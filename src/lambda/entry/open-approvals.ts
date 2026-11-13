import { awsApprovalStore, awsBatchStore } from '../aws';
import { openApprovals } from '../approval';

const deps = { approvals: awsApprovalStore(), batches: awsBatchStore() };

/** Invoked by Step Functions with .waitForTaskToken; the execution pauses until 2 officials approve. */
export const handler = (event: { batchId: string; taskToken: string }) => openApprovals(event, deps);
