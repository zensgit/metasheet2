import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}
import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { AutomationRule, DingTalkGroupDelivery, DingTalkPersonDelivery } from '../src/multitable/types'

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
  const personDeliveries: DingTalkPersonDelivery[] = [
    {
      id: 'dpd_1',
      localUserId: 'user_1',
      dingtalkUserId: 'dt_1',
      sourceType: 'automation',
      subject: 'Ticket rec_1 ready',
      content: 'Please review the latest changes.',
      success: true,
      createdAt: '2026-04-19T12:00:00.000Z',
      localUserLabel: 'Lin Lan',
      localUserSubtitle: 'lin@example.com',
      localUserIsActive: true,
    },
  ]
  const groupDeliveries: DingTalkGroupDelivery[] = [
    {
      id: 'dgd_1',
      destinationId: 'dt_1',
      destinationName: 'Ops Group',
      sourceType: 'automation',
      subject: 'Ticket rec_1 pending',
      content: 'Please process the latest update.',
      success: true,
      createdAt: '2026-04-19T12:00:00.000Z',
    },
  ]

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/dingtalk-groups')) {
      return ok({
        destinations: [{
          id: 'dt_1',
          name: 'Ops Group',
          webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
          enabled: true,
          createdBy: 'user_1',
          createdAt: '2026-04-01T00:00:00Z',
        }],
      })
    }
    if (method === 'GET' && url.includes('/automations')) {
      if (url.includes('/dingtalk-group-deliveries')) {
        return ok({ deliveries: groupDeliveries })
      }
      if (url.includes('/dingtalk-person-deliveries')) {
        return ok({ deliveries: personDeliveries })
      }
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
  const client = new MultitableApiClient({ fetchFn })
  client.listCommentMentionSuggestions = vi.fn(async () => ({
    items: [
      { id: 'user_1', label: 'Lin Lan', subtitle: 'lin@example.com' },
      { id: 'user_2', label: 'Zhao Ming', subtitle: 'zhao@example.com' },
    ],
    total: 2,
    limit: 8,
  }))
  return { client, fetchFn }
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

const views = [
  { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
  { id: 'view_form', sheetId: 'sheet_1', name: 'Public Form', type: 'form' },
]

describe('MetaAutomationManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders rule list when visible', async () => {
    const { client } = mockClient([fakeRule()])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const cards = container.querySelectorAll('[data-automation-rule]')
    expect(cards.length).toBe(1)
    expect(container.querySelector('.meta-automation__card-name')?.textContent).toBe('Notify on create')
  })

  it('shows empty state when no rules', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const el = container.querySelector('[data-automation-empty]')
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain('No automations yet')
  })

  it('creates rule via form', async () => {
    const { client, fetchFn } = mockClient([])
    const updatedSpy = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client, onUpdated: updatedSpy })
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
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
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
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
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
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
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
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
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

  it('creates DingTalk group automation via form', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const destinationSelect = container.querySelector('[data-automation-field="dingtalkDestinationId"]') as HTMLSelectElement
    destinationSelect.value = 'dt_1'
    destinationSelect.dispatchEvent(new Event('change', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))

    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))

    const internalViewSelect = container.querySelector('[data-automation-field="internalViewId"]') as HTMLSelectElement
    internalViewSelect.value = 'view_grid'
    internalViewSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionType).toBe('send_dingtalk_group_message')
    expect(body.actionConfig).toEqual({
      destinationId: 'dt_1',
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
  })

  it('creates DingTalk person automation via form', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk person notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1, user_2'
    userIdsInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))

    const publicFormSelect = container.querySelector('[data-automation-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))

    const internalViewSelect = container.querySelector('[data-automation-field="dingtalkPersonInternalViewId"]') as HTMLSelectElement
    internalViewSelect.value = 'view_grid'
    internalViewSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionType).toBe('send_dingtalk_person_message')
    expect(body.actionConfig).toEqual({
      userIds: ['user_1', 'user_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
  })

  it('can search and add DingTalk person recipients before save', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk search notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const searchInput = container.querySelector('[data-automation-field="dingtalkPersonUserSearch"]') as HTMLInputElement
    searchInput.value = 'lin'
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const suggestion = container.querySelector('[data-automation-person-suggestion="user_1"]') as HTMLButtonElement
    expect(suggestion).toBeTruthy()
    suggestion.click()
    await flushPromises()

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    expect(userIdsInput.value).toBe('user_1')

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionConfig.userIds).toEqual(['user_1'])
    expect(client.listCommentMentionSuggestions).toHaveBeenCalledTimes(1)
  })

  it('opens DingTalk person delivery viewer for person message rules', async () => {
    const { client } = mockClient([
      fakeRule({
        name: 'DingTalk person notify',
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: ['user_1'],
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill {{record.status}}',
        },
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const deliveriesBtn = container.querySelector('[data-automation-person-deliveries="rule_1"]') as HTMLButtonElement
    expect(deliveriesBtn).toBeTruthy()
    deliveriesBtn.click()
    await flushPromises()

    const delivery = document.querySelector('[data-person-delivery-id="dpd_1"]')
    expect(delivery?.textContent).toContain('Lin Lan')
    expect(delivery?.textContent).toContain('Ticket rec_1 ready')
  })

  it('opens DingTalk group delivery viewer for group message rules', async () => {
    const { client } = mockClient([
      fakeRule({
        name: 'DingTalk group notify',
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'dt_1',
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill {{record.status}}',
        },
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const deliveriesBtn = container.querySelector('[data-automation-group-deliveries="rule_1"]') as HTMLButtonElement
    expect(deliveriesBtn).toBeTruthy()
    deliveriesBtn.click()
    await flushPromises()

    const delivery = document.querySelector('[data-group-delivery-id="dgd_1"]')
    expect(delivery?.textContent).toContain('Ops Group')
    expect(delivery?.textContent).toContain('Ticket rec_1 pending')
  })

  it('applies DingTalk group presets in the inline create form', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const presetBtn = container.querySelector('[data-automation-preset="group-form"]') as HTMLButtonElement
    presetBtn.click()
    await flushPromises()

    const titleInput = container.querySelector('[data-automation-field="dingtalkTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-automation-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    const internalViewSelect = container.querySelector('[data-automation-field="internalViewId"]') as HTMLSelectElement

    expect(titleInput.value).toBe('{{recordId}} 待填写')
    expect(bodyInput.value).toContain('请完成本次表单填写')
    expect(publicFormSelect.value).toBe('view_form')
    expect(internalViewSelect.value).toBe('')
  })

  it('applies DingTalk person presets in the inline create form', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1'
    userIdsInput.dispatchEvent(new Event('input', { bubbles: true }))

    const presetBtn = container.querySelector('[data-automation-preset="person-both"]') as HTMLButtonElement
    presetBtn.click()
    await flushPromises()

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    const publicFormSelect = container.querySelector('[data-automation-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    const internalViewSelect = container.querySelector('[data-automation-field="dingtalkPersonInternalViewId"]') as HTMLSelectElement

    expect(userIdsInput.value).toBe('user_1')
    expect(titleInput.value).toBe('{{recordId}} 待填写并处理')
    expect(bodyInput.value).toContain('请先填写所需信息')
    expect(publicFormSelect.value).toBe('view_form')
    expect(internalViewSelect.value).toBe('view_grid')
  })

  it('inserts DingTalk template tokens in the inline create form', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    ;(container.querySelector('[data-automation-token="person-title-recordId"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-automation-token="person-body-recordField"]') as HTMLButtonElement).click()
    await flushPromises()

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    expect(titleInput.value).toBe('{{recordId}}')
    expect(bodyInput.value).toBe('{{record.xxx}}')
  })
})
