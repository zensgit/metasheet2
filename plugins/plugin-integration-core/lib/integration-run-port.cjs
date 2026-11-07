'use strict'
/**
 * R-69 1b-ii — the plugin's IntegrationRunPort (ADR adr-automation-pipeline-bridge-20261103 §2 ②③, §3.2;
 * design baseline v2.3 §10.2.4 "plugins/plugin-integration-core/index.cjs" row). R-69 is OPEN: dry-run only.
 *
 * ONE CHAIN, TWO CALLERS. The port calls the SAME request-free governed entries the HTTP handlers call
 * (`runGovernedStockPrepPull` / `runGovernedPipeline`, http-routes.cjs), with the principal context the host
 * built from a committed live-authority read. Nothing here widens, defaults or re-reads a permission; nothing
 * here adds `runAs`, a C6 write-lifecycle marker or a tenant; `replayDeadLetter` is never exposed. The
 * `signal` / `checkpoint` the host passes are handed down untouched so the table action and the runner check
 * them before the source read, before each page and before planning (1b-i).
 *
 * THE RESULT IS VALUES-FREE: a closed status, a bounded reason / error class, integer counts and the dry-run
 * `canApply` bit. The dry-run payload's `missingComponents` (real part numbers), `dryRunToken`, `revision`,
 * `evidence` and every other key never leave this module. Core re-sanitizes the summary again.
 *
 * STATUS MAPPING (the OS task's own classification, scripts/ops/stock-preparation-scheduled-pull.mjs):
 *   ready → succeeded (canApply carried as a boolean; nothing is applied — dry run only)
 *   manual_confirm_required | suspended | large_bom_bounded | review_pending → held (human work, not a fault)
 *   not_found → skipped (reason not_found; the script's skipped_not_found)
 *   recovery_pending → failed (errorClass STOCK_PREP_REFRESH_RECOVERY_PENDING)
 *   refusal 404/409 STOCK_PREPARATION_PROJECT_ABSENT / _ARCHIVED → held (reason project_absent / project_archived)
 *   refusal 401/403 → skipped (reason principal_unauthorized)
 *   any other HttpRouteError → failed (errorClass = its code); any other error → failed (errorClass = code | name)
 *   an abort (the host's signal, the checkpoint's lease-lost rejection, or the governed entry's own
 *   GovernedEntryAbortError that wraps either — governed-entry-checkpoint.cjs) is RETHROWN — core classifies it.
 */

// R-69 1c (I5 ruling N4): `review_pending` (a written change awaits its review, #6791) is held, as the scheduled pull
// logs it skipped_review_pending — human work on the 拉取待确认 page, never applicable (the dry run mints no token).
const HELD_DRY_RUN_STATUSES = new Set(['manual_confirm_required', 'suspended', 'large_bom_bounded', 'review_pending'])
const HELD_REFUSAL_CODES = new Map([
  ['STOCK_PREPARATION_PROJECT_ABSENT', 'project_absent'],
  ['STOCK_PREPARATION_PROJECT_ARCHIVED', 'project_archived'],
])
const DEFAULT_STOCK_PREP_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const CLASS_SHAPE = /^[A-Za-z0-9_:.-]{1,80}$/

function integerCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isInteger(count) && /^[A-Za-z0-9_:-]{1,64}$/.test(key)) out[key] = count
  }
  return out
}

function boundedClass(value, fallback) {
  return typeof value === 'string' && CLASS_SHAPE.test(value) ? value : fallback
}

// An abort-shaped rejection: the host's signal reason (AbortError / TimeoutError), the host's lease checkpoint
// (JobLeaseLostError / JOB_LEASE_LOST), or the governed entries' own refusal that wraps either of them
// (GovernedEntryAbortError / GOVERNED_ENTRY_ABORTED, lib/governed-entry-checkpoint.cjs). Rethrown, never classified.
function isAbortLike(error) {
  if (!error || typeof error !== 'object') return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'JobLeaseLostError'
    || error.name === 'GovernedEntryAbortError'
    || error.code === 'ABORT_ERR' || error.code === 'JOB_LEASE_LOST' || error.code === 'GOVERNED_ENTRY_ABORTED'
}

/** The stock-prep dry-run payload → values-free summary. */
function summarizeStockPrepDryRun(data, startedAt) {
  const durationMs = Date.now() - startedAt
  const status = data && typeof data.status === 'string' ? data.status : null
  const counts = integerCounts(data && data.counts)
  if (status === 'ready') {
    return { status: 'succeeded', reason: 'ready', canApply: data.canApply === true, ...(counts ? { counts } : {}), durationMs }
  }
  if (status && HELD_DRY_RUN_STATUSES.has(status)) {
    return { status: 'held', reason: status, canApply: false, ...(counts ? { counts } : {}), durationMs }
  }
  // R-69 1c (I5 ruling N4): the source does not know the project — the scheduled pull's skipped_not_found.
  if (status === 'not_found') {
    return { status: 'skipped', reason: 'not_found', canApply: false, ...(counts ? { counts } : {}), durationMs }
  }
  if (status === 'recovery_pending') {
    return { status: 'failed', errorClass: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', failureStage: 'read', durationMs }
  }
  return { status: 'failed', errorClass: 'unexpected_dry_run_status', failureStage: 'read', durationMs }
}

/** The pipeline runner's dry-run result → values-free summary. */
function summarizePipelineRun(result, startedAt) {
  const durationMs = Date.now() - startedAt
  const status = result && typeof result.status === 'string' ? result.status : null
  const metrics = result && result.metrics && typeof result.metrics === 'object' ? result.metrics : {}
  const counts = integerCounts({
    read: metrics.rowsRead,
    cleaned: metrics.rowsCleaned,
    written: metrics.rowsWritten,
    failed: metrics.rowsFailed,
  })
  const runId = result && typeof result.runId === 'string' && CLASS_SHAPE.test(result.runId) ? result.runId : undefined
  if (status === 'succeeded' || status === 'partial') {
    return { status, ...(runId ? { runId } : {}), counts, durationMs }
  }
  return { status: 'failed', errorClass: boundedClass(status, 'unexpected_run_status'), ...(runId ? { runId } : {}), counts, durationMs }
}

function classifyRefusal(error, startedAt) {
  const durationMs = Date.now() - startedAt
  if (error && error.name === 'HttpRouteError') {
    if (error.status === 401 || error.status === 403) {
      return { status: 'skipped', reason: 'principal_unauthorized', errorClass: boundedClass(error.code, 'FORBIDDEN'), durationMs }
    }
    const held = HELD_REFUSAL_CODES.get(error.code)
    if (held) return { status: 'held', reason: held, durationMs }
    return {
      status: 'failed',
      errorClass: boundedClass(error.code, 'HTTP_ROUTE_ERROR'),
      failureStage: boundedClass(error.details && error.details.failureStage, 'authorize'),
      durationMs,
    }
  }
  const failureStage = error && typeof error === 'object' && typeof error.failureStage === 'string' ? boundedClass(error.failureStage, 'read') : 'read'
  const errorClass = error && typeof error === 'object'
    ? boundedClass(error.errorClass, boundedClass(error.code, boundedClass(error.name, 'error')))
    : 'error'
  return { status: 'failed', errorClass, failureStage, durationMs }
}

/**
 * @param {{ governedEntries: { runGovernedStockPrepPull: Function, runGovernedPipeline: Function }, actionId?: string }} deps
 */
function createIntegrationRunPort({ governedEntries, actionId = DEFAULT_STOCK_PREP_ACTION_ID } = {}) {
  if (!governedEntries || typeof governedEntries.runGovernedStockPrepPull !== 'function' || typeof governedEntries.runGovernedPipeline !== 'function') {
    throw new TypeError('createIntegrationRunPort: governedEntries.runGovernedStockPrepPull and runGovernedPipeline are required')
  }
  return Object.freeze({
    async run({ context, job, signal, checkpoint } = {}) {
      const startedAt = Date.now()
      if (!context || typeof context !== 'object') throw new TypeError('IntegrationRunPort.run: context is required')
      if (!job || typeof job !== 'object') throw new TypeError('IntegrationRunPort.run: job is required')
      // A kind outside the closed set is a programming error at the boundary — thrown, never classified.
      if (job.kind !== 'stock_prep_pull' && job.kind !== 'pipeline') {
        throw new TypeError('IntegrationRunPort.run: job.kind must be stock_prep_pull | pipeline')
      }
      // Handed down as-is: only the keys the host gave (the governed entries treat absence as "ungoverned").
      const options = {
        ...(signal ? { signal } : {}),
        ...(typeof checkpoint === 'function' ? { checkpoint } : {}),
      }
      try {
        if (job.kind === 'stock_prep_pull') {
          const data = await governedEntries.runGovernedStockPrepPull(
            context,
            { actionId: typeof job.actionId === 'string' && job.actionId ? job.actionId : actionId },
            options,
          )
          return summarizeStockPrepDryRun(data, startedAt)
        }
        if (job.kind === 'pipeline') {
          // ALWAYS dryRun:true (ADR Q12b: a non-dry run never leaves this module), triggeredBy 'automation'.
          const result = await governedEntries.runGovernedPipeline(
            context,
            { pipelineId: job.pipelineId, dryRun: true, triggeredBy: 'automation' },
            options,
          )
          return summarizePipelineRun(result, startedAt)
        }
        throw new TypeError('IntegrationRunPort.run: unreachable job kind')
      } catch (error) {
        if (isAbortLike(error)) throw error
        return classifyRefusal(error, startedAt)
      }
    },
  })
}

module.exports = {
  createIntegrationRunPort,
  __internals: { summarizeStockPrepDryRun, summarizePipelineRun, classifyRefusal, DEFAULT_STOCK_PREP_ACTION_ID },
}
