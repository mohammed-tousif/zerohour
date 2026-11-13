import { describe, expect, it } from 'vitest';
import { FormatInputError } from '../../src/crypto/format';
import { formatCountdown, parseDobInput } from './format';
import { nextPollDelay, parseRelease } from './release';
import { compact, niceTicks } from './chart';

describe('chart helpers', () => {
  it('niceTicks gives 0 and round steps up to at least the max', () => {
    expect(niceTicks(87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(120_000)).toEqual([0, 50_000, 100_000, 150_000]);
    expect(niceTicks(0.6)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
  it('compact keeps small numbers in full and abbreviates large ones', () => {
    expect(compact(9_500)).toBe('9,500');
    expect(compact(12_300)).toBe('12.3K');
    expect(compact(250_000)).toBe('250K');
    expect(compact(4_500_000)).toBe('4.5M');
  });
});

describe('parseDobInput', () => {
  it.each([
    ['2004-05-17', '2004-05-17'],
    ['17/05/2004', '2004-05-17'],
    ['7/5/2004', '2004-05-07'],
    ['17-05-2004', '2004-05-17'],
    [' 17.05.2004 ', '2004-05-17'],
  ])('%j → %s', (input, expected) => expect(parseDobInput(input)).toBe(expected));

  it.each(['31/02/2004', '2004/05/17', '17 May 2004', ''])('rejects %j', (bad) => {
    expect(() => parseDobInput(bad)).toThrow(FormatInputError);
  });
});

describe('formatCountdown', () => {
  it('formats hours, minutes, seconds and days', () => {
    expect(formatCountdown(3_723_000)).toBe('01:02:03');
    expect(formatCountdown(93_784_000)).toBe('1d 02:03:04');
    expect(formatCountdown(-5)).toBe('00:00:00');
  });
});

describe('parseRelease', () => {
  it('accepts the locked and released shapes', () => {
    expect(parseRelease({ released: false, batchId: 'b', releaseAt: '2026-11-16T04:30:00Z' })).toEqual({
      released: false,
      batchId: 'b',
      releaseAt: '2026-11-16T04:30:00Z',
    });
    const open = { released: true, batchId: 'b', key: 'AAAA', releasedAt: '2026-11-16T04:30:02Z' };
    expect(parseRelease(open)).toEqual(open);
  });

  it.each([null, {}, { released: true }, { released: false, batchId: 'b', releaseAt: 'soon' }, { released: false, releaseAt: '2026-11-16T04:30:00Z' }, { released: 'yes' }])(
    'rejects %j',
    (bad) => expect(() => parseRelease(bad)).toThrow(),
  );
});

describe('nextPollDelay', () => {
  const at = Date.parse('2026-11-16T04:30:00Z');
  const locked = { released: false as const, batchId: 'b', releaseAt: '2026-11-16T04:30:00Z' };
  const min = 60_000;

  it('polls rarely when far away, but never sleeps past the 10-minute mark', () => {
    expect(nextPollDelay(locked, at - 3 * 3600_000)).toBe(min);
    expect(nextPollDelay(locked, at - 10 * min - 5_000)).toBe(6_000);
  });

  it('polls every 10 s in the last ten minutes and wakes right at zero hour', () => {
    expect(nextPollDelay(locked, at - 5 * min)).toBe(10_000);
    expect(nextPollDelay(locked, at - 2_000)).toBe(2_250);
  });

  it('after zero hour, polls every 2-3 s with jitter', () => {
    expect(nextPollDelay(locked, at + 1, () => 0)).toBe(2_000);
    expect(nextPollDelay(locked, at + 1, () => 0.999)).toBe(2_999);
  });

  it('stops once released', () => {
    expect(nextPollDelay({ released: true, batchId: 'b', key: 'k', releasedAt: 'x' }, at)).toBeNull();
  });
});
