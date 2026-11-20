/**
 * Integration assistant stage 1b (owner 2026-11-19, register R-99 ③; plan
 * docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md §7): the rule editor's
 * 「表单 / 流程」 layout toggle. Flow mode is a second VIEW of the same draft — its ↑ ↓ × / 添加步骤 buttons call
 * the editor's existing moveAction / removeAction / addAction, and Save is the editor's one buildPayload path.
 * The load-bearing case is the byte-identical save: the same edits made in Flow and in Form emit the same JSON.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { automationTriggerTypeLabel } from '../src/multitable/utils/meta-automation-labels'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

const TIMEOUT_MS = 20_000

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

const extension = { nested: true }

/** Three saved actions; the webhook and the cross-base update carry keys the editor does not model. */
const SAVED_ACTIONS = [
  {
    type: 'update_record',
    config: {
      fields: { fld_1: 'done' },
      targetBaseId: 'base_x',
      targetSheetId: 'sheet_x',
      targetRecordId: 'rec_x',
      x_customerExtension: extension,
    },
  },
  {
    type: 'send_webhook',
    config: {
      url: 'https://example.test/hook',
      method: 'POST',
      headers: { 'X-Trace': '1' },
      body: { payload: 'custom' },
      secret: 's3cr3t',
      x_customerExtension: extension,
    },
  },
  { type: 'send_notification', config: { userIds: ['user_1'], message: 'hi' } },
]

function savedRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_flow',
    sheetId: 'sheet_1',
    name: 'Flow rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: SAVED_ACTIONS[0].type,
    actionConfig: SAVED_ACTIONS[0].config,
    enabled: true,
    actions: JSON.parse(JSON.stringify(SAVED_ACTIONS)),
    ...overrides,
  } as AutomationRule
}

const RIJ_CONFIG = {
  job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' },
  timeoutMs: 20 * 60_000,
}

const mountedApps: Array<{ unmount: () => void }> = []

function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ visible: true, sheetId: 'sheet_1', fields, ...props })
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, state) })
  app.mount(container)
  mountedApps.push(app)
  return { container, state }
}

const q = (root: ParentNode, selector: string) => root.querySelector(selector) as HTMLElement | null
const flowPanel = (c: HTMLElement) => q(c, '[data-automation-flow-edit="true"]')
const flowCards = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-flow-step="true"]')) as HTMLElement[]
const formRows = (c: HTMLElement) => Array.from(c.querySelectorAll('.meta-rule-editor__action-row')) as HTMLElement[]

async function click(el: HTMLElement | null) {
  expect(el, 'element to click').not.toBeNull()
  el!.click()
  await flushPromises()
}

async function setMode(c: HTMLElement, mode: 'form' | 'flow') {
  await click(q(c, `[data-editor-mode="${mode}"]`))
}

async function save(c: HTMLElement, saved: ReturnType<typeof vi.fn>) {
  const btn = q(c, '[data-action="save"]') as HTMLButtonElement
  expect(btn.disabled).toBe(false)
  btn.click()
  await flushPromises()
  expect(saved).toHaveBeenCalledTimes(1)
  return saved.mock.calls[0][0] as Record<string, unknown>
}

describe('rule editor: Form / Flow layout toggle (integration assistant 1b)', () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  let scrollSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    useLocale().setLocale('en')
    scrollSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollSpy })
  })

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount()
    document.body.innerHTML = ''
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    useLocale().setLocale('en')
  })

  it('renders the toggle with Form as the default; Flow shows the trigger card and one card per action with the Form summaries', async () => {
    const { container } = mountEditor({
      rule: savedRule({
        conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_1', operator: 'eq', value: 'x' }] } as AutomationRule['conditions'],
      }),
    })
    await flushPromises()

    const formBtn = q(container, '[data-editor-mode="form"]')!
    const flowBtn = q(container, '[data-editor-mode="flow"]')!
    expect(formBtn.textContent?.trim()).toBe('Form')
    expect(flowBtn.textContent?.trim()).toBe('Flow')
    expect(formBtn.getAttribute('aria-pressed')).toBe('true')
    expect(flowBtn.getAttribute('aria-pressed')).toBe('false')
    expect(flowPanel(container)).toBeNull()
    expect(formRows(container)).toHaveLength(3)
    for (const row of formRows(container)) expect(row.style.display).not.toBe('none')

    const formSummaries = formRows(container).map((row) => q(row, '[data-field="actionSummary"]')?.textContent?.trim())
    expect(formSummaries.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)

    await setMode(container, 'flow')
    expect(flowBtn.getAttribute('aria-pressed')).toBe('true')
    const panel = flowPanel(container)!
    expect(panel).not.toBeNull()
    // The long config section is hidden, not unmounted (v-show) — the same draft and the same DOM.
    for (const row of formRows(container)) expect(row.style.display).toBe('none')

    const trigger = q(panel, '[data-flow-trigger="true"]')!
    expect(trigger.getAttribute('data-trigger-type')).toBe('record.created')
    expect(trigger.textContent).toContain(automationTriggerTypeLabel('record.created', false))
    expect(q(panel, '[data-flow-conditions="true"]')).not.toBeNull()

    const cards = flowCards(container)
    expect(cards.map((c) => c.getAttribute('data-step-type'))).toEqual(['update_record', 'send_webhook', 'send_notification'])
    expect(cards.map((c) => q(c, '[data-flow-step-summary="true"]')?.textContent?.trim())).toEqual(formSummaries)
    // first card has no ↑, last card has no ↓, every card has × and 配置.
    expect(q(cards[0], '[data-flow-step-action="up"]')).toBeNull()
    expect(q(cards[2], '[data-flow-step-action="down"]')).toBeNull()
    for (const card of cards) {
      expect(q(card, '[data-flow-step-action="remove"]')).not.toBeNull()
      expect(q(card, '[data-flow-step-action="configure"]')?.textContent?.trim()).toBe('Configure')
    }

    // Clicking the trigger card goes back to Form (trigger editing stays there).
    await click(trigger)
    expect(flowPanel(container)).toBeNull()
    expect(formBtn.getAttribute('aria-pressed')).toBe('true')
  }, TIMEOUT_MS)

  it('shows zh copy 表单 / 流程 / 添加步骤 / 配置', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountEditor({ rule: savedRule({ actions: [SAVED_ACTIONS[1]] as AutomationRule['actions'] }) })
    await flushPromises()
    expect(q(container, '[data-editor-mode="form"]')?.textContent?.trim()).toBe('表单')
    expect(q(container, '[data-editor-mode="flow"]')?.textContent?.trim()).toBe('流程')
    await setMode(container, 'flow')
    expect(q(container, '[data-flow-add-step="true"]')?.textContent?.trim()).toBe('+ 添加步骤')
    expect(q(container, '[data-flow-step-action="configure"]')?.textContent?.trim()).toBe('配置')
  }, TIMEOUT_MS)

  it('byte-identical save: move-down + remove in Flow emits exactly what the same edits in Form emit', async () => {
    const savedA = vi.fn()
    const savedB = vi.fn()
    const a = mountEditor({ rule: savedRule(), onSave: savedA })
    const b = mountEditor({ rule: savedRule(), onSave: savedB })
    await flushPromises()

    // A — Flow mode: move step 1 down, then remove the (now) third step.
    await setMode(a.container, 'flow')
    await click(q(flowCards(a.container)[0], '[data-flow-step-action="down"]'))
    expect(flowCards(a.container).map((c) => c.getAttribute('data-step-type'))).toEqual(['send_webhook', 'update_record', 'send_notification'])
    await click(q(flowCards(a.container)[2], '[data-flow-step-action="remove"]'))
    expect(flowCards(a.container).map((c) => c.getAttribute('data-step-type'))).toEqual(['send_webhook', 'update_record'])

    // B — Form mode: the same two edits through the form's own header buttons.
    await click(q(b.container, '[data-action-index="0"] button[title="Move down"]'))
    await click(q(b.container, '[data-action-index="2"] button[title="Remove action"]'))
    expect(formRows(b.container)).toHaveLength(2)

    const payloadA = await save(a.container, savedA)
    const payloadB = await save(b.container, savedB)

    expect(payloadA).toEqual(payloadB)
    expect(JSON.stringify(payloadA)).toBe(JSON.stringify(payloadB))
    // …and the edit really happened, with the unmodelled keys riding along untouched.
    const actions = payloadA.actions as Array<{ type: string; config: Record<string, unknown> }>
    expect(actions.map((x) => x.type)).toEqual(['send_webhook', 'update_record'])
    expect(actions[0].config).toMatchObject({ headers: { 'X-Trace': '1' }, secret: 's3cr3t', x_customerExtension: extension })
    expect(actions[1].config).toMatchObject({ targetSheetId: 'sheet_x', targetRecordId: 'rec_x', x_customerExtension: extension })
  }, TIMEOUT_MS)

  it('「配置」 switches to Form with that action expanded and scrolled to', async () => {
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    // Saved actions open collapsed behind their summary.
    const section = (idx: number) => q(container, `[data-action-index="${idx}"] [data-field="actionConfigSection"]`)!
    expect(section(1).classList.contains('is-active')).toBe(false)

    await setMode(container, 'flow')
    await click(q(flowCards(container)[1], '[data-flow-step-action="configure"]'))
    await flushPromises()

    expect(flowPanel(container)).toBeNull()
    expect(q(container, '[data-editor-mode="form"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(section(1).classList.contains('is-active')).toBe(true)
    expect(section(0).classList.contains('is-active')).toBe(false)
    expect(section(2).classList.contains('is-active')).toBe(false)
    expect(scrollSpy).toHaveBeenCalled()
    expect(scrollSpy.mock.instances.at(-1)).toBe(q(container, '[data-action-index="1"]'))
  }, TIMEOUT_MS)

  it('添加步骤 calls the editor addAction and is disabled where addAction would refuse', async () => {
    // 2 actions → enabled; one click appends a third step to the same draft.
    const two = mountEditor({ rule: savedRule({ actions: SAVED_ACTIONS.slice(0, 2) as AutomationRule['actions'] }) })
    await flushPromises()
    await setMode(two.container, 'flow')
    const add = q(two.container, '[data-flow-add-step="true"]') as HTMLButtonElement
    expect(add.disabled).toBe(false)
    expect(q(two.container, '[data-flow-add-blocked="true"]')).toBeNull()
    await click(add)
    expect(flowCards(two.container).map((c) => c.getAttribute('data-step-type'))).toEqual(['update_record', 'send_webhook', 'update_record'])
    expect(formRows(two.container)).toHaveLength(3)
    // …which is now the 3-action cap.
    expect((q(two.container, '[data-flow-add-step="true"]') as HTMLButtonElement).disabled).toBe(true)

    // 3 saved actions → disabled with the max reason.
    const three = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(three.container, 'flow')
    expect((q(three.container, '[data-flow-add-step="true"]') as HTMLButtonElement).disabled).toBe(true)
    expect(q(three.container, '[data-flow-add-blocked="true"]')?.textContent).toContain('at most 3 steps')
    // the form agrees: its add button is not rendered at all.
    expect(q(three.container, '[data-action="add-action"]')).toBeNull()

    // run_integration_job → disabled, nothing may be added beside it.
    const rij = mountEditor({
      rule: savedRule({
        triggerType: 'schedule.cron',
        triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
        actionType: 'run_integration_job',
        actionConfig: RIJ_CONFIG,
        actions: [{ type: 'run_integration_job', config: RIJ_CONFIG }] as AutomationRule['actions'],
      }),
    })
    await flushPromises()
    await setMode(rij.container, 'flow')
    expect(flowCards(rij.container)).toHaveLength(1)
    const rijAdd = q(rij.container, '[data-flow-add-step="true"]') as HTMLButtonElement
    expect(rijAdd.disabled).toBe(true)
    expect(q(rij.container, '[data-flow-add-blocked="true"]')?.textContent).toContain('only step')
    rijAdd.click()
    await flushPromises()
    expect(flowCards(rij.container)).toHaveLength(1)
    expect(q(rij.container, '[data-action="add-action"]')).toBeNull()
  }, TIMEOUT_MS)

  it('Flow mode carries no config inputs — only cards and buttons; the toggle sits outside it', async () => {
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(container, 'flow')
    const panel = flowPanel(container)!
    expect(panel.querySelectorAll('input, select, textarea, [contenteditable]').length).toBe(0)
    expect(panel.querySelectorAll('.el-select, .el-input, .el-textarea').length).toBe(0)
    expect(panel.querySelector('[data-editor-mode]')).toBeNull()
    expect(container.querySelectorAll('[data-editor-mode]')).toHaveLength(2)
  }, TIMEOUT_MS)

  it('the layout is per open: closing and reopening the editor starts in Form again', async () => {
    const { container, state } = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(container, 'flow')
    expect(flowPanel(container)).not.toBeNull()
    state.visible = false
    await flushPromises()
    state.visible = true
    await flushPromises()
    expect(flowPanel(container)).toBeNull()
    expect(q(container, '[data-editor-mode="form"]')?.getAttribute('aria-pressed')).toBe('true')
  }, TIMEOUT_MS)
})
