/**
 * #5825 — sheet lists and the selected-sheet slot hide system sheets with the SAME rule as the delete
 * guard (`sheet-delete-guard.ts`): server-owned `system_kind = people_directory` OR the People sentinel
 * description. Mock pool, no DB.
 *
 * Before #5825 the four list-filtering sites in `routes/univer-meta.ts` (`GET /bases`, `POST /templates`,
 * `GET /context`, `GET /sheets`) only looked at the description, so a People directory sheet whose
 * description had been edited showed up as an ordinary, selectable sheet, while sync / search / delete
 * guard still treated it as the system People sheet.
 *
 *   - a people_directory sheet with an edited description is hidden (lists, base listing, template
 *     extraction, /context list, /context?sheetId= selected-sheet path)
 *   - a sentinel-only sheet stays hidden, as before
 *   - an ordinary sheet stays visible
 *   - an approval_projection sheet is NOT hidden by this predicate (scope is the People kind only)
 *   - on a database without the `system_kind` column every route still answers (no 500 / 42703)
 *   - structural: univer-meta.ts filters lists only through `isHiddenSystemSheet`, never a
 *     description-only check
 *
 * VISIBILITY ONLY: nothing here grants or refuses a capability on the basis of the sentinel.
 *
 * TRANSPORT: one pinned listener per file — `request(app)` is banned in tests/unit by
 * supertest-app-mode-tripwire.test.ts (#4154).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SYSTEM_PEOPLE_SHEET_DESCRIPTION,
  isHiddenSystemSheet,
} from '../../src/multitable/system-sheet-predicate'
import { usePinnedServer } from '../utils/pinned-server'

const BASE_ID = 'base_sslv'
const PEOPLE_ONLY_BASE_ID = 'base_sslv_people_only'
const ADMIN_USER = { id: 'u_sslv_admin', roles: ['admin'], perms: [] as string[] }

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
  bases: Array<{ id: string; name: string; icon: string; color: string; owner_id: string; workspace_id: string | null }>
  sheets: SheetRow[]
  sheetsLackSystemKind?: boolean
}

function sheet(id: string, createdAt: string, extra: Partial<SheetRow> = {}): SheetRow {
  return { id, base_id: BASE_ID, name: id, description: null, system_kind: null, deleted_at: null, created_at: createdAt, ...extra }
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
    if (/\bAS\b/i.test(expr)) continue
    const col = expr.replace(/^\w+\./, '').replace(/"/g, '')
    if (col in row) out[col] = row[col]
  }
  return out
}

function createMockPool(store: Store) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const p = (i: number) => (params[i] === undefined || params[i] === null ? null : params[i])
    const lacking = store.sheetsLackSystemKind ? ['system_kind'] : []

    if (store.sheetsLackSystemKind && /\bmeta_sheets\b/i.test(sql)) {
      const withoutTolerantRead = sql.replace(/\(\s*to_jsonb\(\w+\)\s*->>\s*'system_kind'\s*\)\s+AS\s+system_kind/gi, '')
      if (/\bsystem_kind\b/i.test(withoutTolerantRead)) {
        throw Object.assign(new Error('column "system_kind" does not exist'), { code: '42703' })
      }
    }
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) return { rows: [], rowCount: 0 }

    if (/FROM\s+meta_bases\b/i.test(sql)) {
      if (/WHERE\s+id\s*=\s*\$1/i.test(sql)) return { rows: store.bases.filter((b) => b.id === p(0)) }
      return { rows: [...store.bases] }
    }

    if (/FROM\s+meta_sheets\s+s\b[\s\S]*WHERE\s+s\.id\s*=\s*\$1/i.test(sql)) {
      const row = store.sheets.find((s) => s.id === p(0) && s.deleted_at === null)
      return { rows: row ? [projectSelected(sql, row as unknown as Record<string, unknown>, lacking)] : [] }
    }
    if (/FROM\s+meta_sheets\s+WHERE\s+base_id\s*=\s*\$1/i.test(sql)) {
      let rows = store.sheets.filter((s) => s.base_id === p(0) && s.deleted_at === null)
      const ids = p(1)
      if (/id\s*=\s*ANY\(\$2/i.test(sql) && Array.isArray(ids)) rows = rows.filter((s) => ids.includes(s.id))
      rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
      return { rows: rows.map((s) => projectSelected(sql, s as unknown as Record<string, unknown>, lacking)) }
    }
    if (/FROM\s+meta_sheets\s+WHERE\s+deleted_at\s+IS\s+NULL\s+ORDER\s+BY\s+created_at/i.test(sql)) {
      const rows = store.sheets
        .filter((s) => s.deleted_at === null)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      return { rows: rows.map((s) => projectSelected(sql, s as unknown as Record<string, unknown>, lacking)) }
    }
    if (/FROM\s+meta_sheets\b/i.test(sql) && /WHERE\s+id\s*=\s*\$1/i.test(sql)) {
      const row = store.sheets.find((s) => s.id === p(0))
      return { rows: row ? [projectSelected(sql, row as unknown as Record<string, unknown>, lacking)] : [] }
    }
    return { rows: [] }
  })
  return { query, transaction: vi.fn() }
}

async function buildApp(store: Store): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(true),
    userHasPermission: vi.fn().mockResolvedValue(true),
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

function freshStore(): Store {
  return {
    bases: [
      { id: BASE_ID, name: 'Ops', icon: 'table', color: '#1677ff', owner_id: 'o1', workspace_id: null },
      { id: PEOPLE_ONLY_BASE_ID, name: 'Directory', icon: 'users', color: '#722ed1', owner_id: 'o1', workspace_id: null },
    ],
    sheets: [
      // people_directory whose description was edited by a user — must stay hidden (#5825).
      sheet('sheet_kind_people', '2026-01-01T00:00:00.000Z', { name: 'People', description: 'Team roster', system_kind: 'people_directory' }),
      // Pre-`system_kind` People sheet — hidden by the sentinel, as before.
      sheet('sheet_sentinel_people', '2026-01-02T00:00:00.000Z', { name: 'People (legacy)', description: `  ${SYSTEM_PEOPLE_SHEET_DESCRIPTION} ` }),
      sheet('sheet_orders', '2026-01-03T00:00:00.000Z', { name: 'Orders', description: 'Ops records' }),
      sheet('sheet_approval_proj', '2026-01-04T00:00:00.000Z', { name: 'Approval · x', description: 'projection', system_kind: 'approval_projection' }),
      // A base whose ONLY sheet is a description-edited People directory sheet.
      sheet('sheet_kind_people_only', '2026-01-05T00:00:00.000Z', { base_id: PEOPLE_ONLY_BASE_ID, name: 'People', description: 'renamed', system_kind: 'people_directory' }),
    ],
  }
}

const HIDDEN = ['sheet_kind_people', 'sheet_sentinel_people', 'sheet_kind_people_only']

describe('#5825 — list visibility uses system_kind OR the People sentinel', () => {
  let store: Store

  beforeEach(() => {
    vi.resetModules()
    store = freshStore()
  })

  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  it('predicate: people_directory OR sentinel; other kinds and ordinary sheets stay visible', () => {
    expect(isHiddenSystemSheet({ system_kind: 'people_directory', description: 'edited' })).toBe(true)
    expect(isHiddenSystemSheet({ system_kind: null, description: ` ${SYSTEM_PEOPLE_SHEET_DESCRIPTION}` })).toBe(true)
    expect(isHiddenSystemSheet({ description: SYSTEM_PEOPLE_SHEET_DESCRIPTION })).toBe(true)
    expect(isHiddenSystemSheet({ system_kind: null, description: 'Ops' })).toBe(false)
    expect(isHiddenSystemSheet({ system_kind: 'approval_projection', description: 'x' })).toBe(false)
    expect(isHiddenSystemSheet({ system_kind: 'elearning_projection', description: 'x' })).toBe(false)
    expect(isHiddenSystemSheet(undefined)).toBe(false)
    expect(isHiddenSystemSheet(null)).toBe(false)
  })

  for (const lackColumn of [false, true]) {
    const label = lackColumn ? ' (database without system_kind)' : ''

    it(`GET /sheets hides system People sheets${label}`, async () => {
      store.sheetsLackSystemKind = lackColumn
      pinned.setApp(await buildApp(store))
      const res = await request(pinned.url()).get('/api/multitable/sheets')
      expect(res.status).toBe(200)
      const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
      expect(ids).toContain('sheet_orders')
      expect(ids).toContain('sheet_approval_proj')
      expect(ids).not.toContain('sheet_sentinel_people')
      if (lackColumn) {
        // Without the column the server cannot know the kind: the pre-#5825 sentinel rule applies alone.
        expect(ids).toContain('sheet_kind_people')
      } else {
        for (const id of HIDDEN) expect(ids).not.toContain(id)
      }
    })

    it(`GET /bases drops a base whose only sheet is a system People sheet${label}`, async () => {
      store.sheetsLackSystemKind = lackColumn
      pinned.setApp(await buildApp(store))
      const res = await request(pinned.url()).get('/api/multitable/bases')
      expect(res.status).toBe(200)
      const ids = (res.body.data.bases as Array<{ id: string }>).map((b) => b.id)
      expect(ids).toContain(BASE_ID)
      if (lackColumn) expect(ids).toContain(PEOPLE_ONLY_BASE_ID)
      else expect(ids).not.toContain(PEOPLE_ONLY_BASE_ID)
    })

    it(`GET /context?baseId= lists only visible sheets and never selects a system sheet${label}`, async () => {
      store.sheetsLackSystemKind = lackColumn
      pinned.setApp(await buildApp(store))
      const res = await request(pinned.url()).get('/api/multitable/context').query({ baseId: BASE_ID })
      expect(res.status).toBe(200)
      const ids = (res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)
      if (lackColumn) {
        expect(ids).toEqual(['sheet_kind_people', 'sheet_orders', 'sheet_approval_proj'])
        expect(res.body.data.sheet?.id).toBe('sheet_kind_people')
      } else {
        expect(ids).toEqual(['sheet_orders', 'sheet_approval_proj'])
        expect(res.body.data.sheet?.id).toBe('sheet_orders')
      }
    })
  }

  it('GET /context?sheetId= does not serve a description-edited people_directory sheet as the selected sheet', async () => {
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: 'sheet_kind_people' })
    expect(res.body?.data?.sheet?.id).not.toBe('sheet_kind_people')
    expect(res.status).toBe(403)
  })

  it('GET /context?sheetId= keeps a sentinel-only sheet out of the selected slot (unchanged)', async () => {
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: 'sheet_sentinel_people' })
    expect(res.body?.data?.sheet?.id).not.toBe('sheet_sentinel_people')
    expect(res.status).toBe(403)
  })

  it('GET /context?sheetId= still serves an ordinary sheet', async () => {
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: 'sheet_orders' })
    expect(res.status).toBe(200)
    expect(res.body.data.sheet.id).toBe('sheet_orders')
    expect((res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)).toEqual(['sheet_orders', 'sheet_approval_proj'])
  })

  it('GET /context?sheetId= on a database without system_kind does not 500', async () => {
    store.sheetsLackSystemKind = true
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: 'sheet_orders' })
    expect(res.status).toBe(200)
    expect(res.body.data.sheet.id).toBe('sheet_orders')
    // #6089 B1: this pins the COLUMN-TOLERANT read specifically, not merely "did not 500" — the
    // route's own S1 fail-closed net (any probe error => canDeleteSheet: false) would ALSO turn a
    // 500-causing bare-column read into a 200 with canDeleteSheet FALSE, so a status-only assertion
    // cannot tell the tolerant read apart from S1 quietly swallowing a 42703 every time. ADMIN_USER
    // holds admin role (global schema authority) and `sheet_orders` is an ordinary, unmanaged sheet,
    // so the correct answer on a column-less database is TRUE (isSystemManagedSheet must resolve to
    // false without throwing) — only the tolerant read (sheet-delete-guard.ts) gets that right.
    expect(res.body.data.capabilities.canDeleteSheet).toBe(true)
  })

  it('POST /templates does not extract a description-edited people_directory sheet', async () => {
    pinned.setApp(await buildApp(store))
    const res = await request(pinned.url())
      .post('/api/multitable/templates')
      .send({ baseId: BASE_ID, sheetIds: ['sheet_kind_people'] })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('structural: univer-meta.ts filters sheet lists only through isHiddenSystemSheet', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8').replace(/\r\n/g, '\n')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
    // The description-only check survives only where it is NOT list visibility: the People sheet pick
    // (`selectPeopleSheetRow`, sentinel fallback) and the reserved-description refusal on create (#5807).
    const descriptionOnly = code.match(/isSystemPeopleSheetDescription\(/g) ?? []
    expect(descriptionOnly).toHaveLength(2)
    expect(code).toMatch(/candidateRows\.find\(\(row\) => isSystemPeopleSheetDescription\(row\.description\)\)/)
    expect(code).toMatch(/if \(isSystemPeopleSheetDescription\(description\)\)/)
    // filterVisibleSheetRows + the /context selected-sheet slot + the /context sheet list.
    expect(code).toMatch(/rows\.filter\(\(row\) => !isHiddenSystemSheet\(row\)\)/)
    expect(code).toMatch(/\(!isHiddenSystemSheet\(sheetRow\) \? sheetRow : null\)/)
    expect(code).toMatch(/filter\(\(row: any\) =>\s*!isHiddenSystemSheet\(row\)/)
    // Every list read feeding those filters carries system_kind (column-tolerant form).
    const listReads = code.match(/SELECT id, base_id, name, description, \(to_jsonb\(meta_sheets\) ->> 'system_kind'\) AS system_kind/g) ?? []
    expect(listReads).toHaveLength(4)
    expect(code).toMatch(/SELECT s\.id, s\.base_id, s\.name, s\.description, \(to_jsonb\(s\) ->> 'system_kind'\) AS system_kind,/)
  })
})
