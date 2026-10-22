/** A single line of the target JSON order model. */
export interface OrderLine {
  lineId: number;
  itemId: string;
  quantity: number;
  unitOfMeasure: string;
  /** Free-text note of the UBL OrderLine; omitted when the line has no note. */
  comment?: string;
}

/** Target JSON order model produced from a UBL 2.1 Order document. */
export interface Order {
  orderId: string;
  externalOrganizationId: string;
  /** UBL CustomerReference is optional; omitted when absent. */
  reference?: string;
  /** Calendar date in YYYY-MM-DD format. */
  orderDate: string;
  lines: OrderLine[];
}

/** Message published to the output topic (orders.transformed). */
export interface TransformedOrderMessage {
  messageId: string;
  transformedAt: string;
  order: Order;
}
