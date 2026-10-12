import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Request = { params: { userId?: string, referenceId?: string }, allowed?: boolean, body?: unknown }
type Response = { status: (status: number) => Response, json: (body: unknown) => void }
type Handler = (req: Request, res: Response) => Promise<void>
const { registerAttendanceTimezonePolicyRoutes: register } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-routes.cjs',
)
const defaultRow = { id: 'rule-a', timezone: 'Asia/Tokyo', timezone_version: 3 }

function fixture(responses: unknown[][], actor: { orgId: string, userId: string } | null = { orgId: 'org-a', userId: 'admin-a' }, ports: Record<string, unknown> = {}) {
  const routes = new Map<string, Handler>()
  const query = vi.fn()
  for (const rows of responses) query.mockResolvedValueOnce(rows)
  const transaction = vi.fn(async (work: (trx: { query: typeof query }) => Promise<unknown>) => work({ query }))
  const permissions: string[] = []
  register({
    addRoute: (method: string, path: string, handler: Handler) => routes.set(method + ' ' + path, handler),
    withPermission: (permission: string, handler: Handler) => {
      permissions.push(permission)
      return async (req: Request, res: Response) => {
        if (!req.allowed) { res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } }); return }
        await handler(req, res)
      }
    },
    resolveActor: () => actor,
    db: { transaction },
    ...ports,
  })
  async function run(employee = false, allowed = true) {
    const result = { status: 200, body: undefined as unknown }
    const res: Response = {
      status: status => { result.status = status; return res },
      json: body => { result.body = body },
    }
    const path = employee ? '/api/attendance/timezone-policy/employees/:userId' : '/api/attendance/timezone-policy'
    await routes.get('GET ' + path)!({ params: { userId: 'employee-a' }, allowed }, res)
    return result
  }
  async function runWrite(path: string, body: unknown, allowed = true) {
    const result = { status: 200, body: undefined as unknown }
    const res: Response = { status: status => { result.status = status; return res }, json: body => { result.body = body } }
    await routes.get(path)!({ params: { userId: 'employee-a', referenceId: 'override-a' }, body, allowed }, res)
    return result
  }
  return { routes, query, transaction, permissions, run, runWrite }
}

afterEach(() => vi.useRealTimers())

describe('attendance timezone administration read routes', () => {
  it('registers reads and guarded writes with attendance admin permission', () => {
    const f = fixture([])
    expect([...f.routes.keys()]).toEqual([
      'GET /api/attendance/timezone-policy',
      'GET /api/attendance/timezone-policy/employees/:userId',
      'POST /api/attendance/timezone-policy/preview',
      'PUT /api/attendance/timezone-policy',
      'POST /api/attendance/timezone-policy/employees/:userId',
      'POST /api/attendance/timezone-policy/employees/:userId/:referenceId/close',
    ])
    expect(f.permissions).toEqual(Array(6).fill('attendance:admin'))
  })
  it('denies insufficient permission before any transaction or SQL', async () => {
    const f = fixture([])
    expect(await f.run(false, false)).toEqual({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } })
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.query).not.toHaveBeenCalled()
  })
  it('returns before SQL when the authenticated actor resolver refuses the request', async () => {
    const f = fixture([], null)
    await f.run()
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('returns absent policy as OFF with the actual organization default revision', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], [defaultRow]])
    expect(await f.run()).toEqual({
      status: 200, body: { ok: true, data: {
        enabled: false, version: 0,
        systemDefault: { orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Tokyo', version: 3 },
      } },
    })
    expect(f.transaction).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls.map(call => call[1])).toEqual([
      ['admin-a', 'org-a'], ['org-a'], ['org-a'],
    ])
    expect(f.query.mock.calls.every(call => /^SELECT /.test(call[0]))).toBe(true)
  })
  it('returns a persisted strict boolean and actual policy version', async () => {
    const f = fixture([[{ id: 'admin-a' }], [{ enabled: true, version: 7 }], [defaultRow]])
    expect((await f.run()).body).toEqual({ ok: true, data: {
      enabled: true, version: 7,
      systemDefault: { orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Tokyo', version: 3 },
    } })
  })
  it('refuses an inactive or cross-organization actor without reading configuration', async () => {
    const f = fixture([[]])
    expect(await f.run()).toEqual({ status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } } })
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls[0][0]).toContain('uo.org_id = $2')
    expect(f.query.mock.calls[0][0]).toContain('uo.is_active = true')
  })
  it('refuses missing organization default instead of using a global fallback', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], []])
    expect(await f.run()).toEqual({ status: 422, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED' } } })
  })
  it('refuses duplicate defaults without choosing by row order', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], [defaultRow, { ...defaultRow, id: 'rule-b' }]])
    expect(await f.run()).toEqual({ status: 409, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS' } } })
  })
  it('never echoes a database error or turns it into OFF', async () => {
    const f = fixture([])
    f.query.mockRejectedValueOnce(new Error('synthetic-sensitive-value'))
    expect(await f.run()).toEqual({ status: 503, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE' } } })
  })
  it('refuses a target outside the organization before reading its overrides', async () => {
    const f = fixture([[{ id: 'admin-a' }], []])
    expect(await f.run(true)).toEqual({ status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } } })
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls[1][1]).toEqual(['employee-a', 'org-a'])
  })
  it('returns no effective override as null using one server instant', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-10-12T01:00:00.000Z')
    vi.setSystemTime(now)
    const f = fixture([[{ id: 'admin-a' }], [{ id: 'employee-a' }], []])
    expect(await f.run(true)).toEqual({ status: 200, body: { ok: true, data: { override: null } } })
    expect(f.query.mock.calls[2][1]).toEqual(['org-a', 'employee-a', now])
  })
})

describe('guarded administrator timezone write adapters', () => {
  const policyPath = 'PUT /api/attendance/timezone-policy'
  const createPath = 'POST /api/attendance/timezone-policy/employees/:userId'
  const closePath = createPath + '/:referenceId/close'
  it('requires a combined trusted source guard before starting a write transaction', async () => {
    const f = fixture([])
    expect(await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 })).toEqual({
      status: 503, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_WRITE_GUARD_UNAVAILABLE' } },
    })
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it.each([
    { enabled: 'false', expectedVersion: 0 },
    { enabled: false, expectedVersion: -1 },
    { enabled: false, expectedVersion: 0.5 },
    { enabled: false, expectedVersion: 0, orgId: 'org-b' },
    { enabled: false, expectedVersion: 0, actorId: 'other' },
  ])('rejects malformed or forged policy input before any transaction', async body => {
    const f = fixture([])
    expect(await f.runWrite(policyPath, body)).toEqual({
      status: 400, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_INVALID_INPUT' } },
    })
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it.each(['2026-10-12T09:00', '2026-02-30T09:00:00Z', '2026-10-12T24:00:00Z'])(
    'rejects invalid or zone-free effective timestamps %s', async effectiveFrom => {
      const f = fixture([])
      expect((await f.runWrite(createPath, { timezone: 'Asia/Singapore', effectiveFrom,
        effectiveTo: null, expectedPolicyVersion: 0 })).status).toBe(400)
      expect(f.transaction).not.toHaveBeenCalled()
    },
  )
  it('refuses invalid close versions without invoking a guard or transaction', async () => {
    const f = fixture([])
    expect((await f.runWrite(closePath, { endAt: '2026-10-15T00:00:00Z', expectedVersion: 0 })).status).toBe(400)
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('keeps permission refusal before transaction', async () => {
    const f = fixture([])
    expect((await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 }, false)).status).toBe(403)
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('uses the actor organization and runs both source guard phases in the same transaction', async () => {
    const verify = vi.fn(async () => {})
    const prepare = vi.fn(async (_input: { orgId: string, userIds: string[] | null, trx: { query: unknown }, mutation: unknown }) => verify)
    const authorize = vi.fn(async (_input: { orgId: string, actorId: string }) => true)
    const f = fixture([[], [defaultRow], [{ id: 'admin-a' }], [], [{ enabled: true, version: 1 }], []],
      { orgId: 'org-a', userId: 'admin-a' },
      { authorizeManage: authorize, prepareTimezoneSourceChange: prepare })
    expect(await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 })).toEqual({
      status: 200, body: { ok: true, data: { enabled: true, version: 1 } },
    })
    expect(authorize.mock.calls[0][0]).toMatchObject({ orgId: 'org-a', actorId: 'admin-a' })
    expect(prepare.mock.calls[0][0]).toMatchObject({ orgId: 'org-a', userIds: null,
      mutation: { kind: 'policy', enabled: true, expectedVersion: 0 } })
    expect(prepare.mock.calls[0][0].trx.query).toBe(f.query)
    expect(verify).toHaveBeenCalledOnce()
    expect(f.query.mock.calls[4][1]).toEqual(['org-a', true, 'admin-a', 0])
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(f.query.mock.invocationCallOrder[4])
    expect(f.query.mock.invocationCallOrder[5]).toBeLessThan(verify.mock.invocationCallOrder[0])
  })
  it('converts explicit employee interval offsets and binds the target to actor organization', async () => {
    const from = new Date('2026-10-15T01:00:00.000Z')
    const verify = vi.fn(async () => {})
    const f = fixture([[], [{ id: 'admin-a' }], [{ enabled: true, version: 2 }], [{ id: 'employee-a' }],
      [{ id: 'override-a', timezone: 'Asia/Singapore', version: 1, effective_from: from, effective_to: null }], []],
    undefined, { authorizeManage: async () => true, prepareTimezoneSourceChange: async () => verify })
    expect(await f.runWrite(createPath, { timezone: 'Asia/Singapore', effectiveFrom: '2026-10-15T09:00:00+08:00',
      effectiveTo: null, expectedPolicyVersion: 2 })).toEqual({
      status: 201, body: { ok: true, data: { orgId: 'org-a', userId: 'employee-a', referenceId: 'override-a',
        timezone: 'Asia/Singapore', version: 1, effectiveFrom: from, effectiveTo: null } },
    })
    expect(f.query.mock.calls[4][1]).toEqual(['org-a', 'employee-a', 'Asia/Singapore', from, null, 'admin-a'])
    expect(verify).toHaveBeenCalledOnce()
  })
  it('closes only the named same-organization override at its expected revision', async () => {
    const from = new Date('2026-10-12T00:00:00.000Z')
    const end = new Date('2026-10-15T00:00:00.000Z')
    const old = { id: 'override-a', timezone: 'Asia/Tokyo', version: 1, effective_from: from, effective_to: null }
    const verify = vi.fn(async () => {})
    const f = fixture([[], [{ id: 'admin-a' }], [{ enabled: true, version: 2 }], [{ id: 'employee-a' }],
      [old], [{ ...old, version: 2, effective_to: end }], []], undefined,
    { authorizeManage: async () => true, prepareTimezoneSourceChange: async () => verify })
    expect(await f.runWrite(closePath, { endAt: end.toISOString(), expectedVersion: 1 })).toEqual({
      status: 200, body: { ok: true, data: { orgId: 'org-a', userId: 'employee-a', referenceId: 'override-a',
        timezone: 'Asia/Tokyo', version: 2, effectiveFrom: from, effectiveTo: end } },
    })
    expect(f.query.mock.calls[5][1]).toEqual([end, 'admin-a', 'override-a', 'org-a', 'employee-a', 1])
    expect(verify).toHaveBeenCalledOnce()
  })
  it.each([
    { rows: [], status: 422, code: 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED' },
    { rows: [defaultRow, { ...defaultRow, id: 'rule-b' }], status: 409, code: 'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS' },
    { rows: [{ ...defaultRow, timezone: 'invalid-zone' }], status: 422, code: 'ATTENDANCE_TIMEZONE_INVALID_ZONE' },
    { rows: [{ ...defaultRow, timezone_version: 0 }], status: 422, code: 'ATTENDANCE_TIMEZONE_INVALID_REVISION' },
  ])('rejects enablement when the organization default is unavailable or invalid', async item => {
    const prepare = vi.fn()
    const f = fixture([[], item.rows], undefined,
      { authorizeManage: async () => true, prepareTimezoneSourceChange: prepare })
    expect(await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 })).toEqual({
      status: item.status, body: { ok: false, error: { code: item.code } },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(f.query.mock.calls.every(call => !/^(INSERT|UPDATE|DELETE)/.test(call[0]))).toBe(true)
  })
  it('permits disabling without reading a broken organization default while retaining source guards', async () => {
    const verify = vi.fn(async () => {})
    const prepare = vi.fn(async () => verify)
    const f = fixture([[], [{ id: 'admin-a' }], [{ enabled: true, version: 2 }],
      [{ enabled: false, version: 3 }], []], undefined,
    { authorizeManage: async () => true, prepareTimezoneSourceChange: prepare })
    expect(await f.runWrite(policyPath, { enabled: false, expectedVersion: 2 })).toEqual({
      status: 200, body: { ok: true, data: { enabled: false, version: 3 } },
    })
    expect(f.query.mock.calls.some(call => call[0].includes('FROM attendance_rules'))).toBe(false)
    expect(prepare).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledOnce()
  })
  it('refuses a changed permission inside the store transaction before source writes', async () => {
    const prepare = vi.fn()
    const f = fixture([[]], undefined, { authorizeManage: async () => false, prepareTimezoneSourceChange: prepare })
    expect((await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 })).status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
    expect(f.query).toHaveBeenCalledTimes(1)
  })
  it('does not echo an unexpected trusted guard failure', async () => {
    const f = fixture([[], [defaultRow]], undefined, { authorizeManage: async () => true,
      prepareTimezoneSourceChange: async () => { throw new Error('synthetic-sensitive-value') } })
    expect(await f.runWrite(policyPath, { enabled: true, expectedVersion: 0 })).toEqual({
      status: 503, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE' } },
    })
  })
})


describe('attendance timezone read-only impact preview adapter', () => {
  const route = 'POST /api/attendance/timezone-policy/preview'
  const input = { enabled: true, expectedVersion: 2 }
  const impact = { currentVersion: 2, proposedEnabled: true, evaluatedUsers: 3, affectedUsers: 2,
    conflictingUsers: 1, conflictCounts: { startedContext: 1, tripContext: 0, invalidTargetContext: 0 } }
  const fail = (status: number, code: string) => ({ status, body: { ok: false, error: { code } } })
  it('runs in a read-only transaction, authorizes the actual actor and binds the preview organization', async () => {
    const authorize = vi.fn(async () => true)
    const preview = vi.fn(async () => impact)
    const f = fixture([[]], undefined, { authorizeManage: authorize, previewTimezonePolicyChange: preview })
    expect(await f.runWrite(route, input)).toEqual({ status: 200, body: { ok: true, data: impact } })
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith({ query: expect.any(Function), trx: expect.any(Object), orgId: 'org-a', actorId: 'admin-a' })
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ query: f.query }), { orgId: 'org-a', ...input })
  })
  it.each([{}, { ...input, orgId: 'other' }, { ...input, actorId: 'other' }, { ...input, enabled: 'true' },
    { ...input, expectedVersion: -1 }, { ...input, expectedVersion: 2.1 }, { ...input, policyProjection: {} },
  ])('refuses an untrusted projection or invalid input before SQL: %j', async body => {
    const f = fixture([])
    expect(await f.runWrite(route, body)).toEqual(fail(400, 'ATTENDANCE_TIMEZONE_INVALID_INPUT'))
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('refuses missing trusted ports before starting a transaction', async () => {
    const f = fixture([])
    expect(await f.runWrite(route, input)).toEqual(fail(503, 'ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE'))
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('does not run the preview for an unauthorized actor', async () => {
    const preview = vi.fn()
    const f = fixture([[]], undefined, { authorizeManage: async () => false, previewTimezonePolicyChange: preview })
    expect(await f.runWrite(route, input)).toEqual(fail(403, 'ATTENDANCE_TIMEZONE_FORBIDDEN'))
    expect(preview).not.toHaveBeenCalled()
  })
  it.each([
    { ...impact, currentVersion: 1 }, { ...impact, proposedEnabled: false },
    { ...impact, affectedUsers: 4 }, { ...impact, evaluatedUsers: -1 },
    { ...impact, conflictCounts: { ...impact.conflictCounts, tripContext: 4 } },
    { ...impact, conflictingUsers: 0 },
    { ...impact, untrusted: 'private-value' },
  ])('fails closed on unbound or invalid counts without partial results', async result => {
    const f = fixture([[]], undefined, { authorizeManage: async () => true, previewTimezonePolicyChange: async () => result })
    expect(await f.runWrite(route, input)).toEqual(fail(503, 'ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE'))
  })
  it('does not serialize an unknown runtime exception', async () => {
    const f = fixture([[]], undefined, { authorizeManage: async () => true,
      previewTimezonePolicyChange: async () => { throw Object.assign(new Error('private value'), { status: 409, code: 'PRIVATE_VALUE' }) } })
    expect(await f.runWrite(route, input)).toEqual(fail(503, 'ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE'))
  })
  it('rejects middleware permission before any read-only transaction', async () => {
    const f = fixture([])
    expect(await f.runWrite(route, input, false)).toEqual(fail(403, 'FORBIDDEN'))
    expect(f.transaction).not.toHaveBeenCalled()
  })
})
