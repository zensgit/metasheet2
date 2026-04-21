/**
 * Automation Action Types — V1
 * Defines all supported action types and their configuration shapes.
 */

export type AutomationActionType =
  | 'update_record'
  | 'create_record'
  | 'send_webhook'
  | 'send_notification'
  | 'send_dingtalk_group_message'
  | 'send_dingtalk_person_message'
  | 'lock_record'

export const ALL_ACTION_TYPES: AutomationActionType[] = [
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
]

/** Config shape for update_record */
export interface UpdateRecordConfig {
  fields: Record<string, unknown>
}

/** Config shape for create_record */
export interface CreateRecordConfig {
  sheetId: string
  data: Record<string, unknown>
}

/** Config shape for send_webhook */
export interface SendWebhookConfig {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** Config shape for send_notification */
export interface SendNotificationConfig {
  userIds: string[]
  message: string
}

/** Config shape for send_dingtalk_group_message */
export interface SendDingTalkGroupMessageConfig {
  destinationId?: string
  destinationIds?: string[]
  destinationIdFieldPath?: string
  destinationIdFieldPaths?: string[]
  titleTemplate: string
  bodyTemplate: string
  publicFormViewId?: string
  internalViewId?: string
}

/** Config shape for send_dingtalk_person_message */
export interface SendDingTalkPersonMessageConfig {
  userIds: string[]
  memberGroupIds?: string[]
  userIdFieldPath?: string
  userIdFieldPaths?: string[]
  memberGroupIdFieldPath?: string
  memberGroupIdFieldPaths?: string[]
  titleTemplate: string
  bodyTemplate: string
  publicFormViewId?: string
  internalViewId?: string
}

/** Config shape for lock_record */
export interface LockRecordConfig {
  locked: boolean
}

export interface AutomationAction {
  type: AutomationActionType
  config: Record<string, unknown>
}
