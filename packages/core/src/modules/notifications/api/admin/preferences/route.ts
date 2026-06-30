import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { User } from '../../../../auth/data/entities'
import { resolveNotificationPreferenceService, type NotificationPreferenceScope } from '../../../lib/notificationPreferenceService'
import { runGuardedNotificationWrite, NOTIFICATION_PREFERENCE_RESOURCE_KIND } from '../../../lib/routeHelpers'
import { PREFERENCE_UPDATED_EVENT } from '../../../events'
import {
  adminPreferencesQuerySchema,
  adminUpdatePreferencesSchema,
  notificationPreferenceItemSchema,
} from '../../../data/validators'
import { errorResponseSchema } from '../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['notifications.manage_user_preferences'] },
  PUT: { requireAuth: true, requireFeatures: ['notifications.manage_user_preferences'] },
}

const unauthorized = async () => {
  const { t } = await resolveTranslations()
  return NextResponse.json({ error: t('api.errors.unauthorized', 'Unauthorized') }, { status: 401 })
}

/** Confirm the target user exists in the acting admin's tenant (prevents cross-tenant writes). */
async function assertTargetUserInTenant(em: EntityManager, userId: string, tenantId: string): Promise<boolean> {
  const user = await em.findOne(User, { id: userId, tenantId, deletedAt: null })
  return Boolean(user)
}

export async function GET(req: Request) {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) return await unauthorized()

  const url = new URL(req.url)
  const parsed = adminPreferencesQuerySchema.safeParse({ userId: url.searchParams.get('userId') ?? undefined })
  if (!parsed.success) {
    return NextResponse.json({ error: t('api.errors.invalidPayload', 'Invalid request body') }, { status: 400 })
  }

  const container = await createRequestContainer()
  try {
    const em = container.resolve('em') as EntityManager
    if (!(await assertTargetUserInTenant(em, parsed.data.userId, auth.tenantId))) {
      return NextResponse.json({ error: t('notifications.preferences.userNotFound', 'User not found') }, { status: 404 })
    }
    const service = resolveNotificationPreferenceService(container)
    const scope: NotificationPreferenceScope = { tenantId: auth.tenantId, userId: parsed.data.userId }
    const rows = await service.listForUser(scope)
    const items = rows.map((row) => ({
      notificationTypeId: row.notificationTypeId,
      channel: row.channel,
      enabled: row.enabled,
    }))
    return NextResponse.json({ items })
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

export async function PUT(req: Request) {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) return await unauthorized()

  const parsed = adminUpdatePreferencesSchema.safeParse(await readJsonSafe(req, {}))
  if (!parsed.success) {
    return NextResponse.json({ error: t('api.errors.invalidPayload', 'Invalid request body') }, { status: 400 })
  }

  const container = await createRequestContainer()
  try {
    const em = container.resolve('em') as EntityManager
    if (!(await assertTargetUserInTenant(em, parsed.data.userId, auth.tenantId))) {
      return NextResponse.json({ error: t('notifications.preferences.userNotFound', 'User not found') }, { status: 404 })
    }
    const service = resolveNotificationPreferenceService(container)
    const scope: NotificationPreferenceScope = { tenantId: auth.tenantId, userId: parsed.data.userId }
    const guarded = await runGuardedNotificationWrite(
      container,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null, userId: auth.sub },
      req,
      {
        resourceKind: NOTIFICATION_PREFERENCE_RESOURCE_KIND,
        resourceId: parsed.data.userId,
        operation: 'update',
        payload: parsed.data as Record<string, unknown>,
      },
      () =>
        service.setPreferences(
          scope,
          parsed.data.preferences.map((p) => ({ typeId: p.notificationTypeId, channel: p.channel, enabled: p.enabled })),
        ),
    )
    if (!guarded.ok) return guarded.response

    const eventBus = container.resolve('eventBus') as {
      emit: (event: string, payload: unknown, options?: unknown) => Promise<void>
    }
    await eventBus.emit(
      PREFERENCE_UPDATED_EVENT,
      { tenantId: auth.tenantId, userId: parsed.data.userId },
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )

    return NextResponse.json({ ok: true })
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

export const openApi = {
  GET: {
    summary: "Get a user's notification preferences (admin)",
    description: "Returns a target user's stored channel preferences. Requires notifications.manage_user_preferences.",
    tags: ['Notifications'],
    parameters: [{ name: 'userId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: {
        description: 'Stored preferences',
        content: { 'application/json': { schema: z.object({ items: z.array(notificationPreferenceItemSchema) }) } },
      },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: errorResponseSchema } } },
      404: { description: 'User not found', content: { 'application/json': { schema: errorResponseSchema } } },
    },
  },
  PUT: {
    summary: "Update a user's notification preferences (admin)",
    description: "Bulk-updates a target user's channel preferences. Requires notifications.manage_user_preferences.",
    tags: ['Notifications'],
    requestBody: { required: true, content: { 'application/json': { schema: adminUpdatePreferencesSchema } } },
    responses: {
      200: { description: 'Preferences updated', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      400: { description: 'Invalid request body', content: { 'application/json': { schema: errorResponseSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: errorResponseSchema } } },
      404: { description: 'User not found', content: { 'application/json': { schema: errorResponseSchema } } },
    },
  },
}
