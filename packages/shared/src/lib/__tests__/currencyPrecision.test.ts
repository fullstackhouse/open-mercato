import { resolveCurrencyAmountDecimalPlaces, resolveCurrencyDecimalPlaces } from '../currencyPrecision'

function containerWith(service: unknown) {
  return {
    resolve<T>(name: string): T {
      if (name === 'currencyPrecisionService' && service) return service as T
      throw new Error(`[internal] missing ${name}`)
    },
  }
}

describe('resolveCurrencyAmountDecimalPlaces', () => {
  const lookup = { code: 'ETH', tenantId: 'tenant-1', organizationId: 'org-1' }

  it('uses the tenant currency precision when it is higher than the floor', async () => {
    const service = { getDecimalPlaces: jest.fn(async () => 18) }
    await expect(resolveCurrencyAmountDecimalPlaces(containerWith(service), lookup)).resolves.toBe(18)
    expect(service.getDecimalPlaces).toHaveBeenCalledWith(lookup)
  })

  it('never goes below 4 decimal places', async () => {
    const service = { getDecimalPlaces: async () => 0 }
    await expect(resolveCurrencyAmountDecimalPlaces(containerWith(service), { ...lookup, code: 'JPY' })).resolves.toBe(4)
  })

  it('falls back to ISO digits when the service is missing or fails', async () => {
    await expect(resolveCurrencyAmountDecimalPlaces(containerWith(null), { ...lookup, code: 'USD' })).resolves.toBe(4)
    const failing = { getDecimalPlaces: async () => { throw new Error('[internal] db down') } }
    await expect(resolveCurrencyAmountDecimalPlaces(containerWith(failing), { ...lookup, code: 'USD' })).resolves.toBe(4)
  })

  it('falls back to the floor for unknown currency codes', async () => {
    const service = { getDecimalPlaces: async () => null }
    await expect(resolveCurrencyAmountDecimalPlaces(containerWith(service), { ...lookup, code: 'XYZW' })).resolves.toBe(4)
  })

  it('returns null for well-formed codes the runtime does not know', async () => {
    const service = { getDecimalPlaces: async () => null }
    await expect(resolveCurrencyDecimalPlaces(containerWith(service), { ...lookup, code: 'ETH' })).resolves.toBeNull()
    await expect(resolveCurrencyDecimalPlaces(containerWith(null), { ...lookup, code: 'XYZ' })).resolves.toBeNull()
    await expect(resolveCurrencyDecimalPlaces(containerWith(null), { ...lookup, code: 'KWD' })).resolves.toBe(3)
  })
})
