import { diffPerspectiveSettings } from '../perspectiveDirty'

describe('diffPerspectiveSettings', () => {
  it('reports no changes for identical settings', () => {
    const settings = {
      columnOrder: ['name', 'email'],
      columnVisibility: { email: false },
      columnSizing: { name: 200 },
      sorting: [{ id: 'name', desc: true }],
      filters: { status: 'active' },
      searchValue: 'acme',
    }
    expect(diffPerspectiveSettings(settings, { ...settings })).toEqual([])
  })

  it('treats a materialized default column order as unchanged', () => {
    expect(
      diffPerspectiveSettings({}, { columnOrder: ['name', 'email'] }, { defaultColumnOrder: ['name', 'email'] }),
    ).toEqual([])
  })

  it('detects a reordered column list', () => {
    expect(
      diffPerspectiveSettings(
        { columnOrder: ['name', 'email'] },
        { columnOrder: ['email', 'name'] },
      ),
    ).toEqual(['columnOrder'])
  })

  it('treats an explicit true visibility entry as equal to an absent one', () => {
    expect(
      diffPerspectiveSettings({ columnVisibility: { email: false } }, { columnVisibility: { email: false, name: true } }),
    ).toEqual([])
  })

  it('detects a hidden column', () => {
    expect(diffPerspectiveSettings({}, { columnVisibility: { email: false } })).toEqual(['columnVisibility'])
  })

  it('detects resized columns and changed sorting', () => {
    expect(
      diffPerspectiveSettings(
        { columnSizing: { name: 200 }, sorting: [{ id: 'name', desc: false }] },
        { columnSizing: { name: 320 }, sorting: [{ id: 'name', desc: true }] },
      ),
    ).toEqual(['columnSizing', 'sorting'])
  })

  it('treats an omitted desc flag as ascending', () => {
    expect(
      diffPerspectiveSettings({ sorting: [{ id: 'name' }] }, { sorting: [{ id: 'name', desc: false }] }),
    ).toEqual([])
  })

  it('compares filters by value, not by key order', () => {
    expect(
      diffPerspectiveSettings(
        { filters: { status: 'active', owner: 'me' } },
        { filters: { owner: 'me', status: 'active' } },
      ),
    ).toEqual([])
    expect(
      diffPerspectiveSettings({ filters: { status: 'active' } }, { filters: { status: 'archived' } }),
    ).toEqual(['filters'])
  })

  it('compares nested filter trees by value', () => {
    const tree = { v: 2, root: { id: 'root', kind: 'group', combinator: 'and', children: [{ id: 'r1', field: 'name' }] } }
    expect(diffPerspectiveSettings({ filters: tree }, { filters: JSON.parse(JSON.stringify(tree)) })).toEqual([])
  })

  it('ignores search whitespace but detects a real search change', () => {
    expect(diffPerspectiveSettings({ searchValue: 'acme' }, { searchValue: ' acme ' })).toEqual([])
    expect(diffPerspectiveSettings({ searchValue: 'acme' }, { searchValue: 'other' })).toEqual(['searchValue'])
  })

  it('ignores pageSize, which the live settings never carry', () => {
    expect(diffPerspectiveSettings({ pageSize: 50 }, {})).toEqual([])
  })

  it('ignores changes to the filter keys a host excludes', () => {
    const options = { ignoreFilterKeys: ['status'] }
    expect(
      diffPerspectiveSettings({ filters: { status: 'open', owner: 'me' } }, { filters: { status: 'closed', owner: 'me' } }, options),
    ).toEqual([])
    expect(
      diffPerspectiveSettings({ filters: { status: 'open', owner: 'me' } }, { filters: { status: 'open', owner: 'you' } }, options),
    ).toEqual(['filters'])
  })

  it('treats an ignored filter key as absent on either side', () => {
    const options = { ignoreFilterKeys: ['status'] }
    expect(diffPerspectiveSettings({}, { filters: { status: 'open' } }, options)).toEqual([])
    expect(diffPerspectiveSettings({ filters: { status: 'open' } }, {}, options)).toEqual([])
    expect(diffPerspectiveSettings({ filters: { owner: 'me' } }, { filters: { owner: 'me', status: 'open' } }, options)).toEqual([])
  })

  it('does not mutate the settings it compares when ignoring filter keys', () => {
    const base = { filters: { status: 'open', owner: 'me' } }
    const current = { filters: { status: 'closed', owner: 'me' } }
    diffPerspectiveSettings(base, current, { ignoreFilterKeys: ['status'] })
    expect(base).toEqual({ filters: { status: 'open', owner: 'me' } })
    expect(current).toEqual({ filters: { status: 'closed', owner: 'me' } })
  })

  it('compares a persisted filter tree as a whole even with ignored keys', () => {
    const tree = (value: string) => ({
      v: 2,
      root: { id: 'root', type: 'group', combinator: 'and', children: [{ id: 'r1', type: 'rule', field: 'status', op: 'is', value }] },
    })
    expect(
      diffPerspectiveSettings({ filters: tree('open') }, { filters: tree('closed') }, { ignoreFilterKeys: ['status', 'root'] }),
    ).toEqual(['filters'])
  })

  it('treats null and undefined settings as empty', () => {
    expect(diffPerspectiveSettings(null, undefined)).toEqual([])
    expect(diffPerspectiveSettings(null, { searchValue: 'acme' })).toEqual(['searchValue'])
  })
})
