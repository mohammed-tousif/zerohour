import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptError, decodeReleasedKey, decryptResult } from './web-decrypt';
import { encryptResult } from './node-encrypt';
import { FILE_LEN, FormatInputError, HEADER_LEN, PLAINTEXT_LEN, buildHeader, hkdfInfo, padPlaintext } from './format';
import { sha256Hex } from './manifest';
import { VECTOR } from './test-vector';

const subtle = globalThis.crypto.subtle;

const base = {
  masterKey: new Uint8Array(randomBytes(32)),
  batchId: 'demo-2026-11',
  usn: 'DEMO23CS00042',
  dob: '2004-08-09',
};
const result = { demo: true, usn: 'DEMO23CS00042', subjects: [{ code: 'DEMO-CS501', total: 77 }], sgpa: 8.1 };

function encrypt(overrides: Partial<typeof base> = {}): Uint8Array {
  return encryptResult({ ...base, ...overrides, result });
}

/** Independent encrypt using only WebCrypto, to prove the two implementations agree byte for byte. */
async function webEncrypt(v: typeof VECTOR): Promise<Uint8Array> {
  const ikm = await subtle.importKey('raw', new Uint8Array(v.masterKey), 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(v.salt), info: hkdfInfo(v.batchId, v.usn, v.dob) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const header = buildHeader(v.salt, v.iv);
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(v.iv), additionalData: header, tagLength: 128 },
    key,
    padPlaintext(JSON.stringify(v.result)),
  );
  const out = new Uint8Array(HEADER_LEN + sealed.byteLength);
  out.set(header);
  out.set(new Uint8Array(sealed), HEADER_LEN);
  return out;
}

describe('round trip: node:crypto encrypt → WebCrypto decrypt', () => {
  it('returns the original result', async () => {
    await expect(decryptResult({ ...base, file: encrypt() })).resolves.toEqual(result);
  });

  it('accepts the USN in any case/spacing the student types', async () => {
    const file = encrypt();
    await expect(decryptResult({ ...base, usn: ' demo23cs-00042 ', file })).resolves.toEqual(result);
  });

  it('produces a fresh salt and IV every time', () => {
    const a = encrypt();
    const b = encrypt();
    expect(Buffer.from(a.subarray(0, HEADER_LEN)).equals(Buffer.from(b.subarray(0, HEADER_LEN)))).toBe(false);
  });

  it('works with the base64 key format used by release.json', async () => {
    const key = decodeReleasedKey(Buffer.from(base.masterKey).toString('base64'));
    await expect(decryptResult({ ...base, masterKey: key, file: encrypt() })).resolves.toEqual(result);
  });
});

describe('fixed test vector (format v1)', () => {
  it('node encrypt gives the pinned bytes', () => {
    const file = encryptResult(
      { masterKey: VECTOR.masterKey, batchId: VECTOR.batchId, usn: VECTOR.usn, dob: VECTOR.dob, result: VECTOR.result },
      { salt: VECTOR.salt, iv: VECTOR.iv },
    );
    expect(sha256Hex(file)).toBe(VECTOR.EXPECTED_FILE_SHA256);
  });

  it('an independent WebCrypto encrypt gives the same bytes', async () => {
    expect(sha256Hex(await webEncrypt(VECTOR))).toBe(VECTOR.EXPECTED_FILE_SHA256);
  });
});

describe('cannot be opened with the wrong inputs', () => {
  const cases: Array<[string, Partial<typeof base>]> = [
    ['wrong DOB', { dob: '2004-08-10' }],
    ['wrong USN', { usn: 'DEMO23CS00043' }],
    ['wrong batch', { batchId: 'demo-2026-12' }],
    ['wrong master key', { masterKey: new Uint8Array(randomBytes(32)) }],
  ];
  it.each(cases)('%s → DecryptError', async (_label, wrong) => {
    const file = encrypt();
    await expect(decryptResult({ ...base, ...wrong, file })).rejects.toBeInstanceOf(DecryptError);
  });
});

describe('tamper detection', () => {
  const file = encrypt();
  const positions: Array<[string, number]> = [
    ['salt', 1],
    ['iv', 20],
    ['ciphertext start', HEADER_LEN],
    ['ciphertext end', HEADER_LEN + PLAINTEXT_LEN - 1],
    ['tag', FILE_LEN - 1],
  ];
  it.each(positions)('flipping a bit in the %s → DecryptError', async (_label, at) => {
    const tampered = file.slice();
    tampered[at]! ^= 0x01;
    await expect(decryptResult({ ...base, file: tampered })).rejects.toBeInstanceOf(DecryptError);
  });

  it('a changed version byte is rejected before decrypting', async () => {
    const tampered = file.slice();
    tampered[0] = 2;
    await expect(decryptResult({ ...base, file: tampered })).rejects.toBeInstanceOf(FormatInputError);
  });

  it('a truncated file is rejected', async () => {
    await expect(decryptResult({ ...base, file: file.slice(0, -1) })).rejects.toBeInstanceOf(FormatInputError);
  });
});

describe('fixed size', () => {
  it('every file is exactly 1,069 bytes regardless of content', () => {
    expect(FILE_LEN).toBe(1069);
    const small = encryptResult({ ...base, result: {} });
    const large = encryptResult({ ...base, result: { pad: 'x'.repeat(900) } });
    expect(small.length).toBe(FILE_LEN);
    expect(large.length).toBe(FILE_LEN);
  });

  it('refuses results over 1,024 bytes of JSON', () => {
    expect(() => encryptResult({ ...base, result: { pad: 'x'.repeat(1100) } })).toThrow(FormatInputError);
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => encryptResult({ ...base, masterKey: new Uint8Array(16), result })).toThrow(FormatInputError);
  });
});
