/**
 * Uploads a results CSV and runs the publish workflow on the deployed stack.
 *
 *   npm run publish:batch -- [--stack zerohour] [--csv data/results.csv] [--batch demo-2026-11]
 *                            [--release-at 2026-11-16T04:30:00Z] [--sample 5]
 *
 * Afterwards it checks the result the way a student's phone would: reads
 * manifest.json, release.json and a sample of r/<hash>.bin (through CloudFront
 * when the stack has one, otherwise straight from S3 with your credentials).
 * Then, as an admin-only check, it unwraps the batch key via KMS and proves the
 * sample decrypts to the source rows. The key is never printed or saved.
 */
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { fileNameFor } from '../src/crypto/filename';
import { assertBatchId } from '../src/crypto/format';
import { isManifestConsistent, verifyFile, type Manifest } from '../src/crypto/manifest';
import { decryptResult } from '../src/crypto/web-decrypt';
import { parseCsv, rowToResult } from '../src/data/csv';
import { fail, intArg, parseArgs } from './lib/cli';
import { stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
const csvPath = args.get('csv') ?? 'data/results.csv';
const batchId = assertBatchId(args.get('batch') ?? 'demo-2026-11');
const sampleSize = intArg(args, 'sample', 5);
const releaseAt = new Date(args.get('release-at') ?? Date.now() + 24 * 3600 * 1000);
if (Number.isNaN(releaseAt.getTime())) fail('--release-at must be an ISO date-time');

const outputs = await stackOutputs(stack);
const s3 = new S3Client({});
const csv = await readFile(csvPath);
const rows = parseCsv(csv.toString('utf8'));
const csvKey = `uploads/${batchId}.csv`;

console.log(`↑ Uploading ${rows.length} rows to s3://${outputs.RawBucketName}/${csvKey}`);
await s3.send(new PutObjectCommand({ Bucket: outputs.RawBucketName, Key: csvKey, Body: csv, ContentType: 'text/csv' }));

const sfn = new SFNClient({});
const started = Date.now();
const { executionArn } = await sfn.send(
  new StartExecutionCommand({
    stateMachineArn: outputs.PublishStateMachineArn,
    name: `${batchId}-${started}`,
    input: JSON.stringify({ batchId, csvKey, releaseAt: releaseAt.toISOString() }),
  }),
);
console.log(`▶ Publish workflow started: ${executionArn}`);

let status = 'RUNNING';
let output: string | undefined;
let error: string | undefined;
while (status === 'RUNNING') {
  await new Promise((r) => setTimeout(r, 5000));
  const d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  status = d.status ?? 'UNKNOWN';
  output = d.output;
  error = d.error ? `${d.error}: ${d.cause ?? ''}` : undefined;
  process.stdout.write(`  … ${status} (${Math.round((Date.now() - started) / 1000)} s)\r`);
}
console.log();
if (status !== 'SUCCEEDED') fail(`Workflow ${status}. ${error ?? 'See the Step Functions console.'}`);
console.log(`✓ Staged in ${Math.round((Date.now() - started) / 1000)} s: ${output}`);

// ---- What a student's phone sees (public files only) -------------------------
const via = outputs.SiteUrl ? `the public HTTPS URL (${outputs.SiteUrl})` : `S3 with your credentials`;
async function getPublic(key: string): Promise<Uint8Array> {
  if (outputs.SiteUrl) {
    const res = await fetch(`${outputs.SiteUrl}/${key}`);
    if (!res.ok) fail(`GET /${key} via CloudFront returned ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const obj = await s3.send(new GetObjectCommand({ Bucket: outputs.PublicBucketName, Key: key }));
  return obj.Body!.transformToByteArray();
}
const json = async <T>(key: string) => JSON.parse(new TextDecoder().decode(await getPublic(key))) as T;

const manifest = await json<Manifest>('manifest.json');
if (!isManifestConsistent(manifest) || manifest.count !== rows.length) {
  fail(`manifest.json is inconsistent or lists ${manifest.count} files, expected ${rows.length}`);
}
const release = await json<{ released: boolean }>('release.json');
const sample = Array.from({ length: Math.min(sampleSize, rows.length) }, (_, i) =>
  rows[Math.floor((i * rows.length) / Math.max(1, sampleSize))]!,
);
const files = new Map<string, Uint8Array>();
for (const row of sample) {
  const name = await fileNameFor(row['usn']!);
  const bytes = await getPublic(`r/${batchId}/${name}`);
  if (!verifyFile(manifest, name, bytes)) fail(`r/${batchId}/${name} does not match the manifest`);
  files.set(row['usn']!, bytes);
}
console.log(`✓ Read via ${via}: manifest consistent (${manifest.count} files, root ${manifest.rootHash.slice(0, 16)}…), ${files.size}/${sample.length} sampled files match it`);
console.log(`🔒 release.json: released=${String(release.released)} — no key is public yet`);

// ---- Admin-only end-to-end check (students can't do this) --------------------
const item = await new DynamoDBClient({}).send(
  new GetItemCommand({ TableName: outputs.BatchesTableName, Key: { batchId: { S: batchId } }, ConsistentRead: true }),
);
const wrapped = item.Item?.['encryptedKey']?.B;
if (!wrapped) fail(`No encrypted key stored for batch ${batchId}`);
const { Plaintext: masterKey } = await new KMSClient({}).send(
  new DecryptCommand({ CiphertextBlob: wrapped, EncryptionContext: { app: 'zerohour', batchId } }),
);
if (!masterKey) fail('KMS returned no key');
let matched = 0;
for (const row of sample) {
  const result = await decryptResult({ file: files.get(row['usn']!)!, masterKey, batchId, usn: row['usn']!, dob: row['dob']! });
  if (isDeepStrictEqual(result, rowToResult(row))) matched++;
}
masterKey.fill(0);
if (matched !== sample.length) fail(`Only ${matched}/${sample.length} sampled files decrypted to their source rows`);
console.log(`✓ Admin check: unwrapped the batch key via KMS; ${matched}/${sample.length} sampled files decrypt to exactly their CSV rows`);
console.log(`  DynamoDB status: ${item.Item?.['status']?.S}, count ${item.Item?.['count']?.N}`);
