# `@open-mercato/channel-apns` — Agent Guidelines

Apple Push Notification service provider for the Communications Hub (`communication_channels`). Registers a `push` `ChannelAdapter` (providerKey `apns`) consumed by the `push_notifications` delivery strategy/worker.

- **Package**: `@open-mercato/channel-apns` ⇒ **module id**: `channel_apns`
- **Provider key**: `apns` · **channelType**: `push`
- Transport: `@parse/node-apn` (native HTTP/2, token-based `.p8` auth) — keep all APNs-specific logic here.

## Key Files (`src/modules/channel_apns/`)

| File | Purpose |
|------|---------|
| `integration.ts` | `IntegrationDefinition` (credentials fields, `healthCheck.service`) |
| `di.ts` / `setup.ts` | Register the adapter + `channelApnsHealthCheck`; `defaultRoleFeatures` |
| `acl.ts` | `channel_apns.view`, `channel_apns.configure` |
| `lib/adapter.ts` | `ApnsChannelAdapter`; `setApnsSenderFactory` test seam isolates `@parse/node-apn` |
| `lib/credentials.ts` | Zod schema: `{ p8Key, keyId, teamId, bundleId, production? }` |
| `lib/health.ts` | `channelApnsHealthCheck` liveness probe |

## Adapter Contract

Implements the shared push-adapter contract (see `channel-fcm` AGENTS.md). Permanent-token reasons mapped to the uniform `device_unregistered` sentinel: `Unregistered` (410), `BadDeviceToken` (400). One HTTP/2 `apn.Provider` is cached per credentials hash. The `ApnsSender` seam keeps the node-apn provider out of the control flow and out of unit tests.

## Credentials

Tenant-level credentials on `IntegrationCredentials` for provider `channel_apns`: `{ p8Key (PEM contents), keyId, teamId, bundleId (APNs topic), production }`. Connect via the existing `communication_channels` credentials-connect flow. Device tokens live in `devices.UserDevice.push_token`, never here.
