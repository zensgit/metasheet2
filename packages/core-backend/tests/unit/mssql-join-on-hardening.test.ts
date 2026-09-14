import { describe, expect, it, vi } from 'vitest'

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import type { DataSourceConfig, QueryOptions } from '../../src/data-adapters/BaseAdapter'
import { isPureReadStatement } from '../../src/data-adapters/outbound-sql-write-gate'

// G52B — `MSSQLAdapter.select()`'s JOIN clause: the ON predicate is STRUCTURE, not SQL text.
//
// Design:       docs/development/mssql-join-on-hardening-design-20260912.md
// Verification: docs/development/mssql-join-on-hardening-verification-20260912.md
//
// The predecessor (#5614 / G52) hardened every IDENTIFIER this adapter emits and said so in its own
// scope note: `join.on` was a caller-supplied SQL string spliced in verbatim, and its test's
// `on: '1 = 1'` certified the join TARGET only. This file replaces that placeholder with the real
// thing: what the adapter emits for a structured join, byte for byte, and what it refuses — WITHOUT
// sending a statement — for everything else.
//
// Read the negative cases with their reason attached. Some payloads are refused by the CHARACTER RULE
// (`;`, `--`, `(`, `'`, `*`, `=` are outside the identifier class), four-part names by the LINKED
// SERVER rule, and the rest — including injection-SHAPED text made only of letters and spaces — are
// refused because a STRING `on` is not accepted at all. Where a hostile-looking side does pass the
// character rule, the test asserts what actually happens (bracketed, inert, still a pure read), not a
// refusal this code does not perform.

const CJK_TABLE = '销售订单'
const CJK_SCHEMA = '仓库'
const CJK_COLUMN = '物料编码'

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

// `joins` is typed; the negative matrix deliberately passes shapes the TYPE forbids, because a type is
// not a guard and every one of them is reachable from JS (or from an `as QueryOptions` cast).
const withJoins = (joins: unknown): QueryOptions => ({ joins } as unknown as QueryOptions)

async function refusal(options: QueryOptions, fp = fakePool()): Promise<{ error: Error & { status?: number; code?: string }; calls: string[] }> {
  let thrown: unknown
  try {
    await adapterWithPool(fp).select(CJK_TABLE, options)
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected select() to refuse, it returned normally').toBeInstanceOf(Error)
  return { error: thrown as Error & { status?: number; code?: string }, calls: fp.calls }
}

describe('G52B — a structured JOIN is emitted, byte for byte', () => {
  it('select(): { left, right } becomes ON <quoted> = <quoted>, default INNER', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      limit: 5,
      joins: [{
        table: `${CJK_SCHEMA}.物料`,
        on: { left: `${CJK_TABLE}.${CJK_COLUMN}`, right: `${CJK_SCHEMA}.物料.${CJK_COLUMN}` },
      }],
    })
    expect(fp.calls).toHaveLength(1)
    expect(fp.calls[0]).toBe(
      'SELECT TOP (5) * FROM [销售订单] INNER JOIN [仓库].[物料] ' +
      'ON [销售订单].[物料编码] = [仓库].[物料].[物料编码]'
    )
    // The finished statement is still a pure READ to the default-deny gate — the JOIN did not make the
    // adapter's own read look like a write, which is the failure mode bracketing exists to prevent.
    expect(isPureReadStatement(fp.calls[0])).toBe(true)
  })

  it('select(): explicit type + explicit op = are the same bytes, alongside WHERE/ORDER BY', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      limit: 3,
      select: [CJK_COLUMN],
      joins: [{
        table: `${CJK_SCHEMA}.物料`,
        type: 'left',
        on: { left: `${CJK_TABLE}.${CJK_COLUMN}`, right: `${CJK_SCHEMA}.物料.${CJK_COLUMN}`, op: '=' },
      }],
      where: { [`${CJK_TABLE}.${CJK_COLUMN}`]: 'M-1' },
      orderBy: [{ column: CJK_COLUMN, direction: 'asc' }],
    })
    expect(fp.calls[0]).toBe(
      'SELECT TOP (3) [物料编码] FROM [销售订单] LEFT JOIN [仓库].[物料] ' +
      'ON [销售订单].[物料编码] = [仓库].[物料].[物料编码] ' +
      'WHERE [销售订单].[物料编码] = @p0 ORDER BY [物料编码] ASC'
    )
    // The VALUE never enters statement text — it is bound, exactly as without a join.
    expect(fp.calls[0]).not.toContain('M-1')
    expect(isPureReadStatement(fp.calls[0])).toBe(true)
  })

  it('select(): two joins keep their order and each gets its own allowlisted keyword', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      limit: 1,
      joins: [
        { table: 'dbo.a', type: 'right', on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } },
        { table: 'dbo.b', type: 'full', on: { left: 'dbo.b.id', right: `${CJK_TABLE}.b_id` } },
      ],
    })
    expect(fp.calls[0]).toBe(
      'SELECT TOP (1) * FROM [销售订单] ' +
      'RIGHT JOIN [dbo].[a] ON [dbo].[a].[id] = [销售订单].[a_id] ' +
      'FULL JOIN [dbo].[b] ON [dbo].[b].[id] = [销售订单].[b_id]'
    )
  })

  it('select(): a "]" inside a join side is doubled, not passed through', async () => {
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      limit: 1,
      joins: [{ table: 'dbo.a', on: { left: 'a] DROP TABLE x', right: 'dbo.a.id' } }],
    })
    expect(fp.calls[0]).toContain('ON [a]] DROP TABLE x] = [dbo].[a].[id]')
    expect(fp.calls[0]).not.toContain('ON [a] DROP TABLE x] =')
    expect(isPureReadStatement(fp.calls[0])).toBe(true)
  })

  it('a letters-and-spaces side is NOT refused — it is bracketed, and that is what makes it inert', async () => {
    // Scope, stated rather than implied: G52 admits space separators because customers' column names
    // have them, so `a UNION ALL SELECT x FROM sys` passes the CHARACTER rule. The brackets are the
    // defence: it lands as ONE identifier, the server reads it as a (missing) column, and the write
    // gate — which strips bracketed identifiers with the same `]]` rule — sees one token, not a verb.
    const fp = fakePool()
    await adapterWithPool(fp).select(CJK_TABLE, {
      limit: 1,
      joins: [{ table: 'dbo.a', on: { left: 'a UNION ALL SELECT x FROM sys', right: 'dbo.a.id' } }],
    })
    expect(fp.calls[0]).toBe(
      'SELECT TOP (1) * FROM [销售订单] INNER JOIN [dbo].[a] ' +
      'ON [a UNION ALL SELECT x FROM sys] = [dbo].[a].[id]'
    )
    expect(isPureReadStatement(fp.calls[0])).toBe(true)
  })
})

describe('G52B — a string ON is refused, and NO statement is sent', () => {
  // Every one of these is a real T-SQL ON expression that the pre-G52B adapter would have concatenated
  // verbatim. `1 = 1` heads the list on purpose: it is the exact placeholder the G52 test used, and it
  // is refused now, which is what "the placeholder was not a certification" means in code.
  const STRING_PAYLOADS: Array<[label: string, on: string]> = [
    ['the old inert placeholder', '1 = 1'],
    ['a well-shaped equality string', 'a.b = c.d'],
    ['UNION exfiltration', '1 = 1 UNION ALL SELECT password, 1 FROM dbo.users'],
    ['statement batching', "1 = 1; DROP TABLE dbo.t"],
    ['line comment', '1 = 1 --'],
    ['block comment', '1 = 1 /* x */'],
    ['correlated subquery', '1 = 1 OR EXISTS (SELECT 1 FROM dbo.users)'],
    ['function call', 'a.b = dbo.f(1)'],
    ['four-part linked-server name', 'a.b = srv.db.dbo.t'],
    ['a bracketed four-part name', 'a.b = [srv].[db].[dbo].[t]'],
    ['empty string', ''],
  ]

  it.each(STRING_PAYLOADS)('refuses %s with a coded 400 and sends nothing', async (_label, on) => {
    const { error, calls } = await refusal(withJoins([{ table: 'dbo.a', on }]))
    expect(error.code).toBe('SQLSERVER_JOIN_ON_UNSUPPORTED')
    expect(error.status).toBe(400)
    expect(calls).toHaveLength(0)
    // The refusal names the FIELD, never the caller's text — a hostile `on` must not ride an error
    // message into a log line or an HTTP body (routes/data-sources.ts forwards coded messages).
    expect(error.message).toContain('joins[0].on')
    if (on) expect(error.message).not.toContain(on)
  })

  it('names the offending join by index when a later join is the bad one', async () => {
    const { error, calls } = await refusal(withJoins([
      { table: 'dbo.a', on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } },
      { table: 'dbo.b', on: '1 = 1' },
    ]))
    expect(error.message).toContain('joins[1].on')
    expect(calls).toHaveLength(0)
  })
})

describe('G52B — a structured ON that breaks the identifier rule is refused, and NO statement is sent', () => {
  const SIDE_PAYLOADS: Array<[label: string, left: string]> = [
    ['four-part (LINKED SERVER) name', 'srv.db.dbo.t'],
    ['statement terminator', 'a; DROP TABLE dbo.t'],
    ['line comment', 'a --'],
    ['subquery parenthesis', 'a (SELECT 1)'],
    ['string literal quote', "a' OR '1'='1"],
    ['star', 'a.*'],
    ['an equality operator', 'a = b'],
    ['a pre-bracketed name pasted from SSMS', '[dbo].[a]'],
    ['empty', ''],
    ['an empty segment', 'dbo..a'],
  ]

  it.each(SIDE_PAYLOADS)('refuses a left side that is %s', async (_label, left) => {
    const { error, calls } = await refusal(withJoins([
      { table: 'dbo.a', on: { left, right: 'dbo.a.id' } },
    ]))
    expect(error.code).toBe('SQLSERVER_IDENTIFIER_INVALID')
    expect(error.status).toBe(400)
    expect(calls).toHaveLength(0)
    expect(error.message).toMatch(/Invalid identifier/)
  })

  it('refuses the RIGHT side by the same rule (both sides go through one quoter)', async () => {
    const { error, calls } = await refusal(withJoins([
      { table: 'dbo.a', on: { left: 'dbo.a.id', right: 'srv.db.dbo.t' } },
    ]))
    expect(error.code).toBe('SQLSERVER_IDENTIFIER_INVALID')
    expect(calls).toHaveLength(0)
  })

  it('keeps the refusal log-safe: a newline in a join side never reaches the message raw', async () => {
    const { error, calls } = await refusal(withJoins([
      { table: 'dbo.a', on: { left: 'evil\nDELETE FROM dbo.t --', right: 'dbo.a.id' } },
    ]))
    expect(error.message).not.toContain('\n')
    expect(error.message).toContain('\\n')
    expect(calls).toHaveLength(0)
  })

  const SHAPE_PAYLOADS: Array<[label: string, on: unknown, code: string]> = [
    ['a non-= operator', { left: 'a.b', right: 'c.d', op: '<>' }, 'SQLSERVER_JOIN_ON_OPERATOR_INVALID'],
    ['a LIKE operator', { left: 'a.b', right: 'c.d', op: 'LIKE' }, 'SQLSERVER_JOIN_ON_OPERATOR_INVALID'],
    ['a range operator', { left: 'a.b', right: 'c.d', op: '>' }, 'SQLSERVER_JOIN_ON_OPERATOR_INVALID'],
    ['an unknown key (a typo must not be silently emitted as =)', { left: 'a.b', right: 'c.d', operator: '<>' }, 'SQLSERVER_JOIN_ON_INVALID'],
    ['a raw-SQL smuggling key', { left: 'a.b', right: 'c.d', sql: 'OR 1=1' }, 'SQLSERVER_JOIN_ON_INVALID'],
    ['an array', ['a.b', 'c.d'], 'SQLSERVER_JOIN_ON_INVALID'],
    ['null', null, 'SQLSERVER_JOIN_ON_INVALID'],
    ['undefined', undefined, 'SQLSERVER_JOIN_ON_INVALID'],
    ['a number', 1, 'SQLSERVER_JOIN_ON_INVALID'],
    ['a missing right side', { left: 'a.b' }, 'SQLSERVER_JOIN_ON_INVALID'],
    ['a non-string left side', { left: { toString: () => 'a.b' }, right: 'c.d' }, 'SQLSERVER_JOIN_ON_INVALID'],
  ]

  it.each(SHAPE_PAYLOADS)('refuses %s', async (_label, on, code) => {
    const { error, calls } = await refusal(withJoins([{ table: 'dbo.a', on }]))
    expect(error.code).toBe(code)
    expect(error.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('G52B — the JOIN TYPE is an allowlist, not a toUpperCase()', () => {
  const TYPE_PAYLOADS = [
    'inner UNION ALL SELECT password, 1 FROM dbo.users -- ',
    'cross',
    'outer',
    'inner ',
    '',
    'INNER JOIN dbo.x ON 1=1 INNER',
  ]

  it.each(TYPE_PAYLOADS)('refuses type %j and sends nothing', async (type) => {
    const { error, calls } = await refusal(withJoins([
      { table: 'dbo.a', type, on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } },
    ]))
    expect(error.code).toBe('SQLSERVER_JOIN_TYPE_INVALID')
    expect(error.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts the four documented types, case-insensitively, and nothing else', async () => {
    for (const [type, keyword] of [['inner', 'INNER'], ['LEFT', 'LEFT'], ['Right', 'RIGHT'], ['full', 'FULL']]) {
      const fp = fakePool()
      await adapterWithPool(fp).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', type: type as 'inner', on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } }],
      })
      expect(fp.calls[0]).toContain(`${keyword} JOIN [dbo].[a] ON `)
    }
  })

  it('a prototype key is not a join type (Map lookup, not object indexing)', async () => {
    for (const type of ['constructor', 'toString', '__proto__']) {
      const { error, calls } = await refusal(withJoins([
        { table: 'dbo.a', type, on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } },
      ]))
      expect(error.code).toBe('SQLSERVER_JOIN_TYPE_INVALID')
      expect(calls).toHaveLength(0)
    }
  })
})

describe('G52B — mutation probes (in memory, nothing written)', () => {
  const GOOD_JOIN = { table: 'dbo.a', on: { left: 'a] DROP TABLE x', right: 'dbo.a.id' } }

  it('MUTATION 1 — join sides not routed through the quoter: the escape assertions go red', async () => {
    // The real test pins `ON [a]] DROP TABLE x] = [dbo].[a].[id]` as SENT. Replace the quoter with
    // identity and that statement is never produced — proof the assertion is wired to the ONE rule and
    // not to an accident of formatting. TWO payloads, because they land on different sides of the
    // adapter's second line of defence:
    //   (a) `a] DROP TABLE x` — unbracketed, the verbs become visible tokens, so the default-deny write
    //       gate in query() REFUSES the statement (403) and nothing is sent at all;
    //   (b) `a UNION ALL SELECT x FROM sys` — read-grammar keywords only, so the gate passes it and the
    //       mutant SHIPS an ON clause that is no longer one identifier. The gate is a backstop for (a),
    //       not for (b); the brackets are what cover both.
    vi.resetModules()
    vi.doMock('@metasheet/mssql-readonly-utils', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@metasheet/mssql-readonly-utils')
      return { ...actual, quoteSqlServerIdentifier: (value: string) => value }
    })
    try {
      const { MSSQLAdapter: Unquoted } = await import('../../src/data-adapters/MSSQLAdapter')

      const blocked = fakePool()
      let thrown: unknown
      try {
        await adapterWithPool(blocked, Unquoted as typeof MSSQLAdapter).select(CJK_TABLE, { limit: 1, joins: [GOOD_JOIN] })
      } catch (error) { thrown = error }
      expect((thrown as { code?: string })?.code).toBe('OUTBOUND_SQL_WRITE_DISABLED')
      expect(blocked.calls).toHaveLength(0)                            // ← the real test pins 1, bracketed

      const shipped = fakePool()
      await adapterWithPool(shipped, Unquoted as typeof MSSQLAdapter).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', on: { left: 'a UNION ALL SELECT x FROM sys', right: 'dbo.a.id' } }],
      })
      expect(shipped.calls[0]).toContain('ON a UNION ALL SELECT x FROM sys = dbo.a.id') // live SQL
      expect(shipped.calls[0]).not.toContain('[a UNION ALL SELECT x FROM sys]')         // ← the real test asserts this
      expect(isPureReadStatement(shipped.calls[0])).toBe(true)                          // the gate cannot see it
    } finally {
      vi.doUnmock('@metasheet/mssql-readonly-utils')
      vi.resetModules()
    }
  })

  it('MUTATION 2 — the same rule WITHOUT the four-part refusal: the linked-server case goes red', async () => {
    // Per-segment rule kept intact (real `quoteSqlServerIdentifierPart`), only the <=3-part cap removed.
    // The real test pins a refusal for `srv.db.dbo.t`; under this mutant it is accepted and emitted.
    vi.resetModules()
    vi.doMock('@metasheet/mssql-readonly-utils', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@metasheet/mssql-readonly-utils')
      const quotePart = actual.quoteSqlServerIdentifierPart as (part: string, field?: string) => string
      return {
        ...actual,
        quoteSqlServerIdentifier: (value: string, field?: string) =>
          String(value).split('.').map((part) => quotePart(part, field)).join('.'),
      }
    })
    try {
      const { MSSQLAdapter: NoPartCap } = await import('../../src/data-adapters/MSSQLAdapter')
      const fp = fakePool()
      await adapterWithPool(fp, NoPartCap as typeof MSSQLAdapter).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', on: { left: 'srv.db.dbo.t', right: 'dbo.a.id' } }],
      })
      expect(fp.calls).toHaveLength(1)                                  // ← the real test pins 0
      expect(fp.calls[0]).toContain('ON [srv].[db].[dbo].[t] = [dbo].[a].[id]')
    } finally {
      vi.doUnmock('@metasheet/mssql-readonly-utils')
      vi.resetModules()
    }
  })

  it('MUTATION 3 — the operator check removed: a non-= comparison reaches SQL', async () => {
    // The mutant is `buildJoinOn` minus ONE line (the `op !== '='` refusal); both sides still quote.
    const proto = MSSQLAdapter.prototype as unknown as Record<string, unknown>
    const real = proto.buildJoinOn
    proto.buildJoinOn = function (this: MSSQLAdapter, on: unknown, field: string): string {
      const predicate = on as Record<string, unknown>
      const side = (proto.quoteJoinSide as (v: unknown, f: string) => string).bind(this)
      return `${side(predicate.left, `${field}.left`)} ${String(predicate.op ?? '=')} ${side(predicate.right, `${field}.right`)}`
    }
    try {
      const fp = fakePool()
      await adapterWithPool(fp).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id`, op: '<>' } } as never],
      })
      expect(fp.calls).toHaveLength(1)                                  // ← the real test pins 0
      expect(fp.calls[0]).toContain('ON [dbo].[a].[id] <> [销售订单].[a_id]')
    } finally {
      proto.buildJoinOn = real
    }
  })

  it('MUTATION 4 — the string branch restored (pre-G52B behaviour): the exfiltration ships, and the write gate calls it a READ', async () => {
    // This is the whole reason the string form is refused rather than filtered. Under the mutant the
    // caller's SQL is concatenated verbatim; `isPureReadStatement` — the adapter's default-deny gate —
    // then answers TRUE, because UNION/SELECT/FROM are read-grammar keywords. No layer below catches it.
    const proto = MSSQLAdapter.prototype as unknown as Record<string, unknown>
    const real = proto.buildJoinOn
    proto.buildJoinOn = function (this: MSSQLAdapter, on: unknown, field: string): string {
      if (typeof on === 'string') return on
      return (real as (o: unknown, f: string) => string).call(this, on, field)
    }
    try {
      const fp = fakePool()
      await adapterWithPool(fp).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', on: '1 = 1 UNION ALL SELECT password, 1 FROM dbo.users' }],
      })
      expect(fp.calls).toHaveLength(1)                                  // ← the real test pins 0
      expect(fp.calls[0]).toContain('ON 1 = 1 UNION ALL SELECT password, 1 FROM dbo.users')
      expect(isPureReadStatement(fp.calls[0])).toBe(true)               // the gate is blind to it
    } finally {
      proto.buildJoinOn = real
    }
  })

  it('MUTATION 5 — the type allowlist replaced by toUpperCase(): caller text lands in front of JOIN', async () => {
    const proto = MSSQLAdapter.prototype as unknown as Record<string, unknown>
    const real = proto.joinTypeKeyword
    proto.joinTypeKeyword = function (type: unknown): string {
      return (typeof type === 'string' ? type.toUpperCase() : '') || 'INNER'
    }
    try {
      // Again two payloads, on either side of the write gate: a write verb in the type is caught by it
      // (403, nothing sent), while read-grammar text is not — the mutant happily ships caller-chosen
      // keywords in front of JOIN. The real allowlist refuses BOTH before any statement exists.
      const blocked = fakePool()
      let thrown: unknown
      try {
        await adapterWithPool(blocked).select(CJK_TABLE, {
          limit: 1,
          joins: [{ table: 'dbo.a', type: 'inner MERGE dbo.t USING' as never, on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } }],
        })
      } catch (error) { thrown = error }
      expect((thrown as { code?: string })?.code).toBe('OUTBOUND_SQL_WRITE_DISABLED')
      expect(blocked.calls).toHaveLength(0)

      const fp = fakePool()
      await adapterWithPool(fp).select(CJK_TABLE, {
        limit: 1,
        joins: [{ table: 'dbo.a', type: 'left outer' as never, on: { left: 'dbo.a.id', right: `${CJK_TABLE}.a_id` } }],
      })
      expect(fp.calls).toHaveLength(1)                                  // ← the real test pins 0
      expect(fp.calls[0]).toContain('LEFT OUTER JOIN [dbo].[a]')
    } finally {
      proto.joinTypeKeyword = real
    }
  })
})
