/**
 * #5831 part B — the inbox scope is applied IN SQL, in the WHERE of every query that counts or lists,
 * and it binds as a conjunct.
 *
 * CommentService runs here against a real Kysely query builder whose driver only records the compiled SQL
 * (no database). What is pinned:
 *   - getInbox puts the scope in the COUNT and in the page query, before ORDER BY / LIMIT / OFFSET, so
 *     `total` counts exactly the rows the pages list (filtering the page afterwards would make `total`
 *     too big and pages come back short);
 *   - getUnreadSummary / getUnreadCount count only inside the same scope;
 *   - the WHERE has NO top-level `or`: Kysely joins `.where()` calls with a bare `and`, and the inbox
 *     predicate `(mentioned) or unread` used to be unwrapped, which made the mentioned branch skip every
 *     filter after it (the scope included) and the unread branch skip the author filter;
 *   - denied rows are excluded per (sheet, row) pair, with the row compared trimmed like the id gate;
 *   - the candidate listers select ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; parameters: readonly unknown[] }>,
  rows: [] as unknown[][],
}))

vi.mock('../../src/db/db', async () => {
  const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = await import('kysely')
  const connection = {
    async executeQuery(compiled: { sql: string; parameters: readonly unknown[] }) {
      captured.queries.push({ sql: compiled.sql, parameters: compiled.parameters })
      return { rows: captured.rows.shift() ?? [] }
    },
    // eslint-disable-next-line require-yield
    async *streamQuery(): AsyncGenerator<never> {
      throw new Error('streaming is not used by CommentService')
    },
  }
  const driver = {
    async init() {},
    async acquireConnection() { return connection },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  return {
    db: new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver as never,
        createIntrospector: (db: Kysely<any>) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    }),
  }
})

vi.mock('../../src/multitable/record-subscription-service', () => ({
  notifyRecordSubscribersWithKysely: vi.fn(),
}))

import { CommentService } from '../../src/services/CommentService'
import { JS_TRIM_WHITESPACE } from '../../src/utils/js-trim-whitespace'
import type { CommentInboxScope } from '../../src/di/identifiers'

const USER = 'user-fake-viewer'
const SCOPE: CommentInboxScope = {
  sheetIds: ['sheet-fake-a', 'sheet-fake-b'],
  deniedRows: [{ spreadsheetId: 'sheet-fake-b', rowId: 'row-fake-denied' }],
}

function makeService() {
  const collab = { broadcastTo: vi.fn(), sendTo: vi.fn(), getRoomMembers: vi.fn(async () => []) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return new CommentService(collab as never, logger as never)
}

/** Offsets of `token` at paren depth 0 (subqueries in the SELECT list have their own WHERE). */
function topLevelOffsets(text: string, token: string): number[] {
  const found: number[] = []
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (depth === 0 && text.startsWith(token, i)) found.push(i)
  }
  return found
}

/** The top-level WHERE clause of a compiled query (up to ORDER BY / GROUP BY / LIMIT, or the end). */
function whereOf(text: string): string {
  const starts = topLevelOffsets(text, ' where ')
  expect(starts, text).toHaveLength(1)
  const rest = text.slice(starts[0]! + ' where '.length)
  const ends = [' order by ', ' group by ', ' limit ', ' offset ']
    .flatMap((token) => topLevelOffsets(rest, token))
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends))
}

/** Split at top-level (paren depth 0) occurrences of ` and ` / ` or `. */
function topLevel(where: string, word: 'and' | 'or'): string[] {
  const token = ` ${word} `
  const parts: string[] = []
  let from = 0
  for (const at of topLevelOffsets(where, token)) {
    parts.push(where.slice(from, at))
    from = at + token.length
  }
  parts.push(where.slice(from))
  return parts
}

/** The scope conjunct, with its parameters resolved from the compiled parameter list. */
function scopeConjunct(query: { sql: string; parameters: readonly unknown[] }): { text: string; params: unknown[] } {
  const conjuncts = topLevel(whereOf(query.sql), 'and')
  const scoped = conjuncts.filter((c) => c.includes('c.spreadsheet_id = any('))
  expect(scoped, query.sql).toHaveLength(1)
  const text = scoped[0]!
  const params = [...text.matchAll(/\$(\d+)/g)].map((m) => query.parameters[Number(m[1]) - 1])
  return { text, params }
}

describe('CommentService cross-sheet aggregates apply the inbox scope in SQL (#5831 part B)', () => {
  let service: CommentService

  beforeEach(() => {
    captured.queries.length = 0
    captured.rows.length = 0
    service = makeService()
  })

  it('getInbox: the scope is a conjunct of BOTH the COUNT and the page WHERE, before ORDER BY/LIMIT/OFFSET', async () => {
    captured.rows.push([{ c: 7 }], [])
    const result = await service.getInbox(USER, { limit: 2, offset: 4 }, SCOPE)
    expect(result.total).toBe(7)
    expect(captured.queries).toHaveLength(2)
    const [count, page] = captured.queries as [typeof captured.queries[0], typeof captured.queries[0]]

    expect(count.sql).toMatch(/^select count\(\*\) as "c" from "meta_comments" as "c"/)
    expect(count.sql).not.toMatch(/ limit | offset /)
    expect(page.sql).toMatch(/ order by "c"\."created_at" desc limit \$\d+ offset \$\d+$/)
    expect(page.parameters.slice(-2)).toEqual([2, 4])

    for (const query of [count, page]) {
      const where = whereOf(query.sql)
      // No top-level OR: every filter binds as AND.
      expect(topLevel(where, 'or'), query.sql).toHaveLength(1)
      const conjuncts = topLevel(where, 'and')
      expect(conjuncts, query.sql).toHaveLength(3)
      expect(conjuncts[0]).toMatch(/^"c"\."author_id" != \$\d+$/)
      expect(conjuncts[1]).toMatch(/^\(\(c\.mentions @> \$\d+::jsonb\) or r\.comment_id is null\)$/)
      const scope = scopeConjunct(query)
      expect(scope.text).toMatch(/^\(c\.spreadsheet_id = any\(\$\d+::text\[\]\) and not exists \(/)
      expect(scope.text).toMatch(/from unnest\(\$\d+::text\[\], \$\d+::text\[\]\) as denied\(spreadsheet_id, row_id\)/)
      expect(scope.text).toMatch(/where denied\.spreadsheet_id = c\.spreadsheet_id\s+and denied\.row_id = btrim\(c\.row_id, \$\d+\)/)
      expect(scope.params).toEqual([
        ['sheet-fake-a', 'sheet-fake-b'],
        ['sheet-fake-b'],
        ['row-fake-denied'],
        JS_TRIM_WHITESPACE,
      ])
    }
    // The page's scope sits before ORDER BY (it is part of the WHERE, not a post-filter).
    const pageOrderBy = topLevelOffsets(page.sql, ' order by ')
    expect(pageOrderBy).toHaveLength(1)
    expect(page.sql.indexOf('c.spreadsheet_id = any(')).toBeGreaterThan(topLevelOffsets(page.sql, ' where ')[0]!)
    expect(page.sql.indexOf('c.spreadsheet_id = any(')).toBeLessThan(pageOrderBy[0]!)
  })

  it('without denied rows the scope is the sheet set alone', async () => {
    captured.rows.push([{ c: 0 }], [])
    await service.getInbox(USER, undefined, { sheetIds: ['sheet-fake-a'], deniedRows: [] })
    for (const query of captured.queries) {
      const scope = scopeConjunct(query)
      expect(scope.text).toMatch(/^\(c\.spreadsheet_id = any\(\$\d+::text\[\]\)\s*\)$/)
      expect(scope.params).toEqual([['sheet-fake-a']])
    }
  })

  it('getUnreadSummary and getUnreadCount count inside the same scope, all filters ANDed', async () => {
    captured.rows.push([{ unread_count: 3, mention_unread_count: 1 }], [{ c: 3 }])
    await expect(service.getUnreadSummary(USER, SCOPE)).resolves.toEqual({ unreadCount: 3, mentionUnreadCount: 1 })
    await expect(service.getUnreadCount(USER, SCOPE)).resolves.toBe(3)
    expect(captured.queries).toHaveLength(2)
    for (const query of captured.queries) {
      const where = whereOf(query.sql)
      expect(topLevel(where, 'or'), query.sql).toHaveLength(1)
      const conjuncts = topLevel(where, 'and')
      expect(conjuncts, query.sql).toHaveLength(3)
      expect(conjuncts[0]).toMatch(/^"c"\."author_id" != \$\d+$/)
      expect(conjuncts[1]).toBe('r.comment_id is null')
      expect(scopeConjunct(query).params).toEqual([
        ['sheet-fake-a', 'sheet-fake-b'],
        ['sheet-fake-b'],
        ['row-fake-denied'],
        JS_TRIM_WHITESPACE,
      ])
    }
  })

  it('candidate listers read ids only, grouped, with the same (parenthesized) inbox predicate', async () => {
    captured.rows.push([{ spreadsheet_id: 'sheet-fake-a' }], [{ spreadsheet_id: 'sheet-fake-b', row_id: 'row-fake-1' }])
    await expect(service.listInboxCandidateSheetIds(USER)).resolves.toEqual(['sheet-fake-a'])
    await expect(service.listInboxCandidateRowIds(USER, ['sheet-fake-b'])).resolves.toEqual(new Map([['sheet-fake-b', ['row-fake-1']]]))
    const [sheets, rows] = captured.queries as [typeof captured.queries[0], typeof captured.queries[0]]
    expect(sheets.sql).toMatch(/^select "c"\."spreadsheet_id" from "meta_comments" as "c" left join /)
    expect(sheets.sql).toMatch(/ group by "c"\."spreadsheet_id"$/)
    expect(rows.sql).toMatch(/^select "c"\."spreadsheet_id", "c"\."row_id" from "meta_comments" as "c" left join /)
    expect(rows.sql).toMatch(/ group by "c"\."spreadsheet_id", "c"\."row_id"$/)
    for (const query of [sheets, rows]) {
      const where = whereOf(query.sql)
      expect(topLevel(where, 'or'), query.sql).toHaveLength(1)
      expect(topLevel(where, 'and')[1]).toMatch(/^\(\(c\.mentions @> \$\d+::jsonb\) or r\.comment_id is null\)$/)
    }
    expect(topLevel(whereOf(rows.sql), 'and')[2]).toMatch(/^c\.spreadsheet_id = any\(\$\d+::text\[\]\)$/)
  })
})
