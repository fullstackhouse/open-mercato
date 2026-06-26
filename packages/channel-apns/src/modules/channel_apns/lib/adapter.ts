import { createHash } from 'node:crypto'
import type {
  SendMessageInput,
  SendMessageResult,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'
import {
  BasePushChannelAdapter,
  deviceUnregisteredResult,
  MISSING_PUSH_TOKEN_RESULT,
  readPushToken,
} from '@open-mercato/core/modules/communication_channels/lib/push-adapter'
import { readPushEnvelope, resolvePushBody, type PushEnvelope } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import {
  apnsCredentialsSchema,
  resolveApnsCredentials,
  type ApnsResolvedCredentials,
} from './credentials'

/**
 * APNs rejection reasons that mean the device token is permanently invalid.
 * Mapped to the uniform `device_unregistered` sentinel so the push worker
 * soft-deletes the device (identical contract across fcm/apns/expo).
 */
const PERMANENT_APNS_REASONS = new Set(['Unregistered', 'BadDeviceToken'])

export interface ApnsSendOutcome {
  ok: boolean
  /** Provider rejection reason (e.g. `Unregistered`, `BadDeviceToken`). */
  reason?: string
  /** Transport-level error message (network/auth), distinct from a provider rejection. */
  error?: string
}

/**
 * A bound APNs sender for one tenant's credentials. The seam keeps `@parse/node-apn`
 * (and its HTTP/2 provider) entirely out of the adapter's control flow and tests.
 */
export type ApnsSender = (payload: PushEnvelope & { topic: string }, token: string) => Promise<ApnsSendOutcome>

export type ApnsSenderFactory = (credentials: ApnsResolvedCredentials) => ApnsSender

let senderFactory: ApnsSenderFactory | null = null

/** Test-only seam to swap the APNs sender factory. */
export function setApnsSenderFactory(factory: ApnsSenderFactory | null): void {
  senderFactory = factory
}

type ApnsProviderLike = {
  send(notification: unknown, token: string): Promise<{
    sent?: Array<{ device: string }>
    failed?: Array<{ device: string; status?: string | number; error?: Error; response?: { reason?: string } }>
  }>
}

function credentialsHash(credentials: ApnsResolvedCredentials): string {
  return createHash('sha256')
    .update(`${credentials.keyId}:${credentials.teamId}:${credentials.bundleId}:${credentials.production}:${credentials.p8Key}`)
    .digest('hex')
    .slice(0, 16)
}

const providerCache = new Map<string, Promise<ApnsProviderLike>>()

async function getProvider(credentials: ApnsResolvedCredentials): Promise<ApnsProviderLike> {
  const key = credentialsHash(credentials)
  let pending = providerCache.get(key)
  if (!pending) {
    pending = (async () => {
      const apnModule = await import('@parse/node-apn')
      const apn = (apnModule as { default?: unknown }).default ?? apnModule
      const Provider = (apn as { Provider: new (options: unknown) => ApnsProviderLike }).Provider
      return new Provider({
        token: { key: credentials.p8Key, keyId: credentials.keyId, teamId: credentials.teamId },
        production: credentials.production,
      })
    })()
    providerCache.set(key, pending)
  }
  return pending
}

/**
 * Populate an APNs `Notification` from the push envelope, branching on `silent` (background
 * content-available wake-up — no alert/sound) and applying the recognized push options. Mutates and
 * returns `note`. Extracted from the sender so it is unit-testable without `@parse/node-apn`.
 */
export function buildApnsNotification(
  note: Record<string, unknown>,
  payload: PushEnvelope & { topic: string },
): Record<string, unknown> {
  const { options, silent } = payload
  note.topic = payload.topic
  note.payload = payload.data
  if (silent) {
    note.contentAvailable = 1
    note.pushType = 'background'
    note.priority = 5
  } else {
    note.alert = { title: payload.title, body: resolvePushBody(payload) }
    note.sound = options.sound ?? 'default'
    if (typeof options.badge === 'number') note.badge = options.badge
    if (options.priority === 'normal') note.priority = 5
  }
  return note
}

function defaultSenderFactory(credentials: ApnsResolvedCredentials): ApnsSender {
  return async (payload, token) => {
    const apnModule = await import('@parse/node-apn')
    const apn = (apnModule as { default?: unknown }).default ?? apnModule
    const Notification = (apn as { Notification: new () => Record<string, unknown> }).Notification
    const note = buildApnsNotification(new Notification(), payload)

    const provider = await getProvider(credentials)
    const result = await provider.send(note, token)
    if (result.sent && result.sent.length > 0) return { ok: true }
    const failure = result.failed?.[0]
    if (!failure) return { ok: false, error: 'no_response' }
    if (failure.error) return { ok: false, error: failure.error.message }
    const reason = failure.response?.reason ?? (failure.status != null ? String(failure.status) : undefined)
    return { ok: false, reason }
  }
}

class ApnsChannelAdapter extends BasePushChannelAdapter {
  readonly providerKey = 'apns'
  protected readonly credentialsSchema = apnsCredentialsSchema

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const token = readPushToken(input)
    if (!token) return MISSING_PUSH_TOKEN_RESULT

    const parsedCredentials = apnsCredentialsSchema.safeParse(input.credentials)
    if (!parsedCredentials.success) {
      return { externalMessageId: '', status: 'failed', error: 'invalid_apns_credentials' }
    }

    const credentials = resolveApnsCredentials(parsedCredentials.data)
    const envelope = readPushEnvelope(input.content)
    const sender = (senderFactory ?? defaultSenderFactory)(credentials)

    try {
      const outcome = await sender({ ...envelope, topic: credentials.bundleId }, token)
      if (outcome.ok) {
        return { externalMessageId: token.slice(-12), status: 'sent' }
      }
      if (outcome.reason && PERMANENT_APNS_REASONS.has(outcome.reason)) {
        return deviceUnregisteredResult({ reason: outcome.reason })
      }
      return { externalMessageId: '', status: 'failed', error: outcome.error ?? outcome.reason ?? 'apns_send_failed' }
    } catch (err) {
      return { externalMessageId: '', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

let cachedAdapter: ApnsChannelAdapter | null = null

export function getApnsChannelAdapter(): ApnsChannelAdapter {
  if (!cachedAdapter) cachedAdapter = new ApnsChannelAdapter()
  return cachedAdapter
}
