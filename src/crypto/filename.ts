/**
 * Public file name for a student: hex(sha256(normalised USN)) + ".bin".
 * Browser-safe (WebCrypto); the PWA uses the same function to find its file.
 */
import { normaliseUsn } from './format';

export async function fileNameFor(
  usn: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(normaliseUsn(usn)));
  return `${toHex(new Uint8Array(digest))}.bin`;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
