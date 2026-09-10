import { attachAggregateSearchField, buildIndexDocument } from '../lib/document'
import { buildSearchTrigramHashes } from '../lib/search-trigrams'
import { trigramsOfValue } from '@open-mercato/shared/lib/search/trigram'
import { hashTrigram } from '@open-mercato/shared/lib/search/trigram'

const INTERACTION = 'customers:customer_interaction'
const PERSON = 'customers:person'

const originalBlocklist = process.env.OM_SEARCH_FIELD_BLOCKLIST

afterEach(() => {
  if (originalBlocklist === undefined) delete process.env.OM_SEARCH_FIELD_BLOCKLIST
  else process.env.OM_SEARCH_FIELD_BLOCKLIST = originalBlocklist
})

describe('search_text aggregate honours the field blocklist', () => {
  it('keeps a globally blocklisted field out of the aggregate', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'body'
    const doc = attachAggregateSearchField(
      { subject: 'Quarterly review', body: 'Confidential long email text' },
      { entityType: INTERACTION },
    )
    expect(doc.search_text).toContain('Quarterly review')
    expect(doc.search_text).not.toContain('Confidential long email text')
  })

  it('excludes the built-in defaults even when the env var is unset', () => {
    delete process.env.OM_SEARCH_FIELD_BLOCKLIST
    const doc = attachAggregateSearchField(
      { email: 'ada@example.com', password_hash: 'bcrypt-digest-value' },
      { entityType: PERSON },
    )
    expect(doc.search_text).toContain('ada@example.com')
    expect(doc.search_text).not.toContain('bcrypt-digest-value')
  })

  it('applies an entity-scoped entry only to the entity it names', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@body`

    const interaction = attachAggregateSearchField(
      { subject: 'Quarterly review', body: 'Confidential long email text' },
      { entityType: INTERACTION },
    )
    expect(interaction.search_text).not.toContain('Confidential long email text')

    const person = attachAggregateSearchField(
      { display_name: 'Ada Lovelace', body: 'Short profile note' },
      { entityType: PERSON },
    )
    expect(person.search_text).toContain('Short profile note')
  })

  it('applies only global entries when no entity type is supplied', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@body`
    const doc = attachAggregateSearchField({ body: 'Confidential long email text' })
    expect(doc.search_text).toContain('Confidential long email text')
  })

  it('omits the aggregate entirely when every source field is blocklisted', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'body'
    const doc = attachAggregateSearchField({ id: 'rec-1', body: 'Only blocklisted text' }, { entityType: INTERACTION })
    expect(doc.search_text).toBeUndefined()
  })

  it('threads the blocklist through buildIndexDocument, custom fields included', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@cf:body`
    const doc = buildIndexDocument(
      { id: 'rec-1', subject: 'Quarterly review' },
      [{ key: 'body', value: 'Confidential long email text' }],
      {},
      { entityType: INTERACTION },
    )
    expect(doc['cf:body']).toBe('Confidential long email text')
    expect(doc.search_text).toContain('Quarterly review')
    expect(doc.search_text).not.toContain('Confidential long email text')
  })
})

describe('search trigrams honour entity-scoped blocklist entries', () => {
  const TENANT = 'tenant-1'
  const hashesFor = (entityType: string, doc: Record<string, unknown>): number[] =>
    buildSearchTrigramHashes({ entityType, tenantId: TENANT, doc }) ?? []

  const hashesOfValue = (value: string): number[] =>
    trigramsOfValue('text', value).map((trigram) => hashTrigram(trigram, TENANT))

  const containsAnyOf = (hashes: number[], value: string): boolean => {
    const set = new Set(hashes)
    return hashesOfValue(value).some((hash) => set.has(hash))
  }

  it('drops trigrams for an entity-scoped blocklisted field', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@body`
    const hashes = hashesFor(INTERACTION, { subject: 'Quarterly', body: 'Confidential' })
    expect(containsAnyOf(hashes, 'Quarterly')).toBe(true)
    expect(containsAnyOf(hashes, 'Confidential')).toBe(false)
  })

  it('keeps the same field indexed for a different entity type', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@body`
    expect(containsAnyOf(hashesFor(PERSON, { body: 'Profile note' }), 'Profile')).toBe(true)
  })

  it('still honours global entries for every entity type', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'body'
    expect(hashesFor(PERSON, { body: 'Profile note' })).toHaveLength(0)
  })

  it('no longer re-indexes blocklisted text through the aggregate field', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = `${INTERACTION}@body`
    const doc = attachAggregateSearchField(
      { subject: 'Quarterly', body: 'Confidential' },
      { entityType: INTERACTION },
    )
    const hashes = hashesFor(INTERACTION, doc)
    expect(containsAnyOf(hashes, 'Quarterly')).toBe(true)
    expect(containsAnyOf(hashes, 'Confidential')).toBe(false)
  })
})
