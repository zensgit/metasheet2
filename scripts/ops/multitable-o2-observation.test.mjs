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

// ---------------------------------------------------------------------------
// P3-3 gate fix: string/dollar-quote-aware comment stripping + statement split.
//
// The previous `indexOf('--')`-per-line stripper was NOT string-aware: a `--` inside
// a single-quoted string literal (e.g. `SELECT 'note -- see below'; DELETE …;`) was
// treated as a comment start, deleting the rest of the physical line — including a
// subsequent write statement on that SAME line — from the census input entirely.
// That is not "failed to flag", it is "the evidence never reached the regex at all".
// Fixed by making the stripper a real character-level scanner that treats
// single-quoted strings ('' escaping) and dollar-quoted bodies ($tag$…$tag$) as
// OPAQUE: a `--`, `/*`, or `;` inside either is data, never a comment start or a
// statement terminator. Block comments are nesting-aware (Postgres nests them).
//
// FAIL TOWARD FLAGGING: an input the scanner cannot confidently parse — an
// unterminated string, dollar-quoted body, or block comment — makes the scanner
// THROW rather than silently swallow the remainder of the file as comment/string
// content. A thrown error fails the calling test (red), which is the safe direction;
// a silently-empty result would be the P3-3 failure mode all over again.
// ---------------------------------------------------------------------------

/** Matches an opening dollar-quote tag ($tag$ or the bare $$) at the given position. */
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

/** Strip `-- …` line comments and nesting-aware `/* … *\/` block comments, keeping
 *  string/dollar-quoted content byte-for-byte (needed so a later `;`-split still sees
 *  it, and so the "no $$ / no /*" positive-control assertion below still inspects the
 *  untouched raw file, not this function's output). */
function stripComments(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (two === '/*') {
      const start = i
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        const two2 = sql.slice(i, i + 2)
        if (two2 === '/*') { depth += 1; i += 2 }
        else if (two2 === '*/') { depth -= 1; i += 2 }
        else { if (sql[i] === '\n') out += '\n'; i += 1 }
      }
      if (depth > 0) {
        throw new Error(
          `stripComments: unterminated /* block comment starting at offset ${start} — refusing to ` +
            'silently treat the rest of the file as a comment (fail-toward-flagging)',
        )
      }
      continue
    }
    if (sql[i] === "'") {
      const start = i
      out += "'"
      i += 1
      let closed = false
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue }
        if (sql[i] === "'") { out += "'"; i += 1; closed = true; break }
        out += sql[i]
        i += 1
      }
      if (!closed) {
        throw new Error(
          `stripComments: unterminated string literal starting at offset ${start} — refusing to ` +
            'silently treat the rest of the file as string content (fail-toward-flagging)',
        )
      }
      continue
    }
    if (sql[i] === '$') {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const bodyStart = i + tag.length
        const closeIdx = sql.indexOf(tag, bodyStart)
        if (closeIdx === -1) {
          throw new Error(
            `stripComments: unterminated dollar-quoted body ${tag} starting at offset ${i} — refusing ` +
              'to silently treat the rest of the file as its content (fail-toward-flagging)',
          )
        }
        out += sql.slice(i, closeIdx + tag.length)
        i = closeIdx + tag.length
        continue
      }
    }
    out += sql[i]
    i += 1
  }
  return out
}

/** Split a SQL text into statements on `;`. Comments are stripped first (via
 *  stripComments, itself string/dollar-quote-aware); this second pass re-tracks
 *  string/dollar-quoted spans so a `;` inside either is data, not a terminator —
 *  sound because stripComments has already removed every real comment, so the only
 *  spans left to protect are strings and dollar-quoted bodies. */
function splitStatements(sql) {
  const stripped = stripComments(sql)
  const statements = []
  let cur = ''
  let i = 0
  const n = stripped.length
  while (i < n) {
    const ch = stripped[i]
    if (ch === "'") {
      cur += ch
      i += 1
      while (i < n) {
        if (stripped[i] === "'" && stripped[i + 1] === "'") { cur += "''"; i += 2; continue }
        cur += stripped[i]
        const closing = stripped[i] === "'"
        i += 1
        if (closing) break
      }
      continue
    }
    if (ch === '$') {
      const m = DOLLAR_TAG_RE.exec(stripped.slice(i))
      if (m) {
        const tag = m[0]
        const closeIdx = stripped.indexOf(tag, i + tag.length)
        const bodyEnd = closeIdx === -1 ? n : closeIdx + tag.length
        cur += stripped.slice(i, bodyEnd)
        i = bodyEnd
        continue
      }
    }
    if (ch === ';') {
      const trimmed = cur.trim()
      if (trimmed.length > 0) statements.push(trimmed)
      cur = ''
      i += 1
      continue
    }
    cur += ch
    i += 1
  }
  const tail = cur.trim()
  if (tail.length > 0) statements.push(tail)
  return statements
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

// E'...' escape-strings (a Postgres extension: backslash-escapes are live inside them,
// unlike a plain '...' literal under standard_conforming_strings) are the unconsidered
// sibling of the exact P3-3 class this file fixes: `E'it\'s -- x'` — the `\'` is a literal
// escaped apostrophe, NOT a closing quote, but this tokenizer (like every plain-'-'-aware
// SQL parser that does not separately special-case E-strings) treats it as one, exits
// string state one character early, and the same `--`-erasure this file exists to prevent
// fires again. VERIFIED reachable: a synthetic `E'it\'s -- x'; DELETE FROM meta_sheets;`
// fragment erases the DELETE from findNonReadonlyStatements's result exactly like the
// original P3-3 repro. Rather than adding a third string-syntax state machine (E-strings
// also interact with `standard_conforming_strings`, itself a session-level GUC this static
// scanner cannot observe), this is closed the same way $$/`/*` are: banned from ever
// appearing in this specific hand-authored, all-SELECT observation file, so the unsound
// case is simply unreachable here — fail-toward-flagging applied to the INPUT rather than
// attempting a more elaborate parser.
const E_STRING_RE = /(?:^|[^A-Za-z0-9_])[Ee]'/

test('SQL: no dollar-quoting, no slash-star block comments, and no E-string escapes — content-shape restrictions kept as defense-in-depth now that the splitter below is dollar-quote/block-comment-aware on its own merits (not the soundness basis it used to be); E-strings are banned outright because backslash-escape semantics inside them are NOT modeled by this tokenizer (see the comment above), so this restriction IS the soundness basis for that one shape', () => {
  assert.ok(!sqlText.includes('$$'), 'observation SQL must not contain $$ bodies')
  assert.ok(!sqlText.includes('/*'), 'observation SQL must not contain /* block comments (a `;` inside one would mis-split statements)')
  assert.ok(!E_STRING_RE.test(sqlText), "observation SQL must not contain E'...' escape-strings (backslash-escape semantics are not modeled — see the comment above)")
})

test("SQL: E-string ban is not vacuous — a doctored copy containing E'...' IS caught", () => {
  const doctored = `${sqlText}\nSELECT E'x';\n`
  assert.ok(E_STRING_RE.test(doctored), "E-string ban must catch a real E'...' occurrence")
})

test("SQL: (documented residual, not a passing security assertion) an E-string's backslash-escaped quote IS mis-parsed as a close, reopening the P3-3 erasure path — this is exactly WHY E-strings are banned above, not a claim that the tokenizer handles them", () => {
  const doctored = "SELECT E'it\\'s -- x'; DELETE FROM meta_sheets;"
  assert.deepEqual(findNonReadonlyStatements(doctored), [], 'documents the known gap: without the ban above, this would erase the DELETE')
})

// P3-3 gate fix regression legs: synthetic inputs (NOT sqlText — a 367-line file that
// itself contains none of $$, /*, or a `--` inside a string means every one of these
// predicates would be untested, hence unmutation-testable, if only run against the real
// file). One test per predicate so a regression in any single branch reds exactly its own
// test, matching the file's established one-shape-one-test convention.

test('SQL: statement tokenizer treats `--` inside a single-quoted string as data, not a comment start (the exact P3-3 gate reproduction)', () => {
  const doctored = "SELECT 'note -- see below'; DELETE FROM meta_sheets;"
  assert.deepEqual(findNonReadonlyStatements(doctored), ['DELETE'])
})

test('SQL: statement tokenizer does not split a statement on a `;` inside a single-quoted string', () => {
  assert.equal(splitStatements("SELECT 'a;b;c' AS x;").length, 1)
})

// These two use a REAL trailing write statement on the SAME line as the embedded `--`
// (mirroring the exact P3-3 shape) rather than only asserting a statement count: a weaker
// count-only assertion would still pass under some dollar-quote mutations, because
// splitStatements independently re-tracks dollar-quotes for its own `;`-split pass — two
// redundant layers can silently "self-heal" a length-only check even when the tag content
// was genuinely corrupted. Asserting the exact write-keyword outcome closes that gap: if
// the embedded `--` is (wrongly) treated as a real comment start, it swallows everything to
// end-of-line — including the closing tag AND the trailing `DELETE` — collapsing the whole
// fragment to a single harmless-looking SELECT and erasing the DELETE from the result,
// exactly the P3-3 failure mode.
test('SQL: statement tokenizer treats dollar-quoted body content as opaque — an embedded `--` does not erase a trailing write statement', () => {
  const doctored = 'SELECT $tag$ text -- $tag$; DELETE FROM meta_sheets;'
  assert.deepEqual(findNonReadonlyStatements(doctored), ['DELETE'])
})

test('SQL: statement tokenizer handles the bare $$ dollar-quote tag (empty tag name) — same erasure risk as the named-tag case', () => {
  const doctored = 'SELECT $$ text -- $$; DELETE FROM meta_sheets;'
  assert.deepEqual(findNonReadonlyStatements(doctored), ['DELETE'])
})

// Isolates the SEPARATE dollar-quote tracking inside splitStatements's own `;`-split pass
// (distinct from stripComments's dollar-quote handling — see the file-header comment on
// the two-function design): no `--`/`/*` appears anywhere in this fragment, so
// stripComments produces byte-identical output whether or not ITS dollar-quote branch is
// present. Only splitStatements's independent re-tracking stands between the `;` inside
// the dollar body and an incorrect 3-way split.
test('SQL: statement tokenizer (`;`-split pass) independently protects a `;` inside a dollar-quoted body, even with no comment markers to catch it earlier', () => {
  const doctored = 'SELECT $tag$ a;b $tag$ AS x; DELETE FROM meta_sheets;'
  assert.deepEqual(findNonReadonlyStatements(doctored), ['DELETE'])
})

test('SQL: statement tokenizer handles nested /* */ block comments (Postgres nests them)', () => {
  const doctored = 'SELECT 1 /* outer /* inner */ still-comment */ AS x;'
  assert.deepEqual(splitStatements(doctored), ['SELECT 1  AS x'])
})

test('SQL: statement tokenizer handles \'\' escaped-quote-within-string without ending the string early', () => {
  const doctored = "SELECT 'it''s -- not a comment; not a split' AS x;"
  assert.equal(splitStatements(doctored).length, 1)
  assert.deepEqual(findNonReadonlyStatements(doctored), [])
})

test('SQL: statement tokenizer FAILS LOUD (throws) on an unterminated string literal rather than silently swallowing a trailing write statement', () => {
  assert.throws(
    () => splitStatements("SELECT 'unterminated; DELETE FROM meta_sheets;"),
    /unterminated string literal/,
  )
})

test('SQL: statement tokenizer FAILS LOUD (throws) on an unterminated dollar-quoted body', () => {
  assert.throws(() => splitStatements('SELECT $tag$ unterminated; DELETE FROM meta_sheets;'), /unterminated dollar-quoted body/)
})

test('SQL: statement tokenizer FAILS LOUD (throws) on an unterminated /* block comment', () => {
  assert.throws(() => splitStatements('SELECT 1 /* unterminated; DELETE FROM meta_sheets;'), /unterminated \/\* block comment/)
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

// P3-3 gate fix: `AS (` required MATERIALIZED to sit AFTER the paren; the real syntax is
// `name AS [ [NOT] MATERIALIZED ] ( query )`, so `WITH d AS MATERIALIZED (DELETE …)` broke
// the adjacency and slipped through undetected — the DELETE was never at the wrong keyword,
// the regex was looking at the wrong position for the paren.
const CTE_WRITE_RE = /\bAS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(\s*(INSERT|UPDATE|DELETE|MERGE)\b/i
const LOCKING_CLAUSE_RE = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i
const INSERT_INTO_RE = /\bINSERT\s+INTO\b/gi
const BARE_INTO_RE = /\bINTO\b/i
// Lock, session-control, sequence, and other side-effect functions that are NOT
// data writes in the ordinary INSERT/UPDATE/DELETE sense, so a plain read-only
// role or the read-only-transaction execution layer may not stop them (verified
// for the advisory-lock and backend-signal families — see the execution-layer
// tests below). P3-4 gate fix additions: pg_read_file / pg_read_binary_file /
// pg_ls_dir / pg_stat_file are server-side filesystem reads through the DB
// connection (arbitrary host-file read / directory listing — plainly outside a
// read-only OBSERVATION kit's remit and a real exfiltration surface, even though
// they are not a *data write* and default_transaction_read_only does not gate
// filesystem access at all); pg_logical_emit_message is a genuine WAL write that
// default_transaction_read_only does NOT block (verified empirically — see the
// EVASION_SHAPES entry below). All five: execution layer CANNOT catch them
// (documented honestly, not merely asserted — see the 'not-blocked' shapes),
// so the static census here is the sole guard.
const LOCK_OR_SIDE_EFFECT_FN_RE =
  /\b(pg_advisory_(?:xact_)?lock(?:_shared)?|pg_try_advisory_(?:xact_)?lock(?:_shared)?|pg_advisory_unlock(?:_all|_shared)?|pg_terminate_backend|pg_cancel_backend|pg_promote|pg_switch_wal|pg_switch_xlog|pg_reload_conf|pg_rotate_logfile|pg_create_restore_point|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|setval|nextval|dblink(?:_exec)?|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_logical_emit_message)\s*\(/i
const COPY_PROGRAM_RE = /\bCOPY\b[^;]*\b(FROM|TO)\s+PROGRAM\b/i
const DDL_KEYWORD_RE = /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER)\b/i
// P3-3 gate fix: dynamic-SQL-execution XML functions take a raw SQL TEXT argument and
// EXECUTE it via SPI, returning the result as XML — a regex census cannot see inside the
// string literal to know it carries a DELETE (query_to_xml('DELETE …', …) has a SELECT-
// shaped call site and no banned head token). Deliberately narrower than the gate's own
// suggested `query_to_xml|query_to_json|xpath`: `query_to_json` is not a real Postgres
// builtin (nothing to flag, and naming a fictitious function in a security comment would
// be dishonest), and bare `xpath(...)` evaluates an XPath expression against XML — it does
// NOT execute embedded SQL, a different threat class than this family names. Included
// instead: the full SQL/XML mapping family that shares query_to_xml's real mechanism.
const DYNAMIC_SQL_EXEC_FN_RE =
  /\b(query_to_xml|query_to_xmlschema|query_to_xml_and_xmlschema|cursor_to_xml|cursor_to_xmlschema)\s*\(/i

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
      reasons.push(
        'lock/session/side-effect/filesystem-reaching function call (pg_advisory_*, pg_terminate_backend, ' +
          'setval, dblink, pg_read_file, pg_ls_dir, pg_logical_emit_message, …)',
      )
    }
    if (DYNAMIC_SQL_EXEC_FN_RE.test(stmt)) {
      reasons.push(
        'dynamic-SQL-execution function (query_to_xml/query_to_xmlschema/cursor_to_xml family) — executes ' +
          'an embedded SQL string this census cannot statically inspect',
      )
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
  {
    // P3-3 gate fix: CTE_WRITE_RE required the write verb's `(` to sit directly after
    // `AS`; the real grammar allows `AS MATERIALIZED (` between them, which broke the
    // adjacency and slipped a data-modifying CTE past the census entirely.
    name: 'WITH … AS MATERIALIZED (DELETE …) (materialized data-modifying CTE)',
    fragment:
      'WITH d AS MATERIALIZED (DELETE FROM meta_recovery_token_burns WHERE 1=0 RETURNING sheet_id) SELECT count(*) FROM d;',
    executionMode: 'blocked',
  },
  {
    // P3-3 gate fix: dynamic-SQL execution — the DELETE lives inside a string argument,
    // invisible to any regex operating on the statement's own SQL tokens. Postgres
    // itself refuses it, but NOT via the read-only-transaction mechanism: query_to_xml
    // requires its argument to be executable as a non-volatile query in this context,
    // and a DELETE fails that check before read-only enforcement is even reached — a
    // materially different refusal than the 25006 family, pinned separately so this is
    // never mistaken for "the read-only session caught it".
    name: "SELECT query_to_xml('DELETE …') (dynamic SQL execution via SQL/XML mapping function)",
    fragment: "SELECT query_to_xml('DELETE FROM meta_records_trash WHERE 1=0', true, false, '');",
    executionMode: 'blocked-incidental',
    incidentalSignatureRe: /is not allowed in a non-volatile function/i,
  },
  {
    // P3-4 gate fix: arbitrary host-file read through the observation connection. Not a
    // data write, so default_transaction_read_only does not gate it at all — verified
    // empirically (executionMode 'not-blocked' below) — but plainly outside a read-only
    // OBSERVATION kit's remit and a real exfiltration surface. The static census is the
    // only guard; the execution layer cannot ever catch this shape (documented, not
    // merely asserted).
    name: "SELECT pg_read_file('/etc/hosts') (server-side filesystem read)",
    fragment: 'SELECT length(pg_read_file(\'/etc/hosts\'));',
    executionMode: 'not-blocked',
  },
  {
    // P3-4 gate fix: host directory listing through the observation connection. Same
    // reasoning as pg_read_file — not a data write, not blocked by read-only mode,
    // static census is the sole guard.
    name: "SELECT … FROM pg_ls_dir('.') (server-side directory listing)",
    fragment: "SELECT count(*) FROM pg_ls_dir('.');",
    executionMode: 'not-blocked',
  },
  {
    // P3-4 gate fix: a genuine WAL write. default_transaction_read_only does NOT block
    // it (verified empirically) — it is a logical-decoding primitive, not a table data
    // write, so it falls entirely outside what the read-only-transaction mechanism
    // enforces. The static census is the only guard for this shape.
    name: "SELECT pg_logical_emit_message(true, …) (WAL write, not blocked by read-only mode)",
    fragment: "SELECT pg_logical_emit_message(true, 'o2probe', 'x');",
    executionMode: 'not-blocked',
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

// P3-3 gate fix: this shape is a plain top-level DELETE — once the tokenizer above splits
// it correctly, findNonReadonlyStatements (the HEAD-keyword layer) is the one that catches
// it, not findUnsafeConstructs (the body-aware layer covered by EVASION_SHAPES above), so it
// gets its own real-file regression test here rather than joining that array. Reused by the
// execution-layer test further down (appended to the REAL file, exactly like EVASION_SHAPES,
// so a run fails on the read-only mechanism itself, not an incidental "relation does not
// exist").
const COMMENT_HIDDEN_WRITE_FRAGMENT = "SELECT 'note -- see below'; DELETE FROM meta_records_trash WHERE 1=0;"

test('SQL: read-only census catches a write statement hidden behind a `--` inside a preceding string literal (P3-3 gate reproduction, real file)', () => {
  const doctored = `${sqlText}\n${COMMENT_HIDDEN_WRITE_FRAGMENT}\n`
  assert.deepEqual(findNonReadonlyStatements(doctored), ['DELETE'])
})

// P3-4 gate fix, static-only siblings: added to LOCK_OR_SIDE_EFFECT_FN_RE for defense-in-
// depth (same filesystem-read family as pg_read_file/pg_ls_dir) but not given their own
// EVASION_SHAPES execution-layer entry — pg_stat_file needs a real, stable server-side path
// to avoid an execution-layer test that is flaky on the path argument rather than meaningful
// on the read-only mechanism, and pg_read_binary_file is the same primitive as pg_read_file
// with a different return type. Synthetic-input static tests only.
test('SQL: static census catches pg_stat_file(…) (server-side file metadata read)', () => {
  assert.ok(findUnsafeConstructs("SELECT * FROM pg_stat_file('/etc/hosts');").length > 0)
})

test('SQL: static census catches pg_read_binary_file(…) (server-side binary file read)', () => {
  assert.ok(findUnsafeConstructs("SELECT pg_read_binary_file('/etc/hosts');").length > 0)
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
//   nc                            raw TCP/UDP to any host:port — bare, like `docker`, since
//                                 every subcommand-shaped use (listener, relay, port probe)
//                                 is host-reaching by the tool's whole purpose.
//   openssl                       bare, like `docker` — `s_client` is the host-reaching
//                                 subcommand named by the gate, but narrowing to just that
//                                 one subcommand would silently re-open every sibling
//                                 (`s_server`, future subcommands); openssl is not a tool an
//                                 operator runs routinely in this runbook, so bare-word cost
//                                 is negligible and the fail-closed direction wins.
//   node -e/--eval, python3 -c    P3-5 gate fix (was entirely absent): NARROWED to the
//   (python -c also accepted)     inline-code-execution flag specifically (both the short
//                                 `-e` and long `--eval` spellings of Node's flag), NOT bare
//                                 `node`/`python3` — those interpreters are explicitly named
//                                 above as local, non-host-reaching tools (see the
//                                 out-of-scope line below) and are legitimately mentioned
//                                 elsewhere (e.g. `node --test`). `-e`/`--eval`/`-c` is the
//                                 flag shape that lets an inline script embed a network call
//                                 (the gate's own reproduction: `node -e "fetch(...)"`).
//   bare https?:// URL            P3-5 gate fix: an imperative instruction naming a
//                                 destination URL with NO verb at all (the gate's own
//                                 `curl`-less repro) still reaches a host once *anything*
//                                 acts on it — matched as its own alternative below, not a
//                                 "verb".
// Local read-only tools (git, node, pnpm, python3, `gh pr view`) are deliberately out of
// scope EXCEPT the narrow -e/-c inline-execution flag shapes above.
// This is an inventory, not a proof of completeness — the family enumeration below is not
// claimed to converge (widening it can only ADD reds, fail-closed direction; it can never
// un-gate a block). The convergent alternative — a closed-world allowlist of every token
// that can legitimately appear in a backtick span — was considered and rejected: this
// runbook's backticks are dense with repo paths, error-class identifiers
// (`ApplyRefusalError('preview-drift', …)`), flag/constant names
// (`RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS`), and ad hoc CLI invocations (`\watch 5`), so a
// values-free allowlist would itself become an unbounded enumeration, just inverted. The
// actual compensating controls are structural, not enumerative: (1) the workflow
// path-filter guard below re-runs this exact scan on every PR that touches this runbook,
// so a widened inventory is never a one-time check that can go stale unnoticed; (2) per the
// ladder this runbook is a companion to, no step here executes anything by itself — every
// gated or ungated command still requires a human operator to read, authorize, and manually
// run it (ladder §3 owner-authorization-per-rung), so a scanner miss is a defense-in-depth
// gap, not the sole safety mechanism.
const HOST_VERB_RE =
  /\b(?:ssh|sftp|scp|rsync|curl|wget|psql|pg_dump|pg_restore|docker|kubectl|helm|aws|gcloud|az|gh\s+workflow|gh\s+api|gh\s+run\s+rerun|nc|openssl|node\s+(?:-e|--eval)|python3?\s+-c)\b|https?:\/\/\S+/gi

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

/** P3-5 gate fix: a marker must be VISIBLE in rendered Markdown to gate anything. The
 *  previous check was a raw substring test, so `<!-- OWNER-GATED -->` — an HTML comment,
 *  invisible in every Markdown renderer and on GitHub's PR/file view — satisfied it exactly
 *  as well as a real, human-visible marker, gating a visibly-ungated command that a human
 *  reviewer reading the rendered page would never see excused. Strips HTML comments before
 *  testing so only an occurrence OUTSIDE one can ever gate a block. */
function hasVisibleGateMarker(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').includes('OWNER-GATED')
}

/** Blocks containing at least one non-exempt host-reaching command occurrence whose own
 *  block (or inherited fence context) carries no VISIBLE OWNER-GATED marker. */
function findUngatedHostCommands(md) {
  const offenders = []
  for (const b of markdownBlocks(md)) {
    if (hasVisibleGateMarker(b.text) || hasVisibleGateMarker(b.extraContext)) continue
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
      (hasVisibleGateMarker(b.text) || hasVisibleGateMarker(b.extraContext)) &&
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

// P3-5 gate fix: an HTML comment is invisible in rendered Markdown, so a marker hidden
// inside one must not gate a visibly-ungated command. One test per shape, matching the
// file's established convention — a shared loop would hide which regressed.

test('runbook: a marker inside an HTML comment does NOT gate — invisible marker, visibly ungated command (P3-5 gate reproduction)', () => {
  const commentMarkerAttack =
    runbookText + '\n\n<!-- OWNER-GATED -->\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(commentMarkerAttack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: an HTML comment around a REAL marker word elsewhere in the block does not disable a genuine, human-visible gate', () => {
  // Negative control for the fix itself: a visible marker survives comment-stripping even
  // when an unrelated HTML comment sits in the same block.
  const mixed = runbookText + '\n\nOWNER-GATED: run this. <!-- reviewer note --> `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(mixed).length, 0)
})

test('runbook: widened verb inventory — nc, openssl, node -e, python3 -c, and a bare URL are each caught (P3-5 gate reproduction)', () => {
  const ncAttack = runbookText + '\n\nRun `nc deploy-host 22 < payload` now.\n'
  assert.equal(findUngatedHostCommands(ncAttack).length, 1)

  const opensslAttack = runbookText + '\n\nRun `openssl s_client -connect deploy-host:443` now.\n'
  assert.equal(findUngatedHostCommands(opensslAttack).length, 1)

  const nodeAttack =
    runbookText +
    '\n\nRun `node -e "fetch(\'https://deploy-host/api/reset-execute\',{method:\'POST\'})"` now.\n'
  assert.equal(findUngatedHostCommands(nodeAttack).length, 1)

  // Long-flag spelling of the same mechanism (`--eval` is not a distinct threat, just an
  // unmatched alias of `-e` if left out).
  const nodeEvalAttack =
    runbookText +
    '\n\nRun `node --eval "fetch(\'https://deploy-host/api/reset-execute\',{method:\'POST\'})"` now.\n'
  assert.equal(findUngatedHostCommands(nodeEvalAttack).length, 1)

  const pythonAttack =
    runbookText +
    '\n\nRun `python3 -c "import urllib.request; urllib.request.urlopen(\'https://deploy-host/api/reset-execute\')"` now.\n'
  assert.equal(findUngatedHostCommands(pythonAttack).length, 1)

  // Bare `python` (not `python3`) is also accepted.
  const pythonBareAttack =
    runbookText +
    "\n\nRun `python -c \"import urllib.request; urllib.request.urlopen('https://deploy-host/api/reset-execute')\"` now.\n"
  assert.equal(findUngatedHostCommands(pythonBareAttack).length, 1)

  const bareUrlAttack =
    runbookText + '\n\nThen visit https://deploy-host/api/base/sheets/1/revert-execute to finish the rollback.\n'
  const bareUrlOffenders = findUngatedHostCommands(bareUrlAttack)
  assert.equal(bareUrlOffenders.length, 1)
  assert.match(bareUrlOffenders[0], /revert-execute/)
})

// The gate's own `node -e`/`python3 -c` reproductions above embed a bare `https://` URL
// inside the script argument — which the URL alternative ALSO matches independently. That
// makes them a fine literal repro but a confounded isolation test: removing JUST the
// `node\s+(?:-e|--eval)` / `python3?\s+-c` alternatives from HOST_VERB_RE would NOT red
// them (the embedded URL alone still trips the match). These use a network reach with no
// URL literal at all, so each is caught on its own token or not at all.
test('runbook: node -e / --eval / python3 -c are each caught on their OWN token — isolated from the bare-URL alternative (no embedded URL literal)', () => {
  const nodeEIsolated = runbookText + "\n\nRun `node -e \"require('net').connect(9999,'deploy-host')\"` now.\n"
  assert.equal(findUngatedHostCommands(nodeEIsolated).length, 1)

  const nodeEvalIsolated = runbookText + "\n\nRun `node --eval \"require('net').connect(9999,'deploy-host')\"` now.\n"
  assert.equal(findUngatedHostCommands(nodeEvalIsolated).length, 1)

  const python3Isolated =
    runbookText + '\n\nRun `python3 -c "import socket; socket.create_connection((\'deploy-host\',9999))"` now.\n'
  assert.equal(findUngatedHostCommands(python3Isolated).length, 1)
})

test('runbook: node -e / --eval / python3 -c isolation negative control — bare `node`/`python3` (no -e/-c/--eval flag) with the SAME network-reach payload is NOT caught (confirms the isolation fragments above are exercising the flag, not something else in the payload)', () => {
  // Tested on the FRAGMENT alone, not runbookText + fragment — the real runbook already
  // contains legitimate gated ssh/curl/psql/etc. occurrences elsewhere, so counting over
  // the whole doctored text would never read 0 regardless of this fragment.
  const bareNode = "Run `node \"require('net').connect(9999,'deploy-host')\"` now."
  assert.equal(hostVerbOccurrences(bareNode).length, 0)
  const barePython3 = 'Run `python3 "import socket; socket.create_connection((\'deploy-host\',9999))"` now.'
  assert.equal(hostVerbOccurrences(barePython3).length, 0)
})

test('runbook: widened verb inventory negative controls — bare `node`/`python3` (no -e/-c) and non-network `openssl` local ops stay non-offending on their own merits, matching the documented local-tool carve-out', () => {
  // node/python3 WITHOUT the inline-execution flag: not caught by the new alternatives
  // (still local-tool territory) — confirms the narrowing is real, not a silent bare match.
  const benignNode = 'node --test scripts/ops/multitable-o2-observation.test.mjs'
  assert.equal(hostVerbOccurrences(benignNode).length, 0)
  const benignPython = 'python3 --version'
  assert.equal(hostVerbOccurrences(benignPython).length, 0)
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
      !hasVisibleGateMarker(b.text) &&
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
          // Aborts, but NOT via the read-only mechanism — via some OTHER Postgres
          // refusal specific to this shape (self-termination for
          // pg_terminate_backend; a volatility restriction for query_to_xml; …).
          // Pin to the shape's own specific signature (default: the
          // self-termination text, for backward compat with the original shape)
          // so this is never mistaken for a 25006 read-only refusal.
          const incidentalRe =
            shape.incidentalSignatureRe ??
            /terminating connection due to administrator command|server closed the connection unexpectedly/i
          assert.match(
            result.stderr,
            incidentalRe,
            `expected the shape's own incidental-abort signature (NOT a read-only refusal); got exit ${result.status}, stderr:\n${result.stderr}`,
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
            `expected "${shape.name}" NOT to be blocked by read-only mode (documents the real gap the static census covers); stderr:\n${result.stderr}`,
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

  // P3-3 gate fix, execution-layer leg for the head-keyword shape (findNonReadonlyStatements,
  // not findUnsafeConstructs — see the static test's comment above) — kept outside
  // EVASION_SHAPES for the same reason.
  test('EXECUTION: doctored copy with a `--`-hidden DELETE behind a preceding string literal is blocked (SQLSTATE 25006 family)', () => {
    const doctored = `${sqlText}\n${COMMENT_HIDDEN_WRITE_FRAGMENT}\n`
    const result = runReadOnlySql(doctored)
    assert.match(
      result.stderr,
      /cannot execute \S+.*in a read-only transaction/i,
      `expected a read-only-transaction refusal (SQLSTATE 25006 family); got exit ${result.status}, stderr:\n${result.stderr}`,
    )
  })
}
