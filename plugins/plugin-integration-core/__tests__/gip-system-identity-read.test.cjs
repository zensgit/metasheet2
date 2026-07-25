'use strict'

// gip-system-identity-read.cjs — plain node test, hermetic. Proves the
// RATIFIED GIP-D0 §6 formula (systemContentKey = hash(kind + endpointIdentity
// + authPrincipalKey + authTenantScopeKey)) is implemented with EXACTLY those
// four terms — the EXCLUDED fields (config-beyond-endpoint, role, raw
// systemId/tenantId/workspaceId, the connection secret) provably do not move
// the key — plus the decision-(α) boundary properties: brief decryption,
// immediate domain-separated HMAC, discard, and "never into evidence, logs or
// errors" (a sentinel-sweep test, not a bare claim); and, from the review
// round 2 three-lens adversarial pass (P1-a/P1-b/P2-a/P2-b/P3-a): the
// losslessness guard is sourced from the REAL sanitizer (not a hand-listed
// copy), a forged public-class error cannot exfiltrate plaintext through
// either catch site, computeSystemContentKey is not independently reachable,
// an endpoint identity cannot smuggle an embedded credential past rotation
// semantics, and a non-plain-object config is refused rather than silently
// substituted.

const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  deriveSystemContentKey,
  GipSystemIdentityError,
  SYSTEM_IDENTITY_ERROR_REASONS,
  IDENTITY_HMAC_DOMAINS,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-system-identity-read.cjs'))

const {
  createConnectorKindRegistry,
} = require(path.join(__dirname, '..', 'lib', 'gip-connector-kind-registry.cjs'))

const {
  sanitizeIntegrationPayload,
} = require(path.join(__dirname, '..', 'lib', 'payload-redaction.cjs'))

const HMAC_KEY = crypto.randomBytes(32)

function harnessRegistry(overrides = {}) {
  return createConnectorKindRegistry([{
    kind: 'test:harness',
    aliases: [],
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
    ...overrides,
  }])
}

function fakeCredentialStore(ciphertextToPlain) {
  return {
    async decrypt(ciphertext) {
      if (!Object.prototype.hasOwnProperty.call(ciphertextToPlain, ciphertext)) {
        throw new Error('fake store: unknown ciphertext')
      }
      return ciphertextToPlain[ciphertext]
    },
  }
}

function envelope(fields) {
  return JSON.stringify(fields)
}

async function rejectsAsync(fn, reason, message) {
  let caught = null
  try { await fn() } catch (error) { caught = error }
  assert.ok(caught instanceof GipSystemIdentityError, `${message} — expected GipSystemIdentityError, got ${caught && caught.constructor.name}`)
  assert.equal(caught.reason, reason, `${message} — expected reason ${reason}, got ${caught && caught.reason}`)
  return caught
}

// ---------------------------------------------------------------------------
// (1) POSITIVE CONTROL — a well-formed call succeeds and is deterministic.
// ---------------------------------------------------------------------------
async function positiveControlSucceeds() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })
  const system = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }

  const r1 = await deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  const r2 = await deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.equal(r1.systemContentKey, r2.systemContentKey, 'identical inputs must be deterministic')
  assert.equal(r1.kind, 'test:harness')
  assert.match(r1.systemContentKey, /^[0-9a-f]{64}$/, 'systemContentKey must be a sha256 hex digest')
  assert.deepEqual(Object.keys(r1).sort(), ['kind', 'systemContentKey'], 'return shape must carry nothing beyond the key + resolved kind')
}

// ---------------------------------------------------------------------------
// (2) The four INCLUDED terms each independently move the key.
// ---------------------------------------------------------------------------
async function eachIncludedTermMovesTheKey() {
  const registry = createConnectorKindRegistry([
    {
      kind: 'test:harness-a',
      extractEndpointIdentity: (config) => config.baseUrl,
      extractAuthPrincipal: (creds) => creds.username,
      extractAuthTenantScope: (creds) => creds.acctId,
    },
    {
      kind: 'test:harness-b',
      extractEndpointIdentity: (config) => config.baseUrl,
      extractAuthPrincipal: (creds) => creds.username,
      extractAuthTenantScope: (creds) => creds.acctId,
    },
  ])
  const store = fakeCredentialStore({
    base: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }),
  })
  const baseSystem = { kind: 'test:harness-a', config: { baseUrl: 'https://a.example.internal' } }
  const base = await deriveSystemContentKey({ system: baseSystem, credentialCiphertext: 'base', credentialStore: store, registry, hmacKey: HMAC_KEY })

  // kind differs (same endpoint/creds).
  const diffKind = await deriveSystemContentKey({ system: { ...baseSystem, kind: 'test:harness-b' }, credentialCiphertext: 'base', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.notEqual(base.systemContentKey, diffKind.systemContentKey, 'different connector kind must move the key')

  // endpoint differs.
  const diffEndpoint = await deriveSystemContentKey({ system: { ...baseSystem, config: { baseUrl: 'https://b.example.internal' } }, credentialCiphertext: 'base', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.notEqual(base.systemContentKey, diffEndpoint.systemContentKey, 'different endpoint identity must move the key')

  // principal differs.
  const storeB = fakeCredentialStore({ base: envelope({ username: 'bob', password: 'p1', acctId: 'tenantX' }) })
  const diffPrincipal = await deriveSystemContentKey({ system: baseSystem, credentialCiphertext: 'base', credentialStore: storeB, registry, hmacKey: HMAC_KEY })
  assert.notEqual(base.systemContentKey, diffPrincipal.systemContentKey, 'different authPrincipalKey must move the key')

  // tenant scope differs.
  const storeC = fakeCredentialStore({ base: envelope({ username: 'alice', password: 'p1', acctId: 'tenantY' }) })
  const diffScope = await deriveSystemContentKey({ system: baseSystem, credentialCiphertext: 'base', credentialStore: storeC, registry, hmacKey: HMAC_KEY })
  assert.notEqual(base.systemContentKey, diffScope.systemContentKey, 'different authTenantScopeKey must move the key')
}

// ---------------------------------------------------------------------------
// (3) The EXCLUDED terms do NOT move the key — the exact #4596 deviation
// class this module exists to avoid (config-whole, role, raw ids).
// ---------------------------------------------------------------------------
async function excludedTermsDoNotMoveTheKey() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })

  const base = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }
  const r1 = await deriveSystemContentKey({ system: base, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })

  // (a) a non-identity config field (object/filter/data-selection scope, per
  // GIP-D0 §6 this belongs to configContentKey) must not move systemContentKey
  // — proves this module does NOT hash `config` whole.
  const withExtraConfigField = {
    kind: 'test:harness',
    config: { baseUrl: 'https://erp.example.internal', filterPreset: 'only-active-materials', defaultObject: 'bom_line' },
  }
  const r2 = await deriveSystemContentKey({ system: withExtraConfigField, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.equal(r1.systemContentKey, r2.systemContentKey, 'a config field beyond the declared endpoint must not move systemContentKey')

  // (b) role + raw systemId/tenantId/workspaceId — the adapter-shaped system
  // record real code produces (rowToAdapterExternalSystem) carries all of
  // these; a caller handing that full row to this module must get the same
  // key regardless of their values, because this module never reads them.
  const fullAdapterShapedA = {
    id: 'sys-aaaa',
    tenantId: 'tenant-1',
    workspaceId: 'ws-1',
    role: 'source',
    kind: 'test:harness',
    config: { baseUrl: 'https://erp.example.internal' },
  }
  const fullAdapterShapedB = {
    id: 'sys-bbbb',
    tenantId: 'tenant-2',
    workspaceId: 'ws-2',
    role: 'target',
    kind: 'test:harness',
    config: { baseUrl: 'https://erp.example.internal' },
  }
  const r3 = await deriveSystemContentKey({ system: fullAdapterShapedA, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  const r4 = await deriveSystemContentKey({ system: fullAdapterShapedB, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.equal(r3.systemContentKey, r4.systemContentKey, 'role and raw id/tenantId/workspaceId must not move systemContentKey')
  assert.equal(r1.systemContentKey, r3.systemContentKey, 'the extra adapter-row fields must not move the key at all vs. the minimal record')
}

// ---------------------------------------------------------------------------
// (4) Rotation semantics — BOTH directions (ledger §4.0 row α, ⟲OD).
// ---------------------------------------------------------------------------
async function rotationSemanticsBothDirections() {
  const registry = harnessRegistry()
  const system = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }

  const store = fakeCredentialStore({
    original: envelope({ username: 'alice', password: 'old-secret', acctId: 'tenantX' }),
    rotatedSecretOnly: envelope({ username: 'alice', password: 'BRAND-NEW-DIFFERENT-SECRET', acctId: 'tenantX' }),
    changedPrincipal: envelope({ username: 'mallory', password: 'old-secret', acctId: 'tenantX' }),
    changedScope: envelope({ username: 'alice', password: 'old-secret', acctId: 'tenantZ' }),
  })

  const before = await deriveSystemContentKey({ system, credentialCiphertext: 'original', credentialStore: store, registry, hmacKey: HMAC_KEY })

  // Direction 1: key rotated, principal + scope unchanged => UNCHANGED.
  const afterRotation = await deriveSystemContentKey({ system, credentialCiphertext: 'rotatedSecretOnly', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.equal(before.systemContentKey, afterRotation.systemContentKey, 'secret rotation alone must leave systemContentKey unchanged')

  // Direction 2a: principal changed => lineage must be rebuildable (key differs).
  const afterPrincipalChange = await deriveSystemContentKey({ system, credentialCiphertext: 'changedPrincipal', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.notEqual(before.systemContentKey, afterPrincipalChange.systemContentKey, 'a changed principal must force the key to change')

  // Direction 2b: tenant/permission scope changed => key differs.
  const afterScopeChange = await deriveSystemContentKey({ system, credentialCiphertext: 'changedScope', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.notEqual(before.systemContentKey, afterScopeChange.systemContentKey, 'a changed tenant/permission scope must force the key to change')
}

// Note on rotation-invariant load-bearingness: a test asserting "the secret
// never moves the key" (in (4) above) passes trivially under any correct
// implementation, so it needs a discriminating check that a subtly-wrong
// implementation would fail it. That check was performed as a MANUAL mutation
// pass against the real module — folding the connection secret into
// computeSystemContentKey's material (the #4596-class defect) and rerunning
// this suite, which reds rotationSemanticsBothDirections's rotation-unchanged
// case — not as a permanent function in this file (an earlier draft of this
// file carried a decorative in-file demonstration that tested a hand-rolled
// stand-in function rather than this module; removed as misleading). The
// mutation command + output are recorded in PR #4610, not here.

// ---------------------------------------------------------------------------
// (5) Domain separation — a swap of principal/scope must NOT collide.
// ---------------------------------------------------------------------------
async function domainSeparationPreventsSwapCollision() {
  const registry = harnessRegistry()
  const system = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }
  const store = fakeCredentialStore({
    original: envelope({ username: 'valueA', password: 'p', acctId: 'valueB' }),
    swapped: envelope({ username: 'valueB', password: 'p', acctId: 'valueA' }),
  })
  const original = await deriveSystemContentKey({ system, credentialCiphertext: 'original', credentialStore: store, registry, hmacKey: HMAC_KEY })
  const swapped = await deriveSystemContentKey({ system, credentialCiphertext: 'swapped', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.notEqual(original.systemContentKey, swapped.systemContentKey, 'transposing principal <-> scope must not collide (domain separation)')

  // Direct unit check on the HMAC primitive itself.
  const h1 = __internals.domainSeparatedHmac(HMAC_KEY, IDENTITY_HMAC_DOMAINS.PRINCIPAL, 'sameValue')
  const h2 = __internals.domainSeparatedHmac(HMAC_KEY, IDENTITY_HMAC_DOMAINS.TENANT_SCOPE, 'sameValue')
  assert.notEqual(h1, h2, 'HMAC over the same value under two different domains must differ')
}

// ---------------------------------------------------------------------------
// (6) Alias equivalence at the identity-read level (not just the registry
// level): resolving through an explicit alias produces the identical key as
// resolving through the canonical kind, given identical config/credentials.
// ---------------------------------------------------------------------------
async function aliasResolvesToSameKey() {
  const aliasedRegistry = createConnectorKindRegistry([{
    kind: 'test:harness',
    aliases: ['legacy:harness'],
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })
  const config = { baseUrl: 'https://erp.example.internal' }
  const byCanonical = await deriveSystemContentKey({ system: { kind: 'test:harness', config }, credentialCiphertext: 'ct1', credentialStore: store, registry: aliasedRegistry, hmacKey: HMAC_KEY })
  const byAlias = await deriveSystemContentKey({ system: { kind: 'legacy:harness', config }, credentialCiphertext: 'ct1', credentialStore: store, registry: aliasedRegistry, hmacKey: HMAC_KEY })
  assert.equal(byCanonical.systemContentKey, byAlias.systemContentKey, 'an explicit alias must resolve to the identical key as its canonical kind')
}

// ---------------------------------------------------------------------------
// (7) Fail-closed: uncertified kind.
// ---------------------------------------------------------------------------
async function uncertifiedKindFailsClosed() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'unknown:kind', config: {} }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
    'an uncertified kind must fail closed',
  )
}

// ---------------------------------------------------------------------------
// (8) Fail-closed: losslessness — SOURCED FROM THE REAL SANITIZER (P1-a fix,
// review round 2). Every fixture below is produced by running a realistic
// stored config through sanitizeIntegrationPayload itself (payload-
// redaction.cjs), not hand-typed marker strings — so this test cannot drift
// out of sync with what that function actually emits. Plus a genuine
// COLLISION test proving the realized forgery the guard exists to prevent,
// and a positive control proving the guard is not merely all-refusing.
// ---------------------------------------------------------------------------
async function losslessnessGuardIsSourcedFromTheRealSanitizer() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })

  async function mustRefuse(config, label) {
    await rejectsAsync(
      () => deriveSystemContentKey({ system: { kind: 'test:harness', config }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
      'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
      `a config sanitized by ${label} must be refused`,
    )
  }

  // Each fixture: a REALISTIC raw config, run through the REAL sanitizer,
  // whose OUTPUT (not a hand-typed stand-in) is what gets fed to
  // deriveSystemContentKey. Covers every marker shape sanitizeIntegrationPayload
  // can produce, including markers embedded as a SUBSTRING inside a larger
  // string (the exact class the prior exact-equality guard missed).
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', password: 'hunter2' }),
    'key-based redaction (whole-value "[redacted]")',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'postgres://svc:P@ssw0rd@erp-db.internal:5432/erp' }),
    'URL-userinfo value-scrub (embedded "[redacted]" substring, not whole-value)',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal?token=abcXYZ123; note' }),
    'key=value value-scrub (embedded "[redacted]" substring)',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'Authorization: Bearer abcdefgh12345678' }),
    'Bearer value-scrub (embedded "[redacted]" substring)',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: `Basic ${Buffer.from('alice:secret123').toString('base64')}` }),
    'Basic value-scrub (embedded "[redacted]" substring)',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' }),
    '"[redacted-jwt]" value-scrub',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'SEC1234567890AB' }),
    '"[redacted-secret-id]" value-scrub',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', blob: 'x'.repeat(2100) }, { maxStringLength: 2000 }),
    'string-length truncation suffix ("...[truncated]")',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', list: Array.from({ length: 60 }, (_, i) => i) }, { maxArrayItems: 50 }),
    'array-length truncation sentinel element ("[N more items truncated]")',
  )
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', nested: { a: { b: { c: { d: 'leaf' } } } } }, { maxDepth: 3 }),
    '"[max-depth]" marker',
  )
  {
    const circ = {}
    circ.self = circ
    await mustRefuse(
      sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', nested: circ }),
      '"[circular]" marker',
    )
  }
  await mustRefuse(
    sanitizeIntegrationPayload({ baseUrl: 'https://erp.example.internal', big: 'z'.repeat(50000) }, { maxBytes: 20 }),
    'top-level truncation envelope ({ payloadTruncated: true, ... }, incl. preview:"[omitted]")',
  )

  // POSITIVE CONTROLS — a real losslessness guard must not be all-refusing.
  // (a) benign config with no marker anywhere.
  const benign = { baseUrl: 'https://erp.example.internal', note: 'this field is not redacted at all' }
  const ok = await deriveSystemContentKey({ system: { kind: 'test:harness', config: benign }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.match(ok.systemContentKey, /^[0-9a-f]{64}$/, 'a benign config containing but not equal to the marker text must succeed')

  // (b) THE STRENGTHENING, MADE VISIBLE: a config whose marker is embedded as
  // a substring (not the whole value) would have PASSED under the prior
  // exact-equality guard (`value === '[redacted]'` is false for a string that
  // merely CONTAINS it) but MUST be refused under the fixed substring guard.
  await mustRefuse(
    { baseUrl: 'https://erp.example.internal/[redacted]/other-path' },
    'a marker embedded as a substring (would have passed the OLD exact-equality guard)',
  )

  // DEPTH-CAP FAIL-CLOSED — a values-free guard that "gives up" scanning past
  // its depth cap must refuse, never silently answer "clean". This is
  // constructible (config is arbitrary operator JSON with no upstream depth
  // bound), so it is tested directly rather than only asserted in a comment.
  function buildDeeplyNestedObject(depth, leafValue) {
    let value = leafValue
    for (let level = 0; level < depth; level += 1) value = { nested: value }
    return value
  }
  const deepButNoMarkerAnywhere = { baseUrl: 'https://erp.example.internal', deepField: buildDeeplyNestedObject(70, 'benign-leaf-value-no-marker-here') }
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:harness', config: deepButNoMarkerAnywhere }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
    'a config nested past the scan depth cap must refuse (fail closed at the cap, never "clean")',
  )
}

// ---------------------------------------------------------------------------
// (8b) COLLISION TEST (P1-a, explicit review requirement #3): two configs
// with GENUINELY DIFFERENT endpoints (different embedded DSN passwords) that
// sanitize down to a BYTE-IDENTICAL projection must NOT both mint a key —
// this is the realized forgery §3.0 B-2 exists to prevent. Proves (a) the
// collision premise is real (both sanitize identically), and (b) neither
// mints a key (both refused) — collision is structurally impossible, not
// merely "didn't happen to occur in this run".
// ---------------------------------------------------------------------------
async function sanitizedProjectionCollisionCannotMintAKey() {
  const registry = createConnectorKindRegistry([{
    kind: 'test:dsn-harness',
    extractEndpointIdentity: (config) => config.hint,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const store = fakeCredentialStore({ ct1: envelope({ username: 'svc', password: 'p', acctId: 'tenantX' }) })

  const rawA = { hint: 'jdbc:postgres://svc:PASSWORD-AAA-DIFFERENT@erp-db.internal:5432/erp' }
  const rawB = { hint: 'jdbc:postgres://svc:PASSWORD-BBB-DIFFERENT@erp-db.internal:5432/erp' }
  assert.notEqual(rawA.hint, rawB.hint, 'the two RAW endpoints must be genuinely different (different embedded password)')

  const sanitizedA = sanitizeIntegrationPayload(rawA)
  const sanitizedB = sanitizeIntegrationPayload(rawB)
  assert.equal(sanitizedA.hint, sanitizedB.hint, 'PREMISE: two genuinely different endpoints must sanitize to a BYTE-IDENTICAL projection (the collision the guard must prevent)')

  // Neither sanitized projection may mint a key.
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:dsn-harness', config: sanitizedA }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
    'sanitized projection A must be refused, never accepted as if it were the stored record',
  )
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:dsn-harness', config: sanitizedB }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
    'sanitized projection B must be refused, never accepted as if it were the stored record',
  )
}

// ---------------------------------------------------------------------------
// (9) Fail-closed: material missing (declared extractor returns empty/absent).
// ---------------------------------------------------------------------------
async function materialMissingFailsClosed() {
  const registryMissingEndpoint = createConnectorKindRegistry([{
    kind: 'test:no-endpoint',
    extractEndpointIdentity: () => undefined,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:no-endpoint', config: {} }, credentialCiphertext: 'ct1', credentialStore: store, registry: registryMissingEndpoint, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a declared endpoint extractor returning nothing must fail closed',
  )

  const registryMissingPrincipal = createConnectorKindRegistry([{
    kind: 'test:no-principal',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: () => '',
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:no-principal', config: { baseUrl: 'https://erp.example.internal' } }, credentialCiphertext: 'ct1', credentialStore: store, registry: registryMissingPrincipal, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a declared principal extractor returning an empty string must fail closed',
  )
}

// ---------------------------------------------------------------------------
// (10) SENTINEL SWEEP — automated proof of "never into evidence, logs, or
// errors", across every reachable fail path including a MALICIOUS declaration
// that tries to smuggle plaintext out through its own thrown error, AND
// (P1-b, review round 2) a FORGED public-class error at BOTH catch sites,
// plus an exclusivity control proving branding does not swallow a genuinely
// internal fail()'s own reason.
// ---------------------------------------------------------------------------
async function sentinelNeverLeaksAcrossAnyPath() {
  const SENTINEL = 'SENTINEL-PLAINTEXT-MUST-NOT-LEAK-9f3a1c'
  const registry = harnessRegistry()
  const system = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }

  // (a) success path: sentinel used as password (never read) AND as principal/
  // scope (read, but must exit the boundary only as an HMAC digest).
  const leakyStore = fakeCredentialStore({ ct: envelope({ username: SENTINEL, password: SENTINEL, acctId: SENTINEL }) })
  const result = await deriveSystemContentKey({ system, credentialCiphertext: 'ct', credentialStore: leakyStore, registry, hmacKey: HMAC_KEY })
  assert.ok(!JSON.stringify(result).includes(SENTINEL), 'sentinel must not appear in the success result')

  // (b) decrypt() itself throws with the sentinel in its message.
  const throwingStore = { async decrypt() { throw new Error(`decrypt exploded near ${SENTINEL}`) } }
  const errA = await rejectsAsync(
    () => deriveSystemContentKey({ system, credentialCiphertext: 'ct', credentialStore: throwingStore, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_DECRYPTION_FAILED',
    'decrypt() throwing must fail closed',
  )
  assert.ok(!(errA.message + JSON.stringify(errA.details)).includes(SENTINEL))

  // (c) decrypted plaintext is malformed JSON containing the sentinel.
  const malformedStore = fakeCredentialStore({ ct: `not-json-${SENTINEL}` })
  const errB = await rejectsAsync(
    () => deriveSystemContentKey({ system, credentialCiphertext: 'ct', credentialStore: malformedStore, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_DECRYPTION_FAILED',
    'malformed JSON plaintext must fail closed',
  )
  assert.ok(!(errB.message + JSON.stringify(errB.details)).includes(SENTINEL))

  // (d) a MALICIOUS/buggy declaration whose extractor throws an ORDINARY
  // Error that embeds the plaintext credential value — the catch-all in
  // runExtractor must discard the original error entirely, never forward its
  // message.
  const maliciousRegistry = createConnectorKindRegistry([{
    kind: 'test:malicious',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => { throw new Error(`leaked principal=${creds.username} secret=${creds.password}`) },
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const errC = await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:malicious', config: { baseUrl: 'https://erp.example.internal' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: maliciousRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a declaration whose extractor throws an ordinary Error must fail closed without forwarding its message',
  )
  assert.ok(!(errC.message + JSON.stringify(errC.details)).includes(SENTINEL), 'a malicious declaration must not be able to smuggle plaintext out through its own error')

  // (e) a malicious declaration that returns the sentinel WRAPPED so it looks
  // like a legitimate but wrong return (not thrown) — still must never leak,
  // because only the HMAC digest of whatever is returned crosses the boundary.
  const wrappingRegistry = createConnectorKindRegistry([{
    kind: 'test:wrapping',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const wrappedResult = await deriveSystemContentKey({ system: { kind: 'test:wrapping', config: { baseUrl: 'https://erp.example.internal' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: wrappingRegistry, hmacKey: HMAC_KEY })
  assert.ok(!JSON.stringify(wrappedResult).includes(SENTINEL))

  // (f) P1-b: a declaration constructs a REAL, public-class
  // GipSystemIdentityError itself (not this module's own fail()) and throws
  // it from an extractor — reachable at the runExtractor catch site. Prior to
  // the fix, `error instanceof GipSystemIdentityError` was true for this too
  // (the class is a public export a declaration can import and construct),
  // so it was rethrown VERBATIM, carrying the sentinel straight out. Fixed:
  // provenance (branding), not class, decides the exemption — this FOREIGN
  // error must be discarded and relabeled with the generic catch-all reason.
  const forgingExtractorRegistry = createConnectorKindRegistry([{
    kind: 'test:forged-error-extractor',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => {
      throw new GipSystemIdentityError('SYSTEM_IDENTITY_KIND_UNCERTIFIED', `principal=${creds.username} secret=${creds.password} sentinel=${SENTINEL}`, { leaked: SENTINEL })
    },
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const errF = await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:forged-error-extractor', config: { baseUrl: 'https://erp.example.internal' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: forgingExtractorRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a FOREIGN (unbranded) GipSystemIdentityError thrown by an extractor must be discarded, not rethrown verbatim, even though it IS an instance of the public class',
  )
  assert.ok(!(errF.message + JSON.stringify(errF.details)).includes(SENTINEL), 'the forged error message/details must not leak through runExtractor')
  assert.notEqual(errF.reason, 'SYSTEM_IDENTITY_KIND_UNCERTIFIED', 'the forged reason token must not survive either — it must be replaced by the catch-all reason')

  // (g) P1-b: the SAME forged-class attack at the SECOND catch site —
  // credentialStore.decrypt() itself constructs and throws a public-class
  // GipSystemIdentityError carrying the sentinel.
  const forgingStore = {
    async decrypt() {
      throw new GipSystemIdentityError('SYSTEM_IDENTITY_KIND_UNCERTIFIED', `leaked=${SENTINEL}`, { leaked: SENTINEL })
    },
  }
  const errG = await rejectsAsync(
    () => deriveSystemContentKey({ system, credentialCiphertext: 'ct', credentialStore: forgingStore, registry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_DECRYPTION_FAILED',
    'a FOREIGN (unbranded) GipSystemIdentityError thrown by credentialStore.decrypt must be discarded, not rethrown verbatim',
  )
  assert.ok(!(errG.message + JSON.stringify(errG.details)).includes(SENTINEL), 'the forged error message/details must not leak through the decrypt() catch site')
  assert.notEqual(errG.reason, 'SYSTEM_IDENTITY_KIND_UNCERTIFIED')

  // (h) EXCLUSIVITY CONTROL (the "doors cover for each other" trap): branding
  // must not become a NEW hole where the catch-all swallows a genuinely
  // internal, correctly-branded fail() and relabels it. Simulates a
  // (hypothetical, future) internal check inside runExtractor's try by having
  // the declaration itself call this module's OWN __internals.fail — which
  // DOES get branded — and asserts it survives with ITS OWN reason, not
  // MATERIAL_MISSING.
  const internalFailRegistry = createConnectorKindRegistry([{
    kind: 'test:internal-fail',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: () => { __internals.fail('SYSTEM_IDENTITY_INPUT_INVALID', 'deliberately internal, must not be relabeled', {}) },
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:internal-fail', config: { baseUrl: 'https://erp.example.internal' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: internalFailRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_INPUT_INVALID',
    'a BRANDED internal fail() thrown inside runExtractor must propagate with its OWN reason, never get relabeled by the catch-all',
  )
}

// ---------------------------------------------------------------------------
// (11) P2-b: endpoint-identity credential-shape boundary. A declared
// extractEndpointIdentity returning a DSN with embedded userinfo credentials
// must be refused — closing the hole where rotating ONLY the embedded
// password would move systemContentKey (violating decision (α)'s ruled
// rotation contract), because registration only ever checked that the
// extractor EXISTS, never what it RETURNS.
// ---------------------------------------------------------------------------
async function endpointIdentityCredentialBoundaryClosesDsnRotationHole() {
  const dsnRegistry = createConnectorKindRegistry([{
    kind: 'test:dsn-harness',
    extractEndpointIdentity: (config) => config.dsn,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const store = fakeCredentialStore({ ct1: envelope({ username: 'svc', password: 'irrelevant', acctId: 'tenantX' }) })

  const beforeRotation = { kind: 'test:dsn-harness', config: { dsn: 'postgres://svc:OLD-PASSWORD-AAA@erp-db.internal:5432/erp' } }
  const afterRotation = { kind: 'test:dsn-harness', config: { dsn: 'postgres://svc:NEW-PASSWORD-BBB@erp-db.internal:5432/erp' } }
  assert.notEqual(beforeRotation.config.dsn, afterRotation.config.dsn, 'the two DSNs must differ only in the embedded password')

  await rejectsAsync(
    () => deriveSystemContentKey({ system: beforeRotation, credentialCiphertext: 'ct1', credentialStore: store, registry: dsnRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
    'an endpoint identity carrying embedded URL-userinfo credentials must be refused (before rotation)',
  )
  await rejectsAsync(
    () => deriveSystemContentKey({ system: afterRotation, credentialCiphertext: 'ct1', credentialStore: store, registry: dsnRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
    'an endpoint identity carrying embedded URL-userinfo credentials must be refused (after rotation) — neither variant ever mints a key, so rotation cannot move one',
  )

  // key=value credential-param DSN shape (ODBC/SQL Server style) — the other
  // named "single most common shape" in the review.
  const kvBefore = { kind: 'test:dsn-harness', config: { dsn: 'Server=erp-db;Database=erp;password=OLD-PASSWORD-AAA;' } }
  const kvAfter = { kind: 'test:dsn-harness', config: { dsn: 'Server=erp-db;Database=erp;password=NEW-PASSWORD-BBB;' } }
  await rejectsAsync(
    () => deriveSystemContentKey({ system: kvBefore, credentialCiphertext: 'ct1', credentialStore: store, registry: dsnRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
    'a key=value credential-shaped endpoint identity must be refused (before rotation)',
  )
  await rejectsAsync(
    () => deriveSystemContentKey({ system: kvAfter, credentialCiphertext: 'ct1', credentialStore: store, registry: dsnRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
    'a key=value credential-shaped endpoint identity must be refused (after rotation)',
  )

  // POSITIVE CONTROL — a benign DSN-LOOKING string with NO embedded
  // credential (no userinfo, no credential key=value) must succeed, proving
  // the boundary is not merely all-refusing.
  const benignDsn = { kind: 'test:dsn-harness', config: { dsn: 'postgres://erp-db.internal:5432/erp' } }
  const ok = await deriveSystemContentKey({ system: benignDsn, credentialCiphertext: 'ct1', credentialStore: store, registry: dsnRegistry, hmacKey: HMAC_KEY })
  assert.match(ok.systemContentKey, /^[0-9a-f]{64}$/, 'a DSN with no embedded credential must be accepted')

  // COUNTERFACTUAL PROOF — reconstructs, via the internals directly (not the
  // real guarded pipeline), exactly what the pre-fix vulnerability was: if
  // the raw DSN string (untouched by the new boundary check) were allowed
  // through as endpointIdentity, the two rotated variants — same principal,
  // same tenant scope, ONLY the embedded password differing — would produce
  // DIFFERENT systemContentKeys, i.e. secret rotation alone moving the key.
  // This is the concrete violation of decision (α)'s ruled rotation contract
  // that P2-b's fix (the assertEndpointIdentityHasNoEmbeddedCredential call)
  // prevents by refusing such an endpoint identity outright.
  const fixedPrincipalHmac = __internals.domainSeparatedHmac(HMAC_KEY, IDENTITY_HMAC_DOMAINS.PRINCIPAL, 'svc')
  const fixedTenantScopeHmac = __internals.domainSeparatedHmac(HMAC_KEY, IDENTITY_HMAC_DOMAINS.TENANT_SCOPE, 'tenantX')
  const keyIfEndpointGuardDidNotExist_before = __internals.computeSystemContentKey({
    kind: 'test:dsn-harness',
    endpointIdentity: beforeRotation.config.dsn,
    authPrincipalKey: fixedPrincipalHmac,
    authTenantScopeKey: fixedTenantScopeHmac,
  })
  const keyIfEndpointGuardDidNotExist_after = __internals.computeSystemContentKey({
    kind: 'test:dsn-harness',
    endpointIdentity: afterRotation.config.dsn,
    authPrincipalKey: fixedPrincipalHmac,
    authTenantScopeKey: fixedTenantScopeHmac,
  })
  assert.notEqual(
    keyIfEndpointGuardDidNotExist_before,
    keyIfEndpointGuardDidNotExist_after,
    'COUNTERFACTUAL: with the boundary absent, an endpoint identity carrying the embedded DSN password would let systemContentKey MOVE on secret rotation alone — exactly the ruled-contract violation the boundary check prevents by refusing both variants instead',
  )
}

// ---------------------------------------------------------------------------
// (12) P3-a: a non-plain-object system.config is refused, never silently
// substituted with {} (the `Number(x) || 0` class of bug).
// ---------------------------------------------------------------------------
async function nonPlainObjectConfigFailsClosed() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })
  for (const badConfig of ['not-an-object', 42, true, null, undefined, ['array', 'not', 'object']]) {
    await rejectsAsync(
      () => deriveSystemContentKey({ system: { kind: 'test:harness', config: badConfig }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
      'SYSTEM_IDENTITY_INPUT_INVALID',
      `a non-plain-object system.config (${JSON.stringify(badConfig)}) must be refused, never silently substituted with {}`,
    )
  }
}

// ---------------------------------------------------------------------------
// (13) P2-a: computeSystemContentKey is NOT independently reachable — the
// module's exact PUBLIC export key set is pinned, the same technique the
// registries in this package use to pin their own structural closure, so a
// future re-export (under any name) reds.
// ---------------------------------------------------------------------------
function exactPublicExportKeySet() {
  const moduleExports = require(path.join(__dirname, '..', 'lib', 'gip-system-identity-read.cjs'))
  assert.deepEqual(
    Object.keys(moduleExports).sort(),
    ['GipSystemIdentityError', 'IDENTITY_HMAC_DOMAINS', 'SYSTEM_IDENTITY_ERROR_REASONS', '__internals', 'deriveSystemContentKey'],
    'the module must expose no public route to a systemContentKey other than the gated deriveSystemContentKey',
  )
  assert.equal(typeof __internals.computeSystemContentKey, 'function', 'computeSystemContentKey must still be reachable for internal/testing use via __internals')
}

// ---------------------------------------------------------------------------
// (14) Input validation / vocabulary discipline.
// ---------------------------------------------------------------------------
async function inputValidationFailsClosed() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'a', password: 'p', acctId: 't' }) })
  const system = { kind: 'test:harness', config: { baseUrl: 'https://erp.example.internal' } }

  await rejectsAsync(() => deriveSystemContentKey({ system: null, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'null system')
  await rejectsAsync(() => deriveSystemContentKey({ system: { config: {} }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'missing kind')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: '', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'empty ciphertext')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: {}, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'credentialStore without decrypt()')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: Buffer.alloc(16) }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'hmacKey too short')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: 'not-a-buffer' }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'hmacKey not a buffer')

  assert.deepEqual([...SYSTEM_IDENTITY_ERROR_REASONS].sort(), [
    'SYSTEM_IDENTITY_DECRYPTION_FAILED',
    'SYSTEM_IDENTITY_ENDPOINT_NOT_CREDENTIAL_FREE',
    'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
    'SYSTEM_IDENTITY_INPUT_INVALID',
  ].sort())
  assert.ok(Object.isFrozen(SYSTEM_IDENTITY_ERROR_REASONS))
}

async function main() {
  await positiveControlSucceeds()
  await eachIncludedTermMovesTheKey()
  await excludedTermsDoNotMoveTheKey()
  await rotationSemanticsBothDirections()
  await domainSeparationPreventsSwapCollision()
  await aliasResolvesToSameKey()
  await uncertifiedKindFailsClosed()
  await losslessnessGuardIsSourcedFromTheRealSanitizer()
  await sanitizedProjectionCollisionCannotMintAKey()
  await materialMissingFailsClosed()
  await sentinelNeverLeaksAcrossAnyPath()
  await endpointIdentityCredentialBoundaryClosesDsnRotationHole()
  await nonPlainObjectConfigFailsClosed()
  exactPublicExportKeySet()
  await inputValidationFailsClosed()
  console.log('gip-system-identity-read.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
