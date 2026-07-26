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
// ⚠ SCOPE THE CLAIM HONESTLY. The two `createHarness*ForTests` constructors below are
// PUBLIC and their products ARE attested into this module's authority WeakSets — so
// "no public factory's products are trusted" is NOT unconditionally true here either.
// They exist because BOTH certified authorities are unreachable at this head (RQ-2 /
// RQ-3) and a control routed through `__internals` or an untrusted registry would make
// this module's own provenance mutations undetectable. Containment today is LATENCY;
// closing them is a precondition of any runtime wiring. What IS unconditional: the
// resolution granter itself is unexported, and the exported export set is pinned by
// exact key equality so no third seam can appear silently.
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
} = require('./gip-canonical-object-contract-registry.cjs')
const {
  deriveSystemContentKeyForSystemId,
} = require('./gip-system-identity-read.cjs')
const { SANITIZATION_MARKER_PATTERN } = require('./payload-redaction.cjs')

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

// --- trust sets -------------------------------------------------------------

// The ONE set that makes a resolution admissible downstream. Its only writer is
// buildTrustedBindingResolution below, which is exported NOWHERE.
const trustedBindingResolutions = new WeakSet()

// First-party construction attestation for the two pluggable authorities. Every
// writer below is module-private; the exported constructors are the ONLY way in,
// and each is named for exactly what it is.
const trustedSystemIdentityAuthorities = new WeakSet()
const trustedCanonicalObjectAuthorities = new WeakSet()

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

function createCertifiedSystemIdentityAuthority(identityService) {
  const authority = Object.freeze({
    async systemContentKeyFor(systemId) {
      // The β module enforces its own trust on `identityService`; this module does
      // not second-guess it and does not reach into its `__internals`.
      return deriveSystemContentKeyForSystemId(identityService, systemId)
    },
  })
  trustedSystemIdentityAuthorities.add(authority)
  return authority
}

function createCertifiedCanonicalObjectAuthority(contractRegistry) {
  const authority = Object.freeze({
    canonicalObjectVersionFor(contractId, contractVersion) {
      // The γ module enforces trust on `contractRegistry`.
      const found = resolveCanonicalObjectContractVersion(contractRegistry, contractId, contractVersion)
      return found && found.version
    },
  })
  trustedCanonicalObjectAuthorities.add(authority)
  return authority
}

// HARNESS shape — the RQ-3 substitute, named so it cannot be mistaken for the
// certified path. It exists because the certified positive controls are NOT
// CONSTRUCTIBLE at this base head (see the two notes above), and a control routed
// through `__internals.computeSystemContentKey` or through an untrusted registry's
// `resolve()` would make this module's own provenance mutations undetectable.
//
// DECLARED RESIDUAL, not a hidden one: a resolution minted through a harness
// authority carries the SAME trust brand as one minted through the certified path.
// Its containment today is LATENCY — this module has zero production consumers,
// proven by executed enumeration — and closing it is a precondition of any runtime
// wiring, alongside RQ-2/RQ-3.
function createHarnessSystemIdentityAuthorityForTests(systemContentKeyBySystemId) {
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
  trustedSystemIdentityAuthorities.add(authority)
  return authority
}

function createHarnessCanonicalObjectAuthorityForTests(entries) {
  if (!Array.isArray(entries)) fail('RESOLVER_COMPONENTS_INVALID')
  const table = new Map()
  const count = safeLength(entries, 'RESOLVER_INPUT_HOSTILE')
  for (let index = 0; index < count; index += 1) {
    const entry = safeRead(entries, index, 'RESOLVER_INPUT_HOSTILE')
    if (!isPlainObject(entry)) fail('RESOLVER_COMPONENTS_INVALID')
    const contractId = readIdentityToken(entry, 'contractId', 'RESOLVER_COMPONENTS_INVALID')
    const contractVersion = readIdentityToken(entry, 'contractVersion', 'RESOLVER_COMPONENTS_INVALID')
    const canonicalObjectVersion = readIdentityToken(entry, 'canonicalObjectVersion', 'RESOLVER_COMPONENTS_INVALID')
    table.set(`${contractId} ${contractVersion}`, canonicalObjectVersion)
  }
  const authority = Object.freeze({
    canonicalObjectVersionFor(contractId, contractVersion) {
      const found = table.get(`${contractId} ${contractVersion}`)
      if (typeof found !== 'string') fail('RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')
      return found
    },
  })
  trustedCanonicalObjectAuthorities.add(authority)
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
// grants resolution trust.
function buildTrustedBindingResolution(draft) {
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
  trustedBindingResolutions.add(owned)
  return owned
}

// Exported CHECKERS. A checker is a predicate over an object that already exists —
// it admits nothing and grants nothing. Only the GRANTER must stay module-private.
function isTrustedBindingResolution(value) {
  return trustedBindingResolutions.has(value)
}

function assertTrustedBindingResolution(value) {
  if (!trustedBindingResolutions.has(value)) fail('RESOLVER_RESOLUTION_NOT_TRUSTED')
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

async function resolveApprovedBindingInternal(components, runInput) {
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
  })
}

// The service factory. Dependencies are admitted by FIRST-PARTY IDENTITY and are
// captured HERE, once — never per call.
function createApprovedBindingResolver(components) {
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
  if (!trustedSystemIdentityAuthorities.has(systemIdentityAuthority)) fail('RESOLVER_COMPONENTS_INVALID')
  if (!trustedCanonicalObjectAuthorities.has(canonicalObjectAuthority)) fail('RESOLVER_COMPONENTS_INVALID')
  const bound = Object.freeze({ configStore, systemIdentityAuthority, canonicalObjectAuthority })
  return Object.freeze({
    resolveApprovedBinding(runInput) {
      return resolveApprovedBindingInternal(bound, runInput)
    },
  })
}

module.exports = {
  BINDING_RESOLVER_ERROR_REASONS,
  GipApprovedBindingResolverError,
  RESOLUTION_KEYS,
  createApprovedBindingResolver,
  createCertifiedSystemIdentityAuthority,
  createCertifiedCanonicalObjectAuthority,
  createHarnessSystemIdentityAuthorityForTests,
  createHarnessCanonicalObjectAuthorityForTests,
  isTrustedBindingResolution,
  assertTrustedBindingResolution,
  // `fail` is deliberately ABSENT — and inert anyway, since it takes no caller
  // text. `buildTrustedBindingResolution` is absent BECAUSE IT GRANTS TRUST: a
  // granting verb under `__internals` is the identical hole one namespace deeper.
  // Both pinned by the exact-key-set test, so re-adding either reds.
  __internals: {
    isPlainObject,
    hasControlCharacter,
    assertLosslessConfigBody,
  },
}
