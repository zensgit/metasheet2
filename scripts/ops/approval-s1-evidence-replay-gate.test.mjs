// Self-test for the S1 org-backfill evidence workflow's read-only claim:
//   .github/workflows/approval-s1-org-backfill-evidence.yml
//
// The workflow's own header says "THIS WORKFLOW NEVER WRITES. Every remote statement is a
// SELECT, a `docker inspect`, or a `printenv`." — but that claim was never mechanically checked
// against a real Postgres, and the `probe()` helper's own shape-check has a known blind spot: it
// pipes `psql -tA -c "$sql"` through `tr -d '[:space:]'` and validates the result against
// `^[0-9]+$`. A query that returns MULTIPLE rows of single digits (e.g. a `GROUP BY` that lost its
// outer `count(*)` wrapper) still produces a string matching that regex after `tr -d` concatenates
// the rows together — silently WRONG, not merely unvalidated. Mirrors the two-layer approach of
// scripts/ops/multitable-o2-observation.test.mjs (the O-2 observation kit's own self-test):
//
// LAYER 1 — STATIC extraction + census (hermetic: no database, no network, no pnpm install —
// `node --test` against the checked-out tree only). Parses the workflow file MECHANICALLY (never
// a hand-copied list of SQL strings) to find every `psql -c` SQL payload the remote script would
// run, and asserts a statement-HEAD-only SELECT census over all of them. This layer is a
// blocklist — per the trap-enumeration lesson, a blocklist alone never converges, so it exists as
// defense-in-depth, not the load-bearing guard. See LAYER 2.
//
// LAYER 2 — EXECUTION proof (real Postgres, DATABASE_URL-gated; skipped, loudly, when no
// DATABASE_URL is reachable — see the sentinel test below for the fail-not-skip discipline when a
// CI step marker says the DB step should be running). Replays EVERY extracted payload against a
// hand-authored, seeded fixture database inside a session pinned
// `SET default_transaction_read_only = on`, and additionally asserts the SINGLE-ROW property
// `probe()` itself cannot see (a genuine, positive control on real data — see the fixture's >=2
// distinct active `user_orgs.org_id` values, which exist specifically so a `GROUP BY`-shaped
// mutation produces a real, distinguishing two-row result rather than a vacuous one).
//
// WHAT NEITHER LAYER CLAIMS: that the fixture's schema matches any REAL deployment's schema. The
// fixture is hand-authored FROM the payloads (minimal tables/columns sufficient for every SELECT
// in the workflow to execute), not derived independently from the app's real migrations — by
// construction it can never red on drift between this workflow and the real `approval_instances` /
// `user_orgs` / `users` / `directory_integrations` / `kysely_migration` shapes. That evidence leg
// (does the SQL match production reality) is a separate, authoring-time exercise, same disclosure
// as the O-2 kit's own "what neither layer claims" paragraph.
//
// CI WIRING (two-lane, mirroring multitable-o2-observation-kit.yml / -kit-realdb.yml exactly —
// closeout-plan-review A-9(iv)):
//   - approval-s1-evidence-replay-gate.yml (hermetic CONTRACT lane): checkout + setup-node only,
//     no DATABASE_URL, unfiltered `pull_request:`/`push: [main]` — runs LAYER 1 on every PR.
//   - approval-s1-evidence-replay-gate-realdb.yml (EXECUTION-PROOF lane): postgres:16 service,
//     DATABASE_URL set, METASHEET_REAL_DB_TEST_STEP=1 (sentinel armed), path-filtered on the
//     evidence workflow, this test file, the fixture, and both lane files — runs LAYER 2 (and,
//     redundantly but harmlessly, layer 1 again).
// Outside both lanes — a local run with no DATABASE_URL — layer 2 takes the LOUD skip path by
// design; layer 1 always runs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/approval-s1-org-backfill-evidence.yml')
const FIXTURE_PATH = resolve(HERE, 'approval-s1-evidence-replay-gate-fixture.sql')
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8')

// ---------------------------------------------------------------------------------------------
// Mechanical extraction (no hand-authored payload list — everything below is derived from the
// checked-out workflow text). Reused, unmodified, against MUTATED scratch copies later in this
// file, so the extractor itself — not a hand-picked example — is what proves the mutation tests.
// ---------------------------------------------------------------------------------------------

/** Slice out the body of the `bash -s -- "$ENVIRONMENTS" <<'REMOTE' … REMOTE` heredoc — this is
 *  exactly what `bash -s --` executes on the remote host. The YAML `run: |` block dedents the
 *  file's literal 10-space indent before bash ever sees this text, which is why a plain (non
 *  `<<-`) heredoc terminator that LOOKS indented in the file is legal — it is column-0 by the time
 *  bash parses it. We do not need to replicate that dedent to extract the text; we only need the
 *  same structural landmarks bash itself uses (the opener line, and the sole line consisting of
 *  the bare terminator after left-trim). */
function extractRemoteBody(text) {
  const openMatch = text.match(/<<'REMOTE'[^\n]*\n/)
  assert.ok(openMatch, 'REMOTE heredoc opener ("<<\'REMOTE\'") not found in workflow')
  const bodyStart = openMatch.index + openMatch[0].length
  const rest = text.slice(bodyStart)
  const closeMatch = rest.match(/\n[ \t]*REMOTE[ \t]*\n/)
  assert.ok(closeMatch, 'REMOTE heredoc terminator (bare "REMOTE" line) not found in workflow')
  return rest.slice(0, closeMatch.index)
}

/** `MIGRATION_NAME='…'` is the one bash variable interpolated INTO SQL text (`'${MIGRATION_NAME}'`
 *  appears in p01, p03's raw call, and p31). psql never expands bash variables, so replay must
 *  substitute the literal value before sending any payload that contains it. */
function extractMigrationName(remoteBody) {
  const m = remoteBody.match(/MIGRATION_NAME='([^']*)'/)
  assert.ok(m, 'MIGRATION_NAME assignment not found in remote body')
  assert.ok(m[1].length > 0, 'MIGRATION_NAME extracted empty')
  return m[1]
}

/** Every `probe "$pg_container" "$pg_user" "$pg_db" "${label}.NAME" \` call's SQL argument.
 *  Mechanical, not hand-copied: locate the probe-name line (optionally prefixed by `if ! `, as
 *  p01/p02 are), then take the FIRST and SECOND unescaped `"` after it as the SQL literal's
 *  bounds. This pairing is exact IFF no payload contains a literal `"` — asserted as its own
 *  census below, which converts a future silent mis-parse (a payload that starts using double
 *  quotes) into a red test rather than a quietly-wrong extraction. */
function extractProbePayloads(remoteBody) {
  const lines = remoteBody.split('\n')
  const nameLineRe =
    /^\s*(?:if\s*!\s*)?probe\s+"\$pg_container"\s+"\$pg_user"\s+"\$pg_db"\s+"\$\{label\}\.([A-Za-z0-9_]+)"\s*\\?\s*$/
  const results = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(nameLineRe)
    if (!m) continue
    const name = m[1]
    const rest = lines.slice(i + 1).join('\n')
    const openIdx = rest.indexOf('"')
    assert.ok(openIdx >= 0, `no opening quote found for probe ${name}`)
    const closeIdx = rest.indexOf('"', openIdx + 1)
    assert.ok(closeIdx >= 0, `no closing quote found for probe ${name}`)
    results.push({ name, sql: rest.slice(openIdx + 1, closeIdx) })
  }
  return results
}

/** The ONE direct (non-`probe()`) psql call: the raw ledger-timestamp SELECT (p03). Different
 *  shape (inline `-c "…"` on a single line, no `probe()` wrapper, no shape validation at all on
 *  the caller side beyond the ISO-regex check performed on its OWN output afterward) — extracted
 *  separately for exactly that reason. */
function extractRawTimestampPayload(remoteBody) {
  const m = remoteBody.match(/-c "(SELECT timestamp FROM kysely_migration WHERE name = '\$\{MIGRATION_NAME\}')"/)
  assert.ok(m, 'raw p03 timestamp payload not found in remote body')
  return { name: 'p03_migration_executed_at_raw', sql: m[1] }
}

function substituteMigrationName(sql, migrationName) {
  return sql.split('${MIGRATION_NAME}').join(migrationName)
}

/** Full pipeline: text -> substituted {name, sql} payloads (probe() calls + the raw p03 call). */
function allPayloadsFrom(text) {
  const remoteBody = extractRemoteBody(text)
  const migrationName = extractMigrationName(remoteBody)
  const payloads = extractProbePayloads(remoteBody)
  payloads.push(extractRawTimestampPayload(remoteBody))
  for (const p of payloads) p.sql = substituteMigrationName(p.sql, migrationName)
  return { migrationName, payloads }
}

// ---------------------------------------------------------------------------------------------
// Shared mutation fixtures (single source of truth for both the layer-1 negative control and the
// layer-2 mutation proofs below, so the two never silently drift apart from each other).
// ---------------------------------------------------------------------------------------------

const U1A_UPDATE_MUTATION = {
  probeName: 'u1a_distinct_active_orgs',
  from: `probe "$pg_container" "$pg_user" "$pg_db" "\${label}.u1a_distinct_active_orgs" \\\n              "SELECT count(DISTINCT org_id) FROM user_orgs WHERE is_active" || rc=1`,
  to: `probe "$pg_container" "$pg_user" "$pg_db" "\${label}.u1a_distinct_active_orgs" \\\n              "UPDATE user_orgs SET is_active = is_active" || rc=1`,
}

const U1A_TWO_ROW_MUTATION = {
  probeName: 'u1a_multi_org_active_users',
  from: `probe "$pg_container" "$pg_user" "$pg_db" "\${label}.u1a_multi_org_active_users" \\\n              "SELECT count(*) FROM (SELECT user_id FROM user_orgs WHERE is_active\n                 GROUP BY user_id HAVING count(*) > 1) t" || rc=1`,
  to: `probe "$pg_container" "$pg_user" "$pg_db" "\${label}.u1a_multi_org_active_users" \\\n              "SELECT org_id, count(*) FROM user_orgs WHERE is_active GROUP BY org_id" || rc=1`,
}

function applyMutation(text, mutation) {
  const mutatedText = text.replace(mutation.from, mutation.to)
  assert.notEqual(mutatedText, text, `mutation fixture string for "${mutation.probeName}" did not match — source drifted from the real workflow`)
  return mutatedText
}

// closeout-plan-review A-9(ii): the parser's own payload count must be checked against an EXACT
// FLOOR, not merely "greater than some round number buried inside an unrelated test" — a refactor
// of extractProbePayloads/allPayloadsFrom that silently empties (or badly truncates) the parsed
// set must RED here specifically, by name, rather than relying on some other assertion to
// incidentally catch it. Exported as a standalone function (not inlined into a `test()` body) so
// the mutation-proof test immediately below can call it directly against a SYNTHETIC empty/short
// array and observe it throw — proving the floor itself is load-bearing, not vacuous.
const MIN_PROBE_PAYLOAD_COUNT = 47 // exact count on main as of this slice (46 probe() call sites + the one raw p03 call) — set to the ACTUAL count, not "one below", per closeout-plan-review A-9(ii): any single probe deletion must red this assertion, not merely a wholesale emptying.

function assertPayloadFloor(payloads) {
  assert.ok(
    Array.isArray(payloads),
    'assertPayloadFloor: payloads is not an array — parser return shape itself is broken',
  )
  assert.ok(
    payloads.length >= MIN_PROBE_PAYLOAD_COUNT,
    `parser floor breached: only ${payloads.length} payload(s) extracted from the workflow ` +
      `(floor ${MIN_PROBE_PAYLOAD_COUNT}) — a refactor that empties or truncates the parsed ` +
      `payload set must RED here, not silently green`,
  )
}

// =================================================================================================
// LAYER 1 — hermetic static extraction + census. No DATABASE_URL required.
// =================================================================================================

// Bare `test()` calls, grouped by comment section (no `describe` nesting) — matches this repo's
// scripts/ops/*.test.mjs convention elsewhere (e.g. attendance-remote-docker-gc-workflow-contract.test.mjs).

test('sanity: workflow file resolves under the repo root and is non-trivial', () => {
  assert.ok(workflowText.length > 1000, 'workflow file unexpectedly short — resolution likely wrong')
  assert.ok(workflowText.includes('THIS WORKFLOW NEVER WRITES'), 'expected read-only header claim not found')
})

test('extractor negative control: a workflow with no REMOTE heredoc throws, not returns empty', () => {
  assert.throws(() => extractRemoteBody('no heredoc here at all'), /REMOTE heredoc opener/)
})

test('MIGRATION_NAME extracts to a non-empty literal', () => {
  const { migrationName } = allPayloadsFrom(workflowText)
  assert.equal(migrationName, 'zzzz20260821100000_add_approval_instance_org_id')
})

test('extracted probe() payload count matches an INDEPENDENT unanchored count of call sites', () => {
  const remoteBody = extractRemoteBody(workflowText)
  const probeOnly = extractProbePayloads(remoteBody)
  // Independent of extractProbePayloads' own line-anchored regex: a bare substring count of every
  // `probe "$pg_container"` occurrence in the remote body. If the real extractor ever silently
  // drops or double-counts a call site, this cross-check catches it — an extractor that returns []
  // (vacuous-green) fails this immediately since the independent count is provably > 0.
  const independentCount = (remoteBody.match(/probe "\$pg_container"/g) || []).length
  assert.ok(independentCount > 0, 'independent probe() call-site count is 0 — cross-check itself is broken')
  assert.equal(probeOnly.length, independentCount)
})

test('extracted payload set contains every name this hardening slice specifically added/relies on', () => {
  const { payloads } = allPayloadsFrom(workflowText)
  const names = new Set(payloads.map((p) => p.name))
  for (const required of [
    'u1a_distinct_active_orgs',
    'u1a_multi_org_active_users',
    'u1b_zero_membership_active_users',
    'u1b_split_no_row_at_all',
    'u1b_split_only_deactivated_rows',
    'u1c_directory_integrations_table_present',
    'u1c_directory_integration_distinct_orgs',
    'u1c_non_default_integration_rows',
    'p10_instances_table_present',
    'p10_instances_total',
    'u3_attendance_records_org_id_column_present',
    'u3_attendance_records_org_id_not_in_user_orgs',
    'u3_attendance_requests_org_id_column_present',
    'u3_attendance_requests_org_id_not_in_user_orgs',
    'p03_migration_executed_at_raw',
  ]) {
    assert.ok(names.has(required), `expected extracted payload "${required}" not found`)
  }
})

test('the staging pre-gate probes appear in the remote body BEFORE the NOT_APPLIED early return (deep-review P2-2)', () => {
  const remoteBody = extractRemoteBody(workflowText)
  const preGateIdx = remoteBody.indexOf('u1a_distinct_active_orgs')
  // Anchored on the EXECUTABLE echo line, not the bare substring "verdict=NOT_APPLIED" — that
  // substring also appears inside this slice's own explanatory comment prose (which precedes the
  // probes, by design, to explain them), so a naive indexOf on the bare string collides with the
  // comment and produces a false ordering verdict. The `echo "verdict=NOT_APPLIED"` line is the
  // one and only place the workflow actually EMITS the verdict, which is what "before the early
  // return" must mean.
  const notAppliedIdx = remoteBody.indexOf('echo "verdict=NOT_APPLIED"')
  assert.ok(preGateIdx >= 0, 'u1a_distinct_active_orgs not found in remote body')
  assert.ok(notAppliedIdx >= 0, 'echo "verdict=NOT_APPLIED" not found in remote body')
  assert.ok(
    preGateIdx < notAppliedIdx,
    'u1a_distinct_active_orgs must be emitted BEFORE the NOT_APPLIED early return, not after it',
  )
  // Same ordering must hold for u1b (aggregate + both splits), the table-existence-guarded u1c,
  // and the newly table-existence-guarded p10 — every probe this slice's item 1 moved.
  for (const name of [
    'u1b_zero_membership_active_users',
    'u1b_split_no_row_at_all',
    'u1b_split_only_deactivated_rows',
    'u1c_directory_integrations_table_present',
    'p10_instances_table_present',
    'u3_attendance_records_org_id_column_present',
    'u3_attendance_requests_org_id_column_present',
  ]) {
    const idx = remoteBody.indexOf(name)
    assert.ok(idx >= 0, `${name} not found in remote body`)
    assert.ok(idx < notAppliedIdx, `${name} must be emitted BEFORE the NOT_APPLIED early return`)
  }
})

test('parser floor: extracted payload count is at least MIN_PROBE_PAYLOAD_COUNT (closeout-plan-review A-9(ii))', () => {
  const { payloads } = allPayloadsFrom(workflowText)
  assertPayloadFloor(payloads)
})

test('MUTATION PROOF: the parser-floor assertion itself reds on an emptied or truncated payload set', () => {
  // Direct, unconditional proof (no DATABASE_URL needed): a refactor that makes the extractor
  // return [] must be caught HERE, by this exact assertion, not merely hoped-for elsewhere.
  assert.throws(() => assertPayloadFloor([]), /parser floor breached: only 0 payload/)
  assert.throws(
    () => assertPayloadFloor(Array.from({ length: MIN_PROBE_PAYLOAD_COUNT - 1 }, (_, i) => ({ name: `x${i}`, sql: 'SELECT 1' }))),
    /parser floor breached/,
  )
  // Negative control: a payload set AT the floor does not throw — the assertion is a genuine
  // floor, not an always-throws stub.
  assert.doesNotThrow(() =>
    assertPayloadFloor(Array.from({ length: MIN_PROBE_PAYLOAD_COUNT }, (_, i) => ({ name: `x${i}`, sql: 'SELECT 1' }))),
  )
})

test('every extracted payload is a bare SELECT (statement-head census — defense in depth)', () => {
  const { payloads } = allPayloadsFrom(workflowText)
  assertPayloadFloor(payloads)
  for (const p of payloads) {
    assert.match(p.sql.trimStart(), /^SELECT\b/i, `payload "${p.name}" does not start with SELECT: ${p.sql.slice(0, 60)}`)
  }
})

test('no extracted payload contains a literal double-quote (the extractor\'s own soundness precondition)', () => {
  const { payloads } = allPayloadsFrom(workflowText)
  for (const p of payloads) {
    assert.ok(!p.sql.includes('"'), `payload "${p.name}" contains a literal '"' — quote-pairing extraction is unsound for it`)
  }
})

test('MIGRATION_NAME substitution is complete: no payload still carries the literal placeholder', () => {
  const { payloads } = allPayloadsFrom(workflowText)
  for (const p of payloads) {
    assert.ok(!p.sql.includes('${MIGRATION_NAME}'), `payload "${p.name}" still contains an un-substituted \${MIGRATION_NAME}`)
  }
  // And the negative control: at least one payload DID need substitution, so the assertion above
  // is not vacuously true over payloads that never had the placeholder to begin with.
  const remoteBody = extractRemoteBody(workflowText)
  assert.ok(remoteBody.includes('${MIGRATION_NAME}'), 'no payload in the source ever used ${MIGRATION_NAME} — substitution test would be vacuous')
})

test('drift guard: extracted MIGRATION_NAME matches the literal the replay-gate fixture seeds into kysely_migration', () => {
  const { migrationName } = allPayloadsFrom(workflowText)
  const fixtureSql = readFileSync(FIXTURE_PATH, 'utf8')
  assert.ok(
    fixtureSql.includes(`'${migrationName}'`),
    `approval-s1-evidence-replay-gate-fixture.sql does not seed a kysely_migration row matching ` +
      `the workflow's current MIGRATION_NAME ("${migrationName}") — the raw p03 timestamp payload ` +
      `would read 0 rows (not the required single row) against the fixture on drift`,
  )
})

test('extractor tracks a mutated scratch copy, not a memorized snapshot (negative control for the mutation tests below)', () => {
  const mutatedText = applyMutation(workflowText, U1A_UPDATE_MUTATION)
  const { payloads } = allPayloadsFrom(mutatedText)
  const mutated = payloads.find((p) => p.name === U1A_UPDATE_MUTATION.probeName)
  assert.ok(mutated, 'mutated payload not found by name after mutation')
  assert.match(mutated.sql, /^UPDATE\b/, 'extractor did not pick up the planted mutation — it is reading something other than the given text')
})

// =================================================================================================
// LAYER 2 — execution proof against a real, seeded Postgres. DATABASE_URL-gated.
// =================================================================================================

const DATABASE_URL = process.env.DATABASE_URL
const REAL_DB_STEP = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

function psqlAvailable() {
  const r = spawnSync('psql', ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

test('sentinel: the real-DB execution-layer step must have DATABASE_URL (fail-not-skip, mirrors multitable-o2-observation.test.mjs)', () => {
  if (REAL_DB_STEP && !DATABASE_URL) {
    assert.fail(
      'approval-s1-evidence-replay-gate execution-layer step (METASHEET_REAL_DB_TEST_STEP=1) is missing ' +
        'DATABASE_URL — this must FAIL, not silently skip the read-only replay proof',
    )
  }
})

const canRunExecutionLayer = Boolean(DATABASE_URL) && psqlAvailable()

if (!DATABASE_URL) {
  test('EXECUTION-LAYER SKIPPED — no DATABASE_URL reachable', { skip: true }, () => {})
  // eslint-disable-next-line no-console
  console.error(
    '\n*** approval-s1-evidence-replay-gate.test.mjs: EXECUTION-LAYER read-only replay proof SKIPPED ' +
      '(no DATABASE_URL). Set DATABASE_URL to an already-seeded scratch Postgres to run the real proof. ***\n',
  )
} else if (!psqlAvailable()) {
  if (REAL_DB_STEP) {
    test('sentinel: psql binary must be on PATH when the real-DB step is armed', () => {
      assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but the `psql` binary is not on PATH — cannot run the read-only replay proof')
    })
  } else {
    test('EXECUTION-LAYER SKIPPED — DATABASE_URL set but `psql` binary not found on PATH', { skip: true }, () => {})
  }
}

if (canRunExecutionLayer) {
  /** Run `sql` against DATABASE_URL inside a session pinned `default_transaction_read_only = on`,
   *  set via a PRECEDING `-c`. `-q` suppresses the `SET` command's own status tag (verified
   *  empirically: without `-q`, `psql -t -A` still emits a bare "SET" line before the payload's
   *  own output, which would corrupt the row count); `-v VERBOSITY=sqlstate` makes a failure's
   *  stderr the bare SQLSTATE code (e.g. "25006"), so a caller can assert the SPECIFIC read-only
   *  violation rather than merely "some error occurred" (which could also mean the SQL was
   *  malformed against the fixture — see the SQLSTATE assertion in the UPDATE-mutation test). */
  const runReadOnly = (sql) =>
    spawnSync(
      'psql',
      [
        DATABASE_URL,
        '-v', 'ON_ERROR_STOP=1',
        '-v', 'VERBOSITY=sqlstate',
        '--no-psqlrc',
        '-q',
        '-t', '-A',
        '-c', 'SET default_transaction_read_only = on;',
        '-c', sql,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )

  const rowsOf = (stdout) => stdout.split('\n').filter((line) => line.length > 0)

  const { payloads } = allPayloadsFrom(workflowText)

  test('execution-layer census: every payload found by layer 1 actually gets replayed below (no silent drop)', () => {
    assertPayloadFloor(payloads)
  })

  for (const { name, sql } of payloads) {
    test(`replays read-only + single-row: ${name}`, () => {
      const result = runReadOnly(sql)
      assert.equal(
        result.status,
        0,
        `payload "${name}" failed under the read-only session (this is a REAL query against the seeded ` +
          `fixture, not a write probe) — stderr: ${result.stderr}`,
      )
      const rows = rowsOf(result.stdout)
      assert.equal(
        rows.length,
        1,
        `payload "${name}" returned ${rows.length} rows, not exactly 1 — the probe() harness's ` +
          `\`tr -d '[:space:]'\` + \`^[0-9]+$\` contract would silently concatenate a multi-row ` +
          `result into a plausible-looking wrong number. rows: ${JSON.stringify(rows)}`,
      )
    })
  }

  // -----------------------------------------------------------------------------------------
  // MUTATION 1 — a planted write, replayed through the REAL extractor (not hand-simulated),
  // must be rejected by Postgres itself with the SPECIFIC read-only SQLSTATE (25006). This is
  // the positive control that the `SET default_transaction_read_only = on` pin set via a
  // PRECEDING `-c` actually persists to the FOLLOWING `-c` in the same psql invocation/session —
  // the load-bearing assumption of every "replays read-only" assertion above.
  // -----------------------------------------------------------------------------------------
  test('MUTATION PROOF: a planted UPDATE payload, found by the real extractor, reds with SQLSTATE 25006', () => {
    const mutatedText = applyMutation(workflowText, U1A_UPDATE_MUTATION)
    const { payloads: mutatedPayloads } = allPayloadsFrom(mutatedText)
    const mutated = mutatedPayloads.find((p) => p.name === U1A_UPDATE_MUTATION.probeName)
    assert.match(mutated.sql, /^UPDATE\b/)

    const result = runReadOnly(mutated.sql)
    assert.notEqual(result.status, 0, 'planted UPDATE unexpectedly succeeded under the read-only pin')
    assert.match(
      result.stderr,
      /25006/,
      `expected SQLSTATE 25006 (read_only_sql_transaction), got: ${result.stderr}`,
    )
  })

  // -----------------------------------------------------------------------------------------
  // MUTATION 2 — a planted two-row aggregate, also found by the real extractor, must be caught
  // by the single-row assertion specifically (not merely "the query errored for some reason").
  // -----------------------------------------------------------------------------------------
  test('MUTATION PROOF: a planted two-row aggregate, found by the real extractor, actually returns 2 rows and fails the single-row assertion', () => {
    const mutatedText = applyMutation(workflowText, U1A_TWO_ROW_MUTATION)
    const { payloads: mutatedPayloads } = allPayloadsFrom(mutatedText)
    const mutated = mutatedPayloads.find((p) => p.name === U1A_TWO_ROW_MUTATION.probeName)
    assert.match(mutated.sql, /^SELECT org_id, count/)

    const result = runReadOnly(mutated.sql)
    assert.equal(result.status, 0, `planted two-row query unexpectedly failed: ${result.stderr}`)
    const rows = rowsOf(result.stdout)
    // Positive control: the fixture seeds >=2 distinct ACTIVE user_orgs.org_id values
    // ('default', 'org-two') specifically so this mutation is DISTINGUISHING, not vacuous — a
    // mutation that "should" produce 2 rows but the fixture only has 1 org would silently pass.
    assert.equal(rows.length, 2, `expected the planted mutation to return exactly 2 rows (fixture has 2 distinct active orgs), got ${rows.length}: ${JSON.stringify(rows)}`)
    // The property under test: single-row assertion — reproduced inline, mirroring exactly what
    // the main replay loop above asserts — must be the thing that reds, not an incidental error.
    assert.notEqual(rows.length, 1, 'single-row assertion should have failed for this payload and did not')
  })
}
