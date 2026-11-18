/**
 * Gate E (#4844): DB-free literal-BEGIN ownership census across attendance/*.ts.
 * Keep the original four caller-owned sites non-vacuous after private-helper and
 * exclusive-callback migration. Independent collection traverses every scope,
 * without signature/export/wrapper filtering; compare individual starts, not just
 * totals. Runtime protocol/lease gates remain separate from this syntactic proof.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  discoverBeginSitesV1,
  independentDiscoverBeginCallSitesV1,
  discoverPoolOwnedBeginSitesV1,
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

describe('Gate E (#4844) transaction-ownership guard — walk exported/private owners and exclusive callbacks (DB-free, static AST)', () => {
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
          'w4c0-operation-registry.ts::runAttendanceResultOperationOnLeaseV1',
          'w4c2-outbox-dispatcher.ts::dispatchAttendanceResultEventOutboxOnLeaseV1',
        ]),
      )
      expect(sites.length).toBeGreaterThanOrEqual(2)
    })

    it('the allowlist is EMPTY for this batch — a full sweep of the exported surface found zero legitimate JOINS/NESTED sites, so every discovered BEGIN site here must be OWNS', () => {
      expect(TXN_OWNERSHIP_ALLOWLIST_V1).toEqual([])
    })

    it('UNKNOWN is EMPTY across the WHOLE exported surface — every classified caller/lease BEGIN site is provably OWNS (or reviewed-allowlisted JOINS/NESTED, none of which exist today)', () => {
      const unknown = sites.filter((s) => s.bucket === 'UNKNOWN')
      expect(unknown).toEqual([])
    })

    it('exact named OWNS census: two private lease helpers and two exclusive plan callbacks preserve all four original owners', () => {
      expect(sites.map((s) => `${s.file}::${s.enclosingFunction}`).sort()).toEqual([
        'w4c0-operation-registry.ts::runAttendanceResultOperationOnLeaseV1',
        'w4c2-outbox-dispatcher.ts::dispatchAttendanceResultEventOutboxOnLeaseV1',
        'w4c3a-rollout-control.ts::planAttendanceCalculationRolloutTransitionV1',
        // W7-3 (#4556): the context-source plan reporter, announced by this
        // census rather than slipping in — which is the guard working, not an
        // obstacle to it. It is the exact structural TWIN of the
        // `w4c3a-rollout-control.ts` sibling directly above: a read-only `plan`
        // that opens `BEGIN ISOLATION LEVEL SERIALIZABLE` on a CALLER-supplied
        // connection, proves that connection idle with `assertConnectionIsIdleV1`
        // BEFORE the `BEGIN` (so a dirty caller cannot have its own transaction
        // silently joined — PostgreSQL only WARNs on a nested `BEGIN`), and
        // unconditionally `ROLLBACK`s in a `finally` on every path, never
        // `COMMIT`. It therefore OWNS its transaction end to end and needs no
        // JOINS/NESTED allowlist entry.
        'w7-context-source-transition.ts::planAttendanceW7ContextSourceTransitionV1',
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

    it("P2-c backstop: every broad BEGIN matches exactly one classified or proven pool-owned site", () => {
      let independentTotal = 0
      const poolOwned: string[] = []
      for (const file of fileNames) {
        const path = join(ATTENDANCE_SRC_DIR, file)
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
        const independent = independentDiscoverBeginCallSitesV1(source)
        const classified = discoverBeginSitesV1(source, file)
        const acquired = discoverPoolOwnedBeginSitesV1(source)
        independentTotal += independent.length
        // Exact per-file membership: equal totals cannot conceal a missed site
        // plus a duplicate classification at a different BEGIN.
        expect([...classified, ...acquired].map(site => site.start).sort((a, b) => a - b))
          .toEqual(independent.map(site => site.start).sort((a, b) => a - b))
        poolOwned.push(...acquired.map(site => `${file}::${site.enclosingFunction}`))
      }
      // Four migrated owners plus the unchanged pool acquisition. New files,
      // private helpers and callbacks cannot be exempted by a matching name.
      expect(poolOwned).toEqual([
        'attendance-timezone-legacy-repair.ts::inspectAttendanceTimezoneLegacyRepairV1',
      ])
      expect(independentTotal).toBe(5)
      expect(sites).toHaveLength(4)
      expect(independentTotal).toBe(sites.length + poolOwned.length)
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
      { file: 'w4c0-operation-registry.ts', enclosingFunction: 'runAttendanceResultOperationOnLeaseV1' },
      { file: 'w4c2-outbox-dispatcher.ts', enclosingFunction: 'dispatchAttendanceResultEventOutboxOnLeaseV1' },
      { file: 'w4c3a-rollout-control.ts', enclosingFunction: 'planAttendanceCalculationRolloutTransitionV1' },
      { file: 'w7-context-source-transition.ts', enclosingFunction: 'planAttendanceW7ContextSourceTransitionV1' },
    ]

    for (const { file, enclosingFunction } of probes) {
      it(`${file}::${enclosingFunction}: removing the same-lease idle proof reds UNKNOWN for exactly this site, on a real-source-text-derived synthetic fixture`, () => {
        const path = join(ATTENDANCE_SRC_DIR, file)
        const text = readFileSync(path, 'utf8')
        const receiver = file === 'w4c3a-rollout-control.ts' || file === 'w7-context-source-transition.ts' ? 'lease' : 'connection'
        const needle = `assertConnectionIsIdleV1(${receiver})`
        // Guard against a silent no-op mutation if the real source's exact shape drifts —
        // exactly one occurrence expected (the call itself; nothing else in either file
        // mentions this literal substring).
        expect(text.split(needle).length - 1).toBe(1)

        // Replace the CALLEE, not the whole statement — keeps the mutated text syntactically
        // valid (still `await <expr>(connection)`) while making the idle-proof predicate
        // (which keys on the callee identifier `assertConnectionIsIdleV1`) stop matching. This
        // is the AST-level equivalent of "the proof call is gone" without needing to reconstruct
        // valid surrounding statement punctuation by hand.
        const mutated = text.replace(needle, `Promise.resolve(${receiver})`)
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
    const CONN_TYPE_DECL = "import { assertConnectionIsIdleV1 } from './w4c0-identity'\n" + 'interface AttendanceW4TransactionClientV1 { query(sqlText: string, params?: unknown[]): Promise<{ rows: unknown[] }> }\n'

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

    it('unrecognized nested closures are not ownership proofs; the independent census still catches their BEGIN', () => {
      const sites = classify(
        `  await assertConnectionIsIdleV1(connection)\n  await Promise.resolve().then(async () => {\n    await connection.query('BEGIN', [])\n  })\n`,
      )
      expect(sites).toEqual([])
      const source = ts.createSourceFile('nested.ts',
        `${CONN_TYPE_DECL}export async function nested(connection: AttendanceW4TransactionClientV1) {
          await assertConnectionIsIdleV1(connection)
          await Promise.resolve().then(async () => { await connection.query('BEGIN') })
        }`, ts.ScriptTarget.ES2022, true)
      expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
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

    it('a private function stays visible and UNKNOWN without a proof, even before it acquires a lease signature', () => {
      const src =
        `${CONN_TYPE_DECL}async function notExported(connection: AttendanceW4TransactionClientV1): Promise<void> {\n` +
        `  await connection.query('BEGIN', [])\n}\n`
      const source = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
      expect(discoverBeginSitesV1(source, 'fixture.ts', [])).toHaveLength(1)
      expect(discoverBeginSitesV1(source, 'fixture.ts', [])[0].bucket).toBe('UNKNOWN')
      expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
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


describe('pool-owned transaction acquisition positive and negative controls',()=>{
  const parse=(text:string)=>ts.createSourceFile('pool.ts',text,ts.ScriptTarget.ES2022,true)
  const positive='export async function read(pool: Pool) { const client = await pool.connect(); try { await client.query("BEGIN READ ONLY") } finally { client.release() } }'
  it('recognizes only the newly acquired const client and keeps the broad count intact',()=>{
    const source=parse(positive)
    expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
    expect(discoverPoolOwnedBeginSitesV1(source)).toEqual([{enclosingFunction:'read',receiverName:'client',statementText:'BEGIN READ ONLY',start:expect.any(Number)}])
    expect(discoverBeginSitesV1(source,'pool.ts')).toEqual([])
  })
  it.each([
    positive.replace('const client','let client'),
    positive.replace('await pool.connect()','pool.client'),
    positive.replace('await pool.connect()','await pool.connect().catch(() => borrowedClient)'),
    positive.replace('try {','try { const client = borrowedClient;'),
    positive.replace('try {','try { const {client} = borrowed;'),
    'function fail():never { throw Error() } export async function read(pool:Pool,fail:()=>Other) { const client=await pool.connect().catch(()=>fail()); await client.query("BEGIN") }',
    positive.replace('const client = await pool.connect();','if (true) { const client = await pool.connect(); }'),
    'export async function read(client: Other) { await client.query("BEGIN") }',
  ])('does not hide mutable, borrowed or conditionally acquired clients',text=>{
    const source=parse(text)
    expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
    expect(discoverPoolOwnedBeginSitesV1(source)).toEqual([])
  })
})


describe('pool acquisition with fixed synchronous and asynchronous connect failure handling',()=>{
  const parse=(text:string)=>ts.createSourceFile('pool.ts',text,ts.ScriptTarget.ES2022,true)
  const acquired='function fail():never { throw Error() } export async function read(pool:Pool) { let client:Client; try { client=await pool.connect() } catch { fail() } try { await client.query("BEGIN READ ONLY") } finally {client.release()} }'
  it('recognizes the unconditional pool acquisition after a never-returning failure catch',()=>{
    expect(discoverPoolOwnedBeginSitesV1(parse(acquired))).toHaveLength(1)
  })
  it.each([
    acquired.replace('catch { fail() }','catch { return borrowedClient }'),
    acquired.replace('pool:Pool','pool:Pool, {fail}:Options'),
    acquired.replace('try { await client.query','client=borrowedClient; try { await client.query'),
    acquired.replace('try { await client.query','[client]=[borrowedClient]; try { await client.query'),
    acquired.replace('try { await client.query','client &&= borrowedClient; try { await client.query'),
    acquired.replace('try { await client.query','for(client of borrowedClients){} try { await client.query'),
    acquired.replace('try { await client.query','const replace=()=>{client=borrowedClient};replace(); try { await client.query'),
    acquired.replace('catch { fail() }','catch (fail) { fail() }'),
  ])('keeps unproven acquisition or reassignment visible to the independent backstop',text=>{
    const source=parse(text)
    expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
    expect(discoverPoolOwnedBeginSitesV1(source)).toEqual([])
  })
})

describe('owning-session migration: exact leases, private helpers and independent closure census', () => {
  const imports = [
    "import { assertConnectionIsIdleV1 } from './w4c0-identity'",
    "import { withAttendanceExclusiveIdleSessionV1 } from './attendance-owning-session'",
  ].join('\n')
  const parse = (text: string) => ts.createSourceFile('lease.ts', text, ts.ScriptTarget.ES2022, true)
  const privateHelper = `${imports}
    export async function entry(connection: AttendanceOwningSessionV1 | AttendanceSessionLeaseV1) {
      return withAttendanceExclusiveIdleSessionV1(connection, lease => owned(lease))
    }
    async function owned(connection: AttendanceSessionLeaseV1) {
      await assertConnectionIsIdleV1(connection)
      await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    }`
  const callback = `${imports}
    export async function plan(connection: AttendanceOwningSessionV1 | AttendanceSessionLeaseV1) {
      return withAttendanceExclusiveIdleSessionV1(connection, async lease => {
        await assertConnectionIsIdleV1(lease)
        await lease.query('BEGIN')
        try { await lease.query('SELECT 1') } finally { await lease.query('ROLLBACK') }
      })
    }`
  const assertRejected = (text: string): void => {
    const source = parse(text)
    const classified = discoverBeginSitesV1(source, 'lease.ts', [])
    const independent = independentDiscoverBeginCallSitesV1(source)
    expect(independent).toHaveLength(1)
    // Unknown OR a census mismatch is a red guard. Neither can silently pass.
    expect(classified.some(site => site.bucket === 'UNKNOWN')
      || classified.length !== independent.length).toBe(true)
    expect(classified.filter(site => site.bucket === 'OWNS')).toEqual([])
  }

  it.each([
    [privateHelper, 'owned', 'connection'],
    [callback, 'plan', 'lease'],
  ])('keeps one non-vacuous BEGIN for a proven lease shape', (text, name, receiver) => {
    const source = parse(text)
    const classified = discoverBeginSitesV1(source, 'lease.ts', [])
    const independent = independentDiscoverBeginCallSitesV1(source)
    expect(classified).toHaveLength(1)
    expect(classified[0]).toMatchObject({ enclosingFunction: name, connParamName: receiver, bucket: 'OWNS' })
    expect(independent).toHaveLength(1)
    expect(classified[0].start).toBe(independent[0].start)
  })

  it.each([
    privateHelper.replace('connection: AttendanceSessionLeaseV1)', 'connection: SomeOtherPoolClient)'),
    privateHelper.replace('async function owned', 'export async function owned'),
    privateHelper.replace('withAttendanceExclusiveIdleSessionV1(connection,', 'unprovenWrapper(connection,'),
    privateHelper.replace('lease => owned(lease)', 'lease => owned(connection)'),
    privateHelper.replace('await assertConnectionIsIdleV1(connection)', 'await Promise.resolve(connection)'),
    privateHelper.replace('await assertConnectionIsIdleV1(connection)', 'if (flag) await assertConnectionIsIdleV1(connection)'),
    privateHelper.replace('await assertConnectionIsIdleV1(connection)', 'assertConnectionIsIdleV1(connection)'),
    privateHelper.replace("await connection.query('BEGIN", "connection = borrowed; await connection.query('BEGIN"),
    privateHelper.replace("await connection.query('BEGIN", "const replace = () => { connection = borrowed }; replace(); await connection.query('BEGIN"),
    privateHelper.replace("await connection.query('BEGIN", "if (flag) { const connection = borrowed; await connection.query('BEGIN")
      .replace("SERIALIZABLE')", "SERIALIZABLE') }"),
    privateHelper + '\nexport async function mixed(borrowed: Other) { return owned(borrowed) }',
    privateHelper + '\nconst alias = owned',
    privateHelper.replace('lease => owned(lease)', 'lease => { const alias = lease; return owned(alias) }'),
    callback.replace('withAttendanceExclusiveIdleSessionV1(connection,', 'unprovenWrapper(connection,'),
    callback.replace('await assertConnectionIsIdleV1(lease)', 'await Promise.resolve(lease)'),
    callback.replace('await assertConnectionIsIdleV1(lease)', 'flag && await assertConnectionIsIdleV1(lease)'),
    callback.replace('await assertConnectionIsIdleV1(lease)', 'try { await assertConnectionIsIdleV1(lease) } catch {}'),
    callback.replace("await lease.query('BEGIN')", "lease = borrowed; await lease.query('BEGIN')"),
    callback.replace("await lease.query('BEGIN')", "const alias = lease; await alias.query('BEGIN')"),
    callback.replace("await lease.query('BEGIN')", "await connection.query('BEGIN')"),
    callback.replace("await lease.query('BEGIN')", "await lease['query']('BEGIN')"),
    callback.replace("'./attendance-owning-session'", "'./fake-name-stamp'"),
    callback.replace("'./w4c0-identity'", "'./fake-name-stamp'"),
    callback.replace('plan(connection:', 'plan(assertConnectionIsIdleV1: Fake, connection:'),
    callback.replace('async lease => {', 'async lease => { const assertConnectionIsIdleV1 = fake;'),
  ])('fails closed for signature/provenance/proof/binding mutations (BEGIN census remains one)', assertRejected)

  it('a proven callback cannot hide a mixed UNKNOWN private BEGIN', () => {
    const source = parse(callback + `
      async function unreviewed(connection: AttendanceSessionLeaseV1) {
        await connection.query('BEGIN')
      }`)
    const classified = discoverBeginSitesV1(source, 'lease.ts', [])
    const independent = independentDiscoverBeginCallSitesV1(source)
    expect(independent).toHaveLength(2)
    expect(classified.map(site => site.bucket)).toEqual(['OWNS', 'UNKNOWN'])
    expect(classified.map(site => site.start)).toEqual(independent.map(site => site.start))
  })

  it.each([
    "async function privateFn(connection: Other) { await connection.query('BEGIN') }",
    "export const arrow = async (connection: Other) => { await connection.query('BEGIN') }",
    "export async function outer(connection: Other) { await body(async () => { await connection.query('BEGIN') }) }",
    "class Owner { async open() { await this.connection.query('START TRANSACTION') } }",
    "export async function computed(connection: Other) { await connection['query']('BEGIN') }",
  ])('the independent walk does not share classifier discovery/pruning/signatures', text => {
    const source = parse(text)
    expect(independentDiscoverBeginCallSitesV1(source)).toHaveLength(1)
    expect(discoverBeginSitesV1(source, 'lease.ts', [])).toEqual([])
  })

  it('documents dynamic SQL and extracted query-function limits; these require separate runtime gates', () => {
    const source = parse(`${imports}
      export async function dynamic(connection: AttendanceSessionLeaseV1, sql: string) {
        await assertConnectionIsIdleV1(connection)
        await connection.query(sql)
        const extracted = connection.query
        await extracted('BEGIN')
        await connection[method]('BEGIN')
        await connection.query(\`BEGIN \${mode}\`)
      }`)
    expect(discoverBeginSitesV1(source, 'lease.ts', [])).toEqual([])
    expect(independentDiscoverBeginCallSitesV1(source)).toEqual([])
  })

  it.each(['JOINS', 'NESTED'] as const)('preserves the explicit %s reasoned allowlist, rejects blank reasons', bucket => {
    const source = parse(`${imports}export async function fixture(connection: AttendanceW4TransactionClientV1) {
      await connection.query('BEGIN')
    }`)
    const entry = { file: 'lease.ts', enclosingFunction: 'fixture', bucket, reason: 'Reviewed fixture exception' }
    expect(discoverBeginSitesV1(source, 'lease.ts', [entry])[0])
      .toMatchObject({ bucket, reason: entry.reason })
    expect(discoverBeginSitesV1(source, 'lease.ts', [{ ...entry, reason: ' ' }])[0].bucket).toBe('UNKNOWN')
  })

  it.each([
    ['w4c0-operation-registry.ts', 'runAttendanceResultOperationOnLeaseV1'],
    ['w4c2-outbox-dispatcher.ts', 'dispatchAttendanceResultEventOutboxOnLeaseV1'],
  ])('%s: deleting exclusive admission leaves the actual private BEGIN UNKNOWN', (file, name) => {
    const path = join(ATTENDANCE_SRC_DIR, file)
    const text = readFileSync(path, 'utf8')
    const needle = 'return withAttendanceExclusiveIdleSessionV1('
    expect(text.split(needle)).toHaveLength(2)
    const original = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)
    expect(discoverBeginSitesV1(original, file).find(site => site.enclosingFunction === name)?.bucket).toBe('OWNS')
    const mutated = ts.createSourceFile(path, text.replace(needle, 'return unprovenWrapper('), ts.ScriptTarget.ES2022, true)
    const sites = discoverBeginSitesV1(mutated, file)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ enclosingFunction: name, bucket: 'UNKNOWN' })
    expect(independentDiscoverBeginCallSitesV1(mutated).map(site => site.statementText))
      .toEqual(independentDiscoverBeginCallSitesV1(original).map(site => site.statementText))
  })

  it.each([
    'w4c0-operation-registry.ts',
    'w4c2-outbox-dispatcher.ts',
    'w4c3a-rollout-control.ts',
    'w7-context-source-transition.ts',
  ])('%s: removing the signature or callback shape cannot erase the independent BEGIN', file => {
    const path = join(ATTENDANCE_SRC_DIR, file)
    const text = readFileSync(path, 'utf8')
    const privateHelper = file === 'w4c0-operation-registry.ts' || file === 'w4c2-outbox-dispatcher.ts'
    const needle = privateHelper ? 'connection: AttendanceSessionLeaseV1,' : 'async (lease) => {'
    expect(text).toContain(needle)
    if (privateHelper) expect(text.split(needle)).toHaveLength(2)
    // Private signatures go unknown to the narrow type gate. Callback sites lose
    // their exact wrapper instead; their lease declaration alone is insufficient.
    const mutatedText = privateHelper ? text.replace(needle, 'connection: OtherClient,')
      : text.replaceAll('withAttendanceExclusiveIdleSessionV1(', 'unprovenWrapper(')
    expect(mutatedText).not.toBe(text)
    const mutated = ts.createSourceFile(path, mutatedText, ts.ScriptTarget.ES2022, true)
    expect(independentDiscoverBeginCallSitesV1(mutated)).toHaveLength(1)
    expect(discoverBeginSitesV1(mutated, file)).toEqual([])
  })
})
