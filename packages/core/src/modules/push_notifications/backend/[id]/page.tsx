"use client"
import * as React from 'react'
import { useParams } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type PushDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

type DeliveryDetail = {
  id: string
  notification_id: string | null
  notification_type_id: string
  user_device_id: string
  user_id: string
  provider: string
  token_snapshot: string
  status: PushDeliveryStatus
  attempts: number
  last_error: string | null
  payload: Record<string, unknown> | null
  provider_response: Record<string, unknown> | null
  created_at: string | null
  sent_at: string | null
  updated_at: string | null
}

const statusVariant: StatusMap<PushDeliveryStatus> = {
  pending: 'info',
  sent: 'success',
  failed: 'error',
  skipped: 'neutral',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  )
}

function JsonBlock({ value }: { value: Record<string, unknown> | null }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted p-3 text-xs">
      {value ? JSON.stringify(value, null, 2) : '—'}
    </pre>
  )
}

export default function PushDeliveryDetailPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params?.id[0] : ''
  const t = useT()
  const [item, setItem] = React.useState<DeliveryDetail | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notFound, setNotFound] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setError(null)
      setNotFound(false)
      const call = await apiCall<{ item?: DeliveryDetail; error?: string }>(
        `/api/push_notifications/deliveries/${encodeURIComponent(id)}`,
        undefined,
        { fallback: null },
      ).catch(() => null)
      if (cancelled) return
      if (!call || !call.ok) {
        if (call?.status === 404) setNotFound(true)
        else setError((call?.result as { error?: string } | undefined)?.error ?? t('push_notifications.deliveries.error.loadFailed'))
        setIsLoading(false)
        return
      }
      setItem(call.result?.item ?? null)
      setNotFound(!call.result?.item)
      setIsLoading(false)
    }
    if (id) load()
    return () => { cancelled = true }
  }, [id, t])

  return (
    <Page>
      <PageBody>
        {isLoading ? (
          <LoadingMessage label={t('push_notifications.deliveries.detail.loading')} />
        ) : notFound ? (
          <RecordNotFoundState
            label={t('push_notifications.errors.not_found')}
            backHref="/backend/push_notifications"
            backLabel={t('push_notifications.deliveries.title')}
          />
        ) : error ? (
          <ErrorMessage label={error} />
        ) : item ? (
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold">{t('push_notifications.deliveries.detail.pageTitle')}</h1>
              <StatusBadge variant={statusVariant[item.status] ?? 'neutral'} dot>
                {t(`push_notifications.deliveries.status.${item.status}`)}
              </StatusBadge>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t('push_notifications.deliveries.columns.type')}>{item.notification_type_id}</Field>
              <Field label={t('push_notifications.deliveries.columns.provider')}>{item.provider}</Field>
              <Field label={t('push_notifications.deliveries.columns.attempts')}>{item.attempts}</Field>
              <Field label={t('push_notifications.deliveries.columns.user')}>
                <code className="text-xs">{item.user_id}</code>
              </Field>
              <Field label={t('push_notifications.deliveries.detail.device')}>
                <code className="text-xs">{item.user_device_id}</code>
              </Field>
              <Field label={t('push_notifications.deliveries.detail.tokenSnapshot')}>
                <code className="text-xs">…{item.token_snapshot}</code>
              </Field>
              <Field label={t('push_notifications.deliveries.columns.created')}>
                {item.created_at ? new Date(item.created_at).toLocaleString() : '—'}
              </Field>
              <Field label={t('push_notifications.deliveries.columns.sent')}>
                {item.sent_at ? new Date(item.sent_at).toLocaleString() : '—'}
              </Field>
              <Field label={t('push_notifications.deliveries.detail.lastError')}>{item.last_error ?? '—'}</Field>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t('push_notifications.deliveries.detail.payload')}</span>
              <JsonBlock value={item.payload} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t('push_notifications.deliveries.detail.providerResponse')}</span>
              <JsonBlock value={item.provider_response} />
            </div>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
