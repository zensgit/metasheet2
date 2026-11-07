'use strict'

// R-69 1b-i — THE ABORT / CHECKPOINT SEAM OF THE GOVERNED ENTRIES (design baseline v2.3 §10.2.3 I-5,
// §10.2.4; ADR adr-automation-pipeline-bridge-20261103.md §2 ③ and §3.4).
//
// The two request-free governed entries in http-routes.cjs (`runGovernedStockPrepPull`,
// `runGovernedPipeline`) accept an optional `AbortSignal` and an optional `checkpoint()` callback
// and hand them down to the table actions and the pipeline runner. Those call `passGovernedCheckpoint`
// at the points the baseline names: before the source read, before each page, before planning.
// At every such point the order is fixed: the signal FIRST (a local, synchronous fact), and only then
// `await checkpoint()` (in 1b-ii a database check that the caller still holds the current job fence).
// Either refusal throws BEFORE the next call is admitted, which is the whole guarantee: once the
// caller knows it must stop, no further source read is started.
//
// NEITHER PASSED = NO BEHAVIOUR. `normalizeGovernedEntryOptions({})` returns `null`, every caller then
// skips this module entirely, and the path is the one it was before 1b-i — no extra await, no wrapped
// adapter, no extra key on any object. The HTTP routes never pass either, so their requests and
// responses are byte-identical (pinned by __tests__/governed-entry-abort-checkpoints.test.cjs).
//
// ERRORS carry `failureStage` and `errorClass` as OWN properties, never inside `details`: the route
// envelope serializes `details` only (http-routes.cjs `errorResponse`), so nothing here can reach an
// HTTP body, and both values are drawn from closed lists — no message, no value, no identifier.

const GOVERNED_ENTRY_ABORTED_CODE = 'GOVERNED_ENTRY_ABORTED'

// Where a governed run stopped. A closed list; the ADR §4 vocabulary plus `plan` for the table action.
const GOVERNED_FAILURE_STAGES = Object.freeze(['authority', 'authorize', 'load', 'read', 'transform', 'plan', 'write'])

// Why a governed checkpoint refused. `aborted` = the signal had fired; `checkpoint_refused` = the
// caller's own `checkpoint()` threw (in 1b-ii: the job fence is no longer ours).
const GOVERNED_ERROR_CLASSES = Object.freeze({
  ABORTED: 'aborted',
  CHECKPOINT_REFUSED: 'checkpoint_refused',
})

const ERROR_CLASS_NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

class GovernedEntryAbortError extends Error {
  constructor(failureStage, errorClass, cause) {
    super(errorClass === GOVERNED_ERROR_CLASSES.ABORTED
      ? 'the governed run was aborted before its next call'
      : 'the governed run checkpoint refused its next call')
    this.name = 'GovernedEntryAbortError'
    this.code = GOVERNED_ENTRY_ABORTED_CODE
    // Deliberately NO `details` and NO `status`: an abort is not a request failure, and nothing about
    // the caller's signal reason or checkpoint error may be serialized. The cause is kept for the
    // in-process caller (non-enumerable), never for a response.
    defineOwnValue(this, 'failureStage', failureStage)
    defineOwnValue(this, 'errorClass', errorClass)
    if (cause !== undefined) defineOwnValue(this, 'cause', cause)
  }
}

// Own, non-enumerable: readable as `error.failureStage` by an in-process caller, invisible to every
// `{ ...error }`, `Object.keys(error)` and JSON.stringify(error) an existing path might do.
function defineOwnValue(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: true })
}

function isAbortSignalLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.aborted === 'boolean'
}

/**
 * Validates the optional third argument of a governed entry. Returns `null` when neither a signal nor a
 * checkpoint is given — the caller must then behave exactly as before 1b-i. A given-but-malformed one
 * is a programming error and fails closed (TypeError) rather than silently running unguarded.
 */
function normalizeGovernedEntryOptions(options) {
  if (options === undefined || options === null) return null
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('governed entry options must be an object')
  }
  const { signal, checkpoint } = options
  if (signal !== undefined && signal !== null && !isAbortSignalLike(signal)) {
    throw new TypeError('governed entry signal must be an AbortSignal')
  }
  if (checkpoint !== undefined && checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('governed entry checkpoint must be a function')
  }
  const hasSignal = signal !== undefined && signal !== null
  const hasCheckpoint = checkpoint !== undefined && checkpoint !== null
  if (!hasSignal && !hasCheckpoint) return null
  return Object.freeze({
    ...(hasSignal ? { signal } : {}),
    ...(hasCheckpoint ? { checkpoint } : {}),
  })
}

/**
 * ONE checkpoint: the signal first, then `await checkpoint()`. No-op for `null` governance.
 * Throws `GovernedEntryAbortError` (own `failureStage` / `errorClass`) on either refusal.
 */
async function passGovernedCheckpoint(governance, failureStage) {
  if (!governance) return
  if (governance.signal && governance.signal.aborted) {
    throw new GovernedEntryAbortError(failureStage, GOVERNED_ERROR_CLASSES.ABORTED, governance.signal.reason)
  }
  if (typeof governance.checkpoint === 'function') {
    try {
      await governance.checkpoint({ stage: failureStage })
    } catch (error) {
      throw new GovernedEntryAbortError(failureStage, GOVERNED_ERROR_CLASSES.CHECKPOINT_REFUSED, error)
    }
    // A checkpoint can take time (a database round trip); the signal may have fired meanwhile.
    if (governance.signal && governance.signal.aborted) {
      throw new GovernedEntryAbortError(failureStage, GOVERNED_ERROR_CLASSES.ABORTED, governance.signal.reason)
    }
  }
}

/**
 * The source adapter the table action reads through, with `passGovernedCheckpoint(…, 'read')` in front
 * of every `read()` — i.e. before each page the BOM expansion requests. `null` governance returns the
 * adapter itself (same object, same identity), so an unguarded caller sees no wrapper at all.
 */
//
// `onRefusal(error)` is told about every refusal. A caller whose reader CATCHES read failures (the BOM
// expansion records a failed read as a global error and returns normally) uses it to re-raise the
// refusal itself, so a stop is never mistaken for a source fault.
function governSourceAdapterReads(sourceAdapter, governance, onRefusal) {
  if (!governance || !sourceAdapter || typeof sourceAdapter.read !== 'function') return sourceAdapter
  async function governedRead(...args) {
    try {
      await passGovernedCheckpoint(governance, 'read')
    } catch (error) {
      if (typeof onRefusal === 'function') onRefusal(error)
      throw error
    }
    return sourceAdapter.read(...args)
  }
  // A Proxy rather than a prototype copy: every other member resolves on the adapter itself, and a
  // method is called with the adapter as `this` (a class adapter with private fields keeps working).
  return new Proxy(sourceAdapter, {
    get(target, property) {
      if (property === 'read') return governedRead
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** A values-free class for an arbitrary error: the governed class when it is ours, else the constructor name. */
function governedErrorClassOf(error) {
  if (error instanceof GovernedEntryAbortError) return error.errorClass
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'unknown'
  try {
    const name = error.constructor && error.constructor.name
    return typeof name === 'string' && ERROR_CLASS_NAME_SHAPE.test(name) ? name : 'unknown'
  } catch {
    return 'unreadable'
  }
}

/**
 * Stamps own, non-enumerable `failureStage` / `errorClass` onto an error that has none yet (an
 * `undefined` stage is left for an outer frame to fill). Never throws; returns the same error.
 */
function tagGovernedFailure(error, failureStage, errorClass = governedErrorClassOf(error)) {
  if (!error || typeof error !== 'object') return error
  try {
    if (!Object.isExtensible(error)) return error
    if (failureStage !== undefined && !Object.prototype.hasOwnProperty.call(error, 'failureStage')) defineOwnValue(error, 'failureStage', failureStage)
    if (!Object.prototype.hasOwnProperty.call(error, 'errorClass')) defineOwnValue(error, 'errorClass', errorClass)
  } catch {
    // A tag must never replace the error it describes.
  }
  return error
}

module.exports = {
  GOVERNED_ENTRY_ABORTED_CODE,
  GOVERNED_ERROR_CLASSES,
  GOVERNED_FAILURE_STAGES,
  GovernedEntryAbortError,
  governSourceAdapterReads,
  governedErrorClassOf,
  normalizeGovernedEntryOptions,
  passGovernedCheckpoint,
  tagGovernedFailure,
}
