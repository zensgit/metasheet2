// Integration assistant stage 1d (register R-99 ③; plan
// docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md §7): the 1a flow view's
// 「最近执行」 — a rule's recent executions, read through the SAME client call the run log already uses
// (MultitableApiClient.getAutomationLogs → GET …/automations/:ruleId/logs; no new endpoint), aggregated per flow.
//
// Pure functions only (no Vue, no fetch). Values-free by construction: a row carries the execution's time,
// status, triggeredBy and step COUNTS; a step overlay carries a per-step STATUS. Nothing here reads
// `step.output` or `step.error` / `execution.error` — the view has nothing to render them from.
//
// How a run's step results are matched to the flow's step cards — and why it is index + type, never a guess:
//   - The rule-scoped log row's AutomationStepResult carries NO step key (types.ts AutomationStepResult;
//     backend automation-executor.ts `export interface AutomationStepResult` — actionType / status / simulated /
//     output / error / durationMs / alreadyApplied). The log route also strips the rule snapshot
//     (routes/automation.ts toRuleScopedExecutionView), so the run cannot be compared to the rule it ran.
//   - The executor's top-level loop (automation-executor.ts executeActions) pushes exactly ONE result per
//     top-level action, in order, with `actionType: action.type` — a branch / parallel action pushes ONE
//     aggregated result — and on a failure pushes a `skipped` result for every remaining action. A top-level
//     action's step key IS its index (automation-step-key.ts topLevelStepKey), which is what the 1a cards show.
//   So result i ↔ card `${i}` holds exactly when the run recorded one result per CURRENT top-level action and
//   every result's actionType equals that action's type. Anything else (a different count, a different type at
//   any position — the rule was edited since, or the run stopped part-way, e.g. suspended) is NOT overlaid:
//   the view says it cannot match step by step. Branch children are never overlaid (no per-child result).

import type { AutomationExecution, AutomationRule, AutomationStepResult } from './types'
import { ruleActions } from './automationFlowView'
import { formatBusinessTimestamp } from './utils/business-timezone'

/** How many executions the flow view asks for (the run log asks for 50; a strip needs fewer). */
export const FLOW_HISTORY_LIMIT = 20

/** A step's displayed result. `simulated` = a test-run step that was planned but dispatched nothing. */
export type FlowStepRunStatus = 'success' | 'failed' | 'skipped' | 'simulated'

export interface FlowHistoryStepCounts {
  total: number
  success: number
  failed: number
  skipped: number
  simulated: number
}

export interface FlowHistoryRow {
  id: string
  /** Business-timezone timestamp (the run log's formatter), or the raw value when it cannot be parsed. */
  time: string
  /** The execution's status code (rendered through the shared status label; unknown codes stay raw). */
  status: string
  triggeredBy: string
  counts: FlowHistoryStepCounts
}

export type FlowStepOverlay =
  | { kind: 'matched'; byStepKey: Record<string, FlowStepRunStatus | string> }
  | { kind: 'no_steps' }
  | { kind: 'rule_changed' }

function stepsOf(execution: Pick<AutomationExecution, 'steps'>): AutomationStepResult[] {
  return Array.isArray(execution.steps) ? execution.steps.filter((step) => !!step && typeof step === 'object') : []
}

/**
 * One step's displayed status. A simulated step that "succeeded" is shown as simulated (nothing was sent);
 * a failed / skipped simulated step keeps its own status. An unknown status code is passed through raw.
 */
export function flowStepRunStatus(step: Pick<AutomationStepResult, 'status' | 'simulated'>): FlowStepRunStatus | string {
  const status = typeof step.status === 'string' ? step.status : ''
  if (step.simulated === true && status === 'success') return 'simulated'
  return status
}

export function flowHistoryStepCounts(execution: Pick<AutomationExecution, 'steps'>): FlowHistoryStepCounts {
  const counts: FlowHistoryStepCounts = { total: 0, success: 0, failed: 0, skipped: 0, simulated: 0 }
  for (const step of stepsOf(execution)) {
    counts.total += 1
    const status = flowStepRunStatus(step)
    if (status === 'success' || status === 'failed' || status === 'skipped' || status === 'simulated') counts[status] += 1
  }
  return counts
}

export function flowHistoryRow(execution: AutomationExecution): FlowHistoryRow {
  const at = typeof execution.triggeredAt === 'string' ? execution.triggeredAt : ''
  return {
    id: String(execution.id),
    time: (at && formatBusinessTimestamp(at, { precision: 'second' })) || at,
    status: typeof execution.status === 'string' ? execution.status : '',
    triggeredBy: typeof execution.triggeredBy === 'string' ? execution.triggeredBy : '',
    counts: flowHistoryStepCounts(execution),
  }
}

/** Match a run's step results to the CURRENT rule's top-level step cards — see the header for the rule. */
export function matchExecutionToFlow(rule: AutomationRule, execution: Pick<AutomationExecution, 'steps'>): FlowStepOverlay {
  const steps = stepsOf(execution)
  if (steps.length === 0) return { kind: 'no_steps' }
  const actions = ruleActions(rule)
  if (steps.length !== actions.length) return { kind: 'rule_changed' }
  const byStepKey: Record<string, FlowStepRunStatus | string> = {}
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].actionType !== actions[i].type) return { kind: 'rule_changed' }
    byStepKey[String(i)] = flowStepRunStatus(steps[i])
  }
  return { kind: 'matched', byStepKey }
}
