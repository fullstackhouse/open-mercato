import type { SyncRun } from '../../data/entities'
import { deliveredCursorOrigin } from '../cursor-origin'

type RunFacts = Pick<SyncRun, 'cursor' | 'batchesCompleted' | 'cursorOrigin'>

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return { cursor: null, batchesCompleted: 0, cursorOrigin: null, ...overrides }
}

/**
 * The whole point of the derivation is that the row's stored origin and the origin of the cursor
 * being handed over are different facts once a run has done any work of its own.
 */
describe('deliveredCursorOrigin', () => {
  it('reports no cursor as none whatever the row stored', () => {
    expect(deliveredCursorOrigin(run({ cursor: null, cursorOrigin: 'inherited' }))).toBe('none')
  })

  it('passes the stored origin through on the first delivery', () => {
    expect(deliveredCursorOrigin(run({ cursor: 'c1', cursorOrigin: 'inherited' }))).toBe('inherited')
    expect(deliveredCursorOrigin(run({ cursor: 'c1', cursorOrigin: 'explicit' }))).toBe('explicit')
  })

  /**
   * The regression this file exists for. A redelivered job re-enters the adapter with the run's own
   * committed position; reporting the start-time label there would make an adapter that refuses
   * inherited cursors restart from the top on every worker hiccup.
   */
  it('reports self once a batch has committed, whatever the run started from', () => {
    expect(deliveredCursorOrigin(run({ cursor: 'c9', batchesCompleted: 1, cursorOrigin: 'inherited' }))).toBe('self')
    expect(deliveredCursorOrigin(run({ cursor: 'c9', batchesCompleted: 7, cursorOrigin: 'explicit' }))).toBe('self')
    expect(deliveredCursorOrigin(run({ cursor: 'c9', batchesCompleted: 3, cursorOrigin: null }))).toBe('self')
  })

  /**
   * A run written before provenance shipped knows nothing about its own start, and guessing would be
   * worse than silence — an adapter would act on an origin nothing established.
   */
  it('reports an absent origin for a run that predates provenance', () => {
    expect(deliveredCursorOrigin(run({ cursor: 'c1', cursorOrigin: null }))).toBeUndefined()
  })

  it('treats a missing batch count as no batches rather than throwing', () => {
    expect(deliveredCursorOrigin({
      cursor: 'c1',
      batchesCompleted: undefined as unknown as number,
      cursorOrigin: 'inherited',
    })).toBe('inherited')
  })
})
