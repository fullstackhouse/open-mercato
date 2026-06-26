import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { z } from 'zod'
import { NotificationType } from '../../data/entities'
import { syncNotificationTypes } from '../../lib/notification-type-registry'
import { notificationTypeItemSchema } from '../../data/validators'
import { errorResponseSchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['notifications.view'] },
}

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
    const items = rows.map((row) => ({
      id: row.id,
      labelKey: row.labelKey,
      descriptionKey: row.descriptionKey ?? null,
      category: row.category ?? null,
      silent: row.silent === true,
      nonOptOut: row.nonOptOut === true,
    }))
    return NextResponse.json({ items })
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

export const openApi = {
  GET: {
    summary: 'List notification types',
    description: 'Returns the notification type catalogue (system-wide + tenant) so clients can render a preferences screen.',
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
}
