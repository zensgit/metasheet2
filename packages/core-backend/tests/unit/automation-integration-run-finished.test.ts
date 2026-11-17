/**
 * R-69 1c — `integration.run_finished` (Bridge 2): the trigger vocabulary, the closed-key publish port, the action
 * layer's exactly-one-summary-per-job emit, the job-keyed dispatch with its per-rule exactly-once claim, the save
 * gate and the durable leg (ADR adr-automation-pipeline-bridge-20261103 §4; design baseline v2.3 §10.2, §10.2.4 1c
 * rows). Synthetic only: the port is a fake, the ledgers are the in-memory model of tests/utils, no plugin is loaded,
 * no message is sent. R-69 is OPEN: dry-run only, default OFF.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationStepResult,
  type ClassAActionIdentity,
  type ExecutionContext,
} from '../../src/multitable/automation-executor'
import type { IntegrationRunInput, IntegrationRunPort, IntegrationRunSummary } from '../../src/core/integration-run-port'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  ALL_TRIGGER_TYPES,
  INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES,
  INTEGRATION_RUN_FINISHED_HELD_REASONS,
  INTEGRATION_RUN_FINISHED_REASONS,
  INTEGRATION_RUN_FINISHED_REASONS_ADDED_IN_1C,
  INTEGRATION_RUN_FINISHED_SKIPPED_REASONS,
  INTEGRATION_RUN_FINISHED_STATUSES,
  INTEGRATION_RUN_JOB_ID_SHAPE,
  TRIGGER_TYPE_BY_EVENT,
  integrationRunFinishedConfiguredStatuses,
  validateIntegrationRunFinishedTriggerConfig,
} from '../../src/multitable/automation-triggers'
import {
  INTEGRATION_RUN_FINISHED_COUNT_KEYS,
  INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS,
  INTEGRATION_RUN_FINISHED_EVENT_KEYS,
  clearIntegrationRunFinishedSinkForTest,
  deriveAutomationRunFinishedEventId,
  publishIntegrationRunFinished,
  registerIntegrationRunFinishedSink,
  validateIntegrationRunEventRoute,
  validateIntegrationRunFinishedEvent,
  type IntegrationRunEventRoute,
  type IntegrationRunFinishedEvent,
} from '../../src/core/integration-run-events'
import { buildAutomationRunFinishedEvents, runFinishedCountsFrom } from '../../src/multitable/automation-run-finished-events'
// Gate ③ (baseline v2.3 §10.2.2): the OS task's own per-project record, and the plugin's real port.
import { pullOneProject, summarize } from '../../../../scripts/ops/stock-preparation-scheduled-pull.mjs'
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { DURABLE_CONSUMER_KEYS } from '../../src/multitable/automation-durable-activation'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'
import { RUN_INTEGRATION_JOB_ACTION_ID_SHAPE, validateRunIntegrationJobConfig } from '../../src/multitable/automation-run-integration-job'
import {
  AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED,
  AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED,
} from '../../src/db/migrations/zzzz20261106111500_add_integration_run_finished_trigger_type'

const ACTION_FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
// R-69 I6a: the executor's rule-sheet re-check reads the project-sheet registry only while this switch is exactly
// 'true' (off => skipped(principal_unauthorized, rule_sheet_unregistered)); every harness here runs on the fake DB's
// registered 'sheet_1' (tenant_1, P-1), so each describe that executes the action turns it on with ACTION_FLAG.
const PROJECT_SHEETS_FLAG = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
const TENANT = 'tenant_1'
const PRINCIPAL = { id: 'svc_user', permissions: ['stock-prep:pull', 'stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: TENANT }
const BINDING = { principalId: 'svc_user', tenantId: TENANT }
const ON = { [EVENT_FLAG]: 'true' } as NodeJS.ProcessEnv
/** The five stock-prep decision counts at zero (I5 ruling on verifier F7: every event carries all nine counts). */
const ZERO_DECISIONS = { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }

function pluginEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'run_7',
    occurredAt: '2026-11-06T06:00:00.000Z',
    job: { kind: 'pipeline', pipelineId: 'pipe_1' },
    runId: 'run_7',
    status: 'failed',
    canApply: false,
    counts: { read: 10, cleaned: 9, written: 0, failed: 1, ...ZERO_DECISIONS },
    durationMs: 1234,
    attempts: 1,
    triggeredBy: 'manual',
    errorClass: 'PipelineRunnerError',
    _automationDepth: 0,
    ...overrides,
  }
}

// ── 1. vocabulary ────────────────────────────────────────────────────────────────────────────────────────────

describe('integration.run_finished — trigger vocabulary (pure)', () => {
  it('is a trigger type but NOT in TRIGGER_TYPE_BY_EVENT (a bus event of that name never reaches the record lane)', () => {
    expect(ALL_TRIGGER_TYPES).toContain('integration.run_finished')
    expect(Object.values(TRIGGER_TYPE_BY_EVENT)).not.toContain('integration.run_finished')
    expect(Object.keys(TRIGGER_TYPE_BY_EVENT)).not.toContain('integration.run_finished')
  })

  it('the reason set adds shutdown / timeout_unsettled / lease_lost to the ADR held + skipped sets', () => {
    expect([...INTEGRATION_RUN_FINISHED_REASONS_ADDED_IN_1C]).toEqual(['shutdown', 'timeout_unsettled', 'lease_lost'])
    for (const reason of [...INTEGRATION_RUN_FINISHED_REASONS_ADDED_IN_1C, ...INTEGRATION_RUN_FINISHED_HELD_REASONS, ...INTEGRATION_RUN_FINISHED_SKIPPED_REASONS]) {
      expect(INTEGRATION_RUN_FINISHED_REASONS.has(reason)).toBe(true)
    }
    // + not_found (skipped) and review_pending (held): the I5 ruling N4 mappings of the dry run's own statuses.
    expect([...INTEGRATION_RUN_FINISHED_SKIPPED_REASONS]).toEqual(['principal_unauthorized', 'busy', 'pipeline_changed', 'stale_plan', 'action_disabled', 'not_found'])
    // + pull_batch_installing (held): 批次标识 BI-2's install window (I5 follow-up at the main merge).
    expect([...INTEGRATION_RUN_FINISHED_HELD_REASONS]).toEqual(['manual_confirm_required', 'suspended', 'large_bom_bounded', 'review_pending', 'pull_batch_installing', 'project_absent', 'project_archived'])
  })

  it('the reason set is byte-identical to I4\'s step-result label table (+ the two ADR skipped reasons I3 does not write yet)', () => {
    const web = readFileSync(path.resolve(__dirname, '../../../../apps/web/src/multitable/runIntegrationJobAuthoring.ts'), 'utf8').replace(/\r/g, '')
    const block = /export const RUN_INTEGRATION_JOB_REASON_LABELS[^\n]*= Object\.freeze\(\{\n([\s\S]*?)\n\}\)/.exec(web)
    expect(block).toBeTruthy()
    const webKeys = [...block![1].matchAll(/^\s+([a-z_]+): \{/gm)].map((m) => m[1])
    expect(webKeys.length).toBeGreaterThan(20)
    expect([...INTEGRATION_RUN_FINISHED_REASONS].sort()).toEqual([...new Set([...webKeys, 'pipeline_changed', 'stale_plan'])].sort())
    // and the status set is I4's step outcome set
    const outcomes = /export const RUN_INTEGRATION_JOB_STEP_OUTCOMES[^\n]*Object\.freeze\(\[\n\s*([^\n]*)\n/.exec(web)
    expect(outcomes![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1)).sort()).toEqual([...INTEGRATION_RUN_FINISHED_STATUSES].sort())
  })

  it('default alert set: held stays quiet, skipped alerts (ADR §4.2 / baseline §10.2)', () => {
    expect([...INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES]).toEqual(['failed', 'partial', 'skipped', 'outcome_unknown', 'not_started'])
    const defaults = integrationRunFinishedConfiguredStatuses({ job: { kind: 'stock_prep_pull' } })
    expect(defaults.has('held')).toBe(false)
    expect(defaults.has('succeeded')).toBe(false)
    expect(defaults.has('skipped')).toBe(true)
    // an explicit held is honoured; a persisted junk value falls back to the default set
    expect(integrationRunFinishedConfiguredStatuses({ statuses: ['held'] }).has('held')).toBe(true)
    expect(integrationRunFinishedConfiguredStatuses({ statuses: ['nope'] }).has('held')).toBe(false)
  })

  it('save-time config validation is closed', () => {
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull' } })).toBeNull()
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull', actionId: 'plm.stock-preparation.pull-bom.v1' }, statuses: ['held', 'failed'] })).toBeNull()
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'pipeline', pipelineId: 'pipe_1' } })).toBeNull()
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'pipeline' } })).toMatch(/pipelineId is required/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'pipeline', pipelineId: 'https://x/y' } })).toMatch(/pipelineId is required/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull', pipelineId: 'p' } })).toMatch(/not accepted for kind stock_prep_pull/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'apply' } })).toMatch(/job.kind must be one of/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull', tenantId: 't' } })).toMatch(/job.tenantId is not an accepted key/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull' }, extra: 1 })).toMatch(/extra is not an accepted key/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull' }, statuses: [] })).toMatch(/non-empty/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'failed'] })).toMatch(/not repeat/)
    expect(validateIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull' }, statuses: ['exploded'] })).toMatch(/entries must be among/)
  })

  it('the trigger CHECK migration widens the approval.task_created set by exactly integration.run_finished and covers every app trigger type', () => {
    const prior = readFileSync(path.resolve(__dirname, '../../src/db/migrations/zzzz20260705140000_add_approval_task_created_trigger_type.ts'), 'utf8')
    const upBody = /export async function up[\s\S]*?CHECK \(trigger_type IN \(([\s\S]*?)\)\)/.exec(prior)![1]
    expect([...AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED]).toEqual(upBody.match(/'([a-z_.]+)'/g)!.map((s) => s.slice(1, -1)))
    expect([...AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED]).toEqual([...AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED, 'integration.run_finished'])
    for (const type of ALL_TRIGGER_TYPES) expect(AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED).toContain(type)
  })
})

// ── 2. the publish port: closed key set, values-free, switch ─────────────────────────────────────────────────

describe('integration.run_finished — publish port (closed key set, values-free)', () => {
  afterEach(() => clearIntegrationRunFinishedSinkForTest())

  it('accepts the closed shape and returns a frozen copy', () => {
    const result = validateIntegrationRunFinishedEvent(pluginEvent(), 'plugin')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.isFrozen(result.event)).toBe(true)
      expect(Object.keys(result.event).every((key) => (INTEGRATION_RUN_FINISHED_EVENT_KEYS as readonly string[]).includes(key))).toBe(true)
    }
  })

  it.each([
    ['tenantId', { tenantId: TENANT }],
    ['scopeKey', { scopeKey: `stock_prep_pull:${TENANT}:P-1` }],
    ['errorSummary', { errorSummary: 'relation "x" does not exist' }],
    ['url', { url: 'https://erp.example.invalid/api' }],
    ['credentials', { credentials: { token: 'redacted' } }],
  ])('an extra top-level key (%s) is REFUSED, never trimmed', (key, extra) => {
    expect(validateIntegrationRunFinishedEvent(pluginEvent(extra), 'plugin')).toEqual({ ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: key })
  })

  it('nested keys are closed too (job, counts)', () => {
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ job: { kind: 'pipeline', pipelineId: 'pipe_1', tenantId: TENANT } }), 'plugin'))
      .toEqual({ ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: 'job.tenantId' })
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts: { read: 1, cleaned: 1, written: 0, failed: 0, ...ZERO_DECISIONS, created: 1 } }), 'plugin'))
      .toEqual({ ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: 'counts.created' })
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts: { read: 1, cleaned: 1, written: 0 } }), 'plugin'))
      .toMatchObject({ ok: false, field: 'counts.failed' })
  })

  it.each([
    ['errorClass with a URL', { errorClass: 'https://host/x' }, 'errorClass'],
    ['errorClass with a message', { errorClass: 'connect ECONNREFUSED HOST-SENTINEL-R69' }, 'errorClass'],
    ['an open reason', { reason: 'free text reason' }, 'reason'],
    ['a pipelineId path', { job: { kind: 'pipeline', pipelineId: 'a/b' } }, 'job.pipelineId'],
    ['a status outside the set', { status: 'done' }, 'status'],
    ['a negative count', { counts: { read: -1, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS } }, 'counts.read'],
    ['a negative decision count', { counts: { read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS, manual_confirm: -1 } }, 'counts.manual_confirm'],
    ['a string canApply', { canApply: 'true' }, 'canApply'],
    ['a numeric canApply', { canApply: 1 }, 'canApply'],
    ['a plugin depth', { _automationDepth: 1 }, '_automationDepth'],
  ])('a value outside its bounded shape is refused: %s', (_label, overrides, field) => {
    expect(validateIntegrationRunFinishedEvent(pluginEvent(overrides), 'plugin')).toMatchObject({ ok: false, code: 'EVENT_FIELD_INVALID', field })
  })

  it('a stock-prep job needs its project number, and a URL-shaped one is refused', () => {
    const job = { kind: 'stock_prep_pull', projectNo: 'P-1' }
    const base = { job, triggeredBy: 'automation', _automationDepth: 1 }
    expect(validateIntegrationRunFinishedEvent(pluginEvent(base), 'automation').ok).toBe(true)
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ ...base, job: { kind: 'stock_prep_pull' } }), 'automation')).toMatchObject({ field: 'job.projectNo' })
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ ...base, job: { kind: 'stock_prep_pull', projectNo: 'https://h/x' } }), 'automation')).toMatchObject({ field: 'job.projectNo' })
  })

  it('an automation-originated summary is the action layer\'s only: the plugin may not publish one, and the action layer publishes nothing else', () => {
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ triggeredBy: 'automation' }), 'plugin')).toEqual({ ok: false, code: 'AUTOMATION_ORIGIN_RESERVED' })
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ triggeredBy: 'manual' }), 'automation')).toMatchObject({ ok: false, field: 'triggeredBy' })
  })

  it('publish: switch exact literal, route closed, sink absent / failing — never throws, and a refused event never reaches the sink', async () => {
    const sink = vi.fn(async () => undefined)
    for (const value of ['TRUE', ' true', '1', '', undefined]) {
      expect(await publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT }, 'plugin', { [EVENT_FLAG]: value } as NodeJS.ProcessEnv))
        .toEqual({ published: false, code: 'EVENT_DISABLED' })
    }
    expect(await publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'SINK_INACTIVE' })
    registerIntegrationRunFinishedSink('test', sink)
    expect(await publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT, workspaceId: 'w' }, 'plugin', ON)).toEqual({ published: false, code: 'ROUTE_INVALID' })
    expect(await publishIntegrationRunFinished(pluginEvent({ tenantId: TENANT }), { tenantId: TENANT }, 'plugin', ON)).toMatchObject({ published: false, code: 'EVENT_KEY_NOT_ACCEPTED' })
    expect(sink).not.toHaveBeenCalled()
    expect(await publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: true })
    expect(sink).toHaveBeenCalledTimes(1)
    const [event, route] = sink.mock.calls[0] as unknown as [IntegrationRunFinishedEvent, IntegrationRunEventRoute]
    expect(route).toEqual({ tenantId: TENANT })
    expect(JSON.stringify(event)).not.toContain(TENANT)
    clearIntegrationRunFinishedSinkForTest()
    registerIntegrationRunFinishedSink('test', async () => { throw new Error('boom') })
    expect(await publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'SINK_FAILED' })
  })

  it('the registry is owner-tracked: a stale unbind cannot remove a successor', () => {
    const first = registerIntegrationRunFinishedSink('a', async () => undefined)
    registerIntegrationRunFinishedSink('b', async () => undefined)
    first()
    // still bound (b): a publish reaches a sink
    return publishIntegrationRunFinished(pluginEvent(), { tenantId: TENANT }, 'plugin', ON).then((r) => expect(r).toEqual({ published: true }))
  })
})

// ── 3. the action layer: exactly one summary per job, after the final attempt ─────────────────────────────────

type FakeCall = { input: IntegrationRunInput; resolve: (s: IntegrationRunSummary) => void; reject: (e: unknown) => void }
function fakePort(behaviour: 'ignore' | 'immediate', summary: IntegrationRunSummary = { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 2, update: 1 } }) {
  const calls: FakeCall[] = []
  const run = vi.fn(async (input: IntegrationRunInput): Promise<IntegrationRunSummary> => {
    await input.checkpoint()
    if (behaviour === 'immediate') return summary
    return new Promise<IntegrationRunSummary>((resolve, reject) => { calls.push({ input, resolve, reject }) })
  })
  const port: IntegrationRunPort = { run }
  return { port, calls, run }
}

const CONFIG = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 1_000, binding: BINDING }
const CONFIG3 = { ...CONFIG, job: { ...CONFIG.job, projectNos: ['P-1', 'P-2', 'P-3'] } }

function harness(db: ReturnType<typeof createFakeJobDb>, port: IntegrationRunPort | null, extra: Partial<AutomationDeps> = {}) {
  const tracked: Promise<void>[] = []
  const exec = new AutomationExecutor({
    eventBus: new EventBus(),
    queryFn: db.query,
    transaction: db.transaction,
    integrationRunPort: () => port,
    shutdownSignal: new AbortController().signal,
    trackIntegrationJobTask: (task) => { tracked.push(task) },
    resolveIntegrationRunPrincipal: async () => ({ ok: true, user: PRINCIPAL }),
    integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
    ...extra,
  })
  const run = (executionId: string, config: Record<string, unknown> = CONFIG, root = executionId, triggerEvent: unknown = {}) => {
    const context: ExecutionContext = { executionId, ruleId: 'rule_1', sheetId: 'sheet_1', recordId: '', recordData: {}, ruleCreatedBy: 'svc_user', triggerEvent, rootExecutionId: root }
    const identity: ClassAActionIdentity = { structuralPath: '0', rootExecutionId: root }
    return (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i?: ClassAActionIdentity): Promise<AutomationStepResult> })
      .executeSingleAction({ type: 'run_integration_job', config }, context, identity)
  }
  return { exec, run, tracked }
}

function captureSink() {
  const events: Array<{ event: IntegrationRunFinishedEvent; route: IntegrationRunEventRoute }> = []
  registerIntegrationRunFinishedSink('test-capture', async (event, route) => { events.push({ event, route }) })
  return events
}

describe('integration.run_finished — the action layer emits EXACTLY ONE summary per job, after the final attempt', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(PROJECT_SHEETS_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })

  it('one project ⇒ one values-free event with the deterministic id; the tenant rides beside it, never inside', async () => {
    const events = captureSink()
    const db = createFakeJobDb()
    const { run } = harness(db, fakePort('immediate').port)
    const step = await run('exec_1')
    expect(step.status).toBe('success')
    expect(events).toHaveLength(1)
    const { event, route } = events[0]
    expect(route).toEqual({ tenantId: TENANT })
    expect(event).toMatchObject({
      job: { kind: 'stock_prep_pull', projectNo: 'P-1' },
      status: 'succeeded',
      reason: 'ready',
      canApply: true,
      counts: { read: 3, cleaned: 3, written: 0, failed: 0 },
      attempts: 1,
      triggeredBy: 'automation',
      _automationDepth: 1,
    })
    const actionKey = deriveActionKey({ structuralPath: '0', actionType: 'run_integration_job', canonicalConfig: CONFIG })
    expect(event.eventId).toBe(deriveAutomationRunFinishedEventId({ rootExecutionId: 'exec_1', executionId: 'exec_1', actionKey, projectNo: 'P-1' }))
    expect(event.eventId).toMatch(/^[0-9a-f]{64}$/)
    // F7: the port's decision counts ride as they are (fakePort: add 2, update 1).
    expect(event.counts).toEqual({ read: 3, cleaned: 3, written: 0, failed: 0, add: 2, update: 1, skip: 0, inactive: 0, manual_confirm: 0 })
    // values-free: no tenant id, no lease scope key, no principal, no URL
    const text = JSON.stringify(event)
    for (const needle of [TENANT, 'stock_prep_pull:tenant_1', 'svc_user', 'scopeKey', 'http', 'binding']) expect(text).not.toContain(needle)
  })

  it('three projects ⇒ three events (one per job), distinct deterministic ids', async () => {
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
    await run('exec_3', CONFIG3)
    expect(events.map((e) => e.event.job.projectNo)).toEqual(['P-1', 'P-2', 'P-3'])
    expect(new Set(events.map((e) => e.event.eventId)).size).toBe(3)
  })

  it('1000 rows ⇒ 1 event: a port that admits 1000 reads (one checkpoint each) still yields exactly one summary', async () => {
    const events = captureSink()
    const port: IntegrationRunPort = {
      run: async (input) => {
        for (let row = 0; row < 1000; row += 1) await input.checkpoint()
        return { status: 'partial', counts: { read: 1000, cleaned: 998, written: 0, failed: 2 } }
      },
    }
    const { run } = harness(createFakeJobDb(), port)
    await run('exec_1000')
    expect(events).toHaveLength(1)
    expect(events[0].event).toMatchObject({ status: 'partial', counts: { read: 1000, cleaned: 998, written: 0, failed: 2 } })
  })

  it('switch OFF (anything but the exact literal) ⇒ the step is unchanged and nothing is emitted', async () => {
    vi.stubEnv(EVENT_FLAG, 'TRUE')
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
    const step = await run('exec_off')
    expect(step).toMatchObject({ status: 'success', output: { outcome: 'succeeded', reason: 'ready' } })
    expect(events).toHaveLength(0)
  })

  it('the action switch OFF ⇒ one skipped(action_disabled) summary per project (never silent)', async () => {
    vi.stubEnv(ACTION_FLAG, 'false')
    const events = captureSink()
    const port = fakePort('immediate')
    const { run } = harness(createFakeJobDb(), port.port)
    await run('exec_disabled', CONFIG3)
    expect(port.run).not.toHaveBeenCalled()
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.reason])).toEqual([
      ['P-1', 'skipped', 'action_disabled'], ['P-2', 'skipped', 'action_disabled'], ['P-3', 'skipped', 'action_disabled'],
    ])
  })

  // ── R-69 I6d fix round 2 (F1b): the ROUTE is a tenant THIS trigger verified, or there is no summary ──────────
  //
  // The route tenant decides whose integration.run_finished rules fire, and the publish port checks only its shape.
  // The executor's two binding checks (the binding principal is the rule's stored creator; the rule's sheet is the
  // active registered project sheet of the binding tenant) are what verifies it. A step they STOP used to be
  // summarized all the same — once per project, routed to whatever tenant the stored binding named (the I6a L3 pin
  // these cases replace). It publishes nothing now; the step result is unchanged, so the execution log still names
  // the stop and its closed cause.
  const VICTIM = 'tenant_victim'
  /** Captures every delivery, whatever its route — the assertions below are about ALL of them, not one tenant's. */
  const expectNothingPublished = (events: ReturnType<typeof captureSink>) => {
    expect(events.map((e) => [e.route.tenantId, e.event.job.projectNo, e.event.status, e.event.reason])).toEqual([])
  }

  it.each<[label: string, arrange: (db: ReturnType<typeof createFakeJobDb>) => void, status: string, reason: string, cause: string | undefined, registryReads: unknown[]]>([
    ['the rule sheet was ARCHIVED', (db) => { db.projectTargets.get('sheet_1')!.status = 'archived' }, 'skipped', 'principal_unauthorized', 'rule_sheet_unregistered', ['sheet_1']],
    ['the rule sheet is registered to ANOTHER tenant', (db) => { db.projectTargets.set('sheet_1', { tenantId: 'tenant_2', projectNo: 'P-1', status: 'active' }) }, 'skipped', 'principal_unauthorized', 'rule_sheet_tenant_mismatch', ['sheet_1']],
    ['the rule sheet was NEVER registered', (db) => { db.projectTargets.delete('sheet_1') }, 'skipped', 'principal_unauthorized', 'rule_sheet_unregistered', ['sheet_1']],
    // exact literal only: with the switch off the registry is not the authority and is not read at all
    ['the project-sheets switch is OFF', () => { vi.stubEnv(PROJECT_SHEETS_FLAG, 'TRUE') }, 'skipped', 'principal_unauthorized', 'rule_sheet_unregistered', []],
    ['the registry is UNREADABLE', (db) => { db.setRegistryUnreadable('57P01') }, 'not_started', 'authority_unavailable', undefined, ['sheet_1']],
  ])('a rule-sheet stop — %s ⇒ the step keeps its status, reason and cause, and NOTHING is published; the port is never called', async (_label, arrange, status, reason, cause, registryReads) => {
    const events = captureSink()
    const db = createFakeJobDb()
    arrange(db)
    const port = fakePort('immediate')
    const { run } = harness(db, port.port)
    const step = await run('exec_step05', CONFIG3)
    // the STEP is what it was: it names the cause (or none, for an unreadable registry) …
    expect(step.output).toEqual({ outcome: status, reason, ...(cause ? { cause } : {}) })
    expect(port.run).not.toHaveBeenCalled()
    expect(db.intentRows()).toHaveLength(0)
    // … and no summary of it leaves the process, to any tenant
    expectNothingPublished(events)
    // the step's own read only: the emitter used the step's verdict, it did not ask the registry again
    expect(db.registryReads).toEqual(registryReads)
  })

  it('a FORGED binding tenant — the creator\'s own principal over another tenant — is the tenant-mismatch stop: nothing reaches that tenant (or any other)', async () => {
    const events = captureSink()
    const db = createFakeJobDb() // sheet_1 is registered to tenant_1, active
    const port = fakePort('immediate')
    const { run } = harness(db, port.port)
    const forged = { ...CONFIG3, binding: { principalId: 'svc_user', tenantId: VICTIM } }
    const step = await run('exec_forged', forged)
    expect(step.output).toEqual({ outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_tenant_mismatch' })
    expect(port.run).not.toHaveBeenCalled()
    expectNothingPublished(events)
  })

  it('a binding whose principal is NOT the rule\'s creator stops before the registry is read, and publishes nothing — also when its tenant is the sheet\'s own', async () => {
    for (const tenantId of [TENANT, VICTIM]) {
      const events = captureSink()
      const db = createFakeJobDb()
      const port = fakePort('immediate')
      const { run } = harness(db, port.port)
      const step = await run(`exec_principal_${tenantId}`, { ...CONFIG3, binding: { principalId: 'someone_else', tenantId } })
      expect(step.output).toEqual({ outcome: 'skipped', reason: 'principal_unauthorized', cause: 'binding_principal_mismatch' })
      expect(port.run).not.toHaveBeenCalled()
      expect(db.registryReads).toHaveLength(0)
      expectNothingPublished(events)
      clearIntegrationRunFinishedSinkForTest()
    }
  })

  it('the action switch OFF is summarized ONLY for a binding that verifies: the same two checks run before the publish, and a forged tenant, a foreign principal or an archived sheet publishes nothing', async () => {
    vi.stubEnv(ACTION_FLAG, 'false')
    for (const [label, config, arrange] of [
      ['forged tenant', { ...CONFIG3, binding: { principalId: 'svc_user', tenantId: VICTIM } }, undefined],
      ['foreign principal', { ...CONFIG3, binding: { principalId: 'someone_else', tenantId: TENANT } }, undefined],
      ['archived sheet', CONFIG3, (db: ReturnType<typeof createFakeJobDb>) => { db.projectTargets.get('sheet_1')!.status = 'archived' }],
      ['unreadable registry', CONFIG3, (db: ReturnType<typeof createFakeJobDb>) => { db.setRegistryUnreadable('57P01') }],
    ] as const) {
      const events = captureSink()
      const db = createFakeJobDb()
      arrange?.(db)
      const port = fakePort('immediate')
      const { run } = harness(db, port.port)
      const step = await run(`exec_off_${label.replace(/ /g, '_')}`, config)
      // the step never looked at the binding: the switch answers first
      expect(step.output, label).toEqual({ outcome: 'skipped', reason: 'action_disabled' })
      expect(port.run).not.toHaveBeenCalled()
      expectNothingPublished(events)
      clearIntegrationRunFinishedSinkForTest()
    }
    // the control of the same run: a binding that verifies IS summarized (the case above), after ONE registry read
    const events = captureSink()
    const db = createFakeJobDb()
    const { run } = harness(db, fakePort('immediate').port)
    await run('exec_off_verified', CONFIG3)
    expect(events.map((e) => [e.route.tenantId, e.event.job.projectNo, e.event.status, e.event.reason])).toEqual([
      [TENANT, 'P-1', 'skipped', 'action_disabled'], [TENANT, 'P-2', 'skipped', 'action_disabled'], [TENANT, 'P-3', 'skipped', 'action_disabled'],
    ])
    expect(db.registryReads).toEqual(['sheet_1'])
  })

  it('a stop AFTER the binding verified is still summarized, to the verified tenant: live authority refused, authority unreadable, no port', async () => {
    for (const [label, extra, port, status, reason] of [
      ['live authority refused', { resolveIntegrationRunPrincipal: async () => ({ ok: false as const, reason: 'principal_unauthorized' as const }) }, fakePort('immediate').port, 'skipped', 'principal_unauthorized'],
      ['live authority unreadable', { resolveIntegrationRunPrincipal: async () => ({ ok: false as const, reason: 'authority_unavailable' as const }) }, fakePort('immediate').port, 'not_started', 'authority_unavailable'],
      ['no port', {}, null, 'not_started', 'port_inactive'],
    ] as const) {
      const events = captureSink()
      const db = createFakeJobDb()
      const { run } = harness(db, port, extra as Partial<AutomationDeps>)
      const step = await run(`exec_after_${label.replace(/ /g, '_')}`, CONFIG3)
      expect(step.output, label).toEqual({ outcome: status, reason })
      expect(events.map((e) => [e.route.tenantId, e.event.job.projectNo, e.event.status, e.event.reason]), label).toEqual([
        [TENANT, 'P-1', status, reason], [TENANT, 'P-2', status, reason], [TENANT, 'P-3', status, reason],
      ])
      // values-free, closed key set: the step's cause and the tenant never ride in the event
      for (const { event } of events) {
        expect(event).not.toHaveProperty('cause')
        expect(Object.keys(event).every((key) => (INTEGRATION_RUN_FINISHED_EVENT_KEYS as readonly string[]).includes(key))).toBe(true)
        const text = JSON.stringify(event)
        for (const needle of ['rule_sheet', 'cause', TENANT, 'sheet_1', 'svc_user', 'binding']) expect(text).not.toContain(needle)
      }
      // one registry read per trigger: the step's; the emitter used that verdict
      expect(db.registryReads).toEqual(['sheet_1'])
      clearIntegrationRunFinishedSinkForTest()
    }
  })

  it('a timeout_unsettled unit: ONE outcome_unknown summary at the step; the late settlement (Tx B) emits nothing; unreached projects are not_started(timeout)', async () => {
    vi.useFakeTimers()
    const events = captureSink()
    const port = fakePort('ignore')
    const { run, tracked } = harness(createFakeJobDb(), port.port)
    const stepP = run('exec_slow', { ...CONFIG, job: { ...CONFIG.job, projectNos: ['P-1', 'P-2'] } })
    await vi.advanceTimersByTimeAsync(1_000 + 500 + 10)
    const step = await stepP
    expect(step.output).toMatchObject({ outcome: 'outcome_unknown', reason: 'timeout_unsettled' })
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.reason])).toEqual([
      ['P-1', 'outcome_unknown', 'timeout_unsettled'],
      ['P-2', 'not_started', 'timeout'],
    ])
    // the hung call settles later; its continuation writes the intent ledger — and publishes NOTHING
    port.calls[0].resolve({ status: 'succeeded', reason: 'ready', counts: { add: 1 } })
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(tracked)
    expect(tracked.length).toBeGreaterThan(0)
    expect(events).toHaveLength(2)
  })

  it('a replay of the same step derives the SAME id (the per-rule claim then runs nothing — see the dispatch suite)', async () => {
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
    await run('exec_r')
    await run('exec_r') // durable redelivery of the same execution: the intent says sent ⇒ already_applied
    expect(events).toHaveLength(2)
    expect(events[1].event.eventId).toBe(events[0].event.eventId)
    expect(events[1].event).toMatchObject({ status: 'succeeded', reason: 'already_applied' })
    // a manual retry is a NEW execution id ⇒ a new event id, by design (ADR §4.2)
    await run('exec_r2', CONFIG, 'exec_r')
    expect(events[2].event.eventId).not.toBe(events[0].event.eventId)
  })

  it('depth: the event carries the originating execution depth + 1', async () => {
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
    await run('exec_d', CONFIG, 'exec_d', { _automationDepth: 2 })
    expect(events[0].event._automationDepth).toBe(3)
  })

  it('the builder maps counts into the closed four and moves an open reason to errorClass', () => {
    expect(runFinishedCountsFrom({ add: 5, update: 2, skip: 1, inactive: 0, manual_confirm: 3 }))
      .toEqual({ read: 11, cleaned: 11, written: 0, failed: 0, add: 5, update: 2, skip: 1, inactive: 0, manual_confirm: 3 })
    expect(runFinishedCountsFrom({ read: 4, cleaned: 3, written: 2, failed: 1 })).toEqual({ read: 4, cleaned: 3, written: 2, failed: 1, ...ZERO_DECISIONS })
    expect(runFinishedCountsFrom(undefined)).toEqual({ read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS })
    const [event] = buildAutomationRunFinishedEvents({
      output: { outcome: 'failed', reason: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', units: [{ projectNo: 'P-1', scopeKey: `stock_prep_pull:${TENANT}:P-1`, outcome: 'failed', reason: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', durationMs: 5, summary: { status: 'failed', errorClass: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' } }] },
      projectNos: ['P-1'], rootExecutionId: 'r', executionId: 'e', actionKey: 'k', automationDepth: 1, occurredAt: '2026-11-06T06:00:00.000Z',
    })
    expect(event).not.toHaveProperty('reason')
    expect(event).toMatchObject({ status: 'failed', errorClass: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' })
    expect(JSON.stringify(event)).not.toContain(TENANT)
    expect(validateIntegrationRunFinishedEvent(event, 'automation').ok).toBe(true)
  })
})

// ── 4. dispatch: job-keyed, tenant-scoped, per-rule exactly once ─────────────────────────────────────────────

function chainDb(inserted: Record<string, unknown>[] = [], updated: Record<string, unknown>[] = [], existing?: Record<string, unknown>) {
  const chain: Record<string, unknown> = {}
  const chainFn = () => chain
  for (const m of ['selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'leftJoin', 'insertInto', 'updateTable', 'deleteFrom']) chain[m] = vi.fn(chainFn)
  chain.values = vi.fn((row: unknown) => { inserted.push(row as Record<string, unknown>); return chain })
  chain.set = vi.fn((row: unknown) => { updated.push(row as Record<string, unknown>); return chain })
  chain.returningAll = vi.fn(chainFn)
  chain.execute = vi.fn(async () => (updated.length > 0 && existing ? [{ ...existing, ...updated[updated.length - 1] }] : []))
  chain.executeTakeFirst = vi.fn(async () => existing)
  return chain
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule_alert',
    sheet_id: 'sheet_1',
    name: 'alert',
    trigger_type: 'integration.run_finished',
    trigger_config: { job: { kind: 'stock_prep_pull' }, binding: { principalId: 'alerter', tenantId: TENANT } },
    action_type: 'send_dingtalk_group_message',
    action_config: { destinationIds: ['d1'], titleTemplate: 't', bodyTemplate: 'b' },
    enabled: true,
    created_at: '2026-11-06T00:00:00.000Z',
    updated_at: '2026-11-06T00:00:00.000Z',
    created_by: 'alerter',
    conditions: null,
    actions: null,
    execution_mode: null,
    ...overrides,
  }
}

function dispatchHarness(rules: Array<Record<string, unknown>>, authorized = true) {
  const service = new AutomationService(new EventBus(), chainDb() as never, vi.fn(async () => ({ rows: [], rowCount: 0 })) as never)
  const svc = service as unknown as Record<string, unknown>
  const ledger = new Set<string>()
  // The legacy tombstone ledger (INSERT … ON CONFLICT DO NOTHING) modelled exactly: first claim wins.
  vi.spyOn(svc as never, 'claimEventDelivery' as never).mockImplementation((async (ruleId: string, key: string) => {
    const k = `${ruleId}|${key}`
    if (ledger.has(k)) return false
    ledger.add(k)
    return true
  }) as never)
  vi.spyOn(service, 'loadEnabledIntegrationRunFinishedRules').mockImplementation(async (kind, tenantId) => (
    rules.map((r) => (service as unknown as { mapRow(r: unknown): never }).mapRow(r))
      .filter((r: { trigger_config: { job?: { kind?: string }; binding?: { tenantId?: string } } }) => r.trigger_config.job?.kind === kind && r.trigger_config.binding?.tenantId === tenantId)
  ))
  const executeRule = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
  const resolver = vi.fn(async () => (authorized
    ? { ok: true as const, user: { id: 'alerter', permissions: ['integration:read', 'workflow:write'], roles: [], role: 'user', tenantId: TENANT } }
    : { ok: false as const, reason: 'principal_unauthorized' as const }))
  service.setIntegrationRunFinishedCreatorResolverForTest(resolver)
  return { service, executeRule, ledger, resolver }
}

function automationEvent(overrides: Record<string, unknown> = {}): IntegrationRunFinishedEvent {
  const raw = {
    eventId: 'a'.repeat(64),
    occurredAt: '2026-11-06T06:00:00.000Z',
    job: { kind: 'stock_prep_pull', projectNo: 'P-1' },
    status: 'failed',
    canApply: false,
    counts: { read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS },
    durationMs: 10,
    attempts: 1,
    triggeredBy: 'automation',
    reason: 'timeout',
    _automationDepth: 1,
    ...overrides,
  }
  const v = validateIntegrationRunFinishedEvent(raw, 'automation')
  if (!v.ok) throw new Error(`fixture invalid: ${v.code} ${v.field}`)
  return v.event
}

describe('integration.run_finished — dispatch (per-rule exactly once, held quiet, skipped alerts)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a replay with the same deterministic id runs NOTHING; a different id runs again', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow()])
    const event = automationEvent()
    await service.dispatchIntegrationRunFinished(event, { tenantId: TENANT }, ON)
    await service.dispatchIntegrationRunFinished(event, { tenantId: TENANT }, ON)
    await service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
    expect(executeRule).toHaveBeenCalledTimes(1)
    await service.dispatchIntegrationRunFinished(automationEvent({ eventId: 'b'.repeat(64) }), { tenantId: TENANT }, ON)
    expect(executeRule).toHaveBeenCalledTimes(2)
  })

  it('end to end: the executor\'s replayed step (same id) reaches the rule once', async () => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(PROJECT_SHEETS_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
    try {
      const { service, executeRule } = dispatchHarness([ruleRow({ trigger_config: { job: { kind: 'stock_prep_pull' }, statuses: ['succeeded'], binding: { principalId: 'alerter', tenantId: TENANT } } })])
      registerIntegrationRunFinishedSink('svc', (event, route) => service.dispatchIntegrationRunFinished(event, route))
      const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
      await run('exec_e2e')
      await run('exec_e2e')
      expect(executeRule).toHaveBeenCalledTimes(1)
    } finally {
      clearIntegrationRunFinishedSinkForTest()
      vi.unstubAllEnvs()
    }
  })

  it('default statuses: held is quiet, skipped / failed / outcome_unknown / not_started / partial alert, succeeded does not', async () => {
    const outcomes: Record<string, boolean> = {}
    for (const [i, status] of (['held', 'skipped', 'failed', 'outcome_unknown', 'not_started', 'partial', 'succeeded'] as const).entries()) {
      const { service, executeRule } = dispatchHarness([ruleRow()])
      const reason = status === 'held' ? 'manual_confirm_required' : status === 'skipped' ? 'busy' : undefined
      await service.dispatchIntegrationRunFinished(automationEvent({ eventId: String(i).repeat(64), status, reason }), { tenantId: TENANT }, ON)
      outcomes[status] = executeRule.mock.calls.length === 1
      vi.restoreAllMocks()
    }
    expect(outcomes).toEqual({ held: false, skipped: true, failed: true, outcome_unknown: true, not_started: true, partial: true, succeeded: false })
  })

  it('a rule that lists held explicitly gets the human to-do', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow({ trigger_config: { job: { kind: 'stock_prep_pull' }, statuses: ['held'], binding: { principalId: 'alerter', tenantId: TENANT } } })])
    await service.dispatchIntegrationRunFinished(automationEvent({ status: 'held', reason: 'manual_confirm_required' }), { tenantId: TENANT }, ON)
    expect(executeRule).toHaveBeenCalledTimes(1)
  })

  it('routing: job kind / pipelineId / actionId must match, the tenant comes from the route, the binding must be the creator; creator re-checked live', async () => {
    const pipelineRule = ruleRow({ id: 'r_pipe', trigger_config: { job: { kind: 'pipeline', pipelineId: 'pipe_1' }, binding: { principalId: 'alerter', tenantId: TENANT } } })
    const otherPipe = ruleRow({ id: 'r_other', trigger_config: { job: { kind: 'pipeline', pipelineId: 'pipe_2' }, binding: { principalId: 'alerter', tenantId: TENANT } } })
    const otherTenant = ruleRow({ id: 'r_tenant', trigger_config: { job: { kind: 'pipeline', pipelineId: 'pipe_1' }, binding: { principalId: 'alerter', tenantId: 'tenant_2' } } })
    const forged = ruleRow({ id: 'r_forged', trigger_config: { job: { kind: 'pipeline', pipelineId: 'pipe_1' }, binding: { principalId: 'someone_else', tenantId: TENANT } } })
    const { service, executeRule } = dispatchHarness([pipelineRule, otherPipe, otherTenant, forged])
    const plugin = validateIntegrationRunFinishedEvent(pluginEvent(), 'plugin')
    if (!plugin.ok) throw new Error('fixture')
    await service.dispatchIntegrationRunFinished(plugin.event, { tenantId: TENANT }, ON)
    expect(executeRule.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual(['r_pipe'])

    const actionRule = ruleRow({ id: 'r_action', trigger_config: { job: { kind: 'stock_prep_pull', actionId: 'plm.other.v1' }, binding: { principalId: 'alerter', tenantId: TENANT } } })
    const denied = dispatchHarness([actionRule, ruleRow()], false)
    await denied.service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
    expect(denied.executeRule).not.toHaveBeenCalled() // actionId mismatch + creator no longer authorized
    expect(denied.resolver).toHaveBeenCalledTimes(1)
  })

  it('the rule sees a record-less payload carrying `run` (no depth, no tenant, no route)', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow()])
    await service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
    const payload = executeRule.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toMatchObject({ recordId: '', data: {}, eventType: 'integration.run_finished', _automationDepth: 1 })
    expect(payload.run).toMatchObject({ status: 'failed', reason: 'timeout', job: { projectNo: 'P-1' } })
    expect(payload.run).not.toHaveProperty('_automationDepth')
    expect(JSON.stringify(payload)).not.toContain(TENANT)
  })

  it('depth ≥ 3 and the switch OFF dispatch nothing (the loader is not even consulted)', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow()])
    await service.dispatchIntegrationRunFinished(automationEvent({ _automationDepth: 3 }), { tenantId: TENANT }, ON)
    await service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, { [EVENT_FLAG]: 'TRUE' } as NodeJS.ProcessEnv)
    expect(service.loadEnabledIntegrationRunFinishedRules).not.toHaveBeenCalled()
    expect(executeRule).not.toHaveBeenCalled()
  })

  it('the sink: durable OFF dispatches in-process; durable ON enqueues { event, route } on the v4 family and dispatches nothing itself', async () => {
    const off = dispatchHarness([ruleRow()])
    vi.stubEnv(EVENT_FLAG, 'true')
    try {
      await off.service.handleIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
      await (off.service as unknown as { drainLifecycleTasks(set: unknown): Promise<void>; completionConsumerInFlight: unknown })
        .drainLifecycleTasks((off.service as unknown as { completionConsumerInFlight: unknown }).completionConsumerInFlight)
      expect(off.executeRule).toHaveBeenCalledTimes(1)

      const on = dispatchHarness([ruleRow()])
      const enqueue = vi.fn(async () => undefined)
      on.service.setIntegrationRunEventEnqueueForTest(enqueue)
      await on.service.handleIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, { ...ON, AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as NodeJS.ProcessEnv)
      expect(enqueue).toHaveBeenCalledWith({ eventId: 'a'.repeat(64), payload: { event: automationEvent(), route: { tenantId: TENANT } }, automationDepth: 1 })
      expect(on.executeRule).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the durable consumer re-validates the stored row (an extra key throws, never a silent drop) and dedups a redelivery', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow()])
    vi.stubEnv(EVENT_FLAG, 'true')
    try {
      const handlers = buildDurableConsumerHandlers({
        automationService: service,
        projectionService: { reconcile: vi.fn() },
        webhookService: { deliverEvent: vi.fn() },
        recordApprovalService: { handleApprovalCompletion: vi.fn() },
        todoMirrorService: { handleApprovalTaskCreated: vi.fn(), handleApprovalCompletion: vi.fn() },
      } as never)
      expect([...DURABLE_CONSUMER_KEYS]).toContain('integration-run-trigger')
      const row = (payload: unknown, eventType = 'integration.run_finished') => ({ outboxId: 'o', consumerKey: 'integration-run-trigger', eventType, eventId: 'x', payload, automationDepth: 1, manifestVersion: 4, attempts: 1 }) as never
      const good = { event: { ...automationEvent() }, route: { tenantId: TENANT } }
      await handlers['integration-run-trigger'](row(good))
      await handlers['integration-run-trigger'](row(good))
      expect(executeRule).toHaveBeenCalledTimes(1)
      await expect(handlers['integration-run-trigger'](row({ ...good, event: { ...good.event, tenantId: TENANT } }))).rejects.toThrow(/not a valid integration.run_finished event/)
      await expect(handlers['integration-run-trigger'](row(good, 'approval.approved'))).rejects.toThrow(/unroutable event type/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// ── 5. the save gate ─────────────────────────────────────────────────────────────────────────────────────────

describe('integration.run_finished — save gate', () => {
  function makeService(orgRows: Array<{ org_id: string }>, authorized = true) {
    const inserted: Record<string, unknown>[] = []
    const queryFn = vi.fn(async (sql: string) => (/FROM user_orgs/i.test(sql) ? { rows: orgRows, rowCount: orgRows.length } : { rows: [], rowCount: 0 }))
    const service = new AutomationService(new EventBus(), chainDb(inserted) as never, queryFn as never)
    service.setIntegrationRunFinishedCreatorResolverForTest(async () => (authorized
      ? { ok: true, user: { id: 'alerter', permissions: ['stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: TENANT } }
      : { ok: false, reason: 'principal_unauthorized' }))
    return { service, inserted }
  }
  const input = (triggerConfig: Record<string, unknown>, actionType = 'send_dingtalk_group_message', extra: Record<string, unknown> = {}) => ({
    triggerType: 'integration.run_finished',
    triggerConfig,
    actionType,
    actionConfig: { destinationIds: ['d1'], titleTemplate: '{{run.status}}', bodyTemplate: '{{run.job.projectNo}}' },
    createdBy: 'alerter',
    ...extra,
  })

  it('persists the closed config with the SERVER-stamped binding; a client binding is dropped', async () => {
    const { service, inserted } = makeService([{ org_id: TENANT }])
    await service.createRule('sheet_1', input({ job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'], binding: { principalId: 'attacker', tenantId: 'elsewhere' } }))
    expect(inserted).toHaveLength(1)
    expect(JSON.parse(String(inserted[0].trigger_config))).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'], binding: { principalId: 'alerter', tenantId: TENANT } })
    expect(inserted[0].trigger_type).toBe('integration.run_finished')
  })

  it.each([
    ['a record-writing action', input({ job: { kind: 'stock_prep_pull' } }, 'update_record'), /not allowed on integration.run_finished rules/],
    ['run_integration_job (no run → finish → run loop; the I3 gate may refuse first)', input({ job: { kind: 'stock_prep_pull' } }, 'run_integration_job'), /not allowed on integration.run_finished rules|only allowed on a schedule.cron trigger|is disabled on this deployment/],
    ['conditions', input({ job: { kind: 'stock_prep_pull' } }, 'send_dingtalk_group_message', { conditions: { conjunction: 'AND', conditions: [{ fieldId: 'f', operator: 'equals', value: 1 }] } }), /cannot carry conditions/],
    ['an open status', input({ job: { kind: 'stock_prep_pull' }, statuses: ['exploded'] }), /entries must be among/],
    ['a pipeline without its id', input({ job: { kind: 'pipeline' } }), /pipelineId is required/],
  ])('refuses %s', async (_label, ruleInput, message) => {
    const { service, inserted } = makeService([{ org_id: TENANT }])
    await expect(service.createRule('sheet_1', ruleInput as never)).rejects.toThrow(message)
    expect(inserted).toHaveLength(0)
  })

  it('refuses a creator who cannot read integration results, or who is not bound to exactly one tenant', async () => {
    const denied = makeService([{ org_id: TENANT }], false)
    await expect(denied.service.createRule('sheet_1', input({ job: { kind: 'stock_prep_pull' } }))).rejects.toThrow(/integration:read/)
    const none = makeService([])
    await expect(none.service.createRule('sheet_1', input({ job: { kind: 'stock_prep_pull' } }))).rejects.toThrow(/integration.run_finished rules need a creator bound to exactly one active tenant/)
    await expect(none.service.createRule('sheet_1', input({ job: { kind: 'stock_prep_pull' } }))).rejects.toBeInstanceOf(AutomationRuleValidationError)
    expect(denied.inserted.length + none.inserted.length).toBe(0)
  })
})

// ── 6. the alert template renders from `run.*` only ──────────────────────────────────────────────────────────

describe('integration.run_finished — the alert template (ADR §4.3) renders from run.* only', () => {
  it('the web template, rendered by the executor renderer with the dispatched `run`, is complete and values-free', async () => {
    const { INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE } = await import('../../../../apps/web/src/multitable/integrationRunFinishedAuthoring')
    const { renderAutomationTemplate } = await import('../../src/multitable/automation-executor')
    const run: Record<string, unknown> = { ...automationEvent({ status: 'skipped', reason: 'busy' }) }
    delete run._automationDepth
    const title = renderAutomationTemplate(INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.titleTemplate, { run })
    const body = renderAutomationTemplate(INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.bodyTemplate, { run })
    expect(title).toContain('stock_prep_pull')
    expect(title).toContain('P-1')
    expect(title).toContain('skipped')
    expect(body).toContain('busy')
    // F7: canApply and the five decision counts render (a boolean renders as its literal).
    expect(body).toContain('可应用：false')
    expect(body).toContain('待人工确认 0')
    expect(`${title}\n${body}`).not.toMatch(/\{\{/)
    expect(`${title}\n${body}`).not.toContain(TENANT)
    // a template variable outside run.* renders nothing on this record-less trigger
    expect(renderAutomationTemplate('{{record.x}}{{sheetId}}', { run })).toBe('')
  })
})

// ── 7. verifier findings (fix-I5): the failure path, shutdown, exotic objects, one actionId shape, the walls ─────

/** A database error whose MESSAGE is a sentinel: it must never reach a summary or the step's error. */
function dbError(code = '08006'): Error {
  return Object.assign(new Error('connection to HOST-SENTINEL-R69 lost (SECRET-SENTINEL-R69)'), { code })
}

describe('fix-I5 F1 — a throw inside the step still yields EXACTLY ONE summary per job (ADR §4.1, baseline §10.2)', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(PROJECT_SHEETS_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })
  const valuesFree = (events: Array<{ event: IntegrationRunFinishedEvent }>, step: AutomationStepResult) => {
    // the error MESSAGE reaches neither the summaries nor the step; the tenant never rides in a summary (the step's
    // own unit scopeKey carries it, as I3 always did — the step output is the run log, not an event)
    const eventText = JSON.stringify(events.map((e) => e.event))
    for (const needle of ['SENTINEL', 'connection', TENANT]) expect(eventText).not.toContain(needle)
    for (const needle of ['SENTINEL', 'connection']) expect(JSON.stringify(step)).not.toContain(needle)
  }

  it('Tx A of project 3 of 3 throws: P-1 / P-2 keep their results, P-3 is failed with the error CLASS, the step is a closed failure', async () => {
    const events = captureSink()
    const db = createFakeJobDb()
    let claims = 0
    const query: AutomationDeps['queryFn'] = async (sql, params) => {
      if (/INSERT INTO meta_automation_outbound_intent/.test(sql) && ++claims === 3) throw dbError()
      return db.query(sql, params)
    }
    const { run } = harness(db, fakePort('immediate').port, { queryFn: query })
    const step = await run('exec_f1a', CONFIG3)
    expect(step).toMatchObject({ status: 'failed', output: { outcome: 'failed', reason: '08006' } })
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.reason ?? null, e.event.errorClass ?? null])).toEqual([
      ['P-1', 'succeeded', 'ready', null], ['P-2', 'succeeded', 'ready', null], ['P-3', 'failed', null, '08006'],
    ])
    valuesFree(events, step)
  })

  it('the job-lease claim of project 1 throws: the loop goes on (P-2, P-3 run), P-1 is failed and its intent is a definite non-delivery', async () => {
    const events = captureSink()
    const db = createFakeJobDb()
    let leaseClaims = 0
    const query: AutomationDeps['queryFn'] = async (sql, params) => {
      if (/INSERT INTO meta_automation_job_leases/.test(sql) && ++leaseClaims === 1) throw dbError('40001')
      return db.query(sql, params)
    }
    const { run } = harness(db, fakePort('immediate').port, { queryFn: query })
    const step = await run('exec_f1b', CONFIG3)
    expect(step.status).toBe('failed')
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.errorClass ?? null])).toEqual([
      ['P-1', 'failed', '40001'], ['P-2', 'succeeded', null], ['P-3', 'succeeded', null],
    ])
    expect(db.intentRows().map(([, row]) => row.status)).toEqual(['failed', 'sent', 'sent'])
    valuesFree(events, step)
  })

  it('project 1 is busy and its busy-outcome write throws: P-1 stays skipped(busy) (unconfirmed), P-2 / P-3 still run', async () => {
    const events = captureSink()
    const db = createFakeJobDb()
    let leaseClaims = 0
    const query: AutomationDeps['queryFn'] = async (sql, params) => {
      if (/INSERT INTO meta_automation_job_leases/.test(sql) && ++leaseClaims === 1) return { rows: [], rowCount: 0 } // held by someone else
      if (/UPDATE meta_automation_outbound_intent\s+SET status = \$4/.test(sql) && params?.[4] === 'busy') throw dbError('57P01')
      return db.query(sql, params)
    }
    const { run } = harness(db, fakePort('immediate').port, { queryFn: query })
    const step = await run('exec_f1busy', CONFIG3)
    expect(step).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'busy' } })
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.reason ?? null])).toEqual([
      ['P-1', 'skipped', 'busy'], ['P-2', 'succeeded', 'ready'], ['P-3', 'succeeded', 'ready'],
    ])
    valuesFree(events, step)
  })

  it('a throw the unit does not classify (heartbeat start) ⇒ that project outcome_unknown, the others still run and summarize', async () => {
    const events = captureSink()
    let starts = 0
    const now = () => { if (++starts === 1) throw dbError('HEARTBEAT_CLOCK'); return Date.now() }
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port, {
      integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300, heartbeat: { now } },
    })
    const step = await run('exec_f1c', CONFIG3)
    expect(step).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'HEARTBEAT_CLOCK' } })
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.errorClass ?? null])).toEqual([
      ['P-1', 'outcome_unknown', 'HEARTBEAT_CLOCK'], ['P-2', 'succeeded', null], ['P-3', 'succeeded', null],
    ])
    valuesFree(events, step)
  })

  it('a throw outside the unit loop (the port factory) ⇒ one failed summary per project, a values-free step error', async () => {
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), null, { integrationRunPort: () => { throw dbError('PORT_FACTORY') } })
    const step = await run('exec_f1d', CONFIG3)
    expect(step).toMatchObject({ status: 'failed', output: { outcome: 'failed', reason: 'PORT_FACTORY' } })
    expect(events.map((e) => [e.event.job.projectNo, e.event.status, e.event.errorClass ?? null])).toEqual([
      ['P-1', 'failed', 'PORT_FACTORY'], ['P-2', 'failed', 'PORT_FACTORY'], ['P-3', 'failed', 'PORT_FACTORY'],
    ])
    valuesFree(events, step)
  })
})

describe('fix-I5 F2 — shutdown-reason summaries are admitted during the producer drain, refused (closed code) after detach', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })
  const shutdownEvent = () => ({
    eventId: 'd'.repeat(64), occurredAt: '2026-11-06T06:00:00.000Z', job: { kind: 'stock_prep_pull', projectNo: 'P-2' }, status: 'not_started',
    canApply: false, counts: { read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS }, durationMs: 0, attempts: 1, triggeredBy: 'automation', reason: 'shutdown', _automationDepth: 1,
  })

  it('durable ON: after stopProducerAdmissions the not_started(shutdown) summary is still enqueued', async () => {
    const { service } = dispatchHarness([ruleRow()])
    const enqueue = vi.fn(async () => undefined)
    service.setIntegrationRunEventEnqueueForTest(enqueue)
    const env = { ...ON, AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as NodeJS.ProcessEnv
    registerIntegrationRunFinishedSink('fix-i5-svc', (event, route) => service.handleIntegrationRunFinished(event, route, env))
    await service.stopProducerAdmissions()
    expect(await publishIntegrationRunFinished(shutdownEvent(), { tenantId: TENANT }, 'automation', ON)).toEqual({ published: true })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('durable OFF: after stopProducerAdmissions it is dispatched on the completion consumers (drained by the host after detach)', async () => {
    vi.stubEnv(EVENT_FLAG, 'true')
    const { service, executeRule } = dispatchHarness([ruleRow()])
    registerIntegrationRunFinishedSink('fix-i5-svc', (event, route) => service.handleIntegrationRunFinished(event, route, ON))
    await service.stopProducerAdmissions()
    expect(await publishIntegrationRunFinished(shutdownEvent(), { tenantId: TENANT }, 'automation', ON)).toEqual({ published: true })
    service.detachCompletionConsumers()
    await service.drainCompletionConsumers()
    expect(executeRule).toHaveBeenCalledTimes(1)
    expect((executeRule.mock.calls[0][1] as { run: { reason: string } }).run.reason).toBe('shutdown')
  })

  it('after detachCompletionConsumers: refused with SINK_STOPPED (never published:true), nothing enqueued or dispatched', async () => {
    for (const durable of [false, true]) {
      const { service, executeRule } = dispatchHarness([ruleRow()])
      const enqueue = vi.fn(async () => undefined)
      service.setIntegrationRunEventEnqueueForTest(enqueue)
      const env = { ...ON, ...(durable ? { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } : {}) } as NodeJS.ProcessEnv
      registerIntegrationRunFinishedSink('fix-i5-svc', (event, route) => service.handleIntegrationRunFinished(event, route, env))
      await service.shutdown()
      expect(await publishIntegrationRunFinished(shutdownEvent(), { tenantId: TENANT }, 'automation', ON)).toEqual({ published: false, code: 'SINK_STOPPED' })
      await service.drainCompletionConsumers()
      expect(enqueue).not.toHaveBeenCalled()
      expect(executeRule).not.toHaveBeenCalled()
      clearIntegrationRunFinishedSinkForTest()
      vi.restoreAllMocks()
    }
  })
})

describe('fix-I5 F3 — the publish port reads every level ONCE and refuses Proxies / accessors (ADR §2 ⑤, the record() posture)', () => {
  afterEach(() => clearIntegrationRunFinishedSinkForTest())
  const SMUGGLED = 'SMUGGLED-SENTINEL-R69 token'
  const flipping = (good: unknown, reads: { n: number }, after = 1) => ({ enumerable: true, get() { reads.n += 1; return reads.n <= after ? good : SMUGGLED } })

  it('an accessor on the event (errorClass) is refused — nothing is delivered, whatever it would answer on a second read', async () => {
    const events = captureSink()
    const reads = { n: 0 }
    const evil = Object.defineProperty(pluginEvent(), 'errorClass', flipping('PipelineRunnerError', reads, 3))
    expect(await publishIntegrationRunFinished(evil, { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'EVENT_SHAPE_NOT_PLAIN' })
    expect(events).toHaveLength(0)
    expect(reads.n).toBe(0) // never invoked: the descriptor is inspected, not the getter
  })

  it('a Proxy (event, job, counts) is refused', async () => {
    const events = captureSink()
    const trap = <T extends object>(target: T) => new Proxy(target, {})
    expect(await publishIntegrationRunFinished(trap(pluginEvent()), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'EVENT_SHAPE_NOT_PLAIN' })
    expect(await publishIntegrationRunFinished(pluginEvent({ job: trap({ kind: 'pipeline', pipelineId: 'pipe_1' }) }), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'EVENT_SHAPE_NOT_PLAIN', field: 'job' })
    expect(await publishIntegrationRunFinished(pluginEvent({ counts: trap({ read: 1, cleaned: 1, written: 0, failed: 0 }) }), { tenantId: TENANT }, 'plugin', ON)).toEqual({ published: false, code: 'EVENT_SHAPE_NOT_PLAIN', field: 'counts' })
    expect(events).toHaveLength(0)
  })

  it('nested accessors (counts.failed, job.pipelineId), a class instance and a symbol key are refused', () => {
    const reads = { n: 0 }
    const counts = Object.defineProperty({ read: 1, cleaned: 1, written: 0 }, 'failed', flipping(0, reads))
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts }), 'plugin')).toEqual({ ok: false, code: 'EVENT_SHAPE_NOT_PLAIN', field: 'counts' })
    const job = Object.defineProperty({ kind: 'pipeline' }, 'pipelineId', flipping('pipe_1', reads))
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ job }), 'plugin')).toEqual({ ok: false, code: 'EVENT_SHAPE_NOT_PLAIN', field: 'job' })
    class Summary { constructor() { Object.assign(this, pluginEvent()) } }
    expect(validateIntegrationRunFinishedEvent(new Summary(), 'plugin')).toEqual({ ok: false, code: 'EVENT_SHAPE_NOT_PLAIN' })
    expect(validateIntegrationRunFinishedEvent({ ...pluginEvent(), [Symbol('x')]: 1 }, 'plugin')).toEqual({ ok: false, code: 'EVENT_SHAPE_NOT_PLAIN' })
    expect(reads.n).toBe(0)
    // a null-prototype plain object and a frozen one are fine
    expect(validateIntegrationRunFinishedEvent(Object.assign(Object.create(null), pluginEvent()), 'plugin').ok).toBe(true)
    expect(validateIntegrationRunFinishedEvent(Object.freeze(pluginEvent()), 'plugin').ok).toBe(true)
  })

  it('the route is snapshotted too: an accessor tenantId or a Proxy route is refused', async () => {
    const reads = { n: 0 }
    expect(validateIntegrationRunEventRoute(Object.defineProperty({}, 'tenantId', flipping(TENANT, reads)))).toBeNull()
    expect(validateIntegrationRunEventRoute(new Proxy({ tenantId: TENANT }, {}))).toBeNull()
    expect(validateIntegrationRunEventRoute({ tenantId: TENANT })).toEqual({ tenantId: TENANT })
    expect(reads.n).toBe(0)
    captureSink()
    expect(await publishIntegrationRunFinished(pluginEvent(), new Proxy({ tenantId: TENANT }, {}), 'plugin', ON)).toEqual({ published: false, code: 'ROUTE_INVALID' })
  })
})

describe('fix-I5 F4 — one job-id shape: an actionId the I3 save gate accepts always fits the summary', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(PROJECT_SHEETS_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })

  it('the I3 action shape is byte-identical to the event shape', () => {
    expect(RUN_INTEGRATION_JOB_ACTION_ID_SHAPE.source).toBe(INTEGRATION_RUN_JOB_ID_SHAPE.source)
    expect(RUN_INTEGRATION_JOB_ACTION_ID_SHAPE.flags).toBe(INTEGRATION_RUN_JOB_ID_SHAPE.flags)
  })

  it('the I3 save gate refuses an actionId the summary could not carry, and every id it accepts yields one summary per project', async () => {
    const job = (actionId: string) => ({ kind: 'stock_prep_pull', projectNos: ['P-1', 'P-2', 'P-3'], applyMode: 'dry_run_only', actionId })
    for (const bad of ['plm.stock-preparation.pull-bom.v1@site', 'plm/pull', 'a b', 'a'.repeat(129)]) {
      expect(validateRunIntegrationJobConfig({ job: job(bad) }, 'config')).toMatch(/actionId must be an identifier/)
    }
    const good = 'plm.stock-preparation.pull-bom.v1'
    expect(validateRunIntegrationJobConfig({ job: job(good) }, 'config')).toBeNull()
    // I5 ruling N2: the same holds for a project number — one with '://' (the summary refuses it) is refused at save.
    expect(validateRunIntegrationJobConfig({ job: { ...job(good), projectNos: ['P-1', 'x://y', 'P-3'] } }, 'config')).toMatch(/projectNos entries must not contain ":\/\/"/)
    const events = captureSink()
    const { run } = harness(createFakeJobDb(), fakePort('immediate').port)
    await run('exec_f4', { ...CONFIG3, job: job(good) })
    expect(events.map((e) => [e.event.job.projectNo, e.event.job.actionId])).toEqual([['P-1', good], ['P-2', good], ['P-3', good]])
  })
})

describe('fix-I5 F5/F6 — the dispatch walls: another tenant\'s rule never fires; the creator needs an integration read code', () => {
  afterEach(() => vi.restoreAllMocks())
  const noReadCode = async () => ({ ok: true as const, user: { id: 'alerter', permissions: ['workflow:write'], roles: [] as string[], role: 'user', tenantId: TENANT } })

  it('the in-loop tenant check holds even when the loader hands back another tenant\'s rule (loader NOT tenant-filtered here)', async () => {
    const { service, executeRule } = dispatchHarness([])
    const tenantB = ruleRow({ id: 'r_tenant_b', trigger_config: { job: { kind: 'stock_prep_pull' }, binding: { principalId: 'alerter', tenantId: 'tenant_2' } } })
    const tenantA = ruleRow({ id: 'r_tenant_a' })
    vi.spyOn(service, 'loadEnabledIntegrationRunFinishedRules').mockImplementation(async () => [tenantB, tenantA].map((r) => (service as unknown as { mapRow(r: unknown): never }).mapRow(r)))
    await service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
    expect(executeRule.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual(['r_tenant_a'])
  })

  it('save: a creator who resolves (active, one tenant, manages automation) but holds no integration / stock-prep read code is refused', async () => {
    const inserted: Record<string, unknown>[] = []
    const queryFn = vi.fn(async (sql: string) => (/FROM user_orgs/i.test(sql) ? { rows: [{ org_id: TENANT }], rowCount: 1 } : { rows: [], rowCount: 0 }))
    const service = new AutomationService(new EventBus(), chainDb(inserted) as never, queryFn as never)
    service.setIntegrationRunFinishedCreatorResolverForTest(noReadCode)
    await expect(service.createRule('sheet_1', {
      triggerType: 'integration.run_finished', triggerConfig: { job: { kind: 'stock_prep_pull' } },
      actionType: 'send_dingtalk_group_message', actionConfig: { destinationIds: ['d1'], titleTemplate: 't', bodyTemplate: 'b' }, createdBy: 'alerter',
    } as never)).rejects.toThrow(/integration:read/)
    expect(inserted).toHaveLength(0)
  })

  it('fire: a rule whose creator resolves but lost the read code is skipped; stock-prep:read alone is enough', async () => {
    const { service, executeRule } = dispatchHarness([ruleRow()])
    service.setIntegrationRunFinishedCreatorResolverForTest(noReadCode)
    await service.dispatchIntegrationRunFinished(automationEvent(), { tenantId: TENANT }, ON)
    expect(executeRule).not.toHaveBeenCalled()
    service.setIntegrationRunFinishedCreatorResolverForTest(async () => ({ ok: true as const, user: { id: 'alerter', permissions: ['stock-prep:read'], roles: [] as string[], role: 'user', tenantId: TENANT } }))
    await service.dispatchIntegrationRunFinished(automationEvent({ eventId: 'e'.repeat(64) }), { tenantId: TENANT }, ON)
    expect(executeRule).toHaveBeenCalledTimes(1)
  })
})

// ── 8. I5 ruling on verifier F7: canApply + the five decision counts (baseline v2.3 §10.2.2 ③ wins over ADR §4.1) ──

describe('F7 — the closed set carries canApply and the five per-decision counts, and nothing else new', () => {
  afterEach(() => clearIntegrationRunFinishedSinkForTest())

  it('the closed key sets are exactly these (adding or dropping a key goes red)', () => {
    expect([...INTEGRATION_RUN_FINISHED_EVENT_KEYS]).toEqual([
      'eventId', 'occurredAt', 'job', 'runId', 'status', 'canApply', 'counts', 'durationMs', 'attempts', 'triggeredBy', 'errorClass', 'reason', '_automationDepth',
    ])
    // The names the scheduled-pull script logs (its per-project `counts` = the dry run's planner DECISIONS).
    expect([...INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS]).toEqual(['add', 'update', 'skip', 'inactive', 'manual_confirm'])
    expect([...INTEGRATION_RUN_FINISHED_COUNT_KEYS]).toEqual(['read', 'cleaned', 'written', 'failed', 'add', 'update', 'skip', 'inactive', 'manual_confirm'])
  })

  it('an event without canApply is REFUSED (required), for both origins', () => {
    const plugin = pluginEvent()
    delete plugin.canApply
    expect(validateIntegrationRunFinishedEvent(plugin, 'plugin')).toEqual({ ok: false, code: 'EVENT_KEY_MISSING', field: 'canApply' })
    const automation = pluginEvent({ job: { kind: 'stock_prep_pull', projectNo: 'P-1' }, triggeredBy: 'automation', _automationDepth: 1 })
    delete automation.canApply
    expect(validateIntegrationRunFinishedEvent(automation, 'automation')).toEqual({ ok: false, code: 'EVENT_KEY_MISSING', field: 'canApply' })
  })

  it.each(['add', 'update', 'skip', 'inactive', 'manual_confirm'])('an event whose counts lack %s is REFUSED (required)', (key) => {
    const counts: Record<string, number> = { read: 1, cleaned: 1, written: 0, failed: 0, ...ZERO_DECISIONS }
    delete counts[key]
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts }), 'plugin')).toEqual({ ok: false, code: 'EVENT_FIELD_INVALID', field: `counts.${key}` })
  })

  it.each([
    ['largeBom', { largeBom: true }],
    ['holdCount', { holdCount: 2 }],
    ['applyCounts', { applyCounts: { created: 1 } }],
    ['projectStatus', { projectStatus: 'ready' }],
  ])('a script-log key the ruling did not admit (%s) is still REFUSED, never trimmed', (key, extra) => {
    expect(validateIntegrationRunFinishedEvent(pluginEvent(extra), 'plugin')).toEqual({ ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: key })
  })

  it('the validated, frozen copy carries canApply and all nine counts exactly (values-free integers)', () => {
    const counts = { read: 15, cleaned: 15, written: 0, failed: 0, add: 4, update: 3, skip: 2, inactive: 1, manual_confirm: 5 }
    const result = validateIntegrationRunFinishedEvent(pluginEvent({ canApply: true, counts }), 'plugin')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.canApply).toBe(true)
    expect(result.event.counts).toEqual(counts)
    expect(Object.isFrozen(result.event.counts)).toBe(true)
    expect(Object.keys(result.event.counts)).toEqual([...INTEGRATION_RUN_FINISHED_COUNT_KEYS])
  })

  it('the action layer builder emits canApply and the five decision counts from the unit summary; units without one carry false / 0', () => {
    const units = [
      { projectNo: 'P-1', scopeKey: `stock_prep_pull:${TENANT}:P-1`, outcome: 'succeeded', reason: 'ready', durationMs: 5, summary: { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 4, update: 3, skip: 2, inactive: 1, manual_confirm: 0 } } },
      { projectNo: 'P-2', scopeKey: `stock_prep_pull:${TENANT}:P-2`, outcome: 'held', reason: 'manual_confirm_required', durationMs: 5, summary: { status: 'held', reason: 'manual_confirm_required', canApply: false, counts: { add: 1, manual_confirm: 6 } } },
      { projectNo: 'P-3', scopeKey: `stock_prep_pull:${TENANT}:P-3`, outcome: 'failed', reason: 'X', durationMs: 5 },
    ]
    const events = buildAutomationRunFinishedEvents({
      output: { outcome: 'failed', units }, projectNos: ['P-1', 'P-2', 'P-3', 'P-4'], rootExecutionId: 'r', executionId: 'e', actionKey: 'k', automationDepth: 1, occurredAt: '2026-11-06T06:00:00.000Z',
    })
    expect(events.map((event) => event.canApply)).toEqual([true, false, false, false])
    expect(events[0].counts).toEqual({ read: 10, cleaned: 10, written: 0, failed: 0, add: 4, update: 3, skip: 2, inactive: 1, manual_confirm: 0 })
    expect(events[1].counts).toEqual({ read: 7, cleaned: 7, written: 0, failed: 0, add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 6 })
    expect(events[2].counts).toEqual({ read: 0, cleaned: 0, written: 0, failed: 0, ...ZERO_DECISIONS })
    expect(events[3]).toMatchObject({ status: 'not_started', canApply: false, counts: { ...ZERO_DECISIONS } })
    for (const event of events) expect(validateIntegrationRunFinishedEvent(event, 'automation').ok).toBe(true)
  })
})

// ── 9. gate ③: the summary events vs the scheduled-pull script's log, per project ─────────────────────────────

const requireFromTest = createRequire(import.meta.url)
const { createIntegrationRunPort } = requireFromTest('../../../../plugins/plugin-integration-core/lib/integration-run-port.cjs') as {
  createIntegrationRunPort(deps: { governedEntries: { runGovernedStockPrepPull: (...args: unknown[]) => Promise<unknown>; runGovernedPipeline: (...args: unknown[]) => Promise<unknown> } }): {
    run(input: Record<string, unknown>): Promise<IntegrationRunSummary>
  }
}

/**
 * ONE synthetic decision set: the dry-run `data` the server answers, per project. REALISTIC (I5 ruling N1, round 2):
 * every entry is a combination the real dry run can answer (plugins/plugin-integration-core/lib/
 * stock-preparation-table-actions.cjs — `dryRunStatus`, `withReviewStatus`, `mintable`, and the one response that
 * ALWAYS carries `counts: cloneJson(dryRun.plan.counts)`):
 *   - `ready` only with canApply:true (ready needs dryRun.canApply, and every case that withholds the token has its
 *     own status);
 *   - `manual_confirm_required` WITH canApply:true (a held duplicate batch still mints a token — the plugin's own
 *     stock-preparation-table-actions.test.cjs "a held duplicate batch still mints a token");
 *   - `suspended`, `review_pending`, `recovery_pending` with canApply:false AND the plan counts;
 *   - `not_found` with the empty plan's zero counts (`emptyPlan()`);
 *   - 批次标识 BI-2 (#6818; I5 follow-up at the main merge, T-level default-forward): the two preview-phase signals
 *     the script reads as skipped_pull_batch_installing. `P-INSTALLING` is BI-1b's preview stanza on a READY answer
 *     (a crashed install past its lease, or a host without a lease — the lanes suite's LN-06 and I2's G-08): a token,
 *     canApply:true, the plan counts and `pullBatch: { preview: true, wouldStamp: false, reason: 'installing' }`.
 *     `P-INSTALL-LOCKED` is the dry-run precheck's 409 WRITE_LOCKED while the install HOLDS the sheet's write lease:
 *     an error envelope whose `details` name the holder's purpose (stock-preparation-project-write-lock.cjs
 *     `writeLocked`) — no `data` at all.
 * Synthetic values only; the token, revision, the hold / review / pull-batch stanzas and the lock details never reach
 * the summary. Both sides consume the SAME object: the script through its own HTTP client (fetch stubbed), the event
 * through the plugin's real IntegrationRunPort → core sanitize → the real run_integration_job step →
 * buildAutomationRunFinishedEvents → the publish port's validator.
 */
const GATE3_DRY_RUNS: Record<string, Record<string, unknown>> = {
  'P-READY': { status: 'ready', canApply: true, largeBom: false, dryRunToken: 'tok_synthetic', revision: 'rev_synthetic', counts: { add: 3, update: 1, skip: 5, inactive: 2, manual_confirm: 0 } },
  'P-READY-2': { status: 'ready', canApply: true, largeBom: false, dryRunToken: 'tok_synthetic_2', revision: 'rev_synthetic_2', counts: { add: 0, update: 0, skip: 7, inactive: 0, manual_confirm: 0 } },
  'P-MANUAL': { status: 'manual_confirm_required', canApply: true, largeBom: false, dryRunToken: 'tok_synthetic_3', revision: 'rev_synthetic_3', counts: { add: 1, update: 2, skip: 0, inactive: 0, manual_confirm: 4 } },
  'P-SUSPENDED': { status: 'suspended', canApply: false, largeBom: false, refreshHold: { holdCount: 2 }, counts: { add: 2, update: 0, skip: 1, inactive: 1, manual_confirm: 0 } },
  'P-LARGE': { status: 'large_bom_bounded', canApply: false, largeBom: true, counts: { add: 9, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } },
  'P-REVIEW': { status: 'review_pending', canApply: false, largeBom: false, refreshReview: { pendingReviews: 1, blocksMint: true }, counts: { add: 0, update: 3, skip: 4, inactive: 0, manual_confirm: 0 } },
  'P-NOT-FOUND': { status: 'not_found', canApply: false, largeBom: false, counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } },
  'P-RECOVERY': { status: 'recovery_pending', canApply: false, largeBom: false, counts: { add: 2, update: 1, skip: 3, inactive: 0, manual_confirm: 0 } },
  'P-INSTALLING': { status: 'ready', canApply: true, largeBom: false, dryRunToken: 'tok_synthetic_4', revision: 'rev_synthetic_4', pullBatch: { preview: true, wouldStamp: false, reason: 'installing' }, counts: { add: 4, update: 0, skip: 2, inactive: 0, manual_confirm: 0 } },
  'P-INSTALL-LOCKED': { refusal: { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LOCKED', details: { holderPurpose: 'pull_batch_install', heldSince: '2026-11-08T01:00:00.000Z', interrupted: false } } },
}
/** The one fixture shape that is a REFUSAL (an HTTP error envelope on the script side, a thrown lock error on the port side). */
type Gate3Refusal = { status: number; code: string; details: Record<string, unknown> }
const gate3Refusal = (projectNo: string): Gate3Refusal | null => (GATE3_DRY_RUNS[projectNo].refusal as Gate3Refusal | undefined) ?? null

/**
 * The comparison contract for STATUS (every project): the script logs the dry run's own status verbatim; the summary
 * carries the closed status and keeps the dry run's status as its reason (ready / the held four / not_found), or its
 * error class as errorClass (recovery_pending, the same code the script logs as `error`). I5 ruling N4: not_found →
 * skipped (reason not_found; the script's skipped_not_found) and review_pending → held (reason review_pending; the
 * script's skipped_review_pending, #6791) — both mapped in the plugin port (lib/integration-run-port.cjs).
 * BI-2 follow-up: a READY answer whose pull-batch stanza says `installing`, and the 409 WRITE_LOCKED held by the
 * install, are both held (reason pull_batch_installing; the script's skipped_pull_batch_installing) — exactly the two
 * signals the script reads (scheduled-pull.mjs: `data.pullBatch.reason === 'installing'` after `status === 'ready'`,
 * and `isPullBatchInstallHolder(errorDetailsOf(dryRun))` on a refused preview). The expectation is keyed per PROJECT
 * (`gate3Expectation`), because a dry-run status alone cannot tell `ready` from `ready + installing`.
 */
const GATE3_CLOSED_STATUS: Record<string, string> = {
  ready: 'succeeded',
  manual_confirm_required: 'held',
  suspended: 'held',
  large_bom_bounded: 'held',
  review_pending: 'held',
  not_found: 'skipped',
  recovery_pending: 'failed',
}
/** The script action each dry-run status ends in (dry-run mode, the scheduled task's default). */
const GATE3_SCRIPT_ACTION: Record<string, string> = {
  ready: 'skipped_dry_run_only',
  manual_confirm_required: 'skipped_manual_confirm_required',
  suspended: 'skipped_suspended',
  large_bom_bounded: 'skipped_large_bom_bounded',
  review_pending: 'skipped_review_pending',
  not_found: 'skipped_not_found',
  recovery_pending: 'error',
}
type Gate3Expectation = { action: string; status: string; reason?: string; errorClass?: string }
/** Per project: what the script logs as `action`, the event's closed status, and its reason (or error class when failed). */
function gate3Expectation(projectNo: string): Gate3Expectation {
  if (gate3Refusal(projectNo)) return { action: 'skipped_pull_batch_installing', status: 'held', reason: 'pull_batch_installing' }
  const answer = GATE3_DRY_RUNS[projectNo]
  const dryRunStatus = answer.status as string
  const stanza = answer.pullBatch as { reason?: unknown } | undefined
  if (dryRunStatus === 'ready' && stanza !== undefined && stanza.reason === 'installing') return { action: 'skipped_pull_batch_installing', status: 'held', reason: 'pull_batch_installing' }
  if (dryRunStatus === 'recovery_pending') return { action: 'error', status: 'failed', errorClass: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' }
  return { action: GATE3_SCRIPT_ACTION[dryRunStatus], status: GATE3_CLOSED_STATUS[dryRunStatus], reason: dryRunStatus }
}
/**
 * The comparison contract for canApply (I5 ruling N1, option (a) — baseline v2.3 §10.2.2 ③ as written: "脚本
 * skipped_dry_run_only 对应新路径 succeeded（试算成功、未套用），摘要里带布尔 canApply"): canApply is compared ONLY on
 * that pair (event `succeeded`). DECLARED EXCEPTION 1: every other summary carries canApply:false (the pinned 1b-ii
 * port contract "a held preview is never applicable"), whatever the script logs — a manual_confirm_required preview
 * logs canApply:true, and so does the installing READY preview (the script copies `data.canApply` before it decides
 * the skip; the port holds it because the apply would be refused 409 INSTALL_IN_PROGRESS).
 */
const GATE3_CANAPPLY_COMPARED = (eventStatus: string): boolean => eventStatus === 'succeeded'
/**
 * The comparison contract for the five decision counts: compared for every project whose summary is not `failed`.
 * DECLARED EXCEPTION 2: a failed summary carries no decision counts (all 0; the 1b-ii port answers none for
 * recovery_pending), whatever the script logs — a recovery_pending preview logs the plan counts. A refused preview
 * (P-INSTALL-LOCKED) logs no counts and its held summary carries none: 0 = 0, not an exception.
 */
const GATE3_COUNTS_COMPARED = (eventStatus: string): boolean => eventStatus !== 'failed'
/** The script's summary counters (scheduled-pull.mjs `summarize`) ↔ the events' (status, reason) — the per-day roll-up. */
const GATE3_SUMMARY_COUNTERS: ReadonlyArray<[counter: string, status: string, reason: string | null]> = [
  ['skippedManualConfirmRequired', 'held', 'manual_confirm_required'],
  ['skippedSuspended', 'held', 'suspended'],
  ['skippedReviewPending', 'held', 'review_pending'],
  ['skippedPullBatchInstalling', 'held', 'pull_batch_installing'],
  ['skippedLargeBomBounded', 'held', 'large_bom_bounded'],
  ['skippedNotFound', 'skipped', 'not_found'],
  ['skippedDryRunOnly', 'succeeded', null],
  ['failed', 'failed', null],
]

describe('F7 gate ③ — per project, the summary event equals what the scheduled-pull script logs (status; canApply on the ready pair; counts unless failed)', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(PROJECT_SHEETS_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })

  it('the same realistic decision set ⇒ equal per-project status, canApply (ready pair) and decision counts (non-failed), the summary counters (skippedPullBatchInstalling included), and exactly the declared exceptions', async () => {
    const projectNos = Object.keys(GATE3_DRY_RUNS)
    // Anti-vacuous: the fixture covers every mapped status, and BOTH pull-batch-installing signals (BI-2).
    const statusBearing = projectNos.filter((p) => gate3Refusal(p) === null)
    expect([...new Set(statusBearing.map((p) => GATE3_DRY_RUNS[p].status as string))].sort()).toEqual(Object.keys(GATE3_CLOSED_STATUS).sort())
    expect(projectNos.filter((p) => gate3Expectation(p).reason === 'pull_batch_installing')).toEqual(['P-INSTALLING', 'P-INSTALL-LOCKED'])
    expect(gate3Refusal('P-INSTALL-LOCKED')).not.toBeNull()
    // (a) The script's per-project records (dry-run only, the scheduled task's default mode). A refusal answers the
    // server's error envelope (`ok: false`, the typed code, the lock's details) exactly as `postJson` sees it.
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const projectNo = (JSON.parse(init.body) as { parameters: { projectNo: string } }).parameters.projectNo
      const refusal = gate3Refusal(projectNo)
      if (refusal) {
        return { ok: false, status: refusal.status, json: async () => ({ ok: false, error: { code: refusal.code, message: 'another run is writing this stock-prep sheet; retry after it finishes', details: refusal.details } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: GATE3_DRY_RUNS[projectNo] }) }
    })
    const records = new Map<string, Record<string, unknown>>()
    for (const projectNo of projectNos) {
      records.set(projectNo, await pullOneProject({ apiBase: 'http://stub.invalid', token: 'synthetic-token', tenantId: TENANT, projectNo, applyFlag: false, timeoutMs: 1_000 }) as Record<string, unknown>)
    }
    vi.unstubAllGlobals()

    // (b) The summary events of ONE run_integration_job step over the same projects, through the plugin's real port.
    // The refused project's governed entry throws the lock's own refusal class (status, code, details — the shape
    // stock-preparation-project-write-lock.cjs `writeLocked` builds; the port classifies it, never rethrows it).
    const events = captureSink()
    const port: IntegrationRunPort = {
      run: async (input) => {
        const projectNo = (input.job as { projectNo: string }).projectNo
        const pluginPort = createIntegrationRunPort({
          governedEntries: {
            runGovernedStockPrepPull: async () => {
              const refusal = gate3Refusal(projectNo)
              if (refusal) {
                throw Object.assign(new Error('another run is writing this stock-prep sheet; retry after it finishes'), { name: 'StockPreparationProjectWriteLockError', status: refusal.status, code: refusal.code, details: refusal.details })
              }
              return GATE3_DRY_RUNS[projectNo]
            },
            runGovernedPipeline: async () => { throw new Error('not used') },
          },
        })
        return pluginPort.run({ context: input.context, job: input.job, signal: input.signal, checkpoint: input.checkpoint })
      },
    }
    const { run } = harness(createFakeJobDb(), port)
    await run('exec_gate3', { ...CONFIG, job: { ...CONFIG.job, projectNos } })
    expect(events.map((e) => e.event.job.projectNo)).toEqual(projectNos)

    const exceptions: string[] = []
    for (const projectNo of projectNos) {
      const record = records.get(projectNo)!
      const { event } = events.find((e) => e.event.job.projectNo === projectNo)!
      const label = `project ${projectNo}`
      const expected = gate3Expectation(projectNo)
      // status — compared for every project (a refused preview logs no dry-run status: the action is the comparison)
      if (gate3Refusal(projectNo) === null) expect(record.status, label).toBe(GATE3_DRY_RUNS[projectNo].status)
      else expect(record.status, label).toBeUndefined()
      expect(record.action, label).toBe(expected.action)
      expect(event.status, label).toBe(expected.status)
      if (event.status === 'failed') {
        expect(event.errorClass, label).toBe(record.error)
        expect(event.errorClass, label).toBe(expected.errorClass)
      } else {
        expect(event.reason, label).toBe(expected.reason)
      }
      // canApply — compared on the ready ↔ skipped_dry_run_only / succeeded pair only (the script logs data.canApply === true)
      if (GATE3_CANAPPLY_COMPARED(event.status)) {
        expect(event.canApply, label).toBe(record.canApply === true)
      } else {
        expect(event.canApply, `${label} (declared exception 1)`).toBe(false)
        if (record.canApply === true) exceptions.push(`${projectNo}:canApply`)
      }
      // the five decision counts — the script logs the dry run's `counts` verbatim (absent ⇒ none ⇒ 0)
      const logged = (record.counts ?? {}) as Record<string, unknown>
      for (const key of Object.keys(logged)) expect(INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS as readonly string[], label).toContain(key)
      if (GATE3_COUNTS_COMPARED(event.status)) {
        for (const key of INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS) {
          expect(event.counts[key], `${label} counts.${key}`).toBe(typeof logged[key] === 'number' ? logged[key] : 0)
        }
      } else {
        for (const key of INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS) expect(event.counts[key], `${label} counts.${key} (declared exception 2)`).toBe(0)
        if (INTEGRATION_RUN_FINISHED_DECISION_COUNT_KEYS.some((key) => typeof logged[key] === 'number' && logged[key] !== 0)) exceptions.push(`${projectNo}:counts`)
      }
      // values-free: nothing of the token, revision, the hold / review / pull-batch stanzas or the lock details rides the event
      const serialized = JSON.stringify(event)
      for (const leak of ['tok_synthetic', 'rev_synthetic', 'pendingReviews', 'blocksMint', 'holdCount', 'wouldStamp', '"installing"', 'holderPurpose', 'heldSince', 'retry after']) expect(serialized.includes(leak), `${label} ${leak}`).toBe(false)
    }
    // The realistic fixture EXERCISES the declared exceptions (they are real divergences, not vacuous) — and nothing
    // else diverges. P-INSTALLING is exception 1 too: the script copies canApply:true off the READY answer before it
    // decides skipped_pull_batch_installing; the held summary says false.
    expect(exceptions.sort()).toEqual(['P-INSTALLING:canApply', 'P-MANUAL:canApply', 'P-RECOVERY:counts'])
    // Per-status totals match too (the per-day roll-up a reader compares).
    const tally = (statuses: string[]) => statuses.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
    expect(tally(events.map((e) => e.event.status))).toEqual(tally(projectNos.map((p) => gate3Expectation(p).status)))
    // …and so do the script's own summary counters, skippedPullBatchInstalling included (both signals, counted once each).
    const summary = summarize([...records.values()], false) as Record<string, number>
    expect(summary.projectCount).toBe(events.length)
    expect(summary.skippedPullBatchInstalling).toBe(2)
    for (const [counter, status, reason] of GATE3_SUMMARY_COUNTERS) {
      const matching = events.filter((e) => e.event.status === status && (reason === null || e.event.reason === reason)).length
      expect(summary[counter], counter).toBe(matching)
    }
  })
})
