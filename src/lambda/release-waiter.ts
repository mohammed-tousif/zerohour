/**
 * releaseWaiter (M5): a Lambda durable function that sleeps until releaseAt,
 * then opens approvals by starting the release (approval) workflow.
 *
 *   step "read-release-time"        → batch must be STAGED; seconds until releaseAt (+1 s)
 *   wait "until-release-time"       → function suspended; no compute billed, up to 1 year
 *   step "start-approval-workflow"  → Step Functions StartExecution, name "<batchId>-release"
 *
 * Replay rules: everything non-deterministic (clock, AWS calls) lives inside a step,
 * so a replay after the wait reuses the checkpointed results.
 * Duplicate waiters are harmless: the execution name makes StartExecution idempotent.
 */
import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js';
import { assertBatchId } from '../crypto/format';
import type { BatchStore } from './ports';

/** A durable execution may run up to 1 year; leave headroom for the steps around the wait. */
export const MAX_WAIT_SECONDS = 365 * 86_400 - 3_600;

export interface ApprovalStarter {
  /** Starts (or finds) the release workflow for this batch. */
  start(batchId: string): Promise<{ executionArn: string; alreadyStarted: boolean }>;
}

export interface ReleaseWaiterDeps {
  batches: BatchStore;
  approvals: ApprovalStarter;
  now?: () => Date;
}

export interface ReleaseWaiterResult {
  batchId: string;
  releaseAt: string;
  waitedSeconds: number;
  executionArn: string;
  alreadyStarted: boolean;
}

/** Whole seconds from now until releaseAt, plus 1 s so approvals never open a moment early. Min 1. */
export function secondsUntil(releaseAt: string, now: Date): number {
  return Math.max(1, Math.ceil((Date.parse(releaseAt) - now.getTime()) / 1000) + 1);
}

export async function releaseWaiterBody(
  event: { batchId: string },
  context: DurableContext,
  deps: ReleaseWaiterDeps,
): Promise<ReleaseWaiterResult> {
  const batchId = assertBatchId(String(event?.batchId));

  const plan = await context.step('read-release-time', async () => {
    const batch = await deps.batches.get(batchId);
    if (!batch) throw new Error(`Unknown batch ${batchId}`);
    if (batch.status !== 'STAGED') throw new Error(`Batch ${batchId} is ${batch.status}, not STAGED`);
    return { releaseAt: batch.releaseAt, seconds: secondsUntil(batch.releaseAt, (deps.now ?? (() => new Date()))()) };
  });
  if (plan.seconds > MAX_WAIT_SECONDS) {
    throw new Error(`releaseAt ${plan.releaseAt} is more than a year away`);
  }

  await context.wait('until-release-time', { seconds: plan.seconds });

  const started = await context.step('start-approval-workflow', () => deps.approvals.start(batchId));
  return { batchId, releaseAt: plan.releaseAt, waitedSeconds: plan.seconds, ...started };
}

export const makeReleaseWaiter = (deps: ReleaseWaiterDeps) =>
  withDurableExecution((event: { batchId: string }, context: DurableContext) => releaseWaiterBody(event, context, deps));
