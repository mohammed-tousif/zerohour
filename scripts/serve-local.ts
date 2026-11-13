/**
 * Local stand-in for CloudFront: serves the PWA (dist/web) and the staged
 * public files (out/public: r/*.bin, release.json, manifest.json) on one origin.
 *
 *   npm run web:serve -- [--port 5173] [--out out]
 *
 * Demo loop: npm run stage -- --release-at <soon> → open the app → npm run release:local
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intArg, parseArgs } from './lib/cli';

const args = parseArgs();
const port = intArg(args, 'port', 5173);
// Resolve from the project folder, so this works whatever directory it's started from.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(project, 'dist/web');
const dataRoot = resolve(project, args.get('out') ?? 'out', 'public');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.bin': 'application/octet-stream',
};

/** Resolves a URL path inside root, refusing anything that escapes it. */
function safePath(root: string, urlPath: string): string | null {
  const full = resolve(root, `.${decodeURIComponent(urlPath)}`);
  return full === root || full.startsWith(root + sep) ? full : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const isData = path.startsWith('/r/') || path === '/release.json' || path === '/manifest.json';
  const file = safePath(isData ? dataRoot : webRoot, path);

  try {
    if (!file || !(await stat(file)).isFile()) throw new Error('not found');
  } catch {
    // Same as S3 behind CloudFront/OAC: missing keys are 403, not 404.
    res.writeHead(isData ? 403 : 404, { 'content-type': 'text/plain' }).end('Not found');
    console.log(`${isData ? 403 : 404} ${path}`);
    return;
  }

  const cache =
    path === '/release.json' ? 'public, max-age=2'
    : path.startsWith('/r/') ? 'public, max-age=31536000, immutable'
    : path === '/index.html' || path === '/sw.js' ? 'no-cache'
    : /\.[0-9A-Z]{8}\.(js|css)$/.test(path) ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300';
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
  if (!path.startsWith('/r/')) console.log(`200 ${path}`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ZeroHour local CDN on http://localhost:${port}`);
  console.log(`  app  ← ${webRoot}`);
  console.log(`  data ← ${dataRoot}`);
});
