import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CurrencyPrecisionLookup, CurrencyPrecisionResolver } from '@open-mercato/shared/lib/currencyPrecision'
import { Currency } from '../data/entities'

export class CurrencyPrecisionService implements CurrencyPrecisionResolver {
  constructor(private readonly em: EntityManager) {}

  /**
   * The currency's decimal places for one organization. Without an organization the
   * lookup is not scoped tightly enough, so it returns `null` and callers fall back
   * to the ISO digits.
   */
  async getDecimalPlaces(lookup: CurrencyPrecisionLookup): Promise<number | null> {
    const code = lookup.code.trim().toUpperCase()
    if (!code || !lookup.tenantId || !lookup.organizationId) return null
    const currency = await findOneWithDecryption(
      this.em,
      Currency,
      {
        code,
        tenantId: lookup.tenantId,
        organizationId: lookup.organizationId,
        deletedAt: null,
      },
      {},
      { tenantId: lookup.tenantId, organizationId: lookup.organizationId },
    )
    return currency ? currency.decimalPlaces : null
  }
}
