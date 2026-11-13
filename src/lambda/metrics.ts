/**
 * GET /metrics?batch=<id> for the live dashboard (M6): CloudFront traffic for
 * the last hour (1-minute points) plus cost estimates. Results are cached for
 * 15 s per batch so a busy dashboard costs at most 4 CloudWatch calls a minute.
 */
import { assertBatchId } from '../crypto/format';
import { projectResultsDay, resultsDayCost, s3DirectCost, stagingCost, type CostEstimate } from '../cost/estimate';
import { PRICES } from '../cost/prices';
import type { HttpEvent, HttpResult } from './approve-http';
import type { BatchStore } from './ports';

export const WINDOW_MINUTES = 60;
export const PERIOD_SECONDS = 60;
const CACHE_MS = 15_000;
const ROWS_PER_CHILD = 350;

export interface MetricPoint {
  t: string;
  requests: number;
  bytes: number;
  /** % of requests that were 4xx/5xx; null when CloudFront reported no traffic */
  errorRate: number | null;
}

export interface CdnMetrics {
  series(start: Date, end: Date, periodSeconds: number): Promise<MetricPoint[]>;
}

export interface MetricsDeps {
  batches: BatchStore;
  /** Absent while the stack runs without CloudFront (EnableCdn=false). */
  cdn?: CdnMetrics;
  now?: () => Date;
}

export interface MetricsResponse {
  batchId: string;
  generatedAt: string;
  cdnEnabled: boolean;
  window: { start: string; end: string; periodSeconds: number };
  series: MetricPoint[];
  totals: { requests: number; bytes: number; peakRequestsPerMinute: number };
  cost: {
    note: string;
    pricesCheckedOn: string;
    lastHour: CostEstimate;
    staging: CostEstimate;
    projection: { assumption: string; estimate: CostEstimate; s3Direct: CostEstimate };
  };
}

/** Fills every minute in the window so charts never skip gaps (CloudWatch omits zero minutes). */
export function fillMinutes(points: MetricPoint[], start: Date, end: Date, periodSeconds: number): MetricPoint[] {
  const step = periodSeconds * 1000;
  const first = Math.ceil(start.getTime() / step) * step;
  const byTime = new Map(points.map((p) => [Math.floor(Date.parse(p.t) / step) * step, p]));
  const out: MetricPoint[] = [];
  for (let t = first; t < end.getTime(); t += step) {
    out.push(byTime.get(t) ?? { t: new Date(t).toISOString(), requests: 0, bytes: 0, errorRate: null });
  }
  return out;
}

export async function buildMetrics(batchId: string, deps: MetricsDeps): Promise<MetricsResponse | undefined> {
  const batch = await deps.batches.get(batchId);
  if (!batch) return undefined;
  const end = (deps.now ?? (() => new Date()))();
  const start = new Date(end.getTime() - WINDOW_MINUTES * 60_000);
  const raw = deps.cdn ? await deps.cdn.series(start, end, PERIOD_SECONDS) : [];
  const series = deps.cdn ? fillMinutes(raw, start, end, PERIOD_SECONDS) : [];
  const requests = series.reduce((s, p) => s + p.requests, 0);
  const bytes = series.reduce((s, p) => s + p.bytes, 0);
  const students = batch.count ?? 0;

  return {
    batchId,
    generatedAt: end.toISOString(),
    cdnEnabled: Boolean(deps.cdn),
    window: { start: start.toISOString(), end: end.toISOString(), periodSeconds: PERIOD_SECONDS },
    series,
    totals: { requests, bytes, peakRequestsPerMinute: Math.max(0, ...series.map((p) => p.requests)) },
    cost: {
      note: 'Estimate: usage × published AWS on-demand list prices (CloudFront India, Mumbai region). Not a bill.',
      pricesCheckedOn: PRICES.checkedOn,
      lastHour: resultsDayCost({ requests, bytes }),
      staging: stagingCost({ students, children: Math.ceil(students / ROWS_PER_CHILD) }),
      projection: {
        assumption: `All ${students.toLocaleString('en-IN')} students each fetch their file once and check release.json 100 times`,
        estimate: resultsDayCost(projectResultsDay(students, 100)),
        s3Direct: s3DirectCost(projectResultsDay(students, 100)),
      },
    },
  };
}

const cache = new Map<string, { at: number; body: MetricsResponse }>();

export async function handleMetrics(event: HttpEvent, deps: MetricsDeps): Promise<HttpResult> {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (event.requestContext.http.method !== 'GET' || event.rawPath.replace(/\/+$/, '') !== '/metrics') {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found' }) };
  }
  let batchId: string;
  try {
    batchId = assertBatchId(event.queryStringParameters?.['batch'] ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'batch query parameter required' }) };
  }
  const now = Date.now();
  const hit = cache.get(batchId);
  if (hit && now - hit.at < CACHE_MS) return { statusCode: 200, headers, body: JSON.stringify(hit.body) };
  const body = await buildMetrics(batchId, deps);
  if (!body) return { statusCode: 404, headers, body: JSON.stringify({ error: 'unknown batch' }) };
  cache.set(batchId, { at: now, body });
  return { statusCode: 200, headers, body: JSON.stringify(body) };
}

/** For tests. */
export const clearMetricsCache = () => cache.clear();
