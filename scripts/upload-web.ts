/**
 * Uploads the built PWA (dist/web) to the root of the stack's public bucket.
 * CloudFront serves it from there (DefaultRootObject index.html). These files
 * are NOT Object-Locked, so the app can be updated; only r/*.bin is locked.
 *
 *   npm run web:build && npm run web:upload -- [--stack zerohour] [--batch demo-2026-11]
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fail, parseArgs } from './lib/cli';
import { stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
const ROOT = 'dist/web';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/** Names that must never be overwritten by an app upload. */
const RESERVED = new Set(['release.json', 'manifest.json']);

const files = (await readdir(ROOT).catch(() => fail('dist/web not found; run npm run web:build first')))
  .filter((f) => TYPES[extname(f)]);
if (!files.includes('index.html')) fail('dist/web/index.html missing; run npm run web:build');
for (const f of files) if (RESERVED.has(f)) fail(`Refusing to upload ${f}: it is managed by the publish workflow`);

const outputs = await stackOutputs(stack);
const s3 = new S3Client({});
const hashed = /\.[0-9A-Z]{8}\.(js|css)(\.map)?$/;

// Hashed assets first, index.html and sw.js last, so a visitor never gets HTML that points at missing files.
const order = [...files].sort((a, b) => Number(!hashed.test(a)) - Number(!hashed.test(b)));
for (const name of order) {
  await s3.send(
    new PutObjectCommand({
      Bucket: outputs.PublicBucketName,
      Key: name,
      Body: await readFile(join(ROOT, name)),
      ContentType: TYPES[extname(name)],
      CacheControl: hashed.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
    }),
  );
  console.log(`↑ ${name}`);
}

// Dashboard config: which API and batch to show (dashboard.html also accepts ?api=&batch=).
const batchId = args.get('batch');
if (outputs.ApprovalApiUrl && batchId) {
  await s3.send(
    new PutObjectCommand({
      Bucket: outputs.PublicBucketName,
      Key: 'config.json',
      Body: JSON.stringify({ apiUrl: outputs.ApprovalApiUrl, batchId }),
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    }),
  );
  console.log(`↑ config.json (dashboard → batch ${batchId})`);
}
console.log(
  outputs.SiteUrl
    ? `✓ PWA live at ${outputs.SiteUrl}`
    : '✓ Uploaded. It becomes reachable once CloudFront is enabled (EnableCdn=true).',
);
