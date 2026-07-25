'use strict'

// GIP-D0 B1a — step 1.2a: purpose-built system identity read implementing the
// RATIFIED GIP-D0 §6 formula (design lock, landed via #4553 @ a53a199b1):
//
//   systemContentKey = hash( system/connector kind + endpoint identity
//                          + stable authPrincipalKey + authTenantScopeKey )
//
// LATENT: not wired to any runtime, route, scheduler or flag. No caller in this
// tree invokes deriveSystemContentKey yet.
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
const {
  resolveCertifiedConnectorKind,
  GipConnectorKindRegistryError,
} = require('./gip-connector-kind-registry.cjs')
const { SANITIZATION_MARKER_PATTERN, scrubSecretStringValue } = require('./payload-redaction.cjs')

const SYSTEM_IDENTITY_ERROR_REASONS = Object.freeze([
  'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
  'SYSTEM_IDENTITY_INPUT_INVALID',
  'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
  'SYSTEM_IDENTITY_MATERIAL_MISSING',
  'SYSTEM_IDENTITY_DECRYPTION_FAILED',
  'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
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

// ---------------------------------------------------------------------------
// The one entry point. Inputs:
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
//   registry             - a trusted registry from
//                          gip-connector-kind-registry.createConnectorKindRegistry
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

  let declaration
  try {
    declaration = resolveCertifiedConnectorKind(registry, system.kind)
  } catch (error) {
    // FIX (review round 3, advisor-informed re-review): this used to `throw
    // error` verbatim for any reason other than SYSTEM_IDENTITY_KIND_UNCERTIFIED
    // — including CONNECTOR_KIND_DECLARATION_INVALID from an untrusted
    // `registry` argument, which surfaced as a GipConnectorKindRegistryError,
    // NOT this module's GipSystemIdentityError, breaking the "every error
    // deriveSystemContentKey throws is a GipSystemIdentityError" contract
    // every other guard in this file upholds. assertTrustedRegistry's own
    // message/details are fixed constants (values-free already), so this was
    // a contract-consistency defect on its own, not a leak — but
    // gip-connector-kind-registry.cjs and gip-canonical-object-contract-registry.cjs
    // no longer export their registry-trust WeakSets (P2 fix, review round
    // 3): if they still did, a duck-typed forged registry could pass
    // assertTrustedRegistry and make `registry.resolve` itself
    // attacker-controlled, and this `throw error` would forward whatever it
    // threw verbatim — the exact P1-b shape, one level up. Closed on both
    // counts: every non-UNCERTIFIED failure here is relabeled with this
    // module's own fixed, values-free reason, never forwarded.
    if (error instanceof GipConnectorKindRegistryError && error.reason === 'SYSTEM_IDENTITY_KIND_UNCERTIFIED') {
      fail('SYSTEM_IDENTITY_KIND_UNCERTIFIED', 'connector kind is not certified for GIP binding', {})
    }
    fail('SYSTEM_IDENTITY_INPUT_INVALID', 'registry must be a trusted connector-kind registry (from createConnectorKindRegistry)', { field: 'registry' })
  }

  // P3 NOTE (review round 4): "closed on both counts" two comments above names
  // the catch-site relabel just above and the registries' un-exported trust
  // WeakSets (P2, round 3) — it does not name a THIRD dependency this function
  // also relies on. Every direct `declaration.*` property read below —
  // `declaration.extractEndpointIdentity` (passed into runExtractor, not
  // called inline, so a malicious GETTER on that property would run OUTSIDE
  // runExtractor's try), the two extractor reads at the credential-store
  // boundary, and `declaration.kind` at the two computeSystemContentKey/return
  // sites — is not wrapped by any catch. This is safe TODAY only because (a)
  // `normalizeDeclaration` (gip-connector-kind-registry.cjs) always returns a
  // freshly `Object.freeze`d, plain-data-property copy, so reading any of its
  // fields can never execute foreign code, and (b) the trust WeakSet stays
  // module-private, so `assertTrustedRegistry` can only ever be satisfied by a
  // registry whose `resolve()` returns one of THOSE frozen copies — a forged
  // registry cannot substitute a raw object with a malicious getter in
  // `declaration`'s place. Both (a) and (b) are exactly the mechanism the
  // forged-registry attack this round's blocking fix (see the two registries'
  // own `__internals` key-set pins) closes off. Not restructured here: this
  // dependency is not reachable at head (LATENT slice, no runtime consumer,
  // no forged registry can be constructed from outside this codebase today) —
  // recorded so a future change to either registry's freeze/export discipline
  // is reviewed with this function's reliance on it in view.

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

// P2-a FIX (review round 2): computeSystemContentKey used to be a TOP-LEVEL
// public export — a bypass of BOTH the kind-certification gate (it takes a
// raw `kind` string, never resolved through resolveCertifiedConnectorKind)
// AND the HMAC boundary (it takes authPrincipalKey/authTenantScopeKey as
// whatever string a caller hands it, raw or HMAC'd, no way to tell). The
// module's only PUBLIC route to a systemContentKey must be the gated
// deriveSystemContentKey above; computeSystemContentKey moves to
// __internals.
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
module.exports = {
  deriveSystemContentKey,
  GipSystemIdentityError,
  SYSTEM_IDENTITY_ERROR_REASONS,
  IDENTITY_HMAC_DOMAINS,
  __internals: {
    domainSeparatedHmac,
    containsSanitizationMarker,
    assertLosslessIdentityMaterial,
    assertEndpointIdentityHasNoEmbeddedCredential,
    computeSystemContentKey,
    parseCredentialEnvelope,
    runExtractor,
  },
}
