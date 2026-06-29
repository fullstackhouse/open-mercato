# Devices & Push Notifications — Getting Started

A friendly guide for someone who has never touched these modules. It explains *what they are*,
*how the pieces fit together*, and *how to send your first push notification to a phone*.

---

## 1. The 30-second mental model

You want a message to pop up on a user's phone. Four small modules cooperate to make that happen:

| Module | One-line job | Think of it as… |
|--------|--------------|-----------------|
| **`devices`** | Remembers each user's phones/tablets and their push tokens | The **address book** of devices |
| **`notifications`** | Defines notification *types*, stores in-app messages, and tracks per-user opt-out preferences | The **content + rules** |
| **`push_notifications`** | Takes a notification and actually delivers it to devices (queue, retries, delivery log) | The **mail carrier** |
| **`communication_channels`** (+ `channel-fcm` / `channel-apns` / `channel-expo`) | Talks to Apple / Google / Expo using your credentials | The **post office** for each platform |

Flow in one sentence:

> Your app **registers a device** → later your backend **creates a notification** →
> the push module **looks up the user's devices** → and **hands each one to FCM/APNs/Expo**.

```
[Mobile app]                 [Your backend]
     |                             |
  register device           create notification
     |                             |
     v                             v
  devices module  <----------  push_notifications  ---->  communication_channels
  (token stored)              (find devices, queue)        (FCM / APNs / Expo)
                                                                   |
                                                                   v
                                                            📱 push lands
```

---

## 2. The `devices` module — the address book

### What it stores
One row per user device (a `UserDevice`). Important fields:

- `userId`, `platform` (`ios` | `android` | `web`)
- `deviceId` — a stable id the app generates (e.g. iOS `identifierForVendor`, Android ID, or a UUID for web)
- `pushToken` — the token from Apple/Google/Expo. **Encrypted at rest, never returned by any API.**
- `pushProvider` — `fcm` | `apns` | `expo`
- app/OS version metadata, `lastSeenAt`

### Registering a device (what the mobile app calls)
```http
POST /api/devices
Authorization: Bearer <user-token>

{
  "deviceId": "A1B2-C3D4",
  "platform": "ios",
  "pushToken": "<token from APNs/FCM/Expo>",
  "pushProvider": "apns",
  "clientAppVersion": "1.2.3",
  "osVersion": "17.5"
}
```
- It's **idempotent**: calling it again with the same `(user, deviceId)` just updates the row.
- If the device was previously deleted, registering "revives" it.
- Call it again (`PUT /api/devices/:id`) whenever the push token rotates.

### Other endpoints
- `GET /api/devices` — list **your own** devices
- `DELETE /api/devices/:id` — deactivate (soft-delete) your own device
- `/api/devices/admin/devices...` — admin endpoints to manage devices **across users**

### Permissions (ACL)
- `devices.view` — see your own devices
- `devices.manage` — register/update/delete your own
- `devices.admin` — manage everyone's devices in the tenant

---

## 3. The `notifications` module — content + rules

### Notification *types*
Every notification has a **type** (a frozen id like `sales.order.created`). A module declares its
types in a `notifications.ts` file. A type carries:

- `titleKey` / `bodyKey` — i18n keys for the text
- `category` — grouping for UI (e.g. `orders`, `security`)
- `silent` — if `true`, it's a **background wake-up** (no visible message, no preference check)
- `nonOptOut` — if `true`, the user **cannot turn it off** (e.g. security alerts)

### User preferences (opt-out)
Users can disable a type per channel (in-app, push, …):
- `GET /api/notifications/preferences` / `PUT /api/notifications/preferences`
- `silent` and `nonOptOut` types ignore preferences — they always go through.

### Creating a notification (this is what triggers a push)
```http
POST /api/notifications

{
  "recipientUserId": "<uuid>",
  "type": "sales.order.created",
  "titleKey": "notifications.sales.order_created.title",
  "bodyKey": "notifications.sales.order_created.body",
  "bodyVariables": { "orderNumber": "12345" },
  "linkHref": "/backend/sales/orders/<uuid>",
  "data": { "orderId": "<uuid>" },          // custom fields delivered inside the push
  "pushOptions": { "sound": "default", "badge": 1 }
}
```
Bulk variants exist too: `/api/notifications/batch`, `/role`, `/feature`.

From code (the common, event-driven way), resolve the service via DI:
```ts
const notificationService = ctx.resolve('notificationService')
await notificationService.create(input, { tenantId, organizationId })
```

---

## 4. The `push_notifications` module — the mail carrier

You usually **don't call this directly**. When a notification is created, a *delivery strategy*
runs automatically and:

1. Checks the user's preferences (unless the type is `silent`/`nonOptOut`).
2. Loads the recipient's devices that have a push token.
3. Writes a `PushNotificationDelivery` row (status `pending`) per device.
4. Enqueues a background job.
5. A worker resolves the right adapter (FCM/APNs/Expo), sends, and on failure **retries with backoff**.
   If a token is permanently invalid, the device is auto-deactivated.

Observability for admins:
- `GET /api/push_notifications/deliveries` — the delivery log (status, attempts, errors).
- Tokens are never shown — only the last 8 characters for debugging.

### Silent / background push
For data-only wake-ups (no banner), declare the type with `silent: true` and send via:
```ts
const pushService = ctx.resolve('pushNotificationService')
await pushService.sendSilentPush({
  resolve: ctx.resolve, tenantId, userId,
  type: 'system.security.new_login',   // must be registered with silent: true
  data: { ipAddress: '203.0.113.42' },
})
```

---

## 5. One-time setup: connect a push provider

Push tokens are useless without credentials. Credentials live **per tenant** in the admin UI
(no env vars): **Settings → Module Configs → Communication Channels → Connect**.

| Provider | What you paste | Where to get it |
|----------|----------------|-----------------|
| **Firebase (FCM)** — Android | Service-account JSON | Firebase Console → Project settings → Service accounts → Generate key |
| **Apple (APNs)** — iOS | `.p8` key + Key ID + Team ID + Bundle ID + production flag | Apple Developer → Keys → APNs key |
| **Expo** | (optional) access token | expo.dev → Account → Tokens |

---

## 6. End-to-end checklist for your first push

1. **Connect a provider** (FCM/APNs/Expo) in Communication Channels.
2. **Register a device** from the mobile app: `POST /api/devices` with `pushToken` + `pushProvider`.
3. **Make sure a notification type exists** (e.g. `sales.order.created`) and the user hasn't opted out.
4. **Create a notification**: `POST /api/notifications` with `recipientUserId` + `type`.
5. **Watch it land** and verify in the delivery log: `GET /api/push_notifications/deliveries`.

---

## 7. Good-to-know rules

- **Tokens are secret**: encrypted at rest, never returned by any API, redacted in logs.
- **Everything is tenant-scoped** — a tenant only ever sees its own devices and deliveries.
- **Modules are decoupled** — they talk via events and DI, not direct ORM relationships.
- **Resilient delivery** — retries with backoff; dead tokens auto-remove the device.
- **Status**: device registry, notification types/preferences, push delivery, and FCM/APNs/Expo
  adapters are implemented. Pending (Phase 6): a delivery-log purge worker, web push, more providers.
