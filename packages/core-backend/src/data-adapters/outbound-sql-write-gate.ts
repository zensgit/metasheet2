// W-1(c) DEFAULT-DENY AUTHORIZATION GATE for GENERIC OUTBOUND SQL WRITE.
//
// OWNER RULING (2026-08-29), applied to the second lane. Generic outbound SQL write is a capability
// that must be EXPLICITLY AUTHORIZED per deployment. `INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS`
// UNSET => DENY. Reads, lists, schema fetches and health probes are byte-identical to a deployment
// that never heard of this module.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL — FOUR ROUNDS OF EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────
//
// The generic HTTP write lane was closed this way in `outbound-http-write-gate.cjs` (#5314). The SQL
// lane was, until now, governed instead by a DESTINATION SNIFFER: parse the statement for K3 table
// names, probe the catalog for K3 tables, refuse if it "looks like" K3. Four rounds of adversarial
// verification defeated that approach with ordinary single-connection T-SQL:
//
//   * `UPDATE t SET … FROM t_ICItem AS t` — the real target is in FROM; the extractor grabs the alias.
//   * `UPDATE TOP (5) t_ICItem`           — TOP sits between verb and table.
//   * `INSERT INTO srv.AIS.dbo.t_ICItem`  — a 4-part linked-server name the extractor never parsed.
//   * `WITH c AS (SELECT …) DELETE …`     — a data-modifying CTE that led with a "read" keyword.
//
// That is not a series of bugs; it is the shape of the problem. Sniffing the destination is EXACTLY
// the option the owner already REJECTED on 2026-08-29 (W-1: judging "whether the target is a K3
// endpoint" is "brittle, defeatable by a proxy hop / IP literal — worse than none"). The ruling was
// (c): gate the CAPABILITY. This module is that ruling applied to SQL.
//
// The consequence worth stating plainly, because it is the whole point: THERE IS NOTHING LEFT TO
// LAUNDER PAST. The gate never asks what table or what server a statement names. A write is a write,
// off by default. A 4-part linked-server INSERT, a CTE-wrapped DELETE, an aliased UPDATE…FROM and a
// plain `INSERT INTO staging` are all the same question — "is this source armed for SQL write?" —
// and the answer is no unless a deployment file says yes.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT G-4. READ THIS BEFORE CHANGING ANYTHING HERE.
// ─────────────────────────────────────────────────────────────────────────────
//
// `k3-external-write-permanent-fence.cjs` is a PERMANENT BAN (E4 / G-4, HG v1.2 §10.1): K3
// Save/Submit/Audit is unreachable, NO runtime switch is reserved, and re-enabling it requires a
// superseding ADR plus its own Gate. That module is deliberately PARAMETERLESS AND ENV-FREE, because
// any env read would be the re-enable surface §10.1 forbids.
//
// This module is the OPPOSITE KIND OF OBJECT and says so out loud: it is an AUTHORIZATION GATE, so it
// IS env-configurable BY DESIGN. Its posture is "closed until a deployment opens it for named
// sources", not "closed forever". Reading an env var here is the mechanism, not a leak in it.
//
// The two must not be confused in either direction:
//   * Nothing in this file can ever unlock K3. The K3 by-kind fences refuse `erp:k3-wise-webapi` and
//     `erp:k3-wise-sqlserver` at four layers each regardless of what any allowlist says. An operator
//     who writes a K3-shaped entry into this allowlist has authorized NOTHING about those kinds.
//   * Nothing in the K3 fences covers a GENERIC `sqlserver` data source. That is exactly the hole
//     this file closes: the fences key on connector KIND, and a generic SQL source whose connection
//     happens to point at (or link to) a K3 database was, before this file, an ungoverned write.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARMING SEMANTICS — DENY IS THE DEFAULT
// ─────────────────────────────────────────────────────────────────────────────
//
//   ENV UNSET  ->  every generic SQL WRITE is REFUSED with the fixed code
//                  `OUTBOUND_SQL_WRITE_DISABLED`. Reads are untouched.
//
//   ENV SET    ->  the named server-side JSON file enumerates the sources that MAY be written, by
//                  DECLARED IDENTITY (data source id / name / type), never by host, server, database
//                  or connection string. A source the file does not name is refused with the DISTINCT
//                  code `OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED`, so an operator can tell "the gate
//                  is shut" from "the gate is open and your source is not on the list".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ENV IS READ HERE AND NOT THREADED IN
// ─────────────────────────────────────────────────────────────────────────────
//
// `new MSSQLAdapter(config)` takes no policy context. Threading an allowlist in as a constructor dep
// or a factory default would make the allowlist an ARGUMENT — and an argument is an unlock surface.
// ANY in-process caller (a script, a scheduler, a route that builds its own adapter, a test) could
// then hand itself an allowlist and write anywhere.
//
// So the gate reads `process.env` ITSELF, from a LEAF module with ZERO intra-package imports (only
// `node:fs`), and every public function is PARAMETERLESS with respect to configuration: the caller
// supplies the SUBJECT of the decision (which source, which operation) and never the POLICY.
//
// FILE-LOADING POSTURE, borrowed verbatim from the HTTP gate:
//   * unset / blank  -> not configured (DENY)
//   * unreadable     -> THROW, naming the ENV KEY, NEVER echoing the path
//   * not JSON       -> THROW, same shape
//   * not an object  -> THROW, same shape
// A typo in the path must never be indistinguishable from a valid configuration.
//
// NO CACHING, ON PURPOSE. The file is re-read on every write authorization, so a REVOKED entry stops
// working immediately rather than at the next process restart. The DEFAULT path costs nothing: an
// unset env var short-circuits before any file I/O.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY MATCHING, NOT DESTINATION MATCHING
// ─────────────────────────────────────────────────────────────────────────────
//
// An entry names the source's DECLARED IDENTITY: `systemId` (required), plus optional `systemName`
// and `kind` (the data source `type`, e.g. `sqlserver`) which must AGREE when present. It may NOT
// name a host, server, database, port, connection string or credential — `FORBIDDEN_TARGET_KEYS`
// refuses those AT LOAD, and the refusal states the RULE rather than saying "unsupported key".
//
// That is the ruling restated in code, and it is the same reason URL matching was rejected for HTTP:
// a destination is not an identity. It changes under a proxy, a CNAME, an IP literal, an alias, a
// linked server or a synonym. A data source id is a config-authored binding a human wrote and a human
// reviews.
//
// NO WILDCARDS. `'*'` is refused at load in every string position.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WRITE/READ SPLIT IS THE ONLY CLASSIFICATION — AND IT IS COARSE AND FAIL-CLOSED
// ─────────────────────────────────────────────────────────────────────────────
//
// The gate asks ONE question of a statement: is it PROVABLY a pure read? If not, it is a WRITE and
// needs authorization. It never asks what the statement writes TO.
//
// Provably-a-pure-read means ALL of: the noise scan CLOSED every span it opened, a single statement
// (no `;` separator), no `INTO`, a leading SELECT / WITH / EXPLAIN / SHOW, and every RESERVED keyword
// in the SELECT read grammar. Everything else is a WRITE.
//
// A LEADING `WITH` IS ADMITTED ONLY BECAUSE THE READ-GRAMMAR ALLOWLIST DECIDES THE TERMINAL VERB. SQL
// Server allows a CTE to precede a data-modifying statement (`WITH c AS (SELECT …) DELETE …`), and
// proving a given CTE terminates in a SELECT by PARSING is the unbounded game this module exists to
// retire. It is not parsed: a CTE that hides a write carries a reserved non-read keyword (DELETE,
// UPDATE, INSERT, MERGE …) and fails the allowlist, so the verdict falls out without a parser.
//
// AN UNTERMINATED SPAN IS A WRITE (FIX 5). If the scan reaches end-of-input still inside a string
// literal, a block comment, or a bracketed / quoted identifier, the rest of the statement was consumed
// as literal content and NOTHING about it was proved — including whether a write verb is sitting in
// there. Unprovable is a WRITE, exactly as this section's first sentence says.
//
// ─────────────────────────────────────────────────────────────────────────────
// OBJECT SCOPE IS DELIBERATELY NOT OFFERED — AND WHY
// ─────────────────────────────────────────────────────────────────────────────
//
// The HTTP gate scopes an entry to named objects because an `upsert` knows its object. A SQL write
// does not: every write on this lane is ultimately a STATEMENT executed at the adapter, and naming
// the object it touches would require parsing the statement — the exact thing the ruling retires. So
// an entry authorizes a SOURCE for SQL write, and `allObjects: true` must be stated EXPLICITLY; an
// `objects` enumeration is refused at load with a message that explains this rather than silently
// never matching. The scope is coarse on purpose, and it is visible in the file.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALUES-FREE
// ─────────────────────────────────────────────────────────────────────────────
//
// A refusal carries: a FIXED code, a coarse reason token, `systemId`, `operation`, the allowlist
// id/version when one loaded, the matched entry id, and BOOLEANS/COUNTS.
//
// It NEVER carries: the SQL statement or any fragment of it, a table name, a host, server, database,
// port, connection string, credential, bound parameter, row value, file path, or any raw error
// message from the file system or JSON parser. `systemId` is a deployment/config-authored identifier
// — the thing an operator must add to the allowlist file to fix a refusal — not customer data.

import fs from 'node:fs'

// The single env var. Named for the CAPABILITY (generic outbound sql write), not for a consumer: a
// second consumer of this gate arrives as a new entry in the same file, not a new env var.
export const OUTBOUND_SQL_WRITE_TARGETS_ENV = 'INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS'

// ─── FIXED ERROR CODES ───────────────────────────────────────────────────────
// Frozen vocabulary. Fixed strings, never derived, never formatted from input, identical at every
// layer so a caller cannot probe WHICH layer caught them and work inward.

// The env var is unset/blank: the capability is off for this deployment.
export const OUTBOUND_SQL_WRITE_DISABLED = 'OUTBOUND_SQL_WRITE_DISABLED'
// The capability is on, but this source/operation is not on the list. DISTINCT on purpose —
// collapsing them would leave an operator unable to tell a shut gate from a missing entry.
export const OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED = 'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED'
// The deployment configured something the gate cannot honour. A broken DEPLOYMENT, not a refused
// caller, so it carries its own code and a 500 — and it still DENIES, never falls through to allow.
export const OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID = 'OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID'

export const OUTBOUND_SQL_WRITE_ERROR_CODES = Object.freeze([
  OUTBOUND_SQL_WRITE_DISABLED,
  OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
])

// 403, not 422: a refused caller cannot fix this by editing their request. 500 for the load fault.
export const OUTBOUND_SQL_WRITE_REFUSAL_STATUS = 403
export const OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS = 500

export const OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [OUTBOUND_SQL_WRITE_DISABLED]:
    'generic outbound SQL write is disabled; it must be authorized by the server-side outbound SQL write target file',
  [OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED]:
    'this data source is not authorized for generic outbound SQL write',
  [OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID]:
    'the server-side outbound SQL write target file is not usable; generic outbound SQL write stays refused',
})

// ─── THE CLOSED OPERATION VOCABULARY ─────────────────────────────────────────
//
// There is exactly ONE generic SQL write entry point: a STATEMENT executed at the adapter. Structured
// `insert`/`update`/`delete` all build a statement and run it through the same funnel, so they are the
// same operation — modelling them separately would invite an entry that arms `insert` while the same
// bytes flow through as a statement anyway.
//
// AN UNKNOWN OPERATION DEFAULT-REFUSES: a new write path that has not been inventoried presents an
// operation outside this list and is refused rather than inheriting an existing entry. Adding a write
// path therefore requires a visible edit to this list.
export const OUTBOUND_SQL_WRITE_OPERATION_STATEMENT = 'statement'

export const OUTBOUND_SQL_WRITE_OPERATIONS = Object.freeze([
  OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
])

// ─── THE WRITE/READ SPLIT ────────────────────────────────────────────────────

// Noise stripped before classification so a table name, keyword or separator that appears only inside
// a comment, a string literal or a QUOTED IDENTIFIER cannot change the verdict. Stripping quoted and
// bracketed identifiers is what keeps a legitimate read of a column named `[delete]` from being
// misclassified as a write, while a real `DELETE FROM …` is still seen.
//
// FIX 1 — WHY THIS IS A SINGLE-PASS TOKENIZER AND NOT FIVE INDEPENDENT REGEXES.
//
// The previous strip applied a block-comment regex, a line-comment regex and a string-literal regex
// INDEPENDENTLY and IN THAT ORDER. That is unsound, because a comment and a string are MUTUALLY
// EXCLUSIVE contexts that a left-to-right lexer must resolve in one pass: a `/*` that is STRING CONTENT
// must not open a comment, and a `'` that is COMMENT CONTENT must not open a string. Running the
// block-comment regex first, blind to strings, let a `/*` inside one string literal pair with a `*/`
// inside a LATER string literal and delete everything between them — including a real statement:
//
//     SELECT '/*'
//     UPDATE t_ICItem SET FQty=0     ← deleted as if it were comment body
//     SELECT '*/'
//
// stripped to `SELECT '' … SELECT ''`, classified a pure READ, and the UPDATE skipped the gate. You
// cannot strip SQL comments and strings with separate regexes; the contexts interleave. So this scans
// the text ONCE, and whichever opener it meets first (`'`, `--`, `/*`, `[`, `"`) owns the span until
// its own matching close — anything else inside that span is literal content. Replacements match the
// old placeholders (a string → ` '' `, an identifier → ` x `, a comment → ` `) so the downstream
// classifier is unchanged; only the CONTEXT boundaries are now correct.
//
// SQL Server semantics honoured in the one pass: `''` is an embedded quote inside a string; `]]` an
// embedded bracket inside a `[…]` identifier; `""` an embedded quote inside a `"…"` identifier; and
// block comments NEST (`/* a /* b */ c */`), so a nested close must not end the outer comment early.
//
// FIX 5 — AN UNTERMINATED SPAN IS REPORTED, NOT SWALLOWED SILENTLY.
//
// An earlier note here claimed that consuming an unterminated string/comment to end-of-input was
// "fail-safe, because an unterminated string is a T-SQL syntax error the driver rejects anyway". That
// reasoning is about the DRIVER, not about this classifier, and this classifier's contract is
// "anything not PROVABLY a single pure read is a write". A span with no closer is exactly the case
// where the scan proved nothing: everything after the opener was consumed as literal content, so a
// write verb sitting there is invisible to the read-grammar allowlist. Executed proof — before this
// fix, ALL of these classified as PURE READS:
//
//     SELECT N'unterminated /*                  → stripped to `SELECT N ''`
//     SELECT 1 /* unclosed comment              → stripped to `SELECT 1 `
//     SELECT '''                                → `''` is an ESCAPE, so the third quote opens a span
//     SELECT 'x⏎DELETE FROM t_ICItem            → the DELETE eaten as string body
//     SELECT * FROM [t⏎DELETE FROM t_ICItem     → the DELETE eaten as identifier body
//
// The real-world impact is low (an unclosed quote/comment is a syntax error the driver rejects, so
// nothing executes), but a classifier that answers TRUE on input it could not tokenize is fail-OPEN
// by construction, and this module's top guarantee is fail-closed. So the scan now REPORTS whether it
// ended inside an unclosed span and the caller treats that as "not provably a read" ⇒ a WRITE.
//
// This covers ALL FOUR closable spans — string literal, block comment, bracketed identifier, quoted
// identifier — because the swallow-to-end-of-input shape, and therefore the hole, is identical in each.
// A LINE comment is deliberately NOT in that set: `--` is terminated by end-of-line OR end-of-input,
// so `SELECT 1 -- note` with no trailing newline is well-formed and stays a READ.
//
// Still ONE left-to-right pass: `unterminated` is a flag set where each span's loop already discovers
// it ran out of input, not a second scan.
interface SqlNoiseScan {
  /** The statement with comments / literals / quoted identifiers replaced by placeholders. */
  readonly cleaned: string
  /** True when the scan hit end-of-input still INSIDE a string, block comment or quoted identifier. */
  readonly unterminated: boolean
}

function scanSqlNoise(sql: string): SqlNoiseScan {
  const src = String(sql ?? '')
  const n = src.length
  let out = ''
  let i = 0
  let unterminated = false
  while (i < n) {
    const ch = src[i]
    const next = i + 1 < n ? src[i + 1] : ''

    // Line comment: -- … to end of line. End-of-input is a LEGAL end for it, so it never sets the flag.
    if (ch === '-' && next === '-') {
      i += 2
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1
      out += ' '
      continue
    }

    // Block comment: /* … */, NESTING (SQL Server allows nested block comments).
    if (ch === '/' && next === '*') {
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        if (src[i] === '/' && i + 1 < n && src[i + 1] === '*') { depth += 1; i += 2; continue }
        if (src[i] === '*' && i + 1 < n && src[i + 1] === '/') { depth -= 1; i += 2; continue }
        i += 1
      }
      if (depth > 0) unterminated = true // ran out of input with the comment still open
      out += ' '
      continue
    }

    // String literal: '…', where '' is an embedded quote (stays in-string).
    if (ch === "'") {
      i += 1
      let closed = false
      while (i < n) {
        if (src[i] === "'") {
          if (i + 1 < n && src[i + 1] === "'") { i += 2; continue } // escaped ''
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) unterminated = true
      out += " '' "
      continue
    }

    // Bracketed identifier: […], where ]] is an embedded ] (stays in-identifier).
    if (ch === '[') {
      i += 1
      let closed = false
      while (i < n) {
        if (src[i] === ']') {
          if (i + 1 < n && src[i + 1] === ']') { i += 2; continue } // escaped ]]
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) unterminated = true
      out += ' x '
      continue
    }

    // Quoted identifier: "…", where "" is an embedded " (stays in-identifier).
    if (ch === '"') {
      i += 1
      let closed = false
      while (i < n) {
        if (src[i] === '"') {
          if (i + 1 < n && src[i + 1] === '"') { i += 2; continue } // escaped ""
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) unterminated = true
      out += ' x '
      continue
    }

    out += ch
    i += 1
  }
  return { cleaned: out, unterminated }
}

// ─── THE READ GRAMMAR IS AN ALLOWLIST, NOT A WRITE BLOCKLIST ──────────────────
//
// An earlier version asked "does the statement contain a write verb from a list?" — a BLOCKLIST, and
// an incomplete one: WRITETEXT / UPDATETEXT / BACKUP / RESTORE / DBCC / RECONFIGURE / CHECKPOINT /
// KILL / RECEIVE / WAITFOR were not on it, so `SELECT 1\nWRITETEXT t.c @p 0x41` classified as a READ
// and skipped the gate. The module CLAIMS "anything not provably a single pure read is a write", so
// it must be an ALLOWLIST: a statement is a read only if EVERY keyword in it is a SELECT-grammar
// keyword. Any keyword outside the read grammar — including one nobody enumerated — makes it a write.
//
// HOW A "KEYWORD" IS TOLD FROM AN IDENTIFIER, without a parser: after stripping comments, string
// literals and BRACKETED / "quoted" identifiers, any bare word that is a T-SQL RESERVED KEYWORD is a
// real keyword — because SQL Server REQUIRES a reserved word used as an identifier to be bracketed
// (`SELECT [backup] FROM t`), and brackets are stripped to a placeholder. So a bare `BACKUP` is the
// command, never a column. A bare word that is NOT reserved is an identifier/function and is fine.
// The verdict is therefore: a bare word that is RESERVED and NOT in the read-grammar allowlist ⇒ the
// statement is a WRITE. RESERVED is the full, stable T-SQL reserved-word universe below, so an
// unrecognised reserved command (WRITETEXT, DBCC, …) fails closed by construction.

// The SELECT read grammar. WIDENING this to cover a real read is always safe; it may never gain a
// keyword that can execute or mutate. Lower-cased for a case-insensitive lookup.
const SQL_READ_GRAMMAR = new Set<string>([
  // statement heads that are reads
  'select', 'with', 'explain', 'show',
  // projection / set quantifiers
  'all', 'distinct', 'top', 'percent', 'ties', 'as',
  // sources & joins
  'from', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'apply', 'on', 'pivot', 'unpivot',
  'tablesample', 'nolock', 'readpast', 'rowlock', 'holdlock', 'readcommitted', 'readuncommitted',
  'repeatableread', 'serializable', 'snapshot', 'index', 'forceseek', 'forcescan', 'spatial_window_max_cells',
  // predicates & boolean
  'where', 'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'is', 'null', 'some', 'any', 'escape',
  'contains', 'freetext', 'containstable', 'freetexttable',
  // grouping / ordering / paging
  'group', 'by', 'having', 'order', 'asc', 'desc', 'grouping', 'sets', 'rollup', 'cube',
  'offset', 'fetch', 'first', 'next', 'row', 'rows', 'only',
  // set ops
  'union', 'intersect', 'except',
  // expressions / windowing / conditionals
  'case', 'when', 'then', 'else', 'end', 'over', 'partition', 'range', 'unbounded', 'preceding', 'following',
  'current', 'cast', 'convert', 'try_convert', 'try_cast', 'coalesce', 'nullif', 'iif', 'choose', 'collate',
  'within', 'filter', 'at', 'time', 'zone',
  // read-only helpers / hints / output shaping that never mutate
  'option', 'recompile', 'optimize', 'for', 'xml', 'json', 'path', 'auto', 'raw', 'elements',
  'values', 'default', 'user', 'session_user', 'system_user', 'current_user', 'current_timestamp',
  'current_date', 'current_time', 'datefirst', 'language',
  // FIX 4 (P2 over-block): the read-only global variables `@@ROWCOUNT` / `@@IDENTITY` tokenize to the
  // bare reserved words `rowcount` / `identity`, so a plain `SELECT @@ROWCOUNT` was misclassified a
  // WRITE. Admitting them is a SAFE widening — they cannot execute or mutate. It cannot under-block: a
  // statement flips to READ only if its ONLY non-read reserved token is one of these AND it leads with
  // a read verb with no `;`/`INTO`; any mutating use of these words (`SET ROWCOUNT`, `SET
  // IDENTITY_INSERT`, `… IDENTITY` in DDL or `SELECT … IDENTITY(…) INTO`) carries an OTHER non-read
  // reserved token (`set`/`create`/`alter`) or the blocked `into`, so no write can slip through. NOTE:
  // `FOR UPDATE` deliberately stays a WRITE — admitting it would mean admitting the primary write verb
  // `update`, and it is not valid pure-read T-SQL anyway.
  'rowcount', 'identity',
])

// The full T-SQL RESERVED keyword universe. A bare word here that is NOT in SQL_READ_GRAMMAR proves
// the statement is not a pure read. Includes every write/DDL/DCL/admin/cursor/control-flow keyword,
// so the classifier fails closed on any of them — the P0 bypass verbs among them.
const SQL_RESERVED_KEYWORDS = new Set<string>([
  'add', 'all', 'alter', 'and', 'any', 'as', 'asc', 'authorization', 'backup', 'begin', 'between',
  'break', 'browse', 'bulk', 'by', 'cascade', 'case', 'check', 'checkpoint', 'close', 'clustered',
  'coalesce', 'collate', 'column', 'commit', 'compute', 'constraint', 'contains', 'containstable',
  'continue', 'convert', 'create', 'cross', 'current', 'current_date', 'current_time',
  'current_timestamp', 'current_user', 'cursor', 'database', 'dbcc', 'deallocate', 'declare',
  'default', 'delete', 'deny', 'desc', 'disk', 'distinct', 'distributed', 'double', 'drop', 'dump',
  'else', 'end', 'errlvl', 'escape', 'except', 'exec', 'execute', 'exists', 'exit', 'external',
  'fetch', 'file', 'fillfactor', 'for', 'foreign', 'freetext', 'freetexttable', 'from', 'full',
  'function', 'goto', 'grant', 'group', 'having', 'holdlock', 'identity', 'identity_insert',
  'identitycol', 'if', 'in', 'index', 'inner', 'insert', 'intersect', 'into', 'is', 'join', 'key',
  'kill', 'left', 'like', 'lineno', 'load', 'merge', 'national', 'nocheck', 'nonclustered', 'not',
  'null', 'nullif', 'of', 'off', 'offsets', 'on', 'open', 'opendatasource', 'openquery', 'openrowset',
  'openxml', 'option', 'or', 'order', 'outer', 'over', 'percent', 'pivot', 'plan', 'precision',
  'primary', 'print', 'proc', 'procedure', 'public', 'raiserror', 'read', 'readtext', 'reconfigure',
  'references', 'replication', 'restore', 'restrict', 'return', 'revert', 'revoke', 'right',
  'rollback', 'rowcount', 'rowguidcol', 'rule', 'save', 'schema', 'securityaudit', 'select',
  'semantickeyphrasetable', 'semanticsimilaritydetailstable', 'semanticsimilaritytable',
  'session_user', 'set', 'setuser', 'shutdown', 'some', 'statistics', 'system_user', 'table',
  'tablesample', 'textsize', 'then', 'to', 'top', 'tran', 'transaction', 'trigger', 'truncate',
  'try_convert', 'tsequal', 'union', 'unique', 'unpivot', 'update', 'updatetext', 'use', 'user',
  'values', 'varying', 'view', 'waitfor', 'when', 'where', 'while', 'with', 'writetext',
  // Service Broker / newer reserved commands the P0 list names explicitly:
  'receive', 'send', 'get', 'conversation', 'begin_dialog',
])

const SQL_WORD_TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g

/**
 * PROVABLY a pure read? ALL of, after stripping comments / string literals / bracketed & quoted
 * identifiers:
 *   (0) the scan TERMINATED every span it opened (FIX 5 — see `scanSqlNoise`);
 *   (a) a SINGLE statement (no `;` separator);
 *   (b) no `INTO` (a `SELECT … INTO` writes a table);
 *   (c) it LEADS with SELECT / WITH / EXPLAIN / SHOW; and
 *   (d) every RESERVED keyword it contains is in the SELECT read grammar.
 *
 * (0) is a prerequisite for (a)–(d) rather than another rule: if a string / block comment / quoted
 * identifier never closed, the scan consumed the rest of the statement as literal content, so the
 * checks below would be asking their questions of a TRUNCATED statement. Nothing is provable there,
 * and unprovable means WRITE.
 *
 * (d) is the whole point. It is an ALLOWLIST: any reserved keyword outside the read grammar — a write
 * verb, a DDL/DCL/admin command, WRITETEXT/UPDATETEXT/BACKUP/DBCC/RECONFIGURE/CHECKPOINT/KILL/RECEIVE/
 * WAITFOR, or one nobody enumerated — makes the statement a write. This also subsumes the old special
 * cases: OPENQUERY/OPENROWSET/OPENDATASOURCE are reserved and not read-grammar, and an unterminated
 * `SELECT 1\nDELETE …` batch carries a reserved write verb. A write verb that appears ONLY inside a
 * string literal or a bracketed identifier is stripped before this runs, so it stays a read.
 *
 * A leading WITH is now ADMITTED, because (d) verifies the CTE terminates in a read: a CTE that hides
 * a write (`WITH c AS (…) DELETE …`) carries DELETE (reserved, non-read) and fails (d). Proving the
 * terminal verb is no longer a bespoke parse — it falls out of the allowlist.
 */
export function isPureReadStatement(sql: string): boolean {
  const raw = String(sql ?? '').trim().replace(/;\s*$/, '') // drop a single trailing semicolon
  if (raw.length === 0) return false // nothing to allow
  const scan = scanSqlNoise(raw)
  // (0) FIX 5: an unclosed string / block comment / quoted identifier swallowed the rest of the input,
  // so nothing below is being asked of the whole statement. Not provable ⇒ a WRITE.
  if (scan.unterminated) return false
  const cleaned = scan.cleaned
  if (cleaned.includes(';')) return false // an explicit separator — a batch could smuggle a write
  if (/\binto\b/i.test(cleaned)) return false // reject SELECT … INTO (a write)
  if (!/^\s*(select|with|explain|show)\b/i.test(cleaned)) return false // must LEAD with a read verb
  // (d) FAIL-CLOSED ALLOWLIST: every reserved keyword must belong to the read grammar.
  const tokens = cleaned.match(SQL_WORD_TOKEN)
  if (tokens) {
    for (const token of tokens) {
      const word = token.toLowerCase()
      if (SQL_RESERVED_KEYWORDS.has(word) && !SQL_READ_GRAMMAR.has(word)) return false
    }
  }
  return true
}

/** Anything not provably a pure read is a WRITE and requires authorization. */
export function isSqlWriteStatement(sql: string): boolean {
  return !isPureReadStatement(sql)
}

// ─── ALLOWLIST FILE SHAPE ────────────────────────────────────────────────────

const ALLOWLIST_KEYS = Object.freeze(['allowlistId', 'allowlistVersion', 'targets'])
const TARGET_KEYS = Object.freeze([
  'entryId',
  'systemId',
  'systemName',
  'kind',
  'allObjects',
  'operations',
])

// Key names that would turn this into DESTINATION matching, or smuggle a credential into a reviewed
// file. Refused at load BY NAME so the error states the rule instead of inviting a hunt for the
// supported spelling of a control that deliberately does not exist.
const FORBIDDEN_TARGET_KEYS = Object.freeze([
  'url', 'uri', 'baseUrl', 'endpoint', 'origin', 'host', 'hostname', 'server', 'address', 'ip',
  'port', 'database', 'catalog', 'instance', 'schema', 'table', 'tables', 'path',
  'connectionString', 'dsn', 'linkedServer',
  'user', 'username', 'password', 'secret', 'token', 'credential', 'credentials', 'apiKey',
])

// `objects` is refused with its own message: object scope is deliberately not offered on this lane
// (see the header), and an operator who writes one must be told why rather than watching it never
// match.
const OBJECT_SCOPE_KEYS = Object.freeze(['objects', 'object'])

// Refused in EVERY string position. A gate whose allowlist accepts `'*'` is not an allowlist.
const WILDCARD_TOKENS = Object.freeze(['*', '**', 'all', 'any'])

export class OutboundSqlWriteGateError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OutboundSqlWriteGateError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Load-time fault. Values-free: `field` is a JSON POINTER INTO THE FILE (a shape authored by this
// module's own key vocabulary), never a value read out of it and never the file's path.
function failAllowlist(message: string, details?: Record<string, unknown>): never {
  throw new OutboundSqlWriteGateError(
    OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
    OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
    message,
    details || {},
  )
}

function assertNoWildcard(value: string, field: string): string {
  if (WILDCARD_TOKENS.includes(value.toLowerCase()) || value.includes('*')) {
    failAllowlist(`${field} must name one source exactly; this gate has no wildcard`, {
      field,
      reason: 'wildcard_forbidden',
    })
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value)
  if (!parsed) failAllowlist(`${field} is required`, { field })
  return assertNoWildcard(parsed, field)
}

function optionalMatchString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, field)
}

function assertClosedKeySet(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    if (OBJECT_SCOPE_KEYS.includes(key)) {
      failAllowlist(
        `${label}.${key}: object scope is not offered on the SQL write lane — a SQL write is a statement, and naming the object it touches would require parsing it; set allObjects true to authorize this source for SQL write`,
        { field: `${label}.${key}`, reason: 'object_scope_not_supported' },
      )
    }
    if (FORBIDDEN_TARGET_KEYS.includes(key)) {
      failAllowlist(
        `${label}.${key}: an outbound SQL write target is authorized by its declared identity and never by host, server, database, connection string or credential`,
        { field: `${label}.${key}`, reason: 'identity_matching_only' },
      )
    }
    failAllowlist(`${label}.${key} is not a supported key`, { field: `${label}.${key}` })
  }
}

function requiredStringList(list: unknown, field: string): readonly string[] {
  if (!Array.isArray(list) || list.length === 0) {
    failAllowlist(`${field} must be a non-empty array`, { field })
  }
  const out: string[] = []
  for (let index = 0; index < (list as unknown[]).length; index += 1) {
    out.push(requiredString((list as unknown[])[index], `${field}[${index}]`))
  }
  if (new Set(out).size !== out.length) {
    failAllowlist(`${field} must not repeat an entry`, { field })
  }
  return Object.freeze(out)
}

interface SqlWriteTarget {
  readonly entryId: string
  readonly systemId: string
  readonly systemName: string | null
  readonly kind: string | null
  readonly allObjects: boolean
  readonly operations: readonly string[]
}

/**
 * Normalize ONE allowlist entry. Every fault is fatal at load, and a load fault DENIES.
 *
 * `allObjects: true` must be stated EXPLICITLY. Omitting it is a load error rather than an implicit
 * wildcard, so an entry never authorizes a source's whole write surface by accident — the operator
 * writes the words down and a reviewer sees them.
 */
function normalizeTarget(raw: unknown, index: number): SqlWriteTarget {
  const label = `targets[${index}]`
  if (!isPlainObject(raw)) failAllowlist(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, TARGET_KEYS, label)

  const entryId = requiredString(raw.entryId, `${label}.entryId`)
  const systemId = requiredString(raw.systemId, `${label}.systemId`)
  // Optional CORROBORATING identities. When present they must AGREE with the loaded source, so an
  // entry can be written to survive an id reuse; when absent the id alone decides. They can only ever
  // NARROW a match — there is no spelling of them that widens one.
  const systemName = optionalMatchString(raw.systemName, `${label}.systemName`)
  const kind = optionalMatchString(raw.kind, `${label}.kind`)

  if (raw.allObjects !== true) {
    failAllowlist(
      `${label} must set allObjects true to authorize this source for SQL write; the SQL lane has no object scope`,
      { field: `${label}.allObjects`, reason: 'object_scope_required' },
    )
  }

  const operations = raw.operations === undefined || raw.operations === null
    ? Object.freeze([OUTBOUND_SQL_WRITE_OPERATION_STATEMENT])
    : requiredStringList(raw.operations, `${label}.operations`)
  for (const operation of operations) {
    if (!OUTBOUND_SQL_WRITE_OPERATIONS.includes(operation)) {
      failAllowlist(
        `${label}.operations contains an operation that is not a registered outbound SQL write entry point`,
        { field: `${label}.operations`, reason: 'unknown_operation' },
      )
    }
  }

  return Object.freeze({
    entryId,
    systemId,
    systemName,
    kind,
    allObjects: true,
    operations,
  })
}

export interface SqlWriteAllowlist {
  readonly allowlistId: string
  readonly allowlistVersion: number
  readonly targets: readonly SqlWriteTarget[]
  readonly targetCount: number
}

/**
 * Read the allowlist off the environment. THREE states only.
 *
 *   * env unset / blank        -> `null`. DENIED, and no file I/O happens at all.
 *   * env set, file usable     -> a frozen, validated allowlist.
 *   * env set, anything else   -> THROWS `OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID`. Never `null`.
 *
 * Parameterless with respect to POLICY. `env` exists only so the suites can drive the loader without
 * mutating the process; every production call site invokes this with no arguments.
 */
export function loadOutboundSqlWriteAllowlist(env: NodeJS.ProcessEnv = process.env): SqlWriteAllowlist | null {
  const raw = env ? env[OUTBOUND_SQL_WRITE_TARGETS_ENV] : undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const filePath = raw.trim()

  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    // Values-free: the path is deployment topology, so it is named by ENV KEY and never echoed. The
    // underlying fs error message is dropped entirely — it embeds the path.
    failAllowlist(`${OUTBOUND_SQL_WRITE_TARGETS_ENV} points at a file that could not be read`, {
      envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV,
      reason: 'unreadable',
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    failAllowlist(`${OUTBOUND_SQL_WRITE_TARGETS_ENV} must point at a file containing valid JSON`, {
      envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV,
      reason: 'malformed_json',
    })
  }
  if (!isPlainObject(parsed)) {
    failAllowlist(
      `${OUTBOUND_SQL_WRITE_TARGETS_ENV} must point at a JSON object with allowlistId, allowlistVersion and targets`,
      { envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV, reason: 'not_an_object' },
    )
  }

  assertClosedKeySet(parsed, ALLOWLIST_KEYS, 'outboundSqlWriteTargets')
  const allowlistId = requiredString(parsed.allowlistId, 'allowlistId')
  if (!Number.isInteger(parsed.allowlistVersion) || (parsed.allowlistVersion as number) <= 0) {
    failAllowlist('allowlistVersion must be a positive integer', { field: 'allowlistVersion' })
  }
  if (!Array.isArray(parsed.targets)) {
    failAllowlist('targets must be an array', { field: 'targets' })
  }

  const targets = (parsed.targets as unknown[]).map((entry, index) => normalizeTarget(entry, index))

  // Duplicate entry ids would make a refusal/authorization stanza ambiguous about WHICH entry decided.
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.entryId)) {
      failAllowlist('targets contains a duplicate entryId', {
        field: 'targets',
        entryId: target.entryId,
        reason: 'duplicate_entry_id',
      })
    }
    seen.add(target.entryId)
  }

  // An ARMED allowlist with an EMPTY `targets` array is legal and authorizes nothing. That is the
  // correct state for a deployment that has turned the capability on and has not yet approved a
  // source; rejecting it would push operators toward leaving the env unset, which is not safer, it is
  // merely less visible.
  return Object.freeze({
    allowlistId,
    allowlistVersion: parsed.allowlistVersion as number,
    targets: Object.freeze(targets),
    targetCount: targets.length,
  })
}

export interface SqlWriteSubject {
  systemId?: string | null
  systemName?: string | null
  kind?: string | null
  operation?: string | null
}

function matchesTarget(target: SqlWriteTarget, subject: { systemId: string | null; systemName: string | null; kind: string | null; operation: string | null }): boolean {
  if (target.systemId !== subject.systemId) return false
  if (target.systemName !== null && target.systemName !== subject.systemName) return false
  if (target.kind !== null && target.kind !== subject.kind) return false
  if (subject.operation === null || !target.operations.includes(subject.operation)) return false
  return target.allObjects
}

export interface SqlWriteDecision {
  readonly systemId: string | null
  readonly operation: string | null
  readonly authorized: boolean
  readonly canApply: boolean
  readonly code: string | null
  readonly status: number
  readonly reason: string
  readonly message?: string
  readonly allowlistId?: string
  readonly allowlistVersion?: number
  readonly allowlistTargetCount?: number
  readonly entryId?: string
  readonly matchedEntryCount?: number
}

/**
 * DECIDE, WITHOUT THROWING. Returns a frozen, values-free decision, so a preview surface can say
 * `canApply: false` with the code that WOULD fire instead of showing a clean plan for a write the
 * gate will refuse.
 *
 * A load fault is reported here rather than thrown, so a malformed deployment file degrades a PREVIEW
 * into an honest refusal instead of taking the read leg down with it. `assert…` still throws on the
 * same fault, because a real write must stop hard.
 */
export function evaluateOutboundSqlWrite(input: SqlWriteSubject = {}, env: NodeJS.ProcessEnv = process.env): SqlWriteDecision {
  const subject = Object.freeze({
    systemId: optionalString(input.systemId),
    systemName: optionalString(input.systemName),
    kind: optionalString(input.kind),
    operation: optionalString(input.operation),
  })
  const base = { systemId: subject.systemId, operation: subject.operation }

  // UNKNOWN ENTRY POINTS DEFAULT-REFUSE.
  if (!subject.operation || !OUTBOUND_SQL_WRITE_OPERATIONS.includes(subject.operation)) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'unknown_write_operation',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  let allowlist: SqlWriteAllowlist | null
  try {
    allowlist = loadOutboundSqlWriteAllowlist(env)
  } catch (error) {
    const details = error instanceof OutboundSqlWriteGateError ? error.details : {}
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
      status: OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
      reason: optionalString(details.reason) || 'allowlist_invalid',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID],
    })
  }

  // THE DEFAULT. Unset env => refused, with the fixed code, before any file is opened.
  if (allowlist === null) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_DISABLED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'capability_not_authorized',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_DISABLED],
    })
  }

  const scoped = {
    ...base,
    allowlistId: allowlist.allowlistId,
    allowlistVersion: allowlist.allowlistVersion,
  }

  // Fail-closed on an under-specified subject: without a resolved source id nothing can match.
  if (!subject.systemId) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'missing_system_identity',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  const matched = allowlist.targets.filter((target) => matchesTarget(target, subject))
  if (matched.length === 0) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'target_not_listed',
      // A count, never the names.
      allowlistTargetCount: allowlist.targetCount,
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  // Deterministic pick: lowest entry id, so a stanza names a stable entry.
  const entryIds = matched.map((target) => target.entryId).sort()
  return Object.freeze({
    ...scoped,
    authorized: true,
    canApply: true,
    code: null,
    status: 200,
    reason: 'authorized',
    entryId: entryIds[0],
    matchedEntryCount: matched.length,
  })
}

export type BuildGateError = (status: number, code: string, message: string, details: Record<string, unknown>) => Error

/**
 * REFUSE OR RETURN. The form every enforcement point uses.
 *
 * `buildError` receives (status, code, message, details) so each layer throws ITS OWN error type and
 * rides that layer's established mapping — while the code, message and status stay identical across
 * layers. This module never learns those error shapes; that is what keeps it a leaf.
 */
export function assertOutboundSqlWriteAuthorized(
  buildError: BuildGateError,
  input: SqlWriteSubject = {},
  env: NodeJS.ProcessEnv = process.env,
): SqlWriteDecision {
  const decision = evaluateOutboundSqlWrite(input, env)
  if (decision.authorized) return decision
  const { authorized, canApply, status, code, message, ...details } = decision
  throw buildError(status as number, code as string, message as string, { code, ...details })
}

/**
 * The enforcement helper the SQL adapters call: gate a STATEMENT. A pure read returns immediately and
 * costs nothing; anything else must be authorized. This is the whole classification surface.
 */
export function assertSqlStatementWriteAuthorized(
  buildError: BuildGateError,
  sql: string,
  source: { id?: string | null; name?: string | null; type?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isPureReadStatement(sql)) return
  assertOutboundSqlWriteAuthorized(
    buildError,
    {
      systemId: source.id ?? null,
      systemName: source.name ?? null,
      kind: source.type ?? null,
      operation: OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
    },
    env,
  )
}
