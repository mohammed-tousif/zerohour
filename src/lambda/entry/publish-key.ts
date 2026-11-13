import { awsApprovalStore, awsCdnFromEnv, awsDepsFromEnv } from '../aws';
import { publishKey } from '../approval';

const base = awsDepsFromEnv();
const cdn = awsCdnFromEnv();
const deps = { ...base, approvals: awsApprovalStore(), ...(cdn ? { cdn } : {}) };

export const handler = (event: { batchId: string }) => publishKey(event, deps);
