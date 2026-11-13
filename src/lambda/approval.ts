/**
 * 2-of-3 release approval (M4).
 *
 *   invite (admin, before release)  → 3 one-time links; flow WAITING
 *   openApprovals (Step Functions waitForTaskToken, at/after releaseAt) → flow OPEN + task token
 *   approve (API, an official taps the button) → conditional add; the approval that
 *       reaches the threshold flips OPEN → APPROVED and calls SendTaskSuccess
 *   publishKey (next state) → release.json {released:true, key}, CDN invalidation, RELEASED
 *
 * Links are capability URLs: 256-bit random tokens. Only SHA-256(token) is stored.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertBatchId } from '../crypto/format';
import { CACHE, RELEASE_KEY } from './publish';
import type {
  ApprovalFlow,
  ApprovalInvite,
  ApprovalStore,
  Approver,
  BatchStore,
  CdnInvalidator,
  KeyService,
  ObjectStore,
  PublishConfig,
  TaskCallbacks,
} from './ports';

export const REQUIRED_APPROVALS = 2;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface ApprovalDeps {
  approvals: ApprovalStore;
  batches: BatchStore;
  now?: () => Date;
}

const clock = (deps: { now?: () => Date }) => (deps.now ?? (() => new Date()))();

// ---------------------------------------------------------------- invite (admin)

export interface InviteResult {
  flow: ApprovalFlow;
  /** Raw tokens: shown once to the admin, never stored. */
  links: Array<{ approver: Approver; token: string }>;
}

export async function inviteApprovers(
  input: { batchId: string; names: string[]; validHours: number },
  deps: ApprovalDeps,
): Promise<InviteResult> {
  const batchId = assertBatchId(input.batchId);
  const names = input.names.map((n) => n.trim()).filter(Boolean);
  if (names.length < REQUIRED_APPROVALS) throw new Error(`Need at least ${REQUIRED_APPROVALS} approvers`);
  if (new Set(names).size !== names.length) throw new Error('Approver names must be unique');
  if (!(input.validHours > 0 && input.validHours <= 24 * 30)) throw new Error('validHours must be 1..720');

  const batch = await deps.batches.get(batchId);
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  if (batch.status !== 'STAGED') throw new Error(`Batch ${batchId} is ${batch.status}; invite approvers once it is STAGED`);

  const now = clock(deps);
  const expiresAt = new Date(now.getTime() + input.validHours * 3_600_000).toISOString();
  const inviteId = randomUUID();
  const approvers: Approver[] = names.map((name, i) => ({ id: `a${i + 1}`, name }));
  const links = approvers.map((approver) => ({ approver, token: randomBytes(32).toString('base64url') }));
  const invites: ApprovalInvite[] = links.map(({ approver, token }) => ({
    tokenHash: hashToken(token),
    batchId,
    inviteId,
    approverId: approver.id,
    expiresAt,
  }));
  const flow: ApprovalFlow = {
    batchId,
    required: REQUIRED_APPROVALS,
    approvers,
    inviteId,
    approvedBy: [],
    status: 'WAITING',
    createdAt: now.toISOString(),
  };
  await deps.approvals.putInvites(flow, invites);
  return { flow, links };
}

// ---------------------------------------------------------------- openApprovals (Step Functions)

export async function openApprovals(
  input: { batchId: string; taskToken: string },
  deps: ApprovalDeps,
): Promise<void> {
  const batchId = assertBatchId(String(input.batchId));
  if (!input.taskToken) throw new Error('Missing task token');
  const batch = await deps.batches.get(batchId);
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  if (batch.status !== 'STAGED') throw new Error(`Batch ${batchId} is ${batch.status}, not STAGED`);
  const now = clock(deps);
  if (now < new Date(batch.releaseAt)) {
    throw new Error(`Too early: approvals open at ${batch.releaseAt}`);
  }
  const flow = await deps.approvals.getFlow(batchId);
  if (!flow) throw new Error(`No approvers invited for ${batchId}`);
  await deps.approvals.openFlow(batchId, input.taskToken, now.toISOString());
}

// ---------------------------------------------------------------- approve (API)

export type ApproveOutcome =
  | { kind: 'invalid' }
  | { kind: 'expired'; approver: Approver }
  | { kind: 'not-open'; approver: Approver; releaseAt: string }
  | { kind: 'closed'; approver: Approver; flow: ApprovalFlow }
  | { kind: 'duplicate'; approver: Approver; flow: ApprovalFlow }
  | { kind: 'recorded'; approver: Approver; flow: ApprovalFlow }
  | { kind: 'released'; approver: Approver; flow: ApprovalFlow };

/** What a link holder may see before tapping Approve. Never changes state. */
export async function describeLink(token: string, deps: ApprovalDeps) {
  const found = await resolveLink(token, deps);
  if (!found) return undefined;
  const batch = await deps.batches.get(found.flow.batchId);
  return { ...found, releaseAt: batch?.releaseAt, count: batch?.count };
}

async function resolveLink(token: string, deps: ApprovalDeps) {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const invite = await deps.approvals.getInvite(hashToken(token));
  if (!invite) return undefined;
  const flow = await deps.approvals.getFlow(invite.batchId);
  if (!flow || flow.inviteId !== invite.inviteId) return undefined; // superseded by a re-invite
  const approver = flow.approvers.find((a) => a.id === invite.approverId);
  if (!approver) return undefined;
  return { invite, flow, approver };
}

export async function approve(token: string, deps: ApprovalDeps & { callbacks: TaskCallbacks }): Promise<ApproveOutcome> {
  const found = await resolveLink(token, deps);
  if (!found) return { kind: 'invalid' };
  const { invite, approver } = found;
  let { flow } = found;
  const now = clock(deps);

  if (now >= new Date(invite.expiresAt)) return { kind: 'expired', approver };
  if (flow.status === 'WAITING') {
    const batch = await deps.batches.get(flow.batchId);
    return { kind: 'not-open', approver, releaseAt: batch?.releaseAt ?? '' };
  }
  if (flow.status !== 'OPEN') {
    return flow.approvedBy.includes(approver.id) ? { kind: 'duplicate', approver, flow } : { kind: 'closed', approver, flow };
  }

  const result = await deps.approvals.addApproval(flow.batchId, approver.id);
  flow = result.flow;
  if (!result.added) {
    if (flow.approvedBy.includes(approver.id)) return { kind: 'duplicate', approver, flow };
    return { kind: 'closed', approver, flow };
  }
  if (flow.approvedBy.length < flow.required) return { kind: 'recorded', approver, flow };

  // Exactly one approval wins the OPEN → APPROVED race and resumes Step Functions.
  if (await deps.approvals.markApproved(flow.batchId, now.toISOString())) {
    if (!flow.taskToken) throw new Error('Flow is OPEN but has no task token');
    await deps.callbacks.succeed(flow.taskToken, { batchId: flow.batchId, approvedBy: flow.approvedBy });
  }
  return { kind: 'released', approver, flow };
}

// ---------------------------------------------------------------- publishKey (Step Functions)

export interface PublishKeyDeps {
  config: PublishConfig;
  batches: BatchStore;
  approvals: ApprovalStore;
  keys: KeyService;
  objects: ObjectStore;
  cdn?: CdnInvalidator;
  now?: () => Date;
}

export async function publishKey(input: { batchId: string }, deps: PublishKeyDeps) {
  const batchId = assertBatchId(String(input.batchId));
  const batch = await deps.batches.get(batchId);
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  if (batch.status !== 'STAGED' && batch.status !== 'RELEASED') {
    throw new Error(`Batch ${batchId} is ${batch.status}; only a STAGED batch can be released`);
  }
  const flow = await deps.approvals.getFlow(batchId);
  if (!flow || (flow.status !== 'APPROVED' && flow.status !== 'RELEASED')) {
    throw new Error(`Batch ${batchId} has not been approved by ${REQUIRED_APPROVALS} officials`);
  }
  if (flow.approvedBy.length < flow.required) throw new Error('Approval count below threshold');

  const releasedAt = batch.status === 'RELEASED' && flow.releasedAt ? flow.releasedAt : clock(deps).toISOString();
  const key = await deps.keys.decryptDataKey(batch.encryptedKey, batchId);
  try {
    const body = JSON.stringify({
      released: true,
      batchId,
      key: Buffer.from(key).toString('base64'),
      releasedAt,
    });
    await deps.objects.put(deps.config.publicBucket, RELEASE_KEY, body, {
      contentType: 'application/json',
      cacheControl: CACHE.release,
    });
  } finally {
    key.fill(0);
  }
  await deps.cdn?.invalidate([`/${RELEASE_KEY}`]);
  await deps.batches.markReleased(batchId, releasedAt);
  await deps.approvals.markReleased(batchId, releasedAt);
  return { batchId, releasedAt, approvedBy: flow.approvedBy };
}
