import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { InvalidXmlError, ValidationError } from './errors.js';

/** Generic shape of a node produced by fast-xml-parser. */
export type XmlNode = string | XmlElement | XmlNode[];
export interface XmlElement {
  [name: string]: XmlNode | undefined;
}

export const ATTRIBUTE_PREFIX = '@_';
export const TEXT_KEY = '#text';

/** Namespace of the root element of a UBL 2.x Order document. */
export const UBL_ORDER_NAMESPACE = 'urn:oasis:names:specification:ubl:schema:xsd:Order-2';

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

// `removeNSPrefix` above also drops the xmlns declarations, so the root element's
// namespace is read by a second parser that keeps prefixes and attributes as they are.
const namespaceAwareParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export interface ParsedUblOrder {
  /** The root <Order> element, with namespace prefixes removed. */
  order: XmlElement;
  /** Problems that do not prevent processing but are worth reporting (logged by the caller). */
  warnings: string[];
}

/**
 * Parses a UBL 2.1 Order document and returns its root <Order> element.
 *
 * Namespace policy: an `Order` in a foreign namespace is another format and is rejected;
 * an `Order` without any namespace is accepted with a warning, so partners sending
 * otherwise correct but sloppy XML are not blocked during onboarding.
 *
 * @throws InvalidXmlError when the text is not well-formed XML (or contains a DTD).
 * @throws ValidationError when the XML is well-formed but is not a UBL Order
 *   (root element other than 'Order', or an 'Order' in a non-UBL namespace).
 */
export function parseUblOrder(xml: string): ParsedUblOrder {
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

  const warnings: string[] = [];
  const namespace = rootNamespace(xml);
  if (namespace === undefined) {
    warnings.push(
      `Root element 'Order' has no namespace (expected '${UBL_ORDER_NAMESPACE}'); processed as a UBL Order.`,
    );
  } else if (namespace !== UBL_ORDER_NAMESPACE) {
    throw new ValidationError(
      `Document is not a UBL Order (expected namespace '${UBL_ORDER_NAMESPACE}', found '${namespace}').`,
    );
  }

  // An empty <Order/> is parsed as an empty string; the mapper reports the missing fields.
  return { order: typeof order === 'object' ? order : {}, warnings };
}

/**
 * Resolves the namespace URI of the root element: `<Order xmlns="...">` uses the default
 * namespace, `<ubl:Order xmlns:ubl="...">` the one bound to its prefix.
 * The root element can only be bound by declarations on itself.
 */
function rootNamespace(xml: string): string | undefined {
  const parsed = namespaceAwareParser.parse(xml) as XmlElement;
  const [qualifiedName] = Object.keys(parsed);
  if (qualifiedName === undefined) return undefined;

  const root = parsed[qualifiedName];
  if (typeof root !== 'object' || Array.isArray(root)) return undefined; // e.g. <Order/>: no attributes

  const separator = qualifiedName.indexOf(':');
  const declaration = separator === -1 ? 'xmlns' : `xmlns:${qualifiedName.slice(0, separator)}`;
  const uri = root[`${ATTRIBUTE_PREFIX}${declaration}`];
  return typeof uri === 'string' ? uri : undefined;
}
