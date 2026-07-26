'use strict'

// GIP-D0 B1a — step 1.2b/1.2c: first-party CLOSED connector-kind registry
// (owner decision β, ledger §4.0 row β / §4 step 1.2 / §3.0 B-2).
//
// LATENT: not wired to any runtime, route, scheduler or flag. No caller in this
// tree consults CERTIFIED_CONNECTOR_KIND_REGISTRY yet — that wiring is a later,
// separately-gated slice (§4 step 1.2/1.4 consumers).
//
// `kind` is a free-form `requiredString` on `integration_external_systems.kind`
// (external-systems.cjs L91) with no vocabulary anywhere — no CHECK constraint,
// no enum, immutable after creation. This module is the vocabulary GIP binding
// alone will consult; it does NOT touch external-systems.cjs, and every kind
// that works today keeps working there unchanged (§3.0 B-2's "legacy paths keep
// working" clause — enforced by this module simply never being on that path,
// proven by the negative-control test in __tests__/gip-connector-kind-registry.test.cjs).
//
// Ruled design (owner decision β, ledger §4.0):
//   - first-party and CLOSED: the only way to add a kind is to edit this
//     module's source and hand it to createConnectorKindRegistry — never a
//     runtime call, never customer input;
//   - existing aliases are mapped EXPLICITLY (there are none yet — ships EMPTY);
//   - an unknown kind fails closed for GIP binding with SYSTEM_IDENTITY_KIND_UNCERTIFIED;
//   - NEVER auto-extended from customer free strings — structural, not a
//     convention: the frozen registry object exposes no add/register method,
//     see the exact-key-set test;
//   - legacy paths keep working — this module changes no other module.
//
// Each declaration additionally covers step 1.2c (⟲B2-self round-4): the
// per-kind identity-material extraction rules for ALL THREE non-kind terms of
// the GIP-D0 §6 formula — endpoint identity, authPrincipalKey and
// authTenantScopeKey — so the redo does not ship a formula one term of which
// (authTenantScopeKey) is unsourced. A declaration missing any of the three
// extractor functions is refused at REGISTRATION time (CONNECTOR_KIND_DECLARATION_INVALID),
// not silently accepted and left to fail later.

const CONNECTOR_KIND_REGISTRY_ERROR_REASONS = Object.freeze([
  'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
  'CONNECTOR_KIND_DECLARATION_INVALID',
])
const ERROR_REASON_SET = new Set(CONNECTOR_KIND_REGISTRY_ERROR_REASONS)

class GipConnectorKindRegistryError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipConnectorKindRegistryError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details = {}) {
  if (!ERROR_REASON_SET.has(reason)) {
    // Coarse fixed token — never echo the rejected reason value (values-free).
    throw new Error(
      'gip-connector-kind-registry internal: undeclared error reason '
        + '(add it to the frozen CONNECTOR_KIND_REGISTRY_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipConnectorKindRegistryError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Identity-token hygiene, mirroring gip-binding-qualification-spike.cjs's
// requiredIdentityToken: server-authored constants only, never customer text —
// but still must not silently accept control chars / megabyte strings.
function requiredIdentityToken(value, field) {
  if (typeof value !== 'string') {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', `${field} must be a non-empty, <=128 printable-char token`, { field })
  }
  return trimmed
}

function requiredExtractorFunction(value, field) {
  if (typeof value !== 'function') {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', `${field} must be a function`, { field })
  }
  return value
}

// P3 FIX (owner HARD HOLD #4610 residual, round 6): reads ONE property off
// the caller-supplied, untrusted `entry` object. A plain data property never
// throws on read; a hostile GETTER can — and unguarded, the raw foreign
// error it throws (whatever class — TypeError, a bare Error, anything)
// would escape this module VERBATIM, breaking normalizeDeclaration's own
// contract that every error it throws is a GipConnectorKindRegistryError.
// This is the SAME class of hole review round 3 closed at
// gip-system-identity-read.cjs's foreign-call catch sites (runExtractor's
// `fn(arg)`, credentialStore.decrypt) — this module's direct `entry.*`
// property reads were left ASYMMETRIC with that fix until now. Every
// foreign throw crossing this read is unconditionally discarded and
// replaced with this module's own fixed, values-free reason — nothing
// about the original error (class, message, stack) is ever preserved.
// Scope, stated honestly: reachable only by an importer who builds their
// OWN registry via the exported, UNTRUSTED createConnectorKindRegistry seam
// and hands it a hostile declaration — the error surfaces back to that SAME
// caller. The one production entries array (CERTIFIED_CONNECTOR_KIND_REGISTRY's
// literal `[]` below) has zero entries, so this path is unexercised in
// production today. Module-private — not exported, not under __internals
// (the exact-key-set test below pins __internals to fail/normalizeDeclaration/
// requiredIdentityToken only).
function readDeclaredField(entry, field) {
  try {
    return entry[field]
  } catch {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', `${field} could not be read from the declaration`, { field })
  }
}

// Normalizes and validates ONE connector-kind declaration. Every field the
// GIP-D0 §6 formula needs beyond `kind` itself (endpoint identity,
// authPrincipalKey, authTenantScopeKey) must be a declared extractor — no
// guessing, no fallback, no default (a guessing extraction is "silently blind",
// ledger §3.0 B-2). Every direct `entry.*` property read below goes through
// readDeclaredField (see its comment for why); each ELEMENT read out of a
// supplied `aliases` array gets the identical guard inline, in the loop
// below — `Array.isArray` is true for a real array with a hostile accessor
// defined at one index (via `Object.defineProperty`) exactly as much as for
// an ordinary array, so `.map()`'s own internal element read would
// otherwise let a hostile index getter's raw throw escape unguarded, the
// same hole one level deeper. (A `Proxy` wrapping the whole `aliases` array
// is a broader, different attack surface — it can intercept `.length` and
// iteration mechanics themselves, not just one index's value — and is out
// of scope for this fix, at the same honesty-of-scope level this module
// already uses elsewhere: this closes hostile ACCESSORS on genuine
// objects/arrays, not an adversarial Proxy over the whole structure.)
function normalizeDeclaration(entry) {
  if (!isPlainObject(entry)) {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', 'a connector-kind declaration must be a plain object', {})
  }
  const kind = requiredIdentityToken(readDeclaredField(entry, 'kind'), 'kind')

  const rawAliases = readDeclaredField(entry, 'aliases')
  const aliasesInput = rawAliases === undefined ? [] : rawAliases
  if (!Array.isArray(aliasesInput)) {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', 'aliases must be an array', { field: 'aliases' })
  }
  const seenAliases = new Set()
  const aliases = []
  for (let index = 0; index < aliasesInput.length; index += 1) {
    let raw
    try {
      raw = aliasesInput[index]
    } catch {
      fail('CONNECTOR_KIND_DECLARATION_INVALID', 'aliases could not be read from the declaration', { field: 'aliases' })
    }
    const alias = requiredIdentityToken(raw, 'aliases')
    if (alias === kind) {
      fail('CONNECTOR_KIND_DECLARATION_INVALID', 'an alias must not equal its own canonical kind', { field: 'aliases' })
    }
    if (seenAliases.has(alias)) {
      fail('CONNECTOR_KIND_DECLARATION_INVALID', 'duplicate alias within one declaration', { field: 'aliases' })
    }
    seenAliases.add(alias)
    aliases.push(alias)
  }

  const extractEndpointIdentity = requiredExtractorFunction(readDeclaredField(entry, 'extractEndpointIdentity'), 'extractEndpointIdentity')
  const extractAuthPrincipal = requiredExtractorFunction(readDeclaredField(entry, 'extractAuthPrincipal'), 'extractAuthPrincipal')
  // step 1.2c: authTenantScopeKey gets the SAME treatment as endpoint/principal —
  // declared per kind, fail-closed if absent. A declaration missing this
  // extractor is invalid at registration time, not merely unsourced at read time.
  const extractAuthTenantScope = requiredExtractorFunction(readDeclaredField(entry, 'extractAuthTenantScope'), 'extractAuthTenantScope')

  return Object.freeze({
    kind,
    aliases: Object.freeze(aliases),
    extractEndpointIdentity,
    extractAuthPrincipal,
    extractAuthTenantScope,
  })
}

// TRUST is OBJECT IDENTITY (module-private WeakSet), the same unforgeable
// pattern as gip-binding-qualification-spike.cjs's trustedProbeStrategyRegistries
// — a duck-typed object with the right-looking public shape is not a member.
// P2 FIX (review round 3): this WeakSet is NOT re-exported via __internals
// (unlike an earlier shape of this file) — gip-binding-qualification-spike.cjs
// does not export its own equivalent either, and this module now matches
// that precedent exactly rather than merely citing it. Exporting it would
// have let ANY caller with require() access do
// `__internals.trustedConnectorKindRegistries.add(fakeRegistry)`, turning a
// duck-typed forgery into something assertTrustedRegistry accepts — the
// "unforgeable" claim above is true only because this stays private.
//
// P1-1 FIX (owner HARD HOLD #4610): round 3's fix above closed exactly ONE
// door — `.add(fake)` on this WeakSet from outside the module — and left the
// front door open: `createConnectorKindRegistry` itself was ALSO exported at
// the bottom of this file, and every registry it built was unconditionally
// added to this same WeakSet. That meant ANY importer, with zero source
// edits, could do `createConnectorKindRegistry([{ kind: 'runtime:forged',
// ... }])` and receive back an object `assertTrustedRegistry` accepts —
// "trusted" was never actually gated by anything but calling an exported
// function. The owner's demonstration: registering `runtime:forged` this way
// passed the WeakSet; an extractor that treats the password as the principal
// then lets rotating ONLY the secret change systemContentKey — decisions (α)
// and (β), directly violated. "A public factory whose products are trusted
// is equivalent to no trust check at all" (owner's words) — recorded here so
// the next author does not reintroduce this shape.
//
// The fix: `createConnectorKindRegistry` below now ONLY builds a registry
// object (resolve()/size(), same mechanics as always) — it no longer touches
// this WeakSet at all, so calling it, from anywhere, confers NOTHING. Trust
// is granted in EXACTLY one place: buildTrustedConnectorKindRegistry further
// down, which is NEVER exported — not at the top level, and not under
// __internals either (__internals is still a property of module.exports,
// reachable by any require()-holding importer; a trust-granting constructor
// placed there would be the identical hole one namespace deeper). Its only
// caller is the literal invocation that builds CERTIFIED_CONNECTOR_KIND_REGISTRY
// at module load, below. A future amendment that legitimately needs a SECOND
// trusted registry (there is no known reason to) would have to add a second
// call to buildTrustedConnectorKindRegistry from a line added to THIS FILE,
// in a reviewed commit — never from a runtime call anywhere else in the
// process. `createConnectorKindRegistry` stays exported deliberately: it is
// now honestly just "build a registry-shaped object" — the seam tests use to
// build UNTRUSTED registries and then assert resolveCertifiedConnectorKind
// refuses them (see gip-connector-kind-registry.test.cjs's
// forgedRegistryViaExportedFactoryIsRefused, which reproduces the owner's
// exact probe).
const trustedConnectorKindRegistries = new WeakSet()

// Builds a registry object (resolve()/size()) from a fixed entry list.
// `entries` MAY be empty. Calling this function grants NO trust — see the
// P1-1 fix note above. Mechanically unchanged from before that fix: entries
// are validated and inserted here, at construction, and never again.
function createConnectorKindRegistry(entries) {
  if (!Array.isArray(entries)) {
    fail('CONNECTOR_KIND_DECLARATION_INVALID', 'entries must be an array', { field: 'entries' })
  }
  const byKind = new Map()
  const aliasToKind = new Map()
  for (const raw of entries) {
    const declaration = normalizeDeclaration(raw)
    if (byKind.has(declaration.kind) || aliasToKind.has(declaration.kind)) {
      fail('CONNECTOR_KIND_DECLARATION_INVALID', 'duplicate kind declaration', { field: 'kind' })
    }
    for (const alias of declaration.aliases) {
      if (byKind.has(alias) || aliasToKind.has(alias)) {
        fail('CONNECTOR_KIND_DECLARATION_INVALID', 'alias collides with an existing kind or alias', { field: 'aliases' })
      }
      aliasToKind.set(alias, declaration.kind)
    }
    byKind.set(declaration.kind, declaration)
  }
  // Frozen object exposes ONLY resolve()/size() — no add/register/set method
  // exists on this object at all. This is the structural half of "never
  // auto-extended from customer free strings": there is no verb on the
  // returned object that could extend it, checked by the exact-key-set test
  // (the same technique the ledger prescribes for the qualification prober's
  // residual-1 predicate) so a re-addition under ANY name reds that test.
  return Object.freeze({
    resolve(rawKind) {
      if (typeof rawKind !== 'string') return null
      const trimmed = rawKind.trim()
      if (byKind.has(trimmed)) return byKind.get(trimmed)
      if (aliasToKind.has(trimmed)) return byKind.get(aliasToKind.get(trimmed))
      return null
    },
    size() {
      return byKind.size
    },
  })
}

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants trust — see the P1-1 fix note above createConnectorKindRegistry.
function buildTrustedConnectorKindRegistry(entries) {
  const registry = createConnectorKindRegistry(entries)
  trustedConnectorKindRegistries.add(registry)
  return registry
}

function assertTrustedRegistry(registry) {
  if (!trustedConnectorKindRegistries.has(registry)) {
    // WeakSet.has(primitive) returns false (never throws) — null/strings fail here too.
    fail('CONNECTOR_KIND_DECLARATION_INVALID', 'a trusted connector-kind registry (from createConnectorKindRegistry) is required', { field: 'registry' })
  }
}

// The ONE fail-closed entry point GIP binding is meant to call. An unresolved
// kind — including one that works perfectly on every legacy path — refuses
// with the ruled, values-free reason. Never echoes the rejected kind string.
function resolveCertifiedConnectorKind(registry, rawKind) {
  assertTrustedRegistry(registry)
  const declaration = registry.resolve(rawKind)
  if (!declaration) {
    fail('SYSTEM_IDENTITY_KIND_UNCERTIFIED', 'connector kind is not certified for GIP binding', {})
  }
  return declaration
}

// The first-party CLOSED registry itself — SHIPS EMPTY. No entries exist yet;
// this module writes none from anywhere but this literal array. Only a future,
// separately-reviewed amendment may add a declaration here (owner decision β
// requires the alias map to come from a privately-authorized real inventory
// run that has not happened — see #4609 / the ledger's ⟲OD2 amendment). Until
// then every kind, certified-sounding or not, is uncertified for GIP binding.
// Built via buildTrustedConnectorKindRegistry (module-private, P1-1 fix) —
// this is the ONE trusted registry instance that will ever exist.
const CERTIFIED_CONNECTOR_KIND_REGISTRY = buildTrustedConnectorKindRegistry([])

module.exports = {
  createConnectorKindRegistry,
  resolveCertifiedConnectorKind,
  CERTIFIED_CONNECTOR_KIND_REGISTRY,
  GipConnectorKindRegistryError,
  CONNECTOR_KIND_REGISTRY_ERROR_REASONS,
  __internals: {
    fail,
    normalizeDeclaration,
    requiredIdentityToken,
  },
}
