// Self-test for the O-2 observation kit:
//   scripts/ops/multitable-o2-observation.sql   (read-only ladder observation queries)
//   scripts/ops/multitable-o2-canary-drill.md   (L4/L5 canary drill runbook)
//
// Two layers prove the SQL file is read-only. Neither is sufficient alone —
// see the P3-2 gate note below.
//
// LAYER 1 — STATIC census (hermetic: no database, no network, no pnpm install —
// `node --test` against the checked-out tree only, same shape as
// data-source-exposure-inventory.test.mjs). Beyond the original statement-HEAD-only
// check (SELECT/WITH heads), a body-aware census also flags: data-modifying CTEs
// (`WITH … AS (INSERT/UPDATE/DELETE/MERGE …)`), row-locking clauses (FOR UPDATE /
// NO KEY UPDATE / SHARE / KEY SHARE), `SELECT … INTO` (creates a table), and
// lock/session/side-effect function calls (the pg_advisory_* family,
// pg_terminate_backend, pg_cancel_backend, pg_promote, pg_switch_wal, pg_reload_conf,
// setval/nextval, dblink*, lo_import/export/unlink, COPY … PROGRAM) plus bare DDL
// keywords. This layer is a blocklist — per the trap-enumeration lesson, a
// blocklist alone never converges, so it exists as defense-in-depth, not the
// load-bearing guard. See LAYER 2.
//
// LAYER 2 — EXECUTION proof (real Postgres, DATABASE_URL-gated; skipped, loudly,
// when no DATABASE_URL is reachable — see the sentinel test below for the
// fail-not-skip discipline when a CI step marker says the DB step should be
// running). Runs the ENTIRE SQL file via `psql` inside a session pinned
// `SET default_transaction_read_only = on` and asserts a clean exit. WHEN IT
// RUNS, this is the load-bearing layer for most evasion shapes: Postgres
// itself refuses any write attempt under a read-only session (SQLSTATE
// 25006), regardless of how the static regex was fooled. It does NOT catch
// everything, though — verified here empirically: `pg_advisory_lock(...)` is
// NOT blocked by `default_transaction_read_only` at all (an advisory lock is
// a session-level action, not a data write — the guard silently succeeds).
// `pg_terminate_backend` DOES abort a self-targeting run, but only
// incidentally (its own connection dies) — NOT via a 25006 read-only
// refusal, and NOT if it targeted a different backend. For that residual
// family the STATIC census in layer 1 is the load-bearing catch, not layer
// 2 — each evasion-shape test below states which layer(s) actually caught
// it, and pins the SPECIFIC error text so an incidental abort is never
// mistaken for read-only enforcement.
//
// CI WIRING (both layers are enforced): multitable-o2-observation-kit.yml runs
// TWO jobs — `contract` (hermetic: checkout + node only) exercises layer 1 on
// every trigger, and `execution-proof` (postgres:16 service + real migrations)
// sets DATABASE_URL *and* METASHEET_REAL_DB_TEST_STEP=1 so layer 2 runs for
// real; in that lane a missing DATABASE_URL is a RED run (see the sentinel test
// below), never a silent skipped-green. Outside those jobs — a local run with no
// DATABASE_URL — layer 2 still takes the LOUD skip path by design.
//
// What NEITHER layer claims: that the queries return the documented per-ladder-
// level SHAPES against a real database — that evidence leg is a separate,
// authoring-time exercise (recorded in the authoring branch's evidence), not a
// read-only/safety claim.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SQL_PATH = resolve(HERE, 'multitable-o2-observation.sql')
const RUNBOOK_PATH = resolve(HERE, 'multitable-o2-canary-drill.md')
const AUTHORITY_MIGRATION_PATH = resolve(
  ROOT,
  'packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts',
)
const FENCE_MODULE_PATH = resolve(ROOT, 'packages/core-backend/src/multitable/canonical-sheet-fence.ts')

const sqlText = readFileSync(SQL_PATH, 'utf8')
const runbookText = readFileSync(RUNBOOK_PATH, 'utf8')
const migrationText = readFileSync(AUTHORITY_MIGRATION_PATH, 'utf8')
const fenceText = readFileSync(FENCE_MODULE_PATH, 'utf8')

// ---------------------------------------------------------------------------
// SQL statement census helpers
// ---------------------------------------------------------------------------

/** Strip `-- …` line comments, keep everything else. */
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

/** Split into statements on `;`. Sound ONLY while the file has no dollar-quoting /
 *  procedural bodies, and no slash-star block comments (a `;` inside one would
 *  mis-split, which the per-statement regex census in layer 1 relies on being
 *  correct) — both asserted separately below. */
function splitStatements(sql) {
  return stripLineComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Returns the list of statements whose head keyword is NOT read-only. */
function findNonReadonlyStatements(sql) {
  const offenders = []
  for (const stmt of splitStatements(sql)) {
    const head = stmt.split(/\s+/, 1)[0]?.toUpperCase() ?? ''
    if (head !== 'SELECT' && head !== 'WITH') offenders.push(head)
  }
  return offenders
}

test('SQL: no dollar-quoting and no slash-star block comments, so the statement splitter (and the layer-1 per-statement census that depends on it) is sound', () => {
  assert.ok(!sqlText.includes('$$'), 'observation SQL must not contain $$ bodies')
  assert.ok(!sqlText.includes('/*'), 'observation SQL must not contain /* block comments (a `;` inside one would mis-split statements)')
})

test('SQL: every statement is SELECT/WITH (read-only by construction)', () => {
  assert.deepEqual(findNonReadonlyStatements(sqlText), [])
})

test('SQL: read-only census POSITIVE CONTROL — a write statement IS flagged', () => {
  // The census must not be vacuous: feed it a doctored copy and require a hit.
  const doctored = sqlText + "\nUPDATE meta_sheets SET name = 'x';\n"
  assert.deepEqual(findNonReadonlyStatements(doctored), ['UPDATE'])
  // Statement-head trickery (comment before the verb) is also caught.
  const sneaky = sqlText + '\n-- harmless\nDELETE FROM meta_sheets;\n'
  assert.deepEqual(findNonReadonlyStatements(sneaky), ['DELETE'])
})

// ---------------------------------------------------------------------------
// P3-2 gate fix, layer 1: body-aware static census.
//
// findNonReadonlyStatements above only looks at the FIRST keyword of a
// statement. A gate review proved six shapes all have a SELECT/WITH head yet
// write, lock, or touch server state: `WITH … DELETE`, `WITH … UPDATE`,
// `SELECT … FOR UPDATE`, `SELECT pg_advisory_lock(…)`, `SELECT … INTO t`, and
// `SELECT pg_terminate_backend(…)`. findUnsafeConstructs below is a body-aware
// scan for exactly those (plus MERGE CTEs, the other locking-clause variants,
// more lock/session functions, COPY … PROGRAM, and bare DDL keywords).
// ---------------------------------------------------------------------------

const CTE_WRITE_RE = /\bAS\s*\(\s*(INSERT|UPDATE|DELETE|MERGE)\b/i
const LOCKING_CLAUSE_RE = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i
const INSERT_INTO_RE = /\bINSERT\s+INTO\b/gi
const BARE_INTO_RE = /\bINTO\b/i
// Lock, session-control, sequence, and other side-effect functions that are NOT
// data writes in the ordinary INSERT/UPDATE/DELETE sense, so a plain read-only
// role or the read-only-transaction execution layer may not stop them (verified
// for the advisory-lock and backend-signal families — see the execution-layer
// tests below).
const LOCK_OR_SIDE_EFFECT_FN_RE =
  /\b(pg_advisory_(?:xact_)?lock(?:_shared)?|pg_try_advisory_(?:xact_)?lock(?:_shared)?|pg_advisory_unlock(?:_all|_shared)?|pg_terminate_backend|pg_cancel_backend|pg_promote|pg_switch_wal|pg_switch_xlog|pg_reload_conf|pg_rotate_logfile|pg_create_restore_point|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|setval|nextval|dblink(?:_exec)?|lo_import|lo_export|lo_unlink)\s*\(/i
const COPY_PROGRAM_RE = /\bCOPY\b[^;]*\b(FROM|TO)\s+PROGRAM\b/i
const DDL_KEYWORD_RE = /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER)\b/i

/** Body-aware findings, per statement, for constructs a head-only census misses.
 *  Returns [{ stmt, reasons }] — empty array means clean. */
function findUnsafeConstructs(sql) {
  const findings = []
  for (const stmt of splitStatements(sql)) {
    const reasons = []
    if (CTE_WRITE_RE.test(stmt)) {
      reasons.push('data-modifying CTE (WITH … AS (INSERT/UPDATE/DELETE/MERGE))')
    }
    if (LOCKING_CLAUSE_RE.test(stmt)) {
      reasons.push('row-locking clause (FOR UPDATE/NO KEY UPDATE/SHARE/KEY SHARE)')
    }
    // Exclude legitimate `INSERT INTO` (already caught, if a head, by
    // findNonReadonlyStatements; if inside a CTE, already caught above) before
    // checking for a bare INTO, i.e. `SELECT … INTO t`.
    if (BARE_INTO_RE.test(stmt.replace(INSERT_INTO_RE, ''))) {
      reasons.push('SELECT … INTO (creates a table)')
    }
    if (LOCK_OR_SIDE_EFFECT_FN_RE.test(stmt)) {
      reasons.push('lock/session/side-effect function call (pg_advisory_*, pg_terminate_backend, setval, dblink, …)')
    }
    if (COPY_PROGRAM_RE.test(stmt)) {
      reasons.push('COPY … PROGRAM (arbitrary shell execution)')
    }
    if (DDL_KEYWORD_RE.test(stmt)) {
      reasons.push('DDL/administrative keyword (CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE/VACUUM/REINDEX/CLUSTER)')
    }
    if (reasons.length > 0) findings.push({ stmt: stmt.slice(0, 80), reasons })
  }
  return findings
}

test('SQL: static census is clean on the pristine file (positive control — not vacuously empty because nothing runs)', () => {
  assert.deepEqual(findUnsafeConstructs(sqlText), [])
})

// The six shapes the gate proved slip through findNonReadonlyStatements, plus a
// COPY…PROGRAM bonus shape. Reused below by the execution-layer tests too, so
// each fragment references REAL tables from the migrated schema (so an
// execution-layer run fails on the read-only mechanism itself, not on an
// incidental "relation does not exist").
const EVASION_SHAPES = [
  {
    name: 'WITH … DELETE (data-modifying CTE)',
    fragment: 'WITH d AS (DELETE FROM meta_recovery_token_burns WHERE 1=0 RETURNING sheet_id) SELECT count(*) FROM d;',
    // Postgres refuses the whole statement under a read-only session.
    executionMode: 'blocked',
  },
  {
    name: 'WITH … UPDATE (data-modifying CTE)',
    fragment: 'WITH u AS (UPDATE users SET password_hash = password_hash WHERE 1=0 RETURNING id) SELECT count(*) FROM u;',
    executionMode: 'blocked',
  },
  {
    name: 'SELECT … FOR UPDATE (row lock)',
    fragment: 'SELECT id FROM users WHERE 1=0 FOR UPDATE;',
    executionMode: 'blocked',
  },
  {
    name: 'SELECT pg_advisory_lock(…) (session-scoped lock)',
    fragment: 'SELECT pg_advisory_lock(424242); SELECT pg_advisory_unlock(424242);',
    // Verified empirically (see mutationEvidence): advisory locks are NOT
    // blocked by default_transaction_read_only — Postgres treats them as a
    // session-level action, not a data write. The static census is the only
    // guard for this shape.
    executionMode: 'not-blocked',
  },
  {
    name: 'SELECT … INTO t (creates a table)',
    fragment: 'SELECT 1 AS x INTO ro_evasion_probe_tbl_o2p3;',
    executionMode: 'blocked',
    cleanupSql: 'DROP TABLE IF EXISTS ro_evasion_probe_tbl_o2p3;',
  },
  {
    name: 'SELECT pg_terminate_backend(…) (kills the current backend)',
    fragment: 'SELECT pg_terminate_backend(pg_backend_pid());',
    // Verified empirically: default_transaction_read_only does NOT block
    // pg_terminate_backend (it is a signal to the postmaster, not a data
    // write). Self-targeting it DOES abort the run — but only as an incidental
    // side effect (the probe's own connection dies mid-script with a distinct
    // "terminating connection due to administrator command" / "server closed
    // the connection" signature), never as a "cannot execute … in a read-only
    // transaction" refusal. Targeted at any OTHER backend it would succeed
    // silently even read-only. So this is a static-census shape: the execution
    // layer's abort here is real but incidental, not a general enforcement
    // guarantee, and the static census (asserted above) is the load-bearing
    // catch.
    executionMode: 'blocked-incidental',
  },
]

// One test per shape (not one loop inside a single test) so a regression in
// any single regex reds exactly its own shape's test — a shared loop would
// throw on the first failing shape and hide whether the rest still pass.
for (const shape of EVASION_SHAPES) {
  test(`SQL: static census catches evasion shape — ${shape.name}`, () => {
    const doctored = `${sqlText}\n${shape.fragment}\n`
    const findings = findUnsafeConstructs(doctored)
    assert.ok(findings.length > 0, `static census missed evasion shape: ${shape.name}`)
  })
}

test('SQL: static census bonus shape — COPY … PROGRAM (arbitrary shell execution) is flagged', () => {
  const doctored = `${sqlText}\nCOPY (SELECT 1) TO PROGRAM 'echo pwned';\n`
  assert.ok(findUnsafeConstructs(doctored).length > 0, 'COPY … PROGRAM must be flagged')
})

test('SQL: balanced parentheses per statement (parse-shape sanity)', () => {
  for (const stmt of splitStatements(sqlText)) {
    let depth = 0
    for (const ch of stmt) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      assert.ok(depth >= 0, `unbalanced ')' in statement head: ${stmt.slice(0, 60)}`)
    }
    assert.equal(depth, 0, `unbalanced '(' in statement head: ${stmt.slice(0, 60)}`)
  }
})

// ---------------------------------------------------------------------------
// Query-tag completeness + per-level shape docs
// ---------------------------------------------------------------------------

const EXPECTED_TAGS = ['Q1', 'Q2', 'Q3', 'Q3b', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']

/** The comment+query section for a tag: from its section rule to the tagged statement's `;`. */
function sectionFor(tag) {
  const lines = sqlText.split('\n')
  const tagIdx = lines.findIndex((l) => l.trim() === `-- ${tag}`)
  assert.notEqual(tagIdx, -1, `missing tag line "-- ${tag}"`)
  // Section start: walk back to the previous '-- ---…' rule.
  let start = tagIdx
  while (start > 0 && !/^-- -{10,}/.test(lines[start])) start -= 1
  // Statement end: first subsequent line ending with ';'.
  let end = tagIdx + 1
  while (end < lines.length && !/;\s*$/.test(lines[end])) end += 1
  assert.ok(end < lines.length, `tag ${tag}: no terminating ';'`)
  return lines.slice(start, end + 1).join('\n')
}

test('SQL: exactly the 9 documented queries, each tagged once', () => {
  for (const tag of EXPECTED_TAGS) {
    const hits = sqlText.split('\n').filter((l) => l.trim() === `-- ${tag}`).length
    assert.equal(hits, 1, `tag -- ${tag} must appear exactly once, found ${hits}`)
  }
})

test('SQL: every query documents its EXPECTED SHAPE, mentioning the L0 baseline', () => {
  for (const tag of EXPECTED_TAGS) {
    const section = sectionFor(tag)
    assert.match(section, /EXPECTED SHAPE/, `${tag}: missing EXPECTED SHAPE block`)
    assert.match(
      section,
      /L0|Always|every level|Idle database/i,
      `${tag}: shape block must state the baseline-level expectation`,
    )
  }
})

test('SQL: honest sink inventory is present (no fabricated 409/40001 sinks)', () => {
  assert.match(sqlText, /HONEST SINK INVENTORY/)
  assert.match(sqlText, /NO cumulative counter of\s*--\s*SQLSTATE 40001|NO cumulative counter/)
  assert.match(sqlText, /NO\s*--\s*queryable DB sink|NO queryable DB sink/i)
})

// ---------------------------------------------------------------------------
// Drift guards against the authoritative migration / fence module
// ---------------------------------------------------------------------------

/** Parse RECOVERY_AUTHORITY_TRIGGERS = [ ['table','trigger'], … ] from the migration. */
function parseAuthorityTriggerPairs() {
  const m = migrationText.match(/RECOVERY_AUTHORITY_TRIGGERS = \[([\s\S]*?)\] as const/)
  assert.ok(m, 'RECOVERY_AUTHORITY_TRIGGERS array not found in the authority migration')
  const pairs = [...m[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((x) => [x[1], x[2]])
  return pairs
}

test('drift guard: Q1 lists the migration\'s exact trigger set (9 pairs, verbatim)', () => {
  const pairs = parseAuthorityTriggerPairs()
  assert.equal(pairs.length, 9, 'authority migration must declare 9 triggers')
  assert.equal(new Set(pairs.map(([t]) => t)).size, 8, 'authority triggers must span 8 tables')
  const q1 = sectionFor('Q1')
  for (const [table, trigger] of pairs) {
    assert.ok(
      new RegExp(`\\('${table}',\\s*'${trigger}'\\)`).test(q1.replace(/\s+/g, ' ')),
      `Q1 missing pair ('${table}', '${trigger}')`,
    )
  }
  // Closed set: Q1 must not observe triggers the migration does not declare.
  const q1Triggers = [...q1.matchAll(/'(trg_[a-z_]+)'/g)].map((x) => x[1])
  assert.deepEqual(new Set(q1Triggers), new Set(pairs.map(([, trg]) => trg)))
})

test('drift guard: Q2 lists the migration\'s six function names', () => {
  const names = [...migrationText.matchAll(/^export const AUTHORITY_[A-Z_]*FUNCTION = '([a-z_]+)'/gm)].map(
    (x) => x[1],
  )
  assert.equal(names.length, 6, 'authority migration must export 6 function-name constants')
  const q2 = sectionFor('Q2')
  for (const fn of names) assert.ok(q2.includes(`'${fn}'`), `Q2 missing function '${fn}'`)
})

test('drift guard: Q3 derives keys with the production lock-key literals', () => {
  const q3 = sectionFor('Q3')
  for (const prefix of [
    'metasheet:recovery-authority:user:',
    'metasheet:recovery-authority:role:',
    'metasheet:recovery-authority:group:',
  ]) {
    assert.ok(migrationText.includes(`'${prefix}'`), `migration lost prefix ${prefix}`)
    assert.ok(q3.includes(`'${prefix}'`), `Q3 missing prefix ${prefix}`)
  }
  assert.ok(fenceText.includes('meta:auto-number:sheet:'), 'fence module lost its key prefix')
  assert.ok(q3.includes("'meta:auto-number:sheet:'"), 'Q3 missing the canonical fence key prefix')
  // Same derivation functions as production: hashtextextended(…, 0) / hashtext(…)::bigint.
  assert.match(q3, /hashtextextended\(/)
  assert.match(q3, /hashtext\('meta:auto-number:sheet:' \|\| subject_id\)::bigint/)
})

test('drift guard: observed tables exist in migrations (no phantom sinks)', () => {
  // Each table an expect-zero query reads must be created somewhere under migrations —
  // guards against the observation kit outliving a dropped/renamed sink.
  const created = {
    meta_recovery_token_burns: 'zzzz20260719120000_create_meta_recovery_token_burns.ts',
    meta_records_trash: 'zzzz20260617120000_create_meta_records_trash.ts',
  }
  for (const [table, file] of Object.entries(created)) {
    const p = resolve(ROOT, 'packages/core-backend/src/db/migrations', file)
    assert.ok(existsSync(p), `${file} missing`)
    assert.ok(readFileSync(p, 'utf8').includes(table), `${file} no longer creates ${table}`)
    assert.ok(sqlText.includes(table), `observation SQL no longer reads ${table}`)
  }
  assert.match(
    readFileSync(
      resolve(ROOT, 'packages/core-backend/src/db/migrations/zzzz20260715170000_add_meta_sheet_recovery_writer_state.ts'),
      'utf8',
    ),
    /recovery_writer_state/,
  )
  assert.ok(sqlText.includes('recovery_writer_state'), 'Q7 lost its column')
})

// ---------------------------------------------------------------------------
// Runbook: host-reaching commands must be OWNER-GATED
// ---------------------------------------------------------------------------
//
// Verb inventory — WHY each family is listed:
//   ssh / sftp / scp / rsync      remote shell + file transfer: the canonical host reach.
//   curl / wget                   arbitrary HTTP from an operator shell — the natural way
//                                 to POST this drill's own destructive revert-execute /
//                                 reset-execute endpoints.
//   psql / pg_dump / pg_restore   DB-reaching CLIs; psql runs arbitrary DDL/DML via -c.
//                                 ONE positive exemption below: the exact invocation of
//                                 the observation file this same test proves read-only.
//   docker / kubectl / helm       container & orchestrator control planes (bare `docker`
//                                 covers exec/compose/run/cp and every other subcommand).
//   aws / gcloud / az             cloud-provider CLIs (infrastructure mutation).
//   gh workflow / gh api /        GitHub-side dispatch surfaces; the runbook itself states
//   gh run rerun                  that dispatching the containment workflow reaches the
//                                 deploy host over ssh.
// Local read-only tools (git, node, pnpm, `gh pr view`) are deliberately out of scope.
// This is an inventory, not a proof of completeness: widening it can only ADD reds
// (fail-closed direction) — it can never un-gate a block.
const HOST_VERB_RE =
  /\b(?:ssh|sftp|scp|rsync|curl|wget|psql|pg_dump|pg_restore|docker|kubectl|helm|aws|gcloud|az|gh\s+workflow|gh\s+api|gh\s+run\s+rerun)\b/gi

// The ONE exempt invocation: running the observation SQL file — proven read-only by the
// statement-head census at the top of this test — against the operator's own
// already-authorized database, with NO further arguments. Anchored at the occurrence
// (no `m` flag: `^` must match the psql token itself, so an exempt invocation elsewhere
// in the same block can never launder a hostile occurrence), and the lookahead requires
// the path to be immediately followed by a closing backtick or the end of that same line
// — a trailing ` -c 'ALTER …'`, ` < file`, or ` \` continuation must NOT ride the
// exemption.
const EXEMPT_PSQL_RE =
  /^psql "\$DATABASE_URL" -f scripts\/ops\/multitable-o2-observation\.sql(?=`|[ \t]*(?:\n|$))/

/** Structural block model — the gating unit. A block is exactly one of:
 *    - a fenced code block (``` or ~~~ up to its closing fence or EOF). If the fence
 *      opens while a list item is textually open (no blank line in between), the fence is
 *      FOLDED INTO that list item's block; otherwise the fence is its own block and its
 *      marker context additionally includes ONLY the single non-blank line immediately
 *      above the opening fence (the fence's introducing line);
 *    - a list item: a line starting with a bullet (-, *, +) or an ordered marker
 *      (`1.` / `1)`), plus its directly following continuation lines. EVERY list-item
 *      start begins a NEW block, so a marker on item N never gates item N+1 or a nested
 *      child item;
 *    - a heading line (own block);
 *    - a single table row (own block per row);
 *    - a contiguous blockquote run;
 *    - a contiguous run of any other non-blank lines (a paragraph).
 *  A blank line outside a fence ALWAYS terminates the current block. The OWNER-GATED
 *  marker gates only the block it appears in (plus the two fence inheritances above);
 *  a marker in an earlier, separate block never satisfies the scan.
 *  Returns [{ text, extraContext }] — extraContext is the inherited introducing line for
 *  a standalone fence, '' otherwise.
 */
function markdownBlocks(md) {
  const lines = md.split('\n')
  const blocks = []
  let cur = null // { kind: 'list' | 'para' | 'quote', lines: [...] }
  const flush = () => {
    if (cur) {
      blocks.push({ text: cur.lines.join('\n'), extraContext: '' })
      cur = null
    }
  }
  const LIST_START = /^\s*(?:[-*+]|\d{1,4}[.)])\s+/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^\s*(```|~~~)/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const fenceLines = [line]
      let j = i + 1
      for (; j < lines.length; j++) {
        fenceLines.push(lines[j])
        if (lines[j].trimStart().startsWith(marker)) break
      }
      if (cur && cur.kind === 'list') {
        cur.lines.push(...fenceLines) // fence folded into the open list item
      } else {
        const intro = i > 0 && lines[i - 1].trim() !== '' ? lines[i - 1] : ''
        flush()
        blocks.push({ text: fenceLines.join('\n'), extraContext: intro })
      }
      i = j
      continue
    }
    if (/^\s*$/.test(line)) {
      flush()
      continue
    }
    if (/^#{1,6}\s/.test(line) || /^\s*\|/.test(line)) {
      flush()
      blocks.push({ text: line, extraContext: '' })
      continue
    }
    if (/^\s*>/.test(line)) {
      if (cur && cur.kind === 'quote') cur.lines.push(line)
      else {
        flush()
        cur = { kind: 'quote', lines: [line] }
      }
      continue
    }
    if (LIST_START.test(line)) {
      flush()
      cur = { kind: 'list', lines: [line] }
      continue
    }
    if (cur && (cur.kind === 'list' || cur.kind === 'para')) cur.lines.push(line)
    else {
      flush()
      cur = { kind: 'para', lines: [line] }
    }
  }
  flush()
  return blocks
}

/** All host-verb occurrences in a block's text (matchAll clones the regex, so the /g
 *  lastIndex state can never leak between calls). */
function hostVerbOccurrences(text) {
  return [...text.matchAll(HOST_VERB_RE)]
}

/** An occurrence is exempt ONLY if it is a psql token that begins, at that exact
 *  position, the proven-read-only observation-file invocation with no further args. */
function isExemptOccurrence(text, m) {
  return m[0].toLowerCase() === 'psql' && EXEMPT_PSQL_RE.test(text.slice(m.index))
}

/** Blocks containing at least one non-exempt host-reaching command occurrence whose own
 *  block (or inherited fence context) carries no OWNER-GATED marker. */
function findUngatedHostCommands(md) {
  const offenders = []
  for (const b of markdownBlocks(md)) {
    if (b.text.includes('OWNER-GATED') || b.extraContext.includes('OWNER-GATED')) continue
    const live = hostVerbOccurrences(b.text).filter((m) => !isExemptOccurrence(b.text, m))
    if (live.length > 0) offenders.push(b.text)
  }
  return offenders
}

test('runbook: every host-reaching command block is OWNER-GATED', () => {
  const ungated = findUngatedHostCommands(runbookText)
  assert.deepEqual(ungated, [], `ungated host-reaching blocks:\n${ungated.join('\n---\n')}`)
})

test('runbook: gating scan is not vacuous — commands exist AND the scanner catches an unmarked one', () => {
  // Positive control 1: the runbook genuinely contains gated host-reaching commands (else
  // the "all gated" assertion above would be green against nothing).
  const gatedMentions = markdownBlocks(runbookText).filter(
    (b) =>
      (b.text.includes('OWNER-GATED') || b.extraContext.includes('OWNER-GATED')) &&
      hostVerbOccurrences(b.text).some((m) => !isExemptOccurrence(b.text, m)),
  )
  assert.ok(gatedMentions.length >= 3, 'expected >=3 gated host-command blocks in the runbook')
  // Positive control 2: an unmarked command in a doctored copy IS caught.
  const doctored = runbookText + '\n\n- [ ] run `ssh deploy@host disable-triggers.sh` now\n'
  assert.equal(findUngatedHostCommands(doctored).length, 1)
})

test('runbook: widened verbs are caught — ungated curl POST and psql write are red', () => {
  // The drill's own destructive endpoint reached via curl, unmarked: exactly one offender.
  const curlAttack =
    runbookText +
    '\n\nFinish by running `curl -X POST "$HOST/api/base/sheets/1/revert-execute" -H "Authorization: Bearer $T"` yourself.\n'
  const curlOffenders = findUngatedHostCommands(curlAttack)
  assert.equal(curlOffenders.length, 1)
  assert.match(curlOffenders[0], /revert-execute/)
  // An unmarked psql write statement: exactly one offender.
  const psqlAttack =
    runbookText +
    '\n\nThen run `psql "$DATABASE_URL" -c \'ALTER TABLE meta_sheets DISABLE TRIGGER ALL\'` to stand down.\n'
  const psqlOffenders = findUngatedHostCommands(psqlAttack)
  assert.equal(psqlOffenders.length, 1)
  assert.match(psqlOffenders[0], /ALTER TABLE/)
  // wget is in the same family as curl.
  const wgetAttack = runbookText + '\n\nAlso `wget --post-data=x "$HOST/api/reset-execute"` here.\n'
  assert.equal(findUngatedHostCommands(wgetAttack).length, 1)
})

test('runbook: psql exemption is exact — abuse of the allowlisted prefix stays red', () => {
  // Allowlisted invocation + trailing write args must NOT ride the exemption.
  const trailing =
    runbookText +
    '\n\nRun `psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql -c \'ALTER TABLE x ADD y int\'` now.\n'
  assert.equal(findUngatedHostCommands(trailing).length, 1)
  // A hostile psql occurrence is not laundered by an exempt invocation later in the SAME
  // block (the exemption is anchored per-occurrence, not per-block).
  const laundered =
    runbookText +
    '\n\nFirst `psql "$DATABASE_URL" -c \'ALTER TABLE meta_sheets DISABLE TRIGGER ALL\'` and then\n`psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql` afterwards.\n'
  assert.equal(findUngatedHostCommands(laundered).length, 1)
  // Backslash line-continuation after the allowlisted path must not ride the exemption.
  const continued =
    runbookText +
    '\n\nRun `psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql \\\n  -c \'DROP TABLE meta_sheets\'` now.\n'
  assert.equal(findUngatedHostCommands(continued).length, 1)
  // POSITIVE CONTROL for the exemption itself: the exact read-only invocation, ungated,
  // is NOT an offender — and the real runbook still carries it in an ungated block (the
  // §2 baseline step), so the exemption is load-bearing, not dead code.
  const exemptDoctored =
    runbookText +
    '\n\nBaseline again: `psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql` only.\n'
  assert.equal(findUngatedHostCommands(exemptDoctored).length, 0)
  const realExemptBlocks = markdownBlocks(runbookText).filter(
    (b) =>
      !b.text.includes('OWNER-GATED') &&
      hostVerbOccurrences(b.text).some((m) => isExemptOccurrence(b.text, m)),
  )
  assert.equal(realExemptBlocks.length, 1, 'expected exactly the §2 baseline psql step to ride the exemption')
  assert.match(realExemptBlocks[0].text, /Run the full observation file/)
})

test('runbook: OWNER-GATED scoping is block-local — distant markers do not gate', () => {
  // A fence whose only marker sits in a DIFFERENT earlier block (blank line between): red.
  const fenceAttack =
    runbookText +
    '\n\nOWNER-GATED: an unrelated marked step.\n\n```bash\nssh deploy@host systemctl stop metasheet\n```\n'
  assert.equal(findUngatedHostCommands(fenceAttack).length, 1)
  // The historical scoping hole: marked paragraph, then adjacent numbered items, then a
  // fence — the old splitter merged all of it into the marked paragraph. Must be red.
  const mergeAttack =
    runbookText +
    '\n\nOWNER-GATED: rotate the drill log (unrelated marked step).\n1. first do the harmless step\n2. then run:\n```bash\nssh deploy@host systemctl stop metasheet\n```\n'
  assert.equal(findUngatedHostCommands(mergeAttack).length, 1)
  // A marker on list item N does not gate item N+1.
  const siblingAttack =
    runbookText + '\n\n- OWNER-GATED: step A does something manual\n- run `ssh deploy@host stop` here\n'
  assert.equal(findUngatedHostCommands(siblingAttack).length, 1)
  // NEGATIVE CONTROLS (the two sanctioned inheritances — no over-tightening):
  // marker on the fence's introducing line gates the fence…
  const introGated =
    runbookText + '\n\nOWNER-GATED: run exactly this, with per-rung authorization:\n```bash\nssh deploy@host verify-posture\n```\n'
  assert.equal(findUngatedHostCommands(introGated).length, 0)
  // …and a marker inside a list item gates a fence folded into that same item.
  const itemGated =
    runbookText + '\n\n- [ ] OWNER-GATED: with authorization, run:\n```bash\nssh deploy@host verify-posture\n```\n'
  assert.equal(findUngatedHostCommands(itemGated).length, 0)
  // …and fence collection is load-bearing: a blank line INSIDE a gated fence must not
  // split the fence into an ungated paragraph (discriminates the fence branch from
  // plain-line continuation).
  const fenceWithBlank =
    runbookText + '\n\nOWNER-GATED: run exactly this:\n```bash\n\nssh deploy@host verify-posture\n```\n'
  assert.equal(findUngatedHostCommands(fenceWithBlank).length, 0)
})

test('runbook: removing OWNER-GATED from a real gated block goes red (marker is load-bearing)', () => {
  // §1 rung-posture block (gh workflow run + ssh).
  const anchor1 = 'OWNER-GATED: dispatch the existing'
  assert.ok(runbookText.includes(anchor1), 'mutation anchor 1 missing from runbook')
  const stripped1 = findUngatedHostCommands(runbookText.replace(anchor1, 'dispatch the existing'))
  assert.equal(stripped1.length, 1)
  assert.match(stripped1[0], /gh workflow run/)
  // §5 rollback block (ssh / workflow dispatch).
  const anchor2 = 'OWNER-GATED: any ssh session'
  assert.ok(runbookText.includes(anchor2), 'mutation anchor 2 missing from runbook')
  const stripped2 = findUngatedHostCommands(runbookText.replace(anchor2, 'any ssh session'))
  assert.equal(stripped2.length, 1)
  assert.match(stripped2[0], /rollback \(including re-running the containment workflow\)/)
})

test('runbook: declares itself non-executing and authorization-free', () => {
  assert.match(runbookText, /this runbook executes nothing by itself/i)
  assert.match(runbookText, /no new\s*\n?\s*> remote-reaching automation|no new remote-reaching automation/i)
  assert.match(runbookText, /grants no authorization/i)
})

test('runbook: every cited repo path exists', () => {
  const cited = [...runbookText.matchAll(/`((?:packages|scripts|docs|\.github)\/[^`\n]+)`/g)].map((m) => m[1])
  assert.ok(cited.length >= 10, `expected ≥10 cited repo paths, found ${cited.length}`)
  for (const p of cited) {
    assert.ok(existsSync(resolve(ROOT, p)), `runbook cites missing path: ${p}`)
  }
})

test('runbook: contains the ladder §4 no-40P01 link-in concurrent-write step for BOTH rungs', () => {
  assert.match(runbookText, /no-40P01/i)
  assert.match(runbookText, /deadlocks.*delta.*=\s*0|deadlock delta.*0/i)
  assert.match(runbookText, /repeated for reset/i)
})

// ---------------------------------------------------------------------------
// Workflow path-filter closed-world guard (gate #5018 NIT-1)
// ---------------------------------------------------------------------------
// The "every cited repo path exists" test above makes this kit red when any cited
// file is renamed — but the kit's workflow only runs when a path in its `paths:`
// filters changes. If a cited path is missing from the filters, the renaming PR
// lands green and the kit goes stale-red on a later, unrelated PR. So: every
// runbook-cited repo path must appear in BOTH trigger path filters, mechanically.

const KIT_WORKFLOW_PATH = resolve(ROOT, '.github/workflows/multitable-o2-observation-kit.yml')
const kitWorkflowText = readFileSync(KIT_WORKFLOW_PATH, 'utf8')

/** Every `- 'entry'` list under each `paths:` key, in file order (comments/blanks skipped). */
function workflowPathSections(ymlText) {
  const sections = []
  const lines = ymlText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*paths:\s*$/.test(lines[i])) continue
    const entries = []
    for (let j = i + 1; j < lines.length; j++) {
      const entry = lines[j].match(/^\s*-\s*'([^']+)'\s*$/)
      if (entry) {
        entries.push(entry[1])
        continue
      }
      if (/^\s*#/.test(lines[j])) continue
      break
    }
    sections.push(entries)
  }
  return sections
}

/** Cited paths absent from any section, as `section#i: path` strings; [] = fully filtered. */
function missingFilterEntries(ymlText, citedPaths) {
  const sections = workflowPathSections(ymlText)
  const missing = []
  sections.forEach((entries, i) => {
    for (const p of citedPaths) {
      if (!entries.includes(p)) missing.push(`paths-section#${i + 1} (of ${sections.length}): ${p}`)
    }
  })
  return missing
}

function runbookCitedPaths() {
  // Deduplicated: the runbook may cite the same path in several sections.
  return [...new Set([...runbookText.matchAll(/`((?:packages|scripts|docs|\.github)\/[^`\n]+)`/g)].map((m) => m[1]))]
}

test('workflow: every runbook-cited repo path is in BOTH trigger path filters (renames re-run the kit on the renaming PR)', () => {
  const sections = workflowPathSections(kitWorkflowText)
  // Anti-vacuity: the parser must find exactly the pull_request and push filters,
  // each carrying at least the four kit files + five drift-guard sources.
  assert.equal(sections.length, 2, `expected 2 paths: sections (pull_request + push), found ${sections.length}`)
  for (const entries of sections) {
    assert.ok(entries.length >= 9, `paths: section unexpectedly small (${entries.length} entries)`)
  }
  const cited = runbookCitedPaths()
  assert.ok(cited.length >= 10, `expected ≥10 cited repo paths, found ${cited.length}`)
  const missing = missingFilterEntries(kitWorkflowText, cited)
  assert.deepEqual(missing, [], `runbook-cited paths missing from workflow path filters:\n${missing.join('\n')}`)
})

test('workflow filter guard is not vacuous: removing a cited path from one filter IS caught', () => {
  const cited = runbookCitedPaths()
  const victim = 'packages/core-backend/tests/unit/recovery-conflict-census.test.ts'
  // Anchor: the victim must genuinely be cited AND genuinely present before removal.
  assert.ok(cited.includes(victim), 'victim path is no longer cited by the runbook')
  assert.equal(missingFilterEntries(kitWorkflowText, cited).length, 0)
  const doctoredLines = kitWorkflowText.split('\n')
  const idx = doctoredLines.findIndex((l) => l.includes(`- '${victim}'`))
  assert.ok(idx >= 0, 'victim path line not found in workflow')
  doctoredLines.splice(idx, 1)
  const missing = missingFilterEntries(doctoredLines.join('\n'), cited)
  assert.deepEqual(missing, [`paths-section#1 (of 2): ${victim}`])
})
// P3-2 gate fix, layer 2: EXECUTION-level proof against a real, migrated
// scratch Postgres, inside a session pinned `default_transaction_read_only`.
//
// DATABASE_URL-gated, mirroring the repo's sentinel discipline (see e.g.
// packages/core-backend/tests/integration/recovery-conflict-classifier-realdb.test.ts):
// absence of DATABASE_URL is a loud SKIP (node:test tracks `skipped` as a count
// distinct from `pass` — it cannot be mistaken for a green test), UNLESS a CI
// step marker (METASHEET_REAL_DB_TEST_STEP=1) says this step is supposed to be
// running a real DB, in which case a missing DATABASE_URL is a hard FAILURE.
//
// The DATABASE_URL, when set, must point to an ALREADY-MIGRATED database the
// operator/CI step is authorized to reach (same contract as the .sql file's own
// "HOW TO RUN" header) — this test does not run migrations itself. No `pg` npm
// dependency is used (keeps the existing hermetic CI job's "no pnpm install"
// contract intact even after this file grows a DB-aware layer): the `psql`
// binary is invoked directly via node:child_process, exactly as the .sql
// file's own header instructs an operator to do.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL
const REAL_DB_STEP = process.env.METASHEET_REAL_DB_TEST_STEP === '1'

test('sentinel: the real-DB execution-layer step must have DATABASE_URL (fail-not-skip, mirrors recovery-conflict-classifier-realdb.test.ts)', () => {
  if (REAL_DB_STEP && !DATABASE_URL) {
    throw new Error(
      'multitable-o2-observation execution-layer step (METASHEET_REAL_DB_TEST_STEP=1) is missing DATABASE_URL — this must FAIL, not silently skip the read-only execution proof',
    )
  }
})

function psqlAvailable() {
  try {
    execFileSync('psql', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

const canRunExecutionLayer = Boolean(DATABASE_URL) && psqlAvailable()

if (!DATABASE_URL) {
  test('EXECUTION-LAYER SKIPPED — no DATABASE_URL reachable', { skip: true }, () => {})
  // eslint-disable-next-line no-console
  console.error(
    '\n*** multitable-o2-observation.test.mjs: EXECUTION-LAYER read-only proof SKIPPED (no DATABASE_URL). ' +
      'This is NOT evidence the SQL file is read-only-safe — only the static census ran. ' +
      'Set DATABASE_URL to an already-migrated scratch Postgres to run the real proof. ***\n',
  )
} else if (!psqlAvailable()) {
  if (REAL_DB_STEP) {
    test('EXECUTION-LAYER: psql binary must be on PATH when the real-DB step marker is set', () => {
      assert.fail('METASHEET_REAL_DB_TEST_STEP=1 but the `psql` binary is not on PATH — cannot run the read-only execution proof')
    })
  } else {
    test('EXECUTION-LAYER SKIPPED — DATABASE_URL set but `psql` binary not found on PATH', { skip: true }, () => {})
    // eslint-disable-next-line no-console
    console.error('\n*** multitable-o2-observation.test.mjs: EXECUTION-LAYER read-only proof SKIPPED (no `psql` on PATH). ***\n')
  }
}

/** Run `sql` (full text) via psql against DATABASE_URL, in one session pinned
 *  default_transaction_read_only=on, ON_ERROR_STOP so any failing statement
 *  aborts the whole run non-zero. Returns { status, stdout, stderr }. */
function runReadOnlySql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'o2p3-ro-'))
  const file = join(dir, 'probe.sql')
  try {
    writeFileSync(file, sql, 'utf8')
    const result = spawnSync(
      'psql',
      [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-c', 'SET default_transaction_read_only = on;', '-f', file],
      { encoding: 'utf8', timeout: 20000 },
    )
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run `sql` normally (NOT read-only) — used only for defensive cleanup of any
 *  artefact a doctored probe might have left behind if a guard regressed. */
function runCleanupSql(sql) {
  try {
    execFileSync('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-c', sql], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    // best-effort only
  }
}

if (canRunExecutionLayer) {
  test('EXECUTION: pristine SQL file runs clean (exit 0) inside a session pinned default_transaction_read_only=on — positive control that the file really is read-only end to end', () => {
    const result = runReadOnlySql(sqlText)
    assert.equal(result.status, 0, `pristine file should succeed read-only; stderr:\n${result.stderr}`)
  })

  for (const shape of EVASION_SHAPES) {
    test(`EXECUTION: doctored copy with ${shape.name}`, () => {
      const doctored = `${sqlText}\n${shape.fragment}\n`
      let result
      try {
        result = runReadOnlySql(doctored)
        if (shape.executionMode === 'blocked') {
          // Positive assertion pinned to the SPECIFIC Postgres refusal text
          // (not a bare "status !== 0", which cannot distinguish "blocked for
          // the right reason" from "failed for some unrelated reason").
          assert.match(
            result.stderr,
            /cannot execute \S+.*in a read-only transaction/i,
            `expected a read-only-transaction refusal (SQLSTATE 25006 family); got exit ${result.status}, stderr:\n${result.stderr}`,
          )
        } else if (shape.executionMode === 'blocked-incidental') {
          // Aborts, but NOT via the read-only mechanism — via the backend
          // self-terminating. Pin to that specific, distinct signature so this
          // is not mistaken for a 25006 read-only refusal.
          assert.match(
            result.stderr,
            /terminating connection due to administrator command|server closed the connection unexpectedly/i,
            `expected the self-termination signature (NOT a read-only refusal); got exit ${result.status}, stderr:\n${result.stderr}`,
          )
          assert.doesNotMatch(
            result.stderr,
            /in a read-only transaction/i,
            'this abort must NOT be the read-only mechanism — that would falsely credit layer 2 for a shape it does not actually enforce',
          )
          // The incidental self-abort is not a safety guarantee (targeting any
          // OTHER backend would succeed silently, even read-only). The static
          // census is this shape's real guard — assert it here too, so a
          // regression in that regex is caught even though this specific
          // execution outcome (self-kill) would otherwise still look "red" for
          // an unrelated reason.
          assert.ok(
            findUnsafeConstructs(doctored).length > 0,
            'static census must catch this shape — the execution-layer abort above is incidental, not a reliable guarantee',
          )
        } else {
          // executionMode 'not-blocked': documented Postgres behaviour, proven
          // here with a real run — the read-only session does NOT stop this
          // shape. The static census (asserted above) is this shape's actual
          // guard; this assertion exists so a future Postgres/behavioural
          // change that DID start blocking it would be noticed, not silently
          // relied upon.
          assert.equal(
            result.status,
            0,
            `expected pg_advisory_lock NOT to be blocked by read-only mode (documents the real gap the static census covers); stderr:\n${result.stderr}`,
          )
          assert.ok(
            findUnsafeConstructs(doctored).length > 0,
            'static census must catch this shape since the execution layer does not',
          )
        }
      } finally {
        if (shape.cleanupSql) runCleanupSql(shape.cleanupSql)
      }
    })
  }
}
