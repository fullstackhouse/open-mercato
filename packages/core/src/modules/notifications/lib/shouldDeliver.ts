import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import type { NotificationPreferenceScope } from './notificationPreferenceService'

/**
 * The single per-channel delivery gate. Every channel (`in_app`, `email`, `push`, custom) is
 * governed by this one function so opt-out / eligibility / targeting enforcement can never be
 * bypassed or re-implemented inconsistently per strategy.
 *
 * A channel is delivered when ALL hold:
 *   1. it is a registered strategy id (`registeredChannels`),
 *   2. the type is eligible for it (`type.channels`, when declared),
 *   3. it is in the per-send target (`targetChannels`, when provided),
 *   4. either the type is `nonOptOut`, or the recipient has not disabled it (`isChannelEnabled`).
 *
 * `silent` is intentionally NOT consulted here — it selects push delivery STYLE, not whether a
 * channel delivers at all. Absent `type.channels` and absent `targetChannels` both mean "no
 * restriction", so a fully-default call resolves to every registered channel (pre-Phase-7 behavior).
 */
export type ChannelPreferenceReader = {
  isChannelEnabled(scope: NotificationPreferenceScope, typeId: string, channel: string): Promise<boolean>
}

export type ShouldDeliverParams = {
  /** The notification's `type` string (used for the preference lookup even when unregistered). */
  typeId: string
  /** The registered type definition, when the type id is known. Supplies eligibility + nonOptOut. */
  type: NotificationTypeDefinition | undefined
  channel: string
  scope: NotificationPreferenceScope
  /** Per-send channel target. `null`/`undefined` → no target restriction. */
  targetChannels?: string[] | null
  /** Ids of the currently registered delivery strategies. */
  registeredChannels: string[]
  preferences: ChannelPreferenceReader
}

export async function shouldDeliver(params: ShouldDeliverParams): Promise<boolean> {
  const { typeId, type, channel, scope, targetChannels, registeredChannels, preferences } = params

  if (!registeredChannels.includes(channel)) return false
  if (type?.channels && !type.channels.includes(channel)) return false
  if (targetChannels && !targetChannels.includes(channel)) return false
  if (type?.nonOptOut === true) return true

  return preferences.isChannelEnabled(scope, typeId, channel)
}

export type ResolveEffectiveChannelsParams = Omit<ShouldDeliverParams, 'channel'>

/**
 * Resolves the authoritative channel set for a notification at create time: every registered
 * channel that passes {@link shouldDeliver}. Stored on `Notification.channels` and looped by the
 * dispatcher; `in_app` membership also gates bell/inbox visibility.
 */
export async function resolveEffectiveChannels(
  params: ResolveEffectiveChannelsParams,
): Promise<string[]> {
  const results = await Promise.all(
    params.registeredChannels.map(async (channel) =>
      (await shouldDeliver({ ...params, channel })) ? channel : null,
    ),
  )
  return results.filter((channel): channel is string => channel !== null)
}
