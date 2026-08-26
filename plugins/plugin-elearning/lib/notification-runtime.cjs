'use strict'

/**
 * L2 notification runtime adapter.
 *
 * The claim/finalize state machine stays in notification-worker.cjs. This
 * adapter wires it only when core supplies a current-state eligibility guard
 * and an explicit effect-side-idempotent platform dispatcher. It deliberately
 * does not infer the generic notification service as a safe provider.
 */

const { randomBytes } = require('node:crypto')
const { isReminderProducerEnabled } = require('./reminder-producer.cjs')
const { resolveDatabasePort } = require('./jobs.cjs')
const { runNotificationDeliveryBatch } = require('./notification-worker.cjs')

const RUNTIME_INTERVAL_MS = 30_000
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let timer = null
let runtimeGeneration = 0
let runningGeneration = null
let activeDatabase = null
let activeEligibility = null
let activeDispatch = null
let activeLogger = null
let activeWorkerId = null

function emptyResult(extra) {
  return {
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    outcomeUnknown: 0,
    released: 0,
    lostLease: 0,
    ...(extra || {}),
  }
}

function logValuesFree(logger, code) {
  if (!logger || typeof logger.warn !== 'function') return
  logger.warn('elearning notification runtime', { code })
}

function hasSupportedText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function readText(value, max = 512) {
  if (
    typeof value !== 'string'
    || value === ''
    || value !== value.trim()
    || value.length > max
    || !hasSupportedText(value)
  ) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  return value
}

function readUuid(value) {
  const text = readText(value, 36)
  if (!UUID_RE.test(text)) throw new Error('NOTIFICATION_ROW_INVALID')
  return text.toLowerCase()
}

function readPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  const payload = value
  const assignmentId = readUuid(payload.assignmentId)
  const assignmentMemberId = readUuid(payload.assignmentMemberId)
  const courseVersionId = readUuid(payload.courseVersionId)
  const windowStart = readText(payload.windowStart, 32)
  if (!CANONICAL_UTC_TIMESTAMP_RE.test(windowStart)) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  return {
    assignmentId,
    assignmentMemberId,
    courseVersionId,
    windowStart,
  }
}

function runtimeInputFromDelivery(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  const deliveryId = readUuid(row.id)
  const orgId = readText(row.org_id, 256)
  const assignmentMemberId = readUuid(row.assignment_member_id)
  const recipientUserId = readText(row.recipient_user_id, 256)
  if (
    row.kind !== 'assignment_reminder'
    || row.recipient_role !== 'learner'
    || row.channel !== 'platform'
  ) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  const payload = readPayload(row.payload)
  if (payload.assignmentMemberId !== assignmentMemberId) {
    throw new Error('NOTIFICATION_ROW_INVALID')
  }
  return {
    eligibility: { orgId, assignmentMemberId, recipientUserId },
    dispatch: {
      assignmentMemberId,
      deliveryId,
      idempotencyKey: `delivery:${deliveryId}`,
      kind: 'assignment_reminder',
      orgId,
      payload,
      recipientUserId,
    },
  }
}

function resolveNotificationRuntimePorts(context) {
  const services = context && context.services
  const eligibility = services && services.elearningNotificationEligibility
  const dispatch = services && services.elearningNotificationDispatch
  if (!eligibility || typeof eligibility.check !== 'function') return null
  if (!dispatch || typeof dispatch.dispatch !== 'function') return null
  return { eligibility, dispatch }
}

function makeWorkerId() {
  return `elearning-notifications:${process.pid}:${randomBytes(4).toString('hex')}`
}

function getNotificationRuntimeState() {
  return {
    generation: runtimeGeneration,
    intervalMs: RUNTIME_INTERVAL_MS,
    running: timer != null,
    timer,
    workerId: activeWorkerId,
  }
}

function stopNotificationRuntime() {
  runtimeGeneration += 1
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  activeDatabase = null
  activeEligibility = null
  activeDispatch = null
  activeLogger = null
  activeWorkerId = null
}

async function runNotificationRuntimeTick(override) {
  const opts = override && typeof override === 'object' ? override : {}
  const database = opts.database || activeDatabase
  const eligibility = opts.eligibility || activeEligibility
  const dispatch = opts.dispatch || activeDispatch
  const workerId = opts.workerId || activeWorkerId
  const generation = runtimeGeneration
  const enabled = typeof opts.isEnabled === 'function'
    ? opts.isEnabled
    : () => runtimeGeneration === generation && isReminderProducerEnabled()
  if (
    !database
    || !eligibility
    || typeof eligibility.check !== 'function'
    || !dispatch
    || typeof dispatch.dispatch !== 'function'
    || typeof workerId !== 'string'
    || workerId.trim() === ''
  ) {
    return emptyResult()
  }
  if (runningGeneration === generation) return emptyResult({ skipped: true })
  runningGeneration = generation
  try {
    return await runNotificationDeliveryBatch({
      isEnabled: enabled,
      database,
      workerId,
      batchSize: opts.batchSize,
      leaseMs: opts.leaseMs,
      maxAttempts: opts.maxAttempts,
      checkEligibility: async (row) => {
        const input = runtimeInputFromDelivery(row)
        return eligibility.check(input.eligibility)
      },
      dispatch: async (row) => {
        const input = runtimeInputFromDelivery(row)
        return dispatch.dispatch(input.dispatch)
      },
    })
  } finally {
    if (runningGeneration === generation) runningGeneration = null
  }
}

function startNotificationRuntime(context, options) {
  stopNotificationRuntime()
  if (!isReminderProducerEnabled()) return false
  const database = resolveDatabasePort(context)
  const ports = resolveNotificationRuntimePorts(context)
  if (!database || !ports) {
    logValuesFree(context && context.logger, 'NOTIFICATION_RUNTIME_UNAVAILABLE')
    return false
  }
  const opts = options && typeof options === 'object' ? options : {}
  activeDatabase = database
  activeEligibility = ports.eligibility
  activeDispatch = ports.dispatch
  activeLogger = context && context.logger ? context.logger : null
  activeWorkerId = typeof opts.workerId === 'string' && opts.workerId.trim()
    ? opts.workerId.trim()
    : makeWorkerId()
  timer = setInterval(() => {
    const logger = activeLogger
    void runNotificationRuntimeTick().catch(() => {
      logValuesFree(logger, 'NOTIFICATION_TICK_FAILED')
    })
  }, RUNTIME_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return true
}

module.exports = {
  RUNTIME_INTERVAL_MS,
  getNotificationRuntimeState,
  resolveNotificationRuntimePorts,
  runtimeInputFromDelivery,
  runNotificationRuntimeTick,
  startNotificationRuntime,
  stopNotificationRuntime,
}
