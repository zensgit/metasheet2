/**
 * #5816 follow-up — `GET /people-search` reads the SAME People sheet the People sync maintains
 * (mock pool, no DB).
 *
 * The sync (`POST /person-fields/prepare`) picks the People sheet of a base by preferring the
 * server-owned `system_kind = people_directory` sheet, then falling back to the EARLIEST live sheet whose
 * description is the People sentinel (trimmed comparison), reading `system_kind` column-tolerantly.
 * The search used to pick "any one sheet whose description is exactly the sentinel" (no trim, no
 * ordering, `LIMIT 1`), so it could read a shadowed or forged sheet. Both now go through one helper.
 *
 *   - a people_directory sheet wins over an OLDER sentinel-only sheet (and a people_directory sheet whose
 *     description is not the sentinel is still found)
 *   - a soft-deleted people_directory sheet is ignored
 *   - among sentinel-only sheets the EARLIEST wins, whatever order the database returns rows in
 *   - a whitespace-padded sentinel is still recognised
 *   - on a database without the `system_kind` column the search still answers 200 (no 42703)
 *   - a base with no People sheet still answers `{ ok: true, data: { items: [] } }`
 *
 * NOT covered: who may read the People sheet (#5807 read gate stays open).
 *
 * The mock pool EVALUATES the base-scoped `meta_sheets` read: the description filter, ORDER BY
 * direction (none = storage order, which the fixtures deliberately make differ from created_at order)
 * and LIMIT — so a change to that query changes which sheet the route ends up reading.
 *
 * Fixtures are obviously fake. TRANSPORT: one pinned listener per file — `request(app)` is banned in
 * tests/unit by supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'
import { usePinnedServer } from '../utils/pinned-server'

const BASE_ID = 'base_psel'
const OTHER_BASE_ID = 'base_psel_other'
const ADMIN_USER = { id: 'u_psel_admin', roles: ['admin'], perms: [] as string[] }

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

interface Store {
  /** Storage order — what a query without ORDER BY sees. */
  sheets: SheetRow[]
  fields: Array<{ id: string; sheet_id: string; name: string; type: string; order: number }>
  records: Array<{ id: string; sheet_id: string; data: Record<string, unknown>; created_at: string }>
  /** Model a database the `system_kind` migration has not reached yet: naming the column is a 42703. */
  sheetsLackSystemKind?: boolean
}

function sheet(id: string, createdAt: string, extra: Partial<SheetRow> = {}): SheetRow {
  return { id, base_id: BASE_ID, name: 'People', description: null, system_kind: null, deleted_at: null, created_at: createdAt, ...extra }
}

/** A sheet with one `Name` column and one row whose name says which sheet it lives in. */
function addPeopleSheet(store: Store, row: SheetRow): void {
  store.sheets.push(row)
  store.fields.push({ id: `fld_${row.id}`, sheet_id: row.id, name: 'Name', type: 'string', order: 0 })
  store.records.push({ id: `rec_${row.id}`, sheet_id: row.id, data: { [`fld_${row.id}`]: `Person in ${row.id}` }, created_at: '2026-01-10T00:00:00.000Z' })
}

function projectSelected(sql: string, row: Record<string, unknown>, lacking: string[]): Record<string, unknown> {
  const match = /SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql)
  if (!match) return { ...row }
  const out: Record<string, unknown> = {}
  for (const raw of match[1].split(',')) {
    const expr = raw.trim()
    const jsonPick = /^\(\s*to_jsonb\(\w+\)\s*->>\s*'(\w+)'\s*\)\s+AS\s+(\w+)$/i.exec(expr)
    if (jsonPick) {
      const [, source, alias] = jsonPick
      const value = lacking.includes(source) ? null : row[source]
      out[alias] = value === null || value === undefined ? null : String(value)
      continue
    }
    const col = expr.replace(/^\w+\./, '').replace(/"/g, '')
    if (col in row) out[col] = row[col]
  }
  return out
}

function createMockPool(store: Store) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const p = (i: number) => String(params[i] ?? '')

    if (store.sheetsLackSystemKind && /\bmeta_sheets\b/i.test(sql)) {
      const withoutTolerantRead = sql.replace(/\(\s*to_jsonb\(\w+\)\s*->>\s*'system_kind'\s*\)\s+AS\s+system_kind/gi, '')
      if (/\bsystem_kind\b/i.test(withoutTolerantRead)) {
        throw Object.assign(new Error('column "system_kind" does not exist'), { code: '42703' })
      }
    }

    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('source_base_id')) return { rows: [] }
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error(`people-search must not write: ${sql}`)

    if (/FROM\s+meta_sheets\b[\s\S]*WHERE\s+base_id\s*=\s*\$1/i.test(sql)) {
      let rows = store.sheets.filter((s) => s.base_id === p(0))
      if (/deleted_at\s+IS\s+NULL/i.test(sql)) rows = rows.filter((s) => s.deleted_at === null)
      if (/description\s*=\s*\$2/i.test(sql)) rows = rows.filter((s) => s.description === p(1))
      const order = /ORDER\s+BY\s+created_at(\s+(ASC|DESC))?/i.exec(sql)
      if (order) {
        const desc = (order[2] ?? '').toUpperCase() === 'DESC'
        rows = [...rows].sort((a, b) => (desc ? -1 : 1) * a.created_at.localeCompare(b.created_at))
      }
      const limit = /LIMIT\s+(\d+)/i.exec(sql)
      if (limit) rows = rows.slice(0, Number(limit[1]))
      return {
        rows: rows.map((s) => projectSelected(sql, s as unknown as Record<string, unknown>, store.sheetsLackSystemKind ? ['system_kind'] : [])),
      }
    }
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      const row = store.sheets.find((s) => s.id === p(0))
      if (!row) return { rows: [] }
      if (sql.includes('deleted_at IS NULL') && row.deleted_at !== null) return { rows: [] }
      return { rows: [{ ...row }] }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return {
        rows: store.fields
          .filter((f) => f.sheet_id === p(0))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((f) => ({ ...f, property: {} })),
      }
    }
    if (sql.includes('FROM meta_records') && sql.includes('WHERE sheet_id = $1')) {
      return {
        rows: store.records
          .filter((r) => r.sheet_id === p(0))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
          .map((r) => ({ id: r.id, data: structuredClone(r.data) })),
      }
    }
    return { rows: [] }
  })
  return { query, transaction: vi.fn() }
}

async function buildApp(store: Store): Promise<Express> {
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
    ;(req as any).user = { ...ADMIN_USER }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

function search(app: Express, q = 'person') {
  pinned.setApp(app)
  return request(pinned.url()).get('/api/multitable/people-search').query({ baseId: BASE_ID, q })
}

function itemsOf(sheetId: string) {
  return { ok: true, data: { items: [{ id: `rec_${sheetId}`, display: `Person in ${sheetId}` }] } }
}

describe('#5816 follow-up — /people-search selects the People sheet with the sync rule', () => {
  let store: Store

  beforeEach(() => {
    vi.resetModules()
    store = { sheets: [], fields: [], records: [] }
    // A People sheet in ANOTHER base, stored first and oldest: never a candidate.
    addPeopleSheet(store, sheet('sheet_other_base', '2025-12-01T00:00:00.000Z', {
      base_id: OTHER_BASE_ID,
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
      system_kind: 'people_directory',
    }))
  })

  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  it('reads the people_directory sheet, not an OLDER sentinel-only sheet', async () => {
    addPeopleSheet(store, sheet('sheet_forged_old', '2026-01-02T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    addPeopleSheet(store, sheet('sheet_system', '2026-01-05T00:00:00.000Z', {
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
      system_kind: 'people_directory',
    }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_system'))
  })

  it('finds a people_directory sheet whose description is not the sentinel', async () => {
    addPeopleSheet(store, sheet('sheet_forged_old', '2026-01-02T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    addPeopleSheet(store, sheet('sheet_system', '2026-01-05T00:00:00.000Z', { description: 'renamed', system_kind: 'people_directory' }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_system'))
  })

  it('ignores a soft-deleted people_directory sheet and falls back to the sentinel sheet', async () => {
    addPeopleSheet(store, sheet('sheet_system_deleted', '2026-01-01T00:00:00.000Z', {
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
      system_kind: 'people_directory',
      deleted_at: '2026-01-03T00:00:00.000Z',
    }))
    addPeopleSheet(store, sheet('sheet_sentinel', '2026-01-02T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_sentinel'))
  })

  it('reads the EARLIEST of two sentinel-only sheets even when storage order puts the newer one first', async () => {
    addPeopleSheet(store, sheet('sheet_sentinel_newer', '2026-01-04T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    addPeopleSheet(store, sheet('sheet_sentinel_earliest', '2026-01-02T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_sentinel_earliest'))
  })

  it('recognises a whitespace-padded sentinel description', async () => {
    addPeopleSheet(store, sheet('sheet_padded', '2026-01-02T00:00:00.000Z', { description: `  ${SYSTEM_PEOPLE_SHEET_DESCRIPTION} ` }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_padded'))
  })

  it('answers 200 on a database without the system_kind column', async () => {
    store.sheetsLackSystemKind = true
    store.sheets = []
    store.fields = []
    store.records = []
    addPeopleSheet(store, sheet('sheet_sentinel_newer', '2026-01-04T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    addPeopleSheet(store, sheet('sheet_sentinel_earliest', '2026-01-02T00:00:00.000Z', { description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }))
    const res = await search(await buildApp(store))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(itemsOf('sheet_sentinel_earliest'))
  })

  it('keeps the empty answer when the base has no People sheet, and the term filter still applies', async () => {
    const empty = await search(await buildApp(store))
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ ok: true, data: { items: [] } })

    vi.resetModules()
    addPeopleSheet(store, sheet('sheet_system', '2026-01-05T00:00:00.000Z', { system_kind: 'people_directory' }))
    const miss = await search(await buildApp(store), 'nobody-matches')
    expect(miss.status).toBe(200)
    expect(miss.body).toEqual({ ok: true, data: { items: [] } })
  })

  it('still requires baseId', async () => {
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url()).get('/api/multitable/people-search').query({ q: 'person' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
