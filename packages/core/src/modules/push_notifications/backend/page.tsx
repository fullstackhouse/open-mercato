"use client"
import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'

type PushDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

type Row = {
  id: string
  notification_type_id: string
  user_id: string
  provider: string
  token_snapshot: string
  status: PushDeliveryStatus
  attempts: number
  last_error: string | null
  created_at: string | null
  sent_at: string | null
}

type ResponsePayload = {
  items: Row[]
  total: number
  page?: number
  pageSize?: number
  totalPages: number
}

const statusVariant: StatusMap<PushDeliveryStatus> = {
  pending: 'info',
  sent: 'success',
  failed: 'error',
  skipped: 'neutral',
}

function formatDate(value: string | null, t: (key: string) => string) {
  if (!value) return t('push_notifications.deliveries.noValue')
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return t('push_notifications.deliveries.noValue')
    return date.toLocaleString()
  } catch {
    return t('push_notifications.deliveries.noValue')
  }
}

export default function PushDeliveriesListPage() {
  const [rows, setRows] = React.useState<Row[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [isLoading, setIsLoading] = React.useState(true)
  const scopeVersion = useOrganizationScopeVersion()
  const t = useT()
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})

  const filters = React.useMemo<FilterDef[]>(() => [
    {
      id: 'status',
      label: t('push_notifications.deliveries.columns.status'),
      type: 'select',
      options: [
        { value: 'pending', label: t('push_notifications.deliveries.status.pending') },
        { value: 'sent', label: t('push_notifications.deliveries.status.sent') },
        { value: 'failed', label: t('push_notifications.deliveries.status.failed') },
        { value: 'skipped', label: t('push_notifications.deliveries.status.skipped') },
      ],
    },
    { id: 'userId', label: t('push_notifications.deliveries.columns.user'), type: 'text' },
    { id: 'from', label: t('push_notifications.deliveries.filters.from'), type: 'text' },
    { id: 'to', label: t('push_notifications.deliveries.filters.to'), type: 'text' },
  ], [t])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('page', String(page))
        params.set('pageSize', '50')
        const status = typeof filterValues.status === 'string' ? filterValues.status.trim() : ''
        const userId = typeof filterValues.userId === 'string' ? filterValues.userId.trim() : ''
        const from = typeof filterValues.from === 'string' ? filterValues.from.trim() : ''
        const to = typeof filterValues.to === 'string' ? filterValues.to.trim() : ''
        if (status) params.set('status', status)
        if (userId) params.set('userId', userId)
        if (from) params.set('from', from)
        if (to) params.set('to', to)
        const fallback: ResponsePayload = { items: [], total: 0, page, totalPages: 1 }
        const call = await apiCall<ResponsePayload>(`/api/push_notifications/deliveries?${params.toString()}`, undefined, { fallback })
        if (!call.ok) {
          const errorPayload = call.result as { error?: string } | undefined
          const message = typeof errorPayload?.error === 'string' ? errorPayload.error : t('push_notifications.deliveries.error.loadFailed')
          flash(message, 'error')
          return
        }
        const payload = call.result ?? fallback
        if (!cancelled) {
          setRows(Array.isArray(payload.items) ? payload.items : [])
          setTotal(payload.total || 0)
          setTotalPages(payload.totalPages || 1)
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : t('push_notifications.deliveries.error.loadFailed')
          flash(message, 'error')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [page, scopeVersion, filterValues, t])

  const columns = React.useMemo<ColumnDef<Row>[]>(() => [
    {
      accessorKey: 'status',
      header: t('push_notifications.deliveries.columns.status'),
      cell: ({ row }) => (
        <StatusBadge variant={statusVariant[row.original.status] ?? 'neutral'} dot>
          {t(`push_notifications.deliveries.status.${row.original.status}`)}
        </StatusBadge>
      ),
    },
    { accessorKey: 'notification_type_id', header: t('push_notifications.deliveries.columns.type') },
    {
      accessorKey: 'user_id',
      header: t('push_notifications.deliveries.columns.user'),
      cell: ({ row }) => <code className="text-xs">{row.original.user_id}</code>,
    },
    { accessorKey: 'provider', header: t('push_notifications.deliveries.columns.provider') },
    {
      accessorKey: 'attempts',
      header: t('push_notifications.deliveries.columns.attempts'),
    },
    {
      accessorKey: 'created_at',
      header: t('push_notifications.deliveries.columns.created'),
      cell: ({ row }) => formatDate(row.original.created_at, t),
    },
    {
      accessorKey: 'sent_at',
      header: t('push_notifications.deliveries.columns.sent'),
      cell: ({ row }) => formatDate(row.original.sent_at, t),
    },
  ], [t])

  return (
    <Page>
      <PageBody>
        <DataTable
          title={t('push_notifications.deliveries.title')}
          columns={columns}
          data={rows}
          filters={filters}
          filterValues={filterValues}
          onFiltersApply={(values) => { setFilterValues(values); setPage(1) }}
          onFiltersClear={() => { setFilterValues({}); setPage(1) }}
          perspective={{ tableId: 'push_notifications.deliveries' }}
          onRowClick={(row) => { window.location.href = `/backend/push_notifications/${row.id}` }}
          pagination={{ page, pageSize: 50, total, totalPages, onPageChange: setPage }}
          isLoading={isLoading}
          emptyState={t('push_notifications.deliveries.empty')}
        />
      </PageBody>
    </Page>
  )
}
