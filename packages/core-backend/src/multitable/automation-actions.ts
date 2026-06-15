/**
 * Automation Action Types — V1
 * Defines all supported action types and their configuration shapes.
 */

export type AutomationActionType =
  | 'update_record'
  | 'create_record'
  | 'delete_record'
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
  // B1: executor-owned INERT action for the button field. Audit-only click, zero
  // business side effect (no record write / no outbound / no job). Dispatched
  // through the SAME executor path as every other action (no parallel path).
  | 'record_click'

export const ALL_ACTION_TYPES: AutomationActionType[] = [
  'update_record',
  'create_record',
  'delete_record',
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
  'record_click',
]

/** Config shape for update_record */
export interface UpdateRecordConfig {
  fields: Record<string, unknown>
  /**
   * ②b cross-base write opt-in. When `targetBaseId` is set and ≠ the trigger base, this is a GOVERNED
   * cross-base update: it requires FULL explicit addressing (`targetSheetId` + `targetRecordId`) because
   * the trigger record is not in the target base. The executor write-gate then re-verifies, per run,
   * that the TRIGGER ACTOR holds base-WRITE on `targetBaseId` and that `targetSheetId ∈ targetBaseId` /
   * `targetRecordId ∈ targetSheetId` (claim == truth). All three absent = same-base trigger-record
   * update (unchanged, back-compat).
   */
  targetBaseId?: string
  targetSheetId?: string
  targetRecordId?: string
}

/** Config shape for create_record */
export interface CreateRecordConfig {
  sheetId: string
  data: Record<string, unknown>
  /**
   * ②b cross-base write opt-in. When `targetBaseId` is set and ≠ the trigger base, this is a GOVERNED
   * cross-base create: the executor write-gate re-verifies, per run, that the TRIGGER ACTOR holds
   * base-WRITE on `targetBaseId` and that the resolved target sheet (`sheetId`) actually lives in
   * `targetBaseId` (claim == truth). Absent = same-base create (unchanged, back-compat).
   */
  targetBaseId?: string
}

/** Config shape for delete_record */
export interface DeleteRecordConfig {
  /**
   * ②b / Phase C2 cross-base DELETE opt-in. When `targetBaseId` is set and ≠ the trigger base, this is a
   * GOVERNED cross-base delete (a delete is a write for abuse-accounting): it requires FULL explicit
   * addressing (`targetSheetId` + `targetRecordId`) because the trigger record is not in the target base.
   * The executor write-gate then re-verifies, per run, that the TRIGGER ACTOR holds base-WRITE on
   * `targetBaseId` and that `targetSheetId ∈ targetBaseId` / `targetRecordId ∈ targetSheetId`
   * (claim == truth). All three absent = same-base trigger-record delete (back-compat).
   */
  targetBaseId?: string
  targetSheetId?: string
  targetRecordId?: string
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
  /**
   * Phase C2 cross-base LOCK opt-in. Locking a record in ANOTHER base is a denial-of-edit on foreign
   * data — a governance surface gated by the SAME primitive as a cross-base write (`base:write` on the
   * target base, NOT base:admin; lock is an edit-class affordance). When `targetBaseId` is set and ≠ the
   * trigger base, FULL explicit addressing (`targetSheetId` + `targetRecordId`) is required and the lock
   * verifies claim == truth (the target record actually lives in `targetSheetId ∈ targetBaseId`) +
   * trigger-actor base-write. All three absent = same-base trigger-record lock (unchanged, back-compat).
   */
  targetBaseId?: string
  targetSheetId?: string
  targetRecordId?: string
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
