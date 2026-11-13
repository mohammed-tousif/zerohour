import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeReleaseWaiter, secondsUntil, type ApprovalStarter } from './release-waiter';
import { FakeBatchStore } from './testing/fakes';

const BATCH = 'demo-2026-11';

function fixture(status: 'STAGING' | 'STAGED' | 'RELEASED' = 'STAGED', releaseAt = '2026-11-16T04:30:00.000Z') {
  const batches = new FakeBatchStore();
  batches.records.set(BATCH, {
    batchId: BATCH,
    csvKey: `uploads/${BATCH}.csv`,
    releaseAt,
    encryptedKey: new Uint8Array(8),
    status,
    createdAt: '2026-11-13T00:00:00Z',
  });
  const started: string[] = [];
  const approvals: ApprovalStarter = {
    async start(batchId) {
      started.push(batchId);
      return { executionArn: `arn:aws:states:ap-south-1:1:execution:zerohour-approval:${batchId}-release`, alreadyStarted: false };
    },
  };
  return { batches, approvals, started };
}

describe('secondsUntil', () => {
  const now = new Date('2026-11-16T04:00:00.000Z');
  it('rounds up and adds 1 s so approvals never open early', () => {
    expect(secondsUntil('2026-11-16T04:30:00.000Z', now)).toBe(1801);
    expect(secondsUntil('2026-11-16T04:00:00.400Z', now)).toBe(2);
  });
  it('waits at least 1 s when releaseAt has already passed', () => {
    expect(secondsUntil('2026-11-15T00:00:00.000Z', now)).toBe(1);
  });
});

describe('releaseWaiter (durable, time skipped)', () => {
  beforeAll(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }));
  afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

  it('waits until releaseAt, then starts the approval workflow exactly once', async () => {
    const f = fixture();
    const runner = new LocalDurableTestRunner({
      handlerFunction: makeReleaseWaiter({ ...f, now: () => new Date('2026-11-16T04:00:00.000Z') }),
    });
    const execution = await runner.run({ payload: { batchId: BATCH } });
    expect(execution.getResult()).toMatchObject({
      batchId: BATCH,
      releaseAt: '2026-11-16T04:30:00.000Z',
      waitedSeconds: 1801,
      alreadyStarted: false,
    });
    expect(f.started).toEqual([BATCH]);
  });

  it('refuses a batch that is not STAGED and never opens approvals', async () => {
    const f = fixture('RELEASED');
    const runner = new LocalDurableTestRunner({ handlerFunction: makeReleaseWaiter(f) });
    const execution = await runner.run({ payload: { batchId: BATCH } });
    expect(execution.getError()?.errorMessage ?? String(execution.getError())).toMatch(/not STAGED/);
    expect(f.started).toEqual([]);
  });

  it('refuses a release time more than a year away', async () => {
    const f = fixture('STAGED', '2028-01-01T00:00:00.000Z');
    const runner = new LocalDurableTestRunner({
      handlerFunction: makeReleaseWaiter({ ...f, now: () => new Date('2026-11-13T00:00:00.000Z') }),
    });
    const execution = await runner.run({ payload: { batchId: BATCH } });
    expect(execution.getError()?.errorMessage ?? String(execution.getError())).toMatch(/more than a year/);
    expect(f.started).toEqual([]);
  });
});
