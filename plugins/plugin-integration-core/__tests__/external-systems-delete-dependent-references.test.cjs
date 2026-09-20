'use strict'

// 外接源删除守卫的二阶指针计数 —— `deleteExternalSystem` in `lib/external-systems.cjs`.
//
// THE HOLE. The delete guard counted ONE table: `integration_pipelines`. Two other tables hold a
// persisted pointer AT an external system, both deliberately without a foreign key:
//   * `integration_stock_prep_source_binding.external_system_id` (079:45) —— 工作台里选源 的
//     持久化绑定;
//   * `integration_read_source_configs.system_id` (062:27) —— read-source 自助配置版本.
// Neither was counted, so 删掉外接源 left them dangling, and the dangle is what opens the
// SECOND-ORDER hole one level down: `DataSourceManager.countExternalSystemReferences` counts
// external systems, so once the system is gone the data source it named counts zero references and
// is itself deletable — while 079/062 still point at nothing and the operator still believes the
// binding is live.
//
// WHAT THIS FILE PINS
//   B-01 079 binding (tenant-wide row) vs workspace-scoped system -> 409, row survives
//   B-02 079 binding in ANOTHER workspace vs tenant-wide system   -> 409 (the count is NOT
//        workspace-filtered, in EITHER direction)
//   B-03 062 draft      -> 409
//   B-04 062 approved   -> 409
//   B-05 062 retired ONLY -> deleted (retired is terminal history, not a live pointer)
//   B-06 both tables absent (SQLSTATE 42P01, zh_CN message) -> deleted
//   B-07 079 count fails with another SQLSTATE -> propagates, row survives
//   B-08 062 count fails with another SQLSTATE -> propagates, row survives
//   B-09 another TENANT's 079/062 rows -> never counted
//   B-10 another SYSTEM's rows in the same tenant -> never counted
//   B-11 the pipeline conflict keeps its exact wire message and gains `referencedBindingCount`
//
// WHY B-02 IS THE LOAD-BEARING ONE. 079 rows are legitimately tenant-wide (`workspace_id` nullable,
// 079:43) and the READ path resolves a tenant-wide caller onto a workspace-scoped binding through
// the `single_workspace_binding` fallback (`lib/http-routes.cjs:4617-4626`). A workspace-filtered
// count would therefore miss rows the reader can still reach — a guard that goes green while a live
// pointer exists.
//
// MUTATIONS — executed, not described. Each one recompiles the module source IN MEMORY (node:module
// `_compile` on a patched string; nothing is written to disk, the on-disk file is never touched, and
// the unpatched module stays loaded) and asserts the named case actually flips:
//   M-1 drop the 079 count            -> B-01 flips to a successful delete
//   M-2 widen 062 to include retired  -> B-05 flips to 409
//   M-3 judge 42P01 by message prose  -> B-06 flips to a propagated error (zh_CN server locale)

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'external-systems.cjs')
const {
  createExternalSystemRegistry,
  ExternalSystemConflictError,
} = require(MODULE_PATH)

const STOCK_PREP_BINDING_TABLE = 'integration_stock_prep_source_binding'
const READ_SOURCE_CONFIG_TABLE = 'integration_read_source_configs'

// --- in-memory mutation harness -------------------------------------------------
function compileWithSource(source) {
  const compiled = new Module(MODULE_PATH, null)
  compiled.filename = MODULE_PATH
  compiled.paths = Module._nodeModulePaths(path.dirname(MODULE_PATH))
  compiled._compile(source, MODULE_PATH)
  return compiled.exports
}

function mutatedRegistryFactory(label, replacements) {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  let patched = source
  for (const [from, to] of replacements) {
    assert.ok(patched.includes(from), `${label}: mutation anchor is missing, the mutation would be vacuous`)
    patched = patched.split(from).join(to)
  }
  assert.notEqual(patched, source, `${label}: mutation changed nothing`)
  const exported = compileWithSource(patched)
  assert.equal(typeof exported.createExternalSystemRegistry, 'function', `${label}: patched module does not export a registry`)
  return exported.createExternalSystemRegistry
}

// --- fakes ----------------------------------------------------------------------
function createCredentialStore() {
  return {
    source: 'test',
    format: 'enc',
    async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value) { return `fp_${Buffer.from(value).toString('hex').slice(0, 8)}` },
  }
}

function sqlError(message, code) {
  return Object.assign(new Error(message), { code })
}

function createMockDb() {
  const tables = new Map()
  const countErrors = new Map()
  const countCalls = []

  function rowsOf(table) {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    countCalls,
    rowsOf,
    insertRaw(table, row) { rowsOf(table).push(row) },
    failCountWith(table, error) { countErrors.set(table, error) },
    async selectOne(table, where) {
      return rowsOf(table).find(row => matchesWhere(row, where)) || null
    },
    async select(table, options = {}) {
      const filtered = rowsOf(table).filter(row => matchesWhere(row, options.where || {}))
      const offset = options.offset || 0
      return filtered.slice(offset, offset + (options.limit || 1000))
    },
    async insertOne(table, row) {
      const stored = {
        ...row,
        created_at: row.created_at || '2026-09-20T00:00:00.000Z',
        updated_at: row.updated_at || '2026-09-20T00:00:00.000Z',
      }
      rowsOf(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rowsOf(table).find(candidate => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set)
      return [row]
    },
    async deleteRows(table, where) {
      const rows = rowsOf(table)
      const before = rows.length
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(rows[index], where)) rows.splice(index, 1)
      }
      return before - rows.length
    },
    async countRows(table, where) {
      countCalls.push([table, { ...where }])
      if (countErrors.has(table)) throw countErrors.get(table)
      return rowsOf(table).filter(row => matchesWhere(row, where)).length
    },
  }
}

async function setupSystem({ factory = createExternalSystemRegistry, workspaceId = null, id = 'sys_bound' } = {}) {
  const db = createMockDb()
  const registry = factory({
    db,
    credentialStore: createCredentialStore(),
    idGenerator: () => id,
  })
  await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    workspaceId,
    name: 'plm-read',
    kind: 'http',
    role: 'source',
    config: { baseUrl: 'https://plm.example.test' },
    status: 'active',
  })
  assert.equal(db.rowsOf('integration_external_systems').length, 1, 'setup created exactly one system row')
  return { db, registry, workspaceId, id }
}

function stockPrepBinding(overrides = {}) {
  return {
    id: 'bind_1',
    tenant_id: 'tenant_1',
    workspace_id: null,
    action_id: 'plm.stock-preparation.pull-bom.v1',
    external_system_id: 'sys_bound',
    ...overrides,
  }
}

function readSourceConfig(overrides = {}) {
  return {
    id: 'cfg_1',
    tenant_id: 'tenant_1',
    workspace_id: null,
    system_id: 'sys_bound',
    object: 'bom',
    mode: 'detail_with_lines',
    status: 'draft',
    version: 1,
    ...overrides,
  }
}

async function deleteAndCatch(registry, { workspaceId = null, id = 'sys_bound' } = {}) {
  try {
    return { result: await registry.deleteExternalSystem({ tenantId: 'tenant_1', workspaceId, id }), error: null }
  } catch (error) {
    return { result: null, error }
  }
}

function assertSurvives(db, label) {
  assert.equal(db.rowsOf('integration_external_systems').length, 1, `${label}: the refused delete left the system row in place`)
}

// --- B-01 / B-02: 079 bindings are counted WITHOUT a workspace filter ------------
async function testStockPrepBindingBlocksDelete() {
  // B-01: the system lives in a workspace, the binding is TENANT-WIDE.
  const scoped = await setupSystem({ workspaceId: 'ws_a' })
  scoped.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding({ workspace_id: null }))
  const blocked = await deleteAndCatch(scoped.registry, { workspaceId: 'ws_a' })
  assert.ok(blocked.error instanceof ExternalSystemConflictError, 'B-01: a tenant-wide 079 binding refuses the delete')
  assert.equal(blocked.error.details.stockPrepSourceBindingCount, 1, 'B-01: the 079 count is reported')
  assert.equal(blocked.error.details.readSourceConfigCount, 0, 'B-01: 062 contributes nothing here')
  assert.equal(blocked.error.details.referencedBindingCount, 1, 'B-01: the dependent total is reported')
  assert.equal(blocked.error.details.referencedPipelineCount, 0, 'B-01: no pipeline is involved')
  assertSurvives(scoped.db, 'B-01')

  // B-02: the mirror image — tenant-wide system, binding in a NON-NULL workspace. A count filtered
  // by the delete's own workspace hint would miss this row in one direction or the other; this pair
  // pins that it misses in NEITHER.
  const tenantWide = await setupSystem({ workspaceId: null })
  tenantWide.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding({ workspace_id: 'ws_a' }))
  const mirrored = await deleteAndCatch(tenantWide.registry, { workspaceId: null })
  assert.ok(mirrored.error instanceof ExternalSystemConflictError, 'B-02: a workspace-scoped 079 binding refuses a tenant-wide delete')
  assert.equal(mirrored.error.details.stockPrepSourceBindingCount, 1, 'B-02: the 079 count is reported')
  assertSurvives(tenantWide.db, 'B-02')

  // The filter that was actually sent carries the tenant and the system id, and NO workspace key.
  const bindingCounts = tenantWide.db.countCalls.filter(([table]) => table === STOCK_PREP_BINDING_TABLE)
  assert.equal(bindingCounts.length, 1, 'B-02: the 079 table is counted exactly once per delete')
  assert.deepEqual(
    Object.keys(bindingCounts[0][1]).sort(),
    ['external_system_id', 'tenant_id'],
    'B-02: the 079 count filters on tenant + system id only — a workspace key would reintroduce the blind spot',
  )
}

// --- B-03 / B-04 / B-05: 062 lifecycle ------------------------------------------
async function testReadSourceConfigLifecycle() {
  for (const status of ['draft', 'approved']) {
    const live = await setupSystem({})
    live.db.insertRaw(READ_SOURCE_CONFIG_TABLE, readSourceConfig({ status }))
    const blocked = await deleteAndCatch(live.registry, {})
    assert.ok(
      blocked.error instanceof ExternalSystemConflictError,
      `B-03/04: a ${status} read-source config refuses the delete`,
    )
    assert.equal(blocked.error.details.readSourceConfigCount, 1, `B-03/04: the ${status} config is counted`)
    assert.equal(blocked.error.details.stockPrepSourceBindingCount, 0, `B-03/04: 079 contributes nothing for ${status}`)
    assertSurvives(live.db, `B-03/04 (${status})`)
  }

  // B-05: retired is TERMINAL (draft -> approved -> retired, `lib/read-source-config-store.cjs:23-28`).
  // A retired version can never become approved again, so it is history; counting it would make the
  // system permanently undeletable for a pointer that can never be used.
  const retired = await setupSystem({})
  retired.db.insertRaw(READ_SOURCE_CONFIG_TABLE, readSourceConfig({ id: 'cfg_retired', status: 'retired' }))
  const allowed = await deleteAndCatch(retired.registry, {})
  assert.equal(allowed.error, null, 'B-05: a retired-only read-source config does not refuse the delete')
  assert.equal(allowed.result.deleted, true, 'B-05: the delete completes')
  assert.equal(retired.db.rowsOf('integration_external_systems').length, 0, 'B-05: the system row is gone')
}

// --- B-06: the tables are not there ---------------------------------------------
async function testAbsentTablesDoNotBlockDelete() {
  const absent = await setupSystem({})
  // A zh_CN server: SQLSTATE 42P01 with prose that contains no English at all. This is why the
  // guard judges the code and never the message (see the 222 PG locale sweep).
  absent.db.failCountWith(STOCK_PREP_BINDING_TABLE, sqlError('错误: 关系 "integration_stock_prep_source_binding" 不存在', '42P01'))
  absent.db.failCountWith(READ_SOURCE_CONFIG_TABLE, sqlError('错误: 关系 "integration_read_source_configs" 不存在', '42P01'))
  const allowed = await deleteAndCatch(absent.registry, {})
  assert.equal(allowed.error, null, 'B-06: a deployment without 079/062 keeps deleting as before')
  assert.equal(allowed.result.deleted, true, 'B-06: the delete completes')
  assert.equal(absent.db.rowsOf('integration_external_systems').length, 0, 'B-06: the system row is gone')
}

// --- B-07 / B-08: every other failure is fail-closed -----------------------------
async function testOtherSqlstatesPropagate() {
  const denied = await setupSystem({})
  denied.db.failCountWith(STOCK_PREP_BINDING_TABLE, sqlError('permission denied for table', '42501'))
  const bindingFailure = await deleteAndCatch(denied.registry, {})
  assert.ok(bindingFailure.error, 'B-07: a non-42P01 failure on the 079 count is not swallowed')
  assert.equal(bindingFailure.error.code, '42501', 'B-07: the original SQLSTATE propagates unchanged')
  assert.ok(!(bindingFailure.error instanceof ExternalSystemConflictError), 'B-07: it is not laundered into a conflict')
  assertSurvives(denied.db, 'B-07')

  const dropped = await setupSystem({})
  dropped.db.failCountWith(READ_SOURCE_CONFIG_TABLE, sqlError('connection terminated', '08006'))
  const configFailure = await deleteAndCatch(dropped.registry, {})
  assert.ok(configFailure.error, 'B-08: a non-42P01 failure on the 062 count is not swallowed')
  assert.equal(configFailure.error.code, '08006', 'B-08: the original SQLSTATE propagates unchanged')
  assertSurvives(dropped.db, 'B-08')
}

// --- B-09 / B-10: the count is bounded by tenant AND by system id -----------------
async function testForeignRowsAreNeverCounted() {
  const isolated = await setupSystem({})
  isolated.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding({ id: 'bind_other_tenant', tenant_id: 'tenant_2' }))
  isolated.db.insertRaw(READ_SOURCE_CONFIG_TABLE, readSourceConfig({ id: 'cfg_other_tenant', tenant_id: 'tenant_2', status: 'approved' }))
  const crossTenant = await deleteAndCatch(isolated.registry, {})
  assert.equal(crossTenant.error, null, 'B-09: another tenant rows never keep this tenant system alive')
  assert.equal(crossTenant.result.deleted, true, 'B-09: the delete completes')

  const other = await setupSystem({})
  other.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding({ id: 'bind_other_system', external_system_id: 'sys_elsewhere' }))
  other.db.insertRaw(READ_SOURCE_CONFIG_TABLE, readSourceConfig({ id: 'cfg_other_system', system_id: 'sys_elsewhere', status: 'approved' }))
  const otherSystem = await deleteAndCatch(other.registry, {})
  assert.equal(otherSystem.error, null, 'B-10: rows pointing at another system are not counted')
  assert.equal(otherSystem.result.deleted, true, 'B-10: the delete completes')
}

// --- B-11: the pipeline conflict is unchanged on the wire -------------------------
async function testPipelineConflictWireShapeUnchanged() {
  const piped = await setupSystem({})
  piped.db.insertRaw('integration_pipelines', {
    id: 'pipe_1',
    tenant_id: 'tenant_1',
    workspace_id: null,
    source_system_id: 'sys_bound',
    target_system_id: 'target_1',
  })
  const blocked = await deleteAndCatch(piped.registry, {})
  assert.ok(blocked.error instanceof ExternalSystemConflictError, 'B-11: a pipeline still refuses the delete')
  assert.equal(blocked.error.message, 'external system is used by pipelines', 'B-11: the pipeline message is byte-identical to what is already on the wire')
  assert.equal(blocked.error.details.referencedPipelineCount, 1, 'B-11: the pipeline count is unchanged')
  assert.equal(blocked.error.details.sourcePipelineCount, 1, 'B-11: the source breakdown is unchanged')
  assert.equal(blocked.error.details.referencedBindingCount, 0, 'B-11: the dependent total is present and zero')
  // values-free: the details carry counts and handles only, never a row id from 079/062.
  assert.deepEqual(
    Object.keys(blocked.error.details).sort(),
    [
      'id', 'readSourceConfigCount', 'referencedBindingCount', 'referencedPipelineCount',
      'sourcePipelineCount', 'stockPrepSourceBindingCount', 'targetPipelineCount', 'tenantId', 'workspaceId',
    ],
    'B-11: the conflict details expose counts and scope handles only',
  )
  assertSurvives(piped.db, 'B-11')
}

// --- mutations --------------------------------------------------------------------
async function testMutationsFlipTheNamedCases() {
  // M-1 — the 079 count is dropped from the returned totals.
  const withoutStockPrepCount = mutatedRegistryFactory('M-1', [
    ['      stockPrepSourceBindingCount,', '      stockPrepSourceBindingCount: 0,'],
  ])
  const m1 = await setupSystem({ factory: withoutStockPrepCount, workspaceId: 'ws_a' })
  m1.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding({ workspace_id: null }))
  const m1Result = await deleteAndCatch(m1.registry, { workspaceId: 'ws_a' })
  assert.equal(m1Result.error, null, 'M-1: without the 079 count the delete goes through — B-01 is load-bearing')
  assert.equal(m1.db.rowsOf('integration_external_systems').length, 0, 'M-1: the mutant really deletes the bound system')

  // M-2 — 062 is widened to include the terminal `retired` state.
  const retiredCounted = mutatedRegistryFactory('M-2', [
    ["Object.freeze(['draft', 'approved'])", "Object.freeze(['draft', 'approved', 'retired'])"],
  ])
  const m2 = await setupSystem({ factory: retiredCounted })
  m2.db.insertRaw(READ_SOURCE_CONFIG_TABLE, readSourceConfig({ id: 'cfg_retired', status: 'retired' }))
  const m2Result = await deleteAndCatch(m2.registry, {})
  // NOTE the `name` check rather than `instanceof`: a mutant is a SEPARATE module instance, so its
  // error classes are distinct constructors. `name` is what the HTTP layer keys on anyway
  // (`http-routes.cjs:871` tests the name for /Conflict/), so this is the production predicate.
  assert.equal(m2Result.error && m2Result.error.name, 'ExternalSystemConflictError', 'M-2: counting retired refuses a delete B-05 allows')
  assert.equal(m2.db.rowsOf('integration_external_systems').length, 1, 'M-2: the mutant blocks the delete')

  // M-3 — the missing-table judgement is moved from SQLSTATE to message prose. On a zh_CN server
  // the English text never appears, so the guard stops recognising its own tolerated case and a
  // deployment without 079/062 can no longer delete anything.
  const messageJudged = mutatedRegistryFactory('M-3', [
    ['error.code === UNDEFINED_TABLE_SQLSTATE', '/does not exist/.test(String(error && error.message))'],
  ])
  const m3 = await setupSystem({ factory: messageJudged })
  m3.db.failCountWith(STOCK_PREP_BINDING_TABLE, sqlError('错误: 关系 "integration_stock_prep_source_binding" 不存在', '42P01'))
  m3.db.failCountWith(READ_SOURCE_CONFIG_TABLE, sqlError('错误: 关系 "integration_read_source_configs" 不存在', '42P01'))
  const m3Result = await deleteAndCatch(m3.registry, {})
  assert.ok(m3Result.error, 'M-3: judging by prose makes the zh_CN 42P01 propagate — B-06 is load-bearing')
  assert.equal(m3Result.error.code, '42P01', 'M-3: the tolerated case is exactly what now escapes')
  assert.equal(m3.db.rowsOf('integration_external_systems').length, 1, 'M-3: the mutant refuses a delete B-06 allows')

  // The unpatched module is untouched by all of the above.
  const intact = await setupSystem({})
  intact.db.insertRaw(STOCK_PREP_BINDING_TABLE, stockPrepBinding())
  const intactResult = await deleteAndCatch(intact.registry, {})
  assert.ok(intactResult.error instanceof ExternalSystemConflictError, 'the in-memory mutants did not leak into the loaded module')
}

async function main() {
  await testStockPrepBindingBlocksDelete()
  await testReadSourceConfigLifecycle()
  await testAbsentTablesDoNotBlockDelete()
  await testOtherSqlstatesPropagate()
  await testForeignRowsAreNeverCounted()
  await testPipelineConflictWireShapeUnchanged()
  await testMutationsFlipTheNamedCases()
  console.log('✓ external-systems delete guard: 079/062 second-order references counted')
}

main().catch((error) => {
  console.error('✗ external-systems-delete-dependent-references FAILED')
  console.error(error)
  process.exit(1)
})
