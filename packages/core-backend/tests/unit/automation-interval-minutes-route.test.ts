/**
 * schedule.interval through the real POST /sheets/:sheetId/automations route: the editor's intervalMinutes
 * reaches createRule as the stored intervalMs, and a period that would never be armed is answered 400
 * VALIDATION_ERROR before createRule. The persistence + scheduler side is pinned in
 * automation-interval-minutes.test.ts; here the question is only what the route hands createRule.
 *
 * Real univer-meta router on a pinned per-suite server (#4154: never `request(app)`), mocked pool and a mocked
 * automation service.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_interval_save'
const AUTOMATIONS = `/api/multitable/sheets/${SHEET_ID}/automations`

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      const rows = params?.[0] === SHEET_ID ? [{ id: SHEET_ID, deleted_at: null }] : []
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

function createMockAutomationService() {
  return {
    createRule: vi.fn(async (sheetId: string, input: Record<string, unknown>) => ({
      id: 'rule_interval',
      sheet_id: sheetId,
      name: input.name ?? null,
      trigger_type: input.triggerType,
      trigger_config: input.triggerConfig,
      action_type: input.actionType,
      action_config: input.actionConfig,
      enabled: true,
      created_at: '2026-11-12T00:00:00.000Z',
      updated_at: '2026-11-12T00:00:00.000Z',
      created_by: 'admin_1',
      conditions: null,
      actions: input.actions ?? null,
      execution_mode: null,
    })),
    getRule: vi.fn(async () => null),
    updateRule: vi.fn(async () => null),
  }
}

const pinned = usePinnedServer()

async function mountApp() {
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
  const pool = createMockPool()
  const automationService = createMockAutomationService()
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as never)
  setAutomationServiceInstance(automationService as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'admin_1', role: 'admin', roles: ['admin'], perms: ['workflow:write', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
  return { automationService }
}

const action = { type: 'update_record', config: { fields: { fld_status: 'x' } } }
const body = (triggerType: string, triggerConfig: Record<string, unknown>) => ({
  name: 'Interval rule',
  triggerType,
  triggerConfig,
  trigger: { type: triggerType, config: triggerConfig },
  actions: [action],
  actionType: action.type,
  actionConfig: action.config,
})

describe('POST automations — schedule.interval period at save', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('an editor payload with intervalMinutes reaches createRule as intervalMs only', async () => {
    const { automationService } = await mountApp()
    const res = await request(pinned.url()).post(AUTOMATIONS).send(body('schedule.interval', { intervalMinutes: 5 }))
    expect(res.status).toBe(200)
    expect(automationService.createRule).toHaveBeenCalledTimes(1)
    expect(automationService.createRule.mock.calls[0][1].triggerConfig).toEqual({ intervalMs: 300_000 })
    expect(res.body.data.rule.triggerConfig).toEqual({ intervalMs: 300_000 })
  })

  it('an API payload with intervalMs reaches createRule unchanged; both present — minutes win', async () => {
    const { automationService } = await mountApp()
    const api = await request(pinned.url()).post(AUTOMATIONS).send(body('schedule.interval', { intervalMs: 90_000 }))
    expect(api.status).toBe(200)
    expect(automationService.createRule.mock.calls[0][1].triggerConfig).toEqual({ intervalMs: 90_000 })

    const both = await request(pinned.url()).post(AUTOMATIONS)
      .send(body('schedule.interval', { intervalMs: 3_600_000, intervalMinutes: 2 }))
    expect(both.status).toBe(200)
    expect(automationService.createRule.mock.calls[1][1].triggerConfig).toEqual({ intervalMs: 120_000 })
  })

  const refused: Array<[string, Record<string, unknown>]> = [
    ['no period', {}],
    ['intervalMinutes 0', { intervalMinutes: 0 }],
    ['a cleared minutes input', { intervalMinutes: '' }],
    ['intervalMs below the 1000 ms floor', { intervalMs: 500 }],
  ]
  for (const [label, triggerConfig] of refused) {
    it(`refuses ${label} with 400 VALIDATION_ERROR before createRule`, async () => {
      const { automationService } = await mountApp()
      const res = await request(pinned.url()).post(AUTOMATIONS).send(body('schedule.interval', triggerConfig))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.message).toMatch(/schedule\.interval/)
      expect(automationService.createRule).not.toHaveBeenCalled()
    })
  }

  it('a cron payload reaches createRule as sent (the interval normaliser does not touch it)', async () => {
    const { automationService } = await mountApp()
    const cron = { cron: '*/5 * * * *', intervalMinutes: 5 }
    const res = await request(pinned.url()).post(AUTOMATIONS).send(body('schedule.cron', cron))
    expect(res.status).toBe(200)
    expect(automationService.createRule.mock.calls[0][1].triggerConfig).toEqual(cron)
  })
})
