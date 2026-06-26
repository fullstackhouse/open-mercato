import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { E } from '#generated/entities.ids.generated'
import { PushNotificationDelivery } from '../../data/entities'
import {
  deliveryListSchema,
  deliveryListFields,
  deliveryListSortFieldMap,
  deliveryListItemSchema,
} from '../../data/validators'
import { createPushNotificationsCrudOpenApi, createPagedListResponseSchema } from '../openapi'

// Read-only push delivery log (admin observability). No writes: device/token lifecycle lives in the
// `devices` module; delivery rows are produced by the `push` strategy + send-push worker.
const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['push_notifications.view_deliveries'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: PushNotificationDelivery,
    idField: 'id',
    // organization_id is nullable; scope is applied manually in buildFilters (mirrors devices admin list).
    orgField: null,
    tenantField: 'tenantId',
  },
  indexer: { entityType: E.push_notifications.push_notification_delivery },
  list: {
    schema: deliveryListSchema,
    entityId: E.push_notifications.push_notification_delivery,
    fields: deliveryListFields,
    sortFieldMap: deliveryListSortFieldMap,
    buildFilters: async (query, ctx) => {
      const filters: Record<string, unknown> = {}
      if (query.status) filters.status = { $eq: query.status }
      if (query.userId) filters.user_id = { $eq: query.userId }
      const createdAt: Record<string, unknown> = {}
      if (query.from) createdAt.$gte = query.from
      if (query.to) createdAt.$lte = query.to
      if (Object.keys(createdAt).length > 0) filters.created_at = createdAt
      // organization_id is nullable: tenant-level notifications produce push deliveries with a NULL
      // org. A restricted admin (organizationIds = [...]) must still see those rows, which are already
      // tenant-scoped, so scope to "in an allowed org OR org-less". Unrestricted (null) sees everything.
      if (ctx.organizationIds !== null) {
        filters.$or = [
          { organization_id: { $in: ctx.organizationIds } },
          { organization_id: { $eq: null } },
        ]
      }
      return filters
    },
  },
})

export const GET = crud.GET

export const openApi: OpenApiRouteDoc = createPushNotificationsCrudOpenApi({
  resourceName: 'Push delivery',
  pluralName: 'Push deliveries',
  querySchema: deliveryListSchema,
  listResponseSchema: createPagedListResponseSchema(deliveryListItemSchema),
})
