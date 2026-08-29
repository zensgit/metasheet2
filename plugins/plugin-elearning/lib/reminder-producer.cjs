'use strict'

const { isCapabilityEnabled } = require('./feature-flags.cjs')
const { registerJobHandler } = require('./jobs.cjs')

const ASSIGNMENT_REMINDER_JOB_KIND = 'assignment_reminder'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function isReminderProducerEnabled() {
  return isCapabilityEnabled('content') && isCapabilityEnabled('assignment')
}

function resolveReminderProducerPort(context) {
  const port = context && context.services && context.services.elearningReminderProducer
  return port && typeof port.produce === 'function' ? port : null
}

function readRequiredText(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.includes('\u0000')) {
    throw codedError('REMINDER_JOB_INVALID')
  }
  return value
}

function reminderInputFromJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw codedError('REMINDER_JOB_INVALID')
  }
  if (job.kind !== ASSIGNMENT_REMINDER_JOB_KIND) {
    throw codedError('REMINDER_JOB_INVALID')
  }
  const orgId = readRequiredText(job.org_id)
  const assignmentMemberId = readRequiredText(job.ref)
  if (!UUID_RE.test(assignmentMemberId)) throw codedError('REMINDER_JOB_INVALID')
  const occurrenceKey = readRequiredText(job.occurrence_key)
  const payload = job.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('REMINDER_JOB_INVALID')
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'windowStart')) {
    throw codedError('REMINDER_JOB_INVALID')
  }
  if (!(job.due_at instanceof Date) && typeof job.due_at !== 'string') {
    throw codedError('REMINDER_JOB_INVALID')
  }
  return {
    orgId,
    assignmentMemberId: assignmentMemberId.toLowerCase(),
    occurrenceKey,
    windowStart: payload.windowStart,
    dueAt: job.due_at,
  }
}

function mapProducerError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'invalid_input' || code === 'not_found' || code === 'conflict') {
    return codedError('REMINDER_JOB_INVALID')
  }
  return codedError('REMINDER_UNAVAILABLE')
}

function validateProducerResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw codedError('REMINDER_UNAVAILABLE')
  }
  if (result.outcome === 'ineligible') return result
  if (
    (result.outcome === 'enqueued' || result.outcome === 'duplicate')
    && typeof result.deliveryId === 'string'
    && UUID_RE.test(result.deliveryId)
  ) {
    return result
  }
  throw codedError('REMINDER_UNAVAILABLE')
}

function registerAssignmentReminderProducer(context) {
  if (!isReminderProducerEnabled()) return false
  const port = resolveReminderProducerPort(context)
  if (!port) throw codedError('REMINDER_PORT_REQUIRED')

  registerJobHandler(ASSIGNMENT_REMINDER_JOB_KIND, async (job) => {
    if (!isReminderProducerEnabled()) throw codedError('FEATURE_DISABLED')
    const input = reminderInputFromJob(job)
    try {
      return validateProducerResult(await port.produce(input))
    } catch (error) {
      if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        throw error
      }
      throw mapProducerError(error)
    }
  }, isReminderProducerEnabled)
  return true
}

module.exports = {
  ASSIGNMENT_REMINDER_JOB_KIND,
  isReminderProducerEnabled,
  resolveReminderProducerPort,
  reminderInputFromJob,
  registerAssignmentReminderProducer,
}
