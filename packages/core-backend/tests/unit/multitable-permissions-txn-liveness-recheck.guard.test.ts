/**
 * issue #5938 STRUCTURAL guard — a permission write transaction may not hold a `meta_sheets` row lock
 * without having re-read `deleted_at` under it first.
 *
 * ── Why a structural guard, on top of the behaviour suites ────────────────────
 * The behaviour suites (spreadsheet-permissions-txn-liveness-recheck.test.ts,
 * multitable-permissions-txn-liveness-recheck.test.ts) pin the six lock sites that exist TODAY. They
 * cannot see the seventh. The TOCTOU window is not a bug in any one handler — it is what you get for
 * free every time someone writes the obvious thing: gate on liveness, open a transaction, `SELECT 1
 * FROM meta_sheets … FOR UPDATE`, write. That shape READS correct. This guard makes it unwritable:
 *
 *   A. In these files, a SQL statement that locks a `meta_sheets` row must not exist at all — in any lock
 *      mode and any spelling the census recognizer knows (schema-qualified, quoted, through a JOIN; see
 *      "Sheet-row lock recognition" below). The lock is taken through `assertSheetLiveForUpdate`
 *      (multitable/sheet-liveness.ts), which locks the row AND reads `deleted_at` in ONE statement — so
 *      "took the lock but forgot to look" has no spelling. Exemptions are LEDGERED BY NAME with a reason,
 *      never by omission.
 *   B. Every transaction body in those files that writes access control calls `assertSheetLiveForUpdate`
 *      BEFORE its first write — and calls it with the TRANSACTION'S OWN query binding. Handing it the
 *      pool-level `query` satisfies the letter of the rule while reopening the whole window: that runs on
 *      a different connection, takes a second independent lock, and releases it immediately, so the
 *      writing transaction holds nothing.
 *   C. The helper itself actually locks, actually reads `deleted_at`, and actually refuses — asserted on
 *      behaviour, because A and B would both be satisfied by a helper that did nothing.
 *   D. The real-DB probe that proves a writer PARKS on the sheet row derives its `pg_stat_activity`
 *      pattern from the production statement instead of copying it. A copy cannot fail loudly: reword the
 *      statement and the probe matches nothing, so the property stops being verified (#5938 round 2).
 *
 * "Writes access control" is BOTH senses: a row in a permission table (`spreadsheet_permissions`,
 * `meta_view_permissions`, `field_permissions`) AND an access-control column on `meta_sheets` itself
 * (the row-level read-deny switch, the conditional read-deny rules) — the second is a sheet_config UPDATE
 * with no `deleted_at` predicate, which under READ COMMITTED simply overwrites on top of a soft delete
 * that committed in the window.
 *
 * ── Falsifiability ────────────────────────────────────────────────────────────
 * The analyzer is exercised against SYNTHETIC sources at the end of this file: the pre-#5938 shape must
 * be REJECTED and the fixed shape ACCEPTED. Without that pair, a scanner that silently matched nothing
 * (a renamed helper, a `.transaction` call it cannot see) would report a clean bill of health forever —
 * the #3365 lesson. The real-file legs additionally assert a MINIMUM number of discovered sites, so the
 * guard cannot pass by finding zero.
 *
 * Positions come from the AST, never from text scanning: a comment cannot produce a node, so prose
 * mentioning `FOR UPDATE` (spreadsheet-permissions.ts has several such lines) can never satisfy — or
 * violate — a rule here. The source is normalized to LF before parsing, so a CRLF checkout cannot make
 * a pattern silently match nothing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  SHEETS_ROW_LOCK_LIVENESS_SQL,
  SHEET_ROW_LOCK_LIVENESS_SQL,
  SheetNotLiveError,
  assertSheetLiveForUpdate,
  assertSheetsLiveForUpdate,
  loadSheetLivenessForUpdate,
  loadSheetsLivenessForUpdate,
} from '../../src/multitable/sheet-liveness'

const SRC = join(__dirname, '..', '..', 'src')

/**
 * Every door onto the per-sheet grant tables (#5938 fixes them together).
 *
 * The plugin-port service is here, not only the two route files: it opens a transaction, takes the same
 * `meta_sheets` row lock, and writes `field_permissions` — the identical shape, reachable through the
 * stock-prep plugin rather than a core route. A file-scoped guard that named only routes would have
 * reported a clean bill of health while that site kept the pre-#5938 existence-only check.
 */
const GUARDED_FILES = [
  'routes/spreadsheet-permissions.ts',
  'routes/univer-meta.ts',
  'services/stock-preparation-field-permissions.ts',
] as const

/** The permission tables these files own. A write to any of them is what the lock is protecting. */
const PERMISSION_TABLES = ['spreadsheet_permissions', 'meta_view_permissions', 'field_permissions']

/**
 * Access-control columns ON `meta_sheets` itself. An `UPDATE meta_sheets SET <one of these>` is a
 * read-deny policy write: the same authority (`canManageSheetAccess`), the same TOCTOU window, and no
 * `deleted_at` predicate of its own. Listed by COLUMN rather than by table so an ordinary sheet UPDATE
 * (a rename) is not dragged in — this is the access-control subset, not "any meta_sheets write".
 */
const ACCESS_CONTROL_SHEET_COLUMNS = ['row_level_read_permissions_enabled', 'conditional_read_rules']

/** Same-file appliers that write those tables without naming them in the caller's own SQL. */
const PERMISSION_APPLIERS = ['applyPermissionDeEscalation']

/** The one call that takes the lock AND reads `deleted_at`. */
const RECHECK = 'assertSheetLiveForUpdate'

/**
 * NAMED exemptions from rule A — a raw `meta_sheets` row lock (any mode) that is NOT a permission write.
 *
 * Keyed by the collapsed SQL statement so a new lock cannot inherit an old entry's licence. Each is a
 * standing statement that this lock guards something other than a grant table.
 *
 * EMPTY since #5954. Its one entry was the cross-base mirror op's lock-only multi-sheet
 * `SELECT id … = ANY($1) … FOR UPDATE`, which never re-read sheet liveness. That lock now goes through
 * `assertSheetsLiveForUpdate` (multitable/sheet-liveness.ts), so no guarded file spells a raw
 * `meta_sheets` row lock at all; a new one reds rule A until it is either routed through a helper or
 * named here with its reason.
 */
const RAW_LOCK_LEDGER = new Map<string, string>([])

/**
 * What a census entry says about SHEET LIVENESS under its lock (#6065 follow-up):
 *
 *   - `in-statement`: the lock statement itself selects the sheet's `deleted_at` or filters on it.
 *     CHECKED MECHANICALLY against the statement text (`statementReadsSheetDeletedAt`), so this verdict
 *     cannot be claimed by prose alone.
 *   - `under-lock`: the lock statement does not, but a later statement on the same transaction reads or
 *     filters `deleted_at` before anything the lock protects is written. `followUp` names that statement as
 *     `<file> :: <statement>`; the test asserts it still exists in that file and still mentions `deleted_at`.
 *     That pins the follow-up's EXISTENCE, not its ordering — the ordering is argued in `reason`.
 *   - `gap`: neither, and the fix is not a mechanical one. Every such key is also in
 *     `KNOWN_SHEET_LIVENESS_GAPS` (the ratchet below); a new one reds until it is added there visibly.
 */
type SheetLivenessVerdict = 'in-statement' | 'under-lock' | 'gap'

interface SheetRowLockCensusEntry {
  liveness: SheetLivenessVerdict
  reason: string
  /** `under-lock` only: the statement that re-reads liveness, as `<file relative to src> :: <statement>`. */
  followUp?: string
  /**
   * How many call sites in the file issue this exact statement (default 1). The census counts SITES, so a new
   * call site that repeats a named statement reds until this number is raised — visibly, next to a `reason` that
   * must then cover the new site too. Without it, the new site would silently inherit the old site's verdict.
   */
  sites?: number
}

/** The census's expectation, one entry per site, sorted — the shape `censusOfSrcTree().locks` has. */
function expectedCensusSites(census: ReadonlyMap<string, SheetRowLockCensusEntry>): string[] {
  return [...census].flatMap(([key, entry]) => Array.from({ length: entry.sites ?? 1 }, () => key)).sort()
}

/**
 * The WHOLE-TREE census of `meta_sheets` row locks (#5938 round 2; recognizer widened after #6065).
 *
 * The rules above are file-scoped, and a file-scoped guard reports a clean bill of health for a site it
 * was never pointed at — which is exactly how the stock-prep plugin port kept the pre-fix shape while the
 * ledger above read like the complete residual set. So this census names EVERY row lock on `meta_sheets`
 * anywhere under `src/`, with what it guards and whether it re-reads liveness. A new one — in any file, in
 * any lock mode, in any spelling the recognizer below knows, and a new call site repeating a statement already
 * named (the census counts sites; see `sites`) — reds until it is named, which is the only way "no tenth site"
 * can be a claim rather than a hope.
 *
 * The recognizer used to key on `FROM meta_sheets` literally. #6065's implementation and its independent
 * verification both found what that cannot see: `public.meta_sheets` (schema-qualified) and a sheet row
 * locked through a JOIN (`JOIN meta_sheets sheet … FOR SHARE OF sheet`). Widening it surfaced three sites
 * that had never been named — the attendance cleaning authority pin, the recovery derived-effect processor
 * scope pin, and the restore-job writer-block pin — all three below, each with a liveness verdict.
 */
const SHEET_ROW_LOCK_CENSUS = new Map<string, SheetRowLockCensusEntry>([
  [
    'multitable/sheet-liveness.ts :: SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE',
    {
      liveness: 'in-statement',
      reason: 'THE helper. The one statement that locks the row and re-reads `deleted_at` together.',
    },
  ],
  [
    'multitable/sheet-liveness.ts :: SELECT s.id, s.deleted_at FROM meta_sheets s JOIN unnest($1::text[]) WITH ORDINALITY AS u(id, ord) ON s.id = u.id ORDER BY u.ord FOR UPDATE OF s',
    {
      liveness: 'in-statement',
      reason: 'THE multi-sheet helper (#5954). Locks every named row in the order of the array it is handed '
        + '(`WITH ORDINALITY … ORDER BY u.ord`), which the helper sorts in JS code-unit order — the order the '
        + 'JS-sorted sheet lockers use, whatever the database locale and whatever characters the (client-chosen) '
        + 'ids carry; no SQL-side sort of `id`, since both collation order and byte (`COLLATE "C"`) order can cross '
        + 'JS order — and re-reads each `deleted_at` in the same statement. Its caller is the cross-base mirror '
        + 'RECORD op (routes/univer-meta.ts), whose lock-only `SELECT id … = ANY($1) … FOR UPDATE` it replaced — '
        + 'that site is closed, not ledgered.',
    },
  ],
  [
    'multitable/link-writer-fence.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT',
    {
      liveness: 'under-lock',
      followUp: 'routes/univer-meta.ts :: UPDATE meta_sheets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      reason: 'sheet-DELETE writer fence (`enterSheetLinkDeleteFencePlan`, flag-gated). Its only caller is '
        + 'DELETE /sheets/:sheetId, and the one write it protects is the soft delete itself, whose UPDATE carries '
        + '`deleted_at IS NULL` — so a delete racing a delete is a no-op, not a write onto a dead sheet. NOWAIT (it '
        + 'refuses rather than queues). Not a permission write.',
    },
  ],
  [
    'services/approval-record-link-txn-auth.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE',
    {
      liveness: 'under-lock',
      followUp: 'services/approval-record-link-txn-auth.ts :: SELECT id, base_id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
      sites: 2,
      reason: 'record-link target-sheet authority — FOR SHARE (a read-side pin, not a write lock) on a RECORD path. '
        + 'Two call sites, same statement (`sites: 2`). Not a permission write. The pin blocks a concurrent soft delete (an '
        + 'UPDATE of the row), and the callers read in this pass re-read `deleted_at` on the same query after '
        + 'taking it: resolveRecordLinkTargetAuthOnQuery (the followUp), the record-link probe\'s '
        + '`sheetBelongsToBase` (services/approval-record-link-read-projection.ts), the FWB executor\'s '
        + 'membership read (multitable/automation-executor.ts, lockFwbExecutionAuthority), and the record-permission '
        + 'PUT/DELETE routes\' loadSheetLiveness (routes/univer-meta.ts). Read from code, not raced.',
    },
  ],
  [
    'multitable/exact-anchor-recovery-execute.ts :: SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE NOWAIT',
    {
      liveness: 'gap',
      reason: 'exact-anchor recovery apply — pins every AUTHORITY sheet for a RECORD recovery, sorted and NOWAIT '
        + '(it refuses rather than queues). Multi-sheet; not a permission write. It never reads `deleted_at` '
        + '(the file has no such read), so a soft-deleted authority sheet is pinned like a live one. The '
        + '#5954 helper would make it refuse — but whether a RECOVERY may act across a soft-deleted sheet, and '
        + 'whether a NOWAIT pin should turn into a queued lock, are product decisions. Known gap; behaviour unchanged.',
    },
  ],
  [
    'services/elearning-stats-multitable-projection.ts :: SELECT id, base_id, system_kind FROM meta_sheets WHERE id = $1 FOR UPDATE',
    {
      liveness: 'gap',
      reason: 'e-learning statistics projection — a SYSTEM-owned read model that CREATES the sheet it then locks in '
        + 'the same transaction, and re-derives `base_id` + `system_kind` under the lock. It writes meta_fields '
        + 'and meta_records, never a permission table. It does not read `deleted_at`, so a soft-deleted projection '
        + 'sheet would be re-populated rather than refused. No runtime path races it today: the one runtime soft '
        + 'delete (DELETE /sheets/:sheetId) refuses projection ids first. Whether "ensure" should then refuse '
        + '(the base lock just above it does) or restore is a product decision. Known gap; behaviour unchanged.',
    },
  ],
  [
    "attendance/attendance-multitable-cleaning-authority.ts :: SELECT sheet.id AS sheet_id, registry.project_id FROM meta_records projection JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL JOIN plugin_multitable_object_registry registry ON registry.sheet_id = sheet.id WHERE projection.id = $1 AND registry.plugin_name = 'plugin-attendance' AND registry.object_id = 'attendance_report_records' AND registry.project_id = $2 FOR SHARE OF sheet, registry",
    {
      liveness: 'in-statement',
      reason: 'attendance cleaning authority (lockAttendanceCleaningProjectionAccess) — pins the owning report '
        + 'sheet through a JOIN (`FOR SHARE OF sheet`), with `sheet.deleted_at IS NULL` in the join condition, so '
        + 'a soft-deleted sheet yields no row and the caller refuses. First named after #6065: the `FROM meta_sheets` '
        + 'recognizer could not see a sheet locked through a JOIN.',
    },
  ],
  [
    'multitable/recovery-archive-derived-processor.ts :: SELECT sheet.id FROM public.meta_sheets sheet JOIN public.meta_bases base ON base.id=sheet.base_id WHERE sheet.id=ANY($1::text[]) AND sheet.deleted_at IS NULL AND base.deleted_at IS NULL ORDER BY base.id,sheet.id FOR SHARE OF base,sheet NOWAIT',
    {
      liveness: 'in-statement',
      reason: 'recovery derived-effect processor — pins every scope sheet and its base FOR SHARE NOWAIT, filtering '
        + '`sheet.deleted_at IS NULL AND base.deleted_at IS NULL` in the same statement; a row-count mismatch '
        + 'refuses (RECOVERY_DERIVED_SCOPE_CHANGED). First named after #6065: schema-qualified, so invisible to '
        + 'the `FROM meta_sheets` recognizer.',
    },
  ],
  [
    "multitable/recovery-archive-restore-jobs.ts :: SELECT id FROM public.meta_sheets WHERE id = $1 AND recovery_writer_state = 'archiving' AND recovery_writer_owner_kind = 'restore_job' AND recovery_writer_owner_id = $2 AND recovery_writer_owner_fence = $3::bigint AND recovery_writer_lease_until > clock_timestamp() FOR UPDATE",
    {
      liveness: 'gap',
      reason: 'restore-job writer-block pin (lockRestoreJobBlock) — asserts the job still OWNS the sheet\'s '
        + '`archiving` writer block and holds the row for the claim / heartbeat / apply transactions. It does not '
        + 'read `deleted_at`, and neither does the block claim. A soft delete cannot slip in while the block is '
        + 'held when the writer fence is on (DELETE /sheets/:sheetId fences the sheet itself and refuses a writer '
        + 'block — read from code, not raced); a sheet soft-deleted BEFORE the claim is not refused. Whether a '
        + 'recovery restore may run against a soft-deleted sheet is a product decision. First named after #6065 '
        + '(schema-qualified). Known gap; behaviour unchanged.',
    },
  ],
])

/**
 * The GAP ledger — census entries that lock a sheet row WITHOUT re-reading liveness and whose fix waits on a
 * product decision. A ratchet: it may only shrink. Closing one removes its key here (and changes the entry's
 * verdict); adding one means editing this list AND raising `SHEET_LIVENESS_GAP_CEILING`, both visible in review.
 */
const KNOWN_SHEET_LIVENESS_GAPS: readonly string[] = [
  'multitable/exact-anchor-recovery-execute.ts :: SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE NOWAIT',
  'services/elearning-stats-multitable-projection.ts :: SELECT id, base_id, system_kind FROM meta_sheets WHERE id = $1 FOR UPDATE',
  "multitable/recovery-archive-restore-jobs.ts :: SELECT id FROM public.meta_sheets WHERE id = $1 AND recovery_writer_state = 'archiving' AND recovery_writer_owner_kind = 'restore_job' AND recovery_writer_owner_id = $2 AND recovery_writer_owner_fence = $3::bigint AND recovery_writer_lease_until > clock_timestamp() FOR UPDATE",
]
/** Lower it when a gap closes. Never raise it without a named product decision. */
const SHEET_LIVENESS_GAP_CEILING = 3
/** `under-lock` is the verdict least checked by machine; its count is ratcheted the same way. */
const SHEET_LIVENESS_UNDER_LOCK_CEILING = 2

/**
 * Statements that NAME `meta_sheets` beside a lock clause but do NOT lock a sheet row: every `FOR … OF` target
 * resolves to a different relation (PostgreSQL locks only the listed relations). Ledgered by name so the
 * exclusion path is visible too — a recognizer that silently widened what it excludes would shrink the census
 * with no test noticing.
 */
const SHEET_MENTIONED_BESIDE_LOCK_NOT_A_ROW_LOCK = new Map<string, string>([
  [
    "attendance/attendance-multitable-cleaning-authority.ts :: SELECT projection.id AS projection_record_id, attendance_record.id AS canonical_record_id, attendance_record.org_id, attendance_record.user_id, attendance_record.work_date::text AS work_date, attendance_record.timezone, attendance_record.first_in_at, attendance_record.last_out_at, attendance_record.work_minutes, attendance_record.late_minutes, attendance_record.early_leave_minutes, attendance_record.status, attendance_record.is_workday, attendance_record.projection_owner, attendance_record.current_calculation_id, attendance_record.visibility_state, attendance_record.visibility_reason, attendance_record.meta FROM meta_records projection JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL JOIN plugin_multitable_object_registry registry ON registry.sheet_id = projection.sheet_id AND registry.plugin_name = 'plugin-attendance' AND registry.object_id = 'attendance_report_records' JOIN attendance_records attendance_record ON attendance_record.id = $2 AND registry.project_id = attendance_record.org_id || ':attendance' WHERE projection.id = $1 FOR UPDATE OF projection, attendance_record",
    'loadCanonicalRow — `FOR UPDATE OF projection, attendance_record`: the meta_records row and the attendance '
    + 'record, not the joined sheet (which is filtered on `sheet.deleted_at IS NULL` but not locked).',
  ],
  [
    "multitable/recovery-archive-derived-effects.ts :: SELECT effect.revision_id, effect.job_id, effect.record_id, effect.field_ids, effect.link_invalidations, job.workspace_id, job.base_id, job.sheet_id, job.actor_id FROM public.meta_recovery_archive_derived_effects effect JOIN public.meta_recovery_archive_jobs job ON job.id=effect.job_id JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id WHERE effect.completed_at IS NULL AND job.state IN ('done','abandoned_partial') AND sheet.deleted_at IS NULL AND sheet.recovery_writer_state IS NULL ORDER BY effect.last_attempt_at NULLS FIRST, effect.created_at, effect.revision_id LIMIT 1 FOR UPDATE OF effect SKIP LOCKED",
    'derived-effect queue claim — `FOR UPDATE OF effect SKIP LOCKED` locks the queue row only; the sheet join '
    + 'is a filter. The processor pins the sheet separately (the derived-processor census entry).',
  ],
])

interface TxnBlock {
  file: string
  line: number
  /** Position of the recheck call THAT USES THIS TRANSACTION'S OWN query, or -1. */
  recheckAt: number
  /** Position of the first permission write inside the body, or -1. */
  firstWriteAt: number
  /** What the first write was, for the failure message. */
  firstWriteLabel: string
  /** The query expression this transaction binds (`query`, or `client.query`), or '' if unreadable. */
  queryBinding: string
  /** Recheck calls handed something OTHER than that binding — a lock on another connection. */
  foreignRechecks: string[]
}

interface RawLock {
  file: string
  line: number
  sql: string
}

interface Scan {
  txns: TxnBlock[]
  rawLocks: RawLock[]
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ── Sheet-row lock recognition ─────────────────────────────────────────────────
//
// Statement-level and conservative: when a statement's lock target cannot be resolved it COUNTS as a sheet
// lock. An over-count shows up as a census key someone must name (loud); an under-count is the silence the
// census exists to prevent. What is recognized:
//   - any spelling of the relation: `meta_sheets`, `public.meta_sheets`, `"meta_sheets"`, `public."meta_sheets"`,
//     any case, aliased or not, in FROM, JOIN or a comma list;
//   - every lock strength (`FOR UPDATE | NO KEY UPDATE | SHARE | KEY SHARE`), with or without `OF …`, `NOWAIT`,
//     `SKIP LOCKED`;
//   - `FOR … OF <list>`: a sheet row is locked when the list names the sheet's alias (or the bare table), or
//     names anything that is not positively another relation in the statement. With no `OF` list every relation
//     in the FROM clause is locked — the sheet included. A sub-select's alias (`(SELECT … FROM meta_sheets) sub`)
//     is never registered as a relation here, so `OF sub` is unresolvable and counts;
//   - several statements in one literal (plpgsql bodies in migrations): split on `;` the way PostgreSQL's lexer
//     sees one (`lexSql`), so a lock in one statement is not attributed to a `meta_sheets` mention in another.
//     SQL comments (`-- …` to end of line, `/* … */`, nested) are whitespace: a `;` inside one cannot cut a
//     statement in two, and one inside a lock clause (`FOR /* x */ UPDATE`) cannot hide it. `'…'`, `E'…'` and
//     `"…"` are opaque; a dollar-quoted string (`$$…$$`, `$tag$…$tag$`) is opaque to the statement it sits in and
//     its body is lexed again as SQL of its own (a plpgsql body is statements). Text the lexer cannot close (an
//     unterminated quote, dollar body or block comment) is judged WHOLE, as one statement — conservative again;
//   - what the lexer sets aside can add a statement to the census, never take one out: a statement in neither book
//     as PostgreSQL runs it is judged again AS WRITTEN (comments kept, a one-statement dollar string inline; see
//     `censusEntriesOf`). So main's recognizer, which never stripped or split, saw nothing inside one statement
//     that this census does not file — prose naming the table beside a lock clause in a SQL comment is filed too;
//   - one lock per SITE: two call sites that issue the same statement are two census entries' worth (`sites`),
//     so a new call site repeating a named statement is not absorbed by the name it repeats.
// Not recognized (stated so it is not read as more): a table name or lock clause that reaches the SQL only
// through a cross-file import, a runtime value (the generic data adapters; a function parameter) or a binding
// lexical scope does not show (a class field, a `var` declared in a nested block), a view over `meta_sheets`, a
// lock taken in a database function not defined under `src/`, a statement assembled by reassignment
// (`let sql = …; sql += ' FOR UPDATE'`), a query builder held in a variable between the call that names
// the table and the lock call (`const q = db.selectFrom('meta_sheets'); … q.forUpdate()`), and a table name inside a
// MULTI-statement dollar string meeting a lock clause outside it only through dynamic SQL at run time.

/** A SQL identifier, bare or double-quoted. */
const SQL_IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`
/** A relation name, optionally schema-qualified: `meta_sheets`, `public.meta_sheets`, `"public"."meta_sheets"`. */
const SQL_QNAME = String.raw`${SQL_IDENT}(?:\s*\.\s*${SQL_IDENT})?`
/** Words that can follow a relation without being its alias. */
const NOT_AN_ALIAS = new Set([
  'and', 'as', 'cross', 'else', 'end', 'except', 'fetch', 'for', 'from', 'full', 'group', 'having', 'inner',
  'intersect', 'into', 'is', 'join', 'lateral', 'left', 'limit', 'loop', 'natural', 'not', 'offset', 'on', 'or',
  'order', 'outer', 'returning', 'right', 'select', 'set', 'tablesample', 'then', 'union', 'using', 'values',
  'when', 'where', 'window', 'with',
])

/**
 * `"public"."Meta_Sheets"` → `meta_sheets`: unquote, lower-case, drop the schema. Folding the case of a quoted
 * name is deliberately lossy — it can only make two names look ALIKE (an over-count), never different.
 */
function normSqlIdent(raw: string): string {
  const last = raw.split('.').pop()!.trim()
  return (last.startsWith('"') ? last.slice(1, -1) : last).toLowerCase()
}

interface RelationRef {
  table: string
  alias: string | null
}

/** Every `FROM|JOIN|, <relation> [AS] [alias]` in a statement (select-list commas add harmless noise). */
function relationRefs(stmt: string): RelationRef[] {
  // The alias is captured in a LOOKAHEAD so a keyword taken for one (`… x.col FROM t`) is not consumed and
  // the next `FROM` can still start a match.
  const re = new RegExp(String.raw`(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(${SQL_QNAME})(?=(?:\s+(?:AS\s+)?(${SQL_IDENT}))?)`, 'gi')
  const out: RelationRef[] = []
  for (const m of stmt.matchAll(re)) {
    let alias = m[2] ? normSqlIdent(m[2]) : null
    if (alias !== null && !m[2].startsWith('"') && NOT_AN_ALIAS.has(alias)) alias = null
    out.push({ table: normSqlIdent(m[1]), alias })
  }
  return out
}

/** Every locking clause, with its `OF` targets normalized ([] = no `OF` = every relation in FROM). */
function lockClauses(stmt: string): Array<{ of: string[] }> {
  const re = new RegExp(
    String.raw`\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b(?:\s+OF\s+(${SQL_QNAME}(?:\s*,\s*${SQL_QNAME})*))?`,
    'gi',
  )
  return [...stmt.matchAll(re)].map((m) => ({ of: m[1] ? m[1].split(',').map(normSqlIdent) : [] }))
}

/** A character that continues a SQL word — so a `$` or an `E` right after one is not a token start. */
const SQL_WORD_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/
/** A dollar-quote delimiter: `$$` or `$tag$` (a tag never starts with a digit, so `$1` stays a parameter). */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/

/** One SQL statement as the lexer sees it. */
interface SqlStatement {
  /** What PostgreSQL runs, collapsed: each comment became one space, each dollar-quoted string shows as `$tag$…$tag$`. */
  sql: string
  /**
   * The same statement as WRITTEN, collapsed: comments kept verbatim, and a dollar-quoted string that is at most one
   * statement (a string constant, a dynamic-SQL fragment) inline. Only a multi-statement body stays `$tag$…$tag$`.
   */
  asWritten: string
  /** The statements of each dollar-quoted string in it (a plpgsql body is statements), lexed the same way. */
  bodies: SqlStatement[]
}

interface LexedSql {
  /** The statements, in order; a segment that is only comments (PostgreSQL runs nothing) is dropped. */
  statements: SqlStatement[]
  /** False when the text ends inside a quote, a dollar-quoted body or a block comment. */
  clean: boolean
}

/**
 * PostgreSQL's lexical view of a SQL text, as far as statement boundaries and lock clauses need it (see the header
 * above). Only a `;` outside every quote, comment and dollar body ends a statement.
 */
function lexSql(text: string): LexedSql {
  const statements: SqlStatement[] = []
  let current = ''
  let currentAsWritten = ''
  let currentBodies: SqlStatement[] = []
  let clean = true
  const endStatement = () => {
    const sql = collapse(current)
    if (sql !== '') statements.push({ sql, asWritten: collapse(currentAsWritten), bodies: currentBodies })
    current = ''
    currentAsWritten = ''
    currentBodies = []
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    const from = i
    if (ch === '-' && next === '-') {
      // A line comment: whitespace up to (not including) the newline that ends it.
      const eol = text.indexOf('\n', i + 2)
      current += ' '
      i = eol === -1 ? text.length : eol
      currentAsWritten += text.slice(from, i)
    } else if (ch === '/' && next === '*') {
      // A block comment; PostgreSQL nests them.
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      if (depth > 0) clean = false
      current += ' '
      i = j
      currentAsWritten += ` ${text.slice(from, i)} `
    } else if (ch === "'" || ch === '"') {
      // `'…'` / `"…"` with the quote doubled inside; `E'…'` also takes backslash escapes.
      const backslashEscapes = ch === "'" && /[Ee]/.test(text[i - 1] ?? '') && !SQL_WORD_CHAR.test(text[i - 2] ?? '')
      let j = i + 1
      let closed = false
      while (j < text.length) {
        if (backslashEscapes && text[j] === '\\') {
          j += 2
        } else if (text[j] === ch && text[j + 1] === ch) {
          j += 2
        } else if (text[j] === ch) {
          closed = true
          j++
          break
        } else {
          j++
        }
      }
      if (!closed) clean = false
      current += text.slice(i, j)
      currentAsWritten += text.slice(i, j)
      i = j
    } else if (ch === '$' && !SQL_WORD_CHAR.test(text[i - 1] ?? '') && DOLLAR_TAG.test(text.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))![0]
      const end = text.indexOf(tag, i + tag.length)
      if (end === -1) clean = false
      const body = text.slice(i + tag.length, end === -1 ? text.length : end)
      const bodyStatements = sqlStatements(body)
      currentBodies.push(...bodyStatements)
      current += ` ${tag}…${tag} `
      currentAsWritten += bodyStatements.length <= 1 ? ` ${tag}${body}${tag} ` : ` ${tag}…${tag} `
      i = end === -1 ? text.length : end + tag.length
    } else if (ch === ';') {
      endStatement()
      i++
    } else {
      current += ch
      currentAsWritten += ch
      i++
    }
  }
  endStatement()
  return { statements, clean }
}

/**
 * The statements of one SQL text (see `lexSql`). When the lexer cannot close what it opened, its split is not
 * trusted: the whole text, comments and all, is judged as ONE statement — a lock can then only be over-counted.
 */
function sqlStatements(text: string): SqlStatement[] {
  const lexed = lexSql(text)
  if (lexed.clean) return lexed.statements
  const whole = collapse(text)
  return whole === '' ? [] : [{ sql: whole, asWritten: whole, bodies: [] }]
}

/** One statement both names `meta_sheets` and carries a lock clause (locking the sheet or not). */
function mentionsSheetBesideLock(stmt: string): boolean {
  return /\bmeta_sheets\b/i.test(stmt) && lockClauses(stmt).length > 0
}

/** The two census books: a sheet-row lock, or a `meta_sheets` mention beside a lock that does not take the sheet. */
type CensusBook = 'lock' | 'beside'

/** A statement filed in a census book, under the text its key carries. */
interface CensusEntry {
  book: CensusBook
  stmt: string
}

/**
 * Which book a statement text belongs in, if either. `statementLocksSheetRow` is defined below; a function
 * declaration is hoisted, so the order is only for reading.
 */
function bookOf(stmt: string): CensusBook | null {
  if (statementLocksSheetRow(stmt)) return 'lock'
  return mentionsSheetBesideLock(stmt) ? 'beside' : null
}

/**
 * A lexed statement's census entries: the statement as PostgreSQL runs it, then each dollar-quoted body's own
 * statements (judged the same way, recursively).
 *
 * A statement that is in NEITHER book as PostgreSQL runs it is judged a second time AS WRITTEN (`asWritten`: its
 * comments kept, a one-statement dollar string inline), and filed under that text when that puts it in a book.
 * Setting text aside can reveal a lock (`FOR /* x *\/ UPDATE` — which is why the first look comes first) and can hide
 * one; the second look puts the text back, so together the two looks cannot narrow the census below either view:
 * whatever the pre-lexer recognizer (main's, which never stripped or split anything) saw inside ONE statement, this
 * census files in one of its two books. Two reasons it matters beyond prose:
 *   - the text here approximates PostgreSQL's where this file cannot know a runtime value: `${cond ? '-- …' :
 *     'FOR UPDATE'}` is read as both branches at once, so the first branch's comment swallows the second — without
 *     the second look, a comment that PostgreSQL never receives would make a real lock vanish;
 *   - a table name in a dollar-quoted string and a lock clause outside it (`EXECUTE $q$… meta_sheets …$q$ ||
 *     ' FOR UPDATE'`) meet only in dynamic SQL, which PostgreSQL assembles at run time.
 * So prose in a SQL comment that names the table beside a lock clause IS filed (over-counted: loud, and named).
 * A MULTI-statement dollar body stays out of the second look: merging a plpgsql body back into the `CREATE FUNCTION`
 * around it would attribute a lock in one body statement to a `meta_sheets` mention in another — three real
 * migration trigger functions would be filed as sheet-row locks — and its statements are judged on their own anyway.
 */
function censusEntriesOf(st: SqlStatement): CensusEntry[] {
  const out: CensusEntry[] = []
  const book = bookOf(st.sql)
  if (book !== null) out.push({ book, stmt: st.sql })
  else {
    const asWritten = bookOf(st.asWritten)
    if (asWritten !== null) out.push({ book: asWritten, stmt: st.asWritten })
  }
  for (const body of st.bodies) out.push(...censusEntriesOf(body))
  return out
}

/** Every statement of a lexed text, dollar-quoted bodies included (depth-first), as PostgreSQL runs it. */
function flatStatements(statements: SqlStatement[]): string[] {
  return statements.flatMap((st) => [st.sql, ...flatStatements(st.bodies)])
}

/** One statement takes a row lock on `meta_sheets` — see the header above for what "conservative" means. */
function statementLocksSheetRow(stmt: string): boolean {
  if (!mentionsSheetBesideLock(stmt)) return false
  const refs = relationRefs(stmt)
  const sheetNames = new Set(['meta_sheets', ...refs.filter((r) => r.table === 'meta_sheets' && r.alias).map((r) => r.alias!)])
  for (const clause of lockClauses(stmt)) {
    if (clause.of.length === 0) return true
    for (const target of clause.of) {
      if (sheetNames.has(target)) return true
      const otherRelation = refs.some((r) => r.table !== 'meta_sheets' && (r.alias === target || r.table === target))
      if (!otherRelation) return true
    }
  }
  return false
}

/** The census entries of one SQL text (one literal / unit, possibly several statements). */
function censusEntriesOfText(text: string): CensusEntry[] {
  return sqlStatements(text).flatMap(censusEntriesOf)
}

/** A SQL text (one literal / unit, possibly several statements) that takes a row lock on `meta_sheets`. */
function locksSheetRow(text: string): boolean {
  return censusEntriesOfText(text).some((e) => e.book === 'lock')
}

/**
 * The statement itself selects or filters the SHEET's `deleted_at`: qualified by the sheet's alias (or the bare
 * table name), or unqualified when the whole FROM clause is `meta_sheets` alone — an unqualified `deleted_at`
 * beside a second relation could be that relation's column.
 */
function statementReadsSheetDeletedAt(stmt: string): boolean {
  const refs = relationRefs(stmt)
  const sheetNames = new Set(['meta_sheets', ...refs.filter((r) => r.table === 'meta_sheets' && r.alias).map((r) => r.alias!)])
  for (const name of sheetNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(String.raw`(?:\b|")${escaped}"?\s*\.\s*"?deleted_at\b`, 'i').test(stmt)) return true
  }
  const fromClause = /\bFROM\s+([\s\S]*?)(?=\s+(?:WHERE|ORDER|GROUP|HAVING|LIMIT|OFFSET|WINDOW|UNION|FOR)\b|$)/i.exec(stmt)
  const onlySheets = fromClause !== null
    && new RegExp(String.raw`^(?:ONLY\s+)?(${SQL_QNAME})(?:\s+(?:AS\s+)?${SQL_IDENT})?$`, 'i').test(fromClause[1].trim())
    && normSqlIdent(new RegExp(String.raw`^(?:ONLY\s+)?(${SQL_QNAME})`, 'i').exec(fromClause[1].trim())![1]) === 'meta_sheets'
  return onlySheets && /\bdeleted_at\b/i.test(stmt)
}

/** A SQL literal that writes one of the permission tables, or an access-control column on the sheet. */
function writesPermissionTable(text: string): string | null {
  for (const table of PERMISSION_TABLES) {
    const pattern = new RegExp(String.raw`\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+${table}\b`, 'i')
    if (pattern.test(text)) return table
  }
  if (/\bUPDATE\s+meta_sheets\b/i.test(text)) {
    for (const column of ACCESS_CONTROL_SHEET_COLUMNS) {
      if (new RegExp(String.raw`\bSET\b[\s\S]*\b${column}\s*=`, 'i').test(text)) return `meta_sheets.${column}`
    }
  }
  return null
}

/** Every string/template literal's text, with its node — comments are not literals, so prose is out. */
function literalsIn(node: ts.Node): Array<{ node: ts.Node; text: string }> {
  const out: Array<{ node: ts.Node; text: string }> = []
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push({ node: n, text: collapse(n.text) })
    else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)]
      out.push({ node: n, text: collapse(parts.join(' ')) })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Query-builder lock methods (Kysely spells a row lock as a chained call, not as SQL text). */
const LOCK_BUILDER_METHODS = new Set(['forUpdate', 'forShare', 'forNoKeyUpdate', 'forKeyShare'])

interface SqlUnit {
  node: ts.Node
  /** The SQL text as the database would receive it, as far as this file can tell (NOT collapsed). */
  text: string
  /** A query-builder chain ending in a lock method: `text` is the chain's source, not SQL. */
  builder: boolean
}

/** Binary operators whose result is one of their string operands (or their concatenation). */
const STRING_COMPOSING_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
])

/**
 * An initializer whose VALUE is composed from string pieces — the only kind a `${name}` follows. A call's result
 * (`const r = await query('… meta_sheets …')`) is a value the SQL never contains, so it is not followed; following
 * it would stitch another query's text into this one.
 */
function composesString(e: ts.Expression): boolean {
  return ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || ts.isIdentifier(e)
    || ts.isConditionalExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)
    || (ts.isBinaryExpression(e) && STRING_COMPOSING_OPERATORS.has(e.operatorToken.kind))
    || (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'join'
      && ts.isArrayLiteralExpression(e.expression.expression))
}

/** Does this binding (an identifier or a destructuring pattern) bind `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name
  return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name))
}

/**
 * The initializer of the declaration `id` refers to, found the way lexical scope finds it: the nearest enclosing
 * block (or the file) that declares the name with `const` / `let` / `var`. A function parameter, a catch binding,
 * a destructuring or a `for … of|in` variable in between binds a runtime value, so there is nothing to follow.
 * Not seen: a `var` declared inside a nested block (function-scoped by hoisting), a class field, an import.
 */
function declarationInitializer(id: ts.Identifier): ts.Expression | undefined {
  const name = id.text
  for (let n: ts.Node | undefined = id.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) return undefined
    if (ts.isCatchClause(n) && n.variableDeclaration && bindsName(n.variableDeclaration.name, name)) return undefined
    let lists: ts.VariableDeclarationList[] = []
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      lists = n.statements.filter(ts.isVariableStatement).map((s) => s.declarationList)
    } else if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n))
      && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      lists = [n.initializer]
    }
    for (const list of lists) {
      const decl = list.declarations.find((d) => bindsName(d.name, name))
      if (decl === undefined) continue
      const iterated = ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent)
      return ts.isIdentifier(decl.name) && !iterated ? decl.initializer : undefined
    }
  }
  return undefined
}

/**
 * From a query-builder lock call, the whole fluent chain it belongs to: up through every `.x` / `(…)` link ABOVE
 * it (`….forUpdate().innerJoin('meta_sheets as s', …).execute()`), and out of a callback handed to a chain call
 * (`.$if(lock, (qb) => qb.forUpdate())`, expression- or block-bodied) into that call's chain. It stops at anything
 * that is not a link — an `await`, an argument position, a statement.
 */
function outermostChain(from: ts.Node): ts.Node {
  let top = from
  for (;;) {
    const p = top.parent
    if (!p) return top
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === top) {
      top = p
      continue
    }
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      top = p
      continue
    }
    let fn: ts.Node | undefined
    if (ts.isArrowFunction(p) && p.body === top) fn = p
    else if (ts.isReturnStatement(p)) {
      fn = p.parent
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
    }
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isCallExpression(fn.parent)
      && fn.parent.arguments.some((a) => a === fn)) {
      top = fn.parent
      continue
    }
    return top
  }
}

/**
 * Every place under `root` that can hand SQL to the database, as text — a superset of `literalsIn`:
 *   - a string / template literal; a template's `${…}` contributes every literal nested in it and whatever a
 *     same-file declaration it names composes (`const X = '…'`, `const L = lock ? 'FOR UPDATE' : ''`,
 *     `const T = 'meta_sheets' as const`, a template, a `+` chain, another such name — followed transitively,
 *     with a guard against cycles). A name resolves to the declaration lexical scope picks
 *     (`declarationInitializer`), and only an initializer that composes a string is followed (`composesString`);
 *   - a `+` chain (concatenated as JS would) and `[…].join(sep)`, so a statement split across literals is
 *     seen whole;
 *   - a query-builder lock call (forUpdate / forShare / forNoKeyUpdate / forKeyShare) whose WHOLE chain
 *     (`outermostChain`: the links above the lock call too, and the chain a lock inside a callback belongs to)
 *     names `meta_sheets` — in any literal under it (an argument, an `as never` cast, a callback body) or through
 *     a same-file name it uses, resolved as above — one unit per chain, however many lock calls it has.
 * Comments are not nodes, so prose stays out, as before.
 */
function sqlUnitsIn(root: ts.Node, source: ts.SourceFile): SqlUnit[] {
  const resolved = new Map<ts.Node, string>()
  const resolving = new Set<ts.Node>()
  const nameText = (id: ts.Identifier): string => {
    const init = declarationInitializer(id)
    if (init === undefined || !composesString(init)) return ''
    const known = resolved.get(init)
    if (known !== undefined) return known
    // A declaration met again while it is being resolved contributes nothing more (a cycle).
    if (resolving.has(init)) return ''
    resolving.add(init)
    const text = textOf(init)
    resolving.delete(init)
    resolved.set(init, text)
    return text
  }

  const textOf = (e: ts.Node): string => {
    if (ts.isStringLiteralLike(e)) return e.text
    if (ts.isTemplateExpression(e)) {
      return [e.head.text, ...e.templateSpans.flatMap((s) => [textOf(s.expression), s.literal.text])].join(' ')
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
      || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) return textOf(e.expression)
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return textOf(e.left) + textOf(e.right)
    if (ts.isIdentifier(e)) return nameText(e)
    // Anything else (a conditional, a call, …): every literal and resolvable name nested in it, space-joined.
    // The `name` of `x.name` is a property, not a binding, so only `x` is resolved.
    const parts: string[] = []
    const nested = (m: ts.Node) => {
      if (ts.isStringLiteralLike(m) || ts.isTemplateExpression(m) || ts.isIdentifier(m)) parts.push(textOf(m))
      else if (ts.isPropertyAccessExpression(m)) nested(m.expression)
      else ts.forEachChild(m, nested)
    }
    ts.forEachChild(e, nested)
    return ` ${parts.join(' ')} `
  }
  const isPlus = (n: ts.Node): n is ts.BinaryExpression =>
    ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken

  const units: SqlUnit[] = []
  const builderChains = new Set<ts.Node>()
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      units.push({ node: n, text: textOf(n), builder: false })
    } else if (isPlus(n) && !isPlus(n.parent)) {
      units.push({ node: n, text: textOf(n), builder: false })
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      const receiver = n.expression.expression
      if (method === 'join' && ts.isArrayLiteralExpression(receiver)) {
        const sepArg = n.arguments[0]
        const sep = sepArg && ts.isStringLiteralLike(sepArg) ? sepArg.text : ','
        units.push({ node: n, text: receiver.elements.map(textOf).join(sep), builder: false })
      } else if (LOCK_BUILDER_METHODS.has(method)) {
        const chain = outermostChain(n)
        if (!builderChains.has(chain) && /\bmeta_sheets\b/i.test(textOf(chain))) {
          builderChains.add(chain)
          units.push({ node: chain, text: chain.getText(source), builder: true })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return units
}

/** One census entry at one site: the unit that carries it (outermost, see `censusSites`), its book and its text. */
interface CensusSite extends CensusEntry {
  unit: SqlUnit
}

/**
 * Every census entry under `root`, once per SITE. An entry that a nested unit repeats — a literal inside a `+`
 * chain or a `[].join`, a template inside another template's `${}` — belongs to the outermost unit carrying it
 * and is counted there once. Two separate literals with the same text are two sites, and count twice.
 */
function censusSites(root: ts.Node, source: ts.SourceFile): CensusSite[] {
  const units = sqlUnitsIn(root, source)
  const entriesAt = new Map<ts.Node, CensusEntry[]>()
  for (const unit of units) entriesAt.set(unit.node, unitCensusEntries(unit))
  const out: CensusSite[] = []
  for (const unit of units) {
    for (const entry of entriesAt.get(unit.node)!) {
      let covered = false
      for (let p = unit.node.parent; p !== undefined && !covered; p = p.parent) {
        covered = entriesAt.get(p)?.some((e) => e.book === entry.book && e.stmt === entry.stmt) ?? false
      }
      if (!covered) out.push({ ...entry, unit })
    }
  }
  return out
}

/** A unit's census entries: its SQL's (see `censusEntriesOf`), or a builder chain as one opaque lock. */
function unitCensusEntries(unit: SqlUnit): CensusEntry[] {
  return unit.builder ? [{ book: 'lock', stmt: collapse(unit.text) }] : censusEntriesOfText(unit.text)
}

/** Name of a called function (`foo` / `x.foo`), or ''. */
function calleeName(call: ts.CallExpression): string {
  const expr = call.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return ''
}

/**
 * What THIS transaction's own query is called inside its handler: `async ({ query }) => …` binds
 * `query`; `async (client) => …` binds `client.query`. '' when the handler takes no parameter at all —
 * then nothing inside it can be the transaction's query, and every re-check is foreign.
 *
 * The rule this feeds exists because the helper's contract is about WHICH CONNECTION holds the lock.
 * `assertSheetLiveForUpdate(pool.query.bind(pool), id)` reads perfectly, passes rule B's ordering, and
 * takes its row lock on a different connection in its own implicit transaction — released the instant it
 * returns. The writing transaction then holds nothing and the window is fully reopened.
 */
function txnQueryBinding(handler: ts.ArrowFunction | ts.FunctionExpression): string {
  const param = handler.parameters[0]
  if (!param) return ''
  if (ts.isIdentifier(param.name)) return `${param.name.text}.query`
  if (ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      const source = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : null
      const local = ts.isIdentifier(el.name) ? el.name.text : ''
      if ((source ?? local) === 'query') return local
    }
  }
  return ''
}

/** The first argument as written, for identifier/property-access forms; a kind tag otherwise. */
function firstArgText(call: ts.CallExpression, source: ts.SourceFile): string {
  const arg = call.arguments[0]
  if (!arg) return '(no argument)'
  if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) return arg.getText(source)
  return arg.getText(source).replace(/\s+/g, ' ')
}

function scanSource(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true)
  const txns: TxnBlock[] = []
  const rawLocks: RawLock[] = []
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1

  for (const { unit, book, stmt } of censusSites(source, source)) {
    if (book === 'lock') rawLocks.push({ file, line: lineOf(unit.node.getStart(source)), sql: stmt })
  }

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n) === 'transaction' && n.arguments.length > 0) {
      const handler = n.arguments[0]
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        const queryBinding = txnQueryBinding(handler)
        let recheckAt = -1
        let firstWriteAt = -1
        let firstWriteLabel = ''
        const foreignRechecks: string[] = []
        const noteWrite = (pos: number, label: string) => {
          if (firstWriteAt === -1 || pos < firstWriteAt) {
            firstWriteAt = pos
            firstWriteLabel = label
          }
        }
        const inner = (m: ts.Node) => {
          if (ts.isCallExpression(m)) {
            const name = calleeName(m)
            if (name === RECHECK) {
              // Only a re-check on THIS transaction's own query counts. One handed anything else
              // (a pool, a second client, a bound method) is recorded as a violation in its own
              // right rather than silently ignored — ignoring it would report the weaker
              // "no re-check at all", which a reader could fix by adding a second wrong one.
              const arg = firstArgText(m, source)
              if (queryBinding !== '' && arg === queryBinding) {
                if (recheckAt === -1 || m.getStart(source) < recheckAt) recheckAt = m.getStart(source)
              } else {
                foreignRechecks.push(arg)
              }
            }
            if (PERMISSION_APPLIERS.includes(name)) noteWrite(m.getStart(source), `${name}()`)
          }
          ts.forEachChild(m, inner)
        }
        ts.forEachChild(handler.body, inner)
        for (const { node: lit, text: sql } of literalsIn(handler.body)) {
          const table = writesPermissionTable(sql)
          if (table) noteWrite(lit.getStart(source), `write on ${table}`)
        }
        if (firstWriteAt !== -1) {
          txns.push({
            file,
            line: lineOf(n.getStart(source)),
            recheckAt,
            firstWriteAt,
            firstWriteLabel,
            queryBinding,
            foreignRechecks,
          })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return { txns, rawLocks }
}

/** Every `.ts` / `.js` / `.cjs` / `.mjs` file under `src/`, for the whole-tree census. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) srcFiles(full, out)
    else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

interface SourceCensus {
  /**
   * `<rel> :: <statement>` for every statement that locks a `meta_sheets` row — ONE ENTRY PER SITE, sorted: a
   * statement issued from two call sites appears twice.
   */
  locks: string[]
  /** `<rel> :: <statement>` for every statement that names `meta_sheets` beside a lock but does not lock it (per site). */
  besideLockNotLocking: string[]
}

/**
 * The census of ONE file's text. Prefiltered only on the table name (case-insensitive) — the former
 * prefilter also required `FOR UPDATE|SHARE` somewhere in the file, so a file whose only lock was
 * `FOR NO KEY UPDATE` / `FOR KEY SHARE` was never parsed. Then AST-parsed: a comment cannot produce a node,
 * so prose about `FOR UPDATE` neither enters nor is missing from the census.
 */
function censusOfSource(rel: string, rawText: string): SourceCensus {
  const locks: string[] = []
  const besideLockNotLocking: string[] = []
  const text = rawText.replace(/\r\n/g, '\n')
  if (!/meta_sheets/i.test(text)) return { locks: [], besideLockNotLocking: [] }
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  for (const { book, stmt } of censusSites(source, source)) {
    if (book === 'lock') locks.push(`${rel} :: ${stmt}`)
    else besideLockNotLocking.push(`${rel} :: ${stmt}`)
  }
  return { locks: locks.sort(), besideLockNotLocking: besideLockNotLocking.sort() }
}

/** Every collapsed SQL statement a file carries (for resolving an `under-lock` follow-up). */
function statementsOfFile(rel: string): string[] {
  const text = readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  return sqlUnitsIn(source, source).filter((u) => !u.builder).flatMap((u) => flatStatements(sqlStatements(u.text)))
}

/** `censusOfSource` over every file under `src/`. */
function censusOfSrcTree(): SourceCensus {
  const locks: string[] = []
  const besideLockNotLocking: string[] = []
  for (const file of srcFiles(SRC)) {
    const rel = file.slice(SRC.length + 1).split(sep).join('/')
    const found = censusOfSource(rel, readFileSync(file, 'utf8'))
    locks.push(...found.locks)
    besideLockNotLocking.push(...found.besideLockNotLocking)
  }
  return { locks: locks.sort(), besideLockNotLocking: besideLockNotLocking.sort() }
}

/**
 * The recognizer this census used BEFORE the #6065 follow-up, kept verbatim ONLY so the blindness it had can be
 * demonstrated against real source below (the same device as rule D's "a copied literal would NOT match").
 * Nothing else calls it.
 */
function legacyCensusOfSource(rel: string, rawText: string): string[] {
  const text = rawText.replace(/\r\n/g, '\n')
  if (!/meta_sheets/.test(text) || !/FOR\s+(?:UPDATE|SHARE)/i.test(text)) return []
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  const keys = new Set<string>()
  for (const { text: sql } of literalsIn(source)) {
    if (/\bFROM\s+meta_sheets\b/i.test(sql) && /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(sql)) {
      keys.add(`${rel} :: ${sql}`)
    }
  }
  return [...keys].sort()
}

function scanGuardedFiles(): Scan {
  const txns: TxnBlock[] = []
  const rawLocks: RawLock[] = []
  for (const rel of GUARDED_FILES) {
    const scan = scanSource(rel, readFileSync(join(SRC, rel), 'utf8'))
    txns.push(...scan.txns)
    rawLocks.push(...scan.rawLocks)
  }
  return { txns, rawLocks }
}

/** The analyzer's verdict, as a list of human-readable violations. */
function violations(scan: Scan): string[] {
  const out: string[] = []
  for (const lock of scan.rawLocks) {
    if (!RAW_LOCK_LEDGER.has(lock.sql)) {
      out.push(`${lock.file}:${lock.line} takes a raw meta_sheets row lock — use ${RECHECK} (or ledger it): ${lock.sql}`)
    }
  }
  for (const txn of scan.txns) {
    for (const arg of txn.foreignRechecks) {
      out.push(
        `${txn.file}:${txn.line} calls ${RECHECK} with \`${arg}\` instead of this transaction's own query`
        + `${txn.queryBinding ? ` (\`${txn.queryBinding}\`)` : ''} — that locks a row on another connection`,
      )
    }
    if (txn.recheckAt === -1) {
      out.push(`${txn.file}:${txn.line} writes a permission table (${txn.firstWriteLabel}) with no ${RECHECK} in the transaction`)
    } else if (txn.recheckAt > txn.firstWriteAt) {
      out.push(`${txn.file}:${txn.line} calls ${RECHECK} AFTER its first write (${txn.firstWriteLabel})`)
    }
  }
  return out
}

describe('#5938 — permission write transactions re-check sheet liveness under the lock', () => {
  const scan = scanGuardedFiles()

  it('finds the access-control write transactions at all (anti-vacuity)', () => {
    // Nine today: legacy grant + legacy revoke; forward sheet / view / field permission PUTs; the
    // permission-revert execute branch; the two sheet_config read-deny writers (row-level switch,
    // conditional rules); and the stock-prep plugin port. A scan that found none would make every leg
    // below vacuous.
    expect(scan.txns.length, `discovered: ${scan.txns.map((t) => `${t.file}:${t.line}`).join(', ')}`)
      .toBeGreaterThanOrEqual(9)
    // …and from EVERY door. A scan that lost one file (a rename, an unreadable `.transaction` shape)
    // would still clear the count above while covering only part of the surface.
    const perFile = new Map<string, number>()
    for (const txn of scan.txns) perFile.set(txn.file, (perFile.get(txn.file) ?? 0) + 1)
    expect(perFile.get('routes/spreadsheet-permissions.ts') ?? 0).toBeGreaterThanOrEqual(2)
    expect(perFile.get('routes/univer-meta.ts') ?? 0).toBeGreaterThanOrEqual(6)
    expect(perFile.get('services/stock-preparation-field-permissions.ts') ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('the two sheet_config read-deny writers are among them — not merely outside the table list', () => {
    // These write `meta_sheets` itself, so a guard scoped to "permission TABLES" would have called them
    // clean by omission. Named here so removing the column detector reds instead of shrinking silently.
    const labels = scan.txns.map((t) => t.firstWriteLabel)
    expect(labels).toContain('write on meta_sheets.row_level_read_permissions_enabled')
    expect(labels).toContain('write on meta_sheets.conditional_read_rules')
  })

  it('every re-check is handed the transaction\'s own query — never a pool', () => {
    const foreign = scan.txns.flatMap((t) => t.foreignRechecks.map((a) => `${t.file}:${t.line} ← ${a}`))
    expect(foreign).toEqual([])
    // …and each site really does bind one (a handler with no parameter would make the rule vacuous).
    expect(scan.txns.filter((t) => t.queryBinding === '')).toEqual([])
  })

  it('every permission write transaction re-checks liveness before its first write', () => {
    expect(violations({ txns: scan.txns, rawLocks: [] })).toEqual([])
  })

  it('no raw meta_sheets row lock survives outside the named ledger', () => {
    expect(violations({ txns: [], rawLocks: scan.rawLocks })).toEqual([])
  })

  it('every ledgered raw lock still exists — a stale exemption is removed, not left as licence', () => {
    const present = new Set(scan.rawLocks.map((l) => l.sql))
    for (const sql of RAW_LOCK_LEDGER.keys()) {
      expect(present.has(sql), `ledger entry no longer matches any lock: ${sql}`).toBe(true)
    }
  })

  it('WHOLE TREE: every meta_sheets row lock under src/ is named, in any file, lock mode and spelling', () => {
    // The rules above are file-scoped; this one is not. A tenth site in a file nobody pointed the guard at —
    // which is exactly how the stock-prep port kept the pre-fix shape — reds here until it is named with what
    // it guards and a liveness verdict.
    // Compared PER SITE: a second call site repeating a named statement is one more entry here, not absorbed.
    const { locks: found } = censusOfSrcTree()
    expect(found).toEqual(expectedCensusSites(SHEET_ROW_LOCK_CENSUS))
    // Anti-vacuity: a walker that silently found nothing would make the equality above trivially true
    // against an empty ledger, and nothing here would notice.
    expect(found.length).toBeGreaterThanOrEqual(10)
    expect(new Set(found).size).toBeGreaterThanOrEqual(9)
    for (const entry of SHEET_ROW_LOCK_CENSUS.values()) expect(entry.sites ?? 1).toBeGreaterThanOrEqual(1)
    expect(found.some((k) => k.startsWith('multitable/sheet-liveness.ts ::'))).toBe(true)
    // …and the widening itself cannot silently regress: at least one key is ONLY visible through a JOIN
    // (`FROM meta_records …`), and at least one only through a schema-qualified name.
    expect(found.some((k) => /:: .*\bJOIN meta_sheets\b/.test(k) && !/\bFROM meta_sheets\b/.test(k))).toBe(true)
    expect(found.some((k) => /\bpublic\.meta_sheets\b/.test(k))).toBe(true)
    for (const entry of SHEET_ROW_LOCK_CENSUS.values()) expect(entry.reason.length).toBeGreaterThan(40)
  })

  it('WHOLE TREE: every statement naming meta_sheets beside a lock it does NOT take is named too', () => {
    // The recognizer's exclusion path (`FOR … OF` naming only other relations) is where a lock could leak out of
    // the census without a sound; ledgering what it excludes makes that path visible.
    // Per site as well: each named statement is issued from exactly one site today, so a second one reds here.
    const { besideLockNotLocking } = censusOfSrcTree()
    expect(besideLockNotLocking).toEqual([...SHEET_MENTIONED_BESIDE_LOCK_NOT_A_ROW_LOCK.keys()].sort())
    for (const key of besideLockNotLocking) {
      const stmt = key.slice(key.indexOf(' :: ') + 4)
      expect(lockClauses(stmt).every((c) => c.of.length > 0), key).toBe(true)
    }
  })

  it('LIVENESS: an `in-statement` verdict is true of the statement text itself', () => {
    const inStatement = [...SHEET_ROW_LOCK_CENSUS].filter(([, e]) => e.liveness === 'in-statement')
    expect(inStatement.length).toBeGreaterThanOrEqual(4)
    for (const [key] of inStatement) {
      expect(statementReadsSheetDeletedAt(key.slice(key.indexOf(' :: ') + 4)), key).toBe(true)
    }
    // …and no entry that could have claimed it is filed as anything weaker without a reason to (a statement that
    // DOES read the sheet's deleted_at is `in-statement`, full stop).
    for (const [key, entry] of SHEET_ROW_LOCK_CENSUS) {
      if (statementReadsSheetDeletedAt(key.slice(key.indexOf(' :: ') + 4))) expect(entry.liveness, key).toBe('in-statement')
    }
  })

  it('LIVENESS: an `under-lock` verdict names a follow-up statement that still exists and still reads deleted_at', () => {
    const underLock = [...SHEET_ROW_LOCK_CENSUS].filter(([, e]) => e.liveness === 'under-lock')
    expect(underLock.length).toBeLessThanOrEqual(SHEET_LIVENESS_UNDER_LOCK_CEILING)
    for (const [key, entry] of underLock) {
      expect(entry.followUp, `${key} needs a followUp`).toBeTruthy()
      const [file, stmt] = entry.followUp!.split(' :: ')
      expect(statementsOfFile(file), `${key} → followUp not found in ${file}`).toContain(stmt)
      expect(stmt).toMatch(/\bdeleted_at\b/)
    }
    // A followUp on any other verdict would be decoration.
    for (const [key, entry] of SHEET_ROW_LOCK_CENSUS) {
      if (entry.liveness !== 'under-lock') expect(entry.followUp, key).toBeUndefined()
    }
  })

  it('LIVENESS GAPS: exactly the ledgered keys, and the ledger only shrinks', () => {
    const gaps = [...SHEET_ROW_LOCK_CENSUS].filter(([, e]) => e.liveness === 'gap').map(([k]) => k).sort()
    expect(gaps).toEqual([...KNOWN_SHEET_LIVENESS_GAPS].sort())
    expect(KNOWN_SHEET_LIVENESS_GAPS.length).toBeLessThanOrEqual(SHEET_LIVENESS_GAP_CEILING)
    expect(SHEET_LIVENESS_GAP_CEILING).toBe(3)
    // A gap is a lock that does NOT read liveness in its own statement — otherwise it is not a gap.
    for (const key of gaps) expect(statementReadsSheetDeletedAt(key.slice(key.indexOf(' :: ') + 4)), key).toBe(false)
  })

  it('the census recognizes every lock mode, and nothing that is not a lock', () => {
    expect(locksSheetRow('SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR NO KEY UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR KEY SHARE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE SKIP LOCKED')).toBe(true)
    expect(locksSheetRow('select id from meta_sheets where id = $1 for no key update nowait')).toBe(true)
    expect(locksSheetRow('SELECT deleted_at FROM meta_sheets WHERE id = $1')).toBe(false)
    expect(locksSheetRow('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE')).toBe(false)
    // A different relation that merely STARTS with the name is not the sheet table.
    expect(locksSheetRow('SELECT id FROM meta_sheets_archive WHERE id = $1 FOR UPDATE')).toBe(false)
    // #5954: the multi-sheet helper's statement joins meta_sheets to an `unnest … WITH ORDINALITY`.
    expect(locksSheetRow(SHEETS_ROW_LOCK_LIVENESS_SQL)).toBe(true)
  })

  it('the ledger is EMPTY — the cross-base mirror op\'s former lock-only residual is closed, not licensed (#5954)', () => {
    // The one entry this ledger used to carry (the mirror op's `SELECT id … = ANY($1) … FOR UPDATE`) is
    // gone because the site is gone. Re-adding it — or any other raw lock — must be a visible choice here.
    expect([...RAW_LOCK_LEDGER.keys()]).toEqual([])
    // …and the guarded files really do spell no raw sheet-row lock any more (rule A with nothing to excuse).
    expect(scan.rawLocks.map((l) => `${l.file}:${l.line} ${l.sql}`)).toEqual([])
  })
})

/**
 * #6065 follow-up — the census recognizes every spelling of a sheet-row lock, and the pre-widening recognizer
 * provably did not. Synthetic statements first (each spelling on its own), then the two blind spots #6065 found,
 * injected into the REAL route source in memory: the old recognizer reports nothing new (green by omission), the
 * new one reports exactly the injected statement, which is in no ledger (red).
 */
describe('#6065 follow-up — the sheet-row lock census sees every spelling', () => {
  const units = (src: string) => {
    const source = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true)
    return sqlUnitsIn(source, source)
  }
  const locksIn = (src: string) => censusOfSource('probe.ts', src).locks

  it('schema-qualified and quoted relation names', () => {
    expect(locksSheetRow('SELECT id FROM public.meta_sheets WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM public . meta_sheets WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM "meta_sheets" WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM public."meta_sheets" WHERE id = $1 FOR SHARE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM "public"."meta_sheets" AS "S" WHERE "S".id = $1 FOR UPDATE OF "S"')).toBe(true)
    expect(locksSheetRow('SELECT id FROM PUBLIC.META_SHEETS WHERE id = $1 FOR UPDATE')).toBe(true)
  })

  it('a sheet row locked through a JOIN — by alias, by bare name, and with no OF list at all', () => {
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id WHERE r.id = $1 FOR SHARE OF s')).toBe(true)
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets AS sheet ON sheet.id = r.sheet_id FOR UPDATE OF r, sheet NOWAIT')).toBe(true)
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets ON meta_sheets.id = r.sheet_id FOR KEY SHARE OF meta_sheets')).toBe(true)
    // No OF: PostgreSQL locks every relation in FROM, the joined sheet included.
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id WHERE r.id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT r.id FROM meta_records r, public.meta_sheets s WHERE s.id = r.sheet_id FOR NO KEY UPDATE')).toBe(true)
    // Several clauses: one of them reaching the sheet is enough.
    expect(locksSheetRow('SELECT 1 FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF r FOR SHARE OF s')).toBe(true)
  })

  it('OF naming ONLY other relations does not lock the sheet — and anything unresolvable counts as a lock', () => {
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF r')).toBe(false)
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF meta_records')).toBe(false)
    // An OF target that is no relation this statement names (a mis-parsed alias, a view): conservatively a lock.
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF mystery')).toBe(true)
    // A sub-select in FROM: `OF sub` locks the sheet rows inside it; `sub` is no registered relation, so it counts.
    expect(locksSheetRow('SELECT sub.id FROM (SELECT id FROM meta_sheets WHERE id = $1) sub FOR UPDATE OF sub')).toBe(true)
    expect(locksSheetRow('SELECT sub.id FROM (SELECT id FROM meta_sheets WHERE id = $1) sub FOR UPDATE')).toBe(true)
    // …while `OF r` beside such a sub-select locks only `r`.
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN (SELECT id FROM meta_sheets) sh ON sh.id = r.sheet_id FOR UPDATE OF r')).toBe(false)
    // …while a statement with no lock clause, or naming the sheet only in prose-free columns, is not a lock.
    expect(locksSheetRow('SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id = s.base_id')).toBe(false)
  })

  it('several statements in one literal: a lock is attributed to its own statement only', () => {
    expect(locksSheetRow('SELECT 1 FROM meta_sheets WHERE id = $1; SELECT 1 FROM meta_records WHERE id = $2 FOR UPDATE')).toBe(false)
    expect(locksSheetRow('PERFORM 1 FROM meta_records WHERE id = $2 FOR UPDATE; PERFORM 1 FROM public.meta_sheets WHERE id = $1 FOR SHARE;')).toBe(true)
    // A `;` inside a quoted string does not split the statement it sits in.
    expect(locksSheetRow("SELECT id FROM meta_sheets WHERE name <> 'a;b' FOR UPDATE")).toBe(true)
  })

  it('multi-line templates, concatenation, [].join, interpolated lock clauses and builder chains are all seen', () => {
    expect(locksIn('const q = `SELECT s.id\n  FROM meta_records r\n  JOIN public.meta_sheets s\n    ON s.id = r.sheet_id\n FOR SHARE OF s`')).toEqual([
      'probe.ts :: SELECT s.id FROM meta_records r JOIN public.meta_sheets s ON s.id = r.sheet_id FOR SHARE OF s',
    ])
    expect(locksIn("await query('SELECT id FROM meta_sheets ' + 'WHERE id = $1 ' + 'FOR UPDATE', [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    expect(locksIn("await query(['SELECT id', 'FROM meta_sheets', 'WHERE id = $1', 'FOR UPDATE'].join('\\n'), [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    expect(locksIn("await query(`SELECT id FROM meta_sheets WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    expect(locksIn("const LOCK = 'FOR NO KEY UPDATE'\nawait query(`SELECT id FROM meta_sheets WHERE id = $1 ${LOCK}`, [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR NO KEY UPDATE',
    ])
    const builder = locksIn("await trx.selectFrom('meta_sheets').select('id').where('id', '=', id).forUpdate().execute()")
    expect(builder).toHaveLength(1)
    expect(builder[0]).toContain(".selectFrom('meta_sheets')")
    // A builder lock on another table is not a sheet lock.
    expect(locksIn("await trx.selectFrom('data_sources').select('id').forUpdate().execute()")).toEqual([])
    // Prose is still not SQL.
    expect(units('// SELECT id FROM public.meta_sheets FOR UPDATE\nconst x = 1')).toEqual([])
  })

  it('the file prefilter no longer requires `FOR UPDATE|SHARE`: a file whose only lock is FOR NO KEY UPDATE / KEY SHARE is parsed', () => {
    const onlyNoKey = "await query('SELECT id FROM meta_sheets WHERE id = ANY($1) FOR NO KEY UPDATE NOWAIT', [ids])"
    const onlyKeyShare = "await query('SELECT id FROM Meta_Sheets WHERE id = $1 FOR KEY SHARE', [id])"
    expect(legacyCensusOfSource('probe.ts', onlyNoKey)).toEqual([])
    expect(locksIn(onlyNoKey)).toHaveLength(1)
    expect(legacyCensusOfSource('probe.ts', onlyKeyShare)).toEqual([])
    expect(locksIn(onlyKeyShare)).toHaveLength(1)
  })

  it('statementReadsSheetDeletedAt reads the SHEET\'s deleted_at, qualified or alone — not a sibling relation\'s', () => {
    expect(statementReadsSheetDeletedAt('SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(statementReadsSheetDeletedAt(SHEETS_ROW_LOCK_LIVENESS_SQL)).toBe(true)
    expect(statementReadsSheetDeletedAt('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id AND s.deleted_at IS NULL FOR SHARE OF s')).toBe(true)
    expect(statementReadsSheetDeletedAt('SELECT id FROM public.meta_sheets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE')).toBe(true)
    expect(statementReadsSheetDeletedAt('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE')).toBe(false)
    // The base's deleted_at is not the sheet's.
    expect(statementReadsSheetDeletedAt('SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id = s.base_id WHERE b.deleted_at IS NULL FOR SHARE OF s')).toBe(false)
    // Unqualified beside a second relation is ambiguous, so it does not count.
    expect(statementReadsSheetDeletedAt('SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id = s.base_id WHERE deleted_at IS NULL FOR SHARE OF s')).toBe(false)
  })

  describe('the two #6065 blind spots, injected into the REAL route source (in memory)', () => {
    const ROUTE = 'routes/univer-meta.ts'
    const routeSource = readFileSync(join(SRC, ROUTE), 'utf8').replace(/\r\n/g, '\n')
    const inject = (sql: string) => `${routeSource}
router.post('/census-probe/:recordId', async (req: Request, res: Response) => {
  const pool = poolManager.get()
  await pool.transaction(async ({ query }) => {
    await query(\`${sql}\`, [req.params.recordId])
  })
  return res.json({ ok: true })
})
`
    const JOIN_PROBE = 'SELECT r.id FROM meta_records r\n      JOIN meta_sheets s ON s.id = r.sheet_id\n     WHERE r.id = $1\n     FOR SHARE OF s'
    const PUBLIC_PROBE = 'SELECT id FROM public.meta_sheets\n     WHERE id = $1\n     FOR UPDATE'

    for (const [label, probe] of [['JOIN … FOR SHARE OF s', JOIN_PROBE], ['public.meta_sheets … FOR UPDATE', PUBLIC_PROBE]] as const) {
      it(`${label}: the pre-widening census misses it; the census reds on it; rule A reds on it`, () => {
        const mutated = inject(probe)
        // OLD: no new key — the census equality would have stayed green with an unnamed, unchecked lock.
        expect(legacyCensusOfSource(ROUTE, mutated)).toEqual(legacyCensusOfSource(ROUTE, routeSource))
        // NEW: exactly the injected statement, which no ledger names …
        const before = censusOfSource(ROUTE, routeSource).locks
        const added = censusOfSource(ROUTE, mutated).locks.filter((k) => !before.includes(k))
        expect(added).toEqual([`${ROUTE} :: ${collapse(probe)}`])
        expect(SHEET_ROW_LOCK_CENSUS.has(added[0])).toBe(false)
        // … and which does not read liveness, so no verdict but `gap` could fit it — and the gap ledger is closed.
        expect(statementReadsSheetDeletedAt(collapse(probe))).toBe(false)
        expect(KNOWN_SHEET_LIVENESS_GAPS).not.toContain(added[0])
        // Rule A (the guarded permission files) sees it too.
        expect(violations({ txns: [], rawLocks: scanSource(ROUTE, mutated).rawLocks }).join('\n')).toContain('raw meta_sheets row lock')
      })
    }
  })
})

/**
 * #6085 review — four ways a real sheet-row lock still slipped past the widened census, each closed here:
 *   1. a `;` inside a SQL comment or a dollar-quoted string split the statement, so neither half held both the table
 *      and the lock clause (a regression against main, whose recognizer never split); `FOR /* x *\/ UPDATE` hid the
 *      clause outright. Closed by a lexer that sees statement boundaries as PostgreSQL does, plus a second look AS
 *      WRITTEN for anything in neither book, so what the lexer sets aside can add to the census and never subtract;
 *   2. a `${name}` followed only `const X = '…'`, not the conditional / `as const` / template initializers the tree
 *      already uses (routes/attendance-admin.ts builds its lock clause as `lock ? 'FOR SHARE OF …' : ''`);
 *   3. the census keyed a Set on `<file> :: <statement>`, so a NEW call site repeating a named statement was
 *      absorbed by that name and silently inherited its site-specific verdict;
 *   4. a builder lock was recognized only from the lock call's receiver chain, so `.$if(lock, (qb) => qb.forUpdate())`
 *      and a sheet joined after the lock call were missed.
 */
describe('#6085 review — comments, dollar quotes, composed declarations, sites and whole builder chains', () => {
  const locksIn = (src: string) => censusOfSource('probe.ts', src).locks

  it('1. a `;` inside a comment or a dollar-quoted string does not cut a lock out of its statement', () => {
    expect(locksSheetRow('SELECT id FROM meta_sheets -- pin the row; the write follows\n WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets /* pin; see #5938 */ WHERE id = $1 FOR UPDATE')).toBe(true)
    // PostgreSQL nests block comments: the first `*/` does not end this one.
    expect(locksSheetRow('SELECT id FROM meta_sheets /* outer /* inner; */ still a comment; */ WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 AND name <> $$a;b$$ FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 AND name <> $q$a;b$q$ FOR UPDATE')).toBe(true)
    // An E'' string takes backslash escapes: `\'` does not close it, so its `;` is text.
    expect(locksSheetRow("SELECT id FROM meta_sheets WHERE id = $1 AND name <> E'it\\'s; fine' FOR UPDATE")).toBe(true)
    // Two escaped quotes: read as plain '…' strings the text would still close cleanly, with the `;` OUTSIDE them.
    expect(locksSheetRow("SELECT id FROM meta_sheets WHERE id = $1 AND name <> E'a\\'b; c\\'d' FOR UPDATE")).toBe(true)
    // …while a `;` outside all of them still separates statements (attribution per statement is unchanged).
    expect(locksSheetRow('SELECT 1 FROM meta_sheets WHERE id = $1 /* read */; SELECT 1 FROM meta_records WHERE id = $2 FOR UPDATE')).toBe(false)
  })

  it('1. a comment inside the lock clause does not hide it', () => {
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR /* x */ UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1 FOR -- x\n NO KEY UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR SHARE OF /* the sheet */ s')).toBe(true)
  })

  it('1. a dollar-quoted body is SQL of its own: a lock inside it is seen, and attributed to its own statement', () => {
    expect(locksSheetRow('CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN PERFORM 1 FROM meta_sheets WHERE id = 1 FOR UPDATE; END $fn$ LANGUAGE plpgsql')).toBe(true)
    expect(locksSheetRow('DO $$ BEGIN PERFORM 1 FROM meta_sheets WHERE id = 1; PERFORM 1 FROM meta_records WHERE id = 2 FOR UPDATE; END $$')).toBe(false)
  })

  it('1. what the lexer sets aside can ADD a statement to the census, never take one out (the as-written second look)', () => {
    // The key is the statement as PostgreSQL runs it whenever that alone puts it in a book: comments gone.
    expect(locksIn('await query(`SELECT id FROM meta_sheets -- pin; then\n WHERE id = $1 FOR /* x */ UPDATE`, [id])')).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    // Prose in a SQL comment that names the table beside a lock clause is filed AS WRITTEN — an over-count: loud, named.
    expect(censusEntriesOfText('SELECT id FROM meta_records -- joins meta_sheets later\n WHERE id = $1 FOR UPDATE')).toEqual([
      { book: 'lock', stmt: 'SELECT id FROM meta_records -- joins meta_sheets later WHERE id = $1 FOR UPDATE' },
    ])
    expect(locksSheetRow('SELECT id FROM meta_sheets /* FOR UPDATE would go here */ WHERE id = $1')).toBe(true)
    // …which is what stops an APPROXIMATED comment from hiding a real lock: `${debug ? '-- …' : 'FOR UPDATE'}` is read
    // as both branches at once, so the first branch's comment swallows the second in the comment-free view.
    const branches = "await query(`SELECT id FROM meta_sheets WHERE id = $1 ${debug ? '-- no lock while debugging' : 'FOR UPDATE'}`, [id])"
    expect(locksIn(branches)).toHaveLength(1)
    const branchSource = ts.createSourceFile('probe.ts', branches, ts.ScriptTarget.Latest, true)
    const [branchUnit] = sqlUnitsIn(branchSource, branchSource).filter((u) => ts.isTemplateExpression(u.node))
    const [branchStatement] = sqlStatements(branchUnit.text)
    expect(bookOf(branchStatement.sql)).toBe(null) // the comment-free view alone would lose it
    expect(bookOf(branchStatement.asWritten)).toBe('lock')
    // A table name in a one-statement dollar string meets a lock clause outside it only in dynamic SQL — filed too.
    expect(locksSheetRow("EXECUTE $q$SELECT id FROM meta_sheets WHERE id = $1$q$ || ' FOR UPDATE' USING sheet_id")).toBe(true)
    // A segment that is only a comment runs nothing and files nothing.
    expect(censusEntriesOfText('SELECT 1; -- SELECT id FROM meta_sheets FOR UPDATE')).toEqual([])
    // A MULTI-statement body stays out of the second look: its statements are judged on their own, so a lock in one is
    // not pinned on a meta_sheets mention in another (the shape of three real migration trigger functions).
    expect(censusEntriesOfText(
      'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1 FROM meta_records WHERE id = NEW.id '
      + 'FOR KEY SHARE; UPDATE meta_sheets SET updated_at = now() WHERE id = NEW.sheet_id; RETURN NEW; END $fn$',
    )).toEqual([])
  })

  it('1. comment markers inside quotes are not comments, `$1` is not a dollar quote, and unclosed text is judged whole', () => {
    expect(locksSheetRow("SELECT id FROM meta_sheets WHERE name <> '--' FOR UPDATE")).toBe(true)
    expect(locksSheetRow("SELECT id FROM meta_sheets WHERE name <> '/*' FOR UPDATE")).toBe(true)
    // Text the lexer cannot close is judged whole: an unterminated dollar body cannot swallow the lock clause — not
    // even when its unclosed body splits into several statements (which the as-written second look leaves out).
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE note = $x$ FOR UPDATE')).toBe(true)
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE note = $x$ it is; FOR UPDATE')).toBe(true)
    // `$1` is a parameter, not a dollar quote: the `;` after it still ends the statement.
    expect(locksSheetRow('SELECT id FROM meta_sheets WHERE id = $1; SELECT id FROM meta_records WHERE id = $2 FOR UPDATE')).toBe(false)
  })

  it('2. a same-file declaration is followed whatever composes it: conditional, `as const`, `satisfies`, template, `+`, another name', () => {
    // routes/attendance-admin.ts: `const lockClause = lockMembership ? 'FOR SHARE OF u, uo' : ''`, interpolated.
    expect(locksIn("const lockClause = lock ? 'FOR UPDATE' : ''\nawait query(`SELECT id FROM meta_sheets WHERE id = $1 ${lockClause}`, [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    expect(locksIn("const lockClause = lock\n  ? scoped ? 'FOR SHARE OF s' : 'FOR SHARE'\n  : ''\nawait query(`SELECT s.id FROM meta_sheets s WHERE s.id = $1 ${lockClause}`, [id])")).toHaveLength(1)
    expect(locksIn("const T = 'meta_sheets' as const\nawait query(`SELECT id FROM ${T} WHERE id = $1 FOR UPDATE`, [id])")).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
    ])
    expect(locksIn("const L = ('FOR UPDATE' satisfies string)\nawait query(`SELECT id FROM meta_sheets WHERE id = $1 ${L}`, [id])")).toHaveLength(1)
    expect(locksIn("const TABLE = 'public.' + 'meta_sheets'\nconst FROM_SHEETS = `FROM ${TABLE}`\nconst LOCK = FOR_UPDATE\nconst FOR_UPDATE = `FOR ${'UPDATE'}`\nawait query(`SELECT id ${FROM_SHEETS} WHERE id = $1 ${LOCK}`, [id])")).toEqual([
      'probe.ts :: SELECT id FROM public.meta_sheets WHERE id = $1 FOR UPDATE',
    ])
  })

  it('2. …resolved by lexical scope, never through a call\'s RESULT, and never from a property name', () => {
    // `opts.lock` reads a property; the file-level `lock` binding is not what it names.
    expect(locksIn("const lock = 'FOR UPDATE'\nfunction f(opts: { lock: boolean }) { return query(`SELECT id FROM meta_sheets WHERE id = $1 ${opts.lock ? '' : ''}`, [id]) }")).toEqual([])
    // The same name in another function is another binding: `b`'s empty clause is not `a`'s lock.
    expect(locksIn("function a() { const L = 'FOR UPDATE'; return query(`SELECT id FROM meta_records WHERE id = $1 ${L}`, [id]) }\nfunction b() { const L = ''; return query(`SELECT id FROM meta_sheets WHERE id = $1 ${L}`, [id]) }")).toEqual([])
    // A query's result is a value the SQL never contains: its text is another statement, not part of this one.
    expect(locksIn("const r = await query('SELECT id FROM meta_sheets WHERE id = $1', [id])\nawait query(`SELECT id FROM meta_records WHERE sheet_id = '${r.rows[0].id}' FOR UPDATE`, [])")).toEqual([])
    // A cycle terminates.
    expect(() => locksIn("const a = b + ' FOR UPDATE'\nconst b = a + ' FROM meta_sheets'\nawait query(`SELECT id ${a}`, [])")).not.toThrow()
  })

  it('3. the census counts SITES: a second call site repeating a statement is a second entry', () => {
    const twice = "await query('SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE', [a])\nawait query('SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE', [b])"
    expect(locksIn(twice)).toEqual([
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE',
      'probe.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE',
    ])
    // …while ONE site is one entry however it is assembled: a literal inside a `+` chain, a `[].join` or a template's
    // `${}` belongs to the unit around it.
    expect(locksIn("await query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE' + '', [id])")).toHaveLength(1)
    expect(locksIn("await query(['SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE'].join('\\n'), [id])")).toHaveLength(1)
    expect(locksIn("await query(`${'SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE'}`, [id])")).toHaveLength(1)
  })

  it('3. a new call site in the REAL fence file, repeating its named NOWAIT statement, is one entry the ledger does not cover', () => {
    const FENCE = 'multitable/link-writer-fence.ts'
    const KEY = `${FENCE} :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT`
    const fenceSource = readFileSync(join(SRC, FENCE), 'utf8').replace(/\r\n/g, '\n')
    const mutated = `${fenceSource}
export async function censusProbeSecondSite(query: QueryFn, sheetId: string): Promise<void> {
  await query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT', [sheetId])
}
`
    const before = censusOfSource(FENCE, fenceSource).locks
    const after = censusOfSource(FENCE, mutated).locks
    expect(after).toHaveLength(before.length + 1)
    expect(after.filter((k) => k === KEY)).toHaveLength(2)
    // The ledger names one site for this key, so the WHOLE TREE equality would red on the second.
    expect(expectedCensusSites(SHEET_ROW_LOCK_CENSUS).filter((k) => k === KEY)).toHaveLength(1)
    // Keyed as a Set (the pre-review shape), nothing would have changed at all.
    expect([...new Set(after)]).toEqual([...new Set(before)])
  })

  it('4. a builder lock is seen wherever its chain names meta_sheets: above the lock call, in a callback, behind a cast', () => {
    // `$if`: the lock call's own receiver is just `qb`.
    expect(locksIn("await trx.selectFrom('meta_sheets').select('id').where('id', '=', id).$if(lock, (qb) => qb.forUpdate()).execute()")).toHaveLength(1)
    expect(locksIn("await trx.selectFrom('meta_sheets').select('id').$if(lock, (qb) => { return qb.forShare() }).execute()")).toHaveLength(1)
    // The sheet joined AFTER the lock call: FOR UPDATE without OF locks every relation in FROM, the joined sheet too.
    expect(locksIn("await trx.selectFrom('meta_records as r').forUpdate().innerJoin('meta_sheets as s', 's.id', 'r.sheet_id').select('r.id').execute()")).toHaveLength(1)
    // The table name behind a cast (DataSourceManager's `'data_sources' as never` idiom), or through a same-file name.
    expect(locksIn("await trx.selectFrom('meta_sheets' as never).select('id' as never).forUpdate().execute()")).toHaveLength(1)
    expect(locksIn("const T = 'meta_sheets' as const\nawait trx.selectFrom(T).select('id').where('id', '=', id).forUpdate().execute()")).toHaveLength(1)
    // One chain is one site, however many lock calls it carries.
    expect(locksIn("await trx.selectFrom('meta_sheets').select('id').forUpdate().noWait().forUpdate().execute()")).toHaveLength(1)
    // The climb stops at an `await`: the other statements of a transaction body are not this chain.
    expect(locksIn("await db.transaction().execute(async (trx) => {\n  await trx.selectFrom('data_sources').select('id').forUpdate().execute()\n  await trx.selectFrom('meta_sheets').select('id').execute()\n})")).toEqual([])
  })

  describe('the `;`-in-a-comment and `$$` forms, injected into the REAL route source (in memory)', () => {
    const ROUTE = 'routes/univer-meta.ts'
    const routeSource = readFileSync(join(SRC, ROUTE), 'utf8').replace(/\r\n/g, '\n')
    const inject = (sql: string) => `${routeSource}
router.post('/census-probe/:recordId', async (req: Request, res: Response) => {
  const pool = poolManager.get()
  await pool.transaction(async ({ query }) => {
    await query(\`${sql}\`, [req.params.recordId])
  })
  return res.json({ ok: true })
})
`
    const PROBES = [
      ['-- comment carrying `;`', 'SELECT 1 FROM meta_sheets -- lock the sheet; then write\n     WHERE id = $1\n     FOR UPDATE', 'SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE'],
      ['/* comment */ carrying `;`', 'SELECT 1 FROM meta_sheets /* pin; see #5938 */ WHERE id = $1 FOR UPDATE', 'SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE'],
      ['$$ string carrying `;`', 'SELECT 1 FROM meta_sheets WHERE id = $1 AND name <> $$a;b$$ FOR UPDATE', 'SELECT 1 FROM meta_sheets WHERE id = $1 AND name <> $$…$$ FOR UPDATE'],
    ] as const

    for (const [label, probe, statement] of PROBES) {
      it(`${label}: main's census saw it, and so do this census and rule A — no narrower than main`, () => {
        const mutated = inject(probe)
        // main's recognizer never split, so it saw these; the widened one must not be narrower on them.
        expect(legacyCensusOfSource(ROUTE, mutated)).toHaveLength(legacyCensusOfSource(ROUTE, routeSource).length + 1)
        const before = censusOfSource(ROUTE, routeSource).locks
        const added = censusOfSource(ROUTE, mutated).locks.filter((k) => !before.includes(k))
        expect(added).toEqual([`${ROUTE} :: ${statement}`])
        expect(SHEET_ROW_LOCK_CENSUS.has(added[0])).toBe(false)
        expect(violations({ txns: [], rawLocks: scanSource(ROUTE, mutated).rawLocks }).join('\n')).toContain('raw meta_sheets row lock')
      })
    }
  })
})

describe('#5938 — the analyzer rejects the pre-fix shape and accepts the fixed one', () => {
  const PRE_FIX = `
    async function grant(req: any, res: any) {
      await transaction(async ({ query }) => {
        await query('SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE', [req.params.id])
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  const FIXED = `
    async function grant(req: any, res: any) {
      await transaction(async ({ query }) => {
        await assertSheetLiveForUpdate(query, req.params.id)
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  const RECHECK_AFTER_WRITE = `
    async function grant(req: any, res: any) {
      await transaction(async ({ query }) => {
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
        await assertSheetLiveForUpdate(query, req.params.id)
      })
    }
  `
  const PROSE_ONLY = `
    async function grant(req: any, res: any) {
      // SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE — prose only
      await transaction(async ({ query }) => {
        await assertSheetLiveForUpdate(query, req.params.id)
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  /** Reads right, passes the ordering rule, and holds NOTHING: the lock is on another connection. */
  const POOL_QUERY_RECHECK = `
    async function grant(req: any, res: any) {
      await transaction(async ({ query }) => {
        await assertSheetLiveForUpdate(pool.query.bind(pool), req.params.id)
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  /** The same hole in its other spelling: a SECOND client, not the one this transaction runs on. */
  const OTHER_CLIENT_RECHECK = `
    async function grant(req: any, res: any) {
      await transaction(async ({ query }) => {
        await assertSheetLiveForUpdate(other.query, req.params.id)
        await query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  /** A non-destructured handler binds `client.query` — that IS this transaction's own query. */
  const CLIENT_PARAM_FIXED = `
    async function grant(req: any, res: any) {
      await transaction(async (client) => {
        await assertSheetLiveForUpdate(client.query, req.params.id)
        await client.query('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)', [req.params.id])
      })
    }
  `
  /** The sheet_config read-deny switch: an access-control write on meta_sheets itself. */
  const SHEET_CONFIG_UNGUARDED = `
    async function setFlag(req: any, res: any) {
      await transaction(async ({ query }) => {
        await query('UPDATE meta_sheets SET row_level_read_permissions_enabled = $1 WHERE id = $2', [true, req.params.id])
      })
    }
  `
  /** A rename is NOT an access-control write — the column list must not become "any meta_sheets write". */
  const SHEET_RENAME = `
    async function rename(req: any, res: any) {
      await transaction(async ({ query }) => {
        await query('UPDATE meta_sheets SET name = $1 WHERE id = $2 AND deleted_at IS NULL', [req.body.name, req.params.id])
      })
    }
  `

  it('the pre-#5938 shape is rejected — twice over (raw lock AND missing re-check)', () => {
    const found = violations(scanSource('probe.ts', PRE_FIX))
    expect(found.length).toBe(2)
    expect(found.join('\n')).toContain('raw meta_sheets row lock')
    expect(found.join('\n')).toContain(`no ${RECHECK} in the transaction`)
  })

  it('the fixed shape is accepted', () => {
    expect(violations(scanSource('probe.ts', FIXED))).toEqual([])
  })

  it('a re-check placed AFTER the write is rejected — order is the whole point', () => {
    const found = violations(scanSource('probe.ts', RECHECK_AFTER_WRITE))
    expect(found.length).toBe(1)
    expect(found[0]).toContain('AFTER its first write')
  })

  it('a comment can neither satisfy nor violate a rule', () => {
    expect(violations(scanSource('probe.ts', PROSE_ONLY))).toEqual([])
  })

  it('a re-check handed the POOL is rejected — the lock must be on THIS connection', () => {
    const found = violations(scanSource('probe.ts', POOL_QUERY_RECHECK))
    // Two: the foreign re-check itself, and the fact that no valid one remains.
    expect(found.join('\n')).toContain("instead of this transaction's own query")
    expect(found.join('\n')).toContain('another connection')
    expect(found.join('\n')).toContain(`no ${RECHECK} in the transaction`)
  })

  it('a re-check handed a SECOND client is rejected the same way', () => {
    expect(violations(scanSource('probe.ts', OTHER_CLIENT_RECHECK)).join('\n'))
      .toContain("instead of this transaction's own query")
  })

  it('a non-destructured handler passing client.query is accepted', () => {
    expect(violations(scanSource('probe.ts', CLIENT_PARAM_FIXED))).toEqual([])
  })

  it('an unguarded sheet_config access-control write is rejected', () => {
    const found = violations(scanSource('probe.ts', SHEET_CONFIG_UNGUARDED))
    expect(found.length).toBe(1)
    expect(found[0]).toContain('meta_sheets.row_level_read_permissions_enabled')
  })

  it('a sheet RENAME is not an access-control write — the detector stays narrow', () => {
    expect(violations(scanSource('probe.ts', SHEET_RENAME))).toEqual([])
  })

  it('the write detector sees each permission table and access-control column, and ignores unrelated ones', () => {
    expect(writesPermissionTable('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)')).toBe('spreadsheet_permissions')
    expect(writesPermissionTable('DELETE FROM meta_view_permissions WHERE view_id = $1')).toBe('meta_view_permissions')
    expect(writesPermissionTable('UPDATE field_permissions SET visible = $1')).toBe('field_permissions')
    expect(writesPermissionTable('UPDATE meta_sheets SET row_level_read_permissions_enabled = $1 WHERE id = $2'))
      .toBe('meta_sheets.row_level_read_permissions_enabled')
    expect(writesPermissionTable('UPDATE meta_sheets SET conditional_read_rules = $1::jsonb WHERE id = $2'))
      .toBe('meta_sheets.conditional_read_rules')
    expect(writesPermissionTable('SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id = $1')).toBeNull()
    expect(writesPermissionTable('INSERT INTO meta_records(sheet_id) VALUES ($1)')).toBeNull()
    // Neither a rename nor a READ of an access-control column is a policy write.
    expect(writesPermissionTable('UPDATE meta_sheets SET name = $1 WHERE id = $2 AND deleted_at IS NULL')).toBeNull()
    expect(writesPermissionTable('SELECT row_level_read_permissions_enabled AS enabled FROM meta_sheets WHERE id = $1')).toBeNull()
  })
})

describe('#5938 — the helper the guard delegates to actually locks, reads and refuses', () => {
  const SHEET = 'sheet_guard_5938'

  function scriptedQuery(rows: unknown[]) {
    const seen: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      seen.push({ sql: collapse(sql), params })
      return { rows }
    }
    return { query, seen }
  }

  it('locks the row and reads deleted_at in ONE statement', async () => {
    const { query, seen } = scriptedQuery([{ deleted_at: null }])
    await expect(assertSheetLiveForUpdate(query, SHEET)).resolves.toBeUndefined()
    expect(seen).toEqual([{ sql: 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE', params: [SHEET] }])
    // …and that statement IS the exported constant, byte for byte. Observers (the real-DB waiter probe)
    // match on this text; if the constant could drift from what the helper issues, deriving a pattern
    // from it would be no safer than copying one.
    expect(seen[0].sql).toBe(SHEET_ROW_LOCK_LIVENESS_SQL)
  })

  it('refuses a soft-deleted sheet with the deleted-coded error', async () => {
    const { query } = scriptedQuery([{ deleted_at: '2026-09-19T10:00:00.000Z' }])
    await expect(assertSheetLiveForUpdate(query, SHEET)).rejects.toBeInstanceOf(SheetNotLiveError)
    await expect(loadSheetLivenessForUpdate(scriptedQuery([{ deleted_at: '2026-09-19T10:00:00.000Z' }]).query, SHEET))
      .resolves.toBe('deleted')
  })

  it('refuses a missing row as absent', async () => {
    const { query } = scriptedQuery([])
    await expect(assertSheetLiveForUpdate(query, SHEET)).rejects.toBeInstanceOf(SheetNotLiveError)
    await expect(loadSheetLivenessForUpdate(scriptedQuery([]).query, SHEET)).resolves.toBe('absent')
  })

  it('the thrown error never echoes the sheet id — the refusal cannot become an oracle', async () => {
    const { query } = scriptedQuery([{ deleted_at: '2026-09-19T10:00:00.000Z' }])
    const err = await assertSheetLiveForUpdate(query, SHEET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect((err as SheetNotLiveError).message).not.toContain(SHEET)
    expect((err as SheetNotLiveError).code).toBe('SHEET_DELETED')
    // Carried as a FIELD for logging/metrics, never interpolated into the message.
    expect((err as SheetNotLiveError).sheetId).toBe(SHEET)
  })
})

/**
 * Rule D — the CI-only waiter probe cannot go blind (#5938 round 2).
 *
 * `tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts` proves that the forward
 * field-permissions writer PARKS on its sheet row while a recovery holds it, by counting blocked
 * backends whose `pg_stat_activity.query` matches the lock statement. That probe used to carry a
 * hand-copied COPY of the statement text. Renaming the statement (which is exactly what fixing the
 * TOCTOU window did) made the copy match nothing: the count never reached its floor, the assertion read
 * like a LOST LOCK, and the property "the source writer parks on its sheet row" stopped being verified.
 *
 * That file is `describeIfDatabase`-gated, so nothing local can run it — this leg reads its SOURCE and
 * pins the derivation instead. (The same contract is enforced from the ops side in CI by
 * scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs; two independent gates, because a probe that
 * silently stops observing is invisible by construction.)
 */
describe('#5938 — the real-DB waiter probe derives its pattern instead of copying it', () => {
  const PROBE = join(__dirname, '..', 'integration', 'multitable-exact-anchor-route-wiring-realdb.test.ts')
  const probeSource = readFileSync(PROBE, 'utf8').replace(/\r\n/g, '\n')
  const waiterBlock = (): string => {
    const start = probeSource.indexOf('// Both production writers must be blocked')
    const end = probeSource.indexOf('// Membership writers have no sheet-row prerequisite', start)
    expect(start, 'the waiter contract block must still exist').toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return probeSource.slice(start, end)
  }

  it('imports the production statement constant and binds it as the FOR UPDATE pattern', () => {
    expect(probeSource).toContain(
      "import { SHEET_ROW_LOCK_LIVENESS_SQL } from '../../src/multitable/sheet-liveness'",
    )
    expect(waiterBlock()).toContain('[`${SHEET_ROW_LOCK_LIVENESS_SQL}%`]')
  })

  it('carries no copied row-lock literal — a copy is what went blind', () => {
    expect(waiterBlock()).not.toMatch(/query LIKE '[^']*FROM meta_sheets[^']*FOR UPDATE%'/)
  })

  it('a copied literal would NOT match what the route issues (the blindness, demonstrated)', () => {
    // In-memory only: the pre-fix pattern against the statement production actually runs. `LIKE`'s
    // prefix semantics are what the probe relies on, so prefix-matching is the right comparison.
    const preFix = 'SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE'
    expect(SHEET_ROW_LOCK_LIVENESS_SQL.startsWith(preFix)).toBe(false)
    expect(SHEET_ROW_LOCK_LIVENESS_SQL.startsWith(SHEET_ROW_LOCK_LIVENESS_SQL)).toBe(true)
  })

  it('still requires BOTH independent authority writers to park', () => {
    const block = waiterBlock()
    expect(block).toContain('expect(authorityWaiters).toBeGreaterThanOrEqual(2)')
    expect(block).not.toContain('expect(authorityWaiters).toBeGreaterThanOrEqual(1)')
    // The FOR SHARE leg (the foreign record-permission writer) is a different statement in a file this
    // PR does not touch; it stays a literal, and it stays present.
    expect(block).toContain("query LIKE 'SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE%'")
  })
})

/**
 * #5954 — the MULTI-sheet helper: one statement that locks every named row in byte `id` order and reads each
 * `deleted_at` under that lock. Asserted on behaviour, for the same reason as rule C above: a structural
 * rule that the route calls the helper is worthless if the helper does nothing.
 */
describe('#5954 — the multi-sheet helper actually locks, reads and refuses', () => {
  const SHEET_A = 'sheet_guard_5954_a'
  const SHEET_B = 'sheet_guard_5954_b'
  const DELETED_AT = '2026-09-25T10:00:00.000Z'

  function scriptedQuery(rows: unknown[]) {
    const seen: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      seen.push({ sql: collapse(sql), params })
      return { rows }
    }
    return { query, seen }
  }

  it('locks every row and reads deleted_at in ONE statement, ids sorted and de-duplicated', async () => {
    const { query, seen } = scriptedQuery([
      { id: SHEET_A, deleted_at: null },
      { id: SHEET_B, deleted_at: null },
    ])
    // Caller order B, A, B — the statement still receives each id ONCE, in sorted order.
    await expect(assertSheetsLiveForUpdate(query, [SHEET_B, SHEET_A, SHEET_B])).resolves.toBeUndefined()
    expect(seen).toEqual([{ sql: SHEETS_ROW_LOCK_LIVENESS_SQL, params: [[SHEET_A, SHEET_B]] }])
    // The statement locks (FOR UPDATE OF the sheet rows), orders the lock by each id's POSITION in the array it
    // is handed (WITH ORDINALITY … ORDER BY u.ord — so the JS sort above IS the lock order, whatever the
    // database locale and whatever characters the ids carry), and READS deleted_at — all of it, in the one text
    // the helper issues. A lock-only `SELECT id … FOR UPDATE` is what #5954 replaced; any SQL-side sort of `id`
    // (a bare `ORDER BY id` by collation, or `COLLATE "C"` by bytes) can lock in the opposite order to
    // `lockRecordLinkTargetSheetsOnQuery` (the real-DB suite reproduces both deadlocks, L-2 and L-4).
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toMatch(
      /^SELECT s\.id, s\.deleted_at FROM meta_sheets s JOIN unnest\(\$1::text\[\]\) WITH ORDINALITY AS u\(id, ord\) ON s\.id = u\.id ORDER BY u\.ord FOR UPDATE OF s$/,
    )
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).not.toMatch(/ORDER BY\s+(?:s\.)?id\b/i)
  })

  it('hands the statement the ids in JS CODE-UNIT order, not byte order — an emoji id sorts before a full-width one', async () => {
    // Sheet ids are client-chosen (POST /sheets takes any 1–50 character `id`). An id with a character above
    // U+FFFF (a surrogate pair, lead unit 0xD83D here) sorts BEFORE one with U+FF01 in JS, but AFTER it in
    // UTF-8 byte order (F0… > EF…). The lock order is the array order, so it must be the JS one — the order
    // `lockRecordLinkTargetSheetsOnQuery` takes the same rows in (real-DB L-3 races the two).
    const astral = 'sheet_guard_5954_\u{1F600}'
    const fullwidth = 'sheet_guard_5954_\uFF01'
    expect(Buffer.compare(Buffer.from(fullwidth), Buffer.from(astral))).toBe(-1) // byte order: full-width first
    const { query, seen } = scriptedQuery([
      { id: astral, deleted_at: null },
      { id: fullwidth, deleted_at: null },
    ])
    await expect(assertSheetsLiveForUpdate(query, [fullwidth, astral])).resolves.toBeUndefined()
    expect(seen).toEqual([{ sql: SHEETS_ROW_LOCK_LIVENESS_SQL, params: [[astral, fullwidth]] }])
    // …and the same order the production share locker's own sort gives.
    expect([fullwidth, astral].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([astral, fullwidth])
  })

  it('an EMPTY list is a caller bug: a values-free TypeError, and no statement at all (it would lock nothing and pass)', async () => {
    const { query, seen } = scriptedQuery([{ id: SHEET_A, deleted_at: null }])
    const err = await assertSheetsLiveForUpdate(query, []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(SheetNotLiveError)
    expect((err as TypeError).message).toBe('SHEET_LIVENESS_NO_SHEET_IDS')
    expect(seen).toEqual([])
    // Not an array at all is the same caller bug.
    const notArray = await assertSheetsLiveForUpdate(query, undefined as unknown as string[]).catch((e: unknown) => e)
    expect((notArray as TypeError).message).toBe('SHEET_LIVENESS_NO_SHEET_IDS')
    expect(seen).toEqual([])
  })

  it('a list of only unusable ids is refused as absent — never skipped into a pass, never sent to the database', async () => {
    const { query, seen } = scriptedQuery([{ id: SHEET_A, deleted_at: null }])
    for (const ids of [[''], [undefined as unknown as string], [null as unknown as string, '']]) {
      const err = await assertSheetsLiveForUpdate(query, ids).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SheetNotLiveError)
      expect((err as SheetNotLiveError).liveness).toBe('absent')
    }
    expect(seen).toEqual([])
  })

  it('refuses when EITHER sheet was soft-deleted — the first sheet', async () => {
    const { query } = scriptedQuery([{ id: SHEET_A, deleted_at: DELETED_AT }, { id: SHEET_B, deleted_at: null }])
    const err = await assertSheetsLiveForUpdate(query, [SHEET_B, SHEET_A]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect((err as SheetNotLiveError).liveness).toBe('deleted')
    expect((err as SheetNotLiveError).sheetId).toBe(SHEET_A)
  })

  it('refuses when EITHER sheet was soft-deleted — the second sheet', async () => {
    const { query } = scriptedQuery([{ id: SHEET_A, deleted_at: null }, { id: SHEET_B, deleted_at: DELETED_AT }])
    const err = await assertSheetsLiveForUpdate(query, [SHEET_B, SHEET_A]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect((err as SheetNotLiveError).liveness).toBe('deleted')
    expect((err as SheetNotLiveError).sheetId).toBe(SHEET_B)
  })

  it('refuses a row that did not come back as absent (hard-deleted in the window)', async () => {
    const { query } = scriptedQuery([{ id: SHEET_B, deleted_at: null }])
    const err = await assertSheetsLiveForUpdate(query, [SHEET_B, SHEET_A]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect((err as SheetNotLiveError).liveness).toBe('absent')
    expect((err as SheetNotLiveError).code).toBe('NOT_FOUND')
  })

  it('reports the FIRST non-live id in CALLER order, whatever the lock order', async () => {
    // Both dead: the caller's order decides which verdict is reported (the route passes B first, the same
    // precedence its pre-transaction gates run in), independent of the sorted lock order.
    const rows = [{ id: SHEET_A, deleted_at: DELETED_AT }]
    const bFirst = await assertSheetsLiveForUpdate(scriptedQuery(rows).query, [SHEET_B, SHEET_A]).catch((e: unknown) => e)
    expect((bFirst as SheetNotLiveError).sheetId).toBe(SHEET_B)
    expect((bFirst as SheetNotLiveError).liveness).toBe('absent')
    const aFirst = await assertSheetsLiveForUpdate(scriptedQuery(rows).query, [SHEET_A, SHEET_B]).catch((e: unknown) => e)
    expect((aFirst as SheetNotLiveError).sheetId).toBe(SHEET_A)
    expect((aFirst as SheetNotLiveError).liveness).toBe('deleted')
  })

  it('the thrown error never echoes a sheet id — the SAME values-free bodies as the single-id helper', async () => {
    const { query } = scriptedQuery([{ id: SHEET_A, deleted_at: DELETED_AT }, { id: SHEET_B, deleted_at: null }])
    const err = (await assertSheetsLiveForUpdate(query, [SHEET_B, SHEET_A]).catch((e: unknown) => e)) as SheetNotLiveError
    expect(err.message).not.toContain(SHEET_A)
    expect(err.message).not.toContain(SHEET_B)
    expect(err.code).toBe('SHEET_DELETED')
    const single = (await assertSheetLiveForUpdate(scriptedQuery([{ deleted_at: DELETED_AT }]).query, SHEET_A)
      .catch((e: unknown) => e)) as SheetNotLiveError
    expect(err.message).toBe(single.message)
    expect(err.code).toBe(single.code)
  })

  it('never sends an unusable id to the database, and maps it to absent', async () => {
    const { query, seen } = scriptedQuery([{ id: SHEET_A, deleted_at: null }])
    const verdicts = await loadSheetsLivenessForUpdate(query, ['', SHEET_A])
    expect(verdicts.get('')).toBe('absent')
    expect(verdicts.get(SHEET_A)).toBe('live')
    expect(seen).toEqual([{ sql: SHEETS_ROW_LOCK_LIVENESS_SQL, params: [[SHEET_A]] }])
    // A row the database returns for an id nobody asked about cannot vouch for anything.
    const stray = await loadSheetsLivenessForUpdate(scriptedQuery([{ id: 'other', deleted_at: null }]).query, [SHEET_A])
    expect([...stray.entries()]).toEqual([[SHEET_A, 'absent']])
  })
})

/**
 * #5954 — the cross-base mirror op's in-transaction guard re-reads liveness for BOTH sheets under the lock.
 *
 * The real-DB race (tests/integration/multitable-crossbase-mirror-writethrough-concurrency-realdb.test.ts,
 * F-5/F-6/F-8) proves the behaviour; this leg pins the WIRING without a database, so dropping either sheet
 * from the call, swapping their order, or handing the helper the pool reds in the no-DB lane too:
 *   - the FIRST statement of `preWriteGuard` is `await assertSheetsLiveForUpdate(<its own query>, [...])`;
 *   - the array names BOTH `sheetA` and `sheetB` (the two ids the pre-transaction gates resolved), and in
 *     EXACTLY the order `[sheetB, sheetA]`: the helper reports the first non-live id in caller order, so this
 *     order IS the refusal precedence when both ends die with different verdicts (one hard-deleted =>
 *     `absent` 404 NOT_FOUND, the other soft-deleted => `deleted` 404 SHEET_DELETED). B first is the order
 *     the pre-transaction gates run in; the real-DB F-8 case shows the body it decides;
 *   - the handler spells no raw `meta_sheets` row lock;
 *   - its catch maps SheetNotLiveError to the values-free `sendSheetNotLive(res, err.liveness)`.
 */
describe('#5954 — the cross-base mirror op re-reads BOTH sheets under its lock', () => {
  const MIRROR_ROUTE = "'/crossbase/mirror-link'"

  function mirrorOpViolations(text: string): string[] {
    type Fn = ts.ArrowFunction | ts.FunctionExpression
    const isFn = (n: ts.Node | undefined): n is Fn => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
    const source = ts.createSourceFile('mirror.ts', text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true)
    const routes: Fn[] = []
    const findRoute = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'post' && n.arguments[0]?.getText(source) === MIRROR_ROUTE) {
        const last = n.arguments[n.arguments.length - 1]
        if (isFn(last)) routes.push(last)
      }
      ts.forEachChild(n, findRoute)
    }
    findRoute(source)
    if (routes.length !== 1) return [`expected exactly one ${MIRROR_ROUTE} handler, found ${routes.length}`]
    const route = routes[0]

    const out: string[] = []
    for (const { book, stmt } of censusSites(route.body, source)) {
      if (book === 'lock') out.push(`raw meta_sheets row lock in the mirror op: ${stmt}`)
    }

    const guards: Fn[] = []
    const findGuard = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'preWriteGuard' && isFn(n.initializer)) {
        guards.push(n.initializer)
      }
      ts.forEachChild(n, findGuard)
    }
    findGuard(route.body)
    if (guards.length !== 1) return [...out, `expected exactly one preWriteGuard in the mirror op, found ${guards.length}`]
    const g = guards[0]
    // The guard's parameter IS the transaction's query (a QueryFn), so the helper must be handed that name.
    const own = g.parameters[0] && ts.isIdentifier(g.parameters[0].name) ? g.parameters[0].name.text : ''
    if (!ts.isBlock(g.body) || g.body.statements.length === 0) return [...out, 'preWriteGuard has no statements']

    const first = g.body.statements[0]
    const call = ts.isExpressionStatement(first) && ts.isAwaitExpression(first.expression)
      && ts.isCallExpression(first.expression.expression)
      ? first.expression.expression
      : null
    if (!call || calleeName(call) !== 'assertSheetsLiveForUpdate') {
      out.push(`preWriteGuard's first statement is not \`await assertSheetsLiveForUpdate(...)\`: ${first.getText(source).slice(0, 120)}`)
    } else {
      const handed = firstArgText(call, source)
      if (own === '' || handed !== own) out.push(`assertSheetsLiveForUpdate is handed \`${handed}\` instead of preWriteGuard's own \`${own}\``)
      const ids = call.arguments[1]
      const names = ids && ts.isArrayLiteralExpression(ids)
        ? ids.elements.map((e) => (ts.isIdentifier(e) ? e.text : e.getText(source)))
        : []
      // NOT sorted: the caller order is observable (it picks which verdict is reported when both ends are
      // dead), so the analyzer must see it.
      if (!names.includes('sheetA') || !names.includes('sheetB')) {
        out.push(`assertSheetsLiveForUpdate re-reads [${names.join(', ')}], not both sheetA and sheetB`)
      } else if (names.join(',') !== 'sheetB,sheetA') {
        out.push(`assertSheetsLiveForUpdate re-reads [${names.join(', ')}], not exactly [sheetB, sheetA] (the refusal precedence: B first, as the pre-transaction gates run)`)
      }
    }

    if (!/if \(err instanceof SheetNotLiveError\) return sendSheetNotLive\(res, err\.liveness\)/.test(route.body.getText(source))) {
      out.push('the mirror op no longer maps SheetNotLiveError to sendSheetNotLive(res, err.liveness)')
    }
    return out
  }

  const routeSource = readFileSync(join(SRC, 'routes/univer-meta.ts'), 'utf8')

  it('the real route: first guard statement re-reads BOTH sheets, on the guard\'s own query', () => {
    expect(mirrorOpViolations(routeSource)).toEqual([])
  })

  const wrap = (guardBody: string, catchBody = 'if (err instanceof SheetNotLiveError) return sendSheetNotLive(res, err.liveness)') => `
    router.post('/crossbase/mirror-link', async (req: any, res: any) => {
      try {
        const preWriteGuard = async (query: QueryFn): Promise<void> => {
          ${guardBody}
          await query('SELECT id, created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [recB, sheetB])
        }
      } catch (err) {
        ${catchBody}
      }
    })
  `

  it('the analyzer ACCEPTS the fixed shape', () => {
    expect(mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(query, [sheetB, sheetA])'))).toEqual([])
  })

  it('the analyzer REJECTS the pre-#5954 lock-only statement', () => {
    const found = mirrorOpViolations(wrap("await query('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE', [[sheetA, sheetB].sort()])"))
    expect(found.join('\n')).toContain('raw meta_sheets row lock')
    expect(found.join('\n')).toContain('first statement is not')
  })

  it('the analyzer REJECTS a re-read that drops sheet A, and one that drops sheet B', () => {
    expect(mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(query, [sheetB])')).join('\n')).toContain('not both sheetA and sheetB')
    expect(mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(query, [sheetA])')).join('\n')).toContain('not both sheetA and sheetB')
  })

  it('the analyzer REJECTS both sheets in the swapped order (A first flips which verdict wins when both are dead)', () => {
    const swapped = mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(query, [sheetA, sheetB])'))
    expect(swapped).toEqual([
      'assertSheetsLiveForUpdate re-reads [sheetA, sheetB], not exactly [sheetB, sheetA] (the refusal precedence: B first, as the pre-transaction gates run)',
    ])
  })

  it('the analyzer REJECTS a re-read handed the pool instead of the guard\'s own query', () => {
    expect(mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(q, [sheetB, sheetA])')).join('\n'))
      .toContain('instead of preWriteGuard\'s own `query`')
  })

  it('the analyzer REJECTS a re-read that is not the FIRST statement', () => {
    const late = wrap("await query('SELECT 1', [])\n          await assertSheetsLiveForUpdate(query, [sheetB, sheetA])")
    expect(mirrorOpViolations(late).join('\n')).toContain('first statement is not')
  })

  it('the analyzer REJECTS a catch that stops mapping the refusal to the values-free 404', () => {
    expect(mirrorOpViolations(wrap('await assertSheetsLiveForUpdate(query, [sheetB, sheetA])', 'throw err')).join('\n'))
      .toContain('no longer maps SheetNotLiveError')
  })
})
