/**
 * R-69 1c — the action layer's `integration.run_finished` summaries for a run_integration_job STEP (ADR
 * adr-automation-pipeline-bridge-20261103 §4.1 / §4.2; design baseline v2.3 §10.2). Pure: no DB, no clock reads
 * (the caller passes `occurredAt`), no publish. R-69 is OPEN: dry-run only, default OFF.
 *
 * EXACTLY ONE EVENT PER JOB. A stock_prep_pull step runs one UNIT per project; each project is one job. The
 * builder is called ONCE per step, with the step's FINAL result (after every unit settled or was given up on),
 * and returns one event per configured project:
 *   - a project that ran → its unit's outcome / reason / counts / duration;
 *   - a project the step never reached (the step stopped after a `timeout_unsettled` unit, or its budget was
 *     spent) → `not_started` with the stop's cause (`timeout` | `shutdown`);
 *   - a step that stopped BEFORE any unit (switch off, binding mismatch, port inactive, authority read failed …)
 *     → that step-level outcome / reason, once per project.
 * A `timeout_unsettled` unit's continuation (the port call still running, its eventual Tx B) never produces a
 * second event: the step's result is final for the summary; the late settlement goes to the intent ledger only.
 *
 * VALUES-FREE: the event carries the closed key set of core/integration-run-events.ts — never the unit's
 * `scopeKey` (it embeds the tenant id), never a summary message, never the binding.
 *
 * COUNTS (closed, nine keys; the I5 ruling on verifier F7 — baseline v2.3 §10.2.2 ③ wins over ADR §4.1): a
 * stock-prep dry run's planner decision counts (add / update / skip / inactive / manual_confirm, the names the
 * scheduled-pull script logs) are carried AS THEY ARE, so the summary's per-project counts equal the script log's;
 * the four run counts keep the T-level default: read = cleaned = the decisions' sum, written = 0 (a dry run writes
 * nothing), failed = 0. A pipeline summary's read/cleaned/written/failed are taken as they are and its five
 * decision counts are 0 (no planner). A missing or non-integer count is 0.
 *
 * CANAPPLY (same ruling): the port summary's boolean `canApply` (core/integration-run-port.ts
 * sanitizeIntegrationRunSummary keeps it), `=== true` — false for every unit without one (held, failed, a
 * project the step never reached, a step that stopped before any unit). The script logs `data.canApply === true`.
 *
 * `attempts` is 1: bounded retry (ADR §5) is not delivered (`retry` is refused at save).
 */
import {
  deriveAutomationRunFinishedEventId,
  INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS,
  type IntegrationRunFinishedCounts,
} from '../core/integration-run-events'
import { INTEGRATION_RUN_FINISHED_REASONS, INTEGRATION_RUN_FINISHED_STATUSES } from './automation-triggers'

const ERROR_CLASS_SHAPE = /^[A-Za-z0-9_:.-]{1,80}$/
const PIPELINE_COUNT_KEYS = Object.freeze(['read', 'cleaned', 'written', 'failed'] as const)

/** The serialized unit the step writes into `output.units` (automation-executor.ts serializeRunIntegrationJobUnit). */
interface StepUnit {
  projectNo?: unknown
  outcome?: unknown
  reason?: unknown
  durationMs?: unknown
  cause?: unknown
  summary?: unknown
}

export interface RunFinishedStepInput {
  /** The step's `output` (as returned by the run_integration_job step). */
  output: unknown
  projectNos: readonly string[]
  actionId?: string
  rootExecutionId: string
  executionId: string
  actionKey: string
  automationDepth: number
  occurredAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

const ZERO_DECISIONS = Object.freeze({ add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })

/** Map a unit summary's counts into the closed nine (see the header). */
export function runFinishedCountsFrom(rawCounts: unknown): IntegrationRunFinishedCounts {
  if (!isRecord(rawCounts)) return { read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS }
  if (PIPELINE_COUNT_KEYS.some((key) => key in rawCounts)) {
    return {
      read: nonNegativeInteger(rawCounts.read),
      cleaned: nonNegativeInteger(rawCounts.cleaned),
      written: nonNegativeInteger(rawCounts.written),
      failed: nonNegativeInteger(rawCounts.failed),
      ...ZERO_DECISIONS,
    }
  }
  const decisions = {
    add: nonNegativeInteger(rawCounts.add),
    update: nonNegativeInteger(rawCounts.update),
    skip: nonNegativeInteger(rawCounts.skip),
    inactive: nonNegativeInteger(rawCounts.inactive),
    manual_confirm: nonNegativeInteger(rawCounts.manual_confirm),
  }
  const planned = INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS.reduce((sum, key) => sum + decisions[key], 0)
  return { read: planned, cleaned: planned, written: 0, failed: 0, ...decisions }
}

/**
 * The step writes `reason = summary.reason ?? summary.errorClass ?? status` (and an error's code / name for a
 * rejection). A CLOSED reason stays `reason`; an open error class moves to `errorClass`; a reason equal to the
 * status (no reason at all) is dropped. Anything that fits neither shape is dropped (values-free).
 */
export function splitRunFinishedReason(reason: unknown, status: string, summaryErrorClass?: unknown): { reason?: string; errorClass?: string } {
  const out: { reason?: string; errorClass?: string } = {}
  if (typeof reason === 'string' && reason !== status) {
    if (INTEGRATION_RUN_FINISHED_REASONS.has(reason)) out.reason = reason
    else if (ERROR_CLASS_SHAPE.test(reason)) out.errorClass = reason
  }
  if (out.errorClass === undefined && typeof summaryErrorClass === 'string' && ERROR_CLASS_SHAPE.test(summaryErrorClass)) {
    out.errorClass = summaryErrorClass
  }
  return out
}

function statusOf(value: unknown): string {
  return typeof value === 'string' && (INTEGRATION_RUN_FINISHED_STATUSES as readonly string[]).includes(value) ? value : 'failed'
}

/**
 * One raw event per configured project (validated again by publishIntegrationRunFinished before any sink sees
 * it). Returns [] when the output is not a run_integration_job output at all.
 */
export function buildAutomationRunFinishedEvents(input: RunFinishedStepInput): Array<Record<string, unknown>> {
  const output = input.output
  if (!isRecord(output)) return []
  const units: StepUnit[] = Array.isArray(output.units) ? output.units.filter(isRecord) : []
  const byProject = new Map<string, StepUnit>()
  for (const unit of units) if (typeof unit.projectNo === 'string' && !byProject.has(unit.projectNo)) byProject.set(unit.projectNo, unit)
  // The cause the step stopped on, for projects it never reached (the last unit that ended the loop early).
  const stopCause = units.reduce<string | null>((acc, unit) => (unit.cause === 'timeout' || unit.cause === 'shutdown' ? unit.cause : acc), null)

  return input.projectNos.map((projectNo) => {
    const unit = byProject.get(projectNo)
    let status: string
    let reasonFields: { reason?: string; errorClass?: string }
    let counts: IntegrationRunFinishedCounts = runFinishedCountsFrom(undefined)
    let canApply = false
    let durationMs = 0
    let runId: string | undefined
    if (unit) {
      status = statusOf(unit.outcome)
      const summary = isRecord(unit.summary) ? unit.summary : undefined
      reasonFields = splitRunFinishedReason(unit.reason, status, summary?.errorClass)
      counts = runFinishedCountsFrom(summary?.counts)
      canApply = summary?.canApply === true
      durationMs = nonNegativeInteger(unit.durationMs)
      if (typeof summary?.runId === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(summary.runId)) runId = summary.runId
    } else if (units.length > 0) {
      // The step ended early (a timeout_unsettled unit breaks the loop): this project never started.
      status = 'not_started'
      reasonFields = { reason: stopCause ?? 'timeout' }
    } else {
      // The step stopped before any unit: the step-level outcome applies to every project of the job.
      status = statusOf(output.outcome)
      reasonFields = splitRunFinishedReason(output.reason, status)
    }
    return {
      eventId: deriveAutomationRunFinishedEventId({
        rootExecutionId: input.rootExecutionId,
        executionId: input.executionId,
        actionKey: input.actionKey,
        projectNo,
      }),
      occurredAt: input.occurredAt,
      job: { kind: 'stock_prep_pull', ...(input.actionId ? { actionId: input.actionId } : {}), projectNo },
      ...(runId ? { runId } : {}),
      status,
      canApply,
      counts,
      durationMs,
      attempts: 1,
      triggeredBy: 'automation',
      ...reasonFields,
      _automationDepth: input.automationDepth,
    }
  })
}
