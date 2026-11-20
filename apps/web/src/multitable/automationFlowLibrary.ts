// Integration assistant stage 1c (owner 2026-11-19, register R-99 ③; plan
// docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md §3.3 / §7): the rule
// editor's Flow mode gets a node library (节点库) and a read-only go-live gates tab (上线门).
//
// What this module is: pure display derivations. It never decides on its own whether a type may be added —
// the editor passes in what its EXISTING Form logic says (selectableActionTypes for a freshly added row, the
// option's :disabled predicate, addAction()'s refusals), and this module only groups the entries and picks the
// sentence that explains a lock. Whatever the editor's own logic says wins: an entry is locked exactly when the
// Form select of a freshly added row would not offer that type enabled.
//
// What it is NOT: a new authoring rule, a new action type, a switch reader of its own, or a fetch. The
// 「即将开放」 entries are static labels — they are NOT action types and never reach AutomationActionType.

import type { AutomationActionType } from './types'
import { FWB_ACTION_TYPE } from './fwbRuleAuthoring'
import { RUN_INTEGRATION_JOB_ACTION_TYPE, RUN_INTEGRATION_JOB_TRIGGER_TYPE } from './runIntegrationJobAuthoring'
import { INTEGRATION_RUN_FINISHED_TRIGGER_TYPE } from './integrationRunFinishedAuthoring'
import { flowStepCategory, flowStepCategoryLabel, type FlowStepCategory } from './automationFlowView'
import {
  automationActionTypeLabel,
  automationLabel,
  type AutomationLabelKey,
} from './utils/meta-automation-labels'

// ── 1. Node library ─────────────────────────────────────────────────────────────────────────────────────

/** Group order of the library (the prototype's 记录 / 消息 / 控制 / 审批 / 集成); 'other' only if ever non-empty. */
export const FLOW_LIBRARY_GROUP_ORDER: readonly FlowStepCategory[] = Object.freeze([
  'record', 'message', 'control', 'approval', 'integration', 'other',
])

const DESCRIPTION_KEYS: Readonly<Partial<Record<string, AutomationLabelKey>>> = Object.freeze({
  update_record: 'editor.libraryDescUpdateRecord',
  create_record: 'editor.libraryDescCreateRecord',
  delete_record: 'editor.libraryDescDeleteRecord',
  lock_record: 'editor.libraryDescLockRecord',
  send_webhook: 'editor.libraryDescSendWebhook',
  send_notification: 'editor.libraryDescSendNotification',
  send_email: 'editor.libraryDescSendEmail',
  send_dingtalk_group_message: 'editor.libraryDescDingTalkGroup',
  send_dingtalk_person_message: 'editor.libraryDescDingTalkPerson',
  send_dingtalk_approval_card: 'editor.libraryDescDingTalkApprovalCard',
  wait_for_callback: 'editor.libraryDescWaitForCallback',
  condition_branch: 'editor.libraryDescConditionBranch',
  parallel_branch: 'editor.libraryDescParallelBranch',
  start_approval: 'editor.libraryDescStartApproval',
  write_approval_form_values: 'editor.libraryDescFwb',
  run_integration_job: 'editor.libraryDescRunIntegrationJob',
})

export interface FlowLibraryEntry {
  type: AutomationActionType
  label: string
  /** One line saying what the step does; '' for a type this module has no sentence for. */
  description: string
  /** '' when picking it adds a step; otherwise why it cannot be added to THIS draft right now. */
  lockedReason: string
}

export interface FlowLibraryGroup {
  category: FlowStepCategory
  label: string
  entries: FlowLibraryEntry[]
}

/** A 「即将开放」 entry: display-only, never an action type, never clickable. */
export interface FlowComingSoonEntry {
  id: 'connection_call' | 'field_transform' | 'code' | 'k3_write'
  label: string
  reason: string
}

export function flowLibraryDescription(type: string, isZh: boolean): string {
  const key = DESCRIPTION_KEYS[type]
  return key ? automationLabel(key, isZh) : ''
}

/**
 * Groups the editor's full top-level catalog by the same category the flow cards use. `lockReason` is the
 * editor's own answer for each type ('' = can be added); this function never second-guesses it.
 */
export function buildFlowLibrary(input: {
  catalog: readonly AutomationActionType[]
  isZh: boolean
  lockReason: (type: AutomationActionType) => string
}): FlowLibraryGroup[] {
  const seen = new Set<string>()
  const byCategory = new Map<FlowStepCategory, FlowLibraryEntry[]>()
  for (const type of input.catalog) {
    if (seen.has(type)) continue
    seen.add(type)
    const category = flowStepCategory(type)
    const entries = byCategory.get(category) ?? []
    entries.push({
      type,
      label: automationActionTypeLabel(type, input.isZh),
      description: flowLibraryDescription(type, input.isZh),
      lockedReason: input.lockReason(type),
    })
    byCategory.set(category, entries)
  }
  return FLOW_LIBRARY_GROUP_ORDER
    .filter((category) => (byCategory.get(category)?.length ?? 0) > 0)
    .map((category) => ({
      category,
      label: flowStepCategoryLabel(category, input.isZh),
      entries: byCategory.get(category) ?? [],
    }))
}

/** S-line and out-of-scope steps, listed locked so authors see the boundary (plan §3.3). Static labels only. */
export function flowLibraryComingSoon(isZh: boolean): FlowComingSoonEntry[] {
  return [
    { id: 'connection_call', label: automationLabel('editor.libraryComingConnectionCall', isZh), reason: automationLabel('editor.libraryComingReasonSLine', isZh) },
    { id: 'field_transform', label: automationLabel('editor.libraryComingFieldTransform', isZh), reason: automationLabel('editor.libraryComingReasonSLine', isZh) },
    { id: 'code', label: automationLabel('editor.libraryComingCode', isZh), reason: automationLabel('editor.libraryComingReasonCode', isZh) },
    { id: 'k3_write', label: automationLabel('editor.libraryComingK3Write', isZh), reason: automationLabel('editor.libraryComingReasonK3Write', isZh) },
  ]
}

/** What the editor already knows when it asks why a library entry is locked. */
export interface FlowLibraryLockContext {
  /** The editor's flowAddBlockedReason — addAction() refuses (3 steps / beside run_integration_job) when non-empty. */
  addBlockedReason: string
  /** selectableActionTypes() for the row addAction() would append (counted with that row). */
  offered: readonly string[]
  /** The Form select's own :disabled predicate for an option. */
  optionDisabled: (type: AutomationActionType) => boolean
  /** isDeletedTriggerBlockedActionType — explains a disabled option under record.deleted. */
  deletedTriggerBlocked: (type: AutomationActionType) => boolean
  /** The inputs isFwbActionSelectable already reads (flag, trigger, completion outcomes). */
  fwb: { flagOn: boolean; triggerType: string; outcomes: readonly string[] }
  /** The inputs isRunIntegrationJobSelectable already reads, with the count INCLUDING the new row. */
  runIntegrationJob: { switchOn: boolean; triggerType: string; actionCount: number }
}

/**
 * '' when the editor's own logic would let a freshly added row become `type`; otherwise the sentence that
 * explains why not. The lock DECISION is only `addBlockedReason`, `offered` and `optionDisabled`; the branches
 * below merely pick wording for a decision that was already made.
 */
export function flowLibraryLockReason(type: AutomationActionType, ctx: FlowLibraryLockContext, isZh: boolean): string {
  if (ctx.addBlockedReason) return ctx.addBlockedReason
  const offered = ctx.offered.includes(type)
  if (offered && !ctx.optionDisabled(type)) return ''
  if (ctx.deletedTriggerBlocked(type)) return automationLabel('actionConfig.deletedTriggerSelfMutation', isZh)
  if (offered) return automationLabel('editor.libraryLockUnsupported', isZh)
  if (type === FWB_ACTION_TYPE) {
    if (!ctx.fwb.flagOn) return automationLabel('editor.libraryLockFwbFlagOff', isZh)
    if (ctx.fwb.triggerType !== 'approval.completed') return automationLabel('editor.libraryLockFwbTrigger', isZh)
    return automationLabel('editor.libraryLockFwbOutcome', isZh)
  }
  if (type === RUN_INTEGRATION_JOB_ACTION_TYPE) {
    if (!ctx.runIntegrationJob.switchOn) return automationLabel('editor.libraryLockRunJobSwitchOff', isZh)
    if (ctx.runIntegrationJob.triggerType !== RUN_INTEGRATION_JOB_TRIGGER_TYPE) return automationLabel('editor.libraryLockRunJobTrigger', isZh)
    return automationLabel('editor.libraryLockRunJobSole', isZh)
  }
  return automationLabel('editor.libraryLockUnavailable', isZh)
}

// ── 2. Go-live gates (上线门), read-only ────────────────────────────────────────────────────────────────

/** Top-level step types that leave the system; their sends follow the existing delivery switches. */
export const FLOW_GATE_OUTBOUND_ACTION_TYPES: readonly string[] = Object.freeze([
  'send_webhook',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'send_dingtalk_approval_card',
])

export type FlowGateKey = 'runAction' | 'runEvent' | 'fwb' | 'outbound' | 'ruleState' | 'saveGate'

export interface FlowGateRow {
  key: FlowGateKey
  label: string
  /** 'on' / 'off' only for a switch the editor reads itself; '' when this page claims no state. */
  state: 'on' | 'off' | 'enabled' | 'disabled' | 'new' | ''
  stateLabel: string
  /** The session feature the state was read from (values-free: a feature name, never a value). */
  feature: string
  note: string
}

export interface FlowGatesInput {
  actionTypes: readonly string[]
  triggerType: string
  /** featureFlags.hasFeature(...) as the editor already reads them. */
  features: { runAction: boolean; runEvent: boolean; fwb: boolean }
  /** The loaded rule's enabled flag; null for a new (unsaved) rule. The editor never sends `enabled`. */
  ruleEnabled: boolean | null
  isZh: boolean
}

function switchRow(key: FlowGateKey, labelKey: AutomationLabelKey, feature: string, on: boolean, note: string, isZh: boolean): FlowGateRow {
  return {
    key,
    label: automationLabel(labelKey, isZh),
    state: on ? 'on' : 'off',
    stateLabel: automationLabel(on ? 'editor.gatesStateOn' : 'editor.gatesStateOff', isZh),
    feature,
    note,
  }
}

/** The gates that apply to the CURRENT draft, from what the editor already knows. No fetch, no switch write. */
export function buildFlowGates(input: FlowGatesInput): FlowGateRow[] {
  const { isZh } = input
  const types = new Set(input.actionTypes)
  const rows: FlowGateRow[] = []
  if (types.has(RUN_INTEGRATION_JOB_ACTION_TYPE)) {
    rows.push(switchRow('runAction', 'editor.gatesRunAction', 'integrationAutomationRunAction', input.features.runAction,
      automationLabel('editor.gatesRunActionNote', isZh), isZh))
  }
  if (input.triggerType === INTEGRATION_RUN_FINISHED_TRIGGER_TYPE) {
    rows.push(switchRow('runEvent', 'editor.gatesRunEvent', 'integrationAutomationRunEvent', input.features.runEvent, '', isZh))
  }
  if (types.has(FWB_ACTION_TYPE)) {
    rows.push(switchRow('fwb', 'editor.gatesFwb', 'approvalFwbWriteback', input.features.fwb, '', isZh))
  }
  if (FLOW_GATE_OUTBOUND_ACTION_TYPES.some((type) => types.has(type))) {
    rows.push({
      key: 'outbound',
      label: automationLabel('editor.gatesOutbound', isZh),
      state: '',
      stateLabel: '',
      feature: '',
      note: automationLabel('editor.gatesOutboundNote', isZh),
    })
  }
  const ruleState: FlowGateRow['state'] = input.ruleEnabled === null ? 'new' : input.ruleEnabled ? 'enabled' : 'disabled'
  rows.push({
    key: 'ruleState',
    label: automationLabel('editor.gatesRuleState', isZh),
    state: ruleState,
    stateLabel: ruleState === 'new'
      ? automationLabel('editor.gatesRuleNew', isZh)
      : automationLabel(ruleState === 'enabled' ? 'manager.enabled' : 'manager.disabled', isZh),
    feature: '',
    note: automationLabel('editor.gatesRuleStateNote', isZh),
  })
  rows.push({
    key: 'saveGate',
    label: automationLabel('editor.gatesSave', isZh),
    state: '',
    stateLabel: '',
    feature: '',
    note: automationLabel('editor.gatesSaveNote', isZh),
  })
  return rows
}
