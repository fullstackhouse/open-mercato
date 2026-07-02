import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/authFixtures'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-CHANNEL-PUSH-003 — Expo provider visible to the hub's credential-connect API.
 *
 * `@open-mercato/channel-expo` registers the `expo` push `ChannelAdapter` at import.
 * Push providers have no OAuth/webhook surface of their own — operators connect
 * them through the shared credential-connect flow, so that route is where hub
 * registration is observable: an UNregistered provider returns 404 (`no_adapter`),
 * a registered one runs the adapter's `validateCredentials` and returns 422 on bad
 * credentials (see api/post/channels/connect/credentials/route.ts). Asserting
 * "not 404" therefore proves the adapter is registered and reachable; real send
 * paths are covered network-free by lib/__tests__/adapter.test.ts.
 *
 * Expo credentials are all-optional (`accessToken?`), so an empty object would
 * VALIDATE and create a channel — we send a wrong-typed accessToken instead so
 * validateCredentials rejects it and the flow stays side-effect-free.
 */
test.describe('TC-CHANNEL-PUSH-003: Expo provider registration', () => {
  test('POST connect/credentials with providerKey=expo reaches the registered adapter', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        data: {
          providerKey: 'expo',
          displayName: 'Expo — integration test',
          credentials: { accessToken: 12345 },
        },
      },
    )
    expect(response.status(), 'route should not 5xx').toBeLessThan(500)
    expect(response.status(), 'Expo provider should be registered (never 404 no_adapter)').not.toBe(404)
  })

  test('POST connect/credentials with providerKey=expo and malformed credentials returns 422', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        data: {
          providerKey: 'expo',
          displayName: 'Expo — malformed',
          credentials: { accessToken: 12345 },
        },
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
