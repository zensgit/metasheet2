/**
 * 2c-S3a — GET /sheets/:sheetId/person-fields/:fieldId/directory route logic.
 *
 * Mock-pool route test (mirrors the export-permission-canary harness). The directory CONTENT is
 * real-DB-tested at the resolver (2c-S2 / the person-member-group-restrict suite); here we pin the
 * route's OWN gatekeeping: the canEditRecord auth gate (NOT the canManageSheetAccess gate that
 * /permission-candidates uses), the person-field 404, and the success response shape.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

const SHEET_ID = 'sheet_pdir'
const F_PERSON = 'fld_person'
const F_STRING = 'fld_str'
const FIELD_ROWS = [
  { id: F_PERSON, name: 'Owner', type: 'person', property: {}, order: 1 },
  { id: F_STRING, name: 'Note', type: 'string', property: {}, order: 2 },
]

function createMockPool() {
  const handler = (sql: string) => {
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID, base_id: 'base_pdir', name: 'PDir', description: null }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) return { rows: FIELD_ROWS }
    // All permission / candidate tables empty → the directory resolver yields [] (content is tested
    // for real elsewhere; this test only needs the route to reach + shape it).
    return { rows: [], rowCount: 0 }
  }
  const query = vi.fn(async (sql: string) => handler(sql))
  const transaction = vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(isAdmin: boolean) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(isAdmin),
    userHasPermission: vi.fn().mockResolvedValue(isAdmin),
    listUserPermissions: vi.fn().mockResolvedValue(isAdmin ? ['multitable:write'] : ['multitable:read']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as unknown as ReturnType<typeof poolManager.get>)
  const app = express()
  app.use(express.json())
  const perms = isAdmin ? ['multitable:write'] : ['multitable:read']
  app.use((req, _res, next) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u_pdir', roles: [], perms, permissions: perms }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const url = (fieldId: string) => `/api/multitable/sheets/${SHEET_ID}/person-fields/${fieldId}/directory`

describe('2c-S3a person field directory route', () => {
  afterEach(() => vi.restoreAllMocks())

  test('403 when the caller lacks canEditRecord (read-only — not the admin gate)', async () => {
    const app = await createApp(false)
    const res = await request(app).get(url(F_PERSON))
    expect(res.status).toBe(403)
  })

  test('404 for a non-person field', async () => {
    const app = await createApp(true)
    const res = await request(app).get(url(F_STRING))
    expect(res.status).toBe(404)
  })

  test('404 for an unknown field id', async () => {
    const app = await createApp(true)
    const res = await request(app).get(url('fld_nope'))
    expect(res.status).toBe(404)
  })

  test('200 with the directory response shape for a person field', async () => {
    const app = await createApp(true)
    const res = await request(app).get(url(F_PERSON))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toMatchObject({ items: expect.any(Array), total: expect.any(Number), query: '' })
  })
})
