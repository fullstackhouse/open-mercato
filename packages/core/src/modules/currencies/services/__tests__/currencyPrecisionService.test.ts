import { describe, it, expect, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/core'
import { CurrencyPrecisionService } from '../currencyPrecisionService'

function createService(record: { decimalPlaces: number } | null) {
  const findOne = jest.fn(async () => record)
  const service = new CurrencyPrecisionService({ findOne } as unknown as EntityManager)
  return { service, findOne }
}

describe('CurrencyPrecisionService', () => {
  it('returns the scoped currency decimal places', async () => {
    const { service, findOne } = createService({ decimalPlaces: 18 })
    await expect(service.getDecimalPlaces({ code: ' eth ', tenantId: 't1', organizationId: 'o1' })).resolves.toBe(18)
    expect(findOne).toHaveBeenCalledWith(expect.anything(), {
      code: 'ETH',
      tenantId: 't1',
      organizationId: 'o1',
      deletedAt: null,
    })
  })

  it('returns null when the currency is unknown or the lookup is incomplete', async () => {
    const { service, findOne } = createService(null)
    await expect(service.getDecimalPlaces({ code: 'ETH', tenantId: 't1' })).resolves.toBeNull()
    await expect(service.getDecimalPlaces({ code: '', tenantId: 't1' })).resolves.toBeNull()
    expect(findOne).toHaveBeenCalledTimes(1)
  })
})
