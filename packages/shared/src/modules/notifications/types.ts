import type { ComponentType } from 'react'

export type NotificationStatus = 'unread' | 'read' | 'actioned' | 'dismissed'
export type NotificationSeverity = 'info' | 'warning' | 'success' | 'error'

export type NotificationAction = {
  id: string
  label: string
  labelKey?: string
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost'
  icon?: string
  commandId?: string
  href?: string
  confirmRequired?: boolean
  confirmMessage?: string
}

export type NotificationActionData = {
  actions: NotificationAction[]
  primaryActionId?: string
}

export type NotificationTypeAction = {
  id: string
  labelKey: string
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost'
  icon?: string
  commandId?: string
  href?: string
  confirmRequired?: boolean
  confirmMessageKey?: string
}

export type NotificationRendererProps = {
  notification: {
    id: string
    type: string
    title: string
    body?: string | null
    titleKey?: string | null
    bodyKey?: string | null
    titleVariables?: Record<string, string> | null
    bodyVariables?: Record<string, string> | null
    icon?: string | null
    severity: string
    status: string
    sourceModule?: string | null
    sourceEntityType?: string | null
    sourceEntityId?: string | null
    linkHref?: string | null
    createdAt: string
  }
  onAction: (actionId: string) => Promise<void>
  onDismiss: () => Promise<void>
  actions: NotificationTypeAction[]
}

export type NotificationTypeDefinition = {
  type: string
  module: string
  titleKey: string
  bodyKey?: string
  icon: string
  severity: NotificationSeverity
  actions: NotificationTypeAction[]
  primaryActionId?: string
  linkHref?: string
  Renderer?: ComponentType<NotificationRendererProps>
  expiresAfterHours?: number
  /**
   * Optional i18n key for the short type name shown in a per-channel
   * preferences UI (e.g. "Order created"). Distinct from `titleKey`, which is
   * the per-instance message title. Falls back to `titleKey` when omitted.
   */
  labelKey?: string
  /** Optional i18n key for helper text shown beside the type in a preferences UI. */
  descriptionKey?: string
  /**
   * When `true`, this type may be delivered as a silent / content-available push
   * (a data-only wake-up that creates no in-app `Notification` row and bypasses
   * per-channel preferences). Gates `pushNotificationService.sendSilentPush`.
   */
  silent?: boolean
}

export type NotificationDto = {
  id: string
  type: string
  title: string
  body?: string | null
  titleKey?: string | null
  bodyKey?: string | null
  titleVariables?: Record<string, string> | null
  bodyVariables?: Record<string, string> | null
  icon?: string | null
  severity: string
  status: string
  actions: Array<{
    id: string
    label: string
    labelKey?: string
    variant?: string
    icon?: string
  }>
  primaryActionId?: string
  sourceModule?: string | null
  sourceEntityType?: string | null
  sourceEntityId?: string | null
  linkHref?: string | null
  /** Arbitrary app-readable key/values attached at create time (also delivered with the push). */
  data?: Record<string, string> | null
  createdAt: string
  readAt?: string | null
  actionTaken?: string | null
}

export type NotificationPollData = {
  unreadCount: number
  recent: NotificationDto[]
  hasNew: boolean
  lastId?: string
}
