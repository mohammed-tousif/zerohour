import { normaliseDob } from '../../src/crypto/format';

/** Accepts YYYY-MM-DD (date picker) or DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (typed). */
export function parseDobInput(raw: string): string {
  const text = raw.trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    return normaliseDob(`${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`);
  }
  return normaliseDob(text);
}

/** 93784000 → "1d 02:03:04"; 3723000 → "01:02:03"; negative → "00:00:00". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(Math.floor((total % 86_400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/** "16 Nov 2026, 10:00 AM" in the viewer's locale and time zone. */
export function formatWhen(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? 'en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Time with milliseconds, for the "decrypted at" proof line. */
export function formatPrecise(date: Date, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale ?? 'en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
