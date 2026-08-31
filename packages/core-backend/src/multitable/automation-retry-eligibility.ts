import { isClassAExecutionClaimEnabled } from './automation-execution-ledger'
import {
  EVENT_DEDUP_LEDGER_SWEEP_INTERVAL_MS,
  EVENT_DEDUP_RETENTION_DAYS,
} from './automation-event-dedup'
import { isClassBOutboundEnabled } from './automation-outbound-intent'
import { enumerateRuleActions } from './automation-rule-fingerprint'

export const AUTOMATION_RETRY_LEDGER_RETENTION_DAYS = EVENT_DEDUP_RETENTION_DAYS
export const AUTOMATION_RETRY_LEDGER_RETENTION_MS = AUTOMATION_RETRY_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000
export const AUTOMATION_RETRY_LEDGER_SWEEP_INTERVAL_MS = EVENT_DEDUP_LEDGER_SWEEP_INTERVAL_MS

export function automationRetryLedgerRetentionCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - AUTOMATION_RETRY_LEDGER_RETENTION_MS).toISOString()
}

const CLASS_A_ACTION_TYPES: ReadonlySet<string> = new Set([
  'create_record',
  'update_record',
  'delete_record',
  'lock_record',
])

const CLASS_B_ACTION_TYPES: ReadonlySet<string> = new Set([
  'send_webhook',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'send_dingtalk_approval_card',
])

const REAL_FIRE_CONTROL_ACTION_TYPES: ReadonlySet<string> = new Set([
  'condition_branch',
  'parallel_branch',
  'wait_for_callback',
  'start_approval',
  'record_click',
])

export type RealFireTestRunEligibility =
  | { ok: true }
  | {
    ok: false
    code:
      | 'TEST_RUN_ACTION_UNSUPPORTED'
      | 'TEST_RUN_CLASS_A_PROTECTION_DISABLED'
      | 'TEST_RUN_CLASS_B_PROTECTION_DISABLED'
  }

/**
 * #4196 §6 real-fire admission. Every action is inspected, including branch children. Later action
 * families that are absent from #4196 (currently FWB) remain fail-closed until their own lock admits
 * test-run dispatch; non-durable send_notification is explicitly forbidden by Q-A.
 */
export function realFireTestRunEligibility(
  actions: ReadonlyArray<{ type: string; config?: unknown }> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RealFireTestRunEligibility {
  let needsClassA = false
  let needsClassB = false
  for (const { action } of enumerateRuleActions(actions)) {
    if (CLASS_A_ACTION_TYPES.has(action.type)) {
      needsClassA = true
      continue
    }
    if (CLASS_B_ACTION_TYPES.has(action.type)) {
      needsClassB = true
      continue
    }
    if (!REAL_FIRE_CONTROL_ACTION_TYPES.has(action.type)) {
      return { ok: false, code: 'TEST_RUN_ACTION_UNSUPPORTED' }
    }
  }
  if (needsClassA && !isClassAExecutionClaimEnabled(env)) {
    return { ok: false, code: 'TEST_RUN_CLASS_A_PROTECTION_DISABLED' }
  }
  if (needsClassB && !isClassBOutboundEnabled(env)) {
    return { ok: false, code: 'TEST_RUN_CLASS_B_PROTECTION_DISABLED' }
  }
  return { ok: true }
}

export interface RetryLedgerFamilies {
  classA: boolean
  classB: boolean
}

export type RetryEvidenceQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export async function claimFirstAutomationRetryAttempt(
  query: RetryEvidenceQueryFn,
  rootExecutionId: string,
): Promise<boolean> {
  const result = await query(
    `WITH claimed AS (
       UPDATE multitable_automation_executions
          SET first_retry_attempted_at = NOW()
        WHERE id = $1
          AND first_retry_attempted_at IS NULL
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM claimed) AS first_retry_attempt`,
    [rootExecutionId],
  )
  return (result.rows[0] as { first_retry_attempt?: unknown } | undefined)?.first_retry_attempt === true
}

export function isWithinAutomationRetryWindow(triggeredAt: string, nowMs = Date.now()): boolean {
  const triggeredAtMs = Date.parse(triggeredAt)
  if (!Number.isFinite(triggeredAtMs) || !Number.isFinite(nowMs)) return false
  const ageMs = nowMs - triggeredAtMs
  return ageMs >= 0 && ageMs <= AUTOMATION_RETRY_LEDGER_RETENTION_MS
}

export function retryLedgerFamiliesForActions(
  actions: ReadonlyArray<{ type: string; config?: unknown }> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RetryLedgerFamilies {
  let hasClassAAction = false
  let hasClassBAction = false
  for (const { action } of enumerateRuleActions(actions)) {
    hasClassAAction ||= CLASS_A_ACTION_TYPES.has(action.type)
    hasClassBAction ||= CLASS_B_ACTION_TYPES.has(action.type)
  }
  return {
    classA: hasClassAAction && isClassAExecutionClaimEnabled(env),
    classB: hasClassBAction && isClassBOutboundEnabled(env),
  }
}

export async function hasAutomationRetryLedgerEvidence(
  query: RetryEvidenceQueryFn,
  rootExecutionId: string,
  families: RetryLedgerFamilies,
): Promise<boolean> {
  if (!families.classA && !families.classB) return true
  const result = await query(
    `SELECT EXISTS (
       SELECT 1
         FROM meta_automation_action_applied
        WHERE kind = 'execution'
          AND root_execution_id = $1
     ) AS has_class_a_evidence,
     EXISTS (
       SELECT 1
         FROM meta_automation_outbound_intent
        WHERE kind = 'execution'
          AND root_execution_id = $1
     ) AS has_class_b_evidence`,
    [rootExecutionId],
  )
  const row = result.rows[0] as {
    has_class_a_evidence?: unknown
    has_class_b_evidence?: unknown
  } | undefined
  return (
    (!families.classA || row?.has_class_a_evidence === true)
    && (!families.classB || row?.has_class_b_evidence === true)
  )
}
