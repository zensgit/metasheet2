'use strict'

/**
 * Plan-coverage guard for the synthetic PLM BOM SQL fixture
 * (`fixtures/stock-preparation-synthetic-sql-source/`).
 *
 * WHY THIS EXISTS
 *   The fixture's whole value is that it is the SAME shape the read plan reads. Nothing else
 *   enforces that: the SQL is inert text, and the only thing that would notice a drift is a
 *   customer-site run against a real Postgres — i.e. the exact feedback loop the fixture exists to
 *   remove. So this suite parses the DDL and asserts, field by field, that every object and every
 *   column the normalized read plan touches is actually declared — and, in the other direction,
 *   that the DDL declares nothing the plan never reads.
 *
 *   It then goes further, because coverage alone would still allow a fixture whose DATA proves
 *   nothing: it replays both seed files through the REAL expander and the REAL conflict planner and
 *   pins the decision counts. If someone edits a quantity or removes a BOM line, the claims the
 *   README makes about this fixture fail here rather than at a customer site.
 *
 * NO DATABASE IS INVOLVED. The seeds are interpreted in memory. The in-memory source models the
 * two Postgres behaviours that actually matter for this path:
 *   - identifier folding: the host adapter interpolates identifiers UNQUOTED
 *     (packages/core-backend/src/data-adapters/PostgresAdapter.ts:173 with
 *     BaseAdapter.ts:265-281, which validates but does not quote), so every table and column name
 *     is folded to lower case on both sides;
 *   - `numeric` columns come back from node-postgres as STRINGS, so `Number(...)` in
 *     lib/stock-preparation-bom-expansion.cjs:369-383 is genuinely exercised.
 * What it does NOT model — and what therefore stays unverified until someone runs it — is listed in
 * the fixture README under "what a live run still has to prove".
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  expandPlmProjectBom,
  normalizeStockPreparationBomReadPlan,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-bom-expansion.cjs'))
const {
  planStockPreparationConflicts,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'stock-preparation-synthetic-sql-source')
const SCHEMA_FILE = '01-schema.sql'
const PULL_1_FILE = '02-seed-pull-1.sql'
const PULL_2_FILE = '03-seed-pull-2.sql'
const DUPLICATE_FILE = '04-optional-duplicate-expanded-key.sql'
const SUBTREE_FILE = '05-seed-subtree-roots.sql'
const README_FILE = 'README.md'
const PROJECT_NO = 'SYN-PROJ-0001'

/**
 * The OPTIONAL `readPlan.projectSubtree` block, as a deployment would configure it.
 *
 * It exists in this suite for ONE structural reason: the coverage guard below asks the plan which
 * columns the fixture is allowed to declare, and the shipped default plan deliberately does NOT
 * carry this block (that is what makes "subtree off" structural rather than a habit). Without an
 * ENABLED plan to ask, `dn_pdm_pathinfo.parent_obj_id` and `dn_pdm_bomheadinfo.path_id` could only
 * be admitted through `SCHEMA_COLUMNS_NOT_READ_BY_PLAN` — i.e. the guard would issue those two
 * columns a permanent certificate saying the plan never reads them, which is the opposite of true.
 * So the guard asks BOTH plans, and the reverse assertion keeps its full force: a column no plan
 * reads is still a failure.
 *
 * `maxReadCount` is not decoration — the normalizer REFUSES an enabling plan without one.
 */
const SUBTREE_READ_PLAN = Object.freeze({
  ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  maxReadCount: 500,
  projectSubtree: {
    pathInfo: { parentIdField: 'Parent_OBJ_ID' },
    bomHead: { pathIdField: 'path_id' },
  },
})

/**
 * `{ 'table.column': reason }`. Empty on purpose: the fixture declares exactly the plan's read
 * surface and nothing else. Adding a column the plan never reads is allowed, but only as an
 * explicit, reviewable entry here — otherwise the DDL can quietly grow a shape the pull cannot use
 * and the fixture stops being a faithful stand-in for the plan.
 */
const SCHEMA_COLUMNS_NOT_READ_BY_PLAN = Object.freeze({})

// ── SQL reading ──────────────────────────────────────────────────────────────
// A deliberately small reader. It understands only the four statement forms the fixture uses
// (CREATE TABLE / INSERT INTO … VALUES / DELETE FROM / and the ignorable DROP + CREATE INDEX), and
// it is quote-aware so a `--` or `;` inside a literal cannot corrupt the parse.

// Line endings are normalized on read: these fixture files carry no `text eol=lf` attribute, so a
// `core.autocrlf=true` checkout (the Windows default here) hands them back with CRLF. Normalizing
// keeps the parse — and the README substring checks — identical on every platform.
function readFixture(file) {
  return fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8').replace(/\r\n/g, '\n')
}

function stripComments(sql) {
  let out = ''
  let inString = false
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (inString) {
      out += char
      if (char === "'") {
        if (sql[i + 1] === "'") {
          i += 1
          out += "'"
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

function splitStatements(sql) {
  const statements = []
  let current = ''
  let inString = false
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (inString) {
      current += char
      if (char === "'") {
        if (sql[i + 1] === "'") {
          i += 1
          current += "'"
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
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

/** Split on commas that sit at paren depth 0 and outside string literals. */
function splitTopLevel(text) {
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
          i += 1
          current += "'"
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
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** The parenthesised groups of a `VALUES (…), (…)` tail, in order. */
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
          i += 1
          current += "'"
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
        current = ''
        continue
      }
    }
    if (depth > 0) current += char
  }
  assert.equal(depth, 0, 'unbalanced parentheses in a VALUES clause')
  return tuples
}

const CONSTRAINT_PREFIXES = ['primary', 'unique', 'check', 'constraint', 'foreign', 'exclude']

/**
 * Parse the DDL into `{ table(lower) => { column(lower) => typeDescriptor } }`.
 * Postgres folds unquoted identifiers to lower case, so the parse folds too.
 */
function parseSchema(sql) {
  const tables = new Map()
  for (const statement of splitStatements(stripComments(sql))) {
    const match = /^CREATE\s+TABLE\s+([A-Za-z0-9_.]+)\s*\(/i.exec(statement)
    if (!match) continue
    const open = statement.indexOf('(')
    const close = statement.lastIndexOf(')')
    assert.ok(close > open, `CREATE TABLE ${match[1]} has no closing parenthesis`)
    const columns = new Map()
    for (const definition of splitTopLevel(statement.slice(open + 1, close))) {
      const head = definition.trim().split(/\s+/)[0].toLowerCase()
      if (CONSTRAINT_PREFIXES.includes(head)) continue
      const rest = definition.trim().slice(head.length).trim()
      columns.set(head, parseColumnType(rest))
    }
    tables.set(match[1].toLowerCase(), columns)
  }
  return tables
}

/** Enough of the type to model what node-postgres hands back for that column. */
function parseColumnType(text) {
  const lowered = text.toLowerCase()
  if (/^(numeric|decimal)/.test(lowered)) {
    const scale = /^(?:numeric|decimal)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(lowered)
    // node-postgres returns `numeric` as a STRING at the declared scale, not as a JS number.
    return { kind: 'numeric', scale: scale ? Number(scale[1]) : 0 }
  }
  if (/^(smallint|integer|int|bigint)/.test(lowered)) return { kind: 'integer' }
  if (/^(varchar|character varying|text|char)/.test(lowered)) return { kind: 'string' }
  throw new Error(`unsupported fixture column type: ${text}`)
}

function parseLiteral(raw, type) {
  const text = raw.trim()
  if (/^null$/i.test(text)) return null
  if (text.startsWith("'")) {
    assert.ok(text.endsWith("'"), `unterminated string literal: ${text}`)
    const value = text.slice(1, -1).replace(/''/g, "'")
    assert.equal(type.kind, 'string', `string literal assigned to a ${type.kind} column: ${text}`)
    return value
  }
  const numeric = Number(text)
  assert.ok(Number.isFinite(numeric), `unsupported literal: ${text}`)
  if (type.kind === 'numeric') return numeric.toFixed(type.scale)
  assert.equal(type.kind, 'integer', `numeric literal assigned to a ${type.kind} column: ${text}`)
  return numeric
}

/** Apply a seed file's DELETE / INSERT statements onto an in-memory table state. */
function applySeed(state, schema, sql, label) {
  for (const statement of splitStatements(stripComments(sql))) {
    const deleteMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_.]+)\s*$/i.exec(statement)
    if (deleteMatch) {
      const table = deleteMatch[1].toLowerCase()
      assert.ok(schema.has(table), `${label}: DELETE FROM unknown table ${deleteMatch[1]}`)
      state.set(table, [])
      continue
    }
    const insertMatch = /^INSERT\s+INTO\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]+)$/i.exec(statement)
    assert.ok(insertMatch, `${label}: unsupported statement in a seed file: ${statement.slice(0, 60)}…`)
    const table = insertMatch[1].toLowerCase()
    const columns = schema.get(table)
    assert.ok(columns, `${label}: INSERT INTO unknown table ${insertMatch[1]}`)
    const names = insertMatch[2].split(',').map((name) => name.trim().toLowerCase())
    for (const name of names) {
      assert.ok(columns.has(name), `${label}: INSERT names column ${name} which ${insertMatch[1]} does not declare`)
    }
    const rows = state.get(table) || []
    for (const tuple of valueTuples(insertMatch[3])) {
      const values = splitTopLevel(tuple)
      assert.equal(values.length, names.length, `${label}: value count does not match column count in ${insertMatch[1]}`)
      const row = {}
      names.forEach((name, index) => {
        row[name] = parseLiteral(values[index], columns.get(name))
      })
      rows.push(row)
    }
    state.set(table, rows)
  }
  return state
}

function emptyState(schema) {
  const state = new Map()
  for (const table of schema.keys()) state.set(table, [])
  return state
}

// ── in-memory source adapter (models the host facade + PostgresAdapter) ──────

function createAdapter(state) {
  const calls = []
  return {
    calls,
    async read(input = {}) {
      calls.push({ object: input.object, filters: { ...input.filters } })
      assert.ok(input.object, 'read requires an object')
      assert.ok(
        input.filters && Object.keys(input.filters).length > 0,
        `read(${input.object}) must carry equality filters`,
      )
      // `sanitizeIdentifier` + unquoted interpolation => Postgres folds both sides.
      const table = String(input.object).toLowerCase()
      const rows = state.get(table)
      assert.ok(rows, `read(${input.object}) hit a table the fixture does not declare`)
      const matches = rows.filter((row) =>
        Object.entries(input.filters).every(([field, expected]) => row[field.toLowerCase()] === expected),
      )
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map((row) => ({ ...row }))
      const consumed = offset + records.length
      return {
        records,
        nextCursor: consumed < matches.length ? String(consumed) : null,
        done: consumed >= matches.length,
        metadata: {
          source: 'data-source:sql-readonly',
          filtersApplied: true,
          filterFields: Object.keys(input.filters).sort(),
        },
      }
    },
  }
}

// ── assertions ───────────────────────────────────────────────────────────────

/** Deliverable 1: the DDL covers every object/field the read plan requires. */
function testSchemaCoversReadPlan(schema, schemaSql) {
  const plan = normalizeStockPreparationBomReadPlan(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  const sections = ['pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'part', 'bomHead', 'bomDetail']

  // Non-vacuity: if the parser silently returned nothing, every check below would pass for free.
  assert.equal(schema.size, sections.length, `expected ${sections.length} fixture tables, parsed ${schema.size}`)

  const required = new Map()
  const noteRequirement = (object, field) => {
    const table = String(object).toLowerCase()
    const key = `${table}.${String(field).toLowerCase()}`
    required.set(key, true)
  }

  for (const section of sections) {
    const descriptor = plan[section]
    assert.ok(descriptor && descriptor.object, `read plan section ${section} must name an object`)
    const table = descriptor.object.toLowerCase()
    const columns = schema.get(table)
    assert.ok(columns, `fixture DDL is missing the read plan object ${descriptor.object} (${section})`)
    for (const [key, value] of Object.entries(descriptor)) {
      if (key === 'object') continue
      assert.ok(
        columns.has(String(value).toLowerCase()),
        `fixture DDL table ${descriptor.object} is missing ${section}.${key} = ${value}`,
      )
      noteRequirement(descriptor.object, value)
    }
  }

  // THE OPTIONAL BLOCK'S COLUMNS, taken from an ENABLED plan rather than from an exception list.
  //
  // `projectSubtree` does not name objects of its own: it reads the folder-node columns of the
  // pathInfo and bomHead tables the plan already names. So the requirement is recorded against
  // those objects, and the two columns become "read by a plan" in the same sense as every other
  // column here — which is what lets the reverse assertion below stay `deepEqual(unused, [])`.
  const subtreePlan = normalizeStockPreparationBomReadPlan(SUBTREE_READ_PLAN)
  assert.ok(subtreePlan.projectSubtree, 'the subtree-enabled plan must actually carry the block')
  const subtreeRequirements = [
    ['pathInfo', plan.pathInfo.object, subtreePlan.projectSubtree.pathInfo.parentIdField],
    ['bomHead', plan.bomHead.object, subtreePlan.projectSubtree.bomHead.pathIdField],
  ]
  for (const [section, object, column] of subtreeRequirements) {
    const columns = schema.get(String(object).toLowerCase())
    assert.ok(
      columns && columns.has(String(column).toLowerCase()),
      `fixture DDL table ${object} is missing projectSubtree.${section} column ${column}`,
    )
    noteRequirement(object, column)
  }

  // DEFAULT-OFF, PINNED. Without this the "subtree is off unless configured" property is a fact
  // about today's constant rather than a guarantee, and the byte-identical-when-disabled claim in
  // stock-preparation-project-subtree-bridge.test.cjs rests on it.
  assert.equal(
    plan.projectSubtree,
    undefined,
    'the SHIPPED read plan must not carry projectSubtree — "off" has to be structural, not a habit',
  )

  // The top-level matchField is applied to pathExAttr and is pinned equal to it by the normalizer
  // (lib/stock-preparation-bom-expansion.cjs:229-233); assert the column exists under its own name
  // so a fixture cannot pass by covering only the nested spelling.
  assert.ok(
    schema.get(plan.pathExAttr.object.toLowerCase()).has(plan.matchField.toLowerCase()),
    `fixture DDL is missing the top-level readPlan.matchField ${plan.matchField}`,
  )

  // Other direction: nothing in the DDL that the plan never reads.
  const unused = []
  for (const [table, columns] of schema.entries()) {
    for (const column of columns.keys()) {
      const key = `${table}.${column}`
      if (!required.has(key) && !(key in SCHEMA_COLUMNS_NOT_READ_BY_PLAN)) unused.push(key)
    }
  }
  assert.deepEqual(
    unused,
    [],
    'the fixture DDL declares columns the read plan never reads (add them to ' +
      `SCHEMA_COLUMNS_NOT_READ_BY_PLAN with a reason if that is deliberate): ${unused.join(', ')}`,
  )
  for (const [key, reason] of Object.entries(SCHEMA_COLUMNS_NOT_READ_BY_PLAN)) {
    assert.ok(
      typeof reason === 'string' && reason.trim(),
      `SCHEMA_COLUMNS_NOT_READ_BY_PLAN[${key}] must carry a non-empty reason`,
    )
    assert.ok(!required.has(key), `SCHEMA_COLUMNS_NOT_READ_BY_PLAN[${key}] is stale — the plan DOES read it`)
  }

  // Quoting would defeat the fold the whole fixture depends on: a quoted "OBJ_ID" is a genuinely
  // mixed-case column, and the adapter's unquoted `obj_id` would no longer resolve to it.
  assert.ok(
    !stripComments(schemaSql).includes('"'),
    'the fixture DDL must not quote identifiers — the host Postgres adapter emits them unquoted, ' +
      'so a quoted mixed-case name becomes unreadable (PostgresAdapter.ts:173, BaseAdapter.ts:265-281)',
  )

  // Negative control on the coverage check itself: remove one required column and it must fail.
  const victimTable = plan.part.object.toLowerCase()
  const victimColumn = plan.part.idField.toLowerCase()
  const mutated = new Map(schema)
  const mutatedColumns = new Map(schema.get(victimTable))
  mutatedColumns.delete(victimColumn)
  mutated.set(victimTable, mutatedColumns)
  assert.throws(
    () => {
      for (const section of sections) {
        const descriptor = plan[section]
        const columns = mutated.get(descriptor.object.toLowerCase())
        for (const [key, value] of Object.entries(descriptor)) {
          if (key === 'object') continue
          assert.ok(columns.has(String(value).toLowerCase()), `missing ${section}.${key}`)
        }
      }
    },
    /missing part\.idField/,
    'the coverage check must fail when a required plan column is absent',
  )

  console.log(`  schema covers the read plan: ${schema.size} objects, ${required.size} columns`)
}

/** Deliverable 5 (other half): the seeds only ever touch declared columns — enforced by applySeed. */
async function expandFrom(schema, files, readPlan) {
  const state = emptyState(schema)
  for (const file of files) applySeed(state, schema, readFixture(file), file)
  const adapter = createAdapter(state)
  const result = await expandPlmProjectBom({
    sourceAdapter: adapter,
    projectNo: PROJECT_NO,
    // Small on purpose: forces the pagination loop in readAll (…-bom-expansion.cjs:305-351) to run
    // more than one page per object, so the cursor contract is exercised, not just assumed.
    pageLimit: 2,
    ...(readPlan ? { readPlan } : {}),
  })
  return { result, adapter, state }
}

function rowByPath(rows, tokens) {
  const wanted = JSON.stringify(tokens)
  const matches = rows.filter((row) => row.path === wanted)
  assert.equal(matches.length, 1, `expected exactly one row at path ${wanted}, saw ${matches.length}`)
  return matches[0]
}

async function testPullOne(schema) {
  const { result } = await expandFrom(schema, [PULL_1_FILE])
  assert.deepEqual(result.errors, [], 'pull #1 must produce no global errors')
  assert.deepEqual(result.rowErrors, [], 'pull #1 must produce no row errors')
  assert.equal(result.status, 'expanded')
  assert.equal(result.valid, true)
  assert.equal(result.rows.length, 7, 'pull #1 expands to 7 rows')

  // Multi-level assembly: depth is non-trivial and path is the full ancestry.
  assert.deepEqual(
    result.rows.map((row) => row.depth),
    [0, 1, 2, 2, 1, 2, 2],
    'pull #1 must reach depth 2 through a sub-assembly',
  )

  // Quantity roll-up across levels: 2 (root) x 3 (sub) x 4 (leaf) = 24.
  const root = rowByPath(result.rows, ['SYN-PART-ROOT-A'])
  assert.equal(root.rawQuantity, 2)
  assert.equal(root.totalQuantity, 2)
  assert.equal(root.parentSourceId, null)
  const subB = rowByPath(result.rows, ['SYN-PART-ROOT-A', 'SYN-PART-SUB-B'])
  assert.equal(subB.rawQuantity, 3)
  assert.equal(subB.totalQuantity, 6)
  const leafDunderB = rowByPath(result.rows, ['SYN-PART-ROOT-A', 'SYN-PART-SUB-B', 'SYN-PART-LEAF-D'])
  assert.equal(leafDunderB.rawQuantity, 4)
  assert.equal(leafDunderB.totalQuantity, 24)

  // Case-insensitive column read: the source rows only carry lower-case keys (Postgres folding),
  // yet the identity columns still land on the row.
  assert.equal(root.componentCode, 'SYN-A-1000')
  assert.equal(root.componentName, 'Synthetic Root Assembly A')
  assert.equal(root.material, 'SYN-MAT-STEEL')
  assert.equal(root.sourceVersion, 'V1')

  // Same component under TWO parents: two rows, two DISTINCT keys — this is NOT the duplicate case.
  const leafDunderC = rowByPath(result.rows, ['SYN-PART-ROOT-A', 'SYN-PART-SUB-C', 'SYN-PART-LEAF-D'])
  assert.equal(leafDunderC.componentSourceId, leafDunderB.componentSourceId)
  assert.notEqual(leafDunderC.parentSourceId, leafDunderB.parentSourceId)
  assert.notEqual(leafDunderC.idempotencyKey, leafDunderB.idempotencyKey)
  assert.equal(leafDunderC.totalQuantity, 4)

  // Retired BOM head (bom_able = '0') is filtered out, so its component never appears.
  assert.equal(
    result.rows.some((row) => row.componentSourceId === 'SYN-PART-LEAF-G'),
    false,
    'a component reachable only through an inactive BOM head must not expand',
  )

  // The `active` flag every expanded row carries is what makes the pull-2 inactive case meaningful.
  assert.equal(result.rows.every((row) => row.active === true), true)

  console.log(`  pull #1: ${result.rows.length} rows, depths 0-2, roll-up 2 -> 6 -> 24`)
  return result
}

function planAgainst(expandedRows, existingRows) {
  return planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows,
    existingRows,
    runId: 'syn-run-1',
    plannedAt: '2026-01-01T00:00:00.000Z',
  })
}

/** Materialize the target rows an apply of pull #1 would have written, plus human-entered cells. */
function targetRowsAfter(plan) {
  const humanCells = {
    materialType: 'SYN-TYPE-1',
    blankType: 'SYN-BLANK-1',
    stockPreparationStatus: 'SYN-STATUS-1',
    demandDate: '2026-02-02',
    leadTimeDays: 7,
    notes: 'synthetic human note',
    procurementReply: 'synthetic reply',
    warehouseConfirmation: 'synthetic confirmation',
  }
  return plan.decisions
    .filter((decision) => decision.decision === 'add')
    .map((decision) => ({ ...decision.record, ...humanCells }))
}

async function testPullTwo(schema, pullOne) {
  const firstPlan = planAgainst(pullOne.rows, [])
  assert.equal(firstPlan.valid, true, 'pull #1 against an empty sheet must be applyable')
  assert.deepEqual(firstPlan.counts, { add: 7, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })

  const existingRows = targetRowsAfter(firstPlan)
  assert.equal(existingRows.length, 7)

  const { result } = await expandFrom(schema, [PULL_2_FILE])
  assert.deepEqual(result.errors, [], 'pull #2 must produce no global errors')
  assert.deepEqual(result.rowErrors, [], 'pull #2 must produce no row errors')
  assert.equal(result.rows.length, 6, 'pull #2 loses the removed leaf line')

  const secondPlan = planAgainst(result.rows, existingRows)
  assert.equal(secondPlan.valid, true, 'the pull #2 refresh must plan cleanly')
  assert.deepEqual(
    secondPlan.counts,
    { add: 0, update: 3, skip: 3, inactive: 1, manual_confirm: 0 },
    'pull #2 must exercise refresh (update), no-op (skip) and mark_inactive together',
  )

  // The update band is the quantity roll-up, and nothing else.
  const updates = secondPlan.decisions.filter((decision) => decision.decision === 'update')
  const changed = new Set(updates.flatMap((decision) => decision.changedFields))
  assert.deepEqual(
    Array.from(changed).sort(),
    ['rawQuantity', 'totalQuantity'],
    'only PLM-owned quantities may change on the second pull',
  )
  const subC = rowByPath(result.rows, ['SYN-PART-ROOT-A', 'SYN-PART-SUB-C'])
  assert.equal(subC.rawQuantity, 3)
  assert.equal(subC.totalQuantity, 6)
  assert.equal(rowByPath(result.rows, ['SYN-PART-ROOT-A', 'SYN-PART-SUB-C', 'SYN-PART-LEAF-E']).totalQuantity, 36)

  // mark_inactive: the removed line is the ONLY inactive decision, and it flips `active` off
  // instead of deleting (missingFromPlmPolicy is pinned, …-conflict-planner.cjs:151-162).
  const inactive = secondPlan.decisions.filter((decision) => decision.decision === 'inactive')
  assert.equal(inactive.length, 1)
  assert.equal(inactive[0].patch.active, false)
  const removedKey = pullOne.rows.find((row) => row.componentSourceId === 'SYN-PART-LEAF-F').idempotencyKey
  assert.equal(inactive[0].idempotencyKey, removedKey)

  // Preserve half of refresh/preserve: no patch or record may name a human-preserved field.
  for (const decision of secondPlan.decisions) {
    for (const payload of [decision.patch, decision.record]) {
      if (!payload) continue
      for (const field of HUMAN_PRESERVED_FIELD_IDS) {
        assert.ok(
          !Object.prototype.hasOwnProperty.call(payload, field),
          `a ${decision.decision} payload must never carry the human-preserved field ${field}`,
        )
      }
    }
  }

  console.log('  pull #2: add 0 / update 3 / skip 3 / inactive 1 / manual_confirm 0, human cells untouched')
}

async function testOptionalDuplicateFixture(schema) {
  const { result } = await expandFrom(schema, [PULL_1_FILE, DUPLICATE_FILE])
  assert.deepEqual(result.errors, [], 'the duplicate fixture must not break the expander itself')
  assert.deepEqual(result.rowErrors, [])
  assert.equal(result.rows.length, 9)

  const plan = planAgainst(result.rows, [])
  assert.equal(plan.valid, false, 'the duplicate fixture must hold, not apply')
  assert.deepEqual(plan.counts, { add: 7, update: 0, skip: 0, inactive: 0, manual_confirm: 1 })
  const held = plan.decisions.filter((decision) => decision.decision === 'manual_confirm')
  assert.equal(held.length, 1)
  assert.equal(held[0].conflictSummary.type, 'duplicate_expanded_key')
  // `details` is flattened onto the summary by makeConflictSummary (…-conflict-planner.cjs:908-914).
  assert.equal(held[0].conflictSummary.count, 2)

  // With no policy review the group holds under its DEFAULT reason. It is NOT the
  // CONFLICT_POLICY_NOT_IMPLEMENTED refusal, which fires only on an operator SELECTING one of the
  // three unimplemented policies (lib/stock-preparation-conflict-policies.cjs:119-137).
  const resolution = plan.summary.duplicateExpandedKeyResolution
  assert.equal(resolution.heldGroupCount, 1)
  assert.equal(resolution.heldRowCount, 2)
  assert.equal(resolution.heldReasonCounts.default_hold, 1)
  assert.equal(resolution.resolvedGroupCount, 0)

  console.log('  optional duplicate fixture: 1 held group (default_hold), plan invalid as designed')
}

/**
 * The OPTIONAL subtree seed, proved TWICE — and the second half is the load-bearing one.
 *
 *   OFF: the DEFAULT plan over 02 + 05 must produce the SAME 7 rows as 02 alone. The seed adds a
 *        folder node, a part, two BOM heads and two BOM lines, and the default pull must be
 *        completely blind to all of it. If it is not, the fixture's new columns have leaked into
 *        the default read surface and "off is structural" is false.
 *   ON:  the same data with the block enabled adds exactly ONE root (quantity DEFAULTED to 1) plus
 *        its two children — and the two heads on that one part_id collapse to that single root
 *        instead of colliding on a byte-identical idempotencyKey.
 */
async function testProjectSubtreeSeed(schema) {
  const offBaseline = await expandFrom(schema, [PULL_1_FILE])
  const off = await expandFrom(schema, [PULL_1_FILE, SUBTREE_FILE])
  assert.deepEqual(off.result.errors, [])
  assert.deepEqual(off.result.rowErrors, [])
  assert.equal(off.result.rows.length, 7, 'the subtree seed must be invisible to the DEFAULT plan')
  assert.deepEqual(
    off.result.rows.map((row) => row.idempotencyKey),
    offBaseline.result.rows.map((row) => row.idempotencyKey),
    'the default pull over 02 + 05 must produce byte-identical rows to the pull over 02 alone',
  )
  assert.deepEqual(
    off.adapter.calls.map((call) => `${call.object}:${Object.keys(call.filters).sort().join('+')}`),
    offBaseline.adapter.calls.map((call) => `${call.object}:${Object.keys(call.filters).sort().join('+')}`),
    'and it must not cost one extra read, nor change one filter',
  )
  assert.equal(off.result.summary.subtree, undefined, 'a disabled block adds no summary key')

  const on = await expandFrom(schema, [PULL_1_FILE, SUBTREE_FILE], SUBTREE_READ_PLAN)
  assert.deepEqual(on.result.errors, [], 'the enabled subtree pull must produce no global errors')
  assert.deepEqual(on.result.rowErrors, [], 'the enabled subtree pull must produce no row errors')
  assert.equal(on.result.status, 'expanded')
  assert.equal(on.result.rows.length, 10, 'the order path`s 7 rows plus one subtree root and its 2 children')

  const subtreeRoot = rowByPath(on.result.rows, ['SYN-PART-SUBTREE-H'])
  assert.equal(subtreeRoot.depth, 0)
  assert.equal(subtreeRoot.parentSourceId, null)
  assert.equal(subtreeRoot.rawQuantity, 1, 'a folder-discovered root carries the declared neutral multiplier')
  assert.equal(subtreeRoot.totalQuantity, 1)
  assert.equal(rowByPath(on.result.rows, ['SYN-PART-SUBTREE-H', 'SYN-PART-LEAF-J']).totalQuantity, 2)
  assert.equal(rowByPath(on.result.rows, ['SYN-PART-SUBTREE-H', 'SYN-PART-LEAF-K']).totalQuantity, 3)

  assert.deepEqual(on.result.summary.subtree, {
    nodesVisited: 2,
    nodesSkippedAlreadyVisited: 0,
    rootsDiscovered: 1,
    rootsExpanded: 1,
    rootsSkippedAlreadyExpanded: 0,
    rootsWithoutChildren: 0,
    rootQuantitySource: { orderDetail: 1, subtreeDefault: 1 },
  })

  // TWO HEADS, ONE ROOT — pinned on the CONTRACT (the plan is applyable) rather than by reasoning.
  // Two roots on one part_id would carry byte-identical keys, which the planner groups and holds.
  const plan = planAgainst(on.result.rows, [])
  assert.equal(plan.valid, true, 'two BOM heads on one part must not become two colliding roots')
  assert.deepEqual(plan.counts, { add: 10, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })

  console.log('  optional subtree seed: default plan blind (7 rows), enabled plan +1 root +2 children, plan valid')
}

function testReadmeStaysAnchored() {
  const readme = readFixture(README_FILE)
  // Cheap anti-rot: the README's operational claims are worth nothing if the files it names or the
  // action id it tells operators to call have moved.
  for (const needle of [SCHEMA_FILE, PULL_1_FILE, PULL_2_FILE, DUPLICATE_FILE, SUBTREE_FILE, PROJECT_NO]) {
    assert.ok(readme.includes(needle), `README must mention ${needle}`)
  }
  const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(
    __dirname,
    '..',
    'lib',
    'stock-preparation-table-actions.cjs',
  ))
  assert.ok(
    readme.includes(PLM_STOCK_PREPARATION_ACTION_ID),
    `README must name the real action id ${PLM_STOCK_PREPARATION_ACTION_ID}`,
  )
  for (const object of Object.values(PLM_STOCK_PREPARATION_BOM_READ_PLAN)) {
    if (object && typeof object === 'object' && object.object) {
      assert.ok(readme.includes(object.object), `README must name the read plan object ${object.object}`)
    }
  }
  console.log('  README names every fixture file, the action id and all 7 plan objects')
}

async function main() {
  const schemaSql = readFixture(SCHEMA_FILE)
  const schema = parseSchema(schemaSql)
  testSchemaCoversReadPlan(schema, schemaSql)
  const pullOne = await testPullOne(schema)
  await testPullTwo(schema, pullOne)
  await testOptionalDuplicateFixture(schema)
  await testProjectSubtreeSeed(schema)
  testReadmeStaysAnchored()
  console.log('stock-preparation-synthetic-sql-fixture.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
