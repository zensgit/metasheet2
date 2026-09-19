#!/usr/bin/env node
// ============================================================================
// run-verify.mjs — synthetic-PostgreSQL verification of the 2026-09-16
//                  read-only inventory pack (review repairs F3 / F4 / F5)
// ============================================================================
// WHAT IT PROVES (all on throwaway schemas full of obviously fake values —
// this harness must never be pointed at a production database):
//
//   F3  02-trg04's http:// detection is JSON-SEMANTIC. Positives: top-level
//       action, nested condition_branch action, space-laid-out JSON, upper-case
//       key + upper-case scheme. Negatives: https, HTTPS, and a decoy string
//       that merely CONTAINS the literal `"url":"http://…`. The harness also
//       runs the OLD textual predicate on the same fixture and asserts it gets
//       a DIFFERENT, wrong answer — that is the "remove the fix and the test
//       goes red" evidence.
//   F4  01-cred06's count and id list come from one shared `hit` predicate:
//       the clean connection row stays out of BOTH, the matching rows are in
//       BOTH, and |ids| == count. The harness also runs the OLD id predicate
//       (shape-only) and asserts it returns MORE rows than the count.
//   F5  One execution mode (whole file, `psql -f`), automatic schema dispatch,
//       ON_ERROR_STOP, and an explicit INVENTORY_RESULT completion line:
//         * modern schema  → status=complete for all four files
//         * legacy schema  → status=incomplete reason=missing-column:… for the
//                            files whose columns are absent (never a zero)
//         * lock timeout   → psql aborts, NO INVENTORY_RESULT line at all
//         * permission denied → same abort shape
//
// USAGE
//   DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/scratch node run-verify.mjs
//   (PSQL=/path/to/psql if the binary is not on PATH)
// ============================================================================

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(HERE, '..')
export const PSQL = process.env.PSQL || 'psql'

export function psqlAvailable() {
  const r = spawnSync(PSQL, ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

function run(args, { input } = {}) {
  const r = spawnSync(PSQL, ['-d', process.env.DATABASE_URL, '--no-psqlrc', ...args], {
    encoding: 'utf8',
    input,
    env: process.env,
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** Run one SQL statement, return the single scalar as a string. */
export function scalar(sql) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout.trim()
}

export function exec(sql) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${sql}`)
  return r.stdout
}

export function execFile(file, schema) {
  const r = run(['-v', 'ON_ERROR_STOP=1', '-q', '-v', `schema=${schema}`, '-f', file])
  if (r.status !== 0) throw new Error(`psql -f ${file} failed: ${r.stderr}`)
  return r.stdout
}

/** Run one of the pack's four files exactly the way the runbook says to. */
export function runPackFile(name, schema, extraVars = []) {
  const args = ['-A', '-v', `schema=${schema}`, ...extraVars, '-f', path.join(PACK, name)]
  return run(args)
}

/** Split psql -A output into result blocks using the `(N rows)` footers. */
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
  if (found.length === 0) {
    throw new Error(`no result block with header "${header}" in:\n${stdout}`)
  }
  return found
}

export function resultLine(stdout, file) {
  const line = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.startsWith(`INVENTORY_RESULT file=${file}`))
  return line || null
}

// ── fixture lifecycle ───────────────────────────────────────────────────────

export function createFixture(prefix, fixtureSql) {
  const schema = `${prefix}_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE SCHEMA "${schema}"`)
  const r = run([
    '-v', 'ON_ERROR_STOP=1', '-q',
    '-c', `SET search_path = "${schema}"`,
    '-f', path.join(HERE, fixtureSql),
  ])
  if (r.status !== 0) {
    exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    throw new Error(`fixture load failed: ${r.stderr}`)
  }
  return schema
}

export function dropFixture(schema) {
  try { exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* best effort */ }
}

// ── the checks ──────────────────────────────────────────────────────────────

/** F4 evidence: the pre-repair id predicate (shape only, no key match). */
export const OLD_ID_PREDICATE_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM data_sources ds
   WHERE jsonb_typeof(ds.config #> '{connection}') = 'object'
      OR jsonb_typeof(ds.config #> '{connection,headers}') = 'object'`

/** F3 evidence: the pre-repair textual predicate. */
export const OLD_HTTP_PREDICATE_SQL = schema => `
  SET search_path = "${schema}";
  SELECT count(*)::int FROM automation_rules
   WHERE actions::text ILIKE '%"url":"http://%'`

export function checkModern(schema) {
  const out = {}

  // ── 01 / F4 ──────────────────────────────────────────────────────────────
  const o1 = runPackFile('01-cred06-secret-keys.sql', schema)
  assert.equal(o1.status, 0, `01 exited ${o1.status}: ${o1.stderr}`)
  const count01 = Number(block(o1.stdout, 'affected_rows')[0].rows[0])
  const ids01 = block(o1.stdout, 'id|matched_top_level|matched_headers')[0].rows
    .map(r => r.split('|')[0])
  assert.equal(count01, 2, 'modern 01: expected ds-top + ds-headers')
  assert.deepEqual(ids01.sort(), ['ds-headers', 'ds-top'])
  assert.equal(ids01.length, count01, 'F4 invariant: |ids| == count')
  assert.ok(!ids01.includes('ds-clean'), 'F4: clean connection must NOT be listed')
  const oldIdRows = Number(scalar(OLD_ID_PREDICATE_SQL(schema)))
  assert.equal(oldIdRows, 3, 'F4 evidence: the old shape-only id predicate over-lists')
  assert.ok(oldIdRows > count01, 'F4 evidence: old id set was strictly larger than the count')
  // key census is opt-in
  assert.ok(!/connection_key/.test(o1.stdout), 'key census must be off by default')
  const o1c = runPackFile('01-cred06-secret-keys.sql', schema, ['-v', 'census=1'])
  assert.ok(/connection_key/.test(o1c.stdout), '-v census=1 must enable the key census')
  out.f4 = { count: count01, ids: ids01, oldIdRows }
  out.r01 = resultLine(o1.stdout, '01-cred06-secret-keys.sql')
  assert.match(out.r01, /status=complete shapes=A /)

  // ── 02 / F3 ──────────────────────────────────────────────────────────────
  const o2 = runPackFile('02-trg04-http-targets.sql', schema)
  assert.equal(o2.status, 0, `02 exited ${o2.status}: ${o2.stderr}`)
  const httpRules = Number(block(o2.stdout, 'http_rules')[0].rows[0])
  const ruleIds = block(o2.stdout, 'id|sheet_id')[0].rows.map(r => r.split('|')[0]).sort()
  assert.deepEqual(ruleIds, ['r-nested', 'r-spaced', 'r-top', 'r-upper'],
    'F3: top-level + nested + spaced-layout + upper-case must all be found')
  assert.equal(httpRules, 4)
  assert.equal(ruleIds.length, httpRules, 'F3/F4 invariant: |ids| == count')
  for (const neg of ['r-https', 'r-https-upper', 'r-decoy']) {
    assert.ok(!ruleIds.includes(neg), `F3 negative leaked in: ${neg}`)
  }
  const oldHttp = Number(scalar(OLD_HTTP_PREDICATE_SQL(schema)))
  // THE F3 BUG, measured: the pre-repair textual predicate reports ZERO on a
  // fixture that holds four genuine http:// targets — jsonb re-renders members
  // as `"url": "http://…"` (with a space), so `'%"url":"http://%'` never hits.
  assert.equal(oldHttp, 0, 'F3 evidence: the old text pattern under-reports to zero')
  assert.notEqual(oldHttp, httpRules, 'F3 evidence: old vs new predicates disagree')
  const legacyCol = Number(block(o2.stdout, 'http_rules_legacy_column')[0].rows[0])
  assert.equal(legacyCol, 1, 'legacy action_config http row')
  const wh = block(o2.stdout, 'active|http_webhooks')[0].rows.map(r => r.split('|'))
  const whTotal = wh.reduce((a, r) => a + Number(r[1]), 0)
  const whIds = block(o2.stdout, 'id|active|created_by')[0].rows.map(r => r.split('|')[0]).sort()
  assert.deepEqual(whIds, ['w-http', 'w-http-off', 'w-http-upper', 'w-internal'])
  assert.equal(whIds.length, whTotal, 'webhook count/ids invariant')
  out.f3 = { httpRules, ruleIds, oldHttp, legacyCol, whTotal, whIds }
  out.r02 = resultLine(o2.stdout, '02-trg04-http-targets.sql')
  assert.match(out.r02, /status=complete scope=automation_rules\+multitable_webhooks/)

  // ── 03 ───────────────────────────────────────────────────────────────────
  const o3 = runPackFile('03-adm08-wildcard-permissions.sql', schema)
  assert.equal(o3.status, 0, `03 exited ${o3.status}: ${o3.stderr}`)
  assert.equal(Number(block(o3.stdout, 'wildcard_users')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_direct_grants')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_roles')[0].rows[0]), 1)
  assert.equal(Number(block(o3.stdout, 'wildcard_via_role_users')[0].rows[0]), 1)
  out.r03 = resultLine(o3.stdout, '03-adm08-wildcard-permissions.sql')
  assert.match(out.r03, /status=complete shape=A\(jsonb\)/)

  // ── 04 ───────────────────────────────────────────────────────────────────
  const o4 = runPackFile('04-adm13-declared-admins.sql', schema)
  assert.equal(o4.status, 0, `04 exited ${o4.status}: ${o4.stderr}`)
  const declared = Number(block(o4.stdout, 'declared_admin_not_in_user_roles')[0].rows[0])
  const declaredIds = block(o4.stdout, 'id|role_says_admin|is_admin_flag|is_active')[0]
    .rows.map(r => r.split('|')[0]).sort()
  assert.equal(declared, 2)
  assert.deepEqual(declaredIds, ['u-flag', 'u-role'])
  assert.ok(!declaredIds.includes('u-consistent'), 'user WITH a user_roles admin row must not be listed')
  out.r04 = resultLine(o4.stdout, '04-adm13-declared-admins.sql')
  assert.match(out.r04, /status=complete predicate=is_admin-or-role/)
  out.modernDeclared = { declared, declaredIds }

  return out
}

export function checkLegacy(schema) {
  const out = {}

  const o1 = runPackFile('01-cred06-secret-keys.sql', schema)
  assert.equal(o1.status, 0, `01 legacy exited ${o1.status}: ${o1.stderr}`)
  const count01 = Number(block(o1.stdout, 'affected_rows')[0].rows[0])
  const ids01 = block(o1.stdout, 'id|matched_top_level|matched_headers')[0].rows
    .map(r => r.split('|')[0])
  assert.equal(count01, 1)
  assert.deepEqual(ids01, ['ds-b-hit'])
  assert.equal(ids01.length, count01)
  out.r01 = resultLine(o1.stdout, '01-cred06-secret-keys.sql')
  assert.match(out.r01, /status=complete shapes=B /, 'legacy must auto-dispatch to Shape B')

  // F5: the missing `actions` column must be reported as INCOMPLETE, not zero.
  const o2 = runPackFile('02-trg04-http-targets.sql', schema)
  assert.equal(o2.status, 0, `02 legacy exited ${o2.status}: ${o2.stderr}`)
  out.r02 = resultLine(o2.stdout, '02-trg04-http-targets.sql')
  assert.match(out.r02, /status=incomplete reason=missing-column:automation_rules\.actions/)
  assert.ok(!/http_rules\b/.test(o2.stdout), 'Q2 must be skipped, not silently zero')
  const whIds = block(o2.stdout, 'id|active|created_by')[0].rows.map(r => r.split('|')[0])
  assert.deepEqual(whIds, ['w-b-http'], 'the webhook half still runs')

  const o3 = runPackFile('03-adm08-wildcard-permissions.sql', schema)
  assert.equal(o3.status, 0, `03 legacy exited ${o3.status}: ${o3.stderr}`)
  assert.equal(Number(block(o3.stdout, 'wildcard_users')[0].rows[0]), 1)
  out.r03 = resultLine(o3.stdout, '03-adm08-wildcard-permissions.sql')
  assert.match(out.r03, /status=complete shape=B\(text\[\]\)/)

  // F5: BOTH missing columns (is_admin AND is_active — the gap the old prose
  // fallback missed) are handled, and the run is reported incomplete.
  const o4 = runPackFile('04-adm13-declared-admins.sql', schema)
  assert.equal(o4.status, 0, `04 legacy exited ${o4.status}: ${o4.stderr}`)
  const roleOnly = Number(block(o4.stdout, 'declared_admin_not_in_user_roles_role_only')[0].rows[0])
  assert.equal(roleOnly, 1, 'u-b-role only (u-b-ok has the user_roles row)')
  out.r04 = resultLine(o4.stdout, '04-adm13-declared-admins.sql')
  assert.match(out.r04, /status=incomplete reason=missing-column:users\.is_admin users\.is_active/)
  assert.match(out.r04, /note=role-only-lower-bound/)

  return out
}

/** F5: an aborted run prints NO completion line (must never read as zero). */
export async function checkLockTimeoutIsIncomplete(schema) {
  const holder = spawn(PSQL, [
    '-d', process.env.DATABASE_URL, '--no-psqlrc', '-q',
    '-c', `BEGIN; SET search_path = "${schema}"; LOCK TABLE data_sources IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;`,
  ], { stdio: 'ignore' })
  try {
    await new Promise(r => setTimeout(r, 1500))
    const o = runPackFile('01-cred06-secret-keys.sql', schema)
    assert.notEqual(o.status, 0, 'a lock timeout must make psql exit non-zero (ON_ERROR_STOP)')
    assert.match(o.stderr, /lock timeout|canceling statement/i)
    assert.equal(resultLine(o.stdout, '01-cred06-secret-keys.sql'), null,
      'an aborted run must print NO INVENTORY_RESULT line')
    assert.ok(!/affected_rows/.test(o.stdout) || !/^0$/m.test(o.stdout),
      'an aborted run must not look like a zero-hit run')
    return { exit: o.status, stderr: o.stderr.trim().split(/\r?\n/)[0] }
  } finally {
    holder.kill()
  }
}

/** F5: a permission error aborts the same way (no completion line). */
export function checkPermissionDeniedIsIncomplete(schema) {
  const role = `inv_verify_ro_${Math.random().toString(36).slice(2, 8)}`
  exec(`CREATE ROLE "${role}" LOGIN PASSWORD 'fake-verify-only'`)
  try {
    exec(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`)
    // deliberately NO grant on data_sources
    const url = new URL(process.env.DATABASE_URL)
    url.username = role
    url.password = 'fake-verify-only'
    const r = spawnSync(PSQL, [
      '-d', url.toString(), '--no-psqlrc', '-A',
      '-v', `schema=${schema}`, '-f', path.join(PACK, '01-cred06-secret-keys.sql'),
    ], { encoding: 'utf8' })
    // A role without SELECT on data_sources cannot even SEE the table in
    // information_schema (the catalog views are privilege-filtered), so the
    // probe finds nothing. The contract that matters is the same one: the run
    // must NOT look like a clean zero-hit inventory.
    const line = resultLine(r.stdout || '', '01-cred06-secret-keys.sql')
    if (r.status === 0) {
      assert.ok(line, 'a completed run must print an INVENTORY_RESULT line')
      assert.match(line, /status=incomplete reason=missing-table:data_sources/,
        'an unprivileged run must report incomplete, never a zero-hit "complete"')
      assert.ok(!/affected_rows/.test(r.stdout || ''), 'no count may be printed at all')
    } else {
      assert.match(r.stderr || '', /permission denied/i)
      assert.equal(line, null, 'an aborted run must print NO INVENTORY_RESULT line')
    }
    return { exit: r.status, resultLine: line, stderr: (r.stderr || '').trim().split(/\r?\n/)[0] }
  } finally {
    try { exec(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${role}"`) } catch {}
    try { exec(`DROP ROLE IF EXISTS "${role}"`) } catch {}
  }
}

export async function verifyAll() {
  const modern = createFixture('inventory_fixture_modern', 'fixture-modern.sql')
  const legacy = createFixture('inventory_fixture_legacy', 'fixture-legacy.sql')
  try {
    const report = {
      modern: checkModern(modern),
      legacy: checkLegacy(legacy),
      lockTimeout: await checkLockTimeoutIsIncomplete(modern),
      permissionDenied: checkPermissionDeniedIsIncomplete(modern),
    }
    return report
  } finally {
    dropFixture(modern)
    dropFixture(legacy)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (point it at a LOCAL/CONTAINER scratch PostgreSQL)')
    process.exit(2)
  }
  if (!psqlAvailable()) {
    console.error('psql not found on PATH (set PSQL=/path/to/psql)')
    process.exit(2)
  }
  verifyAll().then(r => {
    console.log(JSON.stringify(r, null, 2))
    console.log('\nALL CHECKS PASSED (synthetic fixtures only; nothing was run against a real database).')
  }).catch(e => {
    console.error(e)
    process.exit(1)
  })
}
