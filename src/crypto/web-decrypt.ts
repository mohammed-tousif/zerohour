/**
 * Decrypt side (WebCrypto only). This exact code ships to the student PWA (M3).
 * Works in browsers and in Node >= 22 via globalThis.crypto.subtle.
 */
import { KEY_LEN, FormatInputError, hkdfInfo, parseFile } from './format';

export interface DecryptInput {
  file: Uint8Array;
  /** The released 32-byte master key (base64-decoded from release.json). */
  masterKey: Uint8Array;
  batchId: string;
  usn: string;
  dob: string;
}

/** Wrong USN / DOB / key / batch, or the file was changed. Deliberately vague. */
export class DecryptError extends Error {
  override name = 'DecryptError';
}

export async function decryptResult<T = unknown>(
  input: DecryptInput,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<T> {
  if (input.masterKey.length !== KEY_LEN) {
    throw new FormatInputError(`masterKey must be ${KEY_LEN} bytes`);
  }
  const { header, salt, iv, sealed } = parseFile(input.file);
  const info = hkdfInfo(input.batchId, input.usn, input.dob);

  const ikm = await subtle.importKey('raw', new Uint8Array(input.masterKey), 'HKDF', false, [
    'deriveKey',
  ]);
  const studentKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
      studentKey,
      sealed,
    );
  } catch {
    throw new DecryptError('Could not open this result: check USN and date of birth');
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Decodes the base64 key from release.json. */
export function decodeReleasedKey(base64: string): Uint8Array {
  const binary = atob(base64);
  const key = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (key.length !== KEY_LEN) {
    throw new FormatInputError(`Released key must be ${KEY_LEN} bytes`);
  }
  return key;
}
