import {
  findEntityIdsBySearchTrigrams,
  findEntityIdsBySearchTrigramsCompat,
} from '../trigramLookup'
import { findEntityIdsBySearchTokens } from '../tokenLookup'
import { resolveSearchConfig } from '../config'

type KyselyCall = {
  method: string
  args: unknown[]
}

function createKyselyMock(rows: Array<{ entity_id: unknown }>) {
  const calls: KyselyCall[] = []
  const tableNameRef: { value: string | null } = { value: null }
  const builder: Record<string, unknown> = {}
  const passthrough = (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    }
  builder.select = passthrough('select')
  builder.where = passthrough('where')
  builder.limit = passthrough('limit')
  builder.execute = jest.fn(async () => rows)

  const db = {
    selectFrom: (table: string) => {
      tableNameRef.value = table
      return builder
    },
  }
  return { db: db as never, calls, tableNameRef, builder }
}

function compileSql(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'toOperationNode' in raw && typeof raw.toOperationNode === 'function') {
    const node = raw.toOperationNode() as { sqlFragments?: unknown }
    return Array.isArray(node.sqlFragments) ? node.sqlFragments.join(' ? ') : ''
  }
  if (raw && typeof raw === 'object' && 'sql' in raw) return String(raw.sql)
  return String(raw)
}

function rawWhereFragments(calls: KyselyCall[]): string[] {
  return calls
    .filter((call) => call.method === 'where' && call.args.length === 1)
    .map((call) => compileSql(call.args[0]))
}

describe('findEntityIdsBySearchTrigrams', () => {
  const baseInput = {
    entityType: 'customers:customer_entity',
    query: 'Hello',
  }

  it('skips the lookup for a blank query', async () => {
    const { db, builder } = createKyselyMock([])
    const result = await findEntityIdsBySearchTrigrams({ ...baseInput, db, query: '   ' })
    expect(result).toEqual({ matched: false, reason: 'empty-query' })
    expect(builder.execute).not.toHaveBeenCalled()
  })

  it('skips the lookup when search is disabled', async () => {
    const { db, builder } = createKyselyMock([])
    const result = await findEntityIdsBySearchTrigrams({
      ...baseInput,
      db,
      config: { ...resolveSearchConfig(), enabled: false },
    })
    expect(result).toEqual({ matched: false, reason: 'search-disabled' })
    expect(builder.execute).not.toHaveBeenCalled()
  })

  it('skips the lookup when the query shapes into no trigram', async () => {
    const { db, builder } = createKyselyMock([])
    const result = await findEntityIdsBySearchTrigrams({ ...baseInput, db, query: '!' })
    expect(result).toEqual({ matched: false, reason: 'term-too-short' })
    expect(builder.execute).not.toHaveBeenCalled()
  })

  it('filters on the projection row\'s trigram column rather than a token table', async () => {
    const { db, calls, tableNameRef } = createKyselyMock([{ entity_id: 'a' }])
    await findEntityIdsBySearchTrigrams({ ...baseInput, db, query: 'ada lovelace' })

    expect(tableNameRef.value).toBe('entity_indexes')
    // Two raw predicates: `search_trgm is not null` and the containment expression.
    expect(rawWhereFragments(calls).length).toBeGreaterThanOrEqual(2)
    // No aggregate: containment answers the whole predicate on the row being scanned.
    expect(calls.some((call) => call.method === 'having' || call.method === 'groupBy')).toBe(false)
  })

  it('returns the matched ids and drops non-string rows', async () => {
    const { db, tableNameRef } = createKyselyMock([
      { entity_id: 'id-1' },
      { entity_id: null },
      { entity_id: 42 },
      { entity_id: '' },
      { entity_id: 'id-2' },
    ])
    const result = await findEntityIdsBySearchTrigrams({ ...baseInput, db })
    expect(result).toEqual({ matched: true, ids: ['id-1', 'id-2'] })
    expect(tableNameRef.value).toBe('entity_indexes')
  })

  it('reports an empty match instead of a skip when nothing matched', async () => {
    const { db } = createKyselyMock([])
    const result = await findEntityIdsBySearchTrigrams({ ...baseInput, db })
    expect(result).toEqual({ matched: true, ids: [] })
  })

  it('emits no per-field predicate: the hash set is per record, not per field', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({ ...baseInput, db, fields: ['name', 'email'] })
    expect(calls.some((call) => call.args[0] === 'field')).toBe(false)
  })

  it('omits tenant and organization predicates when the scope is absent', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({ ...baseInput, db })
    expect(rawWhereFragments(calls).some((fragment) => fragment.includes('tenant_id'))).toBe(false)
    expect(calls.some((call) => call.args[0] === 'organization_id')).toBe(false)
  })

  it('emits a null-safe tenant predicate for an explicit null tenant', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({ ...baseInput, db, scope: { tenantId: null } })
    expect(rawWhereFragments(calls).some((s) => s.includes('tenant_id is not distinct from'))).toBe(true)
  })

  it('emits a null-safe organization predicate for an explicit null organization', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({ ...baseInput, db, scope: { organizationId: null } })
    expect(rawWhereFragments(calls).some((s) => s.includes('organization_id is not distinct from'))).toBe(true)
  })

  it('prefers a concrete organization over the visible-organization list', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({
      ...baseInput,
      db,
      scope: { organizationId: 'org-1', organizationIds: ['org-1', 'org-2'] },
    })
    expect(calls).toContainEqual({ method: 'where', args: ['organization_id', '=', 'org-1'] })
    expect(calls.some((call) => call.args[1] === 'in' && call.args[0] === 'organization_id')).toBe(false)
  })

  it('falls back to the visible-organization list when no organization is selected', async () => {
    const { db, calls } = createKyselyMock([])
    await findEntityIdsBySearchTrigrams({
      ...baseInput,
      db,
      scope: { organizationIds: ['org-1', 'org-2'] },
    })
    expect(calls).toContainEqual({ method: 'where', args: ['organization_id', 'in', ['org-1', 'org-2']] })
  })
})

describe('findEntityIdsBySearchTrigramsCompat', () => {
  it('returns null only for a blank query', async () => {
    const { db } = createKyselyMock([])
    await expect(findEntityIdsBySearchTrigramsCompat({
      db,
      entityType: 'customers:customer_entity',
      query: ' ',
    })).resolves.toBeNull()
  })

  it('returns an empty array for the remaining skip reasons', async () => {
    const noTokens = createKyselyMock([])
    await expect(findEntityIdsBySearchTrigramsCompat({
      db: noTokens.db,
      entityType: 'customers:customer_entity',
      query: '!',
    })).resolves.toEqual([])

    const disabled = createKyselyMock([])
    await expect(findEntityIdsBySearchTrigramsCompat({
      db: disabled.db,
      entityType: 'customers:customer_entity',
      query: 'Hello',
      config: { ...resolveSearchConfig(), enabled: false },
    })).resolves.toEqual([])
  })

  it('returns the matched ids', async () => {
    const { db } = createKyselyMock([{ entity_id: 'id-1' }])
    await expect(findEntityIdsBySearchTrigramsCompat({
      db,
      entityType: 'customers:customer_entity',
      query: 'Hello',
    })).resolves.toEqual(['id-1'])
  })
})

describe('findEntityIdsBySearchTokens (deprecated alias)', () => {
  it('delegates to the trigram lookup and keeps the legacy `no-tokens` skip reason', async () => {
    const matched = createKyselyMock([{ entity_id: 'id-1' }])
    await expect(findEntityIdsBySearchTokens({
      db: matched.db,
      entityType: 'customers:customer_entity',
      query: 'Hello',
    })).resolves.toEqual({ matched: true, ids: ['id-1'] })
    expect(matched.tableNameRef.value).toBe('entity_indexes')

    const tooShort = createKyselyMock([])
    await expect(findEntityIdsBySearchTokens({
      db: tooShort.db,
      entityType: 'customers:customer_entity',
      query: '!',
    })).resolves.toEqual({ matched: false, reason: 'no-tokens' })
  })
})
