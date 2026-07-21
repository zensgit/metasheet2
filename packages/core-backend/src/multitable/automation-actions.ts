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
  // A-2b (one-tap lock #3594): approval-card delivery — ledger-anchored action_card send whose
  // recipient is FIXED from the approval.task_created event (never author-supplied).
  | 'send_dingtalk_approval_card'
  | 'lock_record'
  | 'wait_for_callback'
  | 'condition_branch'
  | 'start_approval'
  | 'parallel_branch'
  // B1: executor-owned INERT action for the button field. Audit-only click, zero
  // business side effect (no record write / no outbound / no job). Dispatched
  // through the SAME executor path as every other action (no parallel path).
  | 'record_click'
  // FWB activation (FWB0 lock, RATIFIED 2026-07-15): write approved form values into the rule's OWN
  // sheet as a NEW record (lock D2 — FWB-1 target = rule.sheet_id, no cross-base, no explicit sheet
  // target; §11 Q3 rejected same-base explicit targets). Save-allowed ONLY on approval.completed rules
  // (lock D11: APPROVAL_COMPLETED_ALLOWED_ACTION_TYPES "只放行这一个新动作"). Execution is flag-gated
  // (APPROVAL_FWB_WRITEBACK_ENABLED, default OFF) and rides the durable outbox + the FWB instance-scoped
  // idempotency ledger (lock D9: claim + record + revision + outbox = ONE transaction).
  | 'write_approval_form_values'

export const ALL_ACTION_TYPES: AutomationActionType[] = [
  'update_record',
  'create_record',
  'delete_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'send_dingtalk_approval_card',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
  'start_approval',
  'parallel_branch',
  'record_click',
  'write_approval_form_values',
]

/**
 * Config shape for write_approval_form_values (FWB activation).
 *
 * Deliberately NO target sheet/base fields: FWB-1's target is the rule's own sheet (FWB0 lock D2; §11 Q3
 * rejected same-base explicit sheet targets — "显式表目标无表单锚点，会重开 W7 Q2 字面目标之争").
 * Form VALUES never appear here either — the executor reads the immutable `form_snapshot` server-side by
 * instanceId (lock D4: 表单值永不进事件载荷/动作配置).
 */
export interface WriteApprovalFormValuesConfig {
  /** template form field → target field mappings; v1 types text/number/date/select (lock §4, D5-D8). */
  mappings: Array<{
    formFieldId: string
    targetFieldId: string
    targetType: 'text' | 'number' | 'date' | 'select'
    /** required for 'select': the CLOSED allowed-option set (lock D6 — no create-on-write). */
    selectOptions?: string[]
  }>
  /**
   * §11 Q6 gate-3 explicit confirmation, BOUND to the actual config: the server-derived sha256 of the
   * canonicalized {templateId, targetSheetId, mappings}. Save rejects a mismatch; execute re-derives from
   * the persisted row, so any config/target/template change invalidates the confirmation.
   */
  confirmationHash: string
}

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
