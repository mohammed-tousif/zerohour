import { describe, expect, it } from 'vitest';
import { fileNameFor } from '../crypto/filename';
import { isManifestConsistent, verifyFile, type Manifest } from '../crypto/manifest';
import { decryptResult } from '../crypto/web-decrypt';
import { parseCsv, rowToResult, toCsv, type CsvRecord } from '../data/csv';
import { generateStudents } from '../data/generate';
import { CACHE, createBatch, encryptBatch, finalizeManifest, partsPrefix, type KeyCache } from './publish';
import { fakeDeps } from './testing/fakes';

const BATCH = 'demo-test';
const CSV_KEY = `uploads/${BATCH}.csv`;
const RELEASE_AT = '2026-11-16T04:30:00.000Z';
const ROWS_PER_CHILD = 350; // matches ItemBatcher.MaxItemsPerBatch

const csv = toCsv(generateStudents(1_000, 42));
const rows = parseCsv(csv);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs the same three steps the state machine runs, with the Map done in-process. */
async function runWorkflow(deps = fakeDeps(), sourceRows: CsvRecord[] = rows, cache: KeyCache = new Map()) {
  await deps.objects.put(deps.config.rawBucket, CSV_KEY, csv, { contentType: 'text/csv' });
  const created = await createBatch({ batchId: BATCH, csvKey: CSV_KEY, releaseAt: RELEASE_AT }, deps);
  const counts = await Promise.all(
    chunks(sourceRows, ROWS_PER_CHILD).map((Items) => encryptBatch({ BatchInput: { batchId: BATCH }, Items }, deps, cache)),
  );
  return { deps, created, counts };
}

describe('publish workflow (in memory)', () => {
  it('stages every student, writes a consistent manifest, and marks the batch STAGED', async () => {
    const { deps, counts } = await runWorkflow();
    expect(counts.map((c) => c.count)).toEqual([350, 350, 300]);

    const summary = await finalizeManifest({ batchId: BATCH }, deps);
    expect(summary.count).toBe(1_000);

    const manifest = JSON.parse(deps.objects.text('public-bucket', 'manifest.json')) as Manifest;
    expect(isManifestConsistent(manifest)).toBe(true);
    expect(manifest.rootHash).toBe(summary.rootHash);
    expect((await deps.batches.get(BATCH))?.status).toBe('STAGED');
  });

  it('a student can decrypt their own file with only the released key + USN + DOB', async () => {
    const { deps } = await runWorkflow();
    await finalizeManifest({ batchId: BATCH }, deps);
    const manifest = JSON.parse(deps.objects.text('public-bucket', 'manifest.json')) as Manifest;
    const record = await deps.batches.get(BATCH);
    // Stand-in for publishKey (M4): unwrap the stored key.
    const masterKey = await deps.keys.decryptDataKey(record!.encryptedKey, BATCH);

    for (const row of [rows[0]!, rows[499]!, rows[999]!]) {
      const name = await fileNameFor(row['usn']!);
      const file = await deps.objects.get('public-bucket', `r/${BATCH}/${name}`);
      expect(verifyFile(manifest, name, file)).toBe(true);
      const result = await decryptResult({ file, masterKey, batchId: BATCH, usn: row['usn']!, dob: row['dob']! });
      expect(result).toEqual(rowToResult(row));
    }
  });

  it('keeps release.json locked and writes no plaintext to the public bucket', async () => {
    const { deps } = await runWorkflow();
    await finalizeManifest({ batchId: BATCH }, deps);
    expect(JSON.parse(deps.objects.text('public-bucket', 'release.json'))).toEqual({
      released: false,
      batchId: BATCH,
      releaseAt: RELEASE_AT,
    });
    for (const [key, obj] of deps.objects.buckets.get('public-bucket')!) {
      const text = new TextDecoder().decode(obj.body);
      expect(text, key).not.toContain('Demo Student');
      expect(text, key).not.toContain('DEMO23');
    }
  });

  it('only stores the KMS-encrypted master key, never the plaintext', async () => {
    const { deps } = await runWorkflow();
    const record = deps.batches.records.get(BATCH)!;
    const plaintext = await deps.keys.decryptDataKey(record.encryptedKey, BATCH);
    expect(Buffer.from(record.encryptedKey).includes(Buffer.from(plaintext))).toBe(false);
  });

  it('locks every result file for retentionDays and sets the right cache headers', async () => {
    const { deps } = await runWorkflow();
    await finalizeManifest({ batchId: BATCH }, deps);
    const bucket = deps.objects.buckets.get('public-bucket')!;
    const expectedLock = new Date('2026-11-15T06:00:00Z').getTime();
    for (const [key, obj] of bucket) {
      if (key.startsWith(`r/${BATCH}/`)) {
        expect(obj.options.lockUntil?.getTime(), key).toBe(expectedLock);
        expect(obj.options.cacheControl).toBe(CACHE.results);
        expect(obj.body.length).toBe(1069);
      } else {
        expect(obj.options.lockUntil, key).toBeUndefined();
      }
    }
    expect(bucket.get('release.json')?.options.cacheControl).toBe(CACHE.release);
  });

  it('calls KMS once per warm container, not once per batch', async () => {
    const { deps } = await runWorkflow();
    expect(deps.keys.generated).toBe(1);
    expect(deps.keys.decrypted).toBe(1);
  });
});

describe('per-batch result paths (stale-cache regression)', () => {
  it('the same USN in two batches gets two different URLs, so no cache can serve the old file', async () => {
    const deps = fakeDeps();
    await runWorkflow(deps, rows.slice(0, 10));
    const name = await fileNameFor(rows[0]!['usn']!);
    const keys = [...deps.objects.buckets.get('public-bucket')!.keys()].filter((k) => k.endsWith(name));
    expect(keys).toEqual([`r/${BATCH}/${name}`]);
  });
});

describe('failure handling', () => {
  it('finalize refuses when a batch of rows is missing', async () => {
    const deps = fakeDeps();
    await runWorkflow(deps, rows.slice(0, 700)); // last child "lost"
    await expect(finalizeManifest({ batchId: BATCH }, deps)).rejects.toThrow(/700 files but the CSV has 1000 rows/);
    expect((await deps.batches.get(BATCH))?.status).toBe('STAGING');
  });

  it('a bad row fails its whole batch before anything is written', async () => {
    const deps = fakeDeps();
    await deps.objects.put(deps.config.rawBucket, CSV_KEY, csv, { contentType: 'text/csv' });
    await createBatch({ batchId: BATCH, csvKey: CSV_KEY, releaseAt: RELEASE_AT }, deps);
    const putsBefore = deps.objects.puts;
    const items = [rows[0]!, { ...rows[1]!, s1_ext: '99' }];
    await expect(encryptBatch({ BatchInput: { batchId: BATCH }, Items: items }, deps)).rejects.toThrow(/s1_ext/);
    expect(deps.objects.puts).toBe(putsBefore);
  });

  it('a duplicate USN across batches is caught when merging', async () => {
    const deps = fakeDeps();
    await runWorkflow(deps, [...rows.slice(0, ROWS_PER_CHILD), rows[0]!]); // 2nd child repeats row 0
    await expect(finalizeManifest({ batchId: BATCH }, deps)).rejects.toThrow(/Duplicate/);
  });

  it('a duplicate USN within one batch fails before anything is written', async () => {
    const deps = fakeDeps();
    await deps.objects.put(deps.config.rawBucket, CSV_KEY, csv, { contentType: 'text/csv' });
    await createBatch({ batchId: BATCH, csvKey: CSV_KEY, releaseAt: RELEASE_AT }, deps);
    const putsBefore = deps.objects.puts;
    const items = [rows[0]!, rows[1]!, rows[0]!];
    await expect(encryptBatch({ BatchInput: { batchId: BATCH }, Items: items }, deps)).rejects.toThrow(/Duplicate USN/);
    expect(deps.objects.puts).toBe(putsBefore);
  });

  it('re-running a STAGING batch keeps its key and clears stale partial manifests', async () => {
    const deps = fakeDeps();
    await runWorkflow(deps, rows.slice(0, 700));
    const keyBefore = deps.batches.records.get(BATCH)!.encryptedKey;
    expect(await deps.objects.list('raw-bucket', partsPrefix(BATCH))).toHaveLength(2);

    const { created } = await runWorkflow(deps);
    expect(created.resumed).toBe(true);
    expect(deps.batches.records.get(BATCH)!.encryptedKey).toEqual(keyBefore);
    expect(deps.keys.generated).toBe(1);
    await expect(finalizeManifest({ batchId: BATCH }, deps)).resolves.toMatchObject({ count: 1_000 });
  });

  it('refuses to re-open a STAGED batch', async () => {
    const { deps } = await runWorkflow();
    await finalizeManifest({ batchId: BATCH }, deps);
    await expect(
      createBatch({ batchId: BATCH, csvKey: CSV_KEY, releaseAt: RELEASE_AT }, deps),
    ).rejects.toThrow(/already STAGED/);
    await expect(
      encryptBatch({ BatchInput: { batchId: BATCH }, Items: rows.slice(0, 1) }, deps),
    ).rejects.toThrow(/not STAGING/);
  });

  it('validates createBatch input', async () => {
    const deps = fakeDeps();
    const ok = { batchId: BATCH, csvKey: CSV_KEY, releaseAt: RELEASE_AT };
    await expect(createBatch({ ...ok, batchId: 'bad|id' }, deps)).rejects.toThrow(/batchId/);
    await expect(createBatch({ ...ok, csvKey: '../secret.csv' }, deps)).rejects.toThrow(/csvKey/);
    await expect(createBatch({ ...ok, releaseAt: '2020-01-01T00:00:00Z' }, deps)).rejects.toThrow(/future/);
    await expect(createBatch({ ...ok, releaseAt: 'soon' }, deps)).rejects.toThrow(/ISO/);
  });

  it('rejects an unknown batch', async () => {
    await expect(
      encryptBatch({ BatchInput: { batchId: 'nope' }, Items: rows.slice(0, 1) }, fakeDeps()),
    ).rejects.toThrow(/Unknown batch/);
  });
});
