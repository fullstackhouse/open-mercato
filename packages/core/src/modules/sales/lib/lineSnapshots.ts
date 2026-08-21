import type { SalesOrderLine, SalesQuoteLine } from '../data/entities'
import type { SalesLineSnapshot } from './types'

function toNumeric(value: unknown): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// Both order and quote lines expose the same pricing shape; the mappers below
// differ only in the entity they accept.
type PersistedSalesLine = SalesOrderLine | SalesQuoteLine

function mapPersistedLineToSnapshot(line: PersistedSalesLine): SalesLineSnapshot {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    kind: line.kind,
    productId: line.productId ?? null,
    productVariantId: line.productVariantId ?? null,
    name: line.name ?? null,
    description: line.description ?? null,
    comment: line.comment ?? null,
    quantity: toNumeric(line.quantity),
    quantityUnit: line.quantityUnit ?? null,
    normalizedQuantity: toNumeric(line.normalizedQuantity ?? line.quantity),
    normalizedUnit: line.normalizedUnit ?? line.quantityUnit ?? null,
    uomSnapshot: line.uomSnapshot ? cloneJson(line.uomSnapshot) : null,
    currencyCode: line.currencyCode,
    unitPriceNet: toNumeric(line.unitPriceNet),
    unitPriceGross: toNumeric(line.unitPriceGross),
    discountAmount: toNumeric(line.discountAmount),
    // The persisted column holds the discount for the whole line. Marking the
    // origin here is what stops the calculation engine multiplying it by the
    // quantity a second time on every recalculation (#5019).
    discountAmountFromStoredRow: true,
    discountPercent: toNumeric(line.discountPercent),
    taxRate: toNumeric(line.taxRate),
    taxAmount: toNumeric(line.taxAmount),
    totalNetAmount: toNumeric(line.totalNetAmount),
    totalGrossAmount: toNumeric(line.totalGrossAmount),
    configuration: line.configuration ? cloneJson(line.configuration) : null,
    promotionCode: line.promotionCode ?? null,
    metadata: line.metadata ? cloneJson(line.metadata) : null,
    customFieldSetId: line.customFieldSetId ?? null,
  }
}

export function mapOrderLineEntityToSnapshot(line: SalesOrderLine): SalesLineSnapshot {
  return mapPersistedLineToSnapshot(line)
}

export function mapQuoteLineEntityToSnapshot(line: SalesQuoteLine): SalesLineSnapshot {
  return mapPersistedLineToSnapshot(line)
}
