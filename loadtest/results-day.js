/**
 * ZeroHour results-day load test (k6) against the CloudFront distribution.
 *
 *   k6 run -e BASE_URL=https://dxxxx.cloudfront.net -e PEAK=500 loadtest/results-day.js
 *
 * Traffic mix (what phones really do on results day):
 *   90%  GET /release.json      (polling for the key, 160 bytes, cached ≤ 5 s at the edge)
 *   10%  GET /r/<batch>/<sha256>.bin  (a student's 1,069-byte encrypted result, cached for a year)
 *
 * Follows AWS's CloudFront load-testing guidance
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/load-testing.html):
 *   - every DNS lookup is independent (ttl 0) and picks a random returned IP,
 *     so requests spread across the edge IPs instead of hammering one;
 *   - no Lambda@Edge viewer triggers and no Origin Shield on this distribution.
 * Limitation: the guidance also asks for clients in several geographic regions.
 * Run from one laptop this only exercises the nearest edge locations, so keep PEAK
 * moderate (default 500 req/s, brief: "up to a few thousand") and ramp gently.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const PEAK = Number(__ENV.PEAK || 500);
const HOLD = __ENV.HOLD || '60s';

if (!BASE.startsWith('https://')) throw new Error('Set -e BASE_URL=https://<distribution>.cloudfront.net');

export const options = {
  dns: { ttl: '0', select: 'random', policy: 'preferIPv4' },
  discardResponseBodies: false,
  scenarios: {
    results_day: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(5, Math.round(PEAK / 20)),
      timeUnit: '1s',
      preAllocatedVUs: Math.min(400, PEAK),
      maxVUs: Math.max(200, PEAK * 2),
      stages: [
        { target: Math.round(PEAK / 4), duration: '30s' }, // students start opening the app
        { target: PEAK, duration: '30s' }, // zero hour
        { target: PEAK, duration: HOLD }, // everyone polling
        { target: 0, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    'http_req_duration{kind:release}': ['p(95)<300'],
    'http_req_duration{kind:result}': ['p(95)<300'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const edgeHits = new Counter('edge_cache_hits');

/** Pick result files to fetch from the public manifest (file names only; contents stay encrypted). */
export function setup() {
  const res = http.get(`${BASE}/manifest.json`, { responseType: 'text', timeout: '60s' });
  if (res.status !== 200) throw new Error(`manifest.json returned ${res.status}`);
  const manifest = JSON.parse(res.body);
  const names = Object.keys(manifest.files);
  const sample = [];
  const step = Math.max(1, Math.floor(names.length / 2000));
  for (let i = 0; i < names.length && sample.length < 2000; i += step) sample.push(names[i]);
  return { files: sample, batchId: manifest.batchId };
}

export default function (data) {
  const isResult = Math.random() < 0.1;
  const url = isResult
    ? `${BASE}/r/${data.batchId}/${data.files[Math.floor(Math.random() * data.files.length)]}`
    : `${BASE}/release.json`;
  const res = http.get(url, { tags: { kind: isResult ? 'result' : 'release' } });
  if (/Hit from cloudfront/i.test(res.headers['X-Cache'] || '')) edgeHits.add(1);
  check(res, {
    'status 200': (r) => r.status === 200,
    'result file is 1,069 bytes': (r) => !isResult || (r.body && r.body.length === 1069),
  });
}

export function handleSummary(summary) {
  return {
    stdout: textSummary(summary),
    'out/loadtest-summary.json': JSON.stringify(summary, null, 2),
  };
}

function textSummary(s) {
  const m = s.metrics;
  const d = (name) => m[name] && m[name].values;
  const lines = [
    `ZeroHour load test against ${BASE} (peak ${PEAK} req/s)`,
    `  requests      ${d('http_reqs') ? d('http_reqs').count : 0} (${d('http_reqs') ? d('http_reqs').rate.toFixed(0) : 0}/s avg)`,
    `  failed        ${d('http_req_failed') ? (d('http_req_failed').rate * 100).toFixed(3) : 0}%`,
    `  edge hits     ${d('edge_cache_hits') ? d('edge_cache_hits').count : 0}`,
    `  latency p50/p95/p99  ${['p(50)', 'p(95)', 'p(99)'].map((k) => (d('http_req_duration') ? d('http_req_duration')[k].toFixed(0) : '?')).join(' / ')} ms`,
  ];
  return lines.join('\n') + '\n';
}
