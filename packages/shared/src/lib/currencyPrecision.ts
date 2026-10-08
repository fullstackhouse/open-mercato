import { resolveAmountDecimalPlaces, resolveIsoCurrencyDecimalPlaces } from './decimal'

export type CurrencyPrecisionLookup = {
  code: string
  tenantId: string
  organizationId?: string | null
}

export type CurrencyPrecisionResolver = {
  getDecimalPlaces(lookup: CurrencyPrecisionLookup): Promise<number | null>
}

type ServiceContainer = {
  resolve<T = unknown>(name: string): T
}

/**
 * Decimal places money amounts in `code` are rounded to after a division:
 * the tenant's currency precision (via the optional `currencyPrecisionService`),
 * else the ISO 4217 digits, never fewer than DEFAULT_AMOUNT_DECIMAL_PLACES.
 */
export async function resolveCurrencyAmountDecimalPlaces(
  container: ServiceContainer,
  lookup: CurrencyPrecisionLookup,
): Promise<number> {
  let resolver: CurrencyPrecisionResolver | null = null
  try {
    resolver = container.resolve<CurrencyPrecisionResolver>('currencyPrecisionService')
  } catch {
    resolver = null
  }
  let decimalPlaces: number | null = null
  if (resolver && lookup.code) {
    try {
      decimalPlaces = await resolver.getDecimalPlaces(lookup)
    } catch {
      decimalPlaces = null
    }
  }
  return resolveAmountDecimalPlaces(decimalPlaces ?? resolveIsoCurrencyDecimalPlaces(lookup.code))
}
