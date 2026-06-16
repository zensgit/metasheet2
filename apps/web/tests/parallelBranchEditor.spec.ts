// A6-3-4/W3-2a UI tests — parallel_branch editor through the real component.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
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
  const input = container.querySelector(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function selectAction0(container: HTMLElement, type: string) {
  const select = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
  select.value = type
  select.dispatchEvent(new Event('change'))
}

function ruleWithParallel(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_pb',
    sheetId: 'sheet_1',
    name: 'Parallel rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'parallel_branch',
    actionConfig: config,
    enabled: true,
    executionMode: 'workflow_job_v1',
    actions: [{ type: 'parallel_branch', config }],
  } as AutomationRule
}

beforeEach(() => useLocale().setLocale('en'))
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('A6-3-4/W3-2a parallel_branch editor', () => {
  it('auto-locks workflow_job_v1 but blocks saving the default empty branch action', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()

    setInput(container, '[data-field="name"]', 'Parallel rule')
    selectAction0(container, 'parallel_branch')
    await flush()

    const toggle = container.querySelector('[data-field="executionMode"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    expect(container.querySelector('[data-action-config="parallel_branch"]')).not.toBeNull()
    expect(container.querySelector('[data-field="parallel-branch-action-error"]')?.textContent ?? '').toContain('at least one field')
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)

    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()

    expect(saved).not.toHaveBeenCalled()
  })

  it('creates a branch with update_record field config in the executor shape', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()

    setInput(container, '[data-field="name"]', 'Parallel update')
    selectAction0(container, 'parallel_branch')
    await flush()

    ;(container.querySelector('[data-parallel-branch-index="0"] [data-action="add-parallel-branch-field"]') as HTMLButtonElement).click()
    await flush()
    const pair = container.querySelector('[data-parallel-branch-index="0"] .meta-rule-editor__field-pair') as HTMLElement
    const pairField = pair.querySelector('select') as HTMLSelectElement
    pairField.value = 'fld_1'
    pairField.dispatchEvent(new Event('change'))
    const pairValue = pair.querySelector('input') as HTMLInputElement
    pairValue.value = 'done'
    pairValue.dispatchEvent(new Event('input'))
    await flush()

    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()

    const branch = saved.mock.calls[0][0].actions[0].config.branches[0]
    expect(branch).toEqual({
      key: 'branch_1',
      actions: [{ type: 'update_record', config: { fields: { fld_1: 'done' } } }],
    })
  })

  it('loads a supported parallel_branch rule and round-trips it on save', async () => {
    const config = {
      joinMode: 'all',
      branches: [
        { key: 'ops', label: 'Ops', actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }] },
        { key: 'notify', actions: [{ type: 'send_notification', config: { userIds: ['u1', 'u2'], message: 'ready' } }] },
      ],
    }
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithParallel(config), onSave: saved })
    await flush()

    expect((container.querySelector('[data-parallel-branch-index="0"] [data-field="parallel-branch-key"]') as HTMLInputElement).value).toBe('ops')
    expect(container.querySelector('[data-field="parallel-branch-readonly"]')).toBeNull()

    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()

    expect(saved.mock.calls[0][0].actions[0].config).toEqual(config)
  })

  it('opens unsupported loaded parallel_branch shapes read-only and blocks save', async () => {
    const config = {
      joinMode: 'all',
      branches: [{ key: 'a', actions: [{ type: 'wait_for_callback', config: {} }] }],
    }
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithParallel(config) })
    await flush()

    expect(container.querySelector('[data-field="parallel-branch-readonly"]')).not.toBeNull()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-action-config="parallel_branch"] [data-parallel-branch-index="0"]')).toBeNull()
  })

  it('blocks duplicate parallel branch keys before save', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()

    setInput(container, '[data-field="name"]', 'Duplicate branch')
    selectAction0(container, 'parallel_branch')
    await flush()
    ;(container.querySelector('[data-action-config="parallel_branch"] [data-action="add-parallel-branch"]') as HTMLButtonElement).click()
    await flush()

    const keyInputs = container.querySelectorAll('[data-parallel-branch-index] [data-field="parallel-branch-key"]')
    ;(keyInputs[1] as HTMLInputElement).value = 'branch_1'
    ;(keyInputs[1] as HTMLInputElement).dispatchEvent(new Event('input'))
    await flush()

    expect(container.querySelector('[data-field="parallel-branch-key-error"]')).not.toBeNull()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  // A6-3-3b parity guard — the mirror of conditionBranchEditor.spec.ts's "menu OFFERS wait_for_callback".
  // condition_branch split into a SEPARATE constant (CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES adds
  // wait_for_callback) so parallel_branch keeps BRANCH_AUTHORABLE_ACTION_TYPES (no wait). The backend
  // rejects a branch-local wait inside a parallel branch, so the parallel authoring MENU must EXCLUDE it.
  // This goes red if line :1010 is ever "simplified" to share the condition constant.
  it('the parallel branch action menu EXCLUDES wait_for_callback (and the other nested primitives)', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()

    setInput(container, '[data-field="name"]', 'Parallel menu')
    selectAction0(container, 'parallel_branch')
    await flush()

    const branchActionSelect = container.querySelector(
      '[data-action-config="parallel_branch"] [data-parallel-branch-action-index="0"] select',
    ) as HTMLSelectElement
    const options = Array.from(branchActionSelect.options).map((o) => o.value)
    expect(options).toContain('update_record')
    expect(options).toContain('send_notification')
    expect(options).not.toContain('wait_for_callback')
    expect(options).not.toContain('condition_branch')
    expect(options).not.toContain('parallel_branch')
    expect(options).not.toContain('start_approval')
  })

  it('blocks saving when the component draft exceeds the branch cap', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()

    setInput(container, '[data-field="name"]', 'Too many branches')
    selectAction0(container, 'parallel_branch')
    await flush()

    const addBranch = container.querySelector('[data-action-config="parallel_branch"] [data-action="add-parallel-branch"]') as HTMLButtonElement
    for (let i = 0; i < 10; i += 1) {
      addBranch.click()
      await flush()
    }

    expect(container.querySelectorAll('[data-parallel-branch-index]')).toHaveLength(11)
    expect(container.querySelector('[data-field="parallel-branch-key-error"]')?.textContent ?? '').toContain('at most 10')
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
