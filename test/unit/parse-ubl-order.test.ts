import { describe, expect, it } from 'vitest';
import { InvalidXmlError, ValidationError } from '../../src/domain/errors.js';
import { parseUblOrder } from '../../src/domain/parse-ubl-order.js';
import { SAMPLE_XML } from '../helpers.js';

const UBL_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Order-2';
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

/** The parsed <Order> element (warnings are covered by their own tests). */
const parse = (xml: string) => parseUblOrder(xml).order;

describe('parseUblOrder', () => {
  it('parses the sample UBL 2.1 Order into local-name elements', () => {
    const order = parse(SAMPLE_XML);

    expect(order.ID).toBe('12347');
    expect(order.IssueDate).toBe('2025-01-01');
    expect(order.CustomerReference).toBe('test-order');
    expect(order.BuyerCustomerParty).toEqual({ SupplierAssignedAccountID: '1234567' });
    expect(order.OrderLine).toHaveLength(2);
  });

  it('keeps identifier values as strings (no numeric coercion)', () => {
    const order = parse(SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>000123</cbc:ID>'));
    expect(order.ID).toBe('000123');
  });

  it('exposes attributes such as Quantity/@unitCode', () => {
    const order = parse(SAMPLE_XML);
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
    expect(Array.isArray(parse(xml).OrderLine)).toBe(true);
  });

  it('does not depend on the namespace prefixes chosen by the sender', () => {
    const xml = `<ubl:Order xmlns:ubl="${UBL_NS}" xmlns:b="${CBC_NS}">
      <b:ID>42</b:ID>
    </ubl:Order>`;
    expect(parse(xml).ID).toBe('42');
  });

  it('decodes standard XML entities', () => {
    const xml = `<Order xmlns="${UBL_NS}" xmlns:cbc="${CBC_NS}"><cbc:CustomerReference>A &amp; B</cbc:CustomerReference></Order>`;
    expect(parse(xml).CustomerReference).toBe('A & B');
  });

  it('returns an empty element for an empty <Order/>', () => {
    expect(parse(`<Order xmlns="${UBL_NS}"/>`)).toEqual({});
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

  describe('UBL Order namespace', () => {
    const MISSING_NAMESPACE_WARNING = `Root element 'Order' has no namespace (expected '${UBL_NS}'); processed as a UBL Order.`;
    const foreignNamespace = (found: string) =>
      new ValidationError(
        `Document is not a UBL Order (expected namespace '${UBL_NS}', found '${found}').`,
      );

    it('accepts the UBL namespace as default or bound to any prefix, without warnings', () => {
      expect(parseUblOrder(`<Order xmlns="${UBL_NS}"><ID>1</ID></Order>`)).toEqual({
        order: { ID: '1' },
        warnings: [],
      });
      expect(parseUblOrder(`<o:Order xmlns:o="${UBL_NS}"><o:ID>1</o:ID></o:Order>`)).toEqual({
        order: { ID: '1' },
        warnings: [],
      });
      expect(parseUblOrder(SAMPLE_XML).warnings).toEqual([]);
    });

    it('accepts an Order without a namespace, with a warning', () => {
      expect(parseUblOrder('<Order><ID>1</ID></Order>')).toEqual({
        order: { ID: '1' },
        warnings: [MISSING_NAMESPACE_WARNING],
      });
    });

    it('treats a prefixed root whose prefix is not declared as having no namespace', () => {
      const xml = `<ubl:Order xmlns="${UBL_NS}"><ubl:ID>1</ubl:ID></ubl:Order>`;
      expect(parseUblOrder(xml).warnings).toEqual([MISSING_NAMESPACE_WARNING]);
    });

    it('rejects an Order in a foreign namespace', () => {
      expect(() => parseUblOrder('<Order xmlns="urn:example:order"><ID>1</ID></Order>')).toThrow(
        foreignNamespace('urn:example:order'),
      );
    });

    it('resolves the prefix of the root element, not the default namespace', () => {
      const xml = `<x:Order xmlns="${UBL_NS}" xmlns:x="urn:example:order"><x:ID>1</x:ID></x:Order>`;
      expect(() => parseUblOrder(xml)).toThrow(foreignNamespace('urn:example:order'));
    });
  });

  it('throws ValidationError for well-formed XML that is not a UBL Order', () => {
    expect(() => parseUblOrder('<Invoice><ID>1</ID></Invoice>')).toThrow(ValidationError);
    expect(() => parseUblOrder('<Invoice><ID>1</ID></Invoice>')).toThrow(
      /expected root element 'Order'/,
    );
  });
});
