import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { awsBatchStore } from '../aws';
import { makeReleaseWaiter, type ApprovalStarter } from '../release-waiter';

const stateMachineArn = process.env['APPROVAL_STATE_MACHINE_ARN'];
if (!stateMachineArn) throw new Error('Missing environment variable APPROVAL_STATE_MACHINE_ARN');
const sfn = new SFNClient({});

const approvals: ApprovalStarter = {
  async start(batchId) {
    const name = `${batchId}-release`;
    const executionArn = `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
    try {
      const out = await sfn.send(new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify({ batchId }) }));
      return { executionArn: out.executionArn ?? executionArn, alreadyStarted: false };
    } catch (err) {
      // Same name used before (e.g. a duplicate waiter): approvals were already opened once.
      if (err instanceof ExecutionAlreadyExists) return { executionArn, alreadyStarted: true };
      throw err;
    }
  },
};

export const handler = makeReleaseWaiter({ batches: awsBatchStore(), approvals });
