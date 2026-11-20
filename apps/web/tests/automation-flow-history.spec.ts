/**
 * Integration assistant stage 1d (register R-99 ③; plan integration-assistant-n8n-plan-20261119.md §7):
 *
 *   A. 「最近执行」 in the 1a flow view — the rule's recent runs through the run log's own client call
 *      (getAutomationLogs; no new endpoint): time (business timezone), status, triggeredBy, step counts;
 *      loading / error / empty states; picking a run overlays a per-step STATUS on the top-level cards only when
 *      result i ↔ card `${i}` holds (same count, same type at every position); otherwise it says the rule may
 *      have changed. Values-free: no step output / step error / execution error text is ever rendered.
 *   B. Templates A 「备料 BOM 每日拉取」 and B 「拉取失败告警」 — open only while the editor's own gating session
 *      feature is on (otherwise listed locked with the reason); a template opens a NEW draft in the advanced
 *      editor and never saves; template → save ≡ the same rule built by hand in the Form (deep-equal +
 *      JSON.stringify-equal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ElementPlus from 'element-plus'

import MetaAutomationFlowView from '../src/multitable/components/MetaAutomationFlowView.vue'
import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import {
  FLOW_HISTORY_LIMIT,
  flowHistoryRow,
  flowHistoryStepCounts,
  matchExecutionToFlow,
} from '../src/multitable/automationFlowHistory'
import {
  AUTOMATION_RECIPES,
  AUTOMATION_RULE_TEMPLATES,
  automationRuleTemplateOffers,
  buildAutomationTemplateSeed,
} from '../src/multitable/automationRecipes'
import { formatBusinessTimestamp } from '../src/multitable/utils/business-timezone'
import { automationLabel } from '../src/multitable/utils/meta-automation-labels'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationExecution, AutomationRule } from '../src/multitable/types'
import { epSelectValue, epSetSelect } from './helpers/epControls'

const flags: Record<string, boolean> = {}
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: (feature: string) => flags[feature] === true }),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const TIMEOUT_MS = 30_000
const OUTPUT_MARKER = 'OUTPUT_MARKER_1d_values'
const STEP_ERROR_MARKER = 'STEP_ERROR_MARKER_1d'
const EXEC_ERROR_MARKER = 'EXEC_ERROR_MARKER_1d'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'Flow rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'update_record',
    actionConfig: {},
    enabled: true,
    actions: [
      { type: 'update_record', config: { fields: { fld_1: 'Done' } } },
      { type: 'send_notification', config: { userIds: ['u1'], message: 'hi' } },
    ],
    ...overrides,
  }
}

function execution(overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: 'exec_1',
    ruleId: 'rule_1',
    status: 'failed',
    triggeredBy: 'scheduler',
    triggeredAt: '2026-11-20T01:02:03.000Z',
    duration: 40,
    error: EXEC_ERROR_MARKER,
    steps: [
      { actionType: 'update_record', status: 'success', output: { written: OUTPUT_MARKER }, durationMs: 12 },
      { actionType: 'send_notification', status: 'failed', error: STEP_ERROR_MARKER, output: { detail: OUTPUT_MARKER } },
    ],
    ...overrides,
  }
}

const mountedApps: Array<{ unmount: () => void }> = []

function mountFlowView(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ visible: true, rule: rule(), fields, sheetId: 'sheet_1', ...props })
  const app = createApp({ render: () => h(MetaAutomationFlowView, state) })
  app.mount(container)
  mountedApps.push(app)
  return { container, state }
}

function logsClient(impl: () => Promise<AutomationExecution[]>) {
  return { getAutomationLogs: vi.fn(impl) }
}

const q = (root: ParentNode, selector: string) => root.querySelector(selector) as HTMLElement | null
const history = (c: ParentNode) => q(c, '[data-flow-history="true"]')
const runButton = (c: ParentNode, id: string) => q(c, `[data-flow-history-run="${id}"]`) as HTMLButtonElement | null
const cardRunStatuses = (c: ParentNode) => Array.from(c.querySelectorAll('[data-flow-step="true"]'))
  .map((el) => el.getAttribute('data-step-run-status'))

async function click(el: HTMLElement | null) {
  expect(el, 'element to click').not.toBeNull()
  el!.click()
  await flushPromises()
}

function resetFlags() {
  for (const key of Object.keys(flags)) delete flags[key]
}

beforeEach(() => {
  useLocale().setLocale('en')
  resetFlags()
})

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  resetFlags()
})

// ── A. Execution history ──────────────────────────────────────────────────────────────────────────────

describe('automationFlowHistory (pure)', () => {
  it('matches result i to top-level card `${i}` when count and every type line up', () => {
    const overlay = matchExecutionToFlow(rule(), execution())
    expect(overlay).toEqual({ kind: 'matched', byStepKey: { 0: 'success', 1: 'failed' } })
  })

  it('a simulated step that succeeded shows as simulated; a skipped tail stays skipped', () => {
    const overlay = matchExecutionToFlow(rule(), execution({
      steps: [
        { actionType: 'update_record', status: 'success', simulated: true },
        { actionType: 'send_notification', status: 'skipped', durationMs: 0 },
      ],
    }))
    expect(overlay).toEqual({ kind: 'matched', byStepKey: { 0: 'simulated', 1: 'skipped' } })
  })

  it('a different step count or a different type at any position is "rule changed" — never a partial overlay', () => {
    expect(matchExecutionToFlow(rule(), execution({ steps: [{ actionType: 'update_record', status: 'success' }] })).kind).toBe('rule_changed')
    expect(matchExecutionToFlow(rule(), execution({
      steps: [
        { actionType: 'update_record', status: 'success' },
        { actionType: 'send_email', status: 'success' },
      ],
    })).kind).toBe('rule_changed')
    expect(matchExecutionToFlow(rule({ actions: [{ type: 'update_record', config: {} }] }), execution()).kind).toBe('rule_changed')
  })

  it('a run with no step results (e.g. conditions not met) is "no steps"', () => {
    expect(matchExecutionToFlow(rule(), execution({ steps: [] }))).toEqual({ kind: 'no_steps' })
    expect(matchExecutionToFlow(rule(), execution({ steps: undefined }))).toEqual({ kind: 'no_steps' })
  })

  it('the legacy single-action rule matches on its one card', () => {
    const legacy = rule({ actions: undefined, actionType: 'send_notification', actionConfig: { userIds: ['u'] } })
    expect(matchExecutionToFlow(legacy, execution({ steps: [{ actionType: 'send_notification', status: 'success' }] })))
      .toEqual({ kind: 'matched', byStepKey: { 0: 'success' } })
  })

  it('a row carries time / status / triggeredBy / counts only — no output, no error', () => {
    const row = flowHistoryRow(execution())
    expect(row).toEqual({
      id: 'exec_1',
      time: formatBusinessTimestamp('2026-11-20T01:02:03.000Z', { precision: 'second' }),
      status: 'failed',
      triggeredBy: 'scheduler',
      counts: { total: 2, success: 1, failed: 1, skipped: 0, simulated: 0 },
    })
    expect(JSON.stringify(row)).not.toContain(OUTPUT_MARKER)
    expect(JSON.stringify(row)).not.toContain('ERROR_MARKER')
    expect(flowHistoryStepCounts({ steps: [] })).toEqual({ total: 0, success: 0, failed: 0, skipped: 0, simulated: 0 })
  })
})

describe('flow view 「最近执行」', () => {
  it('reads through getAutomationLogs(sheetId, ruleId, limit) and lists time, status, source and step counts', async () => {
    const client = logsClient(async () => [
      execution(),
      execution({ id: 'exec_2', status: 'success', triggeredBy: 'manual', steps: [
        { actionType: 'update_record', status: 'success', simulated: true },
        { actionType: 'send_notification', status: 'success', simulated: true },
      ] }),
    ])
    const { container } = mountFlowView({ client })
    await flushPromises()

    expect(client.getAutomationLogs).toHaveBeenCalledTimes(1)
    expect(client.getAutomationLogs).toHaveBeenCalledWith('sheet_1', 'rule_1', FLOW_HISTORY_LIMIT)
    const section = history(container)!
    expect(section.textContent).toContain('Recent runs')
    const first = runButton(section, 'exec_1')!
    expect(q(first, '[data-flow-history-time]')?.textContent).toBe(formatBusinessTimestamp('2026-11-20T01:02:03.000Z', { precision: 'second' }))
    expect(q(first, '[data-flow-history-status]')?.textContent).toBe('failed')
    expect(q(first, '[data-flow-history-by]')?.textContent).toBe('Source: scheduler')
    expect(q(first, '[data-flow-history-counts]')?.textContent).toBe('2 steps · succeeded 1 · failed 1')
    expect(q(runButton(section, 'exec_2')!, '[data-flow-history-counts]')?.textContent).toBe('2 steps · simulated 2')
    expect(q(section, '[data-flow-history-count]')?.textContent).toBe('2')
    // read-only: nothing to retry / rerun / test from here
    expect(section.querySelectorAll('input, textarea, select').length).toBe(0)
  })

  it('zh: business-timezone time and localized labels', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountFlowView({ client: logsClient(async () => [execution()]) })
    await flushPromises()
    const section = history(container)!
    expect(section.textContent).toContain('最近执行')
    expect(q(section, '[data-flow-history-status]')?.textContent).toBe('失败')
    expect(q(section, '[data-flow-history-counts]')?.textContent).toBe('2 步 · 成功 1 · 失败 1')
  })

  it('loading → rows; the loading line shows while the call is pending', async () => {
    let resolve!: (value: AutomationExecution[]) => void
    const client = logsClient(() => new Promise<AutomationExecution[]>((r) => { resolve = r }))
    const { container } = mountFlowView({ client })
    await flushPromises()
    expect(q(container, '[data-flow-history-loading]')?.textContent).toBe('Loading runs…')
    expect(q(container, '[data-flow-history-run]')).toBeNull()
    resolve([execution()])
    await flushPromises()
    expect(q(container, '[data-flow-history-loading]')).toBeNull()
    expect(runButton(container, 'exec_1')).not.toBeNull()
  })

  it('empty: says the rule has not run yet', async () => {
    const { container } = mountFlowView({ client: logsClient(async () => []) })
    await flushPromises()
    expect(q(container, '[data-flow-history-empty]')?.textContent).toBe('This rule has not run yet.')
    expect(q(container, '[data-flow-history-count]')).toBeNull()
  })

  it('error: a fixed sentence (never the failure text) and a retry that calls again', async () => {
    let fail = true
    const client = logsClient(async () => {
      if (fail) throw new Error('db host 10.0.0.1 password=hunter2')
      return [execution()]
    })
    const { container } = mountFlowView({ client })
    await flushPromises()
    const err = q(container, '[data-flow-history-error]')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('Could not load the runs.')
    expect(container.textContent).not.toContain('hunter2')
    expect(container.textContent).not.toContain('10.0.0.1')
    fail = false
    await click(q(err, '[data-flow-history-retry]'))
    expect(client.getAutomationLogs).toHaveBeenCalledTimes(2)
    expect(q(container, '[data-flow-history-error]')).toBeNull()
    expect(runButton(container, 'exec_1')).not.toBeNull()
  })

  it('no client or no sheet: the section is not shown and nothing is fetched', async () => {
    const client = logsClient(async () => [])
    const a = mountFlowView({ client: undefined })
    const b = mountFlowView({ client, sheetId: '' })
    await flushPromises()
    expect(history(a.container)).toBeNull()
    expect(history(b.container)).toBeNull()
    expect(client.getAutomationLogs).not.toHaveBeenCalled()
    // the 1a flow itself still renders
    expect(a.container.querySelectorAll('[data-flow-step="true"]').length).toBe(2)
  })

  it('picking a matching run overlays each top-level card with its step status; picking it again clears', async () => {
    const { container } = mountFlowView({ client: logsClient(async () => [execution()]) })
    await flushPromises()
    expect(cardRunStatuses(container)).toEqual([null, null])

    await click(runButton(container, 'exec_1'))
    expect(runButton(container, 'exec_1')!.getAttribute('aria-pressed')).toBe('true')
    expect(cardRunStatuses(container)).toEqual(['success', 'failed'])
    const badges = Array.from(container.querySelectorAll('[data-flow-step-run]')).map((el) => el.textContent)
    expect(badges).toEqual(['succeeded', 'failed'])
    expect(q(container, '[data-flow-history-overlay]')?.getAttribute('data-flow-history-overlay')).toBe('matched')

    await click(runButton(container, 'exec_1'))
    expect(cardRunStatuses(container)).toEqual([null, null])
    expect(q(container, '[data-flow-history-overlay]')).toBeNull()

    await click(runButton(container, 'exec_1'))
    await click(q(container, '[data-flow-history-clear]'))
    expect(cardRunStatuses(container)).toEqual([null, null])
  })

  it('a run that no longer lines up with the rule says so and overlays NOTHING', async () => {
    const { container } = mountFlowView({
      client: logsClient(async () => [execution({ steps: [{ actionType: 'update_record', status: 'success' }] })]),
    })
    await flushPromises()
    await click(runButton(container, 'exec_1'))
    const note = q(container, '[data-flow-history-overlay]')!
    expect(note.getAttribute('data-flow-history-overlay')).toBe('rule_changed')
    expect(note.textContent).toContain('The rule may have changed since this run')
    expect(cardRunStatuses(container)).toEqual([null, null])
    expect(container.querySelectorAll('[data-flow-step-run]').length).toBe(0)
  })

  it('zh: the mismatch reads 规则可能已改动…无法逐步对应; a step-less run reads 没有逐步记录', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountFlowView({
      client: logsClient(async () => [
        execution({ steps: [{ actionType: 'send_email', status: 'success' }, { actionType: 'send_notification', status: 'success' }] }),
        execution({ id: 'exec_2', status: 'skipped', steps: [] }),
      ]),
    })
    await flushPromises()
    await click(runButton(container, 'exec_1'))
    expect(q(container, '[data-flow-history-overlay]')?.textContent).toContain('规则可能已改动（步骤数或类型与这次执行对不上），无法逐步对应。')
    await click(runButton(container, 'exec_2'))
    expect(q(container, '[data-flow-history-overlay]')?.getAttribute('data-flow-history-overlay')).toBe('no_steps')
    expect(q(container, '[data-flow-history-overlay]')?.textContent).toContain('没有逐步记录')
    expect(cardRunStatuses(container)).toEqual([null, null])
  })

  it('values-free: no step output, step error or execution error text reaches the page, before or after picking', async () => {
    const { container } = mountFlowView({ client: logsClient(async () => [execution()]) })
    await flushPromises()
    const check = () => {
      const text = document.body.textContent ?? ''
      expect(text).not.toContain(OUTPUT_MARKER)
      expect(text).not.toContain(STEP_ERROR_MARKER)
      expect(text).not.toContain(EXEC_ERROR_MARKER)
      expect(document.body.innerHTML).not.toContain(OUTPUT_MARKER)
    }
    check()
    await click(runButton(container, 'exec_1'))
    check()
  })

  it('switching to another rule reloads for that rule and drops the previous overlay', async () => {
    const client = logsClient(async () => [execution()])
    const { container, state } = mountFlowView({ client })
    await flushPromises()
    await click(runButton(container, 'exec_1'))
    expect(cardRunStatuses(container)).toEqual(['success', 'failed'])
    state.rule = rule({ id: 'rule_2' })
    await flushPromises()
    expect(client.getAutomationLogs).toHaveBeenLastCalledWith('sheet_1', 'rule_2', FLOW_HISTORY_LIMIT)
    expect(cardRunStatuses(container)).toEqual([null, null])
  })
})

// ── Manager wiring (real MultitableApiClient over a fetch stub) ───────────────────────────────────────────

function managerClient(rules: AutomationRule[], logs: AutomationExecution[]) {
  const calls: Array<{ method: string; url: string }> = []
  const ok = (body: unknown) => new Response(JSON.stringify({ ok: true, data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url })
    if (method === 'GET' && url.includes('/logs')) return ok({ executions: logs })
    if (method === 'GET' && url.endsWith('/stats')) return ok({ total: 0, success: 0, failed: 0, skipped: 0, avgDuration: 0 })
    if (method === 'GET' && url.includes('/automations')) return ok({ rules })
    return ok({})
  })
  const client = new MultitableApiClient({ fetchFn })
  client.listFormShareCandidates = vi.fn(async () => ({ items: [], total: 0, limit: 8, query: '' }))
  return { client, calls }
}

function mountManager(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationManager, { visible: true, sheetId: 'sheet_1', fields, views: [], ...props }) })
  app.use(ElementPlus)
  app.mount(container)
  mountedApps.push(app)
  return { container }
}

describe('manager → flow view → 最近执行', () => {
  it('the flow view opened from a rule card reads that rule\'s runs through the manager\'s client (the run-log route)', async () => {
    const { client, calls } = managerClient([rule()], [execution()])
    const { container } = mountManager({ client })
    await flushPromises()
    await click(q(container, '[data-automation-flow-view-open="true"]'))
    await flushPromises()
    const view = q(document, '[data-automation-flow-view]')!
    expect(runButton(view, 'exec_1')).not.toBeNull()
    const logCalls = calls.filter((c) => c.url.includes('/automations/rule_1/logs'))
    expect(logCalls.length).toBeGreaterThanOrEqual(1)
    expect(logCalls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.some((c) => c.url.includes(`/automations/rule_1/logs?limit=${FLOW_HISTORY_LIMIT}`))).toBe(true)
    // read-only: opening the history and picking a run writes nothing
    await click(runButton(view, 'exec_1'))
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  }, TIMEOUT_MS)
})

// ── B. Templates A / B ───────────────────────────────────────────────────────────────────────────────────

describe('rule templates (pure)', () => {
  it('two templates, each gated by the session feature the editor gates its trigger / action on', () => {
    expect(AUTOMATION_RULE_TEMPLATES.map((t) => [t.key, t.requiredFeature])).toEqual([
      ['stock-prep-daily-pull', 'integrationAutomationRunAction'],
      ['stock-prep-pull-failed-alert', 'integrationAutomationRunEvent'],
    ])
    const offers = (on: string[]) => automationRuleTemplateOffers((f) => on.includes(f)).map((o) => [o.template.key, o.open])
    expect(offers([])).toEqual([['stock-prep-daily-pull', false], ['stock-prep-pull-failed-alert', false]])
    expect(offers(['integrationAutomationRunAction'])).toEqual([['stock-prep-daily-pull', true], ['stock-prep-pull-failed-alert', false]])
    expect(offers(['integrationAutomationRunEvent'])).toEqual([['stock-prep-daily-pull', false], ['stock-prep-pull-failed-alert', true]])
    // the quick-form recipes are untouched (their own spec pins quick-form-only types)
    expect(AUTOMATION_RECIPES.map((r) => r.key)).toEqual(['created-notify', 'updated-notify', 'field-changed-update'])
  })

  it('template A seed: 06:00 Asia/Shanghai cron → the dry-run stock-prep pull with NO project', () => {
    const seed = buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[0], true)
    const action = { type: 'run_integration_job', config: { job: { kind: 'stock_prep_pull', projectNos: [], applyMode: 'dry_run_only' } } }
    expect(seed).toEqual({
      name: '备料 BOM 每日拉取',
      triggerType: 'schedule.cron',
      triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
      actionType: 'run_integration_job',
      actionConfig: action.config,
      actions: [action],
    })
  })

  it('template B seed: run_finished (stock_prep_pull, failed only) → in-app notification with NO recipient', () => {
    const seed = buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[1], true)
    expect(seed.name).toBe('拉取失败告警')
    expect(seed.triggerType).toBe('integration.run_finished')
    expect(seed.triggerConfig).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['failed'] })
    expect(seed.actions).toEqual([{ type: 'send_notification', config: { userIds: [], message: automationLabel('recipe.stockPrepPullFailedAlertMessage', true) } }])
    expect(seed.actionType).toBe('send_notification')
    // a fresh object each call (the editor mutates its draft in place)
    expect(buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[1], true).triggerConfig).not.toBe(seed.triggerConfig)
  })
})

describe('manager: 从模板新建', () => {
  async function openTemplates(container: HTMLElement) {
    await click(q(container, '[data-automation-new-rule="template"]'))
    return q(container, '[data-automation-templates="true"]')!
  }

  it('both switches off: both templates listed LOCKED with their reasons; clicking opens nothing', async () => {
    const { client, calls } = managerClient([], [])
    const { container } = mountManager({ client })
    await flushPromises()
    const panel = await openTemplates(container)
    for (const key of ['stock-prep-daily-pull', 'stock-prep-pull-failed-alert']) {
      const card = q(panel, `[data-automation-template="${key}"]`) as HTMLButtonElement
      expect(card.disabled, key).toBe(true)
      expect(card.getAttribute('data-template-locked')).toBe('true')
    }
    expect(q(panel, '[data-automation-template="stock-prep-daily-pull"] [data-template-locked-reason]')?.textContent)
      .toContain('integrationAutomationRunAction')
    expect(q(panel, '[data-automation-template="stock-prep-pull-failed-alert"] [data-template-locked-reason]')?.textContent)
      .toContain('integrationAutomationRunEvent')
    ;(q(panel, '[data-automation-template="stock-prep-daily-pull"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(q(container, '.meta-rule-editor__title')).toBeNull()
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  }, TIMEOUT_MS)

  it('run-action switch on: A opens a NEW draft in the advanced editor (nothing saved); B stays locked', async () => {
    flags.integrationAutomationRunAction = true
    const { client, calls } = managerClient([], [])
    const { container } = mountManager({ client })
    await flushPromises()
    const panel = await openTemplates(container)
    expect((q(panel, '[data-automation-template="stock-prep-pull-failed-alert"]') as HTMLButtonElement).disabled).toBe(true)
    const a = q(panel, '[data-automation-template="stock-prep-daily-pull"]') as HTMLButtonElement
    expect(a.disabled).toBe(false)
    expect(a.getAttribute('data-template-locked')).toBeNull()
    await click(a)

    expect(q(container, '.meta-rule-editor__title')?.textContent).toContain('New Automation Rule')
    expect(epSelectValue(q(container, '[data-field="triggerType"]')!.closest('.el-select') ?? q(container, '[data-field="triggerType"]'))).toBe('schedule.cron')
    expect((q(container, '[data-field="cronExpression"] input, input[data-field="cronExpression"]') as HTMLInputElement).value).toBe('0 6 * * *')
    expect(q(container, '[data-action-config="run_integration_job"]')).not.toBeNull()
    const projects = q(container, '[data-field="rijProjectNosText"] textarea, textarea[data-field="rijProjectNosText"]') as HTMLTextAreaElement
    expect(projects.value).toBe('')
    // the empty project list is refused by the editor's existing save gate
    expect(container.querySelectorAll('[data-action="save-block-reason"]').length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  }, TIMEOUT_MS)

  it('run-event switch on: B opens; A stays locked', async () => {
    flags.integrationAutomationRunEvent = true
    const { client, calls } = managerClient([], [])
    const { container } = mountManager({ client })
    await flushPromises()
    const panel = await openTemplates(container)
    expect((q(panel, '[data-automation-template="stock-prep-daily-pull"]') as HTMLButtonElement).disabled).toBe(true)
    await click(q(panel, '[data-automation-template="stock-prep-pull-failed-alert"]'))
    expect(q(container, '.meta-rule-editor__title')?.textContent).toContain('New Automation Rule')
    expect(q(container, '[data-field="runFinishedJobKind"]')).not.toBeNull()
    const checked = Array.from(container.querySelectorAll('[data-field="runFinishedStatuses"] .el-checkbox.is-checked'))
      .map((el) => el.getAttribute('data-status'))
    expect(checked).toEqual(['failed'])
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  }, TIMEOUT_MS)
})

// ── Template → save ≡ hand-built Form rule ─────────────────────────────────────────────────────────────

function editorClient() {
  return {
    listDingTalkGroups: vi.fn(async () => []),
    listApprovalTemplates: vi.fn(async () => ({ data: [], total: 0 })),
    listSheets: vi.fn(async () => ({ sheets: [] })),
    listFields: vi.fn(async () => ({ fields })),
    listFormShareCandidates: vi.fn(async () => ({ items: [], total: 0, limit: 8, query: '' })),
  }
}

function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ visible: true, sheetId: 'sheet_1', fields, client: editorClient(), ...props })
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, state) })
  app.use(ElementPlus)
  app.mount(container)
  mountedApps.push(app)
  // Two Element Plus apps in one jsdom document generate the same popper ids, so an el-select of the second
  // editor can resolve to the first editor's option list. The parity cases therefore run ONE editor at a time.
  const unmount = () => {
    app.unmount()
    container.remove()
    mountedApps.splice(mountedApps.indexOf(app), 1)
  }
  return { container, state, unmount }
}

const actionTypeSelect = (c: HTMLElement) => c.querySelector('.meta-rule-editor__action-row .meta-rule-editor__action-header .el-select')

function setText(c: HTMLElement, field: string, value: string) {
  const el = q(c, `[data-field="${field}"] textarea, [data-field="${field}"] input, textarea[data-field="${field}"], input[data-field="${field}"]`) as HTMLInputElement | HTMLTextAreaElement
  expect(el, field).not.toBeNull()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectOf(c: HTMLElement, field: string): Element {
  const el = q(c, `[data-field="${field}"]`)!
  return el.classList.contains('el-select') ? el : (el.closest('.el-select') ?? el)
}

async function save(c: HTMLElement, saved: ReturnType<typeof vi.fn>) {
  const btn = q(c, '[data-action="save"]') as HTMLButtonElement
  expect(Array.from(c.querySelectorAll('[data-action="save-block-reason"]')).map((el) => el.textContent?.trim())).toEqual([])
  expect(btn.disabled, 'save enabled').toBe(false)
  btn.click()
  await flushPromises()
  expect(saved).toHaveBeenCalledTimes(1)
  return saved.mock.calls[0][0] as Record<string, unknown>
}

describe('template → save ≡ the same rule built by hand in the Form', () => {
  it('template A (run-action switch on): same name and project filled in → identical payload', async () => {
    flags.integrationAutomationRunAction = true
    const seed = buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[0], false)
    const savedT = vi.fn()
    const savedH = vi.fn()
    const t = mountEditor({ seedRule: seed, onSave: savedT })
    await flushPromises()

    // template: the author fills only the project number
    setText(t.container, 'rijProjectNosText', 'P-001')
    await flushPromises()
    const fromTemplate = await save(t.container, savedT)
    t.unmount()

    // by hand: name, schedule.cron, custom 0 6 * * *, run_integration_job, the same project
    const hand = mountEditor({ onSave: savedH })
    await flushPromises()
    setText(hand.container, 'name', seed.name)
    epSetSelect(selectOf(hand.container, 'triggerType'), 'schedule.cron')
    await flushPromises()
    epSetSelect(selectOf(hand.container, 'cronPreset'), 'custom')
    await flushPromises()
    setText(hand.container, 'cronExpression', '0 6 * * *')
    epSetSelect(actionTypeSelect(hand.container), 'run_integration_job')
    await flushPromises()
    setText(hand.container, 'rijProjectNosText', 'P-001')
    await flushPromises()

    const byHand = await save(hand.container, savedH)
    expect(fromTemplate).toEqual(byHand)
    expect(JSON.stringify(fromTemplate)).toBe(JSON.stringify(byHand))
    expect(fromTemplate.triggerConfig).toEqual({ cron: '0 6 * * *', timezone: 'Asia/Shanghai' })
    expect(fromTemplate.actions).toEqual([{
      type: 'run_integration_job',
      config: { job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000 },
    }])
    expect(JSON.stringify(fromTemplate)).not.toContain('binding')
  }, TIMEOUT_MS)

  it('template B (run-event switch on): same recipient filled in → identical payload', async () => {
    flags.integrationAutomationRunEvent = true
    const seed = buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[1], false)
    const message = (seed.actions[0].config as { message: string }).message
    const savedT = vi.fn()
    const savedH = vi.fn()
    const t = mountEditor({ seedRule: seed, onSave: savedT })
    await flushPromises()

    setText(t.container, 'notificationUserIds', 'user_1')
    await flushPromises()
    const fromTemplate = await save(t.container, savedT)
    t.unmount()

    const hand = mountEditor({ onSave: savedH })
    await flushPromises()
    setText(hand.container, 'name', seed.name)
    epSetSelect(selectOf(hand.container, 'triggerType'), 'integration.run_finished')
    await flushPromises()
    // the Form opens on the server's default alert set; untick all but 失败
    for (const status of ['partial', 'skipped', 'outcome_unknown', 'not_started']) {
      const box = Array.from(hand.container.querySelectorAll('[data-field="runFinishedStatuses"] input[type="checkbox"]'))
        .find((el) => (el as HTMLInputElement).value === status) as HTMLInputElement
      expect(box?.checked, status).toBe(true)
      box.click()
      await flushPromises()
    }
    epSetSelect(actionTypeSelect(hand.container), 'send_notification')
    await flushPromises()
    setText(hand.container, 'notificationUserIds', 'user_1')
    setText(hand.container, 'notificationMessage', message)
    await flushPromises()

    const byHand = await save(hand.container, savedH)
    expect(fromTemplate).toEqual(byHand)
    expect(JSON.stringify(fromTemplate)).toBe(JSON.stringify(byHand))
    expect(fromTemplate.triggerConfig).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['failed'] })
    expect(fromTemplate.actions).toEqual([{ type: 'send_notification', config: { userIds: ['user_1'], message } }])
  }, TIMEOUT_MS)

  it('an empty template A cannot be saved until a project is filled (the existing save gate, unchanged)', async () => {
    flags.integrationAutomationRunAction = true
    const saved = vi.fn()
    const t = mountEditor({ seedRule: buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[0], false), onSave: saved })
    await flushPromises()
    expect(t.container.querySelectorAll('[data-action="save-block-reason"]').length).toBeGreaterThan(0)
    ;(q(t.container, '[data-action="save"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  }, TIMEOUT_MS)

  it('a template\'s action opens EXPANDED like a fresh row (not collapsed like a loaded one), so the fields to fill are visible', async () => {
    flags.integrationAutomationRunAction = true
    const expanded = (c: HTMLElement) => c.querySelectorAll('.meta-rule-editor__action-collapse .el-collapse-item.is-active').length
    const seed = buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[0], false)
    const t = mountEditor({ seedRule: seed })
    await flushPromises()
    expect(expanded(t.container)).toBe(1)
    t.unmount()
    // control: the same shape loaded as a STORED rule starts collapsed
    const stored = mountEditor({ rule: rule({ ...seed, id: 'rule_stored', actions: seed.actions }) })
    await flushPromises()
    expect(expanded(stored.container)).toBe(0)
  }, TIMEOUT_MS)

  it('a stored rule wins over a seed (seedRule is only for a NEW rule)', async () => {
    flags.integrationAutomationRunAction = true
    const t = mountEditor({
      rule: rule({ name: 'Stored', triggerType: 'record.created' }),
      seedRule: buildAutomationTemplateSeed(AUTOMATION_RULE_TEMPLATES[0], false),
    })
    await flushPromises()
    expect((q(t.container, '[data-field="name"] input, input[data-field="name"]') as HTMLInputElement).value).toBe('Stored')
    expect(q(t.container, '[data-action-config="run_integration_job"]')).toBeNull()
  }, TIMEOUT_MS)
})
