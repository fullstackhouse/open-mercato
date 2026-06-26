/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'

const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  // Pass through: the page wraps the PUT operation with scoped headers.
  withScopedApiRequestHeaders: (_headers: unknown, fn: () => unknown) => fn(),
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  // Execute the wrapped operation directly so the save reaches apiCall.
  useGuardedMutation: () => ({
    runMutation: ({ operation }: { operation: () => unknown }) => operation(),
    retryLastMutation: jest.fn(),
  }),
}))

jest.mock('@open-mercato/ui/backend/injection/InjectionSpot', () => ({
  // Keep the real injection hooks CrudForm depends on; only neutralise the
  // detail-page injection surface so no external widgets render.
  ...jest.requireActual('@open-mercato/ui/backend/injection/InjectionSpot'),
  InjectionSpot: () => null,
  useInjectionWidgets: () => ({ widgets: [] }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/data_sync/components/IntegrationScheduleTab', () => ({
  IntegrationScheduleTab: () => null,
}))

jest.mock('next/navigation', () => ({
  usePathname: () => '/backend/integrations/example_db',
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

import IntegrationDetailPage from '../page'

const SECRET_PLACEHOLDER = /Saved — type to replace/i

const detailFixture = {
  integration: {
    id: 'example_db',
    title: 'Example DB',
    credentials: {
      fields: [
        { key: 'host', label: 'Host', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'secret', required: true },
      ],
    },
  },
  state: {
    isEnabled: true,
    apiVersion: null,
    reauthRequired: false,
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    lastHealthLatencyMs: null,
    enabledAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  hasCredentials: true,
  credentialsUpdatedAt: '2026-01-01T00:00:00.000Z',
  healthStatus: 'unconfigured' as const,
  analytics: { lastActivityAt: null, totalCount: 0, errorCount: 0, errorRate: 0, dailyCounts: [] },
}

// GET /credentials with the write-only contract: the secret value is never
// returned, only listed in `secretsSet`.
const credentialsResponse = {
  integrationId: 'example_db',
  schema: detailFixture.integration.credentials,
  credentials: { host: 'db.example.com' },
  secretsSet: ['password'],
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function mockApi() {
  apiCallMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/credentials')) {
      if (init?.method === 'PUT') return { ok: true, status: 200, result: { ok: true } }
      return { ok: true, status: 200, result: credentialsResponse }
    }
    if (url.startsWith('/api/integrations/logs')) {
      return { ok: true, status: 200, result: { items: [] } }
    }
    if (url.startsWith('/api/integrations/example_db')) {
      return { ok: true, status: 200, result: detailFixture }
    }
    return { ok: false, status: 404, result: null }
  })
}

function lastCredentialsPut(): { credentials: Record<string, unknown> } | null {
  const calls = apiCallMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith('/credentials') && (init as { method?: string })?.method === 'PUT',
  )
  const last = calls.at(-1)
  if (!last) return null
  const body = (last[1] as { body?: string })?.body
  return body ? (JSON.parse(body) as { credentials: Record<string, unknown> }) : null
}

beforeEach(() => {
  apiCallMock.mockReset()
})

describe('IntegrationDetailPage — write-only secret credentials', () => {
  it('renders a set secret as empty with a "type to replace" hint and prefills non-secrets', async () => {
    mockApi()
    renderWithProviders(<IntegrationDetailPage params={{ id: 'example_db' }} />)

    // The non-secret field is prefilled from the GET response.
    const hostInput = await screen.findByDisplayValue('db.example.com')
    expect(hostInput).toBeTruthy()

    // The secret renders empty (value never read back) with the "set" hint.
    const secretInput = await screen.findByPlaceholderText(SECRET_PLACEHOLDER)
    expect((secretInput as HTMLInputElement).value).toBe('')
  })

  it('drops an untouched secret from the save so the stored value is preserved', async () => {
    mockApi()
    renderWithProviders(<IntegrationDetailPage params={{ id: 'example_db' }} />)

    await screen.findByPlaceholderText(SECRET_PLACEHOLDER)
    fireEvent.click(await screen.findByRole('button', { name: /save credentials/i }))

    await waitFor(() => expect(lastCredentialsPut()).not.toBeNull())
    const payload = lastCredentialsPut()!
    // A required-but-already-set secret does not block the save, and the blank
    // secret is not submitted (server preserves it); the host is sent.
    expect(payload.credentials).not.toHaveProperty('password')
    expect(payload.credentials.host).toBe('db.example.com')
  })

  it('submits a newly typed secret', async () => {
    mockApi()
    renderWithProviders(<IntegrationDetailPage params={{ id: 'example_db' }} />)

    const secretInput = await screen.findByPlaceholderText(SECRET_PLACEHOLDER)
    fireEvent.change(secretInput, { target: { value: 'new-password' } })
    fireEvent.click(await screen.findByRole('button', { name: /save credentials/i }))

    await waitFor(() => expect(lastCredentialsPut()).not.toBeNull())
    expect(lastCredentialsPut()!.credentials.password).toBe('new-password')
  })
})
