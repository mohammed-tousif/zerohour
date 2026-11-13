import { awsApprovalStore, awsBatchStore, awsTaskCallbacks } from '../aws';
import { handleHttp, type HttpEvent } from '../approve-http';

const deps = { approvals: awsApprovalStore(), batches: awsBatchStore(), callbacks: awsTaskCallbacks() };

export const handler = (event: HttpEvent) => handleHttp(event, deps);
