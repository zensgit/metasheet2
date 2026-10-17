import { AutomationReadLedgerError, checkedReadTriggers, type ReadTrigger } from './automation-read-contracts'
import type { LockedAutomationReadRule } from './automation-read-rule-authority'

export const AUTOMATION_READ_ACTION_TYPE = 'integration_read_preview'
export const AUTOMATION_READ_OPERATION = 'plm.stock-preparation.diff-preview.v1'
export type AutomationReadOperationPolicyInput = Pick<LockedAutomationReadRule,
  'actionType' | 'actionConfig' | 'actions' | 'executionMode' | 'triggerType'>
export type AutomationReadOperationPolicy = Readonly<{
  actionType: typeof AUTOMATION_READ_ACTION_TYPE
  operation: typeof AUTOMATION_READ_OPERATION
  allowManual: boolean
  allowedTriggers: readonly ReadTrigger[]
}>

const scheduleTriggers = new Set(['schedule.cron', 'schedule.interval', 'schedule.date_field'])
const recordTriggers = new Set(['record.created', 'record.updated', 'record.deleted', 'field.value_changed'])
function denied(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') }
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return denied()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return denied()
    return [key, descriptor.value]
  }))
}
function config(value: unknown): { operation: typeof AUTOMATION_READ_OPERATION; allowManual: boolean } {
  const captured = data(value, ['operation', 'allowManual'])
  if (captured.operation !== AUTOMATION_READ_OPERATION || typeof captured.allowManual !== 'boolean') return denied()
  return { operation: AUTOMATION_READ_OPERATION, allowManual: captured.allowManual }
}

/**
 * Pure HOST-PRIVATE policy for ONE read-preview action. The provider must pass
 * these five captured fields from the actual same-transaction rule lock, and
 * bind this policy plus the full raw-rule fingerprint/nonce into authorityKey.
 * This function proves neither creator, tenant, enabled state nor permissions;
 * it does not evaluate record conditions or register a public action/trigger.
 *
 * The public rule config carries only a fixed operation and an explicit manual
 * boolean, never private source/profile selectors. Null/empty modern actions
 * use the matching top-level operation; a populated modern list must contain
 * exactly that one identical action, with no successor or branching material.
 * Existing execution modes are null/'legacy' or 'workflow_job_v1'; only the
 * first two are eligible here. Manual additionally needs the grant's opt-in.
 */
export function deriveAutomationReadOperationPolicy(input: AutomationReadOperationPolicyInput): AutomationReadOperationPolicy {
  try {
    const captured = data(input, ['actionType', 'actionConfig', 'actions', 'executionMode', 'triggerType'])
    if (captured.actionType !== AUTOMATION_READ_ACTION_TYPE
      || (captured.executionMode !== null && captured.executionMode !== 'legacy')) denied()
    const actionConfig = config(captured.actionConfig)
    if (captured.actions !== null) {
      if (!Array.isArray(captured.actions) || Object.getPrototypeOf(captured.actions) !== Array.prototype
        || captured.actions.length > 1 || Reflect.ownKeys(captured.actions).length !== captured.actions.length + 1) denied()
      if (captured.actions.length === 1) {
        const descriptor = Object.getOwnPropertyDescriptor(captured.actions, '0')
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied()
        const action = data(descriptor.value, ['type', 'config'])
        const nestedConfig = config(action.config)
        if (action.type !== AUTOMATION_READ_ACTION_TYPE || nestedConfig.allowManual !== actionConfig.allowManual) denied()
      }
    }
    if (typeof captured.triggerType !== 'string') denied()
    const family: ReadTrigger = scheduleTriggers.has(captured.triggerType) ? 'schedule'
      : recordTriggers.has(captured.triggerType) ? 'record' : denied()
    const allowedTriggers = checkedReadTriggers(actionConfig.allowManual ? ['manual', family] : [family])
    return Object.freeze({ actionType: AUTOMATION_READ_ACTION_TYPE, operation: AUTOMATION_READ_OPERATION,
      allowManual: actionConfig.allowManual, allowedTriggers })
  } catch {
    // Existing/private material must never escape through raw causes or hooks.
    return denied()
  }
}
