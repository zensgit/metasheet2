import { isClassAExecutionClaimEnabled } from './automation-execution-ledger'
import { isClassBOutboundEnabled } from './automation-outbound-intent'
import { enumerateRuleActions } from './automation-rule-fingerprint'

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
