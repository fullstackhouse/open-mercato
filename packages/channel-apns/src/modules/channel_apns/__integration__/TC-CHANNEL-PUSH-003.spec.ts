import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/authFixtures'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-CHANNEL-PUSH-003 — APNs provider visible to the hub's credential-connect API.
 *
 * `@open-mercato/channel-apns` registers the `apns` push `ChannelAdapter` at import.
 * Push providers have no OAuth/webhook surface of their own — operators connect
 * them through the shared credential-connect flow, so that route is where hub
 * registration is observable: an UNregistered provider returns 404 (`no_adapter`),
 * a registered one runs the adapter's `validateCredentials` and returns 422 on bad
 * credentials (see api/post/channels/connect/credentials/route.ts). Asserting
 * "not 404" therefore proves the adapter is registered and reachable; real send
 * paths are covered network-free by lib/__tests__/adapter.test.ts.
 */
test.describe('TC-CHANNEL-PUSH-003: APNs provider registration', () => {
  test('POST connect/credentials with providerKey=apns reaches the registered adapter', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        // Missing p8Key/keyId/teamId/bundleId → validateCredentials rejects it, so the
        // flow never creates a channel (no side effect / no cleanup needed).
        data: { providerKey: 'apns', displayName: 'APNs — integration test', credentials: {} },
      },
    )
    expect(response.status(), 'route should not 5xx').toBeLessThan(500)
    // A registered adapter runs validateCredentials on the empty payload and returns 422.
    // Asserting 422 (not merely "not 404") proves the request authenticated AND reached
    // the adapter — a 401 auth misconfig would otherwise let the spec pass vacuously.
    expect(response.status(), 'authenticated request should not 401').not.toBe(401)
    expect(response.status(), 'registered adapter should reject empty credentials with 422').toBe(422)
  })

  test('POST connect/credentials with providerKey=apns and malformed credentials returns 422', async ({ request }) => {
    const token = await getAuthToken(request)
    const response = await apiRequest(
      request,
      'POST',
      '/api/communication_channels/channels/connect/credentials',
      {
        token,
        data: { providerKey: 'apns', displayName: 'APNs — malformed', credentials: {} },
      },
    )
    expect(response.status()).toBeLessThan(500)
    // Require the happy path: authenticated (not 401) and rejected by validateCredentials
    // with 422, so an auth misconfig can't turn this into a false green.
    expect(response.status(), 'authenticated request should not 401').not.toBe(401)
    expect(response.status(), 'malformed credentials should be rejected with 422').toBe(422)
    const body = await readJsonSafe<{ error?: string; fieldErrors?: Record<string, string> }>(response)
    expect(body?.fieldErrors ?? body?.error).toBeTruthy()
  })
})
