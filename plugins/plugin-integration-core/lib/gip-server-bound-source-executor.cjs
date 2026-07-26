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
// `fail(reason)` takes ONLY a reason from the frozen vocabulary — no `message`, no
// `details` — so a foreign connector callback that require()s this module cannot
// mint a branded error carrying attacker text. Every catch around a foreign call
// discards unconditionally: no cause, no stack, no message, no class exemption.

const { assertTrustedBindingResolution } = require('./gip-approved-binding-resolver.cjs')

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
})

class GipSourceExecutorError extends Error {
  constructor(reason) {
    const known = typeof reason === 'string' && ERROR_REASON_SET.has(reason)
    super(known ? ERROR_MESSAGES[reason] : 'gip-server-bound-source-executor internal: undeclared error reason')
    this.name = 'GipSourceExecutorError'
    this.reason = known ? reason : 'PROBE_ACTION_DECLARATION_INVALID'
  }
}

function fail(reason) {
  throw new GipSourceExecutorError(reason)
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

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
//   2. `createHarnessSourceBinderForTests` (:272) is the SOLE writer into
//      `trustedSourceBinders` (:305) and is publicly EXPORTED (:432) — there is no
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
// battery proves. Mitigation that does hold: both factories sit inside the
// exact-key-set export pin, so neither can be widened and no third one can be added
// without reding.
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
function createHttpProbeActionRegistry(entries) {
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
function createHarnessSourceBinderForTests(entries) {
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
    if (!handle || typeof handle !== 'object' || typeof handle.execute !== 'function') {
      fail('EXECUTOR_COMPONENTS_INVALID')
    }
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
function createServerBoundSourceExecutor(components) {
  if (!isPlainObject(components)) fail('EXECUTOR_COMPONENTS_INVALID')
  assertClosedKeySet(components, new Set(['actionRegistry', 'sourceBinder']), 'EXECUTOR_COMPONENTS_INVALID')
  const actionRegistry = safeRead(components, 'actionRegistry', 'EXECUTOR_INPUT_HOSTILE')
  const sourceBinder = safeRead(components, 'sourceBinder', 'EXECUTOR_INPUT_HOSTILE')
  if (!trustedHttpProbeActionRegistries.has(actionRegistry)) fail('PROBE_ACTION_REGISTRY_UNTRUSTED')
  if (!trustedSourceBinders.has(sourceBinder)) fail('EXECUTOR_COMPONENTS_INVALID')
  const bound = Object.freeze({ actionRegistry, sourceBinder })
  const executor = Object.freeze({
    executeOrderingKeyProbe(resolution) {
      return executeOrderingKeyProbeInternal(bound, resolution)
    },
  })
  trustedServerBoundSourceExecutors.add(executor)
  return executor
}

module.exports = {
  SOURCE_EXECUTOR_ERROR_REASONS,
  GipSourceExecutorError,
  HTTP_PROBE_ACTION_DECLARATION_KEYS: ACTION_DECLARATION_KEYS,
  CERTIFIED_HTTP_PROBE_ACTION_REGISTRY,
  createHttpProbeActionRegistry,
  createHarnessHttpProbeActionRegistryForTests,
  createHarnessSourceBinderForTests,
  createServerBoundSourceExecutor,
  isTrustedServerBoundSourceExecutor,
  // `fail` is deliberately ABSENT — and inert anyway, since it takes no caller text.
  // `buildTrustedHttpProbeActionRegistry` is absent BECAUSE IT GRANTS TRUST.
  // Both pinned by the exact-key-set test, so re-adding either reds.
  __internals: {
    isPlainObject,
    hasControlCharacter,
    normalizeActionDeclaration,
  },
}
