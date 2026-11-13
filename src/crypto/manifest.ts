/**
 * Integrity manifest: SHA-256 of every published file, plus a root hash
 * (SHA-256 of the sorted "name:hash\n" lines) that the dashboard displays.
 */
import { createHash } from 'node:crypto';
import { FORMAT_VERSION, assertBatchId } from './format';

export interface Manifest {
  batchId: string;
  formatVersion: number;
  createdAt: string;
  count: number;
  rootHash: string;
  files: Record<string, string>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function computeRootHash(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((name) => `${name}:${files[name]}\n`)
    .join('');
  return sha256Hex(lines);
}

/** Collects file hashes; refuses duplicate names (e.g. a USN listed twice). */
export class ManifestBuilder {
  private readonly files: Record<string, string> = {};

  constructor(private readonly batchId: string) {
    assertBatchId(batchId);
  }

  add(name: string, bytes: Uint8Array): void {
    this.addHash(name, sha256Hex(bytes));
  }

  /** For merging partial manifests whose hashes were computed elsewhere. */
  addHash(name: string, hash: string): void {
    if (!/^[0-9a-f]{64}\.bin$/.test(name)) throw new Error(`Invalid file name in manifest: ${name}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid hash for ${name}`);
    if (Object.hasOwn(this.files, name)) {
      throw new Error(`Duplicate file in manifest: ${name}`);
    }
    this.files[name] = hash;
  }

  get size(): number {
    return Object.keys(this.files).length;
  }

  build(createdAt: Date = new Date()): Manifest {
    const files = Object.fromEntries(
      Object.keys(this.files)
        .sort()
        .map((name) => [name, this.files[name] as string]),
    );
    return {
      batchId: this.batchId,
      formatVersion: FORMAT_VERSION,
      createdAt: createdAt.toISOString(),
      count: Object.keys(files).length,
      rootHash: computeRootHash(files),
      files,
    };
  }
}

/** True when the manifest's count and root hash match its own file list. */
export function isManifestConsistent(manifest: Manifest): boolean {
  return (
    manifest.count === Object.keys(manifest.files).length &&
    manifest.rootHash === computeRootHash(manifest.files)
  );
}

/** True when these bytes are exactly what the manifest recorded for `name`. */
export function verifyFile(manifest: Manifest, name: string, bytes: Uint8Array): boolean {
  const expected = manifest.files[name];
  return expected !== undefined && expected === sha256Hex(bytes);
}
