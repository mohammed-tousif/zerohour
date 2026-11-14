/**
 * Records the real ZeroHour flow against the deployed stack with headless
 * Chromium (Playwright). Three pages are recorded, each to its own video:
 *   slides (1280×720)  title, architecture, publish output, closing card
 *   desk   (1280×720)  control-room dashboard and the officials' approval pages
 *   phone  (414×800)   the student app
 * Every important moment is logged as a mark; assemble.ts cuts clips from marks.
 *
 *   npx tsx video/record.ts --batch demo-video --csv data/demo-video.csv
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { parseCsv } from '../src/data/csv';
import { parseArgs } from '../scripts/lib/cli';
import { requireApprovalOutputs, stackOutputs } from '../scripts/lib/stack';

const args = parseArgs();
const batchId = args.get('batch') ?? 'demo-video';
const csvPath = args.get('csv') ?? `data/${batchId}.csv`;
const OUT = resolve('out/video');
await mkdir(`${OUT}/raw`, { recursive: true });
await mkdir(`${OUT}/slides`, { recursive: true });

const outputs = await stackOutputs('zerohour');
const { ApprovalApiUrl: api } = requireApprovalOutputs(outputs);
const site = outputs.SiteUrl!;
const links = [...(await readFile('out/approver-links.txt', 'utf8')).matchAll(/(https:\/\/\S+\/approve\?t=\S+)/g)].map((m) => m[1]!);
if (links.length < 2) throw new Error('Run approvers:invite first');
const student = parseCsv(await readFile(csvPath, 'utf8'))[0]!;
const [y, m, d] = student['dob']!.split('-');
const status = async () => (await (await fetch(`${api}/status?batch=${batchId}`)).json()) as { releaseAt: string; approvalStatus: string };
const releaseAt = Date.parse((await status()).releaseAt);

// ---------------------------------------------------------------- slides (static HTML)
const css = `body{margin:0;width:1280px;height:720px;background:#0b1324;color:#eef2fa;font-family:"Segoe UI",Roboto,Arial,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden}
.mark{width:56px;height:56px;border-radius:14px;background:conic-gradient(from 200deg,#1f6feb,#7c3aed,#1f6feb);margin-bottom:28px}
h1{font-size:72px;margin:0;letter-spacing:-2px}p{font-size:28px;color:#9aa4ba;margin:16px 0 0;text-align:center;max-width:980px;line-height:1.35}
.small{font-size:20px;margin-top:36px}`;
const slide = async (name: string, body: string, extraCss = '') => {
  const file = `${OUT}/slides/${name}.html`;
  await writeFile(file, `<!doctype html><meta charset="utf-8"><style>${css}${extraCss}</style>${body}`);
  return pathToFileURL(file).href;
};
const publishLog = (await readFile(`${OUT}/publish.txt`, 'utf8').catch(() => '')).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
const urls = {
  title: await slide('title', `<div class="mark"></div><h1>ZeroHour</h1><p>Exam results that can't crash on results day</p><p class="small">Serverless on AWS · ap-south-1 (Mumbai) · synthetic demo data</p>`),
  diagram: await slide('diagram', `<img src="${pathToFileURL(resolve('docs/architecture.png')).href}" style="width:1240px;border-radius:12px">`, 'body{background:#f7f8fb}'),
  publish: await slide(
    'publish',
    `<div class="term"><div class="bar">npm run publish:batch -- --batch ${batchId}</div><pre>${publishLog}</pre></div>`,
    '.term{width:1180px;background:#05080f;border:1px solid #26314a;border-radius:12px;overflow:hidden}.bar{background:#131c31;padding:10px 16px;font:15px Consolas,monospace;color:#9aa4ba}pre{margin:0;padding:22px 26px;font:17px/1.55 Consolas,monospace;color:#d6deeb;white-space:pre-wrap}',
  ),
  closing: await slide('closing', `<div class="mark"></div><h1>Publish early, encrypted.</h1><h1 style="color:#4c8dff">Release only a key.</h1><p class="small">github.com/mohammed-tousif/zerohour</p>`),
};

// ---------------------------------------------------------------- recording
const browser = await chromium.launch();
const wide = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: `${OUT}/raw`, size: { width: 1280, height: 720 } } });
const narrow = await browser.newContext({ viewport: { width: 414, height: 800 }, recordVideo: { dir: `${OUT}/raw`, size: { width: 414, height: 800 } } });
const timeline: { pages: Record<string, { start: number; video?: string }>; marks: Record<string, number> } = { pages: {}, marks: {} };
const pages: Record<string, Page> = {};
async function open(name: 'slides' | 'desk' | 'phone') {
  const page = await (name === 'phone' ? narrow : wide).newPage();
  timeline.pages[name] = { start: Date.now() };
  pages[name] = page;
  return page;
}
const mark = (name: string) => {
  timeline.marks[name] = Date.now();
  console.log(`● ${name}  (${Math.round((Date.now() - releaseAt) / 1000)} s vs release)`);
};
const pause = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

const slides = await open('slides');
for (const [name, hold] of [['title', 12], ['diagram', 40], ['publish', 30], ['closing', 10]] as const) {
  await slides.goto(urls[name]);
  await pause(0.8);
  mark(name);
  await pause(hold);
}

const desk = await open('desk');
await desk.goto(`${site}/dashboard.html?api=${encodeURIComponent(api)}&batch=${batchId}`);
await pause(4);
mark('dash-locked');
await pause(12);

const phone = await open('phone');
await phone.goto(`${site}/index.html`);
await pause(3);
mark('phone-form');
await phone.locator('#usn').pressSequentially(student['usn']!, { delay: 90 });
await phone.locator('#dob').fill(`${y}-${m}-${d}`);
await pause(1.5);
await phone.locator('#setup-submit').click();
await phone.locator('#locked').waitFor({ state: 'visible', timeout: 30_000 });
await pause(14);

console.log(`… waiting for release time (${new Date(releaseAt).toISOString()})`);
while ((await status()).approvalStatus !== 'OPEN') await pause(2);
await pause(3);
mark('phone-waiting');
await pause(12);

await desk.goto(links[0]!);
await pause(1);
mark('approver1');
await pause(3.5);
await desk.locator('button[type=submit]').click();
await pause(6);
mark('after-approve1');
await pause(6);

await desk.goto(links[1]!);
await pause(1);
mark('approver2');
await pause(3.5);
await desk.locator('button[type=submit]').click();
mark('key-moment');
await phone.locator('#result').waitFor({ state: 'visible', timeout: 60_000 });
console.log('🔓 phone decrypted');
await pause(9);

await desk.goto(`${site}/dashboard.html?api=${encodeURIComponent(api)}&batch=${batchId}`);
await pause(4);
mark('dash-released');
await pause(6);
await desk.mouse.wheel(0, 650);
await pause(10);

for (const [name, page] of Object.entries(pages)) {
  await page.close();
  timeline.pages[name]!.video = await page.video()!.path();
}
await wide.close();
await narrow.close();
await browser.close();
await writeFile(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 2));
console.log(`✓ recorded → ${OUT}/timeline.json`);
