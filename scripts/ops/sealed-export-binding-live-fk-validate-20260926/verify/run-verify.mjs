#!/usr/bin/env node
// ============================================================================
// run-verify.mjs — synthetic-PostgreSQL verification of the 073 live FK pack
// ============================================================================
// WHAT IT PROVES (all on throwaway `s073fx_*` schemas built from the REAL
// SQL migrations 057 + 068..075 and holding only obviously fake `fx-` rows —
// this harness must NEVER be pointed at a production database; the pack's own
// 02/03 are owner-gated production writes when they are not being run here):
//
//   S1  01-inventory.sql on the migrated fixture: exactly one ACTIVE binding,
//       dangling; two RETIRED (one at an absent system); one in-flight run on
//       the dangling binding — and Q3's count THROUGH the generated column
//       agrees with Q2's base-column count, with zero generation drift.
//   S2  02-remediate.sql with no APPLY is a DRY RUN: it reports what it would
//       do, ends REMEDIATE_TX=rolled-back, and the binding is still ACTIVE.
//   S3  Only the exact literal `-v APPLY=1` writes. `APPLY=true`, `yes`, `0`
//       and `on` all stay dry runs.
//   S4  02 with APPLY=1 retires the dangling binding and nothing else: its
//       external_system_id is unchanged, the RETIRED rows and the runs are
//       untouched, and 01 then reports dangling_active=0.
//   S5  03-validate.sql then succeeds; convalidated flips to true; a second run
//       is a no-op (already_validated=yes).
//   S6  After validation an ACTIVE binding at an absent system is refused by
//       the database (23503); a RETIRED one is history and accepted.
//   S7  03 run BEFORE remediation: `status=failed sqlstate=23503`, non-zero
//       exit, constraint still NOT VALID.
//   S8  03 run while another session holds ACCESS EXCLUSIVE on the bindings:
//       `status=failed sqlstate=55P03` inside lock_timeout.
//   S9  BEFORE the migration: 01 still completes (the census is spelled over
//       base columns) with live_column=missing and the same dangling count;
//       02 refuses (REMEDIATE_ABORT reason=missing-constraint) and writes
//       nothing.
//   S10 A tenant-MISMATCHED ACTIVE binding (system exists under another
//       tenant) is reported as tenant_mismatch_active, is NOT a VALIDATE
//       blocker, and the database refuses to delete its system (23503).
//   S11 Values-free: nothing any pack file printed in S1..S10 contains a
//       fixture value (`fx-` ids / tenants).
//
//   PM1 MUTANT of 01 whose dangling count drops the status filter: RETIRED
//       history at an absent system is counted as dangling; S1 goes red and the
//       Q2/Q3 agreement goes red.
//   PM2 MUTANT of 02 without STEP 1: APPLY=1 aborts fail-closed
//       (REMEDIATE_ABORT reason=still-dangling) and commits nothing — S4 red,
//       and the STEP 3 guard is what stopped it.
//   PM3 MUTANT of 02 without STEP 1 AND without the STEP 3 guard: APPLY=1
//       COMMITS a table that still holds the dangling row — the failure the
//       guard exists to prevent.
//   PM4 MUTANT of 02 whose apply gate also accepts `true`: S3 goes red.
//   PM5 MUTANT of 03 with lock_timeout disabled: under S8's contention no
//       VALIDATE_RESULT line appears before the harness deadline.
//   PM6 MUTANT of the MIGRATION (verify/migration-up.sql) whose generated
//       column drops the status filter: 01's Q3 reports generation drift and a
//       disagreeing FK-column count (S1 red), and 03 fails 23503 even after 02
//       — RETIRED history would block VALIDATE and keep systems undeletable.
//   PM7 MUTANT of 01 that also prints the binding ids: S11's values-free scan
//       goes red on its output — the scan is not vacuous.
//
// EVERY MUTANT IS IN MEMORY. Mutated SQL is piped to psql on stdin with cwd set
// to the pack directory (so `\ir` still resolves); no mutated file is written.
//
// USAGE
//   DATABASE_URL=postgresql://<user>@<host>:<port>/<throwaway-db> node run-verify.mjs
//   (PSQL=/path/to/psql if the binary is not on PATH)
// ============================================================================

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
const REPO = path.resolve(PACK, '..', '..', '..')
const MIGRATIONS_DIR = path.join(REPO, 'packages', 'core-backend', 'migrations')
export const PSQL = process.env.PSQL || 'psql'

// The REAL SQL migrations the 073 bindings table and its neighbours come from.
// 073 is a pinned input of the frozen S6-A package and never changes in place.
// Neither role GUC is set, so 073/074/075 install their "latent" shape (no
// grants) — the pack does not depend on the S6-A roles.
export const BASE_MIGRATIONS = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
  '074_repair_sealed_export_runtime_authority_privileges.sql',
  '075_grant_sealed_export_runtime_authority_row_lock.sql',
]

const LIVE_FK = 'fk_sealed_export_stock_prep_binding_live_external_system'

// Every value planted in a fixture starts with this — S11 greps for it.
export const FIXTURE_VALUE_MARK = 'fx-'

// PGCLIENTENCODING is pinned because every file here is UTF-8 while psql
// otherwise derives client_encoding from the console code page (GBK on a
// Chinese-locale Windows host). lc_messages may still be Chinese: every
// assertion here reads SQLSTATEs / fixed tokens, never server prose.
const BASE_ENV = { ...process.env, PGCLIENTENCODING: 'UTF8' }

export function psqlAvailable() {
  return spawnSync(PSQL, ['--version'], { encoding: 'utf8' }).status === 0
}

// Every pack-file run is recorded so S11 can scan everything the pack printed.
const printed = []

function psqlRun(args, { input, cwd, env, timeout } = {}) {
  const r = spawnSync(PSQL, ['-d', process.env.DATABASE_URL, '--no-psqlrc', ...args], {
    encoding: 'utf8',
    input,
    cwd,
    timeout,
    env: env ? { ...BASE_ENV, ...env } : BASE_ENV,
  })
  return {
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM',
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  }
}

export function scalar(sql) {
  const r = psqlRun(['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout.trim()
}

export function exec(sql) {
  const r = psqlRun(['-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout
}

/** Run one of the pack's files exactly the way README.md says to. */
export function runPackFile(name, schema, extraVars = [], opts = {}) {
  const r = psqlRun(['-A', '-v', `schema=${schema}`, ...extraVars, '-f', path.join(PACK, name)], opts)
  printed.push({ what: name, text: `${r.stdout}\n${r.stderr}` })
  return r
}

/** Run MUTATED pack source from stdin; cwd = PACK so `\ir` still resolves. */
export function runPackSource(src, schema, extraVars = [], opts = {}) {
  return psqlRun(['-A', '-v', `schema=${schema}`, ...extraVars], { ...opts, input: src, cwd: PACK })
}

export function packSource(name) {
  return fs.readFileSync(path.join(PACK, name), 'utf8').replace(/\r\n/g, '\n')
}

export function verifySource(name) {
  return fs.readFileSync(path.join(HERE, name), 'utf8').replace(/\r\n/g, '\n')
}

// ── output parsing ──────────────────────────────────────────────────────────

/** Split `psql -A` output into result blocks using the `(N rows)` footers. */
export function parseBlocks(stdout) {
  const blocks = []
  let buf = []
  for (const raw of stdout.split(/\r?\n/)) {
    const lineText = raw.trimEnd()
    const m = /^\((\d+) (rows?|行记录)\)$/.exec(lineText)
    if (m) {
      const n = Number(m[1])
      const slice = buf.slice(buf.length - (n + 1))
      blocks.push({ header: slice[0], rows: slice.slice(1) })
      buf = []
      continue
    }
    buf.push(lineText)
  }
  return blocks
}

export function block(stdout, header) {
  const found = parseBlocks(stdout).filter(b => b.header === header)
  if (found.length === 0) throw new Error(`no result block with header "${header}" in:\n${stdout}`)
  return found[0]
}

/** A single-row block as { column: number|string }. */
export function rowOf(stdout, header) {
  const b = block(stdout, header)
  assert.equal(b.rows.length, 1, `block "${header}" must have exactly one row`)
  const cols = header.split('|')
  const vals = b.rows[0].split('|')
  return Object.fromEntries(cols.map((c, i) => [c, /^-?\d+$/.test(vals[i]) ? Number(vals[i]) : vals[i]]))
}

export function line(stdout, prefix) {
  return (
    stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(l => l.startsWith(prefix)) || null
  )
}

export const Q2 =
  'active_total|dangling_active|tenant_mismatch_active|retired_total|retired_system_absent|inflight_runs_on_dangling'
export const Q3 = 'generated_drift|dangling_by_fk_column'
const STEP0 = 'step|dangling|inflight_runs'
const STEPN = 'step|rows'

function stepsByName(stdout) {
  const out = {}
  for (const b of parseBlocks(stdout)) {
    if (b.header !== STEPN) continue
    const [name, rows] = b.rows[0].split('|')
    out[name] = Number(rows)
  }
  return out
}

// ── fixture lifecycle ───────────────────────────────────────────────────────

const BINDING_COLUMNS = `binding_id, tenant_id, workspace_id, external_system_id, object_key, relation_id,
  table_ref, approved_config_version_id, binding_version, config_content_key, canonical_object_version,
  tenant_domain_binding, system_content_key, role_binding_fingerprint, status, expires_at`

function bindingValues(id, system, status, tenant = 'fx-t1') {
  return `('${id}', '${tenant}', NULL, '${system}', 'fx-object', 'sqlserver.relation.rowid_payload.v1',
    'fx-table', 'fx-acv', '${id}-v', 'fx-cck', 'fx-cov', 'fx-tdb', 'fx-sck', 'fx-rbf', '${status}',
    NOW() + interval '1 day')`
}

/** Main fixture rows — planted BEFORE the migration (the only way a dangling ACTIVE row can honestly exist). */
export const MAIN_ROWS = `
  INSERT INTO integration_external_systems (id, tenant_id, name, kind, role)
  VALUES ('fx-sys-live', 'fx-t1', 'fx-sys-live', 'erp:k3-wise-sqlserver', 'source');
  INSERT INTO integration_sealed_export_stock_prep_bindings (${BINDING_COLUMNS}) VALUES
    ${bindingValues('fx-b-dangling', 'fx-sys-gone', 'ACTIVE')},
    ${bindingValues('fx-b-ret-gone', 'fx-sys-gone-2', 'RETIRED')},
    ${bindingValues('fx-b-ret-live', 'fx-sys-live', 'RETIRED')};
  INSERT INTO integration_sealed_export_stock_prep_runs
    (run_id, tenant_id, workspace_id, operation_id, actor_id, binding_id, status, failure_reason) VALUES
    ('fx-run-inflight', 'fx-t1', NULL, 'fx-op-1', 'fx-actor', 'fx-b-dangling', 'CAPTURING', NULL),
    ('fx-run-failed', 'fx-t1', NULL, 'fx-op-2', 'fx-actor', 'fx-b-dangling', 'CAPTURE_FAILED', 'fx-reason');`

/** Tenant-mismatch fixture: the ACTIVE binding's system exists, under another tenant. */
export const MISMATCH_ROWS = `
  INSERT INTO integration_external_systems (id, tenant_id, name, kind, role)
  VALUES ('fx-sys-other', 'fx-t2', 'fx-sys-other', 'erp:k3-wise-sqlserver', 'source');
  INSERT INTO integration_sealed_export_stock_prep_bindings (${BINDING_COLUMNS}) VALUES
    ${bindingValues('fx-b-mismatch', 'fx-sys-other', 'ACTIVE', 'fx-t1')};`

/**
 * A throwaway schema: the real SQL migrations, then `rows` (pre-migration),
 * then — unless `migrate: false` — the migration's up() SQL (or a mutant of it).
 */
export function createFixture({ migrate = true, rows = MAIN_ROWS, migrationSql = null } = {}) {
  const schema = `s073fx_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE SCHEMA "${schema}"`)
  try {
    for (const name of BASE_MIGRATIONS) {
      const r = psqlRun(['-v', 'ON_ERROR_STOP=1', '-q', '-c', `SET search_path = "${schema}"`, '-f', path.join(MIGRATIONS_DIR, name)])
      if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr}`)
    }
    if (rows) exec(`SET search_path = "${schema}"; ${rows}`)
    if (migrate) {
      const up = migrationSql ?? verifySource('migration-up.sql')
      // `-f -`: with a `-c` present psql would otherwise never read stdin.
      const r = psqlRun(['-v', 'ON_ERROR_STOP=1', '-q', '-c', `SET search_path = "${schema}"`, '-f', '-'], { input: up })
      if (r.status !== 0) throw new Error(`migration-up failed: ${r.stderr}`)
    }
  } catch (error) {
    dropFixture(schema)
    throw error
  }
  return schema
}

export function dropFixture(schema) {
  try {
    exec(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name IN ('s073fx-mutant', 's073fx-lockholder') AND pid <> pg_backend_pid()`,
    )
  } catch { /* best effort */ }
  try { exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* best effort */ }
}

function q(schema, sql) {
  return scalar(`SET search_path = "${schema}"; ${sql}`)
}

export function danglingCount(schema) {
  return Number(q(schema, `SELECT count(*) FROM integration_sealed_export_stock_prep_bindings b
     WHERE b.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM integration_external_systems s WHERE s.id = b.external_system_id)`))
}

export function statusOf(schema, bindingId) {
  return q(schema, `SELECT coalesce(status, '<none>') FROM integration_sealed_export_stock_prep_bindings WHERE binding_id = '${bindingId}'`)
}

export function fkValidated(schema) {
  return q(schema, `SELECT coalesce((SELECT convalidated::text FROM pg_constraint
                      WHERE conname = '${LIVE_FK}'
                        AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')), '<missing>')`)
}

/** Run a statement and report its SQLSTATE (read by SQLSTATE, never by localised prose). */
export function sqlstateOf(schema, statement) {
  const r = psqlRun([
    '-t', '-A', '-q', '-c',
    `SET search_path = "${schema}";
     DO $$
     BEGIN
       ${statement};
       RAISE NOTICE 'S073FX_RESULT=ok';
     EXCEPTION WHEN OTHERS THEN
       RAISE NOTICE 'S073FX_RESULT=%', SQLSTATE;
     END $$;`,
  ])
  const m = /S073FX_RESULT=(\w+)/.exec(`${r.stdout}\n${r.stderr}`)
  assert.ok(m, `no S073FX_RESULT from probe:\n${r.stdout}\n${r.stderr}`)
  return m[1]
}

/** Hold ACCESS EXCLUSIVE on the fixture's bindings table for `seconds`. */
export function holdExclusiveLock(schema, seconds) {
  const child = spawn(PSQL, ['-d', process.env.DATABASE_URL, '--no-psqlrc', '-q'], {
    env: { ...BASE_ENV, PGAPPNAME: 's073fx-lockholder' },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  child.stdin.end(
    `SET search_path = "${schema}";
     BEGIN;
     LOCK TABLE integration_sealed_export_stock_prep_bindings IN ACCESS EXCLUSIVE MODE;
     SELECT pg_sleep(${seconds});
     COMMIT;\n`,
  )
  return {
    release() {
      try { child.kill() } catch { /* best effort */ }
      try {
        exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE application_name = 's073fx-lockholder' AND pid <> pg_backend_pid()`)
      } catch { /* best effort */ }
    },
  }
}

function waitForLock(deadlineMs = 10_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const held = scalar(`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
                          WHERE a.application_name = 's073fx-lockholder'
                            AND l.mode = 'AccessExclusiveLock' AND l.granted`)
    if (Number(held) > 0) return true
    sleepSync(200)
  }
  return false
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ── mutants (in memory only) ────────────────────────────────────────────────

/** PM1 — 01's dangling count no longer filters on status. */
export function mutate01DropStatusFilter(src) {
  const re = /count\(\*\) FILTER \(WHERE active AND NOT system_present\)::int(\s+)AS dangling_active/
  assert.match(src, re, 'PM1 anchor not found in 01-inventory.sql')
  return src.replace(re, 'count(*) FILTER (WHERE NOT system_present)::int$1AS dangling_active')
}

const STEP1_RE = /WITH upd AS \(\n  UPDATE integration_sealed_export_stock_prep_bindings b\n     SET status = 'RETIRED'[\s\S]*?FROM upd;/

/** PM2 — 02 without STEP 1 (the retire). */
export function mutate02DropRetire(src) {
  assert.match(src, STEP1_RE, 'PM2 anchor (STEP 1 statement) not found in 02-remediate.sql')
  return src.replace(STEP1_RE, "SELECT 'STEP1_RETIRED' AS step, 0 AS rows;")
}

/** PM3 — PM2 and, on top, without the STEP 3 fail-closed guard. */
export function mutate02DropRetireAndGuard(src) {
  const guard = /\\if :apply_mode\nDO \$\$\nDECLARE remaining int;[\s\S]*?END \$\$;\n\\endif\n/
  assert.match(src, guard, 'PM3 anchor (STEP 3 guard) not found in 02-remediate.sql')
  return mutate02DropRetire(src).replace(guard, '')
}

/** PM4 — 02's apply gate also accepts `true`. */
export function mutate02LooseGate(src) {
  const anchor = ":'APPLY' = '1'"
  assert.ok(src.includes(anchor), 'PM4 anchor not found in 02-remediate.sql')
  return src.replace(anchor, ":'APPLY' IN ('1', 'true')")
}

/** PM5 — 03 without an effective lock timeout (0 = disabled; deleting 03's SET would be masked by the preamble). */
export function mutate03DropLockTimeout(src) {
  const marker = "\\echo '-- effective lock_timeout for the VALIDATE below:'"
  assert.ok(src.includes(marker), 'PM5 anchor not found in 03-validate.sql')
  return src.replace(marker, `SET lock_timeout = 0;\n${marker}`)
}

/** PM6 — the MIGRATION's generated column without the status filter. */
export function mutateMigrationDropStatusFilter(src) {
  const anchor = "GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN external_system_id END) STORED"
  assert.ok(src.includes(anchor), 'PM6 anchor not found in migration-up.sql')
  return src.replace(anchor, 'GENERATED ALWAYS AS (external_system_id) STORED')
}

// ── the checks ──────────────────────────────────────────────────────────────

function inventory(schema, source = null) {
  const out = source
    ? runPackSource(source, schema, [], { env: { PGAPPNAME: 's073fx-mutant' } })
    : runPackFile('01-inventory.sql', schema)
  assert.equal(out.status, 0, `01 exited ${out.status}: ${out.stderr}`)
  return out
}

export function checkInventory(schema) {
  const out = inventory(schema)
  const q2 = rowOf(out.stdout, Q2)
  assert.deepEqual(q2, {
    active_total: 1,
    dangling_active: 1,
    tenant_mismatch_active: 0,
    retired_total: 2,
    retired_system_absent: 1,
    inflight_runs_on_dangling: 1,
  }, 'S1: the census of the main fixture')
  const q3 = rowOf(out.stdout, Q3)
  assert.equal(q3.generated_drift, 0, 'S1: the generated column must be exactly CASE WHEN status=ACTIVE')
  assert.equal(q3.dangling_by_fk_column, q2.dangling_active, 'S1: Q3 (through the FK column) must agree with Q2')
  assert.match(line(out.stdout, 'INVENTORY_RESULT') || '', /status=complete live_column=present live_fk=present validated=no$/)
  return { q2, q3 }
}

export function checkDryRun(schema) {
  const out = runPackFile('02-remediate.sql', schema)
  assert.equal(out.status, 0, `02 dry run exited ${out.status}: ${out.stderr}`)
  assert.deepEqual(rowOf(out.stdout, STEP0), { step: 'STEP0_SNAPSHOT', dangling: 1, inflight_runs: 1 })
  const steps = stepsByName(out.stdout)
  assert.equal(steps.STEP1_RETIRED, 1, 'dry run reports the retire it would do')
  assert.equal(steps.STEP2_REMAINING_DANGLING, 0)
  assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=dry-run dangling_before=1 retired=1 remaining=0$/)
  assert.ok(line(out.stdout, 'REMEDIATE_TX=rolled-back'), 'a dry run must end rolled back')
  assert.equal(statusOf(schema, 'fx-b-dangling'), 'ACTIVE', 'S2: a dry run must not retire anything')
  assert.equal(danglingCount(schema), 1)
  return true
}

export function checkApplyGate(schema, source = null) {
  for (const v of ['APPLY=true', 'APPLY=yes', 'APPLY=0', 'APPLY=on']) {
    const out = source
      ? runPackSource(source, schema, ['-v', v], { env: { PGAPPNAME: 's073fx-mutant' } })
      : runPackFile('02-remediate.sql', schema, ['-v', v])
    assert.equal(out.status, 0, `02 with -v ${v} exited ${out.status}: ${out.stderr}`)
    assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=dry-run/, `-v ${v} must stay a dry run`)
    assert.ok(line(out.stdout, 'REMEDIATE_TX=rolled-back'), `-v ${v} must roll back`)
    assert.equal(danglingCount(schema), 1, `-v ${v} must not change the table`)
  }
  return true
}

export function checkApply(schema) {
  const runsBefore = q(schema, `SELECT string_agg(run_id || ':' || status, ',' ORDER BY run_id) FROM integration_sealed_export_stock_prep_runs`)
  const out = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
  assert.equal(out.status, 0, `02 APPLY exited ${out.status}: ${out.stderr}`)
  assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=apply dangling_before=1 retired=1 remaining=0$/)
  assert.ok(line(out.stdout, 'REMEDIATE_TX=committed'))
  assert.equal(danglingCount(schema), 0, 'S4: APPLY must leave zero dangling ACTIVE bindings')
  assert.equal(statusOf(schema, 'fx-b-dangling'), 'RETIRED')
  assert.equal(
    q(schema, `SELECT external_system_id = 'fx-sys-gone' FROM integration_sealed_export_stock_prep_bindings WHERE binding_id = 'fx-b-dangling'`),
    't',
    'S4: the retired row keeps its (immutable) system anchor',
  )
  assert.equal(statusOf(schema, 'fx-b-ret-gone'), 'RETIRED')
  assert.equal(statusOf(schema, 'fx-b-ret-live'), 'RETIRED')
  assert.equal(
    q(schema, `SELECT string_agg(run_id || ':' || status, ',' ORDER BY run_id) FROM integration_sealed_export_stock_prep_runs`),
    runsBefore,
    'S4: runs are not touched',
  )
  const after = rowOf(inventory(schema).stdout, Q2)
  assert.equal(after.dangling_active, 0, 'S4: 01 must report zero after APPLY')
  assert.equal(after.retired_total, 3)
  return true
}

export function checkValidate(schema) {
  const out = runPackFile('03-validate.sql', schema)
  assert.equal(out.status, 0, `03 exited ${out.status}: ${out.stderr}`)
  assert.match(line(out.stdout, 'VALIDATE_RESULT') || '', /status=complete sqlstate=00000 detail=already_validated=no validated_now=yes/)
  assert.equal(fkValidated(schema), 'true', 'pg_constraint.convalidated must flip')
  const again = runPackFile('03-validate.sql', schema)
  assert.equal(again.status, 0)
  assert.match(line(again.stdout, 'VALIDATE_RESULT') || '', /status=complete .*already_validated=yes/)
  return true
}

export function checkNewDanglingRefused(schema) {
  const active = sqlstateOf(schema, `INSERT INTO integration_sealed_export_stock_prep_bindings (${BINDING_COLUMNS})
    VALUES ${bindingValues('fx-b-new-active', 'fx-sys-gone', 'ACTIVE')}`)
  assert.equal(active, '23503', 'S6: an ACTIVE binding at an absent system must be refused by the database')
  const retired = sqlstateOf(schema, `INSERT INTO integration_sealed_export_stock_prep_bindings (${BINDING_COLUMNS})
    VALUES ${bindingValues('fx-b-new-retired', 'fx-sys-gone', 'RETIRED')}`)
  assert.equal(retired, 'ok', 'S6: a RETIRED binding is history and must be accepted')
  return true
}

export function checkValidateFailsOnDangling(schema) {
  const out = runPackFile('03-validate.sql', schema)
  assert.notEqual(out.status, 0, '03 must exit non-zero when it could not validate')
  assert.match(line(out.stdout, 'VALIDATE_RESULT') || '', /status=failed sqlstate=23503 detail=reason=dangling-rows/)
  assert.equal(fkValidated(schema), 'false', 'a failed VALIDATE must leave the constraint NOT VALID')
  return true
}

function retireEverything(schema) {
  exec(`SET search_path = "${schema}"; UPDATE integration_sealed_export_stock_prep_bindings SET status = 'RETIRED' WHERE status = 'ACTIVE'`)
}

export function checkLockTimeoutClassified(schema) {
  retireEverything(schema) // the ONLY thing that can fail now is the lock
  const holder = holdExclusiveLock(schema, 30)
  try {
    assert.ok(waitForLock(), 'lock holder never acquired ACCESS EXCLUSIVE')
    const started = Date.now()
    const out = runPackFile('03-validate.sql', schema, [], { timeout: 40_000 })
    const elapsed = Date.now() - started
    assert.notEqual(out.status, 0, '03 must exit non-zero on a lock timeout')
    assert.match(line(out.stdout, 'VALIDATE_RESULT') || '', /status=failed sqlstate=55P03 detail=reason=lock-timeout/)
    assert.ok(elapsed < 30_000, `03 must give up inside lock_timeout, took ${elapsed}ms`)
    return { elapsed }
  } finally {
    holder.release()
  }
}

export function checkPreMigration() {
  const schema = createFixture({ migrate: false })
  try {
    const out = inventory(schema)
    assert.equal(rowOf(out.stdout, Q2).dangling_active, 1, 'S9: the census must work before the migration')
    assert.ok(!parseBlocks(out.stdout).some(b => b.header === Q3), 'S9: no Q3 block without the generated column')
    assert.match(line(out.stdout, 'INVENTORY_RESULT') || '', /status=complete live_column=missing live_fk=missing validated=no$/)
    const remediate = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
    assert.notEqual(remediate.status, 0, 'S9: 02 must refuse without the FK')
    assert.match(`${remediate.stdout}\n${remediate.stderr}`, /REMEDIATE_ABORT reason=missing-constraint/)
    assert.equal(statusOf(schema, 'fx-b-dangling'), 'ACTIVE', 'S9: a refused 02 writes nothing')
    return true
  } finally {
    dropFixture(schema)
  }
}

export function checkTenantMismatch() {
  const schema = createFixture({ rows: MISMATCH_ROWS })
  try {
    const q2 = rowOf(inventory(schema).stdout, Q2)
    assert.equal(q2.active_total, 1)
    assert.equal(q2.dangling_active, 0, 'S10: a system that EXISTS is not dangling, whatever its tenant')
    assert.equal(q2.tenant_mismatch_active, 1, 'S10: the tenant mismatch is reported')
    const validated = runPackFile('03-validate.sql', schema)
    assert.equal(validated.status, 0, `S10: 03 exited ${validated.status}: ${validated.stderr}`)
    assert.equal(fkValidated(schema), 'true', 'S10: a tenant mismatch is not a VALIDATE blocker')
    assert.equal(
      sqlstateOf(schema, `DELETE FROM integration_external_systems WHERE id = 'fx-sys-other'`),
      '23503',
      'S10: the database refuses to delete a system a (tenant-mismatched) ACTIVE binding names',
    )
    return { tenantMismatch: q2.tenant_mismatch_active }
  } finally {
    dropFixture(schema)
  }
}

/** The S11 predicate, factored out so PM7 can prove it bites. */
export function assertValuesFree(runs) {
  for (const { what, text } of runs) {
    assert.ok(!text.includes(FIXTURE_VALUE_MARK), `S11: ${what} printed a fixture value`)
  }
}

export function checkValuesFree() {
  assert.ok(printed.length >= 10, `S11: expected the S1..S10 pack runs to be recorded, got ${printed.length}`)
  assertValuesFree(printed)
  return { runsScanned: printed.length }
}

// ── mutation evidence ───────────────────────────────────────────────────────

export function mutantPM1() {
  const schema = createFixture()
  try {
    const out = inventory(schema, mutate01DropStatusFilter(packSource('01-inventory.sql')))
    const q2 = rowOf(out.stdout, Q2)
    const q3 = rowOf(out.stdout, Q3)
    assert.equal(q2.dangling_active, 2, 'PM1 counts RETIRED history as dangling')
    assert.throws(() => assert.equal(q2.dangling_active, 1), 'S1 must go red against PM1')
    assert.throws(() => assert.equal(q3.dangling_by_fk_column, q2.dangling_active), 'the Q2/Q3 agreement must go red against PM1')
    return { dangling: q2.dangling_active, fkColumn: q3.dangling_by_fk_column }
  } finally {
    dropFixture(schema)
  }
}

export function mutantPM2() {
  const schema = createFixture()
  try {
    const out = runPackSource(mutate02DropRetire(packSource('02-remediate.sql')), schema, ['-v', 'APPLY=1'], {
      env: { PGAPPNAME: 's073fx-mutant' },
    })
    assert.notEqual(out.status, 0, 'PM2: the STEP 3 guard must abort a remediation that left a dangling row')
    assert.match(`${out.stdout}\n${out.stderr}`, /REMEDIATE_ABORT reason=still-dangling rows=1/)
    assert.equal(statusOf(schema, 'fx-b-dangling'), 'ACTIVE', 'PM2: nothing committed')
    assert.throws(() => assert.equal(danglingCount(schema), 0), 'S4 must go red against PM2')
    return { aborted: true }
  } finally {
    dropFixture(schema)
  }
}

export function mutantPM3() {
  const schema = createFixture()
  try {
    const out = runPackSource(mutate02DropRetireAndGuard(packSource('02-remediate.sql')), schema, ['-v', 'APPLY=1'], {
      env: { PGAPPNAME: 's073fx-mutant' },
    })
    assert.equal(out.status, 0, `PM3 exited ${out.status}: ${out.stderr}`)
    assert.ok(line(out.stdout, 'REMEDIATE_TX=committed'), 'PM3 commits silently — that is the defect')
    assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /remaining=1$/)
    return { committedWithDangling: danglingCount(schema) }
  } finally {
    dropFixture(schema)
  }
}

export function mutantPM4() {
  const schema = createFixture()
  try {
    const src = mutate02LooseGate(packSource('02-remediate.sql'))
    assert.throws(() => checkApplyGate(schema, src), /must stay a dry run|must roll back|must not change/, 'S3 must go red against PM4')
    return { red: true }
  } finally {
    dropFixture(schema)
  }
}

export function mutantPM5() {
  const schema = createFixture()
  try {
    retireEverything(schema)
    const holder = holdExclusiveLock(schema, 30)
    try {
      assert.ok(waitForLock(), 'lock holder never acquired ACCESS EXCLUSIVE')
      const out = runPackSource(mutate03DropLockTimeout(packSource('03-validate.sql')), schema, [], {
        timeout: 12_000,
        env: { PGAPPNAME: 's073fx-mutant' },
      })
      assert.ok(out.timedOut || out.status !== 0, 'PM5 must not succeed under contention')
      assert.equal(line(out.stdout, 'VALIDATE_RESULT'), null, 'PM5 produces no classified outcome — it is still waiting')
      return { timedOut: out.timedOut }
    } finally {
      holder.release()
    }
  } finally {
    dropFixture(schema)
  }
}

export function mutantPM6() {
  const schema = createFixture({ migrationSql: mutateMigrationDropStatusFilter(verifySource('migration-up.sql')) })
  try {
    const out = inventory(schema)
    const q2 = rowOf(out.stdout, Q2)
    const q3 = rowOf(out.stdout, Q3)
    assert.equal(q3.generated_drift, 2, 'PM6: both RETIRED rows carry a key they must not carry')
    assert.equal(q3.dangling_by_fk_column, 2, 'PM6: the FK sees RETIRED history at an absent system as dangling')
    assert.throws(() => assert.equal(q3.generated_drift, 0), 'S1 must go red against PM6')
    const apply = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
    assert.equal(apply.status, 0, `PM6 02 exited ${apply.status}: ${apply.stderr}`)
    const validated = runPackFile('03-validate.sql', schema)
    assert.notEqual(validated.status, 0, 'PM6: RETIRED history still blocks VALIDATE')
    assert.match(line(validated.stdout, 'VALIDATE_RESULT') || '', /status=failed sqlstate=23503/)
    return { drift: q3.generated_drift, fkColumn: q3.dangling_by_fk_column, danglingQ2: q2.dangling_active }
  } finally {
    dropFixture(schema)
  }
}

/** PM7 — 01 that also prints the binding ids. */
export function mutate01LeakIds(src) {
  const anchor = '-- ── COMPLETENESS RESULT'
  assert.ok(src.includes(anchor), 'PM7 anchor not found in 01-inventory.sql')
  return src.replace(anchor, `SELECT binding_id FROM integration_sealed_export_stock_prep_bindings;\n${anchor}`)
}

export function mutantPM7() {
  const schema = createFixture()
  try {
    const out = inventory(schema, mutate01LeakIds(packSource('01-inventory.sql')))
    const runs = [{ what: 'PM7 01-inventory.sql', text: `${out.stdout}\n${out.stderr}` }]
    assert.throws(() => assertValuesFree(runs), /printed a fixture value/, 'S11 must go red against PM7')
    return { red: true }
  } finally {
    dropFixture(schema)
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export function verifyAll() {
  printed.length = 0
  const report = {}

  const main = createFixture()
  try {
    report.S1 = checkInventory(main)
    report.S2 = checkDryRun(main)
    report.S3 = checkApplyGate(main)
    report.S4 = checkApply(main)
    report.S5 = checkValidate(main)
    report.S6 = checkNewDanglingRefused(main)
  } finally {
    dropFixture(main)
  }

  const failing = createFixture()
  try {
    report.S7 = checkValidateFailsOnDangling(failing)
  } finally {
    dropFixture(failing)
  }

  const locked = createFixture()
  try {
    report.S8 = checkLockTimeoutClassified(locked)
  } finally {
    dropFixture(locked)
  }

  report.S9 = checkPreMigration()
  report.S10 = checkTenantMismatch()
  report.S11 = checkValuesFree()

  report.PM1 = mutantPM1()
  report.PM2 = mutantPM2()
  report.PM3 = mutantPM3()
  report.PM4 = mutantPM4()
  report.PM5 = mutantPM5()
  report.PM6 = mutantPM6()
  report.PM7 = mutantPM7()
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (point it at a THROWAWAY database).')
    process.exit(2)
  }
  console.log(JSON.stringify(verifyAll(), null, 2))
  console.log('OK')
}
