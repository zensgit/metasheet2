'use strict'

// GIP B1a — the APPROVED-BINDING RESOLVER: the single server-side producer of the
// qualification input tuple (§3.1 ⟲R2/⟲R3).
//
// It is the PRECONDITION of §4 step 1.4: every clause of step 1.4's ratified
// acceptance predicate is written in terms of resolutions. §4 item 1's "Retained"
// bullet carries the resolver but NO substep numbers it — numbering it is the
// owner's amendment; it is built here because 1.4 cannot demonstrate its own
// predicate without it.
//
// Output: ONE deep-frozen, module-private-WeakSet-trusted object carrying EXACTLY
// the closed six-field tuple
//   { actionProfileVersion, systemContentKey, configContentKey,
//     objectKey, canonicalObjectVersion, orderingKeySpec }
// and nothing a caller supplied. §3.1: "The prober and the qualification-digest
// inputs accept ONLY this resolution object."
//
// LATENT: no route, no scheduled run, no runtime consumer. It performs NO outbound
// I/O — it reads one first-party store and two first-party authorities.
//
// -- AUTHORITY IS CLOSURE-BOUND, NEVER CALLER-SUPPLIED ----------------------
// The store and the two authorities are captured at CONSTRUCTION. A per-call input
// carries scoped run data only, on a CLOSED allowlist. There is no seam through
// which raw authority can be passed per call.
//
// -- BUILD IS SPLIT FROM TRUST ---------------------------------------------
// `buildTrustedBindingResolution` is exported NOWHERE — not at top level, not under
// `__internals` (reachable by require(), so a trust-granting verb there is the same
// hole one namespace deeper). Dependency admission is FIRST-PARTY IDENTITY, never
// `typeof x.method === 'function'`: that duck-type door is exactly what let the
// prior attempt (#4596 @ 774bdb5e6 L843/L851) mint WeakSet-trusted resolutions from
// two caller-supplied fakes.
//
// -- TWO GRADES, AND ONLY ONE OF THEM IS TRUST (B1a-3 round 6) --------------
// RETRACTION FIRST. Every round from 2 to 5 shipped this module with a residual it
// disclosed but did not close: `createHarnessSystemIdentityAuthorityForTests` and
// `createHarnessCanonicalObjectAuthorityForTests` were PUBLIC and their products were
// attested into the SAME WeakSets the certified path writes, so any in-process
// importer could mint a fully trusted resolution carrying a caller-chosen
// `systemContentKey` and `canonicalObjectVersion`. The containment offered was
// LATENCY ("no production consumers yet"), which is a schedule, not a mechanism, and
// the `ForTests` suffix in those names is a NAME, not a mechanism. That is now closed
// rather than disclosed again.
//
// The mechanism is a GRADE, carried by which WeakSet an object is in:
//   * CERTIFIED — granted ONLY by first-party module-load construction from
//     first-party dependencies. No exported function grants it, at any depth, for any
//     argument. `CERTIFIED_SYSTEM_IDENTITY_AUTHORITY` and
//     `CERTIFIED_CANONICAL_OBJECT_AUTHORITY` below are module-load CONSTANTS, not
//     factories, precisely so that there is no argument a caller can supply.
//   * HARNESS — publicly mintable, and refused wherever certification is required.
//     It exists so the probe/resolve batteries stay EXECUTABLE (a suite that can only
//     construct refusals proves nothing), and it grants nothing: a harness-graded
//     resolution is refused by `assertTrustedBindingResolution`, so it cannot reach
//     the qualification verdict.
//
// `isTrustedBindingResolution` means CERTIFIED and nothing else. The grade a resolver
// stamps is the grade of its OWN dependencies, fixed at construction — a resolver
// cannot be talked into stamping a grade it was not built with, because the grade is
// closure-bound alongside the dependencies and is never a parameter of any entry point.
//
// SCOPE THE CLAIM HONESTLY, as this module's header has had to before. What is closed
// is MINTING: no publicly-reachable code path yields a CERTIFIED-graded object. What is
// NOT claimed is that a certified resolution is obtainable at all — at this head it is
// not, because (β) refuses every identity service and (γ) ships an empty registry. That
// is the substrate's real posture; the harness factories were what made it look
// otherwise.
//
// -- ERROR DISCIPLINE ------------------------------------------------------
// `fail(reason)` takes ONLY a reason from the frozen vocabulary — no `message`
// parameter, no `details` parameter — so the V-9 channel (a foreign callback
// require()ing the module and minting a genuinely branded error carrying attacker
// text) is closed BY CONSTRUCTION and not merely by hiding the verb.

const {
  deepCloneFrozenCanonical,
  CanonicalDomainError,
} = require('./gip-canonical-json.cjs')
const {
  isFirstPartyReadSourceConfigStore,
  __internals: { contentKeyFor },
} = require('./read-source-config-store.cjs')
const {
  resolveCanonicalObjectContractVersion,
  // (γ)'s first-party module-load registry. It SHIPS EMPTY, and binding it here is
  // what makes `CERTIFIED_CANONICAL_OBJECT_AUTHORITY` a constant rather than a
  // caller-parameterised factory.
  CANONICAL_OBJECT_CONTRACT_REGISTRY,
} = require('./gip-canonical-object-contract-registry.cjs')
const {
  deriveSystemContentKeyForSystemId,
} = require('./gip-system-identity-read.cjs')
const { SANITIZATION_MARKER_PATTERN } = require('./payload-redaction.cjs')
const {
  isPlainObject,
  inertRecord,
  inertRecordList,
  createEntryGuard,
  guardExportTable,
} = require('./gip-inert-entry.cjs')

const BINDING_RESOLVER_ERROR_REASONS = Object.freeze([
  'RESOLVER_COMPONENTS_INVALID',
  'RESOLVER_RUN_INPUT_INVALID',
  'RESOLVER_INPUT_HOSTILE',
  // ONE merged outward reason for every store outcome — not-found, out-of-scope,
  // not-approved and any store failure collapse here, so a caller cannot use the
  // resolver as a cross-tenant existence oracle.
  'RESOLVER_APPROVED_CONFIG_UNAVAILABLE',
  'RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS',
  'RESOLVER_CONFIG_CONTENT_KEY_MISMATCH',
  'RESOLVER_CONFIG_BODY_INVALID',
  'RESOLVER_ORDERING_KEY_SPEC_INVALID',
  'RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE',
  'RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
  'RESOLVER_RESOLUTION_NOT_TRUSTED',
  // L2 ONLY — emitted by the entry boundary and by no path inside this module, so it
  // is exclusively distinguishable from every L1 token above.
  'RESOLVER_ENTRY_NOT_INERT',
])
const ERROR_REASON_SET = new Set(BINDING_RESOLVER_ERROR_REASONS)

const ERROR_MESSAGES = Object.freeze({
  RESOLVER_COMPONENTS_INVALID: 'approved-binding resolver components are not first-party',
  RESOLVER_RUN_INPUT_INVALID: 'approved-binding run input is outside the closed allowlist',
  RESOLVER_INPUT_HOSTILE: 'approved-binding input could not be read as inert data',
  RESOLVER_APPROVED_CONFIG_UNAVAILABLE: 'no approved read-source config version is resolvable for this scope',
  RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS: 'the approved config body read back is not lossless',
  RESOLVER_CONFIG_CONTENT_KEY_MISMATCH: 'recomputed config content key does not match the stored column',
  RESOLVER_CONFIG_BODY_INVALID: 'approved config body does not carry a resolvable binding',
  RESOLVER_ORDERING_KEY_SPEC_INVALID: 'orderingKeySpec does not satisfy the closed schema',
  RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE: 'system content key is not obtainable for this system',
  RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED: 'canonical object contract version is not registered',
  RESOLVER_RESOLUTION_NOT_TRUSTED: 'a resolution minted by this module is required',
  RESOLVER_ENTRY_NOT_INERT: 'a public entry point was reached with data that could not be made inert',
})

class GipApprovedBindingResolverError extends Error {
  constructor(reason) {
    const known = typeof reason === 'string' && ERROR_REASON_SET.has(reason)
    super(known ? ERROR_MESSAGES[reason] : 'gip-approved-binding-resolver internal: undeclared error reason')
    this.name = 'GipApprovedBindingResolverError'
    this.reason = known ? reason : 'RESOLVER_RUN_INPUT_INVALID'
  }
}

function fail(reason) {
  throw new GipApprovedBindingResolverError(reason)
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
    // The ownKeys trap throws during ENUMERATION — guarding the read is not enough.
    return Object.keys(value)
  } catch (_error) {
    fail(reason)
  }
  return []
}

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

// `isPlainObject` is the SHARED strict predicate from the inert-entry gate — one
// definition instead of three byte-identical copies. It stays UNGUARDED on purpose:
// it only ever runs on values the gate has already made inert, and if it swallowed
// traps itself it would cover for the gate, so removing the gate from an entry point
// would no longer RED.
const failEntryNotInert = () => fail('RESOLVER_ENTRY_NOT_INERT')
const guardEntry = createEntryGuard(GipApprovedBindingResolverError, failEntryNotInert)

function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function readIdentityToken(container, key, reason) {
  const raw = safeRead(container, key, reason)
  return identityTokenArgument(raw, reason)
}

// The SCALAR half of the same predicate. It exists because the two certified
// authorities take their tokens as POSITIONAL ARGUMENTS rather than members of a
// container, so there is no key to read them from — and an entry point that validates
// nothing before delegating hands a foreign module the caller's object, which is how
// the delegate's OWN brand ends up escaping this module's export surface. `typeof` runs
// no caller code, so this is safe on hostile input without a guarded read.
function identityTokenArgument(raw, reason) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) fail(reason)
  if (hasControlCharacter(raw)) fail(reason)
  return raw
}

// --- trust sets -------------------------------------------------------------

// GRADE TOKENS. Closed set, frozen, and the ONLY two values any grade function may
// return besides `null` ("not one of ours at all").
const GRADE_CERTIFIED = 'certified'
const GRADE_HARNESS = 'harness'
const BINDING_GRADES = Object.freeze([GRADE_CERTIFIED, GRADE_HARNESS])

// The set that makes a resolution admissible AT THE QUALIFICATION DOOR. Its only
// writer is `buildTrustedBindingResolution` below, which is exported NOWHERE and is
// reached only when the resolver's closure-bound grade is CERTIFIED.
const certifiedBindingResolutions = new WeakSet()
// The harness grade. Publicly reachable, and refused by every certified door.
const harnessBindingResolutions = new WeakSet()

// First-party construction attestation for the two pluggable authorities, SPLIT BY
// GRADE. The certified sets are written EXACTLY ONCE each, at module load, from the
// module-load constants below — no exported function writes them.
const certifiedSystemIdentityAuthorities = new WeakSet()
const certifiedCanonicalObjectAuthorities = new WeakSet()
const harnessSystemIdentityAuthorities = new WeakSet()
const harnessCanonicalObjectAuthorities = new WeakSet()

// Grade readers. A reader is a predicate over an object that already exists: it
// admits nothing, grants nothing, and returns `null` rather than throwing for values
// that are not this module's at all. `WeakSet.has` on a primitive returns false and
// never throws, so these are safe on hostile input without a guard.
function systemIdentityAuthorityGrade(value) {
  if (certifiedSystemIdentityAuthorities.has(value)) return GRADE_CERTIFIED
  if (harnessSystemIdentityAuthorities.has(value)) return GRADE_HARNESS
  return null
}

function canonicalObjectAuthorityGrade(value) {
  if (certifiedCanonicalObjectAuthorities.has(value)) return GRADE_CERTIFIED
  if (harnessCanonicalObjectAuthorities.has(value)) return GRADE_HARNESS
  return null
}

function bindingResolutionGrade(value) {
  if (certifiedBindingResolutions.has(value)) return GRADE_CERTIFIED
  if (harnessBindingResolutions.has(value)) return GRADE_HARNESS
  return null
}

// --- the two authorities ----------------------------------------------------
//
// PRODUCTION shape. Both delegate to the first-party module that owns the
// decision, and BOTH ARE FAIL-CLOSED TODAY, which is the accurate posture of the
// substrate rather than a defect of this slice:
//   * (β) — `deriveSystemContentKeyForSystemId` refuses every service, because
//     #4610 landed with `buildSystemIdentityService` exported nowhere and with no
//     call site (RQ-2, UNRULED).
//   * (γ) — the only trusted contract registry is the EMPTY module-load instance,
//     so every real object is CANONICAL_OBJECT_CONTRACT_UNREGISTERED (⟲OD2: an
//     inventory TOOL is not an inventory RESULT).

// CONSTANTS, NOT FACTORIES (B1a-3 round 6). These were `createCertified*Authority(dep)`
// — public functions that branded their product into the certified WeakSet for ANY
// argument a caller passed. That is the same trust-granting shape as the harness
// factories, one name away: an importer supplying its own `identityService` got a
// certified-graded authority, and the fact that (β) then refused that service is a
// property of ANOTHER module, not a check this one performed. A constant has no
// argument, so there is nothing for a caller to supply.
//
// The dependency is bound HERE, from first-party module state, and both delegate to
// the first-party module that owns the decision without reaching into its
// `__internals`.
//
// WHAT THESE ACTUALLY DO AT THIS HEAD — stated plainly, because "certified" must not
// imply "working":
//   * (β) `deriveSystemContentKeyForSystemId` refuses EVERY service, because #4610
//     landed with `buildSystemIdentityService` exported nowhere and with no call site
//     (RQ-2, UNRULED). `CERTIFIED_SYSTEM_IDENTITY_SERVICE` below is therefore the
//     ONLY honest binding available: `null`, which β refuses like everything else.
//     So this authority always refuses. That is the substrate, not a defect here.
//   * (γ) the only trusted contract registry is the EMPTY module-load instance, so
//     every real object is CANONICAL_OBJECT_CONTRACT_UNREGISTERED (⟲OD2: an inventory
//     TOOL is not an inventory RESULT).
// Consequence, and it is deliberate: NO certified resolution is constructible at this
// head. The suite executes that as a refusal rather than asserting it in a comment.
const CERTIFIED_SYSTEM_IDENTITY_SERVICE = null

// L2 ON THE METHODS, and this is not decoration — it is a leak these constants
// INTRODUCED and the gate's own export-table walk caught before they shipped.
//
// `guardExportTable` wraps function-valued exports and recurses into `__internals`; it
// deliberately does NOT rebuild an exported OBJECT, because rebuilding one produces a
// new identity and admission downstream is `WeakSet.has`. These two constants are
// exported objects WITH METHODS, so their methods are outside that wrap. When the
// resolver calls them internally the delegate's throw lands in an unconditional-discard
// catch; called DIRECTLY off the export, it escaped as the DELEGATE's brand
// (`GipCanonicalObjectContractError`) carrying the delegate's text — 15 of 15 hostile
// constructions, executed by `entryTableIsGated`. The methods are therefore wrapped
// HERE, before the freeze, so identity is minted once and never rebuilt.
const CERTIFIED_SYSTEM_IDENTITY_AUTHORITY = Object.freeze({
  systemContentKeyFor: guardEntry(async function systemContentKeyFor(systemId) {
    // L1 — FIRST TOUCH, on a positional argument. Nothing is passed to (β) until it is
    // known to be a plain identity token, so a hostile object never reaches a foreign
    // module and the refusal carries THIS module's vocabulary.
    return deriveSystemContentKeyForSystemId(
      CERTIFIED_SYSTEM_IDENTITY_SERVICE,
      identityTokenArgument(systemId, 'RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE'),
    )
  }),
})
certifiedSystemIdentityAuthorities.add(CERTIFIED_SYSTEM_IDENTITY_AUTHORITY)

const CERTIFIED_CANONICAL_OBJECT_AUTHORITY = Object.freeze({
  canonicalObjectVersionFor: guardEntry(function canonicalObjectVersionFor(contractId, contractVersion) {
    // L1 — FIRST TOUCH, both positional arguments, before (γ) is reached.
    const id = identityTokenArgument(contractId, 'RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
    const version = identityTokenArgument(contractVersion, 'RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
    let found
    try {
      found = resolveCanonicalObjectContractVersion(CANONICAL_OBJECT_CONTRACT_REGISTRY, id, version)
    } catch (_error) {
      // Unconditional discard: (γ)'s brand and text are ITS vocabulary, not this
      // module's, and re-throwing them off this export surface is the leak the gate's
      // export-table walk caught here.
      fail('RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
    }
    return found && found.version
  }),
})
certifiedCanonicalObjectAuthorities.add(CERTIFIED_CANONICAL_OBJECT_AUTHORITY)

// HARNESS shape — the RQ-3 substitute. It exists because the certified positive
// controls are NOT CONSTRUCTIBLE at this base head (see the two notes above), and a
// control routed through `__internals.computeSystemContentKey` or through an untrusted
// registry's `resolve()` would make this module's own provenance mutations
// undetectable.
//
// ROUND 6 — THE RESIDUAL THESE CARRIED IS CLOSED, NOT RE-DISCLOSED. Rounds 2-5 shipped
// with "a resolution minted through a harness authority carries the SAME trust brand as
// one minted through the certified path", contained by LATENCY. It no longer does: the
// product is HARNESS-graded, `createApprovedBindingResolver` stamps its resolutions with
// its own dependencies' grade, and `assertTrustedBindingResolution` — the door the
// qualification verdict stands behind — requires CERTIFIED. A caller who mints one of
// these gets exactly what it could compute for itself and no admission anywhere.
function createHarnessSystemIdentityAuthorityForTests(rawTable) {
  // L1 — FIRST TOUCH.
  const systemContentKeyBySystemId = inertRecord(rawTable, () => fail('RESOLVER_INPUT_HOSTILE'))
  if (!isPlainObject(systemContentKeyBySystemId)) fail('RESOLVER_COMPONENTS_INVALID')
  const table = new Map()
  const keys = safeOwnKeys(systemContentKeyBySystemId, 'RESOLVER_INPUT_HOSTILE')
  for (let index = 0; index < keys.length; index += 1) {
    table.set(keys[index], readIdentityToken(systemContentKeyBySystemId, keys[index], 'RESOLVER_COMPONENTS_INVALID'))
  }
  const authority = Object.freeze({
    async systemContentKeyFor(systemId) {
      const found = table.get(systemId)
      if (typeof found !== 'string') fail('RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE')
      return found
    },
  })
  harnessSystemIdentityAuthorities.add(authority)
  return authority
}

// COMPOSITE-KEY SEPARATOR = U+0000, WRITTEN AS THE ESCAPE `\x00`, NEVER AS A RAW
// NUL BYTE (B1a-3 round 4, P3). It was committed as a raw NUL until this round, and
// the cost was not cosmetic: a file containing a NUL is BINARY to BSD `grep`, which
// then reports ZERO line hits for tokens that are demonstrably present — `grep -c
// safeOwnSymbols` on this file returned nothing (exit 1) while `git grep` returned 2.
// This module's posture is that its in-code comments ARE the ledger and are audited
// by source-text sweeps, so a file that goes grep-invisible bakes the
// "empty read is not absence" trap into the audit surface itself. The separator VALUE
// is unchanged — U+0000 either way — which is proven by hashing the generated key
// before and after. NUL is chosen because `readIdentityToken` rejects every control
// character, so no admissible contractId/contractVersion can contain the separator
// and forge a collision.
function createHarnessCanonicalObjectAuthorityForTests(rawEntries) {
  // L1 — FIRST TOUCH. Two levels: the array and each entry record.
  const entries = inertRecordList(rawEntries, () => fail('RESOLVER_INPUT_HOSTILE'))
  if (!Array.isArray(entries)) fail('RESOLVER_COMPONENTS_INVALID')
  const table = new Map()
  const count = safeLength(entries, 'RESOLVER_INPUT_HOSTILE')
  for (let index = 0; index < count; index += 1) {
    const entry = safeRead(entries, index, 'RESOLVER_INPUT_HOSTILE')
    if (!isPlainObject(entry)) fail('RESOLVER_COMPONENTS_INVALID')
    const contractId = readIdentityToken(entry, 'contractId', 'RESOLVER_COMPONENTS_INVALID')
    const contractVersion = readIdentityToken(entry, 'contractVersion', 'RESOLVER_COMPONENTS_INVALID')
    const canonicalObjectVersion = readIdentityToken(entry, 'canonicalObjectVersion', 'RESOLVER_COMPONENTS_INVALID')
    table.set(`${contractId}\x00${contractVersion}`, canonicalObjectVersion)
  }
  const authority = Object.freeze({
    canonicalObjectVersionFor(contractId, contractVersion) {
      const found = table.get(`${contractId}\x00${contractVersion}`)
      if (typeof found !== 'string') fail('RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
      return found
    },
  })
  harnessCanonicalObjectAuthorities.add(authority)
  return authority
}

// --- the resolver service ---------------------------------------------------

const RUN_INPUT_KEYS = Object.freeze(['tenantId', 'workspaceId', 'approvedConfigVersionId'])
const RUN_INPUT_KEY_SET = new Set(RUN_INPUT_KEYS)

const RESOLUTION_KEYS = Object.freeze([
  'actionProfileVersion',
  'systemContentKey',
  'configContentKey',
  'objectKey',
  'canonicalObjectVersion',
  'orderingKeySpec',
])

const ORDERING_ENTRY_KEYS = Object.freeze(['fieldId', 'direction'])
const ORDERING_ENTRY_KEY_SET = new Set(ORDERING_ENTRY_KEYS)
// UPPERCASE-strict and NOT normalised: §4 step 1.1's ratified decision. A read-time
// up-caser would let two textually different approved bodies — different
// configContentKey, different digest — behave identically.
const ORDERING_DIRECTIONS = new Set(['ASC', 'DESC'])

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place that
// grants resolution grade.
//
// `grade` is NOT a parameter a caller can reach: it is read off the resolver's
// closure-bound `bound.grade`, which was fixed at construction from the grade of the
// dependencies and is never re-derived per call. There is no entry point that takes a
// grade, so "ask for certified" is inexpressible rather than merely refused.
function buildTrustedBindingResolution(draft, grade) {
  let owned
  try {
    // ⟲R2: an owned clone in the STRICT canonical-JSON domain, RECURSIVELY frozen.
    // A shallow Object.freeze leaves nested structures writable, and WeakSet
    // identity proves where an object came from — it does not stop a holder
    // mutating a nested array inside the probe's async window.
    owned = deepCloneFrozenCanonical(draft)
  } catch (error) {
    if (error instanceof CanonicalDomainError) fail('RESOLVER_CONFIG_BODY_INVALID')
    throw error
  }
  // Not a default, not a fallback: an unrecognised grade grants NOTHING rather than
  // silently landing in the harness set (or, worse, the certified one).
  if (grade === GRADE_CERTIFIED) certifiedBindingResolutions.add(owned)
  else if (grade === GRADE_HARNESS) harnessBindingResolutions.add(owned)
  return owned
}

// Exported CHECKERS. A checker is a predicate over an object that already exists —
// it admits nothing and grants nothing. Only the GRANTER must stay module-private.
//
// `isTrustedBindingResolution` means CERTIFIED, not "one of ours". A harness-graded
// resolution answers `false` here, which is the whole of round 6's closure at this
// door: the qualification verdict stands behind this predicate.
function isTrustedBindingResolution(value) {
  return certifiedBindingResolutions.has(value)
}

function assertTrustedBindingResolution(value) {
  if (!certifiedBindingResolutions.has(value)) fail('RESOLVER_RESOLUTION_NOT_TRUSTED')
  return value
}

function assertClosedKeySet(value, allowedKeys, extraKeyReason) {
  const keys = safeOwnKeys(value, 'RESOLVER_INPUT_HOSTILE')
  for (let index = 0; index < keys.length; index += 1) {
    if (!allowedKeys.has(keys[index])) fail(extraKeyReason)
  }
  // A symbol-keyed dependency is still a dependency.
  if (safeOwnSymbols(value, 'RESOLVER_INPUT_HOSTILE').length > 0) fail(extraKeyReason)
}

// The losslessness assertion (§3.1 L370's "recomputes from the IMMUTABLE version
// body"). `getForRuntime` returns `sanitizeIntegrationPayload(row.config)` — arrays
// truncated at 50, depth capped, strings capped — while the stored content key was
// computed over the UNSANITIZED body. Detection DERIVES from payload-redaction's
// own exported pattern, never a hand-listed marker set (that module's explicit
// instruction), plus the structural `payloadTruncated === true` check, which is not
// a string and cannot live in a regex.
//
// RQ-1 IS UNRULED, so this slice adds NO lossless store read. What it does instead
// is NAME the cliff: a truncated body is refused as NOT_LOSSLESS rather than
// reported as CONTENT_KEY_MISMATCH, i.e. rather than accusing the database of
// tampering. The consequence stands and is declared: an approved config with more
// than 50 fieldMap entries is NOT RESOLVABLE at this head.
function assertLosslessConfigBody(value, depth) {
  if (depth > 24) fail('RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS')
  if (typeof value === 'string') {
    if (SANITIZATION_MARKER_PATTERN.test(value)) fail('RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS')
    return
  }
  if (Array.isArray(value)) {
    const count = safeLength(value, 'RESOLVER_INPUT_HOSTILE')
    for (let index = 0; index < count; index += 1) {
      assertLosslessConfigBody(safeRead(value, index, 'RESOLVER_INPUT_HOSTILE'), depth + 1)
    }
    return
  }
  if (value && typeof value === 'object') {
    if (safeRead(value, 'payloadTruncated', 'RESOLVER_INPUT_HOSTILE') === true) {
      fail('RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS')
    }
    const keys = safeOwnKeys(value, 'RESOLVER_INPUT_HOSTILE')
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      if (SANITIZATION_MARKER_PATTERN.test(key)) fail('RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS')
      assertLosslessConfigBody(safeRead(value, key, 'RESOLVER_INPUT_HOSTILE'), depth + 1)
    }
  }
}

// ⟲R6's closed schema, RE-CHECKED at resolution time. The resolver does not assume
// the stored body was validated by the CURRENT validator: a body approved under an
// older one, or a manually inserted row, must still be refused rather than trusted.
function readOrderingKeySpec(config, fieldMapTargets) {
  const spec = safeRead(config, 'orderingKeySpec', 'RESOLVER_INPUT_HOSTILE')
  if (!Array.isArray(spec)) fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
  const count = safeLength(spec, 'RESOLVER_INPUT_HOSTILE')
  if (count === 0) fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
  const seen = new Set()
  const normalized = []
  for (let index = 0; index < count; index += 1) {
    const entry = safeRead(spec, index, 'RESOLVER_INPUT_HOSTILE')
    if (!isPlainObject(entry)) fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
    // The entry shape is CLOSED at two keys. NULLability is deliberately not a
    // schema check — NULL keys stay fail-closed at the qualification probe, where
    // they are observable against the source.
    assertClosedKeySet(entry, ORDERING_ENTRY_KEY_SET, 'RESOLVER_ORDERING_KEY_SPEC_INVALID')
    const fieldId = readIdentityToken(entry, 'fieldId', 'RESOLVER_ORDERING_KEY_SPEC_INVALID')
    const direction = safeRead(entry, 'direction', 'RESOLVER_INPUT_HOSTILE')
    if (typeof direction !== 'string' || !ORDERING_DIRECTIONS.has(direction)) {
      fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
    }
    if (seen.has(fieldId)) fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
    // Every fieldId must resolve through the SAME approved config version's field
    // mapping. No fieldMap ⇒ nothing resolves ⇒ closed rejection.
    if (!fieldMapTargets.has(fieldId)) fail('RESOLVER_ORDERING_KEY_SPEC_INVALID')
    seen.add(fieldId)
    normalized.push({ fieldId, direction })
  }
  return normalized
}

function readFieldMapTargets(config) {
  const fieldMap = safeRead(config, 'fieldMap', 'RESOLVER_INPUT_HOSTILE')
  if (!Array.isArray(fieldMap)) fail('RESOLVER_CONFIG_BODY_INVALID')
  const count = safeLength(fieldMap, 'RESOLVER_INPUT_HOSTILE')
  if (count === 0) fail('RESOLVER_CONFIG_BODY_INVALID')
  const targets = new Set()
  for (let index = 0; index < count; index += 1) {
    const entry = safeRead(fieldMap, index, 'RESOLVER_INPUT_HOSTILE')
    if (!isPlainObject(entry)) fail('RESOLVER_CONFIG_BODY_INVALID')
    const target = safeRead(entry, 'target', 'RESOLVER_INPUT_HOSTILE')
    if (typeof target !== 'string' || target.length === 0) fail('RESOLVER_CONFIG_BODY_INVALID')
    targets.add(target)
  }
  return targets
}

async function resolveApprovedBindingInternal(components, rawRunInput) {
  // L1 — FIRST TOUCH, BEFORE the allowlist. Round 4 found this entry leaking a bare
  // `Error` with attacker text from `isPlainObject`'s prototype interrogation, i.e.
  // BEFORE its own closed allowlist ever ran; the allowlist was never the first thing
  // to touch the caller's object, only the first thing that LOOKED like a gate.
  const runInput = inertRecord(rawRunInput, () => fail('RESOLVER_INPUT_HOSTILE'))
  if (!isPlainObject(runInput)) fail('RESOLVER_RUN_INPUT_INVALID')
  // CLOSED ALLOWLIST, not a denylist. A store, an authority, an executor or a query
  // can never arrive as run data — under a known name, a novel name, or a symbol.
  assertClosedKeySet(runInput, RUN_INPUT_KEY_SET, 'RESOLVER_RUN_INPUT_INVALID')
  const tenantId = readIdentityToken(runInput, 'tenantId', 'RESOLVER_RUN_INPUT_INVALID')
  const approvedConfigVersionId = readIdentityToken(runInput, 'approvedConfigVersionId', 'RESOLVER_RUN_INPUT_INVALID')
  const rawWorkspaceId = safeRead(runInput, 'workspaceId', 'RESOLVER_INPUT_HOSTILE')
  if (rawWorkspaceId !== undefined && rawWorkspaceId !== null && typeof rawWorkspaceId !== 'string') {
    fail('RESOLVER_RUN_INPUT_INVALID')
  }
  const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId : null

  // §3.1 L369 — re-verify through getForRuntime() EVERY time, with SCOPED input.
  // Approval, tenancy and scope are re-checked at resolution time, never assumed
  // from the id and never cached from a prior resolution.
  let row
  try {
    row = await components.configStore.getForRuntime({ tenantId, workspaceId, id: approvedConfigVersionId })
  } catch (_error) {
    // ONE merged outward reason. Splitting these — surfacing the store's error class
    // or its details — turns the resolver into a cross-tenant existence oracle.
    // Every store error crossing this catch is discarded unconditionally: no cause,
    // no stack, no message, no class exemption.
    fail('RESOLVER_APPROVED_CONFIG_UNAVAILABLE')
  }
  if (!row || typeof row !== 'object') fail('RESOLVER_APPROVED_CONFIG_UNAVAILABLE')

  const config = safeRead(row, 'config', 'RESOLVER_INPUT_HOSTILE')
  if (!config || typeof config !== 'object') fail('RESOLVER_CONFIG_BODY_INVALID')

  // Door 5 — losslessness, BEFORE the compare, so a truncated body is named rather
  // than reported as tampering.
  assertLosslessConfigBody(config, 0)

  // §3.1 L370 — RECOMPUTE and COMPARE. The stored column is never trusted, and the
  // recompute REUSES the store's own contentKeyFor (which strips `version` before
  // hashing — a locally-written hasher that includes it produces an always-failing
  // compare, whose natural "fix" is to delete the compare).
  const storedContentKey = safeRead(row, 'contentKey', 'RESOLVER_INPUT_HOSTILE')
  let recomputed
  try {
    recomputed = contentKeyFor(config)
  } catch (_error) {
    fail('RESOLVER_CONFIG_BODY_INVALID')
  }
  if (typeof storedContentKey !== 'string' || storedContentKey !== recomputed) {
    fail('RESOLVER_CONFIG_CONTENT_KEY_MISMATCH')
  }

  const objectKey = readIdentityToken(row, 'object', 'RESOLVER_CONFIG_BODY_INVALID')
  const systemId = readIdentityToken(row, 'systemId', 'RESOLVER_CONFIG_BODY_INVALID')
  const actionProfileVersion = readIdentityToken(config, 'actionProfileVersion', 'RESOLVER_CONFIG_BODY_INVALID')
  const fieldMapTargets = readFieldMapTargets(config)
  const orderingKeySpec = readOrderingKeySpec(config, fieldMapTargets)

  // (β) — OBTAINED from the identity authority, never derived here. This module
  // contains NO hashing of the system record and NO hashing of `config` whole.
  let systemContentKey
  try {
    systemContentKey = await components.systemIdentityAuthority.systemContentKeyFor(systemId)
  } catch (_error) {
    fail('RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE')
  }
  if (typeof systemContentKey !== 'string' || systemContentKey.length === 0) {
    fail('RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE')
  }

  // (γ) — a REGISTRY LOOKUP, not a derivation. It is deliberately NOT a function of
  // systemContentKey / objectKey / fieldMap: those are fields already in the same
  // tuple, so deriving from them would add no contract identity at all (B-3).
  let canonicalObjectVersion
  try {
    canonicalObjectVersion = components.canonicalObjectAuthority
      .canonicalObjectVersionFor(objectKey, actionProfileVersion)
  } catch (_error) {
    fail('RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
  }
  if (typeof canonicalObjectVersion !== 'string' || canonicalObjectVersion.length === 0) {
    fail('RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
  }

  return buildTrustedBindingResolution({
    actionProfileVersion,
    systemContentKey,
    configContentKey: recomputed,
    objectKey,
    canonicalObjectVersion,
    orderingKeySpec,
  }, components.grade)
}

// The service factory. Dependencies are admitted by FIRST-PARTY IDENTITY and are
// captured HERE, once — never per call.
function createApprovedBindingResolver(rawComponents) {
  // L1 — FIRST TOUCH. ONE level only, and that is load-bearing rather than lazy: the
  // three members are admitted downstream by `isFirstPartyReadSourceConfigStore` and
  // by `WeakSet.has`, both of which read OBJECT IDENTITY. A deep clone would hand
  // those checks a copy and turn every legitimate first-party dependency into a
  // refusal. The members are carried by identity and are only ever subjected to
  // identity tests, which run no caller code.
  const components = inertRecord(rawComponents, () => fail('RESOLVER_INPUT_HOSTILE'))
  if (!isPlainObject(components)) fail('RESOLVER_COMPONENTS_INVALID')
  assertClosedKeySet(
    components,
    new Set(['configStore', 'systemIdentityAuthority', 'canonicalObjectAuthority']),
    'RESOLVER_COMPONENTS_INVALID',
  )
  const configStore = safeRead(components, 'configStore', 'RESOLVER_INPUT_HOSTILE')
  const systemIdentityAuthority = safeRead(components, 'systemIdentityAuthority', 'RESOLVER_INPUT_HOSTILE')
  const canonicalObjectAuthority = safeRead(components, 'canonicalObjectAuthority', 'RESOLVER_INPUT_HOSTILE')
  // NOT `typeof configStore.getForRuntime === 'function'` — that duck-type door is
  // exactly what let #4596's resolver mint trusted resolutions from two fakes.
  if (!isFirstPartyReadSourceConfigStore(configStore)) fail('RESOLVER_COMPONENTS_INVALID')
  // GRADE IS MATCHED, NOT MERELY PRESENT (B1a-3 round 6). Two separate reads, then an
  // EQUALITY: an unknown authority yields `null` and is refused, and — the case that
  // matters — a CERTIFIED authority paired with a HARNESS one is refused too. Without
  // the equality, `{ systemIdentityAuthority: CERTIFIED_…, canonicalObjectAuthority:
  // <mine> }` would be enough to have a caller-chosen canonicalObjectVersion stamped
  // into a resolution whose grade the certified half vouched for. A grade is only
  // meaningful if it describes the WHOLE dependency set.
  const systemGrade = systemIdentityAuthorityGrade(systemIdentityAuthority)
  const canonicalGrade = canonicalObjectAuthorityGrade(canonicalObjectAuthority)
  if (systemGrade === null || canonicalGrade === null) fail('RESOLVER_COMPONENTS_INVALID')
  if (systemGrade !== canonicalGrade) fail('RESOLVER_COMPONENTS_INVALID')
  const bound = Object.freeze({
    configStore,
    systemIdentityAuthority,
    canonicalObjectAuthority,
    // CLOSURE-BOUND, never a parameter of any entry point.
    grade: systemGrade,
  })
  return Object.freeze({
    // L2 on a RETURNED method. `guardExportTable` covers the module's export table;
    // it does not reach a method minted per construction, and this one is `async`, so
    // a throw it does not contain becomes a REJECTION that no synchronous boundary
    // would ever see. Guarding it here is what puts the per-call entry point under
    // the same boundary as the factory that produced it.
    resolveApprovedBinding: guardEntry(function resolveApprovedBinding(runInput) {
      return resolveApprovedBindingInternal(bound, runInput)
    }),
  })
}

// L2 — every function-valued export, top level AND `__internals`. A newly added
// export is wrapped by construction, so the suite's export-table walk drives it
// through the hostile matrix with nobody having to remember to add it.
module.exports = guardExportTable({
  BINDING_RESOLVER_ERROR_REASONS,
  GipApprovedBindingResolverError,
  RESOLUTION_KEYS,
  BINDING_GRADES,
  createApprovedBindingResolver,
  // CONSTANTS, not factories. See the note at their definition: as factories they
  // branded certified for any caller argument, which is the shape round 6 closes.
  CERTIFIED_SYSTEM_IDENTITY_AUTHORITY,
  CERTIFIED_CANONICAL_OBJECT_AUTHORITY,
  createHarnessSystemIdentityAuthorityForTests,
  createHarnessCanonicalObjectAuthorityForTests,
  isTrustedBindingResolution,
  assertTrustedBindingResolution,
  // GRADE READERS. Each is a predicate over an object that already exists; none can
  // move an object between sets. They are exported because the spike must MATCH
  // grades across a module boundary, and because the trust-grant-surface sweep needs
  // a mechanical way to ask "is this certified?" without reaching into a WeakSet.
  bindingResolutionGrade,
  systemIdentityAuthorityGrade,
  canonicalObjectAuthorityGrade,
  // `fail` is deliberately ABSENT — and inert anyway, since it takes no caller
  // text. `buildTrustedBindingResolution` is absent BECAUSE IT GRANTS TRUST: a
  // granting verb under `__internals` is the identical hole one namespace deeper.
  // Both pinned by the exact-key-set test, so re-adding either reds.
  __internals: {
    isPlainObject,
    hasControlCharacter,
    assertLosslessConfigBody,
  },
}, guardEntry)
