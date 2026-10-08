import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRandomCurrencyFixture,
  deleteCurrenciesEntityIfExists,
} from '@open-mercato/core/helpers/integration/currenciesFixtures'
import {
  createCheckoutClientHeaders,
  createCustomAmountTemplateInput,
  createCustomerData,
  createFixedTemplateInput,
  deleteCheckoutEntityIfExists,
  readPublicPayLink,
} from './helpers/fixtures'

/**
 * TC-CHKT-PRECISION-001: checkout amounts in an 18-decimal currency keep every digit.
 * Source: .ai/specs/2026-10-08-arbitrary-precision-money-and-fx.md
 */

type JsonRecord = Record<string, unknown>

const FIXED_PRICE = '1.123456789012345678'
const FIXED_ORIGINAL_PRICE = '2.987654321098765432'
const OVERRIDDEN_FIXED_PRICE = '3.000000000000000007'
const CUSTOM_MIN = '0.000000000000000001'
const CUSTOM_MAX = '9.999999999999999999'
const SUBMITTED_AMOUNT = '1.1234567890123456785'
const CHARGED_AMOUNT = '1.123456789012345679'

async function readJson(response: APIResponse): Promise<JsonRecord> {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as JsonRecord
  } catch {
    return {}
  }
}

async function createCheckoutEntity(
  request: APIRequestContext,
  token: string,
  kind: 'templates' | 'links',
  data: JsonRecord,
): Promise<JsonRecord> {
  const response = await apiRequest(request, 'POST', `/api/checkout/${kind}`, { token, data })
  const body = await readJson(response)
  expect(response.status(), `POST /api/checkout/${kind} failed: ${JSON.stringify(body)}`).toBe(201)
  expect(typeof body.id === 'string' && body.id.length > 0, `${kind} create should return id`).toBeTruthy()
  return body
}

async function readCheckoutEntity(
  request: APIRequestContext,
  token: string,
  kind: 'templates' | 'links' | 'transactions',
  id: string,
): Promise<JsonRecord> {
  const response = await apiRequest(request, 'GET', `/api/checkout/${kind}/${encodeURIComponent(id)}`, { token })
  expect(response.status(), `GET /api/checkout/${kind}/${id} should be 200`).toBe(200)
  return readJson(response)
}

async function submitExactAmount(
  request: APIRequestContext,
  slug: string,
  amount: string,
): Promise<APIResponse> {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  return request.fetch(`${baseUrl}/api/checkout/pay/${encodeURIComponent(slug)}/submit`, {
    method: 'POST',
    headers: createCheckoutClientHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': `precision-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }),
    data: { customerData: createCustomerData(), acceptedLegalConsents: {}, amount },
  })
}

test.describe('TC-CHKT-PRECISION-001: 18-decimal currency checkout amounts', () => {
  test('template, link and transaction amounts stay exact beyond float precision', async ({ request }) => {
    test.slow()
    const token = await getAuthToken(request, 'admin')
    let currencyId: string | null = null
    let templateId: string | null = null
    const linkIds: string[] = []

    try {
      const currency = await createRandomCurrencyFixture(request, token, {
        name: 'QA TC-CHKT-PRECISION-001',
        decimalPlaces: 18,
      })
      currencyId = currency.id

      const template = await createCheckoutEntity(request, token, 'templates', {
        ...createFixedTemplateInput({ fixedPriceCurrencyCode: currency.code }),
        fixedPriceAmount: FIXED_PRICE,
        fixedPriceOriginalAmount: FIXED_ORIGINAL_PRICE,
      })
      templateId = template.id as string

      const storedTemplate = await readCheckoutEntity(request, token, 'templates', templateId)
      expect(storedTemplate.fixedPriceAmountExact).toBe(FIXED_PRICE)
      expect(storedTemplate.fixedPriceOriginalAmountExact).toBe(FIXED_ORIGINAL_PRICE)
      expect(storedTemplate.fixedPriceAmount).toBe(Number(FIXED_PRICE))

      const customLink = await createCheckoutEntity(request, token, 'links', {
        ...createCustomAmountTemplateInput({ customAmountCurrencyCode: currency.code }),
        customAmountMin: CUSTOM_MIN,
        customAmountMax: CUSTOM_MAX,
      })
      const customLinkId = customLink.id as string
      const customLinkSlug = customLink.slug as string
      linkIds.push(customLinkId)
      const storedCustomLink = await readCheckoutEntity(request, token, 'links', customLinkId)
      expect(storedCustomLink.customAmountMinExact).toBe(CUSTOM_MIN)
      expect(storedCustomLink.customAmountMaxExact).toBe(CUSTOM_MAX)

      const publicResponse = await readPublicPayLink(request, customLinkSlug)
      expect(publicResponse.status(), 'GET /api/checkout/pay/:slug should be 200').toBe(200)
      const publicLink = await readJson(publicResponse)
      expect(publicLink.customAmountMinExact).toBe(CUSTOM_MIN)
      expect(publicLink.customAmountMaxExact).toBe(CUSTOM_MAX)

      const submitResponse = await submitExactAmount(request, customLinkSlug, SUBMITTED_AMOUNT)
      const submitBody = await readJson(submitResponse)
      expect(submitResponse.status(), `submit failed: ${JSON.stringify(submitBody)}`).toBe(201)
      const transactionId = submitBody.transactionId as string
      expect(transactionId, 'submit should return transactionId').toBeTruthy()

      const transactionBody = await readCheckoutEntity(request, token, 'transactions', transactionId)
      const transaction = (transactionBody.transaction ?? {}) as JsonRecord
      expect(transaction.currencyCode).toBe(currency.code)
      expect(transaction.amountExact).toBe(CHARGED_AMOUNT)
      expect(transaction.amount).toBe(Number(CHARGED_AMOUNT))

      const templateLink = await createCheckoutEntity(request, token, 'links', {
        templateId,
        name: `QA precision template link ${Date.now()}`,
        pricingMode: 'fixed',
        fixedPriceAmount: OVERRIDDEN_FIXED_PRICE,
        fixedPriceCurrencyCode: currency.code,
        gatewayProviderKey: 'mock',
      })
      linkIds.push(templateLink.id as string)
      const storedTemplateLink = await readCheckoutEntity(request, token, 'links', templateLink.id as string)
      expect(storedTemplateLink.templateId).toBe(templateId)
      expect(storedTemplateLink.fixedPriceAmountExact).toBe(OVERRIDDEN_FIXED_PRICE)
      expect(storedTemplateLink.fixedPriceOriginalAmountExact).toBe(FIXED_ORIGINAL_PRICE)
    } finally {
      for (const linkId of linkIds) {
        await deleteCheckoutEntityIfExists(request, token, 'links', linkId)
      }
      await deleteCheckoutEntityIfExists(request, token, 'templates', templateId)
      await deleteCurrenciesEntityIfExists(request, token, '/api/currencies/currencies', currencyId)
    }
  })
})
