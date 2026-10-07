/** @jest-environment jsdom */
import * as React from 'react'
import { DataTable, type DataTablePerspectivesState, type DataTableViewApi } from '../DataTable'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { render, waitFor, act } from '@testing-library/react'
import type { FilterValues } from '../FilterBar'
import type { PerspectivesIndexResponse } from '@open-mercato/shared/modules/perspectives/types'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}))

jest.mock('../injection/useInjectionDataWidgets', () => ({
  useInjectionDataWidgets: () => ({ widgets: [], isLoading: false }),
}))

jest.mock('../injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
    retryLastMutation: async () => false,
  }),
}))

jest.mock('../utils/apiCall', () => ({
  apiCall: async () => ({
    ok: true,
    status: 200,
    result: undefined,
    response: { ok: true, status: 200 } as Response,
    cacheStatus: null,
  }),
  withScopedApiRequestHeaders: async (_headers: Record<string, string>, run: () => Promise<unknown>) => run(),
}))

jest.mock('../PerspectiveSidebar', () => ({
  PerspectiveSidebar: () => null,
}))

type Row = { id: string; name: string; status: string }

const OPEN_VIEW = {
  id: 'persp-open',
  name: 'Open',
  tableId: 'test-table',
  settings: { filters: { status: 'open' } },
  isDefault: false,
  createdAt: 'now',
  updatedAt: '2026-08-06T00:00:00.000Z',
}

const CLOSED_VIEW = {
  id: 'persp-closed',
  name: 'Closed',
  tableId: 'test-table',
  settings: {
    filters: { status: 'closed' },
    sorting: [{ id: 'name', desc: true }],
    columnVisibility: { status: false },
  },
  isDefault: false,
  createdAt: 'now',
  updatedAt: '2026-08-06T00:00:00.000Z',
}

const ROLE_VIEW = {
  id: 'role-view',
  name: 'Team view',
  tableId: 'test-table',
  settings: { filters: { status: 'pending' } },
  isDefault: false,
  roleId: 'role-sales',
  roleName: 'Sales',
  createdAt: 'now',
  updatedAt: '2026-08-06T00:00:00.000Z',
} as unknown as PerspectivesIndexResponse['rolePerspectives'][number]

const INDEX_RESPONSE: PerspectivesIndexResponse = {
  tableId: 'test-table',
  perspectives: [OPEN_VIEW, CLOSED_VIEW],
  defaultPerspectiveId: null,
  rolePerspectives: [ROLE_VIEW],
  manageableRolePerspectives: [],
  roles: [],
  canApplyToRoles: false,
}

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'status', header: 'Status' },
]

function renderTable({ perspectivesFeature = 'granted' }: { perspectivesFeature?: 'granted' | 'denied' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  })
  queryClient.setQueryData(['feature-check', 'perspectives'], {
    use: perspectivesFeature === 'granted',
    roleDefaults: perspectivesFeature === 'granted',
  })
  // Seeded even for the denied case: the list is then in the query cache, and
  // the view API must still hand the host nothing.
  queryClient.setQueryData(['table-perspectives', 'test-table'], INDEX_RESPONSE)

  const apiRef = React.createRef<DataTableViewApi | null>() as React.MutableRefObject<DataTableViewApi | null>
  const onFiltersApply = jest.fn<void, [FilterValues]>()
  const onSortingChange = jest.fn<void, [SortingState]>()
  const pushed: DataTablePerspectivesState[] = []

  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en" dict={{}}>
        <DataTable<Row>
          columns={columns}
          data={[]}
          onFiltersApply={onFiltersApply}
          onSortingChange={onSortingChange}
          perspective={{
            tableId: 'test-table',
            onPerspectivesChange: (state) => { pushed.push(state) },
          }}
          viewApiRef={apiRef}
        />
      </I18nProvider>
    </QueryClientProvider>,
  )

  return { apiRef, onFiltersApply, onSortingChange, pushed }
}

const lastCall = <T,>(mock: jest.Mock<void, [T]>): T | undefined => mock.mock.calls[mock.mock.calls.length - 1]?.[0]

describe('DataTable view API — host-driven view switching', () => {
  beforeEach(() => {
    window.localStorage.clear()
    for (const entry of document.cookie.split(';')) {
      const name = entry.split('=')[0]?.trim()
      if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
    }
  })

  it('applies a view activated by id through the host callbacks', async () => {
    const { apiRef, onFiltersApply, onSortingChange } = renderTable()
    // With no default set, the table activates the first saved view on load.
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open'))

    act(() => { apiRef.current!.activatePerspective('persp-closed') })

    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-closed'))
    expect(lastCall(onFiltersApply)).toEqual({ status: 'closed' })
    expect(lastCall(onSortingChange)).toEqual([{ id: 'name', desc: true }])
    expect(apiRef.current?.getCurrentSettings().columnVisibility).toEqual({ status: false })
  })

  it('activates a role view by id', async () => {
    const { apiRef, onFiltersApply } = renderTable()
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open'))

    act(() => { apiRef.current!.activatePerspective('role-view') })

    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('role-view'))
    expect(lastCall(onFiltersApply)).toEqual({ status: 'pending' })
  })

  it('clears to no view on null, the way the built-in "All views" entry does', async () => {
    const { apiRef, onFiltersApply, onSortingChange } = renderTable()
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open'))
    act(() => { apiRef.current!.activatePerspective('persp-closed') })
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-closed'))

    act(() => { apiRef.current!.activatePerspective(null) })

    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBeNull())
    expect(lastCall(onFiltersApply)).toEqual({})
    expect(lastCall(onSortingChange)).toEqual([])
    expect(apiRef.current?.getCurrentSettings().columnVisibility).toBeUndefined()
  })

  it('ignores an unknown id', async () => {
    const { apiRef, onFiltersApply, onSortingChange } = renderTable()
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open'))
    const filterCalls = onFiltersApply.mock.calls.length
    const sortingCalls = onSortingChange.mock.calls.length

    expect(() => act(() => { apiRef.current!.activatePerspective('no-such-view') })).not.toThrow()

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open')
    expect(onFiltersApply.mock.calls.length).toBe(filterCalls)
    expect(onSortingChange.mock.calls.length).toBe(sortingCalls)
  })

  it('reports the known views and pushes every change of the list or the active view', async () => {
    const { apiRef, pushed } = renderTable()
    await waitFor(() => expect(apiRef.current?.getPerspectives().activePerspectiveId).toBe('persp-open'))

    expect(apiRef.current?.getPerspectives()).toEqual({
      perspectives: [OPEN_VIEW, CLOSED_VIEW],
      rolePerspectives: [ROLE_VIEW],
      activePerspectiveId: 'persp-open',
    })
    await waitFor(() => expect(pushed[pushed.length - 1]).toEqual(apiRef.current?.getPerspectives()))
    const pushedBeforeActivation = pushed.length

    act(() => { apiRef.current!.activatePerspective('persp-closed') })

    await waitFor(() => expect(pushed.length).toBeGreaterThan(pushedBeforeActivation))
    expect(pushed[pushed.length - 1]).toEqual({
      perspectives: [OPEN_VIEW, CLOSED_VIEW],
      rolePerspectives: [ROLE_VIEW],
      activePerspectiveId: 'persp-closed',
    })
  })

  it('hands a user without the perspectives feature an empty state and ignores activation', async () => {
    const { apiRef, onFiltersApply, onSortingChange, pushed } = renderTable({ perspectivesFeature: 'denied' })
    await waitFor(() => expect(apiRef.current).not.toBeNull())

    const empty = { perspectives: [], rolePerspectives: [], activePerspectiveId: null }
    expect(apiRef.current?.getPerspectives()).toEqual(empty)
    await waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(pushed.every((state) => JSON.stringify(state) === JSON.stringify(empty))).toBe(true)

    const filterCalls = onFiltersApply.mock.calls.length
    const sortingCalls = onSortingChange.mock.calls.length
    act(() => {
      apiRef.current!.activatePerspective('persp-closed')
      apiRef.current!.activatePerspective(null)
    })

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(apiRef.current?.getPerspectives()).toEqual(empty)
    expect(onFiltersApply.mock.calls.length).toBe(filterCalls)
    expect(onSortingChange.mock.calls.length).toBe(sortingCalls)
  })
})
