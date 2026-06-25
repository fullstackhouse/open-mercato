"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Spinner } from '@open-mercato/ui/primitives/spinner'

type NotificationTypeItem = { id: string; labelKey: string; descriptionKey?: string | null }
type TypesResponse = { items?: NotificationTypeItem[] }

type PreferenceItem = { notificationTypeId: string; channel: string; enabled: boolean }
type PreferencesResponse = { items?: PreferenceItem[] }
type SaveResponse = { ok?: boolean; error?: string }

type ChannelDef = { key: string; labelKey: string; labelFallback: string; hintKey: string; hintFallback: string }

const CHANNELS: ChannelDef[] = [
  {
    key: 'in_app',
    labelKey: 'notifications.preferences.channels.inApp',
    labelFallback: 'In-app',
    hintKey: 'notifications.preferences.channels.inAppHint',
    hintFallback: 'Notification center and bell.',
  },
  {
    key: 'push',
    labelKey: 'notifications.preferences.channels.push',
    labelFallback: 'Push',
    hintKey: 'notifications.preferences.channels.pushHint',
    hintFallback: 'Mobile push (active once a push channel is connected).',
  },
]

const PREFERENCES_CONTEXT_ID = 'notifications-preferences'

function prefKey(typeId: string, channel: string): string {
  return `${typeId}::${channel}`
}

export function NotificationPreferencesPageClient() {
  const t = useT()
  const [types, setTypes] = React.useState<NotificationTypeItem[] | null>(null)
  const [prefs, setPrefs] = React.useState<Record<string, boolean>>({})
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: PREFERENCES_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const fetchData = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [typesBody, prefsBody] = await Promise.all([
        readApiResultOrThrow<TypesResponse>('/api/notifications/types', undefined, {
          errorMessage: t('notifications.preferences.loadError', 'Failed to load notification preferences'),
          allowNullResult: true,
        }),
        readApiResultOrThrow<PreferencesResponse>('/api/notifications/preferences', undefined, {
          errorMessage: t('notifications.preferences.loadError', 'Failed to load notification preferences'),
          allowNullResult: true,
        }),
      ])
      const typeItems = typesBody?.items ?? []
      const stored = new Map(
        (prefsBody?.items ?? []).map((item) => [prefKey(item.notificationTypeId, item.channel), item.enabled]),
      )
      const nextPrefs: Record<string, boolean> = {}
      for (const type of typeItems) {
        for (const channel of CHANNELS) {
          const key = prefKey(type.id, channel.key)
          nextPrefs[key] = stored.get(key) ?? true
        }
      }
      setTypes(typeItems)
      setPrefs(nextPrefs)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('notifications.preferences.loadError', 'Failed to load notification preferences')
      setError(message)
      flash(message, 'error')
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    fetchData()
  }, [fetchData])

  const togglePref = (typeId: string, channel: string, enabled: boolean) => {
    setPrefs((prev) => ({ ...prev, [prefKey(typeId, channel)]: enabled }))
  }

  const handleSave = async () => {
    if (!types) return
    setSaving(true)
    try {
      const preferences: PreferenceItem[] = []
      for (const type of types) {
        for (const channel of CHANNELS) {
          preferences.push({
            notificationTypeId: type.id,
            channel: channel.key,
            enabled: prefs[prefKey(type.id, channel.key)] ?? true,
          })
        }
      }
      const response = await runMutation({
        operation: () =>
          apiCall<SaveResponse>('/api/notifications/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences }),
          }),
        context: { formId: PREFERENCES_CONTEXT_ID, resourceKind: 'notifications.preference', retryLastMutation },
        mutationPayload: { preferences },
      })
      if (!response.ok) {
        const message = response.result?.error || t('notifications.preferences.saveError', 'Failed to save notification preferences')
        throw new Error(message)
      }
      flash(t('notifications.preferences.saveSuccess', 'Notification preferences saved'), 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('notifications.preferences.saveError', 'Failed to save notification preferences')
      flash(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading || !types) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        {t('notifications.preferences.loading', 'Loading notification preferences...')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('notifications.preferences.pageTitle', 'Notification Preferences')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('notifications.preferences.pageDescription', 'Choose which channels deliver each notification type. Unset choices stay enabled by default.')}
        </p>
      </div>

      {types.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('notifications.preferences.empty', 'No notification types are registered yet.')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium">{t('notifications.preferences.columns.type', 'Notification type')}</th>
                {CHANNELS.map((channel) => (
                  <th key={channel.key} className="px-4 py-3 font-medium">
                    <div>{t(channel.labelKey, channel.labelFallback)}</div>
                    <div className="text-xs font-normal text-muted-foreground">{t(channel.hintKey, channel.hintFallback)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr key={type.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t(type.labelKey, type.id)}</div>
                    {type.descriptionKey ? (
                      <div className="text-xs text-muted-foreground">{t(type.descriptionKey, '')}</div>
                    ) : null}
                  </td>
                  {CHANNELS.map((channel) => (
                    <td key={channel.key} className="px-4 py-3">
                      <Switch
                        checked={prefs[prefKey(type.id, channel.key)] ?? true}
                        onCheckedChange={(checked) => togglePref(type.id, channel.key, checked)}
                        aria-label={`${t(type.labelKey, type.id)} – ${t(channel.labelKey, channel.labelFallback)}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? t('notifications.preferences.saving', 'Saving...') : t('notifications.preferences.save', 'Save preferences')}
        </Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  )
}

export default NotificationPreferencesPageClient
