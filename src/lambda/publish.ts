/**
 * The three steps of the publish workflow (Step Functions, M2):
 *
 *   createBatch      → KMS data key for the batch, DynamoDB record, release.json (locked)
 *   encryptBatch × N → Distributed Map child: rows → encrypted r/<hash>.bin + a partial manifest
 *   finalizeManifest → merge partial manifests, cross-check the row count, write manifest.json
 *
 * Pure orchestration over the ports in ./ports, so tests run it in memory.
 */
import { encryptResult } from '../crypto/node-encrypt';
import { fileNameFor } from '../crypto/filename';
import { assertBatchId } from '../crypto/format';
import { ManifestBuilder, type Manifest } from '../crypto/manifest';
import { parseCsv, rowToResult, type CsvRecord } from '../data/csv';
import { mapLimit } from '../lib/concurrency';
import type { BatchRecord, PublishDeps } from './ports';

const CSV_KEY = /^uploads\/[A-Za-z0-9_-]{1,64}\.csv$/;
const PUT_CONCURRENCY = 32;
const DAY_MS = 86_400_000;

/** Each batch gets its own folder: the same USN in a later batch must never hit a cached older file. */
export const resultKey = (batchId: string, fileName: string) => `r/${batchId}/${fileName}`;
export const RELEASE_KEY = 'release.json';
export const MANIFEST_KEY = 'manifest.json';
export const partsPrefix = (batchId: string) => `parts/${batchId}/`;

export const CACHE = {
  /** Encrypted results never change once written. */
  results: 'public, max-age=31536000, immutable',
  release: 'public, max-age=2',
  manifest: 'public, max-age=60',
} as const;

const clock = (deps: PublishDeps) => (deps.now ?? (() => new Date()))();

// ---------------------------------------------------------------- createBatch

export interface CreateBatchInput {
  batchId: string;
  csvKey: string;
  releaseAt: string;
}

export interface CreateBatchOutput extends CreateBatchInput {
  /** True when re-running a batch that was still STAGING: the existing key is kept. */
  resumed: boolean;
}

export async function createBatch(input: CreateBatchInput, deps: PublishDeps): Promise<CreateBatchOutput> {
  const batchId = assertBatchId(String(input.batchId));
  const csvKey = String(input.csvKey);
  if (!CSV_KEY.test(csvKey)) throw new Error('csvKey must look like uploads/<name>.csv');
  const releaseAt = new Date(String(input.releaseAt));
  if (Number.isNaN(releaseAt.getTime())) throw new Error('releaseAt must be an ISO date-time');
  if (releaseAt <= clock(deps)) throw new Error('releaseAt must be in the future');

  let resumed = false;
  const existing = await deps.batches.get(batchId);
  if (existing) {
    if (existing.status !== 'STAGING') {
      throw new Error(`Batch ${batchId} is already ${existing.status}; use a new batchId`);
    }
    if (existing.csvKey !== csvKey) throw new Error(`Batch ${batchId} was started with ${existing.csvKey}`);
    resumed = true;
  } else {
    const key = await deps.keys.generateDataKey(batchId);
    key.plaintext.fill(0); // only the KMS-encrypted copy is kept
    const record: BatchRecord = {
      batchId,
      csvKey,
      releaseAt: releaseAt.toISOString(),
      encryptedKey: key.ciphertext,
      status: 'STAGING',
      createdAt: clock(deps).toISOString(),
    };
    if (!(await deps.batches.createIfAbsent(record))) {
      throw new Error(`Batch ${batchId} was created concurrently; retry`);
    }
  }

  // Leftover partial manifests from an earlier failed run would skew the merge.
  const stale = await deps.objects.list(deps.config.rawBucket, partsPrefix(batchId));
  if (stale.length) await deps.objects.deleteMany(deps.config.rawBucket, stale);

  await deps.objects.put(
    deps.config.publicBucket,
    RELEASE_KEY,
    JSON.stringify({ released: false, batchId, releaseAt: releaseAt.toISOString() }),
    { contentType: 'application/json', cacheControl: CACHE.release },
  );

  return { batchId, csvKey, releaseAt: releaseAt.toISOString(), resumed };
}

// ---------------------------------------------------------------- encryptBatch

/** Exactly what the Distributed Map's ItemBatcher hands each child. */
export interface EncryptBatchEvent {
  BatchInput: { batchId: string };
  Items: CsvRecord[];
}

export interface EncryptBatchOutput {
  count: number;
}

export interface PartManifest {
  batchId: string;
  files: Record<string, string>;
}

/**
 * Plaintext master keys cached per warm Lambda container, so a container that
 * handles several batches calls KMS once. Never written anywhere. Stores the
 * promise so concurrent calls share one KMS request.
 */
export type KeyCache = Map<string, Promise<Uint8Array>>;

function masterKeyFor(record: BatchRecord, deps: PublishDeps, cache?: KeyCache): Promise<Uint8Array> {
  const cached = cache?.get(record.batchId);
  if (cached) return cached;
  const pending = deps.keys.decryptDataKey(record.encryptedKey, record.batchId);
  cache?.set(record.batchId, pending);
  pending.catch(() => cache?.delete(record.batchId)); // don't cache failures
  return pending;
}

export async function encryptBatch(
  event: EncryptBatchEvent,
  deps: PublishDeps,
  cache?: KeyCache,
): Promise<EncryptBatchOutput> {
  const batchId = assertBatchId(String(event.BatchInput?.batchId));
  const items = event.Items ?? [];
  if (items.length === 0) return { count: 0 };

  const record = await deps.batches.get(batchId);
  if (!record) throw new Error(`Unknown batch ${batchId}`);
  if (record.status !== 'STAGING') throw new Error(`Batch ${batchId} is ${record.status}, not STAGING`);

  // Validate the whole batch (rows, duplicate USNs) before writing anything public.
  const results = items.map(rowToResult);
  const names = await Promise.all(results.map((r) => fileNameFor(r.usn)));
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (seen.has(names[i]!)) throw new Error(`Duplicate USN in batch: ${r.usn}`);
    seen.add(names[i]!);
  });

  const masterKey = await masterKeyFor(record, deps, cache);
  const lockUntil = new Date(clock(deps).getTime() + deps.config.retentionDays * DAY_MS);

  const part = new ManifestBuilder(batchId);
  await mapLimit(results, PUT_CONCURRENCY, async (result, i) => {
    const file = encryptResult({ masterKey, batchId, usn: result.usn, dob: result.dob, result });
    const name = names[i]!;
    part.add(name, file);
    await deps.objects.put(deps.config.publicBucket, resultKey(batchId, name), file, {
      contentType: 'application/octet-stream',
      cacheControl: CACHE.results,
      lockUntil,
    });
  });

  const built = part.build(clock(deps));
  // Deterministic part key: re-running the same batch overwrites, never duplicates.
  const partKey = `${partsPrefix(batchId)}${Object.keys(built.files)[0]}.json`;
  const body: PartManifest = { batchId, files: built.files };
  await deps.objects.put(deps.config.rawBucket, partKey, JSON.stringify(body), {
    contentType: 'application/json',
  });
  return { count: built.count };
}

// ---------------------------------------------------------------- finalizeManifest

export interface FinalizeInput {
  batchId: string;
}

export interface FinalizeOutput {
  batchId: string;
  count: number;
  rootHash: string;
}

export async function finalizeManifest(input: FinalizeInput, deps: PublishDeps): Promise<FinalizeOutput> {
  const batchId = assertBatchId(String(input.batchId));
  const record = await deps.batches.get(batchId);
  if (!record) throw new Error(`Unknown batch ${batchId}`);
  if (record.status === 'RELEASED') throw new Error(`Batch ${batchId} is already RELEASED`);

  const builder = new ManifestBuilder(batchId);
  for (const key of await deps.objects.list(deps.config.rawBucket, partsPrefix(batchId))) {
    const part = JSON.parse(new TextDecoder().decode(await deps.objects.get(deps.config.rawBucket, key))) as PartManifest;
    if (part.batchId !== batchId) throw new Error(`${key} belongs to batch ${part.batchId}`);
    for (const [name, hash] of Object.entries(part.files)) builder.addHash(name, hash);
  }

  // Every CSV row must have exactly one published file.
  const csv = new TextDecoder().decode(await deps.objects.get(deps.config.rawBucket, record.csvKey));
  const expected = parseCsv(csv).length;
  if (builder.size !== expected) {
    throw new Error(`Staged ${builder.size} files but the CSV has ${expected} rows`);
  }

  const now = clock(deps);
  const manifest: Manifest = builder.build(now);
  await deps.objects.put(deps.config.publicBucket, MANIFEST_KEY, JSON.stringify(manifest), {
    contentType: 'application/json',
    cacheControl: CACHE.manifest,
  });
  await deps.batches.markStaged(batchId, {
    count: manifest.count,
    rootHash: manifest.rootHash,
    stagedAt: now.toISOString(),
  });
  return { batchId, count: manifest.count, rootHash: manifest.rootHash };
}
