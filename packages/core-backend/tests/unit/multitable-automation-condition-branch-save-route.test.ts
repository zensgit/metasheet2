/**
 * 客户反馈 2026-09-24 #4b（裁定 PR #6074）— the ROUTE wiring of the save-time field check for `condition_branch`
 * conditions.
 *
 * `preflightAutomationConditionFields` only sees a rule's action tree through its 4th argument, and the two
 * univer-meta save routes are its only callers that pass one:
 *   POST  /sheets/:sheetId/automations          → `preflightAutomationConditionFields(query, sheetId, input.conditions, input)`
 *   PATCH /sheets/:sheetId/automations/:ruleId  → the same, with `actionType` AND `actionConfig` resolved to the
 *                                                 EFFECTIVE pair (request ?? stored) by `preflightAutomationRuleUpdate`.
 * Drop the 4th argument at either site, or hand the PATCH the raw request instead of the effective pair, and every
 * function-level test stays green while a branch condition is persisted unchecked. So these cases go through the
 * real router: the mocked pool answers the liveness / permission / `meta_fields` reads, the automation service is a
 * mock (the only question about it is whether createRule / updateRule was reached), and the transport is the pinned
 * per-suite server (#4154: never `request(app)`).
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_cond_branch'
const RULE_ID = 'rule_cond_branch'
const AUTOMATIONS = `/api/multitable/sheets/${SHEET_ID}/automations`
const INVALID = 'AUTOMATION_CONDITION_VALUE_INVALID'

type FieldRow = { id: string; type: string; property?: Record<string, unknown> | null }
const FIELDS: FieldRow[] = [
  { id: 'fld_qty', type: 'number', property: {} },
  { id: 'fld_done', type: 'boolean', property: {} },
  { id: 'fld_opened', type: 'date', property: {} },
  { id: 'fld_title', type: 'string', property: {} },
]

const FIELDS_SQL = /FROM meta_fields WHERE sheet_id = \$1/

function createMockPool(fields: FieldRow[]) {
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
    // Sheet liveness (`SELECT deleted_at …`) and the plain existence reads: only THE sheet resolves.
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      const rows = params?.[0] === SHEET_ID ? [{ id: SHEET_ID, deleted_at: null }] : []
      return { rows, rowCount: rows.length }
    }
    if (FIELDS_SQL.test(sql)) {
      const rows = params?.[0] === SHEET_ID ? fields.map((field) => ({ ...field })) : []
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return {
    query,
    transaction,
    /** How many times the save path read the sheet's fields (the #4b contract: one read, or none). */
    fieldReads: () => query.mock.calls.filter(([sql]) => FIELDS_SQL.test(String(sql))).length,
  }
}

function storedRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: 'Branch rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'update_record',
    action_config: { fields: { fld_title: 'x' } },
    enabled: true,
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    created_by: 'admin_1',
    conditions: null,
    actions: null,
    execution_mode: null,
    ...overrides,
  }
}

/**
 * Stateful on purpose: what createRule / updateRule "persist" is what the next getRule reads back, so a two-step
 * sequence (save, then PATCH) sees its own first step — the two-step re-type tests depend on it.
 */
function createMockAutomationService(existing: ReturnType<typeof storedRule> | null = storedRule()) {
  let current = existing
  return {
    createRule: vi.fn(async (sheetId: string, input: Record<string, unknown>) => (current = storedRule({
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
      execution_mode: input.executionMode ?? null,
    }))),
    getRule: vi.fn(async (ruleId: string) => (ruleId === RULE_ID ? current : null)),
    updateRule: vi.fn(async (ruleId: string, sheetId: string, input: Record<string, unknown>) => (current = storedRule({
      id: ruleId,
      sheet_id: sheetId,
      action_type: input.actionType ?? current?.action_type,
      action_config: input.actionConfig ?? current?.action_config,
      actions: input.actions ?? current?.actions ?? null,
      execution_mode: input.executionMode ?? current?.execution_mode ?? null,
    }))),
  }
}

const pinned = usePinnedServer()

async function mountApp(options: {
  fields?: FieldRow[]
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

  const pool = createMockPool(options.fields ?? FIELDS)
  const automationService = options.automationService ?? createMockAutomationService()
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as never)
  setAutomationServiceInstance(automationService as never)

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
  pinned.setApp(app)

  return { pool, automationService }
}

type Condition = Record<string, unknown>
const group = (...conditions: unknown[]) => ({ conjunction: 'AND', conditions })
const branchAction = (conditions: unknown) => ({
  type: 'condition_branch',
  config: {
    branches: [{ key: 'hit', conditions, actions: [{ type: 'update_record', config: { fields: { fld_title: 'x' } } }] }],
    defaultBranch: { key: 'fallback', actions: [] },
  },
})
const qty = (operator: string, value: unknown): Condition => ({ fieldId: 'fld_qty', operator, value })
const createBody = (actions: unknown[], extra: Record<string, unknown> = {}) => ({
  name: 'Branch rule',
  triggerType: 'record.created',
  triggerConfig: {},
  executionMode: 'workflow_job_v1',
  actions,
  ...extra,
})
/** A rule persisted in the legacy columns alone (`actions: null`), the shape the partial-PATCH bypass needed. */
const storedBranchRule = (condition: Condition = qty('equals', 1)) => storedRule({
  action_type: 'condition_branch',
  action_config: branchAction(group(condition)).config,
  actions: null,
  execution_mode: 'workflow_job_v1',
})

describe('客户反馈 #4b — condition_branch conditions are field-checked at the route save gate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('POST: a number field compared with "abc" inside actions[0] is refused 400 before createRule, from ONE field read; "5" saves', async () => {
    const { pool, automationService } = await mountApp()

    const bad = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([branchAction(group(qty('equals', 'abc')))]))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toEqual({
      code: INVALID,
      message: 'actions[0].config.branches[0].conditions.conditions[0].value must be a number',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()
    expect(pool.fieldReads()).toBe(1)

    const ok = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([branchAction(group(qty('equals', '5')))]))
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(automationService.createRule).toHaveBeenCalledTimes(1)
    expect(pool.fieldReads()).toBe(2)
  })

  it('POST: a condition_branch behind another action (actions[1]) with a nested group is reached, with its own path; date values follow the same gate', async () => {
    const { automationService } = await mountApp()

    const nested = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([
        { type: 'update_record', config: { fields: { fld_title: 'first' } } },
        branchAction(group({ conjunction: 'OR', conditions: [qty('equals', 'abc')] })),
      ]))
    expect(nested.status).toBe(400)
    expect(nested.body.error).toEqual({
      code: INVALID,
      message: 'actions[1].config.branches[0].conditions.conditions[0].conditions[0].value must be a number',
    })

    const badDate = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([branchAction(group({ fieldId: 'fld_opened', operator: 'equals', value: 'yesterday' }))]))
    expect(badDate.status).toBe(400)
    expect(badDate.body.error).toEqual({
      code: INVALID,
      message: 'actions[0].config.branches[0].conditions.conditions[0].value must be a date (YYYY-MM-DD)',
    })
    expect(automationService.createRule).not.toHaveBeenCalled()

    const okDate = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([branchAction(group({ fieldId: 'fld_opened', operator: 'equals', value: '2026-09-25' }))]))
    expect(okDate.status).toBe(200)
    expect(automationService.createRule).toHaveBeenCalledTimes(1)
  })

  it('POST: top-level conditions and branch conditions are checked together from ONE field read; the top-level path is unchanged', async () => {
    const { pool, automationService } = await mountApp()

    const res = await request(pinned.url())
      .post(AUTOMATIONS)
      .send(createBody([branchAction(group(qty('equals', 5)))], { conditions: group(qty('equals', 'abc')) }))
    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({ code: INVALID, message: 'conditions.conditions[0].value must be a number' })
    expect(automationService.createRule).not.toHaveBeenCalled()
    expect(pool.fieldReads()).toBe(1)
  })

  it('PATCH with actions: the same refusal, before updateRule', async () => {
    const { automationService } = await mountApp()

    const res = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actions: [branchAction(group(qty('less_than', 'many')))] })
    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: INVALID,
      message: 'actions[0].config.branches[0].conditions.conditions[0].value must be a number',
    })
    expect(automationService.updateRule).not.toHaveBeenCalled()
  })

  it('PATCH with only actionConfig on a rule STORED as condition_branch resolves the stored type: refused after one getRule, no updateRule (partial-PATCH bypass closed)', async () => {
    const { pool, automationService } = await mountApp({ automationService: createMockAutomationService(storedBranchRule()) })

    const res = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionConfig: branchAction(group(qty('equals', 'abc'))).config })
    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: INVALID,
      message: 'actionConfig.branches[0].conditions.conditions[0].value must be a number',
    })
    expect(automationService.getRule).toHaveBeenCalledTimes(1)
    expect(automationService.updateRule).not.toHaveBeenCalled()
    expect(pool.fieldReads()).toBe(1)
  })

  it('the stored type is what directs the check: the same actionConfig on a rule stored as update_record has no branch conditions to check', async () => {
    // Discriminator for the case above — a blanket "anything with `branches`" scan would refuse this too.
    const { pool, automationService } = await mountApp({ automationService: createMockAutomationService(storedRule()) })

    const res = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionConfig: branchAction(group(qty('equals', 'abc'))).config })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
    expect(pool.fieldReads()).toBe(0)
  })

  it('two-step re-type: an update_record rule saved with never-checked `branches`, then PATCHed to condition_branch WITHOUT actionConfig, is refused on the STORED branches', async () => {
    // Step 1 is allowed on purpose (the case above): an update_record rule's actionConfig is not a branch config,
    // so its `branches` are not field-checked. Step 2 re-types the rule and resends no actionConfig — updateRule
    // keeps the stored config, so those stored branches go live and are what must be checked (the effective pair).
    const automationService = createMockAutomationService(null)
    const { pool } = await mountApp({ automationService })

    const created = await request(pinned.url())
      .post(AUTOMATIONS)
      .send({
        name: 'Plain rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'update_record',
        actionConfig: { fields: { fld_title: 'x' }, ...branchAction(group(qty('equals', 'abc'))).config },
      })
    expect(created.status).toBe(200)
    expect(automationService.createRule).toHaveBeenCalledTimes(1)
    expect(pool.fieldReads()).toBe(0)

    const retyped = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionType: 'condition_branch', executionMode: 'workflow_job_v1' })
    expect(retyped.status).toBe(400)
    expect(retyped.body.error).toEqual({
      code: INVALID,
      message: 'actionConfig.branches[0].conditions.conditions[0].value must be a number',
    })
    expect(automationService.getRule).toHaveBeenCalledTimes(1)
    expect(automationService.updateRule).not.toHaveBeenCalled()
    expect(pool.fieldReads()).toBe(1)
  })

  it('two-step re-type discriminator: the same sequence with a VALID stored branch value ("5") saves — the stored branches are checked, a re-type is not refused as such', async () => {
    const automationService = createMockAutomationService(null)
    const { pool } = await mountApp({ automationService })

    const created = await request(pinned.url())
      .post(AUTOMATIONS)
      .send({
        name: 'Plain rule',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'update_record',
        actionConfig: { fields: { fld_title: 'x' }, ...branchAction(group(qty('equals', '5'))).config },
      })
    expect(created.status).toBe(200)

    const retyped = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionType: 'condition_branch', executionMode: 'workflow_job_v1' })
    expect(retyped.status).toBe(200)
    expect(retyped.body.ok).toBe(true)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
    expect(pool.fieldReads()).toBe(1)
  })

  it('PATCH: a checkbox branch "done equals \'true\'" — the text the branch editor sends — saves; "yes" is refused', async () => {
    const { automationService } = await mountApp({ automationService: createMockAutomationService(storedBranchRule()) })
    const done = (value: unknown): Condition => ({ fieldId: 'fld_done', operator: 'equals', value })

    const ok = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionType: 'condition_branch', actionConfig: branchAction(group(done('true'))).config })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)

    const bad = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ actionType: 'condition_branch', actionConfig: branchAction(group(done('yes'))).config })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toEqual({
      code: INVALID,
      message: 'actionConfig.branches[0].conditions.conditions[0].value must be a boolean (true/false)',
    })
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
  })

  it('PATCH that does not touch the action tree (a rename) of a stored condition_branch rule saves with no field read', async () => {
    const { pool, automationService } = await mountApp({ automationService: createMockAutomationService(storedBranchRule()) })

    const res = await request(pinned.url())
      .patch(`${AUTOMATIONS}/${RULE_ID}`)
      .send({ name: 'renamed' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(automationService.updateRule).toHaveBeenCalledTimes(1)
    expect(pool.fieldReads()).toBe(0)
  })
})
