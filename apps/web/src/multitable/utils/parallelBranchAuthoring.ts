// A6-3-4/W3-2a — pure save/load seam for the `parallel_branch` editor.
//
// The v1 UI edits only the join-all, flat branch shape that the backend runtime currently
// supports. Anything richer or lossy opens read-only and is re-emitted verbatim by the editor.
import type {
  AutomationAction,
  AutomationActionType,
} from '../types'
import {
  type BranchActionDraft,
  BRANCH_AUTHORABLE_ACTION_TYPES,
  SAFE_BRANCH_KEY,
} from './conditionBranchAuthoring'

export interface ParallelBranchDraft {
  key: string
  label: string
  actions: BranchActionDraft[]
}

export interface ParallelBranchConfigDraft {
  branches: ParallelBranchDraft[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const UPDATE_RECORD_ALLOWED_KEYS = new Set(['fields'])
function updateRecordRoundTrippable(config: unknown): boolean {
  if (!isPlainRecord(config)) return false
  if (Object.keys(config).some((key) => !UPDATE_RECORD_ALLOWED_KEYS.has(key))) return false
  const fields = config.fields
  if (!isPlainRecord(fields)) return false
  return Object.values(fields).every((value) => typeof value === 'string')
}

const SEND_NOTIFICATION_ALLOWED_KEYS = new Set(['userIds', 'message'])
const SIMPLE_USER_ID = /^[^\s,]+$/
function sendNotificationRoundTrippable(config: unknown): boolean {
  if (!isPlainRecord(config)) return false
  if (Object.keys(config).some((key) => !SEND_NOTIFICATION_ALLOWED_KEYS.has(key))) return false
  const userIds = config.userIds
  if (!Array.isArray(userIds)) return false
  if (!userIds.every((id) => typeof id === 'string' && SIMPLE_USER_ID.test(id))) return false
  return typeof config.message === 'string'
}

function branchActionRoundTrippable(action: unknown): boolean {
  if (!isPlainRecord(action)) return false
  if (Object.keys(action).some((key) => key !== 'type' && key !== 'config')) return false
  if (action.type === 'update_record') return updateRecordRoundTrippable(action.config)
  if (action.type === 'send_notification') return sendNotificationRoundTrippable(action.config)
  return false
}

export function parallelBranchUnsupportedReason(config: unknown): string | null {
  if (!isPlainRecord(config)) return null
  const allowedTopKeys = new Set(['joinMode', 'branches'])
  if (Object.keys(config).some((key) => !allowedTopKeys.has(key))) return 'parallel_branch has unsupported top-level keys'
  if (config.joinMode !== undefined && config.joinMode !== 'all') return 'parallel_branch joinMode must be all'
  const branches = config.branches
  if (branches !== undefined && !Array.isArray(branches)) return 'parallel_branch branches must be an array'
  for (const branch of Array.isArray(branches) ? branches : []) {
    if (!isPlainRecord(branch)) return 'a parallel branch is not an object'
    const allowedBranchKeys = new Set(['key', 'label', 'actions'])
    if (Object.keys(branch).some((key) => !allowedBranchKeys.has(key))) return 'a parallel branch has unsupported keys'
    if (branch.label !== undefined && typeof branch.label !== 'string') return 'a parallel branch label is not a string'
    if (!Array.isArray(branch.actions)) return 'a parallel branch actions value is not an array'
    if (branch.actions.length === 0) return 'a parallel branch has no actions'
    for (const action of branch.actions) {
      if (!branchActionRoundTrippable(action)) return 'a parallel branch action is outside the v1 editable set'
    }
  }
  return null
}

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
    userId: userIds.map((id) => String(id)).join(', '),
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
        .map((id) => id.trim())
        .filter(Boolean),
      message: (action.message ?? '').trim(),
    },
  }
}

export function parseParallelBranchDraft(config: Record<string, unknown>): ParallelBranchConfigDraft {
  const branches = (Array.isArray(config.branches) ? config.branches : []).map((raw): ParallelBranchDraft => {
    const branch = isPlainRecord(raw) ? raw : {}
    return {
      key: typeof branch.key === 'string' ? branch.key : '',
      label: typeof branch.label === 'string' ? branch.label : '',
      actions: (Array.isArray(branch.actions) ? branch.actions : []).map((action) => actionToDraft(action as AutomationAction)),
    }
  })
  return { branches }
}

export function buildParallelBranchConfig(draft: ParallelBranchConfigDraft): Record<string, unknown> {
  return {
    joinMode: 'all',
    branches: draft.branches.map((branch) => ({
      key: branch.key.trim(),
      ...(branch.label.trim() ? { label: branch.label.trim() } : {}),
      actions: branch.actions.map(draftToAction),
    })),
  }
}

export function validateParallelBranchKeys(draft: ParallelBranchConfigDraft): string | null {
  if (draft.branches.length === 0) return 'at least one branch is required'
  if (draft.branches.length > 10) return 'at most 10 branches are allowed'
  let totalActions = 0
  const seen = new Set<string>()
  for (const branch of draft.branches) {
    const key = branch.key.trim()
    if (!SAFE_BRANCH_KEY.test(key)) return `branch key "${branch.key}" must be 1-64 of [A-Za-z0-9_-]`
    if (seen.has(key)) return `branch key "${key}" must be unique`
    seen.add(key)
    if (branch.actions.length === 0) return `branch "${key}" must contain at least one action`
    totalActions += branch.actions.length
    if (totalActions > 20) return 'at most 20 branch actions are allowed'
  }
  return null
}

function userIdsFromDraft(action: BranchActionDraft): string[] {
  return (action.userId ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean)
}

export function validateParallelBranchActions(draft: ParallelBranchConfigDraft): string | null {
  for (const branch of draft.branches) {
    const key = branch.key.trim() || '(unnamed)'
    for (const action of branch.actions) {
      if (action.type === 'update_record') {
        const hasField = (action.fieldUpdates ?? []).some((pair) => pair.fieldId.trim())
        if (!hasField) return `branch "${key}" update_record must set at least one field`
      } else if (action.type === 'send_notification') {
        if (userIdsFromDraft(action).length === 0) return `branch "${key}" send_notification must include at least one user`
        if (!(action.message ?? '').trim()) return `branch "${key}" send_notification must include a message`
      }
    }
  }
  return null
}

export function isParallelBranchAuthorableActionType(type: AutomationActionType): boolean {
  return (BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).includes(type)
}
