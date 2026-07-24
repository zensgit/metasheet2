'use strict'

// GIP-D0 / B1a — approved-binding resolver battery. Plain node test, hermetic (no network,
// no real database: an in-memory db double drives the REAL read-source config store and the
// REAL external-system registry, so approval, tenant/workspace scoping and the content-key
// column are proven through production code paths rather than through a mock's opinion).
//
// Proves: the six-field tuple is DERIVED (never caller-supplied), approval + scope are
// re-verified on every resolution, the stored content-key column is distrusted and
// recomputed, the R6 ordering-key schema is closed rule-by-rule, the resolution is
// deep-immutable across a REAL async window, and trust is unforgeable object identity.
// AND (B1a D2.1, the fix for a proven forgery): the SYSTEM identity is derived from the
// registry's UNSANITIZED read, so repointing a system — in place, through the production
// upsertExternalSystem path — invalidates qualifications taken against the old one in every
// reported collision class (§5b), a lossy projection is refused rather than hashed (§5b
// rules, driven by the REAL sanitizer), and every identity field is separately OBSERVABLE
// so "it feeds a hash" is never mistaken for "it is guarded" (§5c).

const assert = require('node:assert/strict')
const path = require('node:path')

const resolverModule = require(path.join(__dirname, '..', 'lib', 'gip-approved-binding-resolver.cjs'))
const {
  BINDING_RESOLUTION_ERROR_REASONS,
  BINDING_RESOLUTION_FIELDS,
  ORDERING_KEY_SPEC_RULES,
  SYSTEM_IDENTITY_SOURCE_RULES,
  ORDERING_KEY_DIRECTIONS,
  GipBindingResolutionError,
  createApprovedBindingResolver,
  assertTrustedBindingResolution,
  isTrustedBindingResolution,
  __internals: resolverInternals,
} = resolverModule

const {
  createReadSourceConfigStore,
  __internals: storeInternals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))
const { createExternalSystemRegistry } = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))
const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const { deepCloneFrozenCanonical } = require(path.join(__dirname, '..', 'lib', 'gip-canonical-json.cjs'))
// The REAL sanitizer, so the D2.1 lossless guard is proven against the transform it exists to
// detect — never against a test-local imitation of it (which could not drift-red).
const { sanitizeIntegrationPayload } = require(path.join(__dirname, '..', 'lib', 'payload-redaction.cjs'))

const { contentKeyFor } = storeInternals

const CONFIG_TABLE = 'integration_read_source_configs'
const SYSTEM_TABLE = 'integration_external_systems'

// ── In-memory db double (the ONLY double under the real store/registry) ────────────────
function createMemoryDb() {
  const tables = new Map()
  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }
  const matches = (row, where) => Object.keys(where || {}).every((key) => (row[key] ?? null) === (where[key] ?? null))
  const db = {
    seed(table, row) {
      rowsOf(table).push(row)
      return row
    },
    async selectOne(table, where) {
      return rowsOf(table).find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      rowsOf(table).push(row)
      return [row]
    },
    // (table, SET, WHERE) — the production signature (lib/db.cjs updateRow(table, set, where)).
    // Getting this order right is what lets the suite drive the REAL upsertExternalSystem
    // write path when it repoints a system in place (§5b).
    async updateRow(table, set, where) {
      const row = rowsOf(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set)
      return [row]
    },
    async select(table, options = {}) {
      const filtered = rowsOf(table).filter((row) => matches(row, options.where || {}))
      return typeof options.limit === 'number' ? filtered.slice(0, options.limit) : filtered
    },
    async deleteRows(table, where) {
      const kept = rowsOf(table).filter((row) => !matches(row, where))
      tables.set(table, kept)
      return []
    },
    async countRows() {
      return 0
    },
    async transaction(fn) {
      return fn(db)
    },
  }
  return db
}

const credentialStoreDouble = {
  async encrypt(value) { return value },
  async decrypt(value) { return value },
  async fingerprint() { return null },
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
const TENANT = 'tenant-alpha'
const WORKSPACE = 'ws-bom'
const CONFIG_ID = 'cfg-approved-1'
const SYSTEM_ID = 'k3-erp'
const OBJECT_KEY = 'v_bom_lines'
const PROFILE_VERSION = 'bridge.bounded_read.v2'

const VALID_ORDERING_KEY_SPEC = [
  { fieldId: 'material_code', direction: 'ASC' },
  { fieldId: 'qty', direction: 'DESC' },
]

// The base body is a REAL read-source config shape (asserted valid by the production
// validator in knownConfigAllowlistGap() below, once the two B1a keys are removed).
function baseConfigBody(overrides = {}) {
  return {
    version: 3,
    systemId: SYSTEM_ID,
    requiredKind: 'k3wise',
    object: OBJECT_KEY,
    mode: 'list_page',
    readPath: '/api/read/bom',
    readMethod: 'GET',
    operations: ['read'],
    containerPaths: ['Data.Rows'],
    fieldMap: [
      { source: 'FNumber', target: 'material_code' },
      { source: 'Data.FQty', target: 'qty' },
    ],
    // B1a D1: bound by APPROVAL, inside the immutable body — never run input.
    actionProfileVersion: PROFILE_VERSION,
    orderingKeySpec: JSON.parse(JSON.stringify(VALID_ORDERING_KEY_SPEC)),
    ...overrides,
  }
}

function systemRow(overrides = {}) {
  return {
    id: SYSTEM_ID,
    tenant_id: TENANT,
    workspace_id: WORKSPACE,
    project_id: null,
    name: 'K3 WISE production',
    kind: 'k3wise',
    role: 'source',
    config: { baseUrl: 'https://erp.internal.example/api' },
    capabilities: {},
    status: 'active',
    credentials_encrypted: null,
    last_tested_at: null,
    last_error: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

// Build a world: real store + real registry over the in-memory db, with a directly-seeded
// approved row. Direct seeding is REQUIRED, not convenience: the production save-time
// validator's key allowlist does not yet accept `orderingKeySpec` / `actionProfileVersion`
// (B1a D1 known gap — asserted behaviourally in knownConfigAllowlistGap()).
function makeWorld(options = {}) {
  const db = createMemoryDb()
  const body = options.body || baseConfigBody()
  const storedContentKey = options.storedContentKey !== undefined ? options.storedContentKey : contentKeyFor(body)
  db.seed(CONFIG_TABLE, {
    id: options.configId || CONFIG_ID,
    tenant_id: options.tenantId || TENANT,
    workspace_id: options.workspaceId === undefined ? WORKSPACE : options.workspaceId,
    system_id: options.rowSystemId !== undefined ? options.rowSystemId : body.systemId,
    object: options.rowObject !== undefined ? options.rowObject : body.object,
    mode: body.mode,
    config: body,
    content_key: storedContentKey,
    version: body.version,
    status: options.status || 'approved',
    created_by: null,
    updated_by: null,
    created_at: null,
    updated_at: null,
  })
  db.seed(SYSTEM_TABLE, systemRow(options.system || {}))
  const store = createReadSourceConfigStore({ db, idGenerator: () => 'generated-id' })
  const registry = createExternalSystemRegistry({ db, credentialStore: credentialStoreDouble })
  const resolver = createApprovedBindingResolver({ configStore: store, systemRegistry: registry })
  return {
    db,
    body,
    store,
    registry,
    resolver,
    scopeInput: {
      tenantId: options.tenantId || TENANT,
      workspaceId: options.workspaceId === undefined ? WORKSPACE : options.workspaceId,
      approvedConfigVersionId: options.configId || CONFIG_ID,
    },
  }
}

async function refusedWith(run, expected, label) {
  let error = null
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${label} — must be REFUSED, nothing was thrown`)
  assert.ok(
    error instanceof GipBindingResolutionError,
    `${label} — must fail with the resolver's closed error type (got ${error && error.name}: ${error && error.message})`,
  )
  assert.equal(error.reason, expected.reason, `${label} — closed reason must be ${expected.reason} (got ${error.reason})`)
  if (expected.rule) {
    assert.equal(
      error.details && error.details.rule,
      expected.rule,
      `${label} — rule token must be ${expected.rule} (got ${error.details && error.details.rule})`,
    )
  }
  return error
}

// POSITIVE CONTROL used everywhere a refusal is asserted: an untouched world resolves.
async function resolvesCleanly(label, options = {}) {
  const world = makeWorld(options)
  const resolution = await world.resolver.resolveApprovedBinding(world.scopeInput)
  assert.ok(resolution, `${label} — positive control: an untouched approved binding MUST resolve`)
  assert.equal(resolution.objectKey, OBJECT_KEY, `${label} — positive control: the resolved objectKey must be the approved object`)
  return resolution
}

// ── 1. Frozen vocabularies (exact pins; subset AND superset must red) ──────────────────
function frozenVocabularies() {
  assert.deepEqual(BINDING_RESOLUTION_ERROR_REASONS, [
    'RESOLVER_DEPENDENCY_INVALID',
    'RESOLVER_INPUT_INVALID',
    'APPROVED_VERSION_UNRESOLVABLE',
    'APPROVED_ROW_BODY_DIVERGENT',
    'APPROVED_BODY_FIELD_MAP_INVALID',
    'CONFIG_CONTENT_KEY_MISMATCH',
    'SYSTEM_RECORD_UNRESOLVABLE',
    'SYSTEM_IDENTITY_NOT_LOSSLESS',
    'ACTION_PROFILE_VERSION_INVALID',
    'ORDERING_KEY_SPEC_INVALID',
    'RESOLUTION_DOMAIN_INVALID',
    'RESOLUTION_NOT_TRUSTED',
  ], 'the frozen error vocabulary must match its pin exactly (a change must update both in one commit)')
  assert.deepEqual(SYSTEM_IDENTITY_SOURCE_RULES, [
    'SYSTEM_IDENTITY_CONFIG_SHAPE',
    'SYSTEM_IDENTITY_CONFIG_TOO_DEEP',
    'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE',
    'SYSTEM_IDENTITY_REDACTION_MARKER',
    'SYSTEM_IDENTITY_UNPROJECTABLE_KEY',
    'SYSTEM_IDENTITY_CREDENTIAL_MATERIAL',
  ], 'the frozen system-identity rule vocabulary must match its pin exactly')
  assert.deepEqual(ORDERING_KEY_SPEC_RULES, [
    'ORDERING_KEY_SPEC_SHAPE',
    'ORDERING_KEY_SPEC_EMPTY',
    'ORDERING_KEY_ENTRY_SHAPE',
    'ORDERING_KEY_FIELD_ID_NOT_CANONICAL',
    'ORDERING_KEY_FIELD_ID_DUPLICATE',
    'ORDERING_KEY_DIRECTION_INVALID',
    'ORDERING_KEY_FIELD_ID_UNRESOLVED',
  ], 'the frozen ordering-key rule vocabulary must match its pin exactly')
  assert.deepEqual(ORDERING_KEY_DIRECTIONS, ['ASC', 'DESC'], 'R6 direction vocabulary is exactly ASC/DESC (strict case)')
  assert.deepEqual(BINDING_RESOLUTION_FIELDS, [
    'actionProfileVersion',
    'systemContentKey',
    'configContentKey',
    'objectKey',
    'canonicalObjectVersion',
    'orderingKeySpec',
  ], 'the closed six-field tuple must match its pin exactly')
  for (const frozen of [BINDING_RESOLUTION_ERROR_REASONS, ORDERING_KEY_SPEC_RULES, SYSTEM_IDENTITY_SOURCE_RULES, ORDERING_KEY_DIRECTIONS, BINDING_RESOLUTION_FIELDS]) {
    assert.ok(Object.isFrozen(frozen), 'every exported vocabulary must be frozen')
  }
  // POSITIVE CONTROL for the vocabulary guard itself: a declared reason still throws the
  // closed error type, an undeclared one is a coarse internal error (never echoed).
  assert.throws(
    () => resolverInternals.fail('RESOLVER_INPUT_INVALID', 'declared reason', {}),
    (error) => error instanceof GipBindingResolutionError && error.reason === 'RESOLVER_INPUT_INVALID',
    'a DECLARED reason must produce the closed error type',
  )
  assert.throws(
    () => resolverInternals.fail('NOT_A_DECLARED_REASON', 'x', {}),
    (error) => !(error instanceof GipBindingResolutionError) && !/NOT_A_DECLARED_REASON/.test(error.message),
    'an UNDECLARED reason must fail as a coarse internal error that does not echo the reason',
  )
}

// ── 2. Happy path + derivation determinism (D2/D3) ────────────────────────────────────
async function derivedTuple() {
  const world = makeWorld()
  const resolution = await world.resolver.resolveApprovedBinding(world.scopeInput)

  assert.deepEqual(
    Object.keys(resolution).sort(),
    [...BINDING_RESOLUTION_FIELDS].sort(),
    'a resolution carries EXACTLY the closed six-field tuple — no more, no less',
  )
  assert.equal(resolution.actionProfileVersion, PROFILE_VERSION, 'actionProfileVersion comes from the immutable approved body')
  assert.equal(resolution.objectKey, OBJECT_KEY, 'objectKey comes from the approved row')
  assert.equal(resolution.configContentKey, contentKeyFor(world.body), 'configContentKey is the SERVER-recomputed key of the immutable body')
  assert.match(resolution.systemContentKey, /^sck1:[0-9a-f]{64}$/, 'systemContentKey is a scheme-tagged sha256 (B1a D2)')
  assert.match(resolution.canonicalObjectVersion, /^cov1:[0-9a-f]{64}$/, 'canonicalObjectVersion is a scheme-tagged sha256 (B1a D3)')
  assert.deepEqual(resolution.orderingKeySpec, VALID_ORDERING_KEY_SPEC, 'orderingKeySpec comes from the immutable approved body')

  // Determinism: a second resolution of the same approved version is value-identical…
  const again = await world.resolver.resolveApprovedBinding(world.scopeInput)
  assert.deepEqual(again, resolution, 'resolving the same approved version twice must be value-identical')
  // …but a DIFFERENT OBJECT (each resolution is its own owned clone).
  assert.notEqual(again, resolution, 'each resolution is its own owned clone, never a shared singleton')

  // D2 INCLUSION: repointing the system's connection identity changes systemContentKey.
  const repointed = makeWorld({ system: { config: { baseUrl: 'https://attacker.example/api' } } })
  const repointedResolution = await repointed.resolver.resolveApprovedBinding(repointed.scopeInput)
  assert.notEqual(
    repointedResolution.systemContentKey,
    resolution.systemContentKey,
    'D2: repointing the system config MUST change systemContentKey (old qualifications must not carry over)',
  )
  assert.equal(repointedResolution.configContentKey, resolution.configContentKey, 'the config body did not change, so configContentKey must not')

  // D2 EXCLUSIONS are real, not aspirational: mutable/operational fields do not churn the key.
  const relabelled = makeWorld({ system: { name: 'renamed system', capabilities: { pagination: 'none' }, last_tested_at: '2026-07-24T00:00:00Z' } })
  const relabelledResolution = await relabelled.resolver.resolveApprovedBinding(relabelled.scopeInput)
  assert.equal(
    relabelledResolution.systemContentKey,
    resolution.systemContentKey,
    'D2: name/capabilities/lastTestedAt are excluded from systemContentKey by design',
  )

  // D3 ORDER SENSITIVITY: the field projection is a sequence of writes, so order matters.
  const swapped = makeWorld({
    body: baseConfigBody({
      fieldMap: [
        { source: 'Data.FQty', target: 'qty' },
        { source: 'FNumber', target: 'material_code' },
      ],
    }),
  })
  const swappedResolution = await swapped.resolver.resolveApprovedBinding(swapped.scopeInput)
  assert.notEqual(
    swappedResolution.canonicalObjectVersion,
    resolution.canonicalObjectVersion,
    'D3: the field projection is ORDER-SENSITIVE',
  )

  // D3 SEPARATION: an ordering-only change moves configContentKey, not canonicalObjectVersion.
  const reordered = makeWorld({
    body: baseConfigBody({ orderingKeySpec: [{ fieldId: 'qty', direction: 'ASC' }] }),
  })
  const reorderedResolution = await reordered.resolver.resolveApprovedBinding(reordered.scopeInput)
  assert.equal(
    reorderedResolution.canonicalObjectVersion,
    resolution.canonicalObjectVersion,
    'D3: canonicalObjectVersion describes the OBJECT shape, not the ordering key',
  )
  assert.notEqual(
    reorderedResolution.configContentKey,
    resolution.configContentKey,
    'the ordering key is bound by configContentKey — this is what makes orderingKeySpec digest-bound indirectly',
  )
}

// ── 3. Approval + tenant/workspace scope: PAIRED fixtures ─────────────────────────────
async function approvalAndScope() {
  // Not approved: same row, only the status differs.
  for (const status of ['draft', 'retired']) {
    const world = makeWorld({ status })
    await refusedWith(
      () => world.resolver.resolveApprovedBinding(world.scopeInput),
      { reason: 'APPROVED_VERSION_UNRESOLVABLE' },
      `a ${status} version must never resolve (approval is re-verified, never assumed from an id)`,
    )
  }
  await resolvesCleanly('approval', { status: 'approved' })

  // Wrong tenant: the SAME row id, asked for as another tenant.
  const world = makeWorld()
  await refusedWith(
    () => world.resolver.resolveApprovedBinding({ ...world.scopeInput, tenantId: 'tenant-beta' }),
    { reason: 'APPROVED_VERSION_UNRESOLVABLE' },
    'a cross-tenant read of the same config id must be refused (store tenant scoping)',
  )
  // Wrong workspace: same tenant, same id, another workspace.
  await refusedWith(
    () => world.resolver.resolveApprovedBinding({ ...world.scopeInput, workspaceId: 'ws-other' }),
    { reason: 'APPROVED_VERSION_UNRESOLVABLE' },
    'a cross-workspace read of the same config id must be refused (store workspace scoping)',
  )
  // POSITIVE CONTROL: the in-scope read of that very row resolves.
  const inScope = await world.resolver.resolveApprovedBinding(world.scopeInput)
  assert.ok(inScope, 'positive control: the same row in its own tenant+workspace must resolve')

  // A store that RETURNS a non-approved row instead of throwing (a decorating store, a
  // cache, a future store variant) must not slip through: approval is re-checked on the
  // returned row, not merely delegated.
  const publicRowFor = (status) => ({
    id: CONFIG_ID,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    systemId: SYSTEM_ID,
    object: OBJECT_KEY,
    mode: 'list_page',
    config: baseConfigBody(),
    contentKey: contentKeyFor(baseConfigBody()),
    version: 3,
    status,
  })
  const nonThrowingStore = (status) => ({ async getForRuntime() { return publicRowFor(status) } })
  const permissive = createApprovedBindingResolver({ configStore: nonThrowingStore('draft'), systemRegistry: world.registry })
  await refusedWith(
    () => permissive.resolveApprovedBinding(world.scopeInput),
    { reason: 'APPROVED_VERSION_UNRESOLVABLE' },
    'a store that RETURNS a draft row instead of throwing must still be refused',
  )
  // POSITIVE CONTROL: the same double with an approved row resolves (the double works).
  const permissiveApproved = createApprovedBindingResolver({ configStore: nonThrowingStore('approved'), systemRegistry: world.registry })
  assert.ok(
    await permissiveApproved.resolveApprovedBinding(world.scopeInput),
    'positive control: the same store double with an APPROVED row must resolve',
  )

  // A workspace-less (tenant-level) config resolves when its system is tenant-level too —
  // proving `workspaceId` is genuinely optional and not silently defaulted.
  const tenantLevel = makeWorld({ workspaceId: null, system: { workspace_id: null } })
  const tenantLevelResolution = await tenantLevel.resolver.resolveApprovedBinding({
    tenantId: TENANT,
    approvedConfigVersionId: CONFIG_ID,
  })
  assert.ok(tenantLevelResolution, 'an absent workspaceId must scope to the tenant-level row, matching the store')
}

// ── 4. Stored-column distrust ─────────────────────────────────────────────────────────
async function storedColumnDistrust() {
  // The mismatch fixture differs from the keyed body ONLY in orderingKeySpec — so this one
  // case proves BOTH the recompute guard AND the claim that orderingKeySpec (which is not
  // digest material) is bound through configContentKey.
  const keyedBody = baseConfigBody()
  const servedBody = baseConfigBody({ orderingKeySpec: [{ fieldId: 'qty', direction: 'ASC' }] })
  assert.notEqual(contentKeyFor(keyedBody), contentKeyFor(servedBody), 'fixture sanity: the two bodies must differ in content key')
  const tampered = makeWorld({ body: servedBody, storedContentKey: contentKeyFor(keyedBody) })
  await refusedWith(
    () => tampered.resolver.resolveApprovedBinding(tampered.scopeInput),
    { reason: 'CONFIG_CONTENT_KEY_MISMATCH' },
    'a stored content key that does not match the served body must be refused (the column is never trusted)',
  )
  // POSITIVE CONTROL: the same served body with its OWN key resolves.
  const honest = makeWorld({ body: servedBody, storedContentKey: contentKeyFor(servedBody) })
  const honestResolution = await honest.resolver.resolveApprovedBinding(honest.scopeInput)
  assert.deepEqual(honestResolution.orderingKeySpec, [{ fieldId: 'qty', direction: 'ASC' }], 'positive control: a correctly keyed body resolves')

  // WHAT THE CONFIG-PLANE GATE ACTUALLY COMPARES (review lens 2) — the store's only exported
  // reads return sanitizeIntegrationPayload(row.config), while `content_key` was written over
  // the RAW row. So the gate is recompute(PROJECTION) === write-time-key(RAW): the write-time
  // key is a LOSSLESS WITNESS, and any lossy projection is DETECTED rather than hashed. This
  // is the asymmetry the system plane lacked (see §5b). Pinned at the sanitizer's own array
  // boundary, both sides, so neither the claim nor the accepted operational limit can rot.
  const fieldMapOfSize = (size) => {
    const fieldMap = []
    for (let index = 0; index < size; index += 1) fieldMap.push({ source: `F${index}`, target: `col_${index}` })
    return fieldMap
  }
  const bodyOfSize = (size) => baseConfigBody({
    fieldMap: fieldMapOfSize(size),
    orderingKeySpec: [{ fieldId: 'col_0', direction: 'ASC' }],
  })
  const atBoundary = makeWorld({ body: bodyOfSize(50) })
  const atBoundaryResolution = await atBoundary.resolver.resolveApprovedBinding(atBoundary.scopeInput)
  assert.equal(
    atBoundaryResolution.configContentKey,
    contentKeyFor(bodyOfSize(50)),
    'a 50-entry fieldMap is INSIDE the sanitizer\'s array limit: the projection is identity and the gate passes',
  )
  await refusedWith(
    () => {
      const past = makeWorld({ body: bodyOfSize(51) })
      return past.resolver.resolveApprovedBinding(past.scopeInput)
    },
    { reason: 'CONFIG_CONTENT_KEY_MISMATCH' },
    'a 51-entry fieldMap is TRUNCATED by the read projection and must FAIL CLOSED — a body the sanitizer changes is unbindable today, never silently hashed as its projection',
  )

  // Denormalized column divergence (object, then systemId).
  const divergentObject = makeWorld({ rowObject: 'v_other_view' })
  await refusedWith(
    () => divergentObject.resolver.resolveApprovedBinding(divergentObject.scopeInput),
    { reason: 'APPROVED_ROW_BODY_DIVERGENT' },
    'an object column that diverges from the immutable body must be refused',
  )
  const divergentSystem = makeWorld({ rowSystemId: 'other-erp' })
  await refusedWith(
    () => divergentSystem.resolver.resolveApprovedBinding(divergentSystem.scopeInput),
    { reason: 'APPROVED_ROW_BODY_DIVERGENT' },
    'a system_id column that diverges from the immutable body must be refused',
  )
  await resolvesCleanly('stored-column distrust')

  // A body whose action profile version is missing/invalid never resolves.
  for (const actionProfileVersion of [undefined, '', 'BRIDGE.Bounded_Read.v2', 'bridge.bounded_read', 'x'.repeat(200)]) {
    const world = makeWorld({ body: baseConfigBody({ actionProfileVersion }) })
    await refusedWith(
      () => world.resolver.resolveApprovedBinding(world.scopeInput),
      { reason: 'ACTION_PROFILE_VERSION_INVALID' },
      'the approved body must declare a valid action profile version (D1)',
    )
  }
  await resolvesCleanly('action profile version')

  // A malformed field map is a closed rejection, never a coerced projection.
  for (const fieldMap of [
    'FNumber',
    [{ source: 'FNumber' }],
    [{ source: 'FNumber', target: 'material_code', transform: 'upper' }],
    [{ source: 'FNumber', target: 42 }],
  ]) {
    const world = makeWorld({ body: baseConfigBody({ fieldMap }) })
    await refusedWith(
      () => world.resolver.resolveApprovedBinding(world.scopeInput),
      { reason: 'APPROVED_BODY_FIELD_MAP_INVALID' },
      'a malformed field map must be refused (the projection feeds canonicalObjectVersion)',
    )
  }
  await resolvesCleanly('field map')
}

// ── 5. System-record admission (D4) ───────────────────────────────────────────────────
async function systemAdmission() {
  for (const status of ['inactive', 'error']) {
    const world = makeWorld({ system: { status } })
    await refusedWith(
      () => world.resolver.resolveApprovedBinding(world.scopeInput),
      { reason: 'SYSTEM_RECORD_UNRESOLVABLE' },
      `a ${status} system must not be bindable (D4 admission gate)`,
    )
  }
  const target = makeWorld({ system: { role: 'target' } })
  await refusedWith(
    () => target.resolver.resolveApprovedBinding(target.scopeInput),
    { reason: 'SYSTEM_RECORD_UNRESOLVABLE' },
    'a write-only target system must not back a READ binding (D4 read-capable role)',
  )
  // POSITIVE CONTROLS: active source, and the other read-capable role.
  await resolvesCleanly('system admission (source)')
  await resolvesCleanly('system admission (bidirectional)', { system: { role: 'bidirectional' } })

  // Scope: the system is resolved in the SAME tenant+workspace as the approved config.
  const otherWorkspace = makeWorld({ system: { workspace_id: 'ws-elsewhere' } })
  await refusedWith(
    () => otherWorkspace.resolver.resolveApprovedBinding(otherWorkspace.scopeInput),
    { reason: 'SYSTEM_RECORD_UNRESOLVABLE' },
    'a system outside the approved config\'s own scope must not be bindable (D4 — no silent widening)',
  )
  const otherTenant = makeWorld({ system: { tenant_id: 'tenant-beta' } })
  await refusedWith(
    () => otherTenant.resolver.resolveApprovedBinding(otherTenant.scopeInput),
    { reason: 'SYSTEM_RECORD_UNRESOLVABLE' },
    'a system belonging to another tenant must not be bindable',
  )

  // THE ACCEPTED COST OF THE LOSSLESS READ (D2.1), asserted rather than only documented: it
  // decrypts credentials, so a credential store that fails makes an otherwise-valid system
  // UNBINDABLE. That is FAIL-CLOSED — never a silent fallback to the sanitized read.
  const credentialed = makeWorld({ system: { credentials_encrypted: 'enc:svc-account-secret' } })
  const brokenRegistry = createExternalSystemRegistry({
    db: credentialed.db,
    credentialStore: { ...credentialStoreDouble, async decrypt() { throw new Error('credential store unavailable') } },
  })
  await refusedWith(
    () => createApprovedBindingResolver({ configStore: credentialed.store, systemRegistry: brokenRegistry })
      .resolveApprovedBinding(credentialed.scopeInput),
    { reason: 'SYSTEM_RECORD_UNRESOLVABLE' },
    'a credential store failure must fail the resolution CLOSED (the accepted cost of reading identity through the unsanitized path)',
  )
  // POSITIVE CONTROL: the same system with a working credential store resolves.
  assert.ok(
    await credentialed.resolver.resolveApprovedBinding(credentialed.scopeInput),
    'positive control: the same credentialed system resolves through a working credential store',
  )
}

// ── 5b. D2.1 — A LOSSY PROJECTION MAY NEVER BACK A SYSTEM IDENTITY ────────────────────
// THE P1 THIS SECTION EXISTS FOR, verbatim: systemContentKey used to hash the registry's
// PUBLIC record — sanitizeIntegrationPayload(row.config) — so two systems differing only
// inside a redacted or truncated region hashed IDENTICALLY. A qualification minted against a
// production ERP still verified `verified: true` after that same system was repointed at
// attacker.example through the production upsertExternalSystem path. FIVE classes: two
// key-name-dependent (`connectionString`, `jdbcUrl`) and three key-name-INDEPENDENT
// (depth > 6, array item > 50, string char > 2000) — which is why no allowlist of "safe"
// config keys could have closed it. canonicalObjectVersion is derived FROM systemContentKey,
// so both system-identity fields of the six-field tuple collapsed together; every case below
// therefore asserts BOTH.

const REPOINT_CLASSES = [
  {
    label: 'baseUrl — a NON-sensitive key (the control that always discriminated)',
    control: true,
    from: { baseUrl: 'https://erp-prod.internal/api' },
    to: { baseUrl: 'https://attacker.example/api' },
  },
  {
    label: 'connectionString — a REDACTED key name (MySQL/MSSQL endpoint)',
    from: { connectionString: 'Server=erp-prod.internal;Database=bom;User Id=svc' },
    to: { connectionString: 'Server=attacker.example;Database=bom;User Id=svc' },
  },
  {
    label: 'jdbcUrl — a REDACTED key name',
    from: { jdbcUrl: 'jdbc:mysql://erp-prod.internal:3306/bom' },
    to: { jdbcUrl: 'jdbc:mysql://attacker.example:3306/bom' },
  },
  {
    label: 'nesting below sanitize maxDepth=6 — KEY-NAME INDEPENDENT',
    from: { profile: nestConfig(6, { host: 'erp-prod.internal' }) },
    to: { profile: nestConfig(6, { host: 'attacker.example' }) },
  },
  {
    label: 'past sanitize maxArrayItems=50 — KEY-NAME INDEPENDENT',
    from: { endpoints: [...Array(50).fill('pad'), 'https://erp-prod.internal/api'] },
    to: { endpoints: [...Array(50).fill('pad'), 'https://attacker.example/api'] },
  },
  {
    label: 'past sanitize maxStringLength=2000 — KEY-NAME INDEPENDENT',
    from: { note: `${'x'.repeat(2000)}host=erp-prod.internal` },
    to: { note: `${'x'.repeat(2000)}host=attacker.example` },
  },
]

function nestConfig(depth, leaf) {
  let node = leaf
  for (let index = 0; index < depth; index += 1) node = { n: node }
  return node
}

const REPOINT_EVIDENCE = {
  probeKind: 'ordering_key_total_order_negative',
  checkedKeyColumnCount: 2,
  duplicateGroupsFound: 0,
  nullKeyRowsFound: 0,
}

function digestOfResolution(resolution) {
  const { computeQualificationDigest } = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
  return computeQualificationDigest({
    actionProfileVersion: resolution.actionProfileVersion,
    systemContentKey: resolution.systemContentKey,
    configContentKey: resolution.configContentKey,
    objectKey: resolution.objectKey,
    canonicalObjectVersion: resolution.canonicalObjectVersion,
    evidence: REPOINT_EVIDENCE,
  })
}

// Repoint IN PLACE through the PRODUCTION write path — same tenant, same workspace, same id,
// exactly the operation an operator (or an attacker with console access) performs.
async function repointSystemInPlace(world, config) {
  return world.registry.upsertExternalSystem({
    id: SYSTEM_ID,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    name: 'K3 WISE production',
    kind: 'k3wise',
    role: 'source',
    status: 'active',
    config,
  })
}

async function repointingInvalidatesQualifications() {
  for (const testCase of REPOINT_CLASSES) {
    const world = makeWorld({ system: { config: testCase.from } })
    const before = await world.resolver.resolveApprovedBinding(world.scopeInput)

    // FIXTURE SHAPE MUST MATCH THE NAMED SCENARIO: for every ATTACK class the difference is
    // INVISIBLE in the registry's public projection — that invisibility IS the collision the
    // P1 exploited. For the control it is visible. A fixture that failed this would be
    // testing a different (easier) scenario.
    const projectedFrom = JSON.stringify(sanitizeIntegrationPayload(testCase.from))
    const projectedTo = JSON.stringify(sanitizeIntegrationPayload(testCase.to))
    if (testCase.control) {
      assert.notEqual(projectedFrom, projectedTo, `${testCase.label} — control fixture: the projection MUST differ`)
    } else {
      assert.equal(
        projectedFrom,
        projectedTo,
        `${testCase.label} — attack fixture: the two configs MUST be indistinguishable in the public projection (else this case is not the reported collision class)`,
      )
    }

    await repointSystemInPlace(world, testCase.to)
    // The DB row really moved (never assert a "change" nobody made).
    const storedRows = await world.db.select(SYSTEM_TABLE, { where: { id: SYSTEM_ID } })
    assert.equal(
      JSON.stringify(storedRows[0].config),
      JSON.stringify(testCase.to),
      `${testCase.label} — fixture sanity: the stored system row must actually carry the repointed config`,
    )

    const after = await world.resolver.resolveApprovedBinding(world.scopeInput)
    assert.equal(
      after.configContentKey,
      before.configContentKey,
      `${testCase.label} — fixture sanity: the approved config body is untouched, so configContentKey must not move`,
    )
    assert.notEqual(
      after.systemContentKey,
      before.systemContentKey,
      `${testCase.label} — REPOINTING THE SYSTEM MUST CHANGE systemContentKey (D2.1: a lossy projection may never back a system identity)`,
    )
    assert.notEqual(
      after.canonicalObjectVersion,
      before.canonicalObjectVersion,
      `${testCase.label} — canonicalObjectVersion is bound to systemContentKey and must move with it`,
    )
    assert.notEqual(
      digestOfResolution(after),
      digestOfResolution(before),
      `${testCase.label} — a qualification digest taken before the repoint must NOT recompute after it`,
    )
  }

  // END-TO-END, on the class the P1 was proven with: mint a real qualification against the
  // production system, repoint, and verify. It must now REFUSE — with the positive control
  // that the same qualification still verifies against the resolution it was minted from.
  const {
    createProbeStrategyRegistry,
    createBindingQualificationProber,
    postgresTotalOrderProbeStrategy,
    verifyBindingQualificationFromResolution,
    GipQualificationError,
  } = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))

  const world = makeWorld({ system: { config: { connectionString: 'Server=erp-prod.internal;Database=bom;User Id=svc' } } })
  const before = await world.resolver.resolveApprovedBinding(world.scopeInput)
  const prober = createBindingQualificationProber(createProbeStrategyRegistry([
    { ...postgresTotalOrderProbeStrategy, actionProfileVersion: PROFILE_VERSION },
  ]))
  const envelopeKey = { keyId: 'kid-1', secret: Buffer.alloc(32, 7) }
  const qualification = await prober.probeFromResolution({
    resolution: before,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }),
    envelopeKey,
    probedAt: '2026-07-24T00:00:00Z',
    expiresAt: '2026-07-24T01:00:00Z',
  })
  // POSITIVE CONTROL FIRST: the qualification is genuinely verifiable where it was minted.
  assert.equal(
    verifyBindingQualificationFromResolution({ resolution: before, qualification, envelopeKey, now: '2026-07-24T00:00:30Z' }).verified,
    true,
    'positive control: the minted qualification verifies against the resolution it was probed from',
  )
  await repointSystemInPlace(world, { connectionString: 'Server=attacker.example;Database=bom;User Id=svc' })
  const after = await world.resolver.resolveApprovedBinding(world.scopeInput)
  let repointError = null
  try {
    verifyBindingQualificationFromResolution({ resolution: after, qualification, envelopeKey, now: '2026-07-24T00:00:30Z' })
  } catch (caught) {
    repointError = caught
  }
  assert.ok(repointError, 'THE MONEY ASSERTION: a qualification minted against the production system MUST NOT verify after the system is repointed at another host')
  assert.ok(repointError instanceof GipQualificationError, `the refusal must be the spike's closed error type (got ${repointError && repointError.name})`)
  assert.equal(repointError.reason, 'QUALIFICATION_DIGEST_MISMATCH', 'the repointed system must fail the digest binding')
}

// D2.1 layer (2), rule by rule, driven by the REAL sanitizer — never by a local imitation of
// it, so a marker/limit change in payload-redaction.cjs reds HERE instead of silently
// reopening the collision.
async function lossyProjectionIsRefused() {
  const world = makeWorld()
  const losslessRecord = await world.registry.getExternalSystemForAdapter({ tenantId: TENANT, workspaceId: WORKSPACE, id: SYSTEM_ID })
  const withConfig = (config) => ({ ...losslessRecord, config })
  const resolverOver = (record) => createApprovedBindingResolver({
    configStore: world.store,
    systemRegistry: { async getExternalSystemForAdapter() { return record } },
  })
  const refuseConfig = async (config, rule, label) => refusedWith(
    () => resolverOver(withConfig(config)).resolveApprovedBinding(world.scopeInput),
    { reason: 'SYSTEM_IDENTITY_NOT_LOSSLESS', rule },
    label,
  )
  const acceptConfig = async (config, label) => {
    const resolution = await resolverOver(withConfig(config)).resolveApprovedBinding(world.scopeInput)
    assert.match(resolution.systemContentKey, /^sck1:[0-9a-f]{64}$/, `positive control beside "${label}": a LOSSLESS config of the same shape MUST resolve`)
    return resolution
  }

  const seenRules = new Set()
  const lossClasses = [
    { label: 'redacted key name', raw: { connectionString: 'Server=erp-prod.internal;Database=bom' } },
    { label: 'depth > 6', raw: { profile: nestConfig(6, { host: 'erp-prod.internal' }) } },
    { label: 'array item > 50', raw: { endpoints: [...Array(50).fill('pad'), 'https://erp-prod.internal/api'] } },
    { label: 'string char > 2000', raw: { note: `${'x'.repeat(2000)}host=erp-prod.internal` } },
    { label: 'secret-shaped substring', raw: { dsn: 'postgres://svc:hunter2@erp-prod.internal/bom' } },
  ]
  for (const { label, raw } of lossClasses) {
    const projected = sanitizeIntegrationPayload(raw)
    // Fixture sanity: this class really IS lossy — otherwise the refusal below proves nothing.
    assert.notEqual(JSON.stringify(projected), JSON.stringify(raw), `fixture sanity (${label}): the sanitizer must actually change this config`)
    // (a) THE EXACT RECORD THE PUBLIC READ RETURNS is refused — this is the pre-fix wiring.
    const protoError = await refuseConfig(projected, 'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE', `a projected config (${label}) must never back an identity`)
    seenRules.add(protoError.details.rule)
    // (b) LAUNDERED: prototypes restored by a JSON round-trip, markers still present — the
    //     second, independent layer. Positive control: the SAME round-trip of the RAW config
    //     resolves, so the round-trip itself is never the reason for the refusal.
    const laundered = JSON.parse(JSON.stringify(projected))
    const markerError = await refuseConfig(laundered, 'SYSTEM_IDENTITY_REDACTION_MARKER', `a laundered projection (${label}) must still be refused on its markers`)
    seenRules.add(markerError.details.rule)
    await acceptConfig(JSON.parse(JSON.stringify(raw)), `laundered projection (${label})`)
  }

  // Deliberate OVER-refusal, stated as a decision rather than discovered later: a genuine
  // value that merely LOOKS like a marker is refused too. Fail-closed beats a clever parser.
  const overRefusal = await refuseConfig({ note: 'legacy field [omitted] by the vendor' }, 'SYSTEM_IDENTITY_REDACTION_MARKER', 'a genuine value carrying a marker substring is refused (deliberate over-refusal)')
  seenRules.add(overRefusal.details.rule)
  await acceptConfig({ note: 'legacy field removed by the vendor' }, 'marker-shaped genuine value')

  // The ONE loss class that leaves NO marker: keys every projection silently drops.
  for (const unsafeKey of ['__proto__', 'constructor', 'prototype']) {
    const config = JSON.parse(`{"baseUrl":"https://erp.internal.example/api","${unsafeKey}":{"host":"attacker.example"}}`)
    const error = await refuseConfig(config, 'SYSTEM_IDENTITY_UNPROJECTABLE_KEY', `a config carrying an own "${unsafeKey}" key must be refused (a projection would drop it with no marker)`)
    seenRules.add(error.details.rule)
  }
  await acceptConfig({ baseUrl: 'https://erp.internal.example/api' }, 'unprojectable key')

  // Unhashable / non-canonical shapes fail closed on the guard, before any hashing.
  const accessorConfig = {}
  Object.defineProperty(accessorConfig, 'baseUrl', { get: () => 'https://erp.internal.example/api', enumerable: true, configurable: true })
  const sparse = ['a']
  sparse[3] = 'b'
  for (const [label, config] of [
    ['an undefined value', { probe: undefined }],
    ['an accessor property', accessorConfig],
    ['a sparse array', { endpoints: sparse }],
    ['a non-object config', 'baseUrl=https://erp.internal.example/api'],
    ['a class instance', new Map([['baseUrl', 'x']])],
  ]) {
    const error = await refuseConfig(config, 'SYSTEM_IDENTITY_CONFIG_SHAPE', `${label} must be refused before any hashing`)
    seenRules.add(error.details.rule)
  }
  await acceptConfig({ probe: 'value', endpoints: ['a', 'b'] }, 'non-canonical shapes')

  // DEPTH IS A RULE (review round-4 regression). Reading identity LOSSLESSLY put unbounded-depth
  // JSONB on a path ending in the RECURSIVE canonical codec: depth 5000 blew the stack as a
  // RangeError that ESCAPED the frozen vocabulary — still fail-closed, but unclassified, which a
  // wiring gate would surface as a 500 instead of a closed refusal. The pre-fix LOSSY read hid
  // this by truncating at depth 6. Pinned in BOTH directions: the bound can neither be removed
  // nor tightened into refusing a real system.
  {
    const nestDeep = (levels) => {
      const root = {}
      let cursor = root
      for (let index = 0; index < levels; index += 1) { cursor.next = {}; cursor = cursor.next }
      return root
    }
    await acceptConfig(nestDeep(60), 'a deeply-but-legally nested config (depth 60, inside the bound)')
    const deepError = await refuseConfig(nestDeep(5000), 'SYSTEM_IDENTITY_CONFIG_TOO_DEEP',
      'a config nested past the bindable maximum must be refused BY RULE, not by a RangeError escaping the vocabulary')
    seenRules.add(deepError.details.rule)
    await refuseConfig(nestDeep(20000), 'SYSTEM_IDENTITY_CONFIG_TOO_DEEP',
      'the depth rule holds far past the JS recursion limit the canonical codec would hit')
  }

  // CREDENTIAL MATERIAL MAY NEVER REACH THE HASHING PATH — and the narrowing that keeps it
  // out is proven LOAD-BEARING, not asserted: the lossless read of a system that HAS
  // credentials carries them, that raw record is refused by assembly, and the SAME system
  // still resolves through the resolver (which narrows at the boundary).
  const withCredentials = makeWorld({ system: { credentials_encrypted: 'enc:svc-account-secret' } })
  const rawCredentialRecord = await withCredentials.registry.getExternalSystemForAdapter({ tenantId: TENANT, workspaceId: WORKSPACE, id: SYSTEM_ID })
  assert.ok(
    Object.prototype.hasOwnProperty.call(rawCredentialRecord, 'credentials'),
    'fixture sanity: the unsanitized read really does carry decrypted credential material',
  )
  const credentialRow = await withCredentials.store.getForRuntime({ tenantId: TENANT, workspaceId: WORKSPACE, id: CONFIG_ID })
  const credentialError = await refusedWith(
    async () => resolverInternals.assembleBindingTuple(credentialRow, rawCredentialRecord),
    { reason: 'SYSTEM_IDENTITY_NOT_LOSSLESS', rule: 'SYSTEM_IDENTITY_CREDENTIAL_MATERIAL' },
    'a system identity record still carrying credential material must be refused before any hashing',
  )
  seenRules.add(credentialError.details.rule)
  const credentialResolution = await withCredentials.resolver.resolveApprovedBinding(withCredentials.scopeInput)
  assert.match(
    credentialResolution.systemContentKey,
    /^sck1:[0-9a-f]{64}$/,
    'positive control: the resolver narrows the record at the boundary, so a system WITH credentials still resolves',
  )
  const plain = await resolvesCleanly('credential narrowing')
  assert.equal(
    credentialResolution.systemContentKey,
    plain.systemContentKey,
    'credential material is NOT identity: adding credentials to a system must not change systemContentKey (D2 exclusion)',
  )

  assert.deepEqual(
    [...seenRules].sort(),
    [...SYSTEM_IDENTITY_SOURCE_RULES].sort(),
    'every frozen system-identity rule must be exercised by at least one case (no unreachable rule token)',
  )

  // THE REGRESSION GUARD FOR THE P1 ITSELF: wiring the resolver back to the registry's PUBLIC
  // read (what the pre-fix code did) must FAIL CLOSED, not silently hash a projection.
  const publicReadRegistry = {
    async getExternalSystemForAdapter(input) { return world.registry.getExternalSystem(input) },
  }
  await refusedWith(
    () => createApprovedBindingResolver({ configStore: world.store, systemRegistry: publicReadRegistry }).resolveApprovedBinding(world.scopeInput),
    { reason: 'SYSTEM_IDENTITY_NOT_LOSSLESS', rule: 'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE' },
    'a registry backed by the SANITIZED public read must be refused — the pre-fix wiring is fail-closed, not silently accepted',
  )
  // POSITIVE CONTROL: the same world through the UNSANITIZED read resolves.
  await resolvesCleanly('lossless system identity')

  // The lossy read is not even a wireable dependency: the factory demands the unsanitized one.
  assert.throws(
    () => createApprovedBindingResolver({ configStore: world.store, systemRegistry: { getExternalSystem: async () => ({}) } }),
    (error) => error instanceof GipBindingResolutionError && error.reason === 'RESOLVER_DEPENDENCY_INVALID',
    'a registry exposing ONLY the sanitized read must be refused by the factory',
  )
}

// ── 5c. Every identity field of the tuple must be OBSERVABLE (hash material is not a guard) ─
// Feeding a field into a hash proves nothing on its own: a mutation that stops hashing it
// survives unless some test can SEE the difference. One world per identity field, varied
// alone. Each case asserts canonicalObjectVersion moves too — that is what makes a mutation
// dropping the systemContentKey binding out of the D3 material visible.
async function everyIdentityFieldDiscriminates() {
  const resolveWorld = async (options) => {
    const world = makeWorld(options)
    return world.resolver.resolveApprovedBinding(world.scopeInput)
  }
  const base = await resolveWorld()
  const cases = [
    {
      label: 'systemId',
      options: { body: baseConfigBody({ systemId: 'k3-erp-secondary' }), system: { id: 'k3-erp-secondary' } },
      configKeyMoves: true,
    },
    { label: 'system kind', options: { system: { kind: 'mysql' } } },
    { label: 'system role', options: { system: { role: 'bidirectional' } } },
    {
      label: 'tenantId',
      options: { tenantId: 'tenant-beta', system: { tenant_id: 'tenant-beta' } },
    },
    {
      label: 'workspaceId',
      options: { workspaceId: null, system: { workspace_id: null } },
    },
  ]
  for (const testCase of cases) {
    const varied = await resolveWorld(testCase.options)
    assert.notEqual(
      varied.systemContentKey,
      base.systemContentKey,
      `${testCase.label} is part of the system identity: varying it ALONE must change systemContentKey`,
    )
    assert.notEqual(
      varied.canonicalObjectVersion,
      base.canonicalObjectVersion,
      `${testCase.label}: canonicalObjectVersion is derived from systemContentKey and must move with it`,
    )
    if (!testCase.configKeyMoves) {
      assert.equal(
        varied.configContentKey,
        base.configContentKey,
        `${testCase.label}: the approved body is untouched, so this case isolates the SYSTEM identity`,
      )
    }
  }
}

// ── 6. R6 closed ordering-key schema, rule by rule, each with a positive control ───────
async function orderingKeySchema() {
  const cases = [
    { rule: 'ORDERING_KEY_SPEC_SHAPE', spec: undefined, label: 'absent spec' },
    { rule: 'ORDERING_KEY_SPEC_SHAPE', spec: 'material_code ASC', label: 'raw string spec' },
    { rule: 'ORDERING_KEY_SPEC_SHAPE', spec: { fieldId: 'material_code', direction: 'ASC' }, label: 'object instead of array' },
    { rule: 'ORDERING_KEY_SPEC_EMPTY', spec: [], label: 'empty spec' },
    { rule: 'ORDERING_KEY_ENTRY_SHAPE', spec: ['material_code'], label: 'bare string entry' },
    { rule: 'ORDERING_KEY_ENTRY_SHAPE', spec: [{ fieldId: 'material_code' }], label: 'entry without direction' },
    { rule: 'ORDERING_KEY_ENTRY_SHAPE', spec: [{ fieldId: 'material_code', direction: 'ASC', nulls: 'FIRST' }], label: 'entry with an extra key' },
    // Raw SQL / expressions / aliases / quoted identifiers / dotted paths — refused BY SYNTAX.
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 'qty; DROP TABLE t', direction: 'ASC' }], label: 'sql injection fieldId' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 'COALESCE(qty,0)', direction: 'ASC' }], label: 'expression fieldId' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 'qty DESC', direction: 'ASC' }], label: 'embedded direction token' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 'qty AS q', direction: 'ASC' }], label: 'alias fieldId' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: '"qty"', direction: 'ASC' }], label: 'quoted identifier' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 'Data.FQty', direction: 'ASC' }], label: 'dotted response path (a fieldMap SOURCE)' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: '', direction: 'ASC' }], label: 'empty fieldId' },
    { rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL', spec: [{ fieldId: 1, direction: 'ASC' }], label: 'non-string fieldId' },
    // (the length boundary and the homoglyph case live below: each needs a fieldMap that
    // RESOLVES the offending fieldId, so the refusal can only come from the SYNTAX rule)
    { rule: 'ORDERING_KEY_FIELD_ID_DUPLICATE', spec: [{ fieldId: 'material_code', direction: 'ASC' }, { fieldId: 'material_code', direction: 'DESC' }], label: 'duplicate fieldId' },
    // STRICT CASE POLICY: lowercase is refused, never uppercased.
    { rule: 'ORDERING_KEY_DIRECTION_INVALID', spec: [{ fieldId: 'material_code', direction: 'asc' }], label: 'lowercase direction' },
    { rule: 'ORDERING_KEY_DIRECTION_INVALID', spec: [{ fieldId: 'material_code', direction: 'Asc' }], label: 'mixed-case direction' },
    { rule: 'ORDERING_KEY_DIRECTION_INVALID', spec: [{ fieldId: 'material_code', direction: 'ASCENDING' }], label: 'unknown direction token' },
    { rule: 'ORDERING_KEY_DIRECTION_INVALID', spec: [{ fieldId: 'material_code', direction: 1 }], label: 'non-string direction' },
    { rule: 'ORDERING_KEY_FIELD_ID_UNRESOLVED', spec: [{ fieldId: 'not_mapped_here', direction: 'ASC' }], label: 'fieldId absent from this version\'s field map' },
    { rule: 'ORDERING_KEY_FIELD_ID_UNRESOLVED', spec: [{ fieldId: 'FNumber', direction: 'ASC' }], label: 'fieldId naming a SOURCE rather than a mapped target' },
  ]
  const seenRules = new Set()
  for (const testCase of cases) {
    const world = makeWorld({ body: baseConfigBody({ orderingKeySpec: testCase.spec }) })
    await refusedWith(
      () => world.resolver.resolveApprovedBinding(world.scopeInput),
      { reason: 'ORDERING_KEY_SPEC_INVALID', rule: testCase.rule },
      `R6 must refuse: ${testCase.label}`,
    )
    seenRules.add(testCase.rule)
    // PER-CASE POSITIVE CONTROL: the same world shape with a VALID spec resolves — a
    // validator that throws for everything cannot pass this suite.
    const control = makeWorld()
    const resolved = await control.resolver.resolveApprovedBinding(control.scopeInput)
    assert.deepEqual(
      resolved.orderingKeySpec,
      VALID_ORDERING_KEY_SPEC,
      `positive control beside "${testCase.label}": a valid ordering key spec MUST resolve`,
    )
  }
  assert.deepEqual(
    [...seenRules].sort(),
    [...ORDERING_KEY_SPEC_RULES].sort(),
    'every frozen ordering-key rule must be exercised by at least one case (no unreachable rule token)',
  )
  // A single-entry spec and a spec that omits a mapped field are both legal.
  const single = makeWorld({ body: baseConfigBody({ orderingKeySpec: [{ fieldId: 'material_code', direction: 'DESC' }] }) })
  const singleResolution = await single.resolver.resolveApprovedBinding(single.scopeInput)
  assert.deepEqual(singleResolution.orderingKeySpec, [{ fieldId: 'material_code', direction: 'DESC' }], 'a single-entry ordering key is legal')

  // THE LENGTH BOUNDARY AND THE HOMOGLYPH, BOTH SIDES — each with a fieldMap target of the
  // SAME name, so the fieldId is RESOLVABLE and the only thing that can refuse it is the
  // syntax rule. (Put in the generic table instead, they would be refused by
  // ORDERING_KEY_FIELD_ID_UNRESOLVED and a widened syntax would go unnoticed.)
  const mappedSpecWorld = (fieldId) => makeWorld({
    body: baseConfigBody({
      fieldMap: [{ source: 'FNumber', target: fieldId }, { source: 'Data.FQty', target: 'qty' }],
      orderingKeySpec: [{ fieldId, direction: 'ASC' }],
    }),
  })
  const sixtyFour = `f${'x'.repeat(63)}`
  const sixtyFive = `f${'x'.repeat(64)}`
  assert.equal(sixtyFour.length, 64, 'fixture sanity: the accepting boundary case is exactly 64 characters')
  assert.equal(sixtyFive.length, 65, 'fixture sanity: the refusing boundary case is exactly 65 characters')
  const boundary = mappedSpecWorld(sixtyFour)
  const boundaryResolution = await boundary.resolver.resolveApprovedBinding(boundary.scopeInput)
  assert.deepEqual(
    boundaryResolution.orderingKeySpec,
    [{ fieldId: sixtyFour, direction: 'ASC' }],
    'a 64-character canonical fieldId is INSIDE the boundary and must resolve',
  )
  const past = mappedSpecWorld(sixtyFive)
  await refusedWith(
    () => past.resolver.resolveApprovedBinding(past.scopeInput),
    { reason: 'ORDERING_KEY_SPEC_INVALID', rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL' },
    'a 65-character fieldId is one PAST the boundary and must be refused BY SYNTAX (it resolves in the field map, so nothing else could refuse it)',
  )
  // HOMOGLYPH: a Cyrillic 'а' (U+0430) inside an otherwise-canonical identifier, mapped as a
  // real target. It is not [A-Za-z], so ASCII-only syntax is the ONLY thing that refuses it.
  const homoglyph = 'mаterial_code'
  assert.ok(!/^[A-Za-z0-9_]+$/.test(homoglyph), 'fixture sanity: the homoglyph case really does carry a non-ASCII letter')
  const homoglyphWorld = mappedSpecWorld(homoglyph)
  await refusedWith(
    () => homoglyphWorld.resolver.resolveApprovedBinding(homoglyphWorld.scopeInput),
    { reason: 'ORDERING_KEY_SPEC_INVALID', rule: 'ORDERING_KEY_FIELD_ID_NOT_CANONICAL' },
    'a homoglyph fieldId must be refused BY SYNTAX even when the field map resolves it (a look-alike identifier is not a canonical one)',
  )
}

// ── 7. No caller override (R3.4) — two separately-red-able properties ─────────────────
async function noCallerOverride() {
  const world = makeWorld()
  // (a) the run input is an EXACT allowlist: each of the six tuple fields is refused.
  for (const field of BINDING_RESOLUTION_FIELDS) {
    const error = await refusedWith(
      () => world.resolver.resolveApprovedBinding({ ...world.scopeInput, [field]: 'FORGED' }),
      { reason: 'RESOLVER_INPUT_INVALID', rule: 'RUN_INPUT_NOT_ALLOWLISTED' },
      `run input must not be able to carry ${field}`,
    )
    assert.equal(error.details.rejectedKeyCount, 1, 'the rejection carries a COUNT, never the offending key name')
  }
  // Dependencies can never arrive as run data either (the spike's duck-typed-injection P1).
  for (const dependencyKey of ['configStore', 'systemRegistry']) {
    await refusedWith(
      () => world.resolver.resolveApprovedBinding({ ...world.scopeInput, [dependencyKey]: { getForRuntime: () => {}, getExternalSystem: () => {} } }),
      { reason: 'RESOLVER_INPUT_INVALID', rule: 'RUN_INPUT_NOT_ALLOWLISTED' },
      `run input must not be able to carry a ${dependencyKey}`,
    )
  }
  // POSITIVE CONTROL: the clean scope-only input resolves.
  const clean = await world.resolver.resolveApprovedBinding(world.scopeInput)
  assert.equal(clean.actionProfileVersion, PROFILE_VERSION, 'positive control: scope-only run input resolves')

  // (b) ASSEMBLY BLINDNESS — proven INDEPENDENTLY of the allowlist. assembleBindingTuple
  // takes the two server-side records and nothing else; this call passes an
  // override-shaped third argument in exactly the position a careless refactor would wire
  // run input into. The tuple must be unchanged.
  const row = await world.store.getForRuntime({ tenantId: TENANT, workspaceId: WORKSPACE, id: CONFIG_ID })
  // THE UNSANITIZED read (D2.1): the public getExternalSystem returns a lossy projection and
  // is refused by assembly — asserted directly below, so this choice is not a silent detail.
  const system = await world.registry.getExternalSystemForAdapter({ tenantId: TENANT, workspaceId: WORKSPACE, id: SYSTEM_ID })
  const forgery = {
    actionProfileVersion: 'forged.profile.v9',
    systemContentKey: 'sck1:forged',
    configContentKey: 'forged-content-key',
    objectKey: 'v_forged_view',
    canonicalObjectVersion: 'cov1:forged',
    orderingKeySpec: [{ fieldId: 'forged', direction: 'ASC' }],
  }
  const tuple = resolverInternals.assembleBindingTuple(row, system, forgery)
  assert.equal(tuple.objectKey, OBJECT_KEY, 'assembly must derive objectKey from the approved row, never from an input')
  assert.equal(tuple.actionProfileVersion, PROFILE_VERSION, 'assembly must derive actionProfileVersion from the immutable body')
  assert.equal(tuple.configContentKey, contentKeyFor(world.body), 'assembly must recompute configContentKey from the body')
  assert.notEqual(tuple.systemContentKey, forgery.systemContentKey, 'assembly must derive systemContentKey')
  assert.notEqual(tuple.canonicalObjectVersion, forgery.canonicalObjectVersion, 'assembly must derive canonicalObjectVersion')
  // The __internals assembly path must not be able to MINT trust either: only the public
  // resolver registers a resolution in the module-private WeakSet.
  assert.equal(
    isTrustedBindingResolution(tuple),
    false,
    'a raw assembled draft must NOT be trusted — only resolveApprovedBinding mints trust',
  )
  // JSON round-trip: the PRE-CLONE draft aliases the store's own null-prototype objects
  // (sanitizeIntegrationPayload builds them that way); only the owned clone is normalized
  // to Object.prototype. The comparison here is about VALUES, not prototypes.
  assert.deepEqual(
    JSON.parse(JSON.stringify(tuple.orderingKeySpec)),
    VALID_ORDERING_KEY_SPEC,
    'assembly must take the ordering key from the approved body',
  )

  // ASSEMBLY DOES NOT READ THE STORED CONTENT-KEY COLUMN — proven DIRECTLY, not through the
  // upstream equality gate. The resolver refuses a row whose stored column disagrees with the
  // body (§4), so an assembly that TRUSTED the column would still look correct end-to-end.
  // This call hands assembly a deliberately-wrong column and pins that the RECOMPUTED key is
  // what lands in the tuple.
  const wrongColumnTuple = resolverInternals.assembleBindingTuple({ ...row, contentKey: 'deadbeef' }, system)
  assert.equal(
    wrongColumnTuple.configContentKey,
    contentKeyFor(world.body),
    'assembly must RECOMPUTE configContentKey from the body — the stored column is not in the tuple\'s provenance path',
  )
  assert.notEqual(wrongColumnTuple.configContentKey, 'deadbeef', 'assembly must never surface the stored content-key column')

  // …and the SANITIZED system record is refused right here, at the one place a lossy record
  // is still expressible after the factory gate (D2.1).
  const projectedSystem = await world.registry.getExternalSystem({ tenantId: TENANT, workspaceId: WORKSPACE, id: SYSTEM_ID })
  await refusedWith(
    async () => resolverInternals.assembleBindingTuple(row, projectedSystem),
    { reason: 'SYSTEM_IDENTITY_NOT_LOSSLESS', rule: 'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE' },
    'assembly must refuse the registry\'s SANITIZED record — a lossy projection may never back a system identity',
  )

  // Dependencies are factory-bound: a missing/duck-typed dependency is refused up front.
  for (const deps of [
    undefined,
    {},
    { configStore: {} },
    { configStore: { getForRuntime: () => {} } },
    { systemRegistry: { getExternalSystemForAdapter: () => {} } },
    // A registry that offers ONLY the SANITIZED public read is not a usable identity source
    // (D2.1): the lossy path must not even be wireable.
    { configStore: { getForRuntime: () => {} }, systemRegistry: { getExternalSystem: () => {} } },
  ]) {
    assert.throws(
      () => createApprovedBindingResolver(deps),
      (error) => error instanceof GipBindingResolutionError && error.reason === 'RESOLVER_DEPENDENCY_INVALID',
      'the factory must refuse to build a resolver without both server-side dependencies',
    )
  }
}

// ── 8. Trust = unforgeable object identity (never a public brand) ─────────────────────
async function trustIsObjectIdentity() {
  const world = makeWorld()
  const resolution = await world.resolver.resolveApprovedBinding(world.scopeInput)
  // POSITIVE CONTROL first.
  assert.equal(assertTrustedBindingResolution(resolution), resolution, 'a real resolution must be accepted and returned')
  assert.equal(isTrustedBindingResolution(resolution), true, 'a real resolution is trusted')

  // A STRUCTURALLY PERFECT hand-built object: same keys, same values, deep-frozen, in the
  // same strict canonical domain — byte-identical to the real one. Only identity differs.
  const handBuilt = deepCloneFrozenCanonical(JSON.parse(JSON.stringify(resolution)))
  assert.deepEqual(handBuilt, resolution, 'the hand-built object must be structurally identical (so only IDENTITY can refuse it)')
  assert.ok(Object.isFrozen(handBuilt) && Object.isFrozen(handBuilt.orderingKeySpec), 'the hand-built object must be deep-frozen too')
  assert.equal(isTrustedBindingResolution(handBuilt), false, 'a hand-built clone is NOT trusted')
  await refusedWith(
    async () => assertTrustedBindingResolution(handBuilt),
    { reason: 'RESOLUTION_NOT_TRUSTED' },
    'a structurally perfect hand-built resolution must be refused on IDENTITY alone',
  )
  // Duck-typed brands and primitives are refused without throwing a non-vocabulary error.
  for (const impostor of [null, undefined, 'resolution', 42, {}, { ...JSON.parse(JSON.stringify(resolution)), __gipTrustedResolution: true }]) {
    assert.equal(isTrustedBindingResolution(impostor), false, 'no public field can make an object trusted')
    await refusedWith(
      async () => assertTrustedBindingResolution(impostor),
      { reason: 'RESOLUTION_NOT_TRUSTED' },
      'a duck-typed or primitive impostor must be refused',
    )
  }
}

// ── 9. MANDATED NEGATIVE CONTROL: deep immutability across a REAL async window ─────────
// A probe reads the ordering key, awaits the external source, and would read it again. That
// await is a real window. Two directions are asserted:
//   (a) the holder mutates the RESOLUTION's nested array (shallow freeze leaves it writable);
//   (b) the holder mutates the ORIGINAL body array the store handed back (owner-named NC:
//       a decorating store / cache / mapper may legitimately return a LIVE reference — the
//       resolver must not depend on its collaborator deep-copying, so ownership is taken
//       here, at the deepCloneFrozenCanonical choke point).
async function fakeTotalOrderProbe(resolution, query) {
  assertTrustedBindingResolution(resolution)
  const keyAtParseTime = resolution.orderingKeySpec.map((entry) => `${entry.fieldId}:${entry.direction}`).join(',')
  const rows = await query(keyAtParseTime)
  const keyAfterAwait = resolution.orderingKeySpec.map((entry) => `${entry.fieldId}:${entry.direction}`).join(',')
  return { keyAtParseTime, keyAfterAwait, rows }
}

async function asyncWindowNegativeControl() {
  const world = makeWorld()
  // The live body a decorating store hands back BY REFERENCE.
  const liveBody = JSON.parse(JSON.stringify(world.body))
  const aliasingStore = {
    async getForRuntime(input) {
      const row = await world.store.getForRuntime(input)
      return { ...row, config: liveBody }
    },
  }
  const resolver = createApprovedBindingResolver({ configStore: aliasingStore, systemRegistry: world.registry })
  const resolution = await resolver.resolveApprovedBinding(world.scopeInput)
  const parseTimeSnapshot = JSON.parse(JSON.stringify(resolution.orderingKeySpec))
  assert.deepEqual(parseTimeSnapshot, VALID_ORDERING_KEY_SPEC, 'fixture sanity: the resolution starts as the approved ordering key')

  let refusedNestedWrites = 0
  const observed = await fakeTotalOrderProbe(resolution, async () => {
    // A GENUINE async window: two macrotask boundaries around the mutation, not a comment.
    await new Promise((resolve) => setImmediate(resolve))

    // (a) mutate the RESOLUTION's nested array — must be impossible.
    try {
      resolution.orderingKeySpec[0].direction = 'DESC'
    } catch (_error) {
      refusedNestedWrites += 1
    }
    try {
      resolution.orderingKeySpec.push({ fieldId: 'qty', direction: 'ASC' })
    } catch (_error) {
      refusedNestedWrites += 1
    }

    // (b) mutate the ORIGINAL arrays the store handed back — must not reach the resolution.
    liveBody.orderingKeySpec[0].direction = 'DESC'
    liveBody.orderingKeySpec.push({ fieldId: 'material_code', direction: 'ASC' })
    liveBody.fieldMap.length = 0
    liveBody.object = 'v_forged_view'

    await new Promise((resolve) => setImmediate(resolve))
    return []
  })

  assert.equal(
    refusedNestedWrites,
    2,
    'the resolution must be DEEP-frozen: both nested writes inside the async window must throw (a shallow freeze silently accepts them)',
  )
  assert.deepEqual(
    resolution.orderingKeySpec,
    parseTimeSnapshot,
    'the resolved ordering key must be UNCHANGED after the async window (mutating the original body must not reach the owned clone)',
  )
  assert.equal(
    observed.keyAfterAwait,
    observed.keyAtParseTime,
    'the probe must use the SAME parse-time ordering key before and after awaiting the source',
  )
  assert.equal(resolution.objectKey, OBJECT_KEY, 'a scalar field of the resolution must also survive the window')

  // The whole resolution is recursively frozen, not just its top level.
  assert.ok(Object.isFrozen(resolution), 'the resolution is frozen')
  assert.ok(Object.isFrozen(resolution.orderingKeySpec), 'the ordering key array is frozen')
  for (const entry of resolution.orderingKeySpec) {
    assert.ok(Object.isFrozen(entry), 'every ordering key entry is frozen')
  }
  assert.equal(Object.getPrototypeOf(resolution), Object.prototype, 'the owned clone is a plain object')
}

// ── 10. Values-free discipline ────────────────────────────────────────────────────────
async function valuesFreeErrors() {
  const secretsThatMustNeverLeak = ['material_code', 'qty', 'v_bom_lines', 'k3-erp', 'cfg-approved-1', 'tenant-alpha', 'DROP TABLE', 'erp.internal.example', 'FNumber']
  const worlds = [
    { label: 'ordering key', world: makeWorld({ body: baseConfigBody({ orderingKeySpec: [{ fieldId: 'qty; DROP TABLE t', direction: 'ASC' }] }) }) },
    { label: 'unresolved field', world: makeWorld({ body: baseConfigBody({ orderingKeySpec: [{ fieldId: 'material_code', direction: 'ASC' }, { fieldId: 'FNumber', direction: 'ASC' }] }) }) },
    { label: 'content key', world: makeWorld({ storedContentKey: 'deadbeef' }) },
    { label: 'divergent column', world: makeWorld({ rowObject: 'v_other_view' }) },
    { label: 'system admission', world: makeWorld({ system: { status: 'inactive' } }) },
  ]
  for (const { label, world } of worlds) {
    let error = null
    try {
      await world.resolver.resolveApprovedBinding(world.scopeInput)
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof GipBindingResolutionError, `${label}: must fail closed`)
    const surface = JSON.stringify({ message: error.message, details: error.details })
    for (const secret of secretsThatMustNeverLeak) {
      assert.ok(!surface.includes(secret), `${label}: the error surface must not carry "${secret}" (values-free)`)
    }
  }
  // The D2.1 refusals are values-free too — and this is where it matters most: a rejected
  // system config is exactly the place a connection string, a host or a credential would leak.
  const leaky = {
    connectionString: 'Server=erp.internal.example;Database=bom;Password=hunter2',
    apiKey: 'SECRET-TOKEN-123456',
    note: `${'x'.repeat(2000)}trailing-host=erp.internal.example`,
  }
  const leakyWorld = makeWorld()
  const leakyRecord = await leakyWorld.registry.getExternalSystemForAdapter({ tenantId: TENANT, workspaceId: WORKSPACE, id: SYSTEM_ID })
  for (const [label, config] of [
    ['projected', sanitizeIntegrationPayload(leaky)],
    ['laundered projection', JSON.parse(JSON.stringify(sanitizeIntegrationPayload(leaky)))],
  ]) {
    const identityError = await refusedWith(
      () => createApprovedBindingResolver({
        configStore: leakyWorld.store,
        systemRegistry: { async getExternalSystemForAdapter() { return { ...leakyRecord, config } } },
      }).resolveApprovedBinding(leakyWorld.scopeInput),
      { reason: 'SYSTEM_IDENTITY_NOT_LOSSLESS' },
      `a ${label} system config is refused`,
    )
    const surface = JSON.stringify({ message: identityError.message, details: identityError.details })
    for (const secret of ['hunter2', 'erp.internal.example', 'connectionString', 'apiKey', 'SECRET-TOKEN', '[redacted', 'truncated']) {
      assert.ok(!surface.includes(secret), `${label}: the identity refusal must not carry "${secret}" (values-free — not the value, not the key, not even the marker)`)
    }
    assert.equal(typeof identityError.details.nodeCount, 'number', 'the identity refusal carries a COUNT as the observable substitute')
    assert.ok(SYSTEM_IDENTITY_SOURCE_RULES.includes(identityError.details.rule), 'the identity refusal carries a CLOSED rule token')
  }

  // Counts ARE allowed and are the observable substitute for the omitted values.
  const counted = makeWorld({ body: baseConfigBody({ orderingKeySpec: [{ fieldId: 'material_code', direction: 'ASC' }, { fieldId: 'nope', direction: 'ASC' }] }) })
  const error = await refusedWith(
    () => counted.resolver.resolveApprovedBinding(counted.scopeInput),
    { reason: 'ORDERING_KEY_SPEC_INVALID', rule: 'ORDERING_KEY_FIELD_ID_UNRESOLVED' },
    'an unresolvable field id is refused',
  )
  assert.equal(error.details.entryCount, 2, 'the rejection carries a COUNT of declared entries')
}

// ── 11. The tuple is CONSUMABLE by the surface it exists to close ─────────────────────
// The resolver exists because verifyBindingQualification() recomputes the digest from
// caller-supplied `expectedInputs`. A resolver that is latent AND unusable would keep every
// other test green, so this pins that the five scalar fields actually satisfy
// computeQualificationDigest's requiredString gate — and that "config A + system B" is
// INEXPRESSIBLE rather than merely discouraged: the same config against a repointed system
// digests differently under IDENTICAL evidence.
// R3.3 STATUS — precise, so this comment cannot rot: probe/verify re-entry through the
// resolver IS proven, at the MODULE BOUNDARY, in gip-binding-qualification-spike.test.cjs
// (probeFromResolution / verifyBindingQualificationFromResolution take an authenticated
// resolution and refuse any tuple field supplied beside it). It is still NOT proven at
// RUNTIME — nothing is wired, and the spike's ratified caller-supplied entry points remain
// exported for the ratified battery; closure there is the gated wiring point's job.
async function digestConsumability() {
  const { computeQualificationDigest } = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
  const evidence = {
    probeKind: 'ordering_key_total_order_negative',
    checkedKeyColumnCount: 2,
    duplicateGroupsFound: 0,
    nullKeyRowsFound: 0,
  }
  const digestOf = (resolution) => computeQualificationDigest({
    actionProfileVersion: resolution.actionProfileVersion,
    systemContentKey: resolution.systemContentKey,
    configContentKey: resolution.configContentKey,
    objectKey: resolution.objectKey,
    canonicalObjectVersion: resolution.canonicalObjectVersion,
    evidence,
  })

  const world = makeWorld()
  const resolution = await world.resolver.resolveApprovedBinding(world.scopeInput)
  const digest = digestOf(resolution)
  assert.match(digest, /^[0-9a-f]{64}$/, 'the six-field tuple must be directly consumable by computeQualificationDigest')

  const again = await world.resolver.resolveApprovedBinding(world.scopeInput)
  assert.equal(digestOf(again), digest, 'two resolutions of the same approved version must digest identically')

  // THE MONEY ASSERTION: same config body, system repointed at another host ⇒ a different
  // digest under identical evidence. This is what makes "config A + system B" inexpressible.
  const repointed = makeWorld({ system: { config: { baseUrl: 'https://attacker.example/api' } } })
  const repointedResolution = await repointed.resolver.resolveApprovedBinding(repointed.scopeInput)
  assert.equal(repointedResolution.configContentKey, resolution.configContentKey, 'fixture sanity: the config body is identical in both worlds')
  assert.notEqual(
    digestOf(repointedResolution),
    digest,
    'a qualification taken against one system must NOT verify against a repointed system (config A + system B is inexpressible)',
  )
}

// ── 12. B1a D1 known gap, asserted behaviourally so the header cannot rot ─────────────
function knownConfigAllowlistGap() {
  const body = baseConfigBody()
  const { actionProfileVersion, orderingKeySpec, ...withoutB1aKeys } = body
  assert.ok(actionProfileVersion && orderingKeySpec, 'fixture sanity: the base body carries both B1a keys')
  // POSITIVE CONTROL: the fixture is a REAL, production-valid read-source config apart from
  // exactly the two B1a keys — so the gap below is about those keys, not about a bad fixture.
  const control = validateReadSourceConfig(withoutB1aKeys)
  assert.equal(control.valid, true, `fixture must be a production-valid read-source config: ${JSON.stringify(control.errors || [])}`)

  const result = validateReadSourceConfig(body)
  assert.equal(result.valid, false, 'B1a D1: the save-time validator does NOT yet accept the two B1a body keys')
  const rejected = result.errors.filter((entry) => entry.code === 'READ_SOURCE_UNEXPECTED_FIELD').map((entry) => entry.field).sort()
  assert.deepEqual(
    rejected,
    ['actionProfileVersion', 'orderingKeySpec'],
    'B1a D1: exactly these two keys are the documented, gated gap — adding them to ALLOWED_CONFIG_KEYS is an owner-gated change to a LIVE validation path',
  )
}

async function main() {
  frozenVocabularies()
  await derivedTuple()
  await approvalAndScope()
  await storedColumnDistrust()
  await systemAdmission()
  await repointingInvalidatesQualifications()
  await lossyProjectionIsRefused()
  await everyIdentityFieldDiscriminates()
  await orderingKeySchema()
  await noCallerOverride()
  await trustIsObjectIdentity()
  await asyncWindowNegativeControl()
  await valuesFreeErrors()
  await digestConsumability()
  knownConfigAllowlistGap()
  console.log('gip-approved-binding-resolver.test.cjs OK')
}

main().catch((error) => {
  // An async failure MUST exit non-zero: this suite is a link in the `&&` chain that
  // plugin-integration-core's `test` script runs, and a swallowed rejection would make the
  // chain green on a red suite.
  console.error(error)
  process.exit(1)
})
