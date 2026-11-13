/**
 * Encrypt side (Node). Runs in the encryptBatch Lambda (M2) and local staging.
 * Uses node:crypto so the format is tested against an independent
 * implementation (WebCrypto) on the decrypt side.
 */
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  FILE_LEN,
  FormatInputError,
  HEADER_LEN,
  IV_LEN,
  KEY_LEN,
  PLAINTEXT_LEN,
  SALT_LEN,
  TAG_LEN,
  buildHeader,
  hkdfInfo,
  padPlaintext,
} from './format';

export interface EncryptInput {
  masterKey: Uint8Array;
  batchId: string;
  usn: string;
  dob: string;
  result: unknown;
}

/** Only for fixed test vectors. Never pass these in production code. */
export interface EncryptOverrides {
  salt?: Uint8Array;
  iv?: Uint8Array;
}

export function encryptResult(input: EncryptInput, overrides: EncryptOverrides = {}): Uint8Array {
  if (input.masterKey.length !== KEY_LEN) {
    throw new FormatInputError(`masterKey must be ${KEY_LEN} bytes`);
  }
  // Validate + pad before touching keys, so bad input fails fast.
  const info = hkdfInfo(input.batchId, input.usn, input.dob);
  const plaintext = padPlaintext(JSON.stringify(input.result));

  const salt = overrides.salt ?? randomBytes(SALT_LEN);
  const iv = overrides.iv ?? randomBytes(IV_LEN);
  const header = buildHeader(salt, iv);

  const studentKey = Buffer.from(hkdfSync('sha256', input.masterKey, salt, info, KEY_LEN));
  try {
    const cipher = createCipheriv('aes-256-gcm', studentKey, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const file = new Uint8Array(FILE_LEN);
    file.set(header, 0);
    file.set(ciphertext, HEADER_LEN);
    file.set(tag, HEADER_LEN + PLAINTEXT_LEN);
    return file;
  } finally {
    studentKey.fill(0);
  }
}
