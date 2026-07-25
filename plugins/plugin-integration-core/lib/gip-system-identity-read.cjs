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
// UNCHANGED (true simply because the secret is never a hash input — proven,
// not just claimed, by the mutation probe in the test file: temporarily
// folding the secret into the hash material reds the "rotation-unchanged"
// case). Principal OR tenant scope changed => systemContentKey changes,
// forcing lineage rebuild + re-qualification upstream (a later slice's job;
// this module only guarantees the key itself moves).

const crypto = require('node:crypto')
const { stableCanonicalStringify, CanonicalDomainError } = require('./gip-canonical-json.cjs')
const {
  resolveCertifiedConnectorKind,
  GipConnectorKindRegistryError,
} = require('./gip-connector-kind-registry.cjs')

const SYSTEM_IDENTITY_ERROR_REASONS = Object.freeze([
  'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
  'SYSTEM_IDENTITY_INPUT_INVALID',
  'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
  'SYSTEM_IDENTITY_MATERIAL_MISSING',
  'SYSTEM_IDENTITY_DECRYPTION_FAILED',
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
// redacted/truncated field would be invisible to the hash. This guard detects
// the FIVE marker shapes that function's redaction/truncation can leave behind
// and refuses closed if any appear anywhere in the value handed to this
// module — it is real-code detection, not a comment, and the mutation
// probe in the test file removes it and shows the "sanitized config is
// refused" case red.
//   1. the literal sensitive-key redaction marker '[redacted]'
//   2. a string truncated with the '...[truncated]' suffix (key-independent)
//   3. the '[max-depth]' marker (key-independent)
//   4. the '[circular]' marker (key-independent)
//   5. the top-level truncation envelope shape { payloadTruncated: true, ... }
const REDACTED_MARKER = '[redacted]'
const TRUNCATION_SUFFIX = '...[truncated]'
const MAX_DEPTH_MARKER = '[max-depth]'
const CIRCULAR_MARKER = '[circular]'
const MAX_SANITIZATION_SCAN_DEPTH = 64

function containsSanitizationMarker(value, depth) {
  if (depth > MAX_SANITIZATION_SCAN_DEPTH) return false
  if (typeof value === 'string') {
    return (
      value === REDACTED_MARKER
      || value === MAX_DEPTH_MARKER
      || value === CIRCULAR_MARKER
      || value.endsWith(TRUNCATION_SUFFIX)
    )
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
  } catch (error) {
    // A guard elsewhere in THIS module (e.g. a nested fail()) must propagate
    // unchanged, never get relabeled by this catch-all — otherwise this
    // catch-all would cover for a more specific guard's exact reason token
    // (the "doors cover for each other" trap). Anything else — including
    // whatever the declaration's own error message says — is deliberately
    // discarded entirely: it may originate from a declaration this module
    // does not control and could embed the very plaintext this function
    // exists to protect.
    if (error instanceof GipSystemIdentityError) throw error
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
    if (error instanceof GipConnectorKindRegistryError && error.reason === 'SYSTEM_IDENTITY_KIND_UNCERTIFIED') {
      fail('SYSTEM_IDENTITY_KIND_UNCERTIFIED', 'connector kind is not certified for GIP binding', {})
    }
    throw error
  }

  const config = isPlainObject(system.config) ? system.config : {}
  assertLosslessIdentityMaterial(config, 'config')
  const endpointIdentity = runExtractor(declaration.extractEndpointIdentity, config, 'endpointIdentity')

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
    } catch (error) {
      if (error instanceof GipSystemIdentityError) throw error
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

module.exports = {
  deriveSystemContentKey,
  computeSystemContentKey,
  GipSystemIdentityError,
  SYSTEM_IDENTITY_ERROR_REASONS,
  IDENTITY_HMAC_DOMAINS,
  __internals: {
    fail,
    domainSeparatedHmac,
    containsSanitizationMarker,
    assertLosslessIdentityMaterial,
    parseCredentialEnvelope,
    runExtractor,
  },
}
