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
 *       context passes that check (the door is what refuses it);
 *   (3) how the chain RECORDS (2): the plugin port classifies the 403 as skipped(principal_unauthorized) with
 *       errorClass OPERATOR_SCOPE_TENANT_REQUIRED, and I5's run_integration_job step and its run_finished summary
 *       carry the same — status `skipped`, not `failed`.
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
  })

  it('(2) door ON: an EMPTY authenticatedTenantId is refused 403 OPERATOR_SCOPE_TENANT_REQUIRED; door OFF: the same context passes the check (the door is what refuses it)', async () => {
    const tenantless = { ...LEGACY, tenantId: '' }
    expect(contextFor(tenantless).authenticatedTenantId).toBe('')
    vi.stubEnv(CLAIM_FLAG, 'true')
    const refused = await settle(m.governedEntries.runGovernedStockPrepPull(contextFor(tenantless), JOB))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect([refused.error.name, refused.error.status, refused.error.code]).toEqual(['HttpRouteError', 403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
    vi.stubEnv(CLAIM_FLAG, '')
    const open = await settle(m.governedEntries.runGovernedStockPrepPull(contextFor(tenantless), JOB))
    expect(open.ok ? 'no refusal' : open.error.code).not.toBe('OPERATOR_SCOPE_TENANT_REQUIRED')
  })

  it('(3) door ON, empty claim: the plugin port records skipped(principal_unauthorized, errorClass OPERATOR_SCOPE_TENANT_REQUIRED); the I5 step and its run_finished summary say skipped, not failed', async () => {
    vi.stubEnv(CLAIM_FLAG, 'true')
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
    const tenantless = { ...LEGACY, tenantId: '' }
    // the plugin port alone
    const summary = await createIntegrationRunPort({ governedEntries: m.governedEntries }).run({ context: contextFor(tenantless), job: JOB, automation: AUTOMATION })
    expect(summary).toEqual({ status: 'skipped', reason: 'principal_unauthorized', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED', durationMs: summary.durationMs })
    // the real run_integration_job step (fake ledgers), its principal resolved to the empty-claim user, the real port
    const events: IntegrationRunFinishedEvent[] = []
    registerIntegrationRunFinishedSink('test-claim', async (event) => { events.push(event) })
    try {
      const pluginPort = createIntegrationRunPort({ governedEntries: m.governedEntries })
      const port: IntegrationRunPort = { run: (input) => pluginPort.run({ context: input.context, job: input.job, signal: input.signal, checkpoint: input.checkpoint, automation: input.automation }) }
      const db = createFakeJobDb()
      const tracked: Promise<void>[] = []
      const exec = new AutomationExecutor({
        eventBus: new EventBus(),
        queryFn: db.query,
        transaction: db.transaction,
        integrationRunPort: () => port,
        shutdownSignal: new AbortController().signal,
        trackIntegrationJobTask: (task) => { tracked.push(task) },
        resolveIntegrationRunPrincipal: async () => ({ ok: true, user: tenantless }),
        integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
      } as AutomationDeps)
      const config = { job: { kind: 'stock_prep_pull', projectNos: [PROJECT], applyMode: 'dry_run_only' }, timeoutMs: 5_000, binding: { principalId: LEGACY.id, tenantId: TENANT } }
      const context: ExecutionContext = { executionId: 'exec_claim', ruleId: 'rule_claim', sheetId: 'sheet_claim', recordId: '', recordData: {}, ruleCreatedBy: LEGACY.id, triggerEvent: {}, rootExecutionId: 'exec_claim' }
      const identity: ClassAActionIdentity = { structuralPath: '0', rootExecutionId: 'exec_claim' }
      const step = await (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i?: ClassAActionIdentity): Promise<AutomationStepResult> })
        .executeSingleAction({ type: 'run_integration_job', config }, context, identity)
      await Promise.all(tracked)
      const unit = (step.output as { units: Array<Record<string, unknown>> }).units[0]
      expect([step.status, (step.output as { outcome?: unknown }).outcome]).toEqual(['skipped', 'skipped'])
      expect(unit).toMatchObject({ projectNo: PROJECT, outcome: 'skipped', reason: 'principal_unauthorized' })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ status: 'skipped', reason: 'principal_unauthorized', errorClass: 'OPERATOR_SCOPE_TENANT_REQUIRED', job: { kind: 'stock_prep_pull', projectNo: PROJECT } })
    } finally {
      clearIntegrationRunFinishedSinkForTest()
    }
  })
})
