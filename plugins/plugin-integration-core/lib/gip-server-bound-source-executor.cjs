'use strict'

// GIP B1a §4 step 1.4 — the SERVER-BOUND SOURCE EXECUTOR, under δ=(c).
//
// "B1a admits connector-owned, NAMED, CERTIFIED HTTP probe actions only; SQL builders
// stay unreachable — that is the accepted v1 outcome, not a gap to work around."
// (§4.0 decision (δ), ruled 2026-07-25.)
//
// SCOPE, stated so it cannot be enlarged by reading:
//   * HTTP probe actions ONLY. This module mints NO statement, builds NO SQL, and
//     reaches `buildTotalOrderProbeSql` on no path.
//   * The bounded CORE-BACKEND statement seam is NOT built here. §4 step 1.4's
//     ratified text still schedules it and ⟲OD3 (#4619) proposing its removal is
//     UNRULED — this slice therefore builds nothing in a second package. The fence
//     is `plugins/plugin-integration-core/`.
//   * NO certification is minted. NO strategy is registered. §4 step 2 — the real
//     MySQL / SQL Server capability spike — has not run.
//   * B-4 is NOT fully closed by this slice. §4 step 1.5's own text says "B-4 is
//     closed by 1.4's builder identity AND BY STEP 3", and step 3 has not run. What
//     lands here is the builder-identity half only.
//
// -- Q2 / DECISION (ε) IS UNRULED, AND THIS IS WHAT THIS MODULE ASSUMED ------
// The §4.0 decision roster carries FOUR decisions — (α), (β), (γ), (δ) — and no (ε).
// Nothing ratified says what a certified HTTP probe action DECLARES. The shipped SQL
// probe path is SQL-shaped by construction: a strategy entry REQUIRES `dialect` and
// `snapshotSemantics`, and `snapshotSemantics` is written into closed evidence and
// therefore into the qualification digest. An HTTP action has no admissible value
// for either.
//
// This module takes the MINIMUM claim: the HTTP probe-action declaration requires
// NEITHER `dialect` NOR `snapshotSemantics`, and HTTP probe evidence carries no
// snapshot, isolation, read-only or dialect guarantee token AT ALL. Declaring
// nothing cannot be an overclaim. If the owner rules (ε) differently, the admission
// surface moves; that is an amendment, not something this module anticipates.
//
// "No guarantee token may be carried" is held by TWO mechanisms, and both are
// load-bearing — naming only one would be the same overclaim shape this round is
// correcting:
//   1. the exact-key-set pin on the DECLARATION (`assertClosedKeySet`). Round 3
//      (P2-D) added the symbol half; before that a symbol-keyed `snapshotSemantics`
//      was ACCEPTED by this "exact-key-set pin" while its string-keyed twin was
//      refused, so the sentence was not yet true of the code. It is now.
//   2. the OBSERVATION is REBUILT FROM A FIXED LITERAL at the bottom of
//      `executeOrderingKeyProbeInternal` — nothing is spread or copied from the
//      declaration or the connector's answer — so no member of either transits into
//      evidence even if a future edit widens (1).
// Mechanism 2 is why the shipped evidence stayed clean while (1) had the symbol gap.
//
// -- LATENT ------------------------------------------------------------------
// Zero production consumers. No route, no scheduled run, no runtime caller, no flag,
// no arming. Every probe in the suite runs against a harness/fixture source; nothing
// here can reach a live customer system.
//
// -- ERROR DISCIPLINE --------------------------------------------------------
// RETRACTION (round 7). This paragraph said a foreign callback "cannot mint a branded
// error carrying attacker text". That was FALSE as an absolute: `fail(reason)` indeed
// takes no text, but a caller who obtains a genuinely branded error — every refusal
// hands one out — can assign `message`, `stack` and `reason` on it, because they are
// ordinary writable own properties, and until round 7 the boundary re-threw a branded
// error VERBATIM. The attacker-text half of that is a DISCLOSED residual under the
// 2026-07-26 in-process-caller ruling (see the PR body). The half that is FIXED here,
// because it is a closed-set invariant violation reachable without any adversary at
// all: the boundary now RE-MINTS every branded error it catches from the frozen table
// below, so a reason outside `SOURCE_EXECUTOR_ERROR_REASONS` can no longer leave it.
// What remains unconditionally true: `fail` takes a reason and nothing else, and every
// catch around a foreign call discards whole — no cause, no stack, no message, no
// class exemption.

const { assertTrustedBindingResolution } = require('./gip-approved-binding-resolver.cjs')
const {
  isPlainObject,
  inertRecord,
  inertRecordList,
  createErrorBrand,
  createEntryGuard,
  guardExportTable,
} = require('./gip-inert-entry.cjs')

const SOURCE_EXECUTOR_ERROR_REASONS = Object.freeze([
  'EXECUTOR_COMPONENTS_INVALID',
  'EXECUTOR_INPUT_HOSTILE',
  'PROBE_ACTION_DECLARATION_INVALID',
  'PROBE_ACTION_REGISTRY_UNTRUSTED',
  'PROBE_ACTION_UNBOUND',
  'PROBE_FIELD_TRANSLATION_UNDECLARED',
  'PROBE_SOURCE_HANDLE_UNAVAILABLE',
  'PROBE_ACTION_FAILED',
  'PROBE_ANSWER_UNVERIFIABLE',
  // L2 ONLY — emitted by the entry boundary and by no path inside this module.
  'EXECUTOR_ENTRY_NOT_INERT',
])
const ERROR_REASON_SET = new Set(SOURCE_EXECUTOR_ERROR_REASONS)

const ERROR_MESSAGES = Object.freeze({
  EXECUTOR_COMPONENTS_INVALID: 'server-bound source executor components are not first-party',
  EXECUTOR_INPUT_HOSTILE: 'executor input could not be read as inert data',
  PROBE_ACTION_DECLARATION_INVALID: 'an HTTP probe action declaration is not admissible',
  PROBE_ACTION_REGISTRY_UNTRUSTED: 'a trusted HTTP probe-action registry is required',
  PROBE_ACTION_UNBOUND: 'no certified HTTP probe action is bound to this action profile',
  PROBE_FIELD_TRANSLATION_UNDECLARED: 'an ordering-key field has no certified connector-owned translation',
  PROBE_SOURCE_HANDLE_UNAVAILABLE: 'no source handle is bound to this resolution',
  PROBE_ACTION_FAILED: 'the HTTP probe action did not complete',
  PROBE_ANSWER_UNVERIFIABLE: 'the HTTP probe action returned no verifiable values-free answer',
  EXECUTOR_ENTRY_NOT_INERT: 'a public entry point was reached with data that could not be made inert',
})

class GipSourceExecutorError extends Error {
  constructor(reason) {
    const known = typeof reason === 'string' && ERROR_REASON_SET.has(reason)
    super(known ? ERROR_MESSAGES[reason] : 'gip-server-bound-source-executor internal: undeclared error reason')
    this.name = 'GipSourceExecutorError'
    this.reason = known ? reason : 'PROBE_ACTION_DECLARATION_INVALID'
  }
}

// THE BRAND IS UNFORGEABLE (round 6, P1-A). `brandError` is the SOLE writer and is
// module-private; `isBrandedSourceExecutorError` is a CHECKER — a predicate over an
// object that already exists, which admits nothing and grants nothing. An error
// constructed DIRECTLY off the exported class is deliberately NOT branded: it is not
// something this module minted, so L2 discards and replaces it like any other foreign
// throw. `instanceof GipSourceExecutorError` is NOT this predicate and must not be
// used as one — `Object.create(GipSourceExecutorError.prototype)` satisfies it while
// carrying attacker text (EXECUTED), and `Symbol.hasInstance` makes the expression
// itself throw.
const { brandError, isBrandedError } = createErrorBrand()

function fail(reason) {
  throw brandError(new GipSourceExecutorError(reason))
}

function isBrandedSourceExecutorError(value) {
  return isBrandedError(value)
}

// --- hostile-input readers --------------------------------------------------

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
    return Object.keys(value)
  } catch (_error) {
    fail(reason)
  }
  return []
}

// A symbol-keyed member is invisible to `Object.keys`. Mirrors the resolver's
// `safeOwnSymbols` (`gip-approved-binding-resolver.cjs`), whose `assertClosedKeySet`
// has checked both halves since it landed.
function safeOwnSymbols(value, reason) {
  try {
    return Object.getOwnPropertySymbols(value)
  } catch (_error) {
    fail(reason)
  }
  return []
}

function safeLength(value, reason) {
  const raw = safeRead(value, 'length', reason)
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail(reason)
  return raw
}

// `isPlainObject` is the SHARED strict predicate from the inert-entry gate. Before
// round 5 this exact five-line function existed as THREE byte-identical copies, one
// per module, each carrying the same unguarded `Object.getPrototypeOf` — which is how
// one trap produced the same P1 in three places at once. It stays UNGUARDED by
// design: it runs only on already-inert values, and a self-guarding predicate would
// cover for the gate and destroy the gate's exclusive failure.
const failEntryNotInert = () => fail('EXECUTOR_ENTRY_NOT_INERT')
// ROUND 7 — RE-MINT, NEVER RE-THROW. The brand attests WHO minted an object; it says
// nothing about what that object currently SAYS, because `reason` is an ordinary
// writable own property. So a caught branded error is discarded and a fresh one is
// minted from the frozen table above, keeping the caught reason only when it is in
// `ERROR_REASON_SET`. The read of `.reason` is itself guarded: an accessor can have
// been installed on a branded object after it was minted, and a throw there is
// treated as "not in the vocabulary" rather than escaping the boundary.
const remintBrandedEntryError = (caught) => {
  let reason
  try {
    reason = caught.reason
  } catch (_error) {
    reason = undefined
  }
  fail(typeof reason === 'string' && ERROR_REASON_SET.has(reason) ? reason : 'EXECUTOR_ENTRY_NOT_INERT')
}
const guardEntry = createEntryGuard(isBrandedError, failEntryNotInert, remintBrandedEntryError)

function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function readIdentityToken(container, key, reason) {
  const raw = safeRead(container, key, reason)
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) fail(reason)
  if (hasControlCharacter(raw)) fail(reason)
  return raw
}

function readFunction(container, key, reason) {
  const raw = safeRead(container, key, reason)
  if (typeof raw !== 'function') fail(reason)
  return raw
}

function assertClosedKeySet(value, allowedKeys, extraKeyReason) {
  const keys = safeOwnKeys(value, 'EXECUTOR_INPUT_HOSTILE')
  for (let index = 0; index < keys.length; index += 1) {
    if (!allowedKeys.has(keys[index])) fail(extraKeyReason)
  }
  // P2-D / B1a-3 round 3. Until this line, this function read `Object.keys` ONLY, so
  // a SYMBOL-keyed member — a symbol-keyed `snapshotSemantics`, a symbol-keyed
  // dependency — was ACCEPTED while its string-keyed twin was refused. "An exact
  // key-set pin" was therefore not true of this function. A symbol-keyed
  // snapshotSemantics is still a snapshotSemantics.
  if (safeOwnSymbols(value, 'EXECUTOR_INPUT_HOSTILE').length > 0) fail(extraKeyReason)
}

// --- the certified HTTP probe-action registry -------------------------------
//
// BUILD IS SPLIT FROM TRUST. `createHttpProbeActionRegistry` below is EXPORTED and
// BUILD-ONLY: calling it, from anywhere, confers NOTHING. It is retained
// deliberately as the untrusted test seam. `buildTrustedHttpProbeActionRegistry` is
// the ONLY writer into the trust WeakSet and is exported NOWHERE under that name —
// not at top level, not under `__internals` (reachable by require(), so a
// trust-granting verb there is the identical hole one namespace deeper).
//
// ⚠ SCOPE THE CLAIM HONESTLY — this split is NOT unconditionally closed. There are
// TWO public wrappers around a private granter in this module, not one, and the
// earlier version of this block named only the first:
//
//   1. `createHarnessHttpProbeActionRegistryForTests` (below) wraps
//      `buildTrustedHttpProbeActionRegistry`.
//   2. `createHarnessSourceBinderForTests` (:392) is the SOLE writer into
//      `trustedSourceBinders` (:386, written :466) and is publicly EXPORTED (:622) — there is no
//      private granter behind it at all, so it is not even "build split from trust";
//      it is the single granting path. And unlike (1) it has NO CERTIFIED
//      COUNTERPART: `CERTIFIED_HTTP_PROBE_ACTION_REGISTRY` exists, and NO certified
//      binder does — so for binders there is currently no non-harness way to obtain
//      a trusted one at all.
//
// Both ARE "a public factory whose products are trusted". The `ForTests` suffix is a
// NAME, not a mechanism. They exist because the certified registry ships EMPTY and no
// certified binder exists, so the ratified positive control is otherwise not
// executable at all; their containment today is LATENCY (zero production consumers,
// proven by executed enumeration), and closing BOTH is a precondition of any runtime
// wiring. Do not read the paragraph above as "no public factory confers trust here" —
// read it as "the BUILD-ONLY factory confers nothing", which is what the mutation
// battery proves.
//
// ROUND 6 — THE SET IS NO LONGER READ, IT IS EXECUTED. Counting these by reading is
// exactly how the round-5 text said ONE when there were TWO.
// `publicSurfaceMintsExactlyTheDeclaredTrust` saturates the public surface of all four
// modules — including COMPOSED components records, so the TRANSITIVE path is visible —
// and pins the minting set by SET EQUALITY. Its call and export counts are PRINTED BY
// THE TEST on every run and are deliberately NOT written here: a number in a comment
// goes stale the moment an export is added, which is the exact defect class this round
// exists to correct. This module's
// three: `createHarnessHttpProbeActionRegistryForTests` -> httpProbeActionRegistry,
// `createHarnessSourceBinderForTests` -> sourceBinder, and
// `createServerBoundSourceExecutor` -> serverBoundSourceExecutor (transitive: it mints
// only once the closure has ALREADY reached a trusted registry AND a trusted binder,
// which is the property that would make a real closure real).
//
// ⚠ ITEM 2's CLOSURE IS NOT DELIVERED. Closing these two removes the only publicly
// reachable path to a trusted binder, which is the sole construction path for this
// module's own suite — and therefore for B-1's control and the always-bind-the-first-
// source mutation. The two cannot both hold at this head; the choice is the owner's.
// Mitigation that does hold: both factories sit inside the exact-key-set export pin and
// inside the saturation's set equality, so neither can be widened and no third one can
// be added without reding AND BEING NAMED.
//
// This is the class the owner ruled on for #4610's registries — "a public factory
// whose products are trusted is equivalent to no trust check at all" — and it is
// the class that is STILL LIVE on main in `gip-binding-qualification-spike.cjs`,
// whose exported `createProbeStrategyRegistry` is the sole writer into its own
// trust WeakSet. §4 step 1.5 assigns that closure to "1.4's builder identity".
const trustedHttpProbeActionRegistries = new WeakSet()

// The DECLARATION shape. Note what is NOT here: no `dialect`, no
// `snapshotSemantics`, no isolation claim, no read-only claim, no guarantee token
// of any kind. See the (ε) note in the module header.
const ACTION_DECLARATION_KEYS = Object.freeze([
  'actionProfileVersion',
  'actionId',
  'actionVersion',
  'connectorKind',
  'sourceFieldFor',
  'execute',
])
const ACTION_DECLARATION_KEY_SET = new Set(ACTION_DECLARATION_KEYS)

function normalizeActionDeclaration(entry) {
  if (!isPlainObject(entry)) fail('PROBE_ACTION_DECLARATION_INVALID')
  // CLOSED: an undeclared key on an action declaration is refused, so a dialect or
  // snapshot claim cannot ride in under an unexpected name.
  assertClosedKeySet(entry, ACTION_DECLARATION_KEY_SET, 'PROBE_ACTION_DECLARATION_INVALID')
  return Object.freeze({
    actionProfileVersion: readIdentityToken(entry, 'actionProfileVersion', 'PROBE_ACTION_DECLARATION_INVALID'),
    actionId: readIdentityToken(entry, 'actionId', 'PROBE_ACTION_DECLARATION_INVALID'),
    actionVersion: readIdentityToken(entry, 'actionVersion', 'PROBE_ACTION_DECLARATION_INVALID'),
    connectorKind: readIdentityToken(entry, 'connectorKind', 'PROBE_ACTION_DECLARATION_INVALID'),
    // B-6 under δ=(c): translation is CERTIFIED and CONNECTOR-OWNED. There is no
    // path by which an undeclared fieldId is passed through raw — guessing is
    // inexpressible, not merely discouraged.
    sourceFieldFor: readFunction(entry, 'sourceFieldFor', 'PROBE_ACTION_DECLARATION_INVALID'),
    execute: readFunction(entry, 'execute', 'PROBE_ACTION_DECLARATION_INVALID'),
  })
}

// EXPORTED, BUILD-ONLY. Its product is NOT trusted.
function createHttpProbeActionRegistry(rawEntries) {
  // L1 — FIRST TOUCH. Two levels: the array and each declaration record. The
  // declarations' `sourceFieldFor` / `execute` members are carried BY IDENTITY —
  // a snapshot of a function is not a function anyone can call.
  const entries = inertRecordList(rawEntries, () => fail('EXECUTOR_INPUT_HOSTILE'))
  if (!Array.isArray(entries)) fail('PROBE_ACTION_DECLARATION_INVALID')
  const count = safeLength(entries, 'EXECUTOR_INPUT_HOSTILE')
  const byProfile = new Map()
  for (let index = 0; index < count; index += 1) {
    const declaration = normalizeActionDeclaration(safeRead(entries, index, 'EXECUTOR_INPUT_HOSTILE'))
    if (byProfile.has(declaration.actionProfileVersion)) {
      // A second action for the same profile is a wiring bug, never a fallback.
      fail('PROBE_ACTION_DECLARATION_INVALID')
    }
    byProfile.set(declaration.actionProfileVersion, declaration)
  }
  return Object.freeze({
    size() { return byProfile.size },
    resolve(actionProfileVersion) {
      return byProfile.get(actionProfileVersion) || null
    },
  })
}

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place that
// grants registry trust.
function buildTrustedHttpProbeActionRegistry(entries) {
  const registry = createHttpProbeActionRegistry(entries)
  trustedHttpProbeActionRegistries.add(registry)
  return registry
}

// The first-party registry — SHIPS EMPTY. There is no runtime register() call that
// could add to this instance once built. Only a future, separately-reviewed
// amendment may extend this literal array, and only after a certified HTTP probe
// action exists to put in it.
const CERTIFIED_HTTP_PROBE_ACTION_REGISTRY = buildTrustedHttpProbeActionRegistry([])

// HARNESS seam — the RQ-3 substitute, named so it cannot be mistaken for the
// certified registry. It exists because the certified registry ships EMPTY, so the
// ratified POSITIVE control ("a probe executed through the server-bound executor
// against the harness source still qualifies") is otherwise not executable at all.
// Reaching a positive control through the UNTRUSTED build-only factory instead
// would make this module's own trust mutations undetectable — the
// green-against-nothing class this line has already paid for.
//
// DECLARED RESIDUAL: a registry minted here carries the SAME trust brand as the
// certified one. Its containment today is LATENCY — zero production consumers,
// proven by executed enumeration — and closing it is a precondition of any runtime
// wiring.
function createHarnessHttpProbeActionRegistryForTests(entries) {
  return buildTrustedHttpProbeActionRegistry(entries)
}

// --- the source binder, and the (α) credential boundary ---------------------
//
// (α), ruled: the AUTHENTICATION SECRET is "consumed inside the boundary by a
// connector-owned factory returning an OPAQUE HANDLE / execution closure, never
// reachable from the executor — HMAC does not apply". The executor below therefore
// holds a closure and nothing else: it never holds, sees, hashes or can enumerate
// the secret. A PR that HMACs the connection secret has misread (α).
const trustedSourceBinders = new WeakSet()

// The binder maps a RESOLUTION'S OWN systemContentKey to its handle. This is the
// whole of B-1's mechanism: the handle demonstrably derives from each resolution's
// own system record, so one executor answer cannot satisfy two differently-bound
// resolutions.
function createHarnessSourceBinderForTests(rawEntries) {
  // L1 — FIRST TOUCH. Two levels: the array and each entry record. `credentialFactory`
  // is carried BY IDENTITY, because it has to remain callable.
  const entries = inertRecordList(rawEntries, () => fail('EXECUTOR_INPUT_HOSTILE'))
  if (!Array.isArray(entries)) fail('EXECUTOR_COMPONENTS_INVALID')
  const count = safeLength(entries, 'EXECUTOR_INPUT_HOSTILE')
  const bySystemContentKey = new Map()
  for (let index = 0; index < count; index += 1) {
    const entry = safeRead(entries, index, 'EXECUTOR_INPUT_HOSTILE')
    if (!isPlainObject(entry)) fail('EXECUTOR_COMPONENTS_INVALID')
    const systemContentKey = readIdentityToken(entry, 'systemContentKey', 'EXECUTOR_COMPONENTS_INVALID')
    const credentialFactory = readFunction(entry, 'credentialFactory', 'EXECUTOR_COMPONENTS_INVALID')
    // The factory is invoked HERE, inside the boundary, and only its return value —
    // the opaque handle — is retained. Whatever secret it closed over never becomes
    // a property of anything this module holds.
    //
    // It is a FOREIGN call, so it gets the same unconditional discard as every other
    // foreign call in this module: no cause, no stack, no message, no class
    // exemption. A connector factory that throws its configuration into the error is
    // otherwise a leak channel on the one path that touches credential material.
    let handle
    try {
      handle = credentialFactory()
    } catch (_error) {
      fail('EXECUTOR_COMPONENTS_INVALID')
    }
    // (α) — THIS READ IS DELIBERATELY *NOT* COVERED BY THE INERT-ENTRY GATE, and the
    // reason is the ruling itself, not convenience. B1a-3 round 4 found this site
    // leaking: the factory CALL was wrapped (three lines up) while
    // `typeof handle.execute !== 'function'` was read RAW one line later, on a value
    // the connector fully controls — so a handle whose `execute` is a throwing getter,
    // or a Proxy with a `get` trap, escaped as a bare `Error` carrying the connector's
    // text. 2 of 2 constructions leaked. The comment directly above already stated the
    // invariant that read violated.
    //
    // The gate is the wrong instrument HERE. `inertRecord` works by ENUMERATING a
    // value's own property names and symbols and reading every one of them. Decision
    // (α) requires that the authentication secret is "consumed inside the boundary by
    // a connector-owned factory returning an OPAQUE HANDLE / execution closure, never
    // reachable from the executor" — and enumerating the handle is precisely how the
    // executor would come to hold, see and be able to list whatever the handle carries.
    // Snapshotting here would close a leak channel by opening the exact channel the
    // ruling exists to forbid.
    //
    // So the read is guarded EXPLICITLY, with the same unconditional discard, and the
    // ORIGINAL handle is retained by identity: no copy, no enumeration, no property
    // list. `typeof` cannot run caller code, so the object test is safe raw; only the
    // member read needs the guard. The suite pins the identity (`handleFor(k)` must be
    // `===` the object the factory returned), which is the mechanical proof that no
    // enumeration happened — without it, "we did not copy the handle" is only a
    // comment, and a later "helpful" edit routing this through the gate would pass.
    if (!handle || typeof handle !== 'object') fail('EXECUTOR_COMPONENTS_INVALID')
    if (typeof safeRead(handle, 'execute', 'EXECUTOR_COMPONENTS_INVALID') !== 'function') {
      fail('EXECUTOR_COMPONENTS_INVALID')
    }
    // FAIL CLOSED ON A DUPLICATE (B1a-3 round 4, NIT). This used to be a bare
    // last-wins `set`, while the action registry ten lines up already refuses a
    // duplicate with "a second action for the same profile is a wiring bug, never a
    // fallback". The asymmetry sat on the component that carries the WHOLE of B-1:
    // per this module's own header, this binder is the SOLE granting path into
    // `trustedSourceBinders`, and the property B-1 rests on is that one executor
    // answer cannot satisfy two differently-bound resolutions. Last-wins means a
    // second entry silently re-points a systemContentKey at a different source
    // handle. Not exploitable today — every registration is first-party and the
    // module is LATENT — but it is aligned BEFORE any certified binder is ever
    // written to this shape, not after.
    if (bySystemContentKey.has(systemContentKey)) fail('EXECUTOR_COMPONENTS_INVALID')
    bySystemContentKey.set(systemContentKey, handle)
  }
  const binder = Object.freeze({
    handleFor(systemContentKey) {
      return bySystemContentKey.get(systemContentKey) || null
    },
  })
  trustedSourceBinders.add(binder)
  return binder
}

// --- the executor -----------------------------------------------------------

// Consumers (the qualification prober) admit an executor by OBJECT IDENTITY.
// `isTrustedServerBoundSourceExecutor` below is a CHECKER export — a predicate over
// an object that already exists. It admits nothing and grants nothing; only the
// granting constructor stays private.
const trustedServerBoundSourceExecutors = new WeakSet()

function isTrustedServerBoundSourceExecutor(value) {
  return trustedServerBoundSourceExecutors.has(value)
}

// ROUND 6, ITEM 2 — CHECKERS FOR THE TWO LEAF BRANDS THIS MODULE OWNS.
//
// A checker is a predicate over an object that already exists: it admits nothing and
// mints nothing, exactly like `isTrustedServerBoundSourceExecutor` above. They exist so
// that the trust-minting surface can be ENUMERATED MECHANICALLY rather than argued in
// prose — `publicSurfaceMintsExactlyTheDeclaredTrust` saturates the public export
// surface with caller-controlled arguments and asks every checker about every value it
// can reach. Without these two, four of the six brands were unobservable from outside
// and "which exports mint trust" was a claim nobody could execute.
function isTrustedHttpProbeActionRegistry(value) {
  return trustedHttpProbeActionRegistries.has(value)
}

function isTrustedSourceBinder(value) {
  return trustedSourceBinders.has(value)
}

const ANSWER_KEYS = Object.freeze(['duplicateGroupsSampled', 'nullKeyRowsSampled'])
const ANSWER_KEY_SET = new Set(ANSWER_KEYS)

function readCount(container, key) {
  const raw = safeRead(container, key, 'PROBE_ANSWER_UNVERIFIABLE')
  // A driver may return a bigint count as a canonical digit string; anything else
  // fails closed rather than being coerced.
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  if (typeof raw === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(raw)) return Number(raw)
  fail('PROBE_ANSWER_UNVERIFIABLE')
  return 0
}

async function executeOrderingKeyProbeInternal(bound, resolution) {
  // Trust is OBJECT IDENTITY. A hand-built object carrying every expected public
  // field — and any plausible brand — is refused BY NAME.
  assertTrustedBindingResolution(resolution)

  // The action, the handle and the probed FIELD SET all derive FROM THE RESOLUTION.
  const action = bound.actionRegistry.resolve(resolution.actionProfileVersion)
  if (!action) fail('PROBE_ACTION_UNBOUND')

  // Certified, connector-owned translation (B-6 as narrowed by δ=(c)). The
  // orderingKeySpec fieldIds are canonical TARGET fields; there is NO fallback that
  // passes an undeclared fieldId through raw.
  const addressing = []
  const spec = resolution.orderingKeySpec
  for (let index = 0; index < spec.length; index += 1) {
    const entry = spec[index]
    let translated
    try {
      translated = action.sourceFieldFor(entry.fieldId)
    } catch (_error) {
      // Foreign connector code. Discard unconditionally — no cause, no message.
      fail('PROBE_FIELD_TRANSLATION_UNDECLARED')
    }
    if (typeof translated !== 'string' || translated.length === 0 || hasControlCharacter(translated)) {
      // Values-free: the refusal names no field and echoes no identifier.
      fail('PROBE_FIELD_TRANSLATION_UNDECLARED')
    }
    addressing.push(Object.freeze({ address: translated, direction: entry.direction }))
  }

  const handle = bound.sourceBinder.handleFor(resolution.systemContentKey)
  if (!handle) fail('PROBE_SOURCE_HANDLE_UNAVAILABLE')

  let answer
  try {
    answer = await handle.execute(Object.freeze({
      actionId: action.actionId,
      actionVersion: action.actionVersion,
      objectKey: resolution.objectKey,
      orderingKeyAddressing: Object.freeze(addressing),
    }))
  } catch (_error) {
    fail('PROBE_ACTION_FAILED')
  }
  if (!answer || typeof answer !== 'object') fail('PROBE_ANSWER_UNVERIFIABLE')
  // The answer is COUNTS ONLY, on a closed key set — a connector cannot smuggle row
  // values, field names or a guarantee token back through it.
  assertClosedKeySet(answer, ANSWER_KEY_SET, 'PROBE_ANSWER_UNVERIFIABLE')
  const duplicateGroupsSampled = readCount(answer, 'duplicateGroupsSampled')
  const nullKeyRowsSampled = readCount(answer, 'nullKeyRowsSampled')

  // Values-free observation. No dialect. No snapshotSemantics. No field names, no
  // row values, no identifiers beyond FIRST-PARTY action identity.
  return Object.freeze({
    probeKind: 'ordering_key_total_order_negative',
    // `http_action`, NOT `http_certified_action`. This token is bound into the
    // qualification digest, and B-5's doctrine is that "'certified' requires a
    // VERIFIED guarantee, not an honest label". The certified registry SHIPS EMPTY
    // and §4 step 2 has not run, so NOTHING is certified at this head — writing
    // "certified" into the digest would be an overclaim, and renaming it after a
    // qualification exists would be a digest-lineage change.
    probeTransport: 'http_action',
    probeActionId: action.actionId,
    probeActionVersion: action.actionVersion,
    probeConnectorKind: action.connectorKind,
    checkedKeyColumnCount: addressing.length,
    duplicateGroupsSampled,
    nullKeyRowsSampled,
  })
}

// The service factory. Authority is CLOSURE-BOUND at construction; the per-call
// entry point takes a resolution and nothing else, so there is no seam through
// which a caller could pass a registry, a binder, a handle or a query.
function createServerBoundSourceExecutor(rawComponents) {
  // L1 — FIRST TOUCH. ONE level: both members are admitted by `WeakSet.has`, which
  // reads OBJECT IDENTITY, so a deep clone would make every trusted registry and
  // binder un-admittable. Identity tests run no caller code.
  const components = inertRecord(rawComponents, () => fail('EXECUTOR_INPUT_HOSTILE'))
  if (!isPlainObject(components)) fail('EXECUTOR_COMPONENTS_INVALID')
  assertClosedKeySet(components, new Set(['actionRegistry', 'sourceBinder']), 'EXECUTOR_COMPONENTS_INVALID')
  const actionRegistry = safeRead(components, 'actionRegistry', 'EXECUTOR_INPUT_HOSTILE')
  const sourceBinder = safeRead(components, 'sourceBinder', 'EXECUTOR_INPUT_HOSTILE')
  if (!trustedHttpProbeActionRegistries.has(actionRegistry)) fail('PROBE_ACTION_REGISTRY_UNTRUSTED')
  if (!trustedSourceBinders.has(sourceBinder)) fail('EXECUTOR_COMPONENTS_INVALID')
  const bound = Object.freeze({ actionRegistry, sourceBinder })
  const executor = Object.freeze({
    // L2 on a RETURNED method. `guardExportTable` covers the export table, not a
    // method minted per construction — and this one is `async`, so an uncontained
    // throw becomes a REJECTION that no synchronous boundary sees.
    executeOrderingKeyProbe: guardEntry(function executeOrderingKeyProbe(resolution) {
      return executeOrderingKeyProbeInternal(bound, resolution)
    }),
  })
  trustedServerBoundSourceExecutors.add(executor)
  return executor
}

// L2 — every function-valued export, top level AND `__internals`. `CERTIFIED_HTTP_
// PROBE_ACTION_REGISTRY` is deliberately NOT rebuilt: it is admitted downstream by
// `WeakSet.has`, so wrapping it would silently make the certified registry
// un-admittable. Its two methods are driven through the hostile matrix instead, so
// the claim that they are inert is EXECUTED rather than asserted.
module.exports = guardExportTable({
  SOURCE_EXECUTOR_ERROR_REASONS,
  GipSourceExecutorError,
  HTTP_PROBE_ACTION_DECLARATION_KEYS: ACTION_DECLARATION_KEYS,
  CERTIFIED_HTTP_PROBE_ACTION_REGISTRY,
  createHttpProbeActionRegistry,
  createHarnessHttpProbeActionRegistryForTests,
  createHarnessSourceBinderForTests,
  createServerBoundSourceExecutor,
  isTrustedServerBoundSourceExecutor,
  isTrustedHttpProbeActionRegistry,
  isTrustedSourceBinder,
  isBrandedSourceExecutorError,
  // `fail` is deliberately ABSENT — and inert anyway, since it takes no caller text.
  // `buildTrustedHttpProbeActionRegistry` is absent BECAUSE IT GRANTS TRUST.
  // Both pinned by the exact-key-set test, so re-adding either reds.
  __internals: {
    isPlainObject,
    hasControlCharacter,
    normalizeActionDeclaration,
  },
}, guardEntry)
