/**
 * ZeroHour encrypted result file format, version 1.
 *
 * This module must stay browser-safe: no `node:` imports. It is shared by the
 * Lambda encrypt side (Node) and the PWA decrypt side (WebCrypto).
 *
 * File layout (1,069 bytes, always):
 *   version (1) | salt (16) | iv (12) | ciphertext (1024) | tag (16)
 *
 * Per-student key = HKDF-SHA256(ikm = master key, salt, info = hkdfInfo(...), 32 bytes)
 * Cipher          = AES-256-GCM, AAD = the 29 header bytes (version | salt | iv)
 * Plaintext       = result JSON, right-padded with spaces to exactly 1024 bytes
 */

export const FORMAT_VERSION = 1;
export const KEY_LEN = 32;
export const SALT_LEN = 16;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const HEADER_LEN = 1 + SALT_LEN + IV_LEN; // 29
export const PLAINTEXT_LEN = 1024;
export const FILE_LEN = HEADER_LEN + PLAINTEXT_LEN + TAG_LEN; // 1069
export const INFO_PREFIX = 'zerohour/v1';

const SALT_OFFSET = 1;
const IV_OFFSET = SALT_OFFSET + SALT_LEN;

const USN_PATTERN = /^[A-Z0-9]{6,20}$/;
const DOB_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PAD_BYTE = 0x20; // space: JSON.parse ignores trailing whitespace

const encoder = new TextEncoder();

/** Thrown for bad USN / DOB / batch ID / oversized result before any crypto runs. */
export class FormatInputError extends Error {
  override name = 'FormatInputError';
}

/** Trim, drop spaces and hyphens, uppercase. " demo23cs-00001 " -> "DEMO23CS00001". */
export function normaliseUsn(raw: string): string {
  const usn = raw.trim().replace(/[\s-]+/g, '').toUpperCase();
  if (!USN_PATTERN.test(usn)) {
    throw new FormatInputError('USN must be 6-20 letters or digits');
  }
  return usn;
}

/** Accepts only YYYY-MM-DD that is a real calendar date. */
export function normaliseDob(raw: string): string {
  const dob = raw.trim();
  const match = DOB_PATTERN.exec(dob);
  if (!match) {
    throw new FormatInputError('DOB must be YYYY-MM-DD');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new FormatInputError('DOB is not a real calendar date');
  }
  return dob;
}

export function assertBatchId(batchId: string): string {
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw new FormatInputError('batchId must be 1-64 of A-Z a-z 0-9 _ -');
  }
  return batchId;
}

/** HKDF info: UTF-8 of "zerohour/v1|<batchId>|<USN>|<DOB>" (all normalised). */
export function hkdfInfo(batchId: string, usn: string, dob: string): Uint8Array<ArrayBuffer> {
  const parts = [INFO_PREFIX, assertBatchId(batchId), normaliseUsn(usn), normaliseDob(dob)];
  return encoder.encode(parts.join('|'));
}

/** UTF-8 JSON right-padded with spaces to exactly PLAINTEXT_LEN bytes. */
export function padPlaintext(json: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(json);
  if (bytes.length > PLAINTEXT_LEN) {
    throw new FormatInputError(
      `Result JSON is ${bytes.length} bytes; the limit is ${PLAINTEXT_LEN}`,
    );
  }
  const out = new Uint8Array(PLAINTEXT_LEN).fill(PAD_BYTE);
  out.set(bytes);
  return out;
}

export function buildHeader(salt: Uint8Array, iv: Uint8Array): Uint8Array<ArrayBuffer> {
  if (salt.length !== SALT_LEN) throw new FormatInputError(`salt must be ${SALT_LEN} bytes`);
  if (iv.length !== IV_LEN) throw new FormatInputError(`iv must be ${IV_LEN} bytes`);
  const header = new Uint8Array(HEADER_LEN);
  header[0] = FORMAT_VERSION;
  header.set(salt, SALT_OFFSET);
  header.set(iv, IV_OFFSET);
  return header;
}

export interface ParsedFile {
  header: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  /** ciphertext followed by the 16-byte tag, as WebCrypto expects */
  sealed: Uint8Array<ArrayBuffer>;
}

/** Splits a file into its parts (copies, so callers get plain ArrayBuffer views). */
export function parseFile(file: Uint8Array): ParsedFile {
  if (file.length !== FILE_LEN) {
    throw new FormatInputError(`File must be ${FILE_LEN} bytes, got ${file.length}`);
  }
  if (file[0] !== FORMAT_VERSION) {
    throw new FormatInputError(`Unsupported format version ${String(file[0])}`);
  }
  return {
    header: file.slice(0, HEADER_LEN),
    salt: file.slice(SALT_OFFSET, IV_OFFSET),
    iv: file.slice(IV_OFFSET, HEADER_LEN),
    sealed: file.slice(HEADER_LEN),
  };
}
