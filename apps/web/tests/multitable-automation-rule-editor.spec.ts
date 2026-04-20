import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const views = [
  { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
  { id: 'view_form', sheetId: 'sheet_1', name: 'Public Form', type: 'form' },
]

function mockClient() {
  return {
    listDingTalkGroups: vi.fn(async () => [
      {
        id: 'dt_1',
        name: 'Ops Group',
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
        enabled: true,
        sheetId: 'sheet_1',
        createdBy: 'user_1',
        createdAt: '2026-04-01T00:00:00Z',
      },
    ]),
    listCommentMentionSuggestions: vi.fn(async () => ({
      items: [
        { id: 'user_1', label: 'Lin Lan', subtitle: 'lin@example.com' },
        { id: 'user_2', label: 'Zhao Ming', subtitle: 'zhao@example.com' },
      ],
      total: 2,
      limit: 8,
    })),
  }
}

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
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
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

  it('emits DingTalk group action config with optional links', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Notify DingTalk'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const destinationSelect = container.querySelector('[data-field="dingtalkDestinationId"]') as HTMLSelectElement
    destinationSelect.value = 'dt_1'
    destinationSelect.dispatchEvent(new Event('change'))

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))

    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))

    const internalViewSelect = container.querySelector('[data-field="internalViewId"]') as HTMLSelectElement
    internalViewSelect.value = 'view_grid'
    internalViewSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionType).toBe('send_dingtalk_group_message')
    expect(payload.actionConfig).toEqual({
      destinationId: 'dt_1',
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
    expect(payload.actions[0]).toEqual({
      type: 'send_dingtalk_group_message',
      config: {
        destinationId: 'dt_1',
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please review {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    })
    expect(client.listDingTalkGroups).toHaveBeenCalledTimes(1)
    expect(client.listDingTalkGroups).toHaveBeenCalledWith('sheet_1')
  })

  it('emits DingTalk person action config with optional links', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Notify People'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1, user_2'
    userIdsInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))

    const publicFormSelect = container.querySelector('[data-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))

    const internalViewSelect = container.querySelector('[data-field="dingtalkPersonInternalViewId"]') as HTMLSelectElement
    internalViewSelect.value = 'view_grid'
    internalViewSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionType).toBe('send_dingtalk_person_message')
    expect(payload.actionConfig).toEqual({
      userIds: ['user_1', 'user_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
    expect(payload.actions[0]).toEqual({
      type: 'send_dingtalk_person_message',
      config: {
        userIds: ['user_1', 'user_2'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please review {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    })
  })

  it('can search and add DingTalk person recipients', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Notify search recipients'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const searchInput = container.querySelector('[data-field="dingtalkPersonUserSearch"]') as HTMLInputElement
    searchInput.value = 'lin'
    searchInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const suggestion = container.querySelector('[data-person-recipient-suggestion="user_1"]') as HTMLButtonElement
    expect(suggestion).toBeTruthy()
    suggestion.click()
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    expect(userIdsInput.value).toBe('user_1')

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionConfig.userIds).toEqual(['user_1'])
    expect(client.listCommentMentionSuggestions).toHaveBeenCalledTimes(1)
  })

  it('applies DingTalk group message presets', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const presetBtn = container.querySelector('[data-field="groupPresetBoth"]') as HTMLButtonElement
    presetBtn.click()
    await flushPromises()

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    const internalViewSelect = container.querySelector('[data-field="internalViewId"]') as HTMLSelectElement

    expect(titleInput.value).toBe('{{recordId}} 待填写并处理')
    expect(bodyInput.value).toContain('请先填写所需信息')
    expect(publicFormSelect.value).toBe('view_form')
    expect(internalViewSelect.value).toBe('view_grid')
  })

  it('applies DingTalk person message presets without touching recipients', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1'
    userIdsInput.dispatchEvent(new Event('input'))

    const presetBtn = container.querySelector('[data-field="personPresetInternal"]') as HTMLButtonElement
    presetBtn.click()
    await flushPromises()

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    const publicFormSelect = container.querySelector('[data-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    const internalViewSelect = container.querySelector('[data-field="dingtalkPersonInternalViewId"]') as HTMLSelectElement

    expect(userIdsInput.value).toBe('user_1')
    expect(titleInput.value).toBe('{{recordId}} 待处理')
    expect(bodyInput.value).toContain('请查看并处理该记录')
    expect(publicFormSelect.value).toBe('')
    expect(internalViewSelect.value).toBe('view_grid')
  })

  it('inserts DingTalk template tokens in the rule editor', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    ;(container.querySelector('[data-field="groupTitleToken-recordId"]') as HTMLButtonElement).click()
    ;(container.querySelector('[data-field="groupBodyToken-recordField"]') as HTMLButtonElement).click()
    await flushPromises()

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    expect(titleInput.value).toBe('{{recordId}}')
    expect(bodyInput.value).toBe('{{record.xxx}}')
  })

  it('shows DingTalk group message summary in the rule editor', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const destinationSelect = container.querySelector('[data-field="dingtalkDestinationId"]') as HTMLSelectElement
    destinationSelect.value = 'dt_1'
    destinationSelect.dispatchEvent(new Event('change'))

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.xxx}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const summary = container.querySelector('[data-field="groupMessageSummary"]')
    expect(summary?.textContent).toContain('Ops Group')
    expect(summary?.textContent).toContain('Ticket {{recordId}}')
    expect(summary?.textContent).toContain('Please fill {{record.xxx}}')
    expect(summary?.textContent).toContain('Ticket record_demo_001')
    expect(summary?.textContent).toContain('Please fill 示例字段值')
    expect(summary?.textContent).toContain('No public form link')
    expect(summary?.textContent).toContain('No internal link')
  })

  it('shows DingTalk template syntax warnings in the rule editor', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = '{{record-id}}'
    titleInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('Unsupported placeholder syntax {{record-id}}')
  })

  it('shows DingTalk unknown placeholder warnings in the rule editor', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = '{{recoredId}}'
    titleInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('Unknown placeholder {{recoredId}}')
  })

  it('copies rendered DingTalk group body example in the rule editor', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.xxx}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    ;(container.querySelector('[data-field="groupRenderedBodyCopy-0"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(navigator.clipboard?.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard!.writeText).mock.calls[0]?.[0]).toBe('Please fill 示例字段值')
    expect(container.textContent).toContain('Copied')
  })
})
