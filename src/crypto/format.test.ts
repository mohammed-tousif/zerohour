import { describe, expect, it } from 'vitest';
import { fileNameFor } from './filename';
import { FormatInputError, hkdfInfo, normaliseDob, normaliseUsn, padPlaintext } from './format';

describe('normaliseUsn', () => {
  it('trims, removes spaces and hyphens, uppercases', () => {
    expect(normaliseUsn(' demo23cs-00001 ')).toBe('DEMO23CS00001');
    expect(normaliseUsn('DEMO23 CS 00001')).toBe('DEMO23CS00001');
  });
  it.each(['', 'ABC', 'DEMO23CS00001!', 'X'.repeat(21), 'DEMO|23CS001'])('rejects %j', (bad) => {
    expect(() => normaliseUsn(bad)).toThrow(FormatInputError);
  });
});

describe('normaliseDob', () => {
  it('accepts real dates', () => {
    expect(normaliseDob('2004-02-29')).toBe('2004-02-29');
    expect(normaliseDob(' 2005-12-31 ')).toBe('2005-12-31');
  });
  it.each(['2005-02-29', '2005-02-30', '2005-13-01', '17/05/2004', '2004-5-17', ''])('rejects %j', (bad) => {
    expect(() => normaliseDob(bad)).toThrow(FormatInputError);
  });
});

describe('hkdfInfo', () => {
  it('is zerohour/v1|batch|USN|DOB with normalised values', () => {
    const info = new TextDecoder().decode(hkdfInfo('demo-1', 'demo23cs00001', '2004-05-17'));
    expect(info).toBe('zerohour/v1|demo-1|DEMO23CS00001|2004-05-17');
  });
  it('rejects a batch ID containing the separator', () => {
    expect(() => hkdfInfo('a|b', 'DEMO23CS00001', '2004-05-17')).toThrow(FormatInputError);
  });
});

describe('padPlaintext', () => {
  it('pads with spaces that JSON.parse ignores', () => {
    const padded = padPlaintext('{"a":1}');
    expect(padded.length).toBe(1024);
    expect(JSON.parse(new TextDecoder().decode(padded))).toEqual({ a: 1 });
  });
});

describe('fileNameFor', () => {
  it('is the hex SHA-256 of the normalised USN', async () => {
    // sha256("DEMO23CS00001")
    const expected = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('DEMO23CS00001'),
    );
    const hex = Buffer.from(expected).toString('hex');
    await expect(fileNameFor('DEMO23CS00001')).resolves.toBe(`${hex}.bin`);
    await expect(fileNameFor(' demo23cs-00001')).resolves.toBe(`${hex}.bin`);
  });
  it('never contains the USN itself', async () => {
    expect(await fileNameFor('DEMO23CS00001')).not.toContain('DEMO');
  });
});
