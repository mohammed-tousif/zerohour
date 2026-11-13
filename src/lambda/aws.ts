/**
 * Real AWS implementations of the ports. Uses the AWS SDK v3 clients that
 * ship with the Lambda Node.js runtime (marked external when bundling).
 */
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { CdnMetrics, MetricPoint } from './metrics';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  ApprovalFlow,
  ApprovalInvite,
  ApprovalStore,
  Approver,
  BatchRecord,
  BatchStatus,
  BatchStore,
  CdnInvalidator,
  DataKey,
  FlowStatus,
  KeyService,
  ObjectStore,
  PublishConfig,
  PutOptions,
  StagedSummary,
  TaskCallbacks,
} from './ports';

const ENCRYPTION_CONTEXT_APP = 'zerohour';

export class KmsKeyService implements KeyService {
  constructor(
    private readonly kms: KMSClient,
    private readonly keyId: string,
  ) {}

  private context(batchId: string): Record<string, string> {
    return { app: ENCRYPTION_CONTEXT_APP, batchId };
  }

  async generateDataKey(batchId: string): Promise<DataKey> {
    const out = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: this.context(batchId),
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS returned no data key');
    return { plaintext: out.Plaintext, ciphertext: out.CiphertextBlob };
  }

  async decryptDataKey(ciphertext: Uint8Array, batchId: string): Promise<Uint8Array> {
    const out = await this.kms.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: ciphertext,
        EncryptionContext: this.context(batchId),
      }),
    );
    if (!out.Plaintext) throw new Error('KMS returned no plaintext key');
    return out.Plaintext;
  }
}

export class DynamoBatchStore implements BatchStore {
  constructor(
    private readonly ddb: DynamoDBClient,
    private readonly table: string,
  ) {}

  async createIfAbsent(record: BatchRecord): Promise<boolean> {
    try {
      await this.ddb.send(
        new PutItemCommand({
          TableName: this.table,
          Item: {
            batchId: { S: record.batchId },
            csvKey: { S: record.csvKey },
            releaseAt: { S: record.releaseAt },
            encryptedKey: { B: record.encryptedKey },
            status: { S: record.status },
            createdAt: { S: record.createdAt },
          },
          ConditionExpression: 'attribute_not_exists(batchId)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async get(batchId: string): Promise<BatchRecord | undefined> {
    const out = await this.ddb.send(
      new GetItemCommand({ TableName: this.table, Key: { batchId: { S: batchId } }, ConsistentRead: true }),
    );
    return out.Item ? fromItem(out.Item) : undefined;
  }

  async markStaged(batchId: string, summary: StagedSummary): Promise<void> {
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { batchId: { S: batchId } },
        UpdateExpression: 'SET #status = :staged, #count = :count, rootHash = :rootHash, stagedAt = :stagedAt',
        ConditionExpression: 'attribute_exists(batchId) AND #status IN (:staging, :staged)',
        ExpressionAttributeNames: { '#status': 'status', '#count': 'count' },
        ExpressionAttributeValues: {
          ':staged': { S: 'STAGED' },
          ':staging': { S: 'STAGING' },
          ':count': { N: String(summary.count) },
          ':rootHash': { S: summary.rootHash },
          ':stagedAt': { S: summary.stagedAt },
        },
      }),
    );
  }

  async markReleased(batchId: string, releasedAt: string): Promise<void> {
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { batchId: { S: batchId } },
        UpdateExpression: 'SET #status = :released, releasedAt = if_not_exists(releasedAt, :releasedAt)',
        ConditionExpression: '#status IN (:staged, :released)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':staged': { S: 'STAGED' },
          ':released': { S: 'RELEASED' },
          ':releasedAt': { S: releasedAt },
        },
      }),
    );
  }
}

// ---------------------------------------------------------------- approvals (M4)

const FLOW = (batchId: string) => `FLOW#${batchId}`;
const INVITE = (tokenHash: string) => `INVITE#${tokenHash}`;

export class DynamoApprovalStore implements ApprovalStore {
  constructor(
    private readonly ddb: DynamoDBClient,
    private readonly table: string,
  ) {}

  async putInvites(flow: ApprovalFlow, invites: ApprovalInvite[]): Promise<void> {
    const ttlFor = (iso: string) => String(Math.floor(new Date(iso).getTime() / 1000) + 7 * 86_400);
    await this.ddb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                pk: { S: FLOW(flow.batchId) },
                batchId: { S: flow.batchId },
                required: { N: String(flow.required) },
                approvers: { S: JSON.stringify(flow.approvers) },
                inviteId: { S: flow.inviteId },
                status: { S: flow.status },
                createdAt: { S: flow.createdAt },
              },
              // Re-inviting is fine until approvals open; never after.
              ConditionExpression: 'attribute_not_exists(pk) OR #status = :waiting',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':waiting': { S: 'WAITING' } },
            },
          },
          ...invites.map((inv) => ({
            Put: {
              TableName: this.table,
              Item: {
                pk: { S: INVITE(inv.tokenHash) },
                batchId: { S: inv.batchId },
                inviteId: { S: inv.inviteId },
                approverId: { S: inv.approverId },
                expiresAt: { S: inv.expiresAt },
                ttl: { N: ttlFor(inv.expiresAt) },
              },
            },
          })),
        ],
      }),
    );
  }

  async getFlow(batchId: string): Promise<ApprovalFlow | undefined> {
    const out = await this.ddb.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: FLOW(batchId) } }, ConsistentRead: true }),
    );
    return out.Item ? flowFromItem(out.Item) : undefined;
  }

  async getInvite(tokenHash: string): Promise<ApprovalInvite | undefined> {
    const out = await this.ddb.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: INVITE(tokenHash) } }, ConsistentRead: true }),
    );
    const i = out.Item;
    if (!i) return undefined;
    return {
      tokenHash,
      batchId: i['batchId']?.S ?? '',
      inviteId: i['inviteId']?.S ?? '',
      approverId: i['approverId']?.S ?? '',
      expiresAt: i['expiresAt']?.S ?? '',
    };
  }

  async openFlow(batchId: string, taskToken: string, openedAt: string): Promise<void> {
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: FLOW(batchId) } },
        UpdateExpression: 'SET #status = :open, taskToken = :token, openedAt = :at',
        ConditionExpression: '#status IN (:waiting, :open)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':open': { S: 'OPEN' },
          ':waiting': { S: 'WAITING' },
          ':token': { S: taskToken },
          ':at': { S: openedAt },
        },
      }),
    );
  }

  async addApproval(batchId: string, approverId: string): Promise<{ added: boolean; flow: ApprovalFlow }> {
    try {
      const out = await this.ddb.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { pk: { S: FLOW(batchId) } },
          UpdateExpression: 'ADD approvedBy :me',
          ConditionExpression: '#status = :open AND NOT contains(approvedBy, :id)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':me': { SS: [approverId] }, ':id': { S: approverId }, ':open': { S: 'OPEN' } },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { added: true, flow: flowFromItem(out.Attributes ?? {}) };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const flow = await this.getFlow(batchId);
      if (!flow) throw new Error(`No approval flow for ${batchId}`);
      return { added: false, flow };
    }
  }

  async markApproved(batchId: string, approvedAt: string): Promise<boolean> {
    try {
      await this.ddb.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { pk: { S: FLOW(batchId) } },
          UpdateExpression: 'SET #status = :approved, approvedAt = :at',
          ConditionExpression: '#status = :open AND size(approvedBy) >= #required',
          ExpressionAttributeNames: { '#status': 'status', '#required': 'required' },
          ExpressionAttributeValues: { ':approved': { S: 'APPROVED' }, ':open': { S: 'OPEN' }, ':at': { S: approvedAt } },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async markReleased(batchId: string, releasedAt: string): Promise<void> {
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: FLOW(batchId) } },
        UpdateExpression: 'SET #status = :released, releasedAt = if_not_exists(releasedAt, :at) REMOVE taskToken',
        ConditionExpression: '#status IN (:approved, :released)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':released': { S: 'RELEASED' }, ':approved': { S: 'APPROVED' }, ':at': { S: releasedAt } },
      }),
    );
  }
}

function flowFromItem(item: Record<string, AttributeValue>): ApprovalFlow {
  const flow: ApprovalFlow = {
    batchId: item['batchId']?.S ?? '',
    required: Number(item['required']?.N ?? '2'),
    approvers: JSON.parse(item['approvers']?.S ?? '[]') as Approver[],
    inviteId: item['inviteId']?.S ?? '',
    approvedBy: [...(item['approvedBy']?.SS ?? [])].sort(),
    status: (item['status']?.S ?? 'WAITING') as FlowStatus,
    createdAt: item['createdAt']?.S ?? '',
  };
  for (const key of ['taskToken', 'openedAt', 'approvedAt', 'releasedAt'] as const) {
    const value = item[key]?.S;
    if (value !== undefined) flow[key] = value;
  }
  return flow;
}

export class SfnTaskCallbacks implements TaskCallbacks {
  constructor(private readonly sfn: SFNClient) {}

  async succeed(taskToken: string, output: Record<string, unknown>): Promise<void> {
    await this.sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
  }
}

/** CloudFront publishes its metrics to us-east-1 with Region=Global. */
export class CloudWatchCdnMetrics implements CdnMetrics {
  constructor(
    private readonly cw: CloudWatchClient,
    private readonly distributionId: string,
  ) {}

  async series(start: Date, end: Date, periodSeconds: number): Promise<MetricPoint[]> {
    const dims = [
      { Name: 'DistributionId', Value: this.distributionId },
      { Name: 'Region', Value: 'Global' },
    ];
    const q = (Id: string, MetricName: string, Stat: string) => ({
      Id,
      MetricStat: { Metric: { Namespace: 'AWS/CloudFront', MetricName, Dimensions: dims }, Period: periodSeconds, Stat },
      ReturnData: true,
    });
    const out = await this.cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        ScanBy: 'TimestampAscending',
        MetricDataQueries: [q('req', 'Requests', 'Sum'), q('bytes', 'BytesDownloaded', 'Sum'), q('err', 'TotalErrorRate', 'Average')],
      }),
    );
    const points = new Map<number, MetricPoint>();
    const at = (d: Date) => {
      const k = d.getTime();
      let p = points.get(k);
      if (!p) points.set(k, (p = { t: d.toISOString(), requests: 0, bytes: 0, errorRate: null }));
      return p;
    };
    for (const r of out.MetricDataResults ?? []) {
      (r.Timestamps ?? []).forEach((ts, i) => {
        const v = r.Values?.[i] ?? 0;
        const p = at(ts);
        if (r.Id === 'req') p.requests = v;
        else if (r.Id === 'bytes') p.bytes = v;
        else if (r.Id === 'err') p.errorRate = v;
      });
    }
    return [...points.values()].sort((a, b) => a.t.localeCompare(b.t));
  }
}

export function awsCdnMetricsFromEnv(): CdnMetrics | undefined {
  const id = process.env['DISTRIBUTION_ID'];
  return id ? new CloudWatchCdnMetrics(new CloudWatchClient({ region: 'us-east-1' }), id) : undefined;
}

export class CloudFrontInvalidator implements CdnInvalidator {
  constructor(
    private readonly cloudfront: CloudFrontClient,
    private readonly distributionId: string,
  ) {}

  async invalidate(paths: string[]): Promise<void> {
    await this.cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: { CallerReference: `zerohour-${Date.now()}`, Paths: { Quantity: paths.length, Items: paths } },
      }),
    );
  }
}

function fromItem(item: Record<string, AttributeValue>): BatchRecord {
  const s = (name: string): string => {
    const value = item[name]?.S;
    if (value === undefined) throw new Error(`Batch record is missing ${name}`);
    return value;
  };
  const encryptedKey = item['encryptedKey']?.B;
  if (!encryptedKey) throw new Error('Batch record is missing encryptedKey');
  const record: BatchRecord = {
    batchId: s('batchId'),
    csvKey: s('csvKey'),
    releaseAt: s('releaseAt'),
    encryptedKey,
    status: s('status') as BatchStatus,
    createdAt: s('createdAt'),
  };
  if (item['count']?.N !== undefined) record.count = Number(item['count'].N);
  if (item['rootHash']?.S !== undefined) record.rootHash = item['rootHash'].S;
  if (item['stagedAt']?.S !== undefined) record.stagedAt = item['stagedAt'].S;
  return record;
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly s3: S3Client) {}

  async put(bucket: string, key: string, body: Uint8Array | string, options: PutOptions): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        // Object Lock uploads must carry Content-MD5 or an SDK checksum header.
        ...(options.lockUntil
          ? {
              ObjectLockMode: 'GOVERNANCE' as const,
              ObjectLockRetainUntilDate: options.lockUntil,
              ChecksumAlgorithm: 'SHA256' as const,
            }
          : {}),
      }),
    );
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) throw new Error(`s3://${bucket}/${key} has no body`);
    return out.Body.transformToByteArray();
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of out.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async deleteMany(bucket: string, keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      const out = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (out.Errors?.length) {
        throw new Error(`Failed to delete ${out.Errors.length} objects, first: ${out.Errors[0]?.Key}`);
      }
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function configFromEnv(): PublishConfig {
  const retentionDays = Number(process.env['RETENTION_DAYS'] ?? '1');
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('RETENTION_DAYS must be >= 1');
  return {
    publicBucket: requireEnv('PUBLIC_BUCKET'),
    rawBucket: requireEnv('RAW_BUCKET'),
    retentionDays,
  };
}

/** Clients are created once per Lambda container and reused across invocations. */
export function awsDepsFromEnv() {
  return {
    config: configFromEnv(),
    batches: new DynamoBatchStore(new DynamoDBClient({}), requireEnv('BATCHES_TABLE')),
    keys: new KmsKeyService(new KMSClient({}), requireEnv('KEY_ID')),
    objects: new S3ObjectStore(new S3Client({})),
  };
}

/** For the approval Lambdas (M4). Each reads only the env vars it needs. */
export const awsApprovalStore = () => new DynamoApprovalStore(new DynamoDBClient({}), requireEnv('APPROVALS_TABLE'));
export const awsBatchStore = () => new DynamoBatchStore(new DynamoDBClient({}), requireEnv('BATCHES_TABLE'));
export const awsTaskCallbacks = () => new SfnTaskCallbacks(new SFNClient({}));
export function awsCdnFromEnv(): CdnInvalidator | undefined {
  const id = process.env['DISTRIBUTION_ID'];
  return id ? new CloudFrontInvalidator(new CloudFrontClient({}), id) : undefined;
}
