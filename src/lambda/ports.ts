/**
 * The small set of AWS operations the publish Lambdas need. Handlers depend
 * on these interfaces only, so they run unchanged against real AWS
 * (src/lambda/aws.ts) or in-memory fakes in tests.
 */

export type BatchStatus = 'STAGING' | 'STAGED' | 'RELEASED';

export interface BatchRecord {
  batchId: string;
  csvKey: string;
  releaseAt: string;
  /** KMS-encrypted master key. The plaintext key is never stored. */
  encryptedKey: Uint8Array;
  status: BatchStatus;
  createdAt: string;
  count?: number;
  rootHash?: string;
  stagedAt?: string;
}

export interface StagedSummary {
  count: number;
  rootHash: string;
  stagedAt: string;
}

export interface BatchStore {
  /** Creates the record only if no record exists for this batchId. Returns false if one already did. */
  createIfAbsent(record: BatchRecord): Promise<boolean>;
  get(batchId: string): Promise<BatchRecord | undefined>;
  /** STAGING/STAGED → STAGED. Throws if the batch is RELEASED or missing. */
  markStaged(batchId: string, summary: StagedSummary): Promise<void>;
  /** STAGED → RELEASED (idempotent if already RELEASED). */
  markReleased(batchId: string, releasedAt: string): Promise<void>;
}

// ------------------------------------------------------------------ approvals (M4)

export interface Approver {
  id: string;
  name: string;
}

/**
 * WAITING  → invites created, approvals not accepted yet
 * OPEN     → release time reached, Step Functions waiting on a task token
 * APPROVED → threshold reached, task token sent
 * RELEASED → publishKey wrote release.json
 */
export type FlowStatus = 'WAITING' | 'OPEN' | 'APPROVED' | 'RELEASED';

export interface ApprovalFlow {
  batchId: string;
  required: number;
  approvers: Approver[];
  /** Changes on every re-invite; older links stop working. */
  inviteId: string;
  approvedBy: string[];
  status: FlowStatus;
  taskToken?: string;
  createdAt: string;
  openedAt?: string;
  approvedAt?: string;
  releasedAt?: string;
}

/** One approver's link. Only the SHA-256 of the random token is stored. */
export interface ApprovalInvite {
  tokenHash: string;
  batchId: string;
  inviteId: string;
  approverId: string;
  expiresAt: string;
}

export interface ApprovalStore {
  /** Creates or replaces the flow + invites. Refuses once the flow is OPEN or later. */
  putInvites(flow: ApprovalFlow, invites: ApprovalInvite[]): Promise<void>;
  getFlow(batchId: string): Promise<ApprovalFlow | undefined>;
  getInvite(tokenHash: string): Promise<ApprovalInvite | undefined>;
  /** WAITING/OPEN → OPEN with this task token (a re-run replaces the token). */
  openFlow(batchId: string, taskToken: string, openedAt: string): Promise<void>;
  /** Atomically adds approverId if the flow is OPEN and they haven't approved. */
  addApproval(batchId: string, approverId: string): Promise<{ added: boolean; flow: ApprovalFlow }>;
  /** OPEN → APPROVED. True only for the single caller that made the change. */
  markApproved(batchId: string, approvedAt: string): Promise<boolean>;
  markReleased(batchId: string, releasedAt: string): Promise<void>;
}

export interface TaskCallbacks {
  succeed(taskToken: string, output: Record<string, unknown>): Promise<void>;
}

export interface CdnInvalidator {
  invalidate(paths: string[]): Promise<void>;
}

export interface DataKey {
  plaintext: Uint8Array;
  ciphertext: Uint8Array;
}

export interface KeyService {
  /** New 256-bit data key, bound to this batch via KMS encryption context. */
  generateDataKey(batchId: string): Promise<DataKey>;
  decryptDataKey(ciphertext: Uint8Array, batchId: string): Promise<Uint8Array>;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  /** Sets S3 Object Lock GOVERNANCE retention until this time. */
  lockUntil?: Date;
}

export interface ObjectStore {
  put(bucket: string, key: string, body: Uint8Array | string, options: PutOptions): Promise<void>;
  get(bucket: string, key: string): Promise<Uint8Array>;
  list(bucket: string, prefix: string): Promise<string[]>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<void>;
}

export interface PublishConfig {
  publicBucket: string;
  rawBucket: string;
  /** Days each encrypted result stays under Object Lock (GOVERNANCE). */
  retentionDays: number;
}

export interface PublishDeps {
  config: PublishConfig;
  batches: BatchStore;
  keys: KeyService;
  objects: ObjectStore;
  now?: () => Date;
}
