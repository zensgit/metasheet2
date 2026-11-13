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
 *   - on a row-deny sheet only the ALLOWED (sheet, row) pairs are admitted (fail-closed: a row the route
 *     never checked is out), with the row compared trimmed like the id gate; a sheet without the deny
 *     is admitted whole;
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
  rowDenySheets: [{ spreadsheetId: 'sheet-fake-b', allowedRowIds: ['row-fake-allowed-1', 'row-fake-allowed-2'] }],
}
/** The scope conjunct's parameters, as SCOPE compiles: sheets, row-deny sheets, allowed pairs (parallel), trim set. */
const SCOPE_PARAMS = [
  ['sheet-fake-a', 'sheet-fake-b'],
  ['sheet-fake-b'],
  ['sheet-fake-b', 'sheet-fake-b'],
  ['row-fake-allowed-1', 'row-fake-allowed-2'],
  JS_TRIM_WHITESPACE,
]

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
      // Sheet in scope AND (not a row-deny sheet OR an allowed pair) — an allow list, never `not exists (denied)`.
      expect(scope.text).toMatch(/^\(c\.spreadsheet_id = any\(\$\d+::text\[\]\) and \(c\.spreadsheet_id <> all\(\$\d+::text\[\]\) or exists \(/)
      expect(scope.text).toMatch(/from unnest\(\$\d+::text\[\], \$\d+::text\[\]\) as allowed\(spreadsheet_id, row_id\)/)
      expect(scope.text).toMatch(/where allowed\.spreadsheet_id = c\.spreadsheet_id\s+and allowed\.row_id = btrim\(c\.row_id, \$\d+\)/)
      expect(scope.text).not.toMatch(/not exists|denied/)
      expect(scope.params).toEqual(SCOPE_PARAMS)
    }
    // The page's scope sits before ORDER BY (it is part of the WHERE, not a post-filter).
    const pageOrderBy = topLevelOffsets(page.sql, ' order by ')
    expect(pageOrderBy).toHaveLength(1)
    expect(page.sql.indexOf('c.spreadsheet_id = any(')).toBeGreaterThan(topLevelOffsets(page.sql, ' where ')[0]!)
    expect(page.sql.indexOf('c.spreadsheet_id = any(')).toBeLessThan(pageOrderBy[0]!)
  })

  it('without a row-deny sheet the scope is the sheet set alone', async () => {
    captured.rows.push([{ c: 0 }], [])
    await service.getInbox(USER, undefined, { sheetIds: ['sheet-fake-a'], rowDenySheets: [] })
    for (const query of captured.queries) {
      const scope = scopeConjunct(query)
      expect(scope.text).toMatch(/^\(c\.spreadsheet_id = any\(\$\d+::text\[\]\)\s*\)$/)
      expect(scope.params).toEqual([['sheet-fake-a']])
    }
  })

  it.each(['Ada Demo', '  王 Demo  ', '', '  ', null, undefined])('projects only a scoped author name (%s), never a directory or email', async (authorName) => {
    const row = {
      id: 'comment-synthetic', spreadsheet_id: 'sheet-fake-a', row_id: 'row-allowed',
      container_id: 'sheet-fake-a', target_id: 'row-allowed', target_field_id: null,
      field_id: null, content: 'Synthetic comment', author_id: 'author-synthetic',
      author_name: authorName, parent_id: null, resolved: false, mentions: [],
      created_at: '2026-01-01', updated_at: '2026-01-01', unread: true, mentioned: false,
    }
    captured.rows.push([{ c: 1 }], [row], [])
    const comments = await service.getComments('sheet-fake-a', {
      rowId: 'row-allowed', excludeRowIds: ['row-denied'], limit: 2,
    })
    expect(comments.items[0].authorName).toBe(authorName?.trim() || undefined)
    expect(comments.items[0].authorId).toBe('author-synthetic')
    const list = captured.queries[1]!
    expect(list.sql).toContain('u.id::text = "meta_comments"."author_id" and u.is_active = true')
    expect(list.sql).toContain('select u.name from users as u')
    expect(list.sql).not.toContain('email')
    expect(whereOf(list.sql)).toMatch(/"spreadsheet_id" = .* and "row_id" = .* and "row_id" not in/)
    expect(list.parameters).toEqual(['sheet-fake-a', 'row-allowed', 'row-denied', 2, 0])
    expect(captured.queries.some((query) => /^select .* from "users"/.test(query.sql))).toBe(false)

    captured.queries.length = 0
    captured.rows.push([{ c: 1 }], [row])
    const inbox = await service.getInbox(USER, { limit: 2 }, SCOPE)
    expect(inbox.items[0]).toMatchObject({ authorId: 'author-synthetic', authorName: authorName?.trim() || undefined })
    expect(captured.queries).toHaveLength(2)
    expect(captured.queries[0]!.sql).not.toContain('users')
    expect(captured.queries[1]!.sql).toContain('u.id::text = "c"."author_id" and u.is_active = true')
    expect(scopeConjunct(captured.queries[1]!).params).toEqual(SCOPE_PARAMS)
  })

  it('does not query any author for an unadmitted inbox scope or an empty comment page', async () => {
    expect(await service.getInbox(USER, {}, { sheetIds: [], rowDenySheets: [] })).toEqual({ items: [], total: 0 })
    expect(captured.queries).toHaveLength(0)
    captured.rows.push([{ c: 0 }], [])
    expect(await service.getComments('sheet-fake-a')).toEqual({ items: [], total: 0 })
    expect(captured.queries).toHaveLength(2)
  })

  it('a row-deny sheet with NO allowed row still binds as a row-deny sheet (nothing on it is admitted)', async () => {
    captured.rows.push([{ c: 0 }], [])
    await service.getInbox(USER, undefined, {
      sheetIds: ['sheet-fake-a', 'sheet-fake-b'],
      rowDenySheets: [{ spreadsheetId: 'sheet-fake-b', allowedRowIds: [] }],
    })
    expect(captured.queries).toHaveLength(2)
    for (const query of captured.queries) {
      const scope = scopeConjunct(query)
      expect(scope.text).toMatch(/<> all\(\$\d+::text\[\]\) or exists \(/)
      expect(scope.params).toEqual([['sheet-fake-a', 'sheet-fake-b'], ['sheet-fake-b'], [], [], JS_TRIM_WHITESPACE])
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
      expect(scopeConjunct(query).params).toEqual(SCOPE_PARAMS)
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
