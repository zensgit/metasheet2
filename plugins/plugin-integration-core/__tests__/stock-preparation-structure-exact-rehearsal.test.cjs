'use strict'

/**
 * STRUCTURE-EXACT CAPABILITY REHEARSAL — proves the 备料 pipeline (steps 1-3 of
 * the customer's business process) works END-TO-END on our stack against a
 * synthetic PLM source shaped EXACTLY like the customer's real DN_PDM / DN_*_View
 * schema, so that on-site the only remaining variable is the customer's DATA.
 *
 * Fixture:  ../fixtures/stock-preparation-structure-exact-plm/ (01-schema,
 *           02-seed-batch-1, 03-seed-batch-2). 100% fabricated, values-free.
 *
 * NO DATABASE. The seeds are interpreted in memory by a source adapter that
 * models the two Postgres behaviours that matter on this path:
 *   - identifier folding: the host adapter interpolates identifiers UNQUOTED, so
 *     every table/column name folds to lower case on both sides;
 *   - node-postgres returns `numeric` columns as STRINGS.
 * The pipeline itself is the SHIPPED code — expandPlmProjectBom, the ext-field
 * mapper, the expansion->snapshot mapper, the conflict planner and its pack-aware
 * ownership derivation — driven by a per-action read-plan OVERRIDE that names the
 * customer's own columns (project_code / DrawingType / TargetName / Material /
 * Specification / Bom_ExAttr1). Nothing here is a mock that merely agrees with
 * production; the only synthetic thing is the SOURCE, which is the whole point.
 *
 * What it proves, and what it CANNOT (stated, never faked): see the tail summary
 * and docs/development/takeover-beiliao-20260821/structure-exact-rehearsal-report-20260901.md.
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
  BATCH_IDENTITY_MODES,
  mintStockPreparationBatchIdentity,
  readStockPreparationBatchIdentityMode,
} = require(path.join(LIB, 'stock-preparation-batch-identity.cjs'))
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

// The per-action read-plan OVERRIDE: the customer's own vocabulary. On site this
// is action.source.readPlan in INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON;
// here it is the one config that adapts the shipped 7-object traversal to the
// customer's column names. The object/field names below are exactly the fixture's.
const REBIND_READ_PLAN = normalizeStockPreparationBomReadPlan({
  id: 'plm.stock-preparation.bom-read.dn-view.structure-exact',
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
    // 规格 and the material creation hour are DECLARED here, which is the whole point: the shipped
    // read plan defaults both to ABSENT (no guessed column) and a deployment that has them says so.
    // This is what turns `Specification` into a canonical `spec` on the snapshot line and what
    // carries `Createtime` far enough for the batch rule to bucket it.
    specField: 'Specification',
    createTimeField: 'Createtime',
  },
  // 备料 batch rule, DECLARED: 物料创建日期(精确到小时)区分同一项目不同批次的物料.
  batchIdentity: { mode: 'material_create_hour' },
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

// The ext-field mapping: the customer's denormalized part attributes that are NOT
// canonical row columns. Specification 规格 -> ext_spec, Creator -> ext_designer.
// Normalized against the factory-a rehearsal pack (its own targets, own ownership).
const EXT_FIELD_MAPPING = normalizeExtFieldMapping(
  {
    mappingId: 'structure-exact-rehearsal',
    mappingVersion: 1,
    mappings: [
      { sourceColumn: 'Specification', target: 'ext_spec' },
      { sourceColumn: 'Creator', target: 'ext_designer' },
    ],
  },
  { pack: FACTORY_A_REHEARSAL_PACK },
)

// ── a deliberately small SQL reader (CREATE TABLE / INSERT / DELETE only) ──────
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

async function expand(state, projectNo) {
  return expandPlmProjectBom({
    sourceAdapter: createAdapter(state),
    projectNo,
    readPlan: REBIND_READ_PLAN,
    extFieldMapping: EXT_FIELD_MAPPING,
    pageLimit: 2, // small on purpose: forces the pagination/cursor loop to run
  })
}

function rowByPath(rows, tokens) {
  const wanted = JSON.stringify(tokens)
  const m = rows.filter((r) => r.path === wanted)
  assert.equal(m.length, 1, `expected exactly one row at path ${wanted}, saw ${m.length}`)
  return m[0]
}

// The customer's batch rule (物料创建日期精确到小时): bucket a pull by its materials' creation hour.
//
// THIS IS NOW SHIPPED CODE. The rehearsal used to carry its own `hourBucket` /
// `batchIdFromMaterials` and reach around the expansion into the fixture's part table, because the
// expansion did not carry `Createtime` and the mapper only ever accepted an opaque caller-supplied
// snapshotBatchId. Both halves are closed: the read plan DECLARES createTimeField, so the hour rides
// on the expansion row itself, and the derivation lives in stock-preparation-batch-identity.cjs.
// The rehearsal calls that module — one implementation, no drift-prone second copy.
function batchIdFromMaterials(projectNo, rows) {
  const minted = mintStockPreparationBatchIdentity({
    mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
    projectNo,
    rows,
    legacyBatchId: `legacy_${projectNo}`,
  })
  assert.equal(minted.degraded, false, 'the fixture declares Createtime — the hour rule must not degrade')
  assert.equal(minted.mode, BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR)
  return minted.batchId
}

const CANONICAL_HUMAN = [...HUMAN_PRESERVED_FIELD_IDS]
const PACK = normalizeCustomerPack(FACTORY_A_REHEARSAL_PACK)
const PACK_HUMAN = PACK.extensionFields.filter((f) => f.ownership === 'human_preserved').map((f) => f.id)
const ALL_HUMAN = [...CANONICAL_HUMAN, ...PACK_HUMAN]

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1 — project search + branch (no-data -> pull; has-data -> fill)
// ═══════════════════════════════════════════════════════════════════════════
async function step1(schema) {
  const state = loadState(schema, ['02-seed-batch-1.sql'])

  // (1a) two DISTINCT projects each resolve independently — multi-project search.
  const a = await expand(state, PROJECT_A)
  assert.equal(a.status, 'expanded', 'SYN-XM-0001 must resolve')
  assert.equal(a.valid, true)
  assert.equal(a.summary.rootMatches, 1, 'exactly one project path matched')
  assert.equal(a.rows.length, 7, 'SYN-XM-0001 expands to 7 rows')
  assert.deepEqual(a.errors, [])
  assert.deepEqual(a.rowErrors, [])

  const b = await expand(state, PROJECT_B)
  assert.equal(b.status, 'expanded', 'SYN-XM-0002 must resolve independently')
  assert.equal(b.rows.length, 2, 'SYN-XM-0002 expands to 2 rows')
  assert.notEqual(
    a.rows[0].componentSourceId, b.rows[0].componentSourceId,
    'the two projects expand to different parts — searches are independent',
  )

  // (1b) a project that is not in PLM -> not_found (the phantom-project guard).
  const phantom = await expand(state, PROJECT_PHANTOM)
  assert.equal(phantom.status, 'not_found', 'an unknown project_code must return not_found, never a partial pull')
  assert.equal(phantom.valid, true)
  assert.equal(phantom.rows.length, 0)

  // (1c) THE BRANCH. Search decides pull-vs-fill by what the TARGET already holds.
  //   no target rows  -> PULL  (every expanded row is an `add`)
  //   target rows      -> FILL  (update / skip / inactive; proven in step 3)
  const pull = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows: a.rows,
    existingRows: [],
    runId: 'sx-run-pull',
    plannedAt: '2026-09-01T00:00:00.000Z',
  })
  assert.equal(pull.valid, true)
  assert.deepEqual(pull.counts, { add: 7, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
    'no-data branch: a first pull is all-add')

  console.log('  STEP 1 GREEN — search SYN-XM-0001 -> 7 rows / SYN-XM-0002 -> 2 rows (independent);'
    + ' phantom SYN-XM-9999 -> not_found; empty target -> PULL (add 7)')
  return { state, expansionA: a }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2 — pull -> snapshot-batch -> multitable rows with plm_system columns
//          mapped; two same-project batches distinguished by creation-hour
// ═══════════════════════════════════════════════════════════════════════════
async function step2(schema, expansionA, state) {
  const rows = expansionA.rows

  // (2a) THE COLUMN MAPPING the customer's landing sheet carries.
  // 当前组件图号/名称 <- componentCode / componentName (canonical, from DrawingType/TargetName)
  // 材料             <- material (canonical, from Material)
  // 总数量           <- totalQuantity (canonical roll-up)
  // 规格             <- ext_spec (ext mapping, from Specification)
  const root = rowByPath(rows, ['TZ-A'])
  assert.equal(root.componentCode, 'TZ-A-1000', '当前组件图号 <- DrawingType')
  assert.equal(root.componentName, '总装配体A', '当前组件名称 <- TargetName')
  assert.equal(root.material, 'Q345R', '材料 <- Material')
  assert.equal(root.totalQuantity, 2, '总数量 <- roll-up')
  assert.equal(root.ext_spec, 'DN1200', '规格 <- Specification (ext mapping)')
  assert.equal(root.ext_designer, 'SYN-USER-1', '设计者 <- Creator (ext mapping)')

  // Quantity roll-up across levels: 2 (root) x 3 (sub) x 2 (leaf) = 12.
  const subB = rowByPath(rows, ['TZ-A', 'TZ-B'])
  assert.equal(subB.rawQuantity, 3)
  assert.equal(subB.totalQuantity, 6)
  const leafD = rowByPath(rows, ['TZ-A', 'TZ-B', 'TZ-D'])
  assert.equal(leafD.rawQuantity, 2)
  assert.equal(leafD.totalQuantity, 12)
  assert.equal(leafD.ext_spec, 'EHA-DN1200x12')
  // TZ-G under the retired head must never appear.
  assert.equal(rows.some((r) => r.componentSourceId === 'TZ-G'), false, 'retired-head component must not expand')

  // (2b) snapshot lines carry 父组件图号 (parentDrawingNo) and 当前组件图号
  // (childDrawingNo), resolved by the shipped mapper's in-batch parent join.
  const snapshotBatchId = batchIdFromMaterials(PROJECT_A, rows)
  const snap = mapExpansionRowsToSnapshotLines(expansionA, { snapshotBatchId, readPlan: REBIND_READ_PLAN })
  assert.equal(snap.status, 'mapped')
  assert.equal(snap.lines.length, 7)
  const parentIndex = buildParentIndex(rows) // the same join the mapper uses
  const leafDLine = snap.lines.find((l) => l.childDrawingNo === 'TZ-D-3000' && l.bomLevel === 2)
  assert.equal(leafDLine.parentDrawingNo, 'TZ-B-2000', '父组件图号 <- parent componentCode via in-batch join')
  const leafDParent = parentIndex.get(leafD.parentSourceId)
  assert.equal(leafDParent.componentName, '筒体组件B', 'fixture control: the parent row carries the name')
  const withParent = snap.evidence.result.withParentDrawingNo
  assert.equal(withParent, 6, '6 of 7 lines have a parent drawing no (the root has none)')

  // ALL SEVEN FIELDS ON THE PERSISTED LINE. The audit's finding was that only drawing numbers,
  // versions and per-level qty survived onto the snapshot line: 材料 lived only inside the
  // fingerprint hash, 当前组件名称 was read then dropped, 总数量 was traded for the per-level qty,
  // 父组件名称 was never emitted at all, and 规格 was never read from the source. Assert each one
  // on the LINE the persist layer writes, not on the expansion row it came from.
  assert.equal(leafDLine.parentName, '筒体组件B', '父组件名称 on the snapshot line')
  assert.equal(leafDLine.childName, '标准封头D', '当前组件名称 on the snapshot line')
  assert.equal(leafDLine.material, 'S30408', '材料 on the snapshot line')
  assert.equal(leafDLine.spec, 'EHA-DN1200x12', '规格 on the snapshot line (readPlan.part.specField)')
  assert.equal(leafDLine.designQty, 2, '逐层数量 unchanged')
  assert.equal(leafDLine.totalQuantity, 12, '总数量 on the snapshot line, alongside the per-level qty')
  const rootLine = snap.lines.find((l) => l.childDrawingNo === 'TZ-A-1000')
  assert.equal(rootLine.childName, '总装配体A', '当前组件名称 on the root line')
  assert.equal(rootLine.parentName, undefined, 'the root has no parent — absence, not an empty string')

  // (2c) TWO same-project batches distinguished by CREATION-HOUR.
  // The mode is DECLARED on the read plan and survives normalization — a deployment configures the
  // rule, it is not a hardcoded behaviour of the pull.
  assert.equal(
    readStockPreparationBatchIdentityMode(REBIND_READ_PLAN),
    BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
    'the batch rule is read off the deployment read plan',
  )
  // batch #1 (hour 09) and batch #2 (hour 10) of SYN-XM-0001 mint DISTINCT batch
  // ids -> DISTINCT snapshot line ids. Same hour re-derives the SAME id (idempotent).
  assert.equal(snapshotBatchId, `${PROJECT_A}|2026-08-30T09`, 'batch #1 buckets to hour 09')

  const state2 = loadState(schema, ['03-seed-batch-2.sql'])
  const expansionA2 = await expand(state2, PROJECT_A)
  assert.equal(expansionA2.rows.length, 6, 'batch #2 re-pull drops the removed leaf')
  const batch2Id = batchIdFromMaterials(PROJECT_A, expansionA2.rows)
  assert.equal(batch2Id, `${PROJECT_A}|2026-08-30T10`, 'batch #2 buckets to hour 10')
  assert.notEqual(snapshotBatchId, batch2Id, 'two same-project batches are DISTINCT by creation-hour')

  const snap2 = mapExpansionRowsToSnapshotLines(expansionA2, { snapshotBatchId: batch2Id, readPlan: REBIND_READ_PLAN })
  const ids1 = new Set(snap.lines.map((l) => l.snapshotLineId))
  const ids2 = new Set(snap2.lines.map((l) => l.snapshotLineId))
  const overlap = [...ids2].filter((id) => ids1.has(id))
  assert.deepEqual(overlap, [], 'no snapshot line id is shared across the two hour-distinct batches')

  // idempotence control: same materials, same hour -> byte-identical batch id.
  assert.equal(batchIdFromMaterials(PROJECT_A, rows), snapshotBatchId, 'same-hour re-derivation is idempotent')

  console.log(`  STEP 2 GREEN — 图号/名称/规格/材料/总数量 mapped onto rows; 父组件图号 via in-batch join;`
    + ` batch #1=${snapshotBatchId} vs batch #2=${batch2Id} (distinct by hour, 0 shared line ids)`)
  return { expansionA2, snapshotBatchId }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3 — human fill + the HUMAN-COLUMN WALL + the export the warehouse takes
// ═══════════════════════════════════════════════════════════════════════════
async function step3(expansionA, expansionA2) {
  // (3a) first pull lands as `add`; a human then fills BOTH bands on those rows.
  const firstPlan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows: expansionA.rows,
    existingRows: [],
    runId: 'sx-run-1',
    plannedAt: '2026-09-01T00:00:00.000Z',
  })
  assert.deepEqual(firstPlan.counts, { add: 7, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })

  // The human cells a 备料/采购/仓库 person types. Canonical human band +
  // the pack's human ext band (备料日期 / 领料节点 / 毛胚尺寸 ...).
  const humanCells = {
    materialType: '30 - Q345R',              // 材料类型
    blankType: '20 - 管材',                   // 毛胚类型
    stockPreparationStatus: '20 - 已下单',    // 备料情况
    demandDate: '2026-09-20',                 // 需求日期
    leadTimeDays: 14,                          // 提前周期
    notes: '按图纸复核后下单',                  // 备注
    procurementReply: '供应商已确认排产',
    warehouseConfirmation: '待到货',
    ext_stockPrepDate: '2026-09-02',          // 备料日期 (pack)
    ext_pickingNode: '10 - 示例节点一',        // 领料节点 (pack)
    ext_handoverSection: '10 - 示例工段一',    // 交接工段 (pack)
    ext_blankLength: 1250,                     // 毛胚尺寸 (pack)
    ext_blankWidth: 800,
    ext_blankThickness: 12,
    ext_blankQuantity: 4,
    ext_blankMass: 94.2,
  }
  for (const id of ALL_HUMAN) {
    assert.ok(Object.prototype.hasOwnProperty.call(humanCells, id), `human fill must cover ${id}`)
  }
  const targetRows = firstPlan.decisions
    .filter((d) => d.decision === 'add')
    .map((d) => ({ ...d.record, ...humanCells }))
  assert.equal(targetRows.length, 7)

  // (3b) THE HUMAN-COLUMN WALL, canonical band: re-pull (batch #2) and re-plan
  // against those human-filled rows. Human cells must survive; only PLM
  // quantities may change; NO decision payload may name any human field.
  const secondPlan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows: expansionA2.rows,
    existingRows: targetRows,
    runId: 'sx-run-2',
    plannedAt: '2026-09-01T01:00:00.000Z',
  })
  assert.equal(secondPlan.valid, true)
  assert.deepEqual(
    secondPlan.counts, { add: 0, update: 3, skip: 3, inactive: 1, manual_confirm: 0 },
    'the fill/refresh exercises update + skip + mark_inactive together',
  )
  const changed = new Set(secondPlan.decisions.filter((d) => d.decision === 'update').flatMap((d) => d.changedFields))
  assert.deepEqual([...changed].sort(), ['rawQuantity', 'totalQuantity'], 'only PLM quantities may change on a refresh')
  for (const d of secondPlan.decisions) {
    for (const payload of [d.patch, d.record]) {
      if (!payload) continue
      for (const field of ALL_HUMAN) {
        assert.ok(!Object.prototype.hasOwnProperty.call(payload, field),
          `a ${d.decision} payload must never carry the human field ${field}`)
      }
    }
  }
  // Apply the plan's update AND inactive patches (the refresh a warehouse then
  // reads), and prove the human cells are byte-identical on every surviving row.
  const byKey = new Map(targetRows.map((r) => [r.idempotencyKey, { ...r }]))
  for (const d of secondPlan.decisions.filter((x) => x.decision === 'update' || x.decision === 'inactive')) {
    Object.assign(byKey.get(d.idempotencyKey), d.patch)
  }
  for (const row of byKey.values()) {
    for (const id of ALL_HUMAN) {
      assert.equal(JSON.stringify(row[id]), JSON.stringify(humanCells[id]), `${id}: human cell survived the refresh`)
    }
  }

  // (3c) THE HUMAN-COLUMN WALL, pack band: the production ownership derivation
  // must EXCLUDE every pack human ext column from a refresh's writable set, and a
  // full-sheet refresh applied through that filter must leave them byte-identical.
  const installedFieldProperties = PACK.extensionFields.map((f) => ({
    fieldId: f.id,
    property: { stockPreparation: { ownership: f.ownership, preserveOnRefresh: f.preserveOnRefresh === true, extension: true } },
  }))
  const bands = derivePackAwarePlmWritableFields({
    templateFields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields,
    installedFieldProperties,
  })
  assert.deepEqual(bands.unclassifiedPackFieldIds, [], 'a fully installed pack leaves nothing unclassified')
  for (const id of PACK_HUMAN) {
    assert.ok(bands.humanPreservedFieldIds.includes(id), `${id} must be in the human band`)
    assert.equal(bands.plmWritableFieldIds.includes(id), false, `a refresh must not be allowed to write ${id}`)
  }
  // money shot: apply a full-sheet refresh THROUGH the writable filter.
  const seeded = { ...targetRows[0] }
  const refreshPayload = {}
  for (const id of Object.keys(seeded)) {
    const v = seeded[id]
    refreshPayload[id] = typeof v === 'number' ? v + 1000 : (typeof v === 'boolean' ? !v : `${v}#refreshed`)
  }
  const refreshed = { ...seeded }
  for (const id of bands.plmWritableFieldIds) if (id in refreshed) refreshed[id] = refreshPayload[id]
  for (const id of ALL_HUMAN) {
    assert.equal(JSON.stringify(refreshed[id]), JSON.stringify(seeded[id]), `${id}: pack/canonical human cell preserved`)
  }
  // negative control: WITHOUT the filter, the human cells are destroyed.
  const clobbered = { ...seeded, ...refreshPayload }
  for (const id of ALL_HUMAN) {
    assert.notEqual(JSON.stringify(clobbered[id]), JSON.stringify(seeded[id]), `${id}: unfiltered refresh DOES clobber — the wall is load-bearing`)
  }

  // (3d) THE EXPORT the warehouse/purchasing takes. The pure XLSX builder
  // (packages/core-backend/src/multitable/xlsx-service.ts buildXlsxBuffer) is fed
  // exactly this headers[] + rows[][] projection; here we assert the PROJECTION
  // (the material content), values-free. Binary packaging is covered by the
  // existing vitest suite tests/integration/multitable-xlsx-routes.test.ts.
  const EXPORT_COLUMNS = [
    { id: 'componentCode', label: '图号' },
    { id: 'componentName', label: '名称' },
    { id: 'ext_spec', label: '规格' },
    { id: 'material', label: '材料' },
    { id: 'totalQuantity', label: '总数量' },
    { id: 'stockPreparationStatus', label: '备料情况' },
    { id: 'demandDate', label: '需求日期' },
    { id: 'ext_pickingNode', label: '领料节点' },
    { id: 'ext_stockPrepDate', label: '备料日期' },
    { id: 'ext_blankLength', label: '毛胚长度' },
  ]
  const headers = EXPORT_COLUMNS.map((c) => c.label)
  // The warehouse export is the ACTIVE material rows after the refresh (the one
  // mark_inactive row drops out of the pick list).
  const activeRows = [...byKey.values()].filter((row) => row.active !== false)
  const exportRows = activeRows.map((row) => EXPORT_COLUMNS.map((c) => {
    const v = row[c.id]
    return Array.isArray(v) ? v.join(', ') : (v === undefined || v === null ? '' : v)
  }))
  assert.equal(headers.length, 10)
  assert.equal(exportRows.length, 6, 'the export carries the 6 active material rows (the inactive leaf drops out)')
  // every row carries its identity (图号) AND the human 备料情况 the person typed
  for (const r of exportRows) {
    assert.ok(String(r[0]).startsWith('TZ-'), 'export row keeps its drawing no')
    assert.equal(r[5], '20 - 已下单', 'export row carries the human 备料情况')
    assert.equal(r[8], '2026-09-02', 'export row carries the human 备料日期')
  }

  console.log('  STEP 3 GREEN — human fill on 16 columns; canonical+pack human WALL holds'
    + ' (refresh touches only rawQuantity/totalQuantity; negative control clobbers 16);'
    + ` export projects ${exportRows.length} material rows x ${headers.length} columns`)
  return { headers, exportRows }
}

// ── values-free self-check over everything this suite would print ─────────────
const FORBIDDEN_PATTERNS = [
  { id: 'ipv4', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { id: 'url', pattern: /\b(?:https?|jdbc|mssql|postgres(?:ql)?|mongodb):\/\//i },
  { id: 'credential-word', pattern: /\b(?:password|passwd|secret|token|apikey|api[_-]key|credential|bearer)\b/i },
  { id: 'connection-string', pattern: /\b(?:uid|pwd|data\s*source|initial\s*catalog)\s*=/i },
]

async function main() {
  const schema = parseSchema(readFixture('01-schema.sql'))
  assert.equal(schema.size, 7, 'the structure-exact fixture declares 7 objects')

  const { state, expansionA } = await step1(schema)
  const { expansionA2 } = await step2(schema, expansionA, state)
  const evidence = await step3(expansionA, expansionA2)

  const printed = JSON.stringify({ headers: evidence.headers, sampleRow: evidence.exportRows[0] })
  for (const { id, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(printed), false, `printed evidence must not carry a ${id} shape`)
  }

  console.log('stock-preparation-structure-exact-rehearsal.test.cjs OK')
}

main().then(
  () => {},
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
