// ---------------------------------------------------------------------------------------------
// scripts/ops/scenario-b-replay.mjs 的**生产者→消费者闭环**契约测试（#5931 复审 F3/F4）。
//
// scenario-b-replay.test.mjs 用假 fetch 回放每一步的响应 —— 它证得了「逐步判成败」「门」「values-free」，
// 却证不了「脚本发出去的请求，真路由 + 真配置仓会怎么接」。复审 R2/R3 正好漏在这条缝里：
//   · 保存/审批不带作用域 → 真 scopedInput 把配置存在 workspace_id=NULL；
//     源运行却带着 workspace → 真 getForRuntime 精确匹配不回退 → 首跑 RUN_V1=404。
//   · 第二次执行：真 saveVersion 复用已批准的同内容版本，无条件 approve → 409；
//     同一业务项目上再落 snapshotVersion=1 → 真落库先拒（422 PERSIST_VERSION_NOT_MONOTONIC，按项目版本
//     严格递增）；历史里若已有两个同版本前驱，真 pickPredecessor 也会拒（409 ambiguous）。两道守卫都不关，
//     脚本改为每次演练用一个隔离的新业务项目。
//
// 所以这里把脚本的 fetchImpl 接到**真**的 http-routes handler 上：
//   真  lib/http-routes.cjs                      externalSystemsUpsert / readSourceConfigsSave /
//                                                readSourceConfigsApprove / stockPreparationPlmBomSourceRun /
//                                                stockPreparationSnapshotBatchList / …Diff / …DiffRows
//   真  lib/read-source-config-store.cjs         saveVersion（内容幂等 + reused；铸新指针前在事务内对目标外部系统行取
//                                                FOR KEY SHARE —— 删除锁协议的写入方半边，external-system-pointer-lock.cjs）/
//                                                approve（仅 draft→approved）/ getForRuntime（作用域精确匹配、不回退）
//   真  lib/adapters/data-source-sql-readonly-source-adapter.cjs、sync-run persist、snapshot reads、diff 引擎
// 被替身的只有：
//   · 部署预检（/preflight）—— 固定回答一个沙箱形状；门本身由 scenario-b-replay.test.mjs 覆盖。
//   · 外部系统登记表（registry 的 upsert/get）—— 按 (tenant, workspace, id) 存，查找时「精确 → 租户级 null」
//     回退，与 external-systems.cjs 的 selectScopedRow 语义一致（#5472）。
//   · 宿主 data-source facade（按 rows 回放合成表）与 multitable records/provisioning（内存 staging）。
//   · 配置仓的 db：有作用域语义的内存表 —— where 里的 null 只匹配 null/undefined，别的值精确相等。
//     它的 selectOneForKeyShare（写入方锁）对 integration_external_systems 按 tenant_id + id 去**登记替身**里解析
//     （系统登记在替身里、不在这张 db 的表中），查不到返回 null：未登记 / 已删除的 systemId 在这条车道上照样被
//     真 saveVersion 拒绝（400 READ_SOURCE_CONFIG_INVALID / READ_SOURCE_SYSTEM_NOT_FOUND），不是「任何 id 都活」的桩。
// 没有网络、没有真数据库、没有写仓库文件。autopersist flag 只在本进程内置 'true'，跑完还原。
//
// Run: node --test scripts/ops/scenario-b-replay-contract.test.mjs
// ---------------------------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { EXIT_CODES, parseArgs, runReplay } from './scenario-b-replay.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..', '..', 'plugins', 'plugin-integration-core')
const LIB_DIR = path.join(PLUGIN_DIR, 'lib')
const require = createRequire(import.meta.url)

const fixture = require(path.join(PLUGIN_DIR, 'fixtures', 'scenario-b-synthetic-bom', 'scenario-b-synthetic-bom.cjs'))
const httpRoutes = require(path.join(LIB_DIR, 'http-routes.cjs'))
const { createReadSourceConfigStore, contentKeyFor } = require(path.join(LIB_DIR, 'read-source-config-store.cjs'))
const { validateReadSourceConfig } = require(path.join(LIB_DIR, 'read-source-config.cjs'))
const { EXTERNAL_SYSTEMS_TABLE } = require(path.join(LIB_DIR, 'external-system-pointer-lock.cjs'))
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require(path.join(LIB_DIR, 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))

const AUTOPERSIST_FLAG = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
const TENANT_ID = 'tenant_scenario_b_contract'
const ADMIN_USER = Object.freeze({
  id: 'user_admin_scenario_b_contract',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin'],
})
const DEFAULT_WORKSPACE_OF_OLD_SCRIPT = 'workspace_scenario_b'

// ── 有作用域语义的内存 db（配置仓用）───────────────────────────────────────────────────────
// `externalSystems`：登记替身的行数组（createExternalSystemRegistryDouble().systems）。真 saveVersion 铸新指针前
// 会在事务内对目标外部系统行取 FOR KEY SHARE（删除锁协议的写入方半边）；这张 db 里没有 integration_external_systems
// 表，系统登记在替身里，所以锁读按 tenant_id + id（与真锁的 where 同形、不带 workspace）去替身里解析，查不到就
// 返回 null —— 「未登记 / 已删除即拒绝」的语义在这条车道上是真的。刻意不写成「任何 id 都活」的桩。
function createScopedMemoryDb({ externalSystems = [] } = {}) {
  const tables = {}
  const tableOf = (name) => { if (!tables[name]) tables[name] = []; return tables[name] }
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (value === null || value === undefined) return row[key] === null || row[key] === undefined
    return row[key] === value
  })
  let clock = 0
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString()
  const db = {
    tables,
    async selectOne(table, where) { return tableOf(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) {
      const stored = { ...row, created_at: row.created_at || stamp(), updated_at: row.updated_at || stamp() }
      tableOf(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = tableOf(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: stamp() })
      return [row]
    },
    async select(table, options = {}) {
      const filtered = tableOf(table).filter((row) => matches(row, options.where || {}))
      const from = options.offset || 0
      return filtered.slice(from, from + (options.limit || 1000))
    },
    async transaction(callback) { return callback(db) },
    // 锁协议的隔离级别钉定（external-system-pointer-lock.cjs pinLockProtocolIsolation：参与事务的第一条语句
    // SET TRANSACTION ISOLATION LEVEL READ COMMITTED）。这里是空操作——内存 db 没有隔离级别可设；钉定的顺序与效果
    // 由 external-systems-delete-bind-lock-protocol.test.cjs 与真 PG 套件负责。
    async setTransactionIsolationLevel() {},
    async selectOneForKeyShare(table, where) {
      if (table !== EXTERNAL_SYSTEMS_TABLE) return db.selectOne(table, where)
      const keys = Object.keys(where || {}).sort()
      if (keys.join(',') !== 'id,tenant_id') {
        // 锁协议的作用域就是 tenant_id + id（external-system-pointer-lock.cjs「SCOPE OF THE LOCK」）；别的形状不是这条协议。
        throw new Error(`replay contract: KEY SHARE on ${table} must be keyed by tenant_id + id, got ${keys.join(',')}`)
      }
      const row = externalSystems.find((s) => s.tenantId === where.tenant_id && s.id === where.id)
      if (!row) return null
      return { id: row.id, tenant_id: row.tenantId, workspace_id: row.workspaceId, kind: row.kind, role: row.role, config: { ...row.config } }
    },
  }
  return db
}

// ── 内存 staging 落点（scenario-b-v2-snapshot-diff.test.cjs 同款）────────────────────────────
function createInMemoryStagingStore() {
  const sheets = new Map()
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
      const id = `rec_replay_contract_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
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
      return { id: recordId, sheetId, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(_input, operation) {
      const previous = tail
      let release
      tail = new Promise((resolve) => { release = resolve })
      await previous
      try { return await operation(recordsApi) } finally { release() }
    },
  }
  const provisioningApi = {
    async findObjectSheet({ objectId } = {}) { return { id: `sheet_${objectId}` } },
    async resolveFieldIds({ fieldIds } = {}) {
      return Object.fromEntries((fieldIds || []).map((fieldId) => [fieldId, fieldId]))
    },
  }
  return { recordsApi, provisioningApi }
}

function throwingStub(name, methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => {
    throw new Error(`${name}.${method} is not exercised by the replay contract test`)
  }]))
}

// 外部系统登记表替身：按 (tenant, workspace, id) 存；查找「精确 → 租户级 null」回退（#5472 语义）。
function createExternalSystemRegistryDouble() {
  const systems = []
  const norm = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return {
    systems,
    async upsertExternalSystem(input) {
      const key = { tenantId: input.tenantId, workspaceId: norm(input.workspaceId), id: input.id }
      const at = systems.findIndex((s) => s.tenantId === key.tenantId && s.workspaceId === key.workspaceId && s.id === key.id)
      const row = { ...key, kind: input.kind, role: input.role, config: { ...(input.config || {}) } }
      if (at >= 0) systems[at] = row
      else systems.push(row)
      return { id: row.id, kind: row.kind, role: row.role, workspaceId: row.workspaceId }
    },
    async getExternalSystemForAdapter(input) {
      const workspaceId = norm(input.workspaceId)
      const find = (ws) => systems.find((s) => s.tenantId === input.tenantId && s.workspaceId === ws && s.id === input.id)
      const row = find(workspaceId) || (workspaceId !== null ? find(null) : undefined)
      if (!row) {
        const error = new Error('external system not found')
        error.name = 'ExternalSystemNotFoundError'
        throw error
      }
      return { id: row.id, tenantId: row.tenantId, kind: row.kind, role: row.role, config: row.config, credentials: {} }
    },
  }
}

// 一整台「后端」：真 handler + 真配置仓 + 替身登记表/facade/staging。`source.rows` 是合成表当前内容。
function createBackend() {
  const registry = createExternalSystemRegistryDouble()
  // 配置仓的写入方锁按 tenant_id + id 去登记替身里解析目标系统（见 createScopedMemoryDb 头注）。
  const db = createScopedMemoryDb({ externalSystems: registry.systems })
  let configSeq = 0
  const readSourceConfigStore = createReadSourceConfigStore({ db, idGenerator: () => `replay_contract_cfg_${++configSeq}` })
  const staging = createInMemoryStagingStore()
  const source = { rows: fixture.ROWS }
  const dataSources = {
    async test() { return { success: true } },
    async getSchema() { return { tables: [] } },
    async getTableInfo() { return { columns: [] } },
    async select(_dataSourceId, _table, options) {
      let matched = source.rows
      if (options && options.where) {
        matched = matched.filter((row) => Object.entries(options.where).every(([column, value]) => String(row[column]) === String(value)))
      }
      const offset = Number.isInteger(options && options.offset) ? options.offset : 0
      const limit = Number.isInteger(options && options.limit) ? options.limit : matched.length
      return { data: matched.slice(offset, offset + limit).map((row) => ({ ...row, qty: String(row.qty) })) }
    },
  }
  const context = {
    api: {
      http: { addRoute() {} },
      multitable: { provisioning: staging.provisioningApi, records: staging.recordsApi },
      dataSources,
    },
    storage: { durable: false, async get() { return null }, async set() {}, async delete() {}, async list() { return [] } },
    config: {},
  }
  const services = {
    externalSystemRegistry: {
      ...throwingStub('externalSystemRegistry', ['getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      upsertExternalSystem: registry.upsertExternalSystem,
      getExternalSystemForAdapter: registry.getExternalSystemForAdapter,
    },
    adapterRegistry: {
      listAdapterKinds() { return [ADAPTER_KIND] },
      createAdapter(system, options = {}) {
        return createDataSourceSqlReadonlySourceAdapter({ system, context, principal: options.principal })
      },
    },
    readSourceConfigStore,
    readSourceCompositionConfigStore: throwingStub('readSourceCompositionConfigStore', ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: throwingStub('bridgeAgentChecklistStore', ['saveVersion', 'approve', 'retire', 'getForApply']),
    pipelineRegistry: throwingStub('pipelineRegistry', ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: throwingStub('pipelineRunner', ['runPipeline']),
    deadLetterStore: throwingStub('deadLetterStore', ['listDeadLetters']),
    stagingInstaller: throwingStub('stagingInstaller', ['installStaging', 'listStagingDescriptors']),
    templateRegistry: throwingStub('templateRegistry', ['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
  }
  const handlers = httpRoutes.createHandlers(services, { context, logger: { warn() {}, error() {}, info() {} } })

  const requests = []
  async function invoke(handlerName, req) {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
    }
    try {
      await handlers[handlerName]({ ...req, user: ADMIN_USER, authenticatedTenantId: TENANT_ID }, res)
    } catch (error) {
      httpRoutes.__internals.sendError(res, error)
    }
    return res
  }

  // 脚本的 fetchImpl —— 按「方法 + 路径」分派到真 handler。
  async function fetchImpl(url, init = {}) {
    const u = new URL(url)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : {}
    const query = Object.fromEntries(u.searchParams)
    const p = u.pathname
    requests.push({ method, path: p, query, body })
    const reply = (status, payload) => ({ status, async text() { return JSON.stringify(payload) } })
    if (p === '/api/integration/stock-preparation/preflight') {
      return reply(200, { ok: true, data: {
        checks: { sandboxWriteAuthorization: {
          objectIdNamespacePrefix: 'plm_stock_preparation_sandbox', modeEnabled: true,
          allowlist: [], declaredSandboxTargetObjectIds: [], droppedNonNamespaceEntries: 0,
        } },
        posture: { productionApply: { state: 'closed' } },
      } })
    }
    let handlerName
    let params = {}
    let match
    if (method === 'POST' && p === '/api/integration/external-systems') handlerName = 'externalSystemsUpsert'
    else if (method === 'POST' && p === '/api/integration/read-source-configs') handlerName = 'readSourceConfigsSave'
    else if (method === 'POST' && (match = p.match(/^\/api\/integration\/read-source-configs\/([^/]+)\/approve$/))) {
      handlerName = 'readSourceConfigsApprove'
      params = { id: decodeURIComponent(match[1]) }
    } else if (method === 'POST' && (match = p.match(/^\/api\/integration\/read-source-configs\/([^/]+)\/retire$/))) {
      handlerName = 'readSourceConfigsRetire'
      params = { id: decodeURIComponent(match[1]) }
    } else if (method === 'POST' && p === '/api/integration/stock-preparation/mvp/source-runs/plm-bom') handlerName = 'stockPreparationPlmBomSourceRun'
    else if (method === 'GET' && p === '/api/integration/stock-preparation/snapshot-batches') handlerName = 'stockPreparationSnapshotBatchList'
    else if (method === 'GET' && (match = p.match(/^\/api\/integration\/stock-preparation\/snapshot-batches\/([^/]+)\/diff$/))) {
      handlerName = 'stockPreparationSnapshotDiff'
      params = { snapshotBatchId: decodeURIComponent(match[1]) }
    } else if (method === 'GET' && (match = p.match(/^\/api\/integration\/stock-preparation\/snapshot-batches\/([^/]+)\/diff\/rows$/))) {
      handlerName = 'stockPreparationSnapshotDiffRows'
      params = { snapshotBatchId: decodeURIComponent(match[1]) }
    } else {
      throw new Error(`replay contract: unrouted ${method} ${p}`)
    }
    const res = await invoke(handlerName, { body, query, params })
    return reply(res.statusCode, res.body)
  }

  // 换表：操作员动作在测试里就是把 facade 看到的内容换成 v2。
  const reseed = async () => { source.rows = fixture.ROWS_V2; return { ok: true, reason: 'contract_reseed_v2' } }
  // 每次完整复演开始前，合成表回到 v1（真机上是操作员重灌 02-seed.sql —— 脚本本身不连库）。
  const resetToV1 = () => { source.rows = fixture.ROWS }

  return { fetchImpl, reseed, resetToV1, requests, db, registry }
}

function replayArgs(extra = []) {
  return parseArgs(['node', 'scenario-b-replay.mjs', '--base-url', 'http://127.0.0.1:8900', '--token', 'contract', '--mode', 'v1v2', ...extra])
}

const BASE_URL = 'http://127.0.0.1:8900'

// 用真 externalSystemsUpsert handler 登记一个外部系统 —— 与脚本 REGISTER_SYSTEM 步同一请求形状。
async function registerSystem(backend, id = 'syn-bom-source-b1') {
  const res = await backend.fetchImpl(`${BASE_URL}/api/integration/external-systems`, {
    method: 'POST',
    body: JSON.stringify({ id, name: 'scenario-b-synthetic-bom', kind: ADAPTER_KIND, role: 'source', config: { dataSourceId: 'syn-bom-postgres-b1' } }),
  })
  const body = JSON.parse(await res.text())
  assert.ok(res.status === 200 || res.status === 201, `register ${id}: ${res.status} ${JSON.stringify(body)}`)
  return body
}

async function saveConfig(backend, config) {
  const res = await backend.fetchImpl(`${BASE_URL}/api/integration/read-source-configs`, { method: 'POST', body: JSON.stringify({ config }) })
  return { status: res.status, body: JSON.parse(await res.text()) }
}

async function withAutoPersist(run) {
  const prev = process.env[AUTOPERSIST_FLAG]
  process.env[AUTOPERSIST_FLAG] = 'true'
  try { return await run() } finally {
    if (prev === undefined) delete process.env[AUTOPERSIST_FLAG]
    else process.env[AUTOPERSIST_FLAG] = prev
  }
}

function summarize(report) {
  return JSON.stringify({ stoppedAt: report.stoppedAt, exitCode: report.exitCode, steps: report.steps.map((s) => `${s.step}:${s.status}:${s.ok}`) })
}

async function fullReplay(backend, args) {
  backend.resetToV1()
  return runReplay({ args, fetchImpl: backend.fetchImpl, reseed: backend.reseed, fixture })
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// F3 —— 保存 / 审批 / 运行 / 读取用同一作用域
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('F3：默认参数下，真保存/审批/源运行 handler + 真配置仓，一次完整复演走通（首跑不再 RUN_V1=404）', async () => {
  await withAutoPersist(async () => {
    const backend = createBackend()
    const report = await fullReplay(backend, replayArgs())
    assert.equal(report.exitCode, EXIT_CODES.OK, summarize(report))
    assert.equal(report.stoppedAt, 'VERIFY_EXPECTED')
    // 配置落在哪个作用域，源运行就在哪个作用域取 —— 由真 getForRuntime 的精确匹配兑现，不是替身说了算。
    const configs = backend.db.tables.integration_read_source_configs
    assert.equal(configs.length, 1)
    assert.equal(configs[0].status, 'approved')
    const runs = backend.requests.filter((r) => r.path.endsWith('/source-runs/plm-bom'))
    assert.equal(runs.length, 2)
    for (const run of runs) {
      const carried = run.body.workspaceId ?? run.query.workspaceId ?? null
      assert.equal(carried, configs[0].workspace_id ?? null, '源运行携带的作用域 = 配置保存时的作用域')
    }
  })
})

test('F3：显式 --workspace 时，登记/保存/审批/源运行/读取全链带同一个 workspace，且照样走通', async () => {
  await withAutoPersist(async () => {
    const backend = createBackend()
    const report = await fullReplay(backend, replayArgs(['--workspace', 'ws_contract_explicit']))
    assert.equal(report.exitCode, EXIT_CODES.OK, summarize(report))
    const configs = backend.db.tables.integration_read_source_configs
    assert.equal(configs.length, 1)
    assert.equal(configs[0].workspace_id, 'ws_contract_explicit', '配置真的存在所选 workspace 下')
    assert.equal(backend.registry.systems[0].workspaceId, 'ws_contract_explicit', '外部系统登记在同一 workspace')
    for (const request of backend.requests.filter((r) => r.path !== '/api/integration/stock-preparation/preflight')) {
      const carried = request.body.workspaceId ?? request.query.workspaceId ?? null
      assert.equal(carried, 'ws_contract_explicit', `${request.method} ${request.path} 带同一作用域`)
    }
  })
})

test('F3 反例钉住：store 作用域没被放宽 —— 配置存在 NULL、却按 workspace 取，真 getForRuntime 仍 404', async () => {
  const backend = createBackend()
  // 真 saveVersion 铸指针前先解析目标系统（写入方锁），所以和脚本一样先 REGISTER_SYSTEM 再 SAVE_CONFIG。
  await registerSystem(backend)
  const saved = await backend.fetchImpl('http://127.0.0.1:8900/api/integration/read-source-configs', {
    method: 'POST', body: JSON.stringify({ config: fixture.readSourceConfig({ systemId: 'syn-bom-source-b1' }) }),
  })
  const savedBody = JSON.parse(await saved.text())
  assert.equal(saved.status, 201)
  assert.equal(backend.db.tables.integration_read_source_configs[0].workspace_id ?? null, null)
  await withAutoPersist(async () => {
    const approved = await backend.fetchImpl(`http://127.0.0.1:8900/api/integration/read-source-configs/${savedBody.data.id}/approve`, { method: 'POST', body: '{}' })
    assert.equal(approved.status, 200)
    const run = await backend.fetchImpl('http://127.0.0.1:8900/api/integration/stock-preparation/mvp/source-runs/plm-bom', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: DEFAULT_WORKSPACE_OF_OLD_SCRIPT, projectId: 'business_project_scope_probe', sourceProjectNo: fixture.PROJECT_NO,
        readSourceConfigId: savedBody.data.id, syncRunId: 'scope_probe_run', snapshotBatchId: 'scope_probe_batch', snapshotVersion: 1,
      }),
    })
    assert.equal(run.status, 404, '作用域不一致时真仓照旧拒绝 —— 修的是脚本，不是仓')
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 写入方锁协议（外部系统删除 × 指针写入）—— 真 saveVersion 铸新指针前先在事务内解析目标外部系统行。
// 这条车道上解析落到登记替身（按 tenant_id + id），所以「未登记 / 已删除即 400」在这里是真的；
// 若把假件改成「任何 id 都活」，下面两条会红。
// ══════════════════════════════════════════════════════════════════════════════════════════════

const SYSTEM_NOT_FOUND_TUPLE = Object.freeze([{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }])

test('锁协议：未登记的 systemId → 真 saveVersion 拒 400 READ_SOURCE_CONFIG_INVALID（tuple READ_SOURCE_SYSTEM_NOT_FOUND），不落行、不落审计、不回显 id', async () => {
  const backend = createBackend()
  const { status, body } = await saveConfig(backend, fixture.readSourceConfig({ systemId: 'syn-bom-source-never-registered' }))
  assert.equal(status, 400, JSON.stringify(body))
  assert.equal(body.error.code, 'READ_SOURCE_CONFIG_INVALID')
  assert.deepEqual(body.error.details.errors, SYSTEM_NOT_FOUND_TUPLE)
  assert.ok(!JSON.stringify(body).includes('never-registered'), 'values-free：拒绝面不回显 systemId')
  assert.equal((backend.db.tables.integration_read_source_configs || []).length, 0, '没有铸出指向未登记系统的指针')
  assert.equal((backend.db.tables.integration_read_source_config_audit || []).length, 0, '没有审计行')
})

test('锁协议：登记过又删掉的 systemId → 新内容再存同样 400；别的租户里的同 id 登记不算（按 tenant_id + id 解析）', async () => {
  const backend = createBackend()
  await registerSystem(backend)
  const live = await saveConfig(backend, fixture.readSourceConfig())
  assert.equal(live.status, 201, JSON.stringify(live.body))
  // 「删除已提交」在替身里就是行消失；同时放一条别的租户的同 id 登记，证明解析不跨租户。
  backend.registry.systems.splice(0, backend.registry.systems.length, {
    tenantId: 'tenant_someone_else', workspaceId: null, id: 'syn-bom-source-b1', kind: ADAPTER_KIND, role: 'source', config: {},
  })
  // 同内容再存会命中内容幂等复用（reuseExisting 不铸指针、不加锁），所以换一个 object 走铸造路径。
  const minted = await saveConfig(backend, fixture.readSourceConfig({ object: 'scenario_b_bom_rows_probe' }))
  assert.equal(minted.status, 400, JSON.stringify(minted.body))
  assert.equal(minted.body.error.code, 'READ_SOURCE_CONFIG_INVALID')
  assert.deepEqual(minted.body.error.details.errors, SYSTEM_NOT_FOUND_TUPLE)
  assert.equal(backend.db.tables.integration_read_source_configs.length, 1, '只剩系统存活时铸的那一版')
})

// ── 登记的复用路径例外（第二轮复审：保证 9 只对「铸新版本」成立）──────────────────────────────
// 真 saveVersion 的内容键复用查找在事务与锁**之前**执行、不看系统是否存在（read-source-config-store.cjs
// reuseExisting）。所以「系统不存在 → 400」只对内容键未命中家族的铸造路径成立；相同内容命中既有行时走复用分支，
// 路由映射是 409（retired）或 200（活行），不是 400。两条用例把这两个出口钉在真 handler 上，
// 与设计文档 §2.6 的登记同步；owner 若裁定「一律 400」，须把存在性检查挪到复用分支之前，并连同这两条一起退掉。

test('登记例外 A：相同内容已有 retired 版本、系统随后删除 → 再存同内容走锁之前的内容复用分支，真路由 409 READ_SOURCE_CONFIG_STATUS_CONFLICT（reason content_retired），不是 400；不落行、不落审计', async () => {
  const backend = createBackend()
  await registerSystem(backend)
  const config = fixture.readSourceConfig()
  const saved = await saveConfig(backend, config)
  assert.equal(saved.status, 201, JSON.stringify(saved.body))
  const approved = await backend.fetchImpl(`${BASE_URL}/api/integration/read-source-configs/${saved.body.data.id}/approve`, { method: 'POST', body: '{}' })
  assert.equal(approved.status, 200)
  const retired = await backend.fetchImpl(`${BASE_URL}/api/integration/read-source-configs/${saved.body.data.id}/retire`, { method: 'POST', body: '{}' })
  assert.equal(retired.status, 200, await retired.text())
  // 系统的删除已提交（retired 行不被删除守卫计数，所以删除放行）——在替身里就是登记行消失。
  backend.registry.systems.splice(0, backend.registry.systems.length)
  const rowsBefore = backend.db.tables.integration_read_source_configs.length
  const auditBefore = backend.db.tables.integration_read_source_config_audit.length

  const again = await saveConfig(backend, config)
  assert.equal(again.status, 409, JSON.stringify(again.body))
  assert.equal(again.body.error.code, 'READ_SOURCE_CONFIG_STATUS_CONFLICT')
  assert.equal(again.body.error.details.reason, 'content_retired')
  assert.equal(again.body.error.details.id, saved.body.data.id, 'details 带的是配置 id（既有形状），不是系统 id')
  assert.ok(!JSON.stringify(again.body).includes('syn-bom-source-b1'), 'values-free：不回显 systemId')
  assert.equal(backend.db.tables.integration_read_source_configs.length, rowsBefore, '没有铸新行')
  assert.equal(backend.db.tables.integration_read_source_config_audit.length, auditBefore, '没有审计行')
  // 换新内容走铸造路径，才是锁守的那条：400 tuple。
  const fresh = await saveConfig(backend, fixture.readSourceConfig({ object: 'scenario_b_bom_rows_probe' }))
  assert.equal(fresh.status, 400, JSON.stringify(fresh.body))
  assert.deepEqual(fresh.body.error.details.errors, SYSTEM_NOT_FOUND_TUPLE)
})

test('登记例外 B：存量活行（协议之前铸的、系统已不存在）以相同内容再存 → 真路由 200 reused:true 并写 reuse_version 审计（不加锁）；换新内容才 400', async () => {
  const backend = createBackend()
  const config = fixture.readSourceConfig({ systemId: 'syn-bom-source-legacy' })
  const normalized = validateReadSourceConfig(config).normalized
  // 直接落一条协议之前的活行：系统从未在替身里登记过。
  backend.db.tables.integration_read_source_configs = [{
    id: 'legacy_cfg_1', tenant_id: TENANT_ID, workspace_id: null, system_id: 'syn-bom-source-legacy',
    object: normalized.object, mode: normalized.mode, config: { ...normalized, version: 1 },
    content_key: contentKeyFor(normalized), version: 1, status: 'draft', created_by: null, updated_by: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }]
  const reused = await saveConfig(backend, config)
  assert.equal(reused.status, 200, JSON.stringify(reused.body))
  assert.equal(reused.body.data.reused, true)
  assert.equal(reused.body.data.id, 'legacy_cfg_1')
  const audits = backend.db.tables.integration_read_source_config_audit || []
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'reuse_version')
  assert.equal(backend.db.tables.integration_read_source_configs.length, 1, '没有铸新指针')
  const fresh = await saveConfig(backend, fixture.readSourceConfig({ systemId: 'syn-bom-source-legacy', object: 'scenario_b_bom_rows_probe' }))
  assert.equal(fresh.status, 400, JSON.stringify(fresh.body))
  assert.deepEqual(fresh.body.error.details.errors, SYSTEM_NOT_FOUND_TUPLE)
  assert.equal(backend.db.tables.integration_read_source_configs.length, 1)
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// F4 —— 连续两次完整复演
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('F4：同一台后端上连续两次完整复演都成功（已批准版本复用不再 409；前驱不再歧义）', async () => {
  await withAutoPersist(async () => {
    const backend = createBackend()
    const first = await fullReplay(backend, replayArgs())
    assert.equal(first.exitCode, EXIT_CODES.OK, `first: ${summarize(first)}`)
    const second = await fullReplay(backend, replayArgs())
    assert.equal(second.exitCode, EXIT_CODES.OK, `second: ${summarize(second)}`)

    // 第二次保存命中了真 saveVersion 的内容幂等复用；审批被识别为已批准而跳过，没有再发 approve。
    const approveCalls = backend.requests.filter((r) => r.path.endsWith('/approve'))
    assert.equal(approveCalls.length, 1, '只有第一次真的发了 approve')
    const secondApprove = second.steps.find((s) => s.step === 'APPROVE_CONFIG')
    assert.equal(secondApprove.ok, true)
    assert.equal(secondApprove.skipped, 'reused_approved_version')
    assert.equal(backend.db.tables.integration_read_source_configs.length, 1, '没有为绕开复用而铸新版本')

    // 两次演练在各自隔离的业务项目上：diff 的基线各自是本次的 v1。
    assert.notEqual(first.rehearsal.projectSuffix, second.rehearsal.projectSuffix)
    const runProjects = new Set(backend.requests.filter((r) => r.path.endsWith('/source-runs/plm-bom')).map((r) => r.body.projectId))
    assert.equal(runProjects.size, 2, '两次复演各用一个项目')
  })
})

test('F4 反例钉住：历史守卫没被关 —— 同一项目上再落 v1，真落库拒 422 版本非单调；两个同版本前驱时真 pickPredecessor 拒 ambiguous', async () => {
  await withAutoPersist(async () => {
    const backend = createBackend()
    const first = await fullReplay(backend, replayArgs())
    assert.equal(first.exitCode, EXIT_CODES.OK, summarize(first))
    const firstRun = backend.requests.find((r) => r.path.endsWith('/source-runs/plm-bom'))
    const scope = firstRun.body.workspaceId ? { workspaceId: firstRun.body.workspaceId } : {}
    backend.resetToV1()
    // 旧脚本第二次执行的请求形状：同一业务项目、固定 snapshotVersion 1。
    const again = await backend.fetchImpl('http://127.0.0.1:8900/api/integration/stock-preparation/mvp/source-runs/plm-bom', {
      method: 'POST',
      body: JSON.stringify({
        ...scope, projectId: firstRun.body.projectId, sourceProjectNo: fixture.PROJECT_NO,
        readSourceConfigId: firstRun.body.readSourceConfigId, syncRunId: 'dup_run_v1', snapshotBatchId: 'dup_batch_v1', snapshotVersion: 1,
      }),
    })
    const body = JSON.parse(await again.text())
    assert.equal(again.status, 422)
    assert.equal(body.error.code, 'PERSIST_VERSION_NOT_MONOTONIC')
  })
  // 若历史里真出现同版本的两个前驱（并发写入等），diff 读面的歧义保护仍在（真函数，复审 R3 的四批次形状）。
  const { __internals } = require(path.join(LIB_DIR, 'stock-preparation-snapshot-reads.cjs'))
  assert.throws(() => __internals.pickPredecessor([
    { snapshotBatchId: 'previous_v1', snapshotVersion: 1 },
    { snapshotBatchId: 'previous_v2', snapshotVersion: 2 },
    { snapshotBatchId: 'new_v1', snapshotVersion: 1 },
    { snapshotBatchId: 'new_v2', snapshotVersion: 2 },
  ], 'new_v2', 2), (error) => error.code === 'SNAPSHOT_DIFF_BATCH_INCOMPLETE' && error.details.reason === 'ambiguous')
})
