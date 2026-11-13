import { awsDepsFromEnv } from '../aws';
import { encryptBatch, type EncryptBatchEvent, type KeyCache } from '../publish';

const deps = awsDepsFromEnv();
const keyCache: KeyCache = new Map();

export const handler = (event: EncryptBatchEvent) => encryptBatch(event, deps, keyCache);
