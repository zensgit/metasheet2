import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import type { AutomationRule } from '../src/multitable/types'

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

function fakeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'Test Rule',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'update_record',
    actionConfig: {},
    enabled: true,
    actions: [{ type: 'update_record', config: { fieldUpdates: [] } }],
    ...overrides,
  }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, props) })
  app.mount(container)
  return { container, app }
}

describe('MetaAutomationRuleEditor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders trigger type selector when visible', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    const triggerSelect = container.querySelector('[data-field="triggerType"]') as HTMLSelectElement
    expect(triggerSelect).toBeTruthy()
    expect(triggerSelect.options.length).toBe(7)
  })

  it('shows field picker for field.value_changed trigger', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    const triggerSelect = container.querySelector('[data-field="triggerType"]') as HTMLSelectElement
    triggerSelect.value = 'field.value_changed'
    triggerSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const fieldSelect = container.querySelector('[data-field="triggerFieldId"]')
    expect(fieldSelect).toBeTruthy()
  })

  it('shows cron preset for schedule.cron trigger', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    const triggerSelect = container.querySelector('[data-field="triggerType"]') as HTMLSelectElement
    triggerSelect.value = 'schedule.cron'
    triggerSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const cronSelect = container.querySelector('[data-field="cronPreset"]')
    expect(cronSelect).toBeTruthy()
  })

  it('can add and remove conditions', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    const addBtn = container.querySelector('[data-action="add-condition"]') as HTMLButtonElement
    expect(addBtn).toBeTruthy()

    addBtn.click()
    await flushPromises()

    const conditionRows = container.querySelectorAll('[data-condition-index]')
    expect(conditionRows.length).toBe(1)

    // Remove condition
    const removeBtn = conditionRows[0].querySelector('button')
    removeBtn?.click()
    await flushPromises()

    expect(container.querySelectorAll('[data-condition-index]').length).toBe(0)
  })

  it('can add actions up to max 3', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    // Starts with 1 action
    expect(container.querySelectorAll('[data-action-index]').length).toBe(1)

    const addBtn = container.querySelector('[data-action="add-action"]') as HTMLButtonElement
    addBtn.click()
    await flushPromises()
    expect(container.querySelectorAll('[data-action-index]').length).toBe(2)

    addBtn.click()
    await flushPromises()
    expect(container.querySelectorAll('[data-action-index]').length).toBe(3)

    // Button should be hidden at max 3
    const addBtnAfter = container.querySelector('[data-action="add-action"]')
    expect(addBtnAfter).toBeFalsy()
  })

  it('save button is disabled without a name', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('emits save with payload when name is filled', async () => {
    const saved = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'My Rule'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.name).toBe('My Rule')
    expect(payload.triggerType).toBe('record.created')
    expect(payload.actions).toHaveLength(1)
  })

  it('populates draft from existing rule', async () => {
    const rule = fakeRule({ name: 'Existing', triggerType: 'record.updated' })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    expect(nameInput.value).toBe('Existing')

    const triggerSelect = container.querySelector('[data-field="triggerType"]') as HTMLSelectElement
    expect(triggerSelect.value).toBe('record.updated')
  })
})
