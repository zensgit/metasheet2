/**
 * Collaboration snapshot hints are attached only after the sheet list is ACL-filtered.
 * Denied and foreign sheet ids are not query parameters. An absent bindings table omits the hint.
 * The optional read selects id, sheet_id, and source_kind only.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const BASE_ID = 'base_collab_w23'
const ECO_SHEET = '11111111-1111-4111-8111-111111111111'
const READY_SHEET = '22222222-2222-4222-8222-222222222222'
const BAD_UUID_SHEET = '33333333-3333-4333-8333-333333333333'
const BAD_KIND_SHEET = '44444444-4444-4444-8444-444444444444'
const DUP_SHEET = '55555555-5555-4555-8555-555555555555'
const MIXED_SHEET = '66666666-6666-4666-8666-666666666666'
const DENIED = '77777777-7777-4777-8777-777777777777'
const FOREIGN = '88888888-8888-4888-8888-888888888888'
const ECO_BINDING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const READY_BINDING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const MIXED_BINDING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const DUP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
const DUP_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
const READABLE = [ECO_SHEET, READY_SHEET, BAD_UUID_SHEET, BAD_KIND_SHEET, DUP_SHEET, MIXED_SHEET]

interface SheetRow {
  id: string
  base_id: string
  name: string
  description: string | null
  system_kind: null
  created_at: string
}

interface BindingRow {
  id: string
  sheet_id: string
  source_kind: string
  owner_id: string
}

/** Bound so a swallowed query cannot grow the observation without limit. */
const UNEXPECTED_SQL_LIMIT = 4

interface Fixture {
  sheets: SheetRow[]
  bindings: BindingRow[]
  grants: Set<string>
  present: string | null
  throwBindings: boolean
  collaborationSql: Array<{ sql: string; params: unknown[] }>
  unexpectedSql: string[]
}

function sheet(id: string, createdAt: string): SheetRow {
  return { id, base_id: BASE_ID, name: id, description: null, system_kind: null, created_at: createdAt }
}

function binding(id: string, sheetId: string, sourceKind: string): BindingRow {
  return { id, sheet_id: sheetId, source_kind: sourceKind, owner_id: 'secret-owner' }
}

function fullFixture(): Fixture {
  return {
    sheets: [
      sheet(ECO_SHEET, '2026-01-01T00:00:00.000Z'),
      sheet(READY_SHEET, '2026-01-02T00:00:00.000Z'),
      sheet(BAD_UUID_SHEET, '2026-01-03T00:00:00.000Z'),
      sheet(BAD_KIND_SHEET, '2026-01-04T00:00:00.000Z'),
      sheet(DUP_SHEET, '2026-01-05T00:00:00.000Z'),
      sheet(MIXED_SHEET, '2026-01-06T00:00:00.000Z'),
      sheet(DENIED, '2026-01-07T00:00:00.000Z'),
    ],
    bindings: [
      binding(ECO_BINDING, ECO_SHEET, 'eco'),
      binding(READY_BINDING, READY_SHEET, 'readiness'),
      binding('not-a-uuid', BAD_UUID_SHEET, 'eco'),
      binding(ECO_BINDING, BAD_KIND_SHEET, 'cad'),
      binding(DUP_A, DUP_SHEET, 'eco'),
      binding(DUP_B, DUP_SHEET, 'readiness'),
      binding(MIXED_BINDING, MIXED_SHEET, 'eco'),
      binding('also-not-a-uuid', MIXED_SHEET, 'readiness'),
      binding(ECO_BINDING, DENIED, 'eco'),
      binding(READY_BINDING, FOREIGN, 'eco'),
    ],
    grants: new Set(READABLE),
    present: 'meta_plm_collaboration_bindings',
    throwBindings: false,
    collaborationSql: [],
    unexpectedSql: [],
  }
}

function recordUnexpectedSql(fixture: Fixture, sql: string): void {
  if (fixture.unexpectedSql.length >= UNEXPECTED_SQL_LIMIT) return
  fixture.unexpectedSql.push(sql)
}

function expectNoUnexpectedSql(fixture: Fixture): void {
  expect(fixture.unexpectedSql).toEqual([])
}

function createPool(fixture: Fixture) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/to_regclass\('meta_plm_collaboration_bindings'\)/i.test(sql) || /FROM\s+meta_plm_collaboration_bindings/i.test(sql)) {
      fixture.collaborationSql.push({ sql, params })
    }
    if (/to_regclass\('meta_plm_collaboration_bindings'\)/i.test(sql)) {
      return { rows: [{ present: fixture.present }] }
    }
    if (/FROM\s+meta_plm_collaboration_bindings/i.test(sql)) {
      if (fixture.throwBindings) throw new Error('bindings unavailable')
      const ids = Array.isArray(params[0]) ? params[0] as string[] : []
      return { rows: fixture.bindings.filter((row) => ids.includes(row.sheet_id)) }
    }
    if (/spreadsheet_permissions/i.test(sql)) {
      const ids = Array.isArray(params[1]) ? params[1] as string[] : []
      return {
        rows: ids
          .filter((id) => fixture.grants.has(id))
          .map((id) => ({ sheet_id: id, perm_code: 'spreadsheet:read', subject_type: 'user' })),
      }
    }
    if (/SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i.test(sql)) {
      const row = fixture.sheets.find((item) => item.id === params[0])
      return { rows: row ? [{ deleted_at: null }] : [] }
    }
    if (/FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*ANY\(\$1::text\[\]\)\s+AND\s+base_id\s*=\s*\$2/i.test(sql)) {
      return { rows: [] }
    }
    if (/FROM\s+meta_sheets\s+s\b/i.test(sql)) {
      const row = fixture.sheets.find((item) => item.id === params[0])
      return { rows: row ? [row] : [] }
    }
    if (/FROM\s+meta_sheets\s+WHERE\s+base_id\s*=\s*\$1/i.test(sql)) {
      return { rows: fixture.sheets.filter((item) => item.base_id === params[0]) }
    }
    if (/FROM\s+meta_sheets\s+WHERE\s+deleted_at\s+IS\s+NULL/i.test(sql)) {
      return { rows: [...fixture.sheets].sort((a, b) => a.created_at.localeCompare(b.created_at)) }
    }
    if (/FROM\s+meta_bases\b/i.test(sql)) {
      const row = { id: BASE_ID, name: '协作库', icon: 'table', color: '#1677ff', owner_id: 'owner-1', workspace_id: null }
      if (/WHERE\s+id\s*=\s*\$1/i.test(sql)) return { rows: params[0] === BASE_ID ? [row] : [] }
      return { rows: [row] }
    }
    if (/FROM\s+meta_views\s+WHERE\s+sheet_id\s*=\s*\$1\s+ORDER\s+BY\s+created_at\s+ASC/i.test(sql)) {
      return { rows: [] }
    }
    if (/FROM\s+meta_fields\s+WHERE\s+sheet_id\s*=\s*\$1\s+ORDER\s+BY\s+"order"\s+ASC,\s+id\s+ASC/i.test(sql)) {
      return { rows: [] }
    }
    if (/FROM\s+field_permissions\s+fp\b/i.test(sql)) {
      return { rows: [] }
    }
    if (/FROM\s+user_permissions\s+up\b/i.test(sql) && /FROM\s+user_roles\s+ur\b/i.test(sql)) {
      return { rows: [] }
    }
    recordUnexpectedSql(fixture, sql)
    throw new Error(`unexpected sql: ${sql}`)
  })
  return { query, transaction: vi.fn() }
}

async function buildApp(fixture: Fixture): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createPool(fixture) as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: 'user-collab', roles: [], perms: [] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

function hintOf(sheet: { plmCollaborationSnapshot?: unknown } | null | undefined): unknown {
  return sheet?.plmCollaborationSnapshot ?? null
}

describe('multitable collaboration navigation hints', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  it('attaches one finite hint per readable sheet and does not query denied or foreign ids', async () => {
    const fixture = fullFixture()
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get('/api/multitable/sheets')
    expect(response.status).toBe(200)
    const sheets = response.body.data.sheets as Array<{ id: string; plmCollaborationSnapshot?: { bindingId: string; sourceKind: string } }>
    expect(sheets.map((item) => item.id)).toEqual(READABLE)
    expect(hintOf(sheets.find((item) => item.id === ECO_SHEET))).toEqual({ bindingId: ECO_BINDING, sourceKind: 'eco' })
    expect(hintOf(sheets.find((item) => item.id === READY_SHEET))).toEqual({ bindingId: READY_BINDING, sourceKind: 'readiness' })
    expect(hintOf(sheets.find((item) => item.id === MIXED_SHEET))).toEqual({ bindingId: MIXED_BINDING, sourceKind: 'eco' })
    expect(hintOf(sheets.find((item) => item.id === BAD_UUID_SHEET))).toBeNull()
    expect(hintOf(sheets.find((item) => item.id === BAD_KIND_SHEET))).toBeNull()
    expect(hintOf(sheets.find((item) => item.id === DUP_SHEET))).toBeNull()
    for (const sheet of sheets) {
      if (!sheet.plmCollaborationSnapshot) continue
      expect(Object.keys(sheet.plmCollaborationSnapshot).sort()).toEqual(['bindingId', 'sourceKind'])
    }
    expect(JSON.stringify(response.body)).not.toContain('secret-owner')
    const bindingSql = fixture.collaborationSql.filter((entry) => /FROM\s+meta_plm_collaboration_bindings/i.test(entry.sql))
    expect(bindingSql).toHaveLength(1)
    expect(bindingSql[0]?.sql).toBe(
      'SELECT id::text AS id, sheet_id, source_kind FROM meta_plm_collaboration_bindings WHERE sheet_id = ANY($1::text[])',
    )
    expect(bindingSql[0]?.sql).not.toMatch(/source_config|\banchor\b|tuple|owner|credential|resources|\bstatus\b/i)
    expect(bindingSql[0]?.params[0]).toEqual(READABLE)
    expect(bindingSql[0]?.params[0]).not.toContain(DENIED)
    expect(bindingSql[0]?.params[0]).not.toContain(FOREIGN)
    expectNoUnexpectedSql(fixture)
  })

  it('omits hints when to_regclass reports the bindings table is absent', async () => {
    const fixture = fullFixture()
    fixture.present = null
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get('/api/multitable/sheets')
    expect(response.status).toBe(200)
    const sheets = response.body.data.sheets as Array<Record<string, unknown>>
    expect(sheets.length).toBeGreaterThan(0)
    expect(sheets.every((sheet) => !('plmCollaborationSnapshot' in sheet))).toBe(true)
    expect(fixture.collaborationSql.map((entry) => entry.sql)).toEqual([
      "SELECT to_regclass('meta_plm_collaboration_bindings') AS present",
    ])
    expectNoUnexpectedSql(fixture)
  })

  it('does not query collaboration tables when no sheet is readable', async () => {
    const fixture = fullFixture()
    fixture.grants = new Set()
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get('/api/multitable/sheets')
    expect(response.status).toBe(200)
    expect(response.body.data.sheets).toEqual([])
    expect(fixture.collaborationSql).toEqual([])
    expectNoUnexpectedSql(fixture)
  })

  it('attaches the same hint on context sheets and the selected sheet', async () => {
    const fixture = fullFixture()
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get(`/api/multitable/context?baseId=${BASE_ID}`)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const selected = response.body.data.sheet
    const sheets = response.body.data.sheets as Array<{ id: string }>
    expect(sheets.map((item) => item.id)).toEqual(READABLE)
    expect(hintOf(selected)).toEqual({ bindingId: ECO_BINDING, sourceKind: 'eco' })
    expect(hintOf(sheets.find((item) => item.id === READY_SHEET))).toEqual({ bindingId: READY_BINDING, sourceKind: 'readiness' })
    expect(JSON.stringify(response.body)).not.toContain('secret-owner')
    const bindingSql = fixture.collaborationSql.filter((entry) => /FROM\s+meta_plm_collaboration_bindings/i.test(entry.sql))
    expect(bindingSql).toHaveLength(1)
    expect(bindingSql[0]?.params[0]).toEqual(READABLE)
    expectNoUnexpectedSql(fixture)
  })

  it('refuses a denied context sheet before any collaboration query', async () => {
    const fixture = fullFixture()
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get(`/api/multitable/context?sheetId=${DENIED}`)
    expect(response.status).toBe(403)
    expect(fixture.collaborationSql).toEqual([])
    expectNoUnexpectedSql(fixture)
  })

  it('journals one direct unknown query and leaves that entry only on this fixture', async () => {
    const fixture = fullFixture()
    const pool = createPool(fixture)
    const sentinel = 'SELECT unexpected_sentinel FROM meta_future_table'
    await expect(pool.query(sentinel)).rejects.toThrow(`unexpected sql: ${sentinel}`)
    expect(fixture.unexpectedSql).toEqual([sentinel])
  })

  it('surfaces a bindings read failure as the route 500', async () => {
    const fixture = fullFixture()
    fixture.throwBindings = true
    pinned.setApp(await buildApp(fixture))
    const response = await request(pinned.url()).get('/api/multitable/sheets')
    expect(response.status).toBe(500)
    expect(response.body.ok).not.toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('secret-owner')
    expect(fixture.collaborationSql.filter((entry) => /FROM\s+meta_plm_collaboration_bindings/i.test(entry.sql))).toHaveLength(1)
    expectNoUnexpectedSql(fixture)
  })
})
