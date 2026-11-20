// Integration assistant stage 1a (owner 2026-11-19, register R-99 ③; plan
// docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md §7): a READ-ONLY
// "flow view" of one saved automation rule — a trigger card followed by its actions as linear step cards,
// the way an n8n-style editor shows a workflow top-down.
//
// What this module is: a pure function from a SAVED rule (the backend config shape, not the rule editor's
// draft model) to a display model. No Vue, no component state, no fetches. Field names come in through an
// optional resolver; anything the rule does not carry renders as an explicit placeholder via the shared
// one-line summary module (automationActionSummary.ts — "never fabricate").
//
// What it is NOT: an editor, a save path, or a second interpretation of the rule. Step keys use the
// executor's structural identity verbatim (packages/core-backend/src/multitable/automation-step-key.ts:
// top level `${i}`, branch children `${i}.branch.${key}.${j}` / `${i}.parallel.${key}.${j}`), so a key shown
// here is the key the execution log carries. Unknown action types render their raw type label — the view
// never invents a meaning for a type it does not know.

import {
  summarizeAutomationAction,
  type ActionSummarySnapshot,
} from './automationActionSummary'
import type {
  AutomationAction,
  AutomationActionType,
  AutomationRule,
} from './types'
import {
  automationActionTypeLabel,
  automationCardTriggerSummary,
  automationTriggerTypeLabel,
} from './utils/meta-automation-labels'

export type FlowStepCategory = 'record' | 'message' | 'control' | 'integration' | 'approval' | 'other'

export interface FlowTriggerCard {
  type: string
  label: string
  /** One line describing the trigger's own config; '' when the type carries nothing worth saying. */
  detail: string
}

export interface FlowBranch {
  kind: 'branch' | 'parallel'
  key: string
  /** Author label when present, else the key. */
  label: string
  isDefault: boolean
  steps: FlowStepCard[]
}

export interface FlowStepCard {
  stepKey: string
  type: string
  label: string
  summary: string
  category: FlowStepCategory
  branches: FlowBranch[]
}

/** Stage 1b: one top-level step card in the rule editor's Flow mode, built from the editor's draft. */
export interface FlowEditStep {
  /** The draft action's stable id (draftId) — keeps cards keyed across reorders. */
  id: string
  type: string
  label: string
  /** The same one-line summary the Form mode shows in the action's collapse header. */
  summary: string
  category: FlowStepCategory
}

export interface AutomationFlowModel {
  ruleId: string
  ruleName: string
  enabled: boolean
  trigger: FlowTriggerCard
  /** True when the rule carries a top-level condition group (shown as a gate between trigger and steps). */
  hasRuleConditions: boolean
  steps: FlowStepCard[]
}

export interface AutomationFlowOptions {
  isZh: boolean
  /** Resolves a field id to its display name; defaults to echoing the id. */
  fieldLabel?: (fieldId: string) => string
}

function pick(isZh: boolean, zh: string, en: string): string {
  return isZh ? zh : en
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
}

function countEntries(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0
}

function actionsOf(value: unknown): AutomationAction[] {
  if (!Array.isArray(value)) return []
  return value.filter((a): a is AutomationAction => isRecord(a) && typeof a.type === 'string')
    .map((a) => ({ type: a.type, config: isRecord(a.config) ? a.config : {} }))
}

/** The rule's actions in executor order: the multi-action array when present, else the legacy single pair. */
export function ruleActions(rule: AutomationRule): AutomationAction[] {
  if (Array.isArray(rule.actions) && rule.actions.length > 0) return actionsOf(rule.actions)
  if (typeof rule.actionType === 'string' && rule.actionType) {
    return [{ type: rule.actionType, config: isRecord(rule.actionConfig) ? rule.actionConfig : {} }]
  }
  return []
}

export function flowStepCategory(type: string): FlowStepCategory {
  switch (type) {
    case 'update_record':
    case 'create_record':
    case 'delete_record':
    case 'lock_record':
    case 'update_field':
      return 'record'
    case 'send_webhook':
    case 'send_notification':
    case 'notify':
    case 'send_email':
    case 'send_dingtalk_group_message':
    case 'send_dingtalk_person_message':
    case 'send_dingtalk_approval_card':
      return 'message'
    case 'condition_branch':
    case 'parallel_branch':
    case 'wait_for_callback':
      return 'control'
    case 'run_integration_job':
      return 'integration'
    case 'start_approval':
    case 'write_approval_form_values':
      return 'approval'
    default:
      return 'other'
  }
}

/** Builds the shared one-line-summary snapshot from a SAVED backend config (automation-actions.ts shapes). */
export function savedConfigSnapshot(
  type: AutomationActionType,
  config: Record<string, unknown>,
  fieldLabel: (fieldId: string) => string,
): ActionSummarySnapshot {
  const snapshot: ActionSummarySnapshot = { type }
  switch (type) {
    case 'update_record': {
      const fields = isRecord(config.fields) ? config.fields : {}
      snapshot.updateRecord = {
        fieldUpdates: Object.entries(fields).map(([fieldId, value]) => ({
          fieldLabel: fieldLabel(fieldId),
          value: typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value),
        })),
      }
      break
    }
    case 'create_record':
      snapshot.createRecord = { targetSheetId: str(config.sheetId), fieldValueCount: countEntries(config.data) }
      break
    case 'send_webhook':
      snapshot.webhook = { url: str(config.url), method: str(config.method) }
      break
    case 'send_notification':
    case 'notify': {
      const userIds = strList(config.userIds)
      snapshot.notification = { userId: userIds.join(', '), message: str(config.message) }
      break
    }
    case 'start_approval': {
      snapshot.startApproval = {
        templateLabel: str(config.templateId).trim(),
        mappingCount: countEntries(config.formDataMapping),
      }
      break
    }
    case 'write_approval_form_values': {
      snapshot.fwbWriteback = {
        mappingCount: Array.isArray(config.mappings) ? config.mappings.length : 0,
        confirmed: str(config.confirmationHash).trim() !== '',
        mode: config.mode === 'update' ? 'update' : 'create',
      }
      break
    }
    case 'send_email':
      snapshot.email = { recipientCount: strList(config.recipients).length, subjectTemplate: str(config.subjectTemplate) }
      break
    case 'send_dingtalk_group_message': {
      const ids = new Set([...strList(config.destinationIds), ...strList([config.destinationId])])
      const paths = new Set([...strList(config.destinationIdFieldPaths), ...strList([config.destinationIdFieldPath])])
      snapshot.dingTalkGroupMessage = { destinationCount: ids.size + paths.size, titleTemplate: str(config.titleTemplate) }
      break
    }
    case 'send_dingtalk_person_message': {
      const count = strList(config.userIds).length
        + strList(config.memberGroupIds).length
        + new Set([...strList(config.userIdFieldPaths), ...strList([config.userIdFieldPath])]).size
        + new Set([...strList(config.memberGroupIdFieldPaths), ...strList([config.memberGroupIdFieldPath])]).size
      snapshot.dingTalkPersonMessage = { recipientCount: count, titleTemplate: str(config.titleTemplate) }
      break
    }
    case 'lock_record':
      snapshot.lockRecord = { locked: config.locked === true }
      break
    case 'delete_record':
      // A saved delete_record already passed the server's acknowledgement gate.
      snapshot.deleteRecord = { acknowledged: true }
      break
    case 'condition_branch': {
      const branches = Array.isArray(config.branches) ? config.branches : []
      snapshot.conditionBranch = {
        branchCount: branches.length,
        hasDefaultBranch: isRecord(config.defaultBranch),
      }
      break
    }
    case 'parallel_branch': {
      const branches = Array.isArray(config.branches) ? config.branches : []
      snapshot.parallelBranch = { branchCount: branches.length }
      break
    }
    default:
      break
  }
  return snapshot
}

function integrationJobSummary(config: Record<string, unknown>, isZh: boolean): string {
  const label = automationActionTypeLabel('run_integration_job', isZh)
  const job = isRecord(config.job) ? config.job : null
  if (!job) return `${label}${pick(isZh, '（未配置）', ' (not configured)')}`
  if (job.kind === 'stock_prep_pull') {
    const n = strList(job.projectNos).length
    return pick(isZh, `${label}：备料拉取，${n} 个项目`, `${label}: stock-prep pull, ${n} ${n === 1 ? 'project' : 'projects'}`)
  }
  if (job.kind === 'pipeline') {
    const id = str(job.pipelineId)
    return pick(isZh, `${label}：管道 ${id || '（未选）'}`, `${label}: pipeline ${id || '(none)'}`)
  }
  return label
}

function summarize(type: string, config: Record<string, unknown>, options: Required<AutomationFlowOptions>): string {
  if (type === 'run_integration_job') return integrationJobSummary(config, options.isZh)
  return summarizeAutomationAction(savedConfigSnapshot(type as AutomationActionType, config, options.fieldLabel), options.isZh)
}

function branchCard(
  kind: 'branch' | 'parallel',
  parentIndex: number,
  raw: unknown,
  isDefault: boolean,
  options: Required<AutomationFlowOptions>,
): FlowBranch | null {
  if (!isRecord(raw)) return null
  const key = str(raw.key)
  const label = str(raw.label).trim() || (isDefault ? pick(options.isZh, '默认分支', 'Default branch') : key)
  const steps = actionsOf(raw.actions).map((action, j) =>
    stepCard(action, `${parentIndex}.${kind}.${key}.${j}`, parentIndex, options, false))
  return { kind, key, label, isDefault, steps }
}

function stepCard(
  action: AutomationAction,
  stepKey: string,
  topIndex: number,
  options: Required<AutomationFlowOptions>,
  allowBranches: boolean,
): FlowStepCard {
  const type = String(action.type)
  const config = isRecord(action.config) ? action.config : {}
  const branches: FlowBranch[] = []
  if (allowBranches && type === 'condition_branch') {
    for (const raw of Array.isArray(config.branches) ? config.branches : []) {
      const b = branchCard('branch', topIndex, raw, false, options)
      if (b) branches.push(b)
    }
    const d = branchCard('branch', topIndex, config.defaultBranch, true, options)
    if (d) branches.push(d)
  } else if (allowBranches && type === 'parallel_branch') {
    for (const raw of Array.isArray(config.branches) ? config.branches : []) {
      const b = branchCard('parallel', topIndex, raw, false, options)
      if (b) branches.push(b)
    }
  }
  return {
    stepKey,
    type,
    label: automationActionTypeLabel(type, options.isZh),
    summary: summarize(type, config, options),
    category: flowStepCategory(type),
    branches,
  }
}

function triggerDetail(
  rule: Pick<AutomationRule, 'triggerType' | 'triggerConfig'>,
  options: Required<AutomationFlowOptions>,
): string {
  const cfg = isRecord(rule.triggerConfig) ? rule.triggerConfig : {}
  const { isZh } = options
  switch (rule.triggerType) {
    case 'schedule.cron': {
      const expr = str(cfg.expression).trim()
      const tz = str(cfg.timezone).trim()
      if (!expr) return pick(isZh, '（未配置）', '(not configured)')
      return tz ? `${expr} · ${tz}` : expr
    }
    case 'schedule.interval': {
      const ms = typeof cfg.intervalMs === 'number' && Number.isFinite(cfg.intervalMs) ? cfg.intervalMs : 0
      if (ms <= 0) return pick(isZh, '（未配置）', '(not configured)')
      const minutes = Math.round(ms / 60000)
      return pick(isZh, `每 ${minutes} 分钟`, `every ${minutes} min`)
    }
    case 'field.changed':
    case 'field.value_changed': {
      const fid = str(cfg.fieldId)
      return fid ? automationCardTriggerSummary(rule.triggerType, options.fieldLabel(fid), isZh) : ''
    }
    case 'integration.run_finished': {
      const job = isRecord(cfg.job) ? cfg.job : {}
      const kind = job.kind === 'stock_prep_pull'
        ? pick(isZh, '备料拉取', 'stock-prep pull')
        : job.kind === 'pipeline' ? pick(isZh, `管道 ${str(job.pipelineId)}`, `pipeline ${str(job.pipelineId)}`) : ''
      const statuses = strList(cfg.statuses)
      const st = statuses.length ? ` · ${statuses.join(' / ')}` : ''
      return `${kind}${st}`
    }
    default:
      return ''
  }
}

function resolveOptions(options: AutomationFlowOptions): Required<AutomationFlowOptions> {
  return { isZh: options.isZh, fieldLabel: options.fieldLabel ?? ((id: string) => id) }
}

/**
 * The trigger card alone. Stage 1b (the rule editor's Flow mode) builds it from the editor's draft trigger
 * (type + config, already in the saved shape), so both stages describe a trigger with the same line.
 */
export function flowTriggerCard(
  rule: Pick<AutomationRule, 'triggerType' | 'triggerConfig'>,
  options: AutomationFlowOptions,
): FlowTriggerCard {
  const resolved = resolveOptions(options)
  const triggerType = String(rule.triggerType ?? '')
  return {
    type: triggerType,
    label: automationTriggerTypeLabel(triggerType, resolved.isZh),
    detail: triggerDetail(rule, resolved),
  }
}

export function flowStepCategoryLabel(category: FlowStepCategory, isZh: boolean): string {
  switch (category) {
    case 'record': return pick(isZh, '记录', 'Record')
    case 'message': return pick(isZh, '消息', 'Message')
    case 'control': return pick(isZh, '控制', 'Control')
    case 'integration': return pick(isZh, '集成', 'Integration')
    case 'approval': return pick(isZh, '审批', 'Approval')
    default: return pick(isZh, '动作', 'Action')
  }
}

export function buildAutomationFlow(rule: AutomationRule, options: AutomationFlowOptions): AutomationFlowModel {
  const resolved = resolveOptions(options)
  const conditions = rule.conditions as unknown
  const hasRuleConditions = isRecord(conditions)
    && Array.isArray(conditions.conditions)
    && conditions.conditions.length > 0
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    enabled: rule.enabled === true,
    trigger: flowTriggerCard(rule, resolved),
    hasRuleConditions,
    steps: ruleActions(rule).map((action, i) => stepCard(action, String(i), i, resolved, true)),
  }
}
