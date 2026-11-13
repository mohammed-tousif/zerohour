import { awsDepsFromEnv } from '../aws';
import { finalizeManifest, type FinalizeInput } from '../publish';

const deps = awsDepsFromEnv();

export const handler = (event: FinalizeInput) => finalizeManifest(event, deps);
