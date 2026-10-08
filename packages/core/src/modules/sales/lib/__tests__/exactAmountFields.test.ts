import { withExactAmounts, withExactListAmounts } from '@open-mercato/shared/lib/decimal'
import { orderCreateSchema, paymentCreateSchema } from '../../data/validators'
import {
  LINE_EXACT_AMOUNT_FIELDS,
  PAYMENT_EXACT_AMOUNT_FIELDS,
  withExactDocumentInput,
  withExactPaymentInput,
} from '../exactAmountFields'

const scope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
}

const precise = '1.123456789012345678'
const wei = '0.000000000000000001'

describe('exact amount route helpers', () => {
  it('keeps document rate and line digits from the route parse through the command parse', () => {
    const body = {
      ...scope,
      currencyCode: 'ETH',
      exchangeRate: '0.000056123456789012345',
      lines: [{ currencyCode: 'ETH', quantity: 3, unitPriceNet: wei, unitPriceGross: wei }],
    }
    const routeInput = withExactDocumentInput(orderCreateSchema.parse(body), body)
    const commandInput = withExactAmounts(orderCreateSchema.parse(routeInput), routeInput, ['exchangeRate'] as const)
    const commandLines = withExactListAmounts(commandInput.lines, routeInput, 'lines', LINE_EXACT_AMOUNT_FIELDS)

    expect(commandInput.exchangeRateExact).toBe('0.000056123456789012345')
    expect(commandLines?.[0]?.unitPriceNetExact).toBe(wei)
    expect(commandLines?.[0]?.unitPriceGrossExact).toBe(wei)
  })

  it('keeps payment and allocation digits from the route parse through the command parse', () => {
    const body = {
      ...scope,
      currencyCode: 'ETH',
      amount: precise,
      allocations: [{ currencyCode: 'ETH', amount: precise }],
    }
    const routeInput = withExactPaymentInput(paymentCreateSchema.parse(body), body)
    const commandInput = withExactAmounts(paymentCreateSchema.parse(routeInput), routeInput, PAYMENT_EXACT_AMOUNT_FIELDS)
    const commandAllocations = withExactListAmounts(commandInput.allocations, routeInput, 'allocations', ['amount'] as const)

    expect(commandInput.amountExact).toBe(precise)
    expect(commandAllocations?.[0]?.amountExact).toBe(precise)
  })
})
