import { awsBatchStore, awsCdnMetricsFromEnv } from '../aws';
import type { HttpEvent } from '../approve-http';
import { handleMetrics } from '../metrics';

const cdn = awsCdnMetricsFromEnv();
const deps = { batches: awsBatchStore(), ...(cdn ? { cdn } : {}) };

export const handler = (event: HttpEvent) => handleMetrics(event, deps);
