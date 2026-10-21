import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { registerAttendanceTimezoneTargetRoutes: register } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-target-routes.cjs')
type Request = { query?: unknown, params: { userId: string }, allowed: boolean }
type Response = { status: (code: number) => Response, json: (body: unknown) => void }
type Handler = (req: Request, res: Response) => Promise<void>
class HttpError extends Error {
  constructor(public status: number, public code: string) { super('private runtime value') }
}
const target = {
  orgId: 'org-a', userId: 'self-a', workDate: '2026-01-07', timezone: 'Asia/Singapore',
  contextFingerprint: 'a'.repeat(64), frozen: false, referenceId: null, provenance: null,
  window: { startAt: new Date('2026-01-07T01:00:00Z'), endAt: new Date('2026-01-07T10:00:00Z') },
  rule: { work_start_time: '09:00', work_end_time: '18:00' }, isWorkingDay: true,
}
function fixture(options: { actor?: null, member?: boolean, manage?: boolean, target?: unknown, error?: Error, unavailable?: boolean } = {}) {
  const routes = new Map<string, Handler>()
  const permissions: string[] = []
  const query = vi.fn(async () => options.member === false ? [] : [{ id: 'self-a' }])
  const trx = { query }
  const transaction = vi.fn(async (work: (value: typeof trx) => Promise<unknown>) => work(trx))
  const authorizeManage = vi.fn(async (_input: { trx: typeof trx; query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>; orgId: string; actorId: string }) => options.manage === true)
  const readTargetTimezoneContext = vi.fn(async () => {
    if (options.error) throw options.error
    return options.target === undefined ? target : options.target
  })
  register({
    addRoute: (_method: string, path: string, handler: Handler) => routes.set(path, handler),
    withPermission: (permission: string, handler: Handler) => {
      permissions.push(permission)
      return async (req: Request, res: Response) => {
        if (!req.allowed) { res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } }); return }
        await handler(req, res)
      }
    },
    resolveActor: () => options.actor === null ? null : { orgId: 'org-a', userId: 'self-a' },
    db: { transaction }, authorizeManage,
    readTargetTimezoneContext: options.unavailable ? undefined : readTargetTimezoneContext, HttpError,
  })
  async function run(queryValue: unknown = { workDate: '2026-01-07' }, employee = false, allowed = true) {
    const result = { status: 200, body: undefined as unknown }
    const res: Response = { status: code => { result.status = code; return res }, json: body => { result.body = body } }
    await routes.get('/api/attendance/timezone-context/' + (employee ? 'employees/:userId' : 'me'))!({
      query: queryValue, params: { userId: 'employee-a' }, allowed,
    }, res)
    return result
  }
  return { run, routes, permissions, query, trx, transaction, authorizeManage, readTargetTimezoneContext }
}
const failure = (status: number, code: string) => ({ status, body: { ok: false, error: { code } } })

describe('trusted target timezone HTTP routes', () => {
  it('pins self and admin routes to their corresponding permission', () => {
    const f = fixture()
    expect([...f.routes.keys()]).toEqual(['/api/attendance/timezone-context/me', '/api/attendance/timezone-context/employees/:userId'])
    expect(f.permissions).toEqual(['attendance:read', 'attendance:admin'])
  })
  it('returns the exact scoped target and UTC window without mutable reconstruction', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ status: 200, body: { ok: true, data: {
      ...target, window: { startAt: '2026-01-07T01:00:00.000Z', endAt: '2026-01-07T10:00:00.000Z' },
    } } })
    expect(f.readTargetTimezoneContext).toHaveBeenCalledTimes(1)
    expect(f.readTargetTimezoneContext).toHaveBeenCalledWith(f.trx, { orgId: 'org-a', userId: 'self-a', workDate: '2026-01-07' })
    expect(f.authorizeManage).not.toHaveBeenCalled()
  })
  it('accepts an old complete freeze with explicitly absent provenance', async () => {
    const f = fixture({ target: { ...target, frozen: true, referenceId: 'record-a', provenance: null } })
    expect(await f.run()).toEqual({ status: 200, body: { ok: true, data: {
      ...target, frozen: true, referenceId: 'record-a', window: { startAt: '2026-01-07T01:00:00.000Z', endAt: '2026-01-07T10:00:00.000Z' },
    } } })
  })
  it.each([undefined, {}, [], { workDate: ['2026-01-07'] }, { workDate: '2026-02-30' },
    { workDate: '2026-01-07', userId: 'other' }, { workDate: '2026-01-07', orgId: 'other' },
    { workDate: '2026-01-07', timezone: 'Asia/Tokyo' }, { workDate: '2026-01-07T00:00:00Z' },
  ])('rejects malformed or override query before any transaction: %j', async query => {
    const f = fixture()
    const actualQuery = query === undefined ? null : query
    expect(await f.run(actualQuery)).toEqual(failure(400, 'ATTENDANCE_TIMEZONE_TARGET_INVALID'))
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('denies route permission without a transaction or runtime call', async () => {
    const f = fixture()
    expect(await f.run(undefined, false, false)).toEqual(failure(403, 'FORBIDDEN'))
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.readTargetTimezoneContext).not.toHaveBeenCalled()
  })
  it('does no work when trusted actor resolution rejects', async () => {
    const f = fixture({ actor: null })
    await f.run()
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('rechecks actor active organization membership inside the same transaction', async () => {
    const f = fixture({ member: false })
    expect(await f.run()).toEqual(failure(403, 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'))
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('uo.is_active=true'), ['self-a', 'org-a'])
    expect(f.readTargetTimezoneContext).not.toHaveBeenCalled()
  })
  it('does not treat attendance admin middleware as database management authority', async () => {
    const f = fixture()
    expect(await f.run(undefined, true)).toEqual(failure(403, 'ATTENDANCE_TIMEZONE_PERMISSION_DENIED'))
    expect(f.readTargetTimezoneContext).not.toHaveBeenCalled()
  })
  it('binds admin target to path subject and actor organization in the same transaction', async () => {
    const f = fixture({ manage: true, target: { ...target, userId: 'employee-a' } })
    expect((await f.run(undefined, true)).status).toBe(200)
    expect(f.authorizeManage).toHaveBeenCalledTimes(1)
    expect(f.authorizeManage).toHaveBeenCalledWith({ trx: f.trx, query: expect.any(Function), orgId: 'org-a', actorId: 'self-a' })
    const authorization = f.authorizeManage.mock.calls[0][0] as {
      query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>
    }
    expect(await authorization.query('authority query', ['self-a', 'org-a'])).toEqual({ rows: [{ id: 'self-a' }] })
    expect(f.query).toHaveBeenLastCalledWith('authority query', ['self-a', 'org-a'])
    expect(f.readTargetTimezoneContext).toHaveBeenCalledTimes(1)
    expect(f.readTargetTimezoneContext).toHaveBeenCalledWith(f.trx, { orgId: 'org-a', userId: 'employee-a', workDate: '2026-01-07' })
  })
  it.each([
    { ...target, orgId: 'other' }, { ...target, userId: 'other' }, { ...target, workDate: '2026-01-08' },
    { ...target, contextFingerprint: 'unverified' }, { ...target, timezone: 'not-a-zone' },
    { ...target, window: { ...target.window, endAt: target.window.startAt } },
  ])('refuses an invalid or unbound trusted result without returning its values', async value => {
    const f = fixture({ target: value })
    expect(await f.run()).toEqual(failure(503, 'ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE'))
  })
  it('preserves typed runtime conflict codes without exception messages', async () => {
    const f = fixture({ error: new HttpError(409, 'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT') })
    expect(await f.run()).toEqual(failure(409, 'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT'))
  })
  it('does not trust status and code properties on an unknown exception', async () => {
    const f = fixture({ error: Object.assign(new Error('private data'), { status: 409, code: 'PRIVATE_VALUE' }) })
    expect(await f.run()).toEqual(failure(503, 'ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE'))
  })
  it('fails closed before SQL when runtime wiring is absent', async () => {
    const f = fixture({ unavailable: true })
    expect(await f.run()).toEqual(failure(503, 'ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE'))
    expect(f.transaction).not.toHaveBeenCalled()
  })
})
