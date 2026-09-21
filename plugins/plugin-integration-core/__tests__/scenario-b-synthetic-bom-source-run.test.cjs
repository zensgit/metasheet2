'use strict'

// ---------------------------------------------------------------------------
// 场景 B / W7-A1 —— 合成 BOM 夹具经既有 data-source:sql-readonly 受控源跑通只读读取。
//
// owner 裁决（SC-01）:「首个增量做 B：本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收。
// 可先用合成字段，不等客户真实字典；不启动 C 的环境/分页工作，不读真实 PLM/K3，不启用生产
// autopersist」。本套件是 A1：只证读取。**不落 staging、不 autopersist**（那是 A2）。
//
// 这条链上真正跑的是产品代码，一个都没换：
//   lib/adapters/data-source-sql-readonly-source-adapter.cjs  真适配器（含它的只读姿态）
//   lib/read-source-config.cjs                                真配置校验
//   lib/read-source-read-runtime.cjs                          真执行器（rowSource:'adapter_records'）
//   lib/stock-preparation-readonly-source-run.cjs             真 feeder（完整性证明 + 项目域守卫）
//   lib/stock-preparation-readonly-intake.cjs                 真 intake 契约
// 唯一被替掉的是**宿主的只读 data-source facade**（`context.api.dataSources`），它在真运行时由
// packages/core-backend 注入，是跨进程/跨语言的边界，node:test 里够不着。
//
// 关于那个替身，说清楚它**不是**什么：它不是 owner/租户门的背书。真正的 owner 门是宿主 facade 的
// `requirePrincipal` + `DataSourceManager.assertAccess`（packages/core-backend/src/data-adapters/
// data-source-plugin-facade.ts:272、DataSourceManager.ts:597-607），拿真对象跑的断言在
// packages/core-backend/tests/integration/scenario-b-synthetic-bom-source-run.test.ts 里。这里的替身
// 只做一件被动的事：记录它收到的每一个参数，让"适配器把 principal 原样递下去了吗、它有没有把
// dataSourceId 交给请求去选"这类**传递性**事实可被证伪。替身自己不拒绝任何人。
//
// Run: node __tests__/scenario-b-synthetic-bom-source-run.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const fixture = require(path.join(
  __dirname, '..', 'fixtures', 'scenario-b-synthetic-bom', 'scenario-b-synthetic-bom.cjs',
))
const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const { prepareConfiguredRead } = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))
const {
  StockPreparationReadonlySourceRunError,
  SOURCE_KIND_CAPABILITIES,
  SOURCE_PAGE_SIZE,
  runPlmBomReadonlySource,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-readonly-source-run.cjs'))
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'scenario-b-synthetic-bom')
const DATA_SOURCE_ID = 'syn-bom-postgres-b1'
const OWNER_PRINCIPAL = 'scenario-b-owner'
const SYSTEM = Object.freeze({
  id: 'syn-bom-source-b1',
  kind: ADAPTER_KIND,
  role: 'source',
  config: { dataSourceId: DATA_SOURCE_ID },
})

// 宿主只读 facade 的被动替身（见文件头）。行为面只做 PG 真正会做的三件事：where 等值过滤、
// offset/limit 切片、把 numeric 以字符串回吐（pg 驱动对 numeric 的真实行为）。任何写入方法都
// 不存在 —— 真 facade 也没有，`select` 是它唯一的数据面出口。
function recordingDataSourcesFacade({ rows = fixture.ROWS, onSelect } = {}) {
  const calls = []
  const api = {
    calls,
    async test(dataSourceId, principal) {
      calls.push({ method: 'test', dataSourceId, principal })
      return { success: true }
    },
    async getSchema(dataSourceId, principal, schema) {
      calls.push({ method: 'getSchema', dataSourceId, principal, schema })
      return { tables: [] }
    },
    async getTableInfo(dataSourceId, object, principal, schema) {
      calls.push({ method: 'getTableInfo', dataSourceId, object, principal, schema })
      return { columns: [] }
    },
    async select(dataSourceId, table, options, principal, strict) {
      calls.push({ method: 'select', dataSourceId, table, options, principal, strict })
      if (typeof onSelect === 'function') return onSelect({ dataSourceId, table, options, principal, strict })
      let matched = rows
      if (options && options.where) {
        matched = matched.filter((row) => Object.entries(options.where)
          .every(([column, value]) => String(row[column]) === String(value)))
      }
      const offset = Number.isInteger(options && options.offset) ? options.offset : 0
      const limit = Number.isInteger(options && options.limit) ? options.limit : matched.length
      const page = matched.slice(offset, offset + limit)
      // pg 把 numeric 作为字符串回吐；夹具的 qty 是 numeric，所以这里也回字符串 —— 否则
      // intake 的数值强转（firstNumber -> numberOrUndefined）就没被这条链真正走过。
      return { data: page.map((row) => ({ ...row, qty: String(row.qty) })) }
    },
  }
  return api
}

function sourceRuntime(facadeOptions) {
  const dataSources = recordingDataSourcesFacade(facadeOptions)
  const context = { api: { dataSources } }
  return {
    dataSources,
    system: { ...SYSTEM },
    createAdapter: (adapterSystem) => createDataSourceSqlReadonlySourceAdapter({
      system: adapterSystem,
      context,
      principal: OWNER_PRINCIPAL,
    }),
  }
}

function preparedRead(overrides = {}) {
  const validation = validateReadSourceConfig(fixture.readSourceConfig(overrides))
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  return prepareConfiguredRead({ config: validation.normalized })
}

function runInput(runtime, overrides = {}) {
  return {
    permission: 'admin',
    projectId: 'business_project_scenario_b',
    sourceProjectNo: fixture.PROJECT_NO,
    projectName: '合成备料项目 B1',
    syncRunId: 'scenario_b_run_1',
    snapshotBatchId: 'scenario_b_batch_1',
    snapshotVersion: 1,
    actor: OWNER_PRINCIPAL,
    preparedRead: preparedRead(),
    system: runtime.system,
    createAdapter: runtime.createAdapter,
    ...overrides,
  }
}

// --- 断言 1：行数 —— 合成表的 54 行全部读到，一行不多一行不少 ---------------------------
async function testEveryFixtureRowIsRead() {
  const runtime = sourceRuntime()
  const result = await runPlmBomReadonlySource(runInput(runtime))

  assert.equal(fixture.ROW_COUNT, 54)
  assert.equal(result.evidence.sourceRows, fixture.ROW_COUNT)
  assert.equal(result.evidence.intake.result.bomSnapshotLines, fixture.ROW_COUNT)
  assert.equal(result.evidence.intake.result.rowErrors, 0)
  assert.equal(result.evidence.sourceChannel, 'data_source')
  assert.equal(result.status, 'ready')
  assert.equal(result.mode, 'dry_run')

  // 两层父子都真的到了 intake 行平面（不是只读到根节点那一条 —— 这正是 raw 平面的老坑）。
  const levels = new Map()
  for (const line of result.intake.bomSnapshotLines) {
    levels.set(line.bomLevel, (levels.get(line.bomLevel) || 0) + 1)
  }
  assert.deepEqual([...levels.entries()].sort(), [[1, fixture.SUBASSEMBLY_COUNT], [2, 48]])

  // 每个配置字段都在真行上解析出了值（feeder 的 assertEveryConfiguredFieldResolved 已经把关，
  // 这里再钉一次具体值，防止"解析到了但全是 null"这种形状被当成通过）。
  const first = result.intake.bomSnapshotLines[0]
  assert.equal(first.parentDrawingNo, fixture.ROOT_PART_NO)
  assert.equal(first.childDrawingNo, 'SYN-SUB-01')
  assert.equal(first.designUnit, 'SET')
  assert.equal(first.childVersion, 'A1')
  // qty 是以 PG 的字符串形态过来的，intake 必须把它变成数字。
  assert.equal(typeof first.designQty, 'number')
  assert.equal(first.designQty, 2)
}

// --- 断言 2：完整性契约 —— 在 B 的 feeder 路径上它到底是什么形状 -------------------------
//
// 实证结论（写清，因为它和任务书的措辞不同）：`adapter_reported` **不适用于**
// data-source:sql-readonly。这个 kind 在 SOURCE_KIND_CAPABILITIES 里登记的是 `honours_request`
// （stock-preparation-readonly-source-run.cjs:60-62），因为它的适配器**不钳制**：它把
// request.limit 原样交给 facade 的 select，宿主再交给 PG 的 LIMIT。相应地它也**不回显**
// metadata.limit/effectiveLimit（适配器 :663-685 只回 object/dataSourceId/offset/count），所以
// effectivePageSize 走的是 honours_request 分支、用请求值。
//
// 那么 B 路径上"完整性"这件事成立的形式是：**证明**二选一（short_page / declared_total），
// 而不是 kind 的 limit 回显。下面三条把这个形状钉死。
async function testCompletenessContractOnTheBFeederPath() {
  // (a) kind 的契约就是 honours_request，不是 adapter_reported。
  assert.deepEqual(SOURCE_KIND_CAPABILITIES[ADAPTER_KIND], {
    pageSize: SOURCE_PAGE_SIZE,
    pagination: 'cursor',
    limitContract: 'honours_request',
  })

  // (b) 适配器确实兑现了请求的页宽：feeder 请求 SOURCE_PAGE_SIZE，宿主收到的就是同一个数。
  const runtime = sourceRuntime()
  const result = await runPlmBomReadonlySource(runInput(runtime))
  const selects = runtime.dataSources.calls.filter((call) => call.method === 'select')
  assert.equal(selects.length, 1)
  assert.equal(selects[0].options.limit, SOURCE_PAGE_SIZE)
  assert.equal(result.evidence.sourcePageSizeRequested, SOURCE_PAGE_SIZE)
  assert.equal(result.evidence.sourcePageSizeEffective, SOURCE_PAGE_SIZE)

  // (c) 54 < 1000 -> 短页，完整性由 short_page 证明；证明是被"写出来"的，不是被假设的。
  assert.equal(result.evidence.completenessProof, 'short_page')
  assert.equal(result.evidence.pages, 1)
  assert.equal(result.evidence.sourceRowsTruncated, false)
}

function paddedRows(count) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    const source = fixture.ROWS[index % fixture.ROW_COUNT]
    rows.push({ ...source, line_no: index + 1, path_key: `${source.path_key}#${index}` })
  }
  return rows
}

// (d) "证不出来就失败"在这条 kind 上的两个真实形状。两个都实跑，不靠推理。
async function testUnprovableReadsFailClosed() {
  // d-1 页预算耗尽：10 页 × 1000 行全满，源还可能有更多 —— 必须拒，不能把一个已知不完整的
  //     快照报成 ready。（10 × 1000 + 1 行）
  const overBudget = sourceRuntime({ rows: paddedRows(SOURCE_PAGE_SIZE * 10 + 1) })
  await assert.rejects(
    () => runPlmBomReadonlySource(runInput(overBudget)),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_RESULT_TOO_LARGE')
      assert.equal(error.details.maxPages, 10)
      return true
    },
  )

  // d-2 源**无视**请求的页宽、回得比它被允许的还多 —— 这正是 honours_request 契约被违反的方向，
  //     feeder 必须按名字拒（"太大"是一个事实，"证不出完整"是另一个，不许让运维去猜）。
  const overServing = sourceRuntime({
    onSelect: () => ({ data: paddedRows(SOURCE_PAGE_SIZE + 5).map((row) => ({ ...row, qty: String(row.qty) })) }),
  })
  await assert.rejects(
    () => runPlmBomReadonlySource(runInput(overServing)),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_RESULT_TOO_LARGE')
      assert.equal(error.details.receivedRows, SOURCE_PAGE_SIZE + 5)
      return true
    },
  )

  // 满一页之后跟进 offset 续页、续页为空 -> 这是被**证明**的完整（short_page），不是假设：
  // 源自己说了"没有更多"。这条钉住，是为了让上面两条的"拒"不被误读成"满页就拒"。
  const exactlyOnePage = sourceRuntime({ rows: paddedRows(SOURCE_PAGE_SIZE) })
  const proven = await runPlmBomReadonlySource(runInput(exactlyOnePage))
  assert.equal(proven.evidence.sourceRows, SOURCE_PAGE_SIZE)
  assert.equal(proven.evidence.pages, 2)
  assert.equal(proven.evidence.completenessProof, 'short_page')
}

// (e) 已知缺口，写成断言而不是写成散文，免得下一个人以为它被挡住了：
// 一个**悄悄钳制**的源（比如被换成会钳制的宿主实现）在这条 kind 上是抓不住的。sql-readonly 被
// 登记为 honours_request，而它的适配器不回显 metadata.limit/effectiveLimit，所以 feeder 没有任何
// 独立证人能看出"我要 1000、它只给了 20 却说没有更多了"。下面这一跑就是那个盲区：20 行被当成
// 完整快照收下。B 的合成源由我们自己灌数据，这个盲区在 A1 不致命；但它是 A2 之前 owner 该知道的
// 事，也是把 adapter_reported 这条契约扩到本 kind 的前提（要改的是适配器的 metadata，不是这里）。
async function testKnownGapSilentlyClampingSourceIsNotDetected() {
  const clamping = sourceRuntime({
    onSelect: () => ({ data: fixture.ROWS.slice(0, 20).map((row) => ({ ...row, qty: String(row.qty) })) }),
  })
  const result = await runPlmBomReadonlySource(runInput(clamping))
  assert.equal(result.evidence.sourceRows, 20)
  assert.equal(result.evidence.completenessProof, 'short_page')
  assert.equal(result.status, 'ready')
  // 如果哪天这一断言开始红，说明有人给这条 kind 补上了 limit 回显 —— 那是好事，
  // 请把这个测试改成正向断言，别把它删掉了事。
  assert.equal(SOURCE_KIND_CAPABILITIES[ADAPTER_KIND].limitContract, 'honours_request')
}

// --- 断言 3：只读 —— 这条 kind 上根本没有写入面 -----------------------------------------
async function testSourceIsReadOnly() {
  const runtime = sourceRuntime()
  const adapter = runtime.createAdapter({ ...SYSTEM })

  // 适配器自己拒绝写：upsert 是 unsupportedAdapterOperation，不是"没实现"。
  assert.equal(typeof adapter.upsert, 'function')
  await assert.rejects(
    () => adapter.upsert({ object: fixture.TABLE_NAME, records: [{ part_no: 'SYN-EVIL' }], keyFields: ['part_no'] }),
    (error) => {
      assert.equal(error.name, 'UnsupportedAdapterOperationError')
      return true
    },
  )
  // 除 upsert 外没有任何别的写动词。
  for (const verb of ['insert', 'update', 'delete', 'write', 'execute', 'query']) {
    assert.equal(adapter[verb], undefined, `adapter must not expose ${verb}`)
  }

  // 整条 feeder 跑完，宿主只被调用过 select —— 没有任何一次写方法调用，
  // 而且 select 只带 limit/offset（没有 SQL 文本入口）。
  await runPlmBomReadonlySource(runInput(runtime))
  assert.deepEqual([...new Set(runtime.dataSources.calls.map((call) => call.method))], ['select'])
  for (const call of runtime.dataSources.calls) {
    assert.deepEqual(Object.keys(call.options).sort(), ['limit', 'offset'])
  }

  // 证据面也必须自述"没写"。A2 会把 internalWriteExecuted 翻成 true —— 那是另一刀的事。
  const result = await runPlmBomReadonlySource(runInput(sourceRuntime()))
  assert.equal(result.evidence.internalWriteExecuted, false)
  assert.equal(result.evidence.externalWriteExecuted, false)
  assert.equal(result.evidence.productionWrite, false)
  assert.equal(result.evidence.autoApply, false)
  assert.equal(result.evidence.rawSql, false)
}

// --- 断言 4：权限门与作用域 ---------------------------------------------------------------
async function testPermissionAndScopeGates() {
  const runtime = sourceRuntime()

  // 无 admin 权限 -> 403，而且在任何 I/O 之前（宿主一次都没被调用过）。
  await assert.rejects(
    () => runPlmBomReadonlySource(runInput(runtime, { permission: 'read' })),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.status, 403)
      assert.equal(error.code, 'SOURCE_RUN_PERMISSION_DENIED')
      return true
    },
  )
  assert.equal(runtime.dataSources.calls.length, 0)

  // 源行自报的项目与本次运行的作用域不符 -> 409，整单拒（不是悄悄按本项目落下去）。
  await assert.rejects(
    () => runPlmBomReadonlySource(runInput(sourceRuntime(), { sourceProjectNo: 'SYN-PRJ-OTHER' })),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'SOURCE_RUN_PROJECT_SCOPE_MISMATCH')
      return true
    },
  )

  // 身份传递性：适配器把调用方 principal 原样递给宿主 facade 的每一次调用。宿主的 owner 门
  // （assertAccess）就是靠这个值判的；这里断言的是"值没被丢/没被换成默认身份"，
  // owner 门本身拿真对象在 core-backend 的姊妹套件里证。
  const scoped = sourceRuntime()
  await runPlmBomReadonlySource(runInput(scoped))
  assert.ok(scoped.dataSources.calls.length > 0)
  for (const call of scoped.dataSources.calls) {
    assert.equal(call.principal, OWNER_PRINCIPAL)
    // 数据源由系统配置定，不由请求定 —— 读请求没有任何一条路能换掉它。
    assert.equal(call.dataSourceId, DATA_SOURCE_ID)
  }
}

// --- 夹具漂移：committed 的 .sql 必须就是生成器的输出 -------------------------------------
async function testCommittedSqlMatchesGenerator() {
  const cases = [
    ['01-schema.sql', fixture.schemaSql()],
    ['02-seed.sql', fixture.seedSql()],
    // v2 种子（对账演练的第二批次）与 01/02 受同一条漂移断言约束 —— 它也是生成物。
    ['03-seed-v2.sql', fixture.seedSqlV2()],
  ]
  for (const [name, expected] of cases) {
    const onDisk = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    assert.equal(onDisk, expected, `${name} 与生成器输出不一致，跑 node fixtures/scenario-b-synthetic-bom/regenerate.cjs`)
  }
  // 夹具是假数据这件事也要可被证伪，而不是靠 README 里的一句话。
  for (const name of ['02-seed.sql', '03-seed-v2.sql']) {
    const seed = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    assert.ok(!/DN_PDM_|Bom_ExAttr|ExAttr\d/i.test(seed), `${name}: 夹具不得模仿客户 PLM 的真实列名`)
    assert.equal((seed.match(/SYN-/g) || []).length > 100, true, `${name}: SYN- 前缀`)
  }
  // committed 的 03 相对 02 只有四处行级差异（四类变更各一）。这条断言钉的是「v2 不是另一份
  // 随手改出来的数据」：多改一行、少改一行都会在这里红。
  const seedRows = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    .split('\n').filter((line) => line.startsWith('  ('))
  const v1Rows = seedRows('02-seed.sql')
  const v2Rows = seedRows('03-seed-v2.sql')
  assert.equal(v1Rows.length, fixture.ROW_COUNT)
  assert.equal(v2Rows.length, fixture.ROW_COUNT_V2)
  // 逐行归一化（去掉行尾的 , / ; 差别）后取对称差：v1 独有 2 行（改数量前 + 替换前 + 被删），
  // v2 独有 2 行（改数量后 + 替换后 + 新增）—— 即 3 : 3。
  const bare = (line) => line.replace(/[,;]$/, '')
  const v1Set = new Set(v1Rows.map(bare))
  const v2Set = new Set(v2Rows.map(bare))
  assert.equal([...v1Set].filter((line) => !v2Set.has(line)).length, 3, 'v1 独有恰好 3 行（改数量前/替换前/被删）')
  assert.equal([...v2Set].filter((line) => !v1Set.has(line)).length, 3, 'v2 独有恰好 3 行（改数量后/替换后/新增）')
}

async function main() {
  await testEveryFixtureRowIsRead()
  await testCompletenessContractOnTheBFeederPath()
  await testUnprovableReadsFailClosed()
  await testKnownGapSilentlyClampingSourceIsNotDetected()
  await testSourceIsReadOnly()
  await testPermissionAndScopeGates()
  await testCommittedSqlMatchesGenerator()
  console.log('scenario-b synthetic BOM source-run tests: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
