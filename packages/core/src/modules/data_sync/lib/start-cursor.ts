import type { CursorOrigin, DataSyncAdapter } from './adapter'
import type { SyncRunService } from './sync-run-service'

type SyncScope = {
  organizationId: string
  tenantId: string
}

export { resolveAdapterForIntegration } from './adapter-registry'

export function persistsSharedCursor(adapter: DataSyncAdapter | null | undefined, entityType: string): boolean {
  return adapter?.persistsSharedCursor?.(entityType) ?? true
}

/**
 * A start position together with where it came from.
 *
 * `origin` is only ever `'none'` or `'inherited'` here: this function resolves positions the caller
 * did NOT name, which is precisely what makes them inherited. A caller that supplies its own cursor
 * (Retry, a provider flow) labels it `'explicit'` itself and never calls this.
 *
 * `sourceRunId` is set only for the previous-run branch. The shared `sync_cursors` row has no run id,
 * so a null `sourceRunId` on an `'inherited'` cursor means "came from the shared row" — that
 * asymmetry is how a caller tells the two inheritance kinds apart without a second discriminator.
 */
export type ResolvedStartCursor = {
  cursor: string | null
  origin: CursorOrigin
  sourceRunId: string | null
}

type ResolveStartCursorParams = {
  syncRunService: SyncRunService
  adapter?: DataSyncAdapter | null
  integrationId: string
  entityType: string
  direction: 'import' | 'export'
  scope: SyncScope
}

/**
 * Start position for a non-full run, with its provenance. Entity types that mirror their cursor into
 * the shared `sync_cursors` row read it from there. Entity types whose adapter opted out never write
 * that row, so reading it would silently turn every incremental run into a full one — they resume
 * from their own last run instead.
 *
 * Either way the position is one the caller never asked for by value, so it is reported as
 * `'inherited'`. That label is the whole point: an adapter whose cursor encodes scope can refuse it,
 * and the run detail page can tell an operator why a fresh run started mid-table.
 */
export async function resolveStartCursorWithOrigin(params: ResolveStartCursorParams): Promise<ResolvedStartCursor> {
  const { syncRunService, adapter, integrationId, entityType, direction, scope } = params
  if (persistsSharedCursor(adapter, entityType)) {
    const cursor = await syncRunService.resolveCursor(integrationId, entityType, direction, scope)
    return { cursor, origin: cursor === null ? 'none' : 'inherited', sourceRunId: null }
  }
  const { cursor, runId } = await syncRunService.resolveResumeCursorWithSource(integrationId, entityType, direction, scope)
  return { cursor, origin: cursor === null ? 'none' : 'inherited', sourceRunId: runId }
}

/**
 * @deprecated Use {@link resolveStartCursorWithOrigin}, which reports where the cursor came from.
 * A bare cursor leaves the adapter unable to tell an inherited position from one the caller asked
 * for, which is the ambiguity provenance exists to remove. Kept for external callers.
 */
export async function resolveStartCursor(params: ResolveStartCursorParams): Promise<string | null> {
  const { cursor } = await resolveStartCursorWithOrigin(params)
  return cursor
}
