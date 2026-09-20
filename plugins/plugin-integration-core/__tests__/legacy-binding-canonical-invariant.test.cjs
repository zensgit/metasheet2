'use strict'

// ---------------------------------------------------------------------------------------------
// MIN-PR2-i / PERM-05 — A ROLLBACK-ELIGIBLE LEGACY BINDING MAY NOT BE SILENTLY RE-POINTED.
//
// docs/integration-consolidation-minimal-plan-20260901.md:214 states the rule verbatim:
//   "已标记可回退的 legacy Binding 若修改 `config.dataSourceId`，必须在同一次写入中提供
//    `connectionId` 并转为 canonical;不得允许旧指针在 legacy 状态下静默改指向。"
//
// WHAT USED TO HAPPEN. `upsertExternalSystem` updates `connection_id` on an existing row only when
// the caller passes an explicit `connectionId` (`requestedConnectionId` inherits
// `existing.connection_id` otherwise), and it carries `legacy_connection_fallback_eligible` over
// verbatim. A row in the rollback shape (connection_id NULL + marker TRUE) therefore took a
// brand-new `config.dataSourceId`, kept the marker, and kept resolving through `resolveLegacy` —
// pointing at a DIFFERENT connection than the one the cutover recorded, with no canonical proof and
// no trace that the binding moved.
//
// THE REFUSAL IS DELIBERATELY NOT AN AUTO-CONVERSION: flipping a row to canonical is a write the
// caller never asked for and cannot undo (`requestedConnectionId` refuses to clear `connectionId`
// afterwards), and the canonical id would have to be GUESSED from the legacy pointer — the very
// inference the cutover migration only dared make when a server-stamped owner matched. So the write
// is refused and the operator re-issues it carrying `connectionId`.
//
// Ownership is still decided FIRST: the guard sits after `resolveUpdatedConfig`, so a non-owner
// keeps getting the binder's uniform "not found" and never learns whether the row is legacy.
// ---------------------------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createExternalSystemRegistry: createExternalSystemRegistryRaw,
  ExternalSystemValidationError,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))
const { createConnectionResolver } = require(path.join(__dirname, '..', 'lib', 'connection-resolver.cjs'))

const SQL_READONLY = 'data-source:sql-readonly'
const SQL_WRITE_GATED = 'data-source:sql-write-gated'
const REFUSAL_CODE = 'LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID'

function createMockCredentialStore() {
  return {
    source: 'host-security',
    format: 'enc',
    async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value) { return `fp_${Buffer.from(value).toString('hex').slice(0, 13)}`.slice(0, 16) },
  }
}

function createMockDb() {
  const rows = []
  const calls = []
  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  return {
    rows,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return rows.find((row) => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, { ...row }])
      const stored = { ...row, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' }
      rows.push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = rows.find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-09-16T00:00:00.000Z' })
      return [row]
    },
    // Present only because the factory requires the full scoped-db shape; no assertion below reads
    // through them, so they stay deliberately minimal.
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      return rows.filter((row) => matchesWhere(row, options.where || {}))
    },
    async deleteRows(table, where) {
      calls.push(['deleteRows', table, { ...where }])
      const kept = rows.filter((row) => !matchesWhere(row, where))
      const removed = rows.length - kept.length
      rows.length = 0
      rows.push(...kept)
      return removed
    },
    async countRows(table, where) {
      calls.push(['countRows', table, { ...where }])
      return rows.filter((row) => matchesWhere(row, where)).length
    },
  }
}

// One owner table drives BOTH authorization choke points, exactly as production does: the legacy
// pointer's `dataSourceBinder.assertReferenceable` and the canonical resolver's host facade both
// end at the same owner check, so no assertion below can pass by proving ownership on one only.
function createRegistry(db, credentialStore, owners, binderCalls) {
  const binder = {
    async assertReferenceable(dataSourceId, principal) {
      binderCalls.push([dataSourceId, principal])
      if (owners.get(dataSourceId) !== principal) {
        throw new Error(`Data source with id '${dataSourceId}' not found`)
      }
    },
  }
  return createExternalSystemRegistryRaw({
    db,
    credentialStore,
    idGenerator: () => 'sys_unused',
    dataSourceBinder: binder,
    connectionResolver: createConnectionResolver({
      facade: {
        async resolveConnectionRegistration(id, context) {
          if (typeof context.principal !== 'string' || context.principal.trim().length === 0) {
            throw new Error('connection binding requires an authenticated principal')
          }
          await binder.assertReferenceable(id, context.principal)
          return { id, tenantId: context.tenantId, type: 'sqlserver', scopeKind: 'private' }
        },
      },
    }),
  })
}

function legacyRow(overrides = {}) {
  return {
    id: 'sys_legacy',
    tenant_id: 'tenant_1',
    workspace_id: null,
    project_id: null,
    name: 'SQL bridge',
    kind: SQL_READONLY,
    role: 'source',
    status: 'active',
    config: {
      dataSourceId: 'ds-1',
      dataSourceOwnerId: 'owner_1',
      schema: 'dbo',
      object: 'dbo.t_ICItem',
      pageSize: 500,
    },
    capabilities: {},
    credentials_encrypted: null,
    connection_id: null,
    legacy_connection_fallback_eligible: true,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    ...overrides,
  }
}

function editPayload(extra = {}) {
  return {
    tenantId: 'tenant_1',
    id: 'sys_legacy',
    name: 'SQL bridge',
    kind: SQL_READONLY,
    role: 'source',
    status: 'active',
    principal: 'owner_1',
    ...extra,
  }
}

function isRefusal(err) {
  return err instanceof ExternalSystemValidationError
    && err.details.code === REFUSAL_CODE
    && err.code === REFUSAL_CODE
}

function setup(rowOverrides = {}, owners = [['ds-1', 'owner_1'], ['ds-2', 'owner_1']]) {
  const db = createMockDb()
  const binderCalls = []
  const registry = createRegistry(db, createMockCredentialStore(), new Map(owners), binderCalls)
  db.rows.push(legacyRow(rowOverrides))
  db.calls.length = 0
  return { db, registry, binderCalls, row: () => db.rows.find((r) => r.id === 'sys_legacy') }
}

function updateWrites(db) {
  return db.calls.filter(([op]) => op === 'updateRow').length
}

// 1. THE HOLE ITSELF: rollback shape (connection_id NULL + marker TRUE), owner re-points.
async function testRepointWithoutConnectionIdIsRefused() {
  const { db, registry, row } = setup()
  const error = await registry.upsertExternalSystem(editPayload({ config: { dataSourceId: 'ds-2' } }))
    .then(() => null, (err) => err)
  assert.ok(isRefusal(error), `expected the canonical-invariant refusal, got: ${error && error.message}`)
  assert.equal(error.details.field, 'connectionId')

  // Values-free: no pointer, no row id, no operator-supplied name reaches the error surface.
  const surface = `${error.message} ${JSON.stringify(error.details)}`
  const forbidden = ['ds-1', 'ds-2', 'sys_legacy', 'owner_1', 'SQL bridge', 'dbo.t_ICItem', 'tenant_1']
  for (const value of forbidden) {
    assert.equal(surface.includes(value), false, `the refusal must not echo ${value}`)
  }

  // ZERO WRITE. The row keeps its pointer, its NULL canonical id and its rollback marker.
  assert.equal(updateWrites(db), 0, 'a refused re-point writes nothing')
  assert.equal(row().config.dataSourceId, 'ds-1')
  assert.equal(row().connection_id, null)
  assert.equal(row().legacy_connection_fallback_eligible, true)
  console.log('  legacy-binding-canonical-invariant: silent re-point refused OK')
}

// 2. The migration's OTHER rollback-eligible shape: connection_id already set AND marker TRUE (the
//    backfill writes both). The resolver used to refuse this one incidentally, as a dual-reference
//    mismatch; the refusal is now the stated rule, with a code that names the remedy.
async function testMigratedDualReferenceRepointIsRefused() {
  const { db, registry, row } = setup({ connection_id: 'ds-1' })
  const error = await registry.upsertExternalSystem(editPayload({ config: { dataSourceId: 'ds-2' } }))
    .then(() => null, (err) => err)
  assert.ok(isRefusal(error), `expected the canonical-invariant refusal, got: ${error && error.message}`)
  assert.equal(updateWrites(db), 0)
  assert.equal(row().connection_id, 'ds-1')
  assert.equal(row().config.dataSourceId, 'ds-1')
  assert.equal(row().legacy_connection_fallback_eligible, true)
  console.log('  legacy-binding-canonical-invariant: migrated dual-reference re-point refused OK')
}

// 3. THE SUPPORTED WAY: the same write carries `connectionId`, so the re-point is proven through the
//    canonical choke point and the row LEAVES the legacy state in that one write.
async function testRepointWithConnectionIdConvertsToCanonical() {
  const { registry, row } = setup()
  const updated = await registry.upsertExternalSystem(editPayload({
    connectionId: 'ds-2',
    config: { dataSourceId: 'ds-2' },
  }))
  assert.equal(updated.connectionId, 'ds-2')
  assert.equal(row().connection_id, 'ds-2', 'the canonical column now holds the new connection')
  assert.equal(row().legacy_connection_fallback_eligible, false,
    'a proven canonical re-bind retires the rollback marker in the same write')
  assert.equal(row().config.dataSourceId, undefined,
    'and the legacy pointer goes with it: marker FALSE must never coexist with a legacy pointer')
  assert.equal(row().config.dataSourceOwnerId, 'owner_1',
    're-stamped by the principal the canonical bind just proved')
  assert.equal(row().config.schema, 'dbo', 'the rest of the stored config survives the conversion')
  assert.equal(row().config.pageSize, 500)

  // The retired marker is durable: a later unrelated edit does not resurrect legacy eligibility.
  const again = await registry.upsertExternalSystem(editPayload({ name: 'SQL bridge renamed' }))
  assert.equal(again.name, 'SQL bridge renamed')
  assert.equal(row().legacy_connection_fallback_eligible, false, 'and it stays retired on later writes')
  console.log('  legacy-binding-canonical-invariant: connectionId converts the row to canonical OK')
}

// 4. UNAFFECTED: re-asserting the SAME pointer (what the bridge picker serializes on every rename)
//    is not a re-point, so a legacy row keeps working exactly as before.
async function testSamePointerAndUnrelatedEditsAreUnaffected() {
  const { registry, row } = setup()
  await registry.upsertExternalSystem(editPayload({
    name: 'SQL bridge renamed',
    config: { dataSourceId: 'ds-1', object: 'dbo.t_ICItemCore' },
  }))
  assert.equal(row().name, 'SQL bridge renamed')
  assert.equal(row().config.object, 'dbo.t_ICItemCore')
  assert.equal(row().config.dataSourceId, 'ds-1')
  assert.equal(row().config.schema, 'dbo', 'the PATCH semantics are untouched')
  assert.equal(row().legacy_connection_fallback_eligible, true, 'a same-pointer edit is not a conversion')
  assert.equal(row().connection_id, null)

  // A payload that never names the pointer, then a payload with no config at all.
  await registry.upsertExternalSystem(editPayload({ config: { pageSize: 250 } }))
  assert.equal(row().config.pageSize, 250)
  assert.equal(row().config.dataSourceId, 'ds-1')
  await registry.upsertExternalSystem(editPayload({ status: 'error', lastError: 'connection test failed' }))
  assert.equal(row().status, 'error')
  assert.equal(row().config.dataSourceId, 'ds-1')
  assert.equal(row().legacy_connection_fallback_eligible, true)
  console.log('  legacy-binding-canonical-invariant: same-pointer and pointer-free edits unaffected OK')
}

// 5. Clearing stays possible — it de-points rather than re-points, and leaves the binding resolving
//    to NOTHING (`resolveLegacy` raises CONNECTION_LEGACY_POINTER_REQUIRED without a pointer). The
//    two-step bypass it would otherwise open (clear, then set) is closed by the same guard: an empty
//    stored pointer is still a difference from the one being written.
async function testClearingIsAllowedAndCannotBeUsedAsABypass() {
  const { registry, row } = setup()
  await registry.upsertExternalSystem(editPayload({ config: { dataSourceId: null } }))
  assert.equal(row().config.dataSourceId, null, 'an explicit null still clears the pointer')
  assert.equal(row().config.dataSourceOwnerId, undefined, 'and the orphaned stamp goes with it')
  assert.equal(row().legacy_connection_fallback_eligible, true)

  const error = await registry.upsertExternalSystem(editPayload({ config: { dataSourceId: 'ds-2' } }))
    .then(() => null, (err) => err)
  assert.ok(isRefusal(error), 'clear-then-set is the same re-point in two writes, and is refused too')
  assert.equal(row().config.dataSourceId, null)
  console.log('  legacy-binding-canonical-invariant: clearing allowed, clear-then-set bypass closed OK')
}

// 6. SCOPED TO THE LEGACY MARKER: a post-cutover canonical row (marker FALSE) keeps its pre-existing
//    behaviour — the resolver refuses the disagreeing dual reference, not this guard.
async function testCanonicalRowKeepsItsExistingRefusal() {
  const { registry, row } = setup({
    connection_id: 'ds-1',
    legacy_connection_fallback_eligible: false,
    config: { dataSourceOwnerId: 'owner_1', schema: 'dbo' },
  })
  const error = await registry.upsertExternalSystem(editPayload({ config: { dataSourceId: 'ds-2' } }))
    .then(() => null, (err) => err)
  assert.ok(error instanceof ExternalSystemValidationError, 'a canonical row still refuses a pointer-only re-point')
  assert.equal(error.details.code, 'CONNECTION_BINDING_MISMATCH',
    'and it refuses with the pre-existing resolver code, so this guard changed nothing for it')
  assert.equal(row().connection_id, 'ds-1')
  console.log('  legacy-binding-canonical-invariant: canonical rows keep their existing refusal OK')
}

// 7. SCOPED TO THE SQL READ-ONLY KIND. Kinds that do not carry `connection_id` cannot satisfy the
//    "provide connectionId in the same write" remedy at all — `requestedConnectionId` rejects the
//    field outright — so a kind-blind guard would freeze their pointer forever.
async function testOtherKindsAreUntouched() {
  const { registry, row } = setup({
    kind: SQL_WRITE_GATED,
    // Cannot occur post-migration (only sql-readonly rows are ever marked). Asserted here anyway so
    // the guard's kind test is pinned by behaviour rather than by reading the source.
    legacy_connection_fallback_eligible: true,
  })
  await registry.upsertExternalSystem(editPayload({ kind: SQL_WRITE_GATED, config: { dataSourceId: 'ds-2' } }))
  assert.equal(row().config.dataSourceId, 'ds-2', 'a write-gated target re-points exactly as before')
  assert.equal(row().config.dataSourceOwnerId, 'owner_1')

  const rejected = await registry.upsertExternalSystem(editPayload({
    kind: SQL_WRITE_GATED,
    connectionId: 'ds-2',
    config: { dataSourceId: 'ds-2' },
  })).then(() => null, (err) => err)
  assert.ok(rejected instanceof ExternalSystemValidationError)
  assert.equal(rejected.details.field, 'connectionId',
    'the remedy is unavailable to this kind, which is exactly why the guard must not reach it')
  console.log('  legacy-binding-canonical-invariant: non sql-readonly kinds untouched OK')
}

// 8. Ownership is still decided first: a stranger gets the binder's uniform wording and learns
//    nothing about whether the row is legacy.
async function testOwnershipStillDecidesFirst() {
  const { db, registry, row } = setup()
  const error = await registry.upsertExternalSystem(editPayload({
    principal: 'stranger_9',
    config: { dataSourceId: 'ds-2' },
  })).then(() => null, (err) => err)
  assert.ok(error instanceof ExternalSystemValidationError)
  assert.notEqual(error.details.code, REFUSAL_CODE,
    'a non-owner still gets the binder refusal, not the invariant code')
  assert.ok(error.message.includes('not found'))
  assert.equal(updateWrites(db), 0)
  assert.equal(row().config.dataSourceId, 'ds-1')
  console.log('  legacy-binding-canonical-invariant: ownership still refused first OK')
}

async function main() {
  await testRepointWithoutConnectionIdIsRefused()
  await testMigratedDualReferenceRepointIsRefused()
  await testRepointWithConnectionIdConvertsToCanonical()
  await testSamePointerAndUnrelatedEditsAreUnaffected()
  await testClearingIsAllowedAndCannotBeUsedAsABypass()
  await testCanonicalRowKeepsItsExistingRefusal()
  await testOtherKindsAreUntouched()
  await testOwnershipStillDecidesFirst()
  console.log('✓ legacy-binding-canonical-invariant: MIN-PR2-i tests passed')
}

main().catch((err) => {
  console.error('✗ legacy-binding-canonical-invariant FAILED')
  console.error(err)
  process.exit(1)
})
