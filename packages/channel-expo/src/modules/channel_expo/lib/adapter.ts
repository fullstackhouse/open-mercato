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
import { readPushEnvelope } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import { expoCredentialsSchema, type ExpoCredentials } from './credentials'

export interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

export interface ExpoPushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, string>
  sound?: string
}

/**
 * Seam over `expo-server-sdk` so the SDK (and its network client) stays out of
 * the adapter control flow and unit tests.
 */
export interface ExpoClientLike {
  isExpoPushToken(token: string): boolean | Promise<boolean>
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>
}

type ExpoModule = {
  Expo: {
    isExpoPushToken(token: string): boolean
    new (options: { accessToken?: string }): {
      sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>
    }
  }
}

export type ExpoClientFactory = (credentials: ExpoCredentials) => ExpoClientLike

let clientFactory: ExpoClientFactory | null = null

/** Test-only seam to swap the Expo client factory. */
export function setExpoClientFactory(factory: ExpoClientFactory | null): void {
  clientFactory = factory
}

type ExpoInstance = InstanceType<ExpoModule['Expo']>

const expoInstanceCache = new Map<string, Promise<ExpoInstance>>()

let expoModulePromise: Promise<ExpoModule> | null = null

function loadExpoModule(): Promise<ExpoModule> {
  if (!expoModulePromise) {
    expoModulePromise = import('expo-server-sdk').then((mod) => {
      const candidate = mod as unknown as { default?: ExpoModule } & ExpoModule
      return candidate.default ?? candidate
    })
  }
  return expoModulePromise
}

function getExpoInstance(accessToken: string | undefined): Promise<ExpoInstance> {
  const cacheKey = accessToken ?? ''
  let instance = expoInstanceCache.get(cacheKey)
  if (!instance) {
    instance = loadExpoModule().then(({ Expo }) => new Expo({ accessToken }))
    expoInstanceCache.set(cacheKey, instance)
  }
  return instance
}

function defaultClientFactory(credentials: ExpoCredentials): ExpoClientLike {
  return {
    async isExpoPushToken(token: string): Promise<boolean> {
      const { Expo } = await loadExpoModule()
      return Expo.isExpoPushToken(token)
    },
    async send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      const expo = await getExpoInstance(credentials.accessToken)
      return expo.sendPushNotificationsAsync(messages)
    },
  }
}

class ExpoChannelAdapter extends BasePushChannelAdapter {
  readonly providerKey = 'expo'
  protected readonly credentialsSchema = expoCredentialsSchema

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const token = readPushToken(input)
    if (!token) return MISSING_PUSH_TOKEN_RESULT

    const parsedCredentials = expoCredentialsSchema.safeParse(input.credentials)
    if (!parsedCredentials.success) {
      return { externalMessageId: '', status: 'failed', error: 'invalid_expo_credentials' }
    }

    const client = (clientFactory ?? defaultClientFactory)(parsedCredentials.data)

    // A malformed Expo token can never deliver — treat it as unregistered so the
    // worker soft-deletes the device (uniform sentinel across providers).
    if (!(await client.isExpoPushToken(token))) {
      return deviceUnregisteredResult({ reason: 'invalid_expo_push_token' })
    }

    const envelope = readPushEnvelope(input.content)

    try {
      const tickets = await client.send([
        { to: token, title: envelope.title, body: envelope.body, data: envelope.data, sound: 'default' },
      ])
      const ticket = tickets[0]
      if (!ticket) return { externalMessageId: '', status: 'failed', error: 'no_response' }
      if (ticket.status === 'ok') {
        return { externalMessageId: ticket.id ?? '', status: 'sent' }
      }
      // LIMITATION: Expo delivery is two-phase. A `status: 'ok'` ticket only means Expo *accepted*
      // the message — it does NOT confirm the token is valid. `DeviceNotRegistered` for a
      // well-formed-but-stale token (the common "app uninstalled" case) surfaces later in the
      // RECEIPT phase via `getPushNotificationReceiptsAsync` (receipt `details.error`), which this
      // adapter does not yet poll. So this ticket-level check only catches the narrow cases Expo
      // rejects synchronously; full unregistered-cleanup for Expo needs receipt polling, tracked as
      // a Phase 6 hygiene follow-up (see spec § Deferred to a later spec).
      if (ticket.details?.error === 'DeviceNotRegistered') {
        return deviceUnregisteredResult({ reason: 'DeviceNotRegistered' })
      }
      return { externalMessageId: '', status: 'failed', error: ticket.message ?? 'expo_send_failed' }
    } catch (err) {
      return { externalMessageId: '', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

let cachedAdapter: ExpoChannelAdapter | null = null

export function getExpoChannelAdapter(): ExpoChannelAdapter {
  if (!cachedAdapter) cachedAdapter = new ExpoChannelAdapter()
  return cachedAdapter
}
