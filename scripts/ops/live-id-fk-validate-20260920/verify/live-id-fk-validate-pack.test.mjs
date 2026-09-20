// ============================================================================
// live-id-fk-validate-pack.test.mjs — `node --test` layer over run-verify.mjs
// ============================================================================
// LAYER 1 (hermetic, no database): static contract checks on the pack —
//   * 01 includes the READ-ONLY preamble and contains no write statement;
//   * 02/03 include the WRITE preamble, which must NOT pin read-only;
//   * 01 computes TOTAL, BY_KIND_TENANT and HIT from ONE `hit` CTE (#5786 F4);
//   * 01 ends with an INVENTORY_RESULT completion statement;
//   * 02's apply gate compares against the exact literal '1' and its default
//     branch is ROLLBACK;
//   * 02 writes the rollback receipt BEFORE it clears connection_id;
//   * 03 classifies 23503 and 55P03 by name, sets a lock_timeout, and does NOT
//     swallow query_canceled or use a catch-all handler;
//   * verify/migration-5896-up.sql still reproduces every sql`…` statement of
//     zzzz20260920120000_data_source_live_id_binding_lock.ts's up() — so the
//     fixture cannot silently drift away from the migration it stands in for.
//
// LAYER 2 (DATABASE_URL-gated): the full synthetic-PostgreSQL verification in
//   run-verify.mjs — scenarios S1..S11 plus mutants M1/M2/M3. Skipped LOUDLY
//   without DATABASE_URL; when METASHEET_REAL_DB_TEST_STEP=1 a missing
//   DATABASE_URL or a missing `psql` FAILS instead of skipping (fail-not-skip,
//   same discipline as scripts/ops/approval-s1-evidence-replay-gate.test.mjs).
//
// The database layer 2 needs is a THROWAWAY, SYNTHETIC one — the harness
// creates and drops its own `h5_fixture_*` schemas. NEVER point it at a real
// database: 02 and 03 are production writes when they are not being run here.
//
//   node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5432/scratch \
//     node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs
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
  'packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts',
)

const read = p => fs.readFileSync(p, 'utf8')
const pack = name => read(path.join(PACK, name))

/** Strip `--` comments so a contract check cannot be satisfied by prose. */
function code(src) {
  return src
    .split(/\r?\n/)
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

test('the read-only preamble pins ON_ERROR_STOP, read-only and both timeouts', () => {
  const pre = pack('_preamble.sql')
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
  assert.ok(
    !/default_transaction_read_only/.test(pre),
    'the write preamble must not pin read-only — 02/03 write by design',
  )
})

test('01 contains no write statement of any kind', () => {
  const body = code(pack('01-inventory.sql'))
  // Matched as statements, not as bare words: `deleted_at` and the string
  // literal `'soft-deleted'` are legitimate content of a read-only file.
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

test('01 computes TOTAL, BY_KIND_TENANT and HIT from ONE shared `hit` CTE (#5786 F4)', () => {
  const body = code(pack('01-inventory.sql'))
  const ctes = body.match(/WITH hit AS \(/g) || []
  assert.equal(ctes.length, 1, 'exactly one `hit` CTE may be defined — two definitions can disagree')
  // All three sections must read it, and TOTAL must not read a base table.
  assert.match(body, /SELECT 'TOTAL'::text[\s\S]*?count\(\*\)::int AS n\s*\n\s*FROM hit/)
  assert.match(body, /SELECT 'BY_KIND_TENANT'[\s\S]*?FROM hit GROUP BY/)
  assert.match(body, /SELECT 'HIT'[\s\S]*?FROM hit\n/)
})

test('01 ends with its INVENTORY_RESULT completion statement', () => {
  const body = code(pack('01-inventory.sql'))
  assert.match(body, /INVENTORY_RESULT file=01-inventory\.sql status=/)
  const tail = body.trimEnd().split(/;\s*$/)[0]
  assert.ok(
    tail.lastIndexOf('INVENTORY_RESULT') > tail.lastIndexOf('ORDER BY CASE section'),
    'the completion line must be the LAST statement, after the inventory query',
  )
})

test('01 uses the FK predicate the constraint itself enforces', () => {
  const body = code(pack('01-inventory.sql'))
  assert.match(body, /es\.connection_id IS NOT NULL/)
  assert.match(body, /NOT EXISTS \(\s*\n\s*SELECT 1 FROM data_sources d WHERE d\.live_id = es\.connection_id/)
})

test('02 gates writing on the exact literal 1 and rolls back by default', () => {
  const body = code(pack('02-remediate.sql'))
  assert.match(body, /\\set apply_mode off/, 'the default must be off before anything is read')
  assert.match(body, /:'APPLY' = '1'/, 'only the exact literal 1 may turn writing on')
  assert.ok(!/:APPLY\b(?!')/.test(body.replace(/:\{\?APPLY\}/g, '')), '02 must not test APPLY as a psql truth value')
  assert.match(body, /\\if :apply_mode\nCOMMIT;[\s\S]*?\\else\nROLLBACK;[\s\S]*?\\endif/)
  assert.match(body, /^BEGIN;$/m, 'the whole remediation must be one explicit transaction')
})

test('02 writes the rollback receipt BEFORE it clears connection_id', () => {
  const body = code(pack('02-remediate.sql'))
  const receipt = body.indexOf("jsonb_set(es.config, '{dataSourceId}'")
  const clear = body.indexOf('SET connection_id = NULL')
  assert.ok(receipt > 0, '02 must write config.dataSourceId')
  assert.ok(clear > 0, '02 must clear connection_id')
  assert.ok(receipt < clear, 'the receipt statement must come first — STEP 2 destroys its only source')
  assert.match(body, /CREATE TEMP TABLE h5_dangling ON COMMIT DROP/, 'both steps must act on one snapshot')
})

test('02 never forges cutover evidence and never deletes a binding', () => {
  const body = code(pack('02-remediate.sql'))
  assert.ok(
    !/legacy_connection_fallback_eligible\s*=/.test(body),
    '02 must not assign legacy_connection_fallback_eligible',
  )
  assert.ok(!/\bDELETE\s+FROM\b/i.test(body), '02 must not delete binding rows')
})

test('02 aborts fail-closed when a row cannot hold a receipt', () => {
  const body = code(pack('02-remediate.sql'))
  assert.match(body, /REMEDIATE_ABORT reason=non-object-config/)
  assert.match(body, /\\if :apply_mode\nDO \$\$/, 'the abort guard runs only when actually applying')
})

test('03 classifies 23503 and 55P03 by name and does not swallow anything else', () => {
  const body = code(pack('03-validate.sql'))
  assert.match(body, /VALIDATE CONSTRAINT fk_integration_external_systems_live_connection_id/)
  assert.match(body, /WHEN foreign_key_violation THEN/)
  assert.match(body, /WHEN lock_not_available THEN/)
  assert.match(body, /'23503'/)
  assert.match(body, /'55P03'/)
  assert.ok(!/WHEN OTHERS/i.test(body), '03 must not use a catch-all handler')
  assert.ok(!/query_canceled/i.test(body), '03 must not trap 57014 — that state is ambiguous, not a diagnosis')
})

test('03 owns its lock_timeout and fails the run when the outcome is not complete', () => {
  const body = code(pack('03-validate.sql'))
  const afterInclude = body.slice(body.indexOf('\\ir _preamble-write.sql'))
  assert.match(afterInclude, /SET lock_timeout = /, '03 must set lock_timeout after the preamble, not rely on it')
  assert.match(body, /IF s IS DISTINCT FROM 'complete' THEN\s*\n\s*RAISE EXCEPTION/)
})

test('README documents the owner gate and the rollback for 02', () => {
  const readme = pack('README.md')
  assert.match(readme, /APPLY=1/)
  assert.match(readme, /owner/i)
  assert.match(readme, /connection_id = NULLIF\(BTRIM\(config->>'dataSourceId'\)/, 'the inverse SQL must be spelled out')
})

/** The drift check, factored out so a doctored fixture can be fed to it. */
function assertFixtureReproducesMigration(fixtureText) {
  const ts = read(MIGRATION_TS)
  const upBody = ts.slice(ts.indexOf('export async function up('), ts.indexOf('export async function down('))
  assert.ok(upBody.length > 0, 'could not slice up() out of the migration')

  const LIVE_FK = 'fk_integration_external_systems_live_connection_id'
  const LEGACY_FK = 'fk_integration_external_systems_connection_id'
  const statements = [...upBody.matchAll(/sql`([\s\S]*?)`\.execute\(db\)/g)]
    .map(m => m[1])
    .map(s =>
      s
        .replace(/\$\{sql\.lit\(LIVE_FK\)\}/g, `'${LIVE_FK}'`)
        .replace(/\$\{sql\.raw\(LIVE_FK\)\}/g, LIVE_FK)
        .replace(/\$\{sql\.lit\(LEGACY_FK\)\}/g, `'${LEGACY_FK}'`)
        .replace(/\$\{sql\.raw\(LEGACY_FK\)\}/g, LEGACY_FK),
    )
    .map(norm)

  assert.equal(statements.length, 4, `up() should hold 4 sql templates, found ${statements.length}`)
  const fixtureSql = norm(fixtureText)
  for (const s of statements) {
    assert.ok(
      fixtureSql.includes(s),
      `migration-5896-up.sql has drifted from the migration; missing statement:\n  ${s}`,
    )
  }
}

test('verify/migration-5896-up.sql still reproduces every statement of #5896 up()', () => {
  assertFixtureReproducesMigration(read(path.join(HERE, 'migration-5896-up.sql')))
})

test('the drift check bites: a fixture that drops the NOT VALID clause is rejected', () => {
  // In-memory mutation of the fixture text only — nothing is written to disk.
  const doctored = read(path.join(HERE, 'migration-5896-up.sql')).replace(
    /\n      NOT VALID;/,
    ';',
  )
  assert.notEqual(doctored, read(path.join(HERE, 'migration-5896-up.sql')), 'mutation anchor not found')
  assert.throws(
    () => assertFixtureReproducesMigration(doctored),
    /has drifted from the migration/,
    'the drift check must reject a fixture that no longer matches up()',
  )
})

// ── LAYER 2 — synthetic PostgreSQL ──────────────────────────────────────────

const REQUIRE_DB = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

test('synthetic-PostgreSQL verification (scenarios S1..S11 + mutants M1/M2/M3)', async t => {
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
  assert.equal(report.S1.total, 2)
  assert.deepEqual(report.S1.hitIds, ['es-dangle-1', 'es-dangle-2'])
  assert.equal(report.S11.absentState, 'absent', 'a missing data_sources row must classify as absent')
  assert.equal(report.S11.total, 3)
  assert.equal(report.M1.total, 3, 'M1 must produce the disagreement the F4 invariant catches')
  assert.equal(report.M1.hits, 2)
  assert.equal(report.M2.receipt, '<null>', 'M2 must lose the rollback receipt')
  assert.equal(report.M3.timedOut, true, 'M3 must hang instead of classifying 55P03')
})
