/**
 * R-69 1c — `integration.run_finished` (Bridge 2): the trigger vocabulary, the closed-key publish port, the action
 * layer's exactly-one-summary-per-job emit, the job-keyed dispatch with its per-rule exactly-once claim, the save
 * gate and the durable leg (ADR adr-automation-pipeline-bridge-20261103 §4; design baseline v2.3 §10.2, §10.2.4 1c
 * rows). Synthetic only: the port is a fake, the ledgers are the in-memory model of tests/utils, no plugin is loaded,
 * no message is sent. R-69 is OPEN: dry-run only, default OFF.
 */
import { readFileSync } from 'node:fs'
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
  TRIGGER_TYPE_BY_EVENT,
  integrationRunFinishedConfiguredStatuses,
  validateIntegrationRunFinishedTriggerConfig,
} from '../../src/multitable/automation-triggers'
import {
  INTEGRATION_RUN_FINISHED_EVENT_KEYS,
  clearIntegrationRunFinishedSinkForTest,
  deriveAutomationRunFinishedEventId,
  publishIntegrationRunFinished,
  registerIntegrationRunFinishedSink,
  validateIntegrationRunFinishedEvent,
  type IntegrationRunEventRoute,
  type IntegrationRunFinishedEvent,
} from '../../src/core/integration-run-events'
import { buildAutomationRunFinishedEvents, runFinishedCountsFrom } from '../../src/multitable/automation-run-finished-events'
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { DURABLE_CONSUMER_KEYS } from '../../src/multitable/automation-durable-activation'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'
import {
  AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED,
  AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED,
} from '../../src/db/migrations/zzzz20261106111500_add_integration_run_finished_trigger_type'

const ACTION_FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
const TENANT = 'tenant_1'
const PRINCIPAL = { id: 'svc_user', permissions: ['stock-prep:pull', 'stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: TENANT }
const BINDING = { principalId: 'svc_user', tenantId: TENANT }
const ON = { [EVENT_FLAG]: 'true' } as NodeJS.ProcessEnv

function pluginEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'run_7',
    occurredAt: '2026-11-06T06:00:00.000Z',
    job: { kind: 'pipeline', pipelineId: 'pipe_1' },
    runId: 'run_7',
    status: 'failed',
    counts: { read: 10, cleaned: 9, written: 0, failed: 1 },
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
    expect([...INTEGRATION_RUN_FINISHED_SKIPPED_REASONS]).toEqual(['principal_unauthorized', 'busy', 'pipeline_changed', 'stale_plan', 'action_disabled'])
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
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts: { read: 1, cleaned: 1, written: 0, failed: 0, add: 1 } }), 'plugin'))
      .toEqual({ ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: 'counts.add' })
    expect(validateIntegrationRunFinishedEvent(pluginEvent({ counts: { read: 1, cleaned: 1, written: 0 } }), 'plugin'))
      .toMatchObject({ ok: false, field: 'counts.failed' })
  })

  it.each([
    ['errorClass with a URL', { errorClass: 'https://host/x' }, 'errorClass'],
    ['errorClass with a message', { errorClass: 'connect ECONNREFUSED HOST-SENTINEL-R69' }, 'errorClass'],
    ['an open reason', { reason: 'free text reason' }, 'reason'],
    ['a pipelineId path', { job: { kind: 'pipeline', pipelineId: 'a/b' } }, 'job.pipelineId'],
    ['a status outside the set', { status: 'done' }, 'status'],
    ['a negative count', { counts: { read: -1, cleaned: 0, written: 0, failed: 0 } }, 'counts.read'],
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
      counts: { read: 3, cleaned: 3, written: 0, failed: 0 },
      attempts: 1,
      triggeredBy: 'automation',
      _automationDepth: 1,
    })
    const actionKey = deriveActionKey({ structuralPath: '0', actionType: 'run_integration_job', canonicalConfig: CONFIG })
    expect(event.eventId).toBe(deriveAutomationRunFinishedEventId({ rootExecutionId: 'exec_1', executionId: 'exec_1', actionKey, projectNo: 'P-1' }))
    expect(event.eventId).toMatch(/^[0-9a-f]{64}$/)
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
    expect(runFinishedCountsFrom({ add: 5, update: 2, skip: 1, inactive: 0, manual_confirm: 3 })).toEqual({ read: 11, cleaned: 11, written: 0, failed: 0 })
    expect(runFinishedCountsFrom({ read: 4, cleaned: 3, written: 2, failed: 1 })).toEqual({ read: 4, cleaned: 3, written: 2, failed: 1 })
    expect(runFinishedCountsFrom(undefined)).toEqual({ read: 0, cleaned: 0, written: 0, failed: 0 })
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
    counts: { read: 0, cleaned: 0, written: 0, failed: 0 },
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
    expect(`${title}\n${body}`).not.toMatch(/\{\{/)
    expect(`${title}\n${body}`).not.toContain(TENANT)
    // a template variable outside run.* renders nothing on this record-less trigger
    expect(renderAutomationTemplate('{{record.x}}{{sheetId}}', { run })).toBe('')
  })
})
