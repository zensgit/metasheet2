'use strict'

// GIP B1a §4 step 1.6 — FROZEN CONTRACT SHAPES ONLY for the read-observability
// counter and the capability handshake. LATENT by construction:
//
//   * nothing here is wired to a route, a scheduled run or a runtime consumer;
//   * the counter is a SHAPE — this module stores no value, increments nothing and
//     owns no registry of samples;
//   * the handshake is a PURE evaluation over two plain records — zero I/O.
//
// Ratified scope (§3.4 ⟲P2-b): "B1a freezes the counter and handshake contract
// shapes only ... with hermetic harness tests", and "wiring either is
// B1-observability — §4 item 5, a separate runtime-authorization gate."
//
// ERROR DISCIPLINE (closes the V-9 channel BY CONSTRUCTION, not by hiding a verb):
// `fail(reason)` takes ONLY a reason from the frozen vocabulary. There is no
// `message` parameter and no `details` parameter, so no caller — including a
// foreign callback that `require()`s this module — can mint a genuinely branded
// error carrying attacker text. The public error class reads its message from a
// frozen per-reason map and ignores every constructor argument beyond the reason,
// so direct construction cannot carry text either.

const OBSERVABILITY_CONTRACT_ERROR_REASONS = Object.freeze([
  'COUNTER_SAMPLE_INVALID',
  'COUNTER_SAMPLE_NOT_VALUES_FREE',
  'HANDSHAKE_REQUEST_INVALID',
  'HANDSHAKE_EXPECTATION_INVALID',
  'HANDSHAKE_INPUT_HOSTILE',
])
const ERROR_REASON_SET = new Set(OBSERVABILITY_CONTRACT_ERROR_REASONS)

// One FIXED message per reason. The message is a property of the reason, never of
// the call site and never of the input.
const ERROR_MESSAGES = Object.freeze({
  COUNTER_SAMPLE_INVALID: 'counter sample does not satisfy the frozen counter contract',
  COUNTER_SAMPLE_NOT_VALUES_FREE: 'counter sample carries a member outside the values-free contract',
  HANDSHAKE_REQUEST_INVALID: 'capability handshake request does not satisfy the frozen request shape',
  HANDSHAKE_EXPECTATION_INVALID: 'capability handshake expectation does not satisfy the frozen shape',
  HANDSHAKE_INPUT_HOSTILE: 'capability handshake input could not be read as inert data',
})

class GipReadObservabilityContractError extends Error {
  constructor(reason) {
    // No caller-supplied message. No caller-supplied details. The reason must be in
    // the frozen vocabulary; anything else collapses to a fixed coarse token so a
    // rejected reason VALUE is never echoed back.
    const known = typeof reason === 'string' && ERROR_REASON_SET.has(reason)
    super(known ? ERROR_MESSAGES[reason] : 'gip-read-observability-contracts internal: undeclared error reason')
    this.name = 'GipReadObservabilityContractError'
    this.reason = known ? reason : 'COUNTER_SAMPLE_INVALID'
  }
}

function fail(reason) {
  throw new GipReadObservabilityContractError(reason)
}

// --- hostile-input readers -------------------------------------------------
// A caller-supplied object may carry throwing getters, a Proxy whose `ownKeys`
// trap throws DURING enumeration, or an array whose `Symbol.iterator` is
// attacker-reachable. Every read of caller data goes through these, and every
// catch discards unconditionally — no `cause`, no `message`, no `stack`.

function safeRead(container, key, reason) {
  try {
    return container[key]
  } catch (_error) {
    fail(reason)
  }
  return undefined
}

function safeOwnKeys(value, reason) {
  try {
    // Object.keys triggers the ownKeys trap; guarding the property READ alone is
    // not enough — the ENUMERATION itself is attacker-reachable.
    return Object.keys(value)
  } catch (_error) {
    fail(reason)
  }
  return []
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertClosedKeySet(value, allowedKeys, hostileReason, extraKeyReason) {
  const keys = safeOwnKeys(value, hostileReason)
  // Index-based: `for...of` over an array whose iterator is attacker-reachable
  // hands control to foreign code mid-loop.
  for (let index = 0; index < keys.length; index += 1) {
    if (!allowedKeys.has(keys[index])) fail(extraKeyReason)
  }
}

// Control characters by CHARACTER CODE — an identity token that can carry a
// newline or a NUL is a token that can carry a second line of anything.
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// --- the counter contract (§3.4: "name + values-free semantics — counts only,
//     no identifiers") --------------------------------------------------------

const UNORDERED_OFFSET_ATTEMPT_COUNTER = Object.freeze({
  name: 'gip.read.unordered_offset_attempt_count',
  kind: 'counter',
  // A counter that may carry labels is a counter that may carry identifiers. The
  // frozen label set is EMPTY, and it is empty on purpose.
  labelKeys: Object.freeze([]),
  sampleKeys: Object.freeze(['value']),
  monotonic: true,
})

const COUNTER_SAMPLE_KEYS = new Set(UNORDERED_OFFSET_ATTEMPT_COUNTER.sampleKeys)

// A sample is `{ value }` and NOTHING else. Any identifier — tenant, config,
// object, field, system — is refused rather than dropped, so a wiring slice
// cannot quietly widen the contract later.
function assertValuesFreeCounterSample(sample) {
  if (!isPlainObject(sample)) fail('COUNTER_SAMPLE_INVALID')
  assertClosedKeySet(sample, COUNTER_SAMPLE_KEYS, 'COUNTER_SAMPLE_INVALID', 'COUNTER_SAMPLE_NOT_VALUES_FREE')
  const value = safeRead(sample, 'value', 'COUNTER_SAMPLE_INVALID')
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('COUNTER_SAMPLE_INVALID')
  }
  return Object.freeze({ value })
}

// --- the capability handshake contract (§3.4) --------------------------------

const CAPABILITY_HANDSHAKE_REQUEST_KEYS = Object.freeze([
  'clientBuild',
  'connectorProtocolVersion',
  'profileId',
  'configVersion',
])
const REQUEST_KEY_SET = new Set(CAPABILITY_HANDSHAKE_REQUEST_KEYS)

const CAPABILITY_HANDSHAKE_EXPECTATION_KEYS = Object.freeze([
  'minimumConnectorProtocolVersion',
  'requiredConfigVersion',
])
const EXPECTATION_KEY_SET = new Set(CAPABILITY_HANDSHAKE_EXPECTATION_KEYS)

const CAPABILITY_HANDSHAKE_OUTCOMES = Object.freeze([
  'READY',
  'UPGRADE_REQUIRED',
  'CONFIG_MIGRATION_REQUIRED',
])

// Protocol/config versions are non-negative integers in the frozen shape. A string
// version is REFUSED rather than coerced: a coercing comparator is how an
// incompatible peer becomes silently READY.
function readIntegerVersion(container, key, reason) {
  const raw = safeRead(container, key, reason)
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail(reason)
  return raw
}

function readIdentityString(container, key, reason) {
  const raw = safeRead(container, key, reason)
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) fail(reason)
  if (hasControlCharacter(raw)) fail(reason)
  return raw
}

// PURE. Version-incompatible ⇒ `mayRun: false` — §3.4's "version-incompatible ⇒
// refuse to run". The two refusal outcomes are ORDERED: a peer too old to speak the
// protocol is told to upgrade FIRST, because its config-version claim cannot be
// trusted to mean what this side means by it.
function evaluateCapabilityHandshake(request, expectation) {
  if (!isPlainObject(request)) fail('HANDSHAKE_REQUEST_INVALID')
  if (!isPlainObject(expectation)) fail('HANDSHAKE_EXPECTATION_INVALID')
  assertClosedKeySet(request, REQUEST_KEY_SET, 'HANDSHAKE_INPUT_HOSTILE', 'HANDSHAKE_REQUEST_INVALID')
  assertClosedKeySet(expectation, EXPECTATION_KEY_SET, 'HANDSHAKE_INPUT_HOSTILE', 'HANDSHAKE_EXPECTATION_INVALID')

  readIdentityString(request, 'clientBuild', 'HANDSHAKE_REQUEST_INVALID')
  readIdentityString(request, 'profileId', 'HANDSHAKE_REQUEST_INVALID')
  const connectorProtocolVersion = readIntegerVersion(request, 'connectorProtocolVersion', 'HANDSHAKE_REQUEST_INVALID')
  const configVersion = readIntegerVersion(request, 'configVersion', 'HANDSHAKE_REQUEST_INVALID')

  const minimumConnectorProtocolVersion = readIntegerVersion(
    expectation, 'minimumConnectorProtocolVersion', 'HANDSHAKE_EXPECTATION_INVALID',
  )
  const requiredConfigVersion = readIntegerVersion(
    expectation, 'requiredConfigVersion', 'HANDSHAKE_EXPECTATION_INVALID',
  )

  if (connectorProtocolVersion < minimumConnectorProtocolVersion) {
    return Object.freeze({ outcome: 'UPGRADE_REQUIRED', mayRun: false })
  }
  if (configVersion !== requiredConfigVersion) {
    return Object.freeze({ outcome: 'CONFIG_MIGRATION_REQUIRED', mayRun: false })
  }
  return Object.freeze({ outcome: 'READY', mayRun: true })
}

module.exports = {
  OBSERVABILITY_CONTRACT_ERROR_REASONS,
  GipReadObservabilityContractError,
  UNORDERED_OFFSET_ATTEMPT_COUNTER,
  assertValuesFreeCounterSample,
  CAPABILITY_HANDSHAKE_REQUEST_KEYS,
  CAPABILITY_HANDSHAKE_EXPECTATION_KEYS,
  CAPABILITY_HANDSHAKE_OUTCOMES,
  evaluateCapabilityHandshake,
  // `fail` is deliberately ABSENT — and it would be inert here anyway, since it
  // takes no caller text. Pinned by the exact-key-set test, so re-adding it reds.
  __internals: {
    isPlainObject,
    assertClosedKeySet,
    hasControlCharacter,
  },
}
