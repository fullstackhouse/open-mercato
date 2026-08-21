import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  canManageSalesOrders,
  createOrderLineFixture,
  createSalesOrderFixture,
  deleteSalesEntityIfExists,
} from '@open-mercato/core/helpers/integration/salesFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-SALES-5019: sales line discounts are idempotent under recalculation.
 * Source: issue #5019, spec `.ai/specs/2026-08-07-sales-line-discount-amount-contract.md`.
 *
 * `discount_amount` was read as a per-unit figure and written as a line total
 * through the same column, so every recalculation multiplied the discount by the
 * line quantity again. A percentage-only line also lost its discount entirely the
 * first time it went through `lines.upsert`, because that path coalesced a missing
 * amount to `0` and `0 ?? percent` is `0`.
 *
 * Exercises the worked example from the spec — quantity 60 at 50.00 net with a 10%
 * discount, where the correct result is a 300.00 line discount and 2700.00 net —
 * across create, re-upsert, and the display recalculation that fires on every
 * single-order GET.
 *
 * Self-contained: creates its own order and lines, cleans up in `finally`.
 * Self-skips on databases whose sales role ACLs were never synced.
 */
test.describe('TC-SALES-5019: line discount idempotency', () => {
  const QUANTITY = 60
  const UNIT_NET = 50
  const DISCOUNT_PERCENT = 10
  const EXPECTED_DISCOUNT = 300
  const EXPECTED_NET = 2700

  test('a percentage-only line keeps its discount across create, upsert and display recalc', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    test.skip(!(await canManageSalesOrders(request, token)), 'sales.orders.manage not granted on this tenant')

    let orderId: string | null = null

    const readLine = async (lineId: string): Promise<Record<string, unknown>> => {
      const res = await apiRequest(request, 'GET', `/api/sales/order-lines?orderId=${encodeURIComponent(orderId as string)}`, { token })
      expect(res.ok(), `GET order lines failed: ${res.status()}`).toBeTruthy()
      const body = (await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(res)) ?? {}
      const line = (body.items ?? []).find((item) => item.id === lineId)
      expect(line, 'created line missing from list response').toBeTruthy()
      return line as Record<string, unknown>
    }

    const readOrderDiscountTotal = async (): Promise<number> => {
      const res = await apiRequest(request, 'GET', `/api/sales/orders?id=${encodeURIComponent(orderId as string)}`, { token })
      expect(res.ok(), `GET order failed: ${res.status()}`).toBeTruthy()
      const body = (await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(res)) ?? {}
      return Number(body.items?.[0]?.discountTotalAmount ?? 0)
    }

    try {
      orderId = await createSalesOrderFixture(request, token, 'USD')
      const lineId = await createOrderLineFixture(request, token, orderId, {
        quantity: QUANTITY,
        unitPriceNet: UNIT_NET,
        discountPercent: DISCOUNT_PERCENT,
        taxRate: 0,
      })

      // Create stores the discount as a line total, with the net discounted.
      const afterCreate = await readLine(lineId)
      expect(Number(afterCreate.discountAmount)).toBeCloseTo(EXPECTED_DISCOUNT, 2)
      expect(Number(afterCreate.totalNetAmount)).toBeCloseTo(EXPECTED_NET, 2)

      // Re-upserting the same line without re-sending the discount must change
      // nothing. Before the fix this re-read the stored 300.00 line total as a
      // per-unit figure, clamped 300 x 60 to the subtotal, and zeroed the net.
      const upsert = await apiRequest(request, 'PUT', '/api/sales/order-lines', {
        token,
        data: { id: lineId, orderId, comment: 'touched by TC-SALES-5019' },
      })
      expect(upsert.ok(), `PUT order line failed: ${upsert.status()}`).toBeTruthy()

      const afterUpsert = await readLine(lineId)
      expect(Number(afterUpsert.discountAmount)).toBeCloseTo(EXPECTED_DISCOUNT, 2)
      expect(Number(afterUpsert.totalNetAmount)).toBeCloseTo(EXPECTED_NET, 2)

      // The single-order GET recalculates totals for display through the same
      // snapshot mappers, so it must agree with the persisted state and stay
      // stable when called twice.
      const firstRead = await readOrderDiscountTotal()
      const secondRead = await readOrderDiscountTotal()
      expect(firstRead).toBeCloseTo(EXPECTED_DISCOUNT, 2)
      expect(secondRead).toBeCloseTo(firstRead, 2)
    } finally {
      if (orderId) {
        await deleteSalesEntityIfExists(request, token, '/api/sales/orders', orderId)
      }
    }
  })

  test('an explicit per-unit amount survives a round trip when no percentage competes with it', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    test.skip(!(await canManageSalesOrders(request, token)), 'sales.orders.manage not granted on this tenant')

    let orderId: string | null = null

    try {
      orderId = await createSalesOrderFixture(request, token, 'USD')
      const lineId = await createOrderLineFixture(request, token, orderId, {
        quantity: 4,
        unitPriceNet: 25,
        discountAmount: 5,
        discountPercent: 0,
        taxRate: 0,
      })

      const read = async (): Promise<Record<string, unknown>> => {
        const res = await apiRequest(request, 'GET', `/api/sales/order-lines?orderId=${encodeURIComponent(orderId as string)}`, { token })
        expect(res.ok(), `GET order lines failed: ${res.status()}`).toBeTruthy()
        const body = (await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(res)) ?? {}
        return ((body.items ?? []).find((item) => item.id === lineId) ?? {}) as Record<string, unknown>
      }

      // 5.00 per unit over 4 units is a 20.00 line discount, leaving 80.00 net.
      const afterCreate = await read()
      expect(Number(afterCreate.discountAmount)).toBeCloseTo(20, 2)
      expect(Number(afterCreate.totalNetAmount)).toBeCloseTo(80, 2)

      const upsert = await apiRequest(request, 'PUT', '/api/sales/order-lines', {
        token,
        data: { id: lineId, orderId, comment: 'touched by TC-SALES-5019' },
      })
      expect(upsert.ok(), `PUT order line failed: ${upsert.status()}`).toBeTruthy()

      const afterUpsert = await read()
      expect(Number(afterUpsert.discountAmount)).toBeCloseTo(20, 2)
      expect(Number(afterUpsert.totalNetAmount)).toBeCloseTo(80, 2)
    } finally {
      if (orderId) {
        await deleteSalesEntityIfExists(request, token, '/api/sales/orders', orderId)
      }
    }
  })
})
