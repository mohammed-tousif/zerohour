/** release.json: the only file that changes at zero hour. */

export interface LockedRelease {
  released: false;
  /** Which batch is staged: the app fetches r/<batchId>/<file>. */
  batchId: string;
  releaseAt: string;
}

export interface OpenRelease {
  released: true;
  batchId: string;
  /** base64 of the 32-byte master key */
  key: string;
  releasedAt: string;
}

export type ReleaseState = LockedRelease | OpenRelease;

const MINUTE = 60_000;

export function parseRelease(json: unknown): ReleaseState {
  if (typeof json !== 'object' || json === null) throw new Error('release.json is not an object');
  const r = json as Record<string, unknown>;
  if (
    r['released'] === false &&
    typeof r['batchId'] === 'string' &&
    typeof r['releaseAt'] === 'string' &&
    !Number.isNaN(Date.parse(r['releaseAt']))
  ) {
    return { released: false, batchId: r['batchId'], releaseAt: r['releaseAt'] };
  }
  if (
    r['released'] === true &&
    typeof r['batchId'] === 'string' &&
    typeof r['key'] === 'string' &&
    typeof r['releasedAt'] === 'string'
  ) {
    return { released: true, batchId: r['batchId'], key: r['key'], releasedAt: r['releasedAt'] };
  }
  throw new Error('release.json has an unexpected shape');
}

/**
 * How long to wait before checking release.json again. Far from zero hour we
 * check rarely; once releaseAt has passed (officials still approving) we check
 * every 2-3 s with jitter so millions of phones don't hit the CDN in lockstep.
 * Returns null once released (stop polling).
 */
export function nextPollDelay(state: ReleaseState, now: number, random: () => number = Math.random): number | null {
  if (state.released) return null;
  const until = Date.parse(state.releaseAt) - now;
  if (until > 10 * MINUTE) return Math.min(MINUTE, until - 10 * MINUTE + 1000);
  if (until > MINUTE) return 10_000;
  if (until > 0) return Math.min(3_000, until + 250);
  return 2_000 + Math.floor(random() * 1_000);
}
