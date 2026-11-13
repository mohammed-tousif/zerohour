import { awsDepsFromEnv } from '../aws';
import { createBatch, type CreateBatchInput } from '../publish';

const deps = awsDepsFromEnv();

export const handler = (event: CreateBatchInput) => createBatch(event, deps);
