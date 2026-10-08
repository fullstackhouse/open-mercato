import type { EntityManager } from '@mikro-orm/core'
import type { CurrencyPrecisionLookup, CurrencyPrecisionResolver } from '@open-mercato/shared/lib/currencyPrecision'
import { Currency } from '../data/entities'

export class CurrencyPrecisionService implements CurrencyPrecisionResolver {
  constructor(private readonly em: EntityManager) {}

  async getDecimalPlaces(lookup: CurrencyPrecisionLookup): Promise<number | null> {
    const code = lookup.code.trim().toUpperCase()
    if (!code || !lookup.tenantId) return null
    const currency = await this.em.findOne(Currency, {
      code,
      tenantId: lookup.tenantId,
      ...(lookup.organizationId ? { organizationId: lookup.organizationId } : {}),
      deletedAt: null,
    })
    return currency ? currency.decimalPlaces : null
  }
}
