"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField, type CrudFormGroup, type CrudFieldOption, type CrudCustomFieldRenderProps } from '@open-mercato/ui/backend/CrudForm'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@open-mercato/ui/primitives/select'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type FormValues = {
  userId: string
  deviceId: string
  mode: string
  title: string
  body: string
  sound: string
  badge: number | string
  image: string
  priority: string
  channelId: string
}

const DELIVERIES_HREF = '/backend/push_notifications'
// Radix Select forbids an empty-string item value, so "all devices" uses a sentinel that we map
// back to '' (the form value that means "fan out to every push-capable device").
const ALL_DEVICES = '__all__'

type DeviceOption = { id: string; label: string }

// Dependent picker: loads the *selected recipient's* push-capable devices (admin devices API,
// filtered by userId) so an admin can target one device or all of them. Reads the live form values,
// so it re-loads whenever the recipient changes and clears a stale selection. Degrades to just
// "All devices" when the admin lacks devices.admin or the recipient has no push-capable device.
function DeviceField({ value, setValue, values }: CrudCustomFieldRenderProps) {
  const t = useT()
  const userId = typeof values?.userId === 'string' ? values.userId : ''
  const selected = typeof value === 'string' && value ? value : ''
  const [devices, setDevices] = React.useState<DeviceOption[]>([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!userId) {
      setDevices([])
      if (selected) setValue('')
      return
    }
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ userId, pageSize: '50' })
    apiCall<{ items?: Array<{ id: string; device_id: string; platform: string; push_provider?: string | null }> }>(
      `/api/devices/admin/devices?${params.toString()}`,
      { headers: { 'x-om-forbidden-redirect': '0' } },
      { fallback: null },
    )
      .catch(() => null)
      .then((call) => {
        if (cancelled) return
        const items = (call && call.ok ? call.result?.items : []) ?? []
        const opts = items
          .filter((d): d is { id: string; device_id: string; platform: string; push_provider?: string | null } =>
            !!d && typeof d.id === 'string' && !!d.push_provider)
          .map((d) => ({ id: d.id, label: `${d.device_id} · ${d.platform}${d.push_provider ? ` · ${d.push_provider}` : ''}` }))
        setDevices(opts)
        if (selected && !opts.some((o) => o.id === selected)) setValue('')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // Reload only when the recipient changes; `selected`/`setValue` are handled inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  return (
    <div className="space-y-1">
      <Select value={selected || ALL_DEVICES} onValueChange={(v) => setValue(v === ALL_DEVICES ? '' : v)} disabled={!userId}>
        <SelectTrigger>
          <SelectValue placeholder={t('push_notifications.send.deviceAll')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_DEVICES}>{t('push_notifications.send.deviceAll')}</SelectItem>
          {devices.map((d) => (
            <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {!userId
          ? t('push_notifications.send.deviceSelectUserFirst')
          : loading
            ? t('common.loading', 'Loading…')
            : devices.length === 0
              ? t('push_notifications.send.deviceNone')
              : t('push_notifications.send.deviceHint')}
      </p>
    </div>
  )
}

export default function PushCustomSendPage() {
  const router = useRouter()
  const t = useT()

  // Pick the recipient by name/email instead of a raw UUID. Search server-side via /api/auth/users
  // (mirrors the devices list + admin notification-preferences picker). Admins without auth.users.list
  // degrade gracefully to no options — they can still paste an id.
  //
  // NOTE: return results only — do NOT push them into component state. The combobox keeps async
  // results internally; feeding them back into a `userOptions` state that `fields` depends on would
  // re-render the whole CrudForm on every keystroke (visible input stutter).
  const loadUserOptions = React.useCallback(async (query?: string): Promise<CrudFieldOption[]> => {
    const params = new URLSearchParams()
    params.set('page', '1')
    params.set('pageSize', '20')
    if (query && query.trim().length > 0) params.set('search', query.trim())
    const call = await apiCall<{ items?: { id: string; name?: string | null; email?: string | null }[] }>(
      `/api/auth/users?${params.toString()}`,
      { headers: { 'x-om-forbidden-redirect': '0' } },
      { fallback: null },
    ).catch(() => null)
    if (!call || !call.ok) return []
    return (call.result?.items ?? []).flatMap((item): CrudFieldOption[] => {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) return []
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
      const email = typeof item.email === 'string' && item.email.trim() ? item.email.trim() : null
      const label = name && email ? `${name} — ${email}` : email ?? name ?? item.id
      return [{ value: item.id, label }]
    })
  }, [])

  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'userId', label: t('push_notifications.send.userId'), type: 'combobox', required: true, description: t('push_notifications.send.userIdHint'), loadOptions: loadUserOptions },
    { id: 'deviceId', label: t('push_notifications.send.device'), type: 'custom', component: (props) => <DeviceField {...props} /> },
    {
      id: 'mode',
      label: t('push_notifications.send.mode'),
      type: 'select',
      required: true,
      description: t('push_notifications.send.modeHint'),
      options: [
        { value: 'visible', label: t('push_notifications.send.modeVisible') },
        { value: 'silent', label: t('push_notifications.send.modeSilent') },
      ],
    },
    { id: 'title', label: t('push_notifications.send.title'), type: 'text', required: true },
    { id: 'body', label: t('push_notifications.send.body'), type: 'textarea' },
    { id: 'sound', label: t('push_notifications.send.sound'), type: 'text' },
    { id: 'badge', label: t('push_notifications.send.badge'), type: 'number' },
    { id: 'image', label: t('push_notifications.send.image'), type: 'text' },
    {
      id: 'priority',
      label: t('push_notifications.send.priority'),
      type: 'select',
      options: [
        { value: '', label: t('push_notifications.send.priorityDefault') },
        { value: 'high', label: t('push_notifications.send.priorityHigh') },
        { value: 'normal', label: t('push_notifications.send.priorityNormal') },
      ],
    },
    { id: 'channelId', label: t('push_notifications.send.channelId'), type: 'text' },
  ], [t, loadUserOptions])

  const groups = React.useMemo<CrudFormGroup[]>(() => ([
    { id: 'message', title: t('push_notifications.send.message'), column: 1, fields: ['userId', 'deviceId', 'mode', 'title', 'body'] },
    { id: 'options', title: t('push_notifications.send.options'), description: t('push_notifications.send.optionsHint'), column: 1, fields: ['sound', 'badge', 'image', 'priority', 'channelId'] },
  ]), [t])

  return (
    <Page>
      <PageBody>
        <CrudForm<FormValues>
          title={t('push_notifications.send.pageTitle')}
          backHref={DELIVERIES_HREF}
          cancelHref={DELIVERIES_HREF}
          fields={fields}
          groups={groups}
          initialValues={{ userId: '', deviceId: '', mode: 'visible', title: '', body: '', sound: '', badge: '', image: '', priority: '', channelId: '' }}
          submitLabel={t('push_notifications.send.submit')}
          onSubmit={async (values) => {
            const body = (values.body ?? '').trim()
            const pushOptions: Record<string, unknown> = {}
            if (typeof values.sound === 'string' && values.sound.trim()) pushOptions.sound = values.sound.trim()
            const badgeNum = typeof values.badge === 'number' ? values.badge : Number.parseInt(String(values.badge ?? ''), 10)
            if (Number.isFinite(badgeNum) && badgeNum >= 0) pushOptions.badge = badgeNum
            if (typeof values.image === 'string' && values.image.trim()) pushOptions.image = values.image.trim()
            if (values.priority === 'high' || values.priority === 'normal') pushOptions.priority = values.priority
            if (typeof values.channelId === 'string' && values.channelId.trim()) pushOptions.channelId = values.channelId.trim()
            const hasOptions = Object.keys(pushOptions).length > 0
            await apiCallOrThrow('/api/push_notifications/custom-send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                recipientUserId: (values.userId ?? '').trim(),
                deviceId: (values.deviceId ?? '').trim() || undefined,
                title: (values.title ?? '').trim(),
                body: body.length > 0 ? body : undefined,
                silent: values.mode === 'silent',
                pushOptions: hasOptions ? pushOptions : undefined,
              }),
            })
            flash(t('push_notifications.send.success'), 'success')
            router.push(DELIVERIES_HREF)
          }}
        />
      </PageBody>
    </Page>
  )
}
