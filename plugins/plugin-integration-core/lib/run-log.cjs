'use strict'

// Cap on the error_summary column so adapter errors that include full HTTP
// response bodies or huge stack traces don't bloat the runs table. Long
// summaries are truncated with a clear suffix so downstream tools can detect
// truncation without re-reading the original row.
const MAX_ERROR_SUMMARY_LENGTH = 2000
const TRUNCATION_SUFFIX = '… [truncated]'

function truncateErrorSummary(value) {
  if (value === undefined || value === null) return value
  const str = typeof value === 'string' ? value : String(value)
  if (str.length <= MAX_ERROR_SUMMARY_LENGTH) return str
  return str.slice(0, MAX_ERROR_SUMMARY_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
}

function nowIso() {
  return new Date().toISOString()
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return value || nowIso()
}

function normalizeMetrics(metrics = {}) {
  return {
    rowsRead: metrics.rowsRead ?? 0,
    rowsCleaned: metrics.rowsCleaned ?? 0,
    rowsWritten: metrics.rowsWritten ?? 0,
    rowsFailed: metrics.rowsFailed ?? 0,
    durationMs: metrics.durationMs,
  }
}

function deriveDurationMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (Number.isNaN(start) || Number.isNaN(finish)) return undefined
  return Math.max(0, finish - start)
}

function createRunLogger({ pipelineRegistry, clock = nowIso } = {}) {
  if (!pipelineRegistry || typeof pipelineRegistry.createPipelineRun !== 'function' || typeof pipelineRegistry.updatePipelineRun !== 'function') {
    throw new Error('createRunLogger: pipelineRegistry is required')
  }

  async function startRun(input = {}) {
    const { tenantId, workspaceId, pipelineId, mode, triggeredBy, details } = input
    const startedAt = toIso(clock())
    return pipelineRegistry.createPipelineRun({
      tenantId,
      workspaceId,
      pipelineId,
      mode,
      triggeredBy,
      status: 'running',
      startedAt,
      details,
    })
  }

  async function finishRun(run, metrics = {}, status = 'succeeded', extra = {}) {
    if (!run || typeof run !== 'object') {
      throw new Error('finishRun: run is required')
    }
    const normalizedMetrics = normalizeMetrics(metrics)
    const finishedAt = toIso(extra.finishedAt || clock())
    const durationMs = normalizedMetrics.durationMs ?? deriveDurationMs(run.startedAt, finishedAt)
    return pipelineRegistry.updatePipelineRun({
      tenantId: run.tenantId,
      workspaceId: run.workspaceId,
      id: run.id,
      status,
      rowsRead: normalizedMetrics.rowsRead,
      rowsCleaned: normalizedMetrics.rowsCleaned,
      rowsWritten: normalizedMetrics.rowsWritten,
      rowsFailed: normalizedMetrics.rowsFailed,
      finishedAt,
      durationMs,
      errorSummary: truncateErrorSummary(extra.errorSummary),
      details: {
        ...(run.details || {}),
        ...(extra.details || {}),
      },
    })
  }

  async function failRun(run, error, metrics = {}, extra = {}) {
    return finishRun(run, metrics, 'failed', {
      ...extra,
      errorSummary: truncateErrorSummary(
        extra.errorSummary || (error && error.message) || String(error),
      ),
    })
  }

  return {
    fail: failRun,
    failRun,
    finish: finishRun,
    startRun,
    start: startRun,
    finishRun,
  }
}

module.exports = {
  MAX_ERROR_SUMMARY_LENGTH,
  createRunLog: createRunLogger,
  createRunLogger,
  __internals: {
    deriveDurationMs,
    normalizeMetrics,
    nowIso,
    toIso,
    truncateErrorSummary,
  },
}
