import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { z } from 'zod'
import { NotificationType } from '../../data/entities'
import { getNotificationType, syncNotificationTypes } from '../../lib/notification-type-registry'
import { notificationTypeItemSchema, updateNotificationTypeChannelsSchema } from '../../data/validators'
import { errorResponseSchema } from '../openapi'
import {
  NOTIFICATION_SETTINGS_RESOURCE_KIND,
  runGuardedNotificationWrite,
} from '../../lib/routeHelpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['notifications.view'] },
  PATCH: { requireAuth: true, requireFeatures: ['notifications.manage'] },
}

/**
 * Effective channel eligibility for a catalogue row: the operator's stored override
 * (`notification_types.channels`) replaces the code-declared `type.channels` — matching
 * `resolveEligibleChannels` in the delivery gate, so preference UIs lock exactly the cells
 * delivery would reject. `null` = no restriction (every registered channel).
 */
const effectiveChannels = (row: NotificationType): string[] | null =>
  row.channels ?? getNotificationType(row.id)?.channels ?? null

const typeItem = (row: NotificationType) => ({
  id: row.id,
  labelKey: row.labelKey,
  descriptionKey: row.descriptionKey ?? null,
  category: row.category ?? null,
  silent: row.silent === true,
  nonOptOut: row.nonOptOut === true,
  channels: effectiveChannels(row),
  storedChannels: row.channels ?? null,
})

export async function GET(req: Request) {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json({ error: t('api.errors.unauthorized', 'Unauthorized') }, { status: 401 })
  }

  const container = await createRequestContainer()
  try {
    const em = container.resolve('em') as EntityManager
    // Read-through mirror: ensure the catalogue is reflected in the DB (once per process).
    await syncNotificationTypes(em)
    const rows = await em.find(
      NotificationType,
      { $or: [{ tenantId: null }, { tenantId: auth.tenantId }] },
      { orderBy: { id: 'asc' } },
    )
    return NextResponse.json({ items: rows.map(typeItem) })
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

export async function PATCH(req: Request) {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json({ error: t('api.errors.unauthorized', 'Unauthorized') }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: t('api.errors.invalidPayload', 'Invalid request body') },
      { status: 400 },
    )
  }

  const parsed = updateNotificationTypeChannelsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: t('notifications.types.invalidChannels', 'Invalid channels payload') },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  try {
    const em = container.resolve('em') as EntityManager
    await syncNotificationTypes(em)
    const row = await em.findOne(NotificationType, { id: parsed.data.id, tenantId: null })
    if (!row) {
      return NextResponse.json(
        { error: t('notifications.types.unknownType', 'Unknown notification type') },
        { status: 404 },
      )
    }

    const guarded = await runGuardedNotificationWrite(
      container,
      {
        tenantId: auth.tenantId,
        organizationId: auth.orgId ?? null,
        userId: auth.sub ?? null,
      },
      req,
      {
        resourceKind: NOTIFICATION_SETTINGS_RESOURCE_KIND,
        operation: 'update',
        payload: parsed.data as unknown as Record<string, unknown>,
      },
      async () => {
        row.channels = parsed.data.channels
        await em.flush()
        return typeItem(row)
      },
    )
    if (!guarded.ok) return guarded.response
    return NextResponse.json({ ok: true, item: guarded.result })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : t('api.errors.internal', 'Internal error') },
      { status: 500 },
    )
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

export const openApi = {
  GET: {
    summary: 'List notification types',
    description: 'Returns the notification type catalogue (system-wide + tenant) so clients can render a preferences screen. `channels` is the effective channel eligibility (operator override, else the code-declared set; `null` = every channel); a channel outside it never delivers and cannot be enabled by users.',
    tags: ['Notifications'],
    responses: {
      200: {
        description: 'Notification type catalogue',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(notificationTypeItemSchema) }),
          },
        },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  },
  PATCH: {
    summary: 'Override a notification type\'s channel eligibility',
    description: 'Operator override of the channels a type may deliver on (`notification_types.channels`). The stored array replaces the code-declared `type.channels`; pass `channels: null` to clear the override and inherit the code default. A channel outside the effective set is completely off for the type: it beats user preferences and `nonOptOut`, and preference UIs lock the cell.',
    tags: ['Notifications'],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: updateNotificationTypeChannelsSchema },
      },
    },
    responses: {
      200: {
        description: 'Channel eligibility updated',
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              item: notificationTypeItemSchema,
            }),
          },
        },
      },
      400: {
        description: 'Invalid request body',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
      404: {
        description: 'Unknown notification type',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  },
}
