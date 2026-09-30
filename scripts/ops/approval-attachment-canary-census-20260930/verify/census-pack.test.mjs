// ============================================================================
// census-pack.test.mjs — self-test for the approval attachment canary census
// (scripts/ops/approval-attachment-canary-census-20260930/, F2-A1)
// ============================================================================
// LAYER 1 (hermetic, no database): static contract checks on the census file —
//   it includes the read-only preamble, every SQL statement is a SELECT, no
//   write / DDL / side-effect token appears, the jsonpath predicate has ONE
//   pinned definition that every query uses, no detail-shaped predicate crept
//   in (that census belongs to OPEN PR #5476), no identity/label/value column
//   is selected, and the INVENTORY_RESULT line is the last statement.
// LAYER 2 (DATABASE_URL-gated): runs the REAL file with `psql -f` against a
//   synthetic fixture schema and asserts every count, the locator/count
//   invariant, values-free output, abort ⇒ no completion line, read-only
//   enforcement, and that the negative fixtures are load-bearing. Skipped
//   LOUDLY without DATABASE_URL / psql; with METASHEET_REAL_DB_TEST_STEP=1 a
//   missing DATABASE_URL or psql FAILS instead (fail-not-skip, same discipline
//   as scripts/ops/readonly-inventory-20260916/verify/).
//
// Node built-ins only (the hermetic CI job runs without `pnpm install`). The
// database must be a THROWAWAY one: the harness creates and drops its own
// `a1census_fixture_*` schemas and needs only CREATE on the database (a plain
// database owner is enough — no superuser, no roles created).
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
const CENSUS_FILE = '01-top-level-attachment-census.sql'
const PREAMBLE_FILE = '_preamble.sql'
const PINNED_PREDICATE = '$.fields[*] ? (@.type == "attachment")'
const FIXTURE_MARKER = /sentinelx/i

function read(name) {
  // CRLF-normalised so a Windows checkout cannot desync the line-oriented checks.
  return fs.readFileSync(path.join(PACK, name), 'utf8').replace(/\r\n/g, '\n')
}

/** SQL code only: psql meta-command lines dropped, `--` comments stripped outside quotes. */
function sqlCode(text) {
  const kept = text
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n')
  let out = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i]
    if (!inSingle && !inDouble && c === '-' && kept[i + 1] === '-') {
      while (i < kept.length && kept[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (!inDouble && c === "'") inSingle = !inSingle
    else if (!inSingle && c === '"') inDouble = !inDouble
    out += c
  }
  assert.ok(!inSingle && !inDouble, 'unbalanced quote in census SQL — the scanner cannot be trusted')
  return out
}

/** Top-level statements (split on `;` outside quotes), trimmed, empty ones dropped. */
function statements(code) {
  const parts = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (const c of code) {
    if (!inDouble && c === "'") inSingle = !inSingle
    else if (!inSingle && c === '"') inDouble = !inDouble
    if (c === ';' && !inSingle && !inDouble) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  parts.push(buf)
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

const WRITE_OR_SIDE_EFFECT =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|INTO|SET|RESET|LOCK|VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH|COMMENT|SECURITY|NOTIFY|LISTEN|PREPARE|EXECUTE|NEXTVAL|SETVAL|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|DBLINK|LO_IMPORT|LO_EXPORT|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND)\b/i

function writeTokens(code) {
  return [...code.matchAll(new RegExp(WRITE_OR_SIDE_EFFECT.source, 'gi'))].map((m) => m[0].toUpperCase())
}

// ── LAYER 1 — hermetic ──────────────────────────────────────────────────────

test('the census includes the read-only preamble first, and the preamble pins the execution contract', () => {
  const src = read(CENSUS_FILE)
  assert.equal(src.split('\n')[0], '\\ir _preamble.sql', 'first line must be `\\ir _preamble.sql`')
  const pre = read(PREAMBLE_FILE)
  assert.match(pre, /^\\set ON_ERROR_STOP on$/m)
  assert.match(pre, /^SET default_transaction_read_only = on;$/m)
  assert.match(pre, /^SET statement_timeout = '120s';$/m)
  assert.match(pre, /^SET lock_timeout = '5s';$/m)
  assert.match(pre, /^SET idle_in_transaction_session_timeout = '30s';$/m)
})

test('every census statement is a SELECT (six: a, b, b-locate, c, d, INVENTORY_RESULT)', () => {
  const stmts = statements(sqlCode(read(CENSUS_FILE)))
  assert.equal(stmts.length, 6, `expected 6 statements, found ${stmts.length}`)
  for (const s of stmts) {
    assert.equal(s.split(/\s+/)[0].toUpperCase(), 'SELECT', `non-SELECT statement: ${s.slice(0, 60)}`)
  }
})

test('no write / DDL / side-effect token anywhere in the census code (and the check itself bites)', () => {
  const code = sqlCode(read(CENSUS_FILE))
  assert.deepEqual(writeTokens(code), [])
  // Negative controls: the same function flags a mutated copy.
  assert.ok(writeTokens(`${code}\nINSERT INTO approval_templates (id) VALUES ('x');`).includes('INSERT'))
  assert.ok(writeTokens(`${code}\nSELECT 1 INTO scratch_copy;`).includes('INTO'))
  assert.ok(writeTokens(`${code}\nSELECT nextval('approval_request_no_seq');`).includes('NEXTVAL'))
})

test('the only psql meta-commands are the preamble include, the predicate \\set and \\echo lines', () => {
  const meta = read(CENSUS_FILE)
    .split('\n')
    .filter((line) => /^\s*\\/.test(line))
  for (const line of meta) {
    assert.match(line, /^(\\ir _preamble\.sql|\\set tla_path '.*'|\\echo '.*')$/, `unexpected meta-command: ${line}`)
  }
})

test('ONE pinned predicate definition, used by every jsonpath call, no inline jsonpath literal', () => {
  const src = read(CENSUS_FILE)
  const defs = src.split('\n').filter((line) => line.startsWith('\\set tla_path '))
  assert.equal(defs.length, 1, 'exactly one \\set tla_path definition')
  assert.equal(defs[0], `\\set tla_path '${PINNED_PREDICATE}'`, 'the predicate text is pinned')
  const code = sqlCode(src)
  const calls = [...code.matchAll(/jsonb_path_\w+\(([^()]*?),\s*([^()]*?)\)/g)]
  assert.ok(calls.length >= 7, `expected >= 7 jsonpath calls, found ${calls.length}`)
  for (const call of calls) {
    assert.equal(call[2].trim(), ":'tla_path'", `jsonpath call not using the pinned variable: ${call[0]}`)
  }
  assert.ok(!/'\$/.test(code), 'no inline jsonpath literal may sit beside the pinned variable')
})

test('scope guard: no detail-shaped predicate (the detail-embedded census belongs to #5476)', () => {
  const code = sqlCode(read(CENSUS_FILE))
  assert.ok(!/\bcolumns\b/i.test(code), 'census code must not reach into detail `columns`')
  assert.ok(!/"detail"/.test(code), 'census code must not match on the detail type')
  assert.ok(!/"detail"|columns\[/.test(PINNED_PREDICATE))
})

test('values-free (static): no identity / label / free-text column is referenced; ->> only reads a field id', () => {
  const code = sqlCode(read(CENSUS_FILE))
  const forbidden = /\b(name|key|description|label|title|comment|reason|requester_snapshot|requester_id|requester_name|created_by|updated_by|actor_id|approval_graph|runtime_graph)\b/i
  for (const [i, line] of code.split('\n').entries()) {
    assert.ok(!forbidden.test(line), `census line ${i + 1} references a value-bearing column: ${line.trim()}`)
  }
  for (const m of code.matchAll(/->>\s*('[^']*')/g)) {
    assert.equal(m[1], "'id'", `->> may only read a field id inside a predicate, found ->> ${m[1]}`)
  }
  // form_snapshot is only ever typed, key-tested or dereferenced into jsonb_typeof / a NOT IN test.
  const snapshotUses = [...code.matchAll(/form_snapshot/g)].length
  const allowed = [...code.matchAll(/jsonb_typeof\(i\.form_snapshot|i\.form_snapshot \?|\(i\.form_snapshot ->/g)].length
  assert.equal(snapshotUses, allowed, 'form_snapshot used outside the kind/presence predicates')
})

test('the INVENTORY_RESULT completion statement is the last statement', () => {
  const stmts = statements(sqlCode(read(CENSUS_FILE)))
  assert.match(stmts.at(-1), /^SELECT 'INVENTORY_RESULT file=01-top-level-attachment-census\.sql status=complete /)
})

// ── LAYER 2 — synthetic PostgreSQL ──────────────────────────────────────────

const PSQL = process.env.PSQL || 'psql'
const DATABASE_URL = process.env.DATABASE_URL
const REAL_DB_STEP = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

function psqlAvailable() {
  return spawnSync(PSQL, ['--version'], { encoding: 'utf8' }).status === 0
}

function psql(args) {
  const r = spawnSync(PSQL, ['-X', '-d', DATABASE_URL, ...args], {
    encoding: 'utf8',
    // Every file in this pack is UTF-8; do not let a console code page decide.
    env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function exec(sql) {
  const r = psql(['-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout
}

function scalar(sql) {
  const r = psql(['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

function createFixture({ dropTable } = {}) {
  const schema = `a1census_fixture_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE SCHEMA "${schema}"`)
  const r = psql(['-v', 'ON_ERROR_STOP=1', '-q', '-c', `SET search_path = "${schema}"`, '-f', path.join(HERE, 'fixture.sql')])
  if (r.status !== 0) {
    exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    throw new Error(`fixture load failed: ${r.stderr}`)
  }
  if (dropTable) exec(`DROP TABLE "${schema}".${dropTable}`)
  return schema
}

function dropFixture(schema) {
  try {
    exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } catch {
    /* best effort */
  }
}

/** Run a census file exactly the way the runbook says: whole file, psql -f, -v schema=…. */
function runCensus(schema, file = path.join(PACK, CENSUS_FILE)) {
  return psql(['-A', '-v', `schema=${schema}`, '-f', file])
}

/** Split `psql -A` output into result blocks using the `(N rows)` footers. */
function blocks(stdout) {
  const out = []
  let buf = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const m = /^\((\d+) rows?\)$/.exec(line)
    if (m) {
      const n = Number(m[1])
      const slice = buf.slice(buf.length - (n + 1))
      out.push({ header: slice[0], rows: slice.slice(1).map((r) => r.split('|')) })
      buf = []
      continue
    }
    buf.push(line)
  }
  return out
}

function block(stdout, header) {
  const found = blocks(stdout).filter((b) => b.header === header)
  assert.equal(found.length, 1, `expected exactly one "${header}" block in:\n${stdout}`)
  return found[0].rows
}

function resultLine(stdout) {
  return stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('INVENTORY_RESULT ')) ?? null
}

/** A doctored copy of the census (plus the preamble it `\ir`s) in a temp dir. */
function doctoredCopy(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1census-'))
  fs.copyFileSync(path.join(PACK, PREAMBLE_FILE), path.join(dir, PREAMBLE_FILE))
  const mutated = mutate(read(CENSUS_FILE))
  assert.notEqual(mutated, read(CENSUS_FILE), 'mutation anchor not found — the doctored copy is identical')
  fs.writeFileSync(path.join(dir, CENSUS_FILE), mutated)
  return { dir, file: path.join(dir, CENSUS_FILE) }
}

const H_A = 'total_templates|fill_page_templates|upload_target_templates|fill_page_not_upload_target|upload_target_not_fill_page'
const H_B = 'matching_versions|total_versions'
const H_LOC =
  'template_id|template_version_id|version|version_status|template_status|is_active_version|is_fill_page_version|attachment_field_count|frozen_instance_count'
const H_C = 'instance_status|frozen_instances'
const H_D = 'value_kind|instances|field_values'

test('sentinel: the DB-backed step must have DATABASE_URL and psql (fail-not-skip)', () => {
  if (REAL_DB_STEP && !DATABASE_URL) {
    assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is missing — this must FAIL, not skip')
  }
  if (REAL_DB_STEP && !psqlAvailable()) {
    assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but `psql` is not on PATH — cannot run the synthetic proof')
  }
})

if (!DATABASE_URL || !psqlAvailable()) {
  test('SYNTHETIC-DB LAYER SKIPPED — no DATABASE_URL / psql', { skip: true }, () => {})
  process.stderr.write(
    '\n*** approval-attachment-canary-census: synthetic-PostgreSQL layer SKIPPED (no DATABASE_URL or no psql). ' +
      'Point DATABASE_URL at a THROWAWAY Postgres to run it. ***\n',
  )
} else {
  test('synthetic PostgreSQL: every census reading on the fixture', () => {
    const schema = createFixture()
    try {
      const r = runCensus(schema)
      assert.equal(r.status, 0, `census run failed: ${r.stderr}`)

      // (a) T1 is both; T2 (draft adds), T6 (never published), T7 (archived), T8 (inactive
      // definition) are fill-page-only; T9 (latest removed it) is upload-target-only.
      assert.deepEqual(block(r.stdout, H_A), [['10', '5', '2', '4', '1']])
      // (b) T1v1, T2v2, T3v1, T6v1, T7v1, T8v1, T9v1 of 13 versions; T4 (detail-only),
      // T5 (text id'd "attachment", select option) and T11 (array form_schema) do not match.
      assert.deepEqual(block(r.stdout, H_B), [['7', '13']])

      const loc = block(r.stdout, H_LOC)
      assert.equal(loc.length, 7, '(b-locate) row count must equal (b).matching_versions')
      const byVersion = Object.fromEntries(loc.map((row) => [row[1], row]))
      // T1v1: two TOP-LEVEL fields (the nested detail column is not counted), 4 frozen instances.
      assert.deepEqual(byVersion['a1a1a1a1-0000-4000-8000-000000000001'].slice(2), ['1', 'published', 'published', 't', 't', '2', '4'])
      assert.deepEqual(byVersion['a2a2a2a2-0000-4000-8000-000000000002'].slice(2), ['2', 'draft', 'published', 'f', 't', '1', '0'])
      assert.deepEqual(byVersion['a3a3a3a3-0000-4000-8000-000000000001'].slice(2), ['1', 'published', 'published', 'f', 'f', '1', '1'])
      assert.deepEqual(byVersion['a6a6a6a6-0000-4000-8000-000000000001'].slice(2), ['1', 'draft', 'draft', 'f', 't', '1', '0'])
      assert.deepEqual(byVersion['a9a9a9a9-0000-4000-8000-000000000001'].slice(2), ['1', 'published', 'published', 't', 'f', '1', '0'])

      // (c) inst-1, inst-3, inst-7 pending and inst-2 approved on T1v1; inst-5 rejected on T3v1.
      assert.deepEqual(block(r.stdout, H_C), [['approved', '1'], ['pending', '3'], ['rejected', '1']])
      // (d) string (inst-1), object (inst-1, inst-5), array (inst-3); "" / null / NULL snapshot excluded.
      assert.deepEqual(block(r.stdout, H_D), [['array', '1', '1'], ['object', '2', '2'], ['string', '1', '1']])

      assert.match(resultLine(r.stdout) ?? '', /status=complete/)
      // Values-free: no name / key / description / field id / label / submitted value reached the output.
      assert.ok(!FIXTURE_MARKER.test(r.stdout), `fixture content leaked into census output:\n${r.stdout}`)
      assert.ok(!FIXTURE_MARKER.test(r.stderr))
    } finally {
      dropFixture(schema)
    }
  })

  test('synthetic PostgreSQL: a missing table aborts the run and leaves NO completion line', () => {
    const schema = createFixture({ dropTable: 'approval_published_definitions' })
    try {
      const r = runCensus(schema)
      assert.notEqual(r.status, 0, 'a missing table must abort (ON_ERROR_STOP), never read as zero')
      assert.equal(resultLine(r.stdout), null)
      assert.match(r.stderr, /approval_published_definitions/)
    } finally {
      dropFixture(schema)
    }
  })

  test('synthetic PostgreSQL: a write smuggled into the file fails read-only (25006) and leaves no completion line', () => {
    const schema = createFixture()
    const { dir, file } = doctoredCopy((src) =>
      src.replace(
        "\\set tla_path",
        "INSERT INTO approval_templates (id, key, name, status) VALUES ('11111111-0000-4000-8000-0000000000ff', 'k', 'n', 'draft');\n\\set tla_path",
      ),
    )
    try {
      const r = runCensus(schema, file)
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /read-only transaction/)
      assert.equal(resultLine(r.stdout), null)
      assert.equal(scalar(`SELECT count(*) FROM "${schema}".approval_templates`), '10', 'no row was written')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      dropFixture(schema)
    }
  })

  test('synthetic PostgreSQL: the negative fixtures are load-bearing (a looser predicate over-counts)', () => {
    const schema = createFixture()
    const { dir, file } = doctoredCopy((src) =>
      src.replace(`\\set tla_path '${PINNED_PREDICATE}'`, `\\set tla_path 'lax $.**.type ? (@ == "attachment")'`),
    )
    try {
      const r = runCensus(schema, file)
      assert.equal(r.status, 0, r.stderr)
      // Any-depth matching also counts T4 (detail-only) and T11 (array form_schema): 9, not 7.
      assert.deepEqual(block(r.stdout, H_B), [['9', '13']])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      dropFixture(schema)
    }
  })
}
