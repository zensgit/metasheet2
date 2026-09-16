/**
 * #5812 final-review follow-up: every sheet-scoped DingTalk group destination route refuses a
 * soft-deleted / absent sheet AFTER the capability check (no liveness oracle), and fails CLOSED
 * when the liveness lookup itself errors.
 *
 * The destination service is mocked (it is the only path to the DingTalk sender), and global
 * fetch is stubbed as a tripwire so no test can ever reach a real robot webhook.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_dt_liveness'
const DESTINATION_ID = 'dt_liveness_1'

type Liveness = 'live' | 'deleted' | 'absent' | 'error'

const pinned = usePinnedServer()

function makeDestination(overrides: Record<string, unknown> = {}) {
  return {
    id: DESTINATION_ID,
    name: 'Ops',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=redacted',
    enabled: true,
    scope: 'sheet',
    sheetId: SHEET_ID,
    createdBy: 'user_1',
    createdAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  }
}

async function buildApp(options: {
  liveness: Liveness
  canManageAutomation?: boolean
  capabilityError?: Error
  livenessErrorCode?: unknown
}) {
  vi.resetModules()

  const service = {
    listDestinations: vi.fn(async () => [makeDestination()]),
    createDestination: vi.fn(async () => makeDestination()),
    updateDestination: vi.fn(async () => makeDestination()),
    deleteDestination: vi.fn(async () => undefined),
    getDestinationById: vi.fn(async () => makeDestination()),
    listDeliveries: vi.fn(async () => []),
    testSend: vi.fn(async () => ({ ok: true })),
  }
  const resolveSheetCapabilitiesForUser = vi.fn(async () => {
    if (options.capabilityError) throw options.capabilityError
    return {
    capabilities: { canManageAutomation: options.canManageAutomation ?? true },
    isAdminRole: false,
    permissions: [],
    }
  })
  const livenessCalls: string[] = []
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (/FROM meta_sheets/.test(sql)) {
      livenessCalls.push(String(params[0]))
      if (options.liveness === 'error') {
        const code = 'livenessErrorCode' in options ? options.livenessErrorCode : '57P01'
        throw Object.assign(new Error('connection terminated secret-host'), { code })
      }
      if (options.liveness === 'absent') return { rows: [], rowCount: 0 }
      return {
        rows: [{ deleted_at: options.liveness === 'deleted' ? new Date('2026-09-15T00:00:00Z') : null }],
        rowCount: 1,
      }
    }
    return { rows: [{ ok: 1 }], rowCount: 1 }
  })
  const authenticate = (req: any, _res: any, next: () => void) => {
    req.user = { id: 'user_1', roles: [], perms: ['workflow:write'] }
    next()
  }

  vi.doMock('../../src/middleware/auth', () => ({ authenticate, authMiddleware: authenticate, default: authenticate }))
  vi.doMock('../../src/db/db', () => ({ db: {} }))
  vi.doMock('../../src/db/pg', () => ({ query }))
  vi.doMock('../../src/multitable/sheet-capabilities', () => ({ resolveSheetCapabilitiesForUser }))
  vi.doMock('../../src/multitable/dingtalk-group-destination-service', () => ({
    DingTalkGroupDestinationService: vi.fn(() => service),
  }))

  const { apiTokensRouter } = await import('../../src/routes/api-tokens')
  // Same module instance the router just loaded (registry was reset above, not since).
  const { Logger } = await import('../../src/core/logger')
  const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  const app = express()
  app.use(express.json())
  app.use(apiTokensRouter())
  pinned.setApp(app)
  return { service, resolveSheetCapabilitiesForUser, livenessCalls, loggerError }
}

type Service = Awaited<ReturnType<typeof buildApp>>['service']

interface RouteCase {
  name: string
  kind: 'send' | 'write' | 'read'
  call: () => request.Test
  serviceMethod: keyof Service
}

const base = () => request(pinned.url())

const ROUTES: RouteCase[] = [
  {
    name: 'GET /dingtalk-groups (list)',
    kind: 'read',
    call: () => base().get('/api/multitable/dingtalk-groups').query({ sheetId: SHEET_ID }),
    serviceMethod: 'listDestinations',
  },
  {
    name: 'POST /dingtalk-groups (create)',
    kind: 'write',
    call: () => base().post('/api/multitable/dingtalk-groups').send({
      name: 'Ops',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=redacted',
      scope: 'sheet',
      sheetId: SHEET_ID,
    }),
    serviceMethod: 'createDestination',
  },
  {
    name: 'PATCH /dingtalk-groups/:id (update)',
    kind: 'write',
    call: () => base().patch(`/api/multitable/dingtalk-groups/${DESTINATION_ID}`).query({ sheetId: SHEET_ID }).send({ name: 'Renamed' }),
    serviceMethod: 'updateDestination',
  },
  {
    name: 'DELETE /dingtalk-groups/:id (delete)',
    kind: 'write',
    call: () => base().delete(`/api/multitable/dingtalk-groups/${DESTINATION_ID}`).query({ sheetId: SHEET_ID }),
    serviceMethod: 'deleteDestination',
  },
  {
    name: 'GET /dingtalk-groups/:id/deliveries',
    kind: 'read',
    call: () => base().get(`/api/multitable/dingtalk-groups/${DESTINATION_ID}/deliveries`).query({ sheetId: SHEET_ID }),
    serviceMethod: 'getDestinationById',
  },
  {
    name: 'POST /dingtalk-groups/:id/test-send',
    kind: 'send',
    call: () => base().post(`/api/multitable/dingtalk-groups/${DESTINATION_ID}/test-send`).query({ sheetId: SHEET_ID }).send({ subject: 'T', content: 'B' }),
    serviceMethod: 'testSend',
  },
]

function expectNoServiceCall(service: Service) {
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
}

describe('DingTalk group sheet-scoped routes refuse non-live sheets (capability first, fail closed)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => {
      throw new Error('real network call attempted in a unit test')
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe.each(ROUTES)('$name', (route) => {
    it('deleted sheet -> 404 SHEET_DELETED, service/sender never called', async () => {
      const { service, livenessCalls } = await buildApp({ liveness: 'deleted' })
      const res = await route.call()
      expect(res.status).toBe(404)
      expect(res.body.ok).toBe(false)
      expect(res.body.error.code).toBe('SHEET_DELETED')
      expect(JSON.stringify(res.body)).not.toContain(SHEET_ID)
      expect(livenessCalls).toEqual([SHEET_ID])
      expectNoServiceCall(service)
    })

    it('absent sheet -> 404 NOT_FOUND (Sheet not found), service never called', async () => {
      const { service } = await buildApp({ liveness: 'absent' })
      const res = await route.call()
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
      expectNoServiceCall(service)
    })

    it('live sheet -> reaches the service', async () => {
      const { service } = await buildApp({ liveness: 'live' })
      const res = await route.call()
      expect(res.status).toBeLessThan(300)
      expect(service[route.serviceMethod]).toHaveBeenCalledTimes(1)
    })

    it('capability denied -> identical 403 for live and deleted sheets (no liveness oracle)', async () => {
      const bodies: unknown[] = []
      for (const liveness of ['live', 'deleted', 'absent'] as const) {
        const { service, livenessCalls } = await buildApp({ liveness, canManageAutomation: false })
        const res = await route.call()
        expect(res.status).toBe(403)
        bodies.push(res.body)
        expect(livenessCalls).toEqual([])
        expectNoServiceCall(service)
      }
      expect(bodies[1]).toEqual(bodies[0])
      expect(bodies[2]).toEqual(bodies[0])
      expect(bodies[0]).toEqual({ ok: false, error: { code: 'FORBIDDEN' } })
    })

    it('liveness lookup failure -> refused (fail closed), values-free, service never called', async () => {
      const { service } = await buildApp({ liveness: 'error' })
      const res = await route.call()
      expect(res.status).toBe(500)
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'SHEET_STATE_CHECK_FAILED', message: 'Failed to resolve sheet state' },
      })
      expect(JSON.stringify(res.body)).not.toContain('secret-host')
      expectNoServiceCall(service)
    })

    it('capability lookup failure -> handled values-free 500 (no hang, no raw message), no liveness, service never called', async () => {
      const { service, livenessCalls, loggerError } = await buildApp({
        liveness: 'live',
        capabilityError: Object.assign(new Error('permission lookup exploded secret-host'), { code: '53300' }),
      })
      const res = await route.call().timeout(3000)
      expect(res.status).toBe(500)
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'SHEET_ACCESS_CHECK_FAILED', message: 'Failed to resolve sheet access' },
      })
      expect(livenessCalls).toEqual([])
      expectNoServiceCall(service)
      const logged = loggerError.mock.calls.map((call) => String(call[0])).join(' ')
      expect(logged).toContain('capability lookup failed (code=53300)')
      expect(logged).not.toContain('secret-host')
      expect(logged).not.toContain(SHEET_ID)
    })
  })

  describe('liveness failure log only carries an identifier-shaped code', () => {
    it.each([
      ['57P01', 'code=57P01'],
      ['ECONNREFUSED', 'code=ECONNREFUSED'],
      ['connect to secret-host:5432 failed', 'code=unknown'],
      ['57P01 secret-host', 'code=unknown'],
      [42, 'code=unknown'],
      [undefined, 'code=unknown'],
    ])('code %j -> %s', async (code, expected) => {
      const { loggerError } = await buildApp({ liveness: 'error', livenessErrorCode: code })
      const res = await base().get('/api/multitable/dingtalk-groups').query({ sheetId: SHEET_ID })
      expect(res.status).toBe(500)
      const logged = loggerError.mock.calls.map((call) => String(call[0]))
      expect(logged).toEqual([`DingTalk group sheet liveness lookup failed (${expected})`])
      expect(logged.join('')).not.toContain('secret-host')
      expect(logged.join('')).not.toContain(SHEET_ID)
    })
  })

  it('private / org destinations (no sheetId) do not consult sheet liveness', async () => {
    const { service, livenessCalls, resolveSheetCapabilitiesForUser } = await buildApp({ liveness: 'error' })
    const res = await base().get('/api/multitable/dingtalk-groups')
    expect(res.status).toBe(200)
    expect(service.listDestinations).toHaveBeenCalledWith('user_1', undefined, undefined)
    expect(livenessCalls).toEqual([])
    expect(resolveSheetCapabilitiesForUser).not.toHaveBeenCalled()
  })
})
