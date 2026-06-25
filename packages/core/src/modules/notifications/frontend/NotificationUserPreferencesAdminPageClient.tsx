"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import {
  NotificationPreferenceMatrix,
  buildPreferenceMap,
  preferenceKey,
  toPreferenceItems,
  type NotificationTypeItem,
  type PreferenceItem,
} from './NotificationPreferenceMatrix'

type TypesResponse = { items?: NotificationTypeItem[] }
type PreferencesResponse = { items?: PreferenceItem[] }
type SaveResponse = { ok?: boolean; error?: string }

type UserRow = { id: string; name?: string | null; email?: string | null }
type UsersResponse = { items?: UserRow[] }

const ADMIN_PREFERENCES_CONTEXT_ID = 'notifications-admin-preferences'

function userLabel(user: UserRow): string {
  return user.name?.trim() || user.email?.trim() || user.id
}

export function NotificationUserPreferencesAdminPageClient() {
  const t = useT()
  const [types, setTypes] = React.useState<NotificationTypeItem[]>([])
  const [typesLoading, setTypesLoading] = React.useState(true)
  const [search, setSearch] = React.useState('')
  const [results, setResults] = React.useState<UserRow[]>([])
  const [searching, setSearching] = React.useState(false)
  const [selected, setSelected] = React.useState<UserRow | null>(null)
  const [prefs, setPrefs] = React.useState<Record<string, boolean>>({})
  const [prefsLoading, setPrefsLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: ADMIN_PREFERENCES_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      setTypesLoading(true)
      try {
        const body = await readApiResultOrThrow<TypesResponse>('/api/notifications/types', undefined, {
          errorMessage: t('notifications.preferences.loadError', 'Failed to load notification preferences'),
          allowNullResult: true,
        })
        if (!cancelled) setTypes(body?.items ?? [])
      } catch (err) {
        if (!cancelled) flash(err instanceof Error ? err.message : t('notifications.preferences.loadError', 'Failed to load notification preferences'), 'error')
      } finally {
        if (!cancelled) setTypesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [t])

  React.useEffect(() => {
    const term = search.trim()
    let cancelled = false
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const params = new URLSearchParams({ pageSize: '10' })
        if (term) params.set('search', term)
        const body = await apiCall<UsersResponse>(`/api/auth/users?${params.toString()}`)
        if (!cancelled) setResults(body.ok ? (body.result?.items ?? []) : [])
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [search])

  const selectUser = async (user: UserRow) => {
    setSelected(user)
    setPrefsLoading(true)
    try {
      const body = await readApiResultOrThrow<PreferencesResponse>(
        `/api/notifications/admin/preferences?userId=${encodeURIComponent(user.id)}`,
        undefined,
        { errorMessage: t('notifications.preferences.loadError', 'Failed to load notification preferences'), allowNullResult: true },
      )
      setPrefs(buildPreferenceMap(types, body?.items ?? []))
    } catch (err) {
      flash(err instanceof Error ? err.message : t('notifications.preferences.loadError', 'Failed to load notification preferences'), 'error')
      setSelected(null)
    } finally {
      setPrefsLoading(false)
    }
  }

  const togglePref = (typeId: string, channel: string, enabled: boolean) => {
    setPrefs((prev) => ({ ...prev, [preferenceKey(typeId, channel)]: enabled }))
  }

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const preferences = toPreferenceItems(types, prefs)
      const response = await runMutation({
        operation: () =>
          apiCall<SaveResponse>('/api/notifications/admin/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: selected.id, preferences }),
          }),
        context: { formId: ADMIN_PREFERENCES_CONTEXT_ID, resourceKind: 'notifications.preference', retryLastMutation },
        mutationPayload: { userId: selected.id, preferences },
      })
      if (!response.ok) {
        throw new Error(response.result?.error || t('notifications.preferences.saveError', 'Failed to save notification preferences'))
      }
      flash(t('notifications.preferences.saveSuccess', 'Notification preferences saved'), 'success')
    } catch (err) {
      flash(err instanceof Error ? err.message : t('notifications.preferences.saveError', 'Failed to save notification preferences'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('notifications.preferences.admin.pageTitle', 'User Notification Preferences')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('notifications.preferences.admin.pageDescription', "Search for a user to review and edit their notification channel preferences.")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Input
          value={search}
          placeholder={t('notifications.preferences.admin.searchPlaceholder', 'Search users by name or email...')}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="rounded-lg border border-border">
          {searching ? (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t('notifications.preferences.admin.searching', 'Searching...')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {t('notifications.preferences.admin.noUsers', 'No users found.')}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => selectUser(user)}
                    className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-muted/50 ${selected?.id === user.id ? 'bg-muted/50 font-medium' : ''}`}
                  >
                    <span>{userLabel(user)}</span>
                    {user.email && user.name ? <span className="text-xs text-muted-foreground">{user.email}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {selected ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">
            {t('notifications.preferences.admin.editingFor', 'Preferences for {user}').replace('{user}', userLabel(selected))}
          </h2>
          {prefsLoading || typesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t('notifications.preferences.loading', 'Loading notification preferences...')}
            </div>
          ) : (
            <>
              <NotificationPreferenceMatrix types={types} prefs={prefs} onToggle={togglePref} />
              <div>
                <Button type="button" onClick={handleSave} disabled={saving}>
                  {saving ? t('notifications.preferences.saving', 'Saving...') : t('notifications.preferences.save', 'Save preferences')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default NotificationUserPreferencesAdminPageClient
