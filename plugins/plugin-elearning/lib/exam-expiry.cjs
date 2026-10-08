'use strict'

const { isCapabilityEnabled } = require('./feature-flags.cjs')
const { registerJobHandler } = require('./jobs.cjs')

const EXAM_EXPIRY_JOB_KIND = 'exam_attempt_expiry'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function isExamExpiryEnabled() {
  return isCapabilityEnabled('content')
    && isCapabilityEnabled('media')
    && isCapabilityEnabled('assessment')
}

function resolveExamExpiryPort(context) {
  const port = context && context.services && context.services.elearningExamExpirySettlement
  return port && typeof port.settle === 'function' ? port : null
}

function readRequiredText(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.includes('\u0000')) {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  return value
}

function examExpiryInputFromJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  if (job.kind !== EXAM_EXPIRY_JOB_KIND) {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  const orgId = readRequiredText(job.org_id)
  const attemptId = readRequiredText(job.ref)
  if (!UUID_RE.test(attemptId)) throw codedError('EXAM_EXPIRY_JOB_INVALID')
  if (job.occurrence_key !== `attempt:${attemptId}`) {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  if (
    !job.payload
    || typeof job.payload !== 'object'
    || Array.isArray(job.payload)
    || Object.keys(job.payload).length !== 0
  ) {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  if (!(job.due_at instanceof Date) && typeof job.due_at !== 'string') {
    throw codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  const dueAt = job.due_at instanceof Date ? job.due_at : new Date(job.due_at)
  if (!Number.isFinite(dueAt.getTime())) throw codedError('EXAM_EXPIRY_JOB_INVALID')
  return { orgId, attemptId }
}

function validateSettlementResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw codedError('EXAM_EXPIRY_UNAVAILABLE')
  }
  if (result.outcome === 'settled' || result.outcome === 'duplicate') return result
  if (result.outcome === 'not_due') throw codedError('EXAM_EXPIRY_NOT_DUE')
  throw codedError('EXAM_EXPIRY_UNAVAILABLE')
}

function mapSettlementError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'invalid_input' || code === 'not_found') {
    return codedError('EXAM_EXPIRY_JOB_INVALID')
  }
  return codedError('EXAM_EXPIRY_UNAVAILABLE')
}

function registerExamExpirySettlement(context) {
  if (!isExamExpiryEnabled()) return false
  const port = resolveExamExpiryPort(context)
  if (!port) throw codedError('EXAM_EXPIRY_PORT_REQUIRED')

  registerJobHandler(EXAM_EXPIRY_JOB_KIND, async (job) => {
    if (!isExamExpiryEnabled()) throw codedError('FEATURE_DISABLED')
    const input = examExpiryInputFromJob(job)
    try {
      return validateSettlementResult(await port.settle(input))
    } catch (error) {
      if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        throw error
      }
      throw mapSettlementError(error)
    }
  }, isExamExpiryEnabled)
  return true
}

module.exports = {
  EXAM_EXPIRY_JOB_KIND,
  examExpiryInputFromJob,
  isExamExpiryEnabled,
  registerExamExpirySettlement,
  resolveExamExpiryPort,
}
