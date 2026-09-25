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
 *   E. The cross-base mirror RECORD op (`POST /crossbase/mirror-link`) — not a permission write, so rule B
 *      never looked at it — takes its two-sheet lock through `assertSheetsLiveForUpdate`, on its guard's
 *      OWN query, naming BOTH sheets, before its guard touches that query for anything else (#5954). Rule A
 *      alone would only say "no bare lock"; deleting the lock outright would satisfy it.
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
  loadSheetLivenessForUpdate,
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
 * EMPTY since #5954. Its one entry was the cross-base mirror op's lock-only
 * `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE` — a MULTI-sheet lock the single-id
 * helper could not express, so it never re-read liveness. It now locks through
 * `assertSheetsLiveForUpdate`, which reads `deleted_at` in the locking statement; the exemption went with
 * the residual. Re-adding an entry here is re-opening a window, and needs a reason that says so.
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
 */
const SHEET_ROW_LOCK_CENSUS = new Map<string, string>([
  [
    'multitable/sheet-liveness.ts :: SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE',
    'THE helper. The one statement that locks the row and re-reads `deleted_at` together.',
  ],
  [
    'multitable/sheet-liveness.ts :: SELECT id, deleted_at FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
    'THE multi-sheet helper (`assertSheetsLiveForUpdate`, #5954). Locks every named sheet row in byte order '
    + 'and re-reads each `deleted_at` in the same statement. Its caller is the cross-base mirror RECORD op '
    + '(routes/univer-meta.ts POST /crossbase/mirror-link), whose lock-only multi-sheet statement it replaced; '
    + 'rule E below pins that the route really goes through it.',
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
 * `<relative file> :: <collapsed SQL>` for every `meta_sheets` row lock under `src/`.
 *
 * Text-prefiltered (cheap) and then AST-parsed (precise): a comment cannot produce a literal node, so
 * prose about `FOR UPDATE` neither enters nor is missing from the census.
 */
function censusOfSrcTree(): string[] {
  const keys = new Set<string>()
  for (const file of srcFiles(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    if (!/meta_sheets/.test(text) || !/FOR\s+(?:UPDATE|SHARE)/i.test(text)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const rel = file.slice(SRC.length + 1).split(sep).join('/')
    for (const { text: sql } of literalsIn(source)) {
      if (locksSheetRowAnyMode(sql)) keys.add(`${rel} :: ${sql}`)
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

/** The route rule E is about, and the helper it must lock through. */
const MIRROR_ROUTE = '/crossbase/mirror-link'
const MULTI_RECHECK = 'assertSheetsLiveForUpdate'

interface MirrorGuardScan {
  /** `router.post('/crossbase/mirror-link', …)` was located at all. */
  routeFound: boolean
  /** Its `const preWriteGuard = async (query) => …` was located at all. */
  guardFound: boolean
  violations: string[]
}

/**
 * Rule E (#5954). Inside the mirror route, find `preWriteGuard` and require that the FIRST call which is
 * handed the guard's own query parameter is `assertSheetsLiveForUpdate(<that param>, <both sheets>)`.
 *
 * "First call handed the query" rather than "first statement": what matters is that nothing reads or
 * writes on the transaction before both sheet rows are locked and re-read, whatever the surrounding code
 * looks like. Every other `assertSheetsLiveForUpdate` in the guard handed something ELSE (the pool-level
 * `q`, a second client) is its own violation — that lock would sit on another connection.
 */
function scanMirrorLinkGuard(file: string, text: string): MirrorGuardScan {
  const source = ts.createSourceFile(file, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true)
  let routeFound = false
  let guard: ts.ArrowFunction | ts.FunctionExpression | undefined
  const findGuard = (m: ts.Node) => {
    if (
      ts.isVariableDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'preWriteGuard'
      && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))
    ) {
      guard = m.initializer
    }
    ts.forEachChild(m, findGuard)
  }
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) && calleeName(n) === 'post'
      && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === MIRROR_ROUTE
    ) {
      routeFound = true
      for (const arg of n.arguments.slice(1)) findGuard(arg)
    }
    ts.forEachChild(n, visit)
  }
  visit(source)

  const out: string[] = []
  if (!guard) return { routeFound, guardFound: false, violations: out }
  const param = guard.parameters[0]
  const queryName = param && ts.isIdentifier(param.name) ? param.name.text : ''
  if (!queryName) {
    out.push(`${MIRROR_ROUTE} preWriteGuard binds no query parameter — nothing in it can be the transaction's lock`)
    return { routeFound, guardFound: true, violations: out }
  }

  const calls: ts.CallExpression[] = []
  const collect = (m: ts.Node) => {
    if (ts.isCallExpression(m)) calls.push(m)
    ts.forEachChild(m, collect)
  }
  ts.forEachChild(guard.body, collect)
  calls.sort((a, b) => a.getStart(source) - b.getStart(source))

  const isQueryIdent = (e: ts.Expression | undefined) => !!e && ts.isIdentifier(e) && e.text === queryName
  for (const call of calls) {
    if (calleeName(call) === MULTI_RECHECK && !isQueryIdent(call.arguments[0])) {
      out.push(`${MIRROR_ROUTE} calls ${MULTI_RECHECK} with \`${firstArgText(call, source)}\` instead of the guard's own \`${queryName}\` — that locks the rows on another connection`)
    }
  }
  const firstUse = calls.find((c) => isQueryIdent(c.expression) || c.arguments.some((a) => isQueryIdent(a)))
  if (!firstUse) {
    out.push(`${MIRROR_ROUTE} preWriteGuard never uses \`${queryName}\` — it cannot be holding any lock`)
  } else if (calleeName(firstUse) !== MULTI_RECHECK || !isQueryIdent(firstUse.arguments[0])) {
    out.push(
      `${MIRROR_ROUTE} preWriteGuard's first use of \`${queryName}\` is \`${collapse(firstUse.getText(source)).slice(0, 120)}\``
      + ` — the two sheet rows must be locked and re-read through ${MULTI_RECHECK}(${queryName}, …) first`,
    )
  } else {
    const idsText = firstUse.arguments[1] ? firstUse.arguments[1].getText(source) : ''
    for (const sheet of ['sheetA', 'sheetB']) {
      if (!new RegExp(String.raw`\b${sheet}\b`).test(idsText)) {
        out.push(`${MIRROR_ROUTE} ${MULTI_RECHECK} does not name \`${sheet}\` — an edge has two ends and both must be live`)
      }
    }
  }
  return { routeFound, guardFound: true, violations: out }
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
  })

  it('the raw-lock ledger is EMPTY — the cross-base mirror residual is closed, not re-licensed (#5954)', () => {
    expect([...RAW_LOCK_LEDGER.keys()]).toEqual([])
    // …and the lock-only statement it used to license is gone from the route, in any lock mode.
    expect(censusOfSrcTree().filter((k) => k.startsWith('routes/univer-meta.ts ::'))).toEqual([])
  })

  it('re-introducing the bare multi-sheet lock into the route REDS rule A (in-memory, #5954)', () => {
    // The exact pre-#5954 statement, spliced back where the helper now sits. Nothing on disk changes.
    const route = readFileSync(join(SRC, 'routes/univer-meta.ts'), 'utf8').replace(/\r\n/g, '\n')
    const helperCall = 'await assertSheetsLiveForUpdate(query, [sheetB, sheetA])'
    expect(route).toContain(helperCall)
    const reverted = route.replace(
      helperCall,
      "await query('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE', [[sheetA, sheetB].sort()])",
    )
    const found = violations({ txns: [], rawLocks: scanSource('routes/univer-meta.ts', reverted).rawLocks })
    expect(found.join('\n')).toContain('raw meta_sheets row lock')
    expect(found.join('\n')).toContain('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE')
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
 * Rule E — the cross-base mirror op's two-sheet lock re-reads liveness (#5954).
 *
 * Rule A reds a bare lock, and the census reds a new one, but neither can see the lock go MISSING: delete
 * it and both are satisfied. This rule is the positive half — it requires the route's guard to take both
 * sheet rows through the liveness-reading helper, on the transaction's own query, first.
 */
describe('#5954 — the cross-base mirror op locks BOTH sheets through the liveness-reading helper', () => {
  const route = scanMirrorLinkGuard('routes/univer-meta.ts', readFileSync(join(SRC, 'routes/univer-meta.ts'), 'utf8'))

  it('finds the route and its preWriteGuard at all (anti-vacuity)', () => {
    expect(route.routeFound).toBe(true)
    expect(route.guardFound).toBe(true)
  })

  it('the guard locks and re-reads both sheets first, on its own query', () => {
    expect(route.violations).toEqual([])
  })

  const wrap = (guardBody: string) => `
    router.post('/crossbase/mirror-link', async (req: any, res: any) => {
      const q = pool.query.bind(pool)
      const preWriteGuard = async (query: any): Promise<void> => {
${guardBody}
      }
      await service.patchRecords({ preWriteGuard })
    })
  `
  const FIXED = wrap(`
        await assertSheetsLiveForUpdate(query, [sheetB, sheetA])
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
  `)
  /** The pre-#5954 shape: locks both rows, reads neither `deleted_at`. */
  const BARE_LOCK = wrap(`
        await query('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE', [[sheetA, sheetB].sort()])
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
  `)
  /** Satisfies rule A (no raw literal) and the census — by locking nothing. */
  const NO_LOCK = wrap(`
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
  `)
  /** Reads right; the lock lands on a pool connection and is released at once. */
  const POOL_QUERY = wrap(`
        await assertSheetsLiveForUpdate(q, [sheetB, sheetA])
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
  `)
  /** The helper, but only after the transaction already read under no sheet lock. */
  const LATE = wrap(`
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
        await assertSheetsLiveForUpdate(query, [sheetB, sheetA])
  `)
  /** Only one end of the edge. */
  const ONE_END = wrap(`
        await assertSheetsLiveForUpdate(query, [sheetB])
        const fresh = await loadSheetPermissionScopeMap(query, [sheetB], actor)
  `)

  it('the fixed shape is accepted', () => {
    const scan = scanMirrorLinkGuard('probe.ts', FIXED)
    expect(scan.guardFound).toBe(true)
    expect(scan.violations).toEqual([])
  })

  it('the pre-#5954 bare lock is rejected — by rule E AND by rule A', () => {
    expect(scanMirrorLinkGuard('probe.ts', BARE_LOCK).violations.join('\n')).toContain(`through ${MULTI_RECHECK}(query, …) first`)
    expect(violations(scanSource('probe.ts', BARE_LOCK)).join('\n')).toContain('raw meta_sheets row lock')
  })

  it('dropping the lock altogether is rejected — rule A alone would call it clean', () => {
    expect(violations(scanSource('probe.ts', NO_LOCK))).toEqual([])
    expect(scanMirrorLinkGuard('probe.ts', NO_LOCK).violations.join('\n')).toContain(`through ${MULTI_RECHECK}(query, …) first`)
  })

  it('the helper handed the pool is rejected — the lock must be on the transaction', () => {
    const found = scanMirrorLinkGuard('probe.ts', POOL_QUERY).violations.join('\n')
    expect(found).toContain('instead of the guard\'s own `query`')
    expect(found).toContain(`through ${MULTI_RECHECK}(query, …) first`)
  })

  it('the helper placed after another use of the transaction is rejected — order is the point', () => {
    expect(scanMirrorLinkGuard('probe.ts', LATE).violations.join('\n')).toContain('first use of `query` is `loadSheetPermissionScopeMap')
  })

  it('the helper naming only one end of the edge is rejected', () => {
    expect(scanMirrorLinkGuard('probe.ts', ONE_END).violations).toEqual([
      `${MIRROR_ROUTE} ${MULTI_RECHECK} does not name \`sheetA\` — an edge has two ends and both must be live`,
    ])
  })

  it('the multi-sheet statement locks meta_sheets, reads deleted_at, and pins its lock order', () => {
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toMatch(/\bFROM\s+meta_sheets\b/)
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toMatch(/\bFOR\s+UPDATE\b/)
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toMatch(/^SELECT id, deleted_at\b/)
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toContain('ORDER BY id COLLATE "C"')
  })
})

/**
 * Rule D for #5954's race test — the same blindness, the same cure. The real-DB test proves the mirror op
 * PARKS on its sheet rows by matching `pg_stat_activity.query`; that pattern must come from the production
 * constant, not a copy. It is DATABASE_URL-gated, so this leg reads its SOURCE.
 */
describe('#5954 — the real-DB race test derives its waiter pattern instead of copying it', () => {
  const RACE = join(__dirname, '..', 'integration', 'multitable-crossbase-mirror-writethrough-concurrency-realdb.test.ts')
  const raceSource = readFileSync(RACE, 'utf8').replace(/\r\n/g, '\n')

  it('imports the production statement constant and binds it as the pattern', () => {
    expect(raceSource).toMatch(/import \{[^}]*\bSHEETS_ROW_LOCK_LIVENESS_SQL\b[^}]*\} from '\.\.\/\.\.\/src\/multitable\/sheet-liveness'/)
    expect(raceSource).toContain('[`${SHEETS_ROW_LOCK_LIVENESS_SQL}%`')
  })

  it('carries no copied row-lock literal', () => {
    expect(raceSource).not.toMatch(/LIKE '[^']*FROM meta_sheets[^']*FOR UPDATE%'/)
  })

  it('asserts the waiter by the blocking pid as well as by text — a text-only probe cannot tell WHO blocks', () => {
    expect(raceSource).toContain('pg_blocking_pids(')
  })
})
