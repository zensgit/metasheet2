// 客户反馈 2026-10-27 4d — "possible duplicate rule" check for the advanced rule editor's save.
//
// Every enabled rule on a sheet runs on its own (the backend never de-duplicates across rules), so
// two rules with the same trigger and the same actions send the same notification twice. That is
// correct behaviour — the host only ASKS before saving such a rule; it never refuses the save.
//
// Pure module (no Vue, no component state): the manager hands in the payload the editor is about to
// save plus the rules it already has loaded for this sheet.
//
// What counts as "the same":
//   - same trigger type;
//   - same trigger config (key order ignored; primitive arrays compared as sets; undefined dropped);
//   - same rule-level conditions (no conditions == empty list). Two rules that only differ in their
//     conditions (e.g. 状态=A vs 状态=B) do not fire together, so they are not reported;
//   - same SET of top-level action types (legacy aliases folded: notify → send_notification,
//     update_field → update_record);
//   - when a send_notification action is present: the same set of notification recipients.
// Not compared: rule name, enabled state of the draft, actions nested inside branches.
// Only ENABLED existing rules are compared — a disabled rule does not fire, so it cannot double up.
// `webhook.received` is skipped: each such rule has its own endpoint, and an edit may omit the
// trigger config entirely (keep-stored-secret), so there is nothing meaningful to compare.

import type { AutomationAction, AutomationActionType, AutomationRule } from '../types'

type RuleLike = Pick<AutomationRule, 'triggerType' | 'triggerConfig' | 'actionType' | 'actionConfig'> & {
  trigger?: AutomationRule['trigger']
  conditions?: AutomationRule['conditions']
  actions?: AutomationAction[]
}

const ACTION_TYPE_ALIASES: Partial<Record<AutomationActionType, AutomationActionType>> = {
  notify: 'send_notification',
  update_field: 'update_record',
}

function canonicalActionType(type: AutomationActionType): AutomationActionType {
  return ACTION_TYPE_ALIASES[type] ?? type
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stable form for deep comparison: sorted keys, undefined dropped, primitive arrays sorted. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize)
    const allPrimitive = items.every((item) => item === null || typeof item !== 'object')
    return allPrimitive ? [...items].sort((a, b) => String(a).localeCompare(String(b))) : items
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry === undefined) continue
      out[key] = canonicalize(entry)
    }
    return out
  }
  return value
}

function triggerConfigOf(rule: Partial<RuleLike>): Record<string, unknown> {
  if (isPlainObject(rule.triggerConfig)) return rule.triggerConfig
  if (rule.trigger && isPlainObject(rule.trigger.config)) return rule.trigger.config
  return {}
}

function triggerTypeOf(rule: Partial<RuleLike>): string {
  return rule.triggerType ?? rule.trigger?.type ?? ''
}

function conditionsOf(rule: Partial<RuleLike>): unknown[] {
  const conditions = rule.conditions?.conditions
  return Array.isArray(conditions) ? conditions : []
}

function conditionConjunctionOf(rule: Partial<RuleLike>): string {
  const raw = rule.conditions?.conjunction ?? rule.conditions?.logic ?? 'AND'
  return String(raw).toUpperCase()
}

function actionsOf(rule: Partial<RuleLike>): Array<{ type: AutomationActionType; config: Record<string, unknown> }> {
  if (Array.isArray(rule.actions) && rule.actions.length > 0) {
    return rule.actions.map((action) => ({
      type: action.type,
      config: isPlainObject(action.config) ? action.config : {},
    }))
  }
  if (rule.actionType) {
    return [{ type: rule.actionType, config: isPlainObject(rule.actionConfig) ? rule.actionConfig : {} }]
  }
  return []
}

function notificationRecipientIds(config: Record<string, unknown>): string[] {
  if (Array.isArray(config.userIds)) {
    return config.userIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean)
  }
  if (typeof config.userId === 'string') {
    return config.userId.split(/[\s,，;；]+/).map((id) => id.trim()).filter(Boolean)
  }
  return []
}

interface RuleFingerprint {
  triggerType: string
  triggerConfig: string
  conditions: string
  actionTypes: string
  notificationRecipients: string
}

function fingerprint(rule: Partial<RuleLike>): RuleFingerprint {
  const actions = actionsOf(rule)
  const actionTypes = Array.from(new Set(actions.map((action) => canonicalActionType(action.type)))).sort()
  const recipients = new Set<string>()
  for (const action of actions) {
    if (canonicalActionType(action.type) !== 'send_notification') continue
    for (const id of notificationRecipientIds(action.config)) recipients.add(id)
  }
  const conditions = conditionsOf(rule)
  return {
    triggerType: triggerTypeOf(rule),
    triggerConfig: JSON.stringify(canonicalize(triggerConfigOf(rule))),
    // The conjunction only matters once there are two or more conditions.
    conditions: JSON.stringify([conditions.length > 1 ? conditionConjunctionOf(rule) : '', canonicalize(conditions)]),
    actionTypes: actionTypes.join('|'),
    notificationRecipients: Array.from(recipients).sort().join('|'),
  }
}

export interface FindDuplicateRuleOptions {
  /** The rule being edited — never reported as a duplicate of itself. */
  excludeRuleId?: string | null
}

/**
 * Returns the first ENABLED existing rule whose trigger + conditions + action types (+ notification
 * recipients) match the payload about to be saved, or null when there is none.
 */
export function findDuplicateAutomationRule<T extends Partial<RuleLike> & { id: string; enabled?: boolean }>(
  payload: Partial<RuleLike>,
  existingRules: readonly T[],
  options: FindDuplicateRuleOptions = {},
): T | null {
  const draftTriggerType = triggerTypeOf(payload)
  if (!draftTriggerType || draftTriggerType === 'webhook.received') return null
  const draft = fingerprint(payload)
  if (!draft.actionTypes) return null
  for (const rule of existingRules) {
    if (options.excludeRuleId && rule.id === options.excludeRuleId) continue
    if (rule.enabled === false) continue
    const other = fingerprint(rule)
    if (
      other.triggerType === draft.triggerType
      && other.triggerConfig === draft.triggerConfig
      && other.conditions === draft.conditions
      && other.actionTypes === draft.actionTypes
      && other.notificationRecipients === draft.notificationRecipients
    ) {
      return rule
    }
  }
  return null
}

export function automationDuplicateRuleConfirmMessage(existingRuleName: string, isZh: boolean): string {
  const name = existingRuleName.trim() || (isZh ? '未命名规则' : 'Untitled rule')
  return isZh
    ? `已有规则『${name}』的触发器和动作相同，仍要保存吗？`
    : `Rule "${name}" already has the same trigger and actions. Save anyway?`
}

export function automationDuplicateRuleConfirmTitle(isZh: boolean): string {
  return isZh ? '可能是重复的规则' : 'Possible duplicate rule'
}

export function automationDuplicateRuleConfirmButton(isZh: boolean): string {
  return isZh ? '仍要保存' : 'Save anyway'
}
