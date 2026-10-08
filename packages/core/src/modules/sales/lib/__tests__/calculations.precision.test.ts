import {
  calculateDocumentTotals,
  calculateLine,
  createSalesCalculationRegistry,
} from '../calculations'
import type { SalesLineSnapshot } from '../types'

const ethContext = {
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  currencyCode: 'ETH',
  amountDecimalPlaces: 18,
}

const wei = '0.000000000000000001'

describe('sales calculations with arbitrary precision', () => {
  it('keeps 18 decimal place unit prices exact through line and document totals', async () => {
    const lines: SalesLineSnapshot[] = [
      {
        kind: 'product',
        quantity: 3,
        currencyCode: 'ETH',
        unitPriceNet: Number(wei),
        unitPriceNetExact: wei,
        taxRate: 0,
      },
      {
        kind: 'product',
        quantity: 1,
        currencyCode: 'ETH',
        unitPriceNet: Number('1.123456789012345678'),
        unitPriceNetExact: '1.123456789012345678',
        taxRate: 0,
      },
    ]

    const result = await calculateDocumentTotals({
      documentKind: 'order',
      lines,
      context: ethContext,
    })

    expect(result.lines[0].netAmountExact).toBe('0.000000000000000003')
    expect(result.totals.grandTotalNetAmountExact).toBe('1.123456789012345681')
    expect(result.totals.grandTotalGrossAmountExact).toBe('1.123456789012345681')
    expect(result.totals.grandTotalNetAmount).toBe(Number('1.123456789012345681'))
  })

  it('rounds tax to the currency precision instead of 4 decimals', async () => {
    const result = await calculateLine({
      documentKind: 'order',
      line: {
        kind: 'product',
        quantity: 1,
        currencyCode: 'ETH',
        unitPriceNet: 0.123456789,
        unitPriceNetExact: '0.123456789',
        taxRate: 23,
      },
      context: ethContext,
    })

    expect(result.taxAmountExact).toBe('0.02839506147')
    expect(result.grossAmountExact).toBe('0.15185185047')
  })

  it('keeps the 4 decimal default for fiat currencies', async () => {
    const result = await calculateLine({
      documentKind: 'order',
      line: { kind: 'product', quantity: 1, currencyCode: 'USD', unitPriceNet: 0.123456789, taxRate: 23 },
      context: { tenantId: 'tenant-1', organizationId: 'org-1', currencyCode: 'USD' },
    })

    expect(result.netAmountExact).toBe('0.1235')
    expect(result.taxAmountExact).toBe('0.0284')
    expect(result.netAmount).toBe(0.1235)
  })

  it('applies totals on payments exactly', async () => {
    const result = await calculateDocumentTotals({
      documentKind: 'order',
      lines: [
        { kind: 'product', quantity: 1, currencyCode: 'ETH', unitPriceNet: 1, unitPriceNetExact: '1', taxRate: 0 },
      ],
      context: ethContext,
      existingTotals: { paidTotalAmount: Number('0.999999999999999999'), paidTotalAmountExact: '0.999999999999999999' },
    })

    expect(result.totals.outstandingAmountExact).toBe(wei)
  })

  it('re-derives exact amounts when a legacy hook changes only the float field', async () => {
    const registry = createSalesCalculationRegistry()
    registry.registerLineCalculator(({ current }) => ({ ...current, netAmount: 42 }))

    const result = await registry.calculateLine({
      documentKind: 'order',
      line: { kind: 'product', quantity: 1, currencyCode: 'ETH', unitPriceNet: 1, unitPriceNetExact: '1.000000000000000001' },
      context: ethContext,
    })

    expect(result.netAmountExact).toBe('42')
    expect(result.grossAmountExact).toBe('1.000000000000000001')
  })
})
