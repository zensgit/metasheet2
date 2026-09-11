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
//   L-07 writes (name-only upsert / delete)        -> unchanged: a hint-carrying write stays in its
//                                                     own scope; the tenant-wide row is not touched
//   L-08 filters + pagination                      -> kind/status apply to both branches, and the
//                                                     page is cut from the MERGE
//   L-09 the projection                            -> unchanged shape: the widening adds NO field.
//                                                     `workspaceId` is what a writable list keys on
//   L-10 hinted upsert CARRYING THE ROW'S ID       -> the shape 编辑/停用/启用 actually send: refused
//                                                     server-side, 409 EXTERNAL_SYSTEM_SCOPE_MISMATCH
//   L-11 the test-connection write                 -> NOT refused: it re-addresses the row's own
//                                                     scope and lands, by design (#5534)
//
// THE ASYMMETRY, STATED HONESTLY (L-10 + L-11 together). "This row is in a scope your writes do not
// address" is NOT "this row is read-only". The buttons that miss are 编辑 / 停用 / 启用 / 删除. The
// one that does NOT miss is 测试连接: `persistExternalSystemTestResult` (lib/http-routes.cjs, #5534)
// deliberately re-addresses its write to the row's OWN scope, so a hinted caller does change this
// row's status / last_tested_at / last_error (a failed test flips active -> error). Both halves are
// pinned here so no comment or UI string can claim blanket read-only again.
//
// MUTATION EVIDENCE (probed in memory against a patched copy of the module source, then reverted —
// nothing is written to disk by this file):
//   * drop `tenant_id` from the fallback branch's where-clause -> L-04 goes red;
//   * replace the fallback branch's `workspace_id: null` with "any workspace" -> L-05 goes red;
//   * delete the `assertHintedIdDoesNotTargetTenantWideRow` call in `upsertExternalSystem` -> L-10
//     goes red (the insert branch runs and dies on this file's id primary key instead).

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
      // MIGRATION 057's TWO CONSTRAINTS, enforced here because L-07 and L-10 differ precisely in
      // WHICH of them an insert would hit. A fake without them cannot tell the two outcomes apart,
      // which is exactly how an earlier revision of this file ended up endorsing "停用 silently
      // forks a same-named row" with a case that never sent an id:
      //   * `id TEXT PRIMARY KEY` (057:20)  -> re-using an existing id raises 23505. This is what an
      //     id-carrying upsert does after `findExisting` misses in the caller's exact scope, and it
      //     is what L-10's server-side refusal now prevents from ever being reached.
      //   * `uniq_integration_external_systems_scope_name` on
      //     (tenant_id, coalesce(workspace_id,''), name) (057:42) -> a NAME-ONLY upsert CAN fork a
      //     same-named row into a different workspace, and only that (L-07).
      if (rows.some(existing => existing.id === row.id)) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "integration_external_systems_pkey"'),
          { code: '23505', constraint: 'integration_external_systems_pkey' },
        )
      }
      if (rows.some(existing => (
        existing.tenant_id === row.tenant_id
        && (existing.workspace_id ?? '') === (row.workspace_id ?? '')
        && existing.name === row.name
      ))) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "uniq_integration_external_systems_scope_name"'),
          { code: '23505', constraint: 'uniq_integration_external_systems_scope_name' },
        )
      }
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
//
// THE SHAPE THIS CASE EXERCISES IS NAME-ONLY (no id) — a direct API/script call. It is the ONLY
// shape that forks a same-named row into the hinted workspace. The workbench's 编辑/停用/启用 do NOT
// use it: they carry the row's id, and that shape is L-10's. This distinction is the whole point of
// splitting the two cases — this file used to assert the name-only outcome and then let comments
// (here, in lib/external-systems.cjs, in the web service layer and in the commit message) attribute
// it to 停用.
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
  // The row the delete just 404d names its OWN scope in the projection, and that — compared against
  // the hint the caller's next write will carry — is what a writable list keys on. No extra field is
  // emitted to say it a second time (L-09).
  assert.equal(listed.find((system) => system.id === 'sys_tenant_wide').workspaceId, null,
    'L-07: the row whose delete just 404d reports the scope that delete would have had to use')
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
// THE PROJECTION IS UNCHANGED — THE WIDENING ADDS NO FIELD.
//
// An earlier revision tagged fallback-branch rows `scopeFallback: true` so a writable list could
// key on it. That is dropped, and pinned dropped, because:
//   (1) its stated justification ("otherwise 停用 silently forks a same-named row and reports
//       success") is false — L-10 measures what 停用 actually does;
//   (2) it is derivable from `workspaceId`, which this projection has always carried, compared with
//       the hint the consumer's own write will carry — and that derivation is strictly better,
//       because a tag is pinned to the FETCH while the write's hint is LIVE (apps/web's workbench
//       lets the operator edit the workspace box without reloading the list, so a stale tag would
//       go on refusing the very tenant-level write the UI told them to make);
//   (3) this plugin already uses the name `scopeFallback` for a different, string-valued,
//       internal-only annotation — stock-preparation-source-binding-routes.test.cjs asserts
//       "scopeFallback never reaches the wire" about it.
// So this case asserts the ABSENCE, and asserts the field a consumer must use instead.
async function testProjectionCarriesNoExtraScopeField() {
  const db = createMockDb()
  seed(db, { id: 'sys_ws', workspace_id: 'default', created_at: '2026-09-05T00:00:00.000Z' })
  seed(db, { id: 'sys_tenant_wide', workspace_id: null, created_at: '2026-09-04T00:00:00.000Z' })
  const registry = createRegistry(db)

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_a', workspaceId: 'default' })
  const byId = new Map(listed.map((system) => [system.id, system]))
  for (const system of listed) {
    assert.ok(!('scopeFallback' in system),
      `L-09: ${system.id} — the widened list emits no scopeFallback field`)
  }

  // What a consumer DOES key on: each row's own scope, which separates these two rows exactly as
  // the dropped tag did.
  assert.equal(byId.get('sys_tenant_wide').workspaceId, null,
    'L-09: the fallback-reached row reports its own (tenant-wide) scope')
  assert.equal(byId.get('sys_ws').workspaceId, 'default',
    'L-09: the exact-scope row reports the scope the caller writes in')

  // Same keys as the un-widened (null-hint) path: the two projections are shape-identical, so no
  // consumer can come to depend on a field only one of them produces.
  const unhinted = await registry.listExternalSystems({ tenantId: 'tenant_a' })
  assert.deepEqual(unhinted.map((system) => system.id), ['sys_tenant_wide'])
  assert.deepEqual(
    Object.keys(unhinted[0]).sort(),
    Object.keys(byId.get('sys_tenant_wide')).sort(),
    'L-09: a fallback-reached row has exactly the keys the same row has when read in its own scope',
  )
}

// L-10 --------------------------------------------------------------------
// WHAT THE WORKBENCH'S WRITE BUTTONS ACTUALLY DO TO A FALLBACK-REACHED ROW — AND THE SERVER-SIDE
// REFUSAL THAT MAKES THE SCREEN'S CLAIM TRUE.
//
// 编辑 / 停用 / 启用 send the ROW'S OWN id (apps/web/src/views/IntegrationWorkbenchView.vue's
// deactivateConnection: `{ ...currentScope(), id: system.id, name, kind, role, status: 'inactive' }`).
// `findExisting` therefore takes its id branch, misses in the caller's exact (hinted) scope, and
// `assertHintedIdDoesNotTargetTenantWideRow` refuses with a stable 409 code.
//
// WITHOUT that guard the INSERT branch re-used the same id (`id: normalized.id || idGenerator()`)
// and the outcome depended on the db handle: real PG raised 23505 on `id TEXT PRIMARY KEY` (an
// untyped 500 carrying driver text), while a fake without that key silently wrote a SECOND row with
// a DUPLICATE id. Greying the button out in the browser closes neither — the route is reachable
// without the browser. Hence the refusal lives here.
async function testHintedIdCarryingUpsertIsRefusedServerSide() {
  const db = createMockDb()
  const tenantWide = seed(db, { id: 'sys_tenant_wide', workspace_id: null, name: '客户 PLM', status: 'active' })
  const registry = createRegistry(db)

  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_a',
      workspaceId: 'default',
      id: 'sys_tenant_wide',
      name: '客户 PLM',
      kind: 'http',
      role: 'source',
      status: 'inactive',
    }),
    (error) => {
      assert.equal(error.name, 'ExternalSystemConflictError',
        'L-10: a scope mismatch is a CONFLICT (409 via inferHttpStatus), not a 500 and not a 404')
      assert.equal(error.code, 'EXTERNAL_SYSTEM_SCOPE_MISMATCH',
        'L-10: with a stable wire code — `inferErrorCode` prefers error.code over error.name')
      return true
    },
    'L-10: a hinted, id-carrying upsert of a tenant-wide row is refused',
  )

  assert.equal(tenantWide.status, 'active', 'L-10: the tenant-wide row keeps its status')
  assert.equal(tenantWide.workspace_id, null, 'L-10: ...and its scope')
  assert.equal(tenantWide.updated_at, '2026-09-01T00:00:00.000Z', 'L-10: ...and was never updated')
  assert.equal(db.rows.length, 1,
    'L-10: no second row — the refusal happens BEFORE the insert branch, so the duplicate id is never attempted')
  assert.ok(!db.calls.some(([name]) => name === 'insertOne'),
    'L-10: ...and the insert is never even issued to the db')

  // THE GUARD IS ONE STEP, NOT A GLOBAL ID PROBE. Another tenant's rows must not make this caller's
  // create a "conflict" — that would answer a question about rows this caller can neither read nor
  // list, and it would break ordinary creation.
  const otherTenantDb = createMockDb()
  seed(otherTenantDb, { id: 'sys_b', tenant_id: 'tenant_b', workspace_id: null, name: 'B 的源' })
  const otherTenantRegistry = createRegistry(otherTenantDb)
  const inserted = await otherTenantRegistry.upsertExternalSystem({
    tenantId: 'tenant_a',
    workspaceId: 'default',
    id: 'sys_a_new',
    name: 'A 的源',
    kind: 'http',
    role: 'source',
    status: 'active',
  })
  assert.equal(inserted.workspaceId, 'default',
    'L-10: an ordinary hinted create is untouched by the guard')
}

// L-11 --------------------------------------------------------------------
// THE OTHER HALF OF THE ASYMMETRY: THE ONE WRITE THAT IS *SUPPOSED* TO REACH THIS ROW.
//
// `POST /api/integration/external-systems/:id/test` loads the system through the by-id fallback
// (#5471) and then `persistExternalSystemTestResult` (lib/http-routes.cjs, #5534) re-addresses the
// status write to `system.workspaceId ?? null` — the ROW'S own scope, not the caller's hint —
// precisely so the tested status lands instead of falling into the insert branch. This case
// reproduces those two steps against the real registry and pins that L-10's guard does not break
// them; the end-to-end route assertion lives in http-routes.test.cjs
// (testExternalSystemTestSavesUnderMatchedScope).
//
// WHY IT IS PINNED HERE. It is the counter-example to "a fallback-reached row is read-only". It is
// not: a failed test flips such a row active -> error for every workspace of the tenant. Any comment
// or UI string in this line must enumerate 编辑/停用/启用/删除 rather than say 只读.
async function testTestConnectionWriteStillLandsOnTheFallbackReachedRow() {
  const db = createMockDb()
  const tenantWide = seed(db, { id: 'sys_tenant_wide', workspace_id: null, name: '客户 PLM', status: 'active' })
  const registry = createRegistry(db)

  // STEP 1 — the hinted by-id load the route performs (`getExternalSystemForAdapter`).
  const loaded = await registry.getExternalSystemForAdapter({
    tenantId: 'tenant_a', workspaceId: 'default', id: 'sys_tenant_wide',
  })
  assert.equal(loaded.workspaceId, null,
    'L-11: the hinted load reaches the tenant-wide row and reports the scope it matched under')

  // STEP 2 — persistExternalSystemTestResult's retarget, verbatim: the caller's hint is replaced by
  // the loaded row's own scope before the upsert.
  const failed = await registry.upsertExternalSystem({
    tenantId: 'tenant_a',
    workspaceId: loaded.workspaceId ?? null,
    id: loaded.id,
    name: loaded.name,
    kind: loaded.kind,
    role: loaded.role,
    status: 'error',
    lastTestedAt: '2026-09-10T02:00:00.000Z',
    lastError: 'connection test failed',
  })

  assert.equal(failed.id, 'sys_tenant_wide', 'L-11: the write lands on the row that was read')
  assert.equal(db.rows.length, 1, 'L-11: no second row — this is an UPDATE, not the insert branch')
  assert.equal(tenantWide.status, 'error',
    'L-11: a failed test really does flip the tenant-wide row active -> error — it is NOT read-only')
  assert.equal(tenantWide.last_error, 'connection test failed', 'L-11: ...and records the reason')
  assert.equal(tenantWide.last_tested_at, '2026-09-10T02:00:00.000Z', 'L-11: ...and the timestamp')
  assert.equal(tenantWide.workspace_id, null, 'L-11: the row keeps its tenant-wide scope')

  // The SAME payload sent under the caller's hint instead of the row's own scope is the L-10
  // refusal — so the retarget is load-bearing, not incidental.
  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_a',
      workspaceId: 'default',
      id: 'sys_tenant_wide',
      name: loaded.name,
      kind: loaded.kind,
      role: loaded.role,
      status: 'error',
    }),
    (error) => error.code === 'EXTERNAL_SYSTEM_SCOPE_MISMATCH',
    'L-11: without the retarget the very same write is refused — that is what #5534 fixed',
  )
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
  'L-09': testProjectionCarriesNoExtraScopeField,
  'L-10': testHintedIdCarryingUpsertIsRefusedServerSide,
  'L-11': testTestConnectionWriteStillLandsOnTheFallbackReachedRow,
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
