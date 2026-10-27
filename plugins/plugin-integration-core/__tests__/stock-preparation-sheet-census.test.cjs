'use strict'

// Batch-refresh step 6d-1a (design-final §6.4, S6-0) — the doubled-sheet census: the pure module and the static
// contract of its R-line psql twin.
//
//   SC-01 (hermetic) `censusOfRows` on D1-D5 fixtures (design §6.1): keyless rows split by creator; the string
//         'false' counts ACTIVE (D5); the module's two-copy count is readiness O-6's own count; every count is
//         non-zero in at least one fixture (a wrong predicate cannot hide behind a vacuous zero).
//   SC-02 (hermetic) values-free: a sentinel project number / objectId / componentSourceId never reaches the public
//         projection; the pack's default output lines carry ordinals, a status token and integers only; object_id
//         is selected ONLY inside the `-v emit_private_map=1` block. Plus the pack's static safety contract: the
//         shared preamble, no write statement, the relations it reads, the human-field list pinned to
//         HUMAN_PRESERVED_FIELD_IDS, and the count columns in the module's order.
// The pack's SQL is run on real PostgreSQL by S9D-02 / S9D-03 (core-backend
// tests/integration/stock-preparation-sheet-census-realdb.cases.ts): per-sheet parity with this module, the
// sentinel absent from the default output, present only in the private map.
//
// VALUES-FREE: synthetic ids only (S6C-…).

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const PACK_DIR = path.join(REPO_ROOT, 'scripts', 'ops', 'stock-prep-sheet-census-20261027')

const {
  SHEET_CENSUS_SCHEME,
  SHEET_CENSUS_COUNT_KEYS,
  StockPreparationSheetCensusError,
  censusOfRows,
  publicCensusOf,
  __internals: { componentHandle },
} = require(path.join(LIB, 'stock-preparation-sheet-census.cjs'))
const { EXISTING_ROW_CREATED_BY } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  __internals: { countTwoCopyComponents },
} = require(path.join(LIB, 'stock-preparation-pilot-readiness.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ── fixtures (logical rows, as the project-scoped reader returns them) ──────────────────────────────────────────
function row(fields, { creator } = {}) {
  const out = { projectNo: 'S6C-PRJ', ...fields }
  if (creator !== undefined) out[EXISTING_ROW_CREATED_BY] = creator
  return out
}

// D1 — S root subtree active AND an active nested copy of S under P.
function d1Rows() {
  return [
    row({ idempotencyKey: 'k-S', componentSourceId: 'S6C-S', parentSourceId: '', active: true }),
    row({ idempotencyKey: 'k-S-C', componentSourceId: 'S6C-C', parentSourceId: 'S6C-S', active: true }),
    row({ idempotencyKey: 'k-P', componentSourceId: 'S6C-P', parentSourceId: null, active: true }),
    row({ idempotencyKey: 'k-P-S', componentSourceId: 'S6C-S', parentSourceId: 'S6C-P', active: true, notes: 'S6C filled on the copy' }),
    row({ idempotencyKey: 'k-P-S-C', componentSourceId: 'S6C-C', parentSourceId: 'S6C-S', active: true }),
  ]
}

// D2 — the item-10 shape: S's rows swept inactive (fills on the hidden rows), P's subtree with S copies active.
function d2Rows() {
  return [
    row({ idempotencyKey: 'k-S', componentSourceId: 'S6C-S', parentSourceId: '', active: false, materialType: 'S6C-type' }),
    row({ idempotencyKey: 'k-S-C', componentSourceId: 'S6C-C', parentSourceId: 'S6C-S', active: false, procurementDone: false }),
    row({ idempotencyKey: 'k-P', componentSourceId: 'S6C-P', active: true }),
    row({ idempotencyKey: 'k-P-S', componentSourceId: 'S6C-S', parentSourceId: 'S6C-P', active: true }),
    row({ idempotencyKey: 'k-P-S-C', componentSourceId: 'S6C-C', parentSourceId: 'S6C-S', active: true, notes: '   ' }),
  ]
}

const ZERO = Object.freeze(Object.fromEntries(SHEET_CENSUS_COUNT_KEYS.map((key) => [key, 0])))
const countsOf = (census) => Object.fromEntries(SHEET_CENSUS_COUNT_KEYS.map((key) => [key, census[key]]))

// ── SC-01 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('SC-01 D1: one two-copy component; the copy carrying a human cell is counted; no remnant', () => {
  const census = censusOfRows(d1Rows())
  assert.equal(census.scheme, SHEET_CENSUS_SCHEME)
  assert.deepEqual(countsOf(census), { ...ZERO, rowCount: 5, activeRowCount: 5, twoCopyComponents: 1, nestedCopiesWithHumanCells: 1 })
  assert.equal(census.twoCopyComponents, countTwoCopyComponents(d1Rows()), 'readiness O-6 counts the same')
})

test('SC-01 D2 (item 10): one remnant; O-6 sees nothing; hidden fills counted (boolean false is a fill); a whitespace note is blank', () => {
  const census = censusOfRows(d2Rows())
  assert.deepEqual(countsOf(census), { ...ZERO, rowCount: 5, activeRowCount: 3, inactiveRootRemnantComponents: 1, inactiveRowsWithHumanCells: 2 })
  assert.equal(countTwoCopyComponents(d2Rows()), 0, 'O-6 counts active rows only — the shape the census exists for')
})

test('SC-01 D2 is not a remnant once S has an active root again, nor without an active nested copy', () => {
  const revived = d2Rows().concat([row({ idempotencyKey: 'k-S-2', componentSourceId: 'S6C-S', parentSourceId: '', active: true })])
  const r = censusOfRows(revived)
  assert.equal(r.inactiveRootRemnantComponents, 0)
  assert.equal(r.twoCopyComponents, 1, 'an active root and an active nested copy is D1')
  const noCopy = d2Rows().filter((entry) => entry.idempotencyKey !== 'k-P-S')
  assert.equal(censusOfRows(noCopy).inactiveRootRemnantComponents, 0)
})

test('SC-01 D3: duplicate key groups count active and inactive rows; a resolved-duplicate suffix is a different key', () => {
  const rows = [
    row({ idempotencyKey: 'k-dup', componentSourceId: 'S6C-A', active: true }),
    row({ idempotencyKey: 'k-dup', componentSourceId: 'S6C-A', parentSourceId: 'S6C-X', active: false }),
    row({ idempotencyKey: 'k-dup', componentSourceId: 'S6C-A', parentSourceId: 'S6C-Y', active: true }),
    row({ idempotencyKey: 'k-two', componentSourceId: 'S6C-B', active: true }),
    row({ idempotencyKey: 'k-two', componentSourceId: 'S6C-B', active: true }),
    row({ idempotencyKey: 'k-two::duplicate:x:abc', componentSourceId: 'S6C-B', active: true }),
    row({ idempotencyKey: ' k-two', componentSourceId: 'S6C-B', active: true }),
  ]
  assert.equal(censusOfRows(rows).duplicateKeyGroups, 2, 'keys compare untrimmed, as the planner keys them')
})

test('SC-01 D4: keyless ACTIVE rows split by creator; an inactive keyless row and a numeric key are handled', () => {
  const rows = [
    row({ componentSourceId: 'S6C-K1', active: true }),
    row({ idempotencyKey: '  ', componentSourceId: 'S6C-K2', active: true }),
    row({ idempotencyKey: 7, componentSourceId: 'S6C-K3', active: true }),
    row({ componentSourceId: 'S6C-M1', active: true }, { creator: 'u_s6c_hand' }),
    row({ idempotencyKey: '', active: true }, { creator: 'u_s6c_hand' }),
    row({ active: true }, { creator: '   ' }),
    row({ componentSourceId: 'S6C-K4', active: false }, { creator: 'u_s6c_hand' }),
  ]
  const census = censusOfRows(rows)
  assert.equal(census.keylessRowsWithoutCreator, 4, 'missing, blank and non-string keys; a blank creator is no creator')
  assert.equal(census.keylessRowsWithCreator, 2, 'hand-added rows never count as the D4 defect')
  assert.equal(census.activeRowCount, 6)
})

test('SC-01 D5: only the boolean false is inactive; the string \'false\' / 0 are active AND non-boolean; null / missing are active and not counted', () => {
  const rows = [
    row({ idempotencyKey: 'k1', active: 'false' }),
    row({ idempotencyKey: 'k2', active: 0 }),
    row({ idempotencyKey: 'k3', active: null }),
    row({ idempotencyKey: 'k4' }),
    row({ idempotencyKey: 'k5', active: false }),
    row({ idempotencyKey: 'k6', active: 'true' }),
  ]
  const census = censusOfRows(rows)
  assert.equal(census.activeRowCount, 5)
  assert.equal(census.nonBooleanActiveCells, 3)
})

test('SC-01 root and component predicates mirror the pairing module: JS trim whitespace (NBSP, U+3000) is blank; a numeric component is none', () => {
  const rows = [
    row({ idempotencyKey: 'r1', componentSourceId: 'S6C-R', parentSourceId: ' 　', active: true }),
    row({ idempotencyKey: 'r2', componentSourceId: 'S6C-R', parentSourceId: 'S6C-Q', active: true }),
    row({ idempotencyKey: 'r3', componentSourceId: 42, parentSourceId: '', active: true }),
    row({ idempotencyKey: 'r4', componentSourceId: 42, parentSourceId: 'S6C-Q', active: true }),
    row({ idempotencyKey: 'r5', componentSourceId: 'S6C-T ', parentSourceId: '', active: true }),
    row({ idempotencyKey: 'r6', componentSourceId: 'S6C-T', parentSourceId: 'S6C-Q', active: true }),
  ]
  assert.equal(censusOfRows(rows).twoCopyComponents, 1, 'NBSP parent is a root; 42 groups nowhere; components compare untrimmed')
  assert.equal(countTwoCopyComponents(rows), 1)
})

test('SC-01 every count is non-zero in at least one fixture (no vacuous zero hides a wrong predicate)', () => {
  const all = [...d1Rows(), ...d2Rows().map((entry) => ({ ...entry, projectNo: 'S6C-PRJ' })),
    row({ active: true }), row({ active: true }, { creator: 'u_s6c_hand' }), row({ idempotencyKey: 'k-S', active: 'false' })]
  const merged = SHEET_CENSUS_COUNT_KEYS.map((key) => [key, Math.max(censusOfRows(d1Rows())[key], censusOfRows(d2Rows())[key], censusOfRows(all)[key])])
  for (const [key, value] of merged) assert.ok(value > 0, `${key} is exercised`)
})

test('SC-01 humanFieldIds: default = HUMAN_PRESERVED_FIELD_IDS; an explicit list is honoured; a malformed one throws', () => {
  const rows = [row({ idempotencyKey: 'h1', active: false, ext_s6c_note: 'S6C' })]
  assert.equal(censusOfRows(rows).inactiveRowsWithHumanCells, 0)
  assert.equal(censusOfRows(rows, { humanFieldIds: ['ext_s6c_note'] }).inactiveRowsWithHumanCells, 1)
  for (const bad of [null, 'notes', [''], [1]]) {
    assert.throws(() => censusOfRows(rows, { humanFieldIds: bad }), StockPreparationSheetCensusError)
  }
  assert.throws(() => censusOfRows(null), StockPreparationSheetCensusError)
  assert.equal(censusOfRows([null, 'x', []]).rowCount, 3, 'a non-object row is counted as an empty (active, root, keyless) row, never thrown on')
})

test('SC-01 the module is pure: the input rows are not mutated and two calls agree', () => {
  const rows = d2Rows()
  const before = JSON.stringify(rows)
  const a = censusOfRows(rows, { tenantId: 't', projectNo: 'S6C-PRJ' })
  const b = censusOfRows(rows, { tenantId: 't', projectNo: 'S6C-PRJ' })
  assert.equal(JSON.stringify(rows), before)
  assert.deepEqual(a, b)
})

// ── SC-02 (module side) ───────────────────────────────────────────────────────────────────────────────────────
test('SC-02 the public projection carries integers only; remnant handles stay under `private` and only with tenant + project', () => {
  const SENTINEL_PROJECT = 'S6C-SENTINEL-PROJECT-0001'
  const SENTINEL_COMPONENT = 'S6C-SENTINEL-COMPONENT-0001'
  const rows = d2Rows().map((entry) => ({ ...entry, projectNo: SENTINEL_PROJECT, componentSourceId: entry.componentSourceId === 'S6C-S' ? SENTINEL_COMPONENT : entry.componentSourceId }))
  const census = censusOfRows(rows, { tenantId: 'tenant_s6c', projectNo: SENTINEL_PROJECT })
  const expected = crypto.createHash('sha256').update(`tenant_s6c:${SENTINEL_PROJECT}:${SENTINEL_COMPONENT}`, 'utf8').digest('hex').slice(0, 24)
  assert.deepEqual(census.private.inactiveRootRemnantComponentHandles, [expected])
  assert.equal(componentHandle('tenant_s6c', SENTINEL_PROJECT, SENTINEL_COMPONENT), expected)
  const pub = publicCensusOf(census)
  assert.deepEqual(Object.keys(pub), ['scheme', ...SHEET_CENSUS_COUNT_KEYS])
  for (const key of SHEET_CENSUS_COUNT_KEYS) assert.ok(Number.isInteger(pub[key]))
  const text = JSON.stringify(pub)
  for (const needle of [SENTINEL_PROJECT, SENTINEL_COMPONENT, expected, 'tenant_s6c']) assert.equal(text.includes(needle), false, needle)
  assert.equal(censusOfRows(rows).private.inactiveRootRemnantComponentHandles, null, 'no handles without tenant + project')
  assert.throws(() => publicCensusOf({ ...census, rowCount: -1 }), StockPreparationSheetCensusError)
})

// ── SC-02 (pack side, static) ─────────────────────────────────────────────────────────────────────────────────
// A CRLF checkout (autocrlf on Windows) must not turn the line-anchored checks red.
const readLf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const PREAMBLE = readLf(path.join(PACK_DIR, '_preamble.sql'))
const PACK = readLf(path.join(PACK_DIR, '01-sheet-census.sql'))
const stripSqlComments = (sql) => sql.split(/\r?\n/).map((line) => line.replace(/--.*$/, '')).join('\n')
const PACK_CODE = stripSqlComments(PACK)

function privateBlock(code) {
  const start = code.indexOf('\\if :emit_private_map')
  assert.notEqual(start, -1, 'the private block exists')
  const end = code.indexOf('\\endif', start)
  return { start, end, text: code.slice(start, end) }
}

test('SC-02 the pack includes the shared preamble (ON_ERROR_STOP, read-only, timeouts) and runs in one read-only snapshot', () => {
  assert.match(PACK, /^\\ir _preamble\.sql$/m)
  assert.match(PREAMBLE, /^\\set ON_ERROR_STOP on$/m)
  assert.match(PREAMBLE, /^SET default_transaction_read_only = on;$/m)
  assert.match(PREAMBLE, /^SET statement_timeout = '120s';$/m)
  assert.match(PREAMBLE, /^SET lock_timeout = '5s';$/m)
  assert.match(PACK_CODE, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;$/m)
  assert.match(PACK_CODE, /^COMMIT;\s*$/m)
})

test('SC-02 no write statement anywhere in the pack', () => {
  for (const code of [PACK_CODE, stripSqlComments(PREAMBLE)]) {
    for (const word of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COPY', 'CALL', 'VACUUM', 'REINDEX', 'CLUSTER', 'LOCK', 'NOTIFY']) {
      assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(code), false, `no ${word}`)
    }
    assert.equal(/\\(?:copy|o|w|g\s|gexec|!)/.test(code), false, 'no psql file/shell/exec meta-command')
  }
})

test('SC-02 the pack reads only the registry, the three meta tables and information_schema', () => {
  const ctes = new Set([...PACK_CODE.matchAll(/^([a-z_]+) AS \($/gm)].map((match) => match[1]))
  const relations = new Set()
  for (const match of PACK_CODE.matchAll(/\b(?:FROM|JOIN)\s+(?!LATERAL\b)([A-Za-z_][A-Za-z_.]*)/g)) {
    if (!ctes.has(match[1])) relations.add(match[1])
  }
  assert.deepEqual([...relations].sort(), ['information_schema.columns', 'integration_stock_prep_project_target', 'meta_fields', 'meta_records', 'meta_sheets'])
  // The registry columns the pack reads exist in migration 087 (byte-identical on onprem-r74 and main).
  const m087 = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'core-backend', 'migrations', '087_create_integration_stock_prep_project_target.sql'), 'utf8')
  for (const column of ['id', 'tenant_id', 'project_no', 'sheet_id', 'object_id', 'status', 'created_at']) {
    assert.match(m087, new RegExp(`^\\s+${column}\\s+(TEXT|TIMESTAMPTZ)`, 'm'), `087 declares ${column}`)
    assert.match(PACK_CODE, new RegExp(`\\br\\.${column}\\b`), `the pack reads r.${column}`)
  }
})

test('SC-02 values-free output: default lines are ordinals, the status token and integers; object_id is selected only in the private block', () => {
  const { start, end, text } = privateBlock(PACK_CODE)
  assert.match(text, /'CENSUS_PRIVATE ordinal=' \|\| reg\.ordinal \|\| ' object_id=' \|\| reg\.object_id/)
  assert.match(PACK_CODE.slice(PACK_CODE.lastIndexOf('\\if :{?emit_private_map}', start), start), /^\\if :\{\?emit_private_map\}\s*$/m)
  const outside = PACK_CODE.slice(0, start) + PACK_CODE.slice(end)
  assert.equal(outside.includes('CENSUS_PRIVATE'), false, 'no private line outside the block')
  assert.equal(/\\echo/.test(outside), false, 'no \\echo outside the block')
  // The output expression: the `lines` CTE body. It may name only ordinals, the registry status, the check reason
  // and the integer count columns — never a value-bearing column.
  const body = outside.slice(outside.indexOf('lines AS ('), outside.indexOf('SELECT line FROM lines'))
  assert.ok(body.length > 0)
  for (const forbidden of ['project_no', 'object_id', 'tenant_id', 'derived_sheet_id', 'fid', 'staging_project', 'data', 'created_by', 'component', 'row_key']) {
    const hits = [...body.matchAll(new RegExp(`(?<![A-Za-z_])(?:[a-z]+\\.)?${forbidden}(?![A-Za-z_])`, 'g'))]
      .filter((hit) => !/_(?:components|cells|groups)$/.test(hit[0]))
    assert.deepEqual(hits.map((hit) => hit[0]), [], `the output never names ${forbidden}`)
  }
  // Every string concatenated into a line is a literal token or one of the closed columns below.
  const concatenated = [...body.matchAll(/\|\|\s*(?:COALESCE\()?([a-z]+\.[a-z_]+)/g)].map((match) => match[1].split('.')[1])
  const closed = new Set(['ordinal', 'status', 'reason', ...SHEET_CENSUS_COUNT_KEYS.map(snake)])
  for (const column of concatenated) assert.ok(closed.has(column), `line column ${column} is a closed one`)
  assert.match(PACK_CODE, /WHEN d\.derived_sheet_id <> d\.sheet_id THEN 'sheet_id_mismatch'/)
})

function snake(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

test('SC-02 the pack prints the module\'s count keys, in the module\'s order', () => {
  const body = PACK_CODE.slice(PACK_CODE.indexOf('lines AS ('), PACK_CODE.indexOf('SELECT line FROM lines'))
  const printed = [...body.matchAll(/' ([a-z_]+)=' \|\| COALESCE/g)].map((match) => match[1])
  assert.deepEqual(printed, SHEET_CENSUS_COUNT_KEYS.map(snake))
  assert.match(body, /' sheet_rows_all_projects=' \|\| \(SELECT count\(\*\) FROM meta_records m WHERE m\.sheet_id = c\.sheet_id\)/)
})

test('SC-02 the pack\'s human-field list is HUMAN_PRESERVED_FIELD_IDS; its required ids are template fields', () => {
  const block = PACK.slice(PACK.indexOf('census-human-field-ids:begin'), PACK.indexOf('census-human-field-ids:end'))
  const ids = [...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, HUMAN_PRESERVED_FIELD_IDS.slice())
  const required = [...PACK.match(/ARRAY\[([^\]]+)\]::text\[\] AS required/)[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(required, ['projectNo', 'idempotencyKey', 'componentSourceId', 'parentSourceId', 'active'])
  const templateIds = new Set(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id))
  for (const id of [...required, ...ids]) assert.ok(templateIds.has(id), `${id} is a main-template field`)
})

test('SC-02 the pack derives ids exactly as provisioning.ts stableMetaId does', () => {
  assert.match(PACK_CODE, /r\.tenant_id \|\| ':integration-core' AS staging_project/)
  assert.match(PACK_CODE, /'sheet_' \|\| left\(encode\(digest\(convert_to\(reg\.staging_project \|\| ':' \|\| reg\.object_id, 'UTF8'\), 'sha1'\), 'hex'\), 24\)/)
  assert.match(PACK_CODE, /'fld_' \|\| left\(encode\(digest\(convert_to\(reg\.staging_project \|\| ':' \|\| reg\.object_id \|\| ':' \|\| l\.id, 'UTF8'\), 'sha1'\), 'hex'\), 24\)/)
  const provisioning = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'multitable', 'provisioning.ts'), 'utf8')
  assert.match(provisioning, /createHash\('sha1'\)\s*\n\s*\.update\(parts\.join\(':'\)\)\s*\n\s*\.digest\('hex'\)\s*\n\s*\.slice\(0, 24\)/)
  // The JS trim() whitespace set, element by element.
  const ws = [...PACK_CODE.slice(PACK_CODE.indexOf('ws AS ('), PACK_CODE.indexOf('logical AS (')).matchAll(/chr\((\d+)\)/g)].map((match) => Number(match[1]))
  const jsWhitespace = []
  for (let code = 0; code <= 0xffff; code += 1) if (String.fromCharCode(code).trim() === '') jsWhitespace.push(code)
  assert.deepEqual(ws, jsWhitespace)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-sheet-census.test.cjs', tests)
