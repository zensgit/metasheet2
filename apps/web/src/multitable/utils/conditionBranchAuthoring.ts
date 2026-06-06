// A6-3-2a — pure save/load seam for the `condition_branch` editor (contained; unit-testable).
//
// Invariant (the non-negotiable): a loaded `condition_branch` config is only ever EDITED when the v1
// UI can faithfully round-trip it — `buildConditionBranchConfig(parseConditionBranchDraft(config))`
// is semantically equal to `config`. Anything the v1 UI cannot represent losslessly
// (nested condition groups, non-string `update_record` values, comma/whitespace-bearing `userIds`,
// branch action types outside the simple subset, `wait_for_callback`/nested `condition_branch`)
// returns a non-null `conditionBranchUnsupportedReason` → the editor opens read-only and never
// flattens. Mirrors the backend `validateConditionBranchConfig` boundaries (SAFE_BRANCH_KEY,
// no wait/nesting in branches).
import type {
  AutomationAction,
  AutomationActionType,
  AutomationCondition,
} from '../types'

// Mirror of backend automation-service.ts SAFE_BRANCH_KEY.
export const SAFE_BRANCH_KEY = /^[A-Za-z0-9_-]{1,64}$/

// The v1 subset of action types authorable INSIDE a branch (simple, round-trippable config).
export const BRANCH_AUTHORABLE_ACTION_TYPES = ['update_record', 'send_notification'] as const
export type BranchAuthorableActionType = (typeof BRANCH_AUTHORABLE_ACTION_TYPES)[number]

export interface BranchActionDraft {
  type: BranchAuthorableActionType
  fieldUpdates?: Array<{ fieldId: string; value: string }> // update_record
  userId?: string // send_notification (comma/space-joined)
  message?: string // send_notification
}
export interface BranchDraft {
  key: string
  label: string
  conjunction: 'AND' | 'OR'
  conditions: AutomationCondition[] // flat only (reuses the rule-level condition-row handlers)
  actions: BranchActionDraft[]
}
export interface DefaultBranchDraft {
  key: string
  label: string
  actions: BranchActionDraft[]
}
export interface ConditionBranchDraft {
  branches: BranchDraft[]
  defaultBranch: DefaultBranchDraft | null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// ---- round-trip checks for the simple-action subset ----

const UPDATE_RECORD_ALLOWED_KEYS = new Set(['fields'])
function updateRecordRoundTrippable(config: unknown): boolean {
  if (!isPlainRecord(config)) return false
  // Extra keys can't be represented by the field-pair UI → not lossless.
  if (Object.keys(config).some((k) => !UPDATE_RECORD_ALLOWED_KEYS.has(k))) return false
  const fields = config.fields
  if (fields === undefined) return true
  if (!isPlainRecord(fields)) return false
  // The UI edits values as strings; non-string values would be coerced (lossy).
  return Object.values(fields).every((v) => typeof v === 'string')
}

const SEND_NOTIFICATION_ALLOWED_KEYS = new Set(['userIds', 'message'])
const SIMPLE_USER_ID = /^[^\s,]+$/ // join(', ')/split round-trips only comma/whitespace-free tokens
function sendNotificationRoundTrippable(config: unknown): boolean {
  if (!isPlainRecord(config)) return false
  if (Object.keys(config).some((k) => !SEND_NOTIFICATION_ALLOWED_KEYS.has(k))) return false
  const userIds = config.userIds
  if (userIds !== undefined) {
    if (!Array.isArray(userIds)) return false
    if (!userIds.every((u) => typeof u === 'string' && SIMPLE_USER_ID.test(u))) return false
  }
  if (config.message !== undefined && typeof config.message !== 'string') return false
  return true
}

function branchActionRoundTrippable(action: unknown): boolean {
  if (!isPlainRecord(action)) return false
  if (action.type === 'update_record') return updateRecordRoundTrippable(action.config)
  if (action.type === 'send_notification') return sendNotificationRoundTrippable(action.config)
  // outside the subset (incl. wait_for_callback / nested condition_branch) → read-only
  return false
}

function conditionGroupIsFlat(group: unknown): boolean {
  if (group === undefined || group === null) return true
  if (!isPlainRecord(group)) return false
  const conditions = group.conditions
  if (conditions === undefined) return true
  if (!Array.isArray(conditions)) return false
  // every child must be a flat AutomationCondition (no nested ConditionGroup)
  return conditions.every(
    (c) => isPlainRecord(c) && typeof c.fieldId === 'string' && !('conditions' in c),
  )
}

/**
 * Returns a human-readable reason the loaded `condition_branch` config cannot be faithfully edited
 * by the v1 UI (→ read-only), or `null` if it round-trips losslessly (→ editable). PURE; never mutates.
 */
export function conditionBranchUnsupportedReason(config: unknown): string | null {
  if (!isPlainRecord(config)) return null // empty / brand-new action → editable as fresh
  const branches = config.branches
  if (branches !== undefined && !Array.isArray(branches)) return 'branches must be an array'
  for (const branch of Array.isArray(branches) ? branches : []) {
    if (!isPlainRecord(branch)) return 'a branch is not an object'
    if (!conditionGroupIsFlat(branch.conditions)) return 'a branch uses a nested condition group'
    for (const action of Array.isArray(branch.actions) ? branch.actions : []) {
      if (!branchActionRoundTrippable(action)) return 'a branch action is outside the v1 editable set'
    }
  }
  const def = config.defaultBranch
  if (def !== undefined && def !== null) {
    if (!isPlainRecord(def)) return 'defaultBranch is not an object'
    for (const action of Array.isArray(def.actions) ? def.actions : []) {
      if (!branchActionRoundTrippable(action)) return 'a default-branch action is outside the v1 editable set'
    }
  }
  return null
}

// ---- parse (load) / build (save) ----

function actionToDraft(action: AutomationAction): BranchActionDraft {
  if (action.type === 'update_record') {
    const fields = isPlainRecord(action.config.fields) ? action.config.fields : {}
    return {
      type: 'update_record',
      fieldUpdates: Object.entries(fields).map(([fieldId, value]) => ({ fieldId, value: String(value ?? '') })),
    }
  }
  const userIds = Array.isArray(action.config.userIds) ? action.config.userIds : []
  return {
    type: 'send_notification',
    userId: userIds.map((u) => String(u)).join(', '),
    message: typeof action.config.message === 'string' ? action.config.message : '',
  }
}

function draftToAction(action: BranchActionDraft): AutomationAction {
  if (action.type === 'update_record') {
    const fields: Record<string, string> = {}
    for (const pair of action.fieldUpdates ?? []) {
      const fieldId = pair.fieldId.trim()
      if (fieldId) fields[fieldId] = pair.value
    }
    return { type: 'update_record', config: { fields } }
  }
  return {
    type: 'send_notification',
    config: {
      userIds: (action.userId ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      message: (action.message ?? '').trim(),
    },
  }
}

/** Load an editable config into draft form. Only safe when `conditionBranchUnsupportedReason` is null. */
export function parseConditionBranchDraft(config: Record<string, unknown>): ConditionBranchDraft {
  const branches = (Array.isArray(config.branches) ? config.branches : []).map((raw): BranchDraft => {
    const b = isPlainRecord(raw) ? raw : {}
    const group = isPlainRecord(b.conditions) ? b.conditions : {}
    const conjunction = group.conjunction === 'OR' || group.logic === 'or' ? 'OR' : 'AND'
    return {
      key: typeof b.key === 'string' ? b.key : '',
      label: typeof b.label === 'string' ? b.label : '',
      conjunction,
      conditions: (Array.isArray(group.conditions) ? group.conditions : []) as AutomationCondition[],
      actions: (Array.isArray(b.actions) ? b.actions : []).map((a) => actionToDraft(a as AutomationAction)),
    }
  })
  const def = isPlainRecord(config.defaultBranch) ? config.defaultBranch : null
  const defaultBranch: DefaultBranchDraft | null = def
    ? {
        key: typeof def.key === 'string' ? def.key : '',
        label: typeof def.label === 'string' ? def.label : '',
        actions: (Array.isArray(def.actions) ? def.actions : []).map((a) => actionToDraft(a as AutomationAction)),
      }
    : null
  return { branches, defaultBranch }
}

/** Build the executor-shaped config from draft. `conjunction` is the canonical form (mirrors the rule editor). */
export function buildConditionBranchConfig(draft: ConditionBranchDraft): Record<string, unknown> {
  const branches = draft.branches.map((b) => ({
    key: b.key.trim(),
    ...(b.label.trim() ? { label: b.label.trim() } : {}),
    conditions: { conjunction: b.conjunction, conditions: b.conditions },
    actions: b.actions.map(draftToAction),
  }))
  const config: Record<string, unknown> = { branches }
  if (draft.defaultBranch) {
    config.defaultBranch = {
      key: draft.defaultBranch.key.trim(),
      ...(draft.defaultBranch.label.trim() ? { label: draft.defaultBranch.label.trim() } : {}),
      actions: draft.defaultBranch.actions.map(draftToAction),
    }
  }
  return config
}

/** Frontend mirror of the backend branch-key rules: safe, non-empty, unique (incl. default vs branches). */
export function validateConditionBranchKeys(draft: ConditionBranchDraft): string | null {
  if (draft.branches.length === 0) return 'at least one branch is required'
  const seen = new Set<string>()
  for (const branch of draft.branches) {
    const key = branch.key.trim()
    if (!SAFE_BRANCH_KEY.test(key)) return `branch key "${branch.key}" must be 1-64 of [A-Za-z0-9_-]`
    if (seen.has(key)) return `branch key "${key}" must be unique`
    seen.add(key)
  }
  if (draft.defaultBranch) {
    const key = draft.defaultBranch.key.trim()
    if (!SAFE_BRANCH_KEY.test(key)) return `default branch key "${draft.defaultBranch.key}" must be 1-64 of [A-Za-z0-9_-]`
    if (seen.has(key)) return `default branch key "${key}" must be unique`
  }
  return null
}

export function isBranchAuthorableActionType(type: AutomationActionType): type is BranchAuthorableActionType {
  return (BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).includes(type)
}
