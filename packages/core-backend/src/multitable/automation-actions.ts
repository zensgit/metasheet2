/**
 * Automation Action Types — V1
 * Defines all supported action types and their configuration shapes.
 */

export type AutomationActionType =
  | 'update_record'
  | 'create_record'
  | 'send_webhook'
  | 'send_notification'
  | 'send_email'
  | 'send_dingtalk_group_message'
  | 'send_dingtalk_person_message'
  | 'lock_record'
  | 'wait_for_callback'
  | 'condition_branch'
  | 'start_approval'
  | 'parallel_branch'

export const ALL_ACTION_TYPES: AutomationActionType[] = [
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
  'start_approval',
  'parallel_branch',
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
  /** Optional HMAC-SHA256 signing secret (X-Webhook-Signature header). */
  secret?: string
}

/** Config shape for send_notification */
export interface SendNotificationConfig {
  userIds: string[]
  message: string
}

/** Config shape for send_email */
export interface SendEmailConfig {
  recipients: string[]
  subjectTemplate: string
  bodyTemplate: string
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

/**
 * Config shape for wait_for_callback (A6-2 suspend/resume).
 *
 * v1 has NO required params — reaching this action in an opted-in
 * (`execution_mode='workflow_job_v1'`) rule suspends the execution. v1 has NO external
 * emitter: the resume token is persisted on the suspension row and surfaced (admin-detail-only,
 * via the C1 suspend descriptor) as the way an admin obtains it to resume. `reason` is fixed to
 * `external_event` in v1 (delay/manual_task are red-lined out — see design doc).
 */
export interface WaitForCallbackConfig {
  reason?: 'external_event'
}

/**
 * Config shape for start_approval (W6-1 approval bridge).
 *
 * v1 creates one approval instance from a published approval template, suspends
 * the automation job, and resumes from W5 approval completion events. Form data
 * is explicit mapping only; result backwrite is intentionally absent.
 */
export interface StartApprovalConfig {
  templateId: string
  formDataMapping: Record<string, string>
  requester?: {
    mode?: 'trigger_actor' | 'rule_creator'
  }
}

/**
 * Config shape for parallel_branch (A6-3-4 / W3-1 join-all runtime).
 *
 * v1 is fan-out + join-all only: all branches run, the parent job settles after
 * every branch is terminal, and join_any/cancellation/branch-local waits stay
 * out of scope.
 */
export interface ParallelBranchConfig {
  joinMode: 'all'
  branches: Array<{
    key: string
    label?: string
    actions: AutomationAction[]
  }>
}

export interface AutomationAction {
  type: AutomationActionType
  config: Record<string, unknown>
}
