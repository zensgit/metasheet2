'use strict'

const { createHash } = require('node:crypto')
const { isCapabilityEnabled } = require('./feature-flags.cjs')
const { registerJobHandler } = require('./jobs.cjs')

const ONBOARDING_ASSIGN_JOB_KIND = 'onboarding_assign'
const ONBOARDING_WEEKLY_REPORT_JOB_KIND = 'onboarding_weekly_report'
const ONBOARDING_ASSIGNMENT_JOB_INVALID = 'ONBOARDING_ASSIGNMENT_JOB_INVALID'
const ONBOARDING_WEEKLY_REPORT_JOB_INVALID = 'ONBOARDING_WEEKLY_REPORT_JOB_INVALID'
const ONBOARDING_ASSIGNMENT_UNAVAILABLE = 'ONBOARDING_ASSIGNMENT_UNAVAILABLE'
const ONBOARDING_WEEKLY_REPORT_UNAVAILABLE = 'ONBOARDING_WEEKLY_REPORT_UNAVAILABLE'
const ONBOARDING_NOT_ELIGIBLE = 'ONBOARDING_NOT_ELIGIBLE'
const ONBOARDING_PORT_REQUIRED = 'ONBOARDING_PORT_REQUIRED'
const ONBOARDING_ASSIGNMENT_METHOD_REQUIRED = 'ONBOARDING_ASSIGNMENT_METHOD_REQUIRED'
const ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED = 'ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const ASSIGNMENT_PAYLOAD_KEYS = 'hireDate,policyId,userId'
const WEEKLY_REPORT_PAYLOAD_KEYS = 'policyId,weekStart'
const ASSIGNMENT_DOMAIN = 'elearning.onboarding.assignment.v1'

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function isOnboardingAssignmentEnabled() {
  return isCapabilityEnabled('content') && isCapabilityEnabled('assignment')
}

function isOnboardingWeeklyReportEnabled() {
  return isCapabilityEnabled('analytics')
}

function resolveElearningOnboardingPort(context) {
  const port = context && context.services && context.services.elearningOnboarding
  return port && typeof port === 'object' && !Array.isArray(port) ? port : null
}

function requiredText(value, code, max = 512) {
  if (
    typeof value !== 'string'
    || value === ''
    || value !== value.trim()
    || value.length > max
    || value.includes('\u0000')
  ) throw codedError(code)
  return value
}

function requiredUuid(value, code) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw codedError(code)
  return value.toLowerCase()
}

function canonicalDate(value, code) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw codedError(code)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw codedError(code)
  }
  return value
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === expected
}

function assignmentOccurrenceKey(input) {
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries({
      domain: ASSIGNMENT_DOMAIN,
      hireDate: input.hireDate,
      orgId: input.orgId,
      policyId: input.policyId,
      userId: input.userId,
    }).sort(([left], [right]) => left.localeCompare(right)),
  ))
  return `onboarding-assign-v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function parseAssignmentJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.kind !== ONBOARDING_ASSIGN_JOB_KIND) {
    throw codedError(ONBOARDING_ASSIGNMENT_JOB_INVALID)
  }
  const jobId = requiredUuid(job.id, ONBOARDING_ASSIGNMENT_JOB_INVALID)
  const orgId = requiredText(job.org_id, ONBOARDING_ASSIGNMENT_JOB_INVALID, 256)
  const policyId = requiredUuid(job.ref, ONBOARDING_ASSIGNMENT_JOB_INVALID)
  if (job.ref !== policyId) throw codedError(ONBOARDING_ASSIGNMENT_JOB_INVALID)
  const payload = job.payload
  if (!exactKeys(payload, ASSIGNMENT_PAYLOAD_KEYS)) {
    throw codedError(ONBOARDING_ASSIGNMENT_JOB_INVALID)
  }
  const payloadPolicyId = requiredUuid(payload.policyId, ONBOARDING_ASSIGNMENT_JOB_INVALID)
  const userId = requiredText(payload.userId, ONBOARDING_ASSIGNMENT_JOB_INVALID, 256)
  const hireDate = canonicalDate(payload.hireDate, ONBOARDING_ASSIGNMENT_JOB_INVALID)
  if (
    payloadPolicyId !== policyId
    || job.occurrence_key !== assignmentOccurrenceKey({ orgId, policyId, userId, hireDate })
  ) throw codedError(ONBOARDING_ASSIGNMENT_JOB_INVALID)
  return { orgId, jobId, policyId, userId, hireDate }
}

function parseWeeklyReportJob(job) {
  if (
    !job
    || typeof job !== 'object'
    || Array.isArray(job)
    || job.kind !== ONBOARDING_WEEKLY_REPORT_JOB_KIND
  ) throw codedError(ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  const jobId = requiredUuid(job.id, ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  const orgId = requiredText(job.org_id, ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  const policyId = requiredUuid(job.ref, ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  if (job.ref !== policyId) throw codedError(ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  const payload = job.payload
  if (!exactKeys(payload, WEEKLY_REPORT_PAYLOAD_KEYS)) {
    throw codedError(ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  }
  const payloadPolicyId = requiredUuid(payload.policyId, ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  const weekStart = canonicalDate(payload.weekStart, ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  if (
    payloadPolicyId !== policyId
    || job.occurrence_key !== `policy:${policyId}:week:${weekStart}`
  ) throw codedError(ONBOARDING_WEEKLY_REPORT_JOB_INVALID)
  return { orgId, jobId, policyId, weekStart }
}

function validateAssignmentResult(result, input) {
  if (
    !exactKeys(result, 'duplicate,effectId,planAssignmentId,policyId,userId')
    || typeof result.duplicate !== 'boolean'
    || typeof result.userId !== 'string'
    || result.userId !== result.userId.trim()
    || result.userId === ''
    || !UUID_RE.test(result.effectId)
    || !UUID_RE.test(result.policyId)
    || !UUID_RE.test(result.planAssignmentId)
    || result.policyId.toLowerCase() !== input.policyId
    || result.userId !== input.userId
  ) throw codedError(ONBOARDING_ASSIGNMENT_UNAVAILABLE)
  return result
}

function addDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateWeeklyReportResult(result, input) {
  if (
    !exactKeys(
      result,
      'assignedUserCount,deadCount,duplicate,enqueuedCount,failedCount,minGroupSize,policyId,reportId,suppressed,weekEnd,weekStart',
    )
    || !UUID_RE.test(result.reportId)
    || !UUID_RE.test(result.policyId)
    || result.policyId.toLowerCase() !== input.policyId
    || result.weekStart !== input.weekStart
    || result.weekEnd !== addDays(input.weekStart, 7)
    || typeof result.suppressed !== 'boolean'
    || result.minGroupSize !== 5
    || typeof result.duplicate !== 'boolean'
  ) throw codedError(ONBOARDING_WEEKLY_REPORT_UNAVAILABLE)

  const counts = [
    result.enqueuedCount,
    result.assignedUserCount,
    result.failedCount,
    result.deadCount,
  ]
  if (result.suppressed) {
    if (counts.some((value) => value !== null)) throw codedError(ONBOARDING_WEEKLY_REPORT_UNAVAILABLE)
  } else if (
    counts.some((value) => !nonnegativeInteger(value))
    || result.enqueuedCount < 5
    || result.assignedUserCount > result.enqueuedCount
    || result.failedCount + result.deadCount > result.enqueuedCount
  ) throw codedError(ONBOARDING_WEEKLY_REPORT_UNAVAILABLE)
  return result
}

function mapError(error, invalidCode, unavailableCode) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (ERROR_CODE_RE.test(code)) return error
  if (['invalid_input', 'not_found', 'conflict'].includes(code)) {
    return codedError(invalidCode)
  }
  if (code === 'not_eligible') return codedError(ONBOARDING_NOT_ELIGIBLE)
  return codedError(unavailableCode)
}

function registerOnboardingWorker(context) {
  const assignmentEnabled = isOnboardingAssignmentEnabled()
  const weeklyReportEnabled = isOnboardingWeeklyReportEnabled()
  if (!assignmentEnabled && !weeklyReportEnabled) return false

  const port = resolveElearningOnboardingPort(context)
  if (!port) throw codedError(ONBOARDING_PORT_REQUIRED)
  if (assignmentEnabled && typeof port.processAssignment !== 'function') {
    throw codedError(ONBOARDING_ASSIGNMENT_METHOD_REQUIRED)
  }
  if (weeklyReportEnabled && typeof port.materializeWeeklyReport !== 'function') {
    throw codedError(ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED)
  }

  if (assignmentEnabled) {
    registerJobHandler(ONBOARDING_ASSIGN_JOB_KIND, async (job) => {
      if (!isOnboardingAssignmentEnabled()) throw codedError('FEATURE_DISABLED')
      const parsed = parseAssignmentJob(job)
      try {
        return validateAssignmentResult(
          await port.processAssignment({ orgId: parsed.orgId, jobId: parsed.jobId }),
          parsed,
        )
      } catch (error) {
        throw mapError(error, ONBOARDING_ASSIGNMENT_JOB_INVALID, ONBOARDING_ASSIGNMENT_UNAVAILABLE)
      }
    }, isOnboardingAssignmentEnabled)
  }

  if (weeklyReportEnabled) {
    registerJobHandler(ONBOARDING_WEEKLY_REPORT_JOB_KIND, async (job) => {
      if (!isOnboardingWeeklyReportEnabled()) throw codedError('FEATURE_DISABLED')
      const parsed = parseWeeklyReportJob(job)
      try {
        return validateWeeklyReportResult(
          await port.materializeWeeklyReport({ orgId: parsed.orgId, jobId: parsed.jobId }),
          parsed,
        )
      } catch (error) {
        throw mapError(error, ONBOARDING_WEEKLY_REPORT_JOB_INVALID, ONBOARDING_WEEKLY_REPORT_UNAVAILABLE)
      }
    }, isOnboardingWeeklyReportEnabled)
  }
  return true
}

module.exports = {
  ONBOARDING_ASSIGN_JOB_KIND,
  ONBOARDING_WEEKLY_REPORT_JOB_KIND,
  ONBOARDING_ASSIGNMENT_JOB_INVALID,
  ONBOARDING_WEEKLY_REPORT_JOB_INVALID,
  ONBOARDING_ASSIGNMENT_UNAVAILABLE,
  ONBOARDING_WEEKLY_REPORT_UNAVAILABLE,
  ONBOARDING_NOT_ELIGIBLE,
  ONBOARDING_PORT_REQUIRED,
  ONBOARDING_ASSIGNMENT_METHOD_REQUIRED,
  ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED,
  isOnboardingAssignmentEnabled,
  isOnboardingWeeklyReportEnabled,
  resolveElearningOnboardingPort,
  onboardingAssignmentInputFromJob: (job) => {
    const parsed = parseAssignmentJob(job)
    return { orgId: parsed.orgId, jobId: parsed.jobId }
  },
  onboardingWeeklyReportInputFromJob: (job) => {
    const parsed = parseWeeklyReportJob(job)
    return { orgId: parsed.orgId, jobId: parsed.jobId }
  },
  validateAssignmentResult,
  validateWeeklyReportResult,
  registerOnboardingWorker,
}
