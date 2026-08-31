import type { CursorOrigin } from './adapter'
import type { SyncRun } from '../data/entities'

/**
 * Provenance of the cursor the engine is about to hand the adapter, which is not always the
 * provenance stored on the run row.
 *
 * The row records where the run STARTED — a fact written once at `createRun` and never mutated. The
 * engine hands over `run.cursor`, which every committed batch advances. So once the run has
 * committed anything, the cursor is the adapter's own output whatever the run started from, and
 * reporting the stored origin would be a lie with teeth: a queue redelivery would present an
 * adapter's own resume position as `'inherited'`, and an adapter that refuses inherited cursors
 * would restart from the top on every worker hiccup.
 *
 * `batchesCompleted` is the signal rather than comparing `cursor` against `initialCursor`, for the
 * same reason the ownership fence uses it: it advances by construction on every commit, while a
 * cursor is a free-form adapter string an adapter may legitimately repeat between batches.
 *
 * Returns `undefined` for a run written before provenance shipped, so those adapters see exactly the
 * absent field they see today rather than an origin nothing actually established.
 */
export function deliveredCursorOrigin(run: Pick<SyncRun, 'cursor' | 'batchesCompleted' | 'cursorOrigin'>): CursorOrigin | undefined {
  if (run.cursor == null) return 'none'
  if ((run.batchesCompleted ?? 0) > 0) return 'self'
  return run.cursorOrigin ?? undefined
}
