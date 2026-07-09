import {
  isPushFakeProvidersEnabled,
  recordFakePush,
} from '@open-mercato/core/modules/push_notifications/lib/fake-provider-recorder'
import { buildApnsNotification, setApnsSenderFactory } from './adapter'

/**
 * Network-free `@parse/node-apn` sender used ONLY by integration tests.
 *
 * Swaps the SDK client behind the adapter's existing seam, so the real adapter still runs its
 * credential resolution and its `Unregistered`/`BadDeviceToken` → `device_unregistered` mapping. The
 * adapter itself is never replaced or re-registered.
 *
 * Unlike FCM and Expo, the APNs seam sits *above* the message builder: the sender receives the raw
 * envelope, and `buildApnsNotification` runs inside the real sender factory this fake replaces. The
 * fake therefore calls the builder itself so the recorded message is the one production would send.
 * `.p8` parsing lives in that same replaced factory, so fake credentials need only a valid shape.
 *
 * Token sentinels match `push_stub`'s convention (see push-stub-adapter.ts):
 *   - token containing `unregistered` → APNs' native permanent-token reason
 *   - token containing `fail`         → a retryable error
 *   - otherwise                        → success
 *
 * Production safety: never installed at module import; no-op unless `OM_PUSH_FAKE_PROVIDERS` is set.
 */
export function ensureApnsFakeProviderInstalled(): void {
  if (!isPushFakeProvidersEnabled()) return
  setApnsSenderFactory(() => async (payload, token) => {
    recordFakePush('apns', token, buildApnsNotification({}, payload))
    if (token.includes('unregistered')) return { ok: false, reason: 'Unregistered' }
    if (token.includes('fail')) return { ok: false, error: 'fake apns transient failure' }
    return { ok: true }
  })
}
