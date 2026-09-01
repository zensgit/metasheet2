// 大 BOM 后台通道 — the operator-facing half of the SKIP the audit found dead-ended.
//
// THE PROBLEM THIS FILE FIXES. When 试算 (dry-run) reports `large_bom_bounded`, projectSync.ts
// SKIPs the write step with `PLAN_LARGE_BOM_BOUNDED` — correctly, because an interactive apply
// cannot expand a BOM this large. But the panel then rendered nothing further: no link, no
// progress, no completion signal. The operator could not tell whether the pull was running or
// dead. The backend has carried the fix for this since #2342 (stock-preparation-large-bom-jobs.cjs):
// a background expansion job, a conflict plan over its artifact, and a checkpoint-chunked apply
// job — five existing routes, all gated at the SAME `read`/`write` tiers the panel's four small-BOM
// steps already use. This module is the first caller that drives them from an operator surface.
//
// WHY "POLL" MEANS "CALL run() AGAIN" HERE, NOT "GET AND WAIT". The audit pointed at the bounded-
// preview polling pattern in useAiBulkFill.ts (start a job, then GET it on an interval until a
// terminal status, because a REAL background worker advances it between polls) and asked this
// module to mirror it. It does, with one adaptation forced by this backend's own shape: nothing on
// the server advances a large-BOM job between calls — `runLargeBomBackgroundExpansionJob` and
// `runLargeBomCheckpointApplyJobChunk` are BOTH synchronous-per-call (the former does the whole
// bounded expansion in one shot; the latter advances by exactly one chunk of decisions). A GET-only
// poll loop would show `queued` forever. So each tick here calls `run` — which is what actually
// moves the job forward — and the interval between ticks is what turns a chunked, potentially slow
// operation into a rendered progression instead of one long blocking call. The terminal-status set,
// the self-limiting tick budget, and the render-every-tick discipline are the same shape as
// useAiBulkFill's `pollStep`; only the verb POST-ed on each tick differs.
//
// NEVER AUTO-ACCEPTS A HELD PLAN. Exactly the small-BOM rule (see projectSync.ts's module header):
// when the post-expansion conflict plan holds rows for manual confirmation, this module stops at
// `confirm_required` and never calls the apply-job-start route — which would 409
// (`LARGE_BOM_APPLY_MANUAL_CONFIRM_ACK_REQUIRED`) unless `acceptManualConfirmHold: true` rides with
// it. That flag is never sent. There is, as of this module, no in-panel review surface for a large
// BOM's held rows (the small-BOM confirmation queue is fed by a different route —
// `confirmation-decisions/reconcile` — that a large-BOM checkpoint plan never reaches), so
// `confirm_required` says so honestly rather than pretending a queue exists to send the operator to.
//
// VALUES-FREE, same discipline as projectSync.ts: every field on `StockPreparationLargeBomPullState`
// is a status token, a count, or a clamped error code. No BOM row, source cell, or server message
// ever reaches it.
//
// NO NEW WRITE AUTHORITY. `runApplyChunk` drives `POST …/apply-jobs/:applyJobId/run`, which is the
// EXISTING `requireAccess(req, 'write')` route the small-BOM `apply` step already uses at the same
// tier — this module adds no route and widens no gate. The panel that calls it renders only for the
// same platform-admin tier `canRunStockPrepProjectSync` already requires.
import {
  StockPreparationProjectSyncCallError,
  clampErrorCode,
  clampToken,
} from './projectSync'
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Mirrors `LARGE_BOM_BACKGROUND_EXPANSION_STATUSES` in stock-preparation-large-bom-jobs.cjs. */
export const STOCK_PREPARATION_LARGE_BOM_EXPANSION_STATUSES: readonly string[] = Object.freeze([
  'queued', 'running', 'paused', 'failed', 'completed', 'cancelled', 'expired',
])

/** Mirrors `LARGE_BOM_CHECKPOINT_APPLY_STATUSES` in the same file. */
export const STOCK_PREPARATION_LARGE_BOM_APPLY_STATUSES: readonly string[] = Object.freeze([
  'queued', 'running', 'paused', 'partial', 'succeeded', 'failed', 'cancelled', 'expired',
])

const EXPANSION_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired'])
const APPLY_NON_TERMINAL = new Set(['queued', 'running', 'paused'])
const APPLY_LANDED = new Set(['succeeded', 'partial'])

/** The seven-state progression the panel renders. Every state maps to ONE plainLanguage.ts entry. */
export type StockPreparationLargeBomPullPhase =
  | 'queued'
  | 'expanding'
  | 'planning'
  | 'confirm_required'
  | 'applying'
  | 'done'
  | 'failed'

export interface StockPreparationLargeBomApplyCounts {
  created: number
  updated: number
  inactive: number
  skipped: number
  held: number
  failed: number
}

/** Values-free snapshot rendered after every tick. */
export interface StockPreparationLargeBomPullState {
  phase: StockPreparationLargeBomPullPhase
  jobId: string | null
  applyJobId: string | null
  expansionStatus: string | null
  applyStatus: string | null
  /**
   * Budget consumption once the expansion completes (`rowsExpanded / maxRows`, falling back to
   * `readCount / maxReadCount`), 0-100. `null` while unknown — the server only populates
   * `progress`/`budgets` once, at expansion completion (see `updateJobFromExpansion`), so this is
   * genuinely unknown before then rather than a fabricated "0%".
   */
  percent: number | null
  /** Rows the checkpoint apply has processed so far. The public evidence carries no denominator
   *  (no `totalDecisions`), so this is a running count, never a percent — inventing one would be a
   *  number this module cannot back. */
  applyCounts: StockPreparationLargeBomApplyCounts | null
  /** > 0 only once the post-expansion plan is known; what routes the run to `confirm_required`. */
  manualConfirmCount: number
  /** Clamped server error code, for `stockPrepErrorPlain` — never a raw message. */
  errorCode: string | null
  /** True once the checkpoint apply reaches `succeeded` or `partial` — rows are in the sheet. */
  imported: boolean
}

function initialState(): StockPreparationLargeBomPullState {
  return {
    phase: 'queued',
    jobId: null,
    applyJobId: null,
    expansionStatus: null,
    applyStatus: null,
    percent: null,
    applyCounts: null,
    manualConfirmCount: 0,
    errorCode: null,
    imported: false,
  }
}

function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value * 100)))
}

/** `progress`/`budgets` are the exact values-free projection fields from `publicBackgroundExpansionJob`. */
export function largeBomExpansionPercent(
  progress: Record<string, unknown> | undefined | null,
  budgets: Record<string, unknown> | undefined | null,
): number | null {
  const rowsExpanded = intOf(progress && progress.rowsExpanded)
  const readCount = intOf(progress && progress.readCount)
  const maxRows = intOf(budgets && budgets.maxRows)
  const maxReadCount = intOf(budgets && budgets.maxReadCount)
  if (maxRows > 0) return clampPercent(rowsExpanded / maxRows)
  if (maxReadCount > 0) return clampPercent(readCount / maxReadCount)
  return null
}

export function largeBomApplyCountsOf(counts: Record<string, unknown> | undefined | null): StockPreparationLargeBomApplyCounts {
  const source = counts && typeof counts === 'object' ? counts : {}
  return {
    created: intOf(source.created),
    updated: intOf(source.updated),
    inactive: intOf(source.inactive),
    skipped: intOf(source.skipped),
    held: intOf(source.held),
    failed: intOf(source.failed),
  }
}

// ---------------------------------------------------------------------------
// the API surface the orchestration drives (injectable — the suite never touches fetch)
// ---------------------------------------------------------------------------

export interface StockPreparationLargeBomExpansionJob {
  jobId?: string
  status?: string
  authoritative?: boolean
  progress?: Record<string, number>
  budgets?: Record<string, number>
  evidence?: {
    errorTypes?: string[]
    plan?: { counts?: Record<string, number> }
  }
}

export interface StockPreparationLargeBomApplyJob {
  jobId?: string
  status?: string
  counts?: Record<string, number>
}

export interface StockPreparationLargeBomJobApi {
  startExpansion(projectNo: string): Promise<StockPreparationLargeBomExpansionJob>
  runExpansion(jobId: string): Promise<StockPreparationLargeBomExpansionJob>
  planExpansion(jobId: string): Promise<StockPreparationLargeBomExpansionJob>
  startApply(jobId: string): Promise<StockPreparationLargeBomApplyJob>
  runApplyChunk(jobId: string, applyJobId: string): Promise<StockPreparationLargeBomApplyJob>
}

/** Reused verbatim from projectSync.ts — one call-error shape for the whole stock-prep surface. */
export { StockPreparationProjectSyncCallError }

function codeOfLargeBomError(error: unknown): string | null {
  return error instanceof StockPreparationProjectSyncCallError ? error.code : null
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export interface StockPreparationLargeBomPullOptions {
  /** Fires after every state transition, including the first ('queued'). */
  onUpdate?: (state: StockPreparationLargeBomPullState) => void
  /** Real `setTimeout` in production; an instant resolver in tests. */
  wait?: (ms: number) => Promise<void>
  /** Gap between ticks. Default mirrors useAiBulkFill's `pollIntervalMs` default (2000ms). */
  pollIntervalMs?: number
  /** Checked before every await boundary; a true return stops the run without another tick. */
  isCancelled?: () => boolean
  /** Safety bound on expansion ticks — never an unbounded loop even if a job never terminates. */
  maxExpansionTicks?: number
  /** Safety bound on apply chunks — same reasoning. */
  maxApplyTicks?: number
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Drive ONE project's large-BOM background channel: expand, plan, and (only when the plan holds
 * nothing for a person) apply — mirroring projectSync.ts's "walk the steps, render every tick"
 * shape. Returns the final state; `onUpdate` is the render hook a panel wires to its own reactive
 * state.
 */
export async function runStockPreparationLargeBomPull(
  api: StockPreparationLargeBomJobApi,
  projectNo: string,
  options: StockPreparationLargeBomPullOptions = {},
): Promise<StockPreparationLargeBomPullState> {
  const wait = options.wait ?? defaultWait
  const intervalMs = options.pollIntervalMs ?? 2000
  const isCancelled = options.isCancelled ?? (() => false)
  const maxExpansionTicks = options.maxExpansionTicks ?? 60
  const maxApplyTicks = options.maxApplyTicks ?? 500

  let state = initialState()
  function emit(patch: Partial<StockPreparationLargeBomPullState>): StockPreparationLargeBomPullState {
    state = { ...state, ...patch }
    if (options.onUpdate) options.onUpdate(state)
    return state
  }
  function fail(error: unknown): StockPreparationLargeBomPullState {
    return emit({ phase: 'failed', errorCode: codeOfLargeBomError(error) })
  }

  // ---- start the expansion job ---------------------------------------------------------------
  let job: StockPreparationLargeBomExpansionJob
  try {
    job = await api.startExpansion(projectNo)
  } catch (error) {
    return fail(error)
  }
  emit({
    jobId: typeof job.jobId === 'string' && job.jobId ? job.jobId : null,
    expansionStatus: clampToken(job.status, STOCK_PREPARATION_LARGE_BOM_EXPANSION_STATUSES),
  })
  if (!state.jobId) return fail(new Error('large-bom expansion job start returned no jobId'))

  // ---- advance it until a terminal status ----------------------------------------------------
  let expansionTicks = 0
  for (;;) {
    const status = clampToken(job.status, STOCK_PREPARATION_LARGE_BOM_EXPANSION_STATUSES)
    if (EXPANSION_TERMINAL.has(status)) break
    expansionTicks += 1
    if (expansionTicks > maxExpansionTicks) {
      return fail(new StockPreparationProjectSyncCallError(0, 'large-bom/expansion-jobs/:jobId/run', { code: 'LARGE_BOM_TICK_BUDGET_EXCEEDED' }))
    }
    if (isCancelled()) return state
    emit({ phase: 'expanding', expansionStatus: status })
    try {
      job = await api.runExpansion(state.jobId)
    } catch (error) {
      return fail(error)
    }
    const nextStatus = clampToken(job.status, STOCK_PREPARATION_LARGE_BOM_EXPANSION_STATUSES)
    emit({ expansionStatus: nextStatus })
    if (EXPANSION_TERMINAL.has(nextStatus)) break
    if (isCancelled()) return state
    await wait(intervalMs)
  }

  const finalExpansionStatus = clampToken(job.status, STOCK_PREPARATION_LARGE_BOM_EXPANSION_STATUSES)
  if (finalExpansionStatus !== 'completed' || job.authoritative !== true) {
    const errorType = Array.isArray(job.evidence?.errorTypes) ? job.evidence!.errorTypes![0] : undefined
    return fail(new StockPreparationProjectSyncCallError(0, 'large-bom/expansion-jobs/:jobId/run', {
      code: clampErrorCode(typeof errorType === 'string' ? errorType.toUpperCase() : undefined),
    }))
  }
  emit({ percent: largeBomExpansionPercent(job.progress, job.budgets) })
  if (isCancelled()) return state

  // ---- plan: does anything need a person? -----------------------------------------------------
  emit({ phase: 'planning' })
  let planned: StockPreparationLargeBomExpansionJob
  try {
    planned = await api.planExpansion(state.jobId)
  } catch (error) {
    return fail(error)
  }
  const manualConfirmCount = intOf(planned.evidence?.plan?.counts?.manual_confirm)
  if (manualConfirmCount > 0) {
    // Deliberately NOT calling startApply. See the module header: this module never sends
    // acceptManualConfirmHold, and there is today no in-panel queue a large-BOM hold reaches.
    return emit({ phase: 'confirm_required', manualConfirmCount })
  }
  if (isCancelled()) return state

  // ---- apply: write the expanded rows, one chunk at a time -------------------------------------
  emit({ phase: 'applying' })
  let applyJob: StockPreparationLargeBomApplyJob
  try {
    applyJob = await api.startApply(state.jobId)
  } catch (error) {
    return fail(error)
  }
  const applyJobId = typeof applyJob.jobId === 'string' && applyJob.jobId ? applyJob.jobId : null
  if (!applyJobId) return fail(new Error('large-bom checkpoint apply start returned no jobId'))
  emit({
    applyJobId,
    applyStatus: clampToken(applyJob.status, STOCK_PREPARATION_LARGE_BOM_APPLY_STATUSES),
    applyCounts: largeBomApplyCountsOf(applyJob.counts),
  })

  let applyTicks = 0
  while (APPLY_NON_TERMINAL.has(clampToken(applyJob.status, STOCK_PREPARATION_LARGE_BOM_APPLY_STATUSES))) {
    applyTicks += 1
    if (applyTicks > maxApplyTicks) {
      return fail(new StockPreparationProjectSyncCallError(0, 'large-bom/.../apply-jobs/:applyJobId/run', { code: 'LARGE_BOM_TICK_BUDGET_EXCEEDED' }))
    }
    if (isCancelled()) return state
    try {
      applyJob = await api.runApplyChunk(state.jobId, applyJobId)
    } catch (error) {
      return fail(error)
    }
    const nextStatus = clampToken(applyJob.status, STOCK_PREPARATION_LARGE_BOM_APPLY_STATUSES)
    emit({ applyStatus: nextStatus, applyCounts: largeBomApplyCountsOf(applyJob.counts) })
    if (!APPLY_NON_TERMINAL.has(nextStatus)) break
    if (isCancelled()) return state
    await wait(intervalMs)
  }

  const finalApplyStatus = clampToken(applyJob.status, STOCK_PREPARATION_LARGE_BOM_APPLY_STATUSES)
  if (APPLY_LANDED.has(finalApplyStatus)) {
    return emit({ phase: 'done', imported: true })
  }
  return fail(new StockPreparationProjectSyncCallError(0, 'large-bom/.../apply-jobs/:applyJobId/run', { code: 'LARGE_BOM_APPLY_DID_NOT_LAND' }))
}

// ---------------------------------------------------------------------------
// the default API implementation — existing routes only, existing gates only
// ---------------------------------------------------------------------------

async function readEnvelope<T>(response: Response | undefined, route: string): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response?.json()
  } catch {
    payload = null
  }
  const status = typeof response?.status === 'number' ? response.status : 0
  const envelope = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? payload as IntegrationApiEnvelope<T>
    : null
  if (!response?.ok || envelope?.ok === false) {
    throw new StockPreparationProjectSyncCallError(status, route, {
      code: clampErrorCode(envelope?.error?.code),
    })
  }
  if (!envelope || envelope.ok !== true) {
    throw new StockPreparationProjectSyncCallError(status, route, { malformed: true })
  }
  return (envelope.data ?? {}) as T
}

/**
 * `actionId` and `scope` match `createStockPreparationProjectSyncApi`'s defaults exactly — the two
 * modules drive the same table action, so a caller building both APIs for one panel passes the same
 * `scope` to each.
 */
export function createStockPreparationLargeBomJobApi(
  scope: IntegrationScope,
  actionId: string,
): StockPreparationLargeBomJobApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  const base = `/api/integration/table-actions/${encodeURIComponent(actionId)}/large-bom/expansion-jobs`
  const json = { 'Content-Type': 'application/json' }

  return {
    async startExpansion(projectNo: string) {
      const route = base
      const response = await apiFetch(`${route}${suffix}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ parameters: { projectNo } }),
      })
      return readEnvelope<StockPreparationLargeBomExpansionJob>(response, route)
    },

    async runExpansion(jobId: string) {
      const route = `${base}/${encodeURIComponent(jobId)}/run`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: JSON.stringify({}) })
      return readEnvelope<StockPreparationLargeBomExpansionJob>(response, route)
    },

    async planExpansion(jobId: string) {
      const route = `${base}/${encodeURIComponent(jobId)}/plan`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: JSON.stringify({}) })
      return readEnvelope<StockPreparationLargeBomExpansionJob>(response, route)
    },

    async startApply(jobId: string) {
      const route = `${base}/${encodeURIComponent(jobId)}/apply-jobs`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: JSON.stringify({}) })
      return readEnvelope<StockPreparationLargeBomApplyJob>(response, route)
    },

    async runApplyChunk(jobId: string, applyJobId: string) {
      const route = `${base}/${encodeURIComponent(jobId)}/apply-jobs/${encodeURIComponent(applyJobId)}/run`
      const response = await apiFetch(`${route}${suffix}`, { method: 'POST', headers: json, body: JSON.stringify({}) })
      return readEnvelope<StockPreparationLargeBomApplyJob>(response, route)
    },
  }
}
