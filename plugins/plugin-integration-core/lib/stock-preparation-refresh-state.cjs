'use strict'

// Batch-refresh step 4, PR-1 — THE PROJECT REFRESH STATE, derived, never stored (design §9.1).
//
// PURE: one function from a governance CONSULT answer to a state token, the counters plan §5.3 keeps
// separate, and the export predicate. No I/O, no clock (time comparisons use only timestamps that are IN
// the answer). In PR-1 nothing calls it; PR-2 builds the consult (lib/stock-preparation-refresh-
// governance.cjs) and PR-5 gates the formal export, the overview posture, the board and the handoff
// terminal hop on it.
//
// THREE DISTINCT ANSWERS (plan §8, design D8): `not_governed`, `unreadable`, and a governed state. A read
// failure is NEVER turned into "no continuation" / "no hold" / "nothing running": anything that is not an
// explicit, well-formed `{ ok: true, ... }` answer is `unreadable`, and `unreadable` refuses the export.
//
// THE CONSULT CONTRACT (what PR-2 must produce; every array REQUIRED, `[]` when the store answered "none"):
//   {
//     ok: true,
//     pilot: null | { enabled: boolean, enabledAt?: string|null, readinessVersion?: * },
//     continuations: [{ id, status: 'active'|'needs_reconfirmation'|'ended', revision,
//                       executedExecutionId: string|null, confirmedAt: ISO string }],
//     holds:         [{ id, status: 'open'|'resolved'|'superseded', kind, confirmable: boolean }],
//     state:         null | { settledAt: ISO|null, settledExecutionId: string|null, ... },
//     executions:    [{ id, status: 'running'|'succeeded'|'partial'|'failed'|'aborted'|'verified_closed',
//                       leaseId: string|null, startedAt: ISO }],
//     changePlans:   [{ id, status: 'confirmed'|'written'|'reviewed'|'invalidated'|'superseded' }],
//     lock: {
//       state:      the #6501 lock `readState(scope)` answer   { present, leaseHeld, leaseLive, ... }
//       generation: the #6501 lock `readGeneration(scope)`    { generationToken, fencingEpoch, leaseId, ... }
//     },
//   }
// A failed read is answered as `{ ok: false, failure: { store, operation } }` (or any non-`ok` value / a
// thrown Error object handed over as-is): `unreadable`, with the values-free failure echoed.
//
// THE LOCK NEEDS BOTH #6501 SHAPES: "an execution `running` whose lease_id is the live lease" needs the
// LIVE flag (readState.leaseLive — expiry + grace) and the lease ID (only readGeneration exposes it). A
// failed lock read is `unreadable`, NEVER "no live lease, so the running execution died".

const STATUS_TOKENS = Object.freeze([
  'unreadable',
  'not_governed',
  'executing',
  'failed_pending_recovery',
  'pending_confirmation',
  'change_pending_review',
  'confirmed_pending_execution',
  'executed_pending_settlement',
  'complete',
])

const STATUS_LABELS_ZH = Object.freeze({
  unreadable: '状态读取失败',
  not_governed: '未启用',
  executing: '执行中',
  failed_pending_recovery: '失败待恢复',
  pending_confirmation: '待确认',
  change_pending_review: '变更待复核',
  confirmed_pending_execution: '已确认待执行',
  executed_pending_settlement: '已执行待核对',
  complete: '已完成',
})

const CONTINUATION_STATUSES = Object.freeze(['active', 'needs_reconfirmation', 'ended'])
const HOLD_STATUSES = Object.freeze(['open', 'resolved', 'superseded'])
const EXECUTION_STATUSES = Object.freeze(['running', 'succeeded', 'partial', 'failed', 'aborted', 'verified_closed'])
const UNVERIFIED_FAILURE_STATUSES = Object.freeze(['partial', 'failed', 'aborted'])
const CHANGE_PLAN_STATUSES = Object.freeze(['confirmed', 'written', 'reviewed', 'invalidated', 'superseded'])

const STORE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function timestampOf(value) {
  if (!nonBlankString(value)) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

class MalformedConsultError extends Error {
  constructor(section) {
    super(`refresh-state consult: ${section} is malformed`)
    this.section = section
  }
}

function unreadable(reason, failure) {
  const out = {
    readable: false,
    status: 'unreadable',
    statusLabel: STATUS_LABELS_ZH.unreadable,
    governed: 'unknown',
    exportAllowed: false,
    counts: null,
    unreadable: { reason },
  }
  // Values-free: two closed-shape tokens at most, never an error message or a value.
  if (isPlainObject(failure)) {
    if (typeof failure.store === 'string' && STORE_TOKEN.test(failure.store)) out.unreadable.store = failure.store
    if (typeof failure.operation === 'string' && STORE_TOKEN.test(failure.operation)) out.unreadable.operation = failure.operation
  }
  return Object.freeze(out)
}

function requireArray(consult, section, check) {
  const value = consult[section]
  if (!Array.isArray(value)) throw new MalformedConsultError(section)
  for (const entry of value) {
    if (!isPlainObject(entry) || !check(entry)) throw new MalformedConsultError(section)
  }
  return value
}

function normalizeConsult(consult) {
  const continuations = requireArray(consult, 'continuations', (entry) => nonBlankString(entry.id)
    && CONTINUATION_STATUSES.includes(entry.status)
    && (entry.executedExecutionId === null || entry.executedExecutionId === undefined || nonBlankString(entry.executedExecutionId)))
  const holds = requireArray(consult, 'holds', (entry) => nonBlankString(entry.id)
    && HOLD_STATUSES.includes(entry.status)
    && typeof entry.confirmable === 'boolean')
  const executions = requireArray(consult, 'executions', (entry) => nonBlankString(entry.id)
    && EXECUTION_STATUSES.includes(entry.status)
    && (entry.leaseId === null || entry.leaseId === undefined || nonBlankString(entry.leaseId)))
  const changePlans = requireArray(consult, 'changePlans', (entry) => nonBlankString(entry.id) && CHANGE_PLAN_STATUSES.includes(entry.status))
  if (consult.pilot !== null && !(isPlainObject(consult.pilot) && typeof consult.pilot.enabled === 'boolean')) {
    throw new MalformedConsultError('pilot')
  }
  if (consult.state !== null && !isPlainObject(consult.state)) throw new MalformedConsultError('state')
  const lock = consult.lock
  if (!isPlainObject(lock) || !isPlainObject(lock.state) || !isPlainObject(lock.generation)
    || typeof lock.state.leaseLive !== 'boolean'
    || typeof lock.state.leaseHeld !== 'boolean'
    || !(lock.generation.leaseId === null || nonBlankString(lock.generation.leaseId))) {
    throw new MalformedConsultError('lock')
  }
  return { continuations, holds, executions, changePlans, pilot: consult.pilot, state: consult.state, lock }
}

function newestExecution(executions) {
  return executions.slice().sort((left, right) => {
    const leftAt = timestampOf(left.startedAt)
    const rightAt = timestampOf(right.startedAt)
    if (leftAt !== rightAt) {
      if (leftAt === null) return 1
      if (rightAt === null) return -1
      return rightAt - leftAt
    }
    return left.id < right.id ? 1 : (left.id > right.id ? -1 : 0)
  })[0] || null
}

/**
 * Derive the project's refresh state from a consult answer. First matching predicate wins, in the
 * design §9.1 order. Returns a frozen, values-free object:
 *   { readable, status, statusLabel, governed: 'pilot'|'protected'|'none'|'unknown', exportAllowed,
 *     counts: { pendingConfirm, confirmable, openExecutions, pendingReviews, continuations } | null,
 *     unreadable?: { reason, store?, operation? } }
 */
function readProjectRefreshState(consult) {
  if (consult instanceof Error) return unreadable('consult_threw')
  if (!isPlainObject(consult)) return unreadable('consult_absent')
  if (consult.ok !== true) return unreadable('store_read_failed', consult.failure)
  let answer
  try {
    answer = normalizeConsult(consult)
  } catch (error) {
    if (error instanceof MalformedConsultError) return unreadable(`malformed_${error.section}`)
    throw error
  }
  const { continuations, holds, executions, changePlans, pilot, state, lock } = answer

  const live = continuations.filter((entry) => entry.status !== 'ended')
  const openHolds = holds.filter((entry) => entry.status === 'open')
  const openExecutions = executions.filter((entry) => entry.status === 'running' || UNVERIFIED_FAILURE_STATUSES.includes(entry.status))
  const pendingReviews = changePlans.filter((entry) => entry.status === 'written')
  const counts = Object.freeze({
    pendingConfirm: openHolds.length,
    confirmable: openHolds.filter((entry) => entry.confirmable === true).length,
    openExecutions: openExecutions.length,
    pendingReviews: pendingReviews.length,
    continuations: live.length,
  })

  const pilotEnabled = isPlainObject(pilot) && pilot.enabled === true
  const anyRows = continuations.length > 0 || holds.length > 0 || state !== null || executions.length > 0 || changePlans.length > 0
  const governed = pilotEnabled ? 'pilot' : (anyRows ? 'protected' : 'none')

  function answerWith(status) {
    return Object.freeze({
      readable: true,
      status,
      statusLabel: STATUS_LABELS_ZH[status],
      governed,
      exportAllowed: status === 'not_governed' || status === 'complete',
      counts,
    })
  }

  if (!pilotEnabled && !anyRows) return answerWith('not_governed')

  const liveLeaseId = lock.state.leaseLive === true ? lock.generation.leaseId : null
  if (lock.state.leaseLive === true) return answerWith('executing')
  if (executions.some((entry) => entry.status === 'running' && liveLeaseId !== null && entry.leaseId === liveLeaseId)) {
    return answerWith('executing')
  }

  // No live lease from here on. A `running` row is therefore a writer that died (结果未知); an
  // abandoned lease still on the row (held, not live) is the same thing without its execution row.
  if (executions.some((entry) => UNVERIFIED_FAILURE_STATUSES.includes(entry.status) || entry.status === 'running')) {
    return answerWith('failed_pending_recovery')
  }
  if (lock.state.leaseHeld === true || lock.generation.leaseId !== null) return answerWith('failed_pending_recovery')

  if (openHolds.length > 0 || live.some((entry) => entry.status === 'needs_reconfirmation')) return answerWith('pending_confirmation')

  if (pendingReviews.length > 0) return answerWith('change_pending_review')

  const settledAt = state ? timestampOf(state.settledAt) : null
  const unconsumed = live.some((entry) => {
    if (entry.status !== 'active' || nonBlankString(entry.executedExecutionId)) return false
    const confirmedAt = timestampOf(entry.confirmedAt)
    // Consumed by a SETTLED computation after the confirm (zero pending decisions by definition, §9.2).
    return !(settledAt !== null && confirmedAt !== null && settledAt > confirmedAt)
  })
  if (unconsumed || changePlans.some((entry) => entry.status === 'confirmed')) return answerWith('confirmed_pending_execution')

  const newest = newestExecution(executions)
  if (newest && newest.status === 'succeeded' && !(state && state.settledExecutionId === newest.id)) {
    return answerWith('executed_pending_settlement')
  }

  return answerWith('complete')
}

module.exports = {
  STATUS_TOKENS,
  STATUS_LABELS_ZH,
  readProjectRefreshState,
}
