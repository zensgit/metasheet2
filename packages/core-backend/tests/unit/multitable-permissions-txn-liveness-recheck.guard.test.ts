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
 *   A. In these files, a SQL literal that locks `meta_sheets` must not exist at all. The lock is taken
 *      through `assertSheetLiveForUpdate` (multitable/sheet-liveness.ts), which locks the row AND reads
 *      `deleted_at` in ONE statement — so "took the lock but forgot to look" has no spelling.
 *      Exemptions are LEDGERED BY NAME with a reason, never by omission.
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
 * NAMED exemptions from rule A — a raw `meta_sheets … FOR UPDATE` that is NOT a permission write.
 *
 * Keyed by the collapsed SQL text so a new lock cannot inherit an old entry's licence. Each is a
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
 * The WHOLE-TREE census of `meta_sheets` row locks (#5938 round 2).
 *
 * The rules above are file-scoped, and a file-scoped guard reports a clean bill of health for a site it
 * was never pointed at — which is exactly how the stock-prep plugin port kept the pre-fix shape while the
 * ledger above read like the complete residual set. So this census names EVERY row lock on `meta_sheets`
 * anywhere under `src/`, with what it guards. A new one — in any file, in any lock mode — reds until it is
 * named, which is the only way "no eighth site" can be a claim rather than a hope.
 *
 * #6085 follow-up: the recognizer (`censusLocksSheetRow`) is main's plus two additions, (a) the
 * schema-qualified `public.meta_sheets` / `"public"."meta_sheets"` and (b) `JOIN meta_sheets <alias>` locked
 * `FOR … OF <alias>`. Every site only those additions see carries an explicit liveness verdict below:
 * IN-statement, the separately proved owned authority, or `KNOWN_SHEET_LIVENESS_GAPS`.
 */
const CLEANING_AUTHORITY_JOIN_LOCK = "attendance/attendance-multitable-cleaning-authority.ts :: SELECT sheet.id AS sheet_id, registry.project_id FROM meta_records projection JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL JOIN plugin_multitable_object_registry registry ON registry.sheet_id = sheet.id WHERE projection.id = $1 AND registry.plugin_name = 'plugin-attendance' AND registry.object_id = 'attendance_report_records' AND registry.project_id = $2 FOR SHARE OF sheet, registry"
const DERIVED_PROCESSOR_SCOPE_LOCK = 'multitable/recovery-archive-derived-processor.ts :: SELECT sheet.id FROM public.meta_sheets sheet JOIN public.meta_bases base ON base.id=sheet.base_id WHERE sheet.id=ANY($1::text[]) AND sheet.deleted_at IS NULL AND base.deleted_at IS NULL ORDER BY base.id,sheet.id FOR SHARE OF base,sheet NOWAIT'
const RESTORE_JOB_BLOCK_LOCK = "multitable/recovery-archive-restore-jobs.ts :: SELECT id FROM public.meta_sheets WHERE id = $1 AND recovery_writer_state = 'archiving' AND recovery_writer_owner_kind = 'restore_job' AND recovery_writer_owner_id = $2 AND recovery_writer_owner_fence = $3::bigint AND recovery_writer_lease_until > clock_timestamp() FOR UPDATE"
const OWNED_ARCHIVE_CLEANUP_LOCK = 'multitable/recovery-archive-owned-cleanup.ts :: SELECT recovery_writer_state AS state,recovery_writer_owner_kind AS kind, recovery_writer_owner_id AS id,recovery_writer_owner_fence::text AS fence,recovery_writer_lease_until::text AS lease, recovery_writer_updated_at::text AS updated,recovery_writer_lease_until<=clock_timestamp() AS expired FROM public.meta_sheets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE'
const OWNED_ARCHIVE_AUTHORITY_LOCK = 'multitable/recovery-archive-owned-authority.ts :: SELECT id FROM public.meta_sheets WHERE id=$1 FOR UPDATE'

const SHEET_ROW_LOCK_CENSUS = new Map<string, string>([
  [OWNED_ARCHIVE_CLEANUP_LOCK, 'Owned expired cleanup reads sheet liveness in its locking statement, then fresh canonical full-read/management before archive mutations; no grant writes.'],
  [
    'multitable/sheet-liveness.ts :: SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE',
    'THE helper. The one statement that locks the row and re-reads `deleted_at` together.',
  ],
  [
    'multitable/sheet-liveness.ts :: SELECT s.id, s.deleted_at FROM meta_sheets s JOIN unnest($1::text[]) WITH ORDINALITY AS u(id, ord) ON s.id = u.id ORDER BY u.ord FOR UPDATE OF s',
    'THE multi-sheet helper (#5954). Locks every named row in the order of the array it is handed '
    + '(`WITH ORDINALITY … ORDER BY u.ord`), which the helper sorts in JS code-unit order — the order the '
    + 'JS-sorted sheet lockers use, whatever the database locale and whatever characters the (client-chosen) '
    + 'ids carry; no SQL-side sort of `id`, since both collation order and byte (`COLLATE "C"`) order can cross '
    + 'JS order — and re-reads each `deleted_at` in the same statement. Its caller is the cross-base mirror '
    + 'RECORD op (routes/univer-meta.ts), whose lock-only `SELECT id … = ANY($1) … FOR UPDATE` it replaced — '
    + 'that site is closed, not ledgered.',
  ],
  [
    'multitable/link-writer-fence.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT',
    'record-link writer fence — a RECORD write path, and NOWAIT (it refuses rather than queues). Not a '
    + 'permission write; outside the scope of this issue, named so it is not mistaken for one.',
  ],
  [
    'services/approval-record-link-txn-auth.ts :: SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE',
    'record-link target-sheet authority — FOR SHARE (a read-side pin, not a write lock) on a RECORD path. '
    + 'Two call sites, same statement. Not a permission write.',
  ],
  [
    'multitable/exact-anchor-recovery-execute.ts :: SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE NOWAIT',
    'exact-anchor recovery apply — pins every AUTHORITY sheet for a RECORD recovery, sorted and NOWAIT '
    + '(it refuses rather than queues). Multi-sheet, so the single-id helper cannot express it; not a '
    + 'permission write.',
  ],
  [
    'services/elearning-stats-multitable-projection.ts :: SELECT id, base_id, system_kind FROM meta_sheets WHERE id = $1 FOR UPDATE',
    'e-learning statistics projection — a SYSTEM-owned read model that CREATES the sheet it then locks in '
    + 'the same transaction, and re-derives `base_id` + `system_kind` under the lock. It writes meta_fields '
    + 'and meta_records, never a permission table. RESIDUAL: it does not read `deleted_at`, so a '
    + 'soft-deleted projection sheet would be re-populated rather than refused — a different issue from '
    + 'this one (nobody grants on it), reported rather than hidden.',
  ],
  [
    CLEANING_AUTHORITY_JOIN_LOCK,
    'attendance cleaning authority (seen via (b)) — pins the projection\'s sheet row FOR SHARE together with its '
    + 'registry row, ahead of the permission and record locks that follow; not a permission write. Liveness is read IN the '
    + 'locking statement: its JOIN keeps only `sheet.deleted_at IS NULL`, so a soft-deleted sheet returns no row '
    + 'and the caller refuses (`ownership.rows.length !== 1` → unavailable).',
  ],
  [
    DERIVED_PROCESSOR_SCOPE_LOCK,
    'recovery-archive derived processor (seen via (a)) — pins every sheet of the fenced derived scope, and their '
    + 'bases, FOR SHARE … NOWAIT (refuses rather than queues); not a permission write. Liveness is read IN the '
    + 'locking statement: `sheet.deleted_at IS NULL AND base.deleted_at IS NULL`, and a row count short of the '
    + 'scope throws RECOVERY_DERIVED_SCOPE_CHANGED.',
  ],
  [
    RESTORE_JOB_BLOCK_LOCK,
    'recovery-archive restore job `lockRestoreJobBlock` (seen via (a)) — pins the sheet row while the job still '
    + 'owns its writer block (state, owner, fence, lease), else RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST; a '
    + 'RECORD-restore path, not a permission write. It does not read `deleted_at`: SHEET-LIVENESS-GAP-1 below.',
  ],
  [
    OWNED_ARCHIVE_AUTHORITY_LOCK,
    'Owned archive authority has two calls of this statement: normal recheck reads the shared live binding '
    + 'after taking this lock, on the same RC query/xid, before any phase write. Exact-owner abandonment '
    + 'only terminalizes/releases its persisted owner, deliberately without current liveness or admission. '
    + 'The dedicated AST proof below checks both uses; neither is an IN-statement liveness claim or a GAP.',
  ],
])

/**
 * Verdicts for the sites ONLY (a)/(b) see (#6085 follow-up): does the locking statement itself read or
 * filter the sheet row's `deleted_at`? Each "yes" names the predicate, and a test checks that predicate is
 * in the statement text — a verdict cannot rest on prose alone. The one owned-authority statement has a
 * separate under-lock/cleanup proof below; every other such site is here or in the GAP ledger.
 */
const SHEET_LOCK_READS_DELETED_AT_IN_STATEMENT = new Map<string, string>([
  [OWNED_ARCHIVE_CLEANUP_LOCK, 'deleted_at IS NULL'],
  [CLEANING_AUTHORITY_JOIN_LOCK, 'sheet.deleted_at IS NULL'],
  [DERIVED_PROCESSOR_SCOPE_LOCK, 'sheet.deleted_at IS NULL'],
])

/** One tracked gap, in the shape of an issue: what is missing under the lock, the candidate fix, who decides. */
interface SheetLivenessGap {
  /** Stable id; the PR body lists the same item under it. */
  id: string
  /** The census key of the lock. */
  site: string
  missing: string
  fix: string
  /** `owner-ruling` when the fix changes product behaviour and needs a decision before code. */
  decision: 'clear' | 'owner-ruling'
}

/**
 * GAP ledger — sites only (a)/(b) see whose lock does NOT read `deleted_at`. Shrink-only: its length must
 * equal `SHEET_LIVENESS_GAP_CEILING`, which a test holds at 1 or below. No production code changes here.
 */
const KNOWN_SHEET_LIVENESS_GAPS: readonly SheetLivenessGap[] = [
  {
    id: 'SHEET-LIVENESS-GAP-1',
    site: RESTORE_JOB_BLOCK_LOCK,
    missing: '`lockRestoreJobBlock` pins the sheet row but neither reads nor filters `deleted_at`, and neither '
      + 'recovery-archive-restore-jobs.ts nor recovery-archive-writer-block.ts mentions `deleted_at` at all. '
      + 'Whether another step of the restore path refuses a soft-deleted sheet was not traced. Reachable only '
      + 'with MULTITABLE_RECOVERY_ARCHIVE_ENABLED and MULTITABLE_ENABLE_WRITER_FENCE both exactly "true".',
    fix: 'Candidate: add `AND deleted_at IS NULL` to this statement, so a soft-deleted sheet becomes '
      + 'RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST. Owner ruling first: a soft-deleted sheet can be undeleted '
      + '(routes/univer-meta.ts), so whether a restore job should abort, wait or continue on one is a product call.',
    decision: 'owner-ruling',
  },
]

const SHEET_LIVENESS_GAP_CEILING = 1

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

/** A SQL literal that takes a row lock on `meta_sheets`. */
function locksSheetRow(text: string): boolean {
  return /\bFROM\s+meta_sheets\b/i.test(text) && /\bFOR\s+UPDATE\b/i.test(text)
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

  for (const { node, text: sql } of literalsIn(source)) {
    if (locksSheetRow(sql)) rawLocks.push({ file, line: lineOf(node.getStart(source)), sql })
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

/** Every `.ts` file under `src/`, for the whole-tree census. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) srcFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** A row lock in ANY mode — the census is about who locks the sheet row at all, not only FOR UPDATE. */
function locksSheetRowAnyMode(text: string): boolean {
  return /\bFROM\s+meta_sheets\b/i.test(text)
    && /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(text)
}

/**
 * (a) The schema-qualified spellings `public.meta_sheets` and `"public"."meta_sheets"` name the same table
 * as bare `meta_sheets`. The census rewrites them to the bare name and then applies the recognizers
 * unchanged, so (a) holds wherever the bare name is recognized: main's `FROM` position, and (b)'s `JOIN`.
 * Case-insensitive, as main's recognizer is. Not recognized: mixed quoting (`public."meta_sheets"`),
 * whitespace around the dot, other schemas, bare `"meta_sheets"`.
 */
function unqualifySheetTable(text: string): string {
  return text.replace(/public\.meta_sheets|"public"\."meta_sheets"/gi, 'meta_sheets')
}

/**
 * (b) The sheet enters by `JOIN meta_sheets <alias>` (optionally `AS <alias>`) and a locking clause names
 * that alias: `FOR UPDATE | NO KEY UPDATE | SHARE | KEY SHARE OF …, <alias>, …`. PostgreSQL locks exactly
 * the relations an `OF` list names, so an `OF` list without the alias is NOT a sheet-row lock.
 *
 * Aliases compare case-folded (PostgreSQL folds unquoted identifiers). A keyword after the table (`ON`,
 * `USING`, …) is captured as an "alias" harmlessly: a reserved word cannot appear unquoted in an `OF` list.
 * Not recognized: a JOINed sheet locked by a bare `FOR …` with no `OF`; a JOIN with no alias; a quoted
 * alias or a quoted name in the `OF` list; a comma-list `FROM a, meta_sheets s`.
 */
function locksJoinedSheetByAlias(text: string): boolean {
  const aliases = new Set<string>()
  for (const m of text.matchAll(/\bJOIN\s+meta_sheets\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gi)) {
    aliases.add(m[1].toLowerCase())
  }
  const lockOf = /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\s+OF\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_$]*)*)/gi
  for (const m of text.matchAll(lockOf)) {
    if (m[1].split(',').some((name) => aliases.has(name.trim().toLowerCase()))) return true
  }
  return false
}

/**
 * The census recognizer: main's `locksSheetRowAnyMode` UNCHANGED as the first disjunct, on the whole
 * literal exactly as before, plus (a) and (b). A disjunction, so it recognizes every literal main's
 * recognizer does — it can only see more, never less.
 *
 * (a) and (b) are judged per `;`-separated piece of the literal, so the sheet and the lock must sit in the
 * same statement. Judged on the whole literal, (a) would book the plpgsql trigger bodies in
 * `db/migrations/` (the sheet read in one `IF NOT EXISTS (…)`, a `FOR KEY SHARE` on another table in another
 * statement) as sheet-row locks. The split is naive and only ever NARROWS the two additions: a `;` inside a
 * comment, string or dollar quote within one statement makes (a)/(b) miss that statement. Main's disjunct
 * never splits, so nothing it sees is affected.
 */
function censusLocksSheetRow(text: string): boolean {
  if (locksSheetRowAnyMode(text)) return true
  return text.split(';').some((piece) => {
    const bare = unqualifySheetTable(piece)
    return locksSheetRowAnyMode(bare) || locksJoinedSheetByAlias(bare)
  })
}

/** main's file prefilter, VERBATIM — kept so the superset leg can re-run main's census exactly. */
function mainMayLockSheetRow(text: string): boolean {
  return /meta_sheets/.test(text) && /FOR\s+(?:UPDATE|SHARE)/i.test(text)
}

/**
 * The census prefilter: main's, plus the two lock strengths main's recognizer already accepted
 * (`NO KEY UPDATE`, `KEY SHARE`) but its prefilter never spelled. Without them a file whose only lock is
 * `FOR KEY SHARE OF s` is never parsed at all, and (b) could not see it. Wider than main's, never narrower.
 */
function censusMayLockSheetRow(text: string): boolean {
  return /meta_sheets/.test(text) && /FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)/i.test(text)
}

/** Census keys for ONE source file: `<rel> :: <collapsed SQL>` for each literal the recognizer accepts. */
function censusOfSource(
  rel: string,
  raw: string,
  recognize: (sql: string) => boolean = censusLocksSheetRow,
  mayLock: (text: string) => boolean = censusMayLockSheetRow,
): string[] {
  const text = raw.replace(/\r\n/g, '\n')
  if (!mayLock(text)) return []
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  return literalsIn(source).filter(({ text: sql }) => recognize(sql)).map(({ text: sql }) => `${rel} :: ${sql}`)
}

/**
 * `<relative file> :: <collapsed SQL>` for every `meta_sheets` row lock under `src/`.
 *
 * Text-prefiltered (cheap) and then AST-parsed (precise): a comment cannot produce a literal node, so
 * prose about `FOR UPDATE` neither enters nor is missing from the census. Called with main's recognizer
 * and prefilter it reproduces main's census, which the superset leg compares against.
 */
function censusOfSrcTree(
  recognize: (sql: string) => boolean = censusLocksSheetRow,
  mayLock: (text: string) => boolean = censusMayLockSheetRow,
): string[] {
  const keys = new Set<string>()
  for (const file of srcFiles(SRC)) {
    const rel = file.slice(SRC.length + 1).split(sep).join('/')
    for (const key of censusOfSource(rel, readFileSync(file, 'utf8'), recognize, mayLock)) keys.add(key)
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

  it('WHOLE TREE: every meta_sheets row lock under src/ is named, in any file and any lock mode', () => {
    // The rules above are file-scoped; this one is not. A seventh site in a file nobody pointed the
    // guard at — which is exactly how the stock-prep port kept the pre-fix shape — reds here until it
    // is named with what it guards.
    const found = censusOfSrcTree()
    expect(found).toEqual([...SHEET_ROW_LOCK_CENSUS.keys()].sort())
    // Anti-vacuity: a walker that silently found nothing would make the equality above trivially true
    // against an empty ledger, and nothing here would notice.
    expect(found.length).toBeGreaterThanOrEqual(6)
    expect(found.some((k) => k.startsWith('multitable/sheet-liveness.ts ::'))).toBe(true)
    for (const reason of SHEET_ROW_LOCK_CENSUS.values()) expect(reason.length).toBeGreaterThan(40)
  })

  it('the census recognizes every lock mode, and nothing that is not a lock', () => {
    expect(locksSheetRowAnyMode('SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRowAnyMode('SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE')).toBe(true)
    expect(locksSheetRowAnyMode('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT')).toBe(true)
    expect(locksSheetRowAnyMode('SELECT id FROM meta_sheets WHERE id = $1 FOR NO KEY UPDATE')).toBe(true)
    expect(locksSheetRowAnyMode('SELECT deleted_at FROM meta_sheets WHERE id = $1')).toBe(false)
    expect(locksSheetRowAnyMode('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE')).toBe(false)
    // #5954: the multi-sheet helper's statement joins meta_sheets to an `unnest … WITH ORDINALITY`; it keeps
    // `FROM meta_sheets s` FIRST so this recognizer (which keys on `FROM meta_sheets`) sees it, and the
    // census equality above reds if a rewrite ever spells it so it is not seen.
    expect(locksSheetRowAnyMode(SHEETS_ROW_LOCK_LIVENESS_SQL)).toBe(true)
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
 * #6085 follow-up — the census's two additions, each witnessed both ways, and the property that makes them
 * safe to land: the census still sees EVERY site main's recognizer sees. (#6085 rewrote the recognizer
 * instead, and its rewrite lost locks main caught — the regression this minimal extension exists to avoid.)
 */
describe('#6085 follow-up — the census adds (a) schema-qualified and (b) JOIN … OF <alias> sheet locks, losing nothing', () => {
  /** A one-literal source file, so each witness runs the whole census path: prefilter, AST literal, recognizer. */
  const probe = (sql: string): string => `export const Q = ${JSON.stringify(sql)}\n`
  const census = (sql: string): string[] => censusOfSource('probe.ts', probe(sql))
  const mainCensus = (sql: string): string[] =>
    censusOfSource('probe.ts', probe(sql), locksSheetRowAnyMode, mainMayLockSheetRow)

  const mainTree = censusOfSrcTree(locksSheetRowAnyMode, mainMayLockSheetRow)
  const tree = censusOfSrcTree()

  it('(a) positive: `FROM public.meta_sheets` and `FROM "public"."meta_sheets"` are sheet-row locks main did not see', () => {
    for (const sql of [
      'SELECT id FROM public.meta_sheets WHERE id = $1 FOR UPDATE',
      'SELECT id FROM "public"."meta_sheets" WHERE id = $1 FOR SHARE',
    ]) {
      expect(census(sql), sql).toEqual([`probe.ts :: ${sql}`])
      expect(mainCensus(sql), sql).toEqual([])
    }
    // Case-insensitive at the statement, as main's recognizer is. (The file prefilter, like main's, is not.)
    expect(censusLocksSheetRow('SELECT id FROM PUBLIC.META_SHEETS WHERE id = $1 FOR UPDATE')).toBe(true)
    expect(locksSheetRowAnyMode('SELECT id FROM PUBLIC.META_SHEETS WHERE id = $1 FOR UPDATE')).toBe(false)
  })

  it('(a) negative: a longer table name, another schema, or no lock clause is not a sheet-row lock', () => {
    expect(census('SELECT id FROM public.meta_sheets_snapshot WHERE id = $1 FOR UPDATE')).toEqual([])
    expect(census('SELECT id FROM archive.meta_sheets WHERE id = $1 FOR UPDATE')).toEqual([])
    expect(census('SELECT deleted_at FROM public.meta_sheets WHERE id = $1')).toEqual([])
  })

  it('(b) positive: `JOIN meta_sheets <alias>` locked `FOR <any strength> OF <alias>` — main did not see it', () => {
    for (const strength of ['UPDATE', 'NO KEY UPDATE', 'SHARE', 'KEY SHARE']) {
      const sql = `SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id WHERE r.id = $1 FOR ${strength} OF s`
      expect(census(sql), strength).toEqual([`probe.ts :: ${sql}`])
      expect(mainCensus(sql), strength).toEqual([])
    }
    // `AS <alias>` with the alias later in a list and a trailing NOWAIT; an (a) spelling in the JOIN; case folding.
    for (const sql of [
      'SELECT r.id FROM meta_records r JOIN meta_sheets AS sheet ON sheet.id = r.sheet_id FOR SHARE OF r, sheet NOWAIT',
      'SELECT r.id FROM meta_records r JOIN public.meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF s',
      'SELECT r.id FROM meta_records r JOIN meta_sheets Sheet ON Sheet.id = r.sheet_id FOR UPDATE OF SHEET',
    ]) {
      expect(census(sql), sql).toEqual([`probe.ts :: ${sql}`])
      expect(mainCensus(sql), sql).toEqual([])
    }
  })

  it('(b) negative: an `OF` list naming only OTHER relations, or a longer table name, is not a sheet-row lock', () => {
    // PostgreSQL locks exactly the relations an `OF` list names; the joined sheet here is only read.
    expect(census('SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id FOR UPDATE OF r')).toEqual([])
    expect(census('SELECT r.id FROM meta_records r JOIN meta_sheets_archive s ON s.id = r.sheet_id FOR UPDATE OF s'))
      .toEqual([])
    // …and the real tree's two statements of that shape exist and stay out of the census.
    const cleaning = readFileSync(join(SRC, 'attendance/attendance-multitable-cleaning-authority.ts'), 'utf8')
    const effects = readFileSync(join(SRC, 'multitable/recovery-archive-derived-effects.ts'), 'utf8')
    expect(cleaning).toContain('FOR UPDATE OF projection, attendance_record')
    expect(effects).toContain('FOR UPDATE OF effect SKIP LOCKED')
    expect(tree.filter((k) => k.includes('FOR UPDATE OF projection, attendance_record'))).toEqual([])
    expect(tree.filter((k) => k.includes('FOR UPDATE OF effect SKIP LOCKED'))).toEqual([])
  })

  it('(a)/(b) need the sheet and the lock in ONE statement; main\'s whole-literal rule is untouched', () => {
    // Another statement ahead of the lock does not hide it…
    const after = 'SELECT 1; SELECT id FROM public.meta_sheets WHERE id = $1 FOR UPDATE'
    expect(census(after)).toEqual([`probe.ts :: ${after}`])
    // …but a sheet READ in one statement and a lock on another relation in the next is not a sheet-row lock.
    expect(census('SELECT id FROM public.meta_sheets WHERE id = $1; SELECT id FROM meta_records WHERE id = $2 FOR UPDATE'))
      .toEqual([])
    expect(census(
      'SELECT r.id FROM meta_records r JOIN meta_sheets s ON s.id = r.sheet_id; SELECT s.id FROM meta_records s WHERE s.id = $1 FOR UPDATE OF s',
    )).toEqual([])
    // The bare-name twin is still recognized: main's rule judges the whole literal, as it always did.
    const bareTwin = 'SELECT id FROM meta_sheets WHERE id = $1; SELECT id FROM meta_records WHERE id = $2 FOR UPDATE'
    expect(census(bareTwin)).toEqual([`probe.ts :: ${bareTwin}`])
    expect(mainCensus(bareTwin)).toEqual([`probe.ts :: ${bareTwin}`])
    // On the real tree the split drops only multi-statement plpgsql function bodies in migrations.
    const wholeLiteral = (sql: string): boolean => {
      const bare = unqualifySheetTable(sql)
      return locksSheetRowAnyMode(sql) || locksSheetRowAnyMode(bare) || locksJoinedSheetByAlias(bare)
    }
    const dropped = censusOfSrcTree(wholeLiteral).filter((k) => !tree.includes(k))
    expect(dropped.length).toBeGreaterThanOrEqual(1)
    for (const key of dropped) {
      expect(key.slice(0, 120)).toMatch(/^db\/migrations\/[^ ]+\.ts :: CREATE (?:OR REPLACE )?FUNCTION /)
    }
  })

  it('SUPERSET: every site main\'s recognizer finds under src/ is still found', () => {
    expect(mainTree.length).toBeGreaterThanOrEqual(6)
    expect(mainTree.filter((k) => !tree.includes(k))).toEqual([])
  })

  it('every site only (a)/(b) finds has a verdict: IN-statement liveness, the proved owned authority, or a ledgered GAP', () => {
    const main = new Set(mainTree)
    const added = tree.filter((k) => !main.has(k))
    const inStatement = [...SHEET_LOCK_READS_DELETED_AT_IN_STATEMENT.keys()]
    expect(added).toEqual([...inStatement, OWNED_ARCHIVE_AUTHORITY_LOCK, ...KNOWN_SHEET_LIVENESS_GAPS.map((g) => g.site)].sort())
    // A verdict is checked against the statement text, never taken from prose alone.
    for (const [key, predicate] of SHEET_LOCK_READS_DELETED_AT_IN_STATEMENT) {
      expect(predicate).toMatch(/\bdeleted_at\b/)
      expect(key.slice(key.indexOf(' :: ') + ' :: '.length), key).toContain(predicate)
    }
    for (const gap of KNOWN_SHEET_LIVENESS_GAPS) {
      expect(gap.site.slice(gap.site.indexOf(' :: ')), gap.id).not.toMatch(/\bdeleted_at\b/)
    }
  })

  it('the GAP ledger only shrinks, and each entry is a trackable item', () => {
    // Raising the ceiling means editing this assertion; closing a gap means lowering it to match.
    expect(SHEET_LIVENESS_GAP_CEILING).toBeLessThanOrEqual(1)
    expect(KNOWN_SHEET_LIVENESS_GAPS.length).toBe(SHEET_LIVENESS_GAP_CEILING)
    const ids = KNOWN_SHEET_LIVENESS_GAPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const gap of KNOWN_SHEET_LIVENESS_GAPS) {
      expect(gap.id).toMatch(/^SHEET-LIVENESS-GAP-\d+$/)
      expect(SHEET_ROW_LOCK_CENSUS.has(gap.site), gap.id).toBe(true)
      expect(gap.missing.length, gap.id).toBeGreaterThan(40)
      expect(gap.fix.length, gap.id).toBeGreaterThan(40)
      expect(['clear', 'owner-ruling']).toContain(gap.decision)
    }
  })
})

describe('owned archive authority — the exact shared lock has two mechanically checked uses', () => {
  const authority = readFileSync(join(SRC, 'multitable/recovery-archive-owned-authority.ts'), 'utf8')
  const capture = readFileSync(join(SRC, 'multitable/recovery-archive-owned-capture.ts'), 'utf8')
  const printer = ts.createPrinter({ removeComments: true })
  const parse = (text: string) => ts.createSourceFile('owned.ts', text, ts.ScriptTarget.Latest, true)
  const printed = (node: ts.Node, source: ts.SourceFile) => collapse(printer.printNode(ts.EmitHint.Unspecified, node, source))
  const body = (text: string, name: string): string[] => {
    const source = parse(text)
    const fn = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
    expect(fn?.parameters[0]?.name.getText(source)).toBe('query')
    expect(fn?.body).toBeDefined()
    return fn!.body!.statements.map((s) => printed(s, source))
  }
  const initializer = (text: string, name: string): ts.Expression => {
    const source = parse(text)
    const declarations = source.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])
    const matches = declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === name)
    expect(matches).toHaveLength(1)
    expect(matches[0].initializer).toBeDefined()
    return matches[0].initializer!
  }
  const expected = (statements: string) => body(`function proof(query) { ${statements} }`, 'proof')

  function assertNormalRecheck(text: string, captured: string): void {
    // Compare AST statements, not comments or subsequences: an intervening write/return/foreign query
    // cannot inherit this verdict. This is deliberately just the owned function's authority prefix.
    const prefix = expected(`
      const state = recoveryArchiveOwnedAttempt(token)
      const claim = state.captured.claim
      await prepareArchiveWriterBlockTransaction(query, claim.identity.sheetId)
      const before = (await query(proofSql)).rows[0] as Record<string, unknown> | undefined
      if (before?.isolation !== 'read committed' || before.read_only !== 'off' || typeof before.xid !== 'string') refuseOwned()
      await lockActiveRecoveryArchiveKeyForReference(query, { keyId: claim.key.keyId, expectedRowVersion: claim.key.rowVersion })
      const block = await query(\`SELECT id FROM public.meta_sheets WHERE id=$1 FOR UPDATE\`, [claim.identity.sheetId])
      if (block.rows.length !== 1) refuseOwned()
      const generation = await query(\`SELECT generation_id FROM public.meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE\`, [claim.generationOwner.generationId])
      if (generation.rows.length !== 1) refuseOwned()
      if (!await authorize(query, claim.identity)) refuseOwned()
      const after = (await query(proofSql)).rows[0] as Record<string, unknown> | undefined
      if (after?.xid !== before.xid || after.isolation !== 'read committed' || after.read_only !== 'off') refuseOwned()
      const binding = JSON.stringify(claim)
      const hash = createHash('sha256').update(JSON.stringify(['recovery-archive-manual-request', 1, claim.identity.actorId,
        claim.identity.workspaceId, claim.identity.baseId, claim.identity.sheetId])).digest('hex')
      const check = async (sql: string, params: unknown[]) => {
        const row = (await query(sql, params)).rows[0] as { matches?: unknown; xid?: unknown } | undefined
        if (row?.matches !== true || row.xid !== before.xid) refuseOwned()
      }
      await check(recoveryArchiveOwnedCaptureAuthoritySql.binding, [binding, hash])
    `)
    expect(body(text, 'recheckRecoveryArchiveOwnedAttempt').slice(0, prefix.length)).toEqual(prefix)
    const proof = initializer(text, 'proofSql')
    expect(ts.isStringLiteralLike(proof)).toBe(true)
    expect(collapse((proof as ts.StringLiteralLike).text)).toBe("SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only")
    const binding = initializer(captured, 'BINDING_SQL')
    expect(ts.isStringLiteralLike(binding)).toBe(true)
    const sql = collapse((binding as ts.StringLiteralLike).text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, ''))
    expect(sql).toContain('JOIN public.meta_sheets s ON s.id=')
    expect(sql).toContain('JOIN public.meta_bases base ON base.id=s.base_id')
    expect(sql).toContain('AND s.deleted_at IS NULL AND base.deleted_at IS NULL')
    expect(sql).not.toMatch(/\bOR\b/i)
    const exported = initializer(captured, 'recoveryArchiveOwnedCaptureAuthoritySql')
    expect(printed(exported, exported.getSourceFile())).toBe('Object.freeze({ binding: BINDING_SQL, heads: HEADS_SQL, reservations: RESERVATIONS_SQL, mutablePins: PINS_SQL })')
  }

  function assertOwnerCleanup(text: string): void {
    // The complete bodies constrain both write sets and every CAS parameter. Adding a current flag,
    // permission, key or lease-validity gate here would strand safety cleanup and must also red.
    expect(body(text, 'abandonRecoveryArchiveOwnedClaim')).toEqual(expected(`
      await prepareArchiveWriterBlockCleanupTransaction(query, claim.identity.sheetId)
      await query('SELECT id FROM public.meta_sheets WHERE id=$1 FOR UPDATE', [claim.identity.sheetId])
      const owner = claim.generationOwner
      await query(\`UPDATE public.meta_recovery_archives SET build_status='abandoned'
        WHERE generation_id=$1::uuid AND state='building' AND build_status='active' AND coverage_status='incomplete'
          AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint AND source_vector_hash=$5
          AND created_at=$6::timestamptz AND lease_expires_at=$7::timestamptz AND expires_at=$8::timestamptz\`,
      [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash,
        claim.generationClaimedAt, claim.leaseUntil, claim.expiresAt])
      await releaseRecoveryArchiveOwnedBlock(query, claim)
    `))
    expect(body(text, 'releaseRecoveryArchiveOwnedBlock')).toEqual(expected(`
      const block = claim.writerBlock
      const result = await query(\`UPDATE public.meta_sheets SET recovery_writer_state=NULL,recovery_writer_owner_kind=NULL,
        recovery_writer_owner_id=NULL,recovery_writer_lease_until=NULL,recovery_writer_updated_at=NULL
        WHERE id=$1 AND recovery_writer_state='archiving' AND recovery_writer_owner_kind=$2 AND recovery_writer_owner_id=$3
          AND recovery_writer_owner_fence=$4::bigint AND recovery_writer_lease_until=$5::timestamptz AND recovery_writer_updated_at=$6::timestamptz\`,
      [claim.identity.sheetId, block.ownerKind, block.ownerId, block.fence, block.leaseUntil, block.updatedAt])
      return result.rowCount ?? 0
    `))
  }

  it('normal recheck reads the live binding on the locked RC query/xid before returning to its writer', () => {
    assertNormalRecheck(authority, capture)
  })

  it('the only two calls of this lock are the checked normal recheck and exact-owner cleanup', () => {
    const lock = OWNED_ARCHIVE_AUTHORITY_LOCK.split(' :: ')[1]
    expect(literalsIn(parse(authority)).filter((l) => l.text === lock)).toHaveLength(2)
    assertOwnerCleanup(authority)
  })

  it.each([
    ['foreign query', 'await query(sql, params)', 'await otherQuery(sql, params)'],
    ['missing xid refusal', 'row.xid !== before.xid', 'false'],
    ['missing binding', 'await check(recoveryArchiveOwnedCaptureAuthoritySql.binding, [binding, hash])', ''],
    ['write before binding', 'await check(recoveryArchiveOwnedCaptureAuthoritySql.binding, [binding, hash])', "await query('UPDATE meta_records SET data = data'); await check(recoveryArchiveOwnedCaptureAuthoritySql.binding, [binding, hash])"],
  ])('the normal proof rejects %s', (_label, before, after) => {
    expect(authority.split(before)).toHaveLength(2)
    expect(() => assertNormalRecheck(authority.replace(before, after), capture)).toThrow()
  })

  it.each(['s', 'base'])('the binding proof rejects a missing %s liveness predicate', (alias) => {
    const predicate = `${alias}.deleted_at IS NULL`
    expect(capture.split(predicate)).toHaveLength(2)
    expect(() => assertNormalRecheck(authority, capture.replace(predicate, 'true'))).toThrow()
  })

  it.each([
    ['lost owner fence', 'AND recovery_writer_owner_fence=$4::bigint', ''],
    ['current lease gate', "AND state='building' AND build_status='active'", "AND lease_expires_at>clock_timestamp() AND state='building' AND build_status='active'"],
    ['extra write', 'await releaseRecoveryArchiveOwnedBlock(query, claim)', "await query('UPDATE meta_records SET data = data'); await releaseRecoveryArchiveOwnedBlock(query, claim)"],
  ])('the cleanup proof rejects %s', (_label, before, after) => {
    expect(authority.split(before)).toHaveLength(2)
    expect(() => assertOwnerCleanup(authority.replace(before, after))).toThrow()
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
    for (const { text: sql } of literalsIn(route.body)) {
      if (locksSheetRowAnyMode(sql)) out.push(`raw meta_sheets row lock in the mirror op: ${sql}`)
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
