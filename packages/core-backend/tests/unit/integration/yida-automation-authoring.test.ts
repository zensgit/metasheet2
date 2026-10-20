import { afterEach, describe, expect, it, vi } from 'vitest'
import { YIDA_AUTOMATION_ACTION_TYPE as TYPE, YIDA_AUTOMATION_AUTHORING_INVALID as INVALID,
  YIDA_AUTOMATION_EXECUTION_UNAVAILABLE as UNAVAILABLE, containsYidaAutomationAction,
  validYidaAutomationAuthoringShape } from '../../../src/integration/yida-automation-authoring-policy'
import { AutomationService, parseCreateRuleInput, serializeAutomationRule } from '../../../src/multitable/automation-service'
import { AutomationExecutor, type AutomationRule, type ExecutionContext } from '../../../src/multitable/automation-executor'
import type { AutomationAction } from '../../../src/multitable/automation-actions'
import { EventBus } from '../../../src/integration/events/event-bus'
import * as policy from '../../../src/integration/yida-automation-authoring-policy'
import { ALL_ACTION_TYPES } from '../../../src/multitable/automation-actions'
import { AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA } from '../../../src/db/migrations/zzzz20261019120000_add_yida_authorized_automation_action'
import { AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW } from '../../../src/db/migrations/zzzz20261001133000_add_automation_read_preview_action'

const action = (): AutomationAction => ({ type: TYPE, config: { authorizationSlot: 'synthetic-slot' } })
const shape = () => ({ actionType: TYPE, actionConfig: action().config, actions: null, executionMode: null,
  triggerType: 'schedule.interval', triggerConfig: { intervalMs: 60000 }, conditions: null })
const services: AutomationService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); vi.restoreAllMocks(); vi.useRealTimers() })

function serviceFixture(overrides: Record<string, unknown> = {}, producer?: ConstructorParameters<typeof AutomationService>[8]) {
  const stored = { id: 'rule', sheet_id: 'sheet', name: 'Synthetic', trigger_type: 'schedule.interval',
    trigger_config: { intervalMs: 60000 }, action_type: TYPE, action_config: action().config,
    actions: null, execution_mode: null, conditions: null, enabled: false, created_by: 'synthetic-owner',
    created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z', ...overrides }
  const writes: Record<string, unknown>[] = [], chain: Record<string, unknown> = {}
  for (const key of ['selectAll', 'where', 'orderBy', 'returningAll']) chain[key] = () => chain
  chain.executeTakeFirst = async () => stored; chain.execute = async () => [stored]
  for (const key of ['values', 'set']) chain[key] = (row: Record<string, unknown>) => { writes.push(row); return chain }
  const db = { selectFrom: () => chain, insertInto: () => chain, updateTable: () => chain }
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const service = new AutomationService(new EventBus(), db as never, query, undefined, null, {}, undefined, undefined, producer)
  services.push(service)
  return { service, stored, writes, query }
}
function rule(actions: AutomationAction[]): AutomationRule {
  return { id: 'rule', sheetId: 'sheet', name: 'Synthetic', enabled: true, createdBy: 'synthetic-owner',
    createdAt: '2026-10-19T00:00:00Z', trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } }, actions }
}
describe('SA06D authoring is inert and never an execution authorization', () => {
  it('keeps the latest database action enum equal to the app enum plus the two historical aliases, with only the authorized YiDa widening', () => {
    // Historical migrations retain these two database values; they are not
    // authorable application actions. Pin the complete set, not a subset.
    expect([...AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA].sort())
      .toEqual([...ALL_ACTION_TYPES, 'notify', 'update_field'].sort())
    expect(AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW).not.toContain(TYPE)
    expect(AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA.filter(type => type !== TYPE))
      .toEqual([...AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW])
    expect(AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA.filter(type => type === TYPE)).toHaveLength(1)
  })
  it.each([undefined, null, [], [action()]])('accepts only one stable slot representation %j', actions => {
    expect(validYidaAutomationAuthoringShape({ ...shape(), actions })).toBe(true)
    const { actions: _oldActions, ...raw } = shape()
    const parsed = parseCreateRuleInput({ ...raw, ...(actions === undefined ? {} : { actions }) }, 'synthetic-owner')
    expect(parsed.actionType).toBe(TYPE); expect(parsed.actionConfig).toEqual(action().config)
  })
  it.each([
    { actionConfig: {} }, { actionConfig: { authorizationSlot: ' slot ' } },
    { actionConfig: { authorizationSlot: 'synthetic-slot', grantId: 'invented' } },
    { actionConfig: { authorizationSlot: 'synthetic-slot', ownerId: 'invented' } },
    { executionMode: 'workflow_job_v1' }, { triggerType: 'webhook.received' },
    { triggerType: 'schedule.cron', triggerConfig: { expression: '* * * * *' } },
    { triggerConfig: { intervalMs: 60000, source: 'invented' } },
    { conditions: { conjunction: 'and', conditions: [] } }, { actions: [action(), action()] },
    { actions: [{ type: TYPE, config: { authorizationSlot: 'different-slot' } }] },
    { actions: [{ ...action(), grantId: 'invented' }] },
  ])('rejects malformed references, executable mixtures and unsupported triggers %#', async patch => {
    const input = { ...shape(), ...patch }
    expect(validYidaAutomationAuthoringShape(input)).toBe(false)
    expect(() => parseCreateRuleInput(input, 'synthetic-owner')).toThrow(INVALID)
    const f = serviceFixture()
    await expect(f.service.createRule('sheet', { ...input, name: 'Synthetic' } as never)).rejects.toThrow(INVALID)
    expect(f.writes).toHaveLength(0); expect(f.query).not.toHaveBeenCalled()
  })
  it('an explicit empty config cannot borrow a valid modern action config', () => {
    expect(() => parseCreateRuleInput({ ...shape(), actionConfig: {}, actions: [action()] }, 'synthetic-owner')).toThrow(INVALID)
  })
  it('the actual service accepts a valid inert rule and only submits a rule-save write', async () => {
    const f = serviceFixture()
    const input = parseCreateRuleInput({ ...shape(), name: 'Synthetic', enabled: false }, 'synthetic-owner')
    expect(await f.service.createRule('sheet', input)).toMatchObject({ action_type: TYPE, action_config: action().config })
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatchObject({ action_type: TYPE, action_config: JSON.stringify(action().config), enabled: false })
    expect(f.query).not.toHaveBeenCalled()
  })
  it('an ordinary name-only edit of a valid saved slot stays eligible without attaching a grant', async () => {
    const f = serviceFixture()
    expect(await f.service.updateRule('rule', 'sheet', { name: 'rename' })).toMatchObject({ action_type: TYPE })
    expect(f.writes).toHaveLength(1); expect(f.writes[0].name).toBe('rename')
    expect(f.writes[0]).not.toHaveProperty('action_config')
    expect(f.query).not.toHaveBeenCalled()
  })
  it('only the private YiDa action exposes a valid database version, never an ordinary or malformed version', () => {
    const f = serviceFixture(), nonce = '11111111-1111-4111-8111-111111111111'
    expect(serializeAutomationRule({ ...f.stored, integration_authority_revision: nonce } as never).integrationAuthorityRevision).toBe(nonce)
    expect(serializeAutomationRule({ ...f.stored, action_type: 'record_click', integration_authority_revision: nonce } as never)).not.toHaveProperty('integrationAuthorityRevision')
    expect(serializeAutomationRule({ ...f.stored, integration_authority_revision: 'malformed' } as never)).not.toHaveProperty('integrationAuthorityRevision')
  })
  it('a real existing scheduler callback fires but cannot fall back to ordinary execution without a private producer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    const f = serviceFixture(), inspected = vi.spyOn(policy, 'containsYidaAutomationAction')
    f.service.registerSchedule({ ...f.stored, enabled: true } as never)
    const before = inspected.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(inspected.mock.calls.length).toBeGreaterThan(before) // Actual callback reached, not a dormant timer.
    expect(f.query).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0)
  })
  it('does not mistake private-looking text in an ordinary action for executable private code', () => {
    expect(containsYidaAutomationAction('record_click', { text: TYPE }, null)).toBe(false)
    expect(validYidaAutomationAuthoringShape({ ...shape(), actionType: 'record_click', actionConfig: { text: TYPE }, actions: null })).toBe(true)
  })
  it('the existing scheduler keeps the saved interval phase and calls only its explicit private producer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:30Z'))
    const produce = vi.fn(async () => {}), f = serviceFixture({}, { produce })
    f.service.registerSchedule({ ...f.stored, enabled: true } as never)
    await vi.advanceTimersByTimeAsync(29999); expect(produce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(produce).toHaveBeenCalledTimes(1)
    expect(produce.mock.calls[0]).toEqual([{ ruleId: 'rule', triggerType: 'schedule.interval',
      scheduledAtMs: Date.parse('2026-10-19T00:01:00Z'), anchorMs: Date.parse('2026-10-19T00:00:00Z'), intervalMs: 60000 }, expect.any(AbortSignal)])
    expect(f.query).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0)
  })
  it.each([
    { executionMode: 'workflow_job_v1' }, { triggerType: 'record.created' },
    { triggerConfig: { intervalMs: 60000, source: 'invented' } },
    { conditions: { conjunction: 'and', conditions: [] } },
    { actions: [{ type: 'record_click', config: {} }, action()] },
  ])('validates the complete merge on partial update %#', async patch => {
    const f = serviceFixture()
    await expect(f.service.updateRule('rule', 'sheet', patch as never)).rejects.toThrow(INVALID)
    expect(f.writes).toHaveLength(0); expect(f.query).not.toHaveBeenCalled()
  })
  it('even a name-only update cannot normalize a corrupted stored private config into eligibility', async () => {
    const f = serviceFixture({ action_config: { authorizationSlot: 'synthetic-slot', grantId: 'invented' } })
    await expect(f.service.updateRule('rule', 'sheet', { name: 'rename' })).rejects.toThrow(INVALID)
    expect(f.writes).toHaveLength(0)
  })
  it.each(['live', 'simulate'] as const)('refuses %s before any condition IO, business action or job factory', async mode => {
    const queryFn = vi.fn(), fetchFn = vi.fn(), transaction = vi.fn(), loadConditionFields = vi.fn(), lifecycle = vi.fn()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn, fetchFn, transaction, loadConditionFields })
    const candidates: AutomationAction[][] = [[action()], [{ type: 'send_webhook', config: { url: 'synthetic-private' } }, action()],
      [{ type: 'condition_branch', config: { branches: [], defaultBranch: { actions: [
        { type: 'parallel_branch', config: { branches: [{ actions: [action()] }] } },
      ] } } }]]
    for (const actions of candidates) {
      const result = await executor.execute(rule(actions), { private: 'synthetic-private' }, lifecycle, undefined, mode)
      expect(result).toMatchObject({ status: 'failed', error: UNAVAILABLE })
      expect(JSON.stringify(result)).not.toContain('synthetic-private')
    }
    const single = await executor.runSingleAction(action(), { dispatchMode: mode } as never)
    expect(single).toMatchObject({ status: 'failed', error: UNAVAILABLE })
    for (const io of [queryFn, fetchFn, transaction, loadConditionFields, lifecycle]) expect(io).not.toHaveBeenCalled()
  })
  it('both continuation entry points refuse private nodes before settling an existing job', async () => {
    const queryFn = vi.fn(), loadConditionFields = vi.fn(), onSettled = vi.fn(), onStart = vi.fn()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn, loadConditionFields })
    const current = { id: 'existing', steps: [] } as never, lifecycle = { onSettled, onStart } as never
    expect(await executor.continueExecution(current, rule([action()]), {} as never, 0, lifecycle)).toMatchObject({ error: UNAVAILABLE })
    expect(await executor.continueBranchExecution(current, rule([action()]), {} as never, {} as never, lifecycle)).toMatchObject({ error: UNAVAILABLE })
    for (const io of [queryFn, loadConditionFields, onSettled, onStart]) expect(io).not.toHaveBeenCalled()
  })
  it('the same ordinary executor harness does reach the injected transport for a normal permitted webhook', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn: vi.fn(), fetchFn })
    const context: ExecutionContext = { executionId: 'synthetic-execution', ruleId: 'synthetic-rule', sheetId: 'synthetic-sheet',
      recordId: 'synthetic-record', recordData: {}, ruleCreatedBy: 'synthetic-owner', triggerEvent: {}, dispatchMode: 'live' }
    await executor.runSingleAction({ type: 'send_webhook', config: { url: 'https://synthetic.invalid/hook', method: 'POST' } }, context)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
