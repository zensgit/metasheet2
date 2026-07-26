'use strict'

// GIP-D0 B1a — step 1.2a: purpose-built system identity read implementing the
// RATIFIED GIP-D0 §6 formula (design lock, landed via #4553 @ a53a199b1):
//
//   systemContentKey = hash( system/connector kind + endpoint identity
//                          + stable authPrincipalKey + authTenantScopeKey )
//
// LATENT: not wired to any runtime, route, scheduler or flag. No caller in
// this tree invokes deriveSystemContentKeyForSystemId (the gated, public
// entry point — see the P1-2 fix note above buildSystemIdentityServiceObject
// further down) yet, and it mints nothing today regardless: the
// module-private trusted-service constructor has no call site anywhere in
// this file, matching gip-connector-kind-registry.cjs's CERTIFIED_CONNECTOR_KIND_REGISTRY
// shipping empty — "nothing to certify/build FROM yet" is the honest LATENT
// state on both sides of this line.
//
// EXCLUDED from the four terms, per the lock and per owner ruling (ledger §3.0
// B-2): object/filter/data-selection scope (belongs to configContentKey),
// secretVersionId and credential material, actionProfileVersion, `role`, and
// the raw systemId/tenantId/workspaceId. This module's material object has
// EXACTLY four keys — see computeSystemContentKey — so none of the excluded
// fields can silently ride along the way #4596's `deriveSystemContentKey`
// hashed `config` whole plus `role` and the raw ids (HELD, never on main).
//
// Owner decision (α) — TWO MATERIALS, TWO RULES:
//   - identity material (authPrincipalKey / authTenantScopeKey): decrypted
//     ONLY inside the boundary formed by deriveSystemContentKey's own async
//     scope below, held BRIEFLY, domain-separated-HMAC'd IMMEDIATELY, then the
//     plaintext reference is dropped before the function returns. No plaintext
//     credential value, and no raw extracted principal/scope string, ever
//     leaves that scope — only the two HMAC digests do.
//   - authentication secret (the actual connection credential, e.g. password):
//     this module never reads it, never extracts it, never has a code path
//     that could put it in the hash material — a connector declaration is
//     only ever asked for a principal and a tenant-scope value, never a
//     secret. Consuming it to actually connect is step 1.4 (server-bound
//     source executor, connector-owned factory) — OUT OF SCOPE here.
//   - shared, fail-closed rule: a secret or a principal in the clear must
//     never reach evidence, a log, or an error. Every fail() call below
//     carries only fixed field-name strings and counts, never a runtime
//     value, and every extractor call is wrapped so a buggy/malicious
//     declaration cannot smuggle plaintext out through an error message.
//
// Rotation semantics (the observable contract, ledger §4.0 row α): key
// rotated, principal and permission scope unchanged => systemContentKey
// UNCHANGED (true simply because the secret is never a hash input). This was
// verified load-bearing, not just claimed (review round 4): this module's
// on-disk source was mutated in place — folding `credentialCiphertext` (the
// value that differs between the before/after-rotation calls in
// rotationSemanticsBothDirections's own fixture — a proxy for "the
// connection secret rotated", not the decrypted password itself) into
// computeSystemContentKey's material (the exact #4596-class defect: a
// rotation-varying value becoming part of the hash input) — then the REAL
// test file's rotationSemanticsBothDirections was run as-is (not a
// stand-in), reds the "rotation-unchanged" assertion specifically. Reverted
// from a pre-mutation backup and diff-verified byte-identical immediately
// after; the mutated state was never committed. The command + output
// transcript is pasted in PR #4610's body (round 4 section), not in this
// file or the test file.
// Principal OR tenant scope changed => systemContentKey changes, forcing
// lineage rebuild +
// re-qualification upstream (a later slice's job; this module only
// guarantees the key itself moves).

const crypto = require('node:crypto')
const { stableCanonicalStringify, CanonicalDomainError } = require('./gip-canonical-json.cjs')
// P1-2 FIX (owner HARD HOLD #4610, see the fix note above deriveSystemContentKeyForSystemId
// below): this module now imports the trusted CONNECTOR-KIND SINGLETON
// directly — "closed by import, not by parameter" — rather than
// resolveCertifiedConnectorKind/GipConnectorKindRegistryError, which existed
// only to trust-gate a CALLER-SUPPLIED registry. There is no longer a
// caller-supplied registry on the gated path at all.
const { CERTIFIED_CONNECTOR_KIND_REGISTRY } = require('./gip-connector-kind-registry.cjs')
const { SANITIZATION_MARKER_PATTERN, scrubSecretStringValue } = require('./payload-redaction.cjs')

const SYSTEM_IDENTITY_ERROR_REASONS = Object.freeze([
  'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
  'SYSTEM_IDENTITY_INPUT_INVALID',
  'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
  'SYSTEM_IDENTITY_MATERIAL_MISSING',
  'SYSTEM_IDENTITY_DECRYPTION_FAILED',
  'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
  'SYSTEM_IDENTITY_SERVICE_UNTRUSTED',
])
const ERROR_REASON_SET = new Set(SYSTEM_IDENTITY_ERROR_REASONS)

class GipSystemIdentityError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipSystemIdentityError'
    this.reason = reason
    this.details = details
  }
}

// P1-b FIX (review round 3 — round 2's fix REVERSED, not hardened). Round 2
// replaced `instanceof GipSystemIdentityError` with a module-private WeakSet
// "brand", reasoning only fail() could add to it. That reasoning was false in
// a way narrowing the export surface cannot repair: fail() itself was
// exported at __internals.fail, so the very actor this module must not trust
// — a connector declaration's extractor, reached through runExtractor's
// `fn(arg)` call, or an injected credentialStore.decrypt — could require()
// this module and call `__internals.fail(reason, attackerMessage,
// attackerDetails)` from inside its own callback, producing a GENUINELY
// branded error (fail() is the real function; the brand it applies is real)
// carrying arbitrary message/details. The two `isOwnFailure` rethrow branches
// then forwarded it VERBATIM — the bar rose (a bare `new
// GipSystemIdentityError(...)` no longer worked) but the hole moved, it did
// not close. Trimming which internals were exported would not have fixed it
// either: __internals.runExtractor and __internals.assertLosslessIdentityMaterial
// both call fail() with a caller-supplied `field` string landing in both
// `message` and `details.field` — an attacker-reachable route to a branded,
// attacker-text-carrying error that never touches __internals.fail directly.
//
// The actual fix is not a stronger brand: it is recognizing that BOTH catch
// sites below wrap ONLY a foreign call (`fn(arg)`, and
// `credentialStore.decrypt`) — this module's own code never runs inside
// either try, so a module-internal fail() can never legitimately need to
// survive either catch. There is nothing for a brand to preserve. Every error
// crossing either catch is therefore discarded unconditionally and replaced
// by a fixed, module-authored error carrying no foreign text at all — see
// runExtractor and the credentialStore.decrypt call site below. `fail` is no
// longer exported at all (see module.exports).
function fail(reason, message, details = {}) {
  if (!ERROR_REASON_SET.has(reason)) {
    throw new Error(
      'gip-system-identity-read internal: undeclared error reason '
        + '(add it to the frozen SYSTEM_IDENTITY_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipSystemIdentityError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// ---------------------------------------------------------------------------
// Losslessness guard (ledger §3.0 B-2: "the record is the STORED one, never a
// sanitized projection"). external-systems.cjs's PUBLIC read path runs stored
// config through sanitizeIntegrationPayload (payload-redaction.cjs) before
// handing it to a caller; hashing THAT output was a realized forgery class in
// the prior (HELD, non-ratified) attempt — a config edit that only changed a
// redacted/truncated field would be invisible to the hash, and two GENUINELY
// DIFFERENT configs (e.g. a DSN differing only in its embedded password) can
// sanitize down to a BYTE-IDENTICAL projection, colliding on one
// systemContentKey (proven directly by the collision test in the test file).
//
// P1-a FIX (review round 2): the marker detection below is NOT a hand-listed
// copy of payload-redaction.cjs's marker strings — it imports
// SANITIZATION_MARKER_PATTERN from that module directly, the single source
// that module's OWN redaction/truncation logic defines, so this guard cannot
// silently drift out of sync with it the next time a pattern there changes.
// It is also SUBSTRING containment, not exact equality: several of
// payload-redaction's value-scrub replacements splice a marker into the
// MIDDLE of a larger string (e.g. a DSN's userinfo, or a `key=value` pair),
// so an exact `value === '[redacted]'` check — the prior implementation —
// would silently miss every one of those embedded cases. Detects every
// marker shape sanitizeIntegrationPayload can leave behind, real-code
// detection, not a comment (review round 4): this module's on-disk source
// was mutated in place — the string check below reverted to the
// exact-equality, hand-listed form (the prior implementation) — then the
// REAL test file's losslessnessGuardIsSourcedFromTheRealSanitizer was run
// as-is (not a stand-in), reds specifically on the URL-userinfo
// embedded-substring case. Reverted from a pre-mutation backup and
// diff-verified byte-identical immediately after; the mutated state was
// never committed. The command + output transcript is pasted in PR #4610's
// body (round 4 section), not in this file or the test file.
//   - '[redacted]', '[redacted-jwt]', '[redacted-secret-id]' — key- and
//     value-based redaction, anywhere in the string (substring, not whole-
//     value equality)
//   - '...[truncated]' — string-length truncation suffix
//   - '[max-depth]' / '[circular]' — depth-cap / circular-reference markers
//   - '[N more items truncated]' — array-length truncation sentinel element
//   - the top-level truncation envelope shape { payloadTruncated: true, ... }
//     (structural, not textual — checked separately below, not by the regex)
//
// P3 SCOPE NOTE (review round 3): this guard can only ever detect the
// TEXTUAL/STRUCTURAL markers listed above — it is handed a single value and
// never a before/after pair, so it structurally cannot detect a lossy
// transform that leaves NO marker at all. payload-redaction.cjs's own
// sanitizePayloadValue has exactly two such marker-free operations: (1) a key
// in UNSAFE_PAYLOAD_KEYS (`__proto__`/`constructor`/`prototype`) is dropped
// with a bare `continue` — no replacement value, no token, the key simply
// does not appear in the output; (2) a non-plain-object value (e.g. a `Date`)
// falls through to `Object.entries(value)`, which is typically empty for
// such a value, so it silently walks to `{}`. Three genuinely different
// stored configs that differ ONLY in a dropped/emptied field can sanitize to
// a byte-identical projection this guard has no marker to catch. NOT rated
// P1: the dropped/emptied field itself cannot simultaneously be the
// string-typed `endpointIdentity` requiredHashInput demands (a dropped key
// reads as `undefined`, an emptied Date-shaped value reads as `{}`, neither
// is a non-empty string), so a plausible declaration still hits
// SYSTEM_IDENTITY_MATERIAL_MISSING downstream. But the module-header claim
// this guard exists for ("the record is the STORED one, never a sanitized
// projection") is a PROVENANCE claim; what this guard actually proves is
// MARKER ABSENCE, a narrower thing — read it as that, not as general
// anti-tampering. (Not fixed here: touching sanitizePayloadValue's shared
// behavior is out of scope for this LATENT slice and would affect every
// other consumer of payload-redaction.cjs, not just this guard.)
const MAX_SANITIZATION_SCAN_DEPTH = 64

function containsSanitizationMarker(value, depth) {
  // FAIL CLOSED at the depth cap: this is a values-free losslessness guard,
  // so "could not finish inspecting" must never answer "clean" — material
  // nested past this depth is not a legitimate identity-material shape
  // anyway, and a permissive `false` here would be a hole in a fail-closed
  // guard (the same class as an empty-references array silently reading as
  // "inventory complete"). `config` has no upstream depth bound on the path
  // to this function, so an attacker-nested value is constructible.
  if (depth > MAX_SANITIZATION_SCAN_DEPTH) return true
  if (typeof value === 'string') {
    return SANITIZATION_MARKER_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSanitizationMarker(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (value.payloadTruncated === true) return true
    return Object.values(value).some((v) => containsSanitizationMarker(v, depth + 1))
  }
  return false
}

function assertLosslessIdentityMaterial(value, field) {
  if (containsSanitizationMarker(value, 0)) {
    fail('SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS', `${field} must be the stored record, never a sanitized/redacted projection`, { field })
  }
}

// ---------------------------------------------------------------------------
// Endpoint-identity credential-shape boundary (P2-b, review round 2).
// gip-connector-kind-registry.cjs's registration check only proves the three
// per-kind extractors EXIST (typeof === 'function') — it says nothing about
// what they RETURN. Reuses payload-redaction.cjs's OWN value-based secret
// scrubber (the SAME regex set the sanitizer uses, not a second hand-rolled
// copy): if scrubbing the extracted endpointIdentity changes it at all, a
// credential-shaped substring was embedded in it (URL userinfo, a
// `password=`/`token=`/... key=value param, a Bearer/Basic header, a JWT, or
// a SEC-prefixed opaque secret id) and it is refused, closed, values-free —
// the message never echoes the endpoint string or which pattern matched.
function assertEndpointIdentityHasNoEmbeddedCredential(endpointIdentity) {
  if (scrubSecretStringValue(endpointIdentity) !== endpointIdentity) {
    fail('SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE', 'endpointIdentity must not contain embedded credential material', { field: 'endpointIdentity' })
  }
}

// ---------------------------------------------------------------------------
// Domain-separated HMAC — owner decision (α): identity material is HMAC'd
// IMMEDIATELY on extraction, keyed with server-held material never derived
// from the value itself. Two independent domain tags (principal vs tenant
// scope), each deriving its OWN key (see domainSeparatedHmac below), so that
// an operator who happens to store the SAME underlying string as both a
// principal and a tenant-scope value (or two systems that swap the two)
// cannot collide: domainKey(PRINCIPAL) and domainKey(TENANT_SCOPE) are two
// independent derived keys, so HMAC(domainKey(PRINCIPAL), X) != HMAC(domainKey(TENANT_SCOPE), X).
// Verified directly in the test file, and again by the swap-test (two systems
// whose principal/scope are transposed must NOT produce the same
// systemContentKey — the collision decision (α)'s domain separation exists to
// prevent).
const IDENTITY_HMAC_DOMAINS = Object.freeze({
  PRINCIPAL: 'gip.system_identity.auth_principal.v1',
  TENANT_SCOPE: 'gip.system_identity.auth_tenant_scope.v1',
})

function domainSeparatedHmac(hmacKey, domain, value) {
  // Double-HMAC (HKDF-Extract-style) domain separation: derive a
  // domain-specific key first, then HMAC the value under that derived
  // key. This needs no separator byte between domain and value at all
  // (avoiding any reliance on embedding a raw control byte in source),
  // and is a strictly stronger separation than concatenation-with-
  // separator: two different fixed domain constants always derive two
  // independent 256-bit keys, so HMAC(domainKey(A), X) and
  // HMAC(domainKey(B), X) cannot be related without hmacKey itself.
  const domainKey = crypto.createHmac('sha256', hmacKey).update(domain, 'utf8').digest()
  return crypto.createHmac('sha256', domainKey).update(value, 'utf8').digest('hex')
}

function assertHmacKey(hmacKey) {
  const isBufferLike = Buffer.isBuffer(hmacKey) || hmacKey instanceof Uint8Array
  if (!isBufferLike || hmacKey.length < 32) {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'a server-held HMAC key (Buffer/Uint8Array, >=32 bytes) is required', { field: 'hmacKey' })
  }
}

// ---------------------------------------------------------------------------
// The GIP-D0 §6 formula itself. EXACTLY four keys, all required non-empty
// strings — the shape that makes "config enters whole" / "role and raw ids
// added" structurally impossible: there is no fifth key this function could
// even receive without a caller change to this file.
function computeSystemContentKey({ kind, endpointIdentity, authPrincipalKey, authTenantScopeKey }) {
  function requiredHashInput(value, field) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('SYSTEM_IDENTITY_INPUT_INVALID', `${field} must be a non-empty string`, { field })
    }
    return value
  }
  const material = {
    kind: requiredHashInput(kind, 'kind'),
    endpointIdentity: requiredHashInput(endpointIdentity, 'endpointIdentity'),
    authPrincipalKey: requiredHashInput(authPrincipalKey, 'authPrincipalKey'),
    authTenantScopeKey: requiredHashInput(authTenantScopeKey, 'authTenantScopeKey'),
  }
  let serialized
  try {
    serialized = stableCanonicalStringify(material)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('SYSTEM_IDENTITY_INPUT_INVALID', 'system content key material must stay in the strict canonical JSON domain', {})
    }
    throw error
  }
  return crypto.createHash('sha256').update(serialized).digest('hex')
}

// Wraps a per-kind extractor call so a buggy or malicious declaration cannot
// leak plaintext (config internals, or worse, the decrypted credential
// envelope) through its OWN thrown error message/details — every reachable
// throw from this module carries only the fixed reason + a field name.
function runExtractor(fn, arg, field) {
  let result
  try {
    result = fn(arg)
  } catch {
    // FIX (review round 3): this try wraps ONLY `fn(arg)` — the per-kind
    // declaration's own extractor function. This module's own code never
    // executes inside that call, so there is no legitimate scenario in which
    // this catch needs to preserve anything about the original error: no
    // module-internal fail() can ever land here. Every foreign throw —
    // whatever class it is, whatever reason/message/details/stack it
    // carries, even a genuine GipSystemIdentityError the declaration
    // constructed or obtained by calling this module's own (former)
    // __internals.fail — is unconditionally discarded and replaced by this
    // fixed, values-free reason. (Round 2's `isOwnFailure` provenance
    // exemption, removed here, was itself the exfiltration channel this
    // round closes — see the note above fail() for the full account.)
    fail('SYSTEM_IDENTITY_MATERIAL_MISSING', `declared ${field} extraction threw`, { field })
  }
  if (typeof result !== 'string' || result.trim() === '') {
    fail('SYSTEM_IDENTITY_MATERIAL_MISSING', `declared ${field} extraction produced no value`, { field })
  }
  return result
}

function parseCredentialEnvelope(plaintext) {
  if (typeof plaintext !== 'string') {
    fail('SYSTEM_IDENTITY_DECRYPTION_FAILED', 'decrypted credential envelope must be a string', {})
  }
  let parsed
  try {
    parsed = JSON.parse(plaintext)
  } catch (_error) {
    fail('SYSTEM_IDENTITY_DECRYPTION_FAILED', 'decrypted credential envelope is not valid JSON', {})
  }
  if (!isPlainObject(parsed)) {
    fail('SYSTEM_IDENTITY_DECRYPTION_FAILED', 'decrypted credential envelope must be a JSON object', {})
  }
  return parsed
}

// MECHANISM-LEVEL helper (P1-2 fix, owner HARD HOLD #4610): resolves a kind
// against WHATEVER registry-shaped object is passed in — no trust check.
// This is deliberate and safe HERE specifically because, after this fix,
// this whole function (deriveSystemContentKey) is __internals-only (see
// module.exports below) — it is not the production/gated entry point, so it
// does not need to re-derive "is this registry genuinely first-party" the
// way the OLD top-level-exported version did. The production entry point
// (deriveSystemContentKeyForSystemId, further down) never accepts a registry
// parameter at all — it is CLOSED BY IMPORT to CERTIFIED_CONNECTOR_KIND_REGISTRY,
// which structurally cannot be forged (gip-connector-kind-registry.cjs's own
// P1-1 fix). Letting this __internals-only mechanism accept any
// resolve()-shaped object is what makes it usable for testing arbitrary
// connector-kind declarations (rotation semantics, hashing terms, DSN
// credential boundary, hostile-extractor probes, …) without needing those
// declarations to ever enter the one real trusted registry, which SHIPS
// EMPTY and stays that way in this LATENT slice.
function resolveDeclarationForMechanism(registry, kind) {
  if (!registry || typeof registry.resolve !== 'function') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'registry must expose resolve()', { field: 'registry' })
  }
  const declaration = registry.resolve(kind)
  if (!declaration) {
    fail('SYSTEM_IDENTITY_KIND_UNCERTIFIED', 'connector kind is not certified for GIP binding', {})
  }
  return declaration
}

// ---------------------------------------------------------------------------
// MECHANISM ONLY — see module.exports below: this function is exposed
// exclusively via __internals, never at the top level. It is the four/five-
// component formula implementation, unchanged in its own logic from prior
// review rounds; what changed (P1-2 fix) is that it is no longer this
// module's PUBLIC entry point. Inputs:
//   system              - { kind, config } — the LOSSLESS stored record (the
//                          adapter-shaped external-system row, never the
//                          sanitized public projection)
//   credentialCiphertext - the stored credentials_encrypted ciphertext string
//   credentialStore      - { decrypt(ciphertext): Promise<string> } — the
//                          SAME credential-store abstraction external-systems.cjs
//                          already uses; this module calls decrypt() itself so
//                          the decrypt-then-discard boundary is contained in
//                          ONE place rather than trusting an upstream caller
//                          to have already discarded the plaintext correctly
//   registry             - ANY object exposing resolve(kind) — NOT trust-gated
//                          here (see resolveDeclarationForMechanism above);
//                          the production path never passes this at all
//   hmacKey              - server-held Buffer/Uint8Array, >=32 bytes
//
// Returns { systemContentKey, kind } — nothing else. No plaintext credential
// value, no raw principal/scope string, and no config value ever appears in
// the return value or in any error this function throws.
async function deriveSystemContentKey({ system, credentialCiphertext, credentialStore, registry, hmacKey }) {
  if (!isPlainObject(system)) {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'system record must be a plain object', { field: 'system' })
  }
  if (typeof system.kind !== 'string' || system.kind.trim() === '') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'system.kind is required', { field: 'kind' })
  }
  assertHmacKey(hmacKey)
  if (typeof credentialCiphertext !== 'string' || credentialCiphertext === '') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'credentialCiphertext is required', { field: 'credentialCiphertext' })
  }
  if (!credentialStore || typeof credentialStore.decrypt !== 'function') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'a credentialStore exposing decrypt() is required', { field: 'credentialStore' })
  }

  const declaration = resolveDeclarationForMechanism(registry, system.kind)

  // NOTE (carried forward from review round 4, re-scoped for the P1-2 fix):
  // every direct `declaration.*` property read below — `declaration.extractEndpointIdentity`
  // (passed into runExtractor, not called inline, so a malicious GETTER on
  // that property would run OUTSIDE runExtractor's try), the two extractor
  // reads at the credential-store boundary, and `declaration.kind` at the
  // two computeSystemContentKey/return sites — is not wrapped by any catch.
  // On the PRODUCTION path (deriveSystemContentKeyForSystemId) this is safe
  // because `registry` is always CERTIFIED_CONNECTOR_KIND_REGISTRY, whose
  // declarations are always `normalizeDeclaration`'s frozen, plain-data
  // copies (gip-connector-kind-registry.cjs) — reading any field can never
  // execute foreign code, and no forged registry can substitute a raw object
  // with a malicious getter in `declaration`'s place (P1-1 fix). On the
  // MECHANISM/testing path (this function called directly via __internals),
  // `registry` can be anything a test builds — that is intentional (see
  // resolveDeclarationForMechanism above) and not a production exposure,
  // since this function itself is __internals-only.

  // P3-a FIX (review round 2): a non-plain-object system.config used to
  // silently substitute {} (the `Number(x) || 0` class of bug) and the
  // losslessness scan then inspected the SUBSTITUTE, never the real value —
  // permissive-by-coincidence (everything still got refused downstream via
  // MATERIAL_MISSING once the substitute's empty config produced no
  // endpointIdentity), but the branch itself was unexercised and wrong. A
  // non-plain-object config is refused outright, never quietly replaced.
  if (!isPlainObject(system.config)) {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'system.config must be a plain object', { field: 'config' })
  }
  const config = system.config
  assertLosslessIdentityMaterial(config, 'config')
  const endpointIdentity = runExtractor(declaration.extractEndpointIdentity, config, 'endpointIdentity')
  // P2-b FIX (review round 2): registration only checks that the three
  // per-kind extractors EXIST (typeof === 'function'), never what they
  // RETURN. Nothing upstream of this point forbids a declaration's
  // extractEndpointIdentity from returning a DSN/connection-string shape with
  // the credential embedded in it (`user:pass@host`, or a `key=value`
  // credential param) — the single most common shape for a
  // connectionString/jdbcUrl-class connector. If that were allowed through,
  // rotating ONLY the embedded password would move systemContentKey, in
  // direct violation of decision (α)'s ruled rotation contract ("secret
  // rotation alone must leave systemContentKey unchanged") — because the
  // secret would be riding inside the term the formula treats as endpoint
  // identity, never inside the (correctly excluded) secret material itself.
  // Constrained AT THE BOUNDARY, reusing payload-redaction.cjs's OWN
  // credential-shape detection (scrubSecretStringValue) rather than a second,
  // hand-rolled pattern set — if scrubbing changes the string at all, it
  // contained a credential-shaped substring and is refused, values-free.
  //
  // P3 DIRECTION NOTE (review round 3): "rotation contract satisfied" here
  // means something WEAKER than decision (α)'s ruled "systemContentKey
  // UNCHANGED across a secret-only rotation". For a declaration whose
  // extractEndpointIdentity returns a credential-embedded DSN, this boundary
  // refuses BOTH the before- and after-rotation variant — no key is ever
  // minted for either — so the invariant holds only because there is nothing
  // to compare, not because the formula computed the same digest twice. The
  // UNCHANGED outcome the ledger actually rules on is achieved by the NORMAL
  // path instead: a well-formed, credential-free endpointIdentity, where only
  // the separately supplied credential rotates (see
  // rotationSemanticsBothDirections in the test file — that is where
  // "unchanged" is genuinely demonstrated). Recorded here so "rotation
  // contract satisfied" is not read as the stronger claim for this
  // refused-DSN case.
  assertEndpointIdentityHasNoEmbeddedCredential(endpointIdentity)

  // ---- credential-store boundary starts: brief decrypt, immediate HMAC,
  // discard. Everything inside this async block is unreachable from the
  // function's return value or any error path except the two HMAC digests
  // computed at the very end of the try. ----
  let plaintext
  let principalHmac
  let tenantScopeHmac
  try {
    try {
      plaintext = await credentialStore.decrypt(credentialCiphertext)
    } catch {
      // FIX (review round 3): same discipline as runExtractor above —
      // credentialStore.decrypt is an injected, foreign dependency; this
      // module's own code never runs inside this try, so nothing legitimate
      // can ever need to survive this catch. Every foreign throw is
      // unconditionally discarded and replaced by this fixed reason,
      // regardless of what reason/message/details/stack it carried.
      fail('SYSTEM_IDENTITY_DECRYPTION_FAILED', 'credential decryption failed', {})
    }
    const credentials = parseCredentialEnvelope(plaintext)
    assertLosslessIdentityMaterial(credentials, 'credentials')
    const principal = runExtractor(declaration.extractAuthPrincipal, credentials, 'authPrincipalKey')
    const tenantScope = runExtractor(declaration.extractAuthTenantScope, credentials, 'authTenantScopeKey')
    principalHmac = domainSeparatedHmac(hmacKey, IDENTITY_HMAC_DOMAINS.PRINCIPAL, principal)
    tenantScopeHmac = domainSeparatedHmac(hmacKey, IDENTITY_HMAC_DOMAINS.TENANT_SCOPE, tenantScope)
  } finally {
    // Discard: drop every local reference this function holds to plaintext
    // material. JS cannot scrub already-copied heap bytes the way a
    // credential-store-native implementation could, but from this point no
    // variable in this function's scope holds the plaintext or the parsed
    // credentials object, and neither is returned or threaded into any error
    // above — verified by the sentinel-sweep test (a sentinel injected via a
    // fake credentialStore.decrypt must appear nowhere in the result or in
    // any thrown error's message/details, across every reachable fail path).
    plaintext = undefined
  }
  // ---- boundary ends: only opaque HMAC digests exist beyond this point ----

  const systemContentKey = computeSystemContentKey({
    kind: declaration.kind,
    endpointIdentity,
    authPrincipalKey: principalHmac,
    authTenantScopeKey: tenantScopeHmac,
  })

  return Object.freeze({ systemContentKey, kind: declaration.kind })
}

// ---------------------------------------------------------------------------
// P1-2 FIX (owner HARD HOLD #4610): deriveSystemContentKey above used to be
// this module's ONE top-level PUBLIC export, receiving system, credentialStore,
// registry AND hmacKey on EVERY call — it could prove none of the four came
// from the server DB, the real credential store, or a fixed service key. Any
// importing module could call it with entirely self-sourced components.
//
// Required shape (owner's words): the trusted singleton registry, the
// credential store, the HMAC key and a server-side system resolver are fixed
// at CONSTRUCTION time; the per-call API then accepts ONLY a scoped system ID
// — never the authority components.
//
// The trap the owner named explicitly: a PUBLIC factory that still takes
// those components "simply moves the problem up one level". So
// buildSystemIdentityService below is NEVER exported, under any name,
// anywhere — not at the top level, and not under __internals either
// (__internals is still a property of module.exports, reachable by any
// require()-holding importer; a trust-granting constructor placed there
// would be the identical hole one namespace deeper — the SAME reasoning
// gip-connector-kind-registry.cjs's buildTrustedConnectorKindRegistry and
// gip-canonical-object-contract-registry.cjs's buildInventoryAttestation
// apply). The registry component specifically is closed a layer further
// down still: it is not even a PARAMETER here — buildSystemIdentityService's
// returned service always resolves kinds against CERTIFIED_CONNECTOR_KIND_REGISTRY,
// imported directly at the top of this file, never supplied by a caller.
//
// Ships with ZERO trusted instances — buildSystemIdentityService has no call
// site anywhere in this file today. That is the honest state: this repo has
// no real server-side system resolver, no real credential-store singleton,
// and no fixed service HMAC key yet (LATENT slice, no runtime wiring) — so
// there is nothing legitimate to build one FROM, and inventing one now would
// be new infrastructure this slice does not own. A future, separately-
// reviewed amendment that wires real infrastructure must call
// buildSystemIdentityService from a line ADDED TO THIS FILE — never from a
// runtime call anywhere else in the process. Until then,
// deriveSystemContentKeyForSystemId below refuses EVERY caller,
// unconditionally — "the public path mints nothing in this slice" is a
// precise description, not an approximation: reproduced directly by
// publicPathNeverMintsInThisSlice in the test file.
const trustedSystemIdentityServices = new WeakSet()

function assertValidServiceComponents({ credentialStore, hmacKey, resolveSystem }) {
  if (!credentialStore || typeof credentialStore.decrypt !== 'function') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'a credentialStore exposing decrypt() is required', { field: 'credentialStore' })
  }
  assertHmacKey(hmacKey)
  if (typeof resolveSystem !== 'function') {
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'a resolveSystem(systemId) function is required', { field: 'resolveSystem' })
  }
}

function assertTrustedSystemIdentityService(service) {
  // WeakSet.has(primitive) returns false (never throws) — null/plain
  // objects/strings all fail here too.
  if (!trustedSystemIdentityServices.has(service)) {
    fail('SYSTEM_IDENTITY_SERVICE_UNTRUSTED', 'a trusted system identity service (module-internally constructed) is required', { field: 'service' })
  }
}

// Shared construction mechanics for BOTH the trusted builder and the
// untrusted test seam below — the ONLY difference between them is whether
// the result is added to trustedSystemIdentityServices, never the mechanics.
//
// TRUST-CHECK PLACEMENT (advisor-caught defect, fixed before this ever
// shipped): the trust check must live INSIDE the returned method itself, not
// only in the deriveSystemContentKeyForSystemId free-function wrapper below.
// An earlier draft checked trust ONLY in that wrapper — so
// `service.deriveSystemContentKeyForSystemId(systemId)`, called DIRECTLY on
// an object from the untrusted seam (bypassing the wrapper entirely), never
// touched the trust check at all, and "refused" only by the accident of
// CERTIFIED_CONNECTOR_KIND_REGISTRY being empty today. The moment a future
// amendment registers one kind, that direct call becomes fully
// mint-capable from an importer's own credentialStore + hmacKey — the exact
// P1-2 shape, reintroduced by the very seam meant to prove it closed. Fixed
// by capturing `service` in closure BEFORE freezing and asserting trust on
// it as the method's OWN first statement — the object's identity is
// unaffected by Object.freeze, so this checks the SAME reference
// buildSystemIdentityService below adds to the WeakSet.
function buildSystemIdentityServiceObject({ credentialStore, hmacKey, resolveSystem }) {
  assertValidServiceComponents({ credentialStore, hmacKey, resolveSystem })
  const service = {
    async deriveSystemContentKeyForSystemId(systemId) {
      assertTrustedSystemIdentityService(service)
      if (typeof systemId !== 'string' || systemId.trim() === '') {
        fail('SYSTEM_IDENTITY_INPUT_INVALID', 'systemId must be a non-empty string', { field: 'systemId' })
      }
      let resolved
      try {
        resolved = await resolveSystem(systemId)
      } catch {
        // Same discipline as runExtractor / credentialStore.decrypt above:
        // resolveSystem is an injected, foreign dependency (a THIRD foreign
        // call site, alongside the two already-guarded ones) — this
        // module's own code never runs inside this try, so every foreign
        // throw is unconditionally discarded and replaced by this fixed,
        // values-free reason.
        fail('SYSTEM_IDENTITY_INPUT_INVALID', 'resolveSystem threw', { field: 'resolveSystem' })
      }
      if (!isPlainObject(resolved) || !isPlainObject(resolved.system) || typeof resolved.credentialCiphertext !== 'string') {
        fail('SYSTEM_IDENTITY_INPUT_INVALID', 'resolveSystem must resolve to { system, credentialCiphertext }', { field: 'resolveSystem' })
      }
      // Registry is CLOSED BY IMPORT, never a parameter — CERTIFIED_CONNECTOR_KIND_REGISTRY
      // is the only trusted connector-kind registry in existence (P1-1 fix,
      // gip-connector-kind-registry.cjs).
      return deriveSystemContentKey({
        system: resolved.system,
        credentialCiphertext: resolved.credentialCiphertext,
        credentialStore,
        registry: CERTIFIED_CONNECTOR_KIND_REGISTRY,
        hmacKey,
      })
    },
  }
  return Object.freeze(service)
}

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants trust — see the P1-2 fix note above.
function buildSystemIdentityService(components) {
  const service = buildSystemIdentityServiceObject(components)
  trustedSystemIdentityServices.add(service)
  return service
}

// The gated, closure-style PUBLIC entry point (owner's required shape).
// Accepts ONLY a service reference + a scoped systemId — never raw authority
// components. Refuses EVERY caller today (see the header note above) because
// buildSystemIdentityService has no call site yet. This check is now
// REDUNDANT with the one inside the method itself (defense in depth,
// deliberately — see the fix note above buildSystemIdentityServiceObject),
// not a substitute for it.
async function deriveSystemContentKeyForSystemId(service, systemId) {
  assertTrustedSystemIdentityService(service)
  return service.deriveSystemContentKeyForSystemId(systemId)
}

// TEST SEAM (owner's words: "give them a seam that produces UNTRUSTED
// [services] — and assert those are refused"). Builds the SAME shape as
// buildSystemIdentityService but is NEVER added to trustedSystemIdentityServices
// — calling deriveSystemContentKeyForSystemId with its output must always
// refuse, WHETHER called through the free-function wrapper above OR directly
// as a method on the object itself (see the fix note above
// buildSystemIdentityServiceObject — both are tested, not just the wrapper).
// This is the ONLY way an importing module can construct a service-shaped
// object out of its own credentialStore/hmacKey/resolveSystem — and it is
// refused BY DESIGN. This is the acceptance test this fix must satisfy: "an
// importing module cannot construct a minting-capable identity service out
// of its own registry / credential store / HMAC key" (the registry
// component is not even a parameter here at all — see above).
function createUntrustedSystemIdentityServiceForTests(components) {
  return buildSystemIdentityServiceObject(components)
}

// P2-a FIX (review round 2): computeSystemContentKey used to be a TOP-LEVEL
// public export — a bypass of BOTH the kind-certification gate (it takes a
// raw `kind` string, never resolved through resolveCertifiedConnectorKind)
// AND the HMAC boundary (it takes authPrincipalKey/authTenantScopeKey as
// whatever string a caller hands it, raw or HMAC'd, no way to tell). The
// module's only PUBLIC route to a systemContentKey must be the gated
// entry point; computeSystemContentKey moves to __internals.
//
// P2 FIX (review round 3): the exact-export-key-set test used to pin only
// the TOP-LEVEL export keys — "__internals" itself was one pinned key, but
// nothing pinned WHICH keys live inside it, so adding a key under
// __internals (any name) reds nothing. `__internals`'s own key set is now
// pinned too (exactPublicExportKeySet in the test file), and `fail` was
// removed from it entirely (see the note above fail() itself) rather than
// merely narrowed — exporting fail() at all was round 2's exfiltration
// channel's root cause, and neither `runExtractor` nor
// `assertLosslessIdentityMaterial` (still exported, for internal/testing
// use) can reach it either: both only ever call fail() with fixed reason
// tokens and a caller-controlled `field` LABEL, never with plaintext
// identity/credential material — a materially different exposure than the
// removed brand-forging path.
//
// P1-2 FIX (owner HARD HOLD #4610), CORRECTED (advisor-caught defect):
// deriveSystemContentKey does NOT unconditionally join computeSystemContentKey
// under __internals. computeSystemContentKey's round-2 demotion was safe
// because it hashes four strings the caller already holds — anyone can
// compute sha256, so an importer reaching it via require() gains nothing.
// deriveSystemContentKey is different in kind: it resolves a kind, drives an
// injected credential store, and emits a value that LOOKS like an authorized
// systemContentKey — putting it in __internals unconditionally would let any
// importer do `require(...).__internals.deriveSystemContentKey({ system,
// credentialCiphertext, credentialStore: mine, registry:
// createConnectorKindRegistry([...]), hmacKey: mine })` and mint one, the
// exact P1-2 shape one namespace deeper (proven live during this fix's own
// review: this exact call minted successfully before this env gate existed).
//
// Fixed with the SAME principle this codebase already applies to optional
// side-effect channels elsewhere: an optional, test-only surface registers
// only when its own env var is explicitly set — __internals.deriveSystemContentKey
// exists ONLY when GIP_SYSTEM_IDENTITY_TEST_MECHANISM=1 is set in the
// process environment BEFORE this module is first required (require()
// caches the module and its exports object, so this is a load-time
// decision, not a per-call check). The test file sets it at the very top,
// before requiring this module. A production process has no reason to ever
// set it, so in an UNCONFIGURED process __internals.deriveSystemContentKey
// does not exist — an importing module cannot reach the mechanism via a
// plain require() at all, not just "is refused by it". The module's only
// PUBLIC route to a systemContentKey is deriveSystemContentKeyForSystemId,
// which mints nothing today (no trusted service is ever built) — see the
// fix note above buildSystemIdentityServiceObject.
//
// SCOPE LIMIT (state this plainly, do not overclaim it): this gate reduces
// REACHABILITY from a plain require(), not authority. Code already executing
// inside the process can set `process.env.GIP_SYSTEM_IDENTITY_TEST_MECHANISM
// = '1'`, delete this module's entry from `require.cache`, and re-require it
// to get the mechanism back. That is a materially higher bar than the
// owner's stated concern ("any importer... no source edit required" — a
// PLAIN require() with no further trickery) and this fix closes exactly that
// bar, not a stronger one — it does not, and does not claim to, defend
// against arbitrary in-process code execution.
const GIP_SYSTEM_IDENTITY_TEST_MECHANISM_ENV_VAR = 'GIP_SYSTEM_IDENTITY_TEST_MECHANISM'
const __internalsExports = {
  domainSeparatedHmac,
  containsSanitizationMarker,
  assertLosslessIdentityMaterial,
  assertEndpointIdentityHasNoEmbeddedCredential,
  computeSystemContentKey,
  parseCredentialEnvelope,
  runExtractor,
}
if (process.env[GIP_SYSTEM_IDENTITY_TEST_MECHANISM_ENV_VAR] === '1') {
  __internalsExports.deriveSystemContentKey = deriveSystemContentKey
}

module.exports = {
  deriveSystemContentKeyForSystemId,
  createUntrustedSystemIdentityServiceForTests,
  GipSystemIdentityError,
  SYSTEM_IDENTITY_ERROR_REASONS,
  IDENTITY_HMAC_DOMAINS,
  __internals: __internalsExports,
}
