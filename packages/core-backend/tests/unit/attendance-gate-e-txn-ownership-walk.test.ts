/**
 * Gate E (#4844) first batch — the class-closing anti-regression guard.
 *
 * #4844's own scope statement, verbatim: "Enumerating known offenders converges no better here
 * than it did the last two times — the guard has to walk the exported table." This file IS that
 * walk: it parses every `.ts` file directly under `packages/core-backend/src/attendance/`,
 * classifies every `BEGIN`/`START TRANSACTION` issued on a CALLER-supplied
 * `AttendanceW4TransactionClientV1` parameter (`../helpers/attendance-txn-ownership-walk.ts`),
 * and asserts the `UNKNOWN` bucket is EMPTY. A future new BEGIN-on-caller-connection site with no
 * dominating `assertConnectionIsIdleV1` proof — and not explicitly reviewed onto the
 * JOINS/NESTED allowlist — lands in UNKNOWN and reds this file, not by enumerating it here by
 * name.
 *
 * DB-free: pure static AST analysis, no PostgreSQL required. Modelled on the F1 assembly guard
 * (`tests/helpers/attendance-w6-index-assembly-order.ts` +
 * `tests/unit/attendance-w6-group-effective-policy-authorization.test.ts`) — same ts-compiler
 * walk idiom, same non-vacuity discipline (assert the walk actually found something, not just
 * that it found nothing bad), same synthetic-fixture mutation probe (never mutates files on
 * disk — the "delete the proof, watch UNKNOWN turn non-empty" claim is proven via an in-memory
 * string-mutated copy of the REAL source text, per Gate E design lock §D3).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  discoverBeginSitesV1,
  independentDiscoverBeginCallSitesV1,
  TXN_OWNERSHIP_ALLOWLIST_V1,
  type BeginSiteV1,
} from '../helpers/attendance-txn-ownership-walk'

const ATTENDANCE_SRC_DIR = join(__dirname, '..', '..', 'src', 'attendance')

/** Non-recursive `*.ts` glob — matches the design lock's own scope statement ("the whole exported
 *  surface of `packages/core-backend/src/attendance/*.ts`"), deliberately excluding the sibling
 *  `__tests__/` subdirectory (test fixtures, not production exported surface). */
function loadAttendanceFileNames(): string[] {
  return readdirSync(ATTENDANCE_SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
}

function discoverAllBeginSites(): BeginSiteV1[] {
  const out: BeginSiteV1[] = []
  for (const file of loadAttendanceFileNames()) {
    const path = join(ATTENDANCE_SRC_DIR, file)
    const text = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)
    out.push(...discoverBeginSitesV1(source, file))
  }
  return out
}

describe('Gate E (#4844) transaction-ownership guard — walk the exported table (DB-free, static AST)', () => {
  describe('real packages/core-backend/src/attendance/*.ts', () => {
    const fileNames = loadAttendanceFileNames()
    const sites = discoverAllBeginSites()

    it('non-vacuity: the directory scan itself is not empty (guards against a silently broken glob reading zero files and vacuously passing every assertion below)', () => {
      // 51 files as of this batch; a loose lower bound so an unrelated future file addition does
      // not itself red this line — the point is "not zero / not a handful", not an exact census.
      expect(fileNames.length).toBeGreaterThan(40)
      expect(fileNames).toContain('w4c0-operation-registry.ts')
      expect(fileNames).toContain('w4c2-outbox-dispatcher.ts')
    })

    it('non-vacuity: the walk actually DISCOVERS the two converted category-1 sites, named — an AST walk that silently matches nothing must fail here first, before the UNKNOWN-empty assertion below could otherwise pass vacuously', () => {
      const names = sites.map((s) => `${s.file}::${s.enclosingFunction}`)
      expect(names).toEqual(
        expect.arrayContaining([
          'w4c0-operation-registry.ts::runAttendanceResultOperationTransactionV1',
          'w4c2-outbox-dispatcher.ts::dispatchAttendanceResultEventOutboxV1',
        ]),
      )
      expect(sites.length).toBeGreaterThanOrEqual(2)
    })

    it('the allowlist is EMPTY for this batch — a full sweep of the exported surface found zero legitimate JOINS/NESTED sites, so every discovered BEGIN site here must be OWNS', () => {
      expect(TXN_OWNERSHIP_ALLOWLIST_V1).toEqual([])
    })

    it('UNKNOWN is EMPTY across the WHOLE exported surface — every BEGIN-on-caller-connection site is provably OWNS (or reviewed-allowlisted JOINS/NESTED, none of which exist today)', () => {
      const unknown = sites.filter((s) => s.bucket === 'UNKNOWN')
      expect(unknown).toEqual([])
    })

    it('exact named OWNS census: the two converted sites plus the pre-existing correctly-guarded sibling (`planAttendanceCalculationRolloutTransitionV1`, W4C-5 NEW-B) — a NEW BEGIN-on-caller-connection site anywhere in the exported surface changes this exact list and demands review, not a silent pass', () => {
      expect(sites.map((s) => `${s.file}::${s.enclosingFunction}`).sort()).toEqual([
        'w4c0-operation-registry.ts::runAttendanceResultOperationTransactionV1',
        'w4c2-outbox-dispatcher.ts::dispatchAttendanceResultEventOutboxV1',
        'w4c3a-rollout-control.ts::planAttendanceCalculationRolloutTransitionV1',
      ])
      for (const s of sites) {
        expect(s.bucket).toBe('OWNS')
        expect(s.reason).toBeUndefined()
      }
    })

    it('every site key is enclosing-symbol + ancestor-KIND path (no line/column) and unique — the F1 context-key rule', () => {
      const keys = sites.map((s) => s.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) {
        expect(key).not.toMatch(/:\d+:\d+/) // not a "line:col"-shaped fragment
        expect(key.split('//').length).toBeGreaterThanOrEqual(3) // fn // ancestor-path // BEGIN // #n
      }
    })

    it("P2-c backstop: the classifier's site COUNT agrees with an INDEPENDENT, type-agnostic collector — a BEGIN call the classifier's AttendanceW4TransactionClientV1 type-name gate cannot see would otherwise be INVISIBLE (not even UNKNOWN), the exact defect class the F1 guard's independentThisStarts exists to catch", () => {
      let independentTotal = 0
      for (const file of fileNames) {
        const path = join(ATTENDANCE_SRC_DIR, file)
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
        independentTotal += independentDiscoverBeginCallSitesV1(source).length
      }
      // Reference-independent completeness (P2-c): if this ever drops below `sites.length`, the
      // classifier is reporting MORE sites than even the broad, type-agnostic walk can find —
      // impossible unless the classifier double-counts. If it ever RISES above `sites.length`,
      // some BEGIN call the classifier's type gate did not recognize as a caller-connection
      // parameter is invisible to the whole rest of this file's UNKNOWN-empty discipline.
      expect(independentTotal).toBe(sites.length)
    })
  })

  describe("P2-c backstop, load-bearing (synthetic fixture): a BEGIN call on a receiver typed something OTHER than AttendanceW4TransactionClientV1 is invisible to the narrow classifier but IS found by the independent collector — proving the count cross-check above is not vacuous", () => {
    const OTHER_TYPE_DECL = 'interface SomeOtherPoolClient { query(sqlText: string, params?: unknown[]): Promise<{ rows: unknown[] }> }\n'

    it('the classifier finds ZERO sites (the receiver is not AttendanceW4TransactionClientV1-typed) while the independent walker finds ONE — the mismatch this guard is built to catch', () => {
      const src =
        `${OTHER_TYPE_DECL}export async function fixtureFnOtherType(connection: SomeOtherPoolClient): Promise<void> {\n` +
        `  await connection.query('BEGIN', [])\n}\n`
      const source = ts.createSourceFile('fixture-other-type.ts', src, ts.ScriptTarget.ES2022, true)

      const classified = discoverBeginSitesV1(source, 'fixture-other-type.ts', [])
      const independent = independentDiscoverBeginCallSitesV1(source)

      expect(classified).toEqual([]) // invisible to the narrow, type-gated classifier
      expect(independent).toHaveLength(1) // found by the broad, type-agnostic walk
      expect(independent[0]).toMatchObject({
        enclosingFunction: 'fixtureFnOtherType',
        receiverName: 'connection',
      })
      // This is exactly the count mismatch (0 !== 1) the real-tree cross-check above asserts
      // does NOT happen today — if it ever did, that assertion reds.
      expect(classified.length).not.toBe(independent.length)
    })
  })

  describe('mutation probe (synthetic in-memory fixture, per design-lock §D3 — never mutates a file on disk): deleting the idle-proof call moves a converted site from OWNS to UNKNOWN', () => {
    const probes: ReadonlyArray<{ file: string; enclosingFunction: string }> = [
      { file: 'w4c0-operation-registry.ts', enclosingFunction: 'runAttendanceResultOperationTransactionV1' },
      { file: 'w4c2-outbox-dispatcher.ts', enclosingFunction: 'dispatchAttendanceResultEventOutboxV1' },
    ]

    for (const { file, enclosingFunction } of probes) {
      it(`${file}::${enclosingFunction}: removing "assertConnectionIsIdleV1(connection)" reds UNKNOWN for exactly this site, on a real-source-text-derived synthetic fixture`, () => {
        const path = join(ATTENDANCE_SRC_DIR, file)
        const text = readFileSync(path, 'utf8')
        const needle = 'assertConnectionIsIdleV1(connection)'
        // Guard against a silent no-op mutation if the real source's exact shape drifts —
        // exactly one occurrence expected (the call itself; nothing else in either file
        // mentions this literal substring).
        expect(text.split(needle).length - 1).toBe(1)

        // Replace the CALLEE, not the whole statement — keeps the mutated text syntactically
        // valid (still `await <expr>(connection)`) while making the idle-proof predicate
        // (which keys on the callee identifier `assertConnectionIsIdleV1`) stop matching. This
        // is the AST-level equivalent of "the proof call is gone" without needing to reconstruct
        // valid surrounding statement punctuation by hand.
        const mutated = text.replace(needle, 'Promise.resolve(connection)')
        expect(mutated).not.toEqual(text)
        // The CALL is gone; the import declaration naming the same identifier legitimately
        // remains (an unused import is not this guard's concern — the classifier keys on the
        // CALLEE of a CallExpression, never on raw text containing the identifier).
        expect(mutated.split(needle).length - 1).toBe(0)

        const mutatedSource = ts.createSourceFile(path, mutated, ts.ScriptTarget.ES2022, true)
        const mutatedSites = discoverBeginSitesV1(mutatedSource, file)
        const target = mutatedSites.find((s) => s.enclosingFunction === enclosingFunction)

        expect(target).toBeDefined()
        expect(target!.bucket).toBe('UNKNOWN')
        expect(target!.reason).toBeUndefined()

        // Non-vacuity within the probe itself: the ORIGINAL (unmutated) source must classify
        // this exact site as OWNS — otherwise "moves to UNKNOWN" would be trivially true of a
        // site that was never OWNS in the first place.
        const originalSource = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)
        const originalSite = discoverBeginSitesV1(originalSource, file).find(
          (s) => s.enclosingFunction === enclosingFunction,
        )
        expect(originalSite?.bucket).toBe('OWNS')
      })
    }
  })

  describe('classifier state-space coverage (inline synthetic fixtures — never index.ts / never src/attendance, so these are independent of the live tree)', () => {
    const CONN_TYPE_DECL = 'interface AttendanceW4TransactionClientV1 { query(sqlText: string, params?: unknown[]): Promise<{ rows: unknown[] }> }\n'

    const classify = (body: string, fnName = 'fixtureFn'): BeginSiteV1[] => {
      const src = `${CONN_TYPE_DECL}export async function ${fnName}(connection: AttendanceW4TransactionClientV1): Promise<void> {\n${body}\n}\n`
      const source = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
      return discoverBeginSitesV1(source, 'fixture.ts', [])
    }

    it('OWNS: idle proof as a bare unconditional statement immediately before BEGIN', () => {
      const sites = classify(
        `  await assertConnectionIsIdleV1(connection)\n  await connection.query('BEGIN', [])\n`,
      )
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('OWNS')
    })

    it('OWNS: idle proof before a loop that itself contains the BEGIN (the retry-loop shape, site 1)', () => {
      const sites = classify(
        `  await assertConnectionIsIdleV1(connection)\n  for (;;) {\n    try {\n      await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE', [])\n      break\n    } catch (e) {\n      break\n    }\n  }\n`,
      )
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('OWNS')
    })

    it('UNKNOWN: no idle proof call anywhere', () => {
      const sites = classify(`  await connection.query('BEGIN', [])\n`)
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('UNKNOWN')
    })

    it('UNKNOWN: idle proof present but nested inside an `if` — not an unconditional top-level statement, so it does not dominate', () => {
      const sites = classify(
        `  if (Math.random() > 0) {\n    await assertConnectionIsIdleV1(connection)\n  }\n  await connection.query('BEGIN', [])\n`,
      )
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('UNKNOWN')
    })

    it('UNKNOWN: idle proof present but AFTER the BEGIN (wrong order)', () => {
      const sites = classify(
        `  await connection.query('BEGIN', [])\n  await assertConnectionIsIdleV1(connection)\n`,
      )
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('UNKNOWN')
    })

    it('UNKNOWN: idle proof called on a DIFFERENT identifier than the one BEGIN uses (name-based identity, deliberately not symbol-resolved)', () => {
      const src =
        `${CONN_TYPE_DECL}export async function fixtureFn(connection: AttendanceW4TransactionClientV1, other: AttendanceW4TransactionClientV1): Promise<void> {\n` +
        `  await assertConnectionIsIdleV1(other)\n  await connection.query('BEGIN', [])\n}\n`
      const source = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
      const sites = discoverBeginSitesV1(source, 'fixture.ts', [])
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('UNKNOWN')
    })

    it('invisible, not OWNS: a BEGIN issued inside a NESTED closure (a callback passed to another function) is not attributed to the enclosing exported function at all — zero sites, not a false OWNS/UNKNOWN', () => {
      const sites = classify(
        `  await assertConnectionIsIdleV1(connection)\n  await Promise.resolve().then(async () => {\n    await connection.query('BEGIN', [])\n  })\n`,
      )
      expect(sites).toEqual([])
    })

    it('not a BEGIN site at all: SAVEPOINT is out of scope for this batch (category-3, explicitly deferred by the design lock)', () => {
      const sites = classify(`  await connection.query('SAVEPOINT some_savepoint', [])\n`)
      expect(sites).toEqual([])
    })

    it('START TRANSACTION is treated as an alias for BEGIN', () => {
      const sites = classify(`  await connection.query('START TRANSACTION', [])\n`)
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('UNKNOWN')
    })

    it('a non-exported function is not walked at all (the guard\'s domain is the EXPORTED surface only)', () => {
      const src =
        `${CONN_TYPE_DECL}async function notExported(connection: AttendanceW4TransactionClientV1): Promise<void> {\n` +
        `  await connection.query('BEGIN', [])\n}\n`
      const source = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
      expect(discoverBeginSitesV1(source, 'fixture.ts', [])).toEqual([])
    })

    it('JOINS/NESTED: an allowlisted site with a reason is classified accordingly, not OWNS/UNKNOWN', () => {
      const src = `${CONN_TYPE_DECL}export async function fixtureFn(connection: AttendanceW4TransactionClientV1): Promise<void> {\n  await connection.query('BEGIN', [])\n}\n`
      const source = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
      const sites = discoverBeginSitesV1(source, 'fixture.ts', [
        { file: 'fixture.ts', enclosingFunction: 'fixtureFn', bucket: 'JOINS', reason: 'synthetic fixture, JOINS branch coverage' },
      ])
      expect(sites).toHaveLength(1)
      expect(sites[0].bucket).toBe('JOINS')
      expect(sites[0].reason).toBe('synthetic fixture, JOINS branch coverage')
    })

    it('key stability: an unrelated sibling statement inserted earlier in the same function does not change the BEGIN site\'s key', () => {
      const before = classify(`  await assertConnectionIsIdleV1(connection)\n  await connection.query('BEGIN', [])\n`)
      const after = classify(
        `  const unrelated = 1 + 1\n  await assertConnectionIsIdleV1(connection)\n  await connection.query('BEGIN', [])\n`,
      )
      expect(after[0].key).toBe(before[0].key)
    })
  })
})
