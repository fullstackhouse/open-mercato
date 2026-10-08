import { z } from 'zod'
import {
  assertExactCustomAmountRange,
  createLinkSchema,
  createTemplateSchema,
  updateLinkSchema,
  updateTemplateSchema,
} from '../validators'

const TEMPLATE_ID = '020b29c5-db01-4ee3-8080-1d9b185c5e29'

describe('checkout validators', () => {
  test('createTemplateSchema accepts payloads that omit optional normalized fields', () => {
    const result = createTemplateSchema.parse({
      name: 'QA template',
      pricingMode: 'fixed',
      fixedPriceAmount: 49.99,
      fixedPriceCurrencyCode: 'USD',
      gatewayProviderKey: 'mock',
    })

    expect(result.logoUrl).toBeUndefined()
    expect(result.customFieldsetCode).toBeUndefined()
    expect(result.successTitle).toBeUndefined()
    expect(result.password).toBeUndefined()
  })

  test('createLinkSchema accepts payloads that omit optional normalized fields including slug', () => {
    const result = createLinkSchema.parse({
      name: 'QA link',
      pricingMode: 'fixed',
      fixedPriceAmount: 49.99,
      fixedPriceCurrencyCode: 'USD',
      gatewayProviderKey: 'mock',
    })

    expect(result.logoUrl).toBeUndefined()
    expect(result.slug).toBeUndefined()
    expect(result.password).toBeUndefined()
  })

  test('createLinkSchema normalizes blank optional strings after zod preprocessing', () => {
    const result = createLinkSchema.parse({
      name: 'QA link',
      pricingMode: 'fixed',
      fixedPriceAmount: 49.99,
      fixedPriceCurrencyCode: 'USD',
      gatewayProviderKey: 'mock',
      slug: '   ',
      password: '',
    })

    expect(result.slug).toBeNull()
    expect(result.password).toBeNull()
  })

  test('updateTemplateSchema rejects a cleared gatewayProviderKey', () => {
    expect(() =>
      updateTemplateSchema.parse({
        id: TEMPLATE_ID,
        name: 'Consulting Fee',
        pricingMode: 'fixed',
        fixedPriceAmount: 49.99,
        fixedPriceCurrencyCode: 'USD',
        gatewayProviderKey: null,
      }),
    ).toThrow()

    expect(() =>
      updateTemplateSchema.parse({
        id: TEMPLATE_ID,
        name: 'Consulting Fee',
        pricingMode: 'fixed',
        fixedPriceAmount: 49.99,
        fixedPriceCurrencyCode: 'USD',
        gatewayProviderKey: '   ',
      }),
    ).toThrow()
  })

  test('updateTemplateSchema accepts edits that omit gatewayProviderKey', () => {
    const result = updateTemplateSchema.parse({
      id: TEMPLATE_ID,
      name: 'Consulting Fee renamed',
    })

    expect(Object.prototype.hasOwnProperty.call(result, 'gatewayProviderKey')).toBe(false)
  })

  test('updateLinkSchema accepts a null gatewayProviderKey (issue #2505)', () => {
    const result = updateLinkSchema.parse({
      id: TEMPLATE_ID,
      name: 'Consulting Fee link',
      pricingMode: 'fixed',
      fixedPriceAmount: 49.99,
      fixedPriceCurrencyCode: 'USD',
      gatewayProviderKey: null,
    })

    expect(result.gatewayProviderKey).toBeNull()
  })

  test('createTemplateSchema still rejects a null gatewayProviderKey', () => {
    expect(() =>
      createTemplateSchema.parse({
        name: 'QA template',
        pricingMode: 'fixed',
        fixedPriceAmount: 49.99,
        fixedPriceCurrencyCode: 'USD',
        gatewayProviderKey: null,
      }),
    ).toThrow()
  })

  test('assertExactCustomAmountRange rejects a min above max that differs only beyond float precision', () => {
    let caught: unknown = null
    try {
      assertExactCustomAmountRange({
        pricingMode: 'custom_amount',
        customAmountMinExact: '1.000000000000000002',
        customAmountMaxExact: '1.000000000000000001',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(z.ZodError)
    expect((caught as z.ZodError).issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        message: 'checkout.validation.customAmount.range',
        path: ['customAmountMax'],
      }),
    ])
  })

  test('assertExactCustomAmountRange accepts ordered, equal, partial or non custom amount ranges', () => {
    expect(() => assertExactCustomAmountRange({
      pricingMode: 'custom_amount',
      customAmountMinExact: '1.000000000000000001',
      customAmountMaxExact: '1.000000000000000002',
    })).not.toThrow()
    expect(() => assertExactCustomAmountRange({
      pricingMode: 'custom_amount',
      customAmountMinExact: '1.000000000000000001',
      customAmountMaxExact: '1.0000000000000000010',
    })).not.toThrow()
    expect(() => assertExactCustomAmountRange({
      pricingMode: 'custom_amount',
      customAmountMinExact: '1.000000000000000002',
    })).not.toThrow()
    expect(() => assertExactCustomAmountRange({
      pricingMode: 'fixed',
      customAmountMinExact: '1.000000000000000002',
      customAmountMaxExact: '1.000000000000000001',
    })).not.toThrow()
  })
})
