'use strict'

// 外接源 LIST 的非 null workspace hint 回退 — `listExternalSystems` in `lib/external-systems.cjs`.
//
// THE GAP. #5471 gave the BY-ID read (`selectScopedRow`) a one-step fallback: a caller carrying a
// non-null workspace hint that misses falls back ONCE to the SAME tenant's tenant-wide
// (`workspace_id IS NULL`) row. The LIST never got it. The web workbench puts a hint on every
// request (`apps/web/src/composables/useAuth.ts` writes `localStorage.workspaceId`, in practice the
// tenant id; `getDefaultIntegrationScope` reads it back; `resolveWorkspaceId` in http-routes.cjs
// turns the query param into a non-null hint), while on-prem sources are provisioned tenant-wide.
// Result: 工作台里选源 listed ZERO candidates and reported `effectiveSourceProblem: 'not_found'`
// ("源不可用") for the very source whose dry-run — a by-id read — succeeded.
//
// WHAT THIS FILE PINS. The widening is ONE step, in ONE direction, on the READ side only:
//   L-01 non-null hint, row tenant-wide            -> listed
//   L-02 non-null hint, row in that workspace      -> listed exactly once (no duplicate)
//   L-03 both exist                                -> each once, created_at DESC, exact row wins ties
//   L-04 another TENANT's null row                 -> NEVER listed  (tenant_id on both branches)
//   L-05 another non-null WORKSPACE's row          -> NEVER listed  (the fallback is null-only)
//   L-06 null hint                                 -> unchanged: ONE query, exact null scope
//   L-07 writes (upsert/delete)                    -> unchanged: a hint-carrying write stays on its
//                                                     own row; the tenant-wide row is not touched
//   L-08 filters + pagination                      -> kind/status apply to both branches, and the
//                                                     page is cut from the MERGE
//   L-09 the `scopeFallback` tag                    -> ONLY the rows the fallback branch produced
//                                                     carry it, so a caller that renders this list
//                                                     with write buttons can tell which rows its
//                                                     own (exact-scope) writes would MISS
//
// MUTATION EVIDENCE (probed in memory against a patched copy of the module source, then reverted —
// nothing is written to disk by this file):
//   * drop `tenant_id` from the fallback branch's where-clause -> L-04 goes red;
//   * replace the fallback branch's `workspace_id: null` with "any workspace" -> L-05 goes red.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createExternalSystemRegistry,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))

function createCredentialStore() {
  return {
    source: 'test',
    format: 'enc',
    async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value) { return `fp_${Buffer.from(value).toString('hex').slice(0, 8)}` },
  }
}

function createMockDb() {
  const rows = []
  const pipelineRows = []
  const calls = []

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    rows,
    pipelineRows,
    calls,
    selectCalls() {
      return calls.filter(([name]) => name === 'select')
    },
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return rows.find(row => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, { ...row }])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-09-10T00:00:00.000Z',
        updated_at: row.updated_at || '2026-09-10T00:00:00.000Z',
      }
      rows.push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = rows.find(candidate => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-09-10T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      const filtered = tableRows.filter(row => matchesWhere(row, options.where || {}))
      const ordered = options.orderBy && options.orderBy[0] === 'created_at'
        ? filtered.slice().sort((a, b) => {
            const delta = Date.parse(b.created_at) - Date.parse(a.created_at)
            // Deliberately NOT stable-by-insertion for equal keys: the DB gives no such promise
            // either, so ties are decided by the registry's own merge order, not by this fake.
            return delta === 0 ? String(a.id).localeCompare(String(b.id)) : delta
          })
        : filtered
      const offset = options.offset || 0
      return ordered.slice(offset, offset + (options.limit || 1000))
    },
    async countRows(table, where) {
      calls.push(['countRows', table, { ...where }])
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      return tableRows.filter(row => matchesWhere(row, where)).length
    },
    async deleteRows(table, where) {
      calls.push(['deleteRows', table, { ...where }])
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      const before = tableRows.length
      for (let index = tableRows.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(tableRows[index], where)) tableRows.splice(index, 1)
      }
      return before - tableRows.length
    },
  }
}

function seed(db, overrides) {
  const row = {
    id: 'sys',
    connection_id: null,
    tenant_id: 'tenant_a',
    workspace_id: null,
    project_id: null,
    name: 'seeded',
    kind: 'http',
    role: 'source',
    config: {},
    capabilities: {},
    status: 'active',
    credentials_encrypted: null,
    last_tested_at: null,
    last_error: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
  db.rows.push(row)
  return row
}

function createRegistry(db) {
  return createExternalSystemRegistry({
    db,
    credentialStore: createCredentialStore(),
    idGenerator: () => `sys_${db.rows.length + 1}`,
  })
}

// L-01 --------------------------------------------------------------------
// The failing screen, minimally: the source is tenant-wide, the workbench asks with its own hint.
async function testTenantWideRowIsVisibleToHintedCaller() {
  const db = createMockDb()
  seed(db, { id: 'sys_tenant_wide', workspace_id: null, name: '客户 PLM' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_tenant_wide'],
    'L-01: a non-null hint must fall back to the same tenant\'s tenant-wide rows')
  assert.equal(listed[0].workspaceId, null, 'L-01: the row keeps its OWN scope in the projection')

  // Both branches must be tenant-scoped queries — the literal where-clause, so that deleting
  // `tenant_id` from the fallback is visible here too and not only through L-04's row set.
  const wheres = db.selectCalls().map(([, , options]) => options.where)
  assert.equal(wheres.length, 2, 'L-01: a non-null hint issues exactly two scoped queries')
  for (const where of wheres) {
    assert.equal(where.tenant_id, 'tenant_a', 'L-01: every branch carries the caller\'s own tenant')
  }
  assert.deepEqual(wheres.map((where) => where.workspace_id), ['default', null],
    'L-01: the branches are the caller\'s workspace and the tenant-wide scope, nothing else')
}

// L-02 --------------------------------------------------------------------
async function testWorkspaceRowIsNotDuplicated() {
  const db = createMockDb()
  seed(db, { id: 'sys_ws', workspace_id: 'default', name: 'ws row' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_ws'],
    'L-02: an exact-scope row is returned exactly once, never doubled by the fallback branch')
}

// L-03 --------------------------------------------------------------------
async function testBothScopesMergeOncePreferringExactOnTies() {
  const db = createMockDb()
  seed(db, { id: 'sys_null_old', workspace_id: null, created_at: '2026-09-01T00:00:00.000Z' })
  seed(db, { id: 'sys_ws_new', workspace_id: 'default', created_at: '2026-09-03T00:00:00.000Z' })
  seed(db, { id: 'sys_null_new', workspace_id: null, created_at: '2026-09-05T00:00:00.000Z' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_null_new', 'sys_ws_new', 'sys_null_old'],
    'L-03: the merge keeps the single-query order (created_at DESC) across both scopes')
  assert.equal(new Set(listed.map((system) => system.id)).size, listed.length,
    'L-03: every row appears exactly once')

  // TIE-BREAK, stated口径: equal created_at -> the exact-scope row first (the merge concatenates the
  // exact branch ahead of the tenant-wide one and Array.prototype.sort is stable).
  const tieDb = createMockDb()
  seed(tieDb, { id: 'sys_tie_null', workspace_id: null, created_at: '2026-09-04T00:00:00.000Z' })
  seed(tieDb, { id: 'sys_tie_ws', workspace_id: 'default', created_at: '2026-09-04T00:00:00.000Z' })
  const tied = await createRegistry(tieDb).listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.deepEqual(tied.map((system) => system.id), ['sys_tie_ws', 'sys_tie_null'],
    'L-03: on an equal created_at the workspace-scoped row wins')
}

// L-04 --------------------------------------------------------------------
// THE TENANT FENCE. Mutation probe: drop `tenant_id` from the fallback where-clause -> red.
async function testOtherTenantsTenantWideRowIsNeverListed() {
  const db = createMockDb()
  seed(db, { id: 'sys_other_tenant_null', tenant_id: 'tenant_b', workspace_id: null })
  seed(db, { id: 'sys_other_tenant_ws', tenant_id: 'tenant_b', workspace_id: 'default' })
  seed(db, { id: 'sys_mine', tenant_id: 'tenant_a', workspace_id: null })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_mine'],
    'L-04: tenant B\'s rows are unreachable from tenant A\'s hint, tenant-wide ones included')
  for (const system of listed) {
    assert.equal(system.tenantId, 'tenant_a', 'L-04: no foreign tenant row survives the merge')
  }
}

// L-05 --------------------------------------------------------------------
// THE SIBLING-WORKSPACE FENCE. Mutation probe: widen the fallback branch to any workspace -> red.
async function testOtherWorkspaceRowIsNeverListed() {
  const db = createMockDb()
  seed(db, { id: 'sys_ws_a', workspace_id: 'ws-a' })
  seed(db, { id: 'sys_null', workspace_id: null })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'ws-b' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_null'],
    'L-05: a non-null hint reaches the tenant-wide scope and NOTHING else — never a sibling workspace')
}

// L-06 --------------------------------------------------------------------
async function testNullHintIsUnchanged() {
  const db = createMockDb()
  seed(db, { id: 'sys_null', workspace_id: null })
  seed(db, { id: 'sys_ws', workspace_id: 'default' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a' })
  assert.deepEqual(listed.map((system) => system.id), ['sys_null'],
    'L-06: a null hint keeps its exact tenant-wide scope — it never widens to a workspace row')
  assert.equal(db.selectCalls().length, 1, 'L-06: the unhinted path still issues exactly one query')
  assert.deepEqual(db.selectCalls()[0][2].where, { tenant_id: 'tenant_a', workspace_id: null },
    'L-06: unchanged where-clause for the unhinted path')

  const explicitNull = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: null })
  assert.deepEqual(explicitNull.map((system) => system.id), ['sys_null'],
    'L-06: an explicit null hint behaves like an omitted one')
}

// L-07 --------------------------------------------------------------------
// WRITES ARE NOT WIDENED. The read fallback must not move a write's target.
async function testWritesStayOnTheirOwnRow() {
  const db = createMockDb()
  seed(db, { id: 'sys_tenant_wide', workspace_id: null, name: '客户 PLM', status: 'active' })
  const registry = createRegistry(db)

  const created = await registry.upsertExternalSystem({
    tenantId: 'tenant_a',
    workspaceId: 'default',
    name: '客户 PLM',
    kind: 'http',
    role: 'source',
    status: 'active',
  })
  assert.notEqual(created.id, 'sys_tenant_wide',
    'L-07: a hint-carrying upsert of the same NAME creates its own workspace row')
  assert.equal(created.workspaceId, 'default', 'L-07: the new row is scoped to the hint')
  const tenantWide = db.rows.find((row) => row.id === 'sys_tenant_wide')
  assert.equal(tenantWide.updated_at, '2026-09-01T00:00:00.000Z',
    'L-07: the tenant-wide row is not touched by a hinted write')

  // DELETE keeps its exact scope: the tenant-wide row is not deletable through a workspace hint.
  await assert.rejects(
    () => registry.deleteExternalSystem({ tenantId: 'tenant_a', workspaceId: 'default', id: 'sys_tenant_wide' }),
    (error) => error.name === 'ExternalSystemNotFoundError',
    'L-07: delete does not fall back to the tenant-wide row',
  )
  assert.ok(db.rows.some((row) => row.id === 'sys_tenant_wide'), 'L-07: the tenant-wide row survives')

  // ...even though the READ that populates the picker can see it.
  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  assert.ok(listed.some((system) => system.id === 'sys_tenant_wide'),
    'L-07: read widening and write scoping coexist — this is the asymmetry, on purpose')
  // ...and the asymmetry is DECLARED on the row, because one caller of this list renders it as a
  // writable inventory (工作台 连接管理's 编辑/停用/启用/删除). Without the tag the screen offers a 停用
  // that forks a second same-named row and a 删除 that 404s. L-09 pins the tag itself.
  assert.equal(listed.find((system) => system.id === 'sys_tenant_wide').scopeFallback, true,
    'L-07: the row whose delete just 404d is the row the list marks as fallback-reached')
}

// L-08 --------------------------------------------------------------------
async function testFiltersAndPaginationApplyToTheMerge() {
  const db = createMockDb()
  seed(db, { id: 'sys_1', workspace_id: null, kind: 'http', status: 'active', created_at: '2026-09-05T00:00:00.000Z' })
  seed(db, { id: 'sys_2', workspace_id: 'default', kind: 'http', status: 'active', created_at: '2026-09-04T00:00:00.000Z' })
  seed(db, { id: 'sys_3', workspace_id: null, kind: 'http', status: 'inactive', created_at: '2026-09-03T00:00:00.000Z' })
  seed(db, { id: 'sys_4', workspace_id: null, kind: 'erp:k3-wise-webapi', status: 'active', created_at: '2026-09-02T00:00:00.000Z' })
  const registry = createRegistry(db)

  const active = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default', kind: 'http', status: 'active' })
  assert.deepEqual(active.map((system) => system.id), ['sys_1', 'sys_2'],
    'L-08: kind/status filters are applied to BOTH branches')
  for (const [, , options] of db.selectCalls()) {
    assert.equal(options.where.kind, 'http', 'L-08: the kind filter is on every branch')
    assert.equal(options.where.status, 'active', 'L-08: the status filter is on every branch')
  }

  const firstPage = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default', limit: 2 })
  assert.deepEqual(firstPage.map((system) => system.id), ['sys_1', 'sys_2'], 'L-08: limit cuts the merged page')
  const secondPage = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default', limit: 2, offset: 2 })
  assert.deepEqual(secondPage.map((system) => system.id), ['sys_3', 'sys_4'],
    'L-08: offset walks the MERGE, not one branch')

  await assert.rejects(
    () => registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default', status: 'bogus' }),
    (error) => error.name === 'ExternalSystemValidationError',
    'L-08: status validation is unchanged by the fallback',
  )
}

// L-09 --------------------------------------------------------------------
// THE TAG A WRITABLE LIST KEYS ON. `scopeFallback` says "your own write scope does not contain this
// row" — the SAME rows `findExisting`/`deleteExternalSystem` (both exact) cannot reach. Drop the tag
// and the workbench re-offers 停用/删除 on a tenant-wide row: the 停用 forks a second same-named row
// (migration 057's unique index is (tenant_id, coalesce(workspace_id,''), name), so both are legal)
// and reports success while the real row stays active.
async function testFallbackReachedRowsAreTagged() {
  const db = createMockDb()
  seed(db, { id: 'sys_ws', workspace_id: 'default', created_at: '2026-09-05T00:00:00.000Z' })
  seed(db, { id: 'sys_tenant_wide', workspace_id: null, created_at: '2026-09-04T00:00:00.000Z' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  const byId = new Map(listed.map((system) => [system.id, system]))
  assert.equal(byId.get('sys_tenant_wide').scopeFallback, true,
    'L-09: a row the fallback branch produced is tagged')
  assert.ok(!('scopeFallback' in byId.get('sys_ws')),
    'L-09: a row in the SAME scope the caller writes in carries no tag at all — its writes land')

  // A null hint reads tenant-wide rows in its own EXACT scope: its writes land on them, so nothing
  // is tagged. The tag tracks "unreachable by MY writes", not "the row is tenant-wide".
  const unhinted = await registry.listExternalSystems({ tenantId: 'tenant_a' })
  assert.deepEqual(unhinted.map((system) => system.id), ['sys_tenant_wide'])
  assert.ok(!('scopeFallback' in unhinted[0]),
    'L-09: the unhinted caller writes in the same scope it read, so the row is not tagged')

  // The tag is a projection-level statement, not new disclosure: the row already names its own
  // scope, and that is what the tag restates.
  assert.equal(byId.get('sys_tenant_wide').workspaceId, null,
    'L-09: the tag says the same thing the projection already said')
}

const CASES = {
  'L-01': testTenantWideRowIsVisibleToHintedCaller,
  'L-02': testWorkspaceRowIsNotDuplicated,
  'L-03': testBothScopesMergeOncePreferringExactOnTies,
  'L-04': testOtherTenantsTenantWideRowIsNeverListed,
  'L-05': testOtherWorkspaceRowIsNeverListed,
  'L-06': testNullHintIsUnchanged,
  'L-07': testWritesStayOnTheirOwnRow,
  'L-08': testFiltersAndPaginationApplyToTheMerge,
  'L-09': testFallbackReachedRowsAreTagged,
}

async function main() {
  for (const [id, run] of Object.entries(CASES)) {
    await run()
    console.log(`  ${id} OK`)
  }
  console.log('✓ external-systems: list non-null workspace hint fallback tests passed')
}

// Exported ONE CASE AT A TIME so a mutation probe can point at the single case a given mutation is
// contracted to kill, instead of reading whichever assertion the sequential run happens to hit first.
module.exports = { CASES }

if (require.main === module) {
  main().catch((error) => {
    console.error('✗ external-systems list workspace fallback FAILED')
    console.error(error)
    process.exit(1)
  })
}
