import { calculateDocumentTotals } from '../calculations'
import { mapOrderLineEntityToSnapshot, mapQuoteLineEntityToSnapshot } from '../lineSnapshots'
import { createLineSnapshotFromInput } from '../../commands/documents'
import type { SalesLineSnapshot } from '../types'

const baseContext = {
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  currencyCode: 'USD',
}

async function calculateLine(line: SalesLineSnapshot) {
  const result = await calculateDocumentTotals({
    documentKind: 'order',
    lines: [line],
    adjustments: [],
    context: baseContext,
  })
  return result.lines[0]
}

/**
 * Round trip: persist what the calculation produced, rebuild the snapshot the way
 * the entity mappers do, and calculate again. This is the shape the write and
 * display paths both take, and the shape that used to re-multiply the discount by
 * the line quantity on every pass (#5019).
 */
async function roundTrip(line: SalesLineSnapshot): Promise<SalesLineSnapshot> {
  const calculated = await calculateLine(line)
  return {
    ...line,
    discountAmount: calculated.discountAmount,
    discountAmountBasis: undefined,
    discountAmountFromStoredRow: true,
    totalNetAmount: calculated.netAmount,
    totalGrossAmount: undefined,
  }
}

describe('line discount contract (#5019)', () => {
  describe('idempotency', () => {
    const cases: Array<{ name: string; line: SalesLineSnapshot }> = [
      {
        name: 'percentage-only, quantity > 1',
        line: { kind: 'product', quantity: 60, currencyCode: 'USD', unitPriceNet: 50, discountPercent: 10, taxRate: 8 },
      },
      {
        name: 'percentage-only, quantity = 1 (where the defect is invisible)',
        line: { kind: 'product', quantity: 1, currencyCode: 'USD', unitPriceNet: 50, discountPercent: 10, taxRate: 8 },
      },
      {
        name: 'amount-only, per-unit basis, quantity > 1',
        line: { kind: 'product', quantity: 4, currencyCode: 'USD', unitPriceNet: 25, discountAmount: 5, taxRate: 20 },
      },
      {
        name: 'amount-only, explicit line basis',
        line: {
          kind: 'product',
          quantity: 4,
          currencyCode: 'USD',
          unitPriceNet: 25,
          discountAmount: 20,
          discountAmountBasis: 'line',
          taxRate: 20,
        },
      },
      {
        name: 'no discount at all',
        line: { kind: 'product', quantity: 3, currencyCode: 'USD', unitPriceNet: 10, taxRate: 20 },
      },
    ]

    it.each(cases)('recalculating N times equals recalculating once — $name', async ({ line }) => {
      const once = await calculateLine(line)

      let snapshot = line
      for (let pass = 0; pass < 3; pass += 1) {
        snapshot = await roundTrip(snapshot)
      }
      const afterThreePasses = await calculateLine(snapshot)

      expect(afterThreePasses.discountAmount).toBeCloseTo(once.discountAmount, 4)
      expect(afterThreePasses.netAmount).toBeCloseTo(once.netAmount, 4)
    })
  })

  describe('the worked example from the spec', () => {
    const line: SalesLineSnapshot = {
      kind: 'product',
      quantity: 60,
      currencyCode: 'USD',
      unitPriceNet: 50,
      discountPercent: 10,
      taxRate: 8,
    }

    it('creates with the discount as a line total and the net discounted', async () => {
      const result = await calculateLine(line)
      expect(result.discountAmount).toBeCloseTo(300, 4)
      expect(result.netAmount).toBeCloseTo(2700, 4)
    })

    it('does not collapse the net to zero on a second pass', async () => {
      const result = await calculateLine(await roundTrip(line))
      expect(result.discountAmount).toBeCloseTo(300, 4)
      expect(result.netAmount).toBeCloseTo(2700, 4)
    })
  })

  describe('precedence', () => {
    it('lets a non-zero percentage govern over a stored zero amount', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 2,
        currencyCode: 'USD',
        unitPriceNet: 100,
        discountAmount: 0,
        discountPercent: 10,
        taxRate: 20,
      })
      expect(result.discountAmount).toBeCloseTo(20, 4)
      expect(result.netAmount).toBeCloseTo(180, 4)
    })

    it('uses the amount when there is no percentage to derive from', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 2,
        currencyCode: 'USD',
        unitPriceNet: 100,
        discountAmount: 15,
        discountPercent: 0,
        taxRate: 20,
      })
      expect(result.discountAmount).toBeCloseTo(30, 4)
    })

    it('treats a supplied amount as per-unit by default', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 3,
        currencyCode: 'USD',
        unitPriceNet: 100,
        discountAmount: 10,
        taxRate: 0,
      })
      expect(result.discountAmount).toBeCloseTo(30, 4)
    })

    it('honours an explicit line basis', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 3,
        currencyCode: 'USD',
        unitPriceNet: 100,
        discountAmount: 10,
        discountAmountBasis: 'line',
        taxRate: 0,
      })
      expect(result.discountAmount).toBeCloseTo(10, 4)
    })

    it('does not multiply a stored line total by quantity again', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 3,
        currencyCode: 'USD',
        unitPriceNet: 100,
        discountAmount: 30,
        discountAmountFromStoredRow: true,
        taxRate: 0,
      })
      expect(result.discountAmount).toBeCloseTo(30, 4)
      expect(result.netAmount).toBeCloseTo(270, 4)
    })

    it('still clamps the discount at the undiscounted subtotal', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 2,
        currencyCode: 'USD',
        unitPriceNet: 10,
        discountAmount: 1000,
        taxRate: 0,
      })
      expect(result.discountAmount).toBeCloseTo(20, 4)
      expect(result.netAmount).toBeCloseTo(0, 4)
    })
  })

  describe('createLineSnapshotFromInput passthrough', () => {
    // `lines.upsert` builds an updated snapshot, then re-runs every line of the
    // document through `createLineSnapshotFromInput` before calculating. Any
    // discount field dropped in that rebuild silently changes the result: losing
    // `discountAmountFromStoredRow` lets a stored line total re-enter as a
    // per-unit amount and be multiplied by quantity again.
    it('carries the stored-row marker and the caller basis across a rebuild', () => {
      const stored = createLineSnapshotFromInput(
        { kind: 'product', quantity: 4, currencyCode: 'USD', unitPriceNet: 25, discountAmount: 20, discountAmountFromStoredRow: true } as never,
        1,
      )
      expect(stored.discountAmountFromStoredRow).toBe(true)

      const fromCaller = createLineSnapshotFromInput(
        { kind: 'product', quantity: 4, currencyCode: 'USD', unitPriceNet: 25, discountAmount: 5, discountAmountBasis: 'line' } as never,
        1,
      )
      expect(fromCaller.discountAmountBasis).toBe('line')
      expect(fromCaller.discountAmountFromStoredRow).toBeUndefined()
    })

    it('a rebuilt stored line still resolves to its line total, not quantity times it', async () => {
      const rebuilt = createLineSnapshotFromInput(
        { kind: 'product', quantity: 4, currencyCode: 'USD', unitPriceNet: 25, discountAmount: 20, discountPercent: 0, discountAmountFromStoredRow: true, taxRate: 0 } as never,
        1,
      )
      const result = await calculateLine(rebuilt)
      expect(result.discountAmount).toBeCloseTo(20, 4)
      expect(result.netAmount).toBeCloseTo(80, 4)
    })
  })

  describe('discount resolution from an already-marked snapshot', () => {
    // `lines.upsert` rebuilds every line through `createLineSnapshotFromInput`
    // before calculating, so a snapshot that has already been marked as coming
    // from a stored row must keep that marker across the rebuild. Losing it lets
    // the stored line total re-enter as a per-unit amount.
    it('keeps a stored line total intact when no percentage competes with it', async () => {
      const storedLine: SalesLineSnapshot = {
        kind: 'product',
        quantity: 4,
        currencyCode: 'USD',
        unitPriceNet: 25,
        discountAmount: 20,
        discountPercent: 0,
        discountAmountFromStoredRow: true,
        taxRate: 0,
      }

      const first = await calculateLine(storedLine)
      expect(first.discountAmount).toBeCloseTo(20, 4)
      expect(first.netAmount).toBeCloseTo(80, 4)

      const second = await calculateLine({ ...storedLine, discountAmount: first.discountAmount })
      expect(second.discountAmount).toBeCloseTo(20, 4)
      expect(second.netAmount).toBeCloseTo(80, 4)
    })

    it('drops to per-unit only when the marker is genuinely absent', async () => {
      const result = await calculateLine({
        kind: 'product',
        quantity: 4,
        currencyCode: 'USD',
        unitPriceNet: 25,
        discountAmount: 20,
        discountPercent: 0,
        taxRate: 0,
      })
      expect(result.discountAmount).toBeCloseTo(80, 4)
    })
  })

  describe('the mapper invariant the contract depends on', () => {
    const entity = {
      id: 'line-1',
      lineNumber: 1,
      kind: 'product',
      currencyCode: 'USD',
      quantity: '60',
      unitPriceNet: '50',
      unitPriceGross: '54',
      discountAmount: '300',
      discountPercent: '10',
      taxRate: '8',
      taxAmount: '216',
      totalNetAmount: '2700',
      totalGrossAmount: '2916',
    } as never

    it.each([
      ['order', mapOrderLineEntityToSnapshot],
      ['quote', mapQuoteLineEntityToSnapshot],
    ])('%s mapper marks the amount as stored and never sets a caller basis', (_kind, mapper) => {
      const snapshot = mapper(entity)
      expect(snapshot.discountAmountFromStoredRow).toBe(true)
      expect(snapshot.discountAmountBasis).toBeUndefined()
    })

    it('produces identical snapshots from the order and quote mappers', () => {
      expect(mapOrderLineEntityToSnapshot(entity)).toEqual(mapQuoteLineEntityToSnapshot(entity))
    })
  })
})
