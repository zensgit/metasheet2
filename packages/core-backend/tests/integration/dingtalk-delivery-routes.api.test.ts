import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

type QueryResult = {
  rows: Record<string, unknown>[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const SHEET_ID = 'sheet_dingtalk_delivery_routes'
const OTHER_SHEET_ID = 'sheet_other'
const RULE_ID = 'rule_dingtalk_delivery_routes'

function createMockPool(queryHandler: QueryHandler = () => ({ rows: [], rowCount: 0 })) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

function makeAutomationRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: 'DingTalk delivery route',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'send_dingtalk_group_message',
    action_config: {},
    enabled: true,
    created_at: '2026-04-21T00:00:00.000Z',
    updated_at: '2026-04-21T00:00:00.000Z',
    created_by: 'admin_1',
    conditions: null,
    actions: null,
    ...overrides,
  }
}

function createMockAutomationService(existingRule: ReturnType<typeof makeAutomationRule> | null = makeAutomationRule()) {
  return {
    getRule: vi.fn(async (ruleId: string) => {
      if (!existingRule || ruleId !== existingRule.id) return null
      return existingRule
    }),
  }
}

async function createApp(options: {
  automationRule?: ReturnType<typeof makeAutomationRule> | null
  groupDeliveries?: Array<Record<string, unknown>>
  personDeliveries?: Array<Record<string, unknown>>
  perms?: string[]
  role?: string
} = {}) {
  vi.resetModules()

  const groupDeliveries = options.groupDeliveries ?? []
  const personDeliveries = options.personDeliveries ?? []
  const listGroupDeliveries = vi.fn(async () => groupDeliveries)
  const listPersonDeliveries = vi.fn(async () => personDeliveries)

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  vi.doMock('../../src/multitable/dingtalk-group-delivery-service', () => ({
    listAutomationDingTalkGroupDeliveries: listGroupDeliveries,
  }))
  vi.doMock('../../src/multitable/dingtalk-person-delivery-service', () => ({
    listAutomationDingTalkPersonDeliveries: listPersonDeliveries,
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { setAutomationServiceInstance } = await import('../../src/multitable/automation-service')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')

  const mockPool = createMockPool()
  const automationService = createMockAutomationService(
    options.automationRule === undefined ? makeAutomationRule() : options.automationRule,
  )
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as ReturnType<typeof poolManager.get>)
  setAutomationServiceInstance(automationService as Parameters<typeof setAutomationServiceInstance>[0])

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'admin_1',
      role: options.role,
      roles: options.role === 'admin' ? ['admin'] : [],
      perms: options.perms ?? ['workflow:write', 'multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return {
    app,
    automationService,
    listGroupDeliveries,
    listPersonDeliveries,
    mockPool,
  }
}

describe('DingTalk automation delivery routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('lists person delivery history and clamps limit=0 to one', async () => {
    const personDeliveries = [{ id: 'person_delivery_1', success: true }]
    const { app, listPersonDeliveries } = await createApp({ personDeliveries })

    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}/dingtalk-person-deliveries`)
      .query({ limit: '0' })
      .expect(200)

    expect(response.body).toEqual({
      ok: true,
      data: { deliveries: personDeliveries },
    })
    expect(listPersonDeliveries).toHaveBeenCalledWith(expect.any(Function), RULE_ID, 1)
  })

  it('lists group delivery history and clamps large limits to 200', async () => {
    const groupDeliveries = [{ id: 'group_delivery_1', success: true }]
    const { app, listGroupDeliveries } = await createApp({ groupDeliveries })

    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}/dingtalk-group-deliveries`)
      .query({ limit: '999' })
      .expect(200)

    expect(response.body).toEqual({
      ok: true,
      data: { deliveries: groupDeliveries },
    })
    expect(listGroupDeliveries).toHaveBeenCalledWith(expect.any(Function), RULE_ID, 200)
  })

  it('rejects delivery history reads when the user cannot manage automations', async () => {
    const { app, automationService, listPersonDeliveries } = await createApp({
      perms: ['multitable:read'],
    })

    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}/dingtalk-person-deliveries`)
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Insufficient permissions',
      },
    })
    expect(automationService.getRule).not.toHaveBeenCalled()
    expect(listPersonDeliveries).not.toHaveBeenCalled()
  })

  it('returns 404 when the automation rule does not belong to the sheet', async () => {
    const { app, listGroupDeliveries } = await createApp({
      automationRule: makeAutomationRule({ sheet_id: OTHER_SHEET_ID }),
    })

    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}/dingtalk-group-deliveries`)
      .expect(404)

    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Automation rule not found',
      },
    })
    expect(listGroupDeliveries).not.toHaveBeenCalled()
  })
})
