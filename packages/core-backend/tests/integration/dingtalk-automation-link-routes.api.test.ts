import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const SHEET_ID = 'sheet_dingtalk_links'
const OTHER_SHEET_ID = 'sheet_other'
const VALID_FORM_VIEW_ID = 'view_form_valid'
const DISABLED_FORM_VIEW_ID = 'view_form_disabled'
const EXPIRED_FORM_VIEW_ID = 'view_form_expired'
const OTHER_SHEET_FORM_VIEW_ID = 'view_form_other_sheet'
const INTERNAL_VIEW_ID = 'view_internal_grid'
const MISSING_INTERNAL_VIEW_ID = 'view_internal_missing'
const RULE_ID = 'rule_dingtalk_links'

type ViewRow = {
  id: string
  sheet_id: string
  type: string
  config: Record<string, unknown> | string
}

function makePublicFormConfig(options: {
  enabled?: boolean
  token?: string
  expiresAt?: number
  accessMode?: string
} = {}): Record<string, unknown> {
  return {
    publicForm: {
      enabled: options.enabled ?? true,
      publicToken: options.token ?? 'pub_valid_token',
      accessMode: options.accessMode ?? 'public',
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    },
  }
}

function makeViewRows(nowMs = Date.now()): ViewRow[] {
  return [
    {
      id: VALID_FORM_VIEW_ID,
      sheet_id: SHEET_ID,
      type: 'form',
      config: makePublicFormConfig(),
    },
    {
      id: DISABLED_FORM_VIEW_ID,
      sheet_id: SHEET_ID,
      type: 'form',
      config: makePublicFormConfig({ enabled: false }),
    },
    {
      id: EXPIRED_FORM_VIEW_ID,
      sheet_id: SHEET_ID,
      type: 'form',
      config: makePublicFormConfig({ expiresAt: nowMs - 1_000 }),
    },
    {
      id: OTHER_SHEET_FORM_VIEW_ID,
      sheet_id: OTHER_SHEET_ID,
      type: 'form',
      config: makePublicFormConfig(),
    },
    {
      id: INTERNAL_VIEW_ID,
      sheet_id: SHEET_ID,
      type: 'grid',
      config: {},
    },
  ]
}

function createDingTalkLinkQueryHandler(views = makeViewRows()): QueryHandler {
  return (sql, params) => {
    if (sql.includes('FROM meta_views') && sql.includes('id::text = ANY')) {
      const sheetId = typeof params?.[0] === 'string' ? params[0] : ''
      const ids = Array.isArray(params?.[1]) ? params[1].map(String) : []
      const rows = views
        .filter((view) => view.sheet_id === sheetId && ids.includes(view.id))
        .map((view) => ({
          id: view.id,
          type: view.type,
          config: view.config,
        }))
      return { rows, rowCount: rows.length }
    }

    return { rows: [], rowCount: 0 }
  }
}

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
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
    name: 'DingTalk rule',
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

function createMockAutomationService(existingRule = makeAutomationRule()) {
  return {
    createRule: vi.fn(async (sheetId: string, input: Record<string, unknown>) => makeAutomationRule({
      sheet_id: sheetId,
      name: input.name ?? null,
      trigger_type: input.triggerType,
      trigger_config: input.triggerConfig,
      action_type: input.actionType,
      action_config: input.actionConfig,
      enabled: input.enabled,
      created_by: input.createdBy,
      conditions: input.conditions,
      actions: input.actions,
    })),
    getRule: vi.fn(async (ruleId: string) => ruleId === RULE_ID ? existingRule : null),
    updateRule: vi.fn(async (ruleId: string, sheetId: string, input: Record<string, unknown>) => makeAutomationRule({
      id: ruleId,
      sheet_id: sheetId,
      action_type: input.actionType ?? existingRule.action_type,
      action_config: input.actionConfig ?? existingRule.action_config,
      actions: input.actions ?? existingRule.actions,
      enabled: input.enabled ?? existingRule.enabled,
    })),
  }
}

async function createApp(options: {
  queryHandler?: QueryHandler
  automationService?: ReturnType<typeof createMockAutomationService>
} = {}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(true),
    userHasPermission: vi.fn().mockResolvedValue(true),
    listUserPermissions: vi.fn().mockResolvedValue(['workflow:write', 'multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { setAutomationServiceInstance } = await import('../../src/multitable/automation-service')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')

  const mockPool = createMockPool(options.queryHandler ?? createDingTalkLinkQueryHandler())
  const automationService = options.automationService ?? createMockAutomationService()
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)
  setAutomationServiceInstance(automationService as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'admin_1',
      role: 'admin',
      roles: ['admin'],
      perms: ['workflow:write', 'multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool, automationService, setAutomationServiceInstance }
}

describe('DingTalk automation link route validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('rejects a cross-sheet public form link on automation create before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify group',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'group_1',
          title: 'Please fill',
          content: 'Open form',
          publicFormViewId: OTHER_SHEET_FORM_VIEW_ID,
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Public form view not found: ${OTHER_SHEET_FORM_VIEW_ID}`,
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('persists a DingTalk group rule when public form and internal links are valid', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify group',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'group_1',
          title: 'Please fill',
          content: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        },
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.createRule).toHaveBeenCalledWith(SHEET_ID, expect.objectContaining({
      actionType: 'send_dingtalk_group_message',
      actionConfig: expect.objectContaining({
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: VALID_FORM_VIEW_ID,
        internalViewId: INTERNAL_VIEW_ID,
      }),
    }))
  })

  it('persists a DingTalk person rule when public form and internal links are valid', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify person',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: ['user_1'],
          title: 'Please fill',
          content: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        },
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.createRule).toHaveBeenCalledWith(SHEET_ID, expect.objectContaining({
      actionType: 'send_dingtalk_person_message',
      actionConfig: expect.objectContaining({
        userIds: ['user_1'],
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: VALID_FORM_VIEW_ID,
        internalViewId: INTERNAL_VIEW_ID,
      }),
    }))
    expect(res.body.data.rule).toMatchObject({
      actionType: 'send_dingtalk_person_message',
      actionConfig: expect.objectContaining({
        userIds: ['user_1'],
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: VALID_FORM_VIEW_ID,
        internalViewId: INTERNAL_VIEW_ID,
      }),
    })
  })

  it('rejects a DingTalk person rule without an effective recipient before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify person',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: [],
          memberGroupIds: [','],
          userIdFieldPath: 'record.',
          title: 'Please fill',
          content: 'Open form',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a DingTalk person rule without executable templates before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify person',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: ['user_1'],
          titleTemplate: ' ',
          bodyTemplate: 'Open form',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk titleTemplate is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('returns a canonical camelCase automation rule response with V1 DingTalk actions', async () => {
    const { app } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Advanced group rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'group_1',
          title: 'Please fill',
          content: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        },
        conditions: { conjunction: 'AND', conditions: [] },
        actions: [{
          type: 'send_dingtalk_group_message',
          config: {
            destinationIds: ['group_1'],
            title: 'Please fill',
            content: 'Open form',
            publicFormViewId: VALID_FORM_VIEW_ID,
            internalViewId: INTERNAL_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(200)
    expect(res.body.data.rule).toMatchObject({
      id: RULE_ID,
      sheetId: SHEET_ID,
      name: 'Advanced group rule',
      triggerType: 'record.created',
      triggerConfig: {},
      trigger: {
        type: 'record.created',
        config: {},
      },
      conditions: { conjunction: 'AND', conditions: [] },
      actionType: 'send_dingtalk_group_message',
      actionConfig: expect.objectContaining({
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: VALID_FORM_VIEW_ID,
        internalViewId: INTERNAL_VIEW_ID,
      }),
      enabled: true,
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
      createdBy: 'admin_1',
    })
    expect(res.body.data.rule.actions).toEqual([
      expect.objectContaining({
        type: 'send_dingtalk_group_message',
        config: expect.objectContaining({
          destinationIds: ['group_1'],
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        }),
      }),
    ])
    expect(res.body.data.rule).not.toHaveProperty('sheet_id')
    expect(res.body.data.rule).not.toHaveProperty('action_type')
  })

  it('persists a V1 DingTalk person action when public form and internal links are valid', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Advanced person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        conditions: { conjunction: 'AND', conditions: [] },
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            title: 'Please fill',
            content: 'Open form',
            publicFormViewId: VALID_FORM_VIEW_ID,
            internalViewId: INTERNAL_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.createRule).toHaveBeenCalledWith(SHEET_ID, expect.objectContaining({
      actionType: 'notify',
      actions: [
        expect.objectContaining({
          type: 'send_dingtalk_person_message',
          config: expect.objectContaining({
            userIds: ['user_1'],
            titleTemplate: 'Please fill',
            bodyTemplate: 'Open form',
            publicFormViewId: VALID_FORM_VIEW_ID,
            internalViewId: INTERNAL_VIEW_ID,
          }),
        }),
      ],
    }))
    expect(res.body.data.rule).toMatchObject({
      actionType: 'notify',
      conditions: { conjunction: 'AND', conditions: [] },
    })
    expect(res.body.data.rule.actions).toEqual([
      expect.objectContaining({
        type: 'send_dingtalk_person_message',
        config: expect.objectContaining({
          userIds: ['user_1'],
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        }),
      }),
    ])
  })

  it('rejects an invalid public form link in a V1 DingTalk person action before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Advanced person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            title: 'Please fill',
            content: 'Open form',
            publicFormViewId: DISABLED_FORM_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Selected public form view is not shared: ${DISABLED_FORM_VIEW_ID}`,
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects an invalid internal link in a V1 DingTalk person action before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Advanced person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            title: 'Please process',
            content: 'Open internal link',
            internalViewId: MISSING_INTERNAL_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Internal processing view not found: ${MISSING_INTERNAL_VIEW_ID}`,
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a DingTalk group rule without an effective destination before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify group',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationIds: [],
          destinationIdFieldPath: 'record., ,',
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one DingTalk destination or record destination field path is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects an invalid internal processing link on automation create before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Notify group',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'group_1',
          title: 'Please process',
          content: 'Open internal link',
          internalViewId: MISSING_INTERNAL_VIEW_ID,
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Internal processing view not found: ${MISSING_INTERNAL_VIEW_ID}`,
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action without an effective recipient before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Multi action person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [
          {
            type: 'send_dingtalk_person_message',
            config: {
              userIds: [],
              memberGroupIds: [','],
              userIdFieldPath: 'record.',
              titleTemplate: 'Please fill',
              bodyTemplate: 'Open form',
            },
          },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action with a non-object config before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Multi action person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [
          {
            type: 'send_dingtalk_person_message',
            config: null,
          },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk action config must be an object',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action without executable templates before persisting the rule', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Multi action person rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [
          {
            type: 'send_dingtalk_person_message',
            config: {
              userIds: ['user_1'],
              titleTemplate: ' ',
              bodyTemplate: 'Open form',
            },
          },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk titleTemplate is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk group action without an effective destination before persisting the rule', async () => {
    const { app, mockPool, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Multi action group rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [
          {
            type: 'send_dingtalk_group_message',
            config: {
              destinationIds: [],
              destinationIdFieldPath: 'record., ,',
              title: 'Please fill',
              content: 'Open form',
              publicFormViewId: VALID_FORM_VIEW_ID,
            },
          },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one DingTalk destination or record destination field path is required',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_views'))).toBe(false)
  })

  it('validates V1 actions on automation create', async () => {
    const { app, automationService } = await createApp()

    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/automations`)
      .send({
        name: 'Multi action rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'notify',
        actionConfig: {},
        actions: [
          {
            type: 'send_dingtalk_group_message',
            config: {
              destinationId: 'group_1',
              title: 'Please fill',
              content: 'Open form',
              publicFormViewId: DISABLED_FORM_VIEW_ID,
            },
          },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Selected public form view is not shared: ${DISABLED_FORM_VIEW_ID}`,
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('validates the merged DingTalk link state on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'send_dingtalk_person_message',
      action_config: {
        userIds: ['user_1'],
        title: 'Old title',
        content: 'Old content',
        publicFormViewId: VALID_FORM_VIEW_ID,
      },
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actionConfig: {
          userIds: ['user_1'],
          title: 'New title',
          content: 'New content',
          publicFormViewId: EXPIRED_FORM_VIEW_ID,
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Selected public form view has expired: ${EXPIRED_FORM_VIEW_ID}`,
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('normalizes legacy DingTalk group actionConfig templates on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'send_dingtalk_group_message',
      action_config: {
        destinationId: 'group_1',
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))
    const { app, mockPool } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actionConfig: {
          destinationId: 'group_1',
          title: 'Please fill',
          content: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        },
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).toHaveBeenCalledWith(RULE_ID, SHEET_ID, expect.objectContaining({
      actionConfig: expect.objectContaining({
        destinationId: 'group_1',
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: VALID_FORM_VIEW_ID,
        internalViewId: INTERNAL_VIEW_ID,
      }),
    }))
    expect(res.body.data.rule.actionConfig).toEqual(expect.objectContaining({
      titleTemplate: 'Please fill',
      bodyTemplate: 'Open form',
      publicFormViewId: VALID_FORM_VIEW_ID,
      internalViewId: INTERNAL_VIEW_ID,
    }))
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_views'))).toBe(true)
  })

  it('rejects an invalid public form link in a V1 DingTalk person action on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
          publicFormViewId: VALID_FORM_VIEW_ID,
        },
      }],
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            title: 'Please fill',
            content: 'Open form',
            publicFormViewId: DISABLED_FORM_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Selected public form view is not shared: ${DISABLED_FORM_VIEW_ID}`,
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects an invalid internal link in a V1 DingTalk person action on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
          internalViewId: INTERNAL_VIEW_ID,
        },
      }],
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            title: 'Please process',
            content: 'Open internal link',
            internalViewId: MISSING_INTERNAL_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Internal processing view not found: ${MISSING_INTERNAL_VIEW_ID}`,
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action without an effective recipient on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
        },
      }],
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: [],
            memberGroupIds: [','],
            userIdFieldPath: 'record.',
            title: 'Please fill',
            content: 'Open form',
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action with a non-object config on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
        },
      }],
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_person_message',
          config: null,
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk action config must be an object',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk person action without executable templates on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
        },
      }],
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: ['user_1'],
            titleTemplate: ' ',
            bodyTemplate: 'Open form',
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk titleTemplate is required',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('validates merged DingTalk action config on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'send_dingtalk_person_message',
      action_config: {
        userIds: ['user_1'],
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actionConfig: {
          userIds: [],
          memberGroupIds: [],
          userIdFieldPath: 'record.',
          titleTemplate: 'New title',
          bodyTemplate: 'New body',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required',
    })
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects a DingTalk group action without an effective destination on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'send_dingtalk_group_message',
      action_config: {
        destinationId: 'group_1',
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actionConfig: {
          destinationIds: [],
          destinationIdFieldPath: 'record., ,',
          titleTemplate: 'New title',
          bodyTemplate: 'New body',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one DingTalk destination or record destination field path is required',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('rejects a V1 DingTalk group action without an effective destination on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'group_1',
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
        },
      }],
    }))
    const { app, mockPool } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_group_message',
          config: {
            destinationIds: [],
            destinationIdFieldPath: 'record., ,',
            title: 'Please fill',
            content: 'Open form',
          },
        }],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'At least one DingTalk destination or record destination field path is required',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_views'))).toBe(false)
  })

  it('normalizes V1 DingTalk group action templates on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'notify',
      action_config: {},
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'group_1',
          titleTemplate: 'Old title',
          bodyTemplate: 'Old body',
        },
      }],
    }))
    const { app, mockPool } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actions: [{
          type: 'send_dingtalk_group_message',
          config: {
            destinationId: 'group_1',
            title: 'Please fill',
            content: 'Open form',
            publicFormViewId: VALID_FORM_VIEW_ID,
            internalViewId: INTERNAL_VIEW_ID,
          },
        }],
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).toHaveBeenCalledWith(RULE_ID, SHEET_ID, expect.objectContaining({
      actions: expect.arrayContaining([
        expect.objectContaining({
          type: 'send_dingtalk_group_message',
          config: expect.objectContaining({
            destinationId: 'group_1',
            titleTemplate: 'Please fill',
            bodyTemplate: 'Open form',
            publicFormViewId: VALID_FORM_VIEW_ID,
            internalViewId: INTERNAL_VIEW_ID,
          }),
        }),
      ]),
    }))
    expect(res.body.data.rule.actions).toEqual([
      expect.objectContaining({
        type: 'send_dingtalk_group_message',
        config: expect.objectContaining({
          titleTemplate: 'Please fill',
          bodyTemplate: 'Open form',
          publicFormViewId: VALID_FORM_VIEW_ID,
          internalViewId: INTERNAL_VIEW_ID,
        }),
      }),
    ])
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_views'))).toBe(true)
  })

  it('rejects a DingTalk person action without executable templates on automation update', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_type: 'send_dingtalk_person_message',
      action_config: {
        userIds: ['user_1'],
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))
    const { app } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({
        actionConfig: {
          userIds: ['user_1'],
          titleTemplate: ' ',
          bodyTemplate: 'New body',
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'DingTalk titleTemplate is required',
    })
    expect(automationService.getRule).toHaveBeenCalledWith(RULE_ID)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('does not revalidate DingTalk links for enable-only updates', async () => {
    const automationService = createMockAutomationService(makeAutomationRule({
      action_config: {
        publicFormViewId: EXPIRED_FORM_VIEW_ID,
      },
    }))
    const { app, mockPool } = await createApp({ automationService })

    const res = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/automations/${RULE_ID}`)
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.getRule).not.toHaveBeenCalled()
    expect(automationService.updateRule).toHaveBeenCalledWith(RULE_ID, SHEET_ID, expect.objectContaining({
      enabled: false,
    }))
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('FROM meta_views'))).toBe(false)
  })
})
