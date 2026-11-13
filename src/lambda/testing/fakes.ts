/**
 * In-memory stand-ins for KMS, DynamoDB and S3 used by tests. They enforce the
 * same rules the real services would for the paths we use (conditional
 * create, status transitions, Object Lock retention).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  ApprovalFlow,
  ApprovalInvite,
  ApprovalStore,
  BatchRecord,
  BatchStore,
  CdnInvalidator,
  DataKey,
  KeyService,
  ObjectStore,
  PublishDeps,
  PutOptions,
  StagedSummary,
  TaskCallbacks,
} from '../ports';

export class FakeKeyService implements KeyService {
  /** Stand-in for the KMS key; never leaves this object. */
  private readonly wrappingKey = randomBytes(32);
  generated = 0;
  decrypted = 0;

  async generateDataKey(batchId: string): Promise<DataKey> {
    this.generated++;
    const plaintext = new Uint8Array(randomBytes(32));
    return { plaintext, ciphertext: this.wrap(plaintext, batchId) };
  }

  async decryptDataKey(ciphertext: Uint8Array, batchId: string): Promise<Uint8Array> {
    this.decrypted++;
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const body = ciphertext.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.wrappingKey, iv);
    decipher.setAAD(Buffer.from(`zerohour|${batchId}`)); // like KMS encryption context
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  }

  private wrap(plaintext: Uint8Array, batchId: string): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.wrappingKey, iv);
    cipher.setAAD(Buffer.from(`zerohour|${batchId}`));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
  }
}

export class FakeBatchStore implements BatchStore {
  readonly records = new Map<string, BatchRecord>();

  async createIfAbsent(record: BatchRecord): Promise<boolean> {
    if (this.records.has(record.batchId)) return false;
    this.records.set(record.batchId, structuredClone(record));
    return true;
  }

  async get(batchId: string): Promise<BatchRecord | undefined> {
    const record = this.records.get(batchId);
    return record ? structuredClone(record) : undefined;
  }

  async markStaged(batchId: string, summary: StagedSummary): Promise<void> {
    const record = this.records.get(batchId);
    if (!record || record.status === 'RELEASED') throw new Error('ConditionalCheckFailed');
    Object.assign(record, { status: 'STAGED', ...summary });
  }

  async markReleased(batchId: string): Promise<void> {
    const record = this.records.get(batchId);
    if (!record || (record.status !== 'STAGED' && record.status !== 'RELEASED')) throw new Error('ConditionalCheckFailed');
    record.status = 'RELEASED';
  }
}

/** Mirrors the DynamoDB condition expressions in DynamoApprovalStore. */
export class FakeApprovalStore implements ApprovalStore {
  readonly flows = new Map<string, ApprovalFlow>();
  readonly invites = new Map<string, ApprovalInvite>();

  async putInvites(flow: ApprovalFlow, invites: ApprovalInvite[]): Promise<void> {
    const existing = this.flows.get(flow.batchId);
    if (existing && existing.status !== 'WAITING') throw new Error('ConditionalCheckFailed');
    this.flows.set(flow.batchId, structuredClone(flow));
    for (const inv of invites) this.invites.set(inv.tokenHash, { ...inv });
  }

  async getFlow(batchId: string): Promise<ApprovalFlow | undefined> {
    const flow = this.flows.get(batchId);
    return flow ? structuredClone(flow) : undefined;
  }

  async getInvite(tokenHash: string): Promise<ApprovalInvite | undefined> {
    const inv = this.invites.get(tokenHash);
    return inv ? { ...inv } : undefined;
  }

  async openFlow(batchId: string, taskToken: string, openedAt: string): Promise<void> {
    const flow = this.flows.get(batchId);
    if (!flow || (flow.status !== 'WAITING' && flow.status !== 'OPEN')) throw new Error('ConditionalCheckFailed');
    Object.assign(flow, { status: 'OPEN', taskToken, openedAt });
  }

  async addApproval(batchId: string, approverId: string): Promise<{ added: boolean; flow: ApprovalFlow }> {
    const flow = this.flows.get(batchId);
    if (!flow) throw new Error('No flow');
    if (flow.status !== 'OPEN' || flow.approvedBy.includes(approverId)) return { added: false, flow: structuredClone(flow) };
    flow.approvedBy = [...flow.approvedBy, approverId].sort();
    return { added: true, flow: structuredClone(flow) };
  }

  async markApproved(batchId: string, approvedAt: string): Promise<boolean> {
    const flow = this.flows.get(batchId);
    if (!flow || flow.status !== 'OPEN' || flow.approvedBy.length < flow.required) return false;
    Object.assign(flow, { status: 'APPROVED', approvedAt });
    return true;
  }

  async markReleased(batchId: string, releasedAt: string): Promise<void> {
    const flow = this.flows.get(batchId);
    if (!flow || (flow.status !== 'APPROVED' && flow.status !== 'RELEASED')) throw new Error('ConditionalCheckFailed');
    flow.status = 'RELEASED';
    flow.releasedAt ??= releasedAt;
    delete flow.taskToken;
  }
}

export class FakeTaskCallbacks implements TaskCallbacks {
  readonly calls: Array<{ taskToken: string; output: Record<string, unknown> }> = [];
  async succeed(taskToken: string, output: Record<string, unknown>): Promise<void> {
    this.calls.push({ taskToken, output });
  }
}

export class FakeCdn implements CdnInvalidator {
  readonly invalidated: string[][] = [];
  async invalidate(paths: string[]): Promise<void> {
    this.invalidated.push(paths);
  }
}

export interface StoredObject {
  body: Uint8Array;
  options: PutOptions;
}

export class FakeObjectStore implements ObjectStore {
  readonly buckets = new Map<string, Map<string, StoredObject>>();
  puts = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private bucket(name: string): Map<string, StoredObject> {
    let b = this.buckets.get(name);
    if (!b) this.buckets.set(name, (b = new Map()));
    return b;
  }

  async put(bucket: string, key: string, body: Uint8Array | string, options: PutOptions): Promise<void> {
    this.puts++;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body.slice();
    this.bucket(bucket).set(key, { body: bytes, options: { ...options } });
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const obj = this.bucket(bucket).get(key);
    if (!obj) throw new Error(`NoSuchKey: s3://${bucket}/${key}`);
    return obj.body.slice();
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    return [...this.bucket(bucket).keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async deleteMany(bucket: string, keys: readonly string[]): Promise<void> {
    const b = this.bucket(bucket);
    for (const key of keys) {
      const lockUntil = b.get(key)?.options.lockUntil;
      if (lockUntil && lockUntil > this.now()) throw new Error(`AccessDenied: ${key} is under Object Lock`);
      b.delete(key);
    }
  }

  text(bucket: string, key: string): string {
    const obj = this.bucket(bucket).get(key);
    if (!obj) throw new Error(`NoSuchKey: s3://${bucket}/${key}`);
    return new TextDecoder().decode(obj.body);
  }

  object(bucket: string, key: string): StoredObject | undefined {
    return this.bucket(bucket).get(key);
  }
}

export function fakeDeps(now: () => Date = () => new Date('2026-11-14T06:00:00Z')) {
  const deps = {
    config: { publicBucket: 'public-bucket', rawBucket: 'raw-bucket', retentionDays: 1 },
    batches: new FakeBatchStore(),
    keys: new FakeKeyService(),
    objects: new FakeObjectStore(now),
    now,
  } satisfies PublishDeps;
  return deps;
}
