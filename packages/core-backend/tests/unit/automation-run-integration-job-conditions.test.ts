/**
 * R-69 1b-ii — a `run_integration_job` rule cannot carry conditions (owner-approved 2026-11-11).
 *
 * The job runs on a schedule.cron trigger, which fires with an EMPTY record: a condition can only fail, so the
 * execution is skipped, the job never runs and no summary is published. The save refuses it with one fixed,
 * values-free message (AutomationRuleValidationError, VALIDATION_ERROR → the route answers 400), judged on the
 * NEXT STORED STATE, not on the request alone:
 *   - create with conditions (job as the legacy actionType/actionConfig pair) is refused. A NEW actions[] placement
 *     does not reach this check on this slice: the save gate's nested-occurrence test is by object identity and
 *     refuses it first; a STORED job rule with actions[] is covered by the conditions-only and switch cases below;
 *   - (a) a stored plain rule that already has conditions, edited into a job rule WITHOUT touching conditions, is
 *     refused; (b) a conditions-only edit that adds conditions to a stored job rule is refused; a trigger-only edit
 *     of a stored job rule that already carries conditions is refused too (the stored conditions are the next ones);
 *   - an empty group (no condition nodes) counts as none; clearing conditions (null or an empty group) is allowed;
 *   - a pure on/off switch, a rename and a delete of a stored job rule that DOES carry conditions (a row saved
 *     before this check) are allowed: an operator can always turn a rule off.
 * Assertions are on the service's outbound seams: the Kysely mock (row inserted / update set / delete) and the
 * thrown error (class, code, message).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE,
  validateRunIntegrationJobConditions,
} from '../../src/multitable/automation-run-integration-job'
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { EventBus } from '../../src/integration/events/event-bus'

const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const SHEET_ID = 'sheet_rij_cond'
const RULE_ID = 'atr_rij_cond'
const ORGS = /FROM user_orgs/i
// R-69 I6a: a job rule saves only on the binding tenant's ACTIVE registered project sheet (registry 087, the switch on).
const REGISTRY = /FROM integration_stock_prep_project_target WHERE sheet_id = \$1/
const REGISTERED = { sheet_id: SHEET_ID, project_no: 'P-1', status: 'active', object_id: 'obj_1', tenant_id: 'tenant_1' }
const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' } }
const STAMPED = { ...JOB, timeoutMs: 30 * 60_000, binding: { principalId: 'svc_user', tenantId: 'tenant_1' } }
const CRON = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
const CONDITIONS = { conjunction: 'AND', conditions: [{ fieldId: 'status', operator: 'equals', value: 'x' }] }
const EMPTY_GROUP = { conjunction: 'AND', conditions: [] }

function makeHarness() {
  const inserted: Record<string, unknown>[] = []
  const sets: Record<string, unknown>[] = []
  const deletes: unknown[] = []
  const executeResults: unknown[] = []
  let stored: Record<string, unknown> | undefined
  let lastVerb = ''
  const queryFn = vi.fn(async (sql: string) => {
    if (ORGS.test(sql)) return { rows: [{ org_id: 'tenant_1' }], rowCount: 1 }
    if (REGISTRY.test(sql)) return { rows: [REGISTERED], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const m of ['selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin']) chain[m] = vi.fn(chainFn)
  chain.insertInto = vi.fn(() => { lastVerb = 'insert'; return chain })
  chain.updateTable = vi.fn(() => { lastVerb = 'update'; return chain })
  chain.deleteFrom = vi.fn((table: unknown) => { lastVerb = 'delete'; deletes.push(table); return chain })
  chain.values = vi.fn((row: unknown) => { inserted.push(row as Record<string, unknown>); return chain })
  chain.set = vi.fn((row: unknown) => { sets.push(row as Record<string, unknown>); return chain })
  chain.execute = vi.fn(async () => (lastVerb === 'insert' ? [] : executeResults.shift() ?? []))
  chain.executeTakeFirst = vi.fn(async () => stored)
  const service = new AutomationService(new EventBus(), chain as never, queryFn as never)
  return {
    service,
    inserted,
    sets,
    deletes,
    setStored: (row: Record<string, unknown> | undefined) => { stored = row },
    pushExecute: (rows: unknown) => { executeResults.push(rows) },
  }
}

/** A stored job rule; `legacy` = the job only as the actionType/actionConfig pair (actions null). */
function storedJobRule(overrides: Record<string, unknown> = {}, legacy = false) {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: 'nightly pull',
    trigger_type: 'schedule.cron',
    trigger_config: CRON,
    action_type: 'run_integration_job',
    action_config: STAMPED,
    enabled: true,
    created_at: '2026-11-11T00:00:00.000Z',
    updated_at: '2026-11-11T00:00:00.000Z',
    created_by: 'svc_user',
    conditions: null,
    actions: legacy ? null : [{ type: 'run_integration_job', config: STAMPED }],
    execution_mode: null,
    ...overrides,
  }
}

/** A stored plain (non-job) schedule rule. */
function storedPlainRule(overrides: Record<string, unknown> = {}) {
  return storedJobRule({ action_type: 'record_click', action_config: {}, actions: null, ...overrides })
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error)
}

function expectConditionsRefusal(error: unknown) {
  expect(error).toBeInstanceOf(AutomationRuleValidationError)
  expect((error as AutomationRuleValidationError).code).toBe('VALIDATION_ERROR')
  expect((error as Error).message).toBe(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE)
}

describe('run_integration_job conditions — the validator (pure)', () => {
  it('absent conditions and an empty group are none; any condition node (or a malformed group) is refused with the one fixed message', () => {
    expect(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE).toBe('run_integration_job rules cannot carry conditions (a schedule trigger has no record context)')
    expect(validateRunIntegrationJobConditions(null)).toBeNull()
    expect(validateRunIntegrationJobConditions(undefined)).toBeNull()
    expect(validateRunIntegrationJobConditions(EMPTY_GROUP)).toBeNull()
    expect(validateRunIntegrationJobConditions(CONDITIONS)).toBe(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE)
    expect(validateRunIntegrationJobConditions({ conjunction: 'OR', conditions: [{ conjunction: 'AND', conditions: [] }] })).toBe(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE)
    expect(validateRunIntegrationJobConditions({ conjunction: 'AND' })).toBe(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE)
  })
})

describe('run_integration_job conditions — AutomationService save', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => { vi.stubEnv(FLAG, 'true'); vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true'); h = makeHarness() })
  afterEach(() => { h.service.unregisterSchedule(RULE_ID); vi.unstubAllEnvs() })

  const createInput = (overrides: Record<string, unknown> = {}) => ({
    name: 'nightly pull', triggerType: 'schedule.cron', triggerConfig: CRON,
    actionType: 'run_integration_job', actionConfig: JOB, createdBy: 'svc_user', ...overrides,
  })

  it('create: conditions on the legacy pair placement are refused, nothing inserted', async () => {
    expectConditionsRefusal(await refusal(h.service.createRule(SHEET_ID, createInput({ conditions: CONDITIONS }) as never)))
    expect(h.inserted).toHaveLength(0)
  })
  it('create: an empty group counts as no conditions (saved)', async () => {
    const rule = await h.service.createRule(SHEET_ID, createInput({ conditions: EMPTY_GROUP }) as never)
    expect(h.inserted).toHaveLength(1)
    h.service.unregisterSchedule(rule.id)
  })
  it('create: a plain (non-job) schedule rule with conditions is untouched by this check', async () => {
    const rule = await h.service.createRule(SHEET_ID, createInput({ actionType: 'record_click', actionConfig: {}, conditions: CONDITIONS }) as never)
    expect(h.inserted).toHaveLength(1)
    h.service.unregisterSchedule(rule.id)
  })

  it('update (a): a stored plain rule WITH conditions edited into a job rule (actionType + actionConfig) without touching conditions is refused', async () => {
    h.setStored(storedPlainRule({ conditions: CONDITIONS }))
    expectConditionsRefusal(await refusal(h.service.updateRule(RULE_ID, SHEET_ID, { actionType: 'run_integration_job', actionConfig: JOB } as never)))
    expect(h.sets).toHaveLength(0)
  })
  it('update (a) control: the same edit that also clears the conditions (null, or an empty group) is saved', async () => {
    for (const conditions of [null, EMPTY_GROUP]) {
      const local = makeHarness()
      local.setStored(storedPlainRule({ conditions: CONDITIONS }))
      local.pushExecute([storedJobRule({ conditions })])
      expect(await local.service.updateRule(RULE_ID, SHEET_ID, { actionType: 'run_integration_job', actionConfig: JOB, conditions } as never)).not.toBeNull()
      expect(local.sets).toHaveLength(1)
      expect(local.sets[0].conditions).toBe(conditions === null ? null : JSON.stringify(EMPTY_GROUP))
      local.service.unregisterSchedule(RULE_ID)
    }
  })

  it('update (b): a conditions-only edit that adds conditions to a stored job rule is refused (actions[] and legacy pair)', async () => {
    for (const legacy of [false, true]) {
      const local = makeHarness()
      local.setStored(storedJobRule({}, legacy))
      expectConditionsRefusal(await refusal(local.service.updateRule(RULE_ID, SHEET_ID, { conditions: CONDITIONS } as never)))
      expect(local.sets).toHaveLength(0)
    }
  })
  it('update: a trigger-only edit of a stored job rule that already carries conditions is refused (the stored conditions are the next ones)', async () => {
    h.setStored(storedJobRule({ conditions: CONDITIONS }))
    expectConditionsRefusal(await refusal(h.service.updateRule(RULE_ID, SHEET_ID, { triggerConfig: { cron: '0 7 * * *', timezone: 'Asia/Shanghai' } } as never)))
    expect(h.sets).toHaveLength(0)
  })
  it('update: a conditions-only edit that adds conditions to a plain (non-job) rule is untouched by this check', async () => {
    h.setStored(storedPlainRule())
    h.pushExecute([storedPlainRule({ conditions: CONDITIONS })])
    expect(await h.service.updateRule(RULE_ID, SHEET_ID, { conditions: CONDITIONS } as never)).not.toBeNull()
    expect(h.sets).toHaveLength(1)
  })

  it('allowed on a stored job rule that DOES carry conditions: clearing them with null or with an empty group', async () => {
    for (const conditions of [null, EMPTY_GROUP]) {
      const local = makeHarness()
      local.setStored(storedJobRule({ conditions: CONDITIONS }))
      local.pushExecute([storedJobRule({ conditions })])
      expect(await local.service.updateRule(RULE_ID, SHEET_ID, { conditions } as never)).not.toBeNull()
      expect(local.sets).toHaveLength(1)
      local.service.unregisterSchedule(RULE_ID)
    }
  })
  it('allowed on a stored job rule that DOES carry conditions: the on/off switch both ways (setRuleEnabled routes through updateRule), only the flag written', async () => {
    h.setStored(storedJobRule({ conditions: CONDITIONS }))
    h.pushExecute([storedJobRule({ conditions: CONDITIONS, enabled: false })])
    expect((await h.service.setRuleEnabled(RULE_ID, SHEET_ID, false))?.enabled).toBe(false)
    h.setStored(storedJobRule({ conditions: CONDITIONS, enabled: false }))
    h.pushExecute([storedJobRule({ conditions: CONDITIONS, enabled: true })])
    expect((await h.service.setRuleEnabled(RULE_ID, SHEET_ID, true))?.enabled).toBe(true)
    expect(h.sets.map((set) => Object.keys(set).sort())).toEqual([['enabled', 'updated_at'], ['enabled', 'updated_at']])
  })
  it('allowed on a stored job rule that DOES carry conditions: a rename, and a delete', async () => {
    h.setStored(storedJobRule({ conditions: CONDITIONS }))
    h.pushExecute([storedJobRule({ conditions: CONDITIONS, name: 'renamed' })])
    expect((await h.service.updateRule(RULE_ID, SHEET_ID, { name: 'renamed' }))?.name).toBe('renamed')
    expect(h.sets).toHaveLength(1)
    h.pushExecute([{ numDeletedRows: BigInt(1) }])
    expect(await h.service.deleteRule(RULE_ID, SHEET_ID)).toBe(true)
    expect(h.deletes).toHaveLength(1)
  })
})
