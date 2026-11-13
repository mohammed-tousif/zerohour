/**
 * Fixed known-answer vector for format v1. The M3 PWA tests decrypt this same
 * vector in a real browser. If EXPECTED_FILE_SHA256 ever changes, the file
 * format changed: bump FORMAT_VERSION instead of editing the hash.
 */
const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

export const VECTOR = {
  masterKey: hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
  salt: hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf'),
  iv: hex('b0b1b2b3b4b5b6b7b8b9babb'),
  batchId: 'demo-vector',
  usn: 'DEMO23CS00001',
  dob: '2004-05-17',
  result: { demo: true, usn: 'DEMO23CS00001', sgpa: 8.25, result: 'PASS' },
  EXPECTED_FILE_SHA256: '6768cc271e328b5cc3e7a67faec047330171dce0e1330e6843384c3de7e17d3c',
} as const;
