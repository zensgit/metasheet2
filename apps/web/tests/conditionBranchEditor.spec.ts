// A6-3-2a UI tests — condition_branch editor through the real component (create + edit + read-only + keys).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

function flush() {
  return new Promise<void>((r) => setTimeout(r, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select', options: [{ value: 'done', label: 'Done' }] },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, props) })
  app.mount(container)
  return { container, app }
}

function setInput(container: HTMLElement, selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function selectAction0(container: HTMLElement, type: string) {
  const sel = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
  sel.value = type
  sel.dispatchEvent(new Event('change'))
}
function ruleWithBranch(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_cb', sheetId: 'sheet_1', name: 'Branch rule', triggerType: 'record.created', triggerConfig: {},
    actionType: 'condition_branch', actionConfig: config, enabled: true, executionMode: 'workflow_job_v1',
    actions: [{ type: 'condition_branch', config }],
  } as AutomationRule
}

beforeEach(() => useLocale().setLocale('en'))
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('A6-3-2a condition_branch editor', () => {
  it('#2 auto-lock: selecting condition_branch forces workflow_job_v1 (toggle checked+disabled) and buildPayload enforces it on save', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()
    setInput(container, '[data-field="name"]', 'Branch rule')
    selectAction0(container, 'condition_branch')
    await flush()
    const toggle = container.querySelector('[data-field="executionMode"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false) // default branch (branch_1) is valid
    saveBtn.click()
    await flush()
    expect(saved).toHaveBeenCalledTimes(1)
    expect(saved.mock.calls[0][0].executionMode).toBe('workflow_job_v1')
    expect(saved.mock.calls[0][0].actions[0].type).toBe('condition_branch')
  })

  it('#4 create: a branch with a condition + update_record action saves the executor-shaped config', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()
    setInput(container, '[data-field="name"]', 'Tier rule')
    selectAction0(container, 'condition_branch')
    await flush()
    // branch_1: add a condition (Name = vip)
    ;(container.querySelector('[data-branch-index="0"] [data-action="add-branch-condition"]') as HTMLButtonElement).click()
    await flush()
    const condRow = container.querySelector('[data-branch-index="0"] [data-branch-condition-index="0"]') as HTMLElement
    const fieldSel = condRow.querySelector('select') as HTMLSelectElement
    fieldSel.value = 'fld_2'; fieldSel.dispatchEvent(new Event('change'))
    await flush()
    const valInput = condRow.querySelector('input') as HTMLInputElement
    valInput.value = 'vip'; valInput.dispatchEvent(new Event('input'))
    // branch_1 action 0 (update_record default): add a field pair Status=done
    ;(container.querySelector('[data-branch-index="0"] [data-action="add-branch-field"]') as HTMLButtonElement).click()
    await flush()
    const pair = container.querySelector('[data-branch-index="0"] .meta-rule-editor__field-pair') as HTMLElement
    const pairField = pair.querySelector('select') as HTMLSelectElement
    pairField.value = 'fld_1'; pairField.dispatchEvent(new Event('change'))
    const pairVal = pair.querySelector('input') as HTMLInputElement
    pairVal.value = 'done'; pairVal.dispatchEvent(new Event('input'))
    await flush()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    const payload = saved.mock.calls[0][0]
    const branch = payload.actions[0].config.branches[0]
    expect(branch.key).toBe('branch_1')
    expect(branch.conditions.conditions[0]).toMatchObject({ fieldId: 'fld_2', value: 'vip' })
    expect(branch.actions).toEqual([{ type: 'update_record', config: { fields: { fld_1: 'done' } } }])
  })

  it('#4 edit: loads a supported condition_branch rule and round-trips it on save', async () => {
    const config = {
      branches: [{
        key: 'vip',
        conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_2', operator: 'equals', value: 'vip' }] },
        actions: [{ type: 'send_notification', config: { userIds: ['u1', 'u2'], message: 'hi' } }],
      }],
    }
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(config), onSave: saved })
    await flush()
    expect((container.querySelector('[data-branch-index="0"] [data-field="branch-key"]') as HTMLInputElement).value).toBe('vip')
    expect(container.querySelector('[data-field="condition-branch-readonly"]')).toBeNull()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(saved.mock.calls[0][0].actions[0].config).toEqual(config)
  })

  it('#3 read-only: an unsupported loaded branch (action outside subset) shows the banner and blocks save (never flattens)', async () => {
    const config = {
      branches: [{
        key: 'a', conditions: { conjunction: 'AND', conditions: [] },
        actions: [{ type: 'create_record', config: { sheetId: 's', data: {} } }], // outside subset
      }],
    }
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(config) })
    await flush()
    expect(container.querySelector('[data-field="condition-branch-readonly"]')).not.toBeNull()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
    // no branch-builder rendered (read-only)
    expect(container.querySelector('[data-action-config="condition_branch"] [data-branch-index="0"]')).toBeNull()
  })

  it('#1 key validation: a duplicate branch key blocks save and shows the error', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Dup')
    selectAction0(container, 'condition_branch')
    await flush()
    ;(container.querySelector('[data-action-config="condition_branch"] [data-action="add-branch"]') as HTMLButtonElement).click()
    await flush()
    // set both branch keys to the same value
    const keyInputs = container.querySelectorAll('[data-branch-index] [data-field="branch-key"]')
    ;(keyInputs[1] as HTMLInputElement).value = 'branch_1'
    ;(keyInputs[1] as HTMLInputElement).dispatchEvent(new Event('input'))
    await flush()
    expect(container.querySelector('[data-field="branch-key-error"]')).not.toBeNull()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('#4 branch→normal: switching the action off condition_branch unlocks the job-mode toggle', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Switch')
    selectAction0(container, 'condition_branch')
    await flush()
    expect((container.querySelector('[data-field="executionMode"]') as HTMLInputElement).disabled).toBe(true)
    selectAction0(container, 'update_record')
    await flush()
    expect((container.querySelector('[data-field="executionMode"]') as HTMLInputElement).disabled).toBe(false)
  })
})

// A6-3-3b UI tests — branch-local wait_for_callback is authorable INSIDE the existing condition_branch
// builder; the other nested primitives stay out of the menu; auto-lock + payload-shape preserved.
describe('A6-3-3b branch-local wait_for_callback editor', () => {
  it('the branch action menu OFFERS wait_for_callback but EXCLUDES the nested primitives', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Wait rule')
    selectAction0(container, 'condition_branch')
    await flush()
    const branchActionSelect = container.querySelector(
      '[data-action-config="condition_branch"] [data-branch-action-index="0"] select',
    ) as HTMLSelectElement
    const options = Array.from(branchActionSelect.options).map((o) => o.value)
    expect(options).toContain('wait_for_callback')
    expect(options).toContain('update_record')
    expect(options).toContain('send_notification')
    // rule #3: nested condition_branch / parallel_branch / start_approval remain non-authorable in a branch
    expect(options).not.toContain('condition_branch')
    expect(options).not.toContain('parallel_branch')
    expect(options).not.toContain('start_approval')
  })

  it('adding a branch-local wait_for_callback saves the zero-param config AND keeps workflow_job_v1 locked', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()
    setInput(container, '[data-field="name"]', 'High-risk review')
    selectAction0(container, 'condition_branch')
    await flush()
    // auto-lock is already in effect because the rule action is condition_branch
    const toggle = container.querySelector('[data-field="executionMode"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    // branch_1 action 0: switch its type select to wait_for_callback
    const branchActionSelect = container.querySelector(
      '[data-action-config="condition_branch"] [data-branch-action-index="0"] select',
    ) as HTMLSelectElement
    branchActionSelect.value = 'wait_for_callback'
    branchActionSelect.dispatchEvent(new Event('change'))
    await flush()
    // the zero-param hint renders (no fields to author for a wait)
    expect(
      container.querySelector('[data-branch-action-index="0"] [data-field="branch-wait-for-callback-hint"]'),
    ).not.toBeNull()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.executionMode).toBe('workflow_job_v1') // auto-lock preserved
    const branchActions = payload.actions[0].config.branches[0].actions
    // exact backend-accepted shape (zero-param wait)
    expect(branchActions).toEqual([{ type: 'wait_for_callback', config: {} }])
  })

  it('round-trips a loaded supported branch with a mid-branch wait without flattening it', async () => {
    const config = {
      branches: [{
        key: 'high',
        conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_2', operator: 'equals', value: 'big' }] },
        actions: [
          { type: 'send_notification', config: { userIds: ['u1'], message: 'review' } },
          { type: 'wait_for_callback', config: {} },
          { type: 'update_record', config: { fields: { fld_1: 'done' } } },
        ],
      }],
    }
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(config), onSave: saved })
    await flush()
    // editable (NOT read-only) — the wait is now supported
    expect(container.querySelector('[data-field="condition-branch-readonly"]')).toBeNull()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(saved.mock.calls[0][0].actions[0].config).toEqual(config)
  })

  it('keeps a loaded richer wait (config keys) READ-ONLY and never flattens it (save blocked)', async () => {
    const config = {
      branches: [{
        key: 'high', conditions: { conjunction: 'AND', conditions: [] },
        actions: [{ type: 'wait_for_callback', config: { reason: 'high-risk', resumeToken: 'tok' } }], // richer than the UI
      }],
    }
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(config) })
    await flush()
    expect(container.querySelector('[data-field="condition-branch-readonly"]')).not.toBeNull()
    // save is blocked while read-only (the never-flatten floor); the builder is not rendered
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-action-config="condition_branch"] [data-branch-index="0"]')).toBeNull()
  })
})
