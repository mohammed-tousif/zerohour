/**
 * Builds the final demo video from recorder output + narration.
 *   1. scenes → out/video/scenes.json → Windows TTS → out/video/audio/<id>.wav
 *   2. each scene: cut the clip at its mark for the narration's length, fit to 1280×720
 *   3. concatenate → out/video/zerohour-demo.mp4 (+ one review still per scene)
 *
 *   npx tsx video/assemble.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { SCENES } from './scenes';

const OUT = resolve('out/video');
const ff = (args: string[]) => execFileSync(ffmpegPath as unknown as string, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const probe = (file: string) =>
  Number(execFileSync(ffprobe.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

await mkdir(`${OUT}/clips`, { recursive: true });
await mkdir(`${OUT}/stills`, { recursive: true });
await writeFile(`${OUT}/scenes.json`, JSON.stringify(SCENES.map(({ id, text }) => ({ id, text }))));
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'video/tts.ps1'], { stdio: 'inherit' });

const timeline = JSON.parse(await readFile(`${OUT}/timeline.json`, 'utf8')) as {
  pages: Record<string, { start: number; video: string }>;
  marks: Record<string, number>;
};

const BG = '0x0b1324';
const list: string[] = [];
let total = 0;
for (const scene of SCENES) {
  const page = timeline.pages[scene.page]!;
  const at = timeline.marks[scene.mark];
  if (at === undefined) throw new Error(`No mark ${scene.mark}`);
  const start = Math.max(0, (at - page.start) / 1000 + (scene.offset ?? 0));
  const audio = `${OUT}/audio/${scene.id}.wav`;
  const dur = Math.round(Math.max(probe(audio) + 0.7, scene.minSeconds ?? 0) * 100) / 100;
  const fit =
    scene.page === 'phone'
      ? `scale=-2:720,pad=1280:720:(ow-iw)/2:0:color=${BG}`
      : 'scale=1280:720';
  const clip = `${OUT}/clips/${scene.id}.mp4`;
  ff([
    '-ss', String(start), '-i', page.video, '-i', audio,
    '-filter_complex', `[0:v]${fit},fps=30,tpad=stop_mode=clone:stop_duration=${dur},format=yuv420p[v];[1:a]aresample=48000,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', clip,
  ]);
  ff(['-ss', String(dur / 2), '-i', clip, '-frames:v', '1', `${OUT}/stills/${scene.id}.png`]);
  list.push(`file '${clip.replace(/\\/g, '/')}'`);
  total += dur;
  console.log(`✓ ${scene.id.padEnd(16)} ${dur.toFixed(1)} s (from ${scene.page} @ ${start.toFixed(1)} s)`);
}
await writeFile(`${OUT}/concat.txt`, list.join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', `${OUT}/concat.txt`, '-c', 'copy', '-movflags', '+faststart', `${OUT}/zerohour-demo.mp4`]);
console.log(`✓ ${OUT}/zerohour-demo.mp4 — ${total.toFixed(1)} s ${total < 180 ? '(under 3 min ✓)' : '(OVER 3 MIN ✗)'}`);
