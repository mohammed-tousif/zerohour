/**
 * Starts the release workflow for a batch: approvals open and Step Functions
 * waits (paused, no compute) for 2 of 3 officials. M5 runs this automatically
 * at releaseAt; until then, run it by hand once releaseAt has passed.
 *
 *   npm run release:start -- --batch demo-2026-11 [--wait]
 */
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { assertBatchId } from '../src/crypto/format';
import { fail, parseArgs } from './lib/cli';
import { requireApprovalOutputs, stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
const batchId = assertBatchId(args.get('batch') ?? 'demo-2026-11');

const outputs = await stackOutputs(stack);
const m4 = requireApprovalOutputs(outputs);
const sfn = new SFNClient({});

const { executionArn } = await sfn.send(
  new StartExecutionCommand({
    stateMachineArn: m4.ApprovalStateMachineArn,
    name: `${batchId}-release-${Date.now()}`,
    input: JSON.stringify({ batchId }),
  }),
);
console.log(`▶ Release workflow started for ${batchId}`);
console.log(`  ${executionArn}`);
console.log(`  status: ${m4.ApprovalApiUrl}/status?batch=${batchId}`);

// Give openApprovals a moment, then report whether approvals are open or it refused (e.g. too early).
await new Promise((r) => setTimeout(r, 4000));
let d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
if (d.status === 'FAILED') fail(`Workflow failed: ${d.error ?? ''} ${d.cause ?? ''}`);
console.log('✓ Approvals are open. Waiting for 2 of 3 officials…');

if (args.get('wait') === 'true') {
  while (d.status === 'RUNNING') {
    await new Promise((r) => setTimeout(r, 3000));
    d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  }
  if (d.status !== 'SUCCEEDED') fail(`Workflow ${d.status}: ${d.error ?? ''} ${d.cause ?? ''}`);
  console.log(`🔓 Released: ${d.output}`);
}
