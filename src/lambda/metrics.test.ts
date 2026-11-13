import { beforeEach, describe, expect, it } from 'vitest';
import { buildMetrics, clearMetricsCache, fillMinutes, handleMetrics, type CdnMetrics, type MetricPoint } from './metrics';
import { FakeBatchStore } from './testing/fakes';

const NOW = new Date('2026-11-16T05:00:30.000Z');

function batches() {
  const store = new FakeBatchStore();
  store.records.set('demo', {
    batchId: 'demo',
    csvKey: 'uploads/demo.csv',
    releaseAt: '2026-11-16T04:30:00.000Z',
    encryptedKey: new Uint8Array(8),
    status: 'RELEASED',
    createdAt: '2026-11-13T00:00:00Z',
    count: 50_000,
    rootHash: 'ab'.repeat(32),
  });
  return store;
}

class FakeCdn implements CdnMetrics {
  calls = 0;
  async series(): Promise<MetricPoint[]> {
    this.calls++;
    return [
      { t: '2026-11-16T04:30:00.000Z', requests: 120_000, bytes: 60_000_000, errorRate: 0 },
      { t: '2026-11-16T04:31:00.000Z', requests: 80_000, bytes: 30_000_000, errorRate: 0.01 },
    ];
  }
}

describe('fillMinutes', () => {
  it('returns one point per minute, zero-filling minutes CloudWatch omitted', () => {
    const start = new Date('2026-11-16T04:00:30Z');
    const out = fillMinutes([{ t: '2026-11-16T04:02:00.000Z', requests: 5, bytes: 1, errorRate: 0 }], start, new Date('2026-11-16T04:05:30Z'), 60);
    expect(out.map((p) => p.t.slice(11, 16))).toEqual(['04:01', '04:02', '04:03', '04:04', '04:05']);
    expect(out.map((p) => p.requests)).toEqual([0, 5, 0, 0, 0]);
    expect(out[0]!.errorRate).toBeNull();
  });
});

describe('buildMetrics', () => {
  it('totals the hour, finds the peak minute, and estimates cost', async () => {
    const m = (await buildMetrics('demo', { batches: batches(), cdn: new FakeCdn(), now: () => NOW }))!;
    expect(m.cdnEnabled).toBe(true);
    expect(m.series).toHaveLength(60);
    expect(m.totals).toEqual({ requests: 200_000, bytes: 90_000_000, peakRequestsPerMinute: 120_000 });
    expect(m.cost.lastHour.listUsd).toBeCloseTo(200_000 * 0.0000012 + (90_000_000 / 1024 ** 3) * 0.109, 6);
    expect(m.cost.note).toMatch(/Estimate/);
    expect(m.cost.staging.listUsd).toBeGreaterThan(0.25);
  });

  it('works without CloudFront: no series, cost still estimated from the batch', async () => {
    const m = (await buildMetrics('demo', { batches: batches(), now: () => NOW }))!;
    expect(m.cdnEnabled).toBe(false);
    expect(m.series).toEqual([]);
    expect(m.totals.requests).toBe(0);
    expect(m.cost.projection.assumption).toContain('50,000');
  });

  it('unknown batch → undefined', async () => {
    expect(await buildMetrics('nope', { batches: batches() })).toBeUndefined();
  });
});

describe('handleMetrics', () => {
  beforeEach(() => clearMetricsCache());
  const ev = (batch: string) => ({ rawPath: '/metrics', requestContext: { http: { method: 'GET' } }, queryStringParameters: { batch } });

  it('caches per batch for 15 s so dashboards cannot run up CloudWatch calls', async () => {
    const cdn = new FakeCdn();
    const deps = { batches: batches(), cdn };
    await handleMetrics(ev('demo'), deps);
    await handleMetrics(ev('demo'), deps);
    expect(cdn.calls).toBe(1);
  });

  it('validates the batch id and allows cross-origin GETs', async () => {
    expect((await handleMetrics(ev('bad|id'), { batches: batches() })).statusCode).toBe(400);
    const ok = await handleMetrics(ev('demo'), { batches: batches() });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('*');
  });
});
