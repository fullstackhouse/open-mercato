/** @jest-environment jsdom */
import * as React from 'react'
import { DataTable, type DataTableViewApi } from '../DataTable'
import type { FilterValues } from '../FilterBar'
import type { ColumnDef } from '@tanstack/react-table'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { render, fireEvent, waitFor, screen, act } from '@testing-library/react'
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

jest.mock('../FlashMessages', () => ({ flash: jest.fn() }))

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

// The filter popover is not under test; the stub applies a filter value the way
// the real one does — by handing the merged values to `onApply`.
jest.mock('../FilterBar', () => ({
  FilterBar: (props: { values?: FilterValues; onApply?: (values: FilterValues) => void }) => (
    <div>
      <button type="button" data-testid="apply-status" onClick={() => props.onApply?.({ ...props.values, status: 'closed' })} />
      <button type="button" data-testid="apply-owner" onClick={() => props.onApply?.({ ...props.values, owner: 'you' })} />
    </div>
  ),
}))

type Row = { id: string; name: string }

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'id', header: 'Id' },
]

const SAVED_VIEW = {
  id: 'persp-1',
  name: 'Open items',
  tableId: 'test-table',
  settings: { filters: { status: 'open', owner: 'me' } },
  isDefault: false,
  createdAt: 'now',
  updatedAt: '2026-08-06T00:00:00.000Z',
}

const INDEX_RESPONSE: PerspectivesIndexResponse = {
  tableId: 'test-table',
  perspectives: [SAVED_VIEW],
  defaultPerspectiveId: null,
  rolePerspectives: [],
  manageableRolePerspectives: [],
  roles: [],
  canApplyToRoles: false,
}

function renderTable(apiRef: React.MutableRefObject<DataTableViewApi | null>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  })
  queryClient.setQueryData(['feature-check', 'perspectives'], { use: true, roleDefaults: true })
  queryClient.setQueryData(['table-perspectives', 'test-table'], INDEX_RESPONSE)

  function Harness() {
    const [filterValues, setFilterValues] = React.useState<FilterValues>({})
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider locale="en" dict={{}}>
          <DataTable<Row>
            columns={columns}
            data={[]}
            filters={[{ id: 'status', label: 'Status', type: 'text' }, { id: 'owner', label: 'Owner', type: 'text' }]}
            filterValues={filterValues}
            onFiltersApply={setFilterValues}
            perspective={{ tableId: 'test-table', dirtyIgnoreFilterKeys: ['status'] }}
            viewApiRef={apiRef}
          />
        </I18nProvider>
      </QueryClientProvider>
    )
  }

  return render(<Harness />)
}

describe('DataTable perspective.dirtyIgnoreFilterKeys', () => {
  beforeEach(() => {
    window.localStorage.clear()
    for (const entry of document.cookie.split(';')) {
      const name = entry.split('=')[0]?.trim()
      if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
    }
  })

  it('keeps the view clean when only an ignored filter changes, yet still saves it', async () => {
    const apiRef = React.createRef<DataTableViewApi | null>() as React.MutableRefObject<DataTableViewApi | null>
    renderTable(apiRef)
    await waitFor(() => expect(apiRef.current?.getDirtyState().activePerspectiveId).toBe('persp-1'))
    await waitFor(() => expect(apiRef.current?.getCurrentSettings().filters).toEqual({ status: 'open', owner: 'me' }))

    await act(async () => { fireEvent.click(screen.getByTestId('apply-status')) })

    await waitFor(() => expect(apiRef.current?.getCurrentSettings().filters?.status).toBe('closed'))
    expect(apiRef.current?.getDirtyState().isDirty).toBe(false)

    await act(async () => { fireEvent.click(screen.getByTestId('apply-owner')) })

    await waitFor(() => expect(apiRef.current?.getDirtyState().isDirty).toBe(true))
    expect(apiRef.current?.getDirtyState().changedKeys).toEqual(['filters'])
    expect(apiRef.current?.getCurrentSettings().filters).toEqual({ status: 'closed', owner: 'you' })
  })
})
