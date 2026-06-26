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
import { readPushEnvelope } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import {
  fcmCredentialsSchema,
  parseFcmServiceAccount,
  type FcmServiceAccount,
} from './credentials'

/**
 * FCM error codes that mean the device token is permanently invalid. Mapped to
 * the uniform `device_unregistered` sentinel so the push worker soft-deletes the
 * device (identical contract across fcm/apns/expo — see push-stub-adapter).
 */
const PERMANENT_FCM_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
])

type FirebaseMessaging = {
  send(message: Record<string, unknown>): Promise<string>
}

/**
 * Pluggable messaging factory so tests can inject a fake without importing
 * firebase-admin. Production path lazily loads firebase-admin and caches one app
 * per service-account hash (re-initializing per send is wasteful and
 * firebase-admin throws on duplicate app names).
 */
export type FcmMessagingFactory = (serviceAccount: FcmServiceAccount) => FirebaseMessaging

let messagingFactory: FcmMessagingFactory | null = null

/** Test-only seam to swap the firebase-admin messaging factory. */
export function setFcmMessagingFactory(factory: FcmMessagingFactory | null): void {
  messagingFactory = factory
}

function appNameForServiceAccount(serviceAccount: FcmServiceAccount): string {
  const hash = createHash('sha256')
    .update(`${serviceAccount.projectId}:${serviceAccount.clientEmail}:${serviceAccount.privateKey}`)
    .digest('hex')
    .slice(0, 16)
  return `om-fcm-${hash}`
}

async function defaultMessagingFactory(serviceAccount: FcmServiceAccount): Promise<FirebaseMessaging> {
  const { initializeApp, getApps, cert } = await import('firebase-admin/app')
  const { getMessaging } = await import('firebase-admin/messaging')
  const appName = appNameForServiceAccount(serviceAccount)
  const existing = getApps().find((app) => app?.name === appName)
  const app =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: serviceAccount.projectId,
          clientEmail: serviceAccount.clientEmail,
          privateKey: serviceAccount.privateKey,
        }),
      },
      appName,
    )
  return getMessaging(app) as unknown as FirebaseMessaging
}

async function resolveMessaging(serviceAccount: FcmServiceAccount): Promise<FirebaseMessaging> {
  if (messagingFactory) return messagingFactory(serviceAccount)
  return defaultMessagingFactory(serviceAccount)
}

class FcmChannelAdapter extends BasePushChannelAdapter {
  readonly providerKey = 'fcm'
  protected readonly credentialsSchema = fcmCredentialsSchema

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const token = readPushToken(input)
    if (!token) return MISSING_PUSH_TOKEN_RESULT

    const parsedCredentials = fcmCredentialsSchema.safeParse(input.credentials)
    if (!parsedCredentials.success) {
      return { externalMessageId: '', status: 'failed', error: 'invalid_fcm_credentials' }
    }

    const envelope = readPushEnvelope(input.content)
    let messaging: FirebaseMessaging
    try {
      messaging = await resolveMessaging(parseFcmServiceAccount(parsedCredentials.data))
    } catch {
      return { externalMessageId: '', status: 'failed', error: 'invalid_fcm_credentials' }
    }

    try {
      const externalMessageId = await messaging.send({
        token,
        notification: { title: envelope.title, body: envelope.body },
        data: envelope.data,
        android: { notification: { sound: 'default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      })
      return { externalMessageId, status: 'sent' }
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
      const message = err instanceof Error ? err.message : String(err)
      if (code && PERMANENT_FCM_ERROR_CODES.has(code)) {
        return deviceUnregisteredResult({ code })
      }
      return { externalMessageId: '', status: 'failed', error: message }
    }
  }
}

let cachedAdapter: FcmChannelAdapter | null = null

export function getFcmChannelAdapter(): FcmChannelAdapter {
  if (!cachedAdapter) cachedAdapter = new FcmChannelAdapter()
  return cachedAdapter
}
