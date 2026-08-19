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
    // DOUBLE-QUOTED IDENTIFIER — `"x -- y"`. Round-5 gate P3-1: this branch did not exist, so a
    // `--` inside an identifier read as a comment start and ERASED the rest of that line from
    // every static predicate (heads, body census, function allowlist, and the backslash ban).
    // The gate's shipped-code extraction:
    //     RAW      : SELECT 1 AS "x -- " ; SELECT lo_create(0);
    //     STRIPPED : SELECT 1 AS "x
    //     HEADS: []   BACKSLASH: []
    // — and it WRITES: under this file's own invocation it created a large object, and one armed
    // suite run with the shape present took large objects 0 -> 21 while every layer stayed green.
    // `lo_create` is precisely the family round 3 moved INTO the static census because the
    // execution layer provably cannot see it, so this erasure put it back out of reach of layer 1.
    // Same erasure class as the round-2 single-quote bug, one quoting syntax over; the fix is to
    // mirror the branch above (`""` is the escape for a literal `"` inside an identifier).
    if (sql[i] === '"') {
      const start = i
      out += '"'
      i += 1
      let closed = false
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += '""'; i += 2; continue }
        if (sql[i] === '"') { out += '"'; i += 1; closed = true; break }
        out += sql[i]
        i += 1
      }
      if (!closed) {
        throw new Error(
          `stripComments: unterminated quoted identifier starting at offset ${start} — refusing ` +
            'to silently treat the rest of the file as identifier content (fail-toward-flagging)',
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
    // Quoted identifier — a `;` inside `"…"` must not split a statement (round-5 gate P3-1's
    // sibling: stripComments now preserves these spans, so the splitter has to respect them too,
    // or a `;` inside an identifier would fragment the statement and hand the head census a
    // bogus head token).
    if (ch === '"') {
      cur += ch
      i += 1
      while (i < n) {
        if (stripped[i] === '"' && stripped[i + 1] === '"') { cur += '""'; i += 2; continue }
        cur += stripped[i]
        const closing = stripped[i] === '"'
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

// ---------------------------------------------------------------------------
// P3-1 gate fix (round 4): the observation `.sql` is not only SQL — the file's own
// "HOW TO RUN" header instructs `psql "$DATABASE_URL" -f
// scripts/ops/multitable-o2-observation.sql`, and psql interprets its input file as a
// SCRIPT, not merely as a stream of SQL statements. A line beginning with `\` is a psql
// BACKSLASH METACOMMAND — `\gexec`, `\g`, `\gset`, `\i`, `\o`, `\copy`, `\!`, `\q`, and any
// name psql adds in a future version — and metacommands carry no `;`, so they are absorbed
// into the PRECEDING `SELECT`-headed statement by splitStatements above and never appear as
// their own statement at all. Every static predicate in this file — findNonReadonlyStatements,
// findUnsafeConstructs, findDisallowedPgFunctionCalls, findDisallowedFunctionCalls — operates
// on the output of splitStatements, so all four are STRUCTURALLY BLIND to this channel: not a
// gap in any one regex, a gap in the SQL-statement model itself, which a metacommand is
// outside of by construction. psql, meanwhile, executes it.
//
// Round-4 gate reproduction, verified against a real, freshly migrated scratch Postgres:
//   D4 — `SELECT 'COMM'||'IT' \gexec` / `SELECT 'SET default_transaction_read_only = off'
//        \gexec` / `SELECT 'CREA'||'TE TABLE o2_pwn_np AS SELECT 1' \gexec` / `SELECT 'SET
//        default_transaction_read_only = on' \gexec` — every statement head is SELECT, no
//        `||`-split literal matches DDL_KEYWORD_RE, and the payload avoids a `name(` shape —
//        created a REAL, PERSISTENT table (`o2_pwn_np`, confirmed present in
//        information_schema.tables) while findNonReadonlyStatements, findUnsafeConstructs,
//        AND the execution-layer's OWN "pristine SQL file runs clean" positive control all
//        stayed GREEN. (An unobfuscated `SELECT 'CREATE TEMP TABLE …' \gexec` variant IS
//        caught, but only INCIDENTALLY — DDL_KEYWORD_RE matches the literal CREATE inside the
//        string — and string concatenation (`'CREA' || 'TE …'`) removes that incidental catch,
//        same mechanism as the round-3 `\q` case below.)
//   D5 — `SELECT 1 AS probe` followed by `\! touch /tmp/o2_shell_probe` — arbitrary SHELL
//        EXECUTION from inside the file psql, an OWNER-GATED runbook, and this test's own
//        `psql -f` invocation all run directly.
//
// This ALSO corrects the shape of the `BEGIN READ ONLY` wrap's own disclosed residual, further
// down this file (see runReadOnlySql's comment and the BOUNDED_DISARM_WRITE_SHAPE section): that
// residual previously read as "harness-scoped — sound INSIDE the harness, uncovered only for the
// runbook's plain operator invocation". D4 falsifies the "sound inside the harness" half — a
// metacommand rides inside the wrapped script too (the wrap only governs SQL statements executed
// inside the transaction; `\gexec`/`\!` are interpreted by psql itself, outside any transaction's
// reach) and defeats it from within, including delivering a bare `COMMIT;` (D4's first `\gexec`
// leg) to end the wrapping transaction early. The corrected, precise shape: the metacommand
// channel escapes BOTH the plain operator invocation AND this harness's own `BEGIN READ ONLY`
// wrap equally — it is not a harness-only soundness gap, it is a gap in what layer 1 (the static
// census) was checking. See the correction inline at runReadOnlySql's comment.
//
// FIX: this is NOT another name to add to a blocklist (the family — \gexec, \g, \gset, \i, \o,
// \copy, \!, \q, and anything psql adds later — is exactly the trap-enumeration shape this file's
// own convention rejects). Structural instead: the observation SQL is pure SQL BY CONTRACT (its
// own header says so, and says how it is invoked) — so a single property check, independent of
// which metacommand name is used AND of WHERE it sits, closes the whole family at once: after
// comments are stripped, the file must contain NO backslash at all.
//
// POSITION MATTERS, and a line-leading-only rule is NOT enough — this was caught by re-verifying
// the first version of this fix rather than trusting it: `\gexec`'s canonical idiom is TRAILING,
// on the same line as the statement it re-executes. Proven against a real database:
//   SELECT 'CREA'||'TE TABLE o2_pwn_eol AS SELECT 1' \gexec
// psql exits 0 and the table IS created, while a `/^[ \t]*\\/` line-leading test never fires.
// Stripping comments first is what makes a whole-file backslash ban free to adopt TODAY — and note
// this is a property of THIS FILE, not of the guard (round-5 gate NIT-1): the pristine file's ONLY
// backslash lives in a comment (`-- loop (e.g. \watch 5) …`), and a backslash
// has no legitimate use in this file's executable text — E-strings and dollar-quoting are already
// banned above, so no escape syntax needs one. This is LOAD-BEARING for D4 and D5 (neither slipped
// through any OTHER predicate in this file — see the negative-control test below, which disables
// this predicate alone and confirms D4/D5 pass every remaining check) — it is not defense-in-depth
// alongside a stronger structural catch, it is the only static catch either shape has. It also
// SUBSUMES the round-3 `\q` case: a bare `\q` immediately after a `;` was, until now, caught only
// INCIDENTALLY — findNonReadonlyStatements takes the first whitespace-delimited token of the
// following (`;`-split) statement as its head, so `\q` merges into that role and gets flagged as
// offender `\Q` purely by accident of position; a `\q` that instead lands mid-statement (with no
// preceding `;` on the same "statement" the tokenizer sees) would NOT be a head token and would
// slip that check entirely — verified below (the same dedicated test also proves the new
// predicate catches `\q` regardless of position, not just the accidentally-caught one).
/** Line numbers (1-based) carrying a backslash in the COMMENT-STRIPPED SQL — i.e. a psql
 *  metacommand in any position (line-leading `\q`, trailing `\gexec`, mid-line `\!`), or any
 *  other executable backslash. Empty means clean. `stripComments` preserves newlines, so line
 *  numbers map 1:1 onto the original file. */
function findMetacommandLines(sql) {
  return stripComments(sql)
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => line.includes('\\'))
    .map(([lineNo]) => lineNo)
}

test('SQL: contains no psql backslash metacommand anywhere — the file is pure SQL by contract (its own "HOW TO RUN" header says `psql -f`), and psql ALSO runs it as a SCRIPT: \\gexec/\\!/\\i/\\copy/\\o/\\q and any future psql metacommand carry no `;`, so they are invisible to every statement-based predicate in this file (findNonReadonlyStatements, findUnsafeConstructs, findDisallowedPgFunctionCalls, findDisallowedFunctionCalls all operate on splitStatements output) while psql executes them regardless (P3-1 round-4 gate fix — see D4/D5 above)', () => {
  assert.deepEqual(findMetacommandLines(sqlText), [], 'observation SQL must not contain a backslash outside comments — a psql metacommand in ANY position (line-leading, trailing, mid-line) is executed by psql while being invisible to every statement-based predicate here')
})

test('SQL: metacommand ban is LOAD-BEARING for D4/D5 — with this predicate alone disabled, the exact gate-reproduced \\gexec write chain and the \\! shell-execution line pass every OTHER static predicate in this file (positive control: this is the only static catch either shape has, not defense-in-depth alongside a stronger one)', () => {
  const gexecChain =
    "SELECT 'COMM' || 'IT'\n\\gexec\nSELECT 'SET default_transaction_read_only = off'\n\\gexec\n" +
    "SELECT 'CREA' || 'TE TABLE o2_pwn_np AS SELECT 1'\n\\gexec\nSELECT 'SET default_transaction_read_only = on'\n\\gexec\n"
  const shellLine = 'SELECT 1 AS probe\n\\! touch /tmp/o2_shell_probe_mutation_check\n'
  for (const doctored of [gexecChain, shellLine]) {
    assert.deepEqual(findNonReadonlyStatements(doctored), [], 'every statement head is SELECT — findNonReadonlyStatements does not see this shape')
    assert.deepEqual(findUnsafeConstructs(doctored), [], 'no CTE/locking/pg_*/DDL/function-call shape here — findUnsafeConstructs does not see this shape either')
  }
  // The metacommand ban itself IS the catch — proven by the primary test above, not repeated
  // here (this test's job is only to show every OTHER predicate stays silent).
  assert.ok(findMetacommandLines(gexecChain).length > 0 && findMetacommandLines(shellLine).length > 0)
})

test('SQL: metacommand ban is not vacuous — a doctored copy containing a real metacommand IS caught at the correct line, in EVERY position psql accepts (line-leading, trailing, mid-line), and a backslash inside a string is ALSO refused by deliberate contract', () => {
  /** 1-based line number of the APPENDED metacommand line, computed from the text itself so this
   *  control cannot drift with the pristine file's trailing-newline shape. Uses the LAST
   *  backslash-bearing line on purpose: the pristine file legitimately carries one earlier
   *  backslash inside a COMMENT (`-- loop (e.g. \watch 5) …`), which the predicate strips and
   *  must never report — searching from the front would pin that comment line instead and make
   *  this control assert the wrong thing. */
  const backslashLineOf = (text) => {
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].includes('\\')) return i + 1
    throw new Error('backslashLineOf: no backslash in the doctored text — the probe itself is broken')
  }

  const lineLeading = `${sqlText}\nSELECT 1;\n\\gexec\n`
  assert.deepEqual(findMetacommandLines(lineLeading), [backslashLineOf(lineLeading)])

  // TRAILING `\gexec` — the canonical idiom, and the shape that defeated this rule's first,
  // line-leading-only version. Verified against a real database while re-checking that fix:
  //   SELECT 'CREA'||'TE TABLE o2_pwn_eol AS SELECT 1' \gexec
  // psql exits 0 and the table IS created. A `/^[ \t]*\\/` test never fires on it.
  const trailing = `${sqlText}\nSELECT 'CREA'||'TE TABLE o2_pwn_eol AS SELECT 1' \\gexec\n`
  assert.deepEqual(findMetacommandLines(trailing), [backslashLineOf(trailing)])

  // MID-LINE shell escape.
  const midLine = `${sqlText}\nSELECT 1; \\! touch /tmp/o2_pwn\n`
  assert.deepEqual(findMetacommandLines(midLine), [backslashLineOf(midLine)])

  // A backslash inside a STRING literal is refused too. That is a deliberate contract choice,
  // not an oversight: psql itself would treat it as data, but this file's tokenizer is hand
  // written, and a divergence between what IT calls a string and what PSQL calls a string is
  // exactly the class that already bit this guard once (E-strings, banned above for the same
  // reason). The observation SQL needs no backslash in executable text — the pristine file's
  // only backslash is in a comment — so refusing them outright costs nothing today and removes
  // a whole category of parser-divergence reasoning. Comments are still exempt (stripped first),
  // which is what keeps this zero-false-positive on the pristine file.
  assert.deepEqual(findMetacommandLines("SELECT 'a \\ b' AS x;\n"), [1])
  assert.deepEqual(findMetacommandLines("-- a comment mentioning \\watch 5\nSELECT 1;\n"), [])
})

test('SQL: metacommand ban subsumes the round-3 `\\q` case — the OLD incidental catch only fires when `\\q` happens to land right after a `;` (so it becomes the next merged statement\'s head token); a `\\q` sitting MID-STATEMENT (no preceding `;`) slipped findNonReadonlyStatements entirely — verified here — while the new predicate catches BOTH, regardless of position', () => {
  const afterSemicolon = `${sqlText}\n\\q\n`
  assert.deepEqual(findMetacommandLines(afterSemicolon), [sqlText.split('\n').length + 1])
  // The case the OLD mechanism actually missed: no preceding `;` on the same tokenizer
  // "statement", so `\q` is never a head token and findNonReadonlyStatements sees nothing.
  const midStatement = 'SELECT count(*)\n\\q\nFROM meta_sheets;'
  assert.deepEqual(findNonReadonlyStatements(midStatement), [], "documents the old mechanism's blind spot: mid-statement \\q was never a head token")
  assert.deepEqual(findMetacommandLines(midStatement), [2], 'the new predicate catches it anyway — position-independent, unlike the old incidental catch')
})

// ---------------------------------------------------------------------------

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

// P3-3 gate fix (round 2) follow-up: the "bounded-window" disarm class — an explicit
// `BEGIN; SET TRANSACTION READ WRITE; …; COMMIT;` performs a write WITHOUT ever changing
// either read-only GUC's value at the point the RO_INVARIANT_CANARY_SQL end-of-session
// check runs (the override is scoped to just that one explicit transaction; verified
// empirically here — after COMMIT, `current_setting('default_transaction_read_only')`
// reads 'on' again, unchanged the whole time). So the invariant canary alone does NOT
// cover this class — it is covered by a DIFFERENT, already-existing mechanism: `BEGIN`,
// `SET`, and `COMMIT` are none of them a SELECT/WITH head, so findNonReadonlyStatements
// (layer 1a, the original head-only census, predating this round's fixes) already flags
// every one of them. This test is the mechanical proof of that layering claim — not left
// as an unverified comment — so a regression in the head-only census would be caught here
// even though the invariant canary would stay silent for this specific shape.
test('SQL: bounded-window disarm (`BEGIN; SET TRANSACTION READ WRITE; …; COMMIT;`) is caught by the head-only census — this class does NOT rely on the end-of-session invariant canary, which cannot see it (P3-3 round-2 gate follow-up)', () => {
  const doctored =
    sqlText +
    '\nBEGIN;\nSET TRANSACTION READ WRITE;\nCREATE TEMP TABLE o2_bounded_window_probe(x int);\nINSERT INTO o2_bounded_window_probe VALUES (1);\nCOMMIT;\n'
  const offenders = findNonReadonlyStatements(doctored)
  assert.ok(offenders.includes('BEGIN'), `expected BEGIN to be flagged as a non-SELECT/WITH head; got ${JSON.stringify(offenders)}`)
  assert.ok(offenders.includes('SET'), `expected SET TRANSACTION READ WRITE to be flagged as a non-SELECT/WITH head; got ${JSON.stringify(offenders)}`)
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
// P3-2 gate fix (round 2), quoted-identifier hole: `"pg_ls_waldir"()` names the exact same
// function as `pg_ls_waldir()` — Postgres unquoted identifiers fold to lowercase, so a
// double-quoted identifier spelled in that same lowercase resolves identically — but a
// name-then-`(` regex with no allowance for the closing quote in between does not see it
// as the same call site. `"?` immediately after the name (before the optional whitespace)
// closes that hole without opening a new one: it does not relax WHICH names match, only
// tolerates one extra optional character of punctuation around a name this regex was
// already going to flag.
const LOCK_OR_SIDE_EFFECT_FN_RE =
  /\b(pg_advisory_(?:xact_)?lock(?:_shared)?|pg_try_advisory_(?:xact_)?lock(?:_shared)?|pg_advisory_unlock(?:_all|_shared)?|pg_terminate_backend|pg_cancel_backend|pg_promote|pg_switch_wal|pg_switch_xlog|pg_reload_conf|pg_rotate_logfile|pg_create_restore_point|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|setval|nextval|set_config|dblink(?:_exec)?|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_logical_emit_message)"?\s*\(/i
const COPY_PROGRAM_RE = /\bCOPY\b[^;]*\b(FROM|TO)\s+PROGRAM\b/i
const DDL_KEYWORD_RE = /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER)\b/i

// ---------------------------------------------------------------------------
// P3-2 gate fix (round 2): the enumeration trap recurred INSIDE the fix that closed
// round-1 P3-4 — `pg_ls_dir` was banned by name, but `pg_ls_waldir` / `pg_ls_tmpdir`
// (direct siblings; Postgres also ships pg_ls_archive_statusdir / pg_ls_logicalsnapdir /
// pg_ls_logicalmapdir / pg_ls_replslotdir) and `pg_stat_reset` (a genuine cumulative-
// statistics-destroying side effect, distinct family, but the same "one more pg_ name
// exists that this file forgot to enumerate" failure mode) were fully green through both
// layers. A blocklist of `pg_*` names can never converge — Postgres adds new ones every
// major version, and enumerating today's list only wins today.
//
// STRUCTURAL fix, not a wider blocklist: this observation kit's queries are supposed to
// be a small, closed set of read-only aggregate/introspection queries — a default-DENY
// allowlist of `pg_*` FUNCTION CALLS the file is permitted to make is exactly as
// enumerable as "what does Q1..Q8 actually call today" (verified below: zero, so the
// allowlist starts EMPTY) and, unlike a blocklist, a miss here fails CLOSED: any `pg_*`
// function call not on the allowlist is flagged, including one that does not exist yet.
// Adding a genuinely-needed future `pg_*` call requires TOUCHING THIS ALLOWLIST (and
// justifying, in a comment, why the call is pure/no-side-effect/no-filesystem-or-network
// reach) — the fail-closed direction the trap-enumeration lesson calls for. This does not
// replace LOCK_OR_SIDE_EFFECT_FN_RE above (kept as defense-in-depth / documentation of
// WHY specific named functions are dangerous); this is the load-bearing, non-enumerative
// backstop that catches every `pg_*` sibling LOCK_OR_SIDE_EFFECT_FN_RE forgot, now and in
// any future Postgres version.
// Quoted-identifier hole (found by this fix's own adversarial follow-up, before landing):
// `"pg_ls_waldir"()` names the exact same function as `pg_ls_waldir()` — a double-quoted
// identifier spelled in the same lowercase an unquoted one folds to resolves identically
// — but a bare `\bpg_\w*\s*(?=\()` never sees the call, because a `"` sits between the
// name and the paren. The trailing `"?` tolerates exactly that one extra punctuation
// character without relaxing which NAMES match (still `pg_\w*` only), and is stripped
// back off before the name is compared against the allowlist below.
const PG_FUNCTION_CALL_RE = /\bpg_\w*"?\s*(?=\()/gi
// Deliberately empty: no query in this observation kit calls ANY pg_* function today (see
// the positive control below — the pristine census is clean specifically because this set
// has nothing in it, not because nothing was checked).
const PG_FUNCTION_ALLOWLIST = new Set([])

/** pg_* function calls in `stmt` that are not on the explicit allowlist — default-deny,
 *  so a name this file has never seen before (a brand-new Postgres builtin, or a sibling
 *  of an already-banned one) is flagged without needing to be named here. Strips a
 *  trailing `"` (see PG_FUNCTION_CALL_RE above) before comparing against the allowlist, so
 *  `pg_ls_waldir` and `"pg_ls_waldir"` are recognized as the same call site. */
function findDisallowedPgFunctionCalls(stmt) {
  const found = new Set()
  for (const m of stmt.matchAll(PG_FUNCTION_CALL_RE)) {
    const name = m[0].trim().replace(/"$/, '').toLowerCase()
    if (!PG_FUNCTION_ALLOWLIST.has(name)) found.add(name)
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// P3-3 gate fix (round 3): the pg_* allowlist above is sound WITHIN its own namespace,
// but structurally BLIND outside it — `lo_create(0)` and `lo_from_bytea(0, …)` are real,
// non-pg_*-prefixed function names, so PG_FUNCTION_CALL_RE cannot see them at all;
// `lo_create`/`lo_from_bytea`/`lo_put`/`lo_open`/`lo_write`/`lo_truncate` are not (all)
// named in LOCK_OR_SIDE_EFFECT_FN_RE either (only lo_import/lo_export/lo_unlink are); and
// NEITHER of the two write-target GUCs the invariant canary watches is touched by a
// large-object write, so the canary stays silent by design. Verified empirically this
// gate: under `default_transaction_read_only = on`, `lo_create(0)` and
// `lo_from_bytea(0, '\x0102'::bytea)` each create a REAL, PERSISTENT large object
// (`pg_largeobject_metadata` row count increases; exit 0) — see mutationEvidence for the
// OIDs. dblink_connect(...) and set_config(...) are two more non-pg_*-prefixed names this
// file already separately bans by NAME (LOCK_OR_SIDE_EFFECT_FN_RE) — this fix makes that
// banning non-enumerative too.
//
// STRUCTURAL fix, same shape as the pg_* allowlist above (not a replacement for it — kept
// alongside as defense-in-depth / documentation, same convention as
// LOCK_OR_SIDE_EFFECT_FN_RE vs PG_FUNCTION_CALL_RE): default-deny over EVERY function
// call in the file, not namespaced to pg_*. This observation kit's ENTIRE function-call
// surface today is exactly 8 names — count, max, min, btrim, hashtext, hashtextextended,
// current_database, current_schema — verified below (positive control, derived from the
// file's own splitStatements tokenizer, not a separate ad hoc scan). Framed precisely,
// per the round-3 gate's own NIT-1.3 correction of the sibling pg_* comment: this is
// default-deny over every CALL SITE modulo a short, justified EXCLUSION LIST of SQL
// grammar keywords that name no callable function at all (below) — it is not claimed to
// be "structural, not enumerative" in some absolute sense, because the exclusion list
// itself is a small, closed enumeration by construction. What is non-enumerative is the
// thing that matters: the ALLOWLIST (which functions may be called), not the grammar
// carve-out (which tokens are not function names).
const FUNCTION_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)"?\s*(?=\()/g
// SQL clause keywords that are legitimately followed by `(` in ordinary SQL syntax but are
// not — and cannot be — function calls: `AND (...)` / grouping, `IN (...)`, `AS (...)` (a
// CTE body — already handled on its own terms by CTE_WRITE_RE above), `VALUES (...)`.
// Deliberately TRIMMED to exactly what this file's own pristine content requires (proven
// by running FUNCTION_CALL_RE over the real, tokenized statements — see the positive
// control below) rather than a speculative, larger SQL-keyword list: every entry here is
// empirically load-bearing against the real file, so a mutation that deletes one reds the
// pristine-census test naming a real keyword, not a dead predicate nothing exercises.
const SQL_CLAUSE_KEYWORDS = new Set(['and', 'as', 'in', 'values'])
const ALLOWED_FUNCTION_CALLS = new Set([
  'count',
  'max',
  'min',
  'btrim',
  'hashtext',
  'hashtextextended',
  'current_database',
  'current_schema',
])

/** True if the function-call-shaped match at `matchIndex` in `stmt` is actually a CTE
 *  name-with-column-list header — `WITH name(col, col) AS (...)` — not a function call:
 *  Postgres CTE syntax allows an explicit column list directly after the CTE name, and
 *  this file's only two occurrences (`subjects(kind, subject_id)`, `canary_sheets(sheet_id)`)
 *  are both this shape, immediately preceded by the `WITH` keyword. Deliberately narrow —
 *  only the exact `WITH name(` adjacency is excluded, so a FUTURE multi-CTE list
 *  (`WITH a AS (…), b(cols) AS (…)`) or `WITH RECURSIVE name(cols)` is intentionally left
 *  UNEXCLUDED and would be FLAGGED (fail-closed) until someone extends this predicate and
 *  justifies why — not silently "fixed" by broadening it ahead of need. */
function isCteColumnListHeader(stmt, matchIndex) {
  return /\bWITH\s*$/i.test(stmt.slice(0, matchIndex))
}

/** Function calls in `stmt` that are not on the explicit allowlist — default-deny over
 *  EVERY function call (not namespaced to pg_*, unlike findDisallowedPgFunctionCalls
 *  above), so `lo_create`, `lo_from_bytea`, `dblink_connect`, `set_config`, and any future
 *  non-pg_*-prefixed sibling are flagged without needing to be named by this file's other,
 *  narrower predicates. Strips a trailing `"` before comparing (same quoted-identifier
 *  tolerance as PG_FUNCTION_CALL_RE/LOCK_OR_SIDE_EFFECT_FN_RE), skips SQL grammar keywords
 *  and CTE column-list headers (neither is a callable function), and skips names already
 *  covered by the narrower pg_* allowlist above (pg_* names are validated there — listing
 *  them again here too would just be the same verdict via a second path, not a distinct
 *  check; NOT skipped for that reason in existing narrower-predicate tests below, which
 *  intentionally call the pg_*-specific and named-blocklist predicates directly instead of
 *  routing through this general one — see their own comments). */
function findDisallowedFunctionCalls(stmt) {
  const found = new Set()
  for (const m of stmt.matchAll(FUNCTION_CALL_RE)) {
    if (isCteColumnListHeader(stmt, m.index)) continue
    const name = m[1].toLowerCase()
    if (SQL_CLAUSE_KEYWORDS.has(name)) continue
    if (name.startsWith('pg_')) continue
    if (!ALLOWED_FUNCTION_CALLS.has(name)) found.add(name)
  }
  return [...found]
}
// ---------------------------------------------------------------------------

// P3-3 gate fix: dynamic-SQL-execution XML functions take a raw SQL TEXT argument and
// EXECUTE it via SPI, returning the result as XML — a regex census cannot see inside the
// string literal to know it carries a DELETE (query_to_xml('DELETE …', …) has a SELECT-
// shaped call site and no banned head token). Deliberately narrower than the gate's own
// suggested `query_to_xml|query_to_json|xpath`: `query_to_json` is not a real Postgres
// builtin (nothing to flag, and naming a fictitious function in a security comment would
// be dishonest), and bare `xpath(...)` evaluates an XPath expression against XML — it does
// NOT execute embedded SQL, a different threat class than this family names. Included
// instead: the full SQL/XML mapping family that shares query_to_xml's real mechanism.
// Same quoted-identifier tolerance as LOCK_OR_SIDE_EFFECT_FN_RE above (`"?` before the
// optional whitespace) — `"query_to_xml"('DELETE …', …)` resolves identically to the
// unquoted call.
const DYNAMIC_SQL_EXEC_FN_RE =
  /\b(query_to_xml|query_to_xmlschema|query_to_xml_and_xmlschema|cursor_to_xml|cursor_to_xmlschema)"?\s*\(/i

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
    // P3-2 gate fix (round 2): structural default-deny backstop — catches every pg_*
    // function call not on the (currently empty) allowlist, independent of whether
    // LOCK_OR_SIDE_EFFECT_FN_RE happens to name it. Load-bearing for siblings the named
    // blocklist above has not (yet) enumerated.
    const disallowedPg = findDisallowedPgFunctionCalls(stmt)
    if (disallowedPg.length > 0) {
      reasons.push(
        `pg_* function call(s) not on the explicit allowlist (${disallowedPg.join(', ')}) — structural ` +
          'default-deny: any pg_* call this file has not explicitly justified is flagged, independent of ' +
          'name enumeration',
      )
    }
    // P3-3 gate fix (round 3): the GENERAL structural default-deny backstop — catches
    // every function call, pg_*-prefixed or not, not on ALLOWED_FUNCTION_CALLS. Load-
    // bearing for lo_create/lo_from_bytea/dblink_connect/set_config and any future
    // non-pg_*-prefixed sibling the two narrower checks above (findDisallowedPgFunctionCalls,
    // LOCK_OR_SIDE_EFFECT_FN_RE) have not enumerated. Not a replacement for either — kept
    // alongside them as defense-in-depth, same convention as pg_* allowlist vs
    // LOCK_OR_SIDE_EFFECT_FN_RE.
    const disallowedFn = findDisallowedFunctionCalls(stmt)
    if (disallowedFn.length > 0) {
      reasons.push(
        `function call(s) not on the explicit allowlist (${disallowedFn.join(', ')}) — structural default-deny ` +
          'over EVERY function call (not namespaced to pg_*): any call this file has not explicitly justified ' +
          'is flagged, independent of namespace or name enumeration',
      )
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
  {
    // P3-2 gate fix (round 2): a direct sibling of the just-banned pg_ls_dir — the round-1
    // fix named pg_ls_dir specifically and left every other pg_ls_*dir function fully
    // green through both layers. Verified empirically: NOT blocked by
    // default_transaction_read_only (server-side WAL directory listing, not a data
    // write). The structural pg_* allowlist backstop (not just the widened blocklist) is
    // this shape's real guard — see findDisallowedPgFunctionCalls.
    name: "SELECT … FROM pg_ls_waldir() (server-side WAL directory listing — pg_ls_dir sibling)",
    fragment: 'SELECT count(*) FROM pg_ls_waldir();',
    executionMode: 'not-blocked',
  },
  {
    // P3-2 gate fix (round 2): another pg_ls_dir sibling (temp-file directory listing).
    // Same verified-empirically not-blocked behaviour.
    name: "SELECT … FROM pg_ls_tmpdir() (server-side temp-file directory listing — pg_ls_dir sibling)",
    fragment: 'SELECT count(*) FROM pg_ls_tmpdir();',
    executionMode: 'not-blocked',
  },
  {
    // P3-2 gate fix (round 2): destroys cumulative server statistics — a genuine
    // server-state mutation that default_transaction_read_only does not gate (verified
    // empirically below), and one the ladder's own observation criteria could depend on
    // (Q-series queries reason about stats). Not a filesystem-read sibling of pg_ls_dir,
    // but the same "one more pg_* name this file forgot" failure mode, closed by the same
    // structural allowlist backstop.
    name: 'SELECT pg_stat_reset() (destroys cumulative statistics, not blocked by read-only mode)',
    fragment: 'SELECT pg_stat_reset();',
    executionMode: 'not-blocked',
  },
  {
    // P3-3 gate fix (round 3): a REAL, PERSISTENT write that is NOT pg_*-prefixed, so
    // PG_FUNCTION_CALL_RE structurally cannot see it, and not fully named in
    // LOCK_OR_SIDE_EFFECT_FN_RE (only lo_import/lo_export/lo_unlink are listed there —
    // lo_create is not). Verified empirically this gate, against a real, migrated scratch
    // database, under `default_transaction_read_only = on`: lo_create(0) returns a real
    // OID and `pg_largeobject_metadata` gains a row — a genuine write, not merely
    // unflagged, and NOT blocked by read-only mode (large objects are not table data in
    // the sense `default_transaction_read_only` governs). The general function-call
    // default-deny (findDisallowedFunctionCalls, above) is this shape's only guard — this
    // fragment self-cleans (wraps the create in lo_unlink) so the execution-layer run
    // below leaves no large object behind in the operator's database. HONESTY NOTE
    // (multiple fail-closed doors covering for each other): `lo_unlink` is already a named
    // member of LOCK_OR_SIDE_EFFECT_FN_RE, so this fragment's OWN static-census assertion
    // (`findUnsafeConstructs(doctored).length > 0`, in the execution-layer loop below) is
    // satisfied via THAT door even if the new general default-deny regressed — it is not,
    // by itself, a discriminating test for the general check. The discriminating tests are
    // the dedicated hermetic ones (`findDisallowedFunctionCalls('SELECT lo_create(0);')`,
    // above), which use a bare, non-self-cleaning fragment with no already-blocklisted
    // name in it — mutation-verified (see mutationEvidence) to red on their own when the
    // general check is disabled, while this EVASION_SHAPES entry's static assertion stays
    // green throughout (masked by `lo_unlink`).
    name: 'SELECT lo_create(0) (large-object write, not pg_*-prefixed — not blocked by read-only mode)',
    fragment: 'SELECT lo_unlink(lo_create(0));',
    executionMode: 'not-blocked',
  },
  {
    // P3-3 gate fix (round 3): the bytea-content sibling of lo_create — same real,
    // persistent, not-pg_*-prefixed, not-read-only-gated write, verified empirically this
    // gate. Self-cleaning, same reasoning as lo_create above — including the same
    // masked-by-`lo_unlink` honesty note (the dedicated hermetic test for lo_from_bytea is
    // the discriminating one, not this entry's static-census assertion).
    name: "SELECT lo_from_bytea(0, '\\x0102'::bytea) (large-object write via bytea content, not blocked by read-only mode)",
    fragment: "SELECT lo_unlink(lo_from_bytea(0, '\\x0102'::bytea));",
    executionMode: 'not-blocked',
  },
]

// ---------------------------------------------------------------------------
// P3-3 gate fix (round 2): `set_config('default_transaction_read_only', 'off', false)` —
// a SELECT-headed statement, in no static ban list before this fix, that DISARMS layer 2
// for the REST OF THE SESSION. Verified empirically with a direct psql experiment (see
// mutationEvidence): after this statement, `CREATE TEMP TABLE …; INSERT …;` succeed and
// the run exits 0; the control (identical writes, no disarming statement) reds with
// SQLSTATE 25006. The kit already reds on this shape TODAY, but only COLLATERALLY — six
// `EXECUTION: doctored copy with …` probe tests fail because THEY, not this statement,
// are the last thing in the file, so the failure message names an unrelated probe, never
// the statement that disabled the guard. That is fragile in a specific, foreseeable way:
// the natural "run each doctored probe in its own psql session" hardening would make the
// disarm fully silent while looking like an improvement.
//
// This shape gets its OWN executionMode ('disarm'), not a slot in EVASION_SHAPES's
// blocked/not-blocked/blocked-incidental taxonomy, because its assertion is categorically
// different: it does not check whether THIS statement's own effect was refused — it
// checks whether the STRUCTURAL END-OF-SESSION INVARIANT (asserted by
// RO_INVARIANT_CANARY_SQL, appended inside runReadOnlySql to every execution-layer run —
// see below) fires and NAMES the disarm. That is the fix that makes detection independent
// of which probe happens to run last, and closes the same hole for any future disarm
// statement, spelled any way, that this static census does not yet know to ban by name.
const SET_CONFIG_DISARM_SHAPE = {
  name: "SELECT set_config('default_transaction_read_only', 'off', false) (guard disarm)",
  fragment: "SELECT set_config('default_transaction_read_only', 'off', false);",
  executionMode: 'disarm',
}

// P3-2 gate fix (round 3): the BOUNDED sibling of SET_CONFIG_DISARM_SHAPE — disarm, WRITE,
// then RESTORE before the session (and this canary) ever runs. Round-3 gate finding: this
// exact chain passes every layer under the OLD session-default-only posture (the canary is
// blind because the restore already ran; the write itself succeeded because the session
// default really was 'off' at the moment it executed). See runReadOnlySql's own comment for
// why wrapping the whole script in an explicit `BEGIN READ ONLY; … COMMIT;` transaction
// closes this: the WRITE line itself now errors 25006, before the disarm's restore
// statement is ever reached — a structurally different, and strictly earlier, catch than
// the end-of-session canary.
const BOUNDED_DISARM_WRITE_SHAPE = {
  name: 'bounded guard disarm + write + restore (disarm, CREATE TEMP TABLE, restore, all before session end)',
  fragment:
    "SELECT set_config('default_transaction_read_only', 'off', false);\n" +
    'CREATE TEMP TABLE o2_bounded_disarm_write_probe(x int);\n' +
    "SELECT set_config('default_transaction_read_only', 'on', false);",
}

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

// P3-3 gate fix (round 2), static leg: defense-in-depth only — the load-bearing catch for
// this shape is the end-of-session invariant canary in the execution layer below (a
// static regex can always be evaded by a spelling this file has not seen; the canary
// checks the EFFECT, not the statement text).
test('SQL: static census catches the set_config(…) guard-disarm shape (defense-in-depth; see the execution-layer invariant canary for the load-bearing catch)', () => {
  const doctored = `${sqlText}\n${SET_CONFIG_DISARM_SHAPE.fragment}\n`
  assert.ok(findUnsafeConstructs(doctored).length > 0, 'static census missed the set_config disarm shape')
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

// P3-2 gate fix (round 2) follow-up: quoted-identifier evasion of the structural pg_*
// allowlist AND the named blocklist. `"pg_ls_waldir"()` names the exact same function as
// `pg_ls_waldir()` — Postgres unquoted identifiers fold to lowercase, so a double-quoted
// identifier spelled in that same lowercase resolves to the identical call, verified
// empirically here against a real server. Found by attacking this fix's own new
// PG_FUNCTION_CALL_RE/LOCK_OR_SIDE_EFFECT_FN_RE regexes before they landed (see
// mutationEvidence) — both required the function name to be followed immediately by
// optional whitespace then `(`, with no allowance for the closing `"` a quoted identifier
// interposes. One test per regex family so a regression in either is caught on its own.
test('SQL: static census catches a quoted-identifier pg_* call — `"pg_ls_waldir"()` (structural allowlist; resolves to the identical unquoted function)', () => {
  assert.ok(findUnsafeConstructs('SELECT "pg_ls_waldir"();').length > 0)
})

// Deliberately uses `setval` (NOT a pg_*-prefixed name) rather than `pg_read_file`: a
// pg_*-prefixed quoted call would ALSO be caught by the structural pg_* allowlist above
// regardless of this regex's own quote-tolerance. Asserts the REGEX DIRECTLY, not via
// findUnsafeConstructs (multiple fail-closed doors cover for each other — a door-level
// pass is not proof any SPECIFIC door still fires): since the P3-3 round-3 general
// function-call default-deny (findDisallowedFunctionCalls, below) ALSO now flags `setval`
// (it is not pg_*-prefixed and not on ALLOWED_FUNCTION_CALLS), routing this test through
// findUnsafeConstructs would keep it green even if LOCK_OR_SIDE_EFFECT_FN_RE's own
// quote-tolerance regressed — the general check would silently cover for it. Asserting
// LOCK_OR_SIDE_EFFECT_FN_RE.test(...) directly keeps this test load-bearing on THIS regex
// alone, exactly as originally intended.
test('SQL: LOCK_OR_SIDE_EFFECT_FN_RE catches a quoted-identifier named-blocklist call — `"setval"(...)` (a non-pg_*-prefixed member, asserted directly so the general function-call default-deny below cannot mask a regression here)', () => {
  assert.ok(LOCK_OR_SIDE_EFFECT_FN_RE.test("SELECT \"setval\"('some_seq', 1);"))
  // Still true end-to-end via the full census too (defense-in-depth, not the discriminator).
  assert.ok(findUnsafeConstructs("SELECT \"setval\"('some_seq', 1);").length > 0)
})

test('SQL: static census catches a quoted-identifier dynamic-SQL-execution call — `"query_to_xml"(...)` (DYNAMIC_SQL_EXEC_FN_RE)', () => {
  assert.ok(findUnsafeConstructs('SELECT "query_to_xml"(\'DELETE FROM meta_records_trash WHERE 1=0\', true, false, \'\');').length > 0)
})

// ---------------------------------------------------------------------------
// P3-3 gate fix (round 3): the GENERAL function-call default-deny — findDisallowedFunctionCalls.
// ---------------------------------------------------------------------------

test('SQL: general function-call default-deny catches lo_create(...) (large-object write; not pg_*-prefixed, so only this general check — not the pg_* allowlist, not LOCK_OR_SIDE_EFFECT_FN_RE — can see it)', () => {
  assert.deepEqual(findDisallowedFunctionCalls('SELECT lo_create(0);'), ['lo_create'])
  assert.ok(findUnsafeConstructs('SELECT lo_create(0);').length > 0)
})

test('SQL: general function-call default-deny catches lo_from_bytea(...) (large-object write via bytea content)', () => {
  assert.deepEqual(findDisallowedFunctionCalls("SELECT lo_from_bytea(0, '\\x0102'::bytea);"), ['lo_from_bytea'])
  assert.ok(findUnsafeConstructs("SELECT lo_from_bytea(0, '\\x0102'::bytea);").length > 0)
})

test('SQL: general function-call default-deny catches dblink_connect(...) (already named in LOCK_OR_SIDE_EFFECT_FN_RE; caught here too, independent of that enumeration)', () => {
  assert.deepEqual(findDisallowedFunctionCalls("SELECT dblink_connect('o2probe', '');"), ['dblink_connect'])
})

test('SQL: general function-call default-deny is NOT vacuous — an ALLOWLISTED call, in the exact multi-call shape the real file uses, is genuinely permitted (positive control), while a non-allowlisted sibling call in the identical shape is flagged', () => {
  assert.deepEqual(
    findDisallowedFunctionCalls(
      "SELECT count(*), max(x), min(x), btrim(y), hashtext(z), hashtextextended(z, 0), current_database(), current_schema() FROM t;",
    ),
    [],
    'every one of the 8 allowlisted names must be permitted — this must not just be an empty file passing vacuously',
  )
  assert.deepEqual(findDisallowedFunctionCalls('SELECT length(x) FROM t;'), ['length'])
})

test('SQL: general function-call default-deny — SQL grammar keywords (AND/AS/IN/VALUES) that are followed by `(` are NOT mistaken for function calls', () => {
  assert.deepEqual(findDisallowedFunctionCalls('SELECT 1 WHERE a = 1 AND (b = 2);'), [])
  assert.deepEqual(findDisallowedFunctionCalls('SELECT x FROM t WHERE x IN (1, 2, 3);'), [])
  assert.deepEqual(findDisallowedFunctionCalls('WITH v(x) AS (VALUES (1), (2)) SELECT * FROM v;'), [])
})

test('SQL: general function-call default-deny — a CTE name-with-column-list header (`WITH name(cols) AS (…)`) is NOT mistaken for a function call, but the identical name used as a REAL function call elsewhere in the same statement still is', () => {
  assert.deepEqual(findDisallowedFunctionCalls('WITH subjects(kind, subject_id) AS (VALUES (1, 2)) SELECT count(*) FROM subjects;'), [])
  // The same word, NOT preceded by WITH, IS treated as a function call.
  assert.deepEqual(findDisallowedFunctionCalls('SELECT subjects() FROM t;'), ['subjects'])
})

test('SQL: general function-call default-deny — positive control derived from splitStatements over the REAL file: exactly the 8 documented names appear, nothing more (proves the allowlist is not padded with names the file never actually calls)', () => {
  const found = new Set()
  for (const stmt of splitStatements(sqlText)) {
    for (const m of stmt.matchAll(FUNCTION_CALL_RE)) {
      if (isCteColumnListHeader(stmt, m.index)) continue
      const name = m[1].toLowerCase()
      if (SQL_CLAUSE_KEYWORDS.has(name)) continue
      if (name.startsWith('pg_')) continue
      found.add(name)
    }
  }
  assert.deepEqual([...found].sort(), [...ALLOWED_FUNCTION_CALLS].sort())
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
//
// P3-5 gate fix (round 2) additions:
//   git push          `git` itself stays out of scope (a local read-only tool for every
//                      OTHER subcommand used in this runbook — status/log/diff/…), but
//                      `push` specifically writes to a REMOTE, so it is narrowed in, not
//                      bare `git`, matching the same non-bare-widening discipline as the
//                      node -e/python3 -c narrowing above.
//   gh pr merge        `gh workflow` / `gh api` / `gh run rerun` were already listed as
//                      GitHub-side dispatch surfaces; `gh pr merge` changes GitHub-hosted
//                      repository state exactly the same way and was simply missing.
//   telnet / socat     raw TCP (and, for socat, arbitrary bidirectional stream relay) to
//                       any host:port — the same class of reach as `nc`, just a different
//                       binary name.
// Restated per the compensating-control note above (this list still does not converge):
// the two structural controls are what actually caps the residual risk, not this
// enumeration reaching completeness — (1) the path-filter re-run below, and (2) no
// runbook step self-executes, so any verb this inventory still misses requires a human to
// read, copy, and manually run it regardless.
const HOST_VERB_RE =
  /\b(?:ssh|sftp|scp|rsync|curl|wget|psql|pg_dump|pg_restore|docker|kubectl|helm|aws|gcloud|az|gh\s+workflow|gh\s+api|gh\s+run\s+rerun|gh\s+pr\s+merge|git\s+push|nc|telnet|socat|openssl|node\s+(?:-e|--eval)|python3?\s+-c)\b|https?:\/\/\S+/gi

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

// ---------------------------------------------------------------------------
// P3-4 gate fix (round 2): the invisible-marker class is bigger than HTML comments.
//
// Round 1 closed exactly one construct that renders to nothing: `<!-- OWNER-GATED -->`.
// The round-2 gate found FOUR MORE Markdown/HTML constructs that also render as nothing
// (or as an attribute a sighted reader scanning the page never sees) and every one of
// them slipped: a link-reference definition (`[OWNER-GATED]: # (…)`), the classic
// "comment via empty link reference" idiom (`[//]: # (OWNER-GATED)`), an HTML tag
// attribute (`<span title="OWNER-GATED">`), and Markdown image alt text
// (`![OWNER-GATED](x.png)`). Banning each construct BY NAME repeats the exact trap this
// file's own P3-2 fix just named (枚举陷阱不收敛) — a sixth invisible construct would slip
// exactly the same way.
//
// STRUCTURAL fix: instead of stripping named constructs one at a time, strip every
// construct that is INVISIBLE-BY-DEFINITION in rendered Markdown — text with no visible
// rendering surface at all — and require OWNER-GATED to survive in what remains. That
// generalizes to any future invisible construct without needing a new name added here,
// because the classification is "does CommonMark render this as reader-visible text?",
// not "is this exact syntax on a list".
function stripInvisibleMarkdown(text) {
  let out = text
  // 1. HTML comments — never rendered, in any renderer (round-1 fix, kept).
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // 1b. P3-3 gate fix (round 4): an UNTERMINATED HTML comment — `<!-- OWNER-GATED` with no
  //    closing `-->` anywhere in the rest of the document. Step 1's lazy `[\s\S]*?-->` only
  //    matches a comment that DOES close, so an unterminated one survived the strip entirely
  //    while every real Markdown/HTML renderer swallows everything from the unterminated
  //    `<!--` to end-of-document as comment content (nothing after it is reader-visible
  //    either). Runs strictly AFTER step 1, which is what makes this safe: every comment that
  //    HAS a closing `-->` was already removed by step 1, so any `<!--` still present at this
  //    point is, by construction, unterminated for the rest of the text — this cannot
  //    mis-fire on a well-formed comment. Strips from that `<!--` to the true end of the
  //    string (greedy `[\s\S]*` already reaches the end on its own; no `$` anchor needed).
  out = out.replace(/<!--[\s\S]*/, '')
  // 2. Link-reference definitions — `[label]: destination "title"` (title may also be
  //    `'title'` or `(title)`). CommonMark renders a well-formed reference-definition line
  //    as NOTHING — covers both `[OWNER-GATED]: # (…)` (marker in the label) and the
  //    classic `[//]: # (OWNER-GATED)` idiom (marker in the parenthesized title). Must run
  //    BEFORE the generic HTML-tag strip below, since a `(title)` can itself contain
  //    tag-like text without being HTML.
  out = out.replace(/^[ \t]{0,3}\[[^\]\n]*\]:[^\n]*$/gm, '')
  // 3. Markdown images — `![alt](url "title")`. Alt text is not reader-visible body text;
  //    it is a fallback shown only if the image fails to load, or exposed to assistive
  //    tech — a sighted reviewer scanning the rendered page sees an image (or a broken-
  //    image icon), never the word "OWNER-GATED". The leading `!` distinguishes this from
  //    an ordinary `[text](url)` hyperlink, whose text IS rendered and visible, and which
  //    must NOT be stripped here.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // 4. HTML tags themselves (including all attributes: `title=`, `alt=`, `data-*`, …) —
  //    strip the markup, but keep whatever text sits BETWEEN an opening and closing tag
  //    (that text IS rendered and visible, e.g. `<b>OWNER-GATED</b>: …` must still gate).
  //    P3-2 gate fix (round 4): the `\n` exclusion below used to make this single-line-only —
  //    `<span\ntitle="OWNER-GATED">\n</span>` slipped past entirely because no single LINE
  //    contained both the opening `<` and its closing `>`, even though CommonMark/HTML both
  //    parse a tag's attributes across line breaks without incident (an attacker gets a
  //    genuinely invisible marker for free just by wrapping it). Dropping `\n` from the
  //    excluded-character class lets the match span newlines — no `s`/dotAll flag is needed
  //    for that (a negated class `[^>]` already includes `\n` on its own merits; `s` only
  //    changes what bare `.` matches, and this pattern uses a class, not `.`). Fail-closed
  //    direction preserved: this can only ever strip MORE candidate marker text (⇒ more
  //    offenders flagged), never remove a host command from hostVerbOccurrences' raw-text
  //    scan — see the negative controls below for the over-stripping check this widening
  //    itself needs (a real marker must still survive a real, unrelated multi-line tag).
  // 4b. P3-2 gate fix (round 5): `<style>` and `<script>` CONTENT. Rule 4 correctly keeps text
  //     BETWEEN tags because that text is normally rendered — but these two elements are the
  //     exception: their contents are never page content (GitHub strips both elements entirely),
  //     so `<style>/* OWNER-GATED */</style>` and `<script>// OWNER-GATED</script>` were
  //     invisible markers that still gated. Runs BEFORE the generic tag strip, since afterwards
  //     the element boundaries are gone and the content would look like ordinary text.
  out = out.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  out = out.replace(/<[^>]+>/g, '')
  // 5. P3-4 gate fix (round 3): a fenced code block's INFO STRING — the text on the same
  //    line as the opening ``` /~~~ fence (e.g. "```bash OWNER-GATED"). No Markdown
  //    renderer displays the info string as page content (GitHub and CommonMark both use
  //    it only to select a syntax-highlighting language) — a sighted reader scanning the
  //    rendered page sees a code block with a language badge, never the word
  //    "OWNER-GATED", even though the marker sits on the very line that opens the block
  //    where host commands live. Strips the trailing text on EVERY fence-DELIMITER line
  //    matched (opening or closing) — deliberately not narrowed to "opening only", because
  //    this function is used ONLY inside hasVisibleGateMarker (below), never to decide
  //    whether a host verb is present: findUngatedHostCommands runs hostVerbOccurrences on
  //    the block's RAW text, so over-stripping here can only ever remove an OWNER-GATED
  //    marker (⇒ MORE offenders, the fail-closed direction), never a host command from
  //    detection. A closing fence's trailing text is not meaningfully rendered either way,
  //    so stripping it too costs nothing and needs no separate justification. The CODE
  //    CONTENT lines between the fences are untouched and remain fully visible/scanned (a
  //    real marker placed as actual fence-body content, e.g. a `# OWNER-GATED` shell
  //    comment line, is genuinely rendered and must still gate — see the negative control
  //    below).
  out = out.replace(/^([ \t]{0,3}(?:```+|~~~+))[^\n]*/gm, '$1')
  // 6. P3-4 gate fix (round 3): an inline link/image TITLE — `[text](url "title")` (also
  //    the `'title'` and `(title)` forms CommonMark accepts). A title renders only as a
  //    hover tooltip in the renderers that show it at all — GitHub's own renderer does not
  //    display it even on hover — never as text a reader scanning the page sees. Strips
  //    ONLY the title clause; the link's visible TEXT (`[text]`) and its destination are
  //    left untouched (an ordinary link's visible text must still gate — see the negative
  //    control below). Runs after the image strip above, so an image's title was already
  //    removed along with the rest of the image syntax. Residual, disclosed rather than
  //    claimed closed: a destination containing whitespace, an unescaped `)`/`(`, or the
  //    `<url>` bracketed form is not matched here and its title would survive — narrow by
  //    construction, not a general link-syntax parser.
  out = out.replace(/(\]\([^()\s]*)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))(\s*\))/g, '$1$2')
  return out
}

/** A marker must be VISIBLE in rendered Markdown to gate anything — present in the text
 *  that SURVIVES stripInvisibleMarkdown, not merely present as a raw substring anywhere
 *  in the source (which would also match inside any of the invisible constructs above). */
function hasVisibleGateMarker(text) {
  return stripInvisibleMarkdown(text).includes('OWNER-GATED')
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

// P3-4 gate fix (round 2): four more invisible Markdown/HTML constructs the round-1 fix
// (HTML comments only) left open. One test per shape, matching the file's established
// convention — a shared loop would hide which regressed.

test('runbook: a marker hidden in a link-reference definition does NOT gate — `[OWNER-GATED]: # (…)` renders as nothing (P3-4 gate reproduction, round 2)', () => {
  const attack =
    runbookText +
    '\n\n[OWNER-GATED]: # (invisible link-reference definition)\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: the classic `[//]: # (OWNER-GATED)` comment-via-link-reference idiom does NOT gate (P3-4 gate reproduction, round 2)', () => {
  const attack = runbookText + '\n\n[//]: # (OWNER-GATED)\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: a marker hidden in an HTML tag attribute (`<span title="OWNER-GATED">`) does NOT gate (P3-4 gate reproduction, round 2)', () => {
  const attack =
    runbookText + '\n\n<span title="OWNER-GATED"></span>\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: a marker hidden in Markdown image alt text (`![OWNER-GATED](x.png)`) does NOT gate (P3-4 gate reproduction, round 2)', () => {
  const attack =
    runbookText + '\n\n![OWNER-GATED](nonexistent.png)\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: negative controls for the round-2 invisible-marker fix — a REAL visible marker survives each stripped construct sitting nearby, and an ordinary (non-image) link with "OWNER-GATED" as its visible text still gates', () => {
  // A genuine link-reference definition for an unrelated label must not consume a real,
  // separate, visible marker elsewhere in the same block.
  const refDefNearby =
    runbookText +
    '\n\n[unrelated]: https://example.com "note"\nOWNER-GATED: run exactly this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(refDefNearby).length, 0)
  // An ordinary hyperlink (no leading `!`) with OWNER-GATED as its link TEXT is genuinely
  // rendered and visible — must still gate (discriminates the image-alt strip from over-
  // stripping ordinary links).
  const visibleLinkText =
    runbookText + '\n\n[OWNER-GATED](https://example.com/policy): run this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(visibleLinkText).length, 0)
  // A real marker inside bold/emphasis tags is still visible text between the tags — must
  // still gate (discriminates the HTML-tag strip, which removes only the markup, from
  // over-stripping the tags' own inner content).
  const boldMarker = runbookText + '\n\n<b>OWNER-GATED</b>: run this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(boldMarker).length, 0)
})

// P3-4 gate fix (round 3): two more invisible-by-construction Markdown constructs the
// round-2 fix left open. One test per shape, matching the file's established convention.

test('runbook: a marker hidden in a fenced code block\'s INFO STRING (` ```bash OWNER-GATED `) does NOT gate — no renderer displays text after the language tag, even though it sits on the very line opening the block the command lives in (P3-4 gate reproduction, round 3)', () => {
  const attack = runbookText + '\n\n```bash OWNER-GATED\nssh deploy@host systemctl stop metasheet\n```\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: a marker hidden in an inline link TITLE (`[step](./x.md "OWNER-GATED")`) does NOT gate — a title renders only as a hover tooltip, if it renders at all (P3-4 gate reproduction, round 3)', () => {
  const attack =
    runbookText +
    '\n\nSee the [rollback step](./notes.md "OWNER-GATED") first. `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: negative controls for the round-3 invisible-marker fix — a marker as the actual FIRST LINE of fence BODY content (not the info string) still gates, and a link TITLE with unrelated text does not block detection of a real marker stated separately', () => {
  // A marker inside the fence's CONTENT (not its info-string line) is genuinely rendered
  // — must still gate (discriminates the info-string strip from over-stripping the code
  // block's own visible body).
  const fenceBodyMarker = runbookText + '\n\n```bash\n# OWNER-GATED\nssh deploy@host systemctl stop metasheet\n```\n'
  assert.equal(findUngatedHostCommands(fenceBodyMarker).length, 0)
  // An unrelated link title sitting near a REAL, separately-stated visible marker must not
  // consume it.
  const titleNearby =
    runbookText +
    '\n\nOWNER-GATED: see the [rollback step](./notes.md "internal note") first. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(titleNearby).length, 0)
  // An ordinary link's visible TEXT (not its title) carrying the marker is genuinely
  // rendered — must still gate (discriminates the title strip from over-stripping the
  // link's own visible text portion).
  const linkTextMarker = runbookText + '\n\nSee the [OWNER-GATED](./notes.md) step. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(linkTextMarker).length, 0)
})

// P3-2/P3-3 gate fix (round 4): two more invisible-marker escapes. P3-2 is the file's own
// round-3 residual, previously disclosed as "not confirmed reachable" — the round-4 gate
// CONFIRMED it reachable, so that qualifier is dropped here, not carried forward. P3-3 is a
// sixth, previously undisclosed form.

test('runbook: a marker hidden in an HTML tag whose attributes WRAP ACROSS LINES (`<span\\ntitle="OWNER-GATED">`) does NOT gate — CommonMark/HTML parse a tag\'s attributes across line breaks without incident, but the round-3 tag-strip regex was single-line-only (P3-4 gate reproduction, round 4 — CONFIRMED reachable; the round-3 disclosure of this shape as "not confirmed reachable" is retracted, not merely superseded)', () => {
  const attack =
    runbookText + '\n\n<span\ntitle="OWNER-GATED">\n</span>\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: a marker hidden in an UNTERMINATED HTML comment (`<!-- OWNER-GATED` with no closing `-->` anywhere in the rest of the document) does NOT gate — every real renderer swallows the remainder of the document as comment content, so nothing after it is reader-visible either, yet the terminated-comment-only strip left it untouched (P3-4 gate reproduction, round 4 — sixth form, previously undisclosed)', () => {
  const attack = runbookText + '\n\n<!-- OWNER-GATED\nRun `ssh deploy@host systemctl stop metasheet` now.\n'
  const offenders = findUngatedHostCommands(attack)
  assert.equal(offenders.length, 1)
  assert.match(offenders[0], /ssh deploy@host systemctl stop metasheet/)
})

test('runbook: negative controls for the round-4 invisible-marker fix — a real marker survives an UNRELATED multi-line tag or a properly TERMINATED comment sitting nearby, and a genuinely multi-line VISIBLE tag body (text between the tags) still gates', () => {
  // An unrelated multi-line tag near a real, separately-stated visible marker must not
  // consume it — discriminates the widened tag-strip from over-stripping real prose that
  // merely follows a `<...>` spanning lines.
  const multilineTagNearby =
    runbookText +
    '\n\n<span\nclass="note">unrelated</span>\nOWNER-GATED: run exactly this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(multilineTagNearby).length, 0)
  // A genuine, PROPERLY TERMINATED HTML comment elsewhere in the block must still be
  // stripped as before (step 1, unaffected by the new step 1b) — a real marker after it
  // still gates.
  const terminatedCommentNearby =
    runbookText + '\n\n<!-- reviewer note -->\nOWNER-GATED: run exactly this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(terminatedCommentNearby).length, 0)
  // A real marker as the visible TEXT content between two tags that themselves span lines
  // is still genuinely rendered — must still gate (discriminates "strip the markup" from
  // "strip everything from the first multi-line `<` onward").
  const multilineTagVisibleBody =
    runbookText + '\n\n<b\nclass="x">OWNER-GATED</b>: run this. `ssh deploy@host verify` now.\n'
  assert.equal(findUngatedHostCommands(multilineTagVisibleBody).length, 0)
})

test('runbook: widened verb inventory — git push, gh pr merge, telnet, socat are each caught (P3-5 gate reproduction, round 2)', () => {
  const gitPushAttack = runbookText + '\n\nRun `git push deploy HEAD:main --force` now.\n'
  assert.equal(findUngatedHostCommands(gitPushAttack).length, 1)

  const ghMergeAttack = runbookText + '\n\nRun `gh pr merge 5020 --admin --squash` now.\n'
  assert.equal(findUngatedHostCommands(ghMergeAttack).length, 1)

  const telnetAttack = runbookText + '\n\nRun `telnet deploy-host 8080` now.\n'
  assert.equal(findUngatedHostCommands(telnetAttack).length, 1)

  const socatAttack = runbookText + '\n\nRun `socat TCP:deploy-host:22 -` now.\n'
  assert.equal(findUngatedHostCommands(socatAttack).length, 1)
})

test('runbook: widened verb inventory negative control (round 2) — bare `git` (no `push` subcommand) stays non-offending, matching the documented local-tool carve-out', () => {
  const benignGit = 'Run `git status` then `git log --oneline -5` to review before continuing.'
  assert.equal(hostVerbOccurrences(benignGit).length, 0)
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

/** Residue baseline, captured BEFORE any doctored probe executes. Compared at the very end of
 *  the armed run (round-5 gate NIT-2). Null when the lane is not armed. */
const RESIDUE_BASELINE = canRunExecutionLayer ? residueFingerprint() : null

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

// ---------------------------------------------------------------------------
// P3-3 gate fix (round 2): STRUCTURAL end-of-session invariant canary.
//
// Every prior execution-layer assertion in this file checks whether ONE statement's own
// effect was refused. That is exactly the property a disarming statement (set_config, or
// any future spelling this file has never seen) breaks: the disarming statement itself
// causes no error, so nothing about it is refused — and everything AFTER it in the same
// psql session then runs un-guarded. The round-2 gate proved this concretely: appending
// `SELECT set_config('default_transaction_read_only', 'off', false);` reds today, but
// only because SOME OTHER probe happens to run later in the same test file and hits the
// now-disarmed session — the failure names that unrelated probe, never the statement that
// disarmed it. That is fragile: a "run each probe in its own psql session" refactor (a
// reasonable-looking hardening) would make the disarm fully silent.
//
// This canary is appended to the END of every psql script run through runReadOnlySql
// (pristine AND doctored alike) and asserts THE INVARIANT ITSELF, independent of which
// statement — named or not — broke it:
//   1. `current_setting('default_transaction_read_only')` must still read 'on' at the end
//      of the SAME session (set_config's third argument, is_local=false, makes the change
//      session-wide and durable across the file's implicit per-statement transactions —
//      this is exactly why it persists to be checked here).
//   1b. `current_setting('transaction_read_only')` — the EFFECTIVE per-transaction value
//      that Postgres actually consults when deciding whether to refuse a write, distinct
//      from the default new transactions inherit — must also still read 'on'. Checked
//      separately from 1, not merely inferred from it, for the historical reason the two
//      could in principle disagree: BEFORE the round-3 `BEGIN READ ONLY` wrap (see below),
//      each of the file's top-level statements ran as its own fresh implicit transaction
//      whose effective value was reseeded from the session default at the moment it
//      started, so a disarm mid-file could — in principle, for a future attack shape, not
//      any this file has found — move one without the other. AFTER the round-3 wrap, the
//      whole file (including this canary) runs inside ONE already-started explicit
//      read-only transaction, so `transaction_read_only` is fixed 'on' for its entire
//      duration regardless of what `default_transaction_read_only` does — see the ROUND-3
//      IMPACT note immediately below for what that means for THIS leg specifically (kept
//      checked independently, not because it still catches anything today, but so the
//      reasoning is not silently lost if the wrap is ever removed or narrowed).
//   2. A canary write (CREATE TEMP TABLE + INSERT — confirmed empirically in this gate to
//      raise the standard 25006 read_only_sql_transaction error under a genuinely
//      read-only session, and to succeed silently when disarmed) is attempted inside a
//      PL/pgSQL exception handler: the EXPECTED 25006 is swallowed (so a genuinely
//      read-only pristine run stays silently green, unaffected); if the write instead
//      SUCCEEDS, that is itself proof of disarm and raises explicitly.
// Either failure mode RAISEs an exception containing the literal marker
// 'O2_RO_GUARD_DISARMED', so a disarm is never mistaken for a collateral probe failure —
// see the dedicated 'disarm' executionMode branch below, which asserts on that marker
// specifically, not merely on a non-zero exit.
//
// P3-2 gate fix (round 3) IMPACT on legs 1b and 2, stated precisely rather than left
// stale: runReadOnlySql now wraps the ENTIRE script in one explicit `BEGIN READ ONLY;`
// transaction (see its own comment). `transaction_read_only` — the value leg 1b reads —
// is FIXED for the lifetime of an already-started transaction and literally cannot become
// anything other than 'on' once `BEGIN READ ONLY` has succeeded, no matter what happens to
// `default_transaction_read_only` afterward; by the same mechanism, leg 2's write probe
// can no longer succeed under ANY disarm shape (there is nothing left for it to prove —
// the write is refused by the wrapping transaction, not by whatever the session default
// currently says). So under THIS execution model, legs 1b and 2 are STRUCTURALLY INERT:
// leg 1b always reads 'on' and leg 2's EXCEPTION WHEN branch always fires, for every
// shape this file exercises, doctored or not. They are kept — not because they still
// catch anything under the wrap, but as (a) a textual pin on the canary's own source
// (see the hermetic pin test below, which still asserts their presence) so a future
// change that removes or weakens the wrap does not silently lose this reasoning along
// with it, and (b) documentation of the reasoning trail that justified the wrap in the
// first place. Leg 1 (`default_transaction_read_only`) is the ONLY leg still empirically
// load-bearing today — it is what fires for the plain, un-restored disarm shape (see
// SET_CONFIG_DISARM_SHAPE's own test below) — because that GUC genuinely still changes,
// mid-transaction, even though the EFFECTIVE `transaction_read_only` it would otherwise
// seed does not.
//
// Investigated and closed, not merely assumed: can `transaction_read_only` (the effective
// value) be flipped directly, via its OWN set_config call, independent of the default?
// Verified empirically — NO. `SELECT set_config('transaction_read_only','off',false);` is
// refused outright by Postgres itself with "transaction read-write mode must be set before
// any query", because evaluating that very SELECT already counts as a query in the current
// transaction. The only way to change the EFFECTIVE value directly is `SET TRANSACTION READ
// WRITE` or an explicit `BEGIN` block — both have a non-SELECT/WITH statement head, so both
// are already caught by findNonReadonlyStatements (layer 1a) before this canary would ever
// be relevant. See the dedicated bounded-window test below for the mechanical proof of that
// claim, rather than leaving it as an unverified assertion in a comment.
//
// This does NOT run for a 'blocked' or 'blocked-incidental' EVASION_SHAPES probe: psql is
// invoked with ON_ERROR_STOP=1, so the script already aborts at THAT shape's own refusal
// before ever reaching this trailing canary — those shapes' existing assertions (pinned to
// their own specific refusal text) are unaffected. For 'not-blocked' shapes the invariant
// genuinely still holds (those shapes don't touch either read-only GUC), so the canary
// passes silently and the existing exit-0 assertion is unaffected too. Verified empirically
// for both cases — see mutationEvidence.
const RO_INVARIANT_CANARY_SQL = `
DO $o2_ro_invariant_canary$
DECLARE
  v_default_state text;
  v_effective_state text;
BEGIN
  v_default_state := current_setting('default_transaction_read_only');
  IF v_default_state IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'O2_RO_GUARD_DISARMED: default_transaction_read_only=% at end of session (expected on) — the read-only guard was disarmed by an earlier statement in this run', v_default_state;
  END IF;
  v_effective_state := current_setting('transaction_read_only');
  IF v_effective_state IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'O2_RO_GUARD_DISARMED: transaction_read_only=% at end of session (expected on) — the EFFECTIVE read-only state was disarmed by an earlier statement in this run', v_effective_state;
  END IF;
  BEGIN
    CREATE TEMP TABLE o2_ro_invariant_canary_probe(x int);
    INSERT INTO o2_ro_invariant_canary_probe VALUES (1);
    RAISE EXCEPTION 'O2_RO_GUARD_DISARMED: canary write (CREATE TEMP TABLE + INSERT) succeeded under an ostensibly read-only session';
  EXCEPTION WHEN read_only_sql_transaction THEN
    NULL; -- expected: a genuinely read-only session refuses the canary write. Silence is correct.
  END;
END;
$o2_ro_invariant_canary$;
`

// P3-2 gate fix (round 3): a BOUNDED disarm — `set_config(…,'off',…)` immediately
// RESTORED (`set_config(…,'on',…)`) before the session ends — is invisible to the
// end-of-session invariant canary above by construction: the canary reads the GUC state
// only once, at the very end, and by then the restore has already put it back to 'on'.
// Mutation-proven by the gate: deleting just the `set_config` literal from
// LOCK_OR_SIDE_EFFECT_FN_RE makes a disarm-then-restore pass EVERY layer (static census
// blind to the new spelling, canary blind because the window closed before it ran) — the
// name-list entry was, until this fix, the ONLY thing catching this class, which is
// exactly the enumerable dependency the canary was introduced to get away from.
//
// Relying on the SESSION-LEVEL `default_transaction_read_only` GUC (via the `-c 'SET
// default_transaction_read_only = on;'` pre-command below) can never close this: the GUC
// is, by definition, whatever the most recent `SET`/`set_config` said it was — a bounded
// toggle is invisible to anything that only samples it, not something that watches it
// continuously.
//
// Fix: wrap the ENTIRE script (pristine or doctored) in one EXPLICIT
// `BEGIN READ ONLY; … COMMIT;` transaction. `transaction_read_only` — the EFFECTIVE
// value Postgres actually consults when deciding whether to refuse a write — is fixed
// for the lifetime of an already-started transaction and CANNOT be changed by a
// mid-transaction `set_config('default_transaction_read_only', …)` call (verified
// empirically — see mutationEvidence: inside `BEGIN READ ONLY`, `set_config(…,'off',…)`
// itself still succeeds — it is not a data write — but a write attempted afterward, in
// the SAME transaction, still errors 25006 `cannot execute … in a read-only
// transaction`, regardless of what the session-level GUC now reads). So, INSIDE THIS
// HARNESS (runReadOnlySql — the property this test file itself proves), a bounded
// disarm-then-restore is made INERT, not merely detected after the fact: any write an
// attacker attempts inside the disarmed window still fails at the moment it is
// attempted — see the dedicated bounded-disarm test below, which is the mechanical proof
// of this claim rather than an unverified comment.
//
// NOT claimed: that this closes the bounded-disarm class (pure SQL: `set_config(…,'off',…)`,
// a write, `set_config(…,'on',…)`, no metacommand involved) for an OPERATOR following the
// runbook's own documented invocation (`psql "$DATABASE_URL" -f
// scripts/ops/multitable-o2-observation.sql`, plain, no explicit transaction) — that
// invocation has no `BEGIN READ ONLY` wrapper and relies solely on the session-level GUC
// this file's own execution model has just demonstrated is insufficient for this class.
// Hardening the operator invocation itself would mean changing the runbook (or the .sql
// file's own "HOW TO RUN" header) to recommend the explicit-transaction form — outside
// this test file's remit, and the runbook/SQL blobs are unmodified by this fix (both
// remain byte-identical to `main`). This is a real, disclosed residual, not a closed gap.
//
// CORRECTION (P3-1, round-4 gate): an earlier version of this residual read as
// "harness-scoped" — true for the bounded pure-SQL disarm above, but understated for a
// DIFFERENT class this same round found: psql backslash metacommands (`\gexec`, `\!`, …).
// Those are NOT SQL statements at all — they are interpreted by psql itself, outside
// anything a `BEGIN READ ONLY; … COMMIT;` wrap governs — so the wrap being "sound inside
// the harness" was FALSE for that class: `\gexec` delivering a bare `COMMIT` mid-script (see
// D4, above) ends the wrapping transaction from within the harness just as it would for a
// plain operator invocation, defeating the wrap symmetrically for both. That class is now
// closed — for BOTH invocation styles equally, not merely for this harness — by the P3-1
// static ban above (`SQL: contains no psql backslash metacommand anywhere`): since it
// operates on the checked-in `.sql` file's own content (layer 1, hermetic, no DB needed),
// it protects whoever runs that exact file, wrapped or not. So the residual precisely
// narrows to: the bounded PURE-SQL disarm class only, for the plain operator invocation only
// — not, as the earlier wording implied, "anything not covered by the wrap is also uncovered
// by everything else this kit checks".
//
// This does NOT retire the session-level `SET default_transaction_read_only = on;` (kept
// below) or the end-of-session canary above — both remain independent, cheap
// defense-in-depth layers (the canary in particular is still the ONLY thing that
// catches a plain, un-restored disarm, since that shape touches no write the
// transaction wrapper would ever see) — see the file's own defense-in-depth convention.
// Verified empirically that every existing EVASION_SHAPES classification (`blocked` /
// `blocked-incidental` / `not-blocked`) is UNCHANGED under this wrap, including
// `lo_create`/`lo_from_bytea` (P3-3 below) staying `not-blocked` — large-object writes
// are not gated by `transaction_read_only` either, wrapped or not.

/** Run `sql` (full text) via psql against DATABASE_URL, inside one EXPLICIT
 *  `BEGIN READ ONLY; … COMMIT;` transaction (P3-2 gate fix, round 3 — see above),
 *  ON_ERROR_STOP so any failing statement aborts the whole run non-zero. Returns
 *  { status, stdout, stderr }.
 *  P3-3 gate fix (round 2): the structural end-of-session invariant canary
 *  (RO_INVARIANT_CANARY_SQL) is appended to EVERY run, not just doctored ones — this is
 *  what makes it load-bearing for a disarm shape neither this list nor a future one names. */
function runReadOnlySql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'o2p3-ro-'))
  const file = join(dir, 'probe.sql')
  try {
    writeFileSync(file, `BEGIN READ ONLY;\n${sql}\n${RO_INVARIANT_CANARY_SQL}\nCOMMIT;\n`, 'utf8')
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

/** Scalar query against the real DB (armed lane only). Returns the trimmed single value, or
 *  null when psql itself failed — callers must treat null as "could not measure", never as 0. */
function scalar(sql) {
  const r = spawnSync('psql', [DATABASE_URL, '-Atqc', sql], { encoding: 'utf8', timeout: 20000 })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

/** Residue fingerprint: artefacts a doctored write-probe would leave if a guard ever regressed.
 *  Round-5 gate NIT-2: until now the "zero residue" claim was measured BY HAND, outside CI — and
 *  the gate's own double-quote-erasure shape produced 21 large objects while the suite stayed
 *  green. Measuring it INSIDE the suite is what makes the claim load-bearing rather than a
 *  hand-checked anecdote (被触发≠被验证). */
function residueFingerprint() {
  return {
    largeObjects: scalar('SELECT count(*) FROM pg_largeobject_metadata'),
    // Round-6 gate P3-2: the first version counted only tables whose NAME began `o2_`, which is a
    // guess about what a future leak will be called. The gate planted an `o2_`-prefixed SEQUENCE,
    // a ROLE, and a plain non-`o2_` TABLE and all three survived an armed run — and the suite's own
    // `SELECT … INTO` probe creates `ro_evasion_probe_tbl_o2p3`, which that prefix never matched
    // either. Count every relation by kind with NO name filter instead: a leak cannot dodge this by
    // being named something the author did not anticipate (枚举陷阱不收敛, applied to my own guard).
    // `pg_roles` is cluster-scoped rather than database-scoped, so it is measured separately.
    relations: scalar(
      "SELECT relkind::text || ':' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace" +
        " WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')" +
        ' GROUP BY relkind ORDER BY relkind',
    ),
    roles: scalar('SELECT count(*) FROM pg_roles'),
    // ABSOLUTE leg. The relkind/roles legs above are BASELINE-RELATIVE, which means residue that
    // already existed when the run started is baselined IN — the final gate demonstrated a table,
    // sequence, role and view created BEFORE a run and all four armed runs stayed green. Harmless
    // on CI's fresh service database, but on a reused local database the leftovers of an earlier
    // FAILED run would be silently accepted, which is precisely the state in which you most want
    // this check to speak. Keeping one absolute assertion restores the leg the widening removed:
    // no probe-shaped relation may exist at all, at baseline or at the end.
    probeShaped: scalar(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace" +
        " WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')" +
        " AND (c.relname LIKE 'o2\\_%' ESCAPE '\\' OR c.relname LIKE 'ro\\_evasion\\_probe\\_%' ESCAPE '\\')",
    ),
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

// Hermetic pin (runs with NO DATABASE_URL too — no `if (canRunExecutionLayer)` guard): a
// regression here (someone weakening or deleting the canary body) would silently disable
// the P3-3 structural guard even in a lane where the real execution-layer job still runs
// green, because the canary's absence would just mean nothing extra failed. Pinning the
// literal source text catches that class of regression on every trigger, not only when a
// real Postgres happens to be reachable.
test('EXECUTION-LAYER invariant canary: RO_INVARIANT_CANARY_SQL contains the required end-of-session read-only checks (hermetic pin)', () => {
  assert.match(RO_INVARIANT_CANARY_SQL, /current_setting\('default_transaction_read_only'\)/)
  assert.match(RO_INVARIANT_CANARY_SQL, /current_setting\('transaction_read_only'\)/)
  assert.match(RO_INVARIANT_CANARY_SQL, /O2_RO_GUARD_DISARMED/)
  assert.match(RO_INVARIANT_CANARY_SQL, /CREATE TEMP TABLE/i)
  assert.match(RO_INVARIANT_CANARY_SQL, /WHEN read_only_sql_transaction/i)
})

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
          // executionMode 'not-blocked': the read-only session is not this shape's guard — the
          // STATIC CENSUS is. Whether the server also happens to refuse it is VERSION-DEPENDENT
          // and must not be pinned: `lo_create`/`lo_from_bytea` run fine under
          // `default_transaction_read_only = on` on PostgreSQL 15 (verified locally, 15.17) but
          // are refused on the CI service image (postgres:16) — an earlier version of this branch
          // asserted `status === 0` outright and went RED in CI for a reason that had nothing to
          // do with the guard being wrong (运行器≠生产版本).
          //
          // So assert the two things that ARE version-independent, and record which branch the
          // server took rather than demanding one:
          //   1. the static census catches the shape (this is the actual guard, unconditional);
          //   2. IF the server refused it, the refusal must be a real read-only refusal — not some
          //      unrelated failure being mistaken for protection.
          assert.ok(
            findUnsafeConstructs(doctored).length > 0,
            'static census must catch this shape — the execution layer is not its guard on any server version',
          )
          if (result.status !== 0) {
            assert.match(
              result.stderr,
              /in a read-only transaction|permission denied|must be superuser|not permitted/i,
              `"${shape.name}" was refused by the server, which is allowed (newer PostgreSQL refuses some of these) — but the refusal must be a real read-only/permission refusal, not an unrelated failure being mistaken for protection; got exit ${result.status}, stderr:\n${result.stderr}`,
            )
          }
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

  // P3-3 gate fix (round 2): the load-bearing execution-layer leg for the guard-disarm
  // shape. Kept outside EVASION_SHAPES/its blocked/not-blocked/blocked-incidental
  // taxonomy — see SET_CONFIG_DISARM_SHAPE's comment above for why this assertion is
  // categorically different (it checks the END-OF-SESSION INVARIANT via
  // RO_INVARIANT_CANARY_SQL, not this statement's own immediate effect).
  test(`EXECUTION: doctored copy with ${SET_CONFIG_DISARM_SHAPE.name} — the end-of-session invariant canary NAMES the disarm (P3-3 round-2 gate reproduction)`, () => {
    const doctored = `${sqlText}\n${SET_CONFIG_DISARM_SHAPE.fragment}\n`
    const result = runReadOnlySql(doctored)
    assert.notEqual(result.status, 0, 'expected the run to fail once the end-of-session invariant canary detects the disarm')
    assert.match(
      result.stderr,
      /O2_RO_GUARD_DISARMED/,
      `expected the failure to NAME the invariant violation explicitly (not a collateral probe failure elsewhere in the file); got exit ${result.status}, stderr:\n${result.stderr}`,
    )
    // The specific text must be the GUC-state branch — the ONLY one of the canary's three
    // legs still reachable under the round-3 `BEGIN READ ONLY` wrap for this shape (see
    // the ROUND-3 IMPACT note on RO_INVARIANT_CANARY_SQL above): the write-succeeded
    // branch (leg 2) can no longer fire at all under the wrap, for any shape, so this is
    // not "the branch that happens to fire first" among live alternatives — it is the
    // only leg left standing for a disarm that does not itself attempt a write.
    assert.match(
      result.stderr,
      /default_transaction_read_only=off at end of session/i,
      'expected the canary to report the actual disarmed GUC state',
    )
  })

  // P3-2 gate fix (round 3): the load-bearing execution-layer leg for the BOUNDED
  // disarm-then-restore class — see BOUNDED_DISARM_WRITE_SHAPE's comment and
  // runReadOnlySql's own comment for why this is closed by the explicit
  // `BEGIN READ ONLY; … COMMIT;` wrap, not by the end-of-session canary (the restore
  // already ran by the time the canary would check anything, so the canary is NOT the
  // catch here — asserted below by its ABSENCE, not merely by exit status). Confirmed by
  // the gate, and re-confirmed here: identical fragment, under the OLD (unwrapped,
  // session-default-only) posture exits 0 — this test's whole point is that this run does
  // NOT.
  test(`EXECUTION: doctored copy with ${BOUNDED_DISARM_WRITE_SHAPE.name} is blocked at the WRITE itself (P3-2 round-3 gate reproduction)`, () => {
    const doctored = `${sqlText}\n${BOUNDED_DISARM_WRITE_SHAPE.fragment}\n`
    const result = runReadOnlySql(doctored)
    assert.notEqual(
      result.status,
      0,
      `expected the bounded disarm+write+restore chain to fail — the restore before session end must NOT make this shape invisible; stderr:\n${result.stderr}`,
    )
    assert.match(
      result.stderr,
      /cannot execute \S+.*in a read-only transaction/i,
      `expected the WRITE line itself to be refused (SQLSTATE 25006 family) by the explicit read-only transaction wrap — NOT the end-of-session canary (the restore ran first, so the canary would stay silent); got exit ${result.status}, stderr:\n${result.stderr}`,
    )
    assert.doesNotMatch(
      result.stderr,
      /O2_RO_GUARD_DISARMED/,
      'this must be caught by the transaction wrap itself, at the write, not by the end-of-session canary — a canary-named failure here would mean the restore silently defeated the earlier check and only the (session-scoped) GUC state saved this test, contrary to the fix being verified',
    )
  })
}

// ---------------------------------------------------------------------------
// RESIDUE ASSERTION (armed lane only) — round-5 gate NIT-2.
// The execution-layer probes deliberately EXECUTE doctored SQL against a real database. If a
// static guard ever regresses, a write shape reaches the server and leaves artefacts behind.
// Until now that was checked by hand after the run; the gate demonstrated a shape that left 21
// large objects while every test stayed green. This test measures the fingerprint at the END of
// the armed run and fails on ANY increase, so the "no residue" property is asserted by the suite
// rather than asserted by a human afterwards.
//
// Baseline is captured EAGERLY at module load, before any test body runs, and compared here.
// (Round-6 gate NIT-2: an earlier version of this comment claimed lazy capture — the code never
// did that. A comment describing something not built is the same defect class this file exists to
// catch, so it is corrected rather than left as prose that reads plausibly.) A null measurement means psql could not answer — that
// is a FAILURE, never a silent pass (fail-toward-flagging), because "could not measure" and
// "measured zero" must not look alike.
if (canRunExecutionLayer) {
  test('EXECUTION: the armed run leaves NO residue behind — large objects and o2_* probe tables are back at their pre-run counts (round-5 gate NIT-2: this was a hand-check outside CI until now)', () => {
  const after = residueFingerprint()
  assert.notEqual(after.largeObjects, null, 'could not measure pg_largeobject_metadata — treat an unmeasurable residue check as a failure, not a pass')
  assert.notEqual(after.relations, null, 'could not measure pg_class — treat an unmeasurable residue check as a failure, not a pass')
  assert.notEqual(after.roles, null, 'could not measure pg_roles — treat an unmeasurable residue check as a failure, not a pass')
  assert.equal(
    after.relations,
    RESIDUE_BASELINE.relations,
    `a relation survived the armed run (per-relkind counts moved: ${RESIDUE_BASELINE.relations} -> ${after.relations}) — a write shape reached the server, meaning a static guard regressed`,
  )
  assert.notEqual(after.probeShaped, null, 'could not measure probe-shaped relations — treat an unmeasurable residue check as a failure, not a pass')
  assert.equal(
    after.probeShaped,
    '0',
    `a probe-shaped relation exists after the armed run (count = ${after.probeShaped}) — ABSOLUTE leg: unlike the baseline-relative counts, this one also catches residue that was already present when the run started (e.g. left by an earlier failed run on a reused database)`,
  )
  assert.equal(
    after.roles,
    RESIDUE_BASELINE.roles,
    `pg_roles moved during the armed run (${RESIDUE_BASELINE.roles} -> ${after.roles}) — a cluster-scoped write reached the server`,
  )
  assert.equal(
    after.largeObjects,
    String(RESIDUE_BASELINE.largeObjects),
    `large-object count moved during the armed run (${RESIDUE_BASELINE.largeObjects} -> ${after.largeObjects}) — the lo_* family reached the server`,
  )
  })
}
