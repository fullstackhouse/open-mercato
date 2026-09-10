import { HybridQueryEngine } from '../lib/engine'
import { buildTrigramQuery } from '@open-mercato/shared/lib/search/trigram'

/**
 * Regression coverage for #2738.
 *
 * `HybridQueryEngine` used to keep its search sub-select alias counter as instance
 * state (`searchAliasSeq`) and reset it to `0` at the top of every `query()`
 * call. Because the DI container shares one engine instance per request scope,
 * a second `query()` running concurrently resets the counter mid-flight, so the
 * first call re-emits an `st_N` alias it already used inside the same SQL
 * statement — which Postgres rejects at parse time.
 *
 * The fix makes alias allocation owned per `query()` invocation. These tests
 * drive the two methods that mint trigram sub-select aliases and inject the exact
 * mid-statement reset a concurrent call performs; statement-unique aliases must
 * survive it.
 */

/** Recording builder: `where` is all the trigram path calls on the outer query. */
function createRecordingBuilder(): any {
  const builder: any = new Proxy(
    {},
    { get: () => () => builder },
  )
  return builder
}

/** The alias appears inside the emitted `entity_indexes as "st_N"` sub-select. */
function aliasOf(predicate: unknown): string | null {
  const node = (predicate as { toOperationNode?: () => unknown })?.toOperationNode?.()
  const match = /st_\d+/.exec(JSON.stringify(node))
  return match ? match[0] : null
}

function mintTwiceAcrossConcurrentReset(
  method: 'applySearchTrigrams' | 'buildSearchTrigramPredicate',
): Array<string | null> {
  const engine = new HybridQueryEngine(
    { getKysely: () => ({}) } as any,
    { query: jest.fn() } as any,
  )
  const aliases: Array<string | null> = []
  let perCallSeq = 0
  const opts = {
    entity: 'example:todo',
    field: 'title',
    query: buildTrigramQuery({ term: 'title', tenantId: 't1' })!,
    recordIdColumn: 'b.id',
    tenantId: 't1',
    // Per-call alias minter — consumed after the fix, ignored by the buggy code.
    mintAlias: () => `st_${perCallSeq++}`,
  }

  const capture = () => {
    if (method === 'buildSearchTrigramPredicate') {
      aliases.push(aliasOf((engine as any).buildSearchTrigramPredicate(opts)))
      return
    }
    const spy = jest.spyOn(engine as any, 'buildSearchTrigramPredicate')
    ;(engine as any).applySearchTrigrams(createRecordingBuilder(), opts)
    aliases.push(spy.mock.results.length ? aliasOf(spy.mock.results[0].value) : null)
    spy.mockRestore()
  }

  // Query A enters query(): the pre-fix code resets the shared counter here.
  ;(engine as any).searchAliasSeq = 0
  capture()

  // A concurrent query() on the SAME engine instance enters and resets the
  // shared counter mid-statement — the `this.searchAliasSeq = 0` from #2738.
  ;(engine as any).searchAliasSeq = 0
  capture()

  return aliases
}

describe('query_index search-alias allocation under concurrency (#2738)', () => {
  test.each(['applySearchTrigrams', 'buildSearchTrigramPredicate'] as const)(
    '%s keeps statement aliases unique when a concurrent query() resets mid-flight',
    (method) => {
      const aliases = mintTwiceAcrossConcurrentReset(method)

      expect(aliases).toHaveLength(2)
      expect(aliases.every((alias) => alias !== null)).toBe(true)
      // Duplicate `st_N` aliases inside one statement are an invalid SQL parse.
      expect(new Set(aliases).size).toBe(aliases.length)
    },
  )
})
