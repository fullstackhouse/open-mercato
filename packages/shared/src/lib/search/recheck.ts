import { collectSearchTextValues } from './fields'
import { recheckMatches, type SearchFieldKind, type TrigramQuery } from './trigram'

/**
 * What a query has to re-verify on the rows it is about to return.
 *
 * Trigram containment proves every fragment of the term is present on the record, not that they
 * are contiguous — a record whose name holds *Kowacz* and whose e-mail holds *walter@…* contains
 * every padded trigram of `kowal`. The engine already decrypts the rows it returns, so the honest
 * filter is a substring/prefix test against those values.
 */
export type SearchRecheckPlan = {
  entityType: string
  query: TrigramQuery
  /** Filter fields the term was applied to; `cf:` keys are matched against their `cf_` alias too. */
  fields: string[]
  fieldKinds: Record<string, SearchFieldKind>
}

function candidateKeys(field: string): string[] {
  if (!field.startsWith('cf:')) return [field]
  const bare = field.slice(3)
  return [field, `cf_${bare}`, bare]
}

function collectFieldValues(
  row: Record<string, unknown>,
  fields: readonly string[],
): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = []
  for (const field of fields) {
    for (const key of candidateKeys(field)) {
      if (!(key in row)) continue
      for (const value of collectSearchTextValues(row[key])) {
        if (value.length) out.push({ field, value })
      }
      break
    }
  }
  return out
}

/**
 * Whether a candidate row genuinely matches.
 *
 * Fails OPEN when none of the searched fields is present on the row — a projection that did not
 * select the searched column cannot disprove the match, and dropping the row there would turn a
 * false positive into a false negative, which is the worse error for a search box.
 */
export function rowMatchesSearchRecheck(
  plan: SearchRecheckPlan,
  row: Record<string, unknown>,
): boolean {
  const values = collectFieldValues(row, plan.fields)
  if (!values.length) return true
  return recheckMatches(plan.query, values, plan.fieldKinds)
}

export function applySearchRecheck<T extends Record<string, unknown>>(
  plan: SearchRecheckPlan | null,
  rows: readonly T[],
): T[] {
  if (!plan) return rows as T[]
  return rows.filter((row) => rowMatchesSearchRecheck(plan, row))
}
