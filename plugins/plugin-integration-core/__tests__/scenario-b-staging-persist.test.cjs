'use strict'

// ---------------------------------------------------------------------------
// 场景 B / W7-A2 —— A1 的 54 行合成 BOM 经 buildPlmSourcePersistInput 落进备料 staging，
// 并实证写侧三道守卫 + 幂等。
//
// owner 裁决（SC-01）:「本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收…不启用生产
// autopersist」。本套件因此**只在测试进程内**把 MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED
// 置为 'true'，跑完即还原（withPlmAutoPersistFlag）。生产默认值、模板、文档默认值一律没动 ——
// 这个 flag 在仓库里依旧是「不设 = OFF」。
//
// 这条链上跑的全是产品代码：
//   lib/adapters/data-source-sql-readonly-source-adapter.cjs  真适配器
//   lib/read-source-read-runtime.cjs                          真执行器
//   lib/stock-preparation-readonly-source-run.cjs             真 feeder
//   lib/stock-preparation-plm-source-persist-bridge.cjs       真桥（buildPlmSourcePersistInput）
//   lib/stock-preparation-sync-run-persist.cjs                真落库（幂等/不可变/工作单元）
//   lib/http-routes.cjs                                       真 autopersist 分支（本刀**未改**，pin）
// 被替掉的只有两个宿主注入点：只读 data-source facade（A1 同款被动替身）与 multitable
// records/provisioning（内存 staging 落点）。两者都不是守卫的背书 —— 守卫的断言在下面逐条写明。
//
// 变异探针一律**内存级**：readMutatedModule() 读源码、做一处替换、用 Module._compile 编出一个
// 新模块对象。磁盘上的文件一个字节都没改（并发反驳者互撞的老坑）。
//
// Run: node __tests__/scenario-b-staging-persist.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const LIB_DIR = path.join(__dirname, '..', 'lib')
const HTTP_ROUTES_PATH = path.join(LIB_DIR, 'http-routes.cjs')

const fixture = require(path.join(
  __dirname, '..', 'fixtures', 'scenario-b-synthetic-bom', 'scenario-b-synthetic-bom.cjs',
))
const httpRoutes = require(HTTP_ROUTES_PATH)
const { validateReadSourceConfig } = require(path.join(LIB_DIR, 'read-source-config.cjs'))
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require(path.join(LIB_DIR, 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))
const syncRunPersist = require(path.join(LIB_DIR, 'stock-preparation-sync-run-persist.cjs'))

const SOURCE_RUN_PATH = '/api/integration/stock-preparation/mvp/source-runs/plm-bom'
const AUTOPERSIST_FLAG = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
const TENANT_CLAIM_FLAG = 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'
const CONFIG_ID = 'scenario_b_readsource_1'
const SYSTEM_ID = 'syn-bom-source-b1'
const DATA_SOURCE_ID = 'syn-bom-postgres-b1'
const TENANT_ID = 'tenant_scenario_b'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const BUSINESS_PROJECT_ID = 'business_project_scenario_b'
const PROJECT_NAME = '合成备料项目 B1'
const ADMIN_USER = Object.freeze({
  id: 'user_admin_scenario_b',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin'],
})

// ── 内存变异探针 ──────────────────────────────────────────────────────────────────────────────
// 读源码 → 断言待替换文本确实存在（否则探针自己就是假的）→ 替换 → 编译成一个独立模块。
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

// ── 宿主只读 facade 的被动替身（A1 同款；行为面只做 PG 真正会做的事）──────────────────────────
function recordingDataSourcesFacade({ rows = fixture.ROWS } = {}) {
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
      const page = matched.slice(offset, offset + limit)
      // pg 把 numeric 作为字符串回吐。
      return { data: page.map((row) => ({ ...row, qty: String(row.qty) })) }
    },
  }
}

// ── 内存 staging 落点：records + provisioning ────────────────────────────────────────────────
// limit/offset 老老实实实现（落库侧的分页读是有界的，替身若无视分页就等于替测试做了假设）。
function createInMemoryStagingStore() {
  const sheets = new Map()
  const writes = []
  const findObjectSheetCalls = []
  const unitOfWorkCalls = []
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
      const id = `rec_scenario_b_${seq}`
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
      unitOfWorkCalls.push(input)
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
    async findObjectSheet({ projectId, objectId } = {}) {
      findObjectSheetCalls.push({ projectId, objectId })
      return { id: `sheet_${objectId}` }
    },
    async resolveFieldIds({ fieldIds } = {}) {
      return Object.fromEntries((fieldIds || []).map((fieldId) => [fieldId, fieldId]))
    },
  }
  const rowsOf = (objectId) => [...sheetFor(`sheet_${objectId}`).values()].map((row) => ({ ...row.data }))
  return { recordsApi, provisioningApi, writes, findObjectSheetCalls, unitOfWorkCalls, rowsOf }
}

// records/provisioning 的「碰一下就炸」版本：守卫路径必须一次 I/O 都不发生。
function createCountingThrowApis() {
  const state = { calls: 0 }
  const bomb = (name) => async () => {
    state.calls += 1
    throw new Error(`${name} must not run on this path`)
  }
  return {
    state,
    recordsApi: {
      queryRecords: bomb('queryRecords'),
      createRecord: bomb('createRecord'),
      patchRecord: bomb('patchRecord'),
      runStockPreparationPersistUnitOfWork: bomb('runStockPreparationPersistUnitOfWork'),
    },
    provisioningApi: { findObjectSheet: bomb('findObjectSheet'), resolveFieldIds: bomb('resolveFieldIds') },
  }
}

function throwingStub(name, methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => {
    throw new Error(`${name}.${method} is not exercised by the scenario-B staging-persist suite`)
  }]))
}

function normalizedScenarioBConfig(fieldMap) {
  const raw = fixture.readSourceConfig({ systemId: SYSTEM_ID })
  if (fieldMap) raw.fieldMap = fieldMap.map((entry) => ({ ...entry }))
  const validation = validateReadSourceConfig(raw)
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  return validation.normalized
}

// 真适配器 + 真配置 + 真 http-routes handler 的装配。`routesModule` 让变异探针把一个**改过的**
// http-routes 编译体塞进来，其余一切不变。
function createScenarioBHarness({
  recordsApi,
  provisioningApi,
  rows = fixture.ROWS,
  fieldMap,
  routesModule = httpRoutes,
} = {}) {
  const config = normalizedScenarioBConfig(fieldMap)
  const dataSources = recordingDataSourcesFacade({ rows })
  const adapterCreateCalls = []
  const sourceReadCalls = []
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
        return {
          id: input.id,
          tenantId: input.tenantId,
          kind: ADAPTER_KIND,
          role: 'source',
          config: { dataSourceId: DATA_SOURCE_ID },
          credentials: {},
        }
      },
    },
    adapterRegistry: {
      listAdapterKinds() { return [ADAPTER_KIND] },
      createAdapter(system, options = {}) {
        adapterCreateCalls.push(system && system.kind)
        const adapter = createDataSourceSqlReadonlySourceAdapter({
          system,
          context,
          principal: options.principal,
        })
        return {
          ...adapter,
          async read(request) {
            sourceReadCalls.push({ request })
            return adapter.read(request)
          },
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
  const handlers = routesModule.createHandlers(services, {
    context,
    logger: { warn() {}, error() {}, info() {} },
  })
  return { handlers, dataSources, adapterCreateCalls, sourceReadCalls, externalWriteCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

// http-routes 的 registerIntegrationRoutes 才有 try/catch→sendError 包装；这里直接调 handler，
// 所以自己复刻同一层包装（用的是模块自己导出的 sendError，不是重新实现一套错误投影）。
async function invokeSourceRun(harness, req = {}, routesModule = httpRoutes) {
  const res = createResponse()
  try {
    await harness.handlers.stockPreparationPlmBomSourceRun({
      user: req.user,
      body: req.body || {},
      query: req.query || {},
      params: req.params || {},
      authenticatedTenantId: req.authenticatedTenantId,
    }, res)
  } catch (error) {
    routesModule.__internals.sendError(res, error)
  }
  assert.notEqual(res.body, undefined, `${SOURCE_RUN_PATH} produced a JSON body`)
  return res
}

function requestBody(overrides = {}) {
  return {
    workspaceId: 'workspace_scenario_b',
    projectId: BUSINESS_PROJECT_ID,
    sourceProjectNo: fixture.PROJECT_NO,
    projectName: PROJECT_NAME,
    readSourceConfigId: CONFIG_ID,
    syncRunId: 'scenario_b_run_1',
    snapshotBatchId: 'scenario_b_batch_1',
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

const LINE_OBJECT_ID = syncRunPersist.__internals.LINE_TEMPLATE.objectId
const BATCH_OBJECT_ID = syncRunPersist.BATCH_OBJECT_ID
const RUN_OBJECT_ID = syncRunPersist.RUN_OBJECT_ID
const PROJECT_OBJECT_ID = syncRunPersist.PROJECT_OBJECT_ID
const RUN_FIELD_IDS = syncRunPersist.__internals.RUN_TEMPLATE.fields.map((entry) => entry.id)

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 断言 1：54 行真的落进 staging，且物理落点由**认证租户**推导
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testFiftyFourLinesLandInStaging() {
  await withAutoPersist('true', async () => {
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi })
    const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() })

    assert.equal(res.statusCode, 201, '落了行就是 201')
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.mode, 'internal_persist')
    assert.equal(res.body.data.evidence.internalWriteExecuted, true)
    assert.equal(res.body.data.autoPersist.persisted, true)
    assert.equal(res.body.data.autoPersist.mode, 'created')

    // 一行不多一行不少：A1 读到 54 行，54 行全部作为 snapshot-line 落库。
    assert.equal(fixture.ROW_COUNT, 54)
    assert.equal(res.body.data.autoPersist.created.lines, 54)
    assert.equal(res.body.data.autoPersist.created.batch, 1)
    assert.equal(res.body.data.autoPersist.created.run, 1)
    assert.equal(store.rowsOf(LINE_OBJECT_ID).length, 54)
    assert.equal(store.rowsOf(BATCH_OBJECT_ID).length, 1)
    assert.equal(store.rowsOf(RUN_OBJECT_ID).length, 1)
    assert.equal(store.rowsOf(PROJECT_OBJECT_ID).length, 1)

    // 两层父子都落了（不是只落根那几条）。
    const levels = new Map()
    for (const row of store.rowsOf(LINE_OBJECT_ID)) {
      levels.set(row.bomLevel, (levels.get(row.bomLevel) || 0) + 1)
    }
    assert.deepEqual([...levels.entries()].sort(), [[1, fixture.SUBASSEMBLY_COUNT], [2, 48]])

    // 物理落点：四张 MVP 表全部在**认证租户**的 staging 项目下解析，body 的 projectId 只是行上的
    // 业务键，绝不选目标。
    assert.ok(store.findObjectSheetCalls.length > 0)
    for (const call of store.findObjectSheetCalls) {
      assert.equal(call.projectId, STAGING_PROJECT_ID, 'staging 落点由认证租户推导')
    }
    // 业务 projectId 骑在**批次行**上（LINE_TEMPLATE 没有 projectId 字段 —— 快照行通过
    // snapshotBatchId 归属批次，批次再归属业务项目）。
    assert.equal(store.rowsOf(BATCH_OBJECT_ID)[0].projectId, BUSINESS_PROJECT_ID)
    assert.equal(store.rowsOf(PROJECT_OBJECT_ID)[0].projectId, BUSINESS_PROJECT_ID)
    assert.equal(
      store.rowsOf(LINE_OBJECT_ID).every((row) => row.snapshotBatchId === 'scenario_b_batch_1'),
      true,
      '54 行全部归属这一个批次',
    )

    // 账本/锁作用域：工作单元一次，锁租户 = 认证租户，四张表一起进同一个事务。
    assert.equal(store.unitOfWorkCalls.length, 1)
    assert.equal(store.unitOfWorkCalls[0].tenantId, TENANT_ID)
    assert.equal(store.unitOfWorkCalls[0].sheetIds.length, 4)
    assert.equal(store.unitOfWorkCalls[0].project.projectId, BUSINESS_PROJECT_ID)

    // run 账本行的形状（这条路径写的是 MVP run 表，不是 pipeline run/死信表 —— 见设计文档 §账本）。
    const runRow = store.rowsOf(RUN_OBJECT_ID)[0]
    assert.equal(runRow.runId, 'scenario_b_run_1')
    assert.equal(typeof runRow.runType, 'string')
    assert.equal(typeof runRow.status, 'string')
    assert.ok(runRow.status.length > 0)
    assert.deepEqual(
      Object.keys(runRow).filter((key) => !RUN_FIELD_IDS.includes(key)),
      [],
      'run 账本行只写模板里有的字段',
    )
    assert.equal(store.rowsOf(BATCH_OBJECT_ID)[0].syncRunId, 'scenario_b_run_1', '批次行指回这次 run')

    // 外部写面：一次都没有。
    assert.equal(harness.externalWriteCalls.length, 0)
    assert.equal(res.body.data.evidence.externalWriteExecuted, false)
    assert.equal(res.body.data.evidence.productionWrite, false)

    // 值面不出网：正例自检（哨兵确实到了写侧）+ 反例（HTTP 响应里一个都没有）。
    assert.equal(deepStringIncludes(store.writes, fixture.ROOT_PART_NO), true, '正例自检：哨兵确实到了内部写侧')
    for (const forbidden of [fixture.ROOT_PART_NO, fixture.PROJECT_NO, PROJECT_NAME, 'SYN-SUB-01', 'SYN-PRT-01-01']) {
      assert.equal(deepStringIncludes(res.body, forbidden), false, `values-free：${forbidden} 不许过 HTTP`)
    }
  })
  console.log('  testFiftyFourLinesLandInStaging OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 守卫 ①：租户转向拒绝（400）—— http-routes.cjs:1389 assertStockPreparationPlmAutoPersistNoSteering
//        接线点 http-routes.cjs:7248
// ══════════════════════════════════════════════════════════════════════════════════════════════
const STEERING_VECTORS = [
  ['body.tenantId', { body: requestBody({ tenantId: 'tenant_evil' }) }],
  ['query.tenantId', { body: requestBody(), query: { tenantId: 'tenant_evil' } }],
  ['params.tenantId', { body: requestBody(), params: { tenantId: 'tenant_evil' } }],
  ['query.projectId', { body: requestBody(), query: { projectId: 'tenant_evil:integration-core' } }],
  ['params.projectId', { body: requestBody(), params: { projectId: 'tenant_evil:integration-core' } }],
]

async function testGuard1TenantSteeringRejected(routesModule = httpRoutes) {
  await withAutoPersist('true', async () => {
    // 正例：不带任何转向载体 -> 过（断言 1 已证 201，这里再确认一次同一 harness 形状）。
    const okStore = createInMemoryStagingStore()
    const okHarness = createScenarioBHarness({ recordsApi: okStore.recordsApi, provisioningApi: okStore.provisioningApi, routesModule })
    const ok = await invokeSourceRun(okHarness, { user: ADMIN_USER, body: requestBody() }, routesModule)
    assert.equal(ok.statusCode, 201, '守卫 ①：干净请求放行')

    // 反例：五个载体逐个拒，且守卫在**任何 I/O 之前**开火。
    for (const [label, reqExtra] of STEERING_VECTORS) {
      const bomb = createCountingThrowApis()
      const harness = createScenarioBHarness({ recordsApi: bomb.recordsApi, provisioningApi: bomb.provisioningApi, routesModule })
      const res = await invokeSourceRun(harness, { user: ADMIN_USER, ...reqExtra }, routesModule)
      assert.equal(res.statusCode, 400, `${label}: 转向被拒`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PLM_AUTOPERSIST_STEERING_NOT_ALLOWED', `${label}: 专用错误码`)
      assert.equal(harness.adapterCreateCalls.length, 0, `${label}: 适配器都没被造出来`)
      assert.equal(harness.sourceReadCalls.length, 0, `${label}: 源都没被读`)
      assert.equal(bomb.state.calls, 0, `${label}: records/provisioning 零 I/O`)
    }
  })
  console.log('  testGuard1TenantSteeringRejected OK')
}

// 变异：把接线那一行删掉（守卫函数还在，只是没人叫它）-> 上面的反例必须变绿（=测试红）。
async function testGuard1MutationTurnsRed() {
  const mutated = readMutatedModule(
    HTTP_ROUTES_PATH,
    'if (autoPersistEnabled) assertStockPreparationPlmAutoPersistNoSteering(req)',
    '/* MUTANT: steering guard unwired */',
  )
  await withAutoPersist('true', async () => {
    let leaked = 0
    for (const [, reqExtra] of STEERING_VECTORS) {
      const store = createInMemoryStagingStore()
      const harness = createScenarioBHarness({
        recordsApi: store.recordsApi,
        provisioningApi: store.provisioningApi,
        routesModule: mutated,
      })
      const res = await invokeSourceRun(harness, { user: ADMIN_USER, ...reqExtra }, mutated)
      const stillRejected = res.statusCode === 400 &&
        res.body.error && res.body.error.code === 'STOCK_PREPARATION_PLM_AUTOPERSIST_STEERING_NOT_ALLOWED'
      if (!stillRejected) leaked += 1
    }
    assert.equal(leaked, STEERING_VECTORS.length, '去掉守卫 ① 后五个转向载体全部不再被专用码拒 —— 守卫不是摆设')
  })
  console.log('  testGuard1MutationTurnsRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 守卫 ②：配置结构守卫 assertPlmAutoPersistSourceConfigSafe
//        （stock-preparation-plm-source-persist-bridge.cjs:190，接线点 http-routes.cjs:7268）
// ══════════════════════════════════════════════════════════════════════════════════════════════
// 合成表上的「组合映射绕过」：把 level_no 映到内部标记 missingChildBom，同时显式映一个 lineStatus。
// 值面只看得见 'active'，missing-child 信号会被悄悄抹掉 —— 只有**配置**这一层拦得住。
const FORBIDDEN_FIELD_MAP = [
  ...fixture.FIELD_MAP.map((entry) => ({ ...entry })),
  { source: 'level_no', target: 'missingChildBom' },
  { source: 'uom', target: 'lineStatus' },
]

async function testGuard2ConfigShapeRejected(routesModule = httpRoutes) {
  await withAutoPersist('true', async () => {
    const bomb = createCountingThrowApis()
    const harness = createScenarioBHarness({
      recordsApi: bomb.recordsApi,
      provisioningApi: bomb.provisioningApi,
      fieldMap: FORBIDDEN_FIELD_MAP,
      routesModule,
    })
    const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() }, routesModule)
    assert.equal(res.statusCode, 422, '守卫 ②：禁用目标整条 run 拒掉')
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PLM_AUTOPERSIST_CONFIG_TARGET_FORBIDDEN')
    assert.equal(deepStringIncludes(res.body, 'missingChildBom'), true, '只点名禁用的 target 词表')
    assert.equal(deepStringIncludes(res.body, 'level_no'), false, '源列名不过 HTTP')
    assert.equal(harness.adapterCreateCalls.length, 0, '守卫在适配器被造出来之前开火')
    assert.equal(harness.sourceReadCalls.length, 0, '守卫在任何源读之前开火')
    assert.equal(bomb.state.calls, 0, '守卫在任何 records/provisioning I/O 之前开火')

    // 正例：A1 的原始 fieldMap 过守卫（否则上面的「拒」可能只是因为整条链根本跑不起来）。
    const okStore = createInMemoryStagingStore()
    const okHarness = createScenarioBHarness({ recordsApi: okStore.recordsApi, provisioningApi: okStore.provisioningApi, routesModule })
    const ok = await invokeSourceRun(okHarness, { user: ADMIN_USER, body: requestBody() }, routesModule)
    assert.equal(ok.statusCode, 201, '守卫 ②：干净 fieldMap 放行')
  })

  // flag OFF：同一份配置仍然保持今天的只读行为 —— 守卫是 autopersist 的前置条件，不是对只读面的新限制。
  await withAutoPersist(undefined, async () => {
    const bomb = createCountingThrowApis()
    const harness = createScenarioBHarness({
      recordsApi: bomb.recordsApi,
      provisioningApi: bomb.provisioningApi,
      fieldMap: FORBIDDEN_FIELD_MAP,
      routesModule,
    })
    const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() }, routesModule)
    assert.notEqual(res.statusCode, 422, 'flag OFF 不引入新的 422')
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.mode, 'dry_run')
    assert.equal(bomb.state.calls, 0, 'flag OFF 一行都不写')
  })
  console.log('  testGuard2ConfigShapeRejected OK')
}

async function testGuard2MutationTurnsRed() {
  const mutated = readMutatedModule(
    HTTP_ROUTES_PATH,
    'if (autoPersistEnabled) assertPlmAutoPersistSourceConfigSafe(sourceRuntime.config)',
    '/* MUTANT: config shape guard unwired */',
  )
  await withAutoPersist('true', async () => {
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({
      recordsApi: store.recordsApi,
      provisioningApi: store.provisioningApi,
      fieldMap: FORBIDDEN_FIELD_MAP,
      routesModule: mutated,
    })
    const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() }, mutated)
    const stillRejected = res.statusCode === 422 &&
      res.body.error && res.body.error.code === 'STOCK_PREPARATION_PLM_AUTOPERSIST_CONFIG_TARGET_FORBIDDEN'
    assert.equal(stillRejected, false, '去掉守卫 ② 后禁用目标的配置不再被专用码拒')
    // 而且它不是「换了个码继续拒」：绕过真的发生了 —— 组合映射一路走到了写侧。
    assert.equal(harness.sourceReadCalls.length > 0, true, '变异体确实读了源（绕过是真的，不是换个理由拒）')
  })
  console.log('  testGuard2MutationTurnsRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 守卫 ③：值面租户证明 —— assertVerifiedTenantClaim（http-routes.cjs:1226），由
//        resolveAuthUserTenantId（:1085，autopersist ON 时唯一的租户来源）在写侧调用。
//        它堵的是 x-tenant-id 请求头洞：无租户声明的 token 下，user.tenantId 是请求头填的。
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testGuard3ValuePlaneTenantProof(routesModule = httpRoutes) {
  await withAutoPersist('true', () => withEnv(TENANT_CLAIM_FLAG, 'true', async () => {
    // 正例：token 真的带了租户声明，且与 user.tenantId 一致 -> 落库，落点是该租户的 staging。
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi, routesModule })
    const ok = await invokeSourceRun(harness, {
      user: ADMIN_USER,
      body: requestBody(),
      authenticatedTenantId: TENANT_ID,
    }, routesModule)
    assert.equal(ok.statusCode, 201, '守卫 ③：已证明的租户放行')
    for (const call of store.findObjectSheetCalls) assert.equal(call.projectId, STAGING_PROJECT_ID)

    // 反例 a：无租户声明的 token（user.tenantId 由请求头填出来）-> 403，零 I/O。
    const bombA = createCountingThrowApis()
    const harnessA = createScenarioBHarness({ recordsApi: bombA.recordsApi, provisioningApi: bombA.provisioningApi, routesModule })
    const noClaim = await invokeSourceRun(harnessA, { user: ADMIN_USER, body: requestBody() }, routesModule)
    assert.equal(noClaim.statusCode, 403)
    assert.equal(noClaim.body.error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    assert.equal(bombA.state.calls, 0, '守卫 ③ 在任何写侧 I/O 之前开火')

    // 反例 b：携带的租户与已证明的声明**矛盾** -> 403，零 I/O。
    const bombB = createCountingThrowApis()
    const harnessB = createScenarioBHarness({ recordsApi: bombB.recordsApi, provisioningApi: bombB.provisioningApi, routesModule })
    const contradicted = await invokeSourceRun(harnessB, {
      user: { ...ADMIN_USER, tenantId: 'tenant_evil' },
      body: requestBody(),
      authenticatedTenantId: TENANT_ID,
    }, routesModule)
    assert.equal(contradicted.statusCode, 403)
    assert.equal(contradicted.body.error.code, 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
    assert.equal(bombB.state.calls, 0)
  }))
  console.log('  testGuard3ValuePlaneTenantProof OK')
}

async function testGuard3MutationTurnsRed() {
  const mutated = readMutatedModule(
    HTTP_ROUTES_PATH,
    'function assertVerifiedTenantClaim(req, resolvedTenantId) {',
    'function assertVerifiedTenantClaim(req, resolvedTenantId) {\n  if (true) return // MUTANT: value-plane tenant proof disabled\n',
  )
  await withAutoPersist('true', () => withEnv(TENANT_CLAIM_FLAG, 'true', async () => {
    // 无租户声明的 token：守卫被拿掉后，请求头填出来的租户直接决定了 staging 落点 —— 这正是
    // x-tenant-id 请求头洞的形状。
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({
      recordsApi: store.recordsApi,
      provisioningApi: store.provisioningApi,
      routesModule: mutated,
    })
    const res = await invokeSourceRun(harness, {
      user: { ...ADMIN_USER, tenantId: 'tenant_evil' },
      body: requestBody(),
    }, mutated)
    assert.notEqual(res.statusCode, 403, '去掉守卫 ③ 后无声明 token 不再被 403')
    assert.equal(res.statusCode, 201, '变异体真的写进去了')
    assert.equal(
      store.findObjectSheetCalls.every((call) => call.projectId === 'tenant_evil:integration-core'),
      true,
      '去掉守卫 ③ 后请求头填出来的租户决定了物理落点（洞的形状）',
    )
  }))
  console.log('  testGuard3MutationTurnsRed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 幂等 ①：同一批次重跑 —— 行级幂等键不产生重复行
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testIdempotentReplayCreatesNoDuplicateRows() {
  await withAutoPersist('true', async () => {
    const store = createInMemoryStagingStore()
    const harness = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi })

    const first = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() })
    assert.equal(first.statusCode, 201)
    const createsAfterFirst = store.writes.filter((write) => write.op === 'create').length
    assert.equal(createsAfterFirst, 1 + 54 + 1 + 1, 'batch + 54 lines + run + project')
    const readsAfterFirst = harness.sourceReadCalls.length

    const replay = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() })
    assert.equal(replay.statusCode, 200, '精确重放不是 201')
    assert.equal(replay.body.data.mode, 'internal_noop')
    assert.equal(replay.body.data.evidence.internalWriteExecuted, false)
    assert.equal(replay.body.data.autoPersist.persisted, false)
    assert.equal(replay.body.data.autoPersist.mode, 'skipped_existing')
    assert.equal(replay.body.data.autoPersist.created.lines, 0)
    assert.ok(harness.sourceReadCalls.length > readsAfterFirst, '重放确实又读了一次源')
    assert.equal(store.writes.filter((write) => write.op === 'create').length, createsAfterFirst, '重放零新建')
    assert.equal(store.rowsOf(LINE_OBJECT_ID).length, 54, '行级幂等键没有造出第 55 行')

    // 行级幂等键就是 snapshotLineId（LINE_TEMPLATE.keyFields[0]），它由 intake 从 pathKey 派生，
    // 所以 54 个键互不相同 —— 这是「重跑不重复」在键面上的来源，不是靠落点去重。
    assert.equal(syncRunPersist.__internals.LINE_KEY_FIELD, 'snapshotLineId')
    const keys = new Set(store.rowsOf(LINE_OBJECT_ID).map((row) => row.snapshotLineId))
    assert.equal(keys.size, 54, '54 个行级幂等键互不相同')
    assert.equal(syncRunPersist.BATCH_KEY_FIELD, 'snapshotBatchId', '批次幂等键是 snapshotBatchId')
  })
  console.log('  testIdempotentReplayCreatesNoDuplicateRows OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 幂等 ②：改一行源数据重跑
//
// 实证结论（与任务书的「只更新该行」措辞不同，按实跑写）：这条落库路径是**不可变**的 ——
// 它从不 patch 快照行。同一个 snapshotBatchId 下内容变了，它 409 失败关闭
// （PERSIST_IDEMPOTENCY_CONFLICT / snapshot_line / content_mismatch），并且一行都不改。
// 「只更新该行」在这条路径上的正确形状是：**开一个新批次**（新 snapshotBatchId + 递增
// snapshotVersion），改动体现在新批次里，旧批次原样不动，项目行的活指针 patch 到新 run。
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testChangedRowRerunIsImmutableAndFailsClosed() {
  await withAutoPersist('true', async () => {
    const store = createInMemoryStagingStore()
    const baseline = createScenarioBHarness({ recordsApi: store.recordsApi, provisioningApi: store.provisioningApi })
    assert.equal((await invokeSourceRun(baseline, { user: ADMIN_USER, body: requestBody() })).statusCode, 201)
    const snapshotAfterFirst = JSON.stringify(store.rowsOf(LINE_OBJECT_ID))
    const createsAfterFirst = store.writes.filter((write) => write.op === 'create').length

    // 改掉源里的一行（第 3 行的 qty），其余 53 行逐字节不变。
    const changedRows = fixture.ROWS.map((row, index) => (index === 2 ? { ...row, qty: row.qty + 100 } : { ...row }))

    // a) 同一批次 ID 重跑 -> 409 失败关闭，且一行都没动。
    const sameBatch = createScenarioBHarness({
      recordsApi: store.recordsApi,
      provisioningApi: store.provisioningApi,
      rows: changedRows,
    })
    const conflict = await invokeSourceRun(sameBatch, { user: ADMIN_USER, body: requestBody() })
    assert.equal(conflict.statusCode, 409, '内容变了的同批次重放失败关闭')
    assert.equal(conflict.body.error.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
    assert.equal(conflict.body.error.details.target, 'snapshot_line')
    assert.equal(conflict.body.error.details.reason, 'content_mismatch')
    assert.equal(JSON.stringify(store.rowsOf(LINE_OBJECT_ID)), snapshotAfterFirst, '冲突没有改动任何既有行')
    assert.equal(store.writes.filter((write) => write.op === 'create').length, createsAfterFirst, '冲突零新建')
    assert.equal(store.writes.filter((write) => write.op === 'patch').length, 0, '这条路径从不 patch 快照行')

    // b) 新批次 + 递增版本 -> 改动落在新批次里；旧批次原样不动；项目行不重复、活指针 patch 到新 run。
    const nextBatch = createScenarioBHarness({
      recordsApi: store.recordsApi,
      provisioningApi: store.provisioningApi,
      rows: changedRows,
    })
    const second = await invokeSourceRun(nextBatch, {
      user: ADMIN_USER,
      body: requestBody({
        syncRunId: 'scenario_b_run_2',
        snapshotBatchId: 'scenario_b_batch_2',
        snapshotVersion: 2,
      }),
    })
    assert.equal(second.statusCode, 201)
    assert.equal(second.body.data.autoPersist.created.lines, 54)
    assert.equal(store.rowsOf(LINE_OBJECT_ID).length, 108, '新批次是独立的 54 行')
    assert.equal(store.rowsOf(BATCH_OBJECT_ID).length, 2)
    assert.equal(store.rowsOf(RUN_OBJECT_ID).length, 2, 'run 账本每次真落库加一行')
    assert.equal(store.rowsOf(PROJECT_OBJECT_ID).length, 1, '项目行按 projectId 幂等，不重复')

    // 旧批次那 54 行逐字节不变。
    const batch1Lines = store.rowsOf(LINE_OBJECT_ID).filter((row) => row.snapshotBatchId === 'scenario_b_batch_1')
    assert.equal(JSON.stringify(batch1Lines), snapshotAfterFirst, '旧批次不可变')

    // 改动只体现在新批次的**那一行**：新旧两批次逐键比对，只有一个键的 designQty 不同。
    const batch2Lines = store.rowsOf(LINE_OBJECT_ID).filter((row) => row.snapshotBatchId === 'scenario_b_batch_2')
    assert.equal(batch2Lines.length, 54)
    const oldByPath = new Map(batch1Lines.map((row) => [row.pathKey, row]))
    const differing = batch2Lines.filter((row) => {
      const old = oldByPath.get(row.pathKey)
      assert.ok(old, '新批次的每个 pathKey 在旧批次里都有对应行')
      return old.designQty !== row.designQty
    })
    assert.equal(differing.length, 1, '只有被改的那一行的 designQty 变了')
    assert.equal(differing[0].pathKey, fixture.ROWS[2].path_key)
    // 指纹也跟着变了 —— 这正是 a) 里 content_mismatch 的来源。
    assert.notEqual(differing[0].sourceFingerprint, oldByPath.get(differing[0].pathKey).sourceFingerprint)

    // 项目行活指针 patch 到新 run（不是新建第二行项目）。
    assert.equal(store.rowsOf(PROJECT_OBJECT_ID)[0].lastSyncRunId, 'scenario_b_run_2')
    assert.equal(second.body.data.autoPersist.project.mode, 'patched')
  })
  console.log('  testChangedRowRerunIsImmutableAndFailsClosed OK')
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// flag 的生产默认值没被动：不设 = OFF，只读投影里没有 autoPersist 字段，零写入。
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function testFlagDefaultOffStaysReadOnly() {
  await withAutoPersist(undefined, async () => {
    const bomb = createCountingThrowApis()
    const harness = createScenarioBHarness({ recordsApi: bomb.recordsApi, provisioningApi: bomb.provisioningApi })
    const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'dry_run')
    assert.equal(res.body.data.evidence.internalWriteExecuted, false)
    assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'autoPersist'), false, 'OFF 的响应逐字节是只读投影')
    assert.equal(bomb.state.calls, 0, 'OFF 一次写侧 I/O 都没有')
  })
  // 'false' / 'TRUE ' 的边界：只有精确的 'true'（trim + 小写）才开。
  for (const value of ['false', '1', 'yes', '']) {
    await withAutoPersist(value, async () => {
      const bomb = createCountingThrowApis()
      const harness = createScenarioBHarness({ recordsApi: bomb.recordsApi, provisioningApi: bomb.provisioningApi })
      const res = await invokeSourceRun(harness, { user: ADMIN_USER, body: requestBody() })
      assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'autoPersist'), false, `${value} 不开 autopersist`)
      assert.equal(bomb.state.calls, 0)
    })
  }
  console.log('  testFlagDefaultOffStaysReadOnly OK')
}

async function main() {
  console.log('scenario-b-staging-persist')
  await testFiftyFourLinesLandInStaging()
  await testGuard1TenantSteeringRejected()
  await testGuard1MutationTurnsRed()
  await testGuard2ConfigShapeRejected()
  await testGuard2MutationTurnsRed()
  await testGuard3ValuePlaneTenantProof()
  await testGuard3MutationTurnsRed()
  await testIdempotentReplayCreatesNoDuplicateRows()
  await testChangedRowRerunIsImmutableAndFailsClosed()
  await testFlagDefaultOffStaysReadOnly()
  console.log('scenario-b-staging-persist: all OK')
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

// 导出给「守卫拿掉就红」的外部探针复用：同一批断言可以对着一个**变异过的** http-routes 编译体再跑
// 一遍（见 verification 文档 §变异）。探针在 scratchpad 里，不落仓库。
module.exports = {
  HTTP_ROUTES_PATH,
  readMutatedModule,
  testGuard1TenantSteeringRejected,
  testGuard2ConfigShapeRejected,
  testGuard3ValuePlaneTenantProof,
}
