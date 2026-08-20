#!/usr/bin/env node

/**
 * Hermetic guard for the L1 exercise battery.
 *
 * NO database, NO application, NO node_modules import at any point in this module's graph — the
 * battery reaches `pg` only through a lazy `createRequire(...)('pg')` inside a function, so this
 * file (and the contract lane it will be wired into) runs in a pristine checkout.
 *
 * That property is TESTED, not assumed. "Importing the battery here would fail" is not an alarm in
 * a tree that HAS node_modules: a stray top-level `import pg from 'pg'` would pass locally and blow
 * up only in the pristine lane. So the specifier of every top-level import in this file, in the
 * battery, and in the containment module it re-uses is asserted to be `node:`/relative — see
 * 'no module in the battery graph imports node_modules at the top level'.
 *
 * What a real-DB rehearsal proves — that a held lease produces a 409 — it proves ONCE, for the
 * surfaces that existed that day. What this file guards is what a rehearsal can never re-prove on
 * every PR:
 *
 *   1. ANTI-DRIFT (the point). The census table
 *      `packages/core-backend/tests/unit/lib/recovery-census-table.ts` is the single register of
 *      recovery-conflict write surfaces. This guard re-parses it and asserts SET-EQUALITY against
 *      the battery's ledger. A newly-registered census site that the battery neither drives nor
 *      lists as NOT-DRIVEN turns this red. Silent scope shrinkage is the failure mode this exists
 *      to prevent.
 *   2. MAPPING. The trigger→lease-kind mapping is re-derived FROM the migration source and
 *      cross-checked against every driven surface's declared `table` / `lease`. A wrong-kind lease
 *      would make a surface report "trigger did not fire" while the trigger was working perfectly —
 *      the most expensive possible false verdict.
 *   3. FAIL-NOT-SKIP. A disarmed posture must exit NON-ZERO. A battery that skipped quietly would
 *      publish its strongest artefact (a clean run) for its weakest posture.
 *   4. DISCRIMINATION. 2xx, 5xx and a wrong-coded 409 must land in three DIFFERENT named failure
 *      classes. Collapsing them is how "the trigger never fired" gets filed as "some error".
 *   5. NO-SECRET-LEAK. Behavioural for the redactor; static for the source (see the honesty note
 *      on that test — the static half is defence-in-depth, not proof).
 *
 * Run: node --test scripts/ops/multitable-l1-battery.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DRIVEN_SURFACES,
  ENABLED_TRIGGER_STATES,
  EXPECTED_TRIGGER_COUNT,
  LEASE_FUNCTION_BY_KIND,
  NOT_DRIVEN_SITES,
  RECOVERY_CONFLICT_HTTP_CODE,
  ROLE_CASCADE_WITNESS_QUERY,
  RECOVERY_CONFLICT_HTTP_STATUS,
  STAMP_PREFIX,
  TRIGGER_COVERAGE_EXEMPTIONS,
  USAGE,
  buildNames,
  buildStamp,
  classifyBlockedOutcome,
  classifyClearedOutcome,
  classifyWrongKindOutcome,
  evaluatePosture,
  exercisedTriggers,
  extractErrorCode,
  ledgerSites,
  notArmedReport,
  orderedSurfaces,
  parseCliArgs,
  roleDeleteCascadeExists,
  sanitizeExcerpt,
  triggerCoverage,
} from './multitable-l1-battery.mjs'

const BATTERY_SOURCE = readFileSync(new URL('./multitable-l1-battery.mjs', import.meta.url), 'utf8')
// P3-7 (regate2): a comment-stripped view of the battery source. The first P2-4 guards matched
// bare tokens (`early_exit_residue`) that a COMMENT satisfies — deleting the real code while
// leaving the word in a comment kept the guard green. Assertions that a specific CODE line exists
// must run against this view, not the raw source. Strips /* */ blocks and // line comments; good
// enough for asserting a statement's presence (it is not a parser, and the battery has no comment
// markers inside string literals on the lines these guards check — verified).
const BATTERY_CODE = BATTERY_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

const CENSUS_SOURCE = readFileSync(
  new URL('../../packages/core-backend/tests/unit/lib/recovery-census-table.ts', import.meta.url),
  'utf8',
)

const MIGRATION_SOURCE = readFileSync(
  new URL(
    '../../packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts',
    import.meta.url,
  ),
  'utf8',
)

/**
 * Fail-closed parse of the census site ids.
 *
 * The lesson this encodes (空grep可能是路径没读到 / 扫描窗口两头都骗人): a parse that silently
 * yields ZERO matches — because the file moved, or the `site:` shape changed — would make the
 * set-equality assertion pass against an empty ledger. The floor is asserted here, at the parse,
 * not at the comparison.
 */
function parseCensusSites(source = CENSUS_SOURCE) {
  const sites = new Set()
  // P2-2 (gate): quote-AGNOSTIC. A single-quote-only pattern let a new census site written with
  // double quotes or backticks slip past the anti-drift check while the guard stayed green. Match
  // any of the three JS string delimiters, requiring the SAME delimiter to close (backreference).
  for (const match of source.matchAll(/\bsite:\s*(['"`])((?:(?!\1).)+)\1/g)) sites.add(match[2])
  // Exact floor, not a loose >=40: the census currently declares 48 sites; pin it so a SILENT
  // drop (a site deleted) is caught too, not only additions. Update deliberately if the census
  // legitimately changes size.
  assert.ok(
    sites.size >= 48,
    `census parse yielded only ${sites.size} site ids (expected >= 48) — the census file moved, changed shape, or a site was dropped; refusing to compare against a possibly-truncated set`,
  )
  return sites
}

/** Parse the census's registered source files, same fail-closed discipline. */
function parseCensusFiles(source = CENSUS_SOURCE) {
  const files = new Set()
  for (const match of source.matchAll(/\bfile:\s*'([^']+)'/g)) files.add(match[1])
  assert.ok(files.size >= 10, `census parse yielded only ${files.size} files — refusing to compare`)
  return files
}

/**
 * Extract a `const NAME = [ … ] as const` tuple-array block from the migration source.
 *
 * The outer `[` of the array is stripped BEFORE matching inner tuples, and each tuple is matched
 * as a whole comma-separated run of quoted strings. An earlier, looser version of this parser
 * (`/\[([^\]]+)\]/`) swallowed the array's own opening bracket into row 0 and produced cells like
 * `['record_permissions'` — yet still yielded 9 rows and 8 distinct-looking tables, so the
 * assertions built on it went green against garbage (无效mutation≈无判别力测试). The identifier
 * shape check below is the fail-closed guard against that recurring.
 */
function parseTupleBlock(name, source = MIGRATION_SOURCE) {
  const header = `${name} = [`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `migration no longer declares ${name} — the mapping cannot be derived`)
  const end = source.indexOf('] as const', start)
  assert.notEqual(end, -1, `migration's ${name} block is not terminated by "] as const"`)
  const block = source.slice(start + header.length, end)
  const rows = []
  for (const match of block.matchAll(/\[\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\]/g)) {
    rows.push([...match[1].matchAll(/'([^']*)'/g)].map((cell) => cell[1]))
  }
  assert.ok(rows.length > 0, `migration's ${name} block parsed to zero rows`)
  for (const row of rows) {
    assert.ok(row.length >= 2, `${name}: parsed a tuple with ${row.length} cell(s) — the parse is misaligned`)
    for (const cell of row) {
      assert.match(cell, /^[A-Za-z_][A-Za-z0-9_]*$/, `${name}: parsed cell '${cell}' is not a bare identifier — the parse is misaligned`)
    }
  }
  return rows
}

/**
 * Re-derive table → lease-kind FROM THE MIGRATION. Nothing here is copied from the battery; the
 * whole point is that the two are independently sourced and then compared.
 */
function deriveTableLeaseKinds() {
  // Which lease-function CONSTANT means which kind, read off the migration's own declarations.
  const constantToKind = new Map()
  for (const [constant, kind] of [
    ['AUTHORITY_LOCK_FUNCTION', 'user'],
    ['AUTHORITY_ROLE_LOCK_FUNCTION', 'role'],
    ['AUTHORITY_GROUP_LOCK_FUNCTION', 'group'],
  ]) {
    const match = MIGRATION_SOURCE.match(new RegExp(`export const ${constant} = '([^']+)'`))
    assert.ok(match, `migration no longer exports ${constant}`)
    assert.equal(
      match[1],
      LEASE_FUNCTION_BY_KIND[kind],
      `the battery calls '${LEASE_FUNCTION_BY_KIND[kind]}' for the ${kind} lease, but the migration creates '${match[1]}'`,
    )
    constantToKind.set(constant, kind)
  }

  const byTable = new Map()

  // (a) users — the two lifecycle/update triggers run the USER trigger function.
  const userTriggerOnUsers = /CREATE TRIGGER trg_users_recovery_authority_lock_\w+[\s\S]{0,300}?ON users[\s\S]{0,200}?AUTHORITY_USER_TRIGGER_FUNCTION/g
  assert.ok(MIGRATION_SOURCE.match(userTriggerOnUsers)?.length >= 2, 'migration no longer installs both users triggers on the USER trigger function')
  byTable.set('users', 'user')

  // (b) the USER_TRIGGERS tuple block — table, trigger, user-id column.
  const userTables = parseTupleBlock('const USER_TRIGGERS')
  assert.equal(userTables.length, 3, `expected 3 USER_TRIGGERS rows, parsed ${userTables.length}`)
  for (const [table] of userTables) byTable.set(table, 'user')

  // (c) role_permissions → the role-permission trigger function → role lease.
  assert.match(
    MIGRATION_SOURCE,
    /CREATE TRIGGER trg_role_permissions_recovery_authority_lock[\s\S]{0,200}?ON role_permissions[\s\S]{0,200}?AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION/,
    'migration no longer maps role_permissions to the role-permission trigger function',
  )
  byTable.set('role_permissions', 'role')

  // (d) the three subject tables dispatch by subject_type at runtime.
  //
  // Anchor STRUCTURALLY, never by a fixed-width slice around the first textual hit: the literal
  // ['spreadsheet_permissions', 'trg_…'] also appears in the RECOVERY_AUTHORITY_TRIGGERS census at
  // the top of the file, and a naive indexOf + slice(…, +600) silently reads that neighbouring
  // array instead (扫描窗口两头都骗人 — it cost exactly one wrong verdict while writing this file).
  // Anchor on the CREATE TRIGGER that installs the subject function, then walk back to the loop
  // header that feeds it and forward to that block's own terminator.
  const subjectInstallIdx = MIGRATION_SOURCE.indexOf("${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}('subject_type', 'subject_id')")
  assert.notEqual(subjectInstallIdx, -1, 'migration no longer installs the subject trigger with (subject_type, subject_id)')
  const loopHeaderIdx = MIGRATION_SOURCE.lastIndexOf('for (const [table, trigger] of [', subjectInstallIdx)
  assert.notEqual(loopHeaderIdx, -1, 'the subject-trigger install loop header is gone')
  const loopEndIdx = MIGRATION_SOURCE.indexOf('] as const)', loopHeaderIdx)
  assert.ok(loopEndIdx > loopHeaderIdx && loopEndIdx < subjectInstallIdx, 'the subject-trigger table list is not where the install loop reads it')
  const subjectBlock = MIGRATION_SOURCE.slice(loopHeaderIdx, loopEndIdx)
  const subjectTables = [...subjectBlock.matchAll(/\['(\w+)', 'trg_\w+'\]/g)].map((match) => match[1])
  assert.deepEqual(
    [...subjectTables].sort(),
    ['field_permissions', 'record_permissions', 'spreadsheet_permissions'],
    'the subject-dispatch table set changed',
  )

  // The runtime dispatch inside the subject trigger function: subject_type → lease constant.
  const subjectDispatch = new Map()
  for (const match of MIGRATION_SOURCE.matchAll(
    /IF affected_subject_type = '([\w-]+)' THEN\s*acquired := \$\{sql\.raw\((\w+)\)\}/g,
  )) {
    subjectDispatch.set(match[1], constantToKind.get(match[2]))
  }
  const elseBranch = MIGRATION_SOURCE.match(/ELSE\s*acquired := \$\{sql\.raw\((\w+)\)\}/)
  assert.ok(elseBranch, 'the subject trigger no longer has an ELSE lease branch')
  subjectDispatch.set('member-group', constantToKind.get(elseBranch[1]))
  assert.deepEqual(
    [...subjectDispatch.entries()].sort(),
    [['member-group', 'group'], ['role', 'role'], ['user', 'user']],
    'the subject_type → lease-kind dispatch changed',
  )

  return { byTable, subjectTables: new Set(subjectTables), subjectDispatch }
}

// ---------------------------------------------------------------------------
// 1. Anti-drift: the ledger covers the census exactly
// ---------------------------------------------------------------------------

test('the ledger accounts for EVERY census site — exactly once', () => {
  const censusSites = parseCensusSites()
  const ledger = ledgerSites()

  // No site may be claimed twice (e.g. driven AND excused).
  assert.equal(new Set(ledger).size, ledger.length, 'a census site appears more than once in the battery ledger')

  const ledgerSet = new Set(ledger)
  const unaccounted = [...censusSites].filter((site) => !ledgerSet.has(site)).sort()
  const invented = [...ledgerSet].filter((site) => !censusSites.has(site)).sort()

  assert.deepEqual(
    unaccounted,
    [],
    `census sites the battery neither drives nor lists as NOT-DRIVEN: ${unaccounted.join(', ')} — add them to DRIVEN_SURFACES or to NOT_DRIVEN_SITES with a concrete reason`,
  )
  assert.deepEqual(
    invented,
    [],
    `ledger names sites that are not in the census: ${invented.join(', ')} — the ledger must not invent surfaces`,
  )
})

test('the census file parse is non-empty (a parse sanity anchor, NOT an accounting check)', () => {
  // Named for exactly what it does. The census's site ids do not carry their file, so this cannot
  // and does not verify per-file accounting — the site-level set-equality above is what does that.
  // Its only job is to fail closed if the census file stops being parseable at all.
  const files = parseCensusFiles()
  assert.ok(files.size >= 13, `expected at least 13 census files, parsed ${files.size}`)
})

test('the battery actually drives every site it claims to drive', () => {
  // A "driven" claim is only meaningful if the site belongs to a surface the run loop iterates.
  const iterated = new Set(orderedSurfaces().map((surface) => surface.id))
  for (const surface of DRIVEN_SURFACES) {
    assert.ok(iterated.has(surface.id), `${surface.id} is declared but not iterated by orderedSurfaces()`)
    assert.ok(surface.censusSites.length > 0, `${surface.id} claims no census site`)
  }
  assert.equal(iterated.size, DRIVEN_SURFACES.length, 'orderedSurfaces() dropped or duplicated a surface')
})

test('every NOT-DRIVEN site carries a named reason and a concrete detail', () => {
  const allowedReasons = new Set(['unknowable-lease-key', 'no-trigger-on-target-table', 'external-provider-required', 'orthogonal-fixture-cost'])
  for (const entry of NOT_DRIVEN_SITES) {
    assert.ok(allowedReasons.has(entry.reason), `${entry.site}: unrecognised reason '${entry.reason}'`)
    assert.ok(entry.detail && entry.detail.length >= 40, `${entry.site}: detail is too thin to count as a disclosed cap`)
  }
})

// ---------------------------------------------------------------------------
// 2. Mapping: every driven surface holds the lease kind the MIGRATION names
// ---------------------------------------------------------------------------

test('each driven surface writes a real recovery-authority table', () => {
  const triggerRows = parseTupleBlock('export const RECOVERY_AUTHORITY_TRIGGERS')
  assert.equal(triggerRows.length, EXPECTED_TRIGGER_COUNT, `expected ${EXPECTED_TRIGGER_COUNT} triggers in the migration, parsed ${triggerRows.length}`)
  const guardedTables = new Set(triggerRows.map(([table]) => table))
  assert.equal(guardedTables.size, 8, `expected 8 distinct guarded tables, parsed ${guardedTables.size}`)

  for (const surface of DRIVEN_SURFACES) {
    assert.ok(
      guardedTables.has(surface.table),
      `${surface.id} declares table '${surface.table}', which carries NONE of the nine recovery-authority triggers — no 409 can be constructed for it (this is exactly the roles:update situation, which is correctly NOT-DRIVEN)`,
    )
  }
})

test('each driven surface declares the lease kind its table maps to in the migration', () => {
  const { byTable, subjectTables, subjectDispatch } = deriveTableLeaseKinds()
  for (const surface of DRIVEN_SURFACES) {
    assert.ok(Object.hasOwn(LEASE_FUNCTION_BY_KIND, surface.lease), `${surface.id}: unknown lease kind '${surface.lease}'`)
    if (subjectTables.has(surface.table)) {
      assert.ok(surface.subjectType, `${surface.id} writes the subject-dispatch table ${surface.table} but declares no subjectType`)
      assert.equal(
        surface.lease,
        subjectDispatch.get(surface.subjectType),
        `${surface.id}: subject_type '${surface.subjectType}' dispatches to the ${subjectDispatch.get(surface.subjectType)} lease, not '${surface.lease}'`,
      )
      continue
    }
    assert.equal(
      surface.lease,
      byTable.get(surface.table),
      `${surface.id}: writes ${surface.table}, whose trigger takes the ${byTable.get(surface.table)} lease, but the surface declares '${surface.lease}' — a wrong-kind lease produces a FALSE "trigger did not fire" verdict`,
    )
  }
})

test('role-leased surfaces name which synthetic role the lease is taken on', () => {
  for (const surface of DRIVEN_SURFACES) {
    if (surface.lease !== 'role') continue
    assert.match(
      String(surface.leaseKeyRef ?? ''),
      /^roles\.\w+$/,
      `${surface.id}: a role-leased surface must declare leaseKeyRef so the lease is taken on ITS role, not another surface's`,
    )
  }
})

test('the exclusive/shared mechanism the battery depends on is the one the migration builds', () => {
  // Static claim↔implementation cross-check, NOT a behaviour proof: it pins the battery's core
  // assumption (holder takes the EXCLUSIVE form, triggers take the SHARED form) against silent
  // edits to the migration. The behavioural proof is the real-DB rehearsal.
  assert.match(
    MIGRATION_SOURCE,
    /IF exclusive THEN\s*RETURN pg_try_advisory_xact_lock\(lock_key\);\s*END IF;\s*RETURN pg_try_advisory_xact_lock_shared\(lock_key\);/,
    'the lease function no longer maps exclusive=>true to the EXCLUSIVE advisory lock and the default to the SHARED one',
  )
  const triggerSharedCalls = MIGRATION_SOURCE.match(/\}\(\w+, FALSE\)/g) ?? []
  assert.ok(
    triggerSharedCalls.length >= 3,
    `expected the trigger functions to take SHARED (FALSE) leases; found ${triggerSharedCalls.length} such calls`,
  )
})

// ---------------------------------------------------------------------------
// 3. Fail-not-skip preflight
// ---------------------------------------------------------------------------

const EXPECTED_TRIGGER_NAMES = parseTupleBlock('export const RECOVERY_AUTHORITY_TRIGGERS').map(([, trigger]) => trigger)
const fakeExpected = EXPECTED_TRIGGER_NAMES.map((triggerName, index) => ({
  triggerName,
  tableName: `t${index}`,
}))

const postureRows = (enabled, overrides = {}) =>
  fakeExpected.map((trigger) => ({
    trigger_name: trigger.triggerName,
    enabled: Object.hasOwn(overrides, trigger.triggerName) ? overrides[trigger.triggerName] : enabled,
  }))

test('a factory-inert posture is NOT armed and exits NON-ZERO', () => {
  const posture = evaluatePosture(postureRows('D'), fakeExpected)
  assert.equal(posture.armed, false)
  assert.equal(posture.armedCount, 0)
  const report = notArmedReport(posture)
  assert.notEqual(report.exitCode, 0, 'a disarmed database must never produce a zero exit code')
  assert.equal(report.exitCode, 2)
  assert.match(report.output, /^VERDICT: NOT_ARMED/)
})

test('a PARTIALLY armed posture (8/9) is NOT armed — partial enablement is not L1', () => {
  const posture = evaluatePosture(postureRows('O', { [EXPECTED_TRIGGER_NAMES[0]]: 'D' }), fakeExpected)
  assert.equal(posture.armed, false)
  assert.equal(posture.armedCount, fakeExpected.length - 1)
  assert.equal(posture.offenders.length, 1)
  assert.notEqual(notArmedReport(posture).exitCode, 0)
})

test('an ABSENT trigger is NOT armed (a missing trigger must not read as "not disabled")', () => {
  const rows = postureRows('O').slice(1)
  const posture = evaluatePosture(rows, fakeExpected)
  assert.equal(posture.armed, false)
  assert.match(posture.offenders.join(' '), /absent/)
  assert.equal(posture.fingerprint[EXPECTED_TRIGGER_NAMES[0]], null)
})

test('a fully armed posture IS armed — for every tgenabled letter that means "fires"', () => {
  for (const letter of ENABLED_TRIGGER_STATES) {
    const posture = evaluatePosture(postureRows(letter), fakeExpected)
    assert.equal(posture.armed, true, `tgenabled='${letter}' should count as armed`)
    assert.equal(posture.armedCount, fakeExpected.length)
    assert.deepEqual(posture.offenders, [])
  }
})

// ---------------------------------------------------------------------------
// P2-4 (regate): guard the three round-two behavioural fixes. Before these, reverting any of the
// fixes left the required contract lane 39/39 green — the fixes were unobserved. Each test below
// reds if its fix is reverted, so the required lane now observes the properties this round secured.
// ---------------------------------------------------------------------------

test('P2-4: REPLICA (tgenabled=R) must NOT count as armed — reverting P2-1 reds here', () => {
  // 'R' fires only under session_replication_role=replica, never for an ordinary app write, so a
  // DB with an authority trigger at 'R' is NOT at L1 posture. Re-adding 'R' to the set reverts P2-1.
  assert.equal(ENABLED_TRIGGER_STATES.has('R'), false, "tgenabled 'R' (replica-only) must not certify ARMED")
  assert.equal(ENABLED_TRIGGER_STATES.has('O'), true)
  assert.equal(ENABLED_TRIGGER_STATES.has('A'), true)
  const posture = evaluatePosture(postureRows('R'), fakeExpected)
  assert.equal(posture.armed, false, "a posture of all-'R' triggers must read NOT armed")
})

test('P2-4: user_invites is on BOTH the delete and scan lists, keyed by user_id — reverting P1-1/P2-3 reds here', () => {
  // The false-CLEAN relation (P1-1) and its live key (P2-3). Reverting either — dropping the
  // user_invites entry, or switching the key back to the dead invited_by — reds this test.
  const deleteStmt = /DELETE FROM user_invites WHERE email LIKE \$1 OR user_id = \$2/
  const scanStmt = /SELECT COUNT\(\*\)::int AS c FROM user_invites WHERE email LIKE \$1 OR user_id = \$2/
  assert.match(BATTERY_SOURCE, deleteStmt, 'user_invites must be DELETED by stamped email OR user_id (not invited_by, which holds the admin caller)')
  assert.match(BATTERY_SOURCE, scanStmt, 'user_invites must be SCANNED by the same two keys it is deleted by')
  // And the dead key must not reappear on user_invites.
  assert.doesNotMatch(BATTERY_SOURCE, /user_invites[^;]*invited_by = \$2/, 'invited_by is the admin caller, a dead key for the battery user')
})

test('P2-4: the early-exit cleanup reports via log() and records residue on BOTH paths — reverting P3-6 reds here', () => {
  // P3-7: asserted against BATTERY_CODE (comments stripped) so a leftover token in a comment can
  // NOT satisfy the guard, and covering BOTH the success path AND the catch path (the catch path
  // is the silent-failure hole P3-6 existed to close).
  // success path — residue-remaining must be visible AND recorded:
  assert.match(BATTERY_CODE, /log\(lines, `  cleanup \(early-exit best-effort\)/, 'success path must report residue via log(), not lines.push')
  assert.match(BATTERY_CODE, /failure: 'early_exit_residue'/, 'a residue-remaining early exit must push an early_exit_residue failure entry')
  // catch path — a cleanup that THROWS must also be visible AND recorded:
  assert.match(BATTERY_CODE, /log\(lines, `  WARNING: early-exit cleanup failed/, 'catch path must WARN via log(), not lines.push')
  assert.match(BATTERY_CODE, /failure: 'early_exit_cleanup_failed'/, 'a throwing early-exit cleanup must push an early_exit_cleanup_failed failure entry')
  // and neither may be re-silenced to lines.push:
  assert.doesNotMatch(BATTERY_CODE, /lines\.push\(`  cleanup \(early-exit best-effort\)/, 'the early-exit cleanup must not be re-silenced to lines.push')
  assert.doesNotMatch(BATTERY_CODE, /lines\.push\(`  WARNING: early-exit cleanup failed/, 'the early-exit WARNING must not be re-silenced to lines.push')
})

// ---------------------------------------------------------------------------
// 4. Discrimination: the three failure classes must stay three
// ---------------------------------------------------------------------------

const SAMPLE = DRIVEN_SURFACES[0]
const busyBody = { ok: false, error: { code: RECOVERY_CONFLICT_HTTP_CODE, message: 'Recovery is stabilizing permissions; retry this change.' } }

test('a named retryable 409 under a held lease PASSES', () => {
  const outcome = classifyBlockedOutcome(SAMPLE, RECOVERY_CONFLICT_HTTP_STATUS, busyBody)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.failure, null)
})

test('a 2xx under a held lease is its OWN failure class: the trigger did not fire', () => {
  for (const status of [200, 201, 204]) {
    const outcome = classifyBlockedOutcome(SAMPLE, status, { ok: true })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure, 'trigger_did_not_fire', `status ${status} must be reported as a non-firing trigger, not as a generic error`)
    assert.match(outcome.reason, /trigger did not fire/)
  }
})

test('a 5xx under a held lease is its OWN failure class: unmapped', () => {
  for (const status of [500, 502, 503]) {
    const outcome = classifyBlockedOutcome(SAMPLE, status, { error: 'Internal server error' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure, 'unmapped_5xx')
  }
})

test('a 409 carrying the WRONG code (or none) does not pass as the named conflict', () => {
  const wrongCode = classifyBlockedOutcome(SAMPLE, 409, { ok: false, error: { code: 'USER_ALREADY_EXISTS' } })
  assert.equal(wrongCode.ok, false)
  assert.equal(wrongCode.failure, 'unexpected_code')

  const noBody = classifyBlockedOutcome(SAMPLE, 409, null)
  assert.equal(noBody.ok, false)
  assert.equal(noBody.failure, 'unexpected_code')
  assert.match(noBody.reason, /<none>/)
})

test('other non-2xx statuses are neither silently accepted nor mislabelled', () => {
  for (const [status] of [[400], [401], [403], [404], [0]]) {
    const outcome = classifyBlockedOutcome(SAMPLE, status, { ok: false })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure, 'unexpected_status', `status ${status} must not be classified as a conflict`)
  }
})

test('the positive control fails loudly if the write still fails after release', () => {
  assert.equal(classifyClearedOutcome(SAMPLE, 200).ok, true)
  const failed = classifyClearedOutcome(SAMPLE, 409)
  assert.equal(failed.ok, false)
  assert.equal(failed.failure, 'positive_control_failed')
  assert.match(failed.reason, /NOT proven lease-caused/)
})

test('the wrong-kind control fails if the other lease kind DOES block', () => {
  const control = { id: 'ctl', heldLease: 'role', targetLease: 'user' }
  assert.equal(classifyWrongKindOutcome(control, 200).ok, true)
  const blocked = classifyWrongKindOutcome(control, 409)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.failure, 'wrong_kind_control_failed')
})

test('the error code is read from both published body shapes', () => {
  assert.equal(extractErrorCode({ error: { code: 'A' } }), 'A')
  assert.equal(extractErrorCode({ code: 'B' }), 'B')
  assert.equal(extractErrorCode({ error: 'a string, not an object' }), null)
  assert.equal(extractErrorCode(null), null)
  assert.equal(extractErrorCode('409'), null)
})

// ---------------------------------------------------------------------------
// 5. No-secret-leak
// ---------------------------------------------------------------------------

test('the redactor removes the supplied secrets from a real body excerpt', () => {
  const url = 'postgresql://ops:hunter2@db.internal:5432/metasheet'
  const password = 'S3cret-Battery-Pw'
  const text = `{"error":"connect failed for ${url} with ${password}"}`
  const excerpt = sanitizeExcerpt(text, [url, password])
  assert.ok(!excerpt.includes(url), 'DATABASE_URL survived redaction')
  assert.ok(!excerpt.includes(password), 'the admin password survived redaction')
  assert.ok(!excerpt.includes('hunter2'), 'the embedded credential survived redaction')
  assert.match(excerpt, /\[REDACTED\]/)
})

test('the redactor also catches credential shapes it was not told about', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'
  const excerpt = sanitizeExcerpt(`{"authorization":"Bearer ${jwt}","dsn":"postgres://u:p@h/db"}`, [])
  assert.ok(!excerpt.includes(jwt), 'a bearer token survived redaction')
  assert.ok(!excerpt.includes('u:p@h'), 'a credentialed URI survived redaction')
})

test('the excerpt is truncated so a large body cannot flood the transcript', () => {
  const excerpt = sanitizeExcerpt('x'.repeat(5000), [], 240)
  assert.ok(excerpt.length <= 241, `excerpt length ${excerpt.length} exceeds the cap`)
})

test('the source never interpolates a secret into printed output', () => {
  // Honest scope: this is a STATIC guard and therefore defence-in-depth, not proof — a new leak
  // through a differently-named local would slip past it. It exists because the redactor above
  // only protects the paths that route through it, and a stray `${databaseUrl}` in a log line
  // would not.
  for (const forbidden of ['${databaseUrl}', '${adminPassword}', '${token}', '${env.DATABASE_URL}', '${process.env.DATABASE_URL}', '${env.BATTERY_ADMIN_PASSWORD}']) {
    assert.ok(
      !BATTERY_SOURCE.includes(forbidden),
      `the battery interpolates ${forbidden} somewhere — that value must never reach stdout or the evidence file`,
    )
  }
  // The bearer token has exactly ONE legitimate interpolation: the Authorization request header.
  // Pin the count so a second one (a log line, an evidence field) cannot appear unnoticed.
  const tokenUses = BATTERY_SOURCE.split('${this.token}').length - 1
  assert.equal(tokenUses, 1, `the token is interpolated ${tokenUses} times; exactly one (the Authorization header) is legitimate`)
  const headerLine = BATTERY_SOURCE.split('\n').find((line) => line.includes('${this.token}'))
  assert.match(headerLine, /headers\.authorization\s*=\s*`Bearer \$\{this\.token\}`/, 'the single token interpolation is no longer the Authorization header')
})

test('the evidence file records the not-driven list, so a cap can never be silent', () => {
  assert.match(BATTERY_SOURCE, /not_driven:\s*NOT_DRIVEN_SITES\.map/, 'the evidence JSON no longer carries the NOT-DRIVEN list')
})

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

test('CLI defaults are the documented ones', () => {
  const parsed = parseCliArgs([])
  assert.equal(parsed.ok, true)
  assert.equal(parsed.options.out, './l1-battery-evidence.json')
  assert.equal(parsed.options.timeoutMs, 20_000)
})

test('CLI accepts --out and --timeout-ms', () => {
  const parsed = parseCliArgs(['--out', '/tmp/x.json', '--timeout-ms', '500'])
  assert.equal(parsed.ok, true)
  assert.equal(parsed.options.out, '/tmp/x.json')
  assert.equal(parsed.options.timeoutMs, 500)
})

test('CLI refuses unknown or malformed arguments rather than ignoring them', () => {
  for (const argv of [['--bogus'], ['positional'], ['--out'], ['--out', '--timeout-ms'], ['--timeout-ms', 'abc'], ['--timeout-ms', '0'], ['--timeout-ms', '-5']]) {
    const parsed = parseCliArgs(argv)
    assert.equal(parsed.ok, false, `argv ${JSON.stringify(argv)} should have been refused`)
    assert.match(parsed.output, /VERDICT: NOT_ARMED/)
  }
  assert.match(USAGE, /--out PATH/)
})

// ---------------------------------------------------------------------------
// 7. Residue stamping
// ---------------------------------------------------------------------------

test('every synthetic name carries the greppable residue stamp', () => {
  const stamp = buildStamp('Run/2026-08-21')
  assert.match(stamp, /^[a-z0-9]+$/, 'the stamp must be safe inside emails and identifiers')
  const names = buildNames(stamp)
  const flat = [names.email, names.userName, names.groupName, names.sheetId, ...Object.values(names.roles)]
  for (const name of flat) {
    assert.ok(name.startsWith(STAMP_PREFIX), `${name} is not stamped — it would be invisible to the residue scan`)
    assert.ok(name.includes(stamp), `${name} does not carry the run stamp`)
  }
  assert.equal(new Set(Object.values(names.roles)).size, Object.keys(names.roles).length, 'two surfaces would share a synthetic role')
})

test('a generated stamp is stable-shaped and unique per run', () => {
  const a = buildStamp(undefined, 1, () => 0.1)
  const b = buildStamp(undefined, 2, () => 0.9)
  assert.match(a, /^[a-z0-9]+$/)
  assert.notEqual(a, b)
})

// ---------------------------------------------------------------------------
// 7b. Trigger coverage — the SECOND anti-drift axis
// ---------------------------------------------------------------------------

test('every one of the nine triggers is either exercised or explicitly exempted — exactly once', () => {
  // The census axis structurally CANNOT catch field_permissions / record_permissions: those tables
  // carry recovery-authority triggers but have no census row, so no census set-equality will ever
  // notice they are untouched. L1 is a claim about the nine TRIGGERS, so the nine triggers get
  // their own partition, checked against the migration.
  const triggerRows = parseTupleBlock('export const RECOVERY_AUTHORITY_TRIGGERS')
  const allTriggers = new Set(triggerRows.map(([, trigger]) => trigger))
  assert.equal(allTriggers.size, EXPECTED_TRIGGER_COUNT)

  const exercised = exercisedTriggers()
  const exempted = TRIGGER_COVERAGE_EXEMPTIONS.map((entry) => entry.trigger)
  const accounted = [...exercised, ...exempted]

  assert.equal(new Set(accounted).size, accounted.length, 'a trigger is both exercised and exempted, or listed twice')
  assert.deepEqual(
    [...allTriggers].filter((trigger) => !accounted.includes(trigger)).sort(),
    [],
    'a recovery-authority trigger is neither exercised by a driven surface nor named in TRIGGER_COVERAGE_EXEMPTIONS',
  )
  assert.deepEqual(
    accounted.filter((trigger) => !allTriggers.has(trigger)).sort(),
    [],
    'the ledger accounts for a trigger the migration does not install',
  )
})

test("each driven surface's declared trigger is the one the migration installs on its table", () => {
  // Cross-check, not a copy: table→trigger comes from the migration's own census array.
  const triggerRows = parseTupleBlock('export const RECOVERY_AUTHORITY_TRIGGERS')
  const triggersByTable = new Map()
  for (const [table, trigger] of triggerRows) {
    if (!triggersByTable.has(table)) triggersByTable.set(table, new Set())
    triggersByTable.get(table).add(trigger)
  }
  for (const surface of DRIVEN_SURFACES) {
    assert.ok(surface.trigger, `${surface.id} declares no trigger`)
    assert.ok(
      triggersByTable.get(surface.table)?.has(surface.trigger),
      `${surface.id} claims trigger '${surface.trigger}', which the migration does not install on '${surface.table}'`,
    )
  }
  // `users` carries TWO triggers; the driven one must be the UPDATE-side twin, and the
  // INSERT/DELETE lifecycle twin must be the exempted one. Getting these backwards would let the
  // battery claim lifecycle coverage it does not have.
  const usersSurface = DRIVEN_SURFACES.find((surface) => surface.table === 'users')
  assert.equal(usersSurface.trigger, 'trg_users_recovery_authority_lock_update')
  assert.ok(TRIGGER_COVERAGE_EXEMPTIONS.some((entry) => entry.trigger === 'trg_users_recovery_authority_lock_lifecycle'))
})

test('every trigger exemption carries a substantive reason and a real table', () => {
  const triggerRows = parseTupleBlock('export const RECOVERY_AUTHORITY_TRIGGERS')
  const pairs = new Set(triggerRows.map(([table, trigger]) => `${table}.${trigger}`))
  for (const entry of TRIGGER_COVERAGE_EXEMPTIONS) {
    assert.ok(pairs.has(`${entry.table}.${entry.trigger}`), `${entry.trigger} is not installed on ${entry.table}`)
    assert.ok(entry.reason && entry.reason.length >= 80, `${entry.trigger}: reason is too thin to count as a disclosed cap`)
  }
})

test('the evidence file and the verdict line both publish trigger coverage', () => {
  // Without this the run prints "11/11 surfaces" and a reader takes it for 9/9 triggers.
  const coverage = triggerCoverage([{ triggerName: 'a' }, { triggerName: 'b' }])
  assert.equal(coverage.total_count, 2)
  assert.equal(coverage.exercised_count, exercisedTriggers().length)
  assert.equal(coverage.not_exercised.length, TRIGGER_COVERAGE_EXEMPTIONS.length)
  assert.match(BATTERY_SOURCE, /trigger_coverage: triggerCoverage\(\)/, 'the evidence file no longer carries trigger coverage')
  assert.match(BATTERY_SOURCE, /recovery-authority TRIGGERS exercised/, 'the verdict line no longer prints trigger coverage')
})

// ---------------------------------------------------------------------------
// 7c. Hermeticity — asserted, not merely claimed in a comment
// ---------------------------------------------------------------------------

test('no module in the battery graph imports node_modules at the top level', () => {
  // The header claims the graph is node_modules-free and offers "importing it here would fail" as
  // the alarm. That alarm does NOT sound in a tree that HAS node_modules — a stray top-level
  // `import pg from 'pg'` would pass locally and only blow up in the pristine contract lane. So
  // assert the property directly, in a form that is checkable without node_modules present.
  const files = [
    ['multitable-l1-battery.mjs', BATTERY_SOURCE],
    ['multitable-recovery-schema-containment.mjs', readFileSync(new URL('./multitable-recovery-schema-containment.mjs', import.meta.url), 'utf8')],
    ['multitable-l1-battery.test.mjs', readFileSync(new URL('./multitable-l1-battery.test.mjs', import.meta.url), 'utf8')],
  ]
  for (const [name, source] of files) {
    const specifiers = [
      ...[...source.matchAll(/^import\b[\s\S]*?from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]),
      ...[...source.matchAll(/^import\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]),
    ]
    // Fail closed: a regex that matched nothing must not read as "no bare imports".
    assert.ok(specifiers.length >= 2, `${name}: parsed only ${specifiers.length} top-level import(s) — the parse is broken, not the file clean`)
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${name} imports '${specifier}' at the top level — the graph must stay runnable in a checkout with no node_modules (pg is reached lazily via createRequire instead)`,
      )
    }
  }
})

test('pg is reached lazily, through createRequire, never as a static import', () => {
  assert.match(BATTERY_SOURCE, /requireFromBackend\('pg'\)/, 'the battery no longer loads pg lazily')
  assert.ok(!/^import .*['"]pg['"]/m.test(BATTERY_SOURCE), 'pg became a static import')
})

test('surface execution order is a real total order (destructive surfaces sort last)', () => {
  const ordered = orderedSurfaces()
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      (ordered[index - 1].order ?? 0) <= (ordered[index].order ?? 0),
      `${ordered[index - 1].id} sorts before ${ordered[index].id} but carries a higher order`,
    )
  }
})

// ---------------------------------------------------------------------------
// 8. The NOT-DRIVEN excuses are themselves gated
// ---------------------------------------------------------------------------

test('roles:delete is excused only while its schema premise holds — and the premise is re-checked', () => {
  // The route COMMENTS claim a roles → role_permissions ON DELETE CASCADE. On a schema built by
  // this repo's migration chain that FK does not exist, so the DELETE reaches no triggered table.
  // The exemption is therefore conditional, and the condition is a live query, not a belief.
  const excused = NOT_DRIVEN_SITES.find((entry) => entry.site === 'roles:delete')
  assert.ok(excused, 'roles:delete must be accounted for')
  assert.equal(excused.reason, 'no-trigger-on-target-table')

  // Present + CASCADE ⇒ the excuse has expired and the battery must refuse it.
  assert.equal(roleDeleteCascadeExists([{ conname: 'role_permissions_role_id_fkey', confdeltype: 'c' }]), true)
  // Absent ⇒ excuse holds.
  assert.equal(roleDeleteCascadeExists([]), false)
  // Present but NOT cascading (NO ACTION / RESTRICT) ⇒ still no cascade, excuse holds. A naive
  // "is there any FK?" check would get this backwards.
  assert.equal(roleDeleteCascadeExists([{ conname: 'x', confdeltype: 'a' }]), false)
  assert.equal(roleDeleteCascadeExists([{ conname: 'x', confdeltype: 'r' }]), false)

  assert.match(ROLE_CASCADE_WITNESS_QUERY, /pg_catalog\.pg_constraint/)
  assert.match(ROLE_CASCADE_WITNESS_QUERY, /child\.relname = 'role_permissions'/)
  assert.match(ROLE_CASCADE_WITNESS_QUERY, /parent\.relname = 'roles'/)
})

test('the battery acts on the expired-exemption verdict rather than only computing it', () => {
  // Guards the wiring, not the predicate: a run that computed `cascadePresent` and ignored it
  // would satisfy the predicate test above while shipping a stale exemption.
  assert.match(BATTERY_SOURCE, /not_driven_reason_expired/, 'the expired-exemption failure class is gone')
  assert.match(BATTERY_SOURCE, /if \(cascadePresent\) \{/, 'the cascade witness result is no longer branched on')
})
