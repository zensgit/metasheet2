#!/usr/bin/env node
// ============================================================================
// run-verify.mjs — synthetic-PostgreSQL verification of the live_id FK pack
// ============================================================================
// WHAT IT PROVES (all on throwaway `h5_fixture_*` schemas full of obviously
// fake ids — this harness must NEVER be pointed at a production database, and
// the pack's own 02/03 are owner-gated production writes when they are not
// being run here):
//
//   S1  01-inventory.sql finds exactly the two planted dangling bindings, not
//       the healthy one, classifies both as target_state=soft-deleted, and its
//       TOTAL equals the number of HIT rows (the #5786 F4 invariant).
//   S2  02-remediate.sql with no APPLY is a DRY RUN: it reports what it would
//       do, ends REMEDIATE_TX=rolled-back, and the table still holds 2 dangling
//       rows with no receipt written.
//   S3  Only the exact literal `-v APPLY=1` writes. `APPLY=true`, `APPLY=yes`
//       and `APPLY=0` all stay dry runs.
//   S4  02 with APPLY=1 clears both pointers, writes `config.dataSourceId` as
//       the rollback receipt for the canonical-shaped row, leaves the
//       already-stamped legacy row's config alone, and does not touch the
//       healthy binding.
//   S5  03-validate.sql then succeeds; pg_constraint.convalidated flips to true.
//   S6  After validation a NEW binding pointing at a soft-deleted source is
//       refused by the database with SQLSTATE 23503.
//   S7  03 run BEFORE remediation classifies the failure as
//       `status=failed sqlstate=23503` and exits non-zero.
//   S8  03 run while another session holds ACCESS EXCLUSIVE classifies the
//       failure as `status=failed sqlstate=55P03` within lock_timeout.
//   S9  A binding whose `config` is not a JSON object is reported as `blocked`
//       and makes APPLY=1 abort (fail-closed) instead of half-cleaning.
//   S10 Against a database where #5896's migration has NOT run, 01 reports
//       `status=incomplete reason=missing-column:data_sources.live_id` — never
//       a zero.
//   S11 A binding whose target row is ABSENT from data_sources (not merely
//       soft-deleted) is classified `target_state=absent`, remediated, and
//       validated through — with the F4 invariant holding on a mixed set.
//
//   M1  MUTANT of 01 whose TOTAL is computed from its own predicate instead of
//       the shared `hit` CTE: TOTAL becomes 3 while 2 HIT rows are listed, and
//       S1's `TOTAL == |HIT|` assertion goes red. (This is the failure mode the
//       2026-09-16 pack's review found as F4.)
//   M2  MUTANT of 02 with STEP 1 (the receipt write) removed: APPLY=1 still
//       clears the pointers, but `config.dataSourceId` comes back NULL and S4's
//       receipt assertion goes red — i.e. the rollback evidence is really
//       produced by that statement and not by something else.
//   M3  MUTANT of 03 with the effective lock timeout removed: under the same
//       contention as S8 it produces NO VALIDATE_RESULT line at all before the
//       harness deadline, so S8's 55P03 classification is real.
//       (The mutant SETS lock_timeout = 0 rather than deleting 03's own SET:
//        deleting it would be masked by _preamble-write.sql's 5s default, which
//        is itself part of the guard. 0 is PostgreSQL's "disabled".)
//
// EVERY MUTANT IS IN MEMORY. The mutated SQL is piped to psql on stdin with cwd
// set to the pack directory (so its `\ir _preamble.sql` still resolves); no
// mutated file is ever written to disk, so two of these harnesses running side
// by side cannot read each other's mutation.
//
// USAGE
//   DATABASE_URL=postgresql://user@127.0.0.1:5432/scratch node run-verify.mjs
//   (PSQL=/path/to/psql if the binary is not on PATH)
// ============================================================================

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
export const PSQL = process.env.PSQL || 'psql'

// PGCLIENTENCODING is pinned because every file in this pack is UTF-8 while
// psql otherwise derives client_encoding from the console code page — GBK on a
// Chinese-locale Windows host, which then dies on the em dashes in the comments.
const BASE_ENV = { ...process.env, PGCLIENTENCODING: 'UTF8' }

export function psqlAvailable() {
  return spawnSync(PSQL, ['--version'], { encoding: 'utf8' }).status === 0
}

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

/** One SQL statement, single scalar back as a string ('' when NULL). */
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
  return psqlRun(['-A', '-v', `schema=${schema}`, ...extraVars, '-f', path.join(PACK, name)], opts)
}

/** Run MUTATED pack source from stdin; cwd = PACK so `\ir` still resolves. */
export function runPackSource(src, schema, extraVars = [], opts = {}) {
  return psqlRun(['-A', '-v', `schema=${schema}`, ...extraVars], { ...opts, input: src, cwd: PACK })
}

export function packSource(name) {
  return fs.readFileSync(path.join(PACK, name), 'utf8')
}

// ── output parsing ──────────────────────────────────────────────────────────

/** Split `psql -A` output into result blocks using the `(N rows)` footers. */
export function parseBlocks(stdout) {
  const blocks = []
  let buf = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const m = /^\((\d+) rows?\)$/.exec(line)
    if (m) {
      const n = Number(m[1])
      const slice = buf.slice(buf.length - (n + 1))
      blocks.push({ header: slice[0], rows: slice.slice(1) })
      buf = []
      continue
    }
    buf.push(line)
  }
  return blocks
}

export function block(stdout, header) {
  const found = parseBlocks(stdout).filter(b => b.header === header)
  if (found.length === 0) throw new Error(`no result block with header "${header}" in:\n${stdout}`)
  return found[0]
}

/** Parse the 01 inventory block into typed rows. */
export function inventoryRows(stdout) {
  const b = block(stdout, 'section|key_id|kind|tenant_id|target_state|config_pointer|config_object|legacy_fallback|n')
  return b.rows.map(line => {
    const [section, key_id, kind, tenant_id, target_state, config_pointer, config_object, legacy_fallback, n] =
      line.split('|')
    return {
      section,
      key_id,
      kind,
      tenant_id,
      target_state,
      config_pointer: config_pointer === 't',
      config_object: config_object === 't',
      legacy_fallback: legacy_fallback === 't',
      n: Number(n),
    }
  })
}

export function line(stdout, prefix) {
  return (
    stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(l => l.startsWith(prefix)) || null
  )
}

/** One `step|...` single-row block from 02, as an object. */
export function stepRow(stdout, header) {
  const b = block(stdout, header)
  const cols = header.split('|')
  const vals = b.rows[0].split('|')
  return Object.fromEntries(cols.map((c, i) => [c, /^\d+$/.test(vals[i]) ? Number(vals[i]) : vals[i]]))
}

const STEP0 = 'step|dangling|remediable|blocked|needs_receipt|receipt_already_present'
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

/**
 * Create a throwaway schema holding the pre-#5896 fixture, then (unless
 * `migrate:false`) apply the verbatim #5896 `up()` SQL to it.
 */
export function createFixture({ migrate = true, extraSql = null } = {}) {
  const schema = `h5_fixture_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE SCHEMA "${schema}"`)
  const load = file => {
    const r = psqlRun([
      '-v', 'ON_ERROR_STOP=1', '-q',
      '-c', `SET search_path = "${schema}"`,
      '-f', path.join(HERE, file),
    ])
    if (r.status !== 0) {
      dropFixture(schema)
      throw new Error(`${file} failed: ${r.stderr}`)
    }
  }
  load('fixture-pre5896.sql')
  if (migrate) load('migration-5896-up.sql')
  if (extraSql) exec(`SET search_path = "${schema}"; ${extraSql}`)
  return schema
}

export function dropFixture(schema) {
  try {
    exec(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name IN ('h5-mutant', 'h5-lockholder') AND pid <> pg_backend_pid()`,
    )
  } catch { /* best effort */ }
  try { exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* best effort */ }
}

function q(schema, sql) {
  return scalar(`SET search_path = "${schema}"; ${sql}`)
}

export function danglingCount(schema) {
  return Number(
    q(
      schema,
      `SELECT count(*) FROM integration_external_systems es
        WHERE es.connection_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM data_sources d WHERE d.live_id = es.connection_id)`,
    ),
  )
}

export function receiptOf(schema, id) {
  return q(schema, `SELECT coalesce(config->>'dataSourceId', '<null>') FROM integration_external_systems WHERE id = '${id}'`)
}

export function connectionOf(schema, id) {
  return q(schema, `SELECT coalesce(connection_id, '<null>') FROM integration_external_systems WHERE id = '${id}'`)
}

export function fkValidated(schema) {
  return q(
    schema,
    `SELECT coalesce((SELECT convalidated::text FROM pg_constraint
                       WHERE conname = 'fk_integration_external_systems_live_connection_id'
                         AND conrelid = to_regclass('integration_external_systems')), '<missing>')`,
  )
}

/** Hold ACCESS EXCLUSIVE on the fixture's binding table for `seconds`. */
export function holdExclusiveLock(schema, seconds) {
  const child = spawn(PSQL, ['-d', process.env.DATABASE_URL, '--no-psqlrc', '-q'], {
    env: { ...BASE_ENV, PGAPPNAME: 'h5-lockholder' },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  child.stdin.end(
    `SET search_path = "${schema}";
     BEGIN;
     LOCK TABLE integration_external_systems IN ACCESS EXCLUSIVE MODE;
     SELECT pg_sleep(${seconds});
     COMMIT;\n`,
  )
  return {
    release() {
      try { child.kill() } catch { /* best effort */ }
      try {
        exec(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = 'h5-lockholder' AND pid <> pg_backend_pid()`,
        )
      } catch { /* best effort */ }
    },
  }
}

/** Block until the lock holder is actually holding the lock (or give up). */
function waitForLock(schema, deadlineMs = 10_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const held = q(
      schema,
      `SELECT count(*) FROM pg_locks l
         JOIN pg_stat_activity a USING (pid)
        WHERE a.application_name = 'h5-lockholder'
          AND l.mode = 'AccessExclusiveLock' AND l.granted`,
    )
    if (Number(held) > 0) return true
    sleepSync(200)
  }
  return false
}

/** Synchronous sleep — this harness is deliberately spawnSync-shaped. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ── mutants (in memory only) ────────────────────────────────────────────────

/** M1 — 01's TOTAL no longer reads the shared `hit` CTE. */
export function mutate01BreakSharedCte(src) {
  const re = /count\(\*\)::int AS n\s*\n\s*FROM hit/
  assert.match(src, re, 'M1 anchor not found in 01-inventory.sql')
  return src.replace(
    re,
    'count(*)::int AS n\n          FROM integration_external_systems es2 WHERE es2.connection_id IS NOT NULL',
  )
}

/** M2 — 02 no longer writes the rollback receipt. */
export function mutate02DropReceipt(src) {
  const re = /WITH upd AS \(\n  UPDATE integration_external_systems es\n     SET config = jsonb_set[\s\S]*?FROM upd;/
  assert.match(src, re, 'M2 anchor (STEP 1 statement) not found in 02-remediate.sql')
  return src.replace(re, "SELECT 'STEP1_RECEIPT_WRITTEN' AS step, 0 AS rows;")
}

/** M3 — 03 no longer has an effective lock timeout. */
export function mutate03DropLockTimeout(src) {
  const marker = "\\echo '-- effective lock_timeout for the VALIDATE below:'"
  assert.ok(src.includes(marker), 'M3 anchor not found in 03-validate.sql')
  return src.replace(marker, `SET lock_timeout = 0;\n${marker}`)
}

// ── the checks ──────────────────────────────────────────────────────────────

export function checkInventory(schema) {
  const out = runPackFile('01-inventory.sql', schema)
  assert.equal(out.status, 0, `01 exited ${out.status}: ${out.stderr}`)

  const rows = inventoryRows(out.stdout)
  const total = rows.filter(r => r.section === 'TOTAL')
  const hits = rows.filter(r => r.section === 'HIT')
  const groups = rows.filter(r => r.section === 'BY_KIND_TENANT')

  assert.equal(total.length, 1, '01 must print exactly one TOTAL row, even at zero')
  // S1 / F4 invariant — the whole reason TOTAL and HIT share one CTE.
  assert.equal(hits.length, total[0].n, 'F4 invariant: TOTAL.n == number of HIT rows')
  assert.equal(total[0].n, 2, 'fixture plants exactly two dangling bindings')
  assert.deepEqual(hits.map(h => h.key_id).sort(), ['es-dangle-1', 'es-dangle-2'])
  assert.ok(!hits.some(h => h.key_id === 'es-ok'), 'the healthy binding must not be listed')
  assert.deepEqual([...new Set(hits.map(h => h.target_state))], ['soft-deleted'])
  assert.equal(
    groups.reduce((a, g) => a + g.n, 0),
    total[0].n,
    'BY_KIND_TENANT must sum to TOTAL',
  )
  const h1 = hits.find(h => h.key_id === 'es-dangle-1')
  const h2 = hits.find(h => h.key_id === 'es-dangle-2')
  assert.equal(h1.config_pointer, false, 'canonical-shaped row carries no receipt yet')
  assert.equal(h2.config_pointer, true, 'legacy-shaped row already carries its pointer')
  assert.equal(h1.config_object && h2.config_object, true)

  const result = line(out.stdout, 'INVENTORY_RESULT file=01-inventory.sql')
  assert.ok(result, '01 must print its completion line')
  assert.match(result, /status=complete live_fk=present validated=no/)
  return { total: total[0].n, hitIds: hits.map(h => h.key_id).sort(), groups: groups.length }
}

export function checkDryRun(schema) {
  const before = danglingCount(schema)
  const out = runPackFile('02-remediate.sql', schema)
  assert.equal(out.status, 0, `02 dry run exited ${out.status}: ${out.stderr}`)

  const s0 = stepRow(out.stdout, STEP0)
  assert.deepEqual(
    { d: s0.dangling, r: s0.remediable, b: s0.blocked, nr: s0.needs_receipt, rp: s0.receipt_already_present },
    { d: 2, r: 2, b: 0, nr: 1, rp: 1 },
  )
  const steps = stepsByName(out.stdout)
  assert.equal(steps.STEP1_RECEIPT_WRITTEN, 1, 'dry run reports the receipt it would write')
  assert.equal(steps.STEP2_CONNECTION_CLEARED, 2)
  assert.equal(steps.STEP3_REMAINING_DANGLING, 0)
  assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=dry-run dangling_before=2 remediated=2 blocked=0/)
  assert.ok(line(out.stdout, 'REMEDIATE_TX=rolled-back'), 'a dry run must end rolled back')

  // S2 — the database is untouched.
  assert.equal(danglingCount(schema), before, 'dry run must leave the dangling rows in place')
  assert.equal(receiptOf(schema, 'es-dangle-1'), '<null>', 'dry run must not write a receipt')
  return out
}

export function checkApplyGate(schema) {
  for (const v of ['APPLY=true', 'APPLY=yes', 'APPLY=0', 'APPLY=on']) {
    const out = runPackFile('02-remediate.sql', schema, ['-v', v])
    assert.equal(out.status, 0, `02 with -v ${v} exited ${out.status}: ${out.stderr}`)
    assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=dry-run/, `-v ${v} must stay a dry run`)
    assert.ok(line(out.stdout, 'REMEDIATE_TX=rolled-back'), `-v ${v} must roll back`)
    assert.equal(danglingCount(schema), 2, `-v ${v} must not change the table`)
  }
}

export function checkApply(schema) {
  const out = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
  assert.equal(out.status, 0, `02 APPLY exited ${out.status}: ${out.stderr}`)
  assert.match(line(out.stdout, 'REMEDIATE_RESULT') || '', /mode=apply dangling_before=2 remediated=2 blocked=0/)
  assert.ok(line(out.stdout, 'REMEDIATE_TX=committed'))

  // S4
  assert.equal(danglingCount(schema), 0, 'APPLY must clear every dangling pointer')
  assert.equal(connectionOf(schema, 'es-dangle-1'), '<null>')
  assert.equal(connectionOf(schema, 'es-dangle-2'), '<null>')
  assert.equal(receiptOf(schema, 'es-dangle-1'), 'ds-dead-1', 'canonical row gets its rollback receipt')
  assert.equal(receiptOf(schema, 'es-dangle-2'), 'ds-dead-2', 'legacy row keeps the pointer it already had')
  assert.equal(
    q(schema, `SELECT config->>'dataSourceOwnerId' FROM integration_external_systems WHERE id = 'es-dangle-2'`),
    'user-fixture-b',
    'the legacy row’s other config keys survive',
  )
  assert.equal(
    q(schema, `SELECT config->>'schema' FROM integration_external_systems WHERE id = 'es-dangle-1'`),
    'public',
    'the receipt is merged into config, not a replacement',
  )
  assert.equal(
    q(schema, `SELECT legacy_connection_fallback_eligible::text FROM integration_external_systems WHERE id = 'es-dangle-1'`),
    'false',
    '02 must not forge cutover evidence',
  )
  // the healthy binding is untouched
  assert.equal(connectionOf(schema, 'es-ok'), 'ds-live')
  assert.equal(receiptOf(schema, 'es-ok'), '<null>')
  return out
}

export function checkValidate(schema) {
  const out = runPackFile('03-validate.sql', schema)
  assert.equal(out.status, 0, `03 exited ${out.status}: ${out.stderr}`)
  assert.match(line(out.stdout, 'VALIDATE_RESULT') || '', /status=complete sqlstate=00000 detail=already_validated=no validated_now=yes/)
  assert.equal(fkValidated(schema), 'true', 'pg_constraint.convalidated must flip')

  // S5b — idempotent
  const again = runPackFile('03-validate.sql', schema)
  assert.equal(again.status, 0)
  assert.match(line(again.stdout, 'VALIDATE_RESULT') || '', /status=complete .*already_validated=yes/)
  return out
}

export function checkNewDanglingRefused(schema) {
  // S6 — the FK, now validated, refuses a fresh dangling binding. The probe
  // traps the error in PL/pgSQL so the assertion reads the SQLSTATE itself
  // rather than pattern-matching a localised error message.
  const r = psqlRun([
    '-t', '-A', '-q', '-c',
    `SET search_path = "${schema}";
     DO $$
     BEGIN
       INSERT INTO integration_external_systems
         (id, tenant_id, name, kind, role, config, connection_id)
       VALUES ('es-new-dangle', 'tenant-fixture-1', 'fixture new', 'data-source:sql-readonly',
               'source', '{}'::jsonb, 'ds-dead-1');
       RAISE NOTICE 'H5_INSERT=accepted';
     EXCEPTION WHEN foreign_key_violation THEN
       RAISE NOTICE 'H5_INSERT=refused sqlstate=%', SQLSTATE;
     END $$;`,
  ])
  const combined = `${r.stdout}\n${r.stderr}`
  assert.match(combined, /H5_INSERT=refused sqlstate=23503/, `expected the FK to refuse the insert, got:\n${combined}`)
}

export function checkValidateFailsOnDangling(schema) {
  // S7 — 03 before remediation.
  const out = runPackFile('03-validate.sql', schema)
  assert.notEqual(out.status, 0, '03 must exit non-zero when it could not validate')
  assert.match(line(out.stdout, 'VALIDATE_RESULT') || '', /status=failed sqlstate=23503 detail=reason=dangling-rows/)
  assert.equal(fkValidated(schema), 'false', 'a failed VALIDATE must leave the constraint NOT VALID')
}

export function checkLockTimeoutClassified(schema) {
  // Remove the dangling rows so the ONLY thing that can fail is the lock.
  exec(`SET search_path = "${schema}"; UPDATE integration_external_systems SET connection_id = NULL WHERE id LIKE 'es-dangle%'`)
  const holder = holdExclusiveLock(schema, 30)
  try {
    assert.ok(waitForLock(schema), 'lock holder never acquired ACCESS EXCLUSIVE')
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

export function checkBlockedFailClosed() {
  // S9 — a binding whose config is not an object.
  const schema = createFixture({
    extraSql: `UPDATE integration_external_systems SET config = '"not-an-object"'::jsonb WHERE id = 'es-dangle-1'`,
  })
  try {
    const dry = runPackFile('02-remediate.sql', schema)
    assert.equal(dry.status, 0, `02 dry run exited ${dry.status}: ${dry.stderr}`)
    const s0 = stepRow(dry.stdout, STEP0)
    assert.equal(s0.blocked, 1, 'the non-object config row must be reported as blocked')
    assert.equal(s0.remediable, 1)

    const apply = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
    assert.notEqual(apply.status, 0, 'APPLY must abort when a row cannot hold a receipt')
    assert.match(`${apply.stdout}\n${apply.stderr}`, /REMEDIATE_ABORT reason=non-object-config rows=1/)
    assert.equal(danglingCount(schema), 2, 'an aborted APPLY must leave the table untouched')
    return { schema }
  } finally {
    dropFixture(schema)
  }
}

/**
 * S11 — `target_state='absent'`: a binding whose target row is not in
 * `data_sources` at all. Planted the only way it can honestly exist — the row
 * predates the constraint — by dropping the live FK, inserting, and re-adding
 * it NOT VALID, which is exactly the shape #5896's migration leaves behind.
 */
export function checkAbsentTarget() {
  const LIVE_FK = 'fk_integration_external_systems_live_connection_id'
  const schema = createFixture({
    extraSql: `
      ALTER TABLE integration_external_systems DROP CONSTRAINT ${LIVE_FK};
      INSERT INTO integration_external_systems
        (id, tenant_id, name, kind, role, config, connection_id)
      VALUES ('es-dangle-3', 'tenant-fixture-3', 'fixture dangling absent',
              'data-source:sql-readonly', 'source', '{"schema":"public"}'::jsonb,
              'ds-gone-forever');
      ALTER TABLE integration_external_systems
        ADD CONSTRAINT ${LIVE_FK}
        FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
        ON DELETE RESTRICT NOT VALID;`,
  })
  try {
    const out = runPackFile('01-inventory.sql', schema)
    assert.equal(out.status, 0, `01 exited ${out.status}: ${out.stderr}`)
    const rows = inventoryRows(out.stdout)
    const total = rows.find(r => r.section === 'TOTAL').n
    const hits = rows.filter(r => r.section === 'HIT')
    assert.equal(total, 3)
    assert.equal(hits.length, total, 'F4 invariant still holds with a mixed population')
    const absent = hits.find(h => h.key_id === 'es-dangle-3')
    assert.ok(absent, 'the absent-target binding must be listed')
    assert.equal(absent.target_state, 'absent', 'a missing data_sources row is not `soft-deleted`')

    const apply = runPackFile('02-remediate.sql', schema, ['-v', 'APPLY=1'])
    assert.equal(apply.status, 0, `02 APPLY exited ${apply.status}: ${apply.stderr}`)
    assert.equal(danglingCount(schema), 0)
    assert.equal(receiptOf(schema, 'es-dangle-3'), 'ds-gone-forever', 'the absent target still gets a receipt')

    const validated = runPackFile('03-validate.sql', schema)
    assert.equal(validated.status, 0, `03 exited ${validated.status}: ${validated.stderr}`)
    assert.equal(fkValidated(schema), 'true')
    return { total, absentState: absent.target_state }
  } finally {
    dropFixture(schema)
  }
}

export function checkPreMigrationIncomplete() {
  // S10 — #5896 not applied.
  const schema = createFixture({ migrate: false })
  try {
    const out = runPackFile('01-inventory.sql', schema)
    assert.equal(out.status, 0, `01 exited ${out.status}: ${out.stderr}`)
    const result = line(out.stdout, 'INVENTORY_RESULT file=01-inventory.sql')
    assert.ok(result, '01 must still print its completion line')
    assert.match(result, /status=incomplete reason=missing-column:data_sources\.live_id/)
    assert.ok(
      !parseBlocks(out.stdout).some(b => b.header.startsWith('section|')),
      'no inventory block may be printed when the column is missing (never report a zero)',
    )
  } finally {
    dropFixture(schema)
  }
}

// ── mutation evidence ───────────────────────────────────────────────────────

export function mutantM1(schema) {
  const out = runPackSource(mutate01BreakSharedCte(packSource('01-inventory.sql')), schema)
  assert.equal(out.status, 0, `M1 exited ${out.status}: ${out.stderr}`)
  const rows = inventoryRows(out.stdout)
  const total = rows.find(r => r.section === 'TOTAL').n
  const hits = rows.filter(r => r.section === 'HIT').length
  assert.equal(hits, 2, 'M1 changes only the TOTAL branch')
  assert.equal(total, 3, 'M1 TOTAL now counts the healthy binding too')
  assert.throws(
    () => assert.equal(hits, total, 'F4 invariant: TOTAL.n == number of HIT rows'),
    /F4 invariant/,
    'the F4 assertion must go red against M1',
  )
  return { total, hits }
}

export function mutantM2() {
  const schema = createFixture()
  try {
    const out = runPackSource(mutate02DropReceipt(packSource('02-remediate.sql')), schema, ['-v', 'APPLY=1'])
    assert.equal(out.status, 0, `M2 exited ${out.status}: ${out.stderr}`)
    assert.equal(danglingCount(schema), 0, 'M2 still clears the pointers')
    const receipt = receiptOf(schema, 'es-dangle-1')
    assert.equal(receipt, '<null>', 'M2 loses the rollback receipt')
    assert.throws(
      () => assert.equal(receipt, 'ds-dead-1', 'canonical row gets its rollback receipt'),
      /rollback receipt/,
      'the receipt assertion must go red against M2',
    )
    return { receipt }
  } finally {
    dropFixture(schema)
  }
}

export function mutantM3() {
  const schema = createFixture()
  try {
    exec(`SET search_path = "${schema}"; UPDATE integration_external_systems SET connection_id = NULL WHERE id LIKE 'es-dangle%'`)
    const holder = holdExclusiveLock(schema, 30)
    try {
      assert.ok(waitForLock(schema), 'lock holder never acquired ACCESS EXCLUSIVE')
      const out = runPackSource(mutate03DropLockTimeout(packSource('03-validate.sql')), schema, [], {
        timeout: 15_000,
        env: { PGAPPNAME: 'h5-mutant' },
      })
      assert.ok(out.timedOut || out.status !== 0, 'M3 must not succeed under contention')
      assert.equal(
        line(out.stdout, 'VALIDATE_RESULT'),
        null,
        'M3 produces no classified outcome at all — it is still waiting on the lock',
      )
      return { timedOut: out.timedOut }
    } finally {
      holder.release()
    }
  } finally {
    dropFixture(schema)
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export function verifyAll() {
  const report = {}

  // Happy path, one fixture carried through 01 → 02 dry → gate → 02 apply → 03 → 23503.
  const main = createFixture()
  try {
    report.S1 = checkInventory(main)
    report.S2 = !!checkDryRun(main)
    checkApplyGate(main)
    report.S3 = true
    report.S4 = !!checkApply(main)
    const after = runPackFile('01-inventory.sql', main)
    assert.equal(inventoryRows(after.stdout).find(r => r.section === 'TOTAL').n, 0, '01 must report zero after APPLY')
    report.S5 = !!checkValidate(main)
    checkNewDanglingRefused(main)
    report.S6 = true
  } finally {
    dropFixture(main)
  }

  const failing = createFixture()
  try {
    checkValidateFailsOnDangling(failing)
    report.S7 = true
  } finally {
    dropFixture(failing)
  }

  const locked = createFixture()
  try {
    report.S8 = checkLockTimeoutClassified(locked)
  } finally {
    dropFixture(locked)
  }

  checkBlockedFailClosed()
  report.S9 = true
  checkPreMigrationIncomplete()
  report.S10 = true
  report.S11 = checkAbsentTarget()

  const m1fixture = createFixture()
  try {
    report.M1 = mutantM1(m1fixture)
  } finally {
    dropFixture(m1fixture)
  }
  report.M2 = mutantM2()
  report.M3 = mutantM3()

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
