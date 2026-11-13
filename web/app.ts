/**
 * ZeroHour student PWA.
 *
 *   1. Student enters USN + DOB once → we fetch r/<sha256(USN)>.bin (1,069 bytes)
 *      and keep it in IndexedDB. Works days before results day.
 *   2. Countdown; poll release.json (tiny, short CDN TTL) on a schedule.
 *   3. When release.json carries the key → decrypt on the phone with WebCrypto.
 *
 * All rendering uses textContent (never innerHTML) so file contents can't inject markup.
 */
import { fileNameFor } from '../src/crypto/filename';
import { FILE_LEN, FormatInputError, normaliseUsn } from '../src/crypto/format';
import { DecryptError, decodeReleasedKey, decryptResult } from '../src/crypto/web-decrypt';
import type { StudentResult } from '../src/data/grading';
import { formatCountdown, formatPrecise, formatWhen, parseDobInput } from './lib/format';
import { nextPollDelay, parseRelease, type ReleaseState } from './lib/release';
import { forgetSaved, loadSaved, saveResult, type SavedResult } from './lib/store';

// ------------------------------------------------------------------ DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const SCREENS = ['setup', 'locked', 'result', 'retry', 'loading'] as const;
type Screen = (typeof SCREENS)[number];

function show(screen: Screen): void {
  for (const id of SCREENS) $(id).hidden = id !== screen;
  if (screen !== 'loading') banner(null);
}

function loading(text: string): void {
  $('loading-text').textContent = text;
  show('loading');
}

function banner(message: string | null): void {
  const el = $('banner');
  el.hidden = message === null;
  el.textContent = message ?? '';
}

function fieldError(inputId: string, errorId: string, message: string | null): void {
  const input = $<HTMLInputElement>(inputId);
  const error = $(errorId);
  input.setAttribute('aria-invalid', String(message !== null));
  error.hidden = message === null;
  error.textContent = message ?? '';
}

// ------------------------------------------------------------------ network

async function fetchRelease(): Promise<ReleaseState> {
  const res = await fetch('release.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`release.json returned ${res.status}`);
  return parseRelease(await res.json());
}

class NotFound extends Error {}

async function fetchEncryptedFile(batchId: string, fileName: string): Promise<Uint8Array> {
  const res = await fetch(`r/${encodeURIComponent(batchId)}/${fileName}`);
  // A private bucket behind CloudFront answers 403 for keys that don't exist.
  if (res.status === 404 || res.status === 403) throw new NotFound();
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== FILE_LEN) throw new Error('Downloaded file is not a ZeroHour result');
  return bytes;
}

// ------------------------------------------------------------------ setup

async function onSetup(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  let usn: string;
  let dob: string;
  fieldError('usn', 'usn-error', null);
  fieldError('dob', 'dob-error', null);
  try {
    usn = normaliseUsn($<HTMLInputElement>('usn').value);
  } catch {
    fieldError('usn', 'usn-error', 'Enter your USN, for example DEMO23CS00001.');
    return;
  }
  try {
    dob = parseDobInput($<HTMLInputElement>('dob').value);
  } catch {
    fieldError('dob', 'dob-error', 'Enter a valid date of birth.');
    return;
  }

  const submit = $<HTMLButtonElement>('setup-submit');
  submit.disabled = true;
  submit.textContent = 'Downloading encrypted result…';
  try {
    const fileName = await fileNameFor(usn);
    const { batchId } = await fetchRelease();
    const file = await fetchEncryptedFile(batchId, fileName);
    const saved: SavedResult = { usn, dob, fileName, batchId, file, fetchedAt: new Date().toISOString() };
    await saveResult(saved);
    await startLocked(saved);
  } catch (err) {
    if (err instanceof NotFound) fieldError('usn', 'usn-error', `No result has been published for ${usn}.`);
    else banner(navigator.onLine ? `Couldn't download your result. ${(err as Error).message}` : "You're offline. Connect once to save your result.");
  } finally {
    submit.disabled = false;
    submit.textContent = 'Save my encrypted result';
  }
}

// ------------------------------------------------------------------ locked: countdown + polling

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let lastRelease: ReleaseState | undefined;
let lastCheck: Date | undefined;
let nextCheckAt: number | undefined;
let current: SavedResult | undefined;

function stopTimers(): void {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  pollTimer = undefined;
  tickTimer = undefined;
}

function renderLocked(): void {
  const countdown = $('countdown');
  const label = $('countdown-label');
  if (lastRelease && !lastRelease.released) {
    const left = Date.parse(lastRelease.releaseAt) - Date.now();
    if (left > 0) {
      countdown.classList.remove('waiting');
      countdown.textContent = formatCountdown(left);
      label.textContent = `until results are released (${formatWhen(lastRelease.releaseAt)})`;
    } else {
      countdown.classList.add('waiting');
      countdown.replaceChildren(Object.assign(document.createElement('span'), { className: 'pulse' }), 'Waiting for officials to release');
      label.textContent = 'Release needs approval from 2 of 3 officials. This page will open your result by itself.';
    }
  }

  const status = $('poll-status');
  if (!navigator.onLine) {
    status.textContent = "You're offline. Your result is safe on this phone; we'll check again when you reconnect.";
  } else if (lastCheck) {
    const next = nextCheckAt ? Math.max(0, Math.ceil((nextCheckAt - Date.now()) / 1000)) : 0;
    status.textContent = `Last checked ${formatPrecise(lastCheck).slice(0, 8)} · next check in ${next} s`;
  } else {
    status.textContent = 'Checking release status…';
  }
}

async function startLocked(saved: SavedResult): Promise<void> {
  current = saved;
  $('saved-usn').textContent = saved.usn;
  $('saved-size').textContent = `${saved.file.length.toLocaleString('en-IN')} bytes`;
  show('locked');
  stopTimers();
  tickTimer = setInterval(renderLocked, 1000);
  renderLocked();
  await poll();
}

async function poll(): Promise<void> {
  clearTimeout(pollTimer);
  if (!current) return;
  let delay = 5_000;
  try {
    lastRelease = await fetchRelease();
    lastCheck = new Date();
    if (current.batchId !== lastRelease.batchId) {
      // A newer batch was published since this file was saved: fetch this student's file for it.
      const file = await fetchEncryptedFile(lastRelease.batchId, current.fileName);
      current = { usn: current.usn, dob: current.dob, fileName: current.fileName, batchId: lastRelease.batchId, file, fetchedAt: new Date().toISOString() };
      await saveResult(current);
      $('saved-size').textContent = `${file.length.toLocaleString('en-IN')} bytes`;
    }
    if (lastRelease.released) {
      const { batchId, key, releasedAt } = lastRelease;
      current = { ...current, release: { batchId, key, releasedAt } };
      await saveResult(current);
      stopTimers();
      await openResult(current);
      return;
    }
    delay = nextPollDelay(lastRelease, Date.now()) ?? delay;
  } catch (err) {
    if (err instanceof NotFound) {
      stopTimers();
      show('setup');
      banner(`The latest results batch has no result for ${current.usn}.`);
      return;
    }
    // Offline or a CDN hiccup: keep the saved file, try again shortly.
  }
  nextCheckAt = Date.now() + delay;
  renderLocked();
  pollTimer = setTimeout(() => void poll(), delay);
}

// ------------------------------------------------------------------ released: decrypt on the phone

async function openResult(saved: SavedResult): Promise<void> {
  if (!saved.release) return startLocked(saved);
  try {
    const started = performance.now();
    const result = await decryptResult<StudentResult>({
      file: saved.file,
      masterKey: decodeReleasedKey(saved.release.key),
      batchId: saved.release.batchId,
      usn: saved.usn,
      dob: saved.dob,
    });
    renderResult(result, new Date(), performance.now() - started);
  } catch (err) {
    if (err instanceof DecryptError || err instanceof FormatInputError) {
      $('retry-usn').textContent = saved.usn;
      show('retry');
      $<HTMLInputElement>('retry-dob').focus();
      return;
    }
    throw err;
  }
}

function cell(text: string | number): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = String(text);
  return td;
}

function renderResult(r: StudentResult, decryptedAt: Date, ms: number): void {
  $('decrypted-at').replaceChildren(
    'Decrypted on this phone at ',
    Object.assign(document.createElement('strong'), { textContent: formatPrecise(decryptedAt) }),
    ` in ${ms.toFixed(1)} ms`,
  );
  $('r-name').textContent = r.name;
  $('r-meta').textContent = `${r.usn} · ${r.branch} · Semester ${r.semester}`;
  $('r-sgpa').textContent = r.sgpa.toFixed(2);
  const status = $('r-status');
  status.textContent = r.result === 'PASS' ? 'Pass' : 'Backlog';
  status.className = `badge ${r.result === 'PASS' ? 'pass' : 'fail'}`;

  const rows = r.subjects.map((s) => {
    const tr = document.createElement('tr');
    if (!s.passed) tr.className = 'failed';
    tr.append(cell(s.code), cell(s.internal), cell(s.external), cell(s.total), cell(s.grade));
    return tr;
  });
  $('r-subjects').replaceChildren(...rows);
  show('result');
}

async function onRetry(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!current) return;
  let dob: string;
  try {
    dob = parseDobInput($<HTMLInputElement>('retry-dob').value);
  } catch {
    fieldError('retry-dob', 'retry-error', 'Enter a valid date of birth.');
    return;
  }
  fieldError('retry-dob', 'retry-error', null);
  current = { ...current, dob };
  await saveResult(current);
  await openResult(current);
}

async function forget(): Promise<void> {
  stopTimers();
  current = undefined;
  lastRelease = undefined;
  lastCheck = undefined;
  await forgetSaved();
  $<HTMLFormElement>('setup-form').reset();
  show('setup');
  $<HTMLInputElement>('usn').focus();
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  $<HTMLFormElement>('setup-form').addEventListener('submit', (e) => void onSetup(e));
  $<HTMLFormElement>('retry-form').addEventListener('submit', (e) => void onRetry(e));
  for (const id of ['forget', 'forget-2', 'forget-3']) $(id).addEventListener('click', () => void forget());

  // Check immediately when the phone comes back online or the tab becomes visible.
  window.addEventListener('online', () => void poll());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current && !current.release) void poll();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* the app still works without offline caching */
    });
  }

  loading('Loading…');
  const saved = await loadSaved().catch(() => undefined);
  if (!saved) {
    show('setup');
    return;
  }
  current = saved;
  if (saved.release && saved.batchId === saved.release.batchId) {
    // A result we already opened. If a newer batch is live, follow it; offline, show what we have.
    const latest = await fetchRelease().catch(() => undefined);
    if (!latest || latest.batchId === saved.batchId) {
      await openResult(saved);
      return;
    }
  }
  // Locked, or the saved file/key belongs to another batch: drop the old key and wait for the current one.
  const { release: _stale, ...unreleased } = saved;
  current = unreleased;
  await startLocked(unreleased);
}

void boot().catch((err: unknown) => {
  show('setup');
  banner(`Something went wrong: ${(err as Error).message}`);
});
