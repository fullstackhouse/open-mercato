import {
  QUERY_INDEX_REINDEX_EXPORT,
  declareQueryIndexReindex,
  formatQueryIndexRebuildCommands,
  readQueryIndexReindexDeclaration,
} from '../migration-reindex'

describe('declareQueryIndexReindex', () => {
  it('normalizes and freezes the declared entity types', () => {
    const declared = declareQueryIndexReindex([
      'customers:customer_dictionary_entry',
      'customers:customer_dictionary_entry',
      'workflows:workflow_definition',
    ])

    expect(declared.entityTypes).toEqual(['customers:customer_dictionary_entry', 'workflows:workflow_definition'])
    expect(declared.target).toBe('all')
    expect(Object.isFrozen(declared.entityTypes)).toBe(true)
    expect(Object.isFrozen(declared)).toBe(true)
  })

  it('carries a search-only target and the every-entity wildcard', () => {
    const declared = declareQueryIndexReindex(['*'], { target: 'search' })

    expect(declared).toEqual({ entityTypes: ['*'], target: 'search' })
  })

  it('rejects identifiers that are not module:entity', () => {
    expect(() => declareQueryIndexReindex(['customer_dictionary_entries'])).toThrow(/module:entity/)
    expect(() => declareQueryIndexReindex(['customers:Customer-Dictionary-Entry'])).toThrow(/module:entity/)
    expect(() => declareQueryIndexReindex([])).toThrow(/at least one entity type/)
  })
})

describe('readQueryIndexReindexDeclaration', () => {
  it('reads the declaration from a migration module', () => {
    const moduleExports = {
      [QUERY_INDEX_REINDEX_EXPORT]: ['dictionaries:dictionary_entry', 'dictionaries:dictionary_entry'],
    }

    expect(readQueryIndexReindexDeclaration(moduleExports))
      .toEqual({ entityTypes: ['dictionaries:dictionary_entry'], target: 'all' })
  })

  it('reads the target from a declaration that carries one', () => {
    const moduleExports = {
      [QUERY_INDEX_REINDEX_EXPORT]: declareQueryIndexReindex(['*'], { target: 'search' }),
    }

    expect(readQueryIndexReindexDeclaration(moduleExports)).toEqual({ entityTypes: ['*'], target: 'search' })
  })

  it('returns nothing for migrations that declare nothing', () => {
    const empty = { entityTypes: [], target: 'all' }
    expect(readQueryIndexReindexDeclaration({})).toEqual(empty)
    expect(readQueryIndexReindexDeclaration(null)).toEqual(empty)
    expect(readQueryIndexReindexDeclaration({ [QUERY_INDEX_REINDEX_EXPORT]: 'customers:deal' })).toEqual(empty)
  })

  it('drops malformed entries instead of propagating them into a reindex request', () => {
    const moduleExports = {
      [QUERY_INDEX_REINDEX_EXPORT]: ['customers:deal', 42, 'not-an-entity-type', null],
    }

    expect(readQueryIndexReindexDeclaration(moduleExports)).toEqual({ entityTypes: ['customers:deal'], target: 'all' })
  })

  it('reports every rejected entry so a typo cannot leave a projection stale in silence', () => {
    const rejected: unknown[] = []
    const moduleExports = {
      // camelCase is the natural slip in a codebase whose TS identifiers are all camelCase.
      [QUERY_INDEX_REINDEX_EXPORT]: ['customers:customerDictionaryEntry', 'customers:deal', 42],
    }

    expect(readQueryIndexReindexDeclaration(moduleExports, (value) => rejected.push(value)))
      .toEqual({ entityTypes: ['customers:deal'], target: 'all' })
    expect(rejected).toEqual(['customers:customerDictionaryEntry', 42])
  })

  it('never reports an accepted entry as rejected', () => {
    const rejected: unknown[] = []
    const moduleExports = { [QUERY_INDEX_REINDEX_EXPORT]: ['customers:deal', 'customers:deal'] }

    expect(readQueryIndexReindexDeclaration(moduleExports, (value) => rejected.push(value)))
      .toEqual({ entityTypes: ['customers:deal'], target: 'all' })
    expect(rejected).toEqual([])
  })
})

describe('formatQueryIndexRebuildCommands', () => {
  it('renders the operator fallback command for every entity type', () => {
    expect(formatQueryIndexRebuildCommands(['customers:deal'])).toEqual([
      'mercato query_index rebuild --entity customers:deal --global',
    ])
  })

  it('renders the search-only wildcard as the reindex command an operator can actually run', () => {
    expect(formatQueryIndexRebuildCommands(['*'], 'search')).toEqual([
      'mercato query_index reindex --all --target search',
    ])
  })
})
