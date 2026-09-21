/**
 * #5807 first cut — the People system sheet's read side is bound by ONE ruler (mock pool, no DB).
 *
 * The sheet materializes one row per ACTIVE user and is gated ONLY by `canRead`, which a GLOBAL
 * `multitable:read` satisfies with no sheet-level assignment at all. The actor in every §1–§4 case
 * below is exactly that: `perms: ['multitable:read']`, no admin role, no sheet grant — it PASSES the
 * unchanged gate, and what changes is HOW MUCH it may take.
 *
 *   §1 GET /view truncates to the window and cannot page past it (offset, and the `limit`-less
 *      "whole sheet" request, both land inside it)
 *   §2 GET /records (cursor), GET /records-summary (records AND `displayMap`) and
 *      GET /fields/:fieldId/link-options (bound by the FOREIGN sheet) answer the same ruler
 *   §3 GET /sheets/:id/export-xlsx (xlsx AND csv), GET /sheets/:id/view-aggregate and its twin
 *      POST /dashboard/query refuse with the shared values-free 403 — a truncated file, a truncated
 *      COUNT and a truncated bucket list all LIE, so these are refused rather than clamped
 *   §4 a sheet carrying only the description SENTINEL (no `system_kind` — every People sheet
 *      provisioned before the L5 migration, which performed no backfill) is bound identically
 *   §5 POSITIVE CONTROLS — nothing else moved: an ordinary sheet still answers its 5000-row cap, its
 *      export/aggregate still work, its link picker still answers the 200 cap, the legacy person CHIP
 *      still resolves through the People sheet, `/people-search` still returns display values, and the
 *      window is the SAME number as the candidate-interface ceiling.
 *
 * This is a QUANTITY bound, never a grant: §3's no-oracle case proves an actor WITHOUT read gets the
 * byte-identical 403 it always got, so the refusal adds no signal about which sheets are People sheets.
 *
 * Fixtures are obviously fake (`Fake Person N`, `example.invalid`). TRANSPORT: one pinned listener +
 * `request(pinned.url())` — `request(app)` app-mode is banned in tests/unit (#4154 tripwire).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'
import { PEOPLE_SHEET_READ_MAX_ITEMS } from '../../src/multitable/people-sheet-read-bound'
import { usePinnedServer } from '../utils/pinned-server'

const BASE_ID = 'base_rb'
const PEOPLE_SHEET = 'sheet_people_rb'
const SENTINEL_SHEET = 'sheet_people_sentinel_rb'
const PLAIN_SHEET = 'sheet_plain_rb'
/** Deliberately > the window and > any per-route default, so a missing clamp is visible. */
const ROSTER_SIZE = 120

/** The #5807 actor: a global `multitable:read`, no admin role, no sheet-level assignment. */
const GLOBAL_READER = { id: 'u_rb_reader', roles: [] as string[], perms: ['multitable:read'] }
/** Same actor without the read code — used to prove the bound's 403 is the gate's 403. */
const NO_READER = { id: 'u_rb_noread', roles: [] as string[], perms: ['comments:read'] }

type QueryResult = { rows: any[]; rowCount?: number }

interface SheetRow {
  id: string
  base_id: string
  name: string
  description: string | null
  system_kind: string | null
  deleted_at: string | null
  created_at: string
}

interface FieldRow {
  id: string
  sheet_id: string
  name: string
  type: string
  order: number
  property: Record<string, unknown>
}

interface RecordRow {
  id: string
  sheet_id: string
  data: Record<string, unknown>
  created_at: string
}

interface Store {
  sheets: SheetRow[]
  fields: FieldRow[]
  records: RecordRow[]
  links: Array<{ field_id: string; record_id: string; foreign_record_id: string }>
  /** Every SQL the mock did not recognise — asserted empty-of-meta_records in the suite. */
  unhandled: string[]
}

function sheetRow(id: string, extra: Partial<SheetRow> = {}): SheetRow {
  return {
    id,
    base_id: BASE_ID,
    name: 'Sheet',
    description: null,
    system_kind: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

/** A sheet with one `Name` string column and `count` obviously-fake rows, in a stable order. */
function addRosterSheet(store: Store, row: SheetRow, count: number): string {
  store.sheets.push(row)
  const fieldId = `fld_name_${row.id}`
  store.fields.push({ id: fieldId, sheet_id: row.id, name: 'Name', type: 'string', order: 0, property: {} })
  for (let i = 0; i < count; i += 1) {
    store.records.push({
      id: `rec_${row.id}_${String(i).padStart(3, '0')}`,
      sheet_id: row.id,
      data: { [fieldId]: `Fake Person ${i + 1}` },
      // created_at STRICTLY ascending and in the id order, so "the first N" is unambiguous.
      created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + i * 1000).toISOString(),
    })
  }
  return fieldId
}

function sortedRecords(store: Store, sheetId: string): RecordRow[] {
  return store.records
    .filter((r) => r.sheet_id === sheetId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}

function intParam(params: unknown[], index: number): number | undefined {
  const raw = params[index]
  return typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : undefined
}

function createMockPool(store: Store) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const p = (i: number) => String(params[i] ?? '')
    const text = sql.replace(/\s+/g, ' ')

    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error(`read-bound suite must not write: ${text}`)
    if (/_permissions\b/i.test(text)) return { rows: [] }

    // Base-scoped sheet lookup — how `/people-search` finds the People sheet (kept working in §5).
    if (/FROM meta_sheets/i.test(text) && /base_id = \$1/i.test(text)) {
      let rows = store.sheets.filter((s) => s.base_id === p(0))
      if (/deleted_at IS NULL/i.test(text)) rows = rows.filter((s) => s.deleted_at === null)
      if (/description = \$2/i.test(text)) rows = rows.filter((s) => s.description === p(1))
      const order = /ORDER BY created_at( (ASC|DESC))?/i.exec(text)
      if (order) {
        const desc = (order[2] ?? '').toUpperCase() === 'DESC'
        rows = [...rows].sort((a, b) => (desc ? -1 : 1) * a.created_at.localeCompare(b.created_at))
      }
      const limit = /LIMIT (\d+)/i.exec(text)
      if (limit) rows = rows.slice(0, Number(limit[1]))
      return { rows: rows.map((s) => ({ ...s })) }
    }
    // The helper's own column-tolerant probe.
    if (/to_jsonb\(\w+\)\s*->>\s*'system_kind'/i.test(text) && /FROM meta_sheets/i.test(text)) {
      const row = store.sheets.find((s) => s.id === p(0))
      if (!row) return { rows: [] }
      return { rows: [{ description: row.description, system_kind: row.system_kind }] }
    }
    if (/FROM meta_sheets/i.test(text) && /WHERE id = \$1/i.test(text)) {
      const row = store.sheets.find((s) => s.id === p(0))
      if (!row) return { rows: [] }
      if (/deleted_at IS NULL/i.test(text) && row.deleted_at !== null) return { rows: [] }
      return { rows: [{ ...row }] }
    }
    if (/FROM meta_sheets/i.test(text) && /id = ANY/i.test(text)) {
      // The hard-coded approval / e-learning projection FENCES ask "are these sheets in <that> base?".
      // Evaluating `base_id` matters: answering yes fences the sheet out of every link summary, which is
      // how this suite first mis-read an ordinary sheet as an approval projection.
      const ids = (params[0] as string[] | undefined) ?? []
      const scopedBase = /base_id = \$2/i.test(text) ? p(1) : null
      return {
        rows: store.sheets
          .filter((s) => ids.includes(s.id) && (scopedBase === null || s.base_id === scopedBase))
          .map((s) => ({ ...s })),
      }
    }
    if (/FROM meta_fields/i.test(text) && /WHERE id = \$1/i.test(text)) {
      const row = store.fields.find((f) => f.id === p(0))
      return { rows: row ? [{ ...row }] : [] }
    }
    if (/FROM meta_fields/i.test(text) && /sheet_id = \$1/i.test(text)) {
      return {
        rows: store.fields
          .filter((f) => f.sheet_id === p(0))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((f) => ({ ...f, property: structuredClone(f.property) })),
      }
    }
    if (/FROM meta_links/i.test(text)) {
      const fieldIds = (params[0] as string[] | undefined) ?? []
      const recordIds = (params[1] as string[] | undefined) ?? []
      return {
        rows: store.links
          .filter((l) => fieldIds.includes(l.field_id) && recordIds.includes(l.record_id))
          .map((l) => ({ ...l })),
      }
    }
    // A PURE count (not the `COUNT(*) OVER()` window column the paged reads select alongside rows).
    if (/SELECT COUNT\(\*\)/i.test(text) && /FROM meta_records/i.test(text)) {
      const n = store.records.filter((r) => r.sheet_id === p(0)).length
      return { rows: [{ n, total: n, c: n }] }
    }
    if (/FROM meta_records/i.test(text) && /id = ANY/i.test(text)) {
      const ids = (params[1] as string[] | undefined) ?? []
      return {
        rows: sortedRecords(store, p(0))
          .filter((r) => ids.includes(r.id))
          .map((r) => ({ id: r.id, version: 1, data: structuredClone(r.data), created_at: r.created_at, locked: false, locked_by: null, locked_at: null })),
      }
    }
    if (/FROM meta_records/i.test(text) && /sheet_id = \$1/i.test(text)) {
      let rows = sortedRecords(store, p(0))
      const total = rows.length
      // LIMIT $n OFFSET $m — evaluate them, so a route that forgot to clamp reads more than the window.
      const limitMatch = /LIMIT \$(\d+) OFFSET \$(\d+)/i.exec(text)
      if (limitMatch) {
        const limit = intParam(params, Number(limitMatch[1]) - 1)
        const offset = intParam(params, Number(limitMatch[2]) - 1) ?? 0
        rows = rows.slice(offset, offset + (limit ?? rows.length))
      }
      return {
        rows: rows.map((r) => ({
          id: r.id,
          version: 1,
          data: structuredClone(r.data),
          created_at: r.created_at,
          locked: false,
          locked_by: null,
          locked_at: null,
          ...(/COUNT\(\*\) OVER\(\)/i.test(text) ? { total } : {}),
        })),
      }
    }
    store.unhandled.push(text)
    return { rows: [] }
  })
  return { query, transaction: vi.fn() }
}

async function buildApp(store: Store, user: { id: string; roles: string[]; perms: string[] } = GLOBAL_READER): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool(store) as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { ...user }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

function api(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

describe('#5807 — People system sheet read-side quantity bound', () => {
  let store: Store

  beforeEach(() => {
    vi.resetModules()
    store = { sheets: [], fields: [], records: [], links: [], unhandled: [] }
  })

  afterEach(() => {
    // MOCK FIDELITY: a record read this mock did not recognise would silently answer `{ rows: [] }`, and
    // a bound asserted against an empty answer proves nothing. Any unrecognised `meta_records` SQL fails
    // the test that provoked it rather than passing quietly.
    expect(store.unhandled.filter((sql) => /meta_records/i.test(sql))).toEqual([])
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  // ── §1 GET /view ──────────────────────────────────────────────────────────
  describe('§1 GET /view — truncated to the window, no paging past it', () => {
    beforeEach(() => {
      addRosterSheet(store, sheetRow(PEOPLE_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }), ROSTER_SIZE)
    })

    it('a limit far above the window answers exactly the first window of rows', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET, limit: '1000' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.rows[0].id).toBe(`rec_${PEOPLE_SHEET}_000`)
      expect(res.body.data.rows.at(-1).id).toBe(`rec_${PEOPLE_SHEET}_049`)
      // The envelope never advertises more, and never re-publishes the roster's true cardinality.
      expect(res.body.data.page.hasMore).toBe(false)
      expect(res.body.data.page.total).toBe(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.total).toBeLessThan(ROSTER_SIZE)
    })

    it('the `limit`-less whole-sheet request is bound too (and gains a page envelope saying so)', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('an offset AT the window edge answers an empty page, not row 51', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET, limit: '50', offset: String(PEOPLE_SHEET_READ_MAX_ITEMS) })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(0)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('an offset far past the window answers an empty page', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET, limit: '50', offset: '100' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(0)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('an offset INSIDE the window still cannot reach past it', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET, limit: '50', offset: '40' })
      expect(res.status).toBe(200)
      // 10 rows of room left in the window — never 50.
      expect(res.body.data.rows).toHaveLength(10)
      expect(res.body.data.rows.at(-1).id).toBe(`rec_${PEOPLE_SHEET}_049`)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('a searching read is bound as well (the in-memory branch)', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PEOPLE_SHEET, limit: '1000', search: 'Fake Person' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows.length).toBeLessThanOrEqual(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.hasMore).toBe(false)
    })
  })

  // ── §2 /records, /records-summary, link-options ───────────────────────────
  describe('§2 the other enumerating readers answer the same ruler', () => {
    beforeEach(() => {
      addRosterSheet(store, sheetRow(PEOPLE_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }), ROSTER_SIZE)
    })

    it('GET /records truncates and offers NO continuation cursor', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/records').query({ sheetId: PEOPLE_SHEET, limit: '5000' })
      expect(res.status).toBe(200)
      expect(res.body.data.records.length).toBeLessThanOrEqual(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(false)
      expect(res.body.data.nextCursor).toBeNull()
    })

    it('GET /records with a cursor answers an EMPTY page (fail-closed: the cursor is opaque here)', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/records').query({ sheetId: PEOPLE_SHEET, limit: '5000', cursor: 'anything' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(0)
      expect(res.body.data.hasMore).toBe(false)
      expect(res.body.data.nextCursor).toBeNull()
    })

    it('GET /records-summary bounds `records` AND `displayMap` (the loader fills it for EVERY match)', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/records-summary').query({ sheetId: PEOPLE_SHEET, limit: '200' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      // The leak this cut closes: an unclamped displayMap is the whole roster's display values.
      expect(Object.keys(res.body.data.displayMap)).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(Object.keys(res.body.data.displayMap).length).toBeLessThan(ROSTER_SIZE)
      expect(res.body.data.page.total).toBe(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('GET /records-summary past the window is empty — records and displayMap alike', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/records-summary').query({ sheetId: PEOPLE_SHEET, limit: '200', offset: String(PEOPLE_SHEET_READ_MAX_ITEMS) })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(0)
      expect(Object.keys(res.body.data.displayMap)).toHaveLength(0)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('link-options for a link field INTO the People sheet is bound by the FOREIGN sheet', async () => {
      const linkFieldId = 'fld_link_people'
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), 1)
      store.fields.push({
        id: linkFieldId,
        sheet_id: PLAIN_SHEET,
        name: 'Owner',
        type: 'link',
        order: 1,
        property: { foreignSheetId: PEOPLE_SHEET },
      })
      const res = await api(await buildApp(store)).get(`/api/multitable/fields/${linkFieldId}/link-options`).query({ limit: '200' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.total).toBe(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.hasMore).toBe(false)
    })
  })

  // ── §3 the surfaces that cannot be truncated honestly ─────────────────────
  describe('§3 export + aggregate refuse, values-free', () => {
    beforeEach(() => {
      addRosterSheet(store, sheetRow(PEOPLE_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }), ROSTER_SIZE)
    })

    it('export-xlsx answers the shared 403 and echoes nothing', async () => {
      const res = await api(await buildApp(store)).get(`/api/multitable/sheets/${PEOPLE_SHEET}/export-xlsx`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
      expect(JSON.stringify(res.body)).not.toContain(PEOPLE_SHEET)
    })

    it('the csv format of the same route is refused too (one pipeline, one refusal)', async () => {
      const res = await api(await buildApp(store)).get(`/api/multitable/sheets/${PEOPLE_SHEET}/export-xlsx`).query({ format: 'csv' })
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
    })

    it('view-aggregate answers the shared 403 (a clamped COUNT would be a wrong number)', async () => {
      const res = await api(await buildApp(store)).get(`/api/multitable/sheets/${PEOPLE_SHEET}/view-aggregate`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
      expect(JSON.stringify(res.body)).not.toContain(PEOPLE_SHEET)
    })

    it("the dashboard's group-by is view-aggregate's twin and answers the same 403", async () => {
      const res = await api(await buildApp(store))
        .post('/api/multitable/dashboard/query')
        .send({ sheetId: PEOPLE_SHEET, widgets: [{ title: 'Roster', chartType: 'bar', metric: 'count', groupByFieldId: `fld_name_${PEOPLE_SHEET}` }] })
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
      expect(JSON.stringify(res.body)).not.toContain(PEOPLE_SHEET)
    })

    it('NO ORACLE — an actor without read gets the byte-identical 403 it always got', async () => {
      const denied = await api(await buildApp(store, NO_READER)).get(`/api/multitable/sheets/${PEOPLE_SHEET}/export-xlsx`)
      const bound = await api(await buildApp(store)).get(`/api/multitable/sheets/${PEOPLE_SHEET}/export-xlsx`)
      expect(denied.status).toBe(bound.status)
      expect(denied.body).toEqual(bound.body)
    })
  })

  // ── §4 the sentinel-only (pre-migration) People sheet ─────────────────────
  describe('§4 a sentinel-only People sheet (no system_kind) is bound identically', () => {
    beforeEach(() => {
      addRosterSheet(store, sheetRow(SENTINEL_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: null,
      }), ROSTER_SIZE)
    })

    it('GET /view is truncated', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: SENTINEL_SHEET, limit: '1000' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(res.body.data.page.hasMore).toBe(false)
    })

    it('GET /records-summary bounds records and displayMap', async () => {
      const res = await api(await buildApp(store)).get('/api/multitable/records-summary').query({ sheetId: SENTINEL_SHEET, limit: '200' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
      expect(Object.keys(res.body.data.displayMap)).toHaveLength(PEOPLE_SHEET_READ_MAX_ITEMS)
    })

    it('export-xlsx is refused', async () => {
      const res = await api(await buildApp(store)).get(`/api/multitable/sheets/${SENTINEL_SHEET}/export-xlsx`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
    })
  })

  // ── §5 positive controls ──────────────────────────────────────────────────
  describe('§5 positive controls — nothing but the People sheet moved', () => {
    it('an ORDINARY sheet still answers far past the window (its own 5000 cap)', async () => {
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), ROSTER_SIZE)
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET, limit: '1000' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(ROSTER_SIZE)
      expect(res.body.data.page.total).toBe(ROSTER_SIZE)
    })

    it('an ORDINARY sheet still pages past row 50', async () => {
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), ROSTER_SIZE)
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET, limit: '20', offset: '60' })
      expect(res.status).toBe(200)
      expect(res.body.data.rows).toHaveLength(20)
      expect(res.body.data.rows[0].id).toBe(`rec_${PLAIN_SHEET}_060`)
    })

    it("an ORDINARY sheet's records-summary keeps its full displayMap and honest total", async () => {
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), ROSTER_SIZE)
      const res = await api(await buildApp(store)).get('/api/multitable/records-summary').query({ sheetId: PLAIN_SHEET, limit: '200' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(ROSTER_SIZE)
      expect(Object.keys(res.body.data.displayMap)).toHaveLength(ROSTER_SIZE)
      expect(res.body.data.page.total).toBe(ROSTER_SIZE)
    })

    it('an ORDINARY sheet is neither export-refused nor aggregate-refused', async () => {
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), 3)
      const exported = await api(await buildApp(store)).get(`/api/multitable/sheets/${PLAIN_SHEET}/export-xlsx`)
      expect(exported.status).not.toBe(403)
      const aggregated = await api(await buildApp(store)).get(`/api/multitable/sheets/${PLAIN_SHEET}/view-aggregate`)
      expect(aggregated.status).not.toBe(403)
    })

    it("an ORDINARY sheet's dashboard query is not refused", async () => {
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), 3)
      const res = await api(await buildApp(store))
        .post('/api/multitable/dashboard/query')
        .send({ sheetId: PLAIN_SHEET, widgets: [{ title: 'Tasks', chartType: 'bar', metric: 'count', groupByFieldId: `fld_name_${PLAIN_SHEET}` }] })
      expect(res.status).not.toBe(403)
    })

    it("MetaLinkPicker's link-options for an ORDINARY foreign sheet is unchanged (200 cap)", async () => {
      const linkFieldId = 'fld_link_plain'
      const otherSheet = 'sheet_plain_foreign_rb'
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), 1)
      addRosterSheet(store, sheetRow(otherSheet, { name: 'Projects' }), ROSTER_SIZE)
      store.fields.push({
        id: linkFieldId,
        sheet_id: PLAIN_SHEET,
        name: 'Project',
        type: 'link',
        order: 1,
        property: { foreignSheetId: otherSheet },
      })
      const res = await api(await buildApp(store)).get(`/api/multitable/fields/${linkFieldId}/link-options`).query({ limit: '200' })
      expect(res.status).toBe(200)
      expect(res.body.data.records).toHaveLength(ROSTER_SIZE)
      expect(res.body.data.page.total).toBe(ROSTER_SIZE)
    })

    it('the legacy person CHIP still resolves through the People sheet (summaries are not an enumeration)', async () => {
      const linkFieldId = 'fld_chip_people'
      const peopleNameField = addRosterSheet(store, sheetRow(PEOPLE_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }), ROSTER_SIZE)
      expect(peopleNameField).toBeTruthy()
      addRosterSheet(store, sheetRow(PLAIN_SHEET, { name: 'Tasks' }), 1)
      store.fields.push({
        id: linkFieldId,
        sheet_id: PLAIN_SHEET,
        name: 'Owner',
        type: 'link',
        order: 1,
        property: { foreignSheetId: PEOPLE_SHEET },
      })
      // The task row points at a person BEYOND the window — the chip must still render it.
      store.links.push({
        field_id: linkFieldId,
        record_id: `rec_${PLAIN_SHEET}_000`,
        foreign_record_id: `rec_${PEOPLE_SHEET}_099`,
      })
      const res = await api(await buildApp(store)).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET, limit: '50', includeLinkSummaries: 'true' })
      expect(res.status).toBe(200)
      const summaries = res.body.data.linkSummaries?.[`rec_${PLAIN_SHEET}_000`]?.[linkFieldId]
      expect(summaries).toHaveLength(1)
      expect(summaries[0].id).toBe(`rec_${PEOPLE_SHEET}_099`)
    })

    it('/people-search still returns display values', async () => {
      addRosterSheet(store, sheetRow(PEOPLE_SHEET, {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }), ROSTER_SIZE)
      const res = await api(await buildApp(store)).get('/api/multitable/people-search').query({ baseId: BASE_ID, q: 'Fake Person 1' })
      expect(res.status).toBe(200)
      expect(res.body.data.items.length).toBeGreaterThan(0)
      expect(res.body.data.items[0].display).toContain('Fake Person')
    })

    it('the window is the SAME number as the candidate-interface ceiling (one ruler, two modules)', async () => {
      const { PERSON_DIRECTORY_MAX_ITEMS } = await import('../../src/routes/univer-meta')
      expect(PEOPLE_SHEET_READ_MAX_ITEMS).toBe(PERSON_DIRECTORY_MAX_ITEMS)
      expect(PEOPLE_SHEET_READ_MAX_ITEMS).toBe(50)
    })
  })
})
