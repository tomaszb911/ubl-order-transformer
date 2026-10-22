import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { InvalidXmlError, ValidationError } from './errors.js';

/** Generic shape of a node produced by fast-xml-parser. */
export type XmlNode = string | XmlElement | XmlNode[];
export interface XmlElement {
  [name: string]: XmlNode | undefined;
}

export const ATTRIBUTE_PREFIX = '@_';
export const TEXT_KEY = '#text';

/** Elements that may occur more than once in a UBL Order and must always be arrays. */
const ALWAYS_ARRAY_PATHS = new Set(['Order.OrderLine', 'Order.OrderLine.Note']);

const DOCTYPE_PATTERN = /<!DOCTYPE/i;

const parser = new XMLParser({
  // UBL relies on namespace prefixes (cbc:, cac:) which partners may name differently;
  // the mapping works on local names only.
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  textNodeName: TEXT_KEY,
  // Keep every value as a string: identifiers such as "000123" must not become numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // A single <OrderLine> must still be mapped as a list.
  isArray: (_name, jPath) => typeof jPath === 'string' && ALWAYS_ARRAY_PATHS.has(jPath),
});

/**
 * Parses a UBL 2.1 Order document and returns its root <Order> element.
 *
 * @throws InvalidXmlError when the text is not well-formed XML (or contains a DTD).
 * @throws ValidationError when the XML is well-formed but is not a UBL Order.
 */
export function parseUblOrder(xml: string): XmlElement {
  // UBL documents never use DTDs; rejecting them closes the door to entity-expansion attacks.
  if (DOCTYPE_PATTERN.test(xml)) {
    throw new InvalidXmlError('DOCTYPE declarations are not allowed');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw new InvalidXmlError(`${msg} (line ${line}, column ${col})`);
  }

  let parsed: XmlElement;
  try {
    parsed = parser.parse(xml) as XmlElement;
  } catch (error) {
    throw new InvalidXmlError(error instanceof Error ? error.message : String(error));
  }

  const rootNames = Object.keys(parsed);
  const order = parsed.Order;
  if (rootNames.length !== 1 || Array.isArray(order)) {
    throw new InvalidXmlError('Document must have exactly one root element');
  }
  if (rootNames[0] !== 'Order') {
    throw new ValidationError(
      `Document is not a UBL Order (expected root element 'Order', found '${rootNames[0]}').`,
    );
  }

  // An empty <Order/> is parsed as an empty string; the mapper reports the missing fields.
  return typeof order === 'object' ? order : {};
}
