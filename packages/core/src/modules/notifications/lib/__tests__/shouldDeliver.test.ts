import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import { resolveEffectiveChannels, shouldDeliver, type ChannelPreferenceReader } from '../shouldDeliver'

const SCOPE = { tenantId: 't1', userId: 'u1' }
const REGISTERED = ['in_app', 'email', 'push']

function def(type: string, extra: Partial<NotificationTypeDefinition> = {}): NotificationTypeDefinition {
  return { type, module: 'test', titleKey: `${type}.title`, icon: 'bell', severity: 'info', actions: [], ...extra }
}

/** Preference reader whose disabled `(typeId, channel)` pairs return false; everything else default-on. */
function prefs(disabled: Array<[string, string]> = []): ChannelPreferenceReader {
  const off = new Set(disabled.map(([typeId, channel]) => `${typeId}:${channel}`))
  return { isChannelEnabled: async (_scope, typeId, channel) => !off.has(`${typeId}:${channel}`) }
}

function base(overrides: Partial<Parameters<typeof shouldDeliver>[0]> = {}) {
  return {
    typeId: 'orders.created',
    type: def('orders.created'),
    scope: SCOPE,
    registeredChannels: REGISTERED,
    preferences: prefs(),
    ...overrides,
  }
}

describe('shouldDeliver', () => {
  it('delivers every registered channel by default (no target, no eligibility, no opt-out)', async () => {
    const channels = await resolveEffectiveChannels(base())
    expect(channels).toEqual(['in_app', 'email', 'push'])
  })

  it('rejects a channel that is not registered', async () => {
    expect(await shouldDeliver(base({ channel: 'sms' }))).toBe(false)
  })

  it('honors per-type eligibility (type.channels restricts the eligible set)', async () => {
    const type = def('marketing.promo', { channels: ['push'] })
    const channels = await resolveEffectiveChannels(base({ typeId: type.type, type }))
    expect(channels).toEqual(['push'])
  })

  it('honors per-send targeting, intersected within eligibility', async () => {
    const channels = await resolveEffectiveChannels(base({ targetChannels: ['push'] }))
    expect(channels).toEqual(['push'])
  })

  it('intersects per-send target with per-type eligibility', async () => {
    const type = def('marketing.promo', { channels: ['push', 'email'] })
    // target asks for in_app+push, eligibility allows push+email → only push survives
    const channels = await resolveEffectiveChannels(
      base({ typeId: type.type, type, targetChannels: ['in_app', 'push'] }),
    )
    expect(channels).toEqual(['push'])
  })

  it('excludes a channel the recipient has opted out of', async () => {
    const channels = await resolveEffectiveChannels(
      base({ preferences: prefs([['orders.created', 'in_app'], ['orders.created', 'email']]) }),
    )
    expect(channels).toEqual(['push'])
  })

  it('nonOptOut bypasses preferences on every channel', async () => {
    const type = def('security.alert', { nonOptOut: true })
    const channels = await resolveEffectiveChannels(
      base({
        typeId: type.type,
        type,
        preferences: prefs([['security.alert', 'in_app'], ['security.alert', 'push']]),
      }),
    )
    expect(channels).toEqual(['in_app', 'email', 'push'])
  })

  it('silent does NOT gate delivery (style only)', async () => {
    const type = def('orders.created', { silent: true })
    const channels = await resolveEffectiveChannels(base({ type }))
    expect(channels).toEqual(['in_app', 'email', 'push'])
  })

  it('unknown type (undefined def) still consults preferences by type id', async () => {
    const channels = await resolveEffectiveChannels(
      base({ type: undefined, preferences: prefs([['orders.created', 'email']]) }),
    )
    // no eligibility restriction, no nonOptOut → all channels except the opted-out email
    expect(channels).toEqual(['in_app', 'push'])
  })

  it('empty per-send target resolves to nothing deliverable', async () => {
    const channels = await resolveEffectiveChannels(base({ targetChannels: [] }))
    expect(channels).toEqual([])
  })
})
