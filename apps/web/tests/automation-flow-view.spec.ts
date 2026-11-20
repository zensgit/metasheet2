import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import {
  buildAutomationFlow,
  flowStepCategory,
  ruleActions,
  savedConfigSnapshot,
} from '../src/multitable/automationFlowView'
import MetaAutomationFlowView from '../src/multitable/components/MetaAutomationFlowView.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'Flow rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_notification',
    actionConfig: { userIds: ['user_1'], message: 'Hello' },
    enabled: true,
    ...overrides,
  }
}

const fieldLabel = (id: string) => ({ fld_status: 'Status' } as Record<string, string>)[id] ?? id

describe('automationFlowView (integration assistant 1a, R-99 ③)', () => {
  it('uses the legacy single action when the rule carries no actions array', () => {
    const actions = ruleActions(rule())
    expect(actions).toEqual([{ type: 'send_notification', config: { userIds: ['user_1'], message: 'Hello' } }])
  })

  it('prefers the multi-action array and keeps executor order with top-level step keys', () => {
    const model = buildAutomationFlow(rule({
      actions: [
        { type: 'update_record', config: { fields: { fld_status: 'Done' } } },
        { type: 'send_email', config: { recipients: ['a@example.test', 'b@example.test'], subjectTemplate: 'Hi', bodyTemplate: '' } },
      ],
    }), { isZh: false, fieldLabel })
    expect(model.steps.map((s) => s.stepKey)).toEqual(['0', '1'])
    expect(model.steps[0].summary).toBe('Update record: Status ← Done')
    expect(model.steps[1].summary).toBe('Send email to 2 recipients: Hi')
    expect(model.steps.map((s) => s.category)).toEqual(['record', 'message'])
  })

  it('stamps branch children with the executor step-key identity (branch KEY, not array index)', () => {
    const model = buildAutomationFlow(rule({
      actions: [
        { type: 'lock_record', config: { locked: true } },
        {
          type: 'condition_branch',
          config: {
            branches: [
              { key: 'urgent', label: 'Urgent', conditions: { conditions: [] }, actions: [{ type: 'lock_record', config: { locked: true } }] },
              { key: 'normal', conditions: { conditions: [] }, actions: [] },
            ],
            defaultBranch: { key: 'otherwise', actions: [{ type: 'send_notification', config: { userIds: ['u'], message: 'm' } }] },
          },
        },
        {
          type: 'parallel_branch',
          config: { joinMode: 'all', branches: [{ key: 'left', actions: [{ type: 'lock_record', config: { locked: false } }] }] },
        },
      ],
    }), { isZh: false })
    const cond = model.steps[1]
    expect(cond.summary).toBe('Condition branch: 2 branches + default branch')
    expect(cond.branches.map((b) => [b.key, b.label, b.isDefault])).toEqual([
      ['urgent', 'Urgent', false],
      ['normal', 'normal', false],
      ['otherwise', 'Default branch', true],
    ])
    expect(cond.branches[0].steps[0].stepKey).toBe('1.branch.urgent.0')
    expect(cond.branches[2].steps[0].stepKey).toBe('1.branch.otherwise.0')
    expect(cond.branches[1].steps).toEqual([])
    const par = model.steps[2]
    expect(par.branches[0].kind).toBe('parallel')
    expect(par.branches[0].steps[0].stepKey).toBe('2.parallel.left.0')
    expect(par.branches[0].steps[0].summary).toBe('Unlock record')
  })

  it('describes the I-chain trigger and action without inventing values', () => {
    const model = buildAutomationFlow(rule({
      triggerType: 'schedule.cron',
      triggerConfig: { expression: '0 6 * * *', timezone: 'Asia/Shanghai' },
      actions: [{ type: 'run_integration_job', config: { job: { kind: 'stock_prep_pull', projectNos: ['P1', 'P2'], applyMode: 'dry_run_only' } } }],
    }), { isZh: true })
    expect(model.trigger.label).toBe('定时计划（cron）')
    expect(model.trigger.detail).toBe('0 6 * * * · Asia/Shanghai')
    expect(model.steps[0].summary).toBe('运行集成任务（仅预演）：备料拉取，2 个项目')
    expect(model.steps[0].category).toBe('integration')

    const unconfigured = buildAutomationFlow(rule({
      triggerType: 'integration.run_finished',
      triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed'] },
      actions: [{ type: 'run_integration_job', config: {} }],
    }), { isZh: false })
    expect(unconfigured.trigger.detail).toBe('stock-prep pull · failed')
    expect(unconfigured.steps[0].summary).toBe('Run integration job (dry run) (not configured)')
  })

  it('renders interval and unconfigured schedules honestly', () => {
    expect(buildAutomationFlow(rule({ triggerType: 'schedule.interval', triggerConfig: { intervalMs: 15 * 60000 } }), { isZh: false }).trigger.detail)
      .toBe('every 15 min')
    expect(buildAutomationFlow(rule({ triggerType: 'schedule.cron', triggerConfig: {} }), { isZh: false }).trigger.detail)
      .toBe('(not configured)')
  })

  it('flags rule-level conditions only when the group has members', () => {
    expect(buildAutomationFlow(rule({ conditions: { conjunction: 'AND', conditions: [] } }), { isZh: false }).hasRuleConditions).toBe(false)
    expect(buildAutomationFlow(rule({
      conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_status', operator: 'equals', value: 'x' }] } as never,
    }), { isZh: false }).hasRuleConditions).toBe(true)
  })

  it('reads the saved backend config shapes, not the editor draft shapes', () => {
    expect(savedConfigSnapshot('create_record', { sheetId: 'sheet_9', data: { a: 1, b: 2 } }, fieldLabel).createRecord)
      .toEqual({ targetSheetId: 'sheet_9', fieldValueCount: 2 })
    expect(savedConfigSnapshot('send_dingtalk_group_message', { destinationIds: ['g1', 'g2'], destinationId: 'g1', destinationIdFieldPath: 'record.x', titleTemplate: 'T' }, fieldLabel).dingTalkGroupMessage)
      .toEqual({ destinationCount: 3, titleTemplate: 'T' })
    expect(savedConfigSnapshot('send_dingtalk_person_message', { userIds: ['u1'], memberGroupIds: ['m1'], userIdFieldPaths: ['record.a'], titleTemplate: '' }, fieldLabel).dingTalkPersonMessage)
      .toEqual({ recipientCount: 3, titleTemplate: '' })
    expect(savedConfigSnapshot('start_approval', { templateId: 'tpl_1', formDataMapping: { a: 'b' } }, fieldLabel).startApproval)
      .toEqual({ templateLabel: 'tpl_1', mappingCount: 1 })
    expect(savedConfigSnapshot('write_approval_form_values', { mappings: [{}, {}], confirmationHash: '' }, fieldLabel).fwbWriteback)
      .toEqual({ mappingCount: 2, confirmed: false, mode: 'create' })
  })

  it('falls back to the raw type label for unknown action types', () => {
    const model = buildAutomationFlow(rule({ actions: [{ type: 'future_action' as never, config: {} }] }), { isZh: false })
    expect(model.steps[0].label).toBe('future_action')
    expect(model.steps[0].summary).toBe('future_action')
    expect(flowStepCategory('future_action')).toBe('other')
  })
})

describe('MetaAutomationFlowView', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
  })

  function mountView(props: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaAutomationFlowView, props) })
    app.mount(container)
    return { container, app }
  }

  it('renders nothing while hidden or without a rule', async () => {
    mountView({ visible: false, rule: rule() })
    mountView({ visible: true, rule: null })
    await nextTick()
    expect(document.querySelector('[data-automation-flow-view]')).toBeNull()
  })

  it('renders the trigger, the condition gate and every step card read-only', async () => {
    useLocale().setLocale('zh-CN')
    const { app } = mountView({
      visible: true,
      fields: [{ id: 'fld_status', name: '状态' }],
      rule: rule({
        name: '每日拉取',
        enabled: false,
        triggerType: 'schedule.cron',
        triggerConfig: { expression: '0 6 * * *', timezone: 'Asia/Shanghai' },
        conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_status', operator: 'equals', value: 'x' }] } as never,
        actions: [
          { type: 'update_record', config: { fields: { fld_status: '完成' } } },
          { type: 'condition_branch', config: { branches: [{ key: 'b1', conditions: { conditions: [] }, actions: [{ type: 'lock_record', config: { locked: true } }] }] } },
        ],
      }),
    })
    await nextTick()
    const root = document.querySelector('[data-automation-flow-view]') as HTMLElement
    expect(root).not.toBeNull()
    expect(root.querySelector('[data-flow-rule-name]')?.textContent).toBe('每日拉取')
    expect(root.querySelector('[data-flow-enabled]')?.textContent).toBe('未启用')
    expect(root.querySelector('[data-flow-trigger-detail]')?.textContent).toBe('0 6 * * * · Asia/Shanghai')
    expect(root.querySelector('[data-flow-conditions]')).not.toBeNull()
    const steps = Array.from(root.querySelectorAll('[data-flow-step]')) as HTMLElement[]
    expect(steps.map((s) => s.dataset.stepKey)).toEqual(['0', '1'])
    expect(steps[0].querySelector('[data-flow-step-summary]')?.textContent).toBe('更新记录：状态 ← 完成')
    const child = root.querySelector('[data-flow-branch-step]') as HTMLElement
    expect(child.dataset.stepKey).toBe('1.branch.b1.0')
    // read-only: no inputs, selects or textareas anywhere in the view
    expect(root.querySelectorAll('input, select, textarea').length).toBe(0)
    app.unmount()
  })

  it('emits close from the close button and the backdrop', async () => {
    let closes = 0
    mountView({ visible: true, rule: rule(), onClose: () => { closes += 1 } })
    await nextTick()
    ;(document.querySelector('[data-flow-close]') as HTMLButtonElement).click()
    ;(document.querySelector('[data-automation-flow-view]') as HTMLElement).click()
    expect(closes).toBe(2)
  })

  it('shows an explicit empty state for a rule without actions', async () => {
    mountView({ visible: true, rule: rule({ actions: [], actionType: '' as never }) })
    await nextTick()
    expect(document.querySelector('[data-flow-empty]')).not.toBeNull()
  })
})
