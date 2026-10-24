'use strict'

// R67 ③ — BOUNDED-CONCURRENCY PLM BOM EXPANSION READS.
//
// The expander's walk used to await every PLM read before issuing the next, so one dry-run rode one
// pooled connection end to end. `readConcurrency` adds a read-ahead in front of the UNCHANGED walk
// (see the R67 ③ banner in lib/stock-preparation-bom-expansion.cjs). This suite pins the contract:
//
//   (a) byte-identity — the expansion result, its evidence projection and the dry-run revision are
//       the same bytes at every concurrency as on the pre-R67 serial path, for every fixture below,
//       including the cyclic, duplicate-across-branches, dedupe, row-error and abort ones, under
//       three source schedules (instant, one round per read, seeded random 1–4 rounds per read);
//   (b) speed — with per-read latency, concurrency 4 finishes in under half the serial wall time;
//   (c) a failing sibling read aborts exactly as the serial walk does, and apply writes nothing;
//   (d) the knob's clamp (0 -> 1, 99 -> 8, non-numeric -> 4) at both the expander and the config;
//   (e) at most `readConcurrency` adapter reads are ever in flight (the host connection pool is not
//       touched — see the banner — so this bound IS the pooled-connection bound);
//   (f) `summary.readCount` (the field's "PLM reads") equals the queries the source received on
//       every run without a global error, and `readPhase` reports issued / not-consumed honestly;
//   plus the engine's own guards (claim key check, the lead cap that bounds what an early stop can
//   waste, close-without-drain on a failed run) and the dry-run response's `plmReadPhase` stanza;
//   and, from the fix round, ROW SELF-VALIDATION: a read answered with rows its own filter excludes
//   (a transport cross-wire) fails the run as `read_row_mismatch` at every width, while a
//   case-insensitive or implicitly-converting (int 10 = char '0010') source does not, and a source
//   that DECLARES it did not filter (`filtersApplied: false`) has its answer filtered locally.
//
// Everything here is synthetic (SYN-/R. ids) and runs on in-memory fake PLM sources — no database,
// no real PLM.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  DEFAULT_READ_CONCURRENCY,
  READ_CONCURRENCY_MIN,
  READ_CONCURRENCY_MAX,
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  normalizeReadConcurrency,
  normalizeStockPreparationBomReadPlan,
  expandPlmProjectBom,
  summarizeBomExpansionForEvidence,
  __internals: { createPlmReadAheadEngine, READ_AHEAD_LEAD_PER_SLOT, sameFilterValue },
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  applyStockPreparationAction: rawApplyStockPreparationAction,
  dryRunStockPreparationAction: rawDryRunStockPreparationAction,
  normalizeStockPreparationActionConfig,
  __internals: { buildRevision, normalizeActionReadConcurrency, actionReadConcurrency },
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
// Batch-refresh phase 0 step 1: apply requires the project write guard (the route holds the lease) and an
// applicable dry-run binds its token to the plan generation. This suite predates that, so it calls the lib
// through the REAL lock module (in memory, support/stock-preparation-project-write-lock-kit.cjs) exactly the way
// the routes do: the dry-run with the generation binder, the apply inside the lease with the guard.
const projectWriteLockHarness = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs')).createLibWriteLockHarness()
const applyStockPreparationAction = projectWriteLockHarness.wrapApply(rawApplyStockPreparationAction)
const dryRunStockPreparationAction = projectWriteLockHarness.wrapDryRun(rawDryRunStockPreparationAction)

const PROJECT = 'SYN-RC-0001'
const CONCURRENCIES = [1, 2, 4, 8]

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyTables() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [],
    DN_PDM_PartLibraryInfo: [],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function addPart(tables, id, extra = {}) {
  tables.DN_PDM_PartLibraryInfo.push({ OBJ_ID: id, IdentityNo: `${id}-C`, IdentityName: `Part ${id}`, Material: 'Q235', SysVer: 'V1', ...extra })
}

function addHead(tables, partId, bomId, extra = {}) {
  tables.DN_PDM_BomHeadInfo.push({ part_id: partId, bom_id: bomId, SysVer: 'V1', bom_able: true, ...extra })
}

function addDetail(tables, bomId, childId, qty, sort) {
  tables.DN_PDM_BomDetailsInfo.push({ bom_pid: bomId, part_id: childId, Bom_ExAttr1: qty, sort_id: sort })
}

function addRoot(tables, partId, qty = '1', orderId = 'ORDER-1') {
  tables.DN_PDM_OrderDetailInfo.push({ order_id: orderId, part_id: partId, quantity: qty, sort_id: tables.DN_PDM_OrderDetailInfo.length + 1 })
}

// A regular tree under `rootId`: every internal node has ONE active head with `branching` children.
function addTree(tables, rootId, { branching, depth, withRootPart = true }) {
  if (withRootPart) addPart(tables, rootId)
  const grow = (id, level) => {
    if (level >= depth) return
    const bomId = `BOM-${id}`
    addHead(tables, id, bomId)
    for (let index = 0; index < branching; index += 1) {
      const childId = `${id}.${index}`
      addPart(tables, childId)
      addDetail(tables, bomId, childId, String((index % 3) + 1), index + 1)
      grow(childId, level + 1)
    }
  }
  grow(rootId, 0)
}

function wideTree() {
  const tables = emptyTables()
  addRoot(tables, 'R', '2')
  addTree(tables, 'R', { branching: 4, depth: 3 })
  return tables
}

// Two order heads, five order lines: a 总图 pair (the higher SysVer wins root selection), a sheet-
// metal root, an "other" line root selection drops, a line with no part id, a line whose quantity is
// prose, and the same part ordered twice. Every surviving root has a small subtree.
function multiRootOrders() {
  const tables = emptyTables()
  tables.DN_PDM_OrderHeadInfo.push({ OBJ_ID: 'ORDER-2', path_id: 'PATH-1' })
  addPart(tables, 'M1', { IdentityNo: 'J100-00', SysVer: 'V1' })
  addPart(tables, 'M2', { IdentityNo: 'J100-00', SysVer: 'V2' })
  addPart(tables, 'SM', { IdentityNo: 'J100-A', SysVer: 'V1' })
  addPart(tables, 'OT', { IdentityNo: 'K-1', SysVer: 'V1' })
  for (const id of ['M1', 'M2', 'SM', 'OT']) addTree(tables, id, { branching: 3, depth: 2, withRootPart: false })
  addRoot(tables, 'M1', '1')
  addRoot(tables, 'M2', '1')
  addRoot(tables, 'OT', '1', 'ORDER-2')
  addRoot(tables, 'SM', '2', 'ORDER-2')
  tables.DN_PDM_OrderDetailInfo.push({ order_id: 'ORDER-2', part_id: null, quantity: '1', sort_id: 98 })
  tables.DN_PDM_OrderDetailInfo.push({ order_id: 'ORDER-2', part_id: 'SM', quantity: 'many', sort_id: 99 })
  addRoot(tables, 'SM', '2', 'ORDER-2')
  return tables
}

// The SAME sub-assembly under two different parents (and so two different paths): two rows each,
// its subtree read once per occurrence.
function sharedComponent() {
  const tables = emptyTables()
  addRoot(tables, 'R')
  addPart(tables, 'R')
  addHead(tables, 'R', 'BOM-R')
  for (const [index, id] of ['A', 'B', 'C'].entries()) {
    addPart(tables, id)
    addDetail(tables, 'BOM-R', id, '1', index + 1)
    addHead(tables, id, `BOM-${id}`)
  }
  addPart(tables, 'S')
  addDetail(tables, 'BOM-A', 'S', '2', 1)
  addDetail(tables, 'BOM-C', 'S', '5', 1)
  addDetail(tables, 'BOM-B', 'A', '1', 1)
  addTree(tables, 'S', { branching: 3, depth: 2, withRootPart: false })
  return tables
}

// 老系统同父去重 across TWO active heads: B (qty 3) appears in both heads and twice in the first; the
// second and third occurrences collapse — and B has a subtree, so a read-ahead that missed the
// collapse would read that subtree again for nothing. Plus an inactive head and a head with no bom id.
function twoHeadsDedupe() {
  const tables = emptyTables()
  addRoot(tables, 'P')
  addPart(tables, 'P')
  addHead(tables, 'P', 'BOM-P1')
  addHead(tables, 'P', 'BOM-P2')
  addHead(tables, 'P', 'BOM-P3', { bom_able: false })
  addHead(tables, 'P', '', {})
  for (const id of ['B', 'C', 'D']) addPart(tables, id)
  addDetail(tables, 'BOM-P1', 'B', '3', 1)
  addDetail(tables, 'BOM-P1', 'C', '1', 2)
  addDetail(tables, 'BOM-P1', 'B', '3', 3)
  addDetail(tables, 'BOM-P2', 'B', '3', 1)
  addDetail(tables, 'BOM-P2', 'D', '2', 2)
  addDetail(tables, 'BOM-P3', 'C', '9', 1)
  addTree(tables, 'B', { branching: 3, depth: 2, withRootPart: false })
  addTree(tables, 'D', { branching: 2, depth: 1, withRootPart: false })
  return tables
}

// Row errors only — the walk keeps going: a missing part, an ambiguous part (two library rows for one
// id, and that id HAS a BOM head the walk must not descend into), a prose quantity on a child that
// exists and has a subtree, a child with no part id, and an active head with no detail rows.
function rowErrors() {
  const tables = emptyTables()
  addRoot(tables, 'R')
  addPart(tables, 'R')
  addHead(tables, 'R', 'BOM-R')
  addDetail(tables, 'BOM-R', 'GONE', '1', 1)
  addPart(tables, 'AMB', { IdentityNo: 'AMB-1' })
  addPart(tables, 'AMB', { IdentityNo: 'AMB-2' })
  addTree(tables, 'AMB', { branching: 2, depth: 1, withRootPart: false })
  addDetail(tables, 'BOM-R', 'AMB', '1', 2)
  addPart(tables, 'QTY')
  addTree(tables, 'QTY', { branching: 2, depth: 1, withRootPart: false })
  addDetail(tables, 'BOM-R', 'QTY', 'n/a', 3)
  addDetail(tables, 'BOM-R', null, '1', 4)
  addPart(tables, 'HOLLOW')
  addHead(tables, 'HOLLOW', 'BOM-HOLLOW')
  addDetail(tables, 'BOM-R', 'HOLLOW', '1', 5)
  addPart(tables, 'OK')
  addTree(tables, 'OK', { branching: 3, depth: 1, withRootPart: false })
  addDetail(tables, 'BOM-R', 'OK', '4', 6)
  return tables
}

// A cycle in the LAST branch the walk visits (the last detail of the last node points back at the
// root): everything before it is consumed, so even the concurrent run must issue nothing it does
// not consume — which is what proves the read-ahead stops at the walk's own cycle refusal.
function cyclicLast() {
  const tables = wideTree()
  addDetail(tables, 'BOM-R.3.3', 'R', '1', 99)
  return tables
}

// A cycle in the FIRST branch: the run aborts early and the read-ahead has already gone ahead.
function cyclicFirst() {
  const tables = wideTree()
  addDetail(tables, 'BOM-R.0.0', 'R.0', '1', 99)
  return tables
}

// Depth refusal at the very last node the walk visits: only R.3.3 (depth 2) has a BOM head.
function deepLast() {
  const tables = emptyTables()
  addRoot(tables, 'R')
  addTree(tables, 'R', { branching: 4, depth: 2 })
  addHead(tables, 'R.3.3', 'BOM-R.3.3')
  addPart(tables, 'Z')
  addDetail(tables, 'BOM-R.3.3', 'Z', '1', 1)
  return tables
}

function failing(predicate, code = 'SYN_SOURCE_FAILED') {
  return { failWhen: predicate, failCode: code }
}

// Integer part ids and BOM ids, referenced from the other tables as ZERO-PADDED CHAR (int `bom_id` 10,
// char `bom_pid` '0010'): a legal schema SQL Server joins by implicit conversion. `padded: false` is the
// same tree with every reference in its plain form — the expansion both must produce.
function numericTree({ padded }) {
  const tables = emptyTables()
  const ref = (n) => (padded ? String(n).padStart(6, '0') : n)
  let next = 10
  const grow = (id, level) => {
    tables.DN_PDM_PartLibraryInfo.push({ OBJ_ID: id, IdentityNo: `N-${id}`, IdentityName: `Part ${id}`, Material: 'Q235', SysVer: 'V1' })
    if (level >= 2) return
    const bomId = 1000 + id
    tables.DN_PDM_BomHeadInfo.push({ part_id: ref(id), bom_id: bomId, SysVer: 'V1', bom_able: true })
    for (let index = 0; index < 3; index += 1) {
      next += 1
      const child = next
      tables.DN_PDM_BomDetailsInfo.push({ bom_pid: ref(bomId), part_id: child, Bom_ExAttr1: '1', sort_id: index + 1 })
      grow(child, level + 1)
    }
  }
  grow(10, 0)
  tables.DN_PDM_OrderDetailInfo.push({ order_id: 'ORDER-1', part_id: 10, quantity: '2', sort_id: 1 })
  return tables
}

// A MIS-ANSWER: the source answers a different read than the one it was asked (what a transport
// cross-wire looks like from here). `object`/`field` name the read; `from` is asked, `to` is answered.
function misanswer(object, field, from, to) {
  return {
    answerAs: (input) => (input.object === object && input.filters[field] === from
      ? { ...input, filters: { ...input.filters, [field]: to } }
      : input),
  }
}

const FIXTURES = [
  { name: 'wide tree', tables: wideTree },
  { name: 'wide tree, paged (pageLimit 2)', tables: wideTree, input: { pageLimit: 2 } },
  { name: 'multiple order heads + root selection', tables: multiRootOrders },
  { name: 'shared component across branches', tables: sharedComponent },
  { name: 'two active heads + sibling dedupe', tables: twoHeadsDedupe },
  { name: 'row errors (missing / ambiguous / prose qty / no id / no details)', tables: rowErrors },
  { name: 'cycle in the last branch', tables: cyclicLast, abort: 'cycle_detected', zeroWaste: true },
  { name: 'cycle in the first branch', tables: cyclicFirst, abort: 'cycle_detected' },
  { name: 'maxRows abort', tables: wideTree, input: { maxRows: 20 }, abort: 'max_rows_exceeded' },
  { name: 'maxDepth abort at the last node', tables: deepLast, input: { maxDepth: 2 }, abort: 'max_depth_exceeded', zeroWaste: true },
  { name: 'maxDepth abort early', tables: wideTree, input: { maxDepth: 1 }, abort: 'max_depth_exceeded' },
  { name: 'maxReadCount abort', tables: wideTree, input: { maxReadCount: 40 }, abort: 'read_count_exceeded' },
  { name: 'maxPages abort', tables: wideTree, input: { pageLimit: 1, maxPages: 3 }, abort: 'read_page_limit_exceeded', multiPage: true },
  {
    name: 'failed bomHead read mid-walk',
    tables: wideTree,
    source: failing((input) => input.object === 'DN_PDM_BomHeadInfo' && input.filters.part_id === 'R.1.2'),
    abort: 'read_failed',
  },
  {
    name: 'failed part read mid-walk',
    tables: wideTree,
    source: failing((input) => input.object === 'DN_PDM_PartLibraryInfo' && input.filters.OBJ_ID === 'R.2.3'),
    abort: 'read_failed',
  },
  {
    name: 'failed detail read mid-walk',
    tables: wideTree,
    source: failing((input) => input.object === 'DN_PDM_BomDetailsInfo' && input.filters.bom_pid === 'BOM-R.1'),
    abort: 'read_failed',
  },
  {
    name: 'broken cursor (armed full-batch check)',
    tables: wideTree,
    input: { pageLimit: 2, requireCompleteBatch: true },
    source: { brokenCursorWhen: (input) => input.object === 'DN_PDM_BomDetailsInfo' && input.filters.bom_pid === 'BOM-R.2' },
    abort: 'read_cursor_broken',
    multiPage: true,
  },
  { name: "bomHead read answered with another part's heads", tables: wideTree, source: misanswer('DN_PDM_BomHeadInfo', 'part_id', 'R.1', 'R.2'), abort: 'read_row_mismatch' },
  { name: "detail read answered with another BOM's details", tables: wideTree, source: misanswer('DN_PDM_BomDetailsInfo', 'bom_pid', 'BOM-R.2', 'BOM-R.3'), abort: 'read_row_mismatch' },
  { name: 'part read answered with another part', tables: wideTree, source: misanswer('DN_PDM_PartLibraryInfo', 'OBJ_ID', 'R.1.2', 'R.1.3'), abort: 'read_row_mismatch' },
]

// ── the committed SQL fixtures, replayed in memory ──────────────────────────────────────────────
// A deliberately small reader (CREATE TABLE / INSERT INTO … VALUES / DELETE FROM), quote-aware, the
// same shape the synthetic-sql-fixture and structure-exact suites use. Types are modelled the way
// node-postgres hands them back (numeric as a fixed-scale string).

function stripSqlComments(sql) {
  let out = ''
  let inString = false
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (inString) {
      out += char
      if (char === "'") {
        if (sql[i + 1] === "'") {
          out += "'"
          i += 1
        } else {
          inString = false
        }
      }
      continue
    }
    if (char === "'") {
      inString = true
      out += char
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    out += char
  }
  return out
}

function splitOutsideStrings(text, separator, { trackParens = false } = {}) {
  const parts = []
  let current = ''
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      current += char
      if (char === "'") {
        if (text[i + 1] === "'") {
          current += "'"
          i += 1
        } else {
          inString = false
        }
      }
      continue
    }
    if (char === "'") {
      inString = true
      current += char
      continue
    }
    if (trackParens && char === '(') depth += 1
    if (trackParens && char === ')') depth -= 1
    if (char === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += char
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
    const char = tail[i]
    if (inString) {
      current += char
      if (char === "'") {
        if (tail[i + 1] === "'") {
          current += "'"
          i += 1
        } else {
          inString = false
        }
      }
      continue
    }
    if (char === "'") {
      inString = true
      current += char
      continue
    }
    if (char === '(') {
      depth += 1
      if (depth === 1) {
        current = ''
        continue
      }
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        tuples.push(current)
        continue
      }
    }
    if (depth > 0) current += char
  }
  return tuples
}

function columnKind(definition) {
  const lowered = definition.toLowerCase()
  const scale = /^(?:numeric|decimal)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(lowered)
  if (/^(numeric|decimal)/.test(lowered)) return { kind: 'numeric', scale: scale ? Number(scale[1]) : 0 }
  if (/^(smallint|integer|int|bigint)/.test(lowered)) return { kind: 'integer' }
  if (/^boolean/.test(lowered)) return { kind: 'boolean' }
  return { kind: 'string' }
}

function loadSqlFixture(dir, files) {
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n')
  const schema = new Map()
  for (const statement of splitOutsideStrings(stripSqlComments(read(files[0])), ';')) {
    const match = /^CREATE\s+TABLE\s+([A-Za-z0-9_.]+)\s*\(/i.exec(statement)
    if (!match) continue
    const body = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'))
    const columns = new Map()
    for (const definition of splitOutsideStrings(body, ',', { trackParens: true })) {
      const head = definition.split(/\s+/)[0].toLowerCase()
      if (['primary', 'unique', 'check', 'constraint', 'foreign', 'exclude'].includes(head)) continue
      columns.set(head, columnKind(definition.slice(head.length).trim()))
    }
    schema.set(match[1].toLowerCase(), columns)
  }
  const state = new Map([...schema.keys()].map((table) => [table, []]))
  for (const file of files.slice(1)) {
    for (const statement of splitOutsideStrings(stripSqlComments(read(file)), ';')) {
      const del = /^DELETE\s+FROM\s+([A-Za-z0-9_.]+)\s*$/i.exec(statement)
      if (del) {
        state.set(del[1].toLowerCase(), [])
        continue
      }
      const insert = /^INSERT\s+INTO\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]+)$/i.exec(statement)
      if (!insert) continue
      const table = insert[1].toLowerCase()
      const columns = schema.get(table)
      assert.ok(columns, `${file}: unknown table ${insert[1]}`)
      const names = insert[2].split(',').map((name) => name.trim().toLowerCase())
      for (const tuple of valueTuples(insert[3])) {
        const values = splitOutsideStrings(tuple, ',', { trackParens: true })
        const row = {}
        names.forEach((name, index) => {
          const raw = values[index].trim()
          const type = columns.get(name) || { kind: 'string' }
          if (/^null$/i.test(raw)) row[name] = null
          else if (raw.startsWith("'")) row[name] = raw.slice(1, -1).replace(/''/g, "'")
          else if (/^(true|false)$/i.test(raw)) row[name] = /^true$/i.test(raw)
          else if (type.kind === 'numeric') row[name] = Number(raw).toFixed(type.scale)
          else row[name] = Number(raw)
        })
        state.get(table).push(row)
      }
    }
  }
  // Keyed by the lower-cased table name; the adapter below folds the requested object the same way
  // (Postgres folds unquoted identifiers, and the fixtures are written that way).
  return state
}

const SYNTHETIC_DIR = path.join(__dirname, '..', 'fixtures', 'stock-preparation-synthetic-sql-source')
const STRUCTURE_DIR = path.join(__dirname, '..', 'fixtures', 'stock-preparation-structure-exact-plm')
const SUBTREE_READ_PLAN = Object.freeze({
  ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  maxReadCount: 500,
  projectSubtree: { pathInfo: { parentIdField: 'Parent_OBJ_ID' }, bomHead: { pathIdField: 'path_id' } },
})
// The structure-exact fixture's customer-vocabulary read plan (same objects/fields as
// stock-preparation-structure-exact-rehearsal.test.cjs).
const STRUCTURE_READ_PLAN = normalizeStockPreparationBomReadPlan({
  id: 'plm.stock-preparation.bom-read.dn-view.structure-exact',
  sourceKind: 'data-source:sql-readonly',
  matchField: 'project_code',
  pathExAttr: { object: 'DN_Project_View', matchField: 'project_code', pathIdField: 'path_id' },
  pathInfo: { object: 'DN_ProjectPath_View', idField: 'path_id' },
  orderHead: { object: 'DN_ProjectRoot_View', idField: 'root_id', pathIdField: 'path_id' },
  orderDetail: { object: 'DN_ProjectRootLine_View', orderIdField: 'root_id', componentIdField: 'part_id', quantityField: 'Bom_ExAttr1', sortField: 'sort_id' },
  part: { object: 'DN_PartLibrary_View', idField: 'part_id', codeField: 'DrawingType', nameField: 'TargetName', materialField: 'Material', versionField: 'SysVer', specField: 'Specification', createTimeField: 'Createtime' },
  bomHead: { object: 'DN_BomHead_View', parentPartField: 'part_id', bomIdField: 'bom_id', versionField: 'SysVer', activeField: 'bom_able' },
  bomDetail: { object: 'DN_BomDetails_View', bomParentField: 'bom_pid', componentIdField: 'part_id', quantityField: 'Bom_ExAttr1', sortField: 'sort_id' },
})

const SQL_FIXTURES = [
  { name: 'synthetic SQL pull #1', dir: SYNTHETIC_DIR, files: ['01-schema.sql', '02-seed-pull-1.sql'], projectNo: 'SYN-PROJ-0001', input: { pageLimit: 2 } },
  { name: 'synthetic SQL pull #2', dir: SYNTHETIC_DIR, files: ['01-schema.sql', '03-seed-pull-2.sql'], projectNo: 'SYN-PROJ-0001' },
  { name: 'synthetic SQL duplicate expanded key', dir: SYNTHETIC_DIR, files: ['01-schema.sql', '02-seed-pull-1.sql', '04-optional-duplicate-expanded-key.sql'], projectNo: 'SYN-PROJ-0001' },
  { name: 'synthetic SQL project subtree', dir: SYNTHETIC_DIR, files: ['01-schema.sql', '02-seed-pull-1.sql', '05-seed-subtree-roots.sql'], projectNo: 'SYN-PROJ-0001', input: { readPlan: SUBTREE_READ_PLAN } },
  { name: 'structure-exact batch #1, project A', dir: STRUCTURE_DIR, files: ['01-schema.sql', '02-seed-batch-1.sql'], projectNo: 'SYN-XM-0001', input: { readPlan: STRUCTURE_READ_PLAN, pageLimit: 2 } },
  { name: 'structure-exact batch #1, project B', dir: STRUCTURE_DIR, files: ['01-schema.sql', '02-seed-batch-1.sql'], projectNo: 'SYN-XM-0002', input: { readPlan: STRUCTURE_READ_PLAN } },
  { name: 'structure-exact batch #2', dir: STRUCTURE_DIR, files: ['01-schema.sql', '02-seed-batch-1.sql', '03-seed-batch-2.sql'], projectNo: 'SYN-XM-0001', input: { readPlan: STRUCTURE_READ_PLAN } },
]

// ── fake PLM sources ────────────────────────────────────────────────────────────────────────────

function lookupRows(tables, object) {
  if (tables instanceof Map) {
    const rows = tables.get(String(object).toLowerCase())
    assert.ok(rows, `read(${object}) hit a table the fixture does not declare`)
    return { rows, fold: true }
  }
  return { rows: Array.isArray(tables[object]) ? tables[object] : [], fold: false }
}

// The answer to one read, computed from the tables at the moment it is ANSWERED.
function answer(tables, input, behaviour = {}) {
  if (behaviour.failWhen && behaviour.failWhen(input)) {
    const error = new Error('synthetic source failure')
    error.code = behaviour.failCode || 'SYN_SOURCE_FAILED'
    throw error
  }
  const asked = behaviour.answerAs ? behaviour.answerAs(input) : input
  const { rows, fold } = lookupRows(tables, asked.object)
  // `unfilteredObjects`: the whole table, and SAYS so (`filtersApplied: false`) — legal for the bridge.
  const unfiltered = Array.isArray(behaviour.unfilteredObjects) && behaviour.unfilteredObjects.includes(asked.object)
  // `declareUnfilteredObjects`: answers as asked, but SAYS `filtersApplied: false` (a cross-wired
  // answer from a source that does not filter looks like this).
  const declaresUnfiltered = unfiltered
    || (Array.isArray(behaviour.declareUnfilteredObjects) && behaviour.declareUnfilteredObjects.includes(asked.object))
  // `caseInsensitiveObjects`: equality the way a SQL Server default collation does it.
  const folding = Array.isArray(behaviour.caseInsensitiveObjects) && behaviour.caseInsensitiveObjects.includes(asked.object)
  // `convertNumbers`: SQL Server's implicit conversion — a char column compared with an int.
  const numericKey = (value) => (/^\s*[+-]?\d+(\.\d+)?\s*$/.test(String(value)) ? Number(value) : null)
  const same = (left, right) => {
    if (folding && typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase()
    if (behaviour.convertNumbers && left !== null && right !== null && numericKey(left) !== null) return numericKey(left) === numericKey(right)
    return left === right
  }
  const matches = unfiltered
    ? rows
    : rows.filter((row) => Object.entries(asked.filters).every(([field, expected]) => same(row[fold ? field.toLowerCase() : field], expected)))
  const offset = input.cursor ? Number(input.cursor) : 0
  const limit = input.limit || 1000
  const records = matches.slice(offset, offset + limit).map(clone)
  const consumed = offset + records.length
  const done = consumed >= matches.length
  if (!done && behaviour.brokenCursorWhen && behaviour.brokenCursorWhen(input)) {
    return { records, done: false, nextCursor: null, metadata: { source: 'data-source:sql-readonly', filtersApplied: true } }
  }
  return {
    records,
    nextCursor: done ? null : String(consumed),
    done,
    metadata: { source: 'data-source:sql-readonly', filtersApplied: !declaresUnfiltered, filterFields: Object.keys(input.filters).sort() },
  }
}

// Answers every read immediately (one microtask). Counts calls, records their order.
function instantSource(tables, behaviour) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input) {
        calls.push({ object: input.object, filters: { ...input.filters }, cursor: input.cursor || null })
        // A read the source never answers (a hung connection with no request timeout).
        if (behaviour && behaviour.hangWhen && behaviour.hangWhen(input)) return new Promise(() => {})
        return answer(tables, input, behaviour)
      },
    },
  }
}

// A deterministic simulated network. A read is answered only when the driver advances the virtual
// clock to its due round; `latency(input, seq)` says how many rounds it takes. Between rounds the
// driver lets every microtask run (setImmediate), so the expander has issued every read it can
// before the next round is answered. `rounds` is therefore the wall time in round-trips.
function virtualSource(tables, behaviour = {}, latency = () => 1) {
  const pending = []
  const calls = []
  let round = 0
  let maxPending = 0
  let seq = 0
  let pendingAtSettle
  let swaps = 0
  const adapter = {
    read(input) {
      calls.push({ round, object: input.object, filters: { ...input.filters }, cursor: input.cursor || null })
      // A latency of Infinity is a read the source never answers.
      const rounds = latency(input, seq++)
      const due = rounds === Infinity ? Infinity : round + Math.max(1, rounds)
      return new Promise((resolve, reject) => {
        pending.push({ due, input: { ...input, filters: { ...input.filters } }, resolve, reject })
        maxPending = Math.max(maxPending, pending.length)
      })
    },
  }
  async function drive(promise, { afterSettleRounds = 0 } = {}) {
    let settled = false
    let value
    let failure
    promise.then((result) => { settled = true; value = result }, (error) => { settled = true; failure = error })
    let extra = afterSettleRounds
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve))
      if (settled) {
        // What was still in flight at the moment the expansion returned (no round has run since).
        if (pendingAtSettle === undefined) pendingAtSettle = pending.length
        if (extra <= 0) break
        extra -= 1
      } else if (pending.every((entry) => entry.due === Infinity)) {
        throw new Error('virtual source: the expansion is waiting but no read can ever complete (deadlock / hang)')
      }
      round += 1
      const due = pending.filter((entry) => entry.due <= round)
      for (const entry of due) pending.splice(pending.indexOf(entry), 1)
      const answers = due.map((entry) => {
        try {
          return { value: answer(tables, entry.input, behaviour) }
        } catch (error) {
          return { error }
        }
      })
      // ONE TRANSPORT CROSS-WIRE: two concurrent part reads, each handed the other's answer.
      if (behaviour.crossWirePartReads && swaps === 0) {
        const parts = due
          .map((entry, index) => index)
          .filter((index) => due[index].input.object === 'DN_PDM_PartLibraryInfo' && !answers[index].error)
        if (parts.length >= 2) {
          const [first, second] = parts
          const held = answers[first]
          answers[first] = answers[second]
          answers[second] = held
          swaps += 1
        }
      }
      due.forEach((entry, index) => {
        if (answers[index].error) entry.reject(answers[index].error)
        else entry.resolve(answers[index].value)
      })
    }
    if (failure) throw failure
    return value
  }
  return {
    adapter,
    calls,
    drive,
    now: () => round * 100,
    get round() { return round },
    get maxPending() { return maxPending },
    get pendingCount() { return pending.length },
    get pendingAtSettle() { return pendingAtSettle },
    get swaps() { return swaps },
  }
}

// Seeded PRNG (mulberry32): random-but-reproducible latencies, so arrival order differs from issue
// order in a way that is the same on every CI run.
function seededLatency(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return 1 + (((t ^ (t >>> 14)) >>> 0) % 4)
  }
}

// ── comparison helpers ──────────────────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function withoutReadPhase(result) {
  const { readPhase, ...rest } = result
  return rest
}

const REVISION_ACTION = {
  actionId: PLM_STOCK_PREPARATION_ACTION_ID,
  source: { externalSystemId: 'plm_source_1', workspaceId: null, readPlan: null },
  target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
}

function fingerprints(result, projectNo) {
  return {
    result: sha256(JSON.stringify(withoutReadPhase(result))),
    evidence: sha256(JSON.stringify(summarizeBomExpansionForEvidence(result))),
    revision: buildRevision({
      action: REVISION_ACTION,
      parameters: { projectNo },
      expansion: result,
      existingRows: [],
      conflictPolicyReview: null,
      plan: null,
    }),
  }
}

function expansionInput(fixture, sourceAdapter, extra = {}) {
  return { sourceAdapter, projectNo: fixture.projectNo || PROJECT, ...(fixture.input || {}), ...extra }
}

function tablesOf(fixture) {
  return fixture.dir ? loadSqlFixture(fixture.dir, fixture.files) : fixture.tables()
}

const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

// ── (a) + (f) byte-identity and read accounting, every fixture, every schedule ─────────────────

async function testByteIdenticalAtEveryConcurrencyAndSchedule() {
  let compared = 0
  for (const fixture of [...FIXTURES, ...SQL_FIXTURES]) {
    const tables = tablesOf(fixture)
    const baselineSource = instantSource(tables, fixture.source)
    const baseline = await expandPlmProjectBom(expansionInput(fixture, baselineSource.adapter))
    assert.equal(baseline.readPhase, undefined, `${fixture.name}: no readConcurrency => no engine, no stanza`)
    const expected = fingerprints(baseline, fixture.projectNo || PROJECT)
    const baselineText = JSON.stringify(baseline)
    if (fixture.abort) {
      assert.ok(baseline.errors.some((error) => error.type === fixture.abort), `${fixture.name}: the fixture really aborts with ${fixture.abort}`)
    } else {
      assert.deepEqual(baseline.errors, [], `${fixture.name}: the fixture really has no global error`)
    }

    for (const concurrency of CONCURRENCIES) {
      const schedules = [
        ['instant', () => instantSource(tables, fixture.source)],
        ['one round per read', () => virtualSource(tables, fixture.source)],
        ['seeded random 1-4 rounds', () => virtualSource(tables, fixture.source, seededLatency(concurrency * 7919))],
      ]
      for (const [scheduleName, makeSource] of schedules) {
        const source = makeSource()
        const run = expandPlmProjectBom(expansionInput(fixture, source.adapter, { readConcurrency: concurrency }))
        const result = source.drive ? await source.drive(run) : await run
        const label = `${fixture.name} @ ${concurrency} (${scheduleName})`
        assert.deepEqual(fingerprints(result, fixture.projectNo || PROJECT), expected, `${label}: result / evidence / revision hashes`)
        assert.equal(JSON.stringify(withoutReadPhase(result)), baselineText, `${label}: byte-identical expansion`)
        const phase = result.readPhase
        assert.deepEqual(Object.keys(phase), ['readConcurrency', 'maxReadsInFlight', 'queriesIssued', 'queriesNotConsumed', 'wallMs'], `${label}: stanza shape`)
        assert.ok(Object.values(phase).every((value) => Number.isInteger(value) && value >= 0), `${label}: values-free integers`)
        assert.equal(phase.readConcurrency, concurrency)
        // (f) the source received exactly `queriesIssued` queries; `readCount` stays the walk's own.
        assert.equal(phase.queriesIssued, source.calls.length, `${label}: queriesIssued is every adapter call`)
        assert.equal(phase.queriesNotConsumed, phase.queriesIssued - result.summary.readCount, `${label}: not-consumed is issued minus readCount`)
        assert.ok(phase.maxReadsInFlight >= 1 && phase.maxReadsInFlight <= concurrency, `${label}: in flight within the bound`)
        if (!fixture.multiPage) {
          // The waste bound, on every early stop of every schedule (single-page reads — a multi-page
          // read-ahead finishes its pages, so those two fixtures are bounded by the cap plus pages).
          assert.ok(phase.queriesNotConsumed <= READ_AHEAD_LEAD_PER_SLOT * concurrency, `${label}: waste within the lead cap`)
        }
        if (!fixture.abort || fixture.zeroWaste) {
          assert.equal(phase.queriesNotConsumed, 0, `${label}: a run with no global error (or one aborting on its last branch) issues nothing it does not consume`)
          assert.equal(result.summary.readCount, source.calls.length, `${label}: the field's "PLM reads" equals the queries the source received`)
        }
        compared += 1
      }
    }
    // Concurrency 1 is the literal serial walk: the same reads, in the same order, as no knob at all.
    const serialSource = instantSource(tables, fixture.source)
    await expandPlmProjectBom(expansionInput(fixture, serialSource.adapter, { readConcurrency: 1 }))
    assert.deepEqual(serialSource.calls, baselineSource.calls, `${fixture.name}: readConcurrency 1 issues the pre-R67 read sequence`)
  }
  console.log(`  (a)/(f) ${FIXTURES.length + SQL_FIXTURES.length} fixtures x ${CONCURRENCIES.length} concurrencies x 3 schedules = ${compared} byte-identical runs`)
}

// ── (b) wall time under per-read latency ────────────────────────────────────────────────────────

async function testConcurrencyFourHalvesTheWallTime() {
  const tables = wideTree()
  const measure = async (readConcurrency) => {
    const source = virtualSource(tables)
    const result = await source.drive(expandPlmProjectBom({ sourceAdapter: source.adapter, projectNo: PROJECT, readConcurrency, now: source.now, startedAtMs: 0 }))
    return { result, rounds: source.round, calls: source.calls.length, maxPending: source.maxPending }
  }
  const serial = await measure(1)
  const four = await measure(4)
  const eight = await measure(8)
  assert.equal(serial.rounds, serial.calls, 'serial: one round-trip per read')
  assert.equal(serial.maxPending, 1)
  assert.ok(four.rounds * 2 < serial.rounds, `concurrency 4 takes ${four.rounds} round-trips vs ${serial.rounds} serial — must be < 1/2`)
  assert.ok(eight.rounds < four.rounds, `concurrency 8 (${eight.rounds}) is faster again than 4 (${four.rounds})`)
  // The stanza's wall time is the phase's own clock (here the virtual one: 100 per round-trip).
  assert.ok(four.result.readPhase.wallMs * 2 < serial.result.readPhase.wallMs, 'readPhase.wallMs reports the same halving')
  assert.equal(serial.result.readPhase.wallMs, serial.rounds * 100)
  assert.equal(JSON.stringify(withoutReadPhase(four.result)), JSON.stringify(withoutReadPhase(serial.result)))
  console.log(`  (b) ${serial.calls} reads: serial ${serial.rounds} round-trips, x4 ${four.rounds}, x8 ${eight.rounds}`)
}

// ── (c) a failing sibling read: same error, nothing written ────────────────────────────────────

function baseAction(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
    ...overrides,
  }
}

function memoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.has(key) ? clone(map.get(key)) : null },
    async set(key, value) { map.set(key, clone(value)) },
    async delete(key) { map.delete(key) },
    // Atomic claim, like the host's DELETE ... RETURNING: read and remove in one synchronous step.
    async consume(key) { if (!map.has(key)) return null; const value = map.get(key); map.delete(key); return clone(value) },
  }
}

function recordsApi() {
  const calls = []
  return {
    calls,
    api: {
      async queryRecords(input = {}) { calls.push(['queryRecords', input.sheetId]); return [] },
      async createRecord(input = {}) { calls.push(['createRecord', input.sheetId]); return { id: `rec_${calls.length}`, version: 1, data: input.data } },
      async patchRecord(input = {}) { calls.push(['patchRecord', input.sheetId]); return { id: input.recordId, version: 2, data: input.changes } },
    },
  }
}

function dryRunWithoutClock(response) {
  const copy = clone(response)
  delete copy.dryRunToken
  delete copy.plmReadPhase
  return copy
}

async function testAFailingSiblingReadAbortsTheSameWayAndWritesNothing() {
  const failure = failing((input) => input.object === 'DN_PDM_PartLibraryInfo' && input.filters.OBJ_ID === 'R.1.2', 'SYN_PLM_TIMEOUT')
  const outcomes = []
  for (const readConcurrency of [undefined, 1, 4, 8]) {
    const storage = memoryStorage()
    const records = recordsApi()
    const action = baseAction(readConcurrency === undefined ? {} : { readConcurrency })
    const source = instantSource(wideTree(), failure)
    const dryRun = await dryRunStockPreparationAction({
      action,
      parameters: { projectNo: PROJECT },
      sourceAdapter: source.adapter,
      recordsApi: records.api,
      tokenStore: storage,
      plannedAt: '2026-10-18T00:00:00.000Z',
    })
    assert.equal(dryRun.status, 'failed')
    assert.equal(dryRun.canApply, false)
    assert.equal(dryRun.dryRunToken, null, 'no token, so nothing can be applied off this read')
    assert.equal(storage.map.size, 0, 'a failed dry-run stores nothing')
    assert.deepEqual(dryRun.evidence.expansion.errorTypes, ['read_failed'])
    assert.equal(records.calls.some((call) => call[0] !== 'queryRecords'), false, 'a dry-run never writes')
    outcomes.push(dryRunWithoutClock(dryRun))

    // Apply recomputes the same expansion before its first write: a token minted off a CLEAN read
    // must be refused the moment the recompute meets the failing sibling — and nothing is written.
    const cleanStorage = memoryStorage()
    const cleanRecords = recordsApi()
    const clean = await dryRunStockPreparationAction({
      action,
      parameters: { projectNo: PROJECT },
      sourceAdapter: instantSource(wideTree()).adapter,
      recordsApi: cleanRecords.api,
      tokenStore: cleanStorage,
      plannedAt: '2026-10-18T00:00:00.000Z',
    })
    assert.equal(clean.canApply, true)
    await assert.rejects(
      () => applyStockPreparationAction({
        sandboxPolicy: { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] },
        action,
        parameters: { projectNo: PROJECT },
        dryRunToken: clean.dryRunToken,
        sourceAdapter: instantSource(wideTree(), failure).adapter,
        recordsApi: cleanRecords.api,
        tokenStore: cleanStorage,
        permission: 'write',
        plannedAt: '2026-10-18T00:00:00.000Z',
      }),
      (error) => {
        assert.equal(error.code, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', `@${readConcurrency}: refused at the recompute`)
        return true
      },
    )
    assert.deepEqual(cleanRecords.calls.filter((call) => call[0] !== 'queryRecords'), [], `@${readConcurrency}: apply wrote nothing`)
  }
  for (const outcome of outcomes.slice(1)) {
    assert.deepEqual(outcome, outcomes[0], 'the failed dry-run is the same response at every concurrency (bar the clock stanza)')
  }
  const failed = outcomes[0].evidence.expansion.readDiagnostics.filter((entry) => entry.status === 'failed')
  assert.deepEqual(failed.map((entry) => entry.errorCode), ['SYN_PLM_TIMEOUT'], 'one failed read, recorded once, with its cause class')
  console.log('  (c) failing sibling read: same failed dry-run at 1/4/8, apply refused before any write')
}

// ── (d) the clamp ───────────────────────────────────────────────────────────────────────────────

async function testTheKnobIsClamped() {
  assert.equal(DEFAULT_READ_CONCURRENCY, 4)
  assert.equal(READ_CONCURRENCY_MIN, 1)
  assert.equal(READ_CONCURRENCY_MAX, 8)
  const cases = [
    [0, 1], [-3, 1], [1, 1], [2.9, 2], [4, 4], [8, 8], [9, 8], [99, 8], ['6', 6], [' 3 ', 3], ['99', 8],
    ['abc', 4], ['', 4], [null, 4], [undefined, 4], [true, 4], [NaN, 4], [Infinity, 4], [{}, 4], [[2], 4],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeReadConcurrency(input), expected, `normalizeReadConcurrency(${String(input)})`)
  }
  // Config time: a number is STORED clamped; anything else is dropped (=> the default runs).
  const configCases = [[0, 1], [99, 8], [3, 3], ['5', 5], ['abc', undefined], [null, undefined], [undefined, undefined], [true, undefined]]
  for (const [input, expected] of configCases) {
    assert.equal(normalizeActionReadConcurrency(input), expected, `normalizeActionReadConcurrency(${String(input)})`)
    const normalized = normalizeStockPreparationActionConfig(baseAction(input === undefined ? {} : { readConcurrency: input }))
    assert.equal(normalized.readConcurrency, expected)
    assert.equal('readConcurrency' in normalized, expected !== undefined, 'absent / non-numeric adds no key, so a legacy config normalizes byte-identically')
    assert.equal(actionReadConcurrency(normalized), expected === undefined ? 4 : expected, 'what computeDryRun hands the expander')
  }
  // Expander time, end to end: what actually runs.
  for (const [input, expected] of [[0, 1], [99, 8], ['abc', 4]]) {
    const source = virtualSource(wideTree())
    const result = await source.drive(expandPlmProjectBom({ sourceAdapter: source.adapter, projectNo: PROJECT, readConcurrency: input }))
    assert.equal(result.readPhase.readConcurrency, expected, `readConcurrency ${String(input)} runs at ${expected}`)
    assert.equal(source.maxPending, expected, `readConcurrency ${String(input)}: ${expected} reads in flight at most (and the wide tree reaches it)`)
  }
  console.log('  (d) clamp: 0->1, 99->8, non-numeric->4 (config drops it; the default runs)')
}

// ── (e) the in-flight bound ─────────────────────────────────────────────────────────────────────

async function testNoMoreThanConcurrencyReadsInFlight() {
  for (const readConcurrency of [1, 2, 3, 4, 8]) {
    for (const latency of [() => 1, seededLatency(readConcurrency)]) {
      const source = virtualSource(wideTree(), {}, latency)
      const result = await source.drive(expandPlmProjectBom({ sourceAdapter: source.adapter, projectNo: PROJECT, readConcurrency }))
      assert.ok(source.maxPending <= readConcurrency, `@${readConcurrency}: ${source.maxPending} reads were in flight`)
      assert.equal(result.readPhase.maxReadsInFlight, source.maxPending, `@${readConcurrency}: the stanza reports what the source saw`)
    }
  }
  // And the bound is reached, not just respected: a wide tree keeps all eight slots busy.
  const wide = virtualSource(wideTree())
  await wide.drive(expandPlmProjectBom({ sourceAdapter: wide.adapter, projectNo: PROJECT, readConcurrency: 8 }))
  assert.equal(wide.maxPending, 8)
  console.log('  (e) reads in flight never exceed readConcurrency (1/2/3/4/8, two schedules)')
}

// ── the dry-run response ────────────────────────────────────────────────────────────────────────

async function testDryRunCarriesThePhaseStanzaBesideAnUnchangedEvidence() {
  const responses = []
  for (const readConcurrency of [undefined, 1, 4, 8]) {
    const action = baseAction(readConcurrency === undefined ? {} : { readConcurrency })
    const source = instantSource(wideTree())
    const response = await dryRunStockPreparationAction({
      action,
      parameters: { projectNo: PROJECT },
      sourceAdapter: source.adapter,
      recordsApi: recordsApi().api,
      tokenStore: memoryStorage(),
      plannedAt: '2026-10-18T00:00:00.000Z',
    })
    assert.equal(response.status, 'ready')
    assert.equal(response.plmReadPhase.readConcurrency, readConcurrency === undefined ? 4 : readConcurrency, 'absent config => the default 4 runs')
    assert.equal(response.plmReadPhase.queriesIssued, source.calls.length)
    assert.equal(response.plmReadPhase.queriesNotConsumed, 0)
    assert.equal(response.plmReadPhase.queriesIssued, response.evidence.expansion.readCount, 'the field\'s "PLM reads" is the queries the PLM received')
    assert.equal('plmReadPhase' in response.evidence, false, 'the clock stanza is NOT evidence')
    assert.equal('readPhase' in response.evidence.expansion, false)
    assert.equal(JSON.stringify(response.plmReadPhase).includes(PROJECT), false, 'values-free')
    responses.push(response)
  }
  for (const response of responses.slice(1)) {
    assert.deepEqual(response.evidence, responses[0].evidence, 'evidence is identical at every concurrency')
    assert.equal(response.revision, responses[0].revision, 'and so is the revision the token promises')
    assert.deepEqual(dryRunWithoutClock(response), dryRunWithoutClock(responses[0]))
  }
  console.log('  dry-run: plmReadPhase beside evidence; evidence + revision identical at default/1/4/8')
}

// ── engine guards ───────────────────────────────────────────────────────────────────────────────

function engineOptions(extra = {}) {
  return { pageLimit: 1000, maxPages: 100, startedAtMs: 0, now: () => 0, ...extra }
}

async function testAClaimIsUsedOnlyForTheExactReadItWasIssuedFor() {
  const tables = { T: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }] }
  const source = instantSource(tables)
  const readStats = []
  const engine = createPlmReadAheadEngine({ adapter: source.adapter, concurrency: 4, options: engineOptions(), readStats })
  const guessed = engine.prefetch('T', { k: 'a' })
  // The walk hands back the entry for this position but is reading k=b: the guess must not answer.
  const rows = await engine.read('T', { k: 'b' }, guessed)
  assert.deepEqual(rows, [{ k: 'b', v: 2 }], 'a mismatched read-ahead is never used as the answer')
  const exact = engine.prefetch('T', { k: 'a' })
  assert.deepEqual(await engine.read('T', { k: 'a' }, exact), [{ k: 'a', v: 1 }])
  // A claimed entry is single-use.
  assert.deepEqual(await engine.read('T', { k: 'a' }, exact), [{ k: 'a', v: 1 }])
  await engine.close()
  assert.equal(readStats.length, 3, 'three walk reads were recorded')
  assert.equal(engine.report(0).queriesIssued, 4, 'the mismatched guess and the re-read each cost a query')
  assert.equal(engine.report(0).queriesNotConsumed, 1)

  // A mismatched guess that has NOT started yet is dropped on the spot — it is never issued, and
  // nothing can be left waiting on it.
  const slow = virtualSource({ T: [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }] })
  const queuedStats = []
  const narrow = createPlmReadAheadEngine({ adapter: slow.adapter, concurrency: 2, options: engineOptions(), readStats: queuedStats })
  narrow.prefetch('T', { k: 'a' })
  narrow.prefetch('T', { k: 'b' })
  const queuedGuess = narrow.prefetch('T', { k: 'c' })
  const work = (async () => {
    const rows = await narrow.read('T', { k: 'd' }, queuedGuess)
    await narrow.close()
    return rows
  })()
  assert.deepEqual(await slow.drive(work), [{ k: 'd' }])
  assert.deepEqual(await queuedGuess.outcome, { dropped: true }, 'the queued guess was dropped, not run')
  assert.equal(slow.calls.some((call) => call.filters.k === 'c'), false, 'k=c was never sent to the source')
  console.log('  engine: a read-ahead answers only the exact read it was issued for; a queued wrong guess is dropped')
}

// WHAT OUTLIVES AN EXPANSION, by case (fix round 1):
//   * a run with no global error returns with NOTHING in flight — every query it issued was consumed;
//   * a run the walk stopped early may return with read-aheads still in flight (it does not wait for
//     them; they finish and are discarded), but no NEW query reaches the source after it returned —
//     not even the next page of a multi-page read-ahead.
async function testNoReadOutlivesTheExpansion() {
  for (const fixture of [...FIXTURES, ...SQL_FIXTURES].filter((entry) => !entry.abort)) {
    for (const latency of [() => 1, seededLatency(31)]) {
      const source = virtualSource(tablesOf(fixture), fixture.source, latency)
      const result = await source.drive(expandPlmProjectBom(expansionInput(fixture, source.adapter, { readConcurrency: 8 })), { afterSettleRounds: 6 })
      assert.equal(source.pendingAtSettle, 0, `${fixture.name}: a clean run returns with nothing in flight`)
      assert.equal(source.calls.length, result.readPhase.queriesIssued, `${fixture.name}: and nothing after it`)
    }
  }
  const stoppedEarly = [
    ...FIXTURES.filter((entry) => entry.abort),
    { name: 'cycle in the first branch, one row per page', tables: cyclicFirst, input: { pageLimit: 1 }, abort: 'cycle_detected' },
  ]
  for (const fixture of stoppedEarly) {
    const source = virtualSource(fixture.tables(), fixture.source)
    const result = await source.drive(expandPlmProjectBom(expansionInput(fixture, source.adapter, { readConcurrency: 8 })), { afterSettleRounds: 12 })
    assert.equal(source.calls.length, result.readPhase.queriesIssued, `${fixture.name}: no adapter call after the expansion returned`)
  }
  assert.deepEqual(unhandled, [], 'no read-ahead ever surfaced as an unhandled rejection')
  console.log('  engine: a clean run returns with nothing in flight; a stopped run issues nothing after it returns')
}

function withinMs(promise, ms) {
  let timer
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// FIX ROUND 1. A read-ahead the source never answers must not hold a FAILED expansion open: the walk
// already knows the answer (here: a cycle under R.0), and waiting would keep the dry-run request open
// for the source's own per-read timeout — or forever, on a deployment with no request timeout.
async function testAFailedRunDoesNotWaitForItsReadAheads() {
  const hangs = (input) => input.object === 'DN_PDM_BomHeadInfo' && /^R\.[123]/.test(String(input.filters.part_id))
  const serialSource = instantSource(cyclicFirst(), { hangWhen: hangs })
  const serial = await expandPlmProjectBom({ sourceAdapter: serialSource.adapter, projectNo: PROJECT, readConcurrency: 1 })
  assert.ok(serial.errors.some((error) => error.type === 'cycle_detected'))
  assert.equal(serialSource.calls.some(hangs), false, 'the serial walk never reaches the hanging reads')

  const source = instantSource(cyclicFirst(), { hangWhen: hangs })
  const outcome = await withinMs(expandPlmProjectBom({ sourceAdapter: source.adapter, projectNo: PROJECT, readConcurrency: 4 }), 5000)
  assert.ok(!outcome.timedOut, 'x4: the failed run returned without waiting for its hanging read-ahead')
  assert.ok(source.calls.some(hangs), 'x4: a read-ahead really was hanging when the walk stopped')
  assert.equal(JSON.stringify(withoutReadPhase(outcome.value)), JSON.stringify(withoutReadPhase(serial)), 'x4: the same failure as the serial walk')

  // The same on the deterministic clock: the run returns with the hanging read still in flight.
  const virtual = virtualSource(cyclicFirst(), {}, (input) => (hangs(input) ? Infinity : 1))
  const result = await virtual.drive(expandPlmProjectBom({ sourceAdapter: virtual.adapter, projectNo: PROJECT, readConcurrency: 4 }))
  assert.equal(JSON.stringify(withoutReadPhase(result)), JSON.stringify(withoutReadPhase(serial)))
  assert.ok(virtual.pendingAtSettle > 0, 'it returned with the hanging read-ahead still in flight')
  assert.deepEqual(unhandled, [], 'and nothing surfaced as an unhandled rejection')
  console.log('  fix 1: a failed run returns at once, leaving a hung read-ahead behind (x1 and x4 the same failure)')
}

// FIX ROUND 1, at the engine: close() returns at once with reads hung in flight, and every read-ahead
// that never started settles `dropped` — never issued, and nothing can be left waiting on it.
async function testCloseSettlesEveryUnstartedReadAheadAndDoesNotWait() {
  const stuck = virtualSource({ T: [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }] }, {}, () => Infinity)
  const engine = createPlmReadAheadEngine({ adapter: stuck.adapter, concurrency: 2, options: engineOptions(), readStats: [] })
  const entries = ['a', 'b', 'c', 'd'].map((k) => engine.prefetch('T', { k }))
  const closed = await withinMs(engine.close(), 2000)
  assert.ok(!closed.timedOut, 'close() does not wait for reads in flight')
  const unstarted = await withinMs(Promise.all([entries[2].outcome, entries[3].outcome]), 2000)
  assert.deepEqual(unstarted.value, [{ dropped: true }, { dropped: true }], 'the two that never started settle dropped')
  assert.equal(stuck.calls.length, 2, 'only the two that started were ever issued')
  console.log('  fix 1: close() drops what never started and does not wait for what is in flight')
}

// FIX ROUND 2. A read answered with another read's rows fails the run with `read_row_mismatch` — at x1
// and x4 alike, the same failed dry-run, no token, nothing stored, and apply refuses before any write.
async function testAMisansweredReadFailsClosedAtEveryWidth() {
  const cases = [
    ['bomHead', misanswer('DN_PDM_BomHeadInfo', 'part_id', 'R.1', 'R.2'), 'DN_PDM_BomHeadInfo', 'part_id'],
    ['bomDetail', misanswer('DN_PDM_BomDetailsInfo', 'bom_pid', 'BOM-R.2', 'BOM-R.3'), 'DN_PDM_BomDetailsInfo', 'bom_pid'],
    ['part', misanswer('DN_PDM_PartLibraryInfo', 'OBJ_ID', 'R.1.2', 'R.1.3'), 'DN_PDM_PartLibraryInfo', 'OBJ_ID'],
  ]
  for (const [label, behaviour, object, field] of cases) {
    const responses = []
    for (const readConcurrency of [1, 4]) {
      const expansion = await expandPlmProjectBom({ sourceAdapter: instantSource(wideTree(), behaviour).adapter, projectNo: PROJECT, readConcurrency })
      assert.deepEqual(expansion.errors, [{ type: 'read_row_mismatch', object, field, page: 0 }], `${label} @${readConcurrency}: one values-free global error naming the read plan's column`)
      assert.equal(expansion.status, 'failed')

      const storage = memoryStorage()
      const records = recordsApi()
      const action = baseAction({ readConcurrency })
      const dryRun = await dryRunStockPreparationAction({
        action,
        parameters: { projectNo: PROJECT },
        sourceAdapter: instantSource(wideTree(), behaviour).adapter,
        recordsApi: records.api,
        tokenStore: storage,
        plannedAt: '2026-10-18T00:00:00.000Z',
      })
      assert.equal(dryRun.status, 'failed', `${label} @${readConcurrency}`)
      assert.equal(dryRun.canApply, false)
      assert.equal(dryRun.dryRunToken, null)
      assert.equal(storage.map.size, 0)
      assert.deepEqual(dryRun.evidence.expansion.errorTypes, ['read_row_mismatch'])
      assert.equal(JSON.stringify(dryRun.evidence).includes('R.1'), false, 'values-free')
      responses.push(dryRunWithoutClock(dryRun))

      const cleanStorage = memoryStorage()
      const cleanRecords = recordsApi()
      const clean = await dryRunStockPreparationAction({
        action,
        parameters: { projectNo: PROJECT },
        sourceAdapter: instantSource(wideTree()).adapter,
        recordsApi: cleanRecords.api,
        tokenStore: cleanStorage,
        plannedAt: '2026-10-18T00:00:00.000Z',
      })
      await assert.rejects(
        () => applyStockPreparationAction({
          sandboxPolicy: { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] },
          action,
          parameters: { projectNo: PROJECT },
          dryRunToken: clean.dryRunToken,
          sourceAdapter: instantSource(wideTree(), behaviour).adapter,
          recordsApi: cleanRecords.api,
          tokenStore: cleanStorage,
          permission: 'write',
          plannedAt: '2026-10-18T00:00:00.000Z',
        }),
        (error) => error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH',
      )
      assert.deepEqual(cleanRecords.calls.filter((call) => call[0] !== 'queryRecords'), [], `${label} @${readConcurrency}: apply wrote nothing`)
    }
    assert.deepEqual(responses[1], responses[0], `${label}: the same failed dry-run at x1 and x4`)
  }
  console.log('  fix 2: a misanswered head / detail / part read fails as read_row_mismatch at x1 and x4; apply writes nothing')
}

// FIX ROUND 2, the judge's probe: a transport that hands two CONCURRENT part reads each other's answer.
// Before the fix that was one row, four `missing_component` holds, `manual_confirm_required` and a
// token. Serially there is never a second read in flight to swap with.
async function testATransportCrossWireFailsClosed() {
  for (const readConcurrency of [1, 4]) {
    const source = virtualSource(wideTree(), { crossWirePartReads: true })
    const dryRun = await source.drive(dryRunStockPreparationAction({
      action: baseAction({ readConcurrency }),
      parameters: { projectNo: PROJECT },
      sourceAdapter: source.adapter,
      recordsApi: recordsApi().api,
      tokenStore: memoryStorage(),
      plannedAt: '2026-10-18T00:00:00.000Z',
    }))
    if (readConcurrency === 1) {
      assert.equal(source.swaps, 0, 'x1: never two reads in flight, nothing to swap')
      assert.equal(dryRun.status, 'ready')
    } else {
      assert.equal(source.swaps, 1, 'x4: the transport really swapped two answers')
      assert.equal(dryRun.status, 'failed')
      assert.equal(dryRun.canApply, false)
      assert.equal(dryRun.dryRunToken, null, 'no token is minted off a cross-wired read')
      assert.deepEqual(dryRun.evidence.expansion.errorTypes, ['read_row_mismatch'])
    }
  }
  console.log('  fix 2: a transport cross-wire between two concurrent part reads fails closed (no token)')
}

// FIX ROUND 2, the two answers that are NOT mismatches.
async function testDeclaredUnfilteredAndCaseInsensitiveSourcesAreNotMismatches() {
  for (const readConcurrency of [1, 4]) {
    const honest = await expandPlmProjectBom({ sourceAdapter: instantSource(wideTree()).adapter, projectNo: PROJECT, readConcurrency })
    // The bridge may legally answer with the whole table if it SAYS so; the walk re-filters part reads.
    const whole = await expandPlmProjectBom({
      sourceAdapter: instantSource(wideTree(), { unfilteredObjects: ['DN_PDM_PartLibraryInfo'] }).adapter,
      projectNo: PROJECT,
      readConcurrency,
    })
    assert.deepEqual(whole.errors, [], `@${readConcurrency}: a declared whole-table answer is not a mismatch`)
    assert.deepEqual(whole.rows, honest.rows)
    // A case-insensitive source: the BOM head stores the part id in another case and still matches.
    const tables = wideTree()
    tables.DN_PDM_BomHeadInfo = tables.DN_PDM_BomHeadInfo.map((head) => ({ ...head, part_id: head.part_id.toLowerCase() }))
    const folded = await expandPlmProjectBom({
      sourceAdapter: instantSource(tables, { caseInsensitiveObjects: ['DN_PDM_BomHeadInfo'] }).adapter,
      projectNo: PROJECT,
      readConcurrency,
    })
    assert.deepEqual(folded.errors, [], `@${readConcurrency}: a collation's case folding is not a mismatch`)
    assert.deepEqual(folded.rows, honest.rows)
  }
  console.log('  fix 2: a declared whole-table answer and a case-insensitive source are not mismatches')
}

// THE WASTE BOUND. Whatever stops a walk early, the read-ahead has issued at most
// READ_AHEAD_LEAD_PER_SLOT x readConcurrency queries the walk did not consume. The shape that makes the
// bound bind: the walk stalls on one slow read (here a BOM head that takes 80 round-trips and then
// fails) while every other slot keeps reading ahead — without the cap the read-ahead would read most of
// the tree for a walk that is about to stop.
async function testAnEarlyStopWastesAtMostTheLeadCap() {
  assert.equal(READ_AHEAD_LEAD_PER_SLOT, 16, 'the measured lead cap (see the constant\'s comment)')
  const tables = emptyTables()
  addRoot(tables, 'R')
  addTree(tables, 'R', { branching: 6, depth: 3 })
  const stalled = (input) => input.object === 'DN_PDM_BomHeadInfo' && input.filters.part_id === 'R.0.0'
  for (const readConcurrency of [2, 4, 8]) {
    const source = virtualSource(tables, failing(stalled, 'SYN_PLM_TIMEOUT'), (input) => (stalled(input) ? 80 : 1))
    const result = await source.drive(expandPlmProjectBom({ sourceAdapter: source.adapter, projectNo: PROJECT, readConcurrency }))
    assert.ok(result.errors.some((error) => error.type === 'read_failed'))
    const cap = READ_AHEAD_LEAD_PER_SLOT * readConcurrency
    assert.ok(
      result.readPhase.queriesNotConsumed <= cap,
      `@${readConcurrency}: ${result.readPhase.queriesNotConsumed} queries wasted, cap ${cap}`,
    )
    assert.ok(result.readPhase.queriesNotConsumed > 0, 'the stalled walk really did let the read-ahead run ahead')
  }
  // The run's read budget: a walk refused at maxReadCount issued at most the cap on top of it.
  const budgeted = virtualSource(tables, {}, seededLatency(5))
  const refused = await budgeted.drive(expandPlmProjectBom({ sourceAdapter: budgeted.adapter, projectNo: PROJECT, readConcurrency: 4, maxReadCount: 120 }))
  assert.ok(refused.errors.some((error) => error.type === 'read_count_exceeded'))
  assert.equal(refused.summary.readCount, 120)
  assert.ok(refused.readPhase.queriesIssued <= 120 + READ_AHEAD_LEAD_PER_SLOT * 4, `${refused.readPhase.queriesIssued} queries against a budget of 120`)
  console.log('  engine: an early stop wastes at most READ_AHEAD_LEAD_PER_SLOT x readConcurrency queries')
}

// FIX ROUND 2 — the comparison follows SQL Server's `=` where it would have matched, and nowhere else.
async function testTheCompareRuleFollowsSqlServerEquality() {
  const cases = [
    ['0010', 10, true], [10, '0010', true], ['10.0', 10, true], [' 10 ', '10', true], ['+7', 7, true], ['-0', 0, true],
    ['abc', 'ABC', true], ['BOM-1 ', 'bom-1', true],
    ['12345678901234567890', '12345678901234567891', false], ['10', 11, false], ['0010', '0011', false],
    ['1e1', 10, false], ['１０', '10', false], ['ＡＢＣ', 'ABC', false], ['é', 'e', false], [null, 'x', false], ['', '', false],
  ]
  for (const [left, right, expected] of cases) {
    assert.equal(sameFilterValue(left, right), expected, `sameFilterValue(${JSON.stringify(left)}, ${JSON.stringify(right)})`)
  }
  // End to end: int ids referenced as zero-padded char — every head and detail read is answered by
  // implicit conversion. Not a mismatch, at x1 and x4, and the same rows as the plain-id tree.
  for (const readConcurrency of [1, 4]) {
    const plain = await expandPlmProjectBom({ sourceAdapter: instantSource(numericTree({ padded: false }), { convertNumbers: true }).adapter, projectNo: PROJECT, readConcurrency })
    const padded = await expandPlmProjectBom({ sourceAdapter: instantSource(numericTree({ padded: true }), { convertNumbers: true }).adapter, projectNo: PROJECT, readConcurrency })
    assert.deepEqual(plain.errors, [])
    assert.deepEqual(padded.errors, [], `@${readConcurrency}: int 10 = char '0010' is not a mismatch`)
    assert.equal(padded.rows.length, 13)
    assert.deepEqual(padded.rows, plain.rows)
    // A genuinely different id still fails: part 11's heads answered with its sibling 15's (both are
    // assemblies; ids are numbered depth-first, so 12-14 are 11's own leaves).
    const crossed = await expandPlmProjectBom({
      sourceAdapter: instantSource(numericTree({ padded: true }), { convertNumbers: true, ...misanswer('DN_PDM_BomHeadInfo', 'part_id', '11', '15') }).adapter,
      projectNo: PROJECT,
      readConcurrency,
    })
    assert.deepEqual(crossed.errors.map((error) => [error.type, error.field]), [['read_row_mismatch', 'part_id']], `@${readConcurrency}: '000015' is not '11'`)
  }
  console.log('  fix 2b: trimmed, case-insensitive, numeric-aware compare (int 10 = char \'0010\'); no width / Unicode folding')
}

// FIX ROUND 2 — a DECLARED whole-table answer is filtered locally for every read kind: it stays legal,
// and a cross-wired answer from such a source yields what filtering yields, never a silent expansion.
async function testADeclaredUnfilteredAnswerIsFilteredLocally() {
  const unfilteredReads = ['DN_PDM_BomHeadInfo', 'DN_PDM_BomDetailsInfo', 'DN_PDM_PartLibraryInfo']
  for (const readConcurrency of [1, 4]) {
    const honest = await expandPlmProjectBom({ sourceAdapter: instantSource(wideTree()).adapter, projectNo: PROJECT, readConcurrency })
    const whole = await expandPlmProjectBom({ sourceAdapter: instantSource(wideTree(), { unfilteredObjects: unfilteredReads }).adapter, projectNo: PROJECT, readConcurrency })
    assert.deepEqual(whole.errors, [], `@${readConcurrency}: whole-table head / detail / part answers are legal`)
    assert.deepEqual(whole.rows, honest.rows, `@${readConcurrency}: and expand exactly like the honest source`)
    assert.deepEqual(whole.rowErrors, honest.rowErrors)

    // BOM-R.2's detail read answered with BOM-R.3's rows by a source that declares it did not filter:
    // nothing survives the local filter, so R.2 has an active head and no details — exactly what a
    // filtering source with no rows for BOM-R.2 yields (`missing_child_bom`, which blocks apply).
    const crossed = await expandPlmProjectBom({
      sourceAdapter: instantSource(wideTree(), {
        declareUnfilteredObjects: ['DN_PDM_BomDetailsInfo'],
        ...misanswer('DN_PDM_BomDetailsInfo', 'bom_pid', 'BOM-R.2', 'BOM-R.3'),
      }).adapter,
      projectNo: PROJECT,
      readConcurrency,
    })
    const withoutR2Details = wideTree()
    withoutR2Details.DN_PDM_BomDetailsInfo = withoutR2Details.DN_PDM_BomDetailsInfo.filter((detail) => detail.bom_pid !== 'BOM-R.2')
    const filtered = await expandPlmProjectBom({ sourceAdapter: instantSource(withoutR2Details).adapter, projectNo: PROJECT, readConcurrency })
    assert.deepEqual(crossed.rows, filtered.rows, `@${readConcurrency}: the cross-wired answer yields what filtering yields`)
    assert.deepEqual(crossed.rowErrors, filtered.rowErrors)
    assert.deepEqual(crossed.errors, filtered.errors)
    assert.ok(crossed.rowErrors.some((error) => error.type === 'missing_child_bom'), 'and it is held (missing_child_bom), not expanded')
    assert.equal(crossed.rows.some((row) => row.parentSourceId === 'R.2' && row.componentSourceId.startsWith('R.3')), false, 'no R.3 part under R.2')
  }
  console.log('  fix 2c: declared whole-table answers are filtered locally; a cross-wired one yields what filtering yields')
}

async function main() {
  await testTheKnobIsClamped()
  await testByteIdenticalAtEveryConcurrencyAndSchedule()
  await testConcurrencyFourHalvesTheWallTime()
  await testNoMoreThanConcurrencyReadsInFlight()
  await testAFailingSiblingReadAbortsTheSameWayAndWritesNothing()
  await testDryRunCarriesThePhaseStanzaBesideAnUnchangedEvidence()
  await testAClaimIsUsedOnlyForTheExactReadItWasIssuedFor()
  await testAnEarlyStopWastesAtMostTheLeadCap()
  await testNoReadOutlivesTheExpansion()
  await testAFailedRunDoesNotWaitForItsReadAheads()
  await testCloseSettlesEveryUnstartedReadAheadAndDoesNotWait()
  await testAMisansweredReadFailsClosedAtEveryWidth()
  await testATransportCrossWireFailsClosed()
  await testDeclaredUnfilteredAndCaseInsensitiveSourcesAreNotMismatches()
  await testTheCompareRuleFollowsSqlServerEquality()
  await testADeclaredUnfilteredAnswerIsFilteredLocally()
  console.log('stock-preparation-bom-read-concurrency.test.cjs OK')
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-bom-read-concurrency.test.cjs', main)
