import type { PushEnvelope } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import { buildApnsNotification } from '../adapter'

/**
 * Golden assertions pinning the APNs notification we build against Apple's published reference.
 *
 * These are the only tests that catch serialization drift in *our* builder: the integration fakes
 * replace the SDK client, so nothing else ever validates the notification body. Drift in *Apple's*
 * schema is out of reach of any fake and stays a manual live-key check.
 *
 * Field names are `@parse/node-apn`'s (`contentAvailable`, `pushType`), which the SDK serializes to
 * the wire `aps.content-available` / `apns-push-type` header.
 *
 * Reference (aps payload): https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
 * Reference (background push requires apns-push-type: background + apns-priority: 5):
 *   https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
 *
 * Written as exact `toEqual` fixtures rather than snapshots: a snapshot would re-record drift on
 * `--updateSnapshot` instead of failing.
 */
const TOPIC = 'com.example.app'

function payload(overrides: Partial<PushEnvelope> = {}): PushEnvelope & { topic: string } {
  return {
    topic: TOPIC,
    title: 'Order shipped',
    body: 'Your order #42 is on its way',
    data: { type: 'orders.shipped', notificationId: 'n1' },
    options: {},
    silent: false,
    ...overrides,
  }
}

describe('buildApnsNotification — golden payloads', () => {
  it('visible notification matches the reference shape', () => {
    expect(buildApnsNotification({}, payload())).toEqual({
      topic: TOPIC,
      payload: { type: 'orders.shipped', notificationId: 'n1' },
      alert: { title: 'Order shipped', body: 'Your order #42 is on its way' },
      sound: 'default',
    })
  })

  it('silent notification is a content-available background push at priority 5', () => {
    expect(buildApnsNotification({}, payload({ silent: true }))).toEqual({
      topic: TOPIC,
      payload: { type: 'orders.shipped', notificationId: 'n1' },
      contentAvailable: 1,
      pushType: 'background',
      priority: 5,
    })
  })

  it('full pushOptions map onto the aps payload', () => {
    expect(
      buildApnsNotification(
        {},
        payload({
          options: {
            sound: 'chime.caf',
            badge: 7,
            priority: 'normal',
            body: 'Overridden push body',
          },
        }),
      ),
    ).toEqual({
      topic: TOPIC,
      payload: { type: 'orders.shipped', notificationId: 'n1' },
      alert: { title: 'Order shipped', body: 'Overridden push body' },
      sound: 'chime.caf',
      badge: 7,
      priority: 5,
    })
  })
})
