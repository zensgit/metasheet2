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
 *   A. In these two route files, a SQL literal that locks `meta_sheets` must not exist at all. The lock
 *      is taken through `assertSheetLiveForUpdate` (multitable/sheet-liveness.ts), which locks the row
 *      AND reads `deleted_at` in ONE statement — so "took the lock but forgot to look" has no spelling.
 *      Exemptions are LEDGERED BY NAME with a reason, never by omission.
 *   B. Every transaction body in those files that writes a permission table calls
 *      `assertSheetLiveForUpdate` BEFORE its first write.
 *   C. The helper itself actually locks, actually reads `deleted_at`, and actually refuses — asserted on
 *      behaviour, because A and B would both be satisfied by a helper that did nothing.
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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SheetNotLiveError, assertSheetLiveForUpdate, loadSheetLivenessForUpdate } from '../../src/multitable/sheet-liveness'

const SRC = join(__dirname, '..', '..', 'src')

/** The two doors onto the per-sheet grant tables (#5938 fixes both together). */
const GUARDED_FILES = [
  'routes/spreadsheet-permissions.ts',
  'routes/univer-meta.ts',
] as const

/** The permission tables these files own. A write to any of them is what the lock is protecting. */
const PERMISSION_TABLES = ['spreadsheet_permissions', 'meta_view_permissions', 'field_permissions']

/** Same-file appliers that write those tables without naming them in the caller's own SQL. */
const PERMISSION_APPLIERS = ['applyPermissionDeEscalation']

/** The one call that takes the lock AND reads `deleted_at`. */
const RECHECK = 'assertSheetLiveForUpdate'

/**
 * NAMED exemptions from rule A — a raw `meta_sheets … FOR UPDATE` that is NOT a permission write.
 *
 * Keyed by the collapsed SQL text so a new lock cannot inherit an old entry's licence. Each is a
 * standing statement that this lock guards something other than a grant table; the RESIDUAL is reported
 * rather than hidden (the mirror op re-derives its own per-row gating under the lock, but it does NOT
 * re-read sheet liveness — tracked for its own issue, not silently blessed here).
 */
const RAW_LOCK_LEDGER = new Map<string, string>([
  [
    'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE',
    'cross-base mirror record op (routes/univer-meta.ts) — a RECORD write, not a permission write, and a '
    + 'MULTI-sheet lock that the single-id helper cannot express. It re-derives base-B capability under the '
    + 'lock but does not re-read sheet liveness; RESIDUAL, tracked for its own issue.',
  ],
])

interface TxnBlock {
  file: string
  line: number
  /** Position of the recheck call inside the body, or -1. */
  recheckAt: number
  /** Position of the first permission write inside the body, or -1. */
  firstWriteAt: number
  /** What the first write was, for the failure message. */
  firstWriteLabel: string
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

/** A SQL literal that writes one of the permission tables. */
function writesPermissionTable(text: string): string | null {
  for (const table of PERMISSION_TABLES) {
    const pattern = new RegExp(String.raw`\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+${table}\b`, 'i')
    if (pattern.test(text)) return table
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
        let recheckAt = -1
        let firstWriteAt = -1
        let firstWriteLabel = ''
        const noteWrite = (pos: number, label: string) => {
          if (firstWriteAt === -1 || pos < firstWriteAt) {
            firstWriteAt = pos
            firstWriteLabel = label
          }
        }
        const inner = (m: ts.Node) => {
          if (ts.isCallExpression(m)) {
            const name = calleeName(m)
            if (name === RECHECK && (recheckAt === -1 || m.getStart(source) < recheckAt)) {
              recheckAt = m.getStart(source)
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
          txns.push({ file, line: lineOf(n.getStart(source)), recheckAt, firstWriteAt, firstWriteLabel })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return { txns, rawLocks }
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

  it('finds the permission write transactions at all (anti-vacuity)', () => {
    // Six today: legacy grant + legacy revoke, forward sheet / view / field permission PUTs, and the
    // permission-revert execute branch. A scan that found none would make every leg below vacuous.
    expect(scan.txns.length, `discovered: ${scan.txns.map((t) => `${t.file}:${t.line}`).join(', ')}`)
      .toBeGreaterThanOrEqual(6)
    // …and from BOTH doors. A scan that lost one file (a rename, an unreadable `.transaction` shape)
    // would still clear the count above while covering only half the surface.
    const perFile = new Map<string, number>()
    for (const txn of scan.txns) perFile.set(txn.file, (perFile.get(txn.file) ?? 0) + 1)
    expect(perFile.get('routes/spreadsheet-permissions.ts') ?? 0).toBeGreaterThanOrEqual(2)
    expect(perFile.get('routes/univer-meta.ts') ?? 0).toBeGreaterThanOrEqual(4)
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

  it('the ledgered exemption is the cross-base mirror RECORD op, not a permission write', () => {
    // Named, with its reason, so the residual is reportable rather than invisible.
    expect([...RAW_LOCK_LEDGER.keys()]).toEqual([
      'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE',
    ])
    const [reason] = [...RAW_LOCK_LEDGER.values()]
    expect(reason).toContain('RECORD write')
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

  it('the write detector sees each permission table, and ignores unrelated ones', () => {
    expect(writesPermissionTable('INSERT INTO spreadsheet_permissions(sheet_id) VALUES ($1)')).toBe('spreadsheet_permissions')
    expect(writesPermissionTable('DELETE FROM meta_view_permissions WHERE view_id = $1')).toBe('meta_view_permissions')
    expect(writesPermissionTable('UPDATE field_permissions SET visible = $1')).toBe('field_permissions')
    expect(writesPermissionTable('SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id = $1')).toBeNull()
    expect(writesPermissionTable('INSERT INTO meta_records(sheet_id) VALUES ($1)')).toBeNull()
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
