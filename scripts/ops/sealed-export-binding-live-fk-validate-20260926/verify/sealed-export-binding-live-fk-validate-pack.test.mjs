// ============================================================================
// sealed-export-binding-live-fk-validate-pack.test.mjs — `node --test` layer
// over run-verify.mjs
// ============================================================================
// LAYER 1 (hermetic, no database): static contract checks on the pack —
//   * 01 includes the READ-ONLY preamble and contains no write statement;
//   * 02/03 include the WRITE preamble, which must NOT pin read-only;
//   * 01 computes every count from ONE `classified` CTE and ends with its
//     INVENTORY_RESULT completion statement;
//   * 01's dangling predicate is the FK's own rule (ACTIVE + system absent);
//   * nothing the pack prints is an identifier column (values-free);
//   * 02's apply gate is the exact literal '1', its default is ROLLBACK, it
//     only ever sets status = 'RETIRED', requires the FK, and aborts APPLY=1
//     unless the live table is left with zero dangling rows;
//   * 03 classifies 23503 and 55P03 by name, owns its lock_timeout, and does
//     not swallow query_canceled or use a catch-all handler;
//   * verify/migration-up.sql still reproduces every sql`…` statement of the
//     migration's up() — and that drift check bites.
//
// LAYER 2 (DATABASE_URL-gated): run-verify.mjs — scenarios S1..S11 and mutants
//   PM1..PM7 on synthetic schemas built from the real SQL migrations. Skipped
//   LOUDLY without DATABASE_URL; with METASHEET_REAL_DB_TEST_STEP=1 a missing
//   DATABASE_URL or `psql` FAILS instead of skipping (same discipline as the
//   live-id-fk-validate-20260920 pack).
//
// NEVER point layer 2 at a real database: the harness creates and drops its
// own `s073fx_*` schemas and runs 02 with APPLY=1 and 03 against them.
//
//   node --test scripts/ops/sealed-export-binding-live-fk-validate-20260926/verify/sealed-export-binding-live-fk-validate-pack.test.mjs
//   DATABASE_URL=postgresql://<user>@<host>:<port>/<throwaway-db> \
//     node --test scripts/ops/sealed-export-binding-live-fk-validate-20260926/verify/sealed-export-binding-live-fk-validate-pack.test.mjs
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { psqlAvailable, verifyAll } from './run-verify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
const REPO = path.resolve(PACK, '..', '..', '..')
const MIGRATION_TS = path.join(
  REPO,
  'packages/core-backend/src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts',
)

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const pack = name => read(path.join(PACK, name))

/** Strip `--` comment lines so a contract check cannot be satisfied by prose. */
function code(src) {
  return src
    .split('\n')
    .filter(l => !/^\s*--/.test(l))
    .join('\n')
}

const norm = s => s.replace(/\s+/g, ' ').trim()

// ── LAYER 1 — hermetic ──────────────────────────────────────────────────────

test('01 includes the read-only preamble; 02/03 include the write preamble', () => {
  assert.match(pack('01-inventory.sql'), /^\\ir _preamble\.sql$/m)
  for (const f of ['02-remediate.sql', '03-validate.sql']) {
    assert.match(pack(f), /^\\ir _preamble-write\.sql$/m, `${f} must include the write preamble`)
    assert.ok(!/^\\ir _preamble\.sql$/m.test(pack(f)), `${f} must NOT include the read-only preamble`)
  }
})

test('the read-only preamble pins ON_ERROR_STOP, read-only and the timeouts', () => {
  const pre = code(pack('_preamble.sql'))
  assert.match(pre, /\\set ON_ERROR_STOP on/)
  assert.match(pre, /SET default_transaction_read_only = on;/)
  assert.match(pre, /SET statement_timeout/)
  assert.match(pre, /SET lock_timeout/)
  assert.match(pre, /SET idle_in_transaction_session_timeout/)
})

test('the write preamble pins ON_ERROR_STOP and the timeouts but never read-only', () => {
  const pre = code(pack('_preamble-write.sql'))
  assert.match(pre, /\\set ON_ERROR_STOP on/)
  assert.match(pre, /SET statement_timeout/)
  assert.match(pre, /SET lock_timeout/)
  assert.match(pre, /SET idle_in_transaction_session_timeout/)
  assert.ok(!/default_transaction_read_only/.test(pre), 'the write preamble must not pin read-only')
})

test('01 contains no write statement of any kind', () => {
  const body = code(pack('01-inventory.sql'))
  const writes = [
    [/\bINSERT\s+INTO\b/i, 'INSERT'],
    [/\bUPDATE\s+["a-z_]/i, 'UPDATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE'],
    [/\bALTER\s+(TABLE|INDEX|SEQUENCE)\b/i, 'ALTER'],
    [/\bCREATE\s+(TABLE|TEMP|TEMPORARY|INDEX|VIEW|SCHEMA)\b/i, 'CREATE'],
    [/\bDROP\s+(TABLE|INDEX|VIEW|SCHEMA|CONSTRAINT)\b/i, 'DROP'],
    [/\bTRUNCATE\b/i, 'TRUNCATE'],
    [/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, 'transaction control'],
  ]
  for (const [re, label] of writes) {
    assert.ok(!re.test(body), `01 must contain no ${label} statement`)
  }
})

test('01 derives every census count from ONE `classified` CTE and ends with INVENTORY_RESULT', () => {
  const body = code(pack('01-inventory.sql'))
  assert.equal((body.match(/WITH classified AS \(/g) || []).length, 1, 'exactly one `classified` CTE')
  assert.match(body, /AS inflight_runs_on_dangling\n\s*FROM classified;/, 'the census reads the CTE, not a base table')
  assert.match(body, /INVENTORY_RESULT file=01-inventory\.sql status=/)
  assert.ok(
    body.lastIndexOf('INVENTORY_RESULT') > body.lastIndexOf('FROM classified'),
    'the completion line must be the LAST statement',
  )
})

test("01's dangling predicate is the FK's own rule: ACTIVE and the system row absent", () => {
  const body = code(pack('01-inventory.sql'))
  assert.match(body, /SELECT b\.status = 'ACTIVE' AS active,/)
  assert.match(body, /WHERE s\.id = b\.external_system_id\n\s*\) AS system_present,/)
  assert.match(body, /count\(\*\) FILTER \(WHERE active AND NOT system_present\)::int\s+AS dangling_active/)
  // Q3 counts through the generated column exactly the way MATCH SIMPLE does.
  assert.match(body, /WHERE b\.live_external_system_id IS NOT NULL\n\s*AND NOT EXISTS \(\n\s*SELECT 1 FROM integration_external_systems s\n\s*WHERE s\.id = b\.live_external_system_id/)
})

test('values-free by construction: no pack statement selects an identifier column into its output', () => {
  // Every output column of every SELECT in the pack is an alias; none of them may be an id. The
  // only id-shaped aliases anywhere are 02's `key_id` / `target_id`, and they live in the CTAS
  // snapshot (a temp table), never in a printed result. The dynamic proof is run-verify.mjs S11.
  const IDS = new Set(['binding_id', 'external_system_id', 'tenant_id', 'workspace_id', 'run_id', 'system_id'])
  for (const f of ['01-inventory.sql', '02-remediate.sql', '03-validate.sql']) {
    const body = code(pack(f))
    for (const [, alias] of body.matchAll(/\bAS (\w+)\b/g)) {
      assert.ok(!IDS.has(alias), `${f} must not print ${alias}`)
    }
    assert.ok(!/SELECT \*/.test(body), `${f} must not SELECT *`)
  }
  const r02 = code(pack('02-remediate.sql'))
  const ctasStart = r02.indexOf('CREATE TEMP TABLE s073_dangling')
  const ctasEnd = r02.indexOf("SELECT 'STEP0_SNAPSHOT'")
  for (const alias of ['key_id', 'target_id']) {
    const at = [...r02.matchAll(new RegExp(`\\bAS ${alias}\\b`, 'g'))].map(m => m.index)
    assert.equal(at.length, 1, `02 must alias ${alias} exactly once`)
    assert.ok(at[0] > ctasStart && at[0] < ctasEnd, `02's ${alias} must live only in the temp-table snapshot`)
  }
  for (const f of ['01-inventory.sql', '03-validate.sql']) {
    assert.ok(!/\bAS (key_id|target_id)\b/.test(code(pack(f))), `${f} must not alias an id`)
  }
})

test('02 gates writing on the exact literal 1 and rolls back by default', () => {
  const body = code(pack('02-remediate.sql'))
  assert.match(body, /\\set apply_mode off/, 'the default must be off before anything is read')
  assert.match(body, /:'APPLY' = '1'/, 'only the exact literal 1 may turn writing on')
  assert.ok(!/:APPLY\b(?!')/.test(body.replace(/:\{\?APPLY\}/g, '')), '02 must not test APPLY as a psql truth value')
  assert.match(body, /\\if :apply_mode\nCOMMIT;[\s\S]*?\\else\nROLLBACK;[\s\S]*?\\endif/)
  assert.equal((body.match(/^BEGIN;$/gm) || []).length, 1, 'the whole remediation must be one explicit transaction')
})

test('02 only ever retires: one UPDATE, SET status = RETIRED, re-stating the dangling predicate; no DELETE', () => {
  const body = code(pack('02-remediate.sql'))
  const updates = body.match(/\bUPDATE\s+integration_\w+/g) || []
  assert.deepEqual(updates, ['UPDATE integration_sealed_export_stock_prep_bindings'], 'exactly one UPDATE, on the bindings')
  assert.match(body, /SET status = 'RETIRED'\n\s*FROM s073_dangling d\n\s*WHERE b\.binding_id = d\.key_id\n\s*AND b\.status = 'ACTIVE'\n\s*AND b\.external_system_id = d\.target_id\n\s*AND NOT EXISTS/)
  assert.ok(!/\bDELETE\s+FROM\b/i.test(body), '02 must not delete rows')
  assert.ok(!/SET\s+(external_system_id|binding_id|tenant_id|expires_at)\b/.test(body), '02 must not touch any other column')
  assert.match(body, /CREATE TEMP TABLE s073_dangling ON COMMIT DROP/)
})

test('02 requires the FK and aborts APPLY=1 unless zero dangling rows remain', () => {
  const body = code(pack('02-remediate.sql'))
  assert.match(body, /REMEDIATE_ABORT reason=missing-constraint:fk_sealed_export_stock_prep_binding_live_external_system/)
  assert.match(body, /\\if :apply_mode\nDO \$\$\nDECLARE remaining int;[\s\S]*?REMEDIATE_ABORT reason=still-dangling[\s\S]*?\\endif/)
  assert.ok(
    body.indexOf('REMEDIATE_ABORT reason=still-dangling') < body.indexOf('\\if :apply_mode\nCOMMIT;'),
    'the guard must run before the COMMIT',
  )
})

test('03 classifies 23503 and 55P03 by name and does not swallow anything else', () => {
  const body = code(pack('03-validate.sql'))
  assert.match(body, /VALIDATE CONSTRAINT fk_sealed_export_stock_prep_binding_live_external_system/)
  assert.match(body, /WHEN foreign_key_violation THEN/)
  assert.match(body, /WHEN lock_not_available THEN/)
  assert.match(body, /'23503'/)
  assert.match(body, /'55P03'/)
  assert.ok(!/WHEN OTHERS/i.test(body), '03 must not use a catch-all handler')
  assert.ok(!/query_canceled/i.test(body), '03 must not trap 57014')
})

test('03 owns its lock_timeout and fails the run when the outcome is not complete', () => {
  const body = code(pack('03-validate.sql'))
  const afterInclude = body.slice(body.indexOf('\\ir _preamble-write.sql'))
  assert.match(afterInclude, /SET lock_timeout = /)
  assert.match(body, /IF s IS DISTINCT FROM 'complete' THEN\s*\n\s*RAISE EXCEPTION/)
})

test('README documents the owner gate, the order, and the inverse of 02', () => {
  const readme = pack('README.md')
  assert.match(readme, /APPLY=1/)
  assert.match(readme, /owner/i)
  assert.match(readme, /SET status = 'ACTIVE'/, 'the inverse SQL must be spelled out')
  assert.match(readme, /zzzz20260926140000/)
})

/** The drift check, factored out so a doctored fixture can be fed to it. */
function assertFixtureReproducesMigration(fixtureText) {
  const ts = read(MIGRATION_TS)
  const upBody = ts.slice(ts.indexOf('export async function up('), ts.indexOf('export async function down('))
  assert.ok(upBody.length > 0, 'could not slice up() out of the migration')
  const FK = 'fk_sealed_export_stock_prep_binding_live_external_system'
  assert.ok(ts.includes(`const LIVE_EXTERNAL_SYSTEM_FK = '${FK}'`), 'the migration constant moved')
  const statements = [...upBody.matchAll(/sql`([\s\S]*?)`\.execute\(db\)/g)]
    .map(m => m[1])
    .map(s =>
      s
        .replace(/\$\{sql\.lit\(LIVE_EXTERNAL_SYSTEM_FK\)\}/g, `'${FK}'`)
        .replace(/\$\{sql\.raw\(LIVE_EXTERNAL_SYSTEM_FK\)\}/g, FK),
    )
    .map(norm)
  assert.equal(statements.length, 3, `up() should hold 3 sql templates, found ${statements.length}`)
  for (const s of statements) {
    assert.ok(!s.includes('${'), `an unsubstituted interpolation survived: ${s}`)
  }
  const fixtureSql = norm(fixtureText)
  for (const s of statements) {
    assert.ok(fixtureSql.includes(s), `migration-up.sql has drifted from the migration; missing statement:\n  ${s}`)
  }
}

test('verify/migration-up.sql still reproduces every statement of the migration up()', () => {
  assertFixtureReproducesMigration(read(path.join(HERE, 'migration-up.sql')))
})

test('the drift check bites: a fixture without NOT VALID, or without the status filter, is rejected', () => {
  const original = read(path.join(HERE, 'migration-up.sql'))
  const noNotValid = original.replace(/\n\s+NOT VALID;/, ';')
  const noStatusFilter = original.replace("(CASE WHEN status = 'ACTIVE' THEN external_system_id END)", '(external_system_id)')
  for (const doctored of [noNotValid, noStatusFilter]) {
    assert.notEqual(doctored, original, 'mutation anchor not found')
    assert.throws(() => assertFixtureReproducesMigration(doctored), /has drifted from the migration/)
  }
})

// ── LAYER 2 — synthetic PostgreSQL ──────────────────────────────────────────

const REQUIRE_DB = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

test('synthetic-PostgreSQL verification (scenarios S1..S11 + mutants PM1..PM7)', async t => {
  if (!process.env.DATABASE_URL) {
    if (REQUIRE_DB) assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset')
    t.skip('SKIPPED LOUDLY: set DATABASE_URL to a THROWAWAY database to run layer 2')
    return
  }
  if (!psqlAvailable()) {
    if (REQUIRE_DB) assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but `psql` is not runnable (set PSQL=…)')
    t.skip('SKIPPED LOUDLY: `psql` not found on PATH (set PSQL=/path/to/psql)')
    return
  }
  const report = verifyAll()
  assert.equal(report.S1.q2.dangling_active, 1)
  assert.equal(report.S1.q3.dangling_by_fk_column, 1)
  assert.equal(report.S10.tenantMismatch, 1)
  assert.ok(report.S11.runsScanned >= 10)
  assert.equal(report.PM1.dangling, 2, 'PM1 must count RETIRED history as dangling')
  assert.equal(report.PM2.aborted, true, 'PM2 must be stopped by the STEP 3 guard')
  assert.equal(report.PM3.committedWithDangling, 1, 'PM3 must commit a table that still dangles')
  assert.equal(report.PM4.red, true)
  assert.equal(report.PM6.drift, 2, 'PM6 must show generation drift on both RETIRED rows')
  assert.equal(report.PM7.red, true, 'PM7 must turn the values-free scan red')
})
