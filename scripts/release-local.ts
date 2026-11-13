/**
 * Local stand-in for publishKey (M4): publishes the master key in release.json.
 *   npm run release:local -- [--out out]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest } from '../src/crypto/manifest';
import { fail, parseArgs } from './lib/cli';

const args = parseArgs();
const outDir = args.get('out') ?? 'out';

const keyB64 = (await readFile(join(outDir, 'private', 'master.key'), 'utf8')).trim();
if (Buffer.from(keyB64, 'base64').length !== 32) fail('master.key is not a 32-byte base64 key');

const manifest = JSON.parse(
  await readFile(join(outDir, 'public', 'manifest.json'), 'utf8'),
) as Manifest;

const release = {
  released: true,
  batchId: manifest.batchId,
  key: keyB64,
  releasedAt: new Date().toISOString(),
};
await writeFile(join(outDir, 'public', 'release.json'), JSON.stringify(release), 'utf8');
console.log(`✓ Released batch ${manifest.batchId}: release.json now carries the 32-byte key`);
