'use strict'

// 场景 B / W7-A1 — 合成 BOM 夹具（单一事实来源）。
//
// owner 裁决（SC-01，场景 B 第一刀）:「本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收。
// 可先用合成字段，不等客户真实字典」。本文件是 A1 的夹具：一张本机 PG 表 + 它对应的已批准只读
// 读取配置 + 行内容，三者由同一个生成器产出，所以 SQL 与测试不可能各自漂移。
//
// 为什么列名是合成的、不模仿客户真实列名：客户 PLM 的列名零语义（含义藏在三张字典表里，数量在
// `Bom_ExAttr1`），那份字典 owner 明确说了本刀不等。仿造一套"看起来像客户"的列名只会把一个还没
// 拿到的映射假装成已知输入。这里的 `syn_`/`SYN-` 前缀是刻意的：任何人一眼能看出它不是客户数据。
// 等真实字典到位，改的只是 `FIELD_MAP` 的 `source` 一侧，目标词表（备料 intake 的 target 名）不动。
//
// 落点无关性：本模块不连库、不发请求、不写盘，只返回纯数据。SQL 由 `schemaSql()`/`seedSql()` 生成，
// committed 的 .sql 文件必须与它逐字节相等（`__tests__/scenario-b-synthetic-bom-source-run.test.cjs`
// 的漂移断言），所以「psql 灌进去的那张表」和「测试里跑的那批行」是同一批。

// 表名/列名全合成。BOM 的一行 = 一条父子关系（parent_no -> part_no），与备料 intake 的
// `plmBomLines` 行平面一致。
const TABLE_NAME = 'syn_bom_items'
const PROJECT_NO = 'SYN-PRJ-B1'
const ROOT_PART_NO = 'SYN-ASM-ROOT'
// 2 层父子：第 1 层 6 条（根 -> 分总成），第 2 层 48 条（分总成 -> 零件）= 54 行 >= 50。
const SUBASSEMBLY_COUNT = 6
const PARTS_PER_SUBASSEMBLY = 8
const UNITS = ['PCS', 'SET', 'KG']

function subassemblyNo(index) {
  return `SYN-SUB-${String(index).padStart(2, '0')}`
}

function partNo(subIndex, partIndex) {
  return `SYN-PRT-${String(subIndex).padStart(2, '0')}-${String(partIndex).padStart(2, '0')}`
}

// 确定性：没有 Date.now / Math.random / 遍历顺序依赖。同一次 checkout 的任何一次调用逐字段相等，
// 否则 committed SQL 的漂移断言就成了随机红。
function buildRows() {
  const rows = []
  let lineNo = 0
  for (let sub = 1; sub <= SUBASSEMBLY_COUNT; sub += 1) {
    const subNo = subassemblyNo(sub)
    lineNo += 1
    rows.push({
      line_no: lineNo,
      project_no: PROJECT_NO,
      parent_no: ROOT_PART_NO,
      part_no: subNo,
      part_name: `合成分总成 ${sub}`,
      qty: 1 + (sub % 3),
      uom: UNITS[sub % UNITS.length],
      rev: `A${sub % 5}`,
      level_no: 1,
      path_key: `/${ROOT_PART_NO}/${subNo}`,
    })
    for (let part = 1; part <= PARTS_PER_SUBASSEMBLY; part += 1) {
      const childNo = partNo(sub, part)
      lineNo += 1
      rows.push({
        line_no: lineNo,
        project_no: PROJECT_NO,
        parent_no: subNo,
        part_no: childNo,
        part_name: `合成零件 ${sub}-${part}`,
        qty: 2 + ((sub * part) % 7),
        uom: UNITS[(sub + part) % UNITS.length],
        rev: `B${part % 4}`,
        level_no: 2,
        path_key: `/${ROOT_PART_NO}/${subNo}/${childNo}`,
      })
    }
  }
  return rows
}

const ROWS = Object.freeze(buildRows().map((row) => Object.freeze(row)))
const ROW_COUNT = ROWS.length

// ── v2：第二批次的同一张表 ───────────────────────────────────────────────────────────────────
// 场景 B 的第 3 步是「对账」。对账引擎（lib/stock-preparation-snapshot-diff.cjs 的
// planBomSnapshotDiff）把两个快照批次按 pathKey 配对，分类成 changed / added / removed /
// unchanged。v1 的 54 行只能证「第一次同步」（全部 added）；要真正跑一次对账，需要一份**只差
// 四处**的 v2。
//
// 四类变更各一条，刻意各自只触发一种 changeType（除去必然伴随的 source_fingerprint_changed）：
//   ① 改数量     —— 只动 qty        -> changed / quantity_changed
//   ② 物料替换   —— 只动 part_no    -> changed / component_code_changed
//   ③ 新增子件   —— 多一行          -> added
//   ④ 删除子件   —— 少一行          -> removed
// 其余 51 行逐字段不变 -> unchanged。
//
// ② 为什么**保持 path_key 不变**：这是「原位替换」和「删一行再加一行」的分界。diff 引擎的
// path_key 是**位置地址**（某个父件下的某个装配位），childDrawingNo 是「这个位置上装的是哪个
// 件」；引擎正是靠「同一 path_key 上 childDrawingNo 变了」把原位物料替换认出来
// （stock-preparation-snapshot-diff.cjs:222-228 的 component_code_changed）。若让 path_key 跟着
// part_no 走，同一件事会被报成 removed+added，component_code_changed 这一类就永远走不到。
// v1 的 path_key 由 part_no 拼出来只是生成方便；v2 这一行把两者解耦，正是为了钉住这个语义。
const V2_QTY_DELTA = 100
const V2_QTY_CHANGED_PATH_KEY = `/${ROOT_PART_NO}/${subassemblyNo(1)}/${partNo(1, 3)}`
const V2_SUBSTITUTED_PATH_KEY = `/${ROOT_PART_NO}/${subassemblyNo(2)}/${partNo(2, 5)}`
const V2_SUBSTITUTED_FROM_PART_NO = partNo(2, 5)
const V2_SUBSTITUTED_TO_PART_NO = `${partNo(2, 5)}R`
const V2_REMOVED_PATH_KEY = `/${ROOT_PART_NO}/${subassemblyNo(4)}/${partNo(4, 8)}`
const V2_ADDED_PART_NO = partNo(6, 9)
const V2_ADDED_PATH_KEY = `/${ROOT_PART_NO}/${subassemblyNo(6)}/${V2_ADDED_PART_NO}`

function buildRowsV2() {
  const rows = []
  for (const row of ROWS) {
    if (row.path_key === V2_REMOVED_PATH_KEY) continue
    if (row.path_key === V2_QTY_CHANGED_PATH_KEY) {
      rows.push({ ...row, qty: row.qty + V2_QTY_DELTA })
      continue
    }
    if (row.path_key === V2_SUBSTITUTED_PATH_KEY) {
      // 位置（path_key / parent_no / line_no）与版本、数量、单位全部不动，只换掉装在这个位置上
      // 的件号与件名 —— 这就是原位物料替换。
      rows.push({ ...row, part_no: V2_SUBSTITUTED_TO_PART_NO, part_name: '合成替换件 2-5' })
      continue
    }
    rows.push({ ...row })
  }
  // 新增子件：第 6 个分总成下的第 9 个零件。件号/版本与被删掉的那一行都不同，所以引擎的
  // identity 配对（childDrawingNo|childVersion，:167-172）不会把 removed 和 added 误配成一次移动。
  rows.push({
    line_no: ROW_COUNT + 1,
    project_no: PROJECT_NO,
    parent_no: subassemblyNo(6),
    part_no: V2_ADDED_PART_NO,
    part_name: '合成新增零件 6-9',
    qty: 2 + ((6 * 9) % 7),
    uom: UNITS[(6 + 9) % UNITS.length],
    rev: `B${9 % 4}`,
    level_no: 2,
    path_key: V2_ADDED_PATH_KEY,
  })
  return rows
}

const ROWS_V2 = Object.freeze(buildRowsV2().map((row) => Object.freeze(row)))
const ROW_COUNT_V2 = ROWS_V2.length

// 两批次配对后的期望分布（测试与文档共用同一份算术，避免两处各写一个数）：
//   v1 54 个 path_key，其中 1 个在 v2 消失 -> 53 对被 path 配上；
//   53 对里 2 对有变更（①②），51 对逐字段相等 -> unchanged；
//   再加 v2 独有的 1 行 added 与 v1 独有的 1 行 removed -> 共 55 条 diff。
const V2_EXPECTED_DIFF = Object.freeze({
  changedQuantity: 1,
  changedComponentCode: 1,
  added: 1,
  removed: 1,
  unchanged: ROW_COUNT - 1 - 2,
  total: (ROW_COUNT - 1) + 1 + 1,
})

// 已批准只读读取配置的字段映射。
//   source 一侧 = 合成表的列名（PG 不带引号建表 -> 全部折叠成小写，适配器把行原样交给
//                 read-source-read-runtime 的 mapRecord，所以这里必须写小写）。
//   target 一侧 = 备料 intake 自己的词表（stock-preparation-readonly-intake.cjs:194-232 的别名梯子），
//                 客户真实字典到位后这一侧一个字都不改。
const FIELD_MAP = Object.freeze([
  { source: 'project_no', target: 'sourceProjectNo' },
  { source: 'path_key', target: 'pathKey' },
  { source: 'parent_no', target: 'parentDrawingNo' },
  { source: 'part_no', target: 'childDrawingNo' },
  { source: 'part_name', target: 'childName' },
  { source: 'qty', target: 'designQty' },
  { source: 'uom', target: 'designUnit' },
  { source: 'rev', target: 'childVersion' },
  { source: 'level_no', target: 'bomLevel' },
].map((entry) => Object.freeze(entry)))

// 已批准的只读读取配置（read-source-config.cjs 的 S1 形状）。
// `requiredKind` 固定 data-source:sql-readonly —— 这是既有 kind 集里的一员，本刀不新增 kind。
// `object` 就是表名：sql-readonly 适配器把它当作 select 的表（可带一个点做 schema 限定）。
function readSourceConfig({ systemId = 'syn-bom-source-b1', object = TABLE_NAME } = {}) {
  return {
    version: 1,
    systemId,
    requiredKind: 'data-source:sql-readonly',
    object,
    mode: 'list_page',
    // sql-readonly 适配器不发 HTTP，readPath/readMethod 只是配置契约的必填项（S1 形状），
    // 适配器从不读它们；给一个安全的相对路径占位。
    readPath: '/readonly/scenario-b-synthetic-bom',
    readMethod: 'POST',
    operations: ['read'],
    // 适配器不产生 raw 载荷（它的行只存在于 records 平面），feeder 因此走 rowSource:'adapter_records'；
    // containerPaths 仍是配置契约的必填项。
    containerPaths: ['Rows'],
    fieldMap: FIELD_MAP.map((entry) => ({ ...entry })),
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

const SQL_HEADER = [
  '-- 场景 B / W7-A1 合成 BOM 夹具 —— 由',
  '--   plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs',
  '-- 生成。不要手改：__tests__/scenario-b-synthetic-bom-source-run.test.cjs 逐字节比对本文件与生成器',
  '-- 的输出，手改会直接红。要改内容就改生成器，再重跑',
  '--   node fixtures/scenario-b-synthetic-bom/regenerate.cjs',
  '--',
  '-- 全部是假数据：SYN- 前缀、编造的编号、没有客户名、没有真实图号、没有任何凭据。',
  '-- 标识符一律不加双引号，PG 会折叠成小写，读取配置的 fieldMap 也写小写 —— 两边对得上。',
  '',
]

function schemaSql() {
  return [
    ...SQL_HEADER,
    `DROP TABLE IF EXISTS ${TABLE_NAME};`,
    '',
    `CREATE TABLE ${TABLE_NAME} (`,
    '  line_no    integer PRIMARY KEY,',
    '  project_no text    NOT NULL,',
    '  parent_no  text    NOT NULL,',
    '  part_no    text    NOT NULL,',
    '  part_name  text    NOT NULL,',
    '  qty        numeric NOT NULL,',
    '  uom        text    NOT NULL,',
    '  rev        text    NOT NULL,',
    '  level_no   integer NOT NULL,',
    '  path_key   text    NOT NULL UNIQUE',
    ');',
    '',
  ].join('\n')
}

const SEED_COLUMNS = 'line_no, project_no, parent_no, part_no, part_name, qty, uom, rev, level_no, path_key'

function seedValues(rows) {
  return rows.map((row) => `  (${[
    row.line_no,
    row.project_no,
    row.parent_no,
    row.part_no,
    row.part_name,
    row.qty,
    row.uom,
    row.rev,
    row.level_no,
    row.path_key,
  ].map(sqlLiteral).join(', ')})`)
}

// v2 种子：同一张表、同一套列，换成 ROWS_V2 的内容。演练顺序是
//   01-schema.sql -> 02-seed.sql -> （跑第 1 次源运行，落批次 1）-> 03-seed-v2.sql -> （跑第 2 次，落批次 2）
// 两次源运行之间只有这张表的内容变了，备料侧的配置一个字都没动 —— 这正是「对账」要证的事。
function seedSqlV2() {
  return [
    ...SQL_HEADER,
    '-- v2（第二批次）：把 02-seed.sql 灌进去的那 54 行整体替换成 v2 的 54 行。',
    `-- 相对 v1 只有四处不同：1 行改数量、1 行原位物料替换（path_key 不变、件号变）、1 行新增、1 行删除。`,
    '',
    `DELETE FROM ${TABLE_NAME};`,
    '',
    `INSERT INTO ${TABLE_NAME} (${SEED_COLUMNS}) VALUES`,
    `${seedValues(ROWS_V2).join(',\n')};`,
    '',
    `-- PASS: DELETE ${ROW_COUNT} 之后 INSERT 0 ${ROW_COUNT_V2}`,
    `-- SELECT count(*) FROM ${TABLE_NAME};                 -- ${ROW_COUNT_V2}`,
    `-- SELECT count(*) FROM ${TABLE_NAME} WHERE level_no = 1; -- ${SUBASSEMBLY_COUNT}`,
    `-- SELECT count(*) FROM ${TABLE_NAME} WHERE level_no = 2; -- ${ROW_COUNT_V2 - SUBASSEMBLY_COUNT}`,
    '',
  ].join('\n')
}

function seedSql() {
  const columns = SEED_COLUMNS
  const values = ROWS.map((row) => `  (${[
    row.line_no,
    row.project_no,
    row.parent_no,
    row.part_no,
    row.part_name,
    row.qty,
    row.uom,
    row.rev,
    row.level_no,
    row.path_key,
  ].map(sqlLiteral).join(', ')})`)
  return [
    ...SQL_HEADER,
    `DELETE FROM ${TABLE_NAME};`,
    '',
    `INSERT INTO ${TABLE_NAME} (${columns}) VALUES`,
    `${values.join(',\n')};`,
    '',
    `-- PASS: INSERT 0 ${ROW_COUNT}`,
    `-- SELECT count(*) FROM ${TABLE_NAME};                 -- ${ROW_COUNT}`,
    `-- SELECT count(*) FROM ${TABLE_NAME} WHERE level_no = 1; -- ${SUBASSEMBLY_COUNT}`,
    `-- SELECT count(*) FROM ${TABLE_NAME} WHERE level_no = 2; -- ${SUBASSEMBLY_COUNT * PARTS_PER_SUBASSEMBLY}`,
    '',
  ].join('\n')
}

module.exports = {
  FIELD_MAP,
  PARTS_PER_SUBASSEMBLY,
  PROJECT_NO,
  ROOT_PART_NO,
  ROWS,
  ROWS_V2,
  ROW_COUNT,
  ROW_COUNT_V2,
  SUBASSEMBLY_COUNT,
  TABLE_NAME,
  V2_ADDED_PART_NO,
  V2_ADDED_PATH_KEY,
  V2_EXPECTED_DIFF,
  V2_QTY_CHANGED_PATH_KEY,
  V2_QTY_DELTA,
  V2_REMOVED_PATH_KEY,
  V2_SUBSTITUTED_FROM_PART_NO,
  V2_SUBSTITUTED_PATH_KEY,
  V2_SUBSTITUTED_TO_PART_NO,
  readSourceConfig,
  schemaSql,
  seedSql,
  seedSqlV2,
}
