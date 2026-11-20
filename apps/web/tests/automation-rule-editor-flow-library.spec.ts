/**
 * Integration assistant stage 1c (owner 2026-11-19, register R-99 ③; plan
 * docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md §3.3 / §7): the rule
 * editor's Flow mode gets a node library (节点库) and a read-only go-live gates tab (上线门).
 *
 * Load-bearing claims pinned here:
 * - the library never has a rule of its own: an entry is open exactly when the Form select of the row
 *   「添加动作」 would append offers that type enabled (checked against the real Form select, per scenario);
 * - picking an entry is the Form path (addAction + the row select's type change): the saved payload is
 *   deep-equal and JSON.stringify-equal to doing it in Form;
 * - 「即将开放」 entries are labels only (not action types, not clickable, add nothing);
 * - the gates tab only reports switches the editor already reads, and changes none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ElementPlus from 'element-plus'

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import {
  buildFlowGates,
  buildFlowLibrary,
  FLOW_GATE_OUTBOUND_ACTION_TYPES,
  flowLibraryComingSoon,
  flowLibraryLockReason,
  type FlowLibraryLockContext,
} from '../src/multitable/automationFlowLibrary'
import { automationActionTypeLabel, automationLabel } from '../src/multitable/utils/meta-automation-labels'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationActionType, AutomationRule } from '../src/multitable/types'
import { epOptions, epSelectValue, epSetSelect } from './helpers/epControls'

const flags: Record<string, boolean> = {}
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: (feature: string) => flags[feature] === true }),
}))

const TIMEOUT_MS = 30_000

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

/** Every top-level type the Form select can ever offer a new row (the library's catalog). */
const CATALOG: AutomationActionType[] = [
  'update_record', 'create_record', 'send_webhook', 'send_notification', 'start_approval', 'send_email',
  'send_dingtalk_group_message', 'send_dingtalk_person_message', 'send_dingtalk_approval_card', 'delete_record',
  'wait_for_callback', 'condition_branch', 'parallel_branch', 'lock_record',
  'write_approval_form_values', 'run_integration_job',
]

const NOTIFY = { type: 'send_notification', config: { userIds: ['user_1'], message: 'hi' } }
const RIJ_CONFIG = {
  job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' },
  timeoutMs: 20 * 60_000,
}
const CRON = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }

function savedRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  const actions = (overrides.actions ?? [NOTIFY]) as Array<{ type: string; config: Record<string, unknown> }>
  return {
    id: 'rule_lib',
    sheetId: 'sheet_1',
    name: 'Library rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: actions[0]?.type ?? 'send_notification',
    actionConfig: actions[0]?.config ?? {},
    enabled: true,
    ...overrides,
    actions: JSON.parse(JSON.stringify(actions)),
  } as AutomationRule
}

const mountedApps: Array<{ unmount: () => void }> = []

function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = reactive({ visible: true, sheetId: 'sheet_1', fields, ...props })
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, state) })
  app.use(ElementPlus)
  app.mount(container)
  mountedApps.push(app)
  return { container, state }
}

const q = (root: ParentNode, selector: string) => root.querySelector(selector) as HTMLElement | null
const libraryPanel = (c: HTMLElement) => q(c, '[data-automation-flow-library="true"]')
const entry = (c: HTMLElement, type: string) => q(c, `[data-library-entry="${type}"]`) as HTMLButtonElement | null
const entryReason = (c: HTMLElement, type: string) => q(entry(c, type)!, '[data-library-reason-text="true"]')?.textContent?.trim() ?? ''
const formRows = (c: HTMLElement) => Array.from(c.querySelectorAll('.meta-rule-editor__action-row')) as HTMLElement[]
const flowStepTypes = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-flow-step="true"]')).map((el) => el.getAttribute('data-step-type'))
const rowSelect = (c: HTMLElement, idx: number) => formRows(c)[idx]?.querySelector(".meta-rule-editor__action-header .el-select") ?? null

async function click(el: HTMLElement | null) {
  expect(el, 'element to click').not.toBeNull()
  el!.click()
  await flushPromises()
}

async function setMode(c: HTMLElement, mode: 'form' | 'flow') {
  await click(q(c, `[data-editor-mode="${mode}"]`))
}

/** The library's view of every catalog type: open ('') or the lock reason. */
function libraryState(c: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const type of CATALOG) {
    const el = entry(c, type)
    expect(el, `library entry ${type}`).not.toBeNull()
    out[type] = el!.getAttribute('data-locked') === 'true' ? entryReason(c, type) : ''
  }
  return out
}

/** What the Form offers the row 「添加动作」 appends: the enabled option values of that row's select. */
async function formOffersForNewRow(c: HTMLElement): Promise<Set<string>> {
  await setMode(c, 'form')
  const before = formRows(c).length
  await click(q(c, '[data-action="add-action"]'))
  expect(formRows(c)).toHaveLength(before + 1)
  const options = epOptions(rowSelect(c, before))
  expect(options.length).toBeGreaterThan(5) // a real option list, not an empty select
  return new Set(options.filter((o) => !o.disabled).map((o) => o.value))
}

async function save(c: HTMLElement, saved: ReturnType<typeof vi.fn>) {
  const btn = q(c, '[data-action="save"]') as HTMLButtonElement
  expect(btn.disabled, 'save enabled').toBe(false)
  btn.click()
  await flushPromises()
  expect(saved).toHaveBeenCalledTimes(1)
  return saved.mock.calls[0][0] as Record<string, unknown>
}

function resetFlags() {
  for (const key of Object.keys(flags)) delete flags[key]
}

describe('automationFlowLibrary (pure)', () => {
  const ctx = (over: Partial<FlowLibraryLockContext> = {}): FlowLibraryLockContext => ({
    addBlockedReason: '',
    offered: ['update_record', 'send_webhook'],
    optionDisabled: () => false,
    deletedTriggerBlocked: () => false,
    fwb: { flagOn: false, triggerType: 'record.created', outcomes: ['approved'] },
    runIntegrationJob: { switchOn: false, triggerType: 'record.created', actionCount: 2 },
    ...over,
  })

  it('groups the catalog record / message / control / approval / integration, keeps catalog order, drops duplicates', () => {
    const groups = buildFlowLibrary({ catalog: [...CATALOG, 'update_record'], isZh: true, lockReason: () => '' })
    expect(groups.map((g) => g.category)).toEqual(['record', 'message', 'control', 'approval', 'integration'])
    expect(groups.map((g) => g.label)).toEqual(['记录', '消息', '控制', '审批', '集成'])
    expect(groups.flatMap((g) => g.entries.map((e) => e.type)).sort()).toEqual([...CATALOG].sort())
    expect(groups[0].entries.map((e) => e.type)).toEqual(['update_record', 'create_record', 'delete_record', 'lock_record'])
    for (const e of groups.flatMap((g) => g.entries)) {
      expect(e.label).toBe(automationActionTypeLabel(e.type, true))
      expect(e.description.length, `${e.type} description`).toBeGreaterThan(0)
    }
  })

  it('the lock decision is only addBlocked / offered / optionDisabled — the reason branches only pick wording', () => {
    expect(flowLibraryLockReason('send_webhook', ctx(), false)).toBe('')
    // addAction refuses → every entry carries that same sentence, even an offered one
    expect(flowLibraryLockReason('send_webhook', ctx({ addBlockedReason: 'X' }), false)).toBe('X')
    // offered but the Form option is disabled under record.deleted
    expect(flowLibraryLockReason('update_record', ctx({ optionDisabled: () => true, deletedTriggerBlocked: () => true }), false))
      .toBe(automationLabel('actionConfig.deletedTriggerSelfMutation', false))
    expect(flowLibraryLockReason('update_record', ctx({ optionDisabled: () => true }), false))
      .toBe(automationLabel('editor.libraryLockUnsupported', false))
    // not offered: FWB / run_integration_job explain with the inputs their selectability already reads
    expect(flowLibraryLockReason('write_approval_form_values', ctx(), true)).toContain('approvalFwbWriteback')
    expect(flowLibraryLockReason('write_approval_form_values', ctx({ fwb: { flagOn: true, triggerType: 'record.created', outcomes: ['approved'] } }), true))
      .toBe('只能用于「审批完成」触发')
    expect(flowLibraryLockReason('write_approval_form_values', ctx({ fwb: { flagOn: true, triggerType: 'approval.completed', outcomes: ['approved', 'rejected'] } }), true))
      .toContain('仅通过')
    expect(flowLibraryLockReason('run_integration_job', ctx(), true)).toContain('integrationAutomationRunAction')
    expect(flowLibraryLockReason('run_integration_job', ctx({ runIntegrationJob: { switchOn: true, triggerType: 'record.created', actionCount: 1 } }), true))
      .toBe('只能用于「定时（cron）」触发')
    expect(flowLibraryLockReason('run_integration_job', ctx({ runIntegrationJob: { switchOn: true, triggerType: 'schedule.cron', actionCount: 2 } }), true))
      .toBe('必须是规则唯一的步骤：先删除其他步骤')
    // ...but an OFFERED type is open whatever those inputs say (the editor's list wins)
    expect(flowLibraryLockReason('run_integration_job', ctx({ offered: ['run_integration_job'] }), true)).toBe('')
  })

  it('即将开放 are four static labels with their reasons, none of them an action type', () => {
    const zh = flowLibraryComingSoon(true)
    expect(zh.map((e) => [e.label, e.reason])).toEqual([
      ['调用连接（只调已批准的具名操作）', 'S 线（ADR #6914）未合入'],
      ['字段转换', 'S 线（ADR #6914）未合入'],
      ['代码节点', '不在本期（冻结基线 v2.3 :738）'],
      ['K3 写回', '永久禁止'],
    ])
    for (const e of zh) {
      expect(CATALOG as string[]).not.toContain(e.id)
      // an unknown type label echoes the raw value: none of these ids is a known action type
      expect(automationActionTypeLabel(e.id, true)).toBe(e.id)
    }
  })

  it('gates: only the switches the draft touches, outbound with no claimed state, rule state, and the save line always', () => {
    const base = { triggerType: 'record.created', features: { runAction: false, runEvent: false, fwb: false }, ruleEnabled: null, isZh: true }
    const plain = buildFlowGates({ ...base, actionTypes: ['update_record'] })
    expect(plain.map((r) => r.key)).toEqual(['ruleState', 'saveGate'])
    expect(plain[0].stateLabel).toBe('新规则')
    expect(plain[1].note).toBe('保存只经同一个保存门；本页不改任何开关')

    const rij = buildFlowGates({ ...base, triggerType: 'schedule.cron', actionTypes: ['run_integration_job'], features: { runAction: true, runEvent: false, fwb: false }, ruleEnabled: false })
    expect(rij.map((r) => r.key)).toEqual(['runAction', 'ruleState', 'saveGate'])
    expect(rij[0]).toMatchObject({ state: 'on', stateLabel: '开', feature: 'integrationAutomationRunAction', note: '只试算；真写开关另批（O 层）' })
    expect(rij[1]).toMatchObject({ state: 'disabled', stateLabel: '已停用' })

    const all = buildFlowGates({ ...base, triggerType: 'integration.run_finished', actionTypes: ['write_approval_form_values', 'send_email'], ruleEnabled: true })
    expect(all.map((r) => r.key)).toEqual(['runEvent', 'fwb', 'outbound', 'ruleState', 'saveGate'])
    expect(all[0]).toMatchObject({ state: 'off', feature: 'integrationAutomationRunEvent' })
    expect(all[1]).toMatchObject({ state: 'off', feature: 'approvalFwbWriteback' })
    expect(all[2]).toMatchObject({ state: '', stateLabel: '', feature: '' })
    for (const type of FLOW_GATE_OUTBOUND_ACTION_TYPES) {
      expect(buildFlowGates({ ...base, actionTypes: [type] }).map((r) => r.key), type).toContain('outbound')
    }
    expect(buildFlowGates({ ...base, actionTypes: ['send_notification'] }).map((r) => r.key)).not.toContain('outbound')
  })
})

describe('rule editor Flow mode: node library + 上线门 (integration assistant 1c)', () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

  beforeEach(() => {
    resetFlags()
    useLocale().setLocale('en')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount()
    document.body.innerHTML = ''
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    useLocale().setLocale('en')
    resetFlags()
  })

  it('lists every action type in its group, plus a 即将开放 group; only in Flow mode', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    expect(libraryPanel(container)).toBeNull()
    await setMode(container, 'flow')
    const panel = libraryPanel(container)!
    expect(panel).not.toBeNull()
    expect(q(panel, '[data-flow-tab="library"]')?.textContent?.trim()).toBe('节点库')
    expect(q(panel, '[data-flow-tab="gates"]')?.textContent?.trim()).toBe('上线门')

    const groups = Array.from(panel.querySelectorAll('[data-library-group]')).map((g) => g.getAttribute('data-library-group'))
    expect(groups).toEqual(['record', 'message', 'control', 'approval', 'integration', 'coming-soon'])
    const titles = Array.from(panel.querySelectorAll('.meta-flow-lib__group-title')).map((t) => t.textContent?.trim())
    expect(titles).toEqual(['记录', '消息', '控制', '审批', '集成', '即将开放'])
    const listed = Array.from(panel.querySelectorAll('[data-library-entry]')).map((el) => el.getAttribute('data-library-entry'))
    expect([...listed].sort()).toEqual([...CATALOG].sort())
    expect(q(entry(container, 'send_webhook')!, '[data-library-label="true"]')?.textContent?.trim()).toBe('发送 Webhook')
    expect(q(entry(container, 'send_webhook')!, '[data-library-desc="true"]')?.textContent?.trim()).toBe('向外部地址发 HTTP 请求')

    // switches off by default: the two switch-gated types are locked and say which switch
    expect(entry(container, 'write_approval_form_values')!.disabled).toBe(true)
    expect(entryReason(container, 'write_approval_form_values')).toContain('approvalFwbWriteback')
    expect(entry(container, 'run_integration_job')!.disabled).toBe(true)
    expect(entryReason(container, 'run_integration_job')).toContain('integrationAutomationRunAction')
    expect(entry(container, 'send_webhook')!.disabled).toBe(false)
    expect(entry(container, 'send_webhook')!.getAttribute('data-locked')).toBe('false')
  }, TIMEOUT_MS)

  // Each scenario: the library's open set must equal what the Form select of the appended row offers enabled.
  it.each<[name: string, setup: () => { rule: AutomationRule; flags?: string[] }, expectLocked: Record<string, string>]>([
    ['record.created, switches off', () => ({ rule: savedRule() }), {
      write_approval_form_values: 'approvalFwbWriteback',
      run_integration_job: 'integrationAutomationRunAction',
    }],
    ['record.deleted: same-base update / delete / lock are blocked', () => ({ rule: savedRule({ triggerType: 'record.deleted' }) }), {
      update_record: automationLabel('actionConfig.deletedTriggerSelfMutation', false),
      delete_record: automationLabel('actionConfig.deletedTriggerSelfMutation', false),
      lock_record: automationLabel('actionConfig.deletedTriggerSelfMutation', false),
      write_approval_form_values: 'approvalFwbWriteback',
      run_integration_job: 'integrationAutomationRunAction',
    }],
    ['FWB switch on but record.created', () => ({ rule: savedRule(), flags: ['approvalFwbWriteback'] }), {
      write_approval_form_values: 'approval.completed',
      run_integration_job: 'integrationAutomationRunAction',
    }],
    ['run_integration_job switch on, but not schedule.cron', () => ({ rule: savedRule(), flags: ['integrationAutomationRunAction'] }), {
      write_approval_form_values: 'approvalFwbWriteback',
      run_integration_job: 'scheduled (cron)',
    }],
    ['run_integration_job switch on + cron, but another step exists', () => ({
      rule: savedRule({ triggerType: 'schedule.cron', triggerConfig: CRON }),
      flags: ['integrationAutomationRunAction'],
    }), {
      write_approval_form_values: 'approvalFwbWriteback',
      run_integration_job: 'only step',
    }],
  ])('locks match the Form select of the appended row — %s', async (_name, setup, expectLocked) => {
    const { rule, flags: on = [] } = setup()
    for (const f of on) flags[f] = true
    const { container } = mountEditor({ rule })
    await flushPromises()
    await setMode(container, 'flow')
    const lib = libraryState(container)
    for (const type of CATALOG) {
      if (expectLocked[type]) expect(lib[type], type).toContain(expectLocked[type])
      else expect(lib[type], type).toBe('')
    }
    const offered = await formOffersForNewRow(container)
    for (const type of CATALOG) {
      expect(lib[type] === '', `${type}: library open ⇔ Form offers it enabled`).toBe(offered.has(type))
    }
  }, TIMEOUT_MS)

  it('run_integration_job opens on an empty cron rule with the switch on — and the Form agrees', async () => {
    flags.integrationAutomationRunAction = true
    const { container } = mountEditor({ rule: savedRule({ triggerType: 'schedule.cron', triggerConfig: CRON }) })
    await flushPromises()
    await click(q(container, '[data-action-index="0"] .meta-rule-editor__action-btns button:last-child'))
    expect(formRows(container)).toHaveLength(0)
    await setMode(container, 'flow')
    expect(libraryState(container).run_integration_job).toBe('')
    const offered = await formOffersForNewRow(container)
    expect(offered.has('run_integration_job')).toBe(true)
  }, TIMEOUT_MS)

  it('addAction refusals lock every entry with the same sentence: 3 steps, or beside run_integration_job', async () => {
    const three = mountEditor({ rule: savedRule({ actions: [NOTIFY, NOTIFY, NOTIFY] as AutomationRule['actions'] }) })
    await flushPromises()
    await setMode(three.container, 'flow')
    const blocked = q(three.container, '[data-flow-add-blocked="true"]')?.textContent?.trim()
    expect(blocked).toContain('at most 3 steps')
    for (const [type, reason] of Object.entries(libraryState(three.container))) expect(reason, type).toBe(blocked)
    entry(three.container, 'send_webhook')!.click()
    await flushPromises()
    expect(flowStepTypes(three.container)).toHaveLength(3)

    flags.integrationAutomationRunAction = true
    const rij = mountEditor({
      rule: savedRule({
        triggerType: 'schedule.cron',
        triggerConfig: CRON,
        actions: [{ type: 'run_integration_job', config: RIJ_CONFIG }] as AutomationRule['actions'],
      }),
    })
    await flushPromises()
    await setMode(rij.container, 'flow')
    const rijBlocked = q(rij.container, '[data-flow-add-blocked="true"]')?.textContent?.trim()
    expect(rijBlocked).toContain('only step')
    for (const [type, reason] of Object.entries(libraryState(rij.container))) expect(reason, type).toBe(rijBlocked)
    entry(rij.container, 'send_notification')!.click()
    await flushPromises()
    expect(flowStepTypes(rij.container)).toEqual(['run_integration_job'])
  }, TIMEOUT_MS)

  it('picking an open entry appends a step of that type to the same draft (Flow and Form both show it)', async () => {
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(container, 'flow')
    await click(entry(container, 'lock_record'))
    expect(flowStepTypes(container)).toEqual(['send_notification', 'lock_record'])
    await click(entry(container, 'update_record')) // the default type: no type change at all
    expect(flowStepTypes(container)).toEqual(['send_notification', 'lock_record', 'update_record'])
    await setMode(container, 'form')
    expect(formRows(container)).toHaveLength(3)
    expect([0, 1, 2].map((i) => epSelectValue(rowSelect(container, i)))).toEqual(['send_notification', 'lock_record', 'update_record'])
  }, TIMEOUT_MS)

  it.each<[label: string, type: AutomationActionType]>([
    ['lock_record', 'lock_record'],
    ['wait_for_callback (flips the execution mode on type change)', 'wait_for_callback'],
    ['update_record (the default type, no change event)', 'update_record'],
  ])('payload parity: add %s via the library ≡ 添加动作 + select it in Form', async (_label, type) => {
    const savedA = vi.fn()
    const savedB = vi.fn()
    const a = mountEditor({ rule: savedRule(), onSave: savedA })
    const b = mountEditor({ rule: savedRule(), onSave: savedB })
    await flushPromises()

    await setMode(a.container, 'flow')
    await click(entry(a.container, type))
    expect(flowStepTypes(a.container)).toEqual(['send_notification', type])

    await click(q(b.container, '[data-action="add-action"]'))
    if (type !== 'update_record') {
      epSetSelect(rowSelect(b.container, 1), type)
      await flushPromises()
    }

    if (type === 'update_record') {
      // an update with no field pair blocks save in both; author the same pair through the Form in both editors
      for (const c of [a.container, b.container]) {
        await setMode(c, 'form')
        const row = formRows(c)[1]
        const addField = Array.from(row.querySelectorAll('.meta-rule-editor__action-config > .meta-rule-editor__btn'))
          .find((el) => el.textContent?.trim() === '+ Field') as HTMLElement | undefined
        await click(addField ?? null)
        const pair = row.querySelector('.meta-rule-editor__field-pair')!
        epSetSelect(pair.querySelector('.el-select'), 'fld_2')
        const input = pair.querySelector('.el-input input') as HTMLInputElement
        input.value = 'done'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await flushPromises()
      }
    }

    const payloadA = await save(a.container, savedA)
    const payloadB = await save(b.container, savedB)
    expect(payloadA).toEqual(payloadB)
    expect(JSON.stringify(payloadA)).toBe(JSON.stringify(payloadB))
    const actions = payloadA.actions as Array<{ type: string }>
    expect(actions.map((x) => x.type)).toEqual(['send_notification', type])
    if (type === 'wait_for_callback') expect(payloadA.executionMode).toBe('workflow_job_v1')
  }, TIMEOUT_MS)

  it('即将开放 entries are labels, not buttons: clicking adds nothing', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(container, 'flow')
    const coming = Array.from(container.querySelectorAll('[data-library-coming]')) as HTMLElement[]
    expect(coming.map((el) => el.getAttribute('data-library-coming'))).toEqual(['connection_call', 'field_transform', 'code', 'k3_write'])
    expect(coming.map((el) => q(el, '[data-library-label="true"]')?.textContent?.trim())).toEqual([
      '调用连接（只调已批准的具名操作）', '字段转换', '代码节点', 'K3 写回',
    ])
    expect(coming.map((el) => q(el, '[data-library-reason-text="true"]')?.textContent?.trim())).toEqual([
      'S 线（ADR #6914）未合入',
      'S 线（ADR #6914）未合入',
      '不在本期（冻结基线 v2.3 :738）',
      '永久禁止',
    ])
    for (const el of coming) {
      expect(el.tagName).not.toBe('BUTTON')
      expect(el.querySelector('button, a, [tabindex]')).toBeNull()
      el.click()
      await flushPromises()
    }
    expect(flowStepTypes(container)).toEqual(['send_notification'])
    // and a locked action entry is a disabled button: clicking it adds nothing either
    entry(container, 'run_integration_job')!.click()
    await flushPromises()
    expect(flowStepTypes(container)).toEqual(['send_notification'])
  }, TIMEOUT_MS)

  it('上线门 reflects integrationAutomationRunAction on / off for a run_integration_job rule', async () => {
    const rule = savedRule({
      triggerType: 'schedule.cron',
      triggerConfig: CRON,
      enabled: false,
      actions: [{ type: 'run_integration_job', config: RIJ_CONFIG }] as AutomationRule['actions'],
    })
    for (const on of [false, true]) {
      resetFlags()
      if (on) flags.integrationAutomationRunAction = true
      useLocale().setLocale('zh-CN')
      const { container } = mountEditor({ rule })
      await flushPromises()
      await setMode(container, 'flow')
      await click(q(container, '[data-flow-tab="gates"]'))
      expect(q(container, '[data-flow-library-body="true"]')).toBeNull()
      const row = q(container, '[data-gate="runAction"]')!
      expect(row.getAttribute('data-gate-state')).toBe(on ? 'on' : 'off')
      expect(q(row, '[data-gate-state-label="true"]')?.textContent?.trim()).toBe(on ? '开' : '关')
      expect(q(row, '[data-gate-feature="true"]')?.textContent?.trim()).toBe('integrationAutomationRunAction')
      expect(q(row, '[data-gate-note="true"]')?.textContent?.trim()).toBe('只试算；真写开关另批（O 层）')
      expect(q(container, '[data-gate="ruleState"]')?.getAttribute('data-gate-state')).toBe('disabled')
      expect(q(container, '[data-gate="saveGate"] [data-gate-note="true"]')?.textContent?.trim()).toBe('保存只经同一个保存门；本页不改任何开关')
      expect(q(container, '[data-gate="fwb"]')).toBeNull()
      expect(q(container, '[data-gate="outbound"]')).toBeNull()
      for (const app of mountedApps.splice(0)) app.unmount()
      document.body.innerHTML = ''
    }
  }, TIMEOUT_MS)

  it('上线门 reflects approvalFwbWriteback on / off for a draft carrying write_approval_form_values', async () => {
    for (const on of [false, true]) {
      resetFlags()
      if (on) flags.approvalFwbWriteback = true
      const { container } = mountEditor({ rule: savedRule({ triggerType: 'approval.completed', triggerConfig: { templateId: 'tpl_1' } }) })
      await flushPromises()
      if (on) {
        // switch on + approval.completed: the library opens it and picking it puts it in the draft
        await setMode(container, 'flow')
        expect(libraryState(container).write_approval_form_values).toBe('')
        await click(entry(container, 'write_approval_form_values'))
        expect(flowStepTypes(container)).toEqual(['send_notification', 'write_approval_form_values'])
      } else {
        // switch off: the library keeps it locked; the gate row only appears once the draft carries one,
        // which a switch-off author cannot add — so no FWB row
        await setMode(container, 'flow')
        expect(libraryState(container).write_approval_form_values).toContain('approvalFwbWriteback')
      }
      await click(q(container, '[data-flow-tab="gates"]'))
      const row = q(container, '[data-gate="fwb"]')
      if (on) {
        expect(row?.getAttribute('data-gate-state')).toBe('on')
        expect(q(row!, '[data-gate-feature="true"]')?.textContent?.trim()).toBe('approvalFwbWriteback')
      } else {
        expect(row).toBeNull()
      }
      for (const app of mountedApps.splice(0)) app.unmount()
      document.body.innerHTML = ''
    }

    // a LOADED FWB rule with the switch off shows the row as off (the action stays, read-only)
    resetFlags()
    const loaded = mountEditor({
      rule: savedRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1' },
        actions: [{ type: 'write_approval_form_values', config: { mappings: [], sourceTemplateVersionId: 'v1', confirmationHash: 'h' } }] as AutomationRule['actions'],
      }),
    })
    await flushPromises()
    await setMode(loaded.container, 'flow')
    await click(q(loaded.container, '[data-flow-tab="gates"]'))
    expect(q(loaded.container, '[data-gate="fwb"]')?.getAttribute('data-gate-state')).toBe('off')
  }, TIMEOUT_MS)

  it('上线门: run_finished trigger switch, outbound sends without a claimed state, new-rule state', async () => {
    flags.integrationAutomationRunEvent = true
    const { container } = mountEditor({
      rule: savedRule({
        triggerType: 'integration.run_finished',
        triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed'] },
        actions: [{ type: 'send_webhook', config: { url: 'https://example.test/hook', method: 'POST' } }] as AutomationRule['actions'],
      }),
    })
    await flushPromises()
    await setMode(container, 'flow')
    await click(q(container, '[data-flow-tab="gates"]'))
    const keys = Array.from(container.querySelectorAll('[data-gate]')).map((el) => el.getAttribute('data-gate'))
    expect(keys).toEqual(['runEvent', 'outbound', 'ruleState', 'saveGate'])
    expect(q(container, '[data-gate="runEvent"]')?.getAttribute('data-gate-state')).toBe('on')
    const outbound = q(container, '[data-gate="outbound"]')!
    expect(outbound.getAttribute('data-gate-state')).toBe('')
    expect(q(outbound, '[data-gate-state-label="true"]')).toBeNull()
    expect(q(container, '[data-gate="ruleState"]')?.getAttribute('data-gate-state')).toBe('enabled')

    const fresh = mountEditor({ rule: null })
    await flushPromises()
    await setMode(fresh.container, 'flow')
    await click(q(fresh.container, '[data-flow-tab="gates"]'))
    expect(q(fresh.container, '[data-gate="ruleState"]')?.getAttribute('data-gate-state')).toBe('new')
  }, TIMEOUT_MS)

  it('the library / gates area carries no config inputs and adds no aria-label', async () => {
    flags.integrationAutomationRunAction = true
    const { container } = mountEditor({ rule: savedRule() })
    await flushPromises()
    await setMode(container, 'flow')
    const panel = libraryPanel(container)!
    for (const tab of ['library', 'gates']) {
      await click(q(panel, `[data-flow-tab="${tab}"]`))
      expect(panel.querySelectorAll('input, select, textarea, [contenteditable]').length, tab).toBe(0)
      expect(panel.querySelectorAll('.el-select, .el-input, .el-textarea, .el-switch, .el-checkbox').length, tab).toBe(0)
      expect(panel.querySelectorAll('[aria-label]').length, tab).toBe(0)
    }
  }, TIMEOUT_MS)
})
