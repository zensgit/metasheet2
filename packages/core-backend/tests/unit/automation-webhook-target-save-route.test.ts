/**
 * S0-a (2026-11-03) — EARLY errors for a `send_webhook` target at rule SAVE time.
 *
 * The boundary is the check at the real send (`automation-executor.ts` executeSendWebhook, every attempt,
 * pinned). These route checks only make an unusable target fail when the author saves it instead of on every
 * run: https only, no internal name, no internal IP literal. They do NOT resolve DNS (a save must not depend
 * on the resolver; a public name that resolves internally is still refused at the send).
 *
 * Goes through the real univer-meta router (pinned per-suite server, #4154: never `request(app)`) with a mocked
 * pool and a mocked automation service — the question is only whether createRule / updateRule was reached.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_wh_save'
const RULE_ID = 'rule_wh_save'
const AUTOMATIONS = `/api/multitable/sheets/${SHEET_ID}/automations`
const CODE = 'WEBHOOK_TARGET_REJECTED'
const GOOD_URL = 'https://hooks.example.test/in'

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

function storedRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: 'Webhook rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'send_webhook',
    action_config: { url: GOOD_URL },
    enabled: true,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    created_by: 'admin_1',
    conditions: null,
    actions: null,
    execution_mode: null,
    ...overrides,
  }
}

function createMockAutomationService(existing = storedRule()) {
  return {
    createRule: vi.fn(async (sheetId: string, input: Record<string, unknown>) => storedRule({
      sheet_id: sheetId,
      action_type: input.actionType,
      action_config: input.actionConfig,
      actions: input.actions,
    })),
    getRule: vi.fn(async (ruleId: string) => (ruleId === RULE_ID ? existing : null)),
    updateRule: vi.fn(async (ruleId: string, sheetId: string, input: Record<string, unknown>) => storedRule({
      id: ruleId,
      sheet_id: sheetId,
      action_type: input.actionType ?? existing.action_type,
      action_config: input.actionConfig ?? existing.action_config,
      actions: input.actions ?? existing.actions,
    })),
  }
}

const pinned = usePinnedServer()

async function mountApp(existing = storedRule()) {
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
  const automationService = createMockAutomationService(existing)
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

const webhook = (url: unknown) => ({ type: 'send_webhook', config: { url } })
const createBody = (actions: unknown[]) => ({
  name: 'Webhook rule',
  triggerType: 'record.created',
  triggerConfig: {},
  actions,
})

describe('send_webhook target — save-time early error', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const refused: Array<[string, string, string]> = [
    ['http scheme', 'http://hooks.example.test/in', 'scheme-not-allowed'],
    ['loopback literal', 'https://127.0.0.1/in', 'loopback'],
    ['private literal', 'https://10.0.0.8/in', 'private'],
    ['link-local literal', 'https://169.254.169.254/latest', 'link-local'],
    ['internal name', 'https://localhost/in', 'loopback'],
    ['malformed', 'not a url', 'invalid-url'],
  ]
  for (const [label, url, refusalClass] of refused) {
    it(`POST refuses ${label} with 400 before createRule, and the message does not quote the URL`, async () => {
      const { automationService } = await mountApp()
      const res = await request(pinned.url()).post(AUTOMATIONS).send(createBody([webhook(url)]))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(CODE)
      expect(res.body.error.message).toContain(refusalClass)
      expect(res.body.error.message).toContain('actions[0].config.url')
      expect(res.body.error.message).not.toContain(url)
      expect(automationService.createRule).not.toHaveBeenCalled()
    })
  }

  it('POST accepts a public https target (no DNS at save time)', async () => {
    const { automationService } = await mountApp()
    const res = await request(pinned.url()).post(AUTOMATIONS).send(createBody([webhook(GOOD_URL)]))
    expect(res.status).toBe(200)
    expect(automationService.createRule).toHaveBeenCalledTimes(1)
  })

  it('POST reaches a send_webhook nested in a condition_branch branch', async () => {
    const { automationService } = await mountApp()
    const res = await request(pinned.url()).post(AUTOMATIONS).send({
      ...createBody([{
        type: 'condition_branch',
        config: {
          branches: [{ key: 'hit', conditions: { conjunction: 'AND', conditions: [] }, actions: [webhook('http://hooks.example.test/x')] }],
          defaultBranch: { key: 'fallback', actions: [] },
        },
      }]),
      executionMode: 'workflow_job_v1',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(CODE)
    expect(res.body.error.message).toContain('actions[0].config.branches[0].actions[0].config.url')
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('POST with the legacy actionType/actionConfig pair is checked too', async () => {
    const { automationService } = await mountApp()
    const res = await request(pinned.url()).post(AUTOMATIONS).send({
      name: 'Legacy webhook',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_webhook',
      actionConfig: { url: 'https://192.168.1.1/x' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(CODE)
    expect(automationService.createRule).not.toHaveBeenCalled()
  })

  it('PATCH refuses a new internal target in actions, before updateRule; a public one saves', async () => {
    const { automationService } = await mountApp()
    const bad = await request(pinned.url()).patch(`${AUTOMATIONS}/${RULE_ID}`).send({ actions: [webhook('https://127.0.0.1/in')] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe(CODE)
    expect(automationService.updateRule).not.toHaveBeenCalled()

    const ok = await request(pinned.url()).patch(`${AUTOMATIONS}/${RULE_ID}`).send({ actions: [webhook(GOOD_URL)] })
    expect(ok.status).toBe(200)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
  })

  it('PATCH that only re-types a rule to send_webhook checks the STORED config it would run', async () => {
    const { automationService } = await mountApp(storedRule({
      action_type: 'update_record',
      action_config: { url: 'http://hooks.example.test/legacy', fields: {} },
    }))
    const res = await request(pinned.url()).patch(`${AUTOMATIONS}/${RULE_ID}`).send({ actionType: 'send_webhook' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(CODE)
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('PATCH that does not touch the action tree (rename) is not blocked by a stored legacy target', async () => {
    const { automationService } = await mountApp(storedRule({ action_config: { url: 'http://hooks.example.test/old' } }))
    const res = await request(pinned.url()).patch(`${AUTOMATIONS}/${RULE_ID}`).send({ name: 'renamed' })
    expect(res.status).toBe(200)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
  })
})
