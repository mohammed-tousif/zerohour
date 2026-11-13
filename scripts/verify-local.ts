/**
 * Plays N students: each knows only their USN + DOB and reads only public
 * files (release.json, manifest.json, r/<hash>.bin), exactly like the PWA.
 *
 *   npm run verify -- [--sample 500] [--in data/results.csv] [--out out]
 *
 * Before release it proves the files can't be opened (no key is public).
 */
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeReleasedKey, decryptResult } from '../src/crypto/web-decrypt';
import { fileNameFor } from '../src/crypto/filename';
import { isManifestConsistent, verifyFile, type Manifest } from '../src/crypto/manifest';
import { parseCsv, rowToResult } from '../src/data/csv';
import { fail, intArg, parseArgs } from './lib/cli';

type Release = { released: false; releaseAt: string } | { released: true; batchId: string; key: string };

const args = parseArgs();
const inPath = args.get('in') ?? 'data/results.csv';
const publicDir = join(args.get('out') ?? 'out', 'public');
const sampleSize = intArg(args, 'sample', 500);

const manifest = JSON.parse(await readFile(join(publicDir, 'manifest.json'), 'utf8')) as Manifest;
const release = JSON.parse(await readFile(join(publicDir, 'release.json'), 'utf8')) as Release;

// 1. Manifest is self-consistent and matches what is on disk.
if (!isManifestConsistent(manifest)) fail('manifest.json root hash or count does not match its file list');
const onDisk = (await readdir(join(publicDir, 'r', manifest.batchId))).length;
if (onDisk !== manifest.count) fail(`manifest lists ${manifest.count} files but ${onDisk} are on disk`);
console.log(`✓ Manifest consistent: ${manifest.count} files, root hash ${manifest.rootHash.slice(0, 16)}…`);

if (!release.released) {
  console.log(`🔒 Locked until ${release.releaseAt}. No key is public, so no result can be opened.`);
  console.log('   Run `npm run release:local`, then verify again.');
  process.exit(0);
}

const masterKey = decodeReleasedKey(release.key);
const rows = parseCsv(await readFile(inPath, 'utf8'));
const n = Math.min(sampleSize, rows.length);
const picked = new Set<number>();
while (picked.size < n) picked.add(randomInt(rows.length));

let ok = 0;
let hashFailures = 0;
let decryptFailures = 0;
let mismatches = 0;
const started = performance.now();

for (const index of picked) {
  const row = rows[index]!;
  const name = await fileNameFor(row['usn'] ?? '');
  const file = new Uint8Array(await readFile(join(publicDir, 'r', release.batchId, name)));
  if (!verifyFile(manifest, name, file)) {
    hashFailures++;
    continue;
  }
  try {
    const decrypted = await decryptResult({
      file,
      masterKey,
      batchId: release.batchId,
      usn: row['usn'] ?? '',
      dob: row['dob'] ?? '',
    });
    if (isDeepStrictEqual(decrypted, rowToResult(row))) ok++;
    else mismatches++;
  } catch {
    decryptFailures++;
  }
}

const ms = performance.now() - started;
console.log(
  `${ok === n ? '✓' : '✗'} ${ok}/${n} sampled students decrypted with WebCrypto and matched the source data ` +
    `(${(ms / n).toFixed(2)} ms each)`,
);
if (ok !== n) {
  fail(`hash failures ${hashFailures}, decrypt failures ${decryptFailures}, content mismatches ${mismatches}`);
}
