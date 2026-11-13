/**
 * Bundles each Lambda into dist/lambda/<name>/<name>.mjs (ESM, Node 22, arm64).
 * SAM then only zips these folders, so `sam build` never runs npm in this repo.
 *
 * Most Lambdas leave the AWS SDK v3 external (the Lambda Node.js runtime provides it).
 * release-waiter bundles everything: the durable execution SDK needs a newer
 * @aws-sdk/client-lambda (durable checkpoint APIs) than the runtime may ship, and
 * AWS recommends bundling the durable SDK.
 *
 *   npm run bundle
 */
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

export const LAMBDAS = [
  'create-batch',
  'encrypt-batch',
  'finalize-manifest',
  'open-approvals',
  'approve-api',
  'publish-key',
  'release-waiter',
  'metrics-api',
] as const;

const SELF_CONTAINED = new Set<string>(['release-waiter']);

// Some bundled CommonJS dependencies call require() for Node built-ins; give ESM bundles one.
const REQUIRE_SHIM = "import { createRequire as __zhCreateRequire } from 'node:module'; const require = __zhCreateRequire(import.meta.url);";

await rm('dist/lambda', { recursive: true, force: true });
for (const name of LAMBDAS) {
  const selfContained = SELF_CONTAINED.has(name);
  const result = await build({
    entryPoints: [`src/lambda/entry/${name}.ts`],
    outfile: `dist/lambda/${name}/${name}.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: true,
    external: selfContained ? [] : ['@aws-sdk/*'],
    banner: selfContained ? { js: REQUIRE_SHIM } : {},
    mainFields: ['module', 'main'],
    metafile: true,
    logLevel: 'warning',
  });
  const bytes = Object.values(result.metafile.outputs)
    .filter((o) => o.entryPoint)
    .reduce((n, o) => n + o.bytes, 0);
  console.log(`✓ ${name} → dist/lambda/${name}/${name}.mjs (${(bytes / 1024).toFixed(1)} KB${selfContained ? ', SDK bundled' : ''})`);
}
