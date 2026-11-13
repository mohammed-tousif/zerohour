import { describe, expect, it } from 'vitest';
import { approve, hashToken, inviteApprovers, openApprovals, publishKey } from './approval';
import { handleHttp, type HttpEvent } from './approve-http';
import { FakeApprovalStore, FakeBatchStore, FakeCdn, FakeKeyService, FakeObjectStore, FakeTaskCallbacks } from './testing/fakes';

const BATCH = 'demo-2026-11';
const RELEASE_AT = '2026-11-16T04:30:00.000Z';
const NAMES = ['Registrar', 'Controller of Examinations', 'Dean Academics'];

async function setup(startIso = '2026-11-14T10:00:00Z') {
  let now = new Date(startIso);
  const clock = () => now;
  const batches = new FakeBatchStore();
  const approvals = new FakeApprovalStore();
  const callbacks = new FakeTaskCallbacks();
  const keys = new FakeKeyService();
  const objects = new FakeObjectStore(clock);
  const cdn = new FakeCdn();
  const dataKey = await keys.generateDataKey(BATCH);
  await batches.createIfAbsent({
    batchId: BATCH,
    csvKey: `uploads/${BATCH}.csv`,
    releaseAt: RELEASE_AT,
    encryptedKey: dataKey.ciphertext,
    status: 'STAGED',
    createdAt: startIso,
    count: 50_000,
  });
  const deps = { batches, approvals, callbacks, now: clock };
  const publishDeps = {
    config: { publicBucket: 'public', rawBucket: 'raw', retentionDays: 1 },
    batches,
    approvals,
    keys,
    objects,
    cdn,
    now: clock,
  };
  return {
    deps,
    publishDeps,
    dataKey,
    approvals,
    callbacks,
    objects,
    cdn,
    batches,
    setNow: (iso: string) => (now = new Date(iso)),
  };
}

/** Invite before release, then move the clock past releaseAt and open approvals. */
async function openFlow(t: Awaited<ReturnType<typeof setup>>, validHours = 72) {
  const { links } = await inviteApprovers({ batchId: BATCH, names: NAMES, validHours }, t.deps);
  t.setNow('2026-11-16T04:30:05Z');
  await openApprovals({ batchId: BATCH, taskToken: 'task-token-1' }, t.deps);
  return links.map((l) => l.token);
}

describe('invites', () => {
  it('creates one link per official and stores only token hashes', async () => {
    const t = await setup();
    const { links, flow } = await inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps);
    expect(links).toHaveLength(3);
    expect(flow).toMatchObject({ status: 'WAITING', required: 2 });
    for (const { token } of links) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(t.approvals.invites.has(hashToken(token))).toBe(true);
      expect(JSON.stringify([...t.approvals.invites.values()])).not.toContain(token);
    }
  });

  it('refuses a batch that is not STAGED', async () => {
    const t = await setup();
    t.batches.records.get(BATCH)!.status = 'STAGING';
    await expect(inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps)).rejects.toThrow(/STAGED/);
  });

  it('a re-invite makes the earlier links useless', async () => {
    const t = await setup();
    const first = await inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps);
    await inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps);
    t.setNow('2026-11-16T04:31:00Z');
    await openApprovals({ batchId: BATCH, taskToken: 'tt' }, t.deps);
    expect(await approve(first.links[0]!.token, t.deps)).toEqual({ kind: 'invalid' });
  });
});

describe('opening approvals', () => {
  it('refuses before releaseAt, so the key can never be released early', async () => {
    const t = await setup();
    await inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps);
    t.setNow('2026-11-16T04:29:59Z');
    await expect(openApprovals({ batchId: BATCH, taskToken: 'tt' }, t.deps)).rejects.toThrow(/Too early/);
  });

  it('an approval before approvals open is not counted', async () => {
    const t = await setup();
    const { links } = await inviteApprovers({ batchId: BATCH, names: NAMES, validHours: 72 }, t.deps);
    const outcome = await approve(links[0]!.token, t.deps);
    expect(outcome.kind).toBe('not-open');
    expect((await t.approvals.getFlow(BATCH))!.approvedBy).toEqual([]);
  });
});

describe('2-of-3 approval (brief §9)', () => {
  it('1 approval → still locked', async () => {
    const t = await setup();
    const [a1] = await openFlow(t);
    const outcome = await approve(a1!, t.deps);
    expect(outcome.kind).toBe('recorded');
    expect(t.callbacks.calls).toHaveLength(0);
    expect((await t.approvals.getFlow(BATCH))!.status).toBe('OPEN');
  });

  it('duplicate approval from the same official → ignored', async () => {
    const t = await setup();
    const [a1] = await openFlow(t);
    await approve(a1!, t.deps);
    const again = await approve(a1!, t.deps);
    expect(again.kind).toBe('duplicate');
    expect((await t.approvals.getFlow(BATCH))!.approvedBy).toEqual(['a1']);
    expect(t.callbacks.calls).toHaveLength(0);
  });

  it('2 approvals → released: Step Functions resumed exactly once', async () => {
    const t = await setup();
    const [a1, a2, a3] = await openFlow(t);
    await approve(a1!, t.deps);
    const second = await approve(a2!, t.deps);
    expect(second.kind).toBe('released');
    expect(t.callbacks.calls).toEqual([{ taskToken: 'task-token-1', output: { batchId: BATCH, approvedBy: ['a1', 'a2'] } }]);
    expect((await approve(a3!, t.deps)).kind).toBe('closed');
    expect(t.callbacks.calls).toHaveLength(1);
  });

  it('two officials tapping at the same moment still resume the workflow only once', async () => {
    const t = await setup();
    const [a1, a2, a3] = await openFlow(t);
    await approve(a1!, t.deps);
    await Promise.all([approve(a2!, t.deps), approve(a3!, t.deps)]);
    expect(t.callbacks.calls).toHaveLength(1);
  });

  it('expired link → rejected and not counted', async () => {
    const t = await setup('2026-11-16T03:00:00Z');
    const [a1] = await openFlow(t, 1); // valid until 04:00, flow opens 04:30
    expect((await approve(a1!, t.deps)).kind).toBe('expired');
    expect((await t.approvals.getFlow(BATCH))!.approvedBy).toEqual([]);
  });

  it.each(['', 'short', 'x'.repeat(43), '../../etc/passwd'])('rejects a made-up token %j', async (token) => {
    const t = await setup();
    await openFlow(t);
    expect(await approve(token, t.deps)).toEqual({ kind: 'invalid' });
  });
});

describe('publishKey', () => {
  async function approved() {
    const t = await setup();
    const [a1, a2] = await openFlow(t);
    await approve(a1!, t.deps);
    await approve(a2!, t.deps);
    return t;
  }

  it('publishes the real master key, invalidates the CDN, marks everything RELEASED', async () => {
    const t = await approved();
    const out = await publishKey({ batchId: BATCH }, t.publishDeps);
    const release = JSON.parse(t.objects.text('public', 'release.json'));
    expect(release).toMatchObject({ released: true, batchId: BATCH, releasedAt: out.releasedAt });
    const masterKey = await t.publishDeps.keys.decryptDataKey(t.dataKey.ciphertext, BATCH);
    expect(new Uint8Array(Buffer.from(release.key, 'base64'))).toEqual(masterKey);
    expect(t.cdn.invalidated).toEqual([['/release.json']]);
    expect((await t.batches.get(BATCH))!.status).toBe('RELEASED');
    expect((await t.approvals.getFlow(BATCH))!.status).toBe('RELEASED');
    expect((await t.approvals.getFlow(BATCH))!.taskToken).toBeUndefined();
  });

  it('is safe to retry: same releasedAt, same key', async () => {
    const t = await approved();
    const first = await publishKey({ batchId: BATCH }, t.publishDeps);
    t.setNow('2026-11-16T05:00:00Z');
    const second = await publishKey({ batchId: BATCH }, t.publishDeps);
    expect(second.releasedAt).toBe(first.releasedAt);
  });

  it('refuses without 2 approvals', async () => {
    const t = await setup();
    const [a1] = await openFlow(t);
    await approve(a1!, t.deps);
    await expect(publishKey({ batchId: BATCH }, t.publishDeps)).rejects.toThrow(/not been approved/);
    expect(() => t.objects.text('public', 'release.json')).toThrow();
  });
});

describe('approver HTTP API', () => {
  const get = (path: string, query: Record<string, string>): HttpEvent => ({
    rawPath: path,
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: query,
  });
  const post = (token: string): HttpEvent => ({
    rawPath: '/approve',
    requestContext: { http: { method: 'POST' } },
    body: Buffer.from(`t=${encodeURIComponent(token)}`).toString('base64'),
    isBase64Encoded: true,
  });

  it('GET shows the page but never approves (link previews are harmless)', async () => {
    const t = await setup();
    const [a1] = await openFlow(t);
    const res = await handleHttp(get('/approve', { t: a1! }), t.deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Approve release of results');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await t.approvals.getFlow(BATCH))!.approvedBy).toEqual([]);
  });

  it('POST approves; the second POST releases', async () => {
    const t = await setup();
    const [a1, a2] = await openFlow(t);
    expect((await handleHttp(post(a1!), t.deps)).body).toContain('Approval recorded');
    expect((await handleHttp(post(a2!), t.deps)).body).toContain('Results are being released');
    expect(t.callbacks.calls).toHaveLength(1);
  });

  it('escapes official names in HTML', async () => {
    const t = await setup();
    const { links } = await inviteApprovers({ batchId: BATCH, names: ['<script>alert(1)</script>', 'B', 'C'], validHours: 72 }, t.deps);
    const res = await handleHttp(get('/approve', { t: links[0]!.token }), t.deps);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('/status reports progress without revealing anything secret', async () => {
    const t = await setup();
    const [a1] = await openFlow(t);
    await approve(a1!, t.deps);
    const res = await handleHttp(get('/status', { batch: BATCH }), t.deps);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ batchStatus: 'STAGED', approvalStatus: 'OPEN', approvals: 1, required: 2, approvers: 3, count: 50_000 });
    expect(res.body).not.toContain('task-token');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('unknown routes and bad batch ids are rejected', async () => {
    const t = await setup();
    expect((await handleHttp(get('/admin', {}), t.deps)).statusCode).toBe(404);
    expect((await handleHttp(get('/status', { batch: 'bad|id' }), t.deps)).statusCode).toBe(400);
  });
});
