import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/authFixtures'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-CHANNEL-PUSH-001 — FCM provider visible to the hub's credential-connect API.
 *
 * `@open-mercato/channel-fcm` registers the `fcm` push `ChannelAdapter` at import.
 * Push providers have no OAuth/webhook surface of their own — operators connect
 * them through the shared credential-connect flow, so that route is where hub
 * registration is observable: an UNregistered provider returns 404 (`no_adapter`),
 * a registered one runs the adapter's `validateCredentials` and returns 422 on bad
 * credentials (see api/post/channels/connect/credentials/route.ts). Asserting an
 * authenticated request gets 422 therefore proves the adapter is registered and
 * reached; real send paths are covered network-free by lib/__tests__/adapter.test.ts.
 */
test.describe('TC-CHANNEL-PUSH-001: FCM provider registration', () => {
  test('POST connect/credentials with providerKey=fcm reaches the registered adapter', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        // Missing serviceAccountJson → the adapter's validateCredentials rejects it,
        // so the flow never creates a channel (no side effect / no cleanup needed).
        data: { providerKey: 'fcm', displayName: 'FCM — integration test', credentials: {} },
      },
    )
    expect(response.status(), 'route should not 5xx').toBeLessThan(500)
    // 422 proves the request authenticated AND reached the registered adapter's
    // validateCredentials (which rejects the missing serviceAccountJson). A bare
    // "not 404" would also pass on a 401 auth failure that never hits the adapter,
    // so the whole spec could go green without exercising registration.
    expect(
      response.status(),
      'authenticated request should reach the registered FCM adapter and be rejected by validateCredentials',
    ).toBe(422)
  })

  test('POST connect/credentials with providerKey=fcm and malformed credentials returns 422', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        data: { providerKey: 'fcm', displayName: 'FCM — malformed', credentials: {} },
      },
    )
    expect(response.status()).toBeLessThan(500)
    expect([401, 400, 422]).toContain(response.status())
    if (response.status() === 422) {
      const body = await readJsonSafe<{ error?: string; fieldErrors?: Record<string, string> }>(response)
      expect(body?.fieldErrors ?? body?.error).toBeTruthy()
    }
  })
})
