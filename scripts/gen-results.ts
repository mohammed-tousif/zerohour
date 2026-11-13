/**
 * Generates synthetic demo results as CSV.
 *   npm run gen -- [--count 50000] [--seed 20261113] [--out data/results.csv]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toCsv } from '../src/data/csv';
import { DEFAULT_COUNT, DEFAULT_SEED, generateStudents } from '../src/data/generate';
import { intArg, parseArgs } from './lib/cli';

const args = parseArgs();
const count = intArg(args, 'count', DEFAULT_COUNT);
const seed = intArg(args, 'seed', DEFAULT_SEED);
const out = args.get('out') ?? 'data/results.csv';

const started = performance.now();
const students = generateStudents(count, seed);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, toCsv(students), 'utf8');

const failed = students.filter((s) => s.result === 'FAIL').length;
console.log(
  `✓ ${students.length} synthetic students → ${out} (seed ${seed}, ` +
    `${((failed / Math.max(1, students.length)) * 100).toFixed(1)}% with a backlog, ` +
    `${Math.round(performance.now() - started)} ms)`,
);
