'use strict'

// ---------------------------------------------------------------------------
// 场景 B / Q3a —— 合成 v2 快照经 diff 引擎的四类变更演练（备料路线第 3 步「对账」的合成第一刀）。
//
// 前两刀证的是「读得到」（A1 #5876）与「落得进」（A2 #5877/#5888）。这一刀证的是**比得出**：
// 同一张合成表先后两份内容（ROWS / ROWS_V2，只差四处）各跑一次源运行，落成两个不可变批次，
// 再经**产品自己的**只读 diff 读面把四类变更逐类读出来。
//
// 这条链上跑的全是产品代码，一个都没换：
//   lib/adapters/data-source-sql-readonly-source-adapter.cjs  真适配器
//   lib/read-source-read-runtime.cjs                          真执行器
//   lib/stock-preparation-readonly-source-run.cjs             真 feeder
//   lib/stock-preparation-plm-source-persist-bridge.cjs       真桥
//   lib/stock-preparation-sync-run-persist.cjs                真落库（不可变 / 幂等）
//   lib/stock-preparation-snapshot-reads.cjs                  真只读 diff 读面（含 H-1 完整性门）
//   lib/stock-preparation-snapshot-diff.cjs                   真 diff 引擎（planBomSnapshotDiff）
//   lib/http-routes.cjs                                       真路由 handler（本刀**未改**）
// 被替掉的只有两个宿主注入点：只读 data-source facade 与 multitable records/provisioning
// （内存 staging 落点）。两者都不是任何守卫的背书 —— 它们只提供「行存在于某处」这个事实。
//
// 四类变更（夹具侧 scenario-b-synthetic-bom.cjs 的 ROWS_V2，四处各一）：
//   ① 改数量           -> diffType=changed, changeType=quantity_changed
//   ② 原位物料替换      -> diffType=changed, changeType=component_code_changed
//      （path_key 不变、childDrawingNo 变 —— 引擎正是这么认原位替换的）
//   ③ 新增 1 个子件     -> diffType=added
//   ④ 删除 1 个子件     -> diffType=removed
//   其余 51 行           -> diffType=unchanged
//
// autopersist flag 只在**本测试进程内**被置为 'true'，跑完即还原；生产默认值、模板、文档默认值
// 一律没动（仓库里依旧「不设 = OFF」）。
//
// 变异探针一律**内存级**：readMutatedModule() 读源码、做一处替换、用 Module._compile 编出一个新
// 模块对象。磁盘上的文件一个字节都没改（并发反驳者互撞的老坑）。
//
// Run: node __tests__/scenario-b-v2-snapshot-diff.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const LIB_DIR = path.join(__dirname, '..', 'lib')
const DIFF_ENGINE_PATH = path.join(LIB_DIR, 'stock-preparation-snapshot-diff.cjs')

const fixture = require(path.join(
  __dirname, '..', 'fixtures', 'scenario-b-synthetic-bom', 'scenario-b-synthetic-bom.cjs',
))
const httpRoutes = require(path.join(LIB_DIR, 'http-routes.cjs'))
const { validateReadSourceConfig } = require(path.join(LIB_DIR, 'read-source-config.cjs'))
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require(path.join(LIB_DIR, 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))
const syncRunPersist = require(path.join(LIB_DIR, 'stock-preparation-sync-run-persist.cjs'))
const diffEngine = require(DIFF_ENGINE_PATH)
const { CHANGE_TYPES, DIFF_TYPES, planBomSnapshotDiff } = diffEngine

const AUTOPERSIST_FLAG = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
const CONFIG_ID = 'scenario_b_readsource_1'
const SYSTEM_ID = 'syn-bom-source-b1'
const DATA_SOURCE_ID = 'syn-bom-postgres-b1'
const TENANT_ID = 'tenant_scenario_b'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const BUSINESS_PROJECT_ID = 'business_project_scenario_b'
const PROJECT_NAME = '合成备料项目 B1'
const BATCH_V1 = 'scenario_b_batch_v1'
const BATCH_V2 = 'scenario_b_batch_v2'
const RUN_V1 = 'scenario_b_run_v1'
const RUN_V2 = 'scenario_b_run_v2'
const ADMIN_USER = Object.freeze({
  id: 'user_admin_scenario_b',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin'],
})

const LINE_OBJECT_ID = syncRunPersist.__internals.LINE_TEMPLATE.objectId
const BATCH_OBJECT_ID = syncRunPersist.BATCH_OBJECT_ID

// ── 内存变异探针（A2 同款）────────────────────────────────────────────────────────────────────
function readMutatedModule(filePath, find, replaceWith) {
  const source = fs.readFileSync(filePath, 'utf8')
  const occurrences = source.split(find).length - 1
  assert.equal(occurrences, 1, `变异锚点必须唯一命中一次：${find.slice(0, 60)}…`)
  const mutated = source.split(find).join(replaceWith)
  const mod = new Module(filePath, null)
  mod.filename = filePath
  mod.paths = Module._nodeModulePaths(path.dirname(filePath))
  mod._compile(mutated, filePath)
  return mod.exports
}

// ── 宿主只读 facade 的被动替身（A1/A2 同款）──────────────────────────────────────────────────
function recordingDataSourcesFacade({ rows }) {
  const calls = []
  return {
    calls,
    async test(dataSourceId, principal) {
      calls.push({ method: 'test', dataSourceId, principal })
      return { success: true }
    },
    async getSchema() { return { tables: [] } },
    async getTableInfo() { return { columns: [] } },
    async select(dataSourceId, table, options, principal, strict) {
      calls.push({ method: 'select', dataSourceId, table, options, principal, strict })
      let matched = rows
      if (options && options.where) {
        matched = matched.filter((row) => Object.entries(options.where)
          .every(([column, value]) => String(row[column]) === String(value)))
      }
      const offset = Number.isInteger(options && options.offset) ? options.offset : 0
      const limit = Number.isInteger(options && options.limit) ? options.limit : matched.length
      // pg 把 numeric 作为字符串回吐。
      return { data: matched.slice(offset, offset + limit).map((row) => ({ ...row, qty: String(row.qty) })) }
    },
  }
}

// ── 内存 staging 落点：records + provisioning（A2 同款；读侧也走它）────────────────────────────
function createInMemoryStagingStore() {
  const sheets = new Map()
  const writes = []
  let seq = 0
  let tail = Promise.resolve()
  const sheetFor = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const recordsApi = {
    async queryRecords({ sheetId, filters, limit, offset } = {}) {
      const predicate = filters && typeof filters === 'object' ? filters : {}
      const all = [...sheetFor(sheetId).values()]
        .filter((row) => Object.entries(predicate).every(([key, val]) => row.data[key] === val))
      const from = Number.isInteger(offset) ? offset : 0
      const to = Number.isInteger(limit) ? from + limit : all.length
      return all.slice(from, to).map((row) => ({ id: row.id, sheetId: row.sheetId, data: { ...row.data } }))
    },
    async createRecord({ sheetId, data } = {}) {
      seq += 1
      const id = `rec_scenario_b_v2_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
      writes.push({ op: 'create', sheetId, data: { ...data } })
      return { id, sheetId, data: { ...data } }
    },
    async patchRecord({ sheetId, recordId, changes } = {}) {
      const existing = sheetFor(sheetId).get(recordId)
      if (!existing) throw new Error(`patchRecord: unknown record ${recordId}`)
      const data = { ...existing.data }
      for (const [key, val] of Object.entries(changes || {})) {
        if (val === null) delete data[key]
        else data[key] = val
      }
      sheetFor(sheetId).set(recordId, { id: recordId, sheetId, data })
      writes.push({ op: 'patch', sheetId, data: { ...changes } })
      return { id: recordId, sheetId, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(input, operation) {
      const previous = tail
      let release
      tail = new Promise((resolve) => { release = resolve })
      await previous
      try {
        return await operation(recordsApi)
      } finally {
        release()
      }
    },
  }
  const provisioningApi = {
    async findObjectSheet({ objectId } = {}) { return { id: `sheet_${objectId}` } },
    async resolveFieldIds({ fieldIds } = {}) {
      return Object.fromEntries((fieldIds || []).map((fieldId) => [fieldId, fieldId]))
    },
  }
  const rowsOf = (objectId) => [...sheetFor(`sheet_${objectId}`).values()].map((row) => ({ ...row.data }))
  return { recordsApi, provisioningApi, writes, rowsOf }
}

function throwingStub(name, methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => {
    throw new Error(`${name}.${method} is not exercised by the scenario-B v2 diff drill`)
  }]))
}

function normalizedScenarioBConfig() {
  const validation = validateReadSourceConfig(fixture.readSourceConfig({ systemId: SYSTEM_ID }))
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  return validation.normalized
}

// 真适配器 + 真配置 + 真 http-routes handler 的装配。`rows` 决定这次源运行看到的表内容。
function createScenarioBHarness({ recordsApi, provisioningApi, rows }) {
  const config = normalizedScenarioBConfig()
  const dataSources = recordingDataSourcesFacade({ rows })
  const externalWriteCalls = []
  const context = {
    api: {
      http: { addRoute() {} },
      multitable: { provisioning: provisioningApi, records: recordsApi },
      dataSources,
    },
    storage: { durable: false, async get() { return null }, async set() {}, async delete() {}, async list() { return [] } },
    config: {},
  }
  const services = {
    externalSystemRegistry: {
      ...throwingStub('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystemForAdapter(input) {
        return { id: input.id, tenantId: input.tenantId, kind: ADAPTER_KIND, role: 'source', config: { dataSourceId: DATA_SOURCE_ID }, credentials: {} }
      },
    },
    adapterRegistry: {
      listAdapterKinds() { return [ADAPTER_KIND] },
      createAdapter(system, options = {}) {
        const adapter = createDataSourceSqlReadonlySourceAdapter({ system, context, principal: options.principal })
        return {
          ...adapter,
          async upsert(input) { externalWriteCalls.push(['upsert', input]); return adapter.upsert(input) },
        }
      },
    },
    readSourceConfigStore: {
      ...throwingStub('readSourceConfigStore', ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit']),
      async getForRuntime(input) {
        assert.equal(input.id, CONFIG_ID, 'the approved config is selected by id only')
        return { id: CONFIG_ID, status: 'approved', systemId: SYSTEM_ID, config }
      },
    },
    readSourceCompositionConfigStore: throwingStub('readSourceCompositionConfigStore', ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: throwingStub('bridgeAgentChecklistStore', ['saveVersion', 'approve', 'retire', 'getForApply']),
    pipelineRegistry: throwingStub('pipelineRegistry', ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: throwingStub('pipelineRunner', ['runPipeline']),
    deadLetterStore: throwingStub('deadLetterStore', ['listDeadLetters']),
    stagingInstaller: throwingStub('stagingInstaller', ['installStaging', 'listStagingDescriptors']),
    templateRegistry: throwingStub('templateRegistry', ['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
  }
  const handlers = httpRoutes.createHandlers(services, { context, logger: { warn() {}, error() {}, info() {} } })
  return { handlers, dataSources, externalWriteCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

// registerIntegrationRoutes 的 try/catch→sendError 包装在这里复刻（用模块自己导出的 sendError）。
async function invokeHandler(harness, handlerName, req = {}) {
  const res = createResponse()
  try {
    await harness.handlers[handlerName]({
      user: req.user,
      body: req.body || {},
      query: req.query || {},
      params: req.params || {},
      authenticatedTenantId: req.authenticatedTenantId,
    }, res)
  } catch (error) {
    httpRoutes.__internals.sendError(res, error)
  }
  assert.notEqual(res.body, undefined, `${handlerName} produced a JSON body`)
  return res
}

function sourceRunBody(overrides = {}) {
  return {
    workspaceId: 'workspace_scenario_b',
    projectId: BUSINESS_PROJECT_ID,
    sourceProjectNo: fixture.PROJECT_NO,
    projectName: PROJECT_NAME,
    readSourceConfigId: CONFIG_ID,
    syncRunId: RUN_V1,
    snapshotBatchId: BATCH_V1,
    snapshotVersion: 1,
    ...overrides,
  }
}

function withEnv(name, value, run) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return Promise.resolve().then(run).finally(() => {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  })
}
const withAutoPersist = (value, run) => withEnv(AUTOPERSIST_FLAG, value, run)

function deepStringIncludes(value, needle) {
  return JSON.stringify(value === undefined ? null : value).includes(needle)
}

// v1 + v2 两次源运行落成两个不可变批次。返回 store（读侧接着用同一个落点）。
async function persistBothBatches() {
  const store = createInMemoryStagingStore()

  const first = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS })
  const v1 = await invokeHandler(first, 'stockPreparationPlmBomSourceRun', { user: ADMIN_USER, body: sourceRunBody() })
  assert.equal(v1.statusCode, 201, 'v1 源运行落了行')
  assert.equal(v1.body.data.autoPersist.created.lines, fixture.ROW_COUNT)

  const second = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 })
  const v2 = await invokeHandler(second, 'stockPreparationPlmBomSourceRun', {
    user: ADMIN_USER,
    body: sourceRunBody({ syncRunId: RUN_V2, snapshotBatchId: BATCH_V2, snapshotVersion: 2 }),
  })
  assert.equal(v2.statusCode, 201, 'v2 源运行落了新批次')
  assert.equal(v2.body.data.autoPersist.created.lines, fixture.ROW_COUNT_V2)

  return { store, externalWriteCalls: [...first.externalWriteCalls, ...second.externalWriteCalls] }
}

function linesOfBatch(store, snapshotBatchId) {
  return store.rowsOf(LINE_OBJECT_ID).filter((row) => row.snapshotBatchId === snapshotBatchId)
}

function countByDiffType(diffs) {
  const out = {}
  for (const diff of diffs) out[diff.diffType] = (out[diff.diffType] || 0) + 1
  return out
}

function countByChangeType(diffs) {
  const out = {}
  for (const diff of diffs) for (const changeType of diff.changeTypes || []) out[changeType] = (out[changeType] || 0) + 1
  return out
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 断言 1：两个批次真的独立落库，旧批次不可变
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testTwoImmutableBatchesLand() {
  await withAutoPersist('true', async () => {
    const { store } = await persistBothBatches()

    assert.equal(fixture.ROW_COUNT, 54)
    assert.equal(fixture.ROW_COUNT_V2, 54)
    assert.equal(store.rowsOf(BATCH_OBJECT_ID).length, 2, '两个批次行')
    assert.equal(store.rowsOf(LINE_OBJECT_ID).length, 108, '两批次各 54 行，互不覆盖')
    assert.equal(store.writes.filter((write) => write.op === 'patch' && write.sheetId === `sheet_${LINE_OBJECT_ID}`).length, 0,
      '这条路径从不 patch 快照行')

    // 批次 1 的 54 行与 v1 夹具逐 pathKey 对得上（v2 没有回头改过它们）。
    const v1Paths = new Set(linesOfBatch(store, BATCH_V1).map((row) => row.pathKey))
    assert.equal(v1Paths.size, 54)
    assert.equal(v1Paths.has(fixture.V2_REMOVED_PATH_KEY), true, '被删的那一行只存在于批次 1')
    assert.equal(v1Paths.has(fixture.V2_ADDED_PATH_KEY), false, '新增的那一行不在批次 1')

    const v2Paths = new Set(linesOfBatch(store, BATCH_V2).map((row) => row.pathKey))
    assert.equal(v2Paths.has(fixture.V2_REMOVED_PATH_KEY), false)
    assert.equal(v2Paths.has(fixture.V2_ADDED_PATH_KEY), true)
    // 原位替换：同一个 pathKey 在两批次都在，但 childDrawingNo 换了 —— 这正是 diff 引擎要认的形状。
    const v1Sub = linesOfBatch(store, BATCH_V1).find((row) => row.pathKey === fixture.V2_SUBSTITUTED_PATH_KEY)
    const v2Sub = linesOfBatch(store, BATCH_V2).find((row) => row.pathKey === fixture.V2_SUBSTITUTED_PATH_KEY)
    assert.equal(v1Sub.childDrawingNo, fixture.V2_SUBSTITUTED_FROM_PART_NO)
    assert.equal(v2Sub.childDrawingNo, fixture.V2_SUBSTITUTED_TO_PART_NO)
    assert.equal(v1Sub.designQty, v2Sub.designQty, '替换行只换件号，数量不动')
    assert.equal(v1Sub.childVersion, v2Sub.childVersion, '替换行只换件号，版本不动')
  })
  console.log('  testTwoImmutableBatchesLand OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 断言 2：diff 引擎在两批次上把四类变更逐类分出来（引擎直调 —— 分类逻辑的裸事实）
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testEngineClassifiesFourChangeKinds() {
  await withAutoPersist('true', async () => {
    const { store } = await persistBothBatches()
    const plan = planBomSnapshotDiff({
      previousSnapshotBatchId: BATCH_V1,
      currentSnapshotBatchId: BATCH_V2,
      previousLines: linesOfBatch(store, BATCH_V1),
      currentLines: linesOfBatch(store, BATCH_V2),
    })

    const byDiffType = countByDiffType(plan.diffs)
    const byChangeType = countByChangeType(plan.diffs)

    // 54 个 v1 pathKey，1 个在 v2 消失 -> 53 对被 path 配上；其中 2 对有变更 -> 51 unchanged；
    // 再加 v2 独有 1 行 added、v1 独有 1 行 removed -> 共 55 条。
    assert.equal(plan.diffs.length, fixture.V2_EXPECTED_DIFF.total)
    assert.equal(fixture.V2_EXPECTED_DIFF.total, 55)
    assert.deepEqual(byDiffType, {
      [DIFF_TYPES.CHANGED]: fixture.V2_EXPECTED_DIFF.changedQuantity + fixture.V2_EXPECTED_DIFF.changedComponentCode,
      [DIFF_TYPES.ADDED]: fixture.V2_EXPECTED_DIFF.added,
      [DIFF_TYPES.REMOVED]: fixture.V2_EXPECTED_DIFF.removed,
      [DIFF_TYPES.UNCHANGED]: fixture.V2_EXPECTED_DIFF.unchanged,
    })
    assert.equal(fixture.V2_EXPECTED_DIFF.unchanged, 51)

    // 四类变更逐类点名（不是「有 4 条 diff」这种笼统的数）。
    assert.equal(byChangeType[CHANGE_TYPES.QUANTITY_CHANGED], 1, '① 改数量：恰好一行')
    assert.equal(byChangeType[CHANGE_TYPES.COMPONENT_CODE_CHANGED], 1, '② 原位物料替换：恰好一行')
    assert.equal(byChangeType[CHANGE_TYPES.ADDED], 1, '③ 新增子件：恰好一行')
    assert.equal(byChangeType[CHANGE_TYPES.REMOVED], 1, '④ 删除子件：恰好一行')
    // 两条 changed 各自伴随一次指纹变化；没有任何**其它**变更维度被误报。
    assert.equal(byChangeType[CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED], 2)
    for (const noise of [
      CHANGE_TYPES.UNIT_CHANGED, CHANGE_TYPES.VERSION_CHANGED, CHANGE_TYPES.PATH_CHANGED,
      CHANGE_TYPES.PARENT_CHANGED, CHANGE_TYPES.MATERIAL_CHANGED, CHANGE_TYPES.INVALID_QTY,
      CHANGE_TYPES.MISSING_CHILD_BOM, CHANGE_TYPES.DUPLICATE_PATH_KEY, CHANGE_TYPES.MISSING_PATH_KEY,
    ]) {
      assert.equal(byChangeType[noise], undefined, `未改动的维度不得被报出来：${noise}`)
    }

    // 两条 changed 各自只带自己那一种业务变更（替换那条**不是**靠 quantity 顺带报出来的）。
    const changed = plan.diffs.filter((diff) => diff.diffType === DIFF_TYPES.CHANGED)
    assert.equal(changed.length, 2)
    const changedSets = changed.map((diff) => [...diff.changeTypes].sort().join(','))
    assert.deepEqual(changedSets.slice().sort(), [
      [CHANGE_TYPES.COMPONENT_CODE_CHANGED, CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED].sort().join(','),
      [CHANGE_TYPES.QUANTITY_CHANGED, CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED].sort().join(','),
    ].sort())

    // 四条有变更的行全部 held（BLOCKING_CHANGE_TYPES 覆盖全部变更类型），51 条 unchanged 是 ready。
    assert.equal(plan.status, 'held')
    assert.equal(plan.valid, false)
    assert.equal(plan.evidence.result.heldCount, 4)
    assert.equal(plan.evidence.result.readyCount, 51)

    // evidence values-free：不含任何夹具的业务值样式字符串。
    for (const forbidden of [
      fixture.PROJECT_NO, fixture.ROOT_PART_NO, PROJECT_NAME,
      fixture.V2_SUBSTITUTED_FROM_PART_NO, fixture.V2_SUBSTITUTED_TO_PART_NO,
      fixture.V2_ADDED_PART_NO, fixture.V2_ADDED_PATH_KEY, fixture.V2_REMOVED_PATH_KEY, 'SYN-',
    ]) {
      assert.equal(deepStringIncludes(plan.evidence, forbidden), false, `evidence values-free：${forbidden}`)
    }
    assert.equal(plan.evidence.valuesFree, true)
  })
  console.log('  testEngineClassifiesFourChangeKinds OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 断言 3：经**页面读的那两条真路由**读出来的也是同一份四类变更
//        GET /snapshot-batches、GET /snapshot-batches/:id/diff、/diff/rows
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testDiffReadRoutesServeTheSameFourKinds() {
  await withAutoPersist('true', async () => {
    const { store, externalWriteCalls } = await persistBothBatches()
    const harness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 })

    // 批次列表：两个批次，版本降序，都不是 incomplete（批次行 + 行 + run 行三件齐全）。
    const list = await invokeHandler(harness, 'stockPreparationSnapshotBatchList', {
      user: ADMIN_USER, query: { projectId: BUSINESS_PROJECT_ID },
    })
    assert.equal(list.statusCode, 200)
    assert.equal(list.body.data.batchCount, 2)
    assert.deepEqual(list.body.data.batches.map((batch) => batch.snapshotBatchId), [BATCH_V2, BATCH_V1])
    assert.deepEqual(list.body.data.batches.map((batch) => batch.snapshotVersion), [2, 1])
    for (const batch of list.body.data.batches) {
      assert.equal(batch.incomplete, false, 'H-1 完整性：两侧都齐全，diff 入口才开')
      assert.equal(batch.lineCount, 54)
    }

    // 汇总 diff：base 由**服务端**按「版本严格小于当前的最高版本」自动挑出来，不是请求指定的。
    const diff = await invokeHandler(harness, 'stockPreparationSnapshotDiff', {
      user: ADMIN_USER, params: { snapshotBatchId: BATCH_V2 }, query: {},
    })
    assert.equal(diff.statusCode, 200)
    assert.equal(diff.body.data.snapshotBatchId, BATCH_V2)
    assert.equal(diff.body.data.baseSnapshotBatchId, BATCH_V1, '前序批次自动挑中 v1')
    assert.deepEqual(diff.body.data.changeCounts, {
      added: 1,
      removed: 1,
      quantityChanged: 1,
      unitChanged: 0,
      versionChanged: 0,
      pathChanged: 0,
      missingChildBom: 0,
      // fingerprintChanged stays the pre-existing sourceFingerprint tally (2 = the quantity-changed
      // row + the in-place swap row) — componentCodeChanged/materialChanged below are INDEPENDENT
      // counts over the same rows' changeTypes arrays, not a replacement for it (a row keeps carrying
      // both SOURCE_FINGERPRINT_CHANGED and COMPONENT_CODE_CHANGED at once; see compareMatchedRows).
      fingerprintChanged: 2,
      // Q3c: the gap this used to document is closed — the summary now names the in-place component-
      // code swap by its own key instead of forcing a reviewer into the row-by-row drill-down to learn
      // WHICH kind of swap it was (see stock-preparation-snapshot-reads.cjs changeCountsFromEvidence).
      componentCodeChanged: 1,
      materialChanged: 0,
    })
    assert.equal(diff.body.data.blockingExceptionCount, 0)

    // 逐行 diff：55 行，四类各一，51 行 unchanged；替换那行在这里**被点名**。
    const rows = await invokeHandler(harness, 'stockPreparationSnapshotDiffRows', {
      user: ADMIN_USER, params: { snapshotBatchId: BATCH_V2 }, query: {},
    })
    assert.equal(rows.statusCode, 200)
    assert.equal(rows.body.data.baseSnapshotBatchId, BATCH_V1)
    assert.equal(rows.body.data.rowCount, 55)
    assert.equal(rows.body.data.heldRowCount, 4)
    assert.deepEqual(countByDiffType(rows.body.data.rows), {
      [DIFF_TYPES.CHANGED]: 2,
      [DIFF_TYPES.ADDED]: 1,
      [DIFF_TYPES.REMOVED]: 1,
      [DIFF_TYPES.UNCHANGED]: 51,
    })
    const rowChangeTypes = countByChangeType(rows.body.data.rows)
    assert.equal(rowChangeTypes[CHANGE_TYPES.QUANTITY_CHANGED], 1)
    assert.equal(rowChangeTypes[CHANGE_TYPES.COMPONENT_CODE_CHANGED], 1, '逐行读面点名原位物料替换')
    assert.equal(rowChangeTypes[CHANGE_TYPES.ADDED], 1)
    assert.equal(rowChangeTypes[CHANGE_TYPES.REMOVED], 1)

    // 逐行读面的 held 过滤：正好是那四行。
    const held = await invokeHandler(harness, 'stockPreparationSnapshotDiffRows', {
      user: ADMIN_USER, params: { snapshotBatchId: BATCH_V2 }, query: { reviewStatus: 'held' },
    })
    assert.equal(held.body.data.rowCount, 4)
    assert.equal(held.body.data.heldRowCount, 4, 'heldRowCount 统计的是整对，不随过滤缩水')
    assert.deepEqual(countByDiffType(held.body.data.rows), {
      [DIFF_TYPES.CHANGED]: 2, [DIFF_TYPES.ADDED]: 1, [DIFF_TYPES.REMOVED]: 1,
    })

    // values-free：三个响应体里一个业务值都没有（正例自检在断言 1 里 —— 那些值确实到了写侧）。
    for (const res of [list, diff, rows, held]) {
      for (const forbidden of [
        fixture.PROJECT_NO, fixture.ROOT_PART_NO, PROJECT_NAME, 'SYN-',
        fixture.V2_SUBSTITUTED_FROM_PART_NO, fixture.V2_SUBSTITUTED_TO_PART_NO, fixture.V2_ADDED_PART_NO,
      ]) {
        assert.equal(deepStringIncludes(res.body, forbidden), false, `values-free：${forbidden} 不许过 HTTP`)
      }
    }
    // 对账全程零外部写。
    assert.equal(externalWriteCalls.length, 0)
    assert.equal(harness.externalWriteCalls.length, 0)
  })
  console.log('  testDiffReadRoutesServeTheSameFourKinds OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 断言 4：批次不可变 —— 同一个 v2 批次 ID 用改过的内容重跑 = 409，且 diff 结果逐字节不变
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testSameBatchRerunConflictsAndDiffIsStable() {
  await withAutoPersist('true', async () => {
    const { store } = await persistBothBatches()
    const before = JSON.stringify(store.rowsOf(LINE_OBJECT_ID))
    const diffBefore = await invokeHandler(
      createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 }),
      'stockPreparationSnapshotDiffRows',
      { user: ADMIN_USER, params: { snapshotBatchId: BATCH_V2 }, query: {} },
    )

    // 精确重放（同批次、同内容）-> 200 internal_noop，零新建。
    const replay = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 })
    const noop = await invokeHandler(replay, 'stockPreparationPlmBomSourceRun', {
      user: ADMIN_USER, body: sourceRunBody({ syncRunId: RUN_V2, snapshotBatchId: BATCH_V2, snapshotVersion: 2 }),
    })
    assert.equal(noop.statusCode, 200)
    assert.equal(noop.body.data.autoPersist.mode, 'skipped_existing')

    // 内容变了的同批次重跑 -> 409 失败关闭，一行不动。
    const tampered = fixture.ROWS_V2.map((row, index) => (index === 0 ? { ...row, qty: row.qty + 7 } : { ...row }))
    const conflictHarness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: tampered })
    const conflict = await invokeHandler(conflictHarness, 'stockPreparationPlmBomSourceRun', {
      user: ADMIN_USER, body: sourceRunBody({ syncRunId: RUN_V2, snapshotBatchId: BATCH_V2, snapshotVersion: 2 }),
    })
    assert.equal(conflict.statusCode, 409, '同批次改内容重跑失败关闭')
    assert.equal(conflict.body.error.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
    assert.equal(conflict.body.error.details.target, 'snapshot_line')
    assert.equal(conflict.body.error.details.reason, 'content_mismatch')
    assert.equal(JSON.stringify(store.rowsOf(LINE_OBJECT_ID)), before, '冲突没有改动任何既有行')

    // 对账结果因此是可重放的：同一对批次再读一次，逐字节一样。
    const diffAfter = await invokeHandler(
      createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 }),
      'stockPreparationSnapshotDiffRows',
      { user: ADMIN_USER, params: { snapshotBatchId: BATCH_V2 }, query: {} },
    )
    assert.equal(JSON.stringify(diffAfter.body), JSON.stringify(diffBefore.body), '对账结果可重放')
  })
  console.log('  testSameBatchRerunConflictsAndDiffIsStable OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 变异 ①：把 v2 的「删除 1 子件」改回存在 -> removed 断言必须红
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testMutationRestoringDeletedChildTurnsRemovedRed() {
  await withAutoPersist('true', async () => {
    // v2 的行集里把被删的那一行放回去（内存级：只改这次源运行看到的行，夹具文件不动）。
    const restored = fixture.ROWS.filter((row) => row.path_key === fixture.V2_REMOVED_PATH_KEY)
    assert.equal(restored.length, 1, '变异锚点：v1 里恰好有这一行')
    const mutatedV2 = [...fixture.ROWS_V2, { ...restored[0] }]

    const store = createInMemoryStagingStore()
    const first = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS })
    assert.equal((await invokeHandler(first, 'stockPreparationPlmBomSourceRun', { user: ADMIN_USER, body: sourceRunBody() })).statusCode, 201)
    const second = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: mutatedV2 })
    assert.equal((await invokeHandler(second, 'stockPreparationPlmBomSourceRun', {
      user: ADMIN_USER, body: sourceRunBody({ syncRunId: RUN_V2, snapshotBatchId: BATCH_V2, snapshotVersion: 2 }),
    })).statusCode, 201)

    const plan = planBomSnapshotDiff({
      previousSnapshotBatchId: BATCH_V1,
      currentSnapshotBatchId: BATCH_V2,
      previousLines: linesOfBatch(store, BATCH_V1),
      currentLines: linesOfBatch(store, BATCH_V2),
    })
    const byDiffType = countByDiffType(plan.diffs)
    assert.equal(byDiffType[DIFF_TYPES.REMOVED], undefined, '把删除改回存在后 removed 归零 —— 断言 2 的 removed 会红')
    assert.equal(countByChangeType(plan.diffs)[CHANGE_TYPES.REMOVED], undefined)
    // 而且不是「整条链跑不起来」：另外三类照旧被认出来。
    assert.equal(byDiffType[DIFF_TYPES.ADDED], 1)
    assert.equal(byDiffType[DIFF_TYPES.CHANGED], 2)
    assert.equal(byDiffType[DIFF_TYPES.UNCHANGED], 52, '那一行回来了，unchanged 从 51 涨到 52')
  })
  console.log('  testMutationRestoringDeletedChildTurnsRemovedRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 变异 ②：把 diff 引擎换成「只比行数」-> changed 断言必须红
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testMutationRowCountOnlyDiffTurnsChangedRed() {
  await withAutoPersist('true', async () => {
    const { store } = await persistBothBatches()
    const previousLines = linesOfBatch(store, BATCH_V1)
    const currentLines = linesOfBatch(store, BATCH_V2)

    // 变异体：两侧行数相等就直接判「没差异」。v1/v2 都是 54 行 —— 一条 diff 都不产。
    // 锚点刻意只占**一行**：lib/*.cjs 在 Windows 检出下是 CRLF，跨行锚点会在本机永远命不中
    // （而在 CI 的 LF 检出下命中）—— 那种探针是假的。
    const MUTANT_BODY = [
      'const m = normalizeInput(input);',
      'if (m.previousLines.length === m.currentLines.length) {',
      "return { valid: true, status: 'ready', runId: m.runId,",
      'previousSnapshotBatchId: m.previousSnapshotBatchId,',
      'currentSnapshotBatchId: m.currentSnapshotBatchId,',
      'diffs: [], evidence: buildValuesFreeEvidence(m, []) };',
      '}',
    ].join(' ')
    const rowCountOnly = readMutatedModule(
      DIFF_ENGINE_PATH,
      'function planBomSnapshotDiff(input = {}) {',
      `function planBomSnapshotDiff(input = {}) { /* MUTANT: row-count-only */ ${MUTANT_BODY}`,
    )

    const mutantPlan = rowCountOnly.planBomSnapshotDiff({
      previousSnapshotBatchId: BATCH_V1,
      currentSnapshotBatchId: BATCH_V2,
      previousLines,
      currentLines,
    })
    assert.equal(mutantPlan.diffs.length, 0, '只比行数的引擎在 54 vs 54 上什么都看不见')
    const mutantByChangeType = countByChangeType(mutantPlan.diffs)
    for (const changeType of [
      CHANGE_TYPES.QUANTITY_CHANGED, CHANGE_TYPES.COMPONENT_CODE_CHANGED,
      CHANGE_TYPES.ADDED, CHANGE_TYPES.REMOVED,
    ]) {
      assert.equal(mutantByChangeType[changeType], undefined, `变异体报不出 ${changeType} —— 断言 2 会红`)
    }
    assert.equal(mutantPlan.status, 'ready', '变异体还会把一份有 4 处变更的对账报成「没事」')

    // 真引擎在同一对输入上照旧报 55 条 —— 变异是真的把能力拿掉了，不是输入本身就没差异。
    const realPlan = planBomSnapshotDiff({
      previousSnapshotBatchId: BATCH_V1,
      currentSnapshotBatchId: BATCH_V2,
      previousLines,
      currentLines,
    })
    assert.equal(realPlan.diffs.length, 55)
    assert.equal(countByChangeType(realPlan.diffs)[CHANGE_TYPES.QUANTITY_CHANGED], 1)
  })
  console.log('  testMutationRowCountOnlyDiffTurnsChangedRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 变异 ③：把 v2 的「原位物料替换」改回原件号 -> component_code_changed 断言必须红
//        （证明「替换」那条不是被 source_fingerprint_changed 顺带报出来的）
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testMutationUndoingSubstitutionTurnsComponentCodeRed() {
  await withAutoPersist('true', async () => {
    const original = fixture.ROWS.find((row) => row.path_key === fixture.V2_SUBSTITUTED_PATH_KEY)
    assert.ok(original, '变异锚点：v1 里有这一行')
    const mutatedV2 = fixture.ROWS_V2.map((row) => (
      row.path_key === fixture.V2_SUBSTITUTED_PATH_KEY ? { ...original } : { ...row }
    ))

    const store = createInMemoryStagingStore()
    const first = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS })
    assert.equal((await invokeHandler(first, 'stockPreparationPlmBomSourceRun', { user: ADMIN_USER, body: sourceRunBody() })).statusCode, 201)
    const second = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: mutatedV2 })
    assert.equal((await invokeHandler(second, 'stockPreparationPlmBomSourceRun', {
      user: ADMIN_USER, body: sourceRunBody({ syncRunId: RUN_V2, snapshotBatchId: BATCH_V2, snapshotVersion: 2 }),
    })).statusCode, 201)

    const plan = planBomSnapshotDiff({
      previousSnapshotBatchId: BATCH_V1,
      currentSnapshotBatchId: BATCH_V2,
      previousLines: linesOfBatch(store, BATCH_V1),
      currentLines: linesOfBatch(store, BATCH_V2),
    })
    const byChangeType = countByChangeType(plan.diffs)
    assert.equal(byChangeType[CHANGE_TYPES.COMPONENT_CODE_CHANGED], undefined, '替换撤销后 component_code_changed 归零')
    assert.equal(byChangeType[CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED], 1, '只剩改数量那行的指纹变化')
    assert.equal(countByDiffType(plan.diffs)[DIFF_TYPES.CHANGED], 1)
    assert.equal(countByDiffType(plan.diffs)[DIFF_TYPES.UNCHANGED], 52)
  })
  console.log('  testMutationUndoingSubstitutionTurnsComponentCodeRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// flag 默认 OFF 没被动：不设 = 只读投影，一行都不写（对账演练没有放宽任何写面）
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testFlagDefaultOffStaysReadOnly() {
  await withAutoPersist(undefined, async () => {
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, rows: fixture.ROWS_V2 })
    const res = await invokeHandler(harness, 'stockPreparationPlmBomSourceRun', { user: ADMIN_USER, body: sourceRunBody() })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'dry_run')
    assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'autoPersist'), false)
    assert.equal(store.writes.length, 0, 'OFF 一行都不写')
  })
  console.log('  testFlagDefaultOffStaysReadOnly OK')
}

async function main() {
  console.log('scenario-b-v2-snapshot-diff')
  await testTwoImmutableBatchesLand()
  await testEngineClassifiesFourChangeKinds()
  await testDiffReadRoutesServeTheSameFourKinds()
  await testSameBatchRerunConflictsAndDiffIsStable()
  await testMutationRestoringDeletedChildTurnsRemovedRed()
  await testMutationRowCountOnlyDiffTurnsChangedRed()
  await testMutationUndoingSubstitutionTurnsComponentCodeRed()
  await testFlagDefaultOffStaysReadOnly()
  console.log('scenario-b-v2-snapshot-diff: all OK')
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = { main }
