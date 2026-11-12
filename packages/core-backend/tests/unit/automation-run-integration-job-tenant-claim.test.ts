/**
 * R-69 1b-ii / 1c — the run_integration_job port context against the staged tenant-claim door
 * (MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED, default off; set to 'true' here for these tests only).
 *
 * With the door ON, the governed stock-prep pull's access check (plugin http-routes.cjs requireTableActionAccess
 * → assertVerifiedTenantClaim) asks for a verified tenant claim on the request. The automation path has no
 * request: the core builds the context (buildIntegrationRunPrincipalContext) and sets `authenticatedTenantId` to
 * the binding tenant. Pinned here, on the REAL builder, the REAL governed entry (the plugin's project-sheet harness,
 * synthetic tenant / project / BOM) and the REAL plugin port:
 *   (1) the built context (authenticatedTenantId = the binding tenant) passes the access check — on the legacy
 *       `integration:read` branch (where the claim door sits) and on the stock-prep operator branch;
 *   (2) an EMPTY authenticatedTenantId is refused 403 OPERATOR_SCOPE_TENANT_REQUIRED; with the door off the same
 *       context passes the door and is refused further down by the tenant resolver (400 TENANT_REQUIRED);
 *   (3) how the chain RECORDS (2): the plugin port classifies the 403 as skipped(principal_unauthorized) with
 *       errorClass OPERATOR_SCOPE_TENANT_REQUIRED, and I5's run_integration_job step and its run_finished summary
 *       carry the same — status `skipped`, not `failed`. (Door off, the 400 is recorded failed(TENANT_REQUIRED).)
 *       Cases (2) and (3) are the legacy `integration:read` branch, where the door sits;
 *   (4) on the stock-prep OPERATOR branch an empty claim is refused by the operator scope itself (its own error
 *       class, 403 OPERATOR_SCOPE_TENANT_REQUIRED) whatever the door says, and the port records it `failed`: the
 *       port maps only an HttpRouteError 401/403 to skipped. So the record of an empty claim depends on the branch.
 * Synthetic only; nothing is written, the source is the harness's fake adapter.
 */
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IntegrationRunPort, IntegrationRunSummary } from '../../src/core/integration-run-port'
import {
  clearIntegrationRunFinishedSinkForTest,
  registerIntegrationRunFinishedSink,
  type IntegrationRunFinishedEvent,
} from '../../src/core/integration-run-events'
import { buildIntegrationRunPrincipalContext } from '../../src/integration/automation-run-authority'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationStepResult,
  type ClassAActionIdentity,
  type ExecutionContext,
} from '../../src/multitable/automation-executor'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'

const requireFromTest = createRequire(import.meta.url)
const PLUGIN = '../../../../plugins/plugin-integration-core'
type GovernedEntries = { runGovernedStockPrepPull: (...args: unknown[]) => Promise<unknown>; runGovernedPipeline: (...args: unknown[]) => Promise<unknown> }
const httpRoutes = requireFromTest(`${PLUGIN}/lib/http-routes.cjs`) as { createHandlers(services: unknown, options: unknown): { governedEntries: GovernedEntries } }
const harness = requireFromTest(`${PLUGIN}/__tests__/support/stock-preparation-project-sheet-harness.cjs`) as {
  mountProjectSheetRoutes(options: Record<string, unknown>): { services: unknown; context: unknown; seedRegistryRow(no: string): unknown; restore(): void }
}
const { createIntegrationRunPort } = requireFromTest(`${PLUGIN}/lib/integration-run-port.cjs`) as {
  createIntegrationRunPort(deps: { governedEntries: GovernedEntries }): { run(input: Record<string, unknown>): Promise<IntegrationRunSummary> }
}
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = requireFromTest(`${PLUGIN}/lib/stock-preparation-workbench-access.cjs`) as Record<string, string>

const CLAIM_FLAG = 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'
const ACTION_FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
const TENANT = 'tenant-r69-claim'
const PROJECT = 'PRJ-R69-CLAIM'
const SHEET = 'sheet_claim'
const silent = Object.freeze({ info() {}, warn() {}, error() {} })
/** The legacy branch (integration:read) is where the claim door sits; the operator branch is the stock-prep vocabulary. */
const LEGACY = { id: 'u_r69_claim_legacy', permissions: ['integration:read', 'workflow:write'], roles: [] as string[], role: 'user', tenantId: TENANT }
const OPERATOR = { id: 'u_r69_claim_operator', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL, 'workflow:write'], roles: [] as string[], role: 'user', tenantId: TENANT }
const JOB = { kind: 'stock_prep_pull', projectNo: PROJECT }
const AUTOMATION = { ruleId: 'r', executionId: 'e', rootExecutionId: 'e' }

function mount() {
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, logger: silent })
  h.seedRegistryRow(PROJECT)
  const handlers = httpRoutes.createHandlers(h.services, { context: h.context, logger: silent })
  return { governedEntries: handlers.governedEntries, restore: () => h.restore() }
}

/** The context exactly as the executor builds it (automation-executor: buildIntegrationRunPrincipalContext(principal, { parameters: { projectNo } })). */
const contextFor = (user: typeof LEGACY) => buildIntegrationRunPrincipalContext(user, { parameters: { projectNo: PROJECT } })

async function settle(promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: { name?: string; status?: number; code?: string } }> {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, error: error as { name?: string; status?: number; code?: string } } }
}

describe('run_integration_job port context vs the tenant-claim door (MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED)', () => {
  let m: ReturnType<typeof mount>
  beforeEach(() => { m = mount() })
  afterEach(() => { m.restore(); vi.unstubAllEnvs() })

  it('(1) door ON: the built context carries the binding tenant as its claim and passes the governed pull\'s access check, on the legacy and on the operator branch', async () => {
    vi.stubEnv(CLAIM_FLAG, 'true')
    for (const user of [LEGACY, OPERATOR]) {
      const context = contextFor(user)
      expect(context.authenticatedTenantId).toBe(TENANT)
      const direct = await settle(m.governedEntries.runGovernedStockPrepPull(context, JOB))
      expect(direct.ok ? 'passed' : `${direct.error.status} ${direct.error.code}`, user.id).toBe('passed')
      const summary = await createIntegrationRunPort({ governedEntries: m.governedEntries }).run({ context: contextFor(user), job: JOB, automation: AUTOMATION })
      expect(['succeeded', 'held'], `${user.id}: ${summary.status}`).toContain(summary.status)
    }
  }, 20_000)

  it('(2) door ON: an EMPTY authenticatedTenantId is refused 403 OPERATOR_SCOPE_TENANT_REQUIRED; door OFF: the same context passes the check (the door is what refuses it)', async () => {
    const tenantless = { ...LEGACY, tenantId: '' }
    expect(contextFor(tenantless).authenticatedTenantId).toBe('')
    vi.stubEnv(CLAIM_FLAG, 'true')
    const refused = await settle(m.governedEntries.runGovernedStockPrepPull(contextFor(tenantless), JOB))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect([refused.error.name, refused.error.status, refused.error.code]).toEqual(['HttpRouteError', 403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
    vi.stubEnv(CLAIM_FLAG, '')
    const open = await settle(m.governedEntries.runGovernedStockPrepPull(contextFor(tenantless), JOB))
    // door off: the claim door does not refuse; the tenant resolver further down does (400 TENANT_REQUIRED)
    expect(open.ok ? 'no refusal' : [open.error.status, open.error.code]).toEqual([400, 'TENANT_REQUIRED'])
  }, 20_000)

  it('(3) door ON, empty claim: the plugin port records skipped(principal_unauthorized, errorClass OPERATOR_SCOPE_TENANT_REQUIRED); the I5 step and its run_finished summary say skipped, not failed', async () => {
    vi.stubEnv(CLAIM_FLAG, 'true')
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
    const tenantless = { ...LEGACY, tenantId: '' }
    // the plugin port alone
    const summary = await createIntegrationRunPort({ governedEntries: m.governedEntries }).run({ context: contextFor(tenantless), job: JOB, automation: AUTOMATION })
    expect(summary).toEqual({ status: 'skipped', reason: 'principal_unauthorized', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED', durationMs: summary.durationMs })
    // contrast, door OFF: the same context reaches the tenant resolver's 400, which the port records as failed
    vi.stubEnv(CLAIM_FLAG, '')
    const doorOff = await createIntegrationRunPort({ governedEntries: m.governedEntries }).run({ context: contextFor(tenantless), job: JOB, automation: AUTOMATION })
    expect(doorOff).toEqual({ status: 'failed', errorClass: 'TENANT_REQUIRED', failureStage: 'authorize', durationMs: doorOff.durationMs })
    vi.stubEnv(CLAIM_FLAG, 'true')
    // the real run_integration_job step (fake ledgers), its principal resolved to the empty-claim user, the real port
    const { step, events } = await runStepFor(m.governedEntries, tenantless)
    const unit = (step.output as { units: Array<Record<string, unknown>> }).units[0]
    expect([step.status, (step.output as { outcome?: unknown }).outcome]).toEqual(['skipped', 'skipped'])
    expect(unit).toMatchObject({ projectNo: PROJECT, outcome: 'skipped', reason: 'principal_unauthorized' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'principal_unauthorized', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED', job: { kind: 'stock_prep_pull', projectNo: PROJECT } })
  }, 20_000)

  it('(4) the OPERATOR branch (stock-prep codes, no integration:read) is different: an empty claim is refused by the operator scope itself (its own error class, 403 OPERATOR_SCOPE_TENANT_REQUIRED) whatever the door says, and the port records it FAILED (only an HttpRouteError 401/403 maps to skipped)', async () => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
    const tenantless = { ...OPERATOR, tenantId: '' }
    for (const door of ['true', '']) {
      vi.stubEnv(CLAIM_FLAG, door)
      const refused = await settle(m.governedEntries.runGovernedStockPrepPull(contextFor(tenantless), JOB))
      expect(refused.ok ? 'passed' : [refused.error.name, refused.error.status, refused.error.code], 'door=' + door).toEqual(['StockPreparationOperatorScopeError', 403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
      const summary = await createIntegrationRunPort({ governedEntries: m.governedEntries }).run({ context: contextFor(tenantless), job: JOB, automation: AUTOMATION })
      expect(summary, 'door=' + door).toEqual({ status: 'failed', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED', failureStage: 'read', durationMs: summary.durationMs })
    }
    vi.stubEnv(CLAIM_FLAG, 'true')
    const { step, events } = await runStepFor(m.governedEntries, tenantless)
    expect((step.output as { units: Array<Record<string, unknown>> }).units[0]).toMatchObject({ projectNo: PROJECT, outcome: 'failed' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'failed', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED' })
  }, 20_000)
})

/** One run_integration_job step on the real executor (fake ledgers), its principal resolved to the given user, the real plugin port. */
async function runStepFor(governedEntries: GovernedEntries, user: typeof LEGACY): Promise<{ step: AutomationStepResult; events: IntegrationRunFinishedEvent[] }> {
  const events: IntegrationRunFinishedEvent[] = []
  registerIntegrationRunFinishedSink('test-claim', async (event) => { events.push(event) })
  try {
    const pluginPort = createIntegrationRunPort({ governedEntries })
    const port: IntegrationRunPort = { run: (input) => pluginPort.run({ context: input.context, job: input.job, signal: input.signal, checkpoint: input.checkpoint, automation: input.automation }) }
    // R-69 I6a: the executor re-checks the rule sheet on every trigger, so the step's sheet is the tenant's registered one.
    const db = createFakeJobDb({ projectTargets: { [SHEET]: { tenantId: TENANT, projectNo: PROJECT, status: 'active' } } })
    const tracked: Promise<void>[] = []
    const exec = new AutomationExecutor({
      eventBus: new EventBus(),
      queryFn: db.query,
      transaction: db.transaction,
      integrationRunPort: () => port,
      shutdownSignal: new AbortController().signal,
      trackIntegrationJobTask: (task) => { tracked.push(task) },
      resolveIntegrationRunPrincipal: async () => ({ ok: true, user }),
      integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
    } as AutomationDeps)
    const config = { job: { kind: 'stock_prep_pull', projectNos: [PROJECT], applyMode: 'dry_run_only' }, timeoutMs: 5_000, binding: { principalId: user.id, tenantId: TENANT } }
    const context: ExecutionContext = { executionId: 'exec_claim', ruleId: 'rule_claim', sheetId: SHEET, recordId: '', recordData: {}, ruleCreatedBy: user.id, triggerEvent: {}, rootExecutionId: 'exec_claim' }
    const identity: ClassAActionIdentity = { structuralPath: '0', rootExecutionId: 'exec_claim' }
    const step = await (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i?: ClassAActionIdentity): Promise<AutomationStepResult> })
      .executeSingleAction({ type: 'run_integration_job', config }, context, identity)
    await Promise.all(tracked)
    return { step, events }
  } finally {
    clearIntegrationRunFinishedSinkForTest()
  }
}
