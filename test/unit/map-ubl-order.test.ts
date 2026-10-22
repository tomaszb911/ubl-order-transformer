import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import { mapUblOrder } from '../../src/domain/map-ubl-order.js';
import { parseUblOrder } from '../../src/domain/parse-ubl-order.js';
import { EXPECTED_OUTPUT, SAMPLE_XML, sampleWithout } from '../helpers.js';

const map = (xml: string) => mapUblOrder(parseUblOrder(xml));

const CBC = 'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';
const CAC = 'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"';

function orderWithLines(lines: string): string {
  return `<Order ${CBC} ${CAC}>
    <cbc:ID>1</cbc:ID>
    <cbc:IssueDate>2025-01-01</cbc:IssueDate>
    <cac:BuyerCustomerParty><cbc:SupplierAssignedAccountID>99</cbc:SupplierAssignedAccountID></cac:BuyerCustomerParty>
    ${lines}
  </Order>`;
}

function line({
  id = '1',
  quantity = '<cbc:Quantity unitCode="EA">1</cbc:Quantity>',
  item = '<cac:Item><cac:SellersItemIdentification><cbc:ID>100100</cbc:ID></cac:SellersItemIdentification></cac:Item>',
  notes = '',
} = {}): string {
  return `<cac:OrderLine>${notes}<cac:LineItem><cbc:ID>${id}</cbc:ID>${quantity}${item}</cac:LineItem></cac:OrderLine>`;
}

const mapError = (xml: string): string => {
  try {
    map(xml);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).message;
  }
  throw new Error('Expected a ValidationError');
};

describe('mapUblOrder', () => {
  it('maps the sample document to the expected JSON order', () => {
    expect(map(SAMPLE_XML)).toEqual(EXPECTED_OUTPUT.order);
  });

  it('produces the fields in the documented order', () => {
    expect(Object.keys(map(SAMPLE_XML))).toEqual([
      'orderId',
      'externalOrganizationId',
      'reference',
      'orderDate',
      'lines',
    ]);
  });

  it('maps a single order line to a one-element array', () => {
    expect(map(orderWithLines(line())).lines).toEqual([
      { lineId: 1, itemId: '100100', quantity: 1, unitOfMeasure: 'EA' },
    ]);
  });

  it('omits optional reference and comment when they are absent', () => {
    const order = map(orderWithLines(line()));
    expect(order).not.toHaveProperty('reference');
    expect(order.lines[0]).not.toHaveProperty('comment');
  });

  it('joins multiple OrderLine notes with a newline', () => {
    const order = map(
      orderWithLines(line({ notes: '<cbc:Note>first</cbc:Note><cbc:Note>second</cbc:Note>' })),
    );
    expect(order.lines[0]?.comment).toBe('first\nsecond');
  });

  it('maps decimal quantities and other units of measure', () => {
    const order = map(
      orderWithLines(line({ quantity: '<cbc:Quantity unitCode="KGM">2.5</cbc:Quantity>' })),
    );
    expect(order.lines[0]).toMatchObject({ quantity: 2.5, unitOfMeasure: 'KGM' });
  });

  it('accepts an issue date with a timezone and outputs the date part', () => {
    const xml = SAMPLE_XML.replace('2025-01-01', '2025-01-01+01:00');
    expect(map(xml).orderDate).toBe('2025-01-01');
  });

  it('trims whitespace around values', () => {
    const xml = SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>\n  12347  \n</cbc:ID>');
    expect(map(xml).orderId).toBe('12347');
  });

  describe('validation', () => {
    it('requires Order/ID with the message from the contract', () => {
      expect(mapError(sampleWithout('<cbc:ID>12347</cbc:ID>'))).toBe('Order ID is required.');
    });

    it('treats an empty Order/ID as missing', () => {
      expect(mapError(SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID> </cbc:ID>'))).toBe(
        'Order ID is required.',
      );
    });

    it('requires Order/IssueDate', () => {
      expect(mapError(sampleWithout('<cbc:IssueDate>2025-01-01</cbc:IssueDate>'))).toBe(
        'Order issue date (IssueDate) is required.',
      );
    });

    it.each(['2025-13-01', '2025-02-30', '01-01-2025', 'yesterday'])(
      'rejects invalid issue date %s',
      (date) => {
        expect(mapError(SAMPLE_XML.replace('2025-01-01', date))).toMatch(/is not a valid date/);
      },
    );

    it('requires BuyerCustomerParty/SupplierAssignedAccountID', () => {
      expect(
        mapError(
          sampleWithout('<cbc:SupplierAssignedAccountID>1234567</cbc:SupplierAssignedAccountID>'),
        ),
      ).toBe(
        'External organization ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.',
      );
    });

    it('requires at least one OrderLine', () => {
      expect(mapError(orderWithLines(''))).toBe('At least one OrderLine is required.');
    });

    it('reports missing line fields with the line position', () => {
      const message = mapError(orderWithLines(line() + line({ id: '2', quantity: '', item: '' })));
      expect(message).toContain(
        'OrderLine 2: item ID (LineItem/Item/SellersItemIdentification/ID) is required.',
      );
      expect(message).toContain('OrderLine 2: quantity (LineItem/Quantity) is required.');
      expect(message).toContain(
        'OrderLine 2: unit of measure (LineItem/Quantity/@unitCode) is required.',
      );
      expect(message).not.toContain('OrderLine 1');
    });

    it('requires the unitCode attribute on Quantity', () => {
      expect(mapError(orderWithLines(line({ quantity: '<cbc:Quantity>1</cbc:Quantity>' })))).toBe(
        'OrderLine 1: unit of measure (LineItem/Quantity/@unitCode) is required.',
      );
    });

    it.each(['0', '-1', 'abc', '1e3', '0x10'])('rejects quantity %s', (quantity) => {
      expect(
        mapError(
          orderWithLines(
            line({ quantity: `<cbc:Quantity unitCode="EA">${quantity}</cbc:Quantity>` }),
          ),
        ),
      ).toMatch(/must be a positive number/);
    });

    it.each(['A1', '1.5', '-3'])('rejects non-integer line ID %s', (id) => {
      expect(mapError(orderWithLines(line({ id })))).toMatch(/must be a positive integer/);
    });

    it('rejects duplicated line IDs', () => {
      expect(mapError(orderWithLines(line() + line()))).toBe(
        'Line ID 1 is used by more than one OrderLine.',
      );
    });

    it('reports all problems at once', () => {
      const message = mapError('<Order/>');
      expect(message).toBe(
        [
          'Order ID is required.',
          'Order issue date (IssueDate) is required.',
          'External organization ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.',
          'At least one OrderLine is required.',
        ].join(' '),
      );
    });
  });
});
