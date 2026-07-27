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
// ERROR DISCIPLINE — RETRACTION (round 7). This paragraph said no caller "can mint a
// genuinely branded error carrying attacker text" and that the V-9 channel was closed
// BY CONSTRUCTION. That was FALSE. `fail(reason)` takes no text and the error class
// ignores every argument beyond the reason — both still true — but a caller who
// obtains a genuinely branded error (every refusal hands one out) can assign
// `message`, `stack` and `reason` on it, and until round 7 the boundary re-threw a
// branded error VERBATIM. The attacker-text half is a DISCLOSED residual under the
// 2026-07-26 in-process-caller ruling (see the PR body). The half FIXED here, because
// it needs no adversary: the boundary now RE-MINTS every branded error it catches from
// the frozen table below, so a reason outside
// `OBSERVABILITY_CONTRACT_ERROR_REASONS` cannot leave it.

const {
  isPlainObject,
  inertRecord,
  createErrorBrand,
  createEntryGuard,
  guardExportTable,
} = require('./gip-inert-entry.cjs')

const OBSERVABILITY_CONTRACT_ERROR_REASONS = Object.freeze([
  'COUNTER_SAMPLE_INVALID',
  'COUNTER_SAMPLE_NOT_VALUES_FREE',
  'HANDSHAKE_REQUEST_INVALID',
  'HANDSHAKE_EXPECTATION_INVALID',
  'HANDSHAKE_INPUT_HOSTILE',
  // L2 ONLY. No path inside this module emits this token: it is thrown exclusively by
  // the entry boundary, when something escaped that the inert snapshot did not
  // contain. Its whole purpose is to be DISTINGUISHABLE from every L1 token, so the
  // two doors have exclusive failures instead of covering for each other.
  'OBSERVABILITY_ENTRY_NOT_INERT',
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
  OBSERVABILITY_ENTRY_NOT_INERT: 'a public entry point was reached with data that could not be made inert',
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

// THE BRAND IS UNFORGEABLE (round 6, P1-A). `brandError` is the SOLE writer and stays
// module-private; `isBrandedReadObservabilityContractError` is a CHECKER over an
// object that already exists — it admits nothing and grants nothing. `instanceof
// GipReadObservabilityContractError` is NOT this predicate: it is satisfied by
// `Object.create(...prototype)` carrying attacker text, any `.name`-based criterion is
// satisfied by an ordinary writable property, and `Symbol.hasInstance` makes the
// expression ITSELF throw. All three were EXECUTED against the round-5 head.
const { brandError, isBrandedError } = createErrorBrand()

function fail(reason) {
  throw brandError(new GipReadObservabilityContractError(reason))
}

function isBrandedReadObservabilityContractError(value) {
  return isBrandedError(value)
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

// A symbol-keyed member is invisible to `Object.keys`. Same shape as the
// `safeOwnSymbols` in the §4 step 1.4 executor module and in the approved-binding
// resolver, both of which already check both halves. Their basenames are deliberately
// NOT written out here: this slice's latency enumeration treats ANY file mentioning a
// module's basename as a consumer of it, and this module is not on that allowlist.
function safeOwnSymbols(value, reason) {
  try {
    return Object.getOwnPropertySymbols(value)
  } catch (_error) {
    fail(reason)
  }
  return []
}

// `isPlainObject` is now the SHARED definition from the inert-entry gate — the same
// strict predicate, in ONE place rather than three byte-identical copies. It is
// deliberately NOT internally guarded: it runs only on values the entry gate has
// already made inert, so its `Object.getPrototypeOf` cannot reach a trap, and leaving
// it unguarded is what gives the gate an EXCLUSIVE failure. If it swallowed traps
// itself, removing the snapshot from an entry point would still be refused here and
// the gate's positive control would prove nothing.
const failEntryNotInert = () => fail('OBSERVABILITY_ENTRY_NOT_INERT')
// ROUND 7 — RE-MINT, NEVER RE-THROW. See the note at `createEntryGuard`: the brand
// attests who minted an object, never what it currently says, so a caught branded
// error is discarded and replaced by a fresh one built from the frozen table above.
// The `.reason` read is guarded because an accessor can have been installed on the
// object after minting; a throw there collapses to the L2 token.
const remintBrandedEntryError = (caught) => {
  let reason
  try {
    reason = caught.reason
  } catch (_error) {
    reason = undefined
  }
  fail(typeof reason === 'string' && ERROR_REASON_SET.has(reason) ? reason : 'OBSERVABILITY_ENTRY_NOT_INERT')
}
const guardEntry = createEntryGuard(isBrandedError, failEntryNotInert, remintBrandedEntryError)

function assertClosedKeySet(value, allowedKeys, hostileReason, extraKeyReason) {
  const keys = safeOwnKeys(value, hostileReason)
  // Index-based: `for...of` over an array whose iterator is attacker-reachable
  // hands control to foreign code mid-loop.
  for (let index = 0; index < keys.length; index += 1) {
    if (!allowedKeys.has(keys[index])) fail(extraKeyReason)
  }
  // B1a-3 round 4. Until this line, this function read `Object.keys` ONLY — so a
  // SYMBOL-keyed member was ACCEPTED AND SILENTLY DROPPED while its string-keyed twin
  // was refused, and the comment at `assertValuesFreeCounterSample` claiming any
  // identifier "is refused rather than dropped" was therefore FALSE of this code.
  // EXECUTED before the fix: `assertValuesFreeCounterSample({ value: 1,
  // [Symbol('tenantId')]: '…' })` returned `{"value":1}`, and the same held for both
  // handshake records. No value transited (both entry points rebuild their result from
  // frozen literals over individually-read members), so this was a FALSE COMMENT
  // rather than a live leak — but it is the identical overclaim that the executor
  // module's own P2-D note says it was correcting, in a sibling module, left unfixed.
  // The `hostileReason`/`extraKeyReason` split matches the string half exactly: a
  // throwing enumeration is HOSTILE INPUT, a present symbol is an EXTRA KEY.
  if (safeOwnSymbols(value, hostileReason).length > 0) fail(extraKeyReason)
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
function assertValuesFreeCounterSample(rawSample) {
  // L1 — FIRST TOUCH. Every interrogation of `rawSample` happens inside the gate; from
  // here down the function reads `sample`, a frozen first-party record, and the
  // caller's object is never touched again. The reason is the module's existing
  // merged `COUNTER_SAMPLE_INVALID`: a sample that cannot be read as inert data is
  // not a valid sample, and splitting it would add a token whose only job is to tell
  // a hostile caller which of its traps fired.
  const sample = inertRecord(rawSample, () => fail('COUNTER_SAMPLE_INVALID'))
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
// The ENFORCEMENT set is DERIVED from the exported frozen array, and its MEMBERSHIP
// is pinned in the suite (OB-1, B1a-3 round 3) via a FROZEN SNAPSHOT in `__internals`.
// Before that pin existed, the closed key set was pinned only by (a) the exported
// array and (b) one literal extra-key name in a refusal case — so widening this Set
// by ONE NAMED key (`new Set([...CAPABILITY_HANDSHAKE_REQUEST_KEYS, 'debugPayload'])`)
// left the whole suite GREEN: the array was unchanged and the named key still
// refused. Executed and confirmed GREEN before the fix.
//
// SCOPE THE PIN HONESTLY. It catches a widening WRITTEN INTO THIS FILE — that is the
// mutation class it is built for. It does NOT make the Set immutable: a `Set` cannot
// be frozen (`Object.freeze` does not cover internal slots), so any module holding a
// reference could still `.add()` at runtime. What round 3 removed is the reference:
// `__internals` now exports frozen ARRAY SNAPSHOTS, not the Sets themselves, so this
// module hands out no mutable authority.
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
function evaluateCapabilityHandshake(rawRequest, rawExpectation) {
  // L1 — FIRST TOUCH, both arguments, before any shape check. `HANDSHAKE_INPUT_HOSTILE`
  // already exists for exactly this outcome and is used for both, so a caller cannot
  // learn from the token WHICH of the two carried the trap.
  const request = inertRecord(rawRequest, () => fail('HANDSHAKE_INPUT_HOSTILE'))
  const expectation = inertRecord(rawExpectation, () => fail('HANDSHAKE_INPUT_HOSTILE'))
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

// L2 — every function-valued export, top level AND `__internals`, is wrapped by the
// entry boundary. A NEWLY ADDED export is wrapped automatically by construction; the
// suite's export-table walk then drives it through the hostile matrix without anyone
// having to remember to add it, which is the property that makes this a class closure
// rather than a fifth round of trap enumeration.
module.exports = guardExportTable({
  OBSERVABILITY_CONTRACT_ERROR_REASONS,
  GipReadObservabilityContractError,
  UNORDERED_OFFSET_ATTEMPT_COUNTER,
  assertValuesFreeCounterSample,
  CAPABILITY_HANDSHAKE_REQUEST_KEYS,
  CAPABILITY_HANDSHAKE_EXPECTATION_KEYS,
  CAPABILITY_HANDSHAKE_OUTCOMES,
  evaluateCapabilityHandshake,
  isBrandedReadObservabilityContractError,
  // `fail` is deliberately ABSENT — and it would be inert here anyway, since it
  // takes no caller text. Pinned by the exact-key-set test, so re-adding it reds.
  __internals: {
    isPlainObject,
    assertClosedKeySet,
    hasControlCharacter,
    // FROZEN ARRAY SNAPSHOTS of the enforcement Sets, exposed SO THAT THEIR
    // MEMBERSHIP CAN BE PINNED (OB-1): pinning only the exported key ARRAYS leaves a
    // one-named-key widening of the Sets undetected.
    //
    // SNAPSHOTS, NOT THE SETS. Exporting the live `Set`s was the first attempt and it
    // was WRONG: `Object.freeze` does not stop `Set.prototype.add` (internal slots,
    // not properties), so `require(...).__internals.REQUEST_KEY_SET.add('x')` would
    // widen the enforcement AT RUNTIME with nothing reding — verified by execution
    // before this correction. That is the same class the executor module refuses by
    // name ("reachable by require(), so a trust-granting verb there is the identical
    // hole one namespace deeper"). A frozen array cannot be added to, and it is
    // taken at module load, so a later `.add()` on the real Set makes the snapshot
    // and the Set disagree — which the membership pin catches.
    REQUEST_KEY_SET_MEMBERS: Object.freeze([...REQUEST_KEY_SET].sort()),
    EXPECTATION_KEY_SET_MEMBERS: Object.freeze([...EXPECTATION_KEY_SET].sort()),
    COUNTER_SAMPLE_KEY_MEMBERS: Object.freeze([...COUNTER_SAMPLE_KEYS].sort()),
  },
}, guardEntry)
