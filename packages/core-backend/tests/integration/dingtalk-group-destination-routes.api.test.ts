import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SHEET_ID = 'sheet_dingtalk_group_routes'
const DESTINATION_ID = 'dt_group_route_1'

function makeDestination(overrides: Record<string, unknown> = {}) {
  return {
    id: DESTINATION_ID,
    name: 'Ops DingTalk Group',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token&timestamp=123&sign=abc',
    secret: 'SECsecret',
    enabled: true,
    scope: 'sheet',
    sheetId: SHEET_ID,
    createdBy: 'user_1',
    createdAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  }
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dgd_route_1',
    destinationId: DESTINATION_ID,
    sourceType: 'manual_test',
    subject: 'MetaSheet DingTalk group test',
    content: 'This is a standard DingTalk group destination test message.',
    success: true,
    httpStatus: 200,
    responseBody: '{"errcode":0,"errmsg":"ok"}',
    createdAt: '2026-04-22T00:01:00.000Z',
    deliveredAt: '2026-04-22T00:01:01.000Z',
    ...overrides,
  }
}

async function createApp(options: {
  canManageAutomation?: boolean
  authUser?: Record<string, unknown>
  orgMember?: boolean
  serviceOverrides?: Record<string, ReturnType<typeof vi.fn>>
} = {}) {
  vi.resetModules()

  const service = {
    listDestinations: vi.fn(async () => [makeDestination()]),
    createDestination: vi.fn(async () => makeDestination()),
    updateDestination: vi.fn(async () => makeDestination({ name: 'Updated DingTalk Group' })),
    deleteDestination: vi.fn(async () => undefined),
    getDestinationById: vi.fn(async () => makeDestination()),
    listDeliveries: vi.fn(async () => [makeDelivery()]),
    testSend: vi.fn(async () => ({ ok: true })),
    ...options.serviceOverrides,
  }
  const resolveSheetCapabilitiesForUser = vi.fn(async () => ({
    capabilities: { canManageAutomation: options.canManageAutomation ?? true },
  }))
  const query = vi.fn(async () => ({
    rows: options.orgMember === false ? [] : [{ ok: 1 }],
    rowCount: options.orgMember === false ? 0 : 1,
  }))

  const authenticate = (req: any, _res: any, next: () => void) => {
    req.user = options.authUser ?? { id: 'user_1', roles: [], perms: ['workflow:write'] }
    next()
  }

  vi.doMock('../../src/middleware/auth', () => ({
    authenticate,
    authMiddleware: authenticate,
    default: authenticate,
  }))
  vi.doMock('../../src/db/db', () => ({ db: {} }))
  vi.doMock('../../src/db/pg', () => ({ query }))
  vi.doMock('../../src/multitable/sheet-capabilities', () => ({
    resolveSheetCapabilitiesForUser,
  }))
  vi.doMock('../../src/multitable/dingtalk-group-destination-service', () => ({
    DingTalkGroupDestinationService: vi.fn(() => service),
  }))

  const { apiTokensRouter } = await import('../../src/routes/api-tokens')

  const app = express()
  app.use(express.json())
  app.use(apiTokensRouter())

  return { app, query, resolveSheetCapabilitiesForUser, service }
}

describe('DingTalk group destination routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('rejects sheet-scoped list access without automation permission before calling the service', async () => {
    const { app, service, resolveSheetCapabilitiesForUser } = await createApp({ canManageAutomation: false })

    const response = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ sheetId: SHEET_ID })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(resolveSheetCapabilitiesForUser).toHaveBeenCalledWith(expect.any(Function), SHEET_ID, 'user_1')
    expect(service.listDestinations).not.toHaveBeenCalled()
  })

  it('creates a sheet-scoped destination and redacts webhook credentials and robot secret', async () => {
    const { app, service } = await createApp()

    const response = await request(app)
      .post('/api/multitable/dingtalk-groups')
      .send({
        name: 'Ops DingTalk Group',
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token',
        secret: 'SECsecret',
        sheetId: SHEET_ID,
      })
      .expect(201)

    expect(service.createDestination).toHaveBeenCalledWith('user_1', expect.objectContaining({
      name: 'Ops DingTalk Group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token',
      secret: 'SECsecret',
      sheetId: SHEET_ID,
    }))
    expect(response.body.ok).toBe(true)
    expect(response.body.data.webhookUrl).toContain('access_token=***')
    expect(response.body.data.webhookUrl).toContain('timestamp=***')
    expect(response.body.data.webhookUrl).toContain('sign=***')
    expect(response.body.data.webhookUrl).not.toContain('secret-token')
    expect(response.body.data.hasSecret).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(response.body.data, 'secret')).toBe(false)
  })

  it('creates an organization-scoped destination only for admins', async () => {
    const { app, service } = await createApp({
      authUser: { id: 'admin_1', roles: ['admin'], perms: ['workflow:write'] },
      serviceOverrides: {
        createDestination: vi.fn(async () => makeDestination({
          scope: 'org',
          sheetId: undefined,
          orgId: 'org_1',
          createdBy: 'admin_1',
        })),
      },
    })

    const response = await request(app)
      .post('/api/multitable/dingtalk-groups')
      .send({
        name: 'Org Ops DingTalk Group',
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token',
        scope: 'org',
        orgId: 'org_1',
      })
      .expect(201)

    expect(service.createDestination).toHaveBeenCalledWith('admin_1', expect.objectContaining({
      name: 'Org Ops DingTalk Group',
      scope: 'org',
      orgId: 'org_1',
    }))
    expect(response.body.data.scope).toBe('org')
    expect(response.body.data.orgId).toBe('org_1')
  })

  it('rejects organization-scoped destination creation for non-admins', async () => {
    const { app, service } = await createApp()

    await request(app)
      .post('/api/multitable/dingtalk-groups')
      .send({
        name: 'Org Ops DingTalk Group',
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token',
        scope: 'org',
        orgId: 'org_1',
      })
      .expect(403)

    expect(service.createDestination).not.toHaveBeenCalled()
  })

  it('lists an organization catalog with private destinations for active org members', async () => {
    const { app, service, query } = await createApp({
      serviceOverrides: {
        listDestinations: vi.fn(async () => [
          makeDestination({ id: 'dt_private', scope: 'private', sheetId: undefined }),
          makeDestination({ id: 'dt_org_1', scope: 'org', sheetId: undefined, orgId: 'org_1' }),
          makeDestination({ id: 'dt_org_2', scope: 'org', sheetId: undefined, orgId: 'org_2' }),
        ]),
      },
    })

    const response = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ orgId: 'org_1' })
      .expect(200)

    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true LIMIT 1',
      ['user_1', 'org_1'],
    )
    expect(service.listDestinations).toHaveBeenCalledWith('user_1', undefined, 'org_1')
    expect(response.body.data.destinations.map((item: { id: string }) => item.id)).toEqual(['dt_private', 'dt_org_1'])
  })

  it.each([
    ['PATCH', `/api/multitable/dingtalk-groups/${DESTINATION_ID}`, 'updateDestination'],
    ['DELETE', `/api/multitable/dingtalk-groups/${DESTINATION_ID}`, 'deleteDestination'],
    ['GET', `/api/multitable/dingtalk-groups/${DESTINATION_ID}/deliveries`, 'getDestinationById'],
    ['POST', `/api/multitable/dingtalk-groups/${DESTINATION_ID}/test-send`, 'testSend'],
  ])('rejects %s %s without automation permission before calling %s', async (method, path, serviceMethod) => {
    const { app, service } = await createApp({ canManageAutomation: false })

    const requestBuilder = request(app)[method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](path).query({ sheetId: SHEET_ID })
    if (method === 'PATCH') requestBuilder.send({ enabled: false })
    if (method === 'POST') requestBuilder.send({ subject: 'Test', content: 'Body' })

    const response = await requestBuilder.expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(service[serviceMethod as keyof typeof service]).not.toHaveBeenCalled()
  })

  it('lists delivery history for an authorized sheet-scoped destination', async () => {
    const { app, service } = await createApp()

    const response = await request(app)
      .get(`/api/multitable/dingtalk-groups/${DESTINATION_ID}/deliveries`)
      .query({ sheetId: SHEET_ID, limit: '999' })
      .expect(200)

    expect(service.getDestinationById).toHaveBeenCalledWith(DESTINATION_ID)
    expect(service.listDeliveries).toHaveBeenCalledWith(DESTINATION_ID, 200)
    expect(response.body).toEqual({
      ok: true,
      data: { deliveries: [makeDelivery()] },
    })
  })

  it('test-sends an authorized sheet-scoped destination', async () => {
    const { app, service } = await createApp()

    await request(app)
      .post(`/api/multitable/dingtalk-groups/${DESTINATION_ID}/test-send`)
      .query({ sheetId: SHEET_ID })
      .send({ subject: 'Route test', content: 'Body' })
      .expect(204)

    expect(service.testSend).toHaveBeenCalledWith(
      DESTINATION_ID,
      'user_1',
      { subject: 'Route test', content: 'Body' },
      SHEET_ID,
      undefined,
    )
  })

  it('lists delivery history for an organization destination shared with the caller org', async () => {
    const { app, service, query } = await createApp({
      serviceOverrides: {
        getDestinationById: vi.fn(async () => makeDestination({
          scope: 'org',
          sheetId: undefined,
          orgId: 'org_1',
        })),
      },
    })

    await request(app)
      .get(`/api/multitable/dingtalk-groups/${DESTINATION_ID}/deliveries`)
      .query({ limit: '20' })
      .expect(200)

    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true LIMIT 1',
      ['user_1', 'org_1'],
    )
    expect(service.listDeliveries).toHaveBeenCalledWith(DESTINATION_ID, 20)
  })
})
