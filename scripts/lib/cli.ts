/** Tiny `--name value` / `--flag` argument parser for the local scripts. */
export { mapLimit } from '../../src/lib/concurrency';

export function parseArgs(argv: string[] = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.set(token.slice(2), 'true');
    } else {
      args.set(token.slice(2), next);
      i++;
    }
  }
  return args;
}

export function intArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`);
  return value;
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
