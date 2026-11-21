'use strict'

// 人工补充行 B1 (ADR adr-stock-prep-manual-rows-20261030 §6, §8 「B1 插件」 4) — the export:
//
//   ME-01 PURE PLM IS BYTE-IDENTICAL: the result object of a sheet without a person's row equals, byte for byte (JSON),
//         the one main's own module (d5bc16c55, before B1) produced for the same records — with and without 沿用说明.
//   ME-02 THE PROBE'S THREE DEDUPE CASES (每种都会丢行 on main): a prefix row copying root R (R without a sort number)
//         swallowed R and its subtree; with a sort number on R the prefix row was swallowed; an orphan and a prefix row
//         with one display key lost one of them. Now every prefix row stays out of the tree and the dedupe and is
//         appended after it: nothing is lost, the PLM tree prints exactly as without the prefix row, an unbound prefix
//         row is treated the same way.
//   ME-03 来源 — the three values (人工补充 / 人工（非补充） / PLM), the 32nd column, after 层级 (the last projected
//         column since 2026-11-07; 仓库确认 before that); with 沿用说明 the 33rd column is 沿用说明 (it stays last); the
//         result's values-free counts.
//   ME-04 来源 appears only for PRINTED non-PLM rows: a person-created PLM-key row the dedupe collapsed adds no column.
//   ME-05 an explicit-map target: 来源 is never field-resolved and never in `unresolvedColumns`.
//   ME-06 an env target (not a project sheet): its `manual:` rows are 人工（非补充） — the column appears there too.
//   ME-07 through the mounted route: the workbook carries 来源 and the audit row's columnCount is 32 (31 without a
//         person's row) — no new audit key.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const prepLineExport = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { createInMemoryProjectWriteLock } = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const { makeFakeProvisioning } = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const F = require('./support/stock-preparation-manual-rows-export-fixtures.cjs')

const { EXPORT_COLUMNS, EXPORT_SOURCE_FIELD_IDS, exportStockPreparationPrepLines, __internals: exportInternals } = prepLineExport

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODE = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
const SOURCE_AT = EXPORT_COLUMNS.length // the 32nd column (index 31) since 层级 (2026-11-07)

function exportOf(records, extra = {}) {
  return exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(records), target: F.target(), projectNo: F.PROJECT_NO, permission: 'admin', ...extra })
}
const codes = (result) => result.rows.map((row) => row[CODE])
const sourceCells = (result) => result.rows.map((row) => row[SOURCE_AT])

// Captured from main d5bc16c55's OWN stock-preparation-prep-line-export.cjs over F.plmTree() (and with
// F.continuationFor()), before any B1 change — the JSON of the whole result object. 2026-11-07: the export appends
// 层级 (the row's stored template `depth`) as the 31st column; these fixture rows carry no stored level, so every row
// gains exactly one trailing null cell before any 沿用说明 cell (TAIL_BLANKS 12 -> 13). Nothing else moved.
const HEADERS_31 = '["父组件图号","父组件名称","图号","名称","规格","材料","总数量","备料情况","需求日期","领料节点","备料日期","毛胚长度","自制/外购","采购完成","采购回复日期","仓库完成","实际到货日期","生产编号","名称及规格","材料类型","毛胚类型","备注","交接工段","提前周期(天)","毛胚宽度","毛胚厚度","毛胚数量","毛胚质量","采购回复","仓库确认","层级"'
const TAIL_BLANKS = 'null,null,null,null,null,null,null,null,null,null,null,null,null'
const GOLDEN_PURE_PLM = `{"projectNo":"SYN-MR-EXP","totalRowCount":6,"activeRowCount":5,"headers":${HEADERS_31}],"rows":[["SYN-X","Gone parent","SYN-O","Orphan",null,"SYN-MAT",4,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],[null,null,"SYN-R","Root",null,"SYN-MAT",1,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],["SYN-R","Root","SYN-C1","Child one",null,"SYN-MAT",2,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],["SYN-R","Root","SYN-C2","Child two",null,"SYN-MAT",3,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}]],"collapsedRowCount":1,"treeOrdered":true,"treeIdentity":"path","treeDegraded":false,"unresolvedColumns":[]}`
const GOLDEN_PURE_PLM_CONTINUATION = `{"projectNo":"SYN-MR-EXP","totalRowCount":6,"activeRowCount":5,"headers":${HEADERS_31},"沿用说明"],"rows":[["SYN-X","Gone parent","SYN-O","Orphan",null,"SYN-MAT",4,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},"由 SYN-R 沿用（父边用量 2，关系 ort_0001）"],[null,null,"SYN-R","Root",null,"SYN-MAT",1,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""],["SYN-R","Root","SYN-C1","Child one",null,"SYN-MAT",2,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""],["SYN-R","Root","SYN-C2","Child two",null,"SYN-MAT",3,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""]],"continuationColumn":true,"continuedRowCount":1,"collapsedRowCount":1,"treeOrdered":true,"treeIdentity":"path","treeDegraded":false,"unresolvedColumns":[]}`

test('ME-01 a pure-PLM sheet exports byte-identically to main (with and without 沿用说明)', async () => {
  assert.equal(JSON.stringify(await exportOf(F.plmTree())), GOLDEN_PURE_PLM)
  assert.equal(JSON.stringify(await exportOf(F.plmTree(), { continuation: F.continuationFor() })), GOLDEN_PURE_PLM_CONTINUATION)
  // An env target and an explicit-map target answer the same pure-PLM bytes for the cells (objectId is not an input to
  // a PLM row's projection).
  const env = await exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(F.plmTree()), target: F.target(F.ENV_OBJECT_ID), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(JSON.stringify(env), GOLDEN_PURE_PLM)
})

test('ME-02 the probe\'s three dedupe cases: nothing is swallowed any more, prefix rows are appended after the tree', async () => {
  const tree = codes(await exportOf(F.plmTree()))
  assert.deepEqual(tree, ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2'])
  // Case 1 — a prefix row copies root R (R has no sort number). Main printed ['SYN-O', 'SYN-R'(the copy)] and lost R,
  // C1 and C2 (collapsedRowCount 4). The same for an unbound prefix row (no creator).
  for (const copy of [F.rootCopy('rec_1_manual'), F.rootCopy('rec_3_unbound', { createdBy: null })]) {
    const result = await exportOf([...F.plmTree(), copy])
    assert.deepEqual(codes(result), [...tree, 'SYN-R'], `case 1 (${copy.id}): the PLM tree whole, the copy appended`)
    assert.equal(result.collapsedRowCount, 1, 'only the pure-PLM twin collapses, as before')
    assert.equal(result.rows.length, 5)
    assert.equal(result.rows[4][EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')], 7, 'the appended row is the copy')
  }
  // Case 2 — R carries a sort number. Main printed the tree and lost the prefix row (collapsedRowCount 2).
  const sorted = await exportOf([...F.plmTree({ rootSortNo: 1 }), F.rootCopy('rec_1_manual')])
  assert.deepEqual(codes(sorted), ['SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-O', 'SYN-R'])
  assert.equal(sorted.collapsedRowCount, 1)
  // Case 3 — an orphan and a prefix row share one display key. Main printed one 'SYN-O' (the prefix row) and lost the
  // PLM orphan (collapsedRowCount 2).
  const orphan = await exportOf([...F.plmTree(), F.orphanCopy('rec_2_manual')])
  assert.deepEqual(codes(orphan), [...tree, 'SYN-O'])
  assert.equal(orphan.collapsedRowCount, 1)
  assert.equal(orphan.rows[0][EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')], 4, 'the PLM orphan prints in its tree slot')
  // Several prefix rows: appended in the flat comparator's order (父组件图号 blank last, then 图号 ...).
  const many = await exportOf([...F.plmTree(), F.rootCopy('rec_1_manual'), F.orphanCopy('rec_2_manual'), F.person('rec_4_free', { componentCode: 'SYN-A-FREE', componentName: 'Free' })])
  assert.deepEqual(codes(many), [...tree, 'SYN-O', 'SYN-A-FREE', 'SYN-R'])
  // A prefix row WITH a PLM path (a hand-edited key) adopts no child: its former children become orphans and still print.
  const edited = F.plmTree()
  edited[0].data.idempotencyKey = 'manual:v1:rec_5_root'
  edited[0].createdBy = F.PERSON
  const adopted = await exportOf(edited)
  assert.deepEqual(codes(adopted).slice().sort(), ['SYN-C1', 'SYN-C2', 'SYN-O', 'SYN-R'])
  assert.equal(codes(adopted)[codes(adopted).length - 1], 'SYN-R', 'the prefix row is appended last')
})

test('ME-03 来源: three values in the 32nd column (after 层级); with 沿用说明 that is the 33rd and last; the values-free counts', async () => {
  const records = [
    ...F.plmTree(),
    F.person('rec_1_manual', { componentCode: 'SYN-M1', componentName: 'Manual one' }),
    F.person('rec_2_unbound', { componentCode: 'SYN-M2', componentName: 'Unbound' }, { createdBy: null }),
    F.person('rec_3_other_id', { componentCode: 'SYN-M3', componentName: 'Other id' }, { key: 'manual:v1:rec_someone_else' }),
  ]
  // A person-created row with a PLM key (a pre-#6598 right-click copy): not a prefix row, but 人工（非补充）.
  const copied = F.plm('rec_b_copy', ['P-R', 'P-C3'], { parentComponentCode: 'SYN-R', componentCode: 'SYN-C3', componentName: 'Copied' })
  copied.createdBy = F.PERSON
  records.push(copied)
  const result = await exportOf(records)
  assert.equal(result.headers.length, 32)
  assert.equal(result.headers[31], '来源')
  assert.equal(result.headers[30], '层级', '来源 follows the last projected column (层级, the 31st)')
  const byCode = Object.fromEntries(result.rows.map((row) => [row[CODE], row[SOURCE_AT]]))
  assert.deepEqual(byCode, {
    'SYN-O': 'PLM', 'SYN-R': 'PLM', 'SYN-C1': 'PLM', 'SYN-C2': 'PLM', 'SYN-C3': '人工（非补充）',
    'SYN-M1': '人工补充', 'SYN-M2': '人工（非补充）', 'SYN-M3': '人工（非补充）',
  })
  assert.equal(result.sourceColumn, true)
  assert.equal(result.manualSupplementRowCount, 1)
  assert.equal(result.manualOtherRowCount, 3)
  assert.ok(result.rows.every((row) => row.length === 32))
  // With a live 沿用关系: 来源 is the 32nd column and 沿用说明 the 33rd.
  const continued = await exportOf(records, { continuation: F.continuationFor() })
  assert.equal(continued.headers.length, 33)
  assert.deepEqual(continued.headers.slice(30), ['层级', '来源', '沿用说明'])
  const orphanRow = continued.rows.find((row) => row[CODE] === 'SYN-O')
  assert.equal(orphanRow[31], 'PLM')
  assert.equal(orphanRow[32], '由 SYN-R 沿用（父边用量 2，关系 ort_0001）')
  assert.equal(continued.continuedRowCount, 1)
  // The labels are the ADR's, byte for byte (the full-width parentheses included).
  assert.deepEqual(exportInternals.SOURCE_LABELS, { manual_supplement: '人工补充', manual_other: '人工（非补充）', plm: 'PLM' })
  assert.equal(Buffer.from('人工（非补充）', 'utf8').toString('hex'), 'e4babae5b7a5efbc88e99d9ee8a1a5e58585efbc89')
})

test('ME-04 来源 counts PRINTED rows only: a person-created PLM-key row the dedupe collapsed adds no column', async () => {
  // A display twin of C1 under R, created by a person, sorting AFTER C1 (its key is later) => collapsed, not printed.
  const twin = F.plm('rec_c_twin', ['P-R', 'P-C1Z'], { parentComponentCode: 'SYN-R', parentComponentName: 'Root', componentCode: 'SYN-C1', componentName: 'Child one', totalQuantity: 2 })
  twin.createdBy = F.PERSON
  const result = await exportOf([...F.plmTree(), twin])
  assert.equal(result.collapsedRowCount, 2, 'the person\'s twin collapsed like any twin')
  assert.equal(result.headers.length, 31, 'no printed non-PLM row => no 来源')
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sourceColumn'), false)
})

test('ME-05 an explicit-map target: 来源 is not field-resolved and never in unresolvedColumns', async () => {
  // Bind the scope + key + identity columns only: every other projected column is unbound (reported), 来源 is not.
  const fieldIdMap = {
    projectNo: 'fld_project', active: 'fld_active', idempotencyKey: 'fld_key', componentCode: 'fld_code', path: 'fld_path',
    componentSourceId: 'fld_part', parentSourceId: 'fld_parent',
  }
  const physical = (records) => records.map((record) => {
    const data = {}
    for (const [logical, value] of Object.entries(record.data)) data[fieldIdMap[logical] || `fld_unbound_${logical}`] = value
    return { ...record, data }
  })
  const recordsApi = {
    async queryRecords(input) {
      return F.recordsApiOver(physical([...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1' })])).queryRecords(input)
    },
  }
  const result = await exportStockPreparationPrepLines({ recordsApi, target: F.target(F.PROJECT_OBJECT_ID, fieldIdMap), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(result.headers[31], '来源')
  assert.equal(result.rows.find((row) => row[CODE] === 'SYN-M1')[31], '人工补充')
  assert.ok(result.unresolvedColumns.length > 0, 'the explicit map leaves columns unbound (the check is not vacuous)')
  for (const entry of result.unresolvedColumns) {
    assert.notEqual(entry, exportInternals.SOURCE_COLUMN.id)
    assert.notEqual(entry, '来源')
  }
  assert.equal(EXPORT_SOURCE_FIELD_IDS.includes(exportInternals.SOURCE_COLUMN.id), false)
  assert.equal(EXPORT_COLUMNS.some((column) => column.id === exportInternals.SOURCE_COLUMN.id || column.label === '来源'), false)
})

test('ME-06 an env target: its manual: rows are 人工（非补充） (M′ needs a project sheet), and the column appears there too', async () => {
  const records = [...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1' })]
  const result = await exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(records), target: F.target(F.ENV_OBJECT_ID), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(result.headers[31], '来源')
  assert.equal(result.rows.find((row) => row[CODE] === 'SYN-M1')[31], '人工（非补充）')
  assert.equal(result.manualSupplementRowCount, 0)
  assert.equal(result.manualOtherRowCount, 1)
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-M1'], 'still appended after the tree')
})

// ── P3 (ADR §12.5 「正式导出」, OQ-P2 owner 2026-11-19): 人工补充行 spliced under their 父组件 ───────────────────────────
//
//   ME-08 under a printed PLM parent: at the END of the anchor's subtree (a root, a leaf mid-tree, an orphan root, a
//         parent with a grandchild); 来源 / counts / 层级 / 沿用说明 unchanged.
//   ME-09 several rows under one anchor: after every tree row of the subtree, by compareSiblingRows; nested anchors
//         whose subtrees end on the same row: the deeper anchor's rows first.
//   ME-10 an anchor 图号 printed twice: the FIRST printed row wins.
//   ME-11 no anchor (a new parent), an inactive anchor, a collapsed anchor: the tail, today's order.
//   ME-12 manual → manual: a row follows its 人工补充 parent (spliced or tail) after that row's earlier manual children;
//         on an equal 图号 a tree row wins; a 人工（非补充） row is never an anchor.
//   ME-13 a cycle and a self-parent: the tail, today's order; a row hanging off a cycle follows its parent.
//   ME-14 the degraded part-id tree and the flat comparator: every prefix row in the tail.
//   ME-15 a 人工（非补充） prefix row with a parent: the tail, while a 人工补充 row with the same parent splices.
//   ME-16 C09: the sheets on which no row splices answer main's (df83192d9) result byte for byte.
//   ME-17 the order is a function of the row set (not the arrival order).
//   ME-18 through the mounted route: the workbook carries the spliced order, the audit row is unchanged in shape.

const ME_QTY = EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')
const ME_DEPTH = EXPORT_COLUMNS.findIndex((column) => column.id === 'depth')
const sortNoed = (id, parentComponentCode, componentCode, sortNo) => {
  const record = F.hung(id, parentComponentCode, componentCode)
  record.data.ext_componentSortNo = sortNo
  return record
}

test('ME-08 a 人工补充 row prints at the end of its printed PLM parent\'s subtree', async () => {
  const base = ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2']
  const underRoot = await exportOf([...F.plmTree(), F.hung('rec_c_r', 'SYN-R', 'SYN-M1')])
  assert.deepEqual(codes(underRoot), [...base, 'SYN-M1'], 'R\'s subtree ends after C2 (the collapsed twin and the inactive row are not printed)')
  const underLeaf = await exportOf([...F.plmTree(), F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2')])
  assert.deepEqual(codes(underLeaf), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-M2', 'SYN-C2'], 'mid-tree, before the next sibling')
  const underOrphan = await exportOf([...F.plmTree(), F.hung('rec_c_o', 'SYN-O', 'SYN-M3')])
  assert.deepEqual(codes(underOrphan), ['SYN-O', 'SYN-M3', 'SYN-R', 'SYN-C1', 'SYN-C2'], 'under an orphan root')
  const grandchild = F.plm('rec_6_g', ['P-R', 'P-C1', 'P-C1G'], { parentComponentCode: 'SYN-C1', componentCode: 'SYN-C1G', componentName: 'Grandchild' })
  const deep = await exportOf([...F.plmTree(), grandchild, F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2'), F.hung('rec_c_r', 'SYN-R', 'SYN-M1')])
  assert.deepEqual(codes(deep), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C1G', 'SYN-M2', 'SYN-C2', 'SYN-M1'], 'after the whole subtree, grandchildren included')

  // Everything but the position is B1's: 来源, the counts, 层级 blank, the tree facts; a parentless row stays the tail.
  const mixed = await exportOf([...F.plmTree(), F.hung('rec_c_r', 'SYN-R', 'SYN-M1'), F.person('rec_4_free', { componentCode: 'SYN-A-FREE' })])
  assert.deepEqual(codes(mixed), [...base, 'SYN-M1', 'SYN-A-FREE'])
  assert.deepEqual(sourceCells(mixed), ['PLM', 'PLM', 'PLM', 'PLM', '人工补充', '人工补充'])
  assert.equal(mixed.manualSupplementRowCount, 2)
  assert.equal(mixed.manualOtherRowCount, 0)
  assert.equal(mixed.collapsedRowCount, 1)
  assert.equal(mixed.treeIdentity, 'path')
  assert.equal(mixed.rows[4][ME_DEPTH], null, '层级 stays blank for a spliced row')
  assert.equal(mixed.rows[4][EXPORT_COLUMNS.findIndex((column) => column.id === 'parentComponentCode')], 'SYN-R')
  const continued = await exportOf([...F.plmTree(), F.hung('rec_c_r', 'SYN-R', 'SYN-M1')], { continuation: F.continuationFor() })
  assert.deepEqual(continued.rows.map((row) => [row[CODE], row[32]]), [
    ['SYN-O', '由 SYN-R 沿用（父边用量 2，关系 ort_0001）'], ['SYN-R', ''], ['SYN-C1', ''], ['SYN-C2', ''], ['SYN-M1', ''],
  ])
})

test('ME-09 several rows under one anchor: after the subtree, by compareSiblingRows; nested anchors ending together: deeper first', async () => {
  const result = await exportOf([
    ...F.plmTree(),
    F.hung('rec_c_z', 'SYN-R', 'SYN-MZ'),
    F.hung('rec_c_a', 'SYN-R', 'SYN-MA'),
    sortNoed('rec_c_s', 'SYN-R', 'SYN-MZZ', 1),
    F.hung('rec_c_c2', 'SYN-C2', 'SYN-MC2'),
  ])
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-MC2', 'SYN-MZZ', 'SYN-MA', 'SYN-MZ'],
    'C2 is R\'s last child: C2\'s manual row closes C2\'s subtree, then R\'s rows by 排序号 -> 图号')
})

test('ME-10 an anchor 图号 printed twice: the first printed row is the anchor', async () => {
  const sharedUnderOrphan = F.plm('rec_b_c1o', ['P-X', 'P-O', 'P-C1'], { parentComponentCode: 'SYN-O', componentCode: 'SYN-C1', componentName: 'Child one', totalQuantity: 5 })
  const result = await exportOf([...F.plmTree(), sharedUnderOrphan, F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2')])
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-C1', 'SYN-M2', 'SYN-R', 'SYN-C1', 'SYN-C2'])
  assert.equal(result.rows[1][ME_QTY], 5, 'the anchor is the first SYN-C1 (under the orphan)')
})

test('ME-11 no printed anchor (a new parent, an inactive one, a collapsed one): the tail, in today\'s order', async () => {
  const result = await exportOf([
    ...F.plmTreeWithCollapsedChild(),
    F.hung('rec_c_r', 'SYN-R', 'SYN-M1'),
    F.hung('rec_c_new', 'SYN-NEW', 'SYN-N1'),
    F.hung('rec_c_inactive', 'SYN-OLD', 'SYN-N2'),
    F.hung('rec_c_collapsed', 'SYN-G', 'SYN-N3'),
  ])
  assert.equal(result.collapsedRowCount, 2, 'the twin and its child SYN-G collapsed')
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-M1', 'SYN-N3', 'SYN-N1', 'SYN-N2'],
    'the tail sorts by 父组件图号 (SYN-G < SYN-NEW < SYN-OLD) exactly as B1 did')
})

test('ME-12 manual -> manual: a row follows its 人工补充 parent; a tree row wins on an equal 图号; 人工（非补充） anchors nothing', async () => {
  const result = await exportOf([
    ...F.plmTree(),
    F.hung('rec_c_m1', 'SYN-R', 'SYN-M1'),
    F.hung('rec_c_m0', 'SYN-R', 'SYN-M0'),
    F.hung('rec_c_m2', 'SYN-M1', 'SYN-M2'),
    F.hung('rec_c_m2b', 'SYN-M1', 'SYN-M2B'),
    F.hung('rec_c_m3', 'SYN-M2', 'SYN-M3'),
    // A parentless 人工补充 row with a tree 图号, and a row under that 图号: the tree row is the anchor.
    F.person('rec_e_dup', { componentCode: 'SYN-C1' }),
    F.hung('rec_e_w', 'SYN-C1', 'SYN-W'),
    // Tail: T parentless, U under T (follows T), X under a new parent.
    F.person('rec_f_t', { componentCode: 'SYN-T' }),
    F.hung('rec_f_u', 'SYN-T', 'SYN-U'),
    F.hung('rec_f_x', 'SYN-NEW', 'SYN-X1'),
    // An unbound prefix row (人工（非补充）) is no anchor: V under it stays at its own tail position.
    F.person('rec_g_nb', { componentCode: 'SYN-NB' }, { createdBy: null }),
    F.hung('rec_g_v', 'SYN-NB', 'SYN-V'),
  ])
  assert.deepEqual(codes(result), [
    'SYN-O', 'SYN-R', 'SYN-C1', 'SYN-W', 'SYN-C2', 'SYN-M0', 'SYN-M1', 'SYN-M2', 'SYN-M3', 'SYN-M2B',
    'SYN-V', 'SYN-X1', 'SYN-C1', 'SYN-NB', 'SYN-T', 'SYN-U',
  ])
  assert.equal(result.manualSupplementRowCount, 11)
  assert.equal(result.manualOtherRowCount, 1)
})

test('ME-13 a cycle and a self-parent stay in the tail in today\'s order; a row hanging off a cycle follows its parent', async () => {
  const cycle = [F.hung('rec_d_a', 'SYN-CB', 'SYN-CA'), F.hung('rec_d_b', 'SYN-CA', 'SYN-CB')]
  const selfRows = [F.hung('rec_d_s', 'SYN-S', 'SYN-S'), F.hung('rec_d_r', 'SYN-R', 'SYN-R')]
  const plain = await exportOf([...F.plmTree(), ...cycle, ...selfRows])
  // Today: by 父组件图号 (SYN-CA < SYN-CB < SYN-R < SYN-S). Self-parent stays in the tail even when a tree row has its 图号.
  assert.deepEqual(codes(plain), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-CB', 'SYN-CA', 'SYN-R', 'SYN-S'])
  const hanging = await exportOf([...F.plmTree(), ...cycle, F.hung('rec_d_c', 'SYN-CA', 'SYN-CC')])
  // B1 printed CB, CC (both under SYN-CA), CA. Now CC follows CA; the cycle members keep today's order.
  assert.deepEqual(codes(hanging), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-CB', 'SYN-CA', 'SYN-CC'])
  // A cycle reached from a spliced row: the spliced part is placed, the loop stays in the tail.
  const reached = await exportOf([...F.plmTree(), ...cycle, F.hung('rec_d_m', 'SYN-R', 'SYN-CM'), F.hung('rec_d_n', 'SYN-CM', 'SYN-CN')])
  assert.deepEqual(codes(reached), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-CM', 'SYN-CN', 'SYN-CB', 'SYN-CA'])
})

test('ME-14 the degraded part-id tree and the flat comparator: every prefix row stays in the tail', async () => {
  const degraded = await exportOf([...F.plmTreeWithoutPaths(), F.hung('rec_c_r', 'SYN-R', 'SYN-M1')])
  assert.equal(degraded.treeDegraded, true)
  assert.deepEqual(codes(degraded), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-M1'])
  const underLeaf = await exportOf([...F.plmTreeWithoutPaths(), F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2')])
  assert.deepEqual(codes(underLeaf), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-M2'], 'not after C1: no path, no subtree extent')
  const flat = await exportOf([...F.plmTreeWithoutPaths({ withPartIds: false }), F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2')])
  assert.equal(flat.treeOrdered, false)
  assert.equal(codes(flat)[codes(flat).length - 1], 'SYN-M2')
})

test('ME-15 a 人工（非补充） prefix row with a parent stays in the tail; a 人工补充 row with the same parent splices', async () => {
  const result = await exportOf([
    ...F.plmTree(),
    F.hung('rec_b_unbound', 'SYN-C1', 'SYN-NB1', { createdBy: null }),
    F.hung('rec_b_other', 'SYN-C1', 'SYN-NB2', { key: 'manual:v1:rec_someone_else' }),
    F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2'),
  ])
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-M2', 'SYN-C2', 'SYN-NB1', 'SYN-NB2'])
  assert.deepEqual(sourceCells(result).slice(-2), ['人工（非补充）', '人工（非补充）'])
})

// sha256 of JSON.stringify(result), captured from main df83192d9's OWN export module over F.p3UnsplicedCases().
const P3_UNSPLICED_GOLDENS = {
  'parentless': '9e261d96871ea1c4987929183ab580240d065b02ccba3a5b11d57e4e21499769',
  'parentless + 沿用说明': '126a67c2f3c3cc1cd1b2b984ace91b1d269f71c87b606179b0256e2e2540aa09',
  'unspliceable (人工（非补充）, not found, inactive, collapsed, self, cycle)': '85361da0574816ee7b5d1209dbe561133bf16049f92431fdeda862fcf76af757',
  'degraded part-id tree': 'e87f44d1efa909aa97ec6694ac219a7cea127c8461bfa5cda280faf932b81026',
  'flat comparator': 'b3834fbb47e4b0cc18bbfc99b1410e430fcd67b852aefb5dda352b76e408dcc1',
  'env target': 'e769ad26bbe0b39f1c88823c3511ccaf832de35c67ab46870895f17e45d9b9e2',
}

test('ME-16 C09: a sheet on which no row splices exports main\'s result byte for byte', async () => {
  const crypto = require('node:crypto')
  const cases = F.p3UnsplicedCases()
  assert.deepEqual(cases.map((entry) => entry.name), Object.keys(P3_UNSPLICED_GOLDENS))
  for (const entry of cases) {
    const result = await exportStockPreparationPrepLines({
      recordsApi: F.recordsApiOver(entry.records), target: F.target(entry.objectId), projectNo: F.PROJECT_NO, permission: 'admin',
      ...(entry.continuation ? { continuation: entry.continuation } : {}),
    })
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'), P3_UNSPLICED_GOLDENS[entry.name], entry.name)
  }
  // ME-01 (the pure-PLM goldens) is the other half of C09 and runs unchanged above.
})

test('ME-17 the spliced order depends on the row set only, not on the order rows arrive in', () => {
  const rows = [
    ...F.plmTree(), F.hung('rec_c_m1', 'SYN-R', 'SYN-M1'), F.hung('rec_c_m0', 'SYN-R', 'SYN-M0'), F.hung('rec_c_m2', 'SYN-M1', 'SYN-M2'),
    F.hung('rec_d_a', 'SYN-CB', 'SYN-CA'), F.hung('rec_d_b', 'SYN-CA', 'SYN-CB'), F.person('rec_f_t', { componentCode: 'SYN-T' }), F.hung('rec_f_u', 'SYN-T', 'SYN-U'),
  ].map((record) => exportInternals.unmapRow(record, {}, F.PROJECT_OBJECT_ID)).filter((data) => data.active !== false)
  const split = (list) => {
    const prefix = list.filter((data) => String(data.idempotencyKey).startsWith('manual:'))
    return exportInternals.exportPrintOrder(exportInternals.orderRowsAsBomTree(list.filter((data) => !prefix.includes(data))), prefix)
  }
  const forward = split(rows).map((data) => data[exportInternals.ROW_IDENTITY_KEY])
  const backward = split(rows.slice().reverse()).map((data) => data[exportInternals.ROW_IDENTITY_KEY])
  assert.deepEqual(backward, forward)
  assert.equal(forward.length, rows.length - 1, 'every active row printed, only the PLM display twin collapsed')
  assert.equal(new Set(forward).size, forward.length, 'and none twice')
})

// ── ME-07: through the mounted route ───────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-mr-export'
const STAGING = `${TENANT_ID}:integration-core`
const OPERATOR = Object.freeze({ id: 'u_mr_export_op', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })

function inertService(methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => { throw new Error(`unexpected service call: ${method}`) }]))
}

function mountExport(records) {
  const routes = new Map()
  const auditAppends = []
  const workbooks = []
  const provisioning = makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: {}, sheetOwnerBySheetId: { [F.SHEET_ID]: STAGING } })
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { records: F.recordsApiOver(records), provisioning },
    },
    storage: new Map(),
    config: { stockPreparationTableActions: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' }, target: F.target() }] },
  }
  const services = {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: { async append(entry) { auditAppends.push(entry); return { ok: true } } },
    stockPreparationXlsxExport: { async buildWorkbookBuffer(params) { workbooks.push(params); return Buffer.from(JSON.stringify(params), 'utf8') } },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    stockPreparationProjectWriteLock: createInMemoryProjectWriteLock({ timers: 'real' }).lock,
  }
  httpRoutes.registerIntegrationRoutes({ context, services: withRefreshGovernance(services), logger: { info() {}, warn() {}, error() {} } })
  async function get() {
    const handler = routes.get('GET /api/integration/stock-preparation/prep-lines/export')
    const res = {
      statusCode: 200, body: undefined, headers: {}, sentBuffer: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
      setHeader(name, value) { this.headers[name] = value; return this },
      send(payload) { this.sentBuffer = payload; return this },
    }
    await handler({ user: OPERATOR, body: {}, query: { projectNo: F.PROJECT_NO }, params: {}, headers: {} }, res)
    return res
  }
  return { get, auditAppends, workbooks }
}

test('ME-07 the mounted route: 来源 in the workbook, audit columnCount 32 (31 without a person\'s row), no new audit key', async () => {
  const plain = mountExport(F.plmTree())
  const plainRes = await plain.get()
  assert.equal(plainRes.statusCode, 200, JSON.stringify(plainRes.body))
  assert.equal(plain.workbooks[0].headers.length, 31)
  assert.deepEqual(plain.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 6, activeRowCount: 5, columnCount: 31 })

  const withManual = mountExport([...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1', componentName: 'Manual one' })])
  const res = await withManual.get()
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const workbook = withManual.workbooks[0]
  assert.equal(workbook.headers.length, 32)
  assert.equal(workbook.headers[31], '来源')
  assert.equal(workbook.rows[workbook.rows.length - 1][31], '人工补充')
  assert.deepEqual(withManual.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 7, activeRowCount: 6, columnCount: 32 })
  assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '6')
})

test('ME-18 the mounted route: the workbook carries the spliced order; the audit row keeps its shape', async () => {
  const mounted = mountExport([...F.plmTree(), F.hung('rec_c_c1', 'SYN-C1', 'SYN-M2'), F.person('rec_4_free', { componentCode: 'SYN-A-FREE' })])
  const res = await mounted.get()
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const workbook = mounted.workbooks[0]
  assert.deepEqual(workbook.rows.map((row) => row[CODE]), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-M2', 'SYN-C2', 'SYN-A-FREE'])
  assert.deepEqual(workbook.rows.map((row) => row[31]), ['PLM', 'PLM', 'PLM', '人工补充', 'PLM', '人工补充'])
  assert.deepEqual(mounted.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 8, activeRowCount: 7, columnCount: 32 })
  assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '7')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-manual-rows-export.test.cjs', tests)
