import {
  buildStoredForms,
  buildTrigramQuery,
  candidateKindsForTerm,
  hashTrigram,
  recheckMatches,
  trigramsOfValue,
  type SearchFieldKind,
  type TrigramQuery,
} from '../trigram'
import { buildTrigramContainment, buildTrigramSemiJoin } from '../trigramSql'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'

/**
 * "Would this record be a candidate?" — the containment test the SQL predicate performs, run in
 * memory so a case can state the semantics without a database.
 */
function contains(
  query: TrigramQuery,
  values: Array<{ field: string; value: string; kind?: SearchFieldKind }>,
  tenantId = TENANT,
): boolean {
  const stored = new Set<number>()
  for (const entry of values) {
    for (const trigram of trigramsOfValue(entry.kind ?? 'text', entry.value)) {
      stored.add(hashTrigram(trigram, tenantId))
    }
  }
  return query.shapings.some((shaping) =>
    shaping.groups.every((group) => group.every((hash) => stored.has(hash))),
  )
}

/** Candidate AND recheck: what a list actually returns. */
function matches(
  query: TrigramQuery,
  values: Array<{ field: string; value: string; kind?: SearchFieldKind }>,
): boolean {
  if (!contains(query, values)) return false
  const fieldKinds = Object.fromEntries(
    values.filter((entry) => entry.kind).map((entry) => [entry.field, entry.kind as SearchFieldKind]),
  )
  return recheckMatches(query, values.map(({ field, value }) => ({ field, value })), fieldKinds)
}

const shape = (term: string, kinds?: SearchFieldKind[]): TrigramQuery => {
  const query = buildTrigramQuery({ term, tenantId: TENANT, kinds })
  expect(query).not.toBeNull()
  return query!
}

describe('cleaning per kind', () => {
  it('cleans a phone to its digits, dropping the country-prefix marker only', () => {
    const forms = (value: string) => buildStoredForms('phone', value).map((form) => form.value)
    expect(forms('+48 600-100-200')).toEqual(['48600100200'])
    expect(forms('0048600100200')).toEqual(['48600100200'])
    expect(forms('600 100 200')).toEqual(['600100200'])
    // Under six digits is a year or a house number, not a phone fragment.
    expect(forms('12345')).toEqual([])
  })

  it('cleans a tax id to letters and digits, and keeps the prefix-stripped form too', () => {
    const forms = (value: string) => buildStoredForms('taxId', value).map((form) => form.value)
    expect(forms('PL 526-10-40-828')).toEqual(['PL5261040828', '5261040828'])
    expect(forms('5261040828')).toEqual(['5261040828'])
    expect(forms('DE123456789')).toEqual(['DE123456789', '123456789'])
    // The ISO prefix is only stripped when two letters are followed by digits, so a trailing
    // suffix survives intact.
    expect(forms('NL123456789B01')).toEqual(['NL123456789B01', '123456789B01'])
  })

  it('folds diacritics in text so `Łódź` and `lodz` clean identically', () => {
    expect(buildStoredForms('text', 'Łódź').map((form) => form.value))
      .toEqual(buildStoredForms('text', 'lodz').map((form) => form.value))
  })
})

describe('keyed hashing', () => {
  it('is tenant-dependent, so the same plaintext does not hash alike across tenants', () => {
    expect(hashTrigram('abc', TENANT)).not.toBe(hashTrigram('abc', OTHER_TENANT))
    expect(hashTrigram('abc', TENANT)).toBe(hashTrigram('abc', TENANT))
  })

  it('is pepper-dependent, so a rotation changes every hash', () => {
    const before = hashTrigram('abc', TENANT)
    process.env.LOOKUP_HASH_PEPPER = 'pepper-one'
    try {
      const keyed = hashTrigram('abc', TENANT)
      expect(keyed).not.toBe(before)
      process.env.LOOKUP_HASH_PEPPER = 'pepper-two'
      expect(hashTrigram('abc', TENANT)).not.toBe(keyed)
    } finally {
      delete process.env.LOOKUP_HASH_PEPPER
    }
  })

  it('fits int4', () => {
    for (const trigram of ['abc', ' zk', '  1', 'pl']) {
      const hash = hashTrigram(trigram, TENANT)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(-(2 ** 31))
      expect(hash).toBeLessThanOrEqual(2 ** 31 - 1)
    }
  })
})

describe('term shaping', () => {
  it('rejects a term shorter than a trigram rather than dropping the predicate', () => {
    // The token path silently dropped these, which returned the unfiltered list.
    expect(buildTrigramQuery({ term: 'ZK', tenantId: TENANT })).toBeNull()
    expect(buildTrigramQuery({ term: '  ', tenantId: TENANT })).toBeNull()
    expect(buildTrigramQuery({ term: '!', tenantId: TENANT })).toBeNull()
  })

  it('tries every reading the term\'s own shape allows when no kind is declared', () => {
    expect(candidateKindsForTerm('ada')).toEqual(['text', 'identifier'])
    expect(candidateKindsForTerm('ada@example.test')).toContain('email')
    expect(candidateKindsForTerm('600100200')).toContain('phone')
    expect(candidateKindsForTerm('5261040828')).toContain('taxId')
  })

  it('narrows to the declared kind when the field has one', () => {
    expect(shape('5261040828', ['taxId']).shapings.map((shaping) => shaping.kind)).toEqual(['taxId'])
  })
})

describe('matching semantics', () => {
  const person = [{ field: 'display_name', value: 'Jan Kowalski' }]

  it('matches a word prefix on text, and not a fragment inside a word', () => {
    expect(matches(shape('kowal'), person)).toBe(true)
    expect(matches(shape('Jan Kow'), person)).toBe(true)
    // `owalski` is inside the word but does not start it — a word-prefix search must not match.
    expect(matches(shape('owalski', ['text']), person)).toBe(false)
  })

  it('answers a literal substring on an identifier, spaces included', () => {
    const document = [{ field: 'order_number', value: 'ZK 1/2026' }]
    expect(matches(shape('ZK 1/2026'), document)).toBe(true)
    expect(matches(shape('1/2026'), document)).toBe(true)
    // The defect this design exists to remove: prefix hashes made these two indistinguishable.
    expect(matches(shape('91/2026'), document)).toBe(false)
    expect(matches(shape('ZK 91/2026'), [{ field: 'order_number', value: 'ZK 91/2026' }])).toBe(true)
  })

  it('finds a phone by its last digits and by the term an operator types', () => {
    const contact = [{ field: 'primary_phone', value: '+48 600-100-200', kind: 'phone' as const }]
    expect(matches(shape('600100200'), contact)).toBe(true)
    expect(matches(shape('100200'), contact)).toBe(true)
    expect(matches(shape('0048600100200'), contact)).toBe(true)
    expect(matches(shape('600100201'), contact)).toBe(false)
  })

  it('finds a phone stored without its country code from a term typed with one', () => {
    // No tenant region setting exists, so this is the bounded prefix-drop heuristic.
    const contact = [{ field: 'primary_phone', value: '600100200', kind: 'phone' as const }]
    expect(matches(shape('+48600100200'), contact)).toBe(true)
  })

  it('matches a tax id as a whole value only, never inside another number', () => {
    const company = [{ field: 'tax_id', value: 'PL5261040828', kind: 'taxId' as const }]
    expect(matches(shape('PL5261040828', ['taxId']), company)).toBe(true)
    expect(matches(shape('5261040828', ['taxId']), company)).toBe(true)

    const phone = [{ field: 'primary_phone', value: '005261040828999', kind: 'phone' as const }]
    expect(matches(shape('5261040828', ['taxId']), phone)).toBe(false)
  })

  it('drops a false positive that containment alone would keep', () => {
    // Every padded trigram of `kowal` is present across these two fields, none of them contiguous.
    const record = [
      { field: 'display_name', value: 'Anna Kowacz' },
      { field: 'primary_email', value: 'walter@example.test' },
    ]
    const query = shape('kowal', ['text'])
    expect(contains(query, record)).toBe(true)
    expect(matches(query, record)).toBe(false)
  })
})

describe('emitted SQL', () => {
  const compile = (raw: { toOperationNode: () => unknown }): string => JSON.stringify(raw.toOperationNode())

  it('ANDs one containment per word for a multi-word term and ORs the readings', () => {
    const sqlText = compile(buildTrigramContainment(
      { toOperationNode: () => ({ kind: 'ref' }) } as never,
      shape('ada lovelace', ['text']),
    ))
    // Three groups: one per word plus the whole-string form, all ANDed inside the one reading.
    expect((sqlText.match(/@>/g) ?? []).length).toBe(3)
    expect(sqlText).toContain('and')
    expect(sqlText).not.toContain(' or ')

    const multiReading = compile(buildTrigramContainment(
      { toOperationNode: () => ({ kind: 'ref' }) } as never,
      shape('ada@example.test'),
    ))
    expect(multiReading).toContain(' or ')
  })

  it('emits a non-correlated semi-join scoped to the entity and tenant', () => {
    const predicate = compile(buildTrigramSemiJoin({
      entityType: 'customers:customer_entity',
      recordIdColumn: 'b.id',
      query: shape('kowal', ['text']),
      tenantId: TENANT,
      organizationScope: { ids: ['org-1'], includeNull: false },
      alias: 'st_0',
    }))
    expect(predicate).toContain('entity_indexes')
    expect(predicate).toContain('search_trgm')
    expect(predicate).toContain('customers:customer_entity')
    expect(predicate).toContain(TENANT)
    expect(predicate).toContain('org-1')
    // A row the upgrade fill has not reached yet is not a candidate.
    expect(predicate).toContain('is not null')
    // No aggregate — this is what the token path's `GROUP BY … HAVING` per outer row becomes.
    expect(predicate).not.toContain('group by')
  })

  it('emits a delimited whole-value form for an exact term', () => {
    const forms = buildStoredForms('exact', 'Warehouse A')
    expect(forms).toEqual([{ value: 'warehouse a', shape: 'whole' }])
    // The delimiters are control characters no cleaner emits, so this can only match end to end.
    expect(trigramsOfValue('exact', 'Warehouse A')[0]).toBe('\u0001wa')
  })
})
