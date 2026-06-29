import type { RunParameter } from '../adapter'
import { getRunParametersForDirection, normalizeRunParameters } from '../run-parameters'

const params: RunParameter[] = [
  { key: 'dryRun', label: 'Dry run', type: 'boolean', defaultValue: false },
  { key: 'startId', label: 'Start id', type: 'number', min: 0 },
  { key: 'note', label: 'Note', type: 'string' },
  { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a' }, { value: 'b' }] },
  { key: 'exportOnly', label: 'Export only', type: 'boolean', direction: 'export' },
]

describe('getRunParametersForDirection', () => {
  it('includes direction-agnostic params and only matching directional params', () => {
    expect(getRunParametersForDirection(params, 'import').map((p) => p.key)).toEqual([
      'dryRun', 'startId', 'note', 'mode',
    ])
    expect(getRunParametersForDirection(params, 'export').map((p) => p.key)).toContain('exportOnly')
  })

  it('returns empty array when nothing is declared', () => {
    expect(getRunParametersForDirection(undefined, 'import')).toEqual([])
  })
})

describe('normalizeRunParameters', () => {
  it('coerces values to declared types and drops undeclared keys', () => {
    const result = normalizeRunParameters(params, 'import', {
      dryRun: 'true',
      startId: '42',
      note: '  hello  ',
      mode: 'b',
      unexpected: 'ignored',
    })
    expect(result).toEqual({
      ok: true,
      values: { dryRun: true, startId: 42, note: 'hello', mode: 'b' },
    })
  })

  it('applies defaults for blank values and omits params without a default', () => {
    const result = normalizeRunParameters(params, 'import', { startId: '', note: '' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.values).toEqual({ dryRun: false })
    }
  })

  it('errors when a required value is blank with no default', () => {
    const required: RunParameter[] = [{ key: 'cursor', label: 'Cursor', type: 'string', required: true }]
    const result = normalizeRunParameters(required, 'import', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].key).toBe('cursor')
  })

  it('rejects out-of-range numbers and invalid select values', () => {
    const low = normalizeRunParameters(params, 'import', { startId: '-1' })
    expect(low.ok).toBe(false)
    const badSelect = normalizeRunParameters(params, 'import', { mode: 'z' })
    expect(badSelect.ok).toBe(false)
  })

  it('ignores params that do not apply to the run direction', () => {
    const result = normalizeRunParameters(params, 'import', { exportOnly: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect('exportOnly' in result.values).toBe(false)
  })
})
