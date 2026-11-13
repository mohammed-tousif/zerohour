/**
 * Starts the release waiter for an already-STAGED batch (the publish workflow
 * does this automatically for new batches). Safe to repeat: the durable
 * execution name is the batch id, so a second call returns the same execution.
 *
 *   npm run release:schedule -- --batch demo-2026-11
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { assertBatchId } from '../src/crypto/format';
import { fail, parseArgs } from './lib/cli';
import { stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
const batchId = assertBatchId(args.get('batch') ?? 'demo-2026-11');

const outputs = (await stackOutputs(stack)) as Awaited<ReturnType<typeof stackOutputs>> & { ReleaseWaiterAliasArn?: string };
if (!outputs.ReleaseWaiterAliasArn) fail('The stack has no release waiter yet; run npm run deploy first');

const out = await new LambdaClient({}).send(
  new InvokeCommand({
    FunctionName: outputs.ReleaseWaiterAliasArn,
    InvocationType: 'Event',
    DurableExecutionName: batchId,
    Payload: JSON.stringify({ batchId }),
  }),
);
if (out.StatusCode !== 202) fail(`Unexpected status ${out.StatusCode}`);
console.log(`⏳ Release waiter started for ${batchId}: it sleeps until releaseAt (no compute billed), then opens approvals.`);
// list-durable-executions-by-function can't filter by alias, so list by function name.
console.log(`   Inspect: aws lambda list-durable-executions-by-function --function-name ${outputs.ReleaseWaiterAliasArn.split(':')[6]}`);
