/**
 * Creates one-time approval links for the officials of a STAGED batch.
 * Re-running replaces earlier links (until approvals open).
 *
 *   npm run approvers:invite -- --batch demo-2026-11 \
 *       --names "Registrar,Controller of Examinations,Dean Academics" [--valid-hours 72]
 *
 * The links are secrets: anyone holding two of them can release results.
 * They are printed once and saved to out/approver-links.txt (git-ignored).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { inviteApprovers } from '../src/lambda/approval';
import { DynamoApprovalStore, DynamoBatchStore } from '../src/lambda/aws';
import { fail, intArg, parseArgs } from './lib/cli';
import { requireApprovalOutputs, stackOutputs } from './lib/stack';

const args = parseArgs();
const stack = args.get('stack') ?? 'zerohour';
const batchId = args.get('batch') ?? 'demo-2026-11';
const names = (args.get('names') ?? 'Registrar,Controller of Examinations,Dean Academics').split(',');
const validHours = intArg(args, 'valid-hours', 72);

const outputs = await stackOutputs(stack);
const m4 = requireApprovalOutputs(outputs);
const ddb = new DynamoDBClient({});

const { flow, links } = await inviteApprovers(
  { batchId, names, validHours },
  { approvals: new DynamoApprovalStore(ddb, m4.ApprovalsTableName), batches: new DynamoBatchStore(ddb, outputs.BatchesTableName) },
).catch((err: Error) => fail(err.message));

const lines = links.map(({ approver, token }) => `${approver.name}\n  ${m4.ApprovalApiUrl}/approve?t=${token}`);
await mkdir('out', { recursive: true });
await writeFile('out/approver-links.txt', `Batch ${batchId} — approval links (SECRET, valid ${validHours} h)\n\n${lines.join('\n\n')}\n`, {
  mode: 0o600,
});

console.log(`✓ Invited ${links.length} officials for ${batchId}; ${flow.required} of ${links.length} must approve.`);
console.log('  Treat these links like passwords. Send each one only to its official.\n');
console.log(lines.join('\n\n'));
console.log(`\n  Saved to out/approver-links.txt · status: ${m4.ApprovalApiUrl}/status?batch=${batchId}`);
