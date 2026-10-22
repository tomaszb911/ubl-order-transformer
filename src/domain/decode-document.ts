import { InvalidBase64Error, InvalidXmlError } from './errors.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Strictly decodes a standard (RFC 4648) Base64 string.
 *
 * Node's `Buffer.from(value, 'base64')` never throws - it silently skips invalid
 * characters - so the alphabet and padding are validated explicitly.
 * Line breaks are tolerated because MIME-style encoders wrap output at 76 chars.
 */
export function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/[\r\n]/g, '');

  if (normalized.length === 0) {
    throw new InvalidBase64Error('Base64 string is empty');
  }
  if (normalized.length % 4 !== 0) {
    throw new InvalidBase64Error(`Base64 length ${normalized.length} is not a multiple of 4`);
  }
  if (!BASE64_PATTERN.test(normalized)) {
    throw new InvalidBase64Error('Base64 string contains characters outside of the alphabet');
  }

  return Buffer.from(normalized, 'base64');
}

/** Decodes the Base64 `document` field into the UBL XML text (UTF-8, BOM stripped). */
export function decodeDocument(base64Document: string): string {
  const bytes = decodeBase64(base64Document);

  let xml: string;
  try {
    xml = utf8Decoder.decode(bytes);
  } catch {
    throw new InvalidXmlError('Decoded document is not valid UTF-8');
  }

  if (xml.trim().length === 0) {
    throw new InvalidXmlError('Decoded document is empty');
  }
  return xml;
}
