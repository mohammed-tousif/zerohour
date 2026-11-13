import { describe, expect, it } from 'vitest';
import { ManifestBuilder, computeRootHash, isManifestConsistent, sha256Hex, verifyFile } from './manifest';

const a = new Uint8Array([1, 2, 3]);
const b = new Uint8Array([4, 5, 6]);
const A = `${'a'.repeat(64)}.bin`;
const B = `${'b'.repeat(64)}.bin`;

function build(order: Array<[string, Uint8Array]>) {
  const m = new ManifestBuilder('demo-1');
  for (const [name, bytes] of order) m.add(name, bytes);
  return m.build(new Date('2026-11-13T08:00:00Z'));
}

describe('manifest', () => {
  it('records the SHA-256 of each file', () => {
    const manifest = build([[A, a]]);
    expect(manifest.files[A]).toBe(sha256Hex(a));
    expect(manifest.count).toBe(1);
  });

  it('root hash does not depend on insertion order', () => {
    expect(build([[A, a], [B, b]]).rootHash).toBe(build([[B, b], [A, a]]).rootHash);
  });

  it('verifyFile accepts the original bytes and rejects changed ones', () => {
    const manifest = build([[A, a]]);
    expect(verifyFile(manifest, A, a)).toBe(true);
    expect(verifyFile(manifest, A, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(verifyFile(manifest, 'missing.bin', a)).toBe(false);
  });

  it('detects an edited entry via the root hash', () => {
    const manifest = build([[A, a], [B, b]]);
    expect(isManifestConsistent(manifest)).toBe(true);
    const edited = { ...manifest, files: { ...manifest.files, [A]: sha256Hex(b) } };
    expect(isManifestConsistent(edited)).toBe(false);
    expect(computeRootHash(edited.files)).not.toBe(manifest.rootHash);
  });

  it('refuses the same file twice (duplicate USN)', () => {
    const m = new ManifestBuilder('demo-1');
    m.add(A, a);
    expect(() => m.add(A, b)).toThrow(/Duplicate/);
  });
});
