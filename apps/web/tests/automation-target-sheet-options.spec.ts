// G-B2-27: create_record's "target sheet" field used to be a bare text box (paste a raw sheet ID
// by hand) — apps/web/src/multitable/utils/automation-target-sheet-options.ts is the pure mapping
// from listSheets() results to dropdown options, and MetaAutomationRuleEditor.vue wires it into an
// el-select with a manual-entry fallback/toggle. This file matrix-tests the pure mapping and adds a
// FEW focused mount checks (not a large new mount suite) proving the wiring end-to-end: the
// existing multitable-automation-rule-editor.spec.ts mount suite (~119 tests) stays the regression
// net for everything else in the component.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { automationTargetSheetOptions } from '../src/multitable/utils/automation-target-sheet-options'
import type { AutomationRule } from '../src/multitable/types'
import { epOptions, epSetSelect } from './helpers/epControls'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

describe('automationTargetSheetOptions (pure mapping)', () => {
  it('maps sheets to value/label options, preferring name and falling back to id', () => {
    expect(
      automationTargetSheetOptions([
        { id: 'sheet_1', name: 'Tasks' },
        { id: 'sheet_2', name: '' },
        { id: 'sheet_3', name: '   ' },
        { id: 'sheet_4' },
      ]),
    ).toEqual([
      { value: 'sheet_1', label: 'Tasks' },
      { value: 'sheet_2', label: 'sheet_2' },
      { value: 'sheet_3', label: 'sheet_3' },
      { value: 'sheet_4', label: 'sheet_4' },
    ])
  })

  it('drops entries without a usable string id instead of throwing', () => {
    expect(
      automationTargetSheetOptions([
        { id: '', name: 'Blank id' },
        { id: 123 as unknown as string, name: 'Non-string id' },
        null as unknown as { id: string },
        undefined as unknown as { id: string },
      ]),
    ).toEqual([])
  })

  it('is honest about non-array/nullish input — never throws, always an empty list', () => {
    expect(automationTargetSheetOptions(null)).toEqual([])
    expect(automationTargetSheetOptions(undefined)).toEqual([])
    expect(automationTargetSheetOptions('not-an-array' as unknown as null)).toEqual([])
    expect(automationTargetSheetOptions([])).toEqual([])
  })
})

const fields = [{ id: 'fld_1', name: 'Status', type: 'string' }]

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

describe('MetaAutomationRuleEditor — G-B2-27 target-sheet dropdown wiring', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('lists sheets from listSheets() and writes the selected id back on save', async () => {
    const saved = vi.fn()
    const client = {
      listSheets: vi.fn(async () => ({ sheets: [{ id: 'sheet_2', name: 'Tasks' }] })),
    }
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client, onSave: saved })
    await flushPromises()
    expect(client.listSheets).toHaveBeenCalledTimes(1)

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Create a task'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
    epSetSelect(actionSelect, 'create_record')
    await flushPromises()

    const sheetSelect = container.querySelector('[data-field="createRecordTargetSheetId"]') as HTMLElement
    expect(sheetSelect.tagName).not.toBe('INPUT') // el-select wrapper, not the plain-text fallback
    expect(epOptions(sheetSelect).map((o) => o.textContent)).toContain('Tasks')
    epSetSelect(sheetSelect, 'sheet_2')
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actions[0]).toEqual({ type: 'create_record', config: { sheetId: 'sheet_2', data: {} } })
  })

  it('degrades to a manual text input (never crashes) when the client has no listSheets at all', async () => {
    const saved = vi.fn()
    const client = {} // no listSheets — mirrors mockClient() in the main spec, which also omits it
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client, onSave: saved })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Create a task'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
    epSetSelect(actionSelect, 'create_record')
    await flushPromises()

    const sheetInput = container.querySelector('[data-field="createRecordTargetSheetId"]') as HTMLInputElement
    expect(sheetInput.tagName).toBe('INPUT')
    sheetInput.value = 'sheet_manual'
    sheetInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const payload = saved.mock.calls[0][0]
    expect(payload.actions[0]).toEqual({ type: 'create_record', config: { sheetId: 'sheet_manual', data: {} } })
  })

  it('degrades to a manual text input when no client prop is passed at all', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Create a task'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
    epSetSelect(actionSelect, 'create_record')
    await flushPromises()

    const sheetInput = container.querySelector('[data-field="createRecordTargetSheetId"]') as HTMLInputElement
    expect(sheetInput.tagName).toBe('INPUT')
  })

  it('defaults to manual entry — and preserves the value unedited on save — when an existing rule targets a sheet outside listSheets()', async () => {
    const saved = vi.fn()
    const client = {
      listSheets: vi.fn(async () => ({ sheets: [{ id: 'sheet_2', name: 'Tasks' }] })),
    }
    const rule = fakeRule({
      actionType: 'create_record',
      actions: [{ type: 'create_record', config: { sheetId: 'sheet_offbase', data: {} } }],
    })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client, rule, onSave: saved })
    await flushPromises()

    const sheetField = container.querySelector('[data-field="createRecordTargetSheetId"]') as HTMLInputElement
    expect(sheetField.tagName).toBe('INPUT') // manual mode, defaulted because sheet_offbase isn't in the fetched list
    expect(sheetField.value).toBe('sheet_offbase')

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actions[0]).toEqual({ type: 'create_record', config: { sheetId: 'sheet_offbase', data: {} } })
  })

  it('the manual-entry toggle switches to the dropdown and back without losing the typed value', async () => {
    const saved = vi.fn()
    const client = {
      listSheets: vi.fn(async () => ({ sheets: [{ id: 'sheet_2', name: 'Tasks' }] })),
    }
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client, onSave: saved })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Create a task'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
    epSetSelect(actionSelect, 'create_record')
    await flushPromises()

    const toggleBtn = container.querySelector('[data-field="createRecordTargetSheetToggle"]') as HTMLButtonElement
    toggleBtn.click()
    await flushPromises()

    const sheetInput = container.querySelector('[data-field="createRecordTargetSheetId"]') as HTMLInputElement
    expect(sheetInput.tagName).toBe('INPUT')
    sheetInput.value = 'sheet_cross_base'
    sheetInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const payload = saved.mock.calls[0][0]
    expect(payload.actions[0]).toEqual({ type: 'create_record', config: { sheetId: 'sheet_cross_base', data: {} } })
  })
})
