import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
// Plugin HTTP handlers are untyped CJS; exercise the registered handlers, not copied logic.
type Handler = (req: any, res: any, next: any) => Promise<void>
const originalBypass = process.env.RBAC_BYPASS
const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const id = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const paths = [
  '/api/attendance/import/jobs/:id',
  '/api/attendance/import/batches',
  '/api/attendance/import/batches/:id',
  '/api/attendance/import/batches/:id/items',
  '/api/attendance/import/batches/:id/export.csv',
]

async function createHarness() {
  process.env.RBAC_BYPASS = 'true'
  const routes = new Map<string, Handler>()
  const db = {
    query: vi.fn(async (_sql: string, _args: unknown[] = []) => [] as unknown[]),
    transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(db)),
  }
  await plugin.activate({
    api: {
      database: db,
      events: { emit: vi.fn() },
      http: { addRoute: (method: string, path: string, handler: Handler) => routes.set(`${method} ${path}`, handler) },
    },
    services: {
      attendanceW4SegmentCalculation: {
        resolveOrgSegmentCalculationPosture: async () => ({ effectiveState: 'legacy', referenceSegments: false }),
        createRequestOperationBoundary: () => ({ execute: vi.fn() }),
      },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  db.query.mockClear()
  db.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('COUNT(*)')) return [{ total: 1 }]
    const scope = args.includes(orgB) ? orgB : orgA
    if (sql.includes('attendance_import_items')) {
      return [{ id, batch_id: id, org_id: scope, user_id: actorId, work_date: '2031-01-03', preview_snapshot: {}, source_row: {} }]
    }
    return [{ id, org_id: scope, status: 'completed', source: 'qa', row_count: 1 }]
  })
  return { routes, db }
}

async function invoke(routes: Map<string, Handler>, path: string, override: Record<string, unknown> = {}) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
    send(body: unknown) { this.body = body; return this },
    setHeader(name: string, value: string) { this.headers[name] = value; return this },
    type(value: string) { this.headers['Content-Type'] = value; return this },
  }
  const handler = routes.get(`GET ${path}`)
  expect(handler).toBeTypeOf('function')
  await handler!({
    params: { id }, query: {}, body: {}, headers: {},
    user: { id: actorId }, authenticatedTenantId: orgA,
    ...override,
  }, res, vi.fn())
  return res
}

afterEach(async () => {
  await plugin.deactivate()
  if (originalBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalBypass
  vi.restoreAllMocks()
})

describe.each(paths)('authenticated import read: %s', path => {
  it.each([
    ['no selector', {}],
    ['matching selector', { query: { orgId: orgA } }],
  ])('reads the authenticated organization with %s', async (_name, override) => {
    const { routes, db } = await createHarness()
    const res = await invoke(routes, path, override)
    expect(res.statusCode).toBe(200)
    if (path.endsWith('export.csv')) {
      expect(String(res.body).trim().split(/\r?\n/).map(line => line.split(',').slice(0, 2)))
        .toEqual([['batchId', 'itemId'], [id, id]])
    } else {
      const response = res.body as { ok: boolean; data: { id?: string; orgId?: string; items?: Array<{ id: string; orgId: string }> } }
      expect(response.ok).toBe(true)
      const rows = response.data.items ?? [response.data]
      expect(rows.map(row => ({ id: row.id, orgId: row.orgId }))).toEqual([{ id, orgId: orgA }])
    }
    expect(db.query).toHaveBeenCalled()
    for (const [, args] of db.query.mock.calls) {
      expect(args).toContain(orgA)
      expect(args).not.toContain(orgB)
      expect(args).not.toContain('default')
    }
  })

  it.each([
    ['foreign query', { query: { orgId: orgB } }],
    ['foreign body', { body: { orgId: orgB } }],
    ['foreign org header', { headers: { 'x-org-id': orgB } }],
    ['foreign tenant header', { headers: { 'x-tenant-id': orgB } }],
    ['duplicate query selector', { query: { orgId: [orgA, orgA] } }],
    ['missing authenticated tenant', { authenticatedTenantId: undefined, user: { id: actorId, tenantId: orgA } }],
    ['conflicting user organization', { user: { id: actorId, orgId: orgB } }],
  ])('rejects %s before import SQL even with the permission bypass', async (_name, override) => {
    const { routes, db } = await createHarness()
    const res = await invoke(routes, path, override)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Attendance access denied' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('does not accept a header-only actor', async () => {
    const { routes, db } = await createHarness()
    const res = await invoke(routes, path, { user: undefined, headers: { 'x-user-id': actorId } })
    expect(res.statusCode).toBe(401)
    expect(db.query).not.toHaveBeenCalled()
  })
})
