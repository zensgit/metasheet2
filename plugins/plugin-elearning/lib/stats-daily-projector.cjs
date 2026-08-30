'use strict'

const { isCapabilityEnabled } = require('./feature-flags.cjs')
const { registerJobHandler } = require('./jobs.cjs')

const STATS_DAILY_PROJECT_JOB_KIND = 'stats_daily_project'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function isStatsDailyProjectorEnabled() {
  return isCapabilityEnabled('analytics')
}

function resolveStatsDailyProjectionPort(context) {
  const port = context && context.services && context.services.elearningStatsDailyProjection
  return port && typeof port.project === 'function' ? port : null
}

function readRequiredText(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.includes('\u0000')) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  return value
}

function readCanonicalDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  return value
}

function statsDailyProjectionInputFromJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  if (job.kind !== STATS_DAILY_PROJECT_JOB_KIND) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  const orgId = readRequiredText(job.org_id)
  const departmentId = readRequiredText(job.ref)
  if (!UUID_RE.test(departmentId)) throw codedError('STATS_DAILY_JOB_INVALID')
  const payload = job.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  if (Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, 'statsDate')) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  const statsDate = readCanonicalDate(payload.statsDate)
  const occurrenceKey = readRequiredText(job.occurrence_key)
  if (occurrenceKey !== `department:${departmentId}:date:${statsDate}`) {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  if (!(job.due_at instanceof Date) && typeof job.due_at !== 'string') {
    throw codedError('STATS_DAILY_JOB_INVALID')
  }
  const dueAt = new Date(job.due_at)
  if (Number.isNaN(dueAt.getTime())) throw codedError('STATS_DAILY_JOB_INVALID')
  return { orgId, departmentId, statsDate }
}

function validateProjectionResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw codedError('STATS_DAILY_UNAVAILABLE')
  }
  if (!['noop', 'projected'].includes(result.outcome)) {
    throw codedError('STATS_DAILY_UNAVAILABLE')
  }
  if (!Number.isSafeInteger(result.projectedVersion) || result.projectedVersion <= 0) {
    throw codedError('STATS_DAILY_UNAVAILABLE')
  }
  if (typeof result.suppressed !== 'boolean') {
    throw codedError('STATS_DAILY_UNAVAILABLE')
  }
  if (Object.keys(result).sort().join(',') !== 'outcome,projectedVersion,suppressed') {
    throw codedError('STATS_DAILY_UNAVAILABLE')
  }
  return result
}

function mapProjectionError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'invalid_input' || code === 'not_found') {
    return codedError('STATS_DAILY_JOB_INVALID')
  }
  return codedError('STATS_DAILY_UNAVAILABLE')
}

function registerStatsDailyProjector(context) {
  if (!isStatsDailyProjectorEnabled()) return false
  const port = resolveStatsDailyProjectionPort(context)
  if (!port) throw codedError('STATS_DAILY_PORT_REQUIRED')

  registerJobHandler(STATS_DAILY_PROJECT_JOB_KIND, async (job) => {
    if (!isStatsDailyProjectorEnabled()) throw codedError('FEATURE_DISABLED')
    const input = statsDailyProjectionInputFromJob(job)
    try {
      return validateProjectionResult(await port.project(input))
    } catch (error) {
      if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        throw error
      }
      throw mapProjectionError(error)
    }
  }, isStatsDailyProjectorEnabled)
  return true
}

module.exports = {
  STATS_DAILY_PROJECT_JOB_KIND,
  isStatsDailyProjectorEnabled,
  resolveStatsDailyProjectionPort,
  statsDailyProjectionInputFromJob,
  registerStatsDailyProjector,
}
