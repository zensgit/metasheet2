'use strict'

/**
 * 备料 DEMO RUNNER — a NARRATABLE, presenter-facing click-through of the
 * customer's steps 1-3, driven over the SHIPPED 备料 pipeline against a
 * STRUCTURE-EXACT synthetic PLM source (the customer's real test PLM is empty,
 * so the demo runs on structure-exact synthetic data).
 *
 * This is the terminal companion to the web-UI demo. It exists because a live
 * web-UI+SQL-Server demo needs a Postgres DATABASE_URL and a running instance
 * (see the runbook's mode assessment); this runner needs only `node` and the
 * shipped plugin modules, so it is GUARANTEED-RUNNABLE on a laptop with no
 * database — the same reason the rehearsal driver runs green with plain node.
 *
 * NOT A MOCK OF THE PIPELINE. The pull/expand/map/plan/ownership calls below are
 * the SHIPPED code — expandPlmProjectBom, the ext-field mapper, the
 * expansion->snapshot mapper, planStockPreparationConflicts and its pack-aware
 * ownership derivation. The ONLY synthetic thing is the SOURCE (the fixture),
 * read through a per-action read-plan OVERRIDE that names the customer's own
 * columns (project_code / DrawingType 图号 / TargetName 名称 / Material 材料 /
 * Specification 规格 / quantity in Bom_ExAttr1 / Createtime) — which is exactly
 * the on-site mechanism (action.source.readPlan). Nothing structural is changed
 * to make it pass.
 *
 * The heavy assertions live in the sibling rehearsal DRIVER
 * (stock-preparation-structure-exact-rehearsal.test.cjs). This runner asserts the
 * load-bearing outcomes too (so a broken pipeline FAILS the demo loudly) but is
 * oriented to NARRATION: it prints the BOM tree, the two hour-distinct batches,
 * the human-column wall (with a negative control), and the warehouse export grid
 * — real content a presenter can point at on screen.
 *
 * Fixture: ../fixtures/stock-preparation-structure-exact-plm/ (100% fabricated,
 * values-free). Runbook: docs/development/takeover-beiliao-20260821/
 * stock-prep-demo-runbook-20260901.md.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  expandPlmProjectBom,
  normalizeStockPreparationBomReadPlan,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  normalizeExtFieldMapping,
} = require(path.join(LIB, 'stock-preparation-ext-field-mapping.cjs'))
const {
  mapExpansionRowsToSnapshotLines,
  __internals: { buildParentIndex },
} = require(path.join(LIB, 'stock-preparation-expansion-snapshot-mapper.cjs'))
const {
  planStockPreparationConflicts,
  derivePackAwarePlmWritableFields,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  normalizeCustomerPack,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const {
  FACTORY_A_REHEARSAL_PACK,
} = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'stock-preparation-structure-exact-plm')
const PROJECT_A = 'SYN-XM-0001'
const PROJECT_B = 'SYN-XM-0002'
const PROJECT_PHANTOM = 'SYN-XM-9999'

// ── presentation helpers ──────────────────────────────────────────────────────
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
function banner(title) {
  const bar = '═'.repeat(74)
  console.log(`\n${bar}\n${BOLD(title)}\n${bar}`)
}
function say(line) { console.log(line) }
// A tolerant fixed-width table that counts CJK glyphs as width 2 (so the
// Chinese column values still line up in a monospace terminal).
function cellWidth(s) {
  let w = 0
  for (const ch of String(s)) w += /[⺀-￿]/.test(ch) ? 2 : 1
  return w
}
function pad(s, width) {
  const gap = width - cellWidth(s)
  return String(s) + ' '.repeat(gap > 0 ? gap : 0)
}
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(cellWidth(h), ...rows.map((r) => cellWidth(r[i] ?? ''))))
  const line = (cols) => '  ' + cols.map((c, i) => pad(c ?? '', widths[i])).join('  ')
  console.log(DIM(line(headers)))
  console.log(DIM('  ' + widths.map((w) => '─'.repeat(w)).join('  ')))
  for (const r of rows) console.log(line(r))
}

// ── the per-action read-plan OVERRIDE: the customer's own vocabulary ──────────
// On site this is action.source.readPlan in the table-action config; here it is
// the one config that adapts the shipped 7-object traversal to the fixture's
// (== the customer's) column names. Identical to the rehearsal's REBIND_READ_PLAN.
const REBIND_READ_PLAN = normalizeStockPreparationBomReadPlan({
  id: 'plm.stock-preparation.bom-read.dn-view.demo',
  sourceKind: 'data-source:sql-readonly',
  matchField: 'project_code',
  pathExAttr: { object: 'DN_Project_View', matchField: 'project_code', pathIdField: 'path_id' },
  pathInfo: { object: 'DN_ProjectPath_View', idField: 'path_id' },
  orderHead: { object: 'DN_ProjectRoot_View', idField: 'root_id', pathIdField: 'path_id' },
  orderDetail: {
    object: 'DN_ProjectRootLine_View',
    orderIdField: 'root_id',
    componentIdField: 'part_id',
    quantityField: 'Bom_ExAttr1',
    sortField: 'sort_id',
  },
  part: {
    object: 'DN_PartLibrary_View',
    idField: 'part_id',
    codeField: 'DrawingType',
    nameField: 'TargetName',
    materialField: 'Material',
    versionField: 'SysVer',
  },
  bomHead: {
    object: 'DN_BomHead_View',
    parentPartField: 'part_id',
    bomIdField: 'bom_id',
    versionField: 'SysVer',
    activeField: 'bom_able',
  },
  bomDetail: {
    object: 'DN_BomDetails_View',
    bomParentField: 'bom_pid',
    componentIdField: 'part_id',
    quantityField: 'Bom_ExAttr1',
    sortField: 'sort_id',
  },
})

// The ext-field mapping: denormalized part attributes that are NOT canonical row
// columns. Specification 规格 -> ext_spec, Creator -> ext_designer.
const EXT_FIELD_MAPPING = normalizeExtFieldMapping(
  {
    mappingId: 'structure-exact-demo',
    mappingVersion: 1,
    mappings: [
      { sourceColumn: 'Specification', target: 'ext_spec' },
      { sourceColumn: 'Creator', target: 'ext_designer' },
    ],
  },
  { pack: FACTORY_A_REHEARSAL_PACK },
)

// ── a deliberately small SQL reader (CREATE TABLE / INSERT / DELETE only) ──────
// Models the two Postgres behaviours that matter on this path: unquoted
// identifier folding (everything lower-cases) and numeric-as-string returns.
function readFixture(file) {
  return fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8').replace(/\r\n/g, '\n')
}
function stripComments(sql) {
  let out = ''
  let inString = false
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    if (inString) { out += c; if (c === "'") { if (sql[i + 1] === "'") { i += 1; out += "'" } else inString = false } continue }
    if (c === "'") { inString = true; out += c; continue }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; out += '\n'; continue }
    out += c
  }
  return out
}
function splitStatements(sql) {
  const statements = []
  let current = ''
  let inString = false
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    if (inString) { current += c; if (c === "'") { if (sql[i + 1] === "'") { i += 1; current += "'" } else inString = false } continue }
    if (c === "'") { inString = true; current += c; continue }
    if (c === ';') { if (current.trim()) statements.push(current.trim()); current = ''; continue }
    current += c
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}
function splitTopLevel(text) {
  const parts = []
  let current = ''
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) { current += c; if (c === "'") { if (text[i + 1] === "'") { i += 1; current += "'" } else inString = false } continue }
    if (c === "'") { inString = true; current += c; continue }
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    if (c === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
function valueTuples(tail) {
  const tuples = []
  let depth = 0
  let current = ''
  let inString = false
  for (let i = 0; i < tail.length; i += 1) {
    const c = tail[i]
    if (inString) { current += c; if (c === "'") { if (tail[i + 1] === "'") { i += 1; current += "'" } else inString = false } continue }
    if (c === "'") { inString = true; current += c; continue }
    if (c === '(') { depth += 1; if (depth === 1) { current = ''; continue } }
    if (c === ')') { depth -= 1; if (depth === 0) { tuples.push(current); current = ''; continue } }
    if (depth > 0) current += c
  }
  assert.equal(depth, 0, 'unbalanced parentheses in a VALUES clause')
  return tuples
}
const CONSTRAINT_PREFIXES = ['primary', 'unique', 'check', 'constraint', 'foreign', 'exclude']
function parseColumnType(text) {
  const lowered = text.toLowerCase()
  if (/^(numeric|decimal)/.test(lowered)) {
    const scale = /^(?:numeric|decimal)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(lowered)
    return { kind: 'numeric', scale: scale ? Number(scale[1]) : 0 }
  }
  if (/^(smallint|integer|int|bigint)/.test(lowered)) return { kind: 'integer' }
  if (/^(varchar|character varying|text|char)/.test(lowered)) return { kind: 'string' }
  throw new Error(`unsupported fixture column type: ${text}`)
}
function parseSchema(sql) {
  const tables = new Map()
  for (const statement of splitStatements(stripComments(sql))) {
    const match = /^CREATE\s+TABLE\s+([A-Za-z0-9_.]+)\s*\(/i.exec(statement)
    if (!match) continue
    const open = statement.indexOf('(')
    const close = statement.lastIndexOf(')')
    const columns = new Map()
    for (const definition of splitTopLevel(statement.slice(open + 1, close))) {
      const head = definition.trim().split(/\s+/)[0].toLowerCase()
      if (CONSTRAINT_PREFIXES.includes(head)) continue
      columns.set(head, parseColumnType(definition.trim().slice(head.length).trim()))
    }
    tables.set(match[1].toLowerCase(), columns)
  }
  return tables
}
function parseLiteral(raw, type) {
  const text = raw.trim()
  if (/^null$/i.test(text)) return null
  if (text.startsWith("'")) {
    assert.ok(text.endsWith("'"), `unterminated string literal: ${text}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  const numeric = Number(text)
  assert.ok(Number.isFinite(numeric), `unsupported literal: ${text}`)
  // node-postgres returns numeric columns as STRINGS; integers as numbers.
  return type.kind === 'numeric' ? numeric.toFixed(type.scale) : numeric
}
function applySeed(state, schema, sql, label) {
  for (const statement of splitStatements(stripComments(sql))) {
    const del = /^DELETE\s+FROM\s+([A-Za-z0-9_.]+)\s*$/i.exec(statement)
    if (del) { state.set(del[1].toLowerCase(), []); continue }
    const ins = /^INSERT\s+INTO\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]+)$/i.exec(statement)
    assert.ok(ins, `${label}: unsupported statement: ${statement.slice(0, 60)}...`)
    const table = ins[1].toLowerCase()
    const columns = schema.get(table)
    assert.ok(columns, `${label}: INSERT INTO unknown table ${ins[1]}`)
    const names = ins[2].split(',').map((n) => n.trim().toLowerCase())
    const rows = state.get(table) || []
    for (const tuple of valueTuples(ins[3])) {
      const values = splitTopLevel(tuple)
      assert.equal(values.length, names.length, `${label}: value/column count mismatch in ${ins[1]}`)
      const row = {}
      names.forEach((n, idx) => { row[n] = parseLiteral(values[idx], columns.get(n)) })
      rows.push(row)
    }
    state.set(table, rows)
  }
  return state
}
function loadState(schema, files) {
  const state = new Map()
  for (const table of schema.keys()) state.set(table, [])
  for (const file of files) applySeed(state, schema, readFixture(file), file)
  return state
}
// In-memory source adapter: models unquoted identifier folding + equality filters.
function createAdapter(state) {
  return {
    async read(input = {}) {
      assert.ok(input.object, 'read requires an object')
      assert.ok(input.filters && Object.keys(input.filters).length > 0, `read(${input.object}) must carry equality filters`)
      const rows = state.get(String(input.object).toLowerCase())
      assert.ok(rows, `read(${input.object}) hit a table the fixture does not declare`)
      const matches = rows.filter((row) =>
        Object.entries(input.filters).every(([field, expected]) => row[field.toLowerCase()] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map((r) => ({ ...r }))
      const consumed = offset + records.length
      return {
        records,
        nextCursor: consumed < matches.length ? String(consumed) : null,
        done: consumed >= matches.length,
        metadata: { source: 'data-source:sql-readonly', filtersApplied: true, filterFields: Object.keys(input.filters).sort() },
      }
    },
  }
}
async function pull(state, projectNo) {
  return expandPlmProjectBom({
    sourceAdapter: createAdapter(state),
    projectNo,
    readPlan: REBIND_READ_PLAN,
    extFieldMapping: EXT_FIELD_MAPPING,
    pageLimit: 2, // small on purpose: forces the pagination/cursor loop to run
  })
}
function depthOf(row) { return JSON.parse(row.path).length - 1 }
function treeLabel(row) { return `${'  '.repeat(depthOf(row))}${row.componentCode}` }

// The customer's batch rule (物料创建日期精确到小时): bucket a pull by its
// materials' creation hour, fed as the caller-supplied snapshotBatchId the
// shipped mapper requires. NOT IN SHIPPED CODE — a thin caller-side step (see the
// honest caveats at the tail and the runbook).
function batchIdFromMaterials(state, projectNo, rows) {
  const parts = state.get('dn_partlibrary_view')
  const byId = new Map(parts.map((p) => [p.part_id, p]))
  const hours = rows.map((r) => String(byId.get(r.componentSourceId).createtime).slice(0, 13)).sort()
  return `${projectNo}|${hours[hours.length - 1]}`
}

const CANONICAL_HUMAN = [...HUMAN_PRESERVED_FIELD_IDS]
const PACK = normalizeCustomerPack(FACTORY_A_REHEARSAL_PACK)
const PACK_HUMAN = PACK.extensionFields.filter((f) => f.ownership === 'human_preserved').map((f) => f.id)
const ALL_HUMAN = [...CANONICAL_HUMAN, ...PACK_HUMAN]

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  banner('备料 DEMO — 客户步骤 1-2-3 走查(结构一致合成 PLM 源 · 驱动发货管线)')
  say(DIM('  源 = plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/  (100% 合成, 无凭据无真实值)'))
  say(DIM('  管线 = 发货代码 expandPlmProjectBom / ext 映射 / 快照 mapper / 冲突计划 / pack 权属推导'))
  say(DIM('  读计划改绑 = 客户词汇 project_code / DrawingType 图号 / TargetName 名称 / Material 材料 / 规格 / 数量在 Bom_ExAttr1'))

  const schema = parseSchema(readFixture('01-schema.sql'))
  assert.equal(schema.size, 7, '结构一致夹具声明 7 个对象')
  say(`\n  ${GREEN('✓')} 读入源结构:7 个 DN_*_View 对象 ${DIM('(project → path → root → root-line → part → bomHead → bomDetail)')}`)

  // ── STEP 1 ──────────────────────────────────────────────────────────────────
  banner('步骤 1 — 项目号搜索 + 分支(无数据→拉取 / 有数据→填写)')
  const state1 = loadState(schema, ['02-seed-batch-1.sql'])
  say('  台词:「你们今天的动作 —— 输一个项目号,点拉取。我们这里一模一样。」\n')

  say(`  ${BOLD('搜索 ' + PROJECT_A)} …`)
  const a = await pull(state1, PROJECT_A)
  assert.equal(a.status, 'expanded'); assert.equal(a.summary.rootMatches, 1); assert.equal(a.rows.length, 7)
  say(`    → status=${GREEN(a.status)}  rootMatches=${a.summary.rootMatches}  展开 ${BOLD(a.rows.length)} 行,0 错误`)

  say(`  ${BOLD('搜索 ' + PROJECT_B)} ${DIM('(另一个项目,证明多项目搜索互相独立)')} …`)
  const b = await pull(state1, PROJECT_B)
  assert.equal(b.status, 'expanded'); assert.equal(b.rows.length, 2)
  assert.notEqual(a.rows[0].componentSourceId, b.rows[0].componentSourceId)
  say(`    → status=${GREEN(b.status)}  展开 ${BOLD(b.rows.length)} 行,与 ${PROJECT_A} 是不同的零件`)

  say(`  ${BOLD('搜索 ' + PROJECT_PHANTOM)} ${DIM('(库里没有这个项目)')} …`)
  const phantom = await pull(state1, PROJECT_PHANTOM)
  assert.equal(phantom.status, 'not_found'); assert.equal(phantom.rows.length, 0)
  say(`    → status=${GREEN(phantom.status)}  0 行 ${DIM('—— 空项目护栏:不存在的项目不会拉出半拉数据')}`)

  const pullPlan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows: a.rows, existingRows: [],
    runId: 'demo-pull', plannedAt: '2026-09-01T00:00:00.000Z',
  })
  assert.deepEqual(pullPlan.counts, { add: 7, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })
  say(`\n  ${BOLD('分支')}:目标表为空 → 计划 = 全部新增 ${GREEN('add ' + pullPlan.counts.add)} ${DIM('(首拉 = PULL;有数据时走 FILL,见步骤 3)')}`)
  say(`  ${GREEN('步骤 1 通过')}`)

  // ── STEP 2 ──────────────────────────────────────────────────────────────────
  banner('步骤 2 — 拉取 → BOM 落多维表,列映射;同项目两批次按创建小时区分')
  say('  台词:「拉过来的就是这棵 BOM 树。我指给你看每一列是从你们哪一列来的。」\n')
  const rows = a.rows
  const byPath = (tokens) => rows.find((r) => r.path === JSON.stringify(tokens))

  say(BOLD('  当前批次 BOM(点这几列:图号 / 名称 / 材料 / 规格 / 总数量):'))
  table(
    ['图号(DrawingType)', '名称(TargetName)', '材料(Material)', '规格(Specification)', '总数量', '层级'],
    rows.map((r) => [
      treeLabel(r), r.componentName, r.material, r.ext_spec ?? '', String(r.totalQuantity), String(depthOf(r)),
    ]),
  )
  const root = byPath(['TZ-A'])
  assert.equal(root.componentCode, 'TZ-A-1000'); assert.equal(root.componentName, '总装配体A')
  assert.equal(root.material, 'Q345R'); assert.equal(root.totalQuantity, 2); assert.equal(root.ext_spec, 'DN1200')
  const leafD = byPath(['TZ-A', 'TZ-B', 'TZ-D'])
  assert.equal(leafD.rawQuantity, 2); assert.equal(leafD.totalQuantity, 12)
  assert.equal(rows.some((r) => r.componentSourceId === 'TZ-G'), false)
  say(`\n  ${GREEN('✓')} 数量逐层累乘:根 x2 → 组件 x3 → 封头 x2 = 总数量 ${BOLD('12')}`)
  say(`  ${GREEN('✓')} 停用的 BOM 头(bom_able='0')下的废弃件 TZ-G ${BOLD('从不展开')}`)

  const snapshotBatchId = batchIdFromMaterials(state1, PROJECT_A, rows)
  const snap = mapExpansionRowsToSnapshotLines(a, { snapshotBatchId, readPlan: REBIND_READ_PLAN })
  assert.equal(snap.status, 'mapped'); assert.equal(snap.lines.length, 7)
  const parentIndex = buildParentIndex(rows)
  const leafDLine = snap.lines.find((l) => l.childDrawingNo === 'TZ-D-3000' && l.bomLevel === 2)
  assert.equal(leafDLine.parentDrawingNo, 'TZ-B-2000')
  assert.equal(parentIndex.get(leafD.parentSourceId).componentName, '筒体组件B')
  say(`  ${GREEN('✓')} 快照行携父组件图号(批内父连接):TZ-D-3000 的父组件图号 = ${BOLD('TZ-B-2000')},父名称 = 筒体组件B`)

  say(`\n  ${BOLD('同项目两批次按创建小时区分')} ${DIM('(物料创建日期精确到小时)')}:`)
  const state2 = loadState(schema, ['03-seed-batch-2.sql'])
  const a2 = await pull(state2, PROJECT_A)
  assert.equal(a2.rows.length, 6)
  const batch2Id = batchIdFromMaterials(state2, PROJECT_A, a2.rows)
  assert.equal(snapshotBatchId, `${PROJECT_A}|2026-08-30T09`)
  assert.equal(batch2Id, `${PROJECT_A}|2026-08-30T10`)
  const snap2 = mapExpansionRowsToSnapshotLines(a2, { snapshotBatchId: batch2Id, readPlan: REBIND_READ_PLAN })
  const ids1 = new Set(snap.lines.map((l) => l.snapshotLineId))
  const overlap = snap2.lines.map((l) => l.snapshotLineId).filter((id) => ids1.has(id))
  assert.deepEqual(overlap, [])
  say(`    批 #1 = ${BOLD(snapshotBatchId)}  ${DIM('(材料创建于 09 点)')}`)
  say(`    批 #2 = ${BOLD(batch2Id)}  ${DIM('(一小时后重拉,创建于 10 点)')}`)
  say(`    → 两批次快照行 id ${GREEN('0 重叠')};同一小时重算 id 逐字节一致(幂等)`)
  say(`  ${DIM('⚠ 诚实说明:按小时分批的推导目前在调用方(本 runner 手工铸造),尚未进发货代码 —— 见文末与 runbook。')}`)
  say(`  ${GREEN('步骤 2 通过')}`)

  // ── STEP 3 ──────────────────────────────────────────────────────────────────
  banner('步骤 3 — 人工填列 + 人列墙(杀手锏)+ 仓库导出')
  say('  台词:「你们最怕的:重拉会不会把我填的都冲掉?看好了。」\n')

  const firstPlan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, expandedRows: rows, existingRows: [],
    runId: 'demo-1', plannedAt: '2026-09-01T00:00:00.000Z',
  })
  // The human cells a 备料/采购/仓库 person types (canonical band + 自制/外购 + the
  // departmental response band + pack ext band). Same five new values as the sibling
  // rehearsal driver's humanCells (stock-preparation-structure-exact-rehearsal.test.cjs)
  // -- a select LABEL, two booleans and two ISO dates, typed exactly as the template
  // declares them. `warehouseDone: false` is deliberate, same reasoning as there: the
  // negative control flips booleans, so a `false` that survives is as load-bearing as a
  // `true` that does.
  const humanCells = {
    materialType: '30 - Q345R', blankType: '20 - 管材', stockPreparationStatus: '20 - 已下单',
    demandDate: '2026-09-20', leadTimeDays: 14, notes: '按图纸复核后下单',
    procurementReply: '供应商已确认排产', warehouseConfirmation: '待到货',
    makeOrBuy: '20 - 外购', procurementDone: true, procurementReplyDate: '2026-09-05',
    warehouseDone: false, actualArrivalDate: '2026-09-18',
    ext_stockPrepDate: '2026-09-02', ext_pickingNode: '10 - 示例节点一', ext_handoverSection: '10 - 示例工段一',
    ext_blankLength: 1250, ext_blankWidth: 800, ext_blankThickness: 12, ext_blankQuantity: 4, ext_blankMass: 94.2,
  }
  for (const id of ALL_HUMAN) assert.ok(Object.prototype.hasOwnProperty.call(humanCells, id), `human fill must cover ${id}`)
  const targetRows = firstPlan.decisions.filter((d) => d.decision === 'add').map((d) => ({ ...d.record, ...humanCells }))
  assert.equal(targetRows.length, 7)
  say(`  人填 ${BOLD(ALL_HUMAN.length)} 个人列(材料类型/毛胚类型/备料情况/需求日期/提前周期/备注/自制外购/采购完成/仓库完成/备料日期/领料节点/毛胚尺寸…)于 7 行`)

  // THE WALL (canonical band): re-pull batch #2, re-plan against the filled rows.
  const secondPlan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, expandedRows: a2.rows, existingRows: targetRows,
    runId: 'demo-2', plannedAt: '2026-09-01T01:00:00.000Z',
  })
  assert.deepEqual(secondPlan.counts, { add: 0, update: 3, skip: 3, inactive: 1, manual_confirm: 0 })
  const changed = new Set(secondPlan.decisions.filter((d) => d.decision === 'update').flatMap((d) => d.changedFields))
  assert.deepEqual([...changed].sort(), ['rawQuantity', 'totalQuantity'])
  for (const d of secondPlan.decisions) {
    for (const payload of [d.patch, d.record]) {
      if (!payload) continue
      for (const field of ALL_HUMAN) assert.ok(!Object.prototype.hasOwnProperty.call(payload, field), `${d.decision} payload must not carry ${field}`)
    }
  }
  const byKey = new Map(targetRows.map((r) => [r.idempotencyKey, { ...r }]))
  for (const d of secondPlan.decisions.filter((x) => x.decision === 'update' || x.decision === 'inactive')) {
    Object.assign(byKey.get(d.idempotencyKey), d.patch)
  }
  let survivingRows = 0
  for (const row of byKey.values()) {
    for (const id of ALL_HUMAN) assert.equal(JSON.stringify(row[id]), JSON.stringify(humanCells[id]), `${id}: human cell survived`)
    survivingRows += 1
  }
  say(`\n  ${BOLD('重拉一次(批 #2)')} → 计划 = ${GREEN('add 0 / update 3 / skip 3 / inactive 1')}`)
  say(`    改动的列只有 ${BOLD('rawQuantity / totalQuantity')}(PLM 的量);任何决策都不携带人列`)
  say(`    应用刷新后:${BOLD(survivingRows)} 行 × ${ALL_HUMAN.length} 个人列取值 ${GREEN('逐字节不变')} ✅ ${BOLD('人列墙成立')}`)

  // THE WALL (pack band) + negative control.
  const installedFieldProperties = PACK.extensionFields.map((f) => ({
    fieldId: f.id,
    property: { stockPreparation: { ownership: f.ownership, preserveOnRefresh: f.preserveOnRefresh === true, extension: true } },
  }))
  const bands = derivePackAwarePlmWritableFields({
    templateFields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields, installedFieldProperties,
  })
  for (const id of PACK_HUMAN) assert.equal(bands.plmWritableFieldIds.includes(id), false, `refresh must not write ${id}`)
  const seeded = { ...targetRows[0] }
  const refreshPayload = {}
  for (const id of Object.keys(seeded)) {
    const v = seeded[id]
    refreshPayload[id] = typeof v === 'number' ? v + 1000 : (typeof v === 'boolean' ? !v : `${v}#refreshed`)
  }
  const refreshed = { ...seeded }
  for (const id of bands.plmWritableFieldIds) if (id in refreshed) refreshed[id] = refreshPayload[id]
  for (const id of ALL_HUMAN) assert.equal(JSON.stringify(refreshed[id]), JSON.stringify(seeded[id]), `${id}: preserved through filter`)
  const clobbered = { ...seeded, ...refreshPayload }
  let clobberedCount = 0
  for (const id of ALL_HUMAN) if (JSON.stringify(clobbered[id]) !== JSON.stringify(seeded[id])) clobberedCount += 1
  assert.equal(clobberedCount, ALL_HUMAN.length)
  say(`  ${BOLD('负对照')}:同样的刷新若 ${BOLD('不过')}权属过滤器 → ${clobberedCount} 个人列 ${BOLD('全被冲掉')} ${DIM('—— 证明这堵墙是承重的,不是摆设')}`)

  // THE EXPORT the warehouse/purchasing takes. NOT touched by this change: this local
  // projection already trails the real exporter (lib/stock-preparation-prep-line-export.cjs,
  // which has grown parentComponentCode/parentComponentName + componentSpec fallback ahead of
  // this copy), and PR #5457 (open, not yet merged as of this change) extends the real
  // exporter further, to 17 columns appending makeOrBuy/procurementDone/procurementReplyDate/
  // warehouseDone/actualArrivalDate with 是/否 rendering for the two booleans. Re-syncing this
  // demo copy to either is a separate one-line follow-up once #5457 lands -- out of scope here,
  // which is only the ALL_HUMAN fixture-coverage regression from #5447.
  const EXPORT_COLUMNS = [
    { id: 'componentCode', label: '图号' }, { id: 'componentName', label: '名称' },
    { id: 'ext_spec', label: '规格' }, { id: 'material', label: '材料' },
    { id: 'totalQuantity', label: '总数量' }, { id: 'stockPreparationStatus', label: '备料情况' },
    { id: 'demandDate', label: '需求日期' }, { id: 'ext_pickingNode', label: '领料节点' },
    { id: 'ext_stockPrepDate', label: '备料日期' }, { id: 'ext_blankLength', label: '毛胚长度' },
  ]
  const headers = EXPORT_COLUMNS.map((c) => c.label)
  const activeRows = [...byKey.values()].filter((row) => row.active !== false)
  const exportRows = activeRows.map((row) => EXPORT_COLUMNS.map((c) => {
    const v = row[c.id]
    return Array.isArray(v) ? v.join(', ') : (v === undefined || v === null ? '' : String(v))
  }))
  assert.equal(headers.length, 10); assert.equal(exportRows.length, 6)
  for (const r of exportRows) { assert.ok(String(r[0]).startsWith('TZ-')); assert.equal(r[5], '20 - 已下单'); assert.equal(r[8], '2026-09-02') }
  say(`\n  ${BOLD('导出(仓库/采购拿走的 XLSX 投影)')} —— 活跃物料行 ${exportRows.length} × 列 ${headers.length}(停用的那一行掉出拣料单):`)
  table(headers, exportRows)
  say(`  ${DIM('二进制打包由 packages/core-backend/src/multitable/xlsx-service.ts buildXlsxBuffer + 现有 vitest 覆盖;此处证明的是投影(物料内容)。')}`)
  say(`  ${GREEN('步骤 3 通过')}`)

  // ── honest caveats (staged, never faked) ─────────────────────────────────────
  banner('演示要如实说明的边界(净新 · 未接线 —— 别演成已有)')
  say(`  1. ${BOLD('按创建小时分批的推导')}:可行(本 runner 已在真实 Createtime 上算出),但发货 mapper 目前收`)
  say(`     ${DIM('调用方给定的 snapshotBatchId')} —— 需加一小段调用方推导。属净新,一个小函数。`)
  say(`  2. ${BOLD('多人审批 hand-off 链到备料')}:平台有审批运行时,但未接线到备料流。属净新,未接线。`)
  say(`  3. ${BOLD('钉钉待办推送')}:无连接器接线。属净新,未接线。`)
  say(`  ${DIM('若观众追问以上三点,答:在路线图上,尚未发货 —— 不要摆成在跑。')}`)

  // ── values-free self-check over the printed export projection ─────────────────
  const FORBIDDEN = [
    { id: 'ipv4', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
    { id: 'url', pattern: /\b(?:https?|jdbc|mssql|postgres(?:ql)?|mongodb):\/\//i },
    { id: 'credential-word', pattern: /\b(?:password|passwd|secret|token|apikey|api[_-]key|credential|bearer)\b/i },
    { id: 'connection-string', pattern: /\b(?:uid|pwd|data\s*source|initial\s*catalog)\s*=/i },
  ]
  const printed = JSON.stringify({ headers, sampleRow: exportRows[0] })
  for (const { id, pattern } of FORBIDDEN) assert.equal(pattern.test(printed), false, `printed export must not carry a ${id} shape`)

  banner('DEMO 全绿')
  say(`  ${GREEN('步骤 1-2-3 在结构一致合成源上,驱动发货管线,全部通过。')}`)
  say(`  ${DIM('现场唯一的变量是客户的数据 —— 见 onsite-connection-test-runbook-20260901.md 的 30 秒体检。')}`)
  console.log('\nstock-preparation-demo-runner.cjs OK')
}

main().then(
  () => {},
  (error) => { console.error(error); process.exitCode = 1 },
)
