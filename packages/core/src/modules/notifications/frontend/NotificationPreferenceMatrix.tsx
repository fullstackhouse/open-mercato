"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Switch } from '@open-mercato/ui/primitives/switch'

export type NotificationTypeItem = { id: string; labelKey: string; descriptionKey?: string | null }
export type PreferenceItem = { notificationTypeId: string; channel: string; enabled: boolean }

export type ChannelDef = { key: string; labelKey: string; labelFallback: string; hintKey: string; hintFallback: string }

export const PREFERENCE_CHANNELS: ChannelDef[] = [
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

export function preferenceKey(typeId: string, channel: string): string {
  return `${typeId}::${channel}`
}

/** Build the default-on preference map for a catalogue + stored rows. */
export function buildPreferenceMap(
  types: NotificationTypeItem[],
  stored: PreferenceItem[],
): Record<string, boolean> {
  const storedMap = new Map(stored.map((item) => [preferenceKey(item.notificationTypeId, item.channel), item.enabled]))
  const next: Record<string, boolean> = {}
  for (const type of types) {
    for (const channel of PREFERENCE_CHANNELS) {
      const key = preferenceKey(type.id, channel.key)
      next[key] = storedMap.get(key) ?? true
    }
  }
  return next
}

/** Flatten a preference map back into the API payload shape. */
export function toPreferenceItems(
  types: NotificationTypeItem[],
  prefs: Record<string, boolean>,
): PreferenceItem[] {
  const items: PreferenceItem[] = []
  for (const type of types) {
    for (const channel of PREFERENCE_CHANNELS) {
      items.push({
        notificationTypeId: type.id,
        channel: channel.key,
        enabled: prefs[preferenceKey(type.id, channel.key)] ?? true,
      })
    }
  }
  return items
}

export type NotificationPreferenceMatrixProps = {
  types: NotificationTypeItem[]
  prefs: Record<string, boolean>
  onToggle: (typeId: string, channel: string, enabled: boolean) => void
  disabled?: boolean
}

export function NotificationPreferenceMatrix({ types, prefs, onToggle, disabled }: NotificationPreferenceMatrixProps) {
  const t = useT()

  if (types.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('notifications.preferences.empty', 'No notification types are registered yet.')}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th className="px-4 py-3 font-medium">{t('notifications.preferences.columns.type', 'Notification type')}</th>
            {PREFERENCE_CHANNELS.map((channel) => (
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
              {PREFERENCE_CHANNELS.map((channel) => (
                <td key={channel.key} className="px-4 py-3">
                  <Switch
                    checked={prefs[preferenceKey(type.id, channel.key)] ?? true}
                    disabled={disabled}
                    onCheckedChange={(checked) => onToggle(type.id, channel.key, checked)}
                    aria-label={`${t(type.labelKey, type.id)} – ${t(channel.labelKey, channel.labelFallback)}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default NotificationPreferenceMatrix
