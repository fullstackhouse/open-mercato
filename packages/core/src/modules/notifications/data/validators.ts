import { z } from 'zod'
import { isSafeNotificationHref } from '../lib/safeHref'

export const notificationStatusSchema = z.enum(['unread', 'read', 'actioned', 'dismissed'])
export const notificationSeveritySchema = z.enum(['info', 'warning', 'success', 'error'])

export const safeRelativeHrefSchema = z.string().min(1).refine(
  (href) => isSafeNotificationHref(href),
  { message: 'Href must be a same-origin relative path starting with /' }
)

export const notificationActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  labelKey: z.string().optional(),
  variant: z.enum(['default', 'secondary', 'destructive', 'outline', 'ghost']).optional(),
  icon: z.string().optional(),
  commandId: z.string().optional(),
  href: safeRelativeHrefSchema.optional(),
  confirmRequired: z.boolean().optional(),
  confirmMessage: z.string().optional(),
})

const baseNotificationFieldsSchema = z.object({
  type: z.string().min(1).max(100),
  titleKey: z.string().min(1).max(200).optional(),
  bodyKey: z.string().min(1).max(200).optional(),
  titleVariables: z.record(z.string(), z.string()).optional(),
  bodyVariables: z.record(z.string(), z.string()).optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
  severity: notificationSeveritySchema.optional().default('info'),
  actions: z.array(notificationActionSchema).optional(),
  primaryActionId: z.string().optional(),
  sourceModule: z.string().optional(),
  sourceEntityType: z.string().optional(),
  sourceEntityId: z.string().uuid().optional(),
  linkHref: safeRelativeHrefSchema.optional(),
  groupKey: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
})

const titleRequiredRefinement = {
  refine: (data: { titleKey?: string; title?: string }) => data.titleKey || data.title,
  message: 'Either titleKey or title must be provided',
} as const

export const createNotificationSchema = baseNotificationFieldsSchema
  .extend({ recipientUserId: z.string().uuid() })
  .refine(titleRequiredRefinement.refine, { message: titleRequiredRefinement.message })

export const createBatchNotificationSchema = baseNotificationFieldsSchema
  .extend({ recipientUserIds: z.array(z.string().uuid()).min(1).max(1000) })
  .refine(titleRequiredRefinement.refine, { message: titleRequiredRefinement.message })

export const createRoleNotificationSchema = baseNotificationFieldsSchema
  .extend({ roleId: z.string().uuid() })
  .refine(titleRequiredRefinement.refine, { message: titleRequiredRefinement.message })

export const createFeatureNotificationSchema = baseNotificationFieldsSchema
  .extend({ requiredFeature: z.string().min(1).max(100) })
  .refine(titleRequiredRefinement.refine, { message: titleRequiredRefinement.message })

export const listNotificationsSchema = z.object({
  status: z.union([notificationStatusSchema, z.array(notificationStatusSchema)]).optional(),
  type: z.string().optional(),
  severity: notificationSeveritySchema.optional(),
  sourceEntityType: z.string().optional(),
  sourceEntityId: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
})

export const executeActionSchema = z.object({
  actionId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export const restoreNotificationSchema = z.object({
  status: z.enum(['read', 'unread']).optional(),
})

const notificationDeliveryStrategySchema = z.object({
  enabled: z.boolean().optional(),
})

const notificationDeliveryEmailSchema = notificationDeliveryStrategySchema.extend({
  from: z.string().trim().min(1).optional(),
  replyTo: z.string().trim().min(1).optional(),
  subjectPrefix: z.string().trim().min(1).optional(),
})

const notificationDeliveryCustomSchema = notificationDeliveryStrategySchema.extend({
  config: z.unknown().optional(),
})

export const notificationDeliveryConfigSchema = z.object({
  appUrl: z.string().url().optional(),
  panelPath: safeRelativeHrefSchema.optional(),
  strategies: z.object({
    database: notificationDeliveryStrategySchema.optional(),
    email: notificationDeliveryEmailSchema.optional(),
    custom: z.record(z.string(), notificationDeliveryCustomSchema).optional(),
  }).optional(),
})

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>
export type CreateBatchNotificationInput = z.infer<typeof createBatchNotificationSchema>
export type CreateRoleNotificationInput = z.infer<typeof createRoleNotificationSchema>
export type CreateFeatureNotificationInput = z.infer<typeof createFeatureNotificationSchema>
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>
export type ExecuteActionInput = z.infer<typeof executeActionSchema>
export type NotificationDeliveryConfigInput = z.infer<typeof notificationDeliveryConfigSchema>

// Notification type catalogue (DB-mirrored read model)
export const notificationTypeItemSchema = z.object({
  id: z.string(),
  labelKey: z.string(),
  descriptionKey: z.string().nullable().optional(),
})

// Per-user channel preferences
export const notificationPreferenceItemSchema = z.object({
  notificationTypeId: z.string(),
  channel: z.string(),
  enabled: z.boolean(),
})

export const updatePreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        notificationTypeId: z.string().trim().min(1).max(128),
        channel: z.string().trim().min(1).max(32),
        enabled: z.boolean(),
      }),
    )
    .max(500),
})

// Admin-on-behalf preference management (target a specific user)
export const adminPreferencesQuerySchema = z.object({
  userId: z.string().uuid(),
})

export const adminUpdatePreferencesSchema = updatePreferencesSchema.extend({
  userId: z.string().uuid(),
})

export type NotificationTypeItem = z.infer<typeof notificationTypeItemSchema>
export type NotificationPreferenceItem = z.infer<typeof notificationPreferenceItemSchema>
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>
export type AdminUpdatePreferencesInput = z.infer<typeof adminUpdatePreferencesSchema>
