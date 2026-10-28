import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { quoteSqlServerIdentifier } from '@metasheet/mssql-readonly-utils'
import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { isPureReadStatement } from '../../src/data-adapters/outbound-sql-write-gate'

// G52 — a customer DBA's 中文表名 / 含空格的列名 must READ, and must still be un-injectable.
//
// Design: docs/development/mssql-unicode-identifiers-design-20260910.md
// Verification: docs/development/mssql-unicode-identifiers-verification-20260910.md
//
// This file covers the three things the helper package's own suite cannot see: the ADAPTER actually
// routes every clause through the quoter, the finished statement still classifies as a pure READ at the
// write gate, and the rejection path does not spill arbitrary text into an error/log line.

const require_ = createRequire(import.meta.url)

const CJK_TABLE = '销售订单'
const CJK_SCHEMA = '仓库'
const CJK_COLUMN = '物料编码'
const SPACED_COLUMN = '供应商 名称'

// A fake mssql pool that records the statement text as sent.
function fakePool() {
  const calls: string[] = []
  const pool = {
    request() {
      const req = {
        input() { return req },
        async query(sql: string) { calls.push(sql); return { recordset: [], rowsAffected: [] } },
      }
      return req
    },
    async close() {},
  }
  return { pool, calls }
}

function adapterWithPool(fp: ReturnType<typeof fakePool>, Ctor: typeof MSSQLAdapter = MSSQLAdapter): MSSQLAdapter {
  const a = new Ctor({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', database: 'ERP' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })
  const internal = a as unknown as { pool: unknown; connected: boolean }
  internal.pool = fp.pool
  internal.connected = true
  return a
}

describe('G52 — the shared identifier contract actually gates', () => {
  it('runs the mssql-readonly-utils identifier suite (matrix, round-trip property, mutation probes)', () => {
    // Executing the package's own suite HERE is what makes it a GATE. Nothing in CI runs
    // `pnpm --filter @metasheet/mssql-readonly-utils test` — no workflow references that package's
    // scripts — so the suite would be inert coverage sitting next to the code it certifies. The
    // core-backend vitest run IS a required context, so requiring the file (it throws on the first
    // failed assertion) puts the whole matrix behind a merge gate without duplicating a single case.
    const suite = path.resolve(
      __dirname, '..', '..', '..', 'mssql-readonly-utils', '__tests__', 'identifier-unicode.test.cjs',
    )
    expect(() => require_(suite)).not.toThrow()
  })
})

describe('G52 — MSSQLAdapter emits Unicode identifiers bracketed, in every clause', () => {
  it('select(): table, schema, projection, WHERE key and ORDER BY are all quoted', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(`${CJK_SCHEMA}.${CJK_TABLE}`, {
      select: [CJK_COLUMN, SPACED_COLUMN],
      where: { [SPACED_COLUMN]: 'ACME' },
      orderBy: [{ column: CJK_COLUMN, direction: 'asc' }],
    })
    const sql = fp.calls[0]
    expect(sql).toContain(`FROM [${CJK_SCHEMA}].[${CJK_TABLE}]`)
    expect(sql).toContain(`[${CJK_COLUMN}], [${SPACED_COLUMN}]`)
    expect(sql).toContain(`WHERE [${SPACED_COLUMN}] = @p0`)
    expect(sql).toContain(`ORDER BY [${CJK_COLUMN}] ASC`)
    // The VALUE travels as a bound parameter; it is never in the statement text.
    expect(sql).not.toContain('ACME')
    // Nothing bare survives: every occurrence of the table name is inside brackets.
    expect(sql.split(CJK_TABLE).length - 1).toBe(1)
    expect(sql).not.toMatch(new RegExp(`[^\\[]${CJK_TABLE}`))
  })

  it('select(): a table name containing "]" is escaped, not passed through', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select('a] DROP TABLE x', {})
    expect(fp.calls[0]).toContain('FROM [a]] DROP TABLE x]')
    expect(fp.calls[0]).not.toContain('FROM [a] DROP TABLE x]')
  })

  // SCOPE: this covers the join TARGET and the paging clause. It does NOT cover `join.on`, which
  // `select()` splices in verbatim as a caller-supplied SQL expression (see the note at that line and
  // design §9.1) — `on: '1 = 1'` below is an inert placeholder needed to build the clause, not a
  // certification of the ON path. Naming that here so a future reader does not read this test as
  // "JOINs are covered".
  it('select(): join TARGET and offset paging quote the same way (ON expression NOT covered)', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      joins: [{ table: `${CJK_SCHEMA}.物料`, type: 'inner', on: '1 = 1' }],
      orderBy: [{ column: CJK_COLUMN, direction: 'desc' }],
      offset: 10,
      limit: 5,
    })
    const sql = fp.calls[0]
    expect(sql).toContain(`INNER JOIN [${CJK_SCHEMA}].[物料]`)
    expect(sql).toContain(`ORDER BY [${CJK_COLUMN}] DESC OFFSET 10 ROWS`)
  })

  it('refuses an identifier the rule rejects — and the refusal is log-safe', async () => {
    await expect(adapterWithPool(fakePool()).select('bad-table', {})).rejects.toThrow(/Invalid identifier/)
    await expect(adapterWithPool(fakePool()).select('srv.db.dbo.t', {})).rejects.toThrow(/Invalid identifier/)

    const quote = (id: string) =>
      (adapterWithPool(fakePool()) as unknown as { quoteIdent(s: string): string }).quoteIdent(id)

    // A rejected identifier is arbitrary text by definition. It must not reach the message raw, or a
    // newline in a table name would split the log record it lands in.
    let thrown: unknown
    try { quote('evil\nDELETE FROM t --') } catch (error) { thrown = error }
    const message = String((thrown as Error).message)
    expect(message).toMatch(/Invalid identifier/)
    expect(message).not.toContain('\n')
    expect(message).toContain('\\n') // escaped, so the text is still diagnosable
    expect((thrown as { code?: string }).code).toBe('SQLSERVER_IDENTIFIER_INVALID')

    // JSON.stringify escapes C0 controls but leaves U+0085 / U+2028 / U+2029 / U+FEFF / bidi marks
    // RAW, and U+2028-9 end a line for a JSON/JS log consumer exactly like `\n`. Every one of them is
    // REFUSED by the rule, which is why they can reach this message at all — so the message must carry
    // none of them. One assertion over the whole class, not one per code point.
    for (const hostile of [
      'evil\u2028DELETE FROM t',
      'evil\u2029DELETE FROM t',
      'evil\u0085DELETE FROM t',
      'evil\ufeffDELETE FROM t',
      'evil\u202eDELETE FROM t',
      'evil\u0007DELETE FROM t',
    ]) {
      let hostileThrown: unknown
      try { quote(hostile) } catch (error) { hostileThrown = error }
      const rendered = String((hostileThrown as Error).message)
      expect(rendered).toMatch(/Invalid identifier/)
      expect(/[\p{C}\p{Zl}\p{Zp}]/u.test(rendered), `${JSON.stringify(hostile)} left an unprintable code point in the message`).toBe(false)
    }

    // …and it is bounded, so a multi-kilobyte name cannot flood the log through this channel.
    let longThrown: unknown
    try { quote('x'.repeat(50_000)) } catch (error) { longThrown = error }
    expect(String((longThrown as Error).message).length).toBeLessThan(260)
  })
})

describe('G52 — the finished statement still reads as a pure READ at the write gate', () => {
  // The gate classifies statement TEXT after stripping bracketed identifiers with the SAME `]]` rule
  // the quoter applies. That agreement is the reason a hostile-looking object name does not turn a
  // legitimate read into a refused "write": both sides see one identifier, not a verb.
  it('an escaped, injection-shaped table name leaves the statement a READ', () => {
    const sql = `SELECT TOP (10) * FROM ${quoteSqlServerIdentifier('a] DROP TABLE x')}`
    expect(sql).toBe('SELECT TOP (10) * FROM [a]] DROP TABLE x]')
    expect(isPureReadStatement(sql)).toBe(true)
  })

  it('the SAME name emitted WITHOUT the escape is caught by the gate as a write', () => {
    // i.e. if the quoter ever stopped doubling `]`, the injected verbs become visible tokens. The
    // escape is the primary defence; this is the second, independent one.
    const unescaped = 'SELECT TOP (10) * FROM [a] DROP TABLE x]'
    expect(isPureReadStatement(unescaped)).toBe(false)
  })

  it('a Chinese/spaced name is invisible to the classifier, exactly like an ASCII one', () => {
    const sql =
      `SELECT TOP (10) ${quoteSqlServerIdentifier(SPACED_COLUMN)} FROM ` +
      `${quoteSqlServerIdentifier(`${CJK_SCHEMA}.${CJK_TABLE}`)} WHERE ${quoteSqlServerIdentifier('key')} = @p0`
    expect(isPureReadStatement(sql)).toBe(true)
  })
})

describe('G52 — mutation probes (in memory, nothing written)', () => {
  it('MUTATION: the adapter not routing the table through the quoter reds the shape assertions', async () => {
    // Proves the assertions above are wired to the ONE quoter rather than to an accident of formatting:
    // replace it with identity and the bracketed forms the tests pin all disappear.
    vi.resetModules()
    vi.doMock('@metasheet/mssql-readonly-utils', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@metasheet/mssql-readonly-utils')
      return { ...actual, quoteSqlServerIdentifier: (value: string) => value }
    })
    try {
      const { MSSQLAdapter: Unquoted } = await import('../../src/data-adapters/MSSQLAdapter')
      const fp = fakePool()
      await adapterWithPool(fp, Unquoted as typeof MSSQLAdapter).select(`${CJK_SCHEMA}.${CJK_TABLE}`, {
        where: { [SPACED_COLUMN]: 'ACME' },
      })
      const sql = fp.calls[0]
      expect(sql).toContain(`FROM ${CJK_SCHEMA}.${CJK_TABLE}`) // bare — the outage/injection shape
      expect(sql).not.toContain(`[${CJK_SCHEMA}].[${CJK_TABLE}]`) // ← what the real test asserts
      expect(sql).not.toContain(`[${SPACED_COLUMN}]`)
    } finally {
      vi.doUnmock('@metasheet/mssql-readonly-utils')
      vi.resetModules()
    }
  })

  it('MUTATION: an unescaped emission is a real injection, not a cosmetic difference', () => {
    // What the missing `]]` actually buys an attacker, spelled out on the same string the matrix pins.
    const escaped = quoteSqlServerIdentifier('a] DROP TABLE x')
    const unescaped = `[${'a] DROP TABLE x'}]`
    expect(escaped).not.toBe(unescaped)
    expect(isPureReadStatement(`SELECT * FROM ${escaped}`)).toBe(true)
    expect(isPureReadStatement(`SELECT * FROM ${unescaped}`)).toBe(false)
  })
})
