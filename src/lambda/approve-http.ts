/**
 * HTTP API for officials (API Gateway HTTP API → Lambda).
 *
 *   GET  /approve?t=<token>   page with batch details + an Approve button. Never changes state,
 *                             so link previews in WhatsApp/Slack/email can't approve anything.
 *   POST /approve  (t=<token>) records the approval
 *   GET  /status?batch=<id>    public JSON: approvals so far, release state (dashboard)
 *
 * Every dynamic value in HTML goes through esc().
 */
import { assertBatchId } from '../crypto/format';
import { approve, describeLink, type ApprovalDeps, type ApproveOutcome } from './approval';
import type { TaskCallbacks } from './ports';

export interface HttpEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type Deps = ApprovalDeps & { callbacks: TaskCallbacks };

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The token is in the URL: never leak it via Referer, never let other sites frame the button.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const when = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) + ' IST'
    : 'not set';

function page(statusCode: number, title: string, body: string): HttpResult {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · ZeroHour</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#0b1324;--muted:#5b6478;--line:#e2e6ef;--accent:#1f6feb;--ok:#047857;--okbg:#d1fae5;--warn:#b45309;--warnbg:#fef3c7;--bad:#b42318;--badbg:#fee4e2}
@media (prefers-color-scheme:dark){:root{--bg:#0b1324;--card:#131c31;--ink:#eef2fa;--muted:#9aa4ba;--line:#26314a;--accent:#4c8dff;--ok:#34d399;--okbg:#06372a;--warn:#fbbf24;--warnbg:#3a2a07;--bad:#fda29b;--badbg:#4a1410}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}.brand{font-weight:700;margin-bottom:18px}
h1{font-size:26px;line-height:1.2;margin:8px 0 12px;letter-spacing:-.01em}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:16px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.chip{display:inline-block;border-radius:999px;padding:3px 12px;font-weight:650;font-size:14px}
.ok{background:var(--okbg);color:var(--ok)}.warn{background:var(--warnbg);color:var(--warn)}.bad{background:var(--badbg);color:var(--bad)}
button{width:100%;min-height:54px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:18px;cursor:pointer}
.dots{display:flex;gap:8px;margin-top:6px}.dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--line)}.dot.on{background:var(--ok);border-color:var(--ok)}
</style></head><body><main><div class="brand">ZeroHour · Release approval</div>${body}</main></body></html>`;
  return { statusCode, headers: HTML_HEADERS, body: html };
}

function progress(approved: number, required: number, total: number): string {
  const dots = Array.from({ length: total }, (_, i) => `<span class="dot${i < approved ? ' on' : ''}"></span>`).join('');
  return `<p class="muted" style="margin:0">${approved} of ${required} required approvals</p><div class="dots" aria-hidden="true">${dots}</div>`;
}

async function showLink(token: string, deps: Deps): Promise<HttpResult> {
  const info = await describeLink(token, deps);
  if (!info) return page(404, 'Link not valid', `<h1>This approval link isn't valid</h1><p class="muted">It may have been replaced by a newer invite. Ask the exam office for a new link.</p>`);
  const { flow, approver, invite } = info;
  const expired = new Date() >= new Date(invite.expiresAt);
  const mine = flow.approvedBy.includes(approver.id);
  const details = `<div class="card"><dl>
<dt>Official</dt><dd>${esc(approver.name)}</dd>
<dt>Batch</dt><dd>${esc(flow.batchId)}</dd>
<dt>Results</dt><dd>${info.count !== undefined ? esc(info.count.toLocaleString('en-IN')) : '—'} students</dd>
<dt>Release from</dt><dd>${esc(when(info.releaseAt))}</dd>
<dt>Link valid until</dt><dd>${esc(when(invite.expiresAt))}</dd>
</dl></div><div class="card">${progress(flow.approvedBy.length, flow.required, flow.approvers.length)}</div>`;

  let action: string;
  if (expired) action = `<p class="chip bad">Link expired</p>`;
  else if (flow.status === 'RELEASED' || flow.status === 'APPROVED') action = `<p class="chip ok">Results released</p>`;
  else if (mine) action = `<p class="chip ok">You approved this release</p>`;
  else if (flow.status === 'WAITING') action = `<p class="chip warn">Approvals open at ${esc(when(info.releaseAt))}</p><p class="muted">Come back to this link then.</p>`;
  else {
    action = `<form method="post" action="approve"><input type="hidden" name="t" value="${esc(token)}">
<button type="submit">Approve release of results</button></form>
<p class="muted">Releasing needs ${flow.required} of ${flow.approvers.length} officials. When the ${flow.required === 2 ? 'second' : 'last'} approval arrives, the key is published and every student's phone opens their result.</p>`;
  }
  return page(200, 'Approve release', `<h1>Release exam results?</h1>${details}${action}`);
}

function outcomePage(outcome: ApproveOutcome): HttpResult {
  switch (outcome.kind) {
    case 'invalid':
      return page(404, 'Link not valid', `<h1>This approval link isn't valid</h1>`);
    case 'expired':
      return page(410, 'Link expired', `<h1>This link has expired</h1><p class="muted">Ask the exam office for a new link.</p>`);
    case 'not-open':
      return page(409, 'Not open yet', `<h1>Approvals aren't open yet</h1><p class="muted">Release can be approved from ${esc(when(outcome.releaseAt))}.</p>`);
    case 'closed':
      return page(409, 'Already decided', `<h1>Release already approved</h1><p class="muted">Enough officials approved before you. Nothing more to do.</p>`);
    case 'duplicate':
      return page(200, 'Already approved', `<h1>You've already approved</h1><div class="card">${progress(outcome.flow.approvedBy.length, outcome.flow.required, outcome.flow.approvers.length)}</div><p class="muted">Your approval was counted once. Waiting for another official.</p>`);
    case 'recorded':
      return page(200, 'Approved', `<h1>Thank you, ${esc(outcome.approver.name)}</h1><p class="chip ok">Approval recorded</p><div class="card">${progress(outcome.flow.approvedBy.length, outcome.flow.required, outcome.flow.approvers.length)}</div><p class="muted">Results stay locked until one more official approves.</p>`);
    case 'released':
      return page(200, 'Released', `<h1>Results are being released</h1><p class="chip ok">${outcome.flow.required} of ${outcome.flow.required} approvals</p><p class="muted">The key is being published now. Students' phones will open their results within seconds.</p>`);
  }
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

function formToken(event: HttpEvent): string {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  return new URLSearchParams(raw).get('t') ?? '';
}

export async function handleHttp(event: HttpEvent, deps: Deps): Promise<HttpResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '');

  if (path === '/approve' && method === 'GET') return showLink(event.queryStringParameters?.['t'] ?? '', deps);
  if (path === '/approve' && method === 'POST') return outcomePage(await approve(formToken(event), deps));

  if (path === '/status' && method === 'GET') {
    let batchId: string;
    try {
      batchId = assertBatchId(event.queryStringParameters?.['batch'] ?? '');
    } catch {
      return json(400, { error: 'batch query parameter required' });
    }
    const [flow, batch] = await Promise.all([deps.approvals.getFlow(batchId), deps.batches.get(batchId)]);
    if (!batch) return json(404, { error: 'unknown batch' });
    return json(200, {
      batchId,
      batchStatus: batch.status,
      count: batch.count ?? null,
      rootHash: batch.rootHash ?? null,
      stagedAt: batch.stagedAt ?? null,
      releaseAt: batch.releaseAt,
      approvalStatus: flow?.status ?? 'NOT_INVITED',
      approvals: flow?.approvedBy.length ?? 0,
      required: flow?.required ?? 2,
      approvers: flow?.approvers.length ?? 0,
      releasedAt: flow?.releasedAt ?? null,
    });
  }
  return json(404, { error: 'not found' });
}
