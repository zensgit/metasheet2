/**
 * Automation Trigger Types — V1
 * Defines all supported trigger types and their configuration shapes.
 */

export type AutomationTriggerType =
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'field.value_changed'
  | 'schedule.cron'
  | 'schedule.interval'
  | 'schedule.date_field'
  | 'webhook.received'
  | 'form.submitted'
  | 'approval.completed'
  | 'approval.task_created'
  | 'integration.run_finished'

export const ALL_TRIGGER_TYPES: AutomationTriggerType[] = [
  'record.created',
  'record.updated',
  'record.deleted',
  'field.value_changed',
  'schedule.cron',
  'schedule.interval',
  'schedule.date_field',
  'webhook.received',
  'form.submitted',
  'approval.completed',
  'approval.task_created',
  'integration.run_finished',
]

/** Config shape for field.value_changed */
export interface FieldValueChangedConfig {
  fieldId: string
  condition?: 'any' | 'equals' | 'changed_to'
  value?: unknown
}

/** Config shape for schedule.cron */
export interface ScheduleCronConfig {
  expression: string
  timezone?: string
}

/** Config shape for schedule.interval */
export interface ScheduleIntervalConfig {
  intervalMs: number
  startAt?: string
}

/** Config shape for webhook.received */
export interface WebhookReceivedConfig {
  secret?: string
}

/**
 * Config shape for approval.completed (T1-3).
 * Routing is by REQUIRED approval templateId (cross-sheet; the completion event carries no sheet/record).
 * `outcomes` filters which terminal outcomes fire the rule; omitted = approved only. Dispatch does NOT go
 * through matchesTrigger/TRIGGER_TYPE_BY_EVENT — approval completions are routed by a dedicated
 * template-keyed path in AutomationService (they are not multitable record events).
 */
export interface ApprovalCompletedConfig {
  templateId: string
  outcomes?: Array<'approved' | 'rejected' | 'revoked' | 'cancelled'>
}

/**
 * Config shape for approval.task_created (A-2a, one-tap lock #3594 implementation decision).
 * Same template-keyed dedicated dispatch path as approval.completed — one event per NEW actionable
 * assignment/recipient; NOT a multitable record event. templateId is REQUIRED; a pending event whose
 * instance carries no templateId is v1 out-of-contract (debug log, no match).
 */
export interface ApprovalTaskCreatedConfig {
  templateId: string
}

// ── R-69 1c: integration.run_finished (Bridge 2) ─────────────────────────────────────────────────────────────
//
// ADR adr-automation-pipeline-bridge-20261103 §4 / Q6; design baseline v2.3 §10.2 (two bridges) and §10.2.4
// (1c rows). R-69 is OPEN: dry-run only, default OFF (INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED), not for merge
// until the owner rules.
//
// ONE values-free summary per JOB (one project of a stock-prep pull, one pipeline run), only after the final
// attempt, with a deterministic event id. Dispatch does NOT go through matchesTrigger / TRIGGER_TYPE_BY_EVENT:
// like approval.completed it is a dedicated, job-keyed path in AutomationService (it is not a multitable record
// event, and a bus event of that name must never reach the record lane).

export const INTEGRATION_RUN_FINISHED_TRIGGER = 'integration.run_finished'

/**
 * The status set (ADR §4.1, closed): the step vocabulary of run_integration_job (`RunIntegrationJobOutcome`,
 * automation-executor.ts = IntegrationRunStatus ∪ outcome_unknown), byte-identical to I3/I4.
 * `held` = a human to-do; `skipped` = a system-side skip that someone should look at.
 */
export const INTEGRATION_RUN_FINISHED_STATUSES = Object.freeze([
  'succeeded', 'partial', 'failed', 'held', 'skipped', 'not_started', 'outcome_unknown',
] as const)
export type IntegrationRunFinishedStatus = typeof INTEGRATION_RUN_FINISHED_STATUSES[number]

/**
 * The DEFAULT alert set when a rule omits `statuses` (ADR §4.2 / §4.3, baseline §10.2 "两座桥"): it CONTAINS
 * `skipped` (a revoked principal or a busy project must be visible) and does NOT contain `held` (the daily
 * `manual_confirm_required` is routine — 20 projects a day would get the alert group muted) nor `succeeded`.
 * A rule that wants held items lists `held` explicitly.
 */
export const INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES = Object.freeze([
  'failed', 'partial', 'skipped', 'outcome_unknown', 'not_started',
] as const satisfies readonly IntegrationRunFinishedStatus[])

/**
 * `held` reasons — human work, not a fault (ADR §3.2, §4.1; the plugin port's HELD set + its two held refusals).
 * `review_pending` (I5 ruling N4, T-level default-forward): the scheduled pull logs it skipped_review_pending (#6791).
 */
export const INTEGRATION_RUN_FINISHED_HELD_REASONS = Object.freeze([
  'manual_confirm_required', 'suspended', 'large_bom_bounded', 'review_pending', 'project_absent', 'project_archived',
] as const)
/**
 * `skipped` reasons — the system did not run what it should have (ADR §4.1). `not_found` (I5 ruling N4, T-level
 * default-forward): the dry run's not_found, the scheduled pull's skipped_not_found.
 */
export const INTEGRATION_RUN_FINISHED_SKIPPED_REASONS = Object.freeze([
  'principal_unauthorized', 'busy', 'pipeline_changed', 'stale_plan', 'action_disabled', 'not_found',
] as const)
/** 1c adds these three to the ADR's reason set (baseline §10.2.4, 1c row): the lifecycle endings of 1b-ii. */
export const INTEGRATION_RUN_FINISHED_REASONS_ADDED_IN_1C = Object.freeze([
  'shutdown', 'timeout_unsettled', 'lease_lost',
] as const)
/**
 * Every other closed reason the run_integration_job step writes (automation-executor.ts) and the plugin port
 * returns (lib/integration-run-port.cjs) — the exact keys of I4's RUN_INTEGRATION_JOB_REASON_LABELS
 * (apps/web/src/multitable/runIntegrationJobAuthoring.ts), pinned both ways by
 * tests/unit/automation-integration-run-finished.test.ts.
 */
export const INTEGRATION_RUN_FINISHED_STEP_REASONS = Object.freeze([
  'config_invalid', 'identity_required', 'port_inactive', 'transaction_seam_required', 'authority_unavailable', 'no_units',
  'already_applied', 'inflight_lease', 'prior_outcome_unknown', 'terminal_write_unconfirmed', 'timeout', 'aborted',
  'ready',
] as const)

/** The closed reason set an event may carry. An open error class goes to `errorClass`, never to `reason`. */
export const INTEGRATION_RUN_FINISHED_REASONS: ReadonlySet<string> = new Set<string>([
  ...INTEGRATION_RUN_FINISHED_HELD_REASONS,
  ...INTEGRATION_RUN_FINISHED_SKIPPED_REASONS,
  ...INTEGRATION_RUN_FINISHED_REASONS_ADDED_IN_1C,
  ...INTEGRATION_RUN_FINISHED_STEP_REASONS,
])

export const INTEGRATION_RUN_FINISHED_JOB_KINDS = Object.freeze(['stock_prep_pull', 'pipeline'] as const)
export type IntegrationRunFinishedJobKind = typeof INTEGRATION_RUN_FINISHED_JOB_KINDS[number]

/**
 * Config shape for integration.run_finished (ADR §4.2). Routing is by JOB, inside the creator's tenant:
 *   - `job.kind` (required, closed); `job.pipelineId` (required for `pipeline`) or `job.actionId` (optional for
 *     `stock_prep_pull`; omitted = every stock-prep pull of the tenant);
 *   - `statuses` (optional, closed, non-empty, no repeats); omitted = INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES;
 *   - `binding` is SERVER-STAMPED at save (the creator and its single active tenant — the same posture as
 *     run_integration_job's binding); a client-supplied binding is dropped. Events route only to rules whose
 *     binding tenant equals the run's tenant; the tenant never rides in the event payload.
 */
export interface IntegrationRunFinishedConfig {
  job: { kind: IntegrationRunFinishedJobKind; pipelineId?: string; actionId?: string }
  statuses?: IntegrationRunFinishedStatus[]
  binding?: { principalId: string; tenantId: string }
}

const RUN_FINISHED_CONFIG_KEYS: ReadonlySet<string> = new Set(['job', 'statuses', 'binding'])
const RUN_FINISHED_JOB_KEYS: ReadonlySet<string> = new Set(['kind', 'pipelineId', 'actionId'])
/** A job identifier: no `/`, so never a URL; no spaces; bounded. */
export const INTEGRATION_RUN_JOB_ID_SHAPE = /^[A-Za-z0-9_:.-]{1,128}$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pure save-time validation of an integration.run_finished trigger config (`binding` is ignored here: the
 * service stamps it). Returns an error string (400) or null.
 */
export function validateIntegrationRunFinishedTriggerConfig(config: unknown): string | null {
  if (!isPlainRecord(config)) return 'trigger_config must be an object for integration.run_finished rules'
  for (const key of Object.keys(config)) {
    if (!RUN_FINISHED_CONFIG_KEYS.has(key)) return `trigger_config.${key} is not an accepted key for integration.run_finished (accepted: job, statuses)`
  }
  const job = config.job
  if (!isPlainRecord(job)) return 'trigger_config.job is required for integration.run_finished rules'
  for (const key of Object.keys(job)) {
    if (!RUN_FINISHED_JOB_KEYS.has(key)) return `trigger_config.job.${key} is not an accepted key`
  }
  if (typeof job.kind !== 'string' || !(INTEGRATION_RUN_FINISHED_JOB_KINDS as readonly string[]).includes(job.kind)) {
    return 'trigger_config.job.kind must be one of stock_prep_pull, pipeline'
  }
  if (job.kind === 'pipeline') {
    if (job.actionId !== undefined) return 'trigger_config.job.actionId is not accepted for kind pipeline'
    if (typeof job.pipelineId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(job.pipelineId)) {
      return 'trigger_config.job.pipelineId is required for kind pipeline (an identifier, 1..128 of A-Z a-z 0-9 _ : . -)'
    }
  } else {
    if (job.pipelineId !== undefined) return 'trigger_config.job.pipelineId is not accepted for kind stock_prep_pull'
    if (job.actionId !== undefined && (typeof job.actionId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(job.actionId))) {
      return 'trigger_config.job.actionId must be an identifier when present'
    }
  }
  if (config.statuses !== undefined) {
    if (!Array.isArray(config.statuses) || config.statuses.length === 0) return 'trigger_config.statuses must be a non-empty array when present'
    const seen = new Set<string>()
    for (const status of config.statuses) {
      if (typeof status !== 'string' || !(INTEGRATION_RUN_FINISHED_STATUSES as readonly string[]).includes(status)) {
        return `trigger_config.statuses entries must be among ${INTEGRATION_RUN_FINISHED_STATUSES.join(', ')}`
      }
      if (seen.has(status)) return 'trigger_config.statuses must not repeat a status'
      seen.add(status)
    }
  }
  return null
}

/** The statuses a persisted rule alerts on (omitted / invalid persisted value ⇒ the default set, fail-safe). */
export function integrationRunFinishedConfiguredStatuses(config: unknown): ReadonlySet<string> {
  const raw = isPlainRecord(config) ? config.statuses : undefined
  if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string' && (INTEGRATION_RUN_FINISHED_STATUSES as readonly string[]).includes(s))) {
    return new Set(raw as string[])
  }
  return new Set(INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES)
}

export interface AutomationTrigger {
  type: AutomationTriggerType
  config: Record<string, unknown>
}

/**
 * Map from EventBus event names to trigger types.
 */
export const TRIGGER_TYPE_BY_EVENT: Record<string, AutomationTriggerType> = {
  'multitable.record.created': 'record.created',
  'multitable.record.updated': 'record.updated',
  'multitable.record.deleted': 'record.deleted',
  'multitable.form.submitted': 'form.submitted',
}

/**
 * Check if a trigger matches an incoming event.
 */
export function matchesTrigger(
  trigger: AutomationTrigger,
  eventTriggerType: AutomationTriggerType,
  payload: { data?: Record<string, unknown>; changes?: Record<string, unknown> },
): boolean {
  if (trigger.type === 'field.value_changed') {
    // field.value_changed only fires on record.updated events
    if (eventTriggerType !== 'record.updated') return false
    const config = trigger.config as Partial<FieldValueChangedConfig>
    const fieldId = config.fieldId
    if (!fieldId) return false
    const changes = payload.changes ?? payload.data ?? {}
    if (!(fieldId in changes)) return false

    if (config.condition === 'equals' && config.value !== undefined) {
      return changes[fieldId] === config.value
    }
    if (config.condition === 'changed_to' && config.value !== undefined) {
      return changes[fieldId] === config.value
    }
    // 'any' or unspecified — field just needs to be present in changes
    return true
  }

  return trigger.type === eventTriggerType
}
