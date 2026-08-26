'use strict'

/**
 * Inert L2 notification claim-lease kernel.
 *
 * Reachability: this module is not imported by plugin activate(). A caller
 * must inject isEnabled, checkEligibility, and dispatch. There is no timer,
 * route, env flag, or real notification channel here.
 *
 * Eligibility contract for the injected checker (not implemented here):
 * archived assignments remain eligible; withdrawn, revoked, and completed
 * assignments do not. Quiet hours and frequency belong to the producer.
 */

const DEFAULT_LEASE_MS = 60_000
const DEFAULT_BATCH_SIZE = 16
const DEFAULT_MAX_ATTEMPTS = 8
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const NOT_ELIGIBLE = 'NOT_ELIGIBLE'
const ELIGIBILITY_UNAVAILABLE = 'ELIGIBILITY_UNAVAILABLE'
const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
const ATTEMPTS_EXHAUSTED = 'ATTEMPTS_EXHAUSTED'
const CLAIM_FENCE = 'id, status sending, claim_worker_id, attempt_count'

const CLAIM_SQL = `
/* elearning-notification-worker:claim */
WITH due AS (
  SELECT id
    FROM elearning_notification_deliveries
   WHERE (
           status IN ('pending', 'retrying')
       AND next_attempt_at <= now()
         )
      OR (
           status = 'sending'
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at <= now()
         )
   ORDER BY next_attempt_at ASC, id ASC
   LIMIT $1::int
   FOR UPDATE SKIP LOCKED
)
UPDATE elearning_notification_deliveries AS delivery
   SET status = 'sending',
       attempt_count = delivery.attempt_count + 1,
       last_attempt_at = now(),
       claimed_at = now(),
       claim_expires_at = now() + ($2::int * interval '1 millisecond'),
       claim_worker_id = btrim($3::text),
       last_error = NULL,
       updated_at = now()
  FROM due
 WHERE delivery.id = due.id
 RETURNING delivery.id,
           delivery.org_id,
           delivery.assignment_member_id,
           delivery.kind,
           delivery.source_key,
           delivery.recipient_role,
           delivery.recipient_user_id,
           delivery.channel,
           delivery.payload,
           delivery.due_at,
           delivery.status,
           delivery.attempt_count,
           delivery.claim_worker_id
`

const FINALIZE_SENT_SQL = `
/* elearning-notification-worker:finalize-sent */
UPDATE elearning_notification_deliveries
   SET status = 'sent',
       delivered_at = now(),
       last_error = NULL,
       claimed_at = NULL,
       claim_expires_at = NULL,
       claim_worker_id = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND status = 'sending'
   AND claim_worker_id = $2
   AND attempt_count = $3::int
 RETURNING id
`

const FINALIZE_RETRYING_SQL = `
/* elearning-notification-worker:finalize-retrying */
UPDATE elearning_notification_deliveries
   SET status = 'retrying',
       next_attempt_at = now() + ($4::int * interval '1 millisecond'),
       last_error = $5,
       claimed_at = NULL,
       claim_expires_at = NULL,
       claim_worker_id = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND status = 'sending'
   AND claim_worker_id = $2
   AND attempt_count = $3::int
 RETURNING id
`

const FINALIZE_FAILED_SQL = `
/* elearning-notification-worker:finalize-failed */
UPDATE elearning_notification_deliveries
   SET status = 'failed',
       last_error = $4,
       claimed_at = NULL,
       claim_expires_at = NULL,
       claim_worker_id = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND status = 'sending'
   AND claim_worker_id = $2
   AND attempt_count = $3::int
 RETURNING id
`

const FINALIZE_OUTCOME_UNKNOWN_SQL = `
/* elearning-notification-worker:finalize-outcome-unknown */
UPDATE elearning_notification_deliveries
   SET status = 'outcome_unknown',
       last_error = $4,
       claimed_at = NULL,
       claim_expires_at = NULL,
       claim_worker_id = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND status = 'sending'
   AND claim_worker_id = $2
   AND attempt_count = $3::int
 RETURNING id
`

const RELEASE_PENDING_SQL = `
/* elearning-notification-worker:release-pending */
UPDATE elearning_notification_deliveries
   SET status = 'pending',
       last_error = NULL,
       claimed_at = NULL,
       claim_expires_at = NULL,
       claim_worker_id = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND status = 'sending'
   AND claim_worker_id = $2
   AND attempt_count = $3::int
 RETURNING id, attempt_count
`

function asRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function isDatabasePort(database) {
  return Boolean(database && typeof database.query === 'function')
}

function storedSafeInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readPositiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function readRequiredPositiveInt(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

function readWorkerId(value) {
  if (typeof value !== 'string') return null
  const workerId = value.trim()
  return workerId === '' ? null : workerId
}

function errorCode(value, fallback) {
  return typeof value === 'string' && ERROR_CODE_RE.test(value) ? value : fallback
}

function closedErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_RE.test(value) ? value : null
}

function emptyBatchResult() {
  return {
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    outcomeUnknown: 0,
    released: 0,
    lostLease: 0,
  }
}

function isEnabled(value) {
  if (value === true) return true
  if (typeof value === 'function') {
    try {
      return value() === true
    } catch {
      return false
    }
  }
  return false
}

function computeNotificationBackoffMs(attemptCount) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount <= 1) return 60_000
  if (attemptCount === 2) return 5 * 60_000
  if (attemptCount === 3) return 15 * 60_000
  if (attemptCount === 4) return 60 * 60_000
  return 6 * 60 * 60_000
}

function claimAttemptOf(row) {
  if (!row || typeof row !== 'object') return null
  const raw = Object.prototype.hasOwnProperty.call(row, 'attempt_count')
    ? row.attempt_count
    : row.attemptCount
  const parsed = storedSafeInt(raw)
  if (parsed == null || parsed <= 0) return null
  return parsed
}

function deliveryIdOf(row) {
  return row && typeof row.id === 'string' && row.id !== '' ? row.id : null
}

function normalizeDispatchResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'outcome_unknown', code: OUTCOME_UNKNOWN }
  }
  const outcome = typeof value.outcome === 'string'
    ? value.outcome
    : typeof value.status === 'string'
      ? value.status
      : null
  if (outcome === 'sent') return { kind: 'sent' }
  if (outcome === 'retryable') {
    const code = closedErrorCode(value.code)
    if (!code) return { kind: 'outcome_unknown', code: OUTCOME_UNKNOWN }
    return { kind: 'retryable', code }
  }
  if (outcome === 'failed') {
    const code = closedErrorCode(value.code)
    if (!code) return { kind: 'outcome_unknown', code: OUTCOME_UNKNOWN }
    return { kind: 'failed', code }
  }
  if (outcome === 'outcome_unknown') {
    return { kind: 'outcome_unknown', code: errorCode(value.code, OUTCOME_UNKNOWN) }
  }
  return { kind: 'outcome_unknown', code: OUTCOME_UNKNOWN }
}

async function queryRows(database, sql, params) {
  return asRows(await database.query(sql, params))
}

async function claimDueNotificationDeliveries(database, options) {
  if (!isDatabasePort(database)) return []
  const opts = options && typeof options === 'object' ? options : {}
  const workerId = readWorkerId(opts.workerId)
  if (!workerId) return []
  const batchSize = readPositiveInt(opts.batchSize, DEFAULT_BATCH_SIZE)
  const leaseMs = readPositiveInt(opts.leaseMs, DEFAULT_LEASE_MS)
  return queryRows(database, CLAIM_SQL, [batchSize, leaseMs, workerId])
}

async function fenceUpdate(database, sql, params) {
  if (!isDatabasePort(database)) return { ok: false, lostLease: true }
  const rows = await queryRows(database, sql, params)
  if (rows.length > 0) return { ok: true, lostLease: false, row: rows[0] }
  return { ok: false, lostLease: true }
}

async function finalizeNotificationSent(database, input) {
  const workerId = readWorkerId(input && input.workerId)
  const claimAttempt = readRequiredPositiveInt(input && input.claimAttempt)
  if (!input || !input.deliveryId || !workerId || !claimAttempt) {
    return { ok: false, lostLease: true }
  }
  return fenceUpdate(database, FINALIZE_SENT_SQL, [
    input.deliveryId,
    workerId,
    claimAttempt,
  ])
}

async function finalizeNotificationRetrying(database, input) {
  const workerId = readWorkerId(input && input.workerId)
  const claimAttempt = readRequiredPositiveInt(input && input.claimAttempt)
  const code = errorCode(input && input.code, OUTCOME_UNKNOWN)
  if (!input || !input.deliveryId || !workerId || !claimAttempt) {
    return { ok: false, lostLease: true }
  }
  const backoffMs = readPositiveInt(input.backoffMs, computeNotificationBackoffMs(claimAttempt))
  return fenceUpdate(database, FINALIZE_RETRYING_SQL, [
    input.deliveryId,
    workerId,
    claimAttempt,
    backoffMs,
    code,
  ])
}

async function finalizeNotificationFailed(database, input) {
  const workerId = readWorkerId(input && input.workerId)
  const claimAttempt = readRequiredPositiveInt(input && input.claimAttempt)
  const code = errorCode(input && input.code, NOT_ELIGIBLE)
  if (!input || !input.deliveryId || !workerId || !claimAttempt) {
    return { ok: false, lostLease: true }
  }
  return fenceUpdate(database, FINALIZE_FAILED_SQL, [
    input.deliveryId,
    workerId,
    claimAttempt,
    code,
  ])
}

async function finalizeNotificationOutcomeUnknown(database, input) {
  const workerId = readWorkerId(input && input.workerId)
  const claimAttempt = readRequiredPositiveInt(input && input.claimAttempt)
  const code = errorCode(input && input.code, OUTCOME_UNKNOWN)
  if (!input || !input.deliveryId || !workerId || !claimAttempt) {
    return { ok: false, lostLease: true }
  }
  return fenceUpdate(database, FINALIZE_OUTCOME_UNKNOWN_SQL, [
    input.deliveryId,
    workerId,
    claimAttempt,
    code,
  ])
}

async function releaseClaimedNotificationDelivery(database, input) {
  const workerId = readWorkerId(input && input.workerId)
  const claimAttempt = readRequiredPositiveInt(input && input.claimAttempt)
  if (!input || !input.deliveryId || !workerId || !claimAttempt) {
    return { ok: false, lostLease: true }
  }
  return fenceUpdate(database, RELEASE_PENDING_SQL, [
    input.deliveryId,
    workerId,
    claimAttempt,
  ])
}

async function applyDispatchOutcome(database, row, workerId, outcome) {
  const deliveryId = deliveryIdOf(row)
  const claimAttempt = claimAttemptOf(row)
  if (!deliveryId || !claimAttempt) return { ok: false, lostLease: true }
  if (outcome.kind === 'sent') {
    return finalizeNotificationSent(database, { deliveryId, workerId, claimAttempt })
  }
  if (outcome.kind === 'retryable') {
    return finalizeNotificationRetrying(database, {
      deliveryId,
      workerId,
      claimAttempt,
      code: outcome.code,
      backoffMs: computeNotificationBackoffMs(claimAttempt),
    })
  }
  if (outcome.kind === 'failed') {
    return finalizeNotificationFailed(database, {
      deliveryId,
      workerId,
      claimAttempt,
      code: outcome.code,
    })
  }
  return finalizeNotificationOutcomeUnknown(database, {
    deliveryId,
    workerId,
    claimAttempt,
    code: outcome.code,
  })
}

async function releaseRemaining(database, workerId, rows, fromIndex, result) {
  for (let index = fromIndex; index < rows.length; index += 1) {
    const row = rows[index]
    const released = await releaseClaimedNotificationDelivery(database, {
      deliveryId: deliveryIdOf(row),
      workerId,
      claimAttempt: claimAttemptOf(row),
    })
    if (released.ok) result.released += 1
    else result.lostLease += 1
  }
}

async function runNotificationDeliveryBatch(options) {
  const opts = options && typeof options === 'object' ? options : {}
  if (!isEnabled(opts.isEnabled)) return emptyBatchResult()
  if (!isDatabasePort(opts.database)) return emptyBatchResult()
  if (typeof opts.checkEligibility !== 'function' || typeof opts.dispatch !== 'function') {
    return emptyBatchResult()
  }
  const workerId = readWorkerId(opts.workerId)
  if (!workerId) return emptyBatchResult()
  const maxAttempts = readPositiveInt(opts.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  const enabled = () => isEnabled(opts.isEnabled)

  const claimed = await claimDueNotificationDeliveries(opts.database, {
    workerId,
    batchSize: opts.batchSize,
    leaseMs: opts.leaseMs,
  })
  const result = emptyBatchResult()
  result.claimed = claimed.length

  for (let index = 0; index < claimed.length; index += 1) {
    if (!enabled()) {
      await releaseRemaining(opts.database, workerId, claimed, index, result)
      break
    }

    const row = claimed[index]
    let eligible = false
    try {
      eligible = await opts.checkEligibility(row) === true
    } catch {
      const claimAttempt = claimAttemptOf(row)
      const atCeiling = claimAttempt != null && claimAttempt >= maxAttempts
      const finalized = atCeiling
        ? await finalizeNotificationFailed(opts.database, {
            deliveryId: deliveryIdOf(row),
            workerId,
            claimAttempt,
            code: ATTEMPTS_EXHAUSTED,
          })
        : await finalizeNotificationRetrying(opts.database, {
            deliveryId: deliveryIdOf(row),
            workerId,
            claimAttempt,
            code: ELIGIBILITY_UNAVAILABLE,
            backoffMs: computeNotificationBackoffMs(claimAttempt ?? 1),
          })
      if (finalized.ok) {
        if (atCeiling) result.failed += 1
        else result.retrying += 1
      } else {
        result.lostLease += 1
      }
      continue
    }
    if (!eligible) {
      const finalized = await finalizeNotificationFailed(opts.database, {
        deliveryId: deliveryIdOf(row),
        workerId,
        claimAttempt: claimAttemptOf(row),
        code: NOT_ELIGIBLE,
      })
      if (finalized.ok) result.failed += 1
      else result.lostLease += 1
      continue
    }

    if (!enabled()) {
      await releaseRemaining(opts.database, workerId, claimed, index, result)
      break
    }

    const claimAttempt = claimAttemptOf(row)
    let outcome
    try {
      outcome = normalizeDispatchResult(await opts.dispatch(row))
    } catch {
      outcome = { kind: 'outcome_unknown', code: OUTCOME_UNKNOWN }
    }
    if (
      outcome.kind === 'retryable'
      && claimAttempt != null
      && claimAttempt >= maxAttempts
    ) {
      outcome = { kind: 'failed', code: ATTEMPTS_EXHAUSTED }
    }

    const finalized = await applyDispatchOutcome(opts.database, row, workerId, outcome)
    if (!finalized.ok) {
      result.lostLease += 1
      continue
    }
    if (outcome.kind === 'sent') result.sent += 1
    else if (outcome.kind === 'retryable') result.retrying += 1
    else if (outcome.kind === 'failed') result.failed += 1
    else result.outcomeUnknown += 1
  }

  return result
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  ERROR_CODE_RE,
  NOT_ELIGIBLE,
  ELIGIBILITY_UNAVAILABLE,
  OUTCOME_UNKNOWN,
  ATTEMPTS_EXHAUSTED,
  CLAIM_FENCE,
  CLAIM_SQL,
  FINALIZE_SENT_SQL,
  FINALIZE_RETRYING_SQL,
  FINALIZE_FAILED_SQL,
  FINALIZE_OUTCOME_UNKNOWN_SQL,
  RELEASE_PENDING_SQL,
  computeNotificationBackoffMs,
  claimDueNotificationDeliveries,
  finalizeNotificationSent,
  finalizeNotificationRetrying,
  finalizeNotificationFailed,
  finalizeNotificationOutcomeUnknown,
  releaseClaimedNotificationDelivery,
  runNotificationDeliveryBatch,
}
