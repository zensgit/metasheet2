'use strict'

const { isCapabilityEnabled } = require('./feature-flags.cjs')
const { registerJobHandler } = require('./jobs.cjs')

const ANALYTICS_EXPORT_JOB_KIND = 'analytics_export'
const ANALYTICS_EXPORT_CLEANUP_JOB_KIND = 'analytics_export_cleanup'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function isAnalyticsExportEnabled() {
  return isCapabilityEnabled('analytics')
}

function resolveAnalyticsExportPort(context) {
  const port = context && context.services && context.services.elearningAnalyticsExport
  return port
    && typeof port.materialize === 'function'
    && typeof port.cleanup === 'function'
    ? port
    : null
}

function requiredText(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.includes('\u0000')) {
    throw codedError('ANALYTICS_EXPORT_JOB_INVALID')
  }
  return value
}

function inputFromJob(job, kind) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.kind !== kind) {
    throw codedError('ANALYTICS_EXPORT_JOB_INVALID')
  }
  const orgId = requiredText(job.org_id)
  const exportJobId = requiredText(job.ref)
  if (!UUID_RE.test(exportJobId)) throw codedError('ANALYTICS_EXPORT_JOB_INVALID')
  const payload = job.payload
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || Object.keys(payload).length !== 1
    || payload.exportJobId !== exportJobId
  ) throw codedError('ANALYTICS_EXPORT_JOB_INVALID')
  const expectedOccurrence = kind === ANALYTICS_EXPORT_JOB_KIND
    ? `export:${exportJobId}`
    : `export:${exportJobId}:cleanup`
  if (requiredText(job.occurrence_key) !== expectedOccurrence) {
    throw codedError('ANALYTICS_EXPORT_JOB_INVALID')
  }
  return { orgId, exportId: exportJobId }
}

function validateResult(result, outcomes) {
  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || Object.keys(result).sort().join(',') !== 'exportId,outcome'
    || !outcomes.includes(result.outcome)
    || typeof result.exportId !== 'string'
    || !UUID_RE.test(result.exportId)
  ) throw codedError('ANALYTICS_EXPORT_UNAVAILABLE')
  return result
}

function mapError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'invalid_input' || code === 'not_found' || code === 'expired') {
    return codedError('ANALYTICS_EXPORT_JOB_INVALID')
  }
  return codedError('ANALYTICS_EXPORT_UNAVAILABLE')
}

function registerAnalyticsExportWorker(context) {
  if (!isAnalyticsExportEnabled()) return false
  const port = resolveAnalyticsExportPort(context)
  if (!port) throw codedError('ANALYTICS_EXPORT_PORT_REQUIRED')

  registerJobHandler(ANALYTICS_EXPORT_JOB_KIND, async (job) => {
    if (!isAnalyticsExportEnabled()) throw codedError('FEATURE_DISABLED')
    const input = inputFromJob(job, ANALYTICS_EXPORT_JOB_KIND)
    try {
      return validateResult(await port.materialize(input), ['materialized', 'noop'])
    } catch (error) {
      if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        throw error
      }
      throw mapError(error)
    }
  }, isAnalyticsExportEnabled)

  registerJobHandler(ANALYTICS_EXPORT_CLEANUP_JOB_KIND, async (job) => {
    if (!isAnalyticsExportEnabled()) throw codedError('FEATURE_DISABLED')
    const input = inputFromJob(job, ANALYTICS_EXPORT_CLEANUP_JOB_KIND)
    try {
      return validateResult(await port.cleanup(input), ['expired', 'noop'])
    } catch (error) {
      if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        throw error
      }
      throw mapError(error)
    }
  }, isAnalyticsExportEnabled)
  return true
}

module.exports = {
  ANALYTICS_EXPORT_JOB_KIND,
  ANALYTICS_EXPORT_CLEANUP_JOB_KIND,
  isAnalyticsExportEnabled,
  resolveAnalyticsExportPort,
  analyticsExportInputFromJob: inputFromJob,
  registerAnalyticsExportWorker,
}
