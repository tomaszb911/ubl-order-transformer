import { describe, expect, it } from 'vitest';
import { decodeBase64, decodeDocument } from '../../src/domain/decode-document.js';
import { InvalidBase64Error, InvalidXmlError } from '../../src/domain/errors.js';
import { SAMPLE_XML, toBase64 } from '../helpers.js';

describe('decodeBase64', () => {
  it('decodes a valid Base64 string', () => {
    expect(decodeBase64('aGVsbG8=').toString('utf8')).toBe('hello');
  });

  it('accepts strings without padding characters when the length is a multiple of 4', () => {
    expect(decodeBase64('YWJj').toString('utf8')).toBe('abc');
  });

  it('tolerates MIME line breaks', () => {
    const wrapped = toBase64(SAMPLE_XML).replace(/(.{76})/g, '$1\r\n');
    expect(decodeBase64(wrapped).toString('utf8')).toBe(SAMPLE_XML);
  });

  it.each([
    ['empty string', ''],
    ['characters outside the alphabet', 'abc$def='],
    ['invalid length', 'abcde'],
    ['padding in the middle', 'ab=cdefg'],
    ['too much padding', 'a==='],
    ['URL-safe alphabet', 'ab-_'],
    ['plain XML', '<Order/>'],
    ['spaces inside', 'aGVs bG8='],
  ])('rejects %s', (_case, value) => {
    expect(() => decodeBase64(value)).toThrow(InvalidBase64Error);
  });

  it('uses the error message required by the contract', () => {
    expect(() => decodeBase64('***')).toThrow('Document is not a valid Base64 string.');
  });
});

describe('decodeDocument', () => {
  it('returns the XML text of the encoded document', () => {
    expect(decodeDocument(toBase64(SAMPLE_XML))).toBe(SAMPLE_XML);
  });

  it('strips a UTF-8 byte order mark', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<Order/>')]);
    expect(decodeDocument(withBom.toString('base64'))).toBe('<Order/>');
  });

  it('rejects content that is not valid UTF-8 as invalid XML', () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd, 0x00]).toString('base64');
    expect(() => decodeDocument(binary)).toThrow(InvalidXmlError);
  });

  it('rejects a document that decodes to whitespace only', () => {
    expect(() => decodeDocument(toBase64('   \n'))).toThrow(InvalidXmlError);
  });
});
