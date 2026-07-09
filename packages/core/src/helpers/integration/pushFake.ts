import path from 'node:path'
import { expect, type APIRequestContext } from '@playwright/test'
import {
  findFakePush,
  type FakePushEntry,
  type FakePushProvider,
} from '../../modules/push_notifications/lib/fake-provider-recorder'
import { apiRequest } from './api'
import { readJsonSafe } from './generalFixtures'
import { withClient } from './dbFixtures'

/**
 * Harness for the `OM_PUSH_FAKE_PROVIDERS` integration specs (TC-PUSH-004+, TC-CHANNEL-PUSH-005+).
 *
 * The fake replaces each provider's SDK client, so the REAL adapter runs and records the
 * provider-native message it built. The worker does that in a different process than the spec, so the
 * message travels through a JSONL sink under the queue's own base dir rather than the delivery row —
 * no adapter returns `metadata` on success, and APNs deliberately reports an empty `externalMessageId`.
 */
const TEST_APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
const APP_ROOT = TEST_APP_ROOT ? path.resolve(TEST_APP_ROOT) : path.resolve(process.cwd(), 'apps/mercato')

// Match the queue base dir the drain child uses, so the spec reads the file the worker wrote.
if (!TEST_APP_ROOT && !process.env.QUEUE_BASE_DIR?.trim()) {
  process.env.QUEUE_BASE_DIR = path.resolve(APP_ROOT, '.mercato/queue')
}

export const TENANT_CONNECT_PATH = '/api/communication_channels/channels/connect/tenant-credentials'
export const DEVICES_PATH = '/api/devices'
export const NOTIFICATIONS_PATH = '/api/notifications'

export type PushDeliveryRow = {
  status: string
  token_snapshot: string
  organization_id: string | null
  provider: string
  attempts: number
  silent: boolean
  sent_at: string | null
  last_error: string | null
  provider_response: Record<string, unknown> | null
}

/** Valid-*shaped* fake credentials. `validateCredentials` is schema-only; real parsing lives in the faked SDK client. */
export const FAKE_PUSH_CREDENTIALS: Record<FakePushProvider, Record<string, unknown>> = {
  fcm: {
    serviceAccountJson: JSON.stringify({
      project_id: 'om-fake-project',
      client_email: 'fake@om-fake-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nom-fake-key\n-----END PRIVATE KEY-----\n',
    }),
  },
  apns: {
    p8Key: '-----BEGIN PRIVATE KEY-----\nom-fake-p8\n-----END PRIVATE KEY-----\n',
    keyId: 'FAKEKEYID1',
    teamId: 'FAKETEAMID',
    bundleId: 'com.openmercato.fake',
    production: false,
  },
  expo: {
    accessToken: 'om-fake-expo-token',
  },
}

/** Connect a tenant-wide push channel through the real credential-connect route. */
export async function connectFakePushChannel(
  request: APIRequestContext,
  token: string,
  provider: FakePushProvider,
  displayName: string,
): Promise<string> {
  const response = await apiRequest(request, 'POST', TENANT_CONNECT_PATH, {
    token,
    data: { providerKey: provider, displayName, credentials: FAKE_PUSH_CREDENTIALS[provider] },
  })
  expect(response.status(), `connect ${provider} channel`).toBe(201)
  const body = await readJsonSafe<{ channelId?: string }>(response)
  expect(body?.channelId).toBeTruthy()
  return body!.channelId as string
}

export async function deleteChannelIfExists(channelId: string | null): Promise<void> {
  if (!channelId) return
  await withClient(async (client) => {
    await client.query('delete from communication_channels where id = $1', [channelId])
  }).catch(() => undefined)
}

/**
 * Register a device routed to `provider`. The token tail keys both the delivery row's
 * `token_snapshot` and the recorded native message, isolating concurrent specs.
 */
export async function registerFakePushDevice(
  request: APIRequestContext,
  token: string,
  provider: FakePushProvider,
  pushToken: string,
  deviceId: string,
): Promise<string> {
  const response = await apiRequest(request, 'POST', DEVICES_PATH, {
    token,
    data: { deviceId, platform: provider === 'apns' ? 'ios' : 'android', pushToken, pushProvider: provider },
  })
  expect(response.status(), `register ${provider} device`).toBe(201)
  const body = await readJsonSafe<{ id?: string }>(response)
  expect(body?.id).toBeTruthy()
  return body!.id as string
}

export async function deleteDeliveriesForDevice(userDeviceId: string | null): Promise<void> {
  if (!userDeviceId) return
  await withClient(async (client) => {
    await client.query('delete from push_notification_deliveries where user_device_id = $1', [userDeviceId])
  }).catch(() => undefined)
}

export async function readLatestDelivery(tenantId: string, userDeviceId: string): Promise<PushDeliveryRow | null> {
  return withClient(async (client) => {
    const res = await client.query(
      `select status, token_snapshot, organization_id, provider, attempts, silent, sent_at, last_error, provider_response
         from push_notification_deliveries
        where tenant_id = $1 and user_device_id = $2
        order by created_at desc
        limit 1`,
      [tenantId, userDeviceId],
    )
    return (res.rows[0] as PushDeliveryRow | undefined) ?? null
  })
}

/** True once the device has been soft-deleted (the `device_unregistered` contract). */
export async function isDeviceSoftDeleted(userDeviceId: string): Promise<boolean> {
  return withClient(async (client) => {
    const res = await client.query('select deleted_at from user_devices where id = $1', [userDeviceId])
    if (res.rows.length === 0) return true
    return res.rows[0].deleted_at != null
  })
}

/** The provider-native message the REAL adapter handed the faked SDK client. */
export function readNativeMessage(provider: FakePushProvider, tokenTail: string): FakePushEntry | undefined {
  return findFakePush(provider, tokenTail)
}

export async function expectNativeMessage(
  provider: FakePushProvider,
  tokenTail: string,
): Promise<Record<string, unknown>> {
  await expect
    .poll(() => readNativeMessage(provider, tokenTail)?.native ?? null, { timeout: 30_000 })
    .not.toBeNull()
  return readNativeMessage(provider, tokenTail)!.native
}
