import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}
import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { AutomationRule } from '../src/multitable/types'

function fakeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'Notify on create',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'notify',
    actionConfig: { message: 'New record!' },
    enabled: true,
    ...overrides,
  }
}

function mockClient(rules: AutomationRule[] = []) {
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const noContent = () => new Response(null, { status: 204 })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/automations')) {
      return ok({ rules })
    }
    if (method === 'POST' && url.includes('/automations')) {
      const body = JSON.parse(init?.body as string)
      return ok({ id: 'rule_new', sheetId: 'sheet_1', enabled: true, ...body })
    }
    if (method === 'PATCH' && url.includes('/automations/')) {
      return noContent()
    }
    if (method === 'DELETE' && url.includes('/automations/')) {
      return noContent()
    }
    return ok({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationManager, props) })
  app.mount(container)
  return { container, app }
}

const fields = [
  { id: 'fld_1', name: 'Status', type: 'select' },
  { id: 'fld_2', name: 'Name', type: 'string' },
]

describe('MetaAutomationManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders rule list when visible', async () => {
    const { client } = mockClient([fakeRule()])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    const cards = container.querySelectorAll('[data-automation-rule]')
    expect(cards.length).toBe(1)
    expect(container.querySelector('.meta-automation__card-name')?.textContent).toBe('Notify on create')
  })

  it('shows empty state when no rules', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    const el = container.querySelector('[data-automation-empty]')
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain('No automations yet')
  })

  it('creates rule via form', async () => {
    const { client, fetchFn } = mockClient([])
    const updatedSpy = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client, onUpdated: updatedSpy })
    await flushPromises()

    // Open form
    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    // Fill name
    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'My Rule'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    // Fill message for notify action
    const msgInput = container.querySelector('[data-automation-field="notifyMessage"]') as HTMLInputElement
    msgInput.value = 'Hello!'
    msgInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // Save
    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.name).toBe('My Rule')
    expect(body.triggerType).toBe('record.created')
    expect(body.actionType).toBe('notify')
    expect(body.actionConfig.message).toBe('Hello!')
  })

  it('toggles rule enabled/disabled', async () => {
    const { client, fetchFn } = mockClient([fakeRule()])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    const toggle = container.querySelector('[data-automation-toggle]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    toggle.click()
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'PATCH')
    expect(patchCalls.length).toBe(1)
    const body = JSON.parse(patchCalls[0][1]?.body as string)
    expect(body.enabled).toBe(false)
  })

  it('deletes rule', async () => {
    const { client, fetchFn } = mockClient([fakeRule()])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    const deleteBtn = container.querySelector('[data-automation-delete]') as HTMLButtonElement
    deleteBtn.click()
    await flushPromises()

    const deleteCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'DELETE')
    expect(deleteCalls.length).toBe(1)
    expect(container.querySelectorAll('[data-automation-rule]').length).toBe(0)
  })

  it('shows field picker for field.changed trigger', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    // Open form
    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    // No field picker by default
    expect(container.querySelector('[data-automation-field="triggerFieldId"]')).toBeNull()

    // Change trigger type to field.changed
    const triggerSelect = container.querySelector('[data-automation-field="triggerType"]') as HTMLSelectElement
    triggerSelect.value = 'field.changed'
    triggerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const fieldPicker = container.querySelector('[data-automation-field="triggerFieldId"]') as HTMLSelectElement
    expect(fieldPicker).not.toBeNull()
    // Should have option for each field plus the placeholder
    expect(fieldPicker.options.length).toBe(fields.length + 1)
  })

  it('shows appropriate action config for each action type', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, client })
    await flushPromises()

    // Open form
    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    // Default action is notify — should show message input
    expect(container.querySelector('[data-automation-field="notifyMessage"]')).not.toBeNull()
    expect(container.querySelector('[data-automation-field="targetFieldId"]')).toBeNull()

    // Switch to update_field
    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'update_field'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.querySelector('[data-automation-field="notifyMessage"]')).toBeNull()
    expect(container.querySelector('[data-automation-field="targetFieldId"]')).not.toBeNull()
    expect(container.querySelector('[data-automation-field="targetValue"]')).not.toBeNull()
  })
})
