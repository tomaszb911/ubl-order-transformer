import { describe, expect, it } from 'vitest';
import { InvalidXmlError, ValidationError } from '../../src/domain/errors.js';
import { parseUblOrder } from '../../src/domain/parse-ubl-order.js';
import { SAMPLE_XML } from '../helpers.js';

const UBL_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Order-2';
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

describe('parseUblOrder', () => {
  it('parses the sample UBL 2.1 Order into local-name elements', () => {
    const order = parseUblOrder(SAMPLE_XML);

    expect(order.ID).toBe('12347');
    expect(order.IssueDate).toBe('2025-01-01');
    expect(order.CustomerReference).toBe('test-order');
    expect(order.BuyerCustomerParty).toEqual({ SupplierAssignedAccountID: '1234567' });
    expect(order.OrderLine).toHaveLength(2);
  });

  it('keeps identifier values as strings (no numeric coercion)', () => {
    const order = parseUblOrder(
      SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>000123</cbc:ID>'),
    );
    expect(order.ID).toBe('000123');
  });

  it('exposes attributes such as Quantity/@unitCode', () => {
    const order = parseUblOrder(SAMPLE_XML);
    expect(order.OrderLine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          LineItem: expect.objectContaining({ Quantity: { '#text': '1', '@_unitCode': 'EA' } }),
        }),
      ]),
    );
  });

  it('always returns OrderLine as an array, even for a single line', () => {
    const xml = `<Order xmlns="${UBL_NS}" xmlns:cac="${CAC_NS}" xmlns:cbc="${CBC_NS}">
      <cac:OrderLine><cac:LineItem><cbc:ID>1</cbc:ID></cac:LineItem></cac:OrderLine>
    </Order>`;
    expect(Array.isArray(parseUblOrder(xml).OrderLine)).toBe(true);
  });

  it('does not depend on the namespace prefixes chosen by the sender', () => {
    const xml = `<ubl:Order xmlns:ubl="${UBL_NS}" xmlns:b="${CBC_NS}">
      <b:ID>42</b:ID>
    </ubl:Order>`;
    expect(parseUblOrder(xml).ID).toBe('42');
  });

  it('decodes standard XML entities', () => {
    const xml = `<Order xmlns:cbc="${CBC_NS}"><cbc:CustomerReference>A &amp; B</cbc:CustomerReference></Order>`;
    expect(parseUblOrder(xml).CustomerReference).toBe('A & B');
  });

  it('returns an empty element for an empty <Order/>', () => {
    expect(parseUblOrder('<Order/>')).toEqual({});
  });

  it.each([
    ['not XML at all', 'this is not xml'],
    ['an unclosed element', '<Order><cbc:ID>1</cbc:ID>'],
    ['mismatched tags', '<Order><ID>1</Name></Order>'],
    ['two root elements', '<Order/><Order/>'],
    ['two different root elements', '<Order/><Invoice/>'],
    ['an empty string', ''],
  ])('throws InvalidXmlError for %s', (_case, xml) => {
    expect(() => parseUblOrder(xml)).toThrow(InvalidXmlError);
  });

  it('rejects documents with a DOCTYPE (entity expansion / XXE protection)', () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE Order [<!ENTITY lol "lol">]>
      <Order><ID>&lol;</ID></Order>`;
    expect(() => parseUblOrder(xml)).toThrow(InvalidXmlError);
  });

  it('throws ValidationError for well-formed XML that is not a UBL Order', () => {
    expect(() => parseUblOrder('<Invoice><ID>1</ID></Invoice>')).toThrow(ValidationError);
    expect(() => parseUblOrder('<Invoice><ID>1</ID></Invoice>')).toThrow(
      /expected root element 'Order'/,
    );
  });
});
