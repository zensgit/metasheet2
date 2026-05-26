/**
 * Workflow-job convergence contract (RFC C1) — CONTRACT-ONLY, NOT WIRED.
 *
 * This module is the C1 contract layer for the approval↔automation convergence
 * RFC (`docs/research/approval-automation-convergence-rfc-20260526.md`). It
 * defines the persistable, **resumable** "workflow job" + status contract that
 * a future converged engine (RFC C2+) would use to give our linear automation
 * executor (and, much later at C4, approval) a suspend/resume primitive.
 *
 * INTENTIONALLY NOT IMPORTED BY ANY RUNTIME PATH. Nothing in
 * `automation-executor.ts` / `automation-service.ts` / the approval services
 * imports this module — only its unit test does. It exists so the schema, the
 * status enum, and the strict normalizer are reviewed and locked *before* any
 * runtime is written. Runtime stays FROZEN under the K3 PoC stage-1 lock; each
 * of RFC C2–C5 is a separate explicit opt-in.
 *
 * The status model is a *superset* of the legacy `AutomationExecution` status
 * (`running | success | failed | skipped`); the bridge helpers below make the
 * relationship total and explicit so adopting this contract never silently
 * reinterprets existing executions. The suspend/reject/error states are the
 * additions the converged engine needs (modelled on the RFC §3 source read of
 * NocoBase's `JOB_STATUS`; pattern-borrow only, no code copied — NocoBase is
 * AGPL).
 */

import type { AutomationExecution } from './automation-executor'

/** Legacy automation execution status (the 4-state we must stay compatible with). */
export type LegacyAutomationStatus = AutomationExecution['status']

/**
 * Converged workflow-job status. Superset of {@link LegacyAutomationStatus}.
 *
 * Mapping to the NocoBase reference enum (traceability only — see RFC §3,
 * `references/nocobase/.../plugin-workflow/src/server/constants.ts:10-30`):
 *   queued≈QUEUEING · running≈STARTED · resolved≈RESOLVED · failed≈FAILED
 *   · errored≈ERROR · rejected≈REJECTED · suspended = the PENDING primitive
 *   · skipped = our condition/branch-not-taken (no direct NocoBase analogue).
 */
export const WORKFLOW_JOB_STATUSES = [
  'queued', // persisted, not yet started
  'running', // currently executing
  'suspended', // waiting for an external event (manual task / delay / webhook) — the NEW resumable primitive
  'resolved', // completed successfully
  'failed', // logic-level failure (expected, e.g. action returned failed)
  'skipped', // condition/branch not taken
  'rejected', // explicitly rejected (e.g. approval reject) — distinct from failed
  'errored', // unexpected exception (distinct from a logic-level failure)
] as const

export type WorkflowJobStatus = (typeof WORKFLOW_JOB_STATUSES)[number]

/** Why a job is in the `suspended` state — i.e. what event must occur to resume it. */
export const WORKFLOW_JOB_SUSPEND_REASONS = [
  'manual_task', // awaiting a human action (approval / manual node)
  'delay', // awaiting a timer
  'external_event', // awaiting a webhook / external callback
] as const

export type WorkflowJobSuspendReason = (typeof WORKFLOW_JOB_SUSPEND_REASONS)[number]

/**
 * A persistable, resumable unit of work within a workflow execution.
 *
 * Shape only — no behaviour. A converged engine (C2+) would persist one row
 * per job; `suspended` jobs carry the `suspend` descriptor so an external
 * `resume(jobId)` can re-enter execution at the right step.
 */
export interface WorkflowJob {
  /** Stable job id. */
  id: string
  /** Owning execution id (an `AutomationExecution.id` today; an approval instance id at C4). */
  executionId: string
  /** Stable key of the step/node this job represents (e.g. an action index/id). */
  stepKey: string
  /** Current status. */
  status: WorkflowJobStatus
  /** Predecessor job id, for ordering / resume chaining (null for the first job). */
  upstreamJobId?: string | null
  /** Opaque step result payload (sanitised before persistence by the runtime, not here). */
  result?: unknown
  /** Error message when `status` is `failed` / `errored` / `rejected`. */
  error?: string
  /** Present iff `status === 'suspended'`: what we are waiting on + how to resume. */
  suspend?: {
    reason: WorkflowJobSuspendReason
    /** Token an external resumer presents to continue this job (e.g. task id, timer id, callback nonce). */
    resumeToken: string
  }
}

const STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_JOB_STATUSES)
const SUSPEND_REASON_SET: ReadonlySet<string> = new Set(WORKFLOW_JOB_SUSPEND_REASONS)

/** Type guard: is `value` a known workflow-job status? */
export function isWorkflowJobStatus(value: unknown): value is WorkflowJobStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

/**
 * Enum-strict status normalizer: returns the status unchanged if known, else
 * throws. (Contract boundary — unknown statuses must never silently pass.)
 */
export function normalizeWorkflowJobStatus(raw: unknown): WorkflowJobStatus {
  if (isWorkflowJobStatus(raw)) return raw
  throw new TypeError(`Unknown workflow job status: ${JSON.stringify(raw)}`)
}

/**
 * Enum-strict job normalizer. Validates required fields + the status enum, and
 * enforces the `suspended ⇔ suspend descriptor` invariant. Throws on any
 * violation. Does NOT mutate or persist — pure shape validation.
 */
export function normalizeWorkflowJob(raw: unknown): WorkflowJob {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('WorkflowJob must be an object')
  }
  const obj = raw as Record<string, unknown>
  const requireString = (key: string): string => {
    const v = obj[key]
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(`WorkflowJob.${key} must be a non-empty string`)
    }
    return v
  }

  const id = requireString('id')
  const executionId = requireString('executionId')
  const stepKey = requireString('stepKey')
  const status = normalizeWorkflowJobStatus(obj.status)

  const job: WorkflowJob = { id, executionId, stepKey, status }

  if (obj.upstreamJobId !== undefined) {
    if (obj.upstreamJobId !== null && typeof obj.upstreamJobId !== 'string') {
      throw new TypeError('WorkflowJob.upstreamJobId must be a string or null')
    }
    job.upstreamJobId = obj.upstreamJobId as string | null
  }
  if (obj.result !== undefined) job.result = obj.result
  if (obj.error !== undefined) {
    if (typeof obj.error !== 'string') throw new TypeError('WorkflowJob.error must be a string')
    job.error = obj.error
  }

  // suspended ⇔ suspend descriptor — enforced both ways.
  const suspendRaw = obj.suspend
  if (status === 'suspended') {
    if (typeof suspendRaw !== 'object' || suspendRaw === null) {
      throw new TypeError("WorkflowJob with status 'suspended' must carry a suspend descriptor")
    }
    const s = suspendRaw as Record<string, unknown>
    if (typeof s.reason !== 'string' || !SUSPEND_REASON_SET.has(s.reason)) {
      throw new TypeError(`WorkflowJob.suspend.reason must be one of ${WORKFLOW_JOB_SUSPEND_REASONS.join(', ')}`)
    }
    if (typeof s.resumeToken !== 'string' || s.resumeToken.length === 0) {
      throw new TypeError('WorkflowJob.suspend.resumeToken must be a non-empty string')
    }
    job.suspend = { reason: s.reason as WorkflowJobSuspendReason, resumeToken: s.resumeToken }
  } else if (suspendRaw !== undefined) {
    throw new TypeError(`WorkflowJob.suspend is only allowed when status is 'suspended' (got '${status}')`)
  }

  return job
}

/**
 * Bridge: legacy automation execution status → converged job status (total).
 * `success → resolved` is the only rename; the rest are identity.
 */
export function legacyAutomationStatusToJobStatus(status: LegacyAutomationStatus): WorkflowJobStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'success':
      return 'resolved'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
  }
}

/**
 * Bridge: converged job status → legacy automation status (total, lossy).
 *
 * Lossy by design — the legacy 4-state cannot express the new states, so they
 * collapse to the nearest legacy meaning:
 *   queued/suspended → running (still in-flight) · resolved → success
 *   · rejected/errored → failed. Use only for back-compat surfaces that have
 *   not yet adopted {@link WorkflowJobStatus}.
 */
export function jobStatusToLegacyAutomationStatus(status: WorkflowJobStatus): LegacyAutomationStatus {
  switch (status) {
    case 'queued':
    case 'running':
    case 'suspended':
      return 'running'
    case 'resolved':
      return 'success'
    case 'skipped':
      return 'skipped'
    case 'failed':
    case 'rejected':
    case 'errored':
      return 'failed'
  }
}
