import { z } from 'zod'

export const PUSH_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped', 'expired'] as const

// A `created_at` range bound: an ISO-8601 date (`2026-07-01`) or datetime (`2026-07-01T00:00:00Z`).
// Validated here so a malformed value fails with a 400 instead of reaching the query engine / Postgres.
const rangeDateFilter = z.union([z.string().datetime({ offset: true }), z.string().date()])

// Read-only delivery-log list contract (admin observability). No full push token is ever exposed —
// only `token_snapshot` (last 8 chars) and the `provider` snapshot.
export const deliveryListSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    status: z.enum(PUSH_DELIVERY_STATUSES).optional(),
    userId: z.string().uuid().optional(),
    from: rangeDateFilter.optional(),
    to: rangeDateFilter.optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

export const deliveryListFields: string[] = [
  'id',
  'tenant_id',
  'organization_id',
  'notification_id',
  'notification_type_id',
  'user_device_id',
  'user_id',
  'provider',
  'token_snapshot',
  'status',
  'attempts',
  'last_error',
  'created_at',
  'sent_at',
  'next_retry_at',
  'updated_at',
]

export const deliveryListSortFieldMap: Record<string, string> = {
  createdAt: 'created_at',
  sentAt: 'sent_at',
  updatedAt: 'updated_at',
  status: 'status',
}

export const deliveryListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  organization_id: z.string().uuid().nullable().optional(),
  notification_id: z.string().uuid().nullable().optional(),
  notification_type_id: z.string(),
  user_device_id: z.string().uuid(),
  user_id: z.string().uuid(),
  provider: z.string(),
  token_snapshot: z.string(),
  status: z.enum(PUSH_DELIVERY_STATUSES),
  attempts: z.number(),
  last_error: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  sent_at: z.string().nullable().optional(),
  next_retry_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

// Detail adds the JSON payload + provider response (still no full token).
export const deliveryDetailItemSchema = deliveryListItemSchema.extend({
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  provider_response: z.record(z.string(), z.unknown()).nullable().optional(),
})
