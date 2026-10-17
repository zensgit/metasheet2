import { AUTOMATION_READ_ACTION_TYPE, deriveAutomationReadOperationPolicy } from './automation-read-operation-policy'

export const AUTOMATION_READ_AUTHORING_INVALID = 'AUTOMATION_READ_AUTHORING_INVALID'
export const AUTOMATION_READ_EXECUTION_UNAVAILABLE = 'AUTOMATION_READ_EXECUTION_UNAVAILABLE'

export type AutomationReadAuthoringShape = {
  actionType: unknown
  actionConfig: unknown
  actions: unknown
  executionMode: unknown
  triggerType: unknown
}

function value(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined
  const property = Object.getOwnPropertyDescriptor(object, key)
  return property && Object.hasOwn(property, 'value') ? property.value : undefined
}

/** Only executable action-node paths, never arbitrary JSON/text in an old config.
 * The stored legacy pair is inspected too, even if a modern list currently masks
 * it: clearing that list must not revive a hidden read action in an old branch.
 */
export function containsAutomationReadAction(actionType: unknown, actionConfig: unknown, actions: unknown): boolean {
  const pending: unknown[] = [{ type: actionType, config: actionConfig }]
  if (Array.isArray(actions)) for (const action of actions) pending.push(action)
  const visited = new Set<object>()
  while (pending.length) {
    const action = pending.pop()
    if (!action || typeof action !== 'object' || visited.has(action)) continue
    visited.add(action)
    const type = value(action, 'type')
    if (type === AUTOMATION_READ_ACTION_TYPE) return true
    if (type !== 'condition_branch' && type !== 'parallel_branch') continue
    const config = value(action, 'config')
    const branches = value(config, 'branches')
    if (Array.isArray(branches)) for (const branch of branches) {
      const children = value(branch, 'actions')
      if (Array.isArray(children)) for (const child of children) pending.push(child)
    }
    if (type === 'condition_branch') {
      const children = value(value(config, 'defaultBranch'), 'actions')
      if (Array.isArray(children)) for (const child of children) pending.push(child)
    }
  }
  return false
}

/** Save eligibility only. It creates no grant and cannot call a source/runtime.
 * Call with raw create material or the full merged update, BEFORE normalization.
 * The database independently enforces the same final-row predicate under races.
 */
export function validAutomationReadAuthoringShape(input: AutomationReadAuthoringShape): boolean {
  if (!containsAutomationReadAction(input.actionType, input.actionConfig, input.actions)) return true
  try {
    deriveAutomationReadOperationPolicy({
      actionType: input.actionType,
      actionConfig: input.actionConfig,
      actions: input.actions === undefined ? null : input.actions,
      executionMode: input.executionMode === undefined ? null : input.executionMode,
      triggerType: input.triggerType,
    } as Parameters<typeof deriveAutomationReadOperationPolicy>[0])
    return true
  } catch {
    return false
  }
}
