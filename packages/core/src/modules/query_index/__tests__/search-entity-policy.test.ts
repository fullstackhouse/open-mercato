import {
  CUSTOMERS_BASE_ENTITY_TYPE,
  indexesCustomerBaseEntity,
  listSearchTokenExcludedEntityTypes,
} from '../lib/search-entity-policy'
import { buildSearchTrigramHashes } from '../lib/search-trigrams'
import { hashTrigram, trigramsOfValue } from '@open-mercato/shared/lib/search/trigram'

const PERSON_PROFILE = 'customers:customer_person_profile'

const originalFlag = process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY

afterEach(() => {
  if (originalFlag === undefined) delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
  else process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY = originalFlag
})

describe('OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY', () => {
  it('keeps base customer entities out of token search results by default', () => {
    delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
    expect(indexesCustomerBaseEntity()).toBe(false)
    expect(listSearchTokenExcludedEntityTypes()).toEqual([CUSTOMERS_BASE_ENTITY_TYPE])
  })

  it('returns base customer entities when the flag is on', () => {
    process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY = 'true'
    expect(indexesCustomerBaseEntity()).toBe(true)
    expect(listSearchTokenExcludedEntityTypes()).toEqual([])
  })

  it('never excludes any other entity type, whatever the flag says', () => {
    delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
    expect(listSearchTokenExcludedEntityTypes()).not.toContain(PERSON_PROFILE)
    process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY = 'false'
    expect(listSearchTokenExcludedEntityTypes()).not.toContain(PERSON_PROFILE)
  })
})

/**
 * The exclusion is read-side only. `search_tokens` doubles as the encrypted-column lookup index:
 * `customers/api/people/route.ts` and `.../companies/route.ts` resolve their search box through
 * `findEntityIdsBySearchTokens` on `customers:customer_entity`, and both query engines rewrite
 * `like`/`ilike` on encrypted customer columns into the same table. If the writer ever started
 * honouring the flag, list search on `display_name` / `primary_email` / `description` would return
 * nothing — so the rows must keep being written whatever the flag says.
 */
describe('the base-entity exclusion never touches the trigram writer', () => {
  const TENANT = 'tenant-1'
  const doc = { display_name: 'Ada Lovelace', description: 'Analytical engine pioneer' }
  const buildRows = (entityType: string): number[] =>
    buildSearchTrigramHashes({ entityType, tenantId: TENANT, doc }) ?? []
  const contains = (hashes: number[], value: string): boolean => {
    const set = new Set(hashes)
    return trigramsOfValue('text', value).every((trigram) => set.has(hashTrigram(trigram, TENANT)))
  }

  it('keeps writing base customer entity trigrams while the flag is off', () => {
    delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
    const hashes = buildRows(CUSTOMERS_BASE_ENTITY_TYPE)
    expect(contains(hashes, 'Lovelace')).toBe(true)
    expect(contains(hashes, 'Analytical')).toBe(true)
  })

  it('writes exactly the same set when the flag is on', () => {
    delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
    const withFlagOff = buildRows(CUSTOMERS_BASE_ENTITY_TYPE)
    process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY = 'true'
    expect(buildRows(CUSTOMERS_BASE_ENTITY_TYPE)).toEqual(withFlagOff)
  })

  it('keeps writing rows for the profile entities the customer is found by', () => {
    delete process.env.OM_SEARCH_CUSTOMERS_INDEX_BASE_ENTITY
    expect(buildRows(PERSON_PROFILE).length).toBeGreaterThan(0)
  })
})
