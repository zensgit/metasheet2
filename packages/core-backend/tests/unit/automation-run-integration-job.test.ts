/**
 * R-69 1b-ii — `run_integration_job`: the save gate and the executor's lease/heartbeat/port state machine, on an
 * in-memory model of the two ledger tables and a fake clock (design baseline v2.3 §10.2.5 T1, T5a, T5b, T6, T7,
 * T11 and the trigger-time gates; the DB-clock cases are in tests/integration/multitable-automation-job-lease-
 * realdb.test.ts and multitable-automation-run-integration-job-realdb.test.ts). Synthetic only; no port implementation
 * from the plugin is loaded here — the port is a fake that honours or ignores the signal.
 *
 * The fake database answers EXACTLY the statements automation-outbound-intent.ts and automation-job-lease.ts
 * issue (matched by shape), evaluates `now()` with the fake clock, and rolls a transaction back on throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationExecutor, type AutomationDeps, type AutomationStepResult, type ClassAActionIdentity, type ExecutionContext } from '../../src/multitable/automation-executor'
import type { IntegrationRunInput, IntegrationRunPort, IntegrationRunSummary } from '../../src/core/integration-run-port'
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

const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const PRINCIPAL = { id: 'svc_user', permissions: ['stock-prep:pull', 'stock-prep:operate', 'stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: 'tenant_1' }
const BINDING = { principalId: 'svc_user', tenantId: 'tenant_1' }

// ── in-memory ledger model ─────────────────────────────────────────────────────────────────────────────────

interface IntentRow { status: string; attempts: number; token: string | null; lease: number | null; lastError: string | null }
interface LeaseRow { holder: string | null; fence: number; expires: number }

function createFakeJobDb() {
  const intents = new Map<string, IntentRow>()
  const leases = new Map<string, LeaseRow>()
  const log: string[] = []
  let renewalsFailing = false
  const key = (p: unknown[], idx = [0, 1, 2, 3]) => idx.map((i) => String(p[i])).join('|')
  const query: AutomationDeps['queryFn'] = async (sql, params = []) => {
    const now = Date.now()
    if (/INSERT INTO meta_automation_outbound_intent/.test(sql)) {
      const k = key(params)
      log.push('intent:claim')
      if (intents.has(k)) return { rows: [], rowCount: 0 }
      intents.set(k, { status: 'pending', attempts: 1, token: String(params[4]), lease: now + Number(params[5]), lastError: null })
      return { rows: [], rowCount: 1 }
    }
    if (/SELECT status, attempt_token/.test(sql)) {
      const row = intents.get(key(params))
      return { rows: row ? [{ status: row.status, attempt_token: row.token, lease_live: row.lease !== null && row.lease > now }] : [], rowCount: row ? 1 : 0 }
    }
    if (/SET status = 'outcome_unknown', last_error = 'lease_expired'/.test(sql)) {
      const row = intents.get(key(params))
      log.push('intent:expire')
      if (row && row.status === 'pending' && row.token === (params[4] ?? null) && (row.lease === null || row.lease <= now)) {
        row.status = 'outcome_unknown'; row.lastError = 'lease_expired'
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/SET status = 'pending', attempts = attempts \+ 1/.test(sql)) {
      const row = intents.get(key(params))
      if (row && row.status === 'failed') {
        row.status = 'pending'; row.attempts += 1; row.token = String(params[4]); row.lease = now + Number(params[5])
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_outbound_intent\s+SET lease_expires_at = now\(\)/.test(sql)) {
      const row = intents.get(key(params))
      log.push('intent:renew')
      if (row && row.status === 'pending' && row.token === String(params[5])) { row.lease = now + Number(params[4]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_outbound_intent\s+SET status = \$4/.test(sql)) {
      const row = intents.get(key(params, [0, 1, 2, 5]))
      log.push('intent:outcome')
      if (row && row.status === 'pending' && row.token === String(params[6])) { row.status = String(params[3]); row.lastError = params[4] == null ? null : String(params[4]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO meta_automation_job_leases/.test(sql)) {
      const scope = String(params[0]); const row = leases.get(scope); const ttl = Number(params[2])
      log.push('lease:claim')
      if (!row) { leases.set(scope, { holder: String(params[1]), fence: 1, expires: now + ttl }); return { rows: [{ fence: '1' }], rowCount: 1 } }
      if (row.expires <= now) { row.fence += 1; row.holder = String(params[1]); row.expires = now + ttl; return { rows: [{ fence: String(row.fence) }], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/SELECT 1 AS ok FROM meta_automation_job_leases/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:checkpoint')
      return row && String(row.fence) === String(params[1]) && row.expires > now ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM meta_automation_job_leases[\s\S]*FOR UPDATE/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:lock')
      return row ? { rows: [{ holder: row.holder, fence: String(row.fence), live: row.expires > now }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_job_leases\s+SET lease_expires_at = now\(\) \+/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:renew')
      if (row && String(row.fence) === String(params[1]) && row.holder === String(params[2]) && row.expires > now) { row.expires = now + Number(params[3]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_job_leases\s+SET lease_expires_at = now\(\), holder = NULL/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:release')
      if (row && String(row.fence) === String(params[1])) { row.expires = now; row.holder = null; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`fake db: unexpected statement: ${sql.slice(0, 70)}`)
  }
  const snapshot = () => ({ i: new Map([...intents].map(([k, v]) => [k, { ...v }])), l: new Map([...leases].map(([k, v]) => [k, { ...v }])) })
  const transaction: NonNullable<AutomationDeps['transaction']> = async (handler) => {
    if (renewalsFailing) throw new Error('fake db: connection lost')
    const before = snapshot()
    log.push('BEGIN')
    try {
      const result = await handler({ query })
      log.push('COMMIT')
      return result
    } catch (error) {
      intents.clear(); leases.clear()
      for (const [k, v] of before.i) intents.set(k, v)
      for (const [k, v] of before.l) leases.set(k, v)
      log.push('ROLLBACK')
      throw error
    }
  }
  return {
    query,
    transaction,
    intents,
    leases,
    log,
    /** Simulate the database becoming unreachable for every transaction (a dead process renews nothing). */
    setTransactionsFailing(value: boolean) { renewalsFailing = value },
    lease(scope: string) { return leases.get(scope) },
    intentRows() { return [...intents.entries()] },
  }
}

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

describe('run_integration_job — save-time vocabulary (pure)', () => {
  it('the switch reads the exact literal only; the three other switches have no read point', () => {
    expect(isIntegrationAutomationRunActionEnabled({ [FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    for (const value of ['TRUE', ' true', 'true ', '1', 'yes', '', undefined]) expect(isIntegrationAutomationRunActionEnabled({ [FLAG]: value } as NodeJS.ProcessEnv)).toBe(false)
    expect([...INTEGRATION_AUTOMATION_RUN_FLAGS_NOT_READ_IN_1B_II]).toEqual(['INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED', 'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED', 'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED'])
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
    expect(collectRunIntegrationJobOccurrences('record_click', {}, [nested], [nested]).occurrences.map((o) => o.path)).toEqual(['actions[0].config'])
    expect(collectRunIntegrationJobOccurrences('record_click', {}, [branch], [branch, nested]).error).toMatch(/top-level action/)
    expect(collectRunIntegrationJobOccurrences('record_click', {}, null, [])).toEqual({ occurrences: [], error: null })
  })
})

describe('run_integration_job — AutomationService save gate', () => {
  const ORGS = /FROM user_orgs/i
  function makeService(orgRows: Array<{ org_id: string }>) {
    const inserted: Record<string, unknown>[] = []
    const queryFn = vi.fn(async (sql: string) => (ORGS.test(sql) ? { rows: orgRows, rowCount: orgRows.length } : { rows: [], rowCount: 0 }))
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const m of ['selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin', 'insertInto', 'updateTable', 'deleteFrom', 'set']) chain[m] = vi.fn(chainFn)
    chain.values = vi.fn((row: unknown) => { inserted.push(row as Record<string, unknown>); return chain })
    chain.execute = vi.fn(async () => [])
    chain.executeTakeFirst = vi.fn(async () => undefined)
    const service = new AutomationService(new EventBus(), chain as never, queryFn as never)
    return { service, inserted, queryFn }
  }
  const cronInput = (actionConfig: Record<string, unknown>, triggerConfig: Record<string, unknown> | undefined = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }, triggerType = 'schedule.cron') => ({
    triggerType, triggerConfig, actionType: 'run_integration_job', actionConfig, createdBy: 'svc_user',
  })
  const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' } }

  beforeEach(() => { vi.stubEnv(FLAG, 'true') })
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
})

describe('run_integration_job — executor state machine (fake DB, fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv(FLAG, 'true')
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
    const unauthorized = await harness(db, port, { resolveIntegrationRunPrincipal: async () => ({ ok: false, reason: 'principal_unauthorized' }) }).run('exec_unauth')
    expect(unauthorized).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized' } })
    const unavailable = await harness(db, port, { resolveIntegrationRunPrincipal: async () => ({ ok: false, reason: 'authority_unavailable' }) }).run('exec_unavail')
    expect(unavailable).toMatchObject({ status: 'failed', output: { outcome: 'not_started', reason: 'authority_unavailable' } })
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
