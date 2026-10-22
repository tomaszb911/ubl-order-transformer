import { ValidationError } from './errors.js';
import type { Order, OrderLine } from './order.js';
import { ATTRIBUTE_PREFIX, TEXT_KEY, type XmlElement, type XmlNode } from './parse-ubl-order.js';

const LINE_ID_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
// xsd:date, optionally with a timezone (e.g. 2025-01-01+01:00), as allowed by UBL.
const XSD_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Maps a parsed UBL 2.1 <Order> element to the target JSON order model.
 *
 * All problems are collected and reported together, so a partner fixing their
 * integration sees every missing field in one round-trip instead of one at a time.
 *
 * @throws ValidationError listing every missing or invalid field.
 */
export function mapUblOrder(order: XmlElement): Order {
  const errors: string[] = [];

  const orderId = text(order.ID);
  if (orderId === undefined) {
    errors.push('Order ID is required.');
  }

  const orderDate = mapOrderDate(text(order.IssueDate), errors);

  const externalOrganizationId = text(element(order.BuyerCustomerParty)?.SupplierAssignedAccountID);
  if (externalOrganizationId === undefined) {
    errors.push(
      'External organization ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.',
    );
  }

  const reference = text(order.CustomerReference);

  const lineNodes = asArray(order.OrderLine);
  if (lineNodes.length === 0) {
    errors.push('At least one OrderLine is required.');
  }
  const lines = lineNodes.map((node, index) => mapOrderLine(node, index + 1, errors));
  reportDuplicateLineIds(lines, errors);

  if (
    errors.length > 0 ||
    orderId === undefined ||
    orderDate === undefined ||
    externalOrganizationId === undefined
  ) {
    throw new ValidationError(errors.join(' '));
  }

  return {
    orderId,
    externalOrganizationId,
    ...(reference !== undefined && { reference }),
    orderDate,
    lines: lines.filter((line): line is OrderLine => line !== undefined),
  };
}

function mapOrderDate(issueDate: string | undefined, errors: string[]): string | undefined {
  if (issueDate === undefined) {
    errors.push('Order issue date (IssueDate) is required.');
    return undefined;
  }
  const date = XSD_DATE_PATTERN.exec(issueDate)?.[1];
  if (date === undefined || !isCalendarDate(date)) {
    errors.push(`Order issue date (IssueDate) '${issueDate}' is not a valid date (YYYY-MM-DD).`);
    return undefined;
  }
  return date;
}

function mapOrderLine(node: XmlNode, position: number, errors: string[]): OrderLine | undefined {
  const prefix = `OrderLine ${position}:`;
  const errorCountBefore = errors.length;

  const orderLine = element(node);
  const lineItem = element(orderLine?.LineItem);

  const rawLineId = text(lineItem?.ID);
  let lineId: number | undefined;
  if (rawLineId === undefined) {
    errors.push(`${prefix} line ID (LineItem/ID) is required.`);
  } else if (!LINE_ID_PATTERN.test(rawLineId) || !Number.isSafeInteger(Number(rawLineId))) {
    errors.push(`${prefix} line ID (LineItem/ID) '${rawLineId}' must be a positive integer.`);
  } else {
    lineId = Number(rawLineId);
  }

  const itemId = text(element(element(lineItem?.Item)?.SellersItemIdentification)?.ID);
  if (itemId === undefined) {
    errors.push(`${prefix} item ID (LineItem/Item/SellersItemIdentification/ID) is required.`);
  }

  const rawQuantity = text(lineItem?.Quantity);
  let quantity: number | undefined;
  if (rawQuantity === undefined) {
    errors.push(`${prefix} quantity (LineItem/Quantity) is required.`);
  } else if (!DECIMAL_PATTERN.test(rawQuantity) || Number(rawQuantity) <= 0) {
    errors.push(
      `${prefix} quantity (LineItem/Quantity) '${rawQuantity}' must be a positive number.`,
    );
  } else {
    quantity = Number(rawQuantity);
  }

  const unitOfMeasure = attribute(lineItem?.Quantity, 'unitCode');
  if (unitOfMeasure === undefined) {
    errors.push(`${prefix} unit of measure (LineItem/Quantity/@unitCode) is required.`);
  }

  const notes = asArray(orderLine?.Note)
    .map(text)
    .filter((note): note is string => note !== undefined);

  if (
    errors.length > errorCountBefore ||
    lineId === undefined ||
    itemId === undefined ||
    quantity === undefined ||
    unitOfMeasure === undefined
  ) {
    return undefined;
  }

  return {
    lineId,
    itemId,
    quantity,
    unitOfMeasure,
    ...(notes.length > 0 && { comment: notes.join('\n') }),
  };
}

function reportDuplicateLineIds(lines: (OrderLine | undefined)[], errors: string[]): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (line === undefined) continue;
    if (seen.has(line.lineId)) {
      errors.push(`Line ID ${line.lineId} is used by more than one OrderLine.`);
    }
    seen.add(line.lineId);
  }
}

function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

function asArray(node: XmlNode | undefined): XmlNode[] {
  if (node === undefined) return [];
  return Array.isArray(node) ? node : [node];
}

/** Returns the node as an element; an empty element (`<X/>`) is parsed as '' and becomes {}. */
function element(node: XmlNode | undefined): XmlElement | undefined {
  const first = asArray(node)[0];
  if (first === undefined) return undefined;
  if (typeof first === 'string') return first === '' ? {} : undefined;
  return Array.isArray(first) ? undefined : first;
}

/** Text content of a leaf element (with or without attributes); blank text counts as missing. */
function text(node: XmlNode | undefined): string | undefined {
  const first = asArray(node)[0];
  const value =
    typeof first === 'string'
      ? first
      : typeof first === 'object' && !Array.isArray(first)
        ? first[TEXT_KEY]
        : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return text(element(node)?.[`${ATTRIBUTE_PREFIX}${name}`]);
}
