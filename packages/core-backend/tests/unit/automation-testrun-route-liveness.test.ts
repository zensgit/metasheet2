/**
 * #5803 follow-up — POST /api/multitable/sheets/:sheetId/automations/:ruleId/test
 *
 *   1. capability → liveness, in that order: a soft-deleted (or absent) sheet refuses BOTH modes
 *      with the shared sheet-refusals body, before the sample-record read and before testRun; an
 *      unauthorized caller gets the same 403 whether the sheet is live or deleted (no oracle).
 *   2. failures are values-free: the service's TYPED rejections (rule gate 404
 *      TEST_RUN_RULE_NOT_FOUND, service-side 404 SHEET_DELETED) pass through with their fixed
 *      message; anything else — including a plain Error that reads like the rule gate — is a fixed
 *      503/500, and the thrown text never reaches the client.
 *   3. #5812 follow-up, through the REAL service: a missing / other-sheet / disabled rule answers one
 *      identical 404, and a sheet deleted after the route's liveness check is refused by the service
 *      with the route's own SHEET_DELETED body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import {
  AutomationService,
  AutomationTestRunRejectedError,
  TEST_RUN_RULE_NOT_FOUND_CODE,
  TEST_RUN_RULE_NOT_FOUND_MESSAGE,
} from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'
import { usePinnedServer } from '../utils/pinned-server'

const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
const requireRecordReadable = vi.hoisted(() => vi.fn())
const poolQuery = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
vi.mock('../../src/routes/univer-meta', () => ({ requireRecordReadable }))
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: poolQuery, getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => { req.user = { id: 'u1' }; next() })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/multitable', createAutomationRoutes(service as any))
  return app
}

function makeService() {
  return {
    testRun: vi.fn().mockResolvedValue({ id: 'axe_test', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'success', steps: [] }),
  }
}

const URL_PATH = '/api/multitable/sheets/sheet-a/automations/rule-1/test'
const SIMULATE = {}
const REAL_FIRE = { mode: 'real_fire', confirmSideEffects: true, testRunOperationId: 'click_1', recordId: 'rec-1' }

function allowSampleRecord() {
  requireRecordReadable.mockResolvedValue({
    access: { userId: 'server_actor' },
    capabilities: { canRead: true },
    capabilityOrigin: 'role',
  })
  poolQuery.mockResolvedValue({ rows: [{ data: {} }], rowCount: 1 })
}

const pinned = usePinnedServer()

describe('#5803 follow-up — test-run route sheet liveness', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    requireRecordReadable.mockReset()
    poolQuery.mockReset()
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  for (const [label, body] of [['simulate', SIMULATE], ['real_fire', REAL_FIRE]] as const) {
    it(`refuses a soft-deleted sheet for ${label} with SHEET_DELETED and never runs testRun`, async () => {
      resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'deleted' })
      allowSampleRecord()
      const svc = makeService()
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
      expect(svc.testRun).not.toHaveBeenCalled()
      // Refused BEFORE the sample-record read, not merely by it.
      expect(requireRecordReadable).not.toHaveBeenCalled()
      expect(poolQuery).not.toHaveBeenCalled()
      expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
    })

    it(`refuses an absent sheet for ${label} with NOT_FOUND and never runs testRun`, async () => {
      resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'absent' })
      allowSampleRecord()
      const svc = makeService()
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
      expect(svc.testRun).not.toHaveBeenCalled()
    })

    it(`lets a live sheet reach testRun for ${label}`, async () => {
      resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'live' })
      allowSampleRecord()
      const svc = makeService()
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(200)
      expect(svc.testRun).toHaveBeenCalledTimes(1)
      expect(svc.testRun.mock.calls[0]?.[0]).toBe('rule-1')
      expect(svc.testRun.mock.calls[0]?.[1]).toBe('sheet-a')
      expect(svc.testRun.mock.calls[0]?.[2]?.mode).toBe(label)
    })
  }

  it('answers an unauthorized caller identically for a live, a deleted and an absent sheet (no liveness oracle)', async () => {
    const answers: Array<{ status: number; body: unknown }> = []
    for (const sheetLiveness of ['live', 'deleted', 'absent']) {
      resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false }, sheetLiveness })
      const svc = makeService()
      pinned.setApp(buildApp(svc))
      const res = await request(pinned.url()).post(URL_PATH).send({})
      answers.push({ status: res.status, body: res.body })
      expect(svc.testRun).not.toHaveBeenCalled()
    }
    expect(answers[0]).toEqual({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } } })
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })

  it('400s a whitespace-only sheet segment before any capability or liveness lookup', async () => {
    const svc = makeService()
    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url()).post('/api/multitable/sheets/%20/automations/rule-1/test').send({})
    expect(res.status).toBe(400)
    expect(resolveSheetCapabilities).not.toHaveBeenCalled()
    expect(svc.testRun).not.toHaveBeenCalled()
  })
})

describe('#5803 follow-up — test-run route values-free failures', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    requireRecordReadable.mockReset()
    poolQuery.mockReset()
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'live' })
    allowSampleRecord()
  })

  for (const [label, body] of [['simulate', SIMULATE], ['real_fire', REAL_FIRE]] as const) {
    for (const [code, message] of [
      [TEST_RUN_RULE_NOT_FOUND_CODE, TEST_RUN_RULE_NOT_FOUND_MESSAGE],
      [SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE],
    ] as const) {
      it(`passes the service's typed ${code} rejection through for ${label} with its code and fixed message`, async () => {
        const svc = makeService()
        svc.testRun.mockRejectedValue(new AutomationTestRunRejectedError(404, code, message))
        pinned.setApp(buildApp(svc))

        const res = await request(pinned.url()).post(URL_PATH).send(body)

        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code, message } })
      })
    }

    it(`no longer recognises the rule gate by its text for ${label}: a plain Error with that sentence is a fixed 500`, async () => {
      const svc = makeService()
      svc.testRun.mockRejectedValue(new Error('Rule rule-secret-7f3a not found or not enabled'))
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ ok: false, error: { code: 'TEST_RUN_FAILED', message: 'Test run failed' } })
      expect(JSON.stringify(res.body)).not.toContain('rule-secret-7f3a')
    })

    it(`answers a transient DB error for ${label} with a fixed 503 that does not contain the thrown text`, async () => {
      const svc = makeService()
      svc.testRun.mockRejectedValue(Object.assign(
        new Error('关系 "automation_rules_secret_tbl" 不存在 at db.internal.host:5432 as pg_app'),
        { code: '42P01' },
      ))
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(503)
      expect(res.body).toEqual({ ok: false, error: { code: 'DB_NOT_READY', message: 'Service temporarily unavailable' } })
      expect(JSON.stringify(res.body)).not.toMatch(/automation_rules_secret_tbl|db\.internal\.host|5432|pg_app/)
    })

    it(`answers any other failure for ${label} with a fixed 500 that does not contain the thrown text`, async () => {
      const svc = makeService()
      svc.testRun.mockRejectedValue(new Error('duplicate key value violates unique constraint "secret_idx" (rule not found in cache)'))
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ ok: false, error: { code: 'TEST_RUN_FAILED', message: 'Test run failed' } })
      expect(JSON.stringify(res.body)).not.toMatch(/secret_idx|duplicate key|not found/)
    })
  }

  it('does not reclassify a deeper "... not found" simulation error as a missing rule', async () => {
    const svc = makeService()
    svc.testRun.mockRejectedValue(new Error('Internal view not found: view_secret'))
    pinned.setApp(buildApp(svc))

    const res = await request(pinned.url()).post(URL_PATH).send({})

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'TEST_RUN_FAILED', message: 'Test run failed' } })
    expect(JSON.stringify(res.body)).not.toContain('view_secret')
  })

  for (const prose of [
    'Target view_secret is unavailable',
    'Planner not ready for field fld_secret',
    'Field fld_secret does not exist on target sheet',
    'Upstream webhook ECONNREFUSED-like text too many clients',
  ]) {
    it(`keeps a planner/executor error whose prose looks transient at 500 (not 503): ${prose}`, async () => {
      const svc = makeService()
      svc.testRun.mockRejectedValue(new Error(prose))
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send({})

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ ok: false, error: { code: 'TEST_RUN_FAILED', message: 'Test run failed' } })
      expect(JSON.stringify(res.body)).not.toMatch(/secret/)
    })
  }

  for (const [label, err] of [
    ['socket code ECONNREFUSED', Object.assign(new Error('connect db.internal.host:5432'), { code: 'ECONNREFUSED' })],
    ['SQLSTATE 57P03 cannot_connect_now', Object.assign(new Error('数据库系统正在启动'), { code: '57P03' })],
    ['SQLSTATE 08006 connection_failure', Object.assign(new Error('x'), { code: '08006' })],
    ['SQLSTATE 53300 too_many_connections', Object.assign(new Error('x'), { code: '53300' })],
    ['node-pg driver Connection terminated', new Error('Connection terminated unexpectedly')],
  ] as const) {
    it(`answers a code-classified transient DB error (${label}) with the fixed 503`, async () => {
      const svc = makeService()
      svc.testRun.mockRejectedValue(err)
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send({})

      expect(res.status).toBe(503)
      expect(res.body).toEqual({ ok: false, error: { code: 'DB_NOT_READY', message: 'Service temporarily unavailable' } })
      expect(JSON.stringify(res.body)).not.toMatch(/db\.internal\.host|5432|启动|terminated/)
    })
  }

  it('answers a non-Error rejection with the fixed 500 body', async () => {
    const svc = makeService()
    svc.testRun.mockRejectedValue('raw string secret-token')
    pinned.setApp(buildApp(svc))

    const res = await request(pinned.url()).post(URL_PATH).send({})

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'TEST_RUN_FAILED', message: 'Test run failed' } })
  })
})

describe('#5812 follow-up — test-run route through the REAL service', () => {
  const LIVENESS_BATCH_SQL = /SELECT\s+id,\s*deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*ANY/i

  function ruleRow(over: Record<string, unknown> = {}) {
    return {
      id: 'rule-1',
      sheet_id: 'sheet-a',
      name: 'Rule',
      trigger_type: 'record.created',
      trigger_config: {},
      action_type: 'record_click',
      action_config: {},
      enabled: true,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      created_by: 'u_author',
      ...over,
    }
  }

  /** getRule() reads through the Kysely chain; the rule row (or none) is what it finds. */
  function realService(rule: Record<string, unknown> | undefined, sheetDeletedInService: boolean) {
    const chain: Record<string, unknown> = {}
    for (const method of ['selectAll', 'where', 'orderBy']) chain[method] = vi.fn(() => chain)
    chain.execute = vi.fn(async () => (rule ? [rule] : []))
    chain.executeTakeFirst = vi.fn(async () => rule)
    const db = { selectFrom: vi.fn(() => chain) }
    // The rule's OWN sheet id is the only one that should ever come back "deleted" here: a query for
    // any other id (e.g. a mutant asking about `rule.sheet_id + '_other'`) must read as live, so a
    // wrong-id query lets the run proceed and the assertions below catch it.
    const gatedSheetId = rule?.sheet_id as string | undefined
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (LIVENESS_BATCH_SQL.test(sql)) {
        const ids = (params?.[0] ?? []) as string[]
        return {
          rows: ids.map((id) => ({
            id,
            deleted_at: sheetDeletedInService && id === gatedSheetId ? '2026-09-16T00:00:00.000Z' : null,
          })),
          rowCount: ids.length,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const svc = new AutomationService(new EventBus(), db as never, query as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executeRule = vi.spyOn(svc as any, 'executeRule')
    return { svc, executeRule }
  }

  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    requireRecordReadable.mockReset()
    poolQuery.mockReset()
    // The route's own liveness check sees a LIVE sheet: the service is the layer under test.
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'live' })
    allowSampleRecord()
  })

  for (const [label, body] of [['simulate', SIMULATE], ['real_fire', REAL_FIRE]] as const) {
    it(`answers a missing, an other-sheet and a disabled rule identically for ${label}`, async () => {
      const answers: Array<{ status: number; body: unknown }> = []
      for (const rule of [undefined, ruleRow({ sheet_id: 'sheet-b' }), ruleRow({ enabled: false })]) {
        const { svc, executeRule } = realService(rule, false)
        pinned.setApp(buildApp(svc))
        const res = await request(pinned.url()).post(URL_PATH).send(body)
        answers.push({ status: res.status, body: res.body })
        expect(executeRule).not.toHaveBeenCalled()
      }
      expect(answers[0]).toEqual({
        status: 404,
        body: { ok: false, error: { code: 'TEST_RUN_RULE_NOT_FOUND', message: 'Automation rule not found or not enabled' } },
      })
      expect(answers[1]).toEqual(answers[0])
      expect(answers[2]).toEqual(answers[0])
      expect(JSON.stringify(answers)).not.toMatch(/rule-1|sheet-b/)
    })

    it(`refuses a sheet deleted after the route check for ${label} with the route's SHEET_DELETED body`, async () => {
      const { svc, executeRule } = realService(ruleRow(), true)
      pinned.setApp(buildApp(svc))

      const res = await request(pinned.url()).post(URL_PATH).send(body)

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
      expect(executeRule).not.toHaveBeenCalled()
    })
  }
})
