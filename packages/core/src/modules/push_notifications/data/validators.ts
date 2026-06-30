import { z } from 'zod'
import { pushOptionsSchema } from '@open-mercato/core/modules/notifications/data/validators'

export const PUSH_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const

// POST /api/push_notifications/custom-send — admin composes a one-off visible push to a single user.
// title/body are literal free text (not i18n keys). data/pushOptions reuse the notifications contract.
export const customSendSchema = z
  .object({
    recipientUserId: z.string().uuid(),
    title: z.string().trim().min(1).max(500),
    body: z.string().trim().max(2000).nullish(),
    data: z.record(z.string(), z.string()).optional(),
    pushOptions: pushOptionsSchema.optional(),
  })
  .strict()
export type CustomSendInput = z.infer<typeof customSendSchema>

export const customSendResponseSchema = z.object({ enqueued: z.number() })

// Read-only delivery-log list contract (admin observability). No full push token is ever exposed —
// only `token_snapshot` (last 8 chars) and the `provider` snapshot.
export const deliveryListSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    status: z.enum(PUSH_DELIVERY_STATUSES).optional(),
    userId: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
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
  updated_at: z.string().nullable().optional(),
})

// Detail adds the JSON payload + provider response (still no full token).
export const deliveryDetailItemSchema = deliveryListItemSchema.extend({
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  provider_response: z.record(z.string(), z.unknown()).nullable().optional(),
})
