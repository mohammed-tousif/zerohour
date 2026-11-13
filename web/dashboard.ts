/**
 * ZeroHour control room. Reads two public endpoints of the approval API:
 *   /status?batch=   every 2 s  (staged count, approvals, release state, root hash)
 *   /metrics?batch=  every 15 s (CloudFront traffic from CloudWatch + cost estimate)
 * Config: ?api=<url>&batch=<id>, else config.json written by `npm run web:upload`.
 */
import type { CostEstimate } from '../src/cost/estimate';
import type { MetricsResponse } from '../src/lambda/metrics';
import { compact, TimeChart } from './lib/chart';
import { formatCountdown } from './lib/format';

interface Status {
  batchId: string;
  batchStatus: 'STAGING' | 'STAGED' | 'RELEASED';
  count: number | null;
  rootHash: string | null;
  stagedAt: string | null;
  releaseAt: string;
  approvalStatus: 'NOT_INVITED' | 'WAITING' | 'OPEN' | 'APPROVED' | 'RELEASED';
  approvals: number;
  required: number;
  approvers: number;
  releasedAt: string | null;
}

const $ = (id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
};
const text = (id: string, value: string) => ($(id).textContent = value);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const usd = (n: number) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

async function loadConfig(): Promise<{ api: string; batch: string }> {
  const q = new URLSearchParams(location.search);
  let api = q.get('api') ?? '';
  let batch = q.get('batch') ?? '';
  if (!api || !batch) {
    const cfg = (await fetch('config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as {
      apiUrl?: string;
      batchId?: string;
    };
    api ||= cfg.apiUrl ?? '';
    batch ||= cfg.batchId ?? '';
  }
  if (!api || !batch) throw new Error('Add ?api=<approval API URL>&batch=<batch id> to the address, or run npm run web:upload.');
  return { api: api.replace(/\/+$/, ''), batch };
}

let status: Status | undefined;
let lastOk = 0;

function renderStatus(s: Status): void {
  text('batch-id', s.batchId);
  text('k-staged', s.count === null ? '—' : s.count.toLocaleString('en-IN'));
  text('k-staged-sub', s.batchStatus === 'STAGING' ? 'encrypting now…' : 'encrypted · 1,069 bytes each · unreadable until release');

  const chip = $('k-release-chip');
  const released = s.batchStatus === 'RELEASED';
  const waiting = !released && Date.now() >= Date.parse(s.releaseAt);
  chip.className = `chip ${released ? 'released' : waiting ? 'waiting' : 'locked'}`;
  chip.textContent = released ? '🔓 Released' : waiting ? '⏳ Waiting for officials' : '🔒 Locked';
  text('k-release', released ? when(s.releasedAt).split(', ').pop() ?? '' : waiting ? 'Now' : formatCountdown(Date.parse(s.releaseAt) - Date.now()));
  text('k-release-sub', released ? `key published · release time was ${when(s.releaseAt)}` : `release time ${when(s.releaseAt)}`);

  text('k-approvals', String(s.approvals));
  text('k-required', String(s.required));
  const dots = $('k-dots');
  dots.replaceChildren(...Array.from({ length: Math.max(s.approvers, s.required) }, (_, i) => Object.assign(document.createElement('span'), { className: `dot${i < s.approvals ? ' on' : ''}` })));
  dots.setAttribute('aria-label', `${s.approvals} of ${s.approvers} officials approved; ${s.required} required`);
  text(
    'k-approvals-sub',
    {
      NOT_INVITED: 'officials not invited yet',
      WAITING: `${s.approvers} officials invited · opens at release time`,
      OPEN: 'approvals open',
      APPROVED: 'approved · publishing key',
      RELEASED: 'approved and released',
    }[s.approvalStatus],
  );

  text('root-hash', s.rootHash ?? 'not staged yet');
  text('f-staged', when(s.stagedAt));
  text('f-release-at', when(s.releaseAt));
  text('f-released-at', when(s.releasedAt));
  text('f-status', `${s.batchStatus} · approvals ${s.approvalStatus}`);
}

function costTable(title: string, est: CostEstimate, extra?: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'cost-block';
  block.append(Object.assign(document.createElement('h3'), { textContent: title }));
  if (extra) block.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: extra }));
  const t = document.createElement('table');
  t.className = 'data-table';
  const head = t.createTHead().insertRow();
  for (const h of ['Item', 'Usage', 'Estimate']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
  const body = t.createTBody();
  for (const line of est.lines) {
    const r = body.insertRow();
    r.insertCell().textContent = line.label;
    r.insertCell().textContent = line.quantity;
    r.insertCell().textContent = usd(line.usd);
  }
  const total = body.insertRow();
  total.className = 'cost-total';
  total.insertCell().textContent = 'Total at list price';
  total.insertCell().textContent = est.afterFreeTierUsd !== est.listUsd ? `${usd(est.afterFreeTierUsd)} after free tier` : '';
  total.insertCell().textContent = usd(est.listUsd);
  block.append(t);
  return block;
}

function renderMetrics(m: MetricsResponse, charts: { requests: TimeChart; errors: TimeChart }): void {
  const pts = m.series.map((p) => ({ t: Date.parse(p.t), requests: p.requests, err: p.errorRate }));
  charts.requests.set(pts.map((p) => ({ t: p.t, v: p.requests })));
  charts.errors.set(pts.map((p) => ({ t: p.t, v: p.err })));

  text('k-cost', usd(m.cost.lastHour.listUsd));
  text(
    'k-cost-sub',
    m.cdnEnabled
      ? `estimate · ${compact(m.totals.requests)} requests · ${usd(m.cost.lastHour.afterFreeTierUsd)} after free tier`
      : 'estimate · CloudFront not enabled yet',
  );
  text('cost-note', `${m.cost.note} Prices checked ${m.cost.pricesCheckedOn}.`);
  $('cost-tables').replaceChildren(
    costTable('Results day, last 60 minutes (measured traffic)', m.cost.lastHour),
    costTable('Projection for the whole batch, served by CloudFront', m.cost.projection.estimate, m.cost.projection.assumption),
    costTable('Same projection, served straight from S3 (demo mode while CloudFront awaits verification)', m.cost.projection.s3Direct),
    costTable('One-off: encrypting and staging every result', m.cost.staging),
  );
}

async function main(): Promise<void> {
  const { api, batch } = await loadConfig();
  text('batch-id', batch);
  const requests = new TimeChart($('chart-requests'), { format: compact, valueLabel: 'Requests' }, 'No CloudFront traffic in the last hour (or CloudFront not enabled yet).');
  const errors = new TimeChart(
    $('chart-errors'),
    { format: (v) => `${v.toFixed(v < 1 ? 2 : 1)}%`, valueLabel: 'Error rate', area: false, minMax: 1 },
    'No errors to show: no traffic yet, or 0% errors.',
  );
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-table-for]')) {
    const chart = btn.dataset['tableFor'] === 'chart-requests' ? requests : errors;
    btn.addEventListener('click', () => btn.setAttribute('aria-expanded', String(chart.toggleTable())));
  }

  const live = $('live');
  const pollStatus = async () => {
    try {
      const r = await fetch(`${api}/status?batch=${encodeURIComponent(batch)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      status = (await r.json()) as Status;
      renderStatus(status);
      lastOk = Date.now();
      $('error').hidden = true;
    } catch (err) {
      $('error').hidden = false;
      text('error', `Can't reach the status API: ${(err as Error).message}`);
    }
  };
  const pollMetrics = async () => {
    try {
      const r = await fetch(`${api}/metrics?batch=${encodeURIComponent(batch)}`, { cache: 'no-store' });
      if (r.ok) renderMetrics((await r.json()) as MetricsResponse, { requests, errors });
    } catch {
      /* status polling reports connectivity */
    }
  };

  await Promise.all([pollStatus(), pollMetrics()]);
  setInterval(() => void pollStatus(), 2_000);
  setInterval(() => void pollMetrics(), 15_000);
  setInterval(() => {
    if (status) renderStatus(status); // keep the countdown ticking between polls
    const fresh = Date.now() - lastOk < 6_000;
    live.className = `live ${fresh ? 'ok' : 'stale'}`;
    live.lastChild!.textContent = fresh ? 'Live' : 'Reconnecting…';
  }, 1_000);
}

void main().catch((err: unknown) => {
  $('error').hidden = false;
  text('error', (err as Error).message);
});
