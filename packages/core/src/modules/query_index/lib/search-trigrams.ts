import { resolveSearchConfig, type SearchConfig } from '@open-mercato/shared/lib/search/config'
import { isSearchIndexableField, resolveEntitySearchFieldPolicy } from '@open-mercato/shared/lib/search/fields'
import { buildRecordTrigramHashes } from '@open-mercato/shared/lib/search/trigram'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('query_index').child({ component: 'search-trigrams' })

export const isSearchDebugEnabled = (): boolean => {
  return parseBooleanToken(process.env.OM_SEARCH_DEBUG ?? '') === true
}

export type BuildSearchTrigramsOptions = {
  entityType: string
  tenantId?: string | null
  /** Decrypted index document — the same `tokenDoc` the token writer used to consume. */
  doc?: Record<string, unknown> | null
  config?: SearchConfig
}

/**
 * The keyed trigram hash set for one record, written straight onto its `entity_indexes` row.
 *
 * Not deferred, unlike the token rewrite it replaces: this is one array, not a delete plus
 * thousands of inserts, so read-your-writes for list search is worth more than the deferral ever
 * bought. Returns `null` when search is switched off (`OM_SEARCH_ENABLED=false`) so callers can
 * leave the column untouched rather than blanking it.
 */
export function buildSearchTrigramHashes(options: BuildSearchTrigramsOptions): number[] | null {
  const config = options.config ?? resolveSearchConfig()
  if (!config.enabled) return null
  if (!options.doc) return []
  const policy = resolveEntitySearchFieldPolicy(options.entityType)
  const hashes = buildRecordTrigramHashes({
    entityType: options.entityType,
    tenantId: options.tenantId ?? null,
    doc: options.doc,
    fieldKinds: policy.kinds,
    onlyDeclaredFields: policy.replaceDefaults,
    config,
    isFieldEligible: (field, value) => isSearchIndexableField(field, value, config, options.entityType),
  })
  if (isSearchDebugEnabled()) {
    logger.debug('Search trigram set built', {
      entityType: options.entityType,
      fields: Object.keys(options.doc).length,
      trigrams: hashes.length,
    })
  }
  return hashes
}
