/**
 * Second adversarial review of #6091 — S-1 / N-3: `GET /api/multitable/context` lists a sheet's
 * views with `ORDER BY created_at ASC`, EXACTLY as it did before #6091 — no `, id` tie-breaker.
 *
 * Why the tie-breaker is wrong HERE: bases installed from a template before #6091 got every view
 * inside ONE transaction on the column default `now()`, so all their views share one created_at.
 * For those rows `ORDER BY created_at, id` makes the view id — a sha1 (stableChildId in
 * multitable/template-library.ts), unrelated to template order and different per base — the
 * effective sort key: the tab order reshuffles and the default view (the first one returned) can
 * flip on bases that already exist. No backfill migration is shipped for this; keeping the query
 * byte-identical to the pre-#6091 one is the fix. (Installs since #6091 stamp strictly increasing
 * created_at per view, so they have no ties.)
 *
 * What is pinned:
 *   (1) characterization — three views with IDENTICAL created_at, stored in insertion order A, B, C,
 *       whose ids sort C, B, A: /context answers A, B, C. The fake pool below EXECUTES the ORDER BY
 *       the route actually sends (a stable sort over the keys it names), so re-adding `, id` to the
 *       route turns the answer into C, B, A and this cell reds — it is not a text-only check;
 *   (2) the fake's ORDER BY interpreter is not vacuous: fed `ORDER BY created_at, id` it DOES answer
 *       C, B, A, and it refuses sort keys it does not understand instead of silently ignoring them;
 *   (3) N-3 — /context and GET /views order a sheet's views the same way (`created_at ASC`), read
 *       from the handlers' source with comments stripped.
 *
 * TRANSPORT: one pinned listener per file + request(url()) — `request(app)` app-mode is banned by
 * tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LIVE,
  makeOracleFakePool,
  MANAGER,
  type OracleFakePool,
  type OracleIdentity,
  type OracleQueryResult,
} from '../utils/sheet-existence-oracle'
import { usePinnedServer } from '../utils/pinned-server'

/** The base the fixture's LIVE sheet row points at (`base_id` of the row makeOracleFakePool serves). */
const BASE_ID = 'base_oracle'

/** One shared instant — what every view of a pre-#6091 template install carries. */
const TIED_CREATED_AT = '2026-06-01T08:00:00.000Z'

/**
 * Stored (insertion / heap) order A, B, C. Ids are chosen so that id-ascending is the exact
 * inversion, C, B, A — an `id` tie-break cannot coincide with insertion order by luck.
 */
const STORED_VIEWS = [
  { id: 'vw_order_3', name: 'A', type: 'grid' },
  { id: 'vw_order_2', name: 'B', type: 'kanban' },
  { id: 'vw_order_1', name: 'C', type: 'calendar' },
].map((view) => ({
  ...view,
  sheet_id: LIVE,
  filter_info: {},
  sort_info: {},
  group_info: {},
  hidden_field_ids: [],
  config: {},
  created_at: TIED_CREATED_AT,
}))

type StoredView = (typeof STORED_VIEWS)[number]

/**
 * Executes the ORDER BY clause the SQL actually carries over the stored rows: a STABLE sort
 * (Array.prototype.sort) on the keys it names, so rows the clause leaves tied keep their stored
 * order. Only `created_at` / `id` with an optional ASC/DESC are understood; anything else throws, so
 * a changed clause can never be answered as if it were the old one.
 */
function applyOrderBy(sql: string, rows: readonly StoredView[]): StoredView[] {
  const clause = /\bORDER BY (.+?)(?: LIMIT \S+)?$/.exec(sql)?.[1]
  if (!clause) throw new Error(`meta_views read without ORDER BY reached the view-order fake: ${sql}`)
  const keys = clause.split(',').map((part) => {
    const match = /^\s*(created_at|id)(?:\s+(ASC|DESC))?\s*$/i.exec(part)
    if (!match) throw new Error(`view-order fake does not understand sort key "${part.trim()}" in: ${sql}`)
    return { column: match[1]!.toLowerCase() as 'created_at' | 'id', desc: (match[2] ?? 'ASC').toUpperCase() === 'DESC' }
  })
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const a = key.column === 'created_at' ? Date.parse(left.created_at) : left.id
      const b = key.column === 'created_at' ? Date.parse(right.created_at) : right.id
      const cmp = a < b ? -1 : a > b ? 1 : 0
      if (cmp !== 0) return key.desc ? -cmp : cmp
    }
    return 0
  })
}

const VIEWS_BY_SHEET_SQL = /FROM meta_views WHERE sheet_id = \$1\b/

function routeRows(sql: string, params: unknown[]): OracleQueryResult | undefined {
  if (/SELECT id, name, icon, color, owner_id, workspace_id FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return params[0] === BASE_ID
      ? { rows: [{ id: BASE_ID, name: 'Order base', icon: 'table', color: '#1677ff', owner_id: 'u_order_owner', workspace_id: null }] }
      : { rows: [] }
  }
  if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return params[0] === BASE_ID
      ? { rows: [{ id: LIVE, base_id: BASE_ID, name: 'Order sheet', description: null, system_kind: null }] }
      : { rows: [] }
  }
  if (VIEWS_BY_SHEET_SQL.test(sql)) {
    return params[0] === LIVE ? { rows: applyOrderBy(sql, STORED_VIEWS) } : { rows: [] }
  }
  return undefined
}

/**
 * A route handler's source, comments stripped and whitespace flattened — so prose ABOUT an ORDER BY
 * (like the note above the /context query) can never satisfy or break the source assertions.
 */
function handlerSource(registration: string): string {
  const src = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf(registration)
  const note = `${registration} was not found in routes/univer-meta.ts — re-point this reader.`
  expect(start, note).toBeGreaterThan(-1)
  const end = src.indexOf('\n  })\n', start)
  expect(end, note).toBeGreaterThan(start)
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
}

/** Every `ORDER BY …` of a `FROM meta_views WHERE sheet_id = $1` read in a handler's source. */
function viewsReadOrderBys(body: string): string[] {
  return [...body.matchAll(/FROM meta_views WHERE sheet_id = \$1 ORDER BY (.+?)(?: LIMIT \d+)? ?[`'"]/g)].map((m) => m[1]!)
}

const pinned = usePinnedServer()
let oracle: OracleFakePool
let currentUser: OracleIdentity | undefined
// Imported ONCE: routes/univer-meta.ts is ~20k lines and its cold transform outruns a 15s hook budget.
let poolManager: typeof import('../../src/integration/db/connection-pool')['poolManager']
let univerMeta: typeof import('../../src/routes/univer-meta')

function buildApp(): Express {
  oracle = makeOracleFakePool({ answer: routeRows })
  vi.spyOn(poolManager, 'get').mockReturnValue(oracle.pool as any)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  app.use('/api/multitable', univerMeta.univerMetaRouter())
  return app
}

describe('#6091 second review S-1 / N-3 — GET /context keeps `ORDER BY created_at ASC` for views', () => {
  beforeAll(async () => {
    poolManager = (await import('../../src/integration/db/connection-pool')).poolManager
    univerMeta = await import('../../src/routes/univer-meta')
  }, 120_000)

  beforeEach(() => {
    currentUser = MANAGER
    pinned.setApp(buildApp())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    currentUser = undefined
  })

  it('(1) views sharing one created_at come back in stored order A, B, C — not id order C, B, A', async () => {
    oracle.reset()
    const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: LIVE })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const names = (res.body.data.views as Array<{ name: string }>).map((view) => view.name)
    expect(names, 'tied views were re-sorted — an `id` tie-breaker is back in the /context views read').toEqual(['A', 'B', 'C'])
    // The default view the Workbench opens is the first one returned.
    expect((res.body.data.views as Array<{ id: string }>)[0]?.id).toBe('vw_order_3')

    // And the statement that produced it is the pre-#6091 one, verbatim.
    const viewReads = oracle.calls.filter((call) => VIEWS_BY_SHEET_SQL.test(call.sql))
    expect(viewReads).toHaveLength(1)
    expect(viewReads[0]!.params).toEqual([LIVE])
    expect(viewReads[0]!.sql).toMatch(/ORDER BY created_at ASC$/)
  })

  it('(2) the fake executes the ORDER BY it is sent: `created_at, id` WOULD answer C, B, A; unknown keys throw', () => {
    const idTieBreak = routeRows(
      'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at, id',
      [LIVE],
    )
    expect((idTieBreak?.rows as StoredView[]).map((row) => row.name)).toEqual(['C', 'B', 'A'])

    const asBefore = routeRows(
      'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC',
      [LIVE],
    )
    expect((asBefore?.rows as StoredView[]).map((row) => row.name)).toEqual(['A', 'B', 'C'])

    expect(() => routeRows('SELECT id FROM meta_views WHERE sheet_id = $1 ORDER BY name', [LIVE])).toThrow(/does not understand sort key/)
    expect(() => routeRows('SELECT id FROM meta_views WHERE sheet_id = $1', [LIVE])).toThrow(/without ORDER BY/)
  })

  it('(3) N-3: /context and GET /views order a sheet\'s views identically — `created_at ASC`, no id tie-break', () => {
    const contextOrderBys = viewsReadOrderBys(handlerSource("router.get('/context'"))
    expect(contextOrderBys, 'the /context views read was not found — re-point this reader').toHaveLength(1)
    expect(contextOrderBys[0]).toBe('created_at ASC')

    const listOrderBys = viewsReadOrderBys(handlerSource("router.get('/views'"))
    expect(listOrderBys.length, 'no GET /views read was found — re-point this reader').toBeGreaterThan(0)
    for (const orderBy of listOrderBys) {
      expect(orderBy).toBe(contextOrderBys[0])
    }
  })
})
