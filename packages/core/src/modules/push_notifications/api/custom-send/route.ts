import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  bridgeLegacyGuard,
  runMutationGuards,
  type MutationGuard,
  type MutationGuardInput,
} from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import type { AwilixContainer } from 'awilix'
import { customSendSchema, customSendResponseSchema } from '../../data/validators'
import type { PushNotificationService } from '../../lib/send-silent-push'

const RESOURCE_KIND = 'push_notifications.push_notification_delivery'

const errorResponseSchema = z.object({ error: z.string() })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['push_notifications.send_custom'] },
}

function resolveUserFeatures(auth: unknown): string[] {
  const features = (auth as { features?: unknown })?.features
  if (!Array.isArray(features)) return []
  return features.filter((value): value is string => typeof value === 'string')
}

async function runGuards(
  container: AwilixContainer,
  userFeatures: string[],
  input: MutationGuardInput,
): Promise<{
  ok: boolean
  errorBody?: Record<string, unknown>
  errorStatus?: number
  afterSuccessCallbacks: Array<{ guard: MutationGuard; metadata: Record<string, unknown> | null }>
}> {
  const legacyGuard = bridgeLegacyGuard(container)
  if (!legacyGuard) return { ok: true, afterSuccessCallbacks: [] }
  return runMutationGuards([legacyGuard], input, { userFeatures })
}

export async function POST(req: Request) {
  const { translate } = await resolveTranslations()
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId || !auth.sub) {
      return NextResponse.json(
        { error: translate('push_notifications.errors.unauthorized', 'Unauthorized') },
        { status: 401 },
      )
    }

    const body = customSendSchema.parse(await readJsonSafe(req, {}))
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = scope?.selectedId ?? auth.orgId ?? null

    // Custom write route → wire the mutation-guard registry (AGENTS → API Routes). The send creates
    // append-only delivery rows; map it to a `create` on the delivery resource keyed by recipient.
    const guardInput: MutationGuardInput = {
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub,
      resourceKind: RESOURCE_KIND,
      resourceId: body.recipientUserId,
      operation: 'create',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: body,
    }
    const guardResult = await runGuards(container, resolveUserFeatures(auth), guardInput)
    if (!guardResult.ok) {
      return NextResponse.json(
        guardResult.errorBody ?? { error: translate('push_notifications.errors.send_failed', 'Operation blocked') },
        { status: guardResult.errorStatus ?? 422 },
      )
    }

    const service = container.resolve('pushNotificationService') as PushNotificationService
    const result = await service.sendCustomPush({
      resolve: (<T = unknown,>(name: string): T => container.resolve(name) as T),
      tenantId: auth.tenantId,
      userId: body.recipientUserId,
      organizationId,
      title: body.title,
      body: body.body ?? null,
      data: body.data,
      pushOptions: body.pushOptions,
    })

    for (const callback of guardResult.afterSuccessCallbacks) {
      if (!callback.guard.afterSuccess) continue
      await callback.guard.afterSuccess({
        ...guardInput,
        resourceId: body.recipientUserId,
        metadata: callback.metadata ?? null,
      })
    }

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: translate('push_notifications.errors.invalid_payload', 'Invalid request'), details: err.flatten() },
        { status: 400 },
      )
    }
    console.error('[push_notifications.custom-send.POST]', err)
    return NextResponse.json(
      { error: translate('push_notifications.errors.send_failed', 'Failed to send push notification') },
      { status: 500 },
    )
  }
}

export const openApi = {
  POST: {
    summary: 'Send a custom push notification',
    description:
      "Admin-only: deliver a one-off, free-text visible push to all of a single user's push-capable devices. No in-app notification or email is created.",
    tags: ['PushNotifications'],
    requestBody: { schema: customSendSchema },
    responses: {
      201: {
        description: 'Per-device push jobs enqueued',
        content: { 'application/json': { schema: customSendResponseSchema } },
      },
      400: {
        description: 'Invalid request',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  },
}
