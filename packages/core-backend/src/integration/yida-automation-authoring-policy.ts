import { types } from 'node:util'
import { scheduleIntervalMs } from '../multitable/automation-triggers'

export const YIDA_AUTOMATION_ACTION_TYPE = 'integration_yida_send_authorized'
export const YIDA_AUTOMATION_AUTHORING_INVALID = 'YIDA_AUTOMATION_AUTHORING_INVALID'
export const YIDA_AUTOMATION_EXECUTION_UNAVAILABLE = 'YIDA_AUTOMATION_EXECUTION_UNAVAILABLE'

export type YidaIntervalOccurrence = Readonly<{ ruleId: string; triggerType: 'schedule.interval';
  scheduledAtMs: number; anchorMs: number; intervalMs: number }>

/** Description from the existing scheduler, not an authorization or owner. */
export function checkedYidaIntervalOccurrence(input: unknown): YidaIntervalOccurrence {
  const row = object(input, ['ruleId', 'triggerType', 'scheduledAtMs', 'anchorMs', 'intervalMs'])
  const { ruleId, triggerType, scheduledAtMs, anchorMs, intervalMs } = row
  if (typeof ruleId !== 'string' || !ruleId || ruleId.length > 128 || ruleId.trim() !== ruleId
    || /[\u0000-\u001f\u007f]/u.test(ruleId) || triggerType !== 'schedule.interval'
    || typeof scheduledAtMs !== 'number' || typeof anchorMs !== 'number' || typeof intervalMs !== 'number'
    || !Number.isSafeInteger(scheduledAtMs) || !Number.isSafeInteger(anchorMs) || !Number.isSafeInteger(intervalMs)
    || anchorMs <= 0 || scheduledAtMs <= anchorMs || scheduledAtMs > 8640000000000000
    || intervalMs < 1000 || intervalMs > 2147483647 || (scheduledAtMs - anchorMs) % intervalMs !== 0) {
    throw new Error(YIDA_AUTOMATION_AUTHORING_INVALID)
  }
  return Object.freeze({ ruleId, triggerType, scheduledAtMs, anchorMs, intervalMs })
}
type Shape = { actionType: unknown; actionConfig: unknown; actions: unknown; executionMode: unknown;
  triggerType: unknown; triggerConfig: unknown; conditions: unknown }
function value(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input)) return undefined
  const d = Object.getOwnPropertyDescriptor(input, key)
  return d && Object.hasOwn(d, 'value') ? d.value : undefined
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) throw new Error(YIDA_AUTOMATION_AUTHORING_INVALID)
  const proto = Object.getPrototypeOf(input), d = Object.getOwnPropertyDescriptors(input)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(d).length !== keys.length) throw new Error(YIDA_AUTOMATION_AUTHORING_INVALID)
  return Object.fromEntries(keys.map(key => {
    if (!d[key]?.enumerable || !Object.hasOwn(d[key], 'value')) throw new Error(YIDA_AUTOMATION_AUTHORING_INVALID)
    return [key, d[key].value]
  }))
}
function empty(input: unknown) {
  return input === null || input === undefined || Array.isArray(input) && !types.isProxy(input)
    && Object.getPrototypeOf(input) === Array.prototype && input.length === 0 && Reflect.ownKeys(input).length === 1
}
/** Inspect only executable branch paths, including the stored legacy pair.
 * A private node hidden after a write/inside a branch must refuse the WHOLE
 * ordinary execution before conditions, jobs or any earlier action runs. */
export function containsYidaAutomationAction(actionType: unknown, actionConfig: unknown, actions: unknown): boolean {
  const pending: unknown[] = [{ type: actionType, config: actionConfig }], seen = new Set<object>()
  if (Array.isArray(actions) && !types.isProxy(actions)) pending.push(...actions)
  while (pending.length) {
    const action = pending.pop()
    if (!action || typeof action !== 'object' || types.isProxy(action) || seen.has(action)) continue
    seen.add(action)
    const type = value(action, 'type')
    if (type === YIDA_AUTOMATION_ACTION_TYPE) return true
    if (type !== 'condition_branch' && type !== 'parallel_branch') continue
    const config = value(action, 'config'), branches = value(config, 'branches')
    if (Array.isArray(branches) && !types.isProxy(branches)) for (const branch of branches) {
      const children = value(branch, 'actions')
      if (Array.isArray(children) && !types.isProxy(children)) pending.push(...children)
    }
    const fallback = type === 'condition_branch' ? value(value(config, 'defaultBranch'), 'actions') : null
    if (Array.isArray(fallback) && !types.isProxy(fallback)) pending.push(...fallback)
  }
  return false
}
/** Authoring only. A stable opaque slot is NOT a grant, owner, tenant or permit.
 * Validate raw create or the complete merged update BEFORE normalization. */
export function validYidaAutomationAuthoringShape(input: Shape): boolean {
  if (!containsYidaAutomationAction(input.actionType, input.actionConfig, input.actions)) return true
  try {
    const config = object(input.actionConfig, ['authorizationSlot']), slot = config.authorizationSlot
    if (input.actionType !== YIDA_AUTOMATION_ACTION_TYPE || typeof slot !== 'string' || !slot || slot.length > 128
      || slot.trim() !== slot || /[\u0000-\u001f\u007f]/u.test(slot) || !empty(input.conditions)
      || input.executionMode !== undefined && input.executionMode !== null && input.executionMode !== 'legacy'
      || input.triggerType !== 'schedule.interval' || scheduleIntervalMs(input.triggerConfig, true) === null) return false
    if (empty(input.actions)) return true
    if (!Array.isArray(input.actions) || types.isProxy(input.actions) || Object.getPrototypeOf(input.actions) !== Array.prototype
      || input.actions.length !== 1 || Reflect.ownKeys(input.actions).length !== 2) return false
    const d = Object.getOwnPropertyDescriptor(input.actions, '0')
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false
    const action = object(d.value, ['type', 'config'])
    return action.type === YIDA_AUTOMATION_ACTION_TYPE && object(action.config, ['authorizationSlot']).authorizationSlot === slot
  } catch { return false }
}
