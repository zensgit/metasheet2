/**
 * R-69 1b-ii — `run_integration_job`: the save gate and the executor's lease/heartbeat/port state machine, on an
 * in-memory model of the two ledger tables and a fake clock (design baseline v2.3 §10.2.5 T1, T5a, T5b, T6, T7,
 * T11 and the trigger-time gates; the DB-clock cases are in tests/integration/multitable-automation-job-lease-
 * realdb.test.ts and multitable-automation-run-integration-job-realdb.test.ts). Synthetic only; no port implementation
 * from the plugin is loaded here — the port is a fake that honours or ignores the signal.
 *
 * The fake database answers EXACTLY the statements automation-outbound-intent.ts and automation-job-lease.ts
 * issue (matched by shape), evaluates `now()` with the fake clock, and rolls a transaction back on throw.
 * R-69 I6a: it is now the shared tests/utils/run-integration-job-fake-db.ts (it was a verbatim copy of it — diffed
 * identical at 811552dd6), which also answers the project-sheet registry read of the rule-sheet re-check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationExecutor, type AutomationDeps, type AutomationStepResult, type ClassAActionIdentity, type ExecutionContext } from '../../src/multitable/automation-executor'
import type { IntegrationRunInput, IntegrationRunPort, IntegrationRunSummary } from '../../src/core/integration-run-port'
import { Logger } from '../../src/core/logger'
import { EventBus } from '../../src/integration/events/event-bus'
import { JobLeaseLostError, RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS } from '../../src/multitable/automation-job-lease'
import {
  INTEGRATION_AUTOMATION_RUN_FLAGS_NOT_READ_IN_1B_II,
  collectRunIntegrationJobOccurrences,
  isIntegrationAutomationRunActionEnabled,
  parsePersistedRunIntegrationJobConfig,
  stampRunIntegrationJobConfig,
  validateRunIntegrationJobConfig,
  validateRunIntegrationJobTriggerCoupling,
} from '../../src/multitable/automation-run-integration-job'
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES, checkRunIntegrationJobRuleSheet } from '../../src/multitable/automation-run-integration-job-rule-sheet'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'

const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const PRINCIPAL = { id: 'svc_user', permissions: ['stock-prep:pull', 'stock-prep:operate', 'stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: 'tenant_1' }
const BINDING = { principalId: 'svc_user', tenantId: 'tenant_1' }

// ── fake port ──────────────────────────────────────────────────────────────────────────────────────────────

type FakeCall = { input: IntegrationRunInput; resolve: (s: IntegrationRunSummary) => void; reject: (e: unknown) => void }
function fakePort(behaviour: 'honor' | 'ignore' | 'immediate') {
  const calls: FakeCall[] = []
  const run = vi.fn(async (input: IntegrationRunInput): Promise<IntegrationRunSummary> => {
    await input.checkpoint()
    if (behaviour === 'immediate') return { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 1 } }
    return new Promise<IntegrationRunSummary>((resolve, reject) => {
      calls.push({ input, resolve, reject })
      if (behaviour === 'honor') {
        const onAbort = () => reject(input.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (input.signal.aborted) onAbort()
        else input.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  })
  const port: IntegrationRunPort = { run }
  return { port, calls, run }
}

const SCOPE = 'stock_prep_pull:tenant_1:P-1'
const CONFIG = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 1_000, binding: BINDING }

function harness(db: ReturnType<typeof createFakeJobDb>, port: IntegrationRunPort | null, extra: Partial<AutomationDeps> = {}) {
  const tracked: Promise<void>[] = []
  const shutdown = new AbortController()
  const exec = new AutomationExecutor({
    eventBus: new EventBus(),
    queryFn: db.query,
    transaction: db.transaction,
    integrationRunPort: () => port,
    shutdownSignal: shutdown.signal,
    trackIntegrationJobTask: (task) => { tracked.push(task) },
    resolveIntegrationRunPrincipal: async () => ({ ok: true, user: PRINCIPAL }),
    integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
    ...extra,
  })
  // `identity: null` = dispatch WITHOUT a class-A identity (the ad-hoc single-action path); omitted = the rule-driven identity.
  const run = (executionId: string, config: Record<string, unknown> = CONFIG, contextOverrides: Partial<ExecutionContext> = {}, identity: ClassAActionIdentity | null = { structuralPath: '0', rootExecutionId: executionId }) => {
    const context: ExecutionContext = { executionId, ruleId: 'rule_1', sheetId: 'sheet_1', recordId: '', recordData: {}, ruleCreatedBy: 'svc_user', triggerEvent: {}, rootExecutionId: executionId, ...contextOverrides }
    return (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i?: ClassAActionIdentity): Promise<AutomationStepResult> })
      .executeSingleAction({ type: 'run_integration_job', config }, context, identity ?? undefined)
  }
  return { exec, run, tracked, shutdown }
}
const settle = () => vi.advanceTimersByTimeAsync(0)
const unitOf = (step: AutomationStepResult, index = 0) => ((step.output as { units: Array<Record<string, unknown>> }).units[index])

// ── R-69 I6a fix (re-review M1): the rule sheet id is EXACT ──────────────────────────────────────────────────
// `sheet_1` is the registered sheet of every harness in this file. Each id below is that id plus ONE code point
// String.prototype.trim() strips, on either side. The sheet-create route takes any such text as a client id, so each
// names a DIFFERENT, ordinary sheet — which must never pass as the registered one, at save or at a trigger.
const REGISTRY = /FROM integration_stock_prep_project_target WHERE sheet_id = \$1/
const REGISTERED_SHEET_LOOKALIKES: Array<[label: string, sheetId: string]> = [
  ['a trailing space', 'sheet_1 '],
  ['a leading space', ' sheet_1'],
  ['a trailing tab', 'sheet_1\t'],
  ['a leading no-break space', '\u00a0sheet_1'],
]
/** What a registry reader that NORMALIZES its parameter does to it (a non-deterministic collation, a trimming query wrapper). */
const normalizedByReader = (param: unknown): unknown => (typeof param === 'string' ? param.trim() : param)

describe('run_integration_job — save-time vocabulary (pure)', () => {
  it('the switch reads the exact literal only; the three other switches have no read point', () => {
    expect(isIntegrationAutomationRunActionEnabled({ [FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    for (const value of ['TRUE', ' true', 'true ', '1', 'yes', '', undefined]) expect(isIntegrationAutomationRunActionEnabled({ [FLAG]: value } as NodeJS.ProcessEnv)).toBe(false)
    expect([...INTEGRATION_AUTOMATION_RUN_FLAGS_NOT_READ_IN_1B_II]).toEqual(['INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED', 'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED'])
  })
  it('accepts the dry-run stock_prep_pull shape and refuses every widening (T7: 55 min + 1 ms is a 400)', () => {
    const ok = { job: { kind: 'stock_prep_pull', projectNos: ['P-1', 'P-2'], applyMode: 'dry_run_only' } }
    expect(validateRunIntegrationJobConfig(ok, 'actionConfig')).toBeNull()
    expect(validateRunIntegrationJobConfig({ ...ok, timeoutMs: RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS }, 'actionConfig')).toBeNull()
    expect(validateRunIntegrationJobConfig({ ...ok, timeoutMs: RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS + 1 }, 'actionConfig')).toMatch(/timeoutMs must be at most 3300000/)
    expect(validateRunIntegrationJobConfig({ ...ok, timeoutMs: 3 * 60 * 60_000 }, 'actionConfig')).toMatch(/at most/)
    expect(validateRunIntegrationJobConfig({ ...ok, timeoutMs: 999 }, 'actionConfig')).toMatch(/at least 1000/)
    expect(validateRunIntegrationJobConfig({ ...ok, timeoutMs: 1000.5 }, 'actionConfig')).toMatch(/integer/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, applyMode: 'apply_when_ready' } }, 'actionConfig')).toMatch(/apply_when_ready' is not accepted/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, applyMode: 'apply' } }, 'actionConfig')).toMatch(/applyMode must be dry_run_only/)
    expect(validateRunIntegrationJobConfig({ job: { kind: 'pipeline', pipelineId: 'p', dryRun: true } }, 'actionConfig')).toMatch(/'pipeline' is not deliverable in this slice/)
    expect(validateRunIntegrationJobConfig({ job: { kind: 'pipeline', pipelineId: 'p', dryRun: false } }, 'actionConfig')).toMatch(/dryRun must be true/)
    expect(validateRunIntegrationJobConfig({ job: { kind: 'apply' } }, 'actionConfig')).toMatch(/job.kind must be one of/)
    expect(validateRunIntegrationJobConfig({ ...ok, retry: { maxAttempts: 3, backoffMs: 60_000 } }, 'actionConfig')).toMatch(/retry is reserved/)
    expect(validateRunIntegrationJobConfig({ ...ok, extra: 1 }, 'actionConfig')).toMatch(/extra is not an accepted key/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, projectNos: [] } }, 'actionConfig')).toMatch(/non-empty array/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, projectNos: Array.from({ length: 21 }, (_, i) => `P-${i}`) } }, 'actionConfig')).toMatch(/at most 20/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, projectNos: ['P-1', 'P-1'] } }, 'actionConfig')).toMatch(/not repeat/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, projectNos: ['P-1', ' '] } }, 'actionConfig')).toMatch(/non-blank/)
    expect(validateRunIntegrationJobConfig({ job: { ...ok.job, dryRun: true } }, 'actionConfig')).toMatch(/not an accepted key for kind stock_prep_pull/)
    expect(validateRunIntegrationJobConfig(null, 'actionConfig')).toMatch(/must be an object/)
  })
  it('stamps the server binding and the default timeout, dropping a client binding; the persisted shape re-parses', () => {
    const stamped = stampRunIntegrationJobConfig({ job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, binding: { principalId: 'attacker', tenantId: 'other' } }, BINDING)
    expect(stamped).toEqual({ job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000, binding: BINDING })
    expect(parsePersistedRunIntegrationJobConfig(stamped)).toEqual(stamped)
    expect(parsePersistedRunIntegrationJobConfig({ ...stamped, binding: undefined })).toBeNull()
    expect(parsePersistedRunIntegrationJobConfig({ ...stamped, timeoutMs: RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS + 1 })).toBeNull()
  })
  it('trigger coupling: schedule.cron with a PRESENT valid IANA timezone, nothing else', () => {
    expect(validateRunIntegrationJobTriggerCoupling('schedule.cron', { cron: '0 6 * * *', timezone: 'Asia/Shanghai' })).toBeNull()
    expect(validateRunIntegrationJobTriggerCoupling('schedule.cron', { cron: '0 6 * * *' })).toMatch(/must declare triggerConfig.timezone/)
    expect(validateRunIntegrationJobTriggerCoupling('schedule.cron', { cron: '0 6 * * *', timezone: '' })).toMatch(/must declare/)
    expect(validateRunIntegrationJobTriggerCoupling('schedule.cron', { cron: '0 6 * * *', timezone: 'Mars/Olympus' })).toMatch(/valid IANA/)
    expect(validateRunIntegrationJobTriggerCoupling('schedule.interval', { intervalMs: 900_000, timezone: 'Asia/Shanghai' })).toMatch(/only allowed on a schedule.cron/)
    expect(validateRunIntegrationJobTriggerCoupling('record.created', null)).toMatch(/only allowed on a schedule.cron/)
  })
  it('occurrences: top-level pair and top-level actions are collected; a nested occurrence is refused', () => {
    const nested = { type: 'run_integration_job', config: {} } as never
    const branch = { type: 'parallel_branch', config: { joinMode: 'all', branches: [{ key: 'a', actions: [nested] }] } } as never
    expect(collectRunIntegrationJobOccurrences('run_integration_job', { job: 1 }, null, [])).toEqual({ occurrences: [{ path: 'actionConfig', config: { job: 1 } }], error: null })
    // an actions[] entry is collected as a top-level occurrence; I6d fix round 2 (F2): under a pair that is another
    // action the rule is refused all the same — the job is its rule's only action (pair and list both)
    const underOtherPair = collectRunIntegrationJobOccurrences('record_click', {}, [nested], [nested])
    expect(underOtherPair.occurrences.map((o) => o.path)).toEqual(['actions[0].config'])
    expect(underOtherPair.error).toMatch(/must be the only action of its rule/)
    expect(collectRunIntegrationJobOccurrences('run_integration_job', {}, [nested], [nested])).toMatchObject({ error: null })
    expect(collectRunIntegrationJobOccurrences('record_click', {}, [branch], [branch, nested]).error).toMatch(/top-level action/)
    expect(collectRunIntegrationJobOccurrences('record_click', {}, null, [])).toEqual({ occurrences: [], error: null })
  })
})

describe('run_integration_job — AutomationService save gate', () => {
  const ORGS = /FROM user_orgs/i
  // R-69 I6a: every save now reads the project-sheet registry for the rule's sheet; 'sheet_1' is registered (active,
  // tenant_1, P-1) by default so the existing cases keep their meaning; the I6a cases pass their own registry.
  // I6a fix (M1): a row is stored under its REAL sheet id and answers with THAT id — never the query parameter echoed
  // back — and it matches the parameter byte for byte (PostgreSQL text `=`). `readAs` models a reader that normalizes
  // the parameter first: it then answers a look-alike id with the registered sheet's row (whose id is the real one).
  function makeService(
    orgRows: Array<{ org_id: string }>,
    registry: Record<string, Record<string, unknown>> | Error = { sheet_1: { tenant_id: 'tenant_1', project_no: 'P-1', status: 'active', object_id: 'obj_1' } },
    readAs: (param: unknown) => unknown = (param) => param,
  ) {
    const inserted: Record<string, unknown>[] = []
    const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (ORGS.test(sql)) return { rows: orgRows, rowCount: orgRows.length }
      if (REGISTRY.test(sql)) {
        if (registry instanceof Error) throw registry
        const asked = readAs(params[0])
        const storedSheetId = Object.keys(registry).find((id) => id === asked)
        return storedSheetId !== undefined ? { rows: [{ ...registry[storedSheetId], sheet_id: storedSheetId }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const m of ['selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin', 'insertInto', 'updateTable', 'deleteFrom', 'set']) chain[m] = vi.fn(chainFn)
    chain.values = vi.fn((row: unknown) => { inserted.push(row as Record<string, unknown>); return chain })
    chain.execute = vi.fn(async () => [])
    chain.executeTakeFirst = vi.fn(async () => undefined)
    const service = new AutomationService(new EventBus(), chain as never, queryFn as never)
    // R-69 B1: an enabled job rule is saved only by a user who holds the job authority live (the acting user, in the
    // binding tenant). These cases are about the gate's other checks, so the creator and the editor both hold it.
    service.setRunIntegrationJobEditorAuthorityResolverForTest(async ({ principalId, tenantId }) => (
      ['svc_user', 'editor_2'].includes(principalId) && tenantId === 'tenant_1'
        ? { ok: true, user: { id: principalId, permissions: ['workflow:write'], roles: [], role: 'user', tenantId } }
        : { ok: false, reason: 'principal_unauthorized' }
    ))
    return { service, inserted, queryFn }
  }
  const cronInput = (actionConfig: Record<string, unknown>, triggerConfig: Record<string, unknown> | undefined = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }, triggerType = 'schedule.cron') => ({
    triggerType, triggerConfig, actionType: 'run_integration_job', actionConfig, createdBy: 'svc_user',
  })
  const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' } }

  beforeEach(() => { vi.stubEnv(FLAG, 'true'); vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true') })
  afterEach(() => { vi.unstubAllEnvs() })

  it('switch OFF ⇒ RUN_ACTION_DISABLED (the route answers it 403), nothing persisted, no tenant read', async () => {
    vi.stubEnv(FLAG, 'TRUE')
    const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }])
    await expect(service.createRule('sheet_1', cronInput(JOB))).rejects.toMatchObject({ code: 'RUN_ACTION_DISABLED' })
    expect(inserted).toHaveLength(0)
    expect(queryFn.mock.calls.some(([sql]) => ORGS.test(String(sql)))).toBe(false)
  })
  it('switch ON ⇒ the persisted config carries the SERVER binding (creator + its single active tenant) and the default timeout; a client binding is dropped', async () => {
    const { service, inserted } = makeService([{ org_id: 'tenant_1' }])
    await service.createRule('sheet_1', cronInput({ ...JOB, binding: { principalId: 'attacker', tenantId: 'elsewhere' } }))
    expect(inserted).toHaveLength(1)
    const persisted = JSON.parse(String(inserted[0].action_config)) as Record<string, unknown>
    expect(persisted).toEqual({ job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000, binding: BINDING })
    expect(inserted[0].created_by).toBe('svc_user')
  })
  it.each([
    ['apply_when_ready', { job: { ...JOB.job, applyMode: 'apply_when_ready' } }, /apply_when_ready/],
    ['timeoutMs 55 min + 1 ms (T7)', { ...JOB, timeoutMs: RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS + 1 }, /at most 3300000/],
    ['the pipeline kind', { job: { kind: 'pipeline', pipelineId: 'p', dryRun: true } }, /not deliverable/],
    ['retry', { ...JOB, retry: { maxAttempts: 2, backoffMs: 60_000 } }, /retry is reserved/],
  ])('refuses %s with a 400-class error', async (_label, actionConfig, message) => {
    const { service, inserted } = makeService([{ org_id: 'tenant_1' }])
    await expect(service.createRule('sheet_1', cronInput(actionConfig))).rejects.toThrow(message)
    expect(inserted).toHaveLength(0)
  })
  it('refuses a non-cron trigger and a cron without a timezone (the coupling), and a creator with 0 or 2 active tenants', async () => {
    const one = makeService([{ org_id: 'tenant_1' }])
    await expect(one.service.createRule('sheet_1', cronInput(JOB, { intervalMs: 900_000 }, 'schedule.interval'))).rejects.toThrow(/only allowed on a schedule.cron/)
    await expect(one.service.createRule('sheet_1', cronInput(JOB, { cron: '0 6 * * *' }))).rejects.toThrow(/must declare triggerConfig.timezone/)
    const none = makeService([])
    await expect(none.service.createRule('sheet_1', cronInput(JOB))).rejects.toThrow(/exactly one active tenant \(none found\)/)
    const two = makeService([{ org_id: 'tenant_1' }, { org_id: 'tenant_2' }])
    await expect(two.service.createRule('sheet_1', cronInput(JOB))).rejects.toThrow(/several found/)
    const anonymous = makeService([{ org_id: 'tenant_1' }])
    await expect(anonymous.service.createRule('sheet_1', { ...cronInput(JOB), createdBy: null })).rejects.toThrow(/authenticated creator/)
    expect(one.inserted.length + none.inserted.length + two.inserted.length + anonymous.inserted.length).toBe(0)
  })
  it('a rule without the action is untouched by the gate (no tenant read, no stamp)', async () => {
    const { service, inserted, queryFn } = makeService([])
    await service.createRule('sheet_1', { triggerType: 'schedule.cron', triggerConfig: { cron: '0 6 * * *' }, actionType: 'record_click', actionConfig: {}, createdBy: 'svc_user' })
    expect(inserted).toHaveLength(1)
    expect(queryFn.mock.calls.some(([sql]) => ORGS.test(String(sql)))).toBe(false)
  })
  it('the refusal class is AutomationRuleValidationError (the route maps it)', async () => {
    const { service } = makeService([{ org_id: 'tenant_1' }])
    await expect(service.createRule('sheet_1', cronInput({ job: { kind: 'nope' } }))).rejects.toBeInstanceOf(AutomationRuleValidationError)
  })

  // ── R-69 I6a (ADR §3.1 + §6.5; T-layer defaults R-90): the rule's sheet = the binding tenant's registered sheet ──
  const M = RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES
  const ROW = (tenant: string, projectNo: string, status = 'active') => ({ tenant_id: tenant, project_no: projectNo, status, object_id: 'obj_x' })
  it.each([
    ['an unregistered sheet', 'sheet_9', JOB, { sheet_1: ROW('tenant_1', 'P-1') }, M.unregistered],
    ["another tenant's registered sheet", 'sheet_2', JOB, { sheet_2: ROW('tenant_2', 'P-1') }, M.tenant_mismatch],
    ['an archived sheet', 'sheet_1', JOB, { sheet_1: ROW('tenant_1', 'P-1', 'archived') }, M.unregistered],
    ["a project that is not the sheet's", 'sheet_1', { job: { ...JOB.job, projectNos: ['P-2'] } }, { sheet_1: ROW('tenant_1', 'P-1') }, M.project_mismatch],
    ["more than one project (even including the sheet's)", 'sheet_1', { job: { ...JOB.job, projectNos: ['P-1', 'P-2'] } }, { sheet_1: ROW('tenant_1', 'P-1') }, M.project_mismatch],
  ])('I6a: saving on %s is a 400 (AutomationRuleValidationError) and nothing is written', async (_label, sheetId, actionConfig, registry, message) => {
    const { service, inserted } = makeService([{ org_id: 'tenant_1' }], registry)
    const refusal = await service.createRule(sheetId, cronInput(actionConfig)).then(() => null, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect((refusal as Error).message).toBe(message)
    expect(inserted).toHaveLength(0)
    // values-free: the refusal names no sheet, tenant or project
    for (const needle of ['sheet_', 'tenant_', 'P-1', 'P-2']) expect((refusal as Error).message).not.toContain(needle)
  })
  it("I6a: the project-sheets switch off (anything but exact 'true') fails closed — 400, nothing written, no registry read", async () => {
    for (const value of ['TRUE', ' true', '1', '']) {
      vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, value)
      const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }])
      await expect(service.createRule('sheet_1', cronInput(JOB))).rejects.toThrow(M.switch_off)
      expect(inserted).toHaveLength(0)
      expect(queryFn.mock.calls.some(([sql]) => REGISTRY.test(String(sql)))).toBe(false)
    }
  })
  it('I6a: an unreadable registry is "could not be read; the rule was not saved" (400); a missing table (42P01) is unregistered', async () => {
    const unreadable = makeService([{ org_id: 'tenant_1' }], Object.assign(new Error('boom'), { code: '57P01' }))
    await expect(unreadable.service.createRule('sheet_1', cronInput(JOB))).rejects.toThrow(M.unreadable)
    expect(M.unreadable).toMatch(/could not be read; the rule was not saved$/)
    const missing = makeService([{ org_id: 'tenant_1' }], Object.assign(new Error('no table'), { code: '42P01' }))
    await expect(missing.service.createRule('sheet_1', cronInput(JOB))).rejects.toThrow(M.unregistered)
    expect(unreadable.inserted.length + missing.inserted.length).toBe(0)
  })
  it('I6a: the registered sheet of the binding tenant and its single project saves (the read names the RULE sheet)', async () => {
    const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }], { sheet_7: ROW('tenant_1', 'P-7') })
    await service.createRule('sheet_7', cronInput({ job: { ...JOB.job, projectNos: ['P-7'] } }))
    expect(inserted).toHaveLength(1)
    expect(queryFn.mock.calls.filter(([sql]) => REGISTRY.test(String(sql))).map(([, params]) => params)).toEqual([['sheet_7']])
  })
  it("I6a: an update re-runs the check on the rule's STORED sheet (archived since save => 400, nothing written)", async () => {
    const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }], { sheet_1: ROW('tenant_1', 'P-1', 'archived') })
    const chain = (service as unknown as { db: Record<string, ReturnType<typeof vi.fn>> }).db
    chain.executeTakeFirst.mockImplementation(async () => ({
      id: 'atr_1', sheet_id: 'sheet_1', trigger_type: 'schedule.cron', trigger_config: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
      action_type: 'run_integration_job', action_config: { ...JOB, timeoutMs: 60_000, binding: { principalId: 'svc_user', tenantId: 'tenant_1' } },
      enabled: true, created_by: 'svc_user', actions: null, conditions: null, execution_mode: null,
    }))
    await expect(service.updateRule('atr_1', 'sheet_1', { actionConfig: { ...JOB, timeoutMs: 120_000 } }, 'editor_2')).rejects.toThrow(M.unregistered)
    expect(chain.set).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
    expect(queryFn.mock.calls.filter(([sql]) => REGISTRY.test(String(sql))).map(([, params]) => params)).toEqual([['sheet_1']])
  })

  /** A stored run_integration_job rule row (what getRule reads back) on the given sheet, saved by `svc_user`. */
  const storedRule = (sheetId: string, overrides: Record<string, unknown> = {}) => ({
    id: 'atr_1', sheet_id: sheetId, name: 'pull', trigger_type: 'schedule.cron', trigger_config: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
    action_type: 'run_integration_job', action_config: { ...JOB, timeoutMs: 1_000, binding: BINDING },
    enabled: true, created_by: 'svc_user', actions: null, conditions: null, execution_mode: null, ...overrides,
  })
  const registryReadsOf = (queryFn: ReturnType<typeof makeService>['queryFn']) => queryFn.mock.calls.filter(([sql]) => REGISTRY.test(String(sql))).map(([, params]) => params)

  // ── R-69 I6a fix (re-review M1): the sheet id is EXACT — a look-alike of the registered id is another sheet ──
  it.each(REGISTERED_SHEET_LOOKALIKES)('M1: saving on the registered sheet id plus %s is a 400 (unregistered), nothing is written, and the registry was read with the RAW id', async (_label, lookalike) => {
    expect(lookalike).not.toBe('sheet_1')
    expect(lookalike.trim()).toBe('sheet_1') // the premise: a read with the TRIMMED id would find the registered row
    const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }])
    const refusal = await service.createRule(lookalike, cronInput(JOB)).then(() => null, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect((refusal as Error).message).toBe(M.unregistered)
    expect(inserted).toHaveLength(0)
    expect(registryReadsOf(queryFn)).toEqual([[lookalike]])
  })
  it.each(REGISTERED_SHEET_LOOKALIKES)('M1: an action update of a rule STORED on the registered sheet id plus %s is refused the same way (nothing written, RAW id read)', async (_label, lookalike) => {
    const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }])
    const chain = (service as unknown as { db: Record<string, ReturnType<typeof vi.fn>> }).db
    chain.executeTakeFirst.mockImplementation(async () => storedRule(lookalike))
    await expect(service.updateRule('atr_1', lookalike, { actionConfig: { ...JOB, timeoutMs: 120_000 } }, 'editor_2')).rejects.toThrow(M.unregistered)
    expect(chain.set).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
    expect(registryReadsOf(queryFn)).toEqual([[lookalike]])
  })
  it("M1: a registry reader that answers the look-alike id with the REGISTERED sheet's row is still refused — the answered row is not this sheet's (the re-compare); the registered sheet itself saves through the same reader", async () => {
    for (const [, lookalike] of REGISTERED_SHEET_LOOKALIKES) {
      const { service, inserted, queryFn } = makeService([{ org_id: 'tenant_1' }], undefined, normalizedByReader)
      await expect(service.createRule(lookalike, cronInput(JOB))).rejects.toThrow(M.unregistered)
      expect(inserted).toHaveLength(0)
      // the guard asked with the raw id; the READER normalized it and answered with sheet_1's own row
      expect(registryReadsOf(queryFn)).toEqual([[lookalike]])
      const answered = await queryFn.mock.results[queryFn.mock.calls.findIndex(([sql]) => REGISTRY.test(String(sql)))].value as { rows: unknown[] }
      expect(answered.rows).toEqual([{ sheet_id: 'sheet_1', tenant_id: 'tenant_1', project_no: 'P-1', status: 'active', object_id: 'obj_1' }])
    }
    const control = makeService([{ org_id: 'tenant_1' }], undefined, normalizedByReader)
    await control.service.createRule('sheet_1', cronInput(JOB))
    expect(control.inserted).toHaveLength(1)
  })

  // ── re-review L1: an update that does not touch the action does NOT re-run the sheet check — the trigger does ──
  // Stored: a run_integration_job rule on sheet_1, saved while the sheet was registered. The registry now says ARCHIVED.
  const JSON_COLUMNS = new Set(['trigger_config', 'action_config', 'conditions', 'actions'])
  it.each<[label: string, patch: Record<string, unknown>, expectedWrite: Record<string, unknown>]>([
    ['enable (setRuleEnabled)', { enabled: true }, { enabled: true }],
    ['rename', { name: 'renamed' }, { name: 'renamed' }],
    ['conditions only', { conditions: { conjunction: 'AND', conditions: [] } }, { conditions: JSON.stringify({ conjunction: 'AND', conditions: [] }) }],
    ['trigger only (a new cron)', { triggerConfig: { cron: '30 7 * * *', timezone: 'Asia/Shanghai' } }, { trigger_config: JSON.stringify({ cron: '30 7 * * *', timezone: 'Asia/Shanghai' }) }],
  ])('L1: %s on a rule whose sheet was ARCHIVED after save is written without the sheet check — and the trigger re-check still stops that rule before the port', async (label, patch, expectedWrite) => {
    const { service, queryFn } = makeService([{ org_id: 'tenant_1' }], { sheet_1: ROW('tenant_1', 'P-1', 'archived') })
    const chain = (service as unknown as { db: Record<string, ReturnType<typeof vi.fn>> }).db
    const stored = storedRule('sheet_1', { enabled: !('enabled' in patch) })
    chain.executeTakeFirst.mockImplementation(async () => stored)
    // UPDATE … RETURNING: the stored row with the written columns applied (jsonb columns come back parsed)
    const writes: Array<Record<string, unknown>> = []
    chain.set.mockImplementation((updates: Record<string, unknown>) => { writes.push(updates); return chain })
    chain.execute.mockImplementation(async () => writes.map((updates) => ({
      ...stored,
      ...Object.fromEntries(Object.entries(updates).map(([column, value]) => [column, typeof value === 'string' && JSON_COLUMNS.has(column) ? JSON.parse(value) : value])),
    })))
    let updated: Awaited<ReturnType<AutomationService['updateRule']>> = null
    try {
      updated = 'enabled' in patch
        ? await service.setRuleEnabled('atr_1', 'sheet_1', true, 'editor_2')
        : await service.updateRule('atr_1', 'sheet_1', patch, 'editor_2')
    } finally {
      service.unregisterSchedule('atr_1')
    }
    // the edit WAS written (a null here would be "rule not found"), and it wrote exactly this shape's column
    expect(updated).not.toBeNull()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject(expectedWrite)
    expect(Object.keys(writes[0]).sort()).toEqual([...Object.keys(expectedWrite), 'updated_at'].sort())
    // L1: NO registry read — the save-time sheet check does not run for this write shape (archived: it would refuse)
    expect(registryReadsOf(queryFn)).toEqual([])
    // …while an ACTION-shaped update of the same rule, on the same registry, IS refused and writes nothing more
    await expect(service.updateRule('atr_1', 'sheet_1', { actionConfig: { ...JOB, timeoutMs: 120_000 } }, 'editor_2')).rejects.toThrow(M.unregistered)
    expect(writes).toHaveLength(1)

    // The trigger, on the rule exactly as that update left it: step 0.5 refuses before anything is claimed or called.
    const context = { sheetId: updated!.sheet_id, ruleCreatedBy: updated!.created_by ?? undefined }
    const archivedDb = createFakeJobDb({ projectTargets: { sheet_1: { tenantId: 'tenant_1', projectNo: 'P-1', status: 'archived' } } })
    const blockedPort = fakePort('immediate')
    const blocked = await harness(archivedDb, blockedPort.port).run('exec_l1_archived', updated!.action_config, context)
    expect(blocked).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
    expect(blockedPort.run).toHaveBeenCalledTimes(0)
    expect(archivedDb.intentRows()).toHaveLength(0)
    expect(archivedDb.lease(SCOPE)).toBeUndefined()
    expect(archivedDb.registryReads).toEqual(['sheet_1'])
    // control: the SAME rule row runs while its sheet is registered — the stop above is the archive, nothing else
    const livePort = fakePort('immediate')
    expect((await harness(createFakeJobDb(), livePort.port).run('exec_l1_live', updated!.action_config, context)).status).toBe('success')
    expect(livePort.run).toHaveBeenCalledTimes(1)
  })
})

describe('run_integration_job — executor state machine (fake DB, fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv(FLAG, 'true')
    // R-69 I6a: the rule-sheet re-check reads the registry only while the project-sheets switch is exactly 'true'.
    vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('gates before anything is leased: switch OFF ⇒ skipped(action_disabled); no port ⇒ failed(port_inactive); binding ≠ creator ⇒ skipped(principal_unauthorized); no identity ⇒ failed', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    vi.stubEnv(FLAG, 'TRUE')
    const off = await harness(db, port).run('exec_off')
    expect(off).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'action_disabled' } })
    vi.stubEnv(FLAG, 'true')
    const noPort = await harness(db, null).run('exec_noport')
    expect(noPort).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'port_inactive' } })
    const mismatch = await harness(db, port).run('exec_mm', CONFIG, { ruleCreatedBy: 'someone_else' })
    expect(mismatch).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'binding_principal_mismatch' } })
    const noIdentity = await harness(db, port).run('exec_noid', CONFIG, {}, null)
    expect(noIdentity).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'identity_required' } })
    // I6a fix (L3): the next two refusals are STEP 1's (live authority) — the rule-sheet re-check PASSED. Step 0.5 and
    // the binding check always name a `cause`; step 1 never does, and its resolver was consulted exactly once.
    const denies = vi.fn(async () => ({ ok: false as const, reason: 'principal_unauthorized' as const }))
    const unauthorized = await harness(db, port, { resolveIntegrationRunPrincipal: denies }).run('exec_unauth')
    expect(unauthorized).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized' } })
    expect(unauthorized.output).not.toHaveProperty('cause')
    expect(denies).toHaveBeenCalledTimes(1)
    const down = vi.fn(async () => ({ ok: false as const, reason: 'authority_unavailable' as const }))
    const unavailable = await harness(db, port, { resolveIntegrationRunPrincipal: down }).run('exec_unavail')
    expect(unavailable).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'authority_unavailable' } })
    expect(unavailable.output).not.toHaveProperty('cause')
    expect(down).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(db.intentRows()).toHaveLength(0)
    expect(db.lease(SCOPE)).toBeUndefined()
  })

  it('happy path: intent → lease → port (the six-field context, projectNo in body.parameters) → fenced Tx B → released; the step output is values-free', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const h = harness(db, port)
    const step = await h.run('exec_1')
    expect(step.status).toBe('success')
    expect(step.output).toMatchObject({ outcome: 'succeeded', reason: 'ready' })
    expect(unitOf(step)).toMatchObject({ projectNo: 'P-1', scopeKey: SCOPE, outcome: 'succeeded', confirmed: true, summary: { status: 'succeeded', canApply: true, counts: { add: 1 } } })
    const input = run.mock.calls[0][0] as IntegrationRunInput
    expect(Object.keys(input.context).sort()).toEqual(['authUser', 'authenticatedTenantId', 'body', 'params', 'query', 'user'])
    expect(input.context).toMatchObject({ authenticatedTenantId: 'tenant_1', query: {}, params: {}, body: { parameters: { projectNo: 'P-1' } }, user: { id: 'svc_user', tenantId: 'tenant_1', permissions: PRINCIPAL.permissions } })
    expect(input.context.authUser).toBe(input.context.user)
    expect(input.job).toEqual({ kind: 'stock_prep_pull', projectNo: 'P-1' })
    expect(input.automation).toEqual({ ruleId: 'rule_1', executionId: 'exec_1', rootExecutionId: 'exec_1' })
    expect((input.context as unknown as Record<string, unknown>).runAs).toBeUndefined()
    const [[, intent]] = db.intentRows()
    expect(intent).toMatchObject({ status: 'sent', lastError: 'ready' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: null, fence: 1 })
    expect(db.lease(SCOPE)!.expires).toBeLessThanOrEqual(Date.now())
    // lock order inside Tx B: lease row FOR UPDATE, then the intent outcome, then the release, then COMMIT
    const txB = db.log.slice(db.log.lastIndexOf('BEGIN'))
    expect(txB).toEqual(['BEGIN', 'lease:lock', 'intent:outcome', 'lease:release', 'COMMIT'])
    expect(h.tracked).toHaveLength(0)
    expect(JSON.stringify(step.output)).not.toMatch(/PART-|token|secret/)
    // the heartbeat was stopped before Tx B: NO heartbeat transaction lands after the step (a late tick would
    // lock the released row, see 0 rows and fire a spurious loss)
    const statementsAfterStep = db.log.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(db.log.length).toBe(statementsAfterStep)
    // a replay of the SAME identity is already applied (ledger says sent), no second port call
    const replay = await h.run('exec_1')
    expect(replay).toMatchObject({ status: 'success', alreadyApplied: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('busy: a held lease ⇒ skipped(busy), the intent row records failed(busy), the port is never called', async () => {
    const db = createFakeJobDb()
    await db.query('INSERT INTO meta_automation_job_leases (scope_key, holder, fence, lease_expires_at, updated_at) VALUES ($1, $2, 1, now() + ($3::int * interval \'1 millisecond\'), now()) ON CONFLICT (scope_key) DO UPDATE SET fence = meta_automation_job_leases.fence + 1 WHERE meta_automation_job_leases.lease_expires_at <= now() RETURNING fence::text AS fence', [SCOPE, 'other_holder', 60_000])
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_busy')
    expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'busy' } })
    expect(unitOf(step)).toMatchObject({ outcome: 'skipped', reason: 'busy', confirmed: true })
    expect(run).not.toHaveBeenCalled()
    expect(db.intentRows()[0][1]).toMatchObject({ status: 'failed', lastError: 'busy' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: 'other_holder', fence: 1 })
  })

  it('T1: timeout with the port still running ⇒ outcome_unknown(timeout_unsettled) now; the lease stays held (a successor is busy) and renewed; Tx B + release happen only when the port settles; then the next trigger runs', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('ignore')
    const h = harness(db, port)
    const first = h.run('exec_1')
    await settle()
    expect(calls).toHaveLength(1)
    const fenceAtStart = db.lease(SCOPE)!.fence
    await vi.advanceTimersByTimeAsync(1_000) // timeout fires: abort, then the 500 ms grace
    expect(calls[0].input.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    const step1 = await first
    expect(step1).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'timeout_unsettled' } })
    expect(unitOf(step1)).toMatchObject({ outcome: 'outcome_unknown', reason: 'timeout_unsettled', cause: 'timeout', confirmed: false })
    expect(h.tracked).toHaveLength(1)
    // not released, fence unchanged, and the heartbeat keeps the lease alive past its TTL
    expect(db.lease(SCOPE)).toMatchObject({ fence: fenceAtStart })
    const renewsBefore = db.log.filter((l) => l === 'lease:renew').length
    await vi.advanceTimersByTimeAsync(4_000)
    expect(db.log.filter((l) => l === 'lease:renew').length).toBeGreaterThan(renewsBefore)
    expect(db.lease(SCOPE)!.expires).toBeGreaterThan(Date.now())
    // a successor (another execution root) is busy — exactly once a trial, not two in parallel
    const step2 = await h.run('exec_2')
    expect(step2).toMatchObject({ status: 'skipped', output: { reason: 'busy' } })
    expect(calls).toHaveLength(1)
    // the port settles: Tx B lands failed(timeout) on the FIRST intent row, the lease is released
    calls[0].resolve({ status: 'succeeded', reason: 'ready', canApply: true })
    await settle()
    await Promise.all(h.tracked)
    expect(db.intentRows().find(([k]) => k.includes('exec_1'))![1]).toMatchObject({ status: 'failed', lastError: 'timeout' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: null, fence: fenceAtStart })
    // the next trigger can run
    const step3 = h.run('exec_3')
    await settle()
    expect(calls).toHaveLength(2)
    calls[1].resolve({ status: 'succeeded', reason: 'ready', canApply: false })
    await settle()
    expect(await step3).toMatchObject({ status: 'success' })
    expect(db.lease(SCOPE)!.fence).toBe(fenceAtStart + 1)
  })

  it('T5a: shutdown abort with a port that honours the signal ⇒ failed(shutdown), Tx B lands, the lease is released, inside the short shutdown grace', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('honor')
    const h = harness(db, port)
    const step = h.run('exec_1')
    await settle()
    expect(calls).toHaveLength(1)
    h.shutdown.abort(new Error('AUTOMATION_SHUTDOWN'))
    await settle()
    const result = await step
    expect(result).toMatchObject({ status: 'failed', output: { outcome: 'failed', reason: 'shutdown' } })
    expect(unitOf(result)).toMatchObject({ outcome: 'failed', reason: 'shutdown', confirmed: true })
    expect(db.intentRows()[0][1]).toMatchObject({ status: 'failed', lastError: 'shutdown' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: null })
    expect(h.tracked).toHaveLength(0)
  })

  it('T5b: shutdown abort with a port that ignores the signal ⇒ timeout_unsettled after the SHORT shutdown grace, nothing released, no Tx B; after a "restart" the scope is busy within the TTL and claimable after it', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('ignore')
    const h = harness(db, port)
    const step = h.run('exec_1')
    await settle()
    h.shutdown.abort(new Error('AUTOMATION_SHUTDOWN'))
    await vi.advanceTimersByTimeAsync(299)
    let resolved = false
    void step.then(() => { resolved = true })
    await settle()
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await step
    expect(result).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'timeout_unsettled' } })
    expect(unitOf(result)).toMatchObject({ cause: 'shutdown' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: expect.stringContaining('exec_1:') })
    expect(db.intentRows()[0][1].status).toBe('pending')
    expect(h.tracked).toHaveLength(1)
    // "the process dies": its heartbeat can no longer reach the database → the lease runs out on the DB clock
    db.setTransactionsFailing(true)
    await vi.advanceTimersByTimeAsync(1_000) // the next tick fails ⇒ the old holder is lost; nothing is released
    expect(db.lease(SCOPE)!.holder).toContain('exec_1:')
    db.setTransactionsFailing(false)
    const restarted = harness(db, fakePort('immediate').port)
    const within = await restarted.run('exec_2')
    expect(within).toMatchObject({ status: 'skipped', output: { reason: 'busy' } })
    await vi.advanceTimersByTimeAsync(3_000) // TTL passes on the clock the fake DB reads
    const after = await restarted.run('exec_3')
    expect(after).toMatchObject({ status: 'success' })
    expect(db.lease(SCOPE)!.fence).toBe(2)
    expect(calls).toHaveLength(1) // the ignoring port was never asked again by the dead holder
  })

  it('T6: the port settles long after the timeout — the heartbeat kept the INTENT lease alive, so a same-identity replay in between skips in-flight and the late Tx B still lands', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('ignore')
    const h = harness(db, port)
    const step = h.run('exec_1')
    await settle()
    await vi.advanceTimersByTimeAsync(1_500) // timeout (1 s) + grace (0.5 s) ⇒ early return
    expect(await step).toMatchObject({ output: { reason: 'timeout_unsettled' } })
    const [[, intent]] = db.intentRows()
    const intentLeaseAtClaim = intent.lease!
    await vi.advanceTimersByTimeAsync(40_000) // longer than the 31 s intent lease the claim minted
    expect(intent.lease).toBeGreaterThan(intentLeaseAtClaim)
    expect(intent.lease).toBeGreaterThan(Date.now())
    // same identity replay (e.g. a durable redelivery): the row is pending with a LIVE lease ⇒ skip_inflight, nothing flipped
    const replay = await h.run('exec_1')
    expect(replay).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'inflight_lease' } })
    expect(intent.status).toBe('pending')
    expect(calls).toHaveLength(1)
    // the original settles: its token is still the row's token ⇒ Tx B confirmed
    calls[0].resolve({ status: 'succeeded', reason: 'ready', canApply: true })
    await settle()
    await Promise.all(h.tracked)
    expect(intent).toMatchObject({ status: 'failed', lastError: 'timeout' })
    expect(db.lease(SCOPE)!.holder).toBeNull()
  })

  it('T11 (executor): a failing renewal fires lostSignal ⇒ the port is aborted, the step is outcome_unknown(lease_lost), NO Tx B and NO release; a checkpoint after the loss rejects', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('honor')
    const h = harness(db, port)
    // a 10 s budget: the FIRST heartbeat tick (1 s) is what fires here, not the step timeout
    const step = h.run('exec_1', { ...CONFIG, timeoutMs: 10_000 })
    await settle()
    const leaseBefore = { ...db.lease(SCOPE)! }
    db.setTransactionsFailing(true) // every renewal transaction now errors (not 0 rows: an error)
    await vi.advanceTimersByTimeAsync(1_000) // first heartbeat tick
    const result = await step
    expect(result).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'lease_lost' } })
    expect(calls[0].input.signal.aborted).toBe(true)
    expect(calls[0].input.signal.reason).toBeInstanceOf(JobLeaseLostError)
    await expect(calls[0].input.checkpoint()).rejects.toBeInstanceOf(JobLeaseLostError)
    expect(db.intentRows()[0][1].status).toBe('pending')
    expect(db.lease(SCOPE)).toEqual(leaseBefore)
    expect(db.log.filter((l) => l === 'intent:outcome')).toHaveLength(0)
    expect(db.log.filter((l) => l === 'lease:release')).toHaveLength(0)
  })

  it('production authority path with NO resolver seam: a transaction that cannot reach the database ⇒ not_started(authority_unavailable), nothing leased, no port call, and ONE values-free warn naming the error class only', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      const unreachable = (async () => { throw Object.assign(new Error('connection refused (a message that carries values)'), { code: 'ECONNREFUSED' }) }) as AutomationDeps['transaction']
      // `resolveIntegrationRunPrincipal: undefined` = the executor's OWN authority transaction (the production path)
      const step = await harness(db, port, { resolveIntegrationRunPrincipal: undefined, transaction: unreachable }).run('exec_unavail_prod')
      expect(step).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'authority_unavailable' } })
      expect(run).not.toHaveBeenCalled()
      expect(db.intentRows()).toHaveLength(0)
      expect(db.lease(SCOPE)).toBeUndefined()
      const authorityWarns = warn.mock.calls.filter(([message]) => /live-authority read failed/.test(String(message)))
      expect(authorityWarns).toHaveLength(1)
      expect(authorityWarns[0][1]).toEqual({ errorClass: 'ECONNREFUSED' })
      expect(JSON.stringify(authorityWarns)).not.toMatch(/carries values|svc_user|tenant_1/)
    } finally {
      warn.mockRestore()
    }
  })

  it('a governed-entry refusal (GovernedEntryAbortError / GOVERNED_ENTRY_ABORTED — the plugin checkpoint seam wrapping an abort or a lease-lost checkpoint) rejected by the port with no local abort is an abort class: failed(aborted), Tx B lands, the lease is released', async () => {
    const db = createFakeJobDb()
    const { port, calls } = fakePort('honor')
    const h = harness(db, port)
    const step = h.run('exec_1')
    await settle()
    expect(calls).toHaveLength(1)
    // the shape plugins/plugin-integration-core/lib/governed-entry-checkpoint.cjs throws: name + code, own non-enumerable tags, the wrapped error as `cause`
    const refusal = Object.assign(new Error('the governed run checkpoint refused its next call'), { name: 'GovernedEntryAbortError', code: 'GOVERNED_ENTRY_ABORTED' })
    Object.defineProperty(refusal, 'errorClass', { value: 'checkpoint_refused', enumerable: false })
    Object.defineProperty(refusal, 'failureStage', { value: 'read', enumerable: false })
    Object.defineProperty(refusal, 'cause', { value: new JobLeaseLostError('verify'), enumerable: false })
    calls[0].reject(refusal)
    await settle()
    const result = await step
    expect(result).toMatchObject({ status: 'failed', output: { outcome: 'failed', reason: 'aborted' } })
    expect(unitOf(result)).toMatchObject({ outcome: 'failed', reason: 'aborted', confirmed: true })
    expect(db.intentRows()[0][1]).toMatchObject({ status: 'failed', lastError: 'aborted' })
    expect(db.lease(SCOPE)).toMatchObject({ holder: null })
    expect(h.tracked).toHaveLength(0)
  })

  it('every project is its own unit, in order; the step aggregates worst-wins and stops starting projects once the budget is spent', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const config = { ...CONFIG, job: { ...CONFIG.job, projectNos: ['P-1', 'P-2', 'P-3'] } }
    const step = await harness(db, port).run('exec_multi', config)
    expect(step.status).toBe('success')
    expect((step.output as { units: unknown[] }).units).toHaveLength(3)
    expect(run.mock.calls.map(([input]) => (input as IntegrationRunInput).job)).toEqual([
      { kind: 'stock_prep_pull', projectNo: 'P-1' }, { kind: 'stock_prep_pull', projectNo: 'P-2' }, { kind: 'stock_prep_pull', projectNo: 'P-3' },
    ])
    expect(db.intentRows()).toHaveLength(3)
    expect([...db.leases.keys()].sort()).toEqual(['stock_prep_pull:tenant_1:P-1', 'stock_prep_pull:tenant_1:P-2', 'stock_prep_pull:tenant_1:P-3'])
  })
})

describe('R-69 I6a — the trigger re-checks the rule sheet before anything is claimed, leased or called', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv(FLAG, 'true')
    vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })
  const nothingHappened = (db: ReturnType<typeof createFakeJobDb>, run: ReturnType<typeof vi.fn>) => {
    expect(run).toHaveBeenCalledTimes(0)
    expect(db.intentRows()).toHaveLength(0)
    expect(db.lease(SCOPE)).toBeUndefined()
  }

  it('the registered sheet runs (control): the port is called once', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_i6a_ok')
    expect(step.status).toBe('success')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('the sheet was ARCHIVED after save => skipped(principal_unauthorized, rule_sheet_unregistered), 0 port calls', async () => {
    const db = createFakeJobDb()
    db.projectTargets.get('sheet_1')!.status = 'archived'
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_i6a_archived')
    expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
    nothingHappened(db, run)
  })
  it('the registration is GONE => rule_sheet_unregistered, 0 port calls', async () => {
    const db = createFakeJobDb()
    db.projectTargets.delete('sheet_1')
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_i6a_gone')
    expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
    nothingHappened(db, run)
  })
  it('the sheet was RE-REGISTERED under another tenant after save => skipped(principal_unauthorized, rule_sheet_tenant_mismatch), 0 port calls', async () => {
    const db = createFakeJobDb()
    db.projectTargets.set('sheet_1', { tenantId: 'tenant_2', projectNo: 'P-1', status: 'active' })
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_i6a_tenant')
    expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_tenant_mismatch' } })
    nothingHappened(db, run)
  })
  it('the project-sheets switch was turned OFF after save => rule_sheet_unregistered, 0 port calls', async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    for (const value of ['false', 'TRUE', '']) {
      vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, value)
      const step = await harness(db, port).run(`exec_i6a_off_${value || 'empty'}`)
      expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
    }
    nothingHappened(db, run)
  })
  it('the registry is UNREADABLE => not_started(authority_unavailable), 0 port calls; the context sheet is the one read', async () => {
    const db = createFakeJobDb()
    db.setRegistryUnreadable('57P01')
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_i6a_unreadable')
    expect(step).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'authority_unavailable' } })
    expect(step.output).not.toHaveProperty('cause')
    nothingHappened(db, run)
    // the rule's OWN sheet (context.sheetId) is the one checked: a context naming another sheet is unregistered
    db.setRegistryUnreadable(null)
    const other = await harness(db, port).run('exec_i6a_other_sheet', CONFIG, { sheetId: 'sheet_2' })
    expect(other).toMatchObject({ status: 'skipped', output: { cause: 'rule_sheet_unregistered' } })
    nothingHappened(db, run)
  })

  // ── fix round (re-review M1): the sheet id is EXACT at the trigger too ──
  const REFUSED_BY_STEP_05 = { status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } }
  it.each(REGISTERED_SHEET_LOOKALIKES)('M1: a rule whose sheet is the registered id plus %s => skipped(principal_unauthorized, rule_sheet_unregistered), 0 port calls; the registry was read with the RAW id', async (_label, lookalike) => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const step = await harness(db, port).run('exec_m1_lookalike', CONFIG, { sheetId: lookalike })
    expect(step).toMatchObject(REFUSED_BY_STEP_05)
    nothingHappened(db, run)
    expect(db.registryReads).toEqual([lookalike])
  })
  it("M1: a registry reader that answers the look-alike id with the REGISTERED sheet's row is still refused at the trigger (the re-compare); the registered sheet itself runs through the same reader", async () => {
    const db = createFakeJobDb()
    const { port, run } = fakePort('immediate')
    const normalizing: AutomationDeps['queryFn'] = (sql, params = []) => db.query(sql, REGISTRY.test(sql) ? [normalizedByReader(params[0])] : params)
    for (const [, lookalike] of REGISTERED_SHEET_LOOKALIKES) {
      expect(await harness(db, port, { queryFn: normalizing }).run('exec_m1_recompare', CONFIG, { sheetId: lookalike })).toMatchObject(REFUSED_BY_STEP_05)
    }
    nothingHappened(db, run)
    // the registry was asked for the TRIMMED id every time: the reader did find, and answer with, sheet_1's own row
    expect(db.registryReads).toEqual(REGISTERED_SHEET_LOOKALIKES.map(() => 'sheet_1'))
    const control = await harness(db, port, { queryFn: normalizing }).run('exec_m1_recompare_ok')
    expect(control.status).toBe('success')
    expect(run).toHaveBeenCalledTimes(1)
  })

  // ── fix round (re-review L3): the POSITION of step 0.5 — after the binding-principal check, before everything else.
  // Each case below runs on an ARCHIVED rule sheet (step 0.5 refuses) and pins ONE boundary.
  const AUTHORITY_UNAVAILABLE = { status: 'failed', output: { outcome: 'not_started', reason: 'authority_unavailable' } }
  const archivedSheetDb = () => {
    const db = createFakeJobDb()
    db.projectTargets.get('sheet_1')!.status = 'archived'
    return db
  }
  it('position: step 0.5 answers BEFORE the port lookup — the port factory is never called, and a missing port does not answer first', async () => {
    const db = archivedSheetDb()
    const { port, run } = fakePort('immediate')
    const portFactory = vi.fn(() => port)
    expect(await harness(db, port, { integrationRunPort: portFactory }).run('exec_pos_port')).toMatchObject(REFUSED_BY_STEP_05)
    expect(portFactory).toHaveBeenCalledTimes(0)
    expect(await harness(db, null).run('exec_pos_noport')).toMatchObject(REFUSED_BY_STEP_05) // not failed(port_inactive)
    // an UNREADABLE registry stops at the same place
    db.setRegistryUnreadable('57P01')
    expect(await harness(db, port, { integrationRunPort: portFactory }).run('exec_pos_port_unreadable')).toMatchObject(AUTHORITY_UNAVAILABLE)
    expect(await harness(db, null).run('exec_pos_noport_unreadable')).toMatchObject(AUTHORITY_UNAVAILABLE) // not failed(port_inactive)
    expect(portFactory).toHaveBeenCalledTimes(0)
    nothingHappened(db, run)
  })
  it('position: step 0.5 answers BEFORE the transaction seam and live authority — neither the resolver seam nor the production authority transaction is reached', async () => {
    const db = archivedSheetDb()
    const { port, run } = fakePort('immediate')
    const transaction = vi.fn(db.transaction)
    const resolver = vi.fn(async () => ({ ok: true as const, user: PRINCIPAL }))
    expect(await harness(db, port, { transaction, resolveIntegrationRunPrincipal: resolver }).run('exec_pos_seam')).toMatchObject(REFUSED_BY_STEP_05)
    expect(resolver).toHaveBeenCalledTimes(0)
    // the production path (no resolver seam) would open its own authority transaction
    expect(await harness(db, port, { transaction, resolveIntegrationRunPrincipal: undefined }).run('exec_pos_prod')).toMatchObject(REFUSED_BY_STEP_05)
    expect(transaction).toHaveBeenCalledTimes(0)
    // precedence: a later stage that WOULD refuse on its own does not answer first
    expect(await harness(db, port, { transaction: undefined }).run('exec_pos_notx')).toMatchObject(REFUSED_BY_STEP_05) // not failed(transaction_seam_required)
    expect(await harness(db, port, { resolveIntegrationRunPrincipal: async () => ({ ok: false, reason: 'authority_unavailable' }) }).run('exec_pos_authdown')).toMatchObject(REFUSED_BY_STEP_05) // not failed(authority_unavailable)
    // an UNREADABLE registry ends exactly like step 1's authority_unavailable — only the call counts tell the two apart
    db.setRegistryUnreadable('57P01')
    expect(await harness(db, port, { transaction, resolveIntegrationRunPrincipal: resolver }).run('exec_pos_unreadable')).toMatchObject(AUTHORITY_UNAVAILABLE)
    expect(resolver).toHaveBeenCalledTimes(0)
    expect(transaction).toHaveBeenCalledTimes(0)
    nothingHappened(db, run)
  })
  it('position: step 0.5 answers BEFORE the intent claim and the job lease — not one statement reaches the ledgers', async () => {
    const db = archivedSheetDb()
    const { port, run } = fakePort('immediate')
    expect(await harness(db, port).run('exec_pos_ledgers')).toMatchObject(REFUSED_BY_STEP_05)
    db.setRegistryUnreadable('57P01')
    expect(await harness(db, port).run('exec_pos_ledgers_unreadable')).toMatchObject(AUTHORITY_UNAVAILABLE)
    expect(db.log).toEqual([]) // no BEGIN, no intent:claim, no lease:claim — nothing at all
    nothingHappened(db, run)
    expect(db.registryReads).toEqual(['sheet_1', 'sheet_1'])
    // control: on the registered sheet the same harness does claim, lease and call
    db.setRegistryUnreadable(null)
    db.projectTargets.get('sheet_1')!.status = 'active'
    expect((await harness(db, port).run('exec_pos_ledgers_ok')).status).toBe('success')
    expect(db.log).toEqual(expect.arrayContaining(['intent:claim', 'lease:claim']))
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('position: the gates BEFORE step 0.5 answer first and never read the registry — action switch off, unparsable config, no identity, binding ≠ creator', async () => {
    const db = archivedSheetDb() // step 0.5 WOULD refuse every run below
    const { port, run } = fakePort('immediate')
    vi.stubEnv(FLAG, 'false')
    expect(await harness(db, port).run('exec_pre_off')).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'action_disabled' } })
    vi.stubEnv(FLAG, 'true')
    expect(await harness(db, port).run('exec_pre_config', { ...CONFIG, binding: undefined })).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'config_invalid' } })
    expect(await harness(db, port).run('exec_pre_identity', CONFIG, {}, null)).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'identity_required' } })
    expect(await harness(db, port).run('exec_pre_binding', CONFIG, { ruleCreatedBy: 'someone_else' })).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'binding_principal_mismatch' } })
    expect(db.registryReads).toEqual([])
    nothingHappened(db, run)
    // control: once those four gates pass, the same harness does reach step 0.5
    expect(await harness(db, port).run('exec_pre_reached')).toMatchObject(REFUSED_BY_STEP_05)
    expect(db.registryReads).toEqual(['sheet_1'])
  })
})

describe('R-69 I6a fix (re-review M1) — the rule-sheet guard called directly: the sheet id is exact', () => {
  const ON = { [STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv
  const REGISTERED_ROW = { sheet_id: 'sheet_1', project_no: 'P-1', status: 'active', object_id: 'obj_1', tenant_id: 'tenant_1' }
  const UNREGISTERED = { ok: false, refusal: 'unregistered' }

  it('an empty or non-string sheet id is unregistered WITHOUT a registry read', async () => {
    const query = vi.fn(async () => ({ rows: [REGISTERED_ROW], rowCount: 1 }))
    for (const sheetId of ['', undefined, null, 7, true, {}, ['sheet_1']]) {
      expect(await checkRunIntegrationJobRuleSheet(query, { sheetId, tenantId: 'tenant_1' }, ON)).toEqual(UNREGISTERED)
    }
    expect(query).not.toHaveBeenCalled()
  })
  it("a reader that answers EVERY parameter with the registered sheet's row: only the exact id passes — whatever the read matched on, the answered row must be this sheet's", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [REGISTERED_ROW], rowCount: 1 }))
    const verdict = (sheetId: unknown) => checkRunIntegrationJobRuleSheet(query, { sheetId, tenantId: 'tenant_1', projectNos: ['P-1'] }, ON)
    expect(await verdict('sheet_1')).toEqual({ ok: true })
    const others = [...REGISTERED_SHEET_LOOKALIKES.map(([, sheetId]) => sheetId), 'SHEET_1', 'Sheet_1', 'sheet_1x', 'xsheet_1', 'sheet_', '   ']
    for (const sheetId of others) expect(await verdict(sheetId)).toEqual(UNREGISTERED)
    // each of them WAS read — with the id exactly as given, nothing normalized on the way
    expect(query.mock.calls.map(([, params]) => params)).toEqual([['sheet_1'], ...others.map((sheetId) => [sheetId])])
  })
  it("a row that names no sheet id, or a non-string one, is not this sheet's — even when the exact id was asked for", async () => {
    for (const sheet_id of [undefined, null, 7, ['sheet_1'], { toString: () => 'sheet_1' }]) {
      const query = vi.fn(async () => ({ rows: [{ ...REGISTERED_ROW, sheet_id }], rowCount: 1 }))
      expect(await checkRunIntegrationJobRuleSheet(query, { sheetId: 'sheet_1', tenantId: 'tenant_1' }, ON)).toEqual(UNREGISTERED)
      expect(query).toHaveBeenCalledTimes(1)
    }
    // control: the same row with its real id passes
    const control = vi.fn(async () => ({ rows: [REGISTERED_ROW], rowCount: 1 }))
    expect(await checkRunIntegrationJobRuleSheet(control, { sheetId: 'sheet_1', tenantId: 'tenant_1' }, ON)).toEqual({ ok: true })
  })
})
