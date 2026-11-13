/**
 * Local stand-in for the M2 publish workflow: CSV → one encrypted file per
 * student + manifest + release.json (locked).
 *
 *   npm run stage -- [--in data/results.csv] [--out out] [--batch demo-2026-11]
 *                    [--release-at 2026-11-16T04:30:00Z]
 *
 * Writes:
 *   out/public/r/<batch>/<sha256(USN)>.bin   encrypted results (what CloudFront will serve)
 *   out/public/manifest.json         SHA-256 of every file + root hash
 *   out/public/release.json          { released: false, releaseAt }
 *   out/private/master.key           base64 master key (M2: KMS-encrypted in DynamoDB)
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptResult } from '../src/crypto/node-encrypt';
import { fileNameFor } from '../src/crypto/filename';
import { assertBatchId } from '../src/crypto/format';
import { ManifestBuilder } from '../src/crypto/manifest';
import { parseCsv, rowToResult } from '../src/data/csv';
import { fail, mapLimit, parseArgs } from './lib/cli';

const args = parseArgs();
const inPath = args.get('in') ?? 'data/results.csv';
const outDir = args.get('out') ?? 'out';
const batchId = assertBatchId(args.get('batch') ?? 'demo-2026-11');
const releaseAt = new Date(args.get('release-at') ?? Date.now() + 24 * 3600 * 1000);
if (Number.isNaN(releaseAt.getTime())) fail('--release-at must be an ISO date-time');

const publicDir = join(outDir, 'public');
const resultsDir = join(publicDir, 'r', batchId);
const privateDir = join(outDir, 'private');

const started = performance.now();
const rows = parseCsv(await readFile(inPath, 'utf8'));
if (rows.length === 0) fail(`${inPath} has no rows`);

// Validate every row before writing anything.
const results = rows.map(rowToResult);
const parsedAt = performance.now();

await rm(publicDir, { recursive: true, force: true });
await mkdir(resultsDir, { recursive: true });
await mkdir(privateDir, { recursive: true });

const masterKey = randomBytes(32);
await writeFile(join(privateDir, 'master.key'), masterKey.toString('base64'), {
  encoding: 'utf8',
  mode: 0o600,
});

const manifest = new ManifestBuilder(batchId);
let encryptMs = 0;
await mapLimit(results, 64, async (result) => {
  const t0 = performance.now();
  const file = encryptResult({ masterKey, batchId, usn: result.usn, dob: result.dob, result });
  encryptMs += performance.now() - t0;
  const name = await fileNameFor(result.usn);
  manifest.add(name, file);
  await writeFile(join(resultsDir, name), file);
});
masterKey.fill(0);

const built = manifest.build();
await writeFile(join(publicDir, 'manifest.json'), JSON.stringify(built), 'utf8');
await writeFile(
  join(publicDir, 'release.json'),
  JSON.stringify({ released: false, batchId, releaseAt: releaseAt.toISOString() }),
  'utf8',
);

const totalMs = performance.now() - started;
console.log(`✓ Staged ${built.count} encrypted results for batch ${batchId}`);
console.log(`  files      ${resultsDir}`);
console.log(`  root hash  ${built.rootHash}`);
console.log(`  release    locked until ${releaseAt.toISOString()}`);
console.log(
  `  time       ${(totalMs / 1000).toFixed(1)} s total ` +
    `(parse+validate ${Math.round(parsedAt - started)} ms, encrypt ${Math.round(encryptMs)} ms, rest is disk I/O)`,
);
