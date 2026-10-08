/**
 * #5960 — route-level wiring of the People-sheet read window on
 * `GET /api/approvals/record-link-options`.
 *
 * The service suite (`approval-record-link-options.test.ts`) pins the window in
 * `listApprovalRecordLinkOptions`; this file pins that the ROUTE passes `offset`/`limit` through and
 * returns the bounded `page` unchanged. It builds the real `approvalsRouter()` over a fake pg pool
 * (mocked at `../../src/db/pg`), with `authenticate`/`rbacGuard` mocked so the route body runs, and
 * uses `usePinnedServer()` (the #4154-safe transport), never `request(app)`.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const pgState = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  recordSelects: [] as unknown[][],
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
  query: pgState.pool.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'user-1', tenantId: 'tenant-a', name: 'Filler One', permissions: [] } as never
    next()
  },
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  rbacGuardAny: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/multitable/permission-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/permission-service')>(
    '../../src/multitable/permission-service',
  )
  return {
    ...actual,
    loadFieldPermissionScopeMap: vi.fn(async () => new Map()),
    loadRowLevelReadDenyEnabledStrict: vi.fn(async () => false),
    loadDeniedRecordIds: vi.fn(async () => new Set<string>()),
  }
})

const ROSTER = 120
const roster = Array.from({ length: ROSTER }, (_, i) => ({
  id: `rec_${String(i).padStart(3, '0')}`,
  data: { fld_title: `Person ${i}` },
  display_label: `Person ${i}`,
}))

/** Same dual base+sheet gate fixture as the service suite, with the target classified as People. */
async function peopleSheetQuery(sql: string, params?: unknown[]) {
  const q = sql.replace(/\s+/g, ' ')
  if (q.includes("to_jsonb(s) ->> 'system_kind'") && q.includes('FROM meta_sheets')) {
    return { rows: [{ description: null, system_kind: 'people_directory' }] }
  }
  if (q.includes('COUNT(*)') && q.includes('FROM meta_records')) return { rows: [{ n: ROSTER }] }
  if (q.includes('FROM meta_records') && q.includes('LIMIT')) {
    const p = params ?? []
    pgState.recordSelects.push(p)
    const limit = Number(p[p.length - 2])
    const offset = Number(p[p.length - 1])
    return { rows: roster.slice(offset, offset + limit) }
  }
  if (q.includes('permission_code') || q.includes('user_permissions')) return { rows: [{ code: 'multitable:read' }] }
  if (q.includes('FROM user_roles')) return { rows: [] }
  if (q.includes('FROM meta_sheets') && q.includes('deleted_at')) return { rows: [{ id: 'sheet-1', base_id: 'base-1' }] }
  if (q.includes('FROM meta_bases')) return { rows: [{ owner_id: 'user-1' }] }
  if (q.includes('FROM users') && q.includes('permissions')) return { rows: [{ permissions: [] }] }
  if (q.includes('FROM spreadsheet_permissions')) {
    return { rows: [{ sheet_id: 'sheet-1', perm_code: 'spreadsheet:read', subject_type: 'user' }] }
  }
  if (q.includes('FROM meta_fields')) return { rows: [{ id: 'fld_title', type: 'string', property: {} }] }
  return { rows: [] }
}

const pinned = usePinnedServer()

describe('GET /api/approvals/record-link-options — People sheet read window at the route (#5960)', () => {
  let app: Express

  beforeEach(async () => {
    vi.resetModules()
    pgState.recordSelects.length = 0
    pgState.pool.query.mockReset()
    pgState.pool.query.mockImplementation(peopleSheetQuery)
    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    pinned.setApp(app)
  })

  it('offset past the window answers an empty page, hasMore false, total capped, no record read', async () => {
    const response = await request(pinned.url())
      .get('/api/approvals/record-link-options')
      .query({ baseId: 'base-1', sheetId: 'sheet-1', limit: '20', offset: '60' })

    expect(response.status).toBe(200)
    expect(response.body.records).toEqual([])
    expect(response.body.page).toEqual({ limit: 20, offset: 60, total: 50, hasMore: false })
    expect(pgState.recordSelects).toEqual([])
  })

  it('first page is clamped to the window at the route too', async () => {
    const response = await request(pinned.url())
      .get('/api/approvals/record-link-options')
      .query({ baseId: 'base-1', sheetId: 'sheet-1', limit: '100', offset: '0' })

    expect(response.status).toBe(200)
    expect(response.body.records).toHaveLength(50)
    expect(response.body.page).toEqual({ limit: 50, offset: 0, total: 50, hasMore: false })
  })
})
