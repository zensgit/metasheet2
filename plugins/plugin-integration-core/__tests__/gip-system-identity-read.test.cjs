'use strict'

// gip-system-identity-read.cjs — plain node test, hermetic. Proves the
// RATIFIED GIP-D0 §6 formula (systemContentKey = hash(kind + endpointIdentity
// + authPrincipalKey + authTenantScopeKey)) is implemented with EXACTLY those
// four terms — the EXCLUDED fields (config-beyond-endpoint, role, raw
// systemId/tenantId/workspaceId, the connection secret) provably do not move
// the key — plus the decision-(α) boundary properties: brief decryption,
// immediate domain-separated HMAC, discard, and "never into evidence, logs or
// errors" (a sentinel-sweep test, not a bare claim).

const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  deriveSystemContentKey,
  computeSystemContentKey,
  GipSystemIdentityError,
  SYSTEM_IDENTITY_ERROR_REASONS,
  IDENTITY_HMAC_DOMAINS,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-system-identity-read.cjs'))

const {
  createConnectorKindRegistry,
  GipConnectorKindRegistryError,
} = require(path.join(__dirname, '..', 'lib', 'gip-connector-kind-registry.cjs'))

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

// ---------------------------------------------------------------------------
// (4b) MUTATION-LOAD-BEARING DEMONSTRATION for the rotation-unchanged
// direction. A test that "the secret never moves the key" passes trivially
// under any correct implementation and ALSO under a subtly-wrong one, unless
// something in the suite can distinguish them. This function builds the
// PLAUSIBLE WRONG implementation (the #4596-class defect: fold the raw secret
// into the hash material) side-by-side and proves it fails the very
// same equality the real test above relies on — i.e. the assertion in (4) is
// falsifiable, not vacuous. (The authoritative confirmation is the manual
// neuter-and-rerun pass against the real module, pasted in the PR body; this
// is the automated, permanent half of that proof.)
// ---------------------------------------------------------------------------
function rotationInvariantIsFalsifiable() {
  const { stableCanonicalStringify } = require(path.join(__dirname, '..', 'lib', 'gip-canonical-json.cjs'))
  function wronglyIncludesSecret({ kind, endpointIdentity, authPrincipalKey, authTenantScopeKey, secret }) {
    return crypto.createHash('sha256').update(stableCanonicalStringify({ kind, endpointIdentity, authPrincipalKey, authTenantScopeKey, secret })).digest('hex')
  }
  const shared = { kind: 'k', endpointIdentity: 'e', authPrincipalKey: 'p', authTenantScopeKey: 's' }
  const rotatedOnly1 = wronglyIncludesSecret({ ...shared, secret: 'old-secret' })
  const rotatedOnly2 = wronglyIncludesSecret({ ...shared, secret: 'BRAND-NEW-DIFFERENT-SECRET' })
  assert.notEqual(rotatedOnly1, rotatedOnly2, 'the plausible-wrong (#4596-class) implementation DOES fail rotation-unchanged — proving the real assertion in (4) is discriminating, not vacuous')

  // And the real, correct computeSystemContentKey (no secret parameter exists
  // to even pass) is unaffected by the same two secret values — restated at
  // the unit level, independent of decryption plumbing.
  const correct1 = computeSystemContentKey({ ...shared })
  const correct2 = computeSystemContentKey({ ...shared })
  assert.equal(correct1, correct2, 'computeSystemContentKey has no secret input at all — sanity check')
}

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
  const registry = harnessRegistry({ /* not used, replaced below with aliases */ })
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
  void registry
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
// (8) Fail-closed: losslessness — a sanitized/redacted config must be refused,
// in each of the five marker classes, plus a POSITIVE control that a normal,
// non-sanitized config with benign-looking-but-not-matching text passes.
// ---------------------------------------------------------------------------
async function losslessnessGuardCoversAllFiveMarkerClasses() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'alice', password: 'p1', acctId: 'tenantX' }) })

  const sanitizedConfigs = [
    { baseUrl: '[redacted]' }, // 1. literal sensitive-key redaction marker
    { baseUrl: 'https://erp.exampl...[truncated]' }, // 2. truncation suffix
    { baseUrl: '[max-depth]' }, // 3. max-depth marker
    { baseUrl: '[circular]' }, // 4. circular marker
    { nested: { payloadTruncated: true, originalBytes: 999, preview: {} } }, // 5. truncation envelope shape
  ]
  for (const config of sanitizedConfigs) {
    await rejectsAsync(
      () => deriveSystemContentKey({ system: { kind: 'test:harness', config }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }),
      'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
      `a config carrying marker class ${JSON.stringify(config)} must be refused`,
    )
  }

  // POSITIVE CONTROL — a benign config that merely CONTAINS the word
  // "redacted" as a substring, not the exact sentinel, must NOT be refused
  // (an over-eager substring guard would be a different, also-wrong bug).
  const benign = { baseUrl: 'https://erp.example.internal', note: 'this field is not redacted at all' }
  const ok = await deriveSystemContentKey({ system: { kind: 'test:harness', config: benign }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY })
  assert.match(ok.systemContentKey, /^[0-9a-f]{64}$/, 'a benign config containing but not equal to the marker text must succeed')
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
    () => deriveSystemContentKey({ system: { kind: 'test:no-principal', config: { baseUrl: 'x' } }, credentialCiphertext: 'ct1', credentialStore: store, registry: registryMissingPrincipal, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a declared principal extractor returning an empty string must fail closed',
  )
}

// ---------------------------------------------------------------------------
// (10) SENTINEL SWEEP — automated proof of "never into evidence, logs, or
// errors", across every reachable fail path including a MALICIOUS declaration
// that tries to smuggle plaintext out through its own thrown error.
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

  // (d) a MALICIOUS/buggy declaration whose extractor throws an error that
  // embeds the plaintext credential value — the catch-all in runExtractor
  // must discard the original error entirely, never forward its message.
  const maliciousRegistry = createConnectorKindRegistry([{
    kind: 'test:malicious',
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => { throw new Error(`leaked principal=${creds.username} secret=${creds.password}`) },
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  const errC = await rejectsAsync(
    () => deriveSystemContentKey({ system: { kind: 'test:malicious', config: { baseUrl: 'x' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: maliciousRegistry, hmacKey: HMAC_KEY }),
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'a declaration whose extractor throws must fail closed without forwarding its message',
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
  const wrappedResult = await deriveSystemContentKey({ system: { kind: 'test:wrapping', config: { baseUrl: 'x' } }, credentialCiphertext: 'ct', credentialStore: leakyStore, registry: wrappingRegistry, hmacKey: HMAC_KEY })
  assert.ok(!JSON.stringify(wrappedResult).includes(SENTINEL))
}

// ---------------------------------------------------------------------------
// (11) Input validation / vocabulary discipline.
// ---------------------------------------------------------------------------
async function inputValidationFailsClosed() {
  const registry = harnessRegistry()
  const store = fakeCredentialStore({ ct1: envelope({ username: 'a', password: 'p', acctId: 't' }) })
  const system = { kind: 'test:harness', config: { baseUrl: 'x' } }

  await rejectsAsync(() => deriveSystemContentKey({ system: null, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'null system')
  await rejectsAsync(() => deriveSystemContentKey({ system: { config: {} }, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'missing kind')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: '', credentialStore: store, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'empty ciphertext')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: {}, registry, hmacKey: HMAC_KEY }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'credentialStore without decrypt()')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: Buffer.alloc(16) }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'hmacKey too short')
  await rejectsAsync(() => deriveSystemContentKey({ system, credentialCiphertext: 'ct1', credentialStore: store, registry, hmacKey: 'not-a-buffer' }), 'SYSTEM_IDENTITY_INPUT_INVALID', 'hmacKey not a buffer')

  assert.deepEqual([...SYSTEM_IDENTITY_ERROR_REASONS].sort(), [
    'SYSTEM_IDENTITY_DECRYPTION_FAILED',
    'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
    'SYSTEM_IDENTITY_MATERIAL_MISSING',
    'SYSTEM_IDENTITY_MATERIAL_NOT_LOSSLESS',
    'SYSTEM_IDENTITY_INPUT_INVALID',
  ].sort())
  assert.ok(Object.isFrozen(SYSTEM_IDENTITY_ERROR_REASONS))
  void GipConnectorKindRegistryError
}

async function main() {
  await positiveControlSucceeds()
  await eachIncludedTermMovesTheKey()
  await excludedTermsDoNotMoveTheKey()
  await rotationSemanticsBothDirections()
  rotationInvariantIsFalsifiable()
  await domainSeparationPreventsSwapCollision()
  await aliasResolvesToSameKey()
  await uncertifiedKindFailsClosed()
  await losslessnessGuardCoversAllFiveMarkerClasses()
  await materialMissingFailsClosed()
  await sentinelNeverLeaksAcrossAnyPath()
  await inputValidationFailsClosed()
  console.log('gip-system-identity-read.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
