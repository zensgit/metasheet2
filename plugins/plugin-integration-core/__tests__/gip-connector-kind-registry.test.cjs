'use strict'

// gip-connector-kind-registry.cjs — plain node test, hermetic. Proves: the
// shipped default registry is empty and closed (structurally, not just by
// convention); an unresolved kind fails closed with SYSTEM_IDENTITY_KIND_UNCERTIFIED;
// existing aliases resolve to the SAME declaration explicitly, never a guess;
// a declaration missing any of the three per-kind extractors (endpoint,
// principal, tenant-scope — step 1.2c) is refused at REGISTRATION time; and a
// system whose kind is uncertified for GIP binding still works on its legacy
// (pre-GIP) external-systems.cjs path — the negative control the ledger names
// as the clause an implementer is most likely to break.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createConnectorKindRegistry,
  resolveCertifiedConnectorKind,
  CERTIFIED_CONNECTOR_KIND_REGISTRY,
  GipConnectorKindRegistryError,
  CONNECTOR_KIND_REGISTRY_ERROR_REASONS,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-connector-kind-registry.cjs'))

const {
  createExternalSystemRegistry,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))

function rejects(fn, reason, message) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof GipConnectorKindRegistryError, `${message} — expected GipConnectorKindRegistryError`)
  assert.equal(caught.reason, reason, `${message} — expected reason ${reason}, got ${caught.reason}`)
  return caught
}

function harnessDeclaration(overrides = {}) {
  return {
    kind: 'test:harness',
    aliases: ['legacy:harness'],
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => creds.username,
    extractAuthTenantScope: (creds) => creds.acctId,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// (1) The shipped default registry is EMPTY and CLOSED.
// ---------------------------------------------------------------------------
function defaultRegistryIsEmptyAndClosed() {
  assert.equal(CERTIFIED_CONNECTOR_KIND_REGISTRY.size(), 0, 'shipped registry must be empty — no entries authorized yet')

  // Structural proof of "never auto-extended from customer free strings":
  // the frozen registry object exposes EXACTLY resolve()/size() — no
  // add/register/set verb exists on it at all, under any name. Pinned by
  // EXACT key set (the technique the ledger prescribes for the qualification
  // prober's residual-1 predicate) so a re-addition under any name reds this.
  assert.deepEqual(
    Object.keys(CERTIFIED_CONNECTOR_KIND_REGISTRY).sort(),
    ['resolve', 'size'],
    'registry object must expose exactly resolve()/size() — no mutating verb, under any name',
  )
  assert.ok(Object.isFrozen(CERTIFIED_CONNECTOR_KIND_REGISTRY), 'registry object must be frozen')

  // Any kind at all — including plausible-looking certified names — is
  // uncertified against the empty default registry.
  for (const candidate of ['erp:k3-wise-webapi', 'http:generic', 'anything']) {
    rejects(
      () => resolveCertifiedConnectorKind(CERTIFIED_CONNECTOR_KIND_REGISTRY, candidate),
      'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
      `default registry must refuse "${candidate}"`,
    )
  }
}

// ---------------------------------------------------------------------------
// (2) Positive control (MECHANISM, not trust): a properly declared kind
// resolves and round-trips. createConnectorKindRegistry's output is
// UNTRUSTED (P1-1 fix) — resolve()/size() work identically regardless of
// trust, so declaration/alias mechanics are tested by calling .resolve()
// DIRECTLY on the built object, never through the trust-gated
// resolveCertifiedConnectorKind. Trust-gate behavior itself is proven
// separately below (forgedRegistryViaExportedFactoryIsRefused).
// ---------------------------------------------------------------------------
function positiveControlResolves() {
  const registry = createConnectorKindRegistry([harnessDeclaration()])
  const declaration = registry.resolve('test:harness')
  assert.ok(declaration, 'a properly declared kind must resolve via the object\'s own resolve()')
  assert.equal(declaration.kind, 'test:harness')
  assert.equal(typeof declaration.extractEndpointIdentity, 'function')
  assert.equal(typeof declaration.extractAuthPrincipal, 'function')
  assert.equal(typeof declaration.extractAuthTenantScope, 'function')
}

// ---------------------------------------------------------------------------
// (3) Explicit alias mapping resolves to the SAME declaration as the
// canonical kind — never a guess, never a fuzzy match. MECHANISM-level, via
// .resolve() directly — same rationale as (2) above.
// ---------------------------------------------------------------------------
function explicitAliasResolves() {
  const registry = createConnectorKindRegistry([harnessDeclaration()])
  const byCanonical = registry.resolve('test:harness')
  const byAlias = registry.resolve('legacy:harness')
  assert.equal(byAlias, byCanonical, 'alias must resolve to the identical declaration object, not a re-derived copy')

  // An unmapped near-miss string must NOT silently resolve — aliases are
  // explicit, never fuzzy/prefix/substring matched.
  assert.equal(registry.resolve('legacy:harnes'), null, 'a near-miss alias string must not resolve')
  assert.equal(registry.resolve('LEGACY:HARNESS'), null, 'alias resolution must not case-fold')
}

// ---------------------------------------------------------------------------
// (3b) P1-1 FIX (owner HARD HOLD #4610) — reproduces the owner's EXACT probe:
// registering a kind via the still-exported createConnectorKindRegistry
// factory ("runtime:forged", with an extractor that treats the password as
// the principal — the shape the owner used to show rotating only the secret
// moves systemContentKey) must NOT pass the trust gate. Before this fix,
// createConnectorKindRegistry unconditionally added its output to the
// module-private trust WeakSet, so this exact call sequence returned a
// declaration; now it must be refused as untrusted, never reaching
// SYSTEM_IDENTITY_KIND_UNCERTIFIED (which would mean it passed the trust
// check and merely wasn't found).
// ---------------------------------------------------------------------------
function forgedRegistryViaExportedFactoryIsRefused() {
  const forged = createConnectorKindRegistry([{
    kind: 'runtime:forged',
    aliases: [],
    extractEndpointIdentity: (config) => config.baseUrl,
    extractAuthPrincipal: (creds) => creds.password, // the owner's exact "password as principal" shape
    extractAuthTenantScope: (creds) => creds.acctId,
  }])
  // Mechanically, the forged registry works fine standalone — proving the
  // refusal below is really about TRUST, not a shape defect.
  assert.ok(forged.resolve('runtime:forged'), 'sanity: the forged registry must be well-formed and resolve its own kind via .resolve()')

  const caught = rejects(
    () => resolveCertifiedConnectorKind(forged, 'runtime:forged'),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'a registry built via the exported factory must be refused by the trust gate, exactly like a duck-typed forgery',
  )
  assert.equal(caught.details.field, 'registry')

  // Contrast with the GENUINE trusted singleton: it passes the trust gate
  // (reaches "not found", never "untrusted") — the positive control that
  // proves the gate isn't just refusing everything unconditionally.
  rejects(
    () => resolveCertifiedConnectorKind(CERTIFIED_CONNECTOR_KIND_REGISTRY, 'runtime:forged'),
    'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
    'the genuine trusted singleton must pass the trust gate (fail at lookup, not at trust) — proves the gate discriminates, not merely refuses',
  )
}

// ---------------------------------------------------------------------------
// (4) step 1.2c: a declaration missing ANY of the three per-kind extractors
// is refused at REGISTRATION time, not silently accepted.
// ---------------------------------------------------------------------------
function missingExtractorsRefusedAtRegistration() {
  for (const missingField of ['extractEndpointIdentity', 'extractAuthPrincipal', 'extractAuthTenantScope']) {
    const declaration = harnessDeclaration()
    delete declaration[missingField]
    rejects(
      () => createConnectorKindRegistry([declaration]),
      'CONNECTOR_KIND_DECLARATION_INVALID',
      `registration must refuse a declaration missing ${missingField}`,
    )
  }
  // authTenantScopeKey specifically — step 1.2c's own named requirement —
  // pinned separately so a future edit cannot silently drop just this case
  // while leaving the loop above green by coincidence.
  const missingTenantScope = harnessDeclaration()
  delete missingTenantScope.extractAuthTenantScope
  const caught = rejects(
    () => createConnectorKindRegistry([missingTenantScope]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'a declaration with no authTenantScopeKey source must be refused (step 1.2c)',
  )
  assert.equal(caught.details.field, 'extractAuthTenantScope')
}

// ---------------------------------------------------------------------------
// (5) Structural closure: duplicate kinds, alias/kind collisions, and
// malformed identity tokens are all refused at registration time.
// ---------------------------------------------------------------------------
function malformedDeclarationsRefused() {
  rejects(
    () => createConnectorKindRegistry([harnessDeclaration(), harnessDeclaration()]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'duplicate kind must be refused',
  )
  rejects(
    () => createConnectorKindRegistry([
      harnessDeclaration(),
      harnessDeclaration({ kind: 'test:other', aliases: ['test:harness'] }),
    ]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'an alias colliding with an existing kind must be refused',
  )
  rejects(
    () => createConnectorKindRegistry([harnessDeclaration({ kind: '' })]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'empty kind must be refused',
  )
  rejects(
    () => createConnectorKindRegistry([harnessDeclaration({ kind: `bad\x07kind` })]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'a kind containing a control character must be refused',
  )
  rejects(
    () => createConnectorKindRegistry([harnessDeclaration({ aliases: ['test:harness'] })]),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'an alias equal to its own kind must be refused',
  )
  rejects(
    () => resolveCertifiedConnectorKind({ resolve: () => null, size: () => 0 }, 'anything'),
    'CONNECTOR_KIND_DECLARATION_INVALID',
    'a duck-typed non-trusted object must be refused regardless of matching shape',
  )
}

// ---------------------------------------------------------------------------
// (5b) P3 FIX (owner HARD HOLD #4610 residual, round 6): a hostile GETTER on
// any declaration property read inside normalizeDeclaration must never
// escape this module as a raw foreign error — it must be discarded and
// replaced with GipConnectorKindRegistryError, the SAME contract every other
// reachable throw in this module already honors. Covers all five direct
// `entry.*` reads normalizeDeclaration performs (kind, aliases, and the
// three extractors) — not just the three extractor properties, since the
// same unguarded-read shape applied identically to kind/aliases.
// ---------------------------------------------------------------------------
function hostileGetterOnDeclarationFieldNeverEscapesRaw() {
  for (const field of ['kind', 'aliases', 'extractEndpointIdentity', 'extractAuthPrincipal', 'extractAuthTenantScope']) {
    const hostile = harnessDeclaration()
    delete hostile[field]
    Object.defineProperty(hostile, field, {
      enumerable: true,
      configurable: true,
      get() { throw new TypeError(`hostile getter for ${field} — must never escape raw`) },
    })
    const caught = rejects(
      () => createConnectorKindRegistry([hostile]),
      'CONNECTOR_KIND_DECLARATION_INVALID',
      `a hostile getter on ${field} must be discarded and converted to GipConnectorKindRegistryError, never escape as a raw foreign error`,
    )
    assert.equal(caught.details.field, field)
  }
}

// ---------------------------------------------------------------------------
// (6) NEGATIVE CONTROL — the clause the ledger names as most likely to break:
// a system whose kind is uncertified for GIP binding must still work,
// unaffected, on its pre-GIP external-systems.cjs (legacy) path.
// ---------------------------------------------------------------------------
function createMockCredentialStore() {
  return {
    async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value) { return `fp_${Buffer.from(value).toString('hex').slice(0, 12)}` },
  }
}

function createMockDb() {
  const rows = []
  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  return {
    async selectOne(_table, where) { return rows.find((row) => matchesWhere(row, where)) || null },
    async insertOne(_table, row) {
      const stored = { ...row, created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z' }
      rows.push(stored)
      return [stored]
    },
    async updateRow(_table, set, where) {
      const row = rows.find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set)
      return [row]
    },
    async select(_table, options = {}) {
      const filtered = rows.filter((row) => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async countRows() { return 0 },
    async deleteRows() { return [] },
  }
}

async function legacyPathKeepsWorkingWhileGipBindingRefuses() {
  const registry = createExternalSystemRegistry({ db: createMockDb(), credentialStore: createMockCredentialStore() })

  // "demo:uncertified" is not, and will never be, in the empty shipped
  // registry — this is the whole point of the test.
  const created = await registry.upsertExternalSystem({
    tenantId: 'tenant-1',
    name: 'Legacy Demo System',
    kind: 'demo:uncertified',
    config: { baseUrl: 'https://legacy.example.internal' },
  })
  assert.equal(created.kind, 'demo:uncertified', 'legacy create path must succeed for an uncertified kind')

  const fetched = await registry.getExternalSystem({ tenantId: 'tenant-1', id: created.id })
  assert.equal(fetched.id, created.id, 'legacy read path must succeed for an uncertified kind')

  // The SAME kind, on the GIP binding path, is refused — closed, by name.
  rejects(
    () => resolveCertifiedConnectorKind(CERTIFIED_CONNECTOR_KIND_REGISTRY, created.kind),
    'SYSTEM_IDENTITY_KIND_UNCERTIFIED',
    'GIP binding must refuse the very kind the legacy path just proved works',
  )
}

// ---------------------------------------------------------------------------
// (7) P2 FIX (review round 4 — blocking): __internals's own key set was never
// pinned in this file. gip-system-identity-read.test.cjs's exactPublicExportKeySet
// already pins __internals's key set for its own module (round 3's P2 fix) —
// this module and gip-canonical-object-contract-registry.cjs were the two
// files that fix was never mirrored into, so a junk key added under this
// module's __internals, or — decisively — RE-EXPORTING this module's private
// module-scope trust WeakSet through __internals (the exact regression the
// module's own header comment says is closed by staying unexported) both
// passed silently before this test existed. Pinning the exact key set
// catches both: any addition under __internals, under any name, reds this
// deepEqual. (Deliberately not naming the private WeakSet's identifier in
// this comment or a fixture — doing so would itself add a hit to a
// `grep -rn` over __tests__ that this PR's body cites as returning zero.)
// ---------------------------------------------------------------------------
function internalsExactKeySet() {
  assert.deepEqual(
    Object.keys(__internals).sort(),
    ['fail', 'normalizeDeclaration', 'requiredIdentityToken'],
    '__internals must expose exactly this key set — in particular, the module-private trust WeakSet must never be re-exported under any name',
  )
}

// ---------------------------------------------------------------------------
// (8) Vocabulary discipline: fail() may never throw an undeclared reason —
// the same three-layer pin used elsewhere on this line (exact array + a
// runtime consumer that enforces membership).
// ---------------------------------------------------------------------------
function frozenVocabularyIsExhaustive() {
  assert.deepEqual(
    [...CONNECTOR_KIND_REGISTRY_ERROR_REASONS].sort(),
    ['CONNECTOR_KIND_DECLARATION_INVALID', 'SYSTEM_IDENTITY_KIND_UNCERTIFIED'],
  )
  assert.ok(Object.isFrozen(CONNECTOR_KIND_REGISTRY_ERROR_REASONS))
}

async function main() {
  defaultRegistryIsEmptyAndClosed()
  positiveControlResolves()
  explicitAliasResolves()
  forgedRegistryViaExportedFactoryIsRefused()
  missingExtractorsRefusedAtRegistration()
  hostileGetterOnDeclarationFieldNeverEscapesRaw()
  malformedDeclarationsRefused()
  await legacyPathKeepsWorkingWhileGipBindingRefuses()
  internalsExactKeySet()
  frozenVocabularyIsExhaustive()
  console.log('gip-connector-kind-registry.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
