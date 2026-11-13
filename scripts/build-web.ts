/**
 * Builds the student PWA into dist/web:
 *   app.<hash>.js, styles.<hash>.css   (content-hashed, cache forever)
 *   index.html, sw.js, manifest.webmanifest, icon.svg
 *
 *   npm run web:build
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { build } from 'esbuild';

const OUT = 'dist/web';
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const result = await build({
  entryPoints: {
    app: 'web/app.ts',
    styles: 'web/styles.css',
    dashboard: 'web/dashboard.ts',
    'dashboard-styles': 'web/dashboard.css',
  },
  outdir: OUT,
  entryNames: '[name].[hash]',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome100', 'safari16', 'firefox100'],
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
});

const outputs = Object.entries(result.metafile.outputs);
const find = (entry: string) => {
  const hit = outputs.find(([, o]) => o.entryPoint === entry);
  if (!hit) throw new Error(`No output for ${entry}`);
  return basename(hit[0]);
};
const appJs = find('web/app.ts');
const stylesCss = find('web/styles.css');

const html = (await readFile('web/index.html', 'utf8')).replace('%APP%', appJs).replace('%STYLES%', stylesCss);
await writeFile(`${OUT}/index.html`, html);

// Control-room dashboard (not precached by the service worker: it's for staff, always online).
const dashHtml = (await readFile('web/dashboard.html', 'utf8'))
  .replace('%DASH_APP%', find('web/dashboard.ts'))
  .replace('%DASH_STYLES%', find('web/dashboard.css'));
if (dashHtml.includes('%DASH_')) throw new Error('dashboard.html still has a placeholder');
await writeFile(`${OUT}/dashboard.html`, dashHtml);
await copyFile('web/manifest.webmanifest', `${OUT}/manifest.webmanifest`);
await copyFile('web/icon.svg', `${OUT}/icon.svg`);

const precache = ['./index.html', `./${appJs}`, `./${stylesCss}`, './manifest.webmanifest', './icon.svg'];
const version = createHash('sha256').update(html + appJs + stylesCss).digest('hex').slice(0, 12);
const sw = (await readFile('web/sw.js', 'utf8'))
  .replaceAll('__CACHE_VERSION__', version)
  .replaceAll('__PRECACHE__', JSON.stringify(precache));
if (/__[A-Z_]+__/.test(sw)) throw new Error('sw.js still has an unfilled __PLACEHOLDER__');
if (html.includes('%APP%') || html.includes('%STYLES%')) throw new Error('index.html still has a placeholder');
await writeFile(`${OUT}/sw.js`, sw);

console.log(`✓ PWA built → ${OUT} (${appJs}, ${stylesCss}, cache ${version})`);
