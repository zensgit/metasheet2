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
  { id: 'assigneeUserIds', name: 'Assignees', type: 'user' },
  { id: 'reviewerUserId', name: 'Reviewer', type: 'user' },
  { id: 'watcherGroupIds', name: 'Watcher groups', type: 'link', property: { refKind: 'member-group' } },
  { id: 'escalationGroupId', name: 'Escalation group', type: 'member-group' },
]

const views = [
  { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
  {
    id: 'view_form',
    sheetId: 'sheet_1',
    name: 'Public Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_view_form' } },
  },
]

const viewsWithDisabledPublicForm = [
  views[0],
  {
    ...views[1],
    config: { publicForm: { enabled: false, publicToken: 'pub_view_form' } },
  },
]

const viewsWithProtectedPublicFormWithoutAllowlist = [
  views[0],
  {
    ...views[1],
    config: { publicForm: { enabled: true, publicToken: 'pub_view_form', accessMode: 'dingtalk' } },
  },
]

const viewsWithProtectedPublicFormAllowlist = [
  views[0],
  {
    ...views[1],
    config: {
      publicForm: {
        enabled: true,
        publicToken: 'pub_view_form',
        accessMode: 'dingtalk',
        allowedUserIds: ['user_1'],
      },
    },
  },
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
      {
        id: 'dt_2',
        name: 'Escalation Group',
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-2',
        enabled: true,
        sheetId: 'sheet_1',
        createdBy: 'user_1',
        createdAt: '2026-04-01T00:00:00Z',
      },
    ]),
    listCommentMentionSuggestions: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 8,
    })),
    listFormShareCandidates: vi.fn(async () => ({
      items: [
        { subjectType: 'user', subjectId: 'user_1', label: 'Lin Lan', subtitle: 'lin@example.com', isActive: true },
        { subjectType: 'user', subjectId: 'user_2', label: 'Zhao Ming', subtitle: 'zhao@example.com', isActive: true },
        { subjectType: 'member-group', subjectId: 'group_1', label: 'Sales Team', subtitle: '3 members', isActive: true },
      ],
      total: 3,
      limit: 8,
      query: '',
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

  it('disables Test Run for unsaved rules and explains why', async () => {
    const tested = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onTest: tested })
    await flushPromises()

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(true)
    testBtn.click()
    await flushPromises()

    expect(tested).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Save this automation before running a test.')
  })

  it('warns that DingTalk Test Run can send real messages and emits the saved rule id', async () => {
    const tested = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      rule: fakeRule({
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'dt_1',
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill',
        },
        actions: [{
          type: 'send_dingtalk_group_message',
          config: { destinationId: 'dt_1', titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        }],
      }),
      onTest: tested,
    })
    await flushPromises()

    expect(container.querySelector('[data-field="dingtalkTestRunWarning"]')?.textContent).toContain('can send real DingTalk messages')

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    testBtn.click()
    await flushPromises()

    expect(tested).toHaveBeenCalledWith('rule_1')
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('can send real DingTalk messages'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Unsaved changes are not included'))
  })

  it('requires confirmation when saved V1 actions contain DingTalk but legacy actionType does not', async () => {
    const tested = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      rule: fakeRule({
        actionType: 'notify',
        actionConfig: { message: 'Internal notification' },
        actions: [
          { type: 'notify', config: { message: 'Internal notification' } },
          {
            type: 'send_dingtalk_group_message',
            config: { destinationId: 'dt_1', titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
          },
        ],
      }),
      onTest: tested,
    })
    await flushPromises()

    expect(container.querySelector('[data-field="dingtalkTestRunWarning"]')?.textContent).toContain('can send real DingTalk messages')

    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(tested).toHaveBeenCalledWith('rule_1')
  })

  it('does not emit DingTalk Test Run when confirmation is canceled', async () => {
    const tested = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      rule: fakeRule({
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: ['user_1'],
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill',
        },
        actions: [{
          type: 'send_dingtalk_person_message',
          config: { userIds: ['user_1'], titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        }],
      }),
      onTest: tested,
    })
    await flushPromises()

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    testBtn.click()
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(tested).not.toHaveBeenCalled()
  })

  it('requires confirmation based on the saved rule even when the draft action changes', async () => {
    const tested = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      rule: fakeRule({
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'dt_1',
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill',
        },
        actions: [{
          type: 'send_dingtalk_group_message',
          config: { destinationId: 'dt_1', titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        }],
      }),
      onTest: tested,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'notify'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(tested).toHaveBeenCalledWith('rule_1')
  })

  it('does not require confirmation for non-DingTalk Test Run', async () => {
    const tested = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: fakeRule({
        actionType: 'notify',
        actionConfig: { message: 'Hello' },
        actions: [{ type: 'notify', config: { message: 'Hello' } }],
      }),
      onTest: tested,
    })
    await flushPromises()

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    testBtn.click()
    await flushPromises()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(tested).toHaveBeenCalledWith('rule_1')
  })

  it('shows Test Run feedback and disables duplicate clicks while running', async () => {
    const tested = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: fakeRule(),
      testRunState: { status: 'running', message: 'Running test. DingTalk actions may send real messages.' },
      onTest: tested,
    })
    await flushPromises()

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(true)
    expect(testBtn.textContent).toContain('Running...')
    expect(container.querySelector('[data-field="testRunStatus"]')?.textContent).toContain('Running test')

    testBtn.click()
    await flushPromises()
    expect(tested).not.toHaveBeenCalled()
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

    const destinationSelect = container.querySelector('[data-field="dingtalkDestinationPickerId"]') as HTMLSelectElement
    destinationSelect.value = 'dt_1'
    destinationSelect.dispatchEvent(new Event('change'))
    await flushPromises()
    destinationSelect.value = 'dt_2'
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
      destinationIds: ['dt_1', 'dt_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
    expect(payload.actions[0]).toEqual({
      type: 'send_dingtalk_group_message',
      config: {
        destinationId: 'dt_1',
        destinationIds: ['dt_1', 'dt_2'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please review {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    })
    expect(container.querySelector('[data-group-destination="dt_1"]')).not.toBeNull()
    expect(container.querySelector('[data-group-destination="dt_2"]')).not.toBeNull()
    expect(client.listDingTalkGroups).toHaveBeenCalledTimes(1)
    expect(client.listDingTalkGroups).toHaveBeenCalledWith('sheet_1')
  })

  it('emits DingTalk group action config with only dynamic record destination paths', async () => {
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
    nameInput.value = 'Notify dynamic groups'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const destinationFieldInput = container.querySelector('[data-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    destinationFieldInput.value = 'record.fld_2'
    destinationFieldInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionConfig).toEqual({
      destinationIdFieldPath: 'record.fld_2',
      destinationIdFieldPaths: ['record.fld_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
    })
  })

  it('can pick a dynamic DingTalk group destination field', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkDestinationFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'fld_2'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const fieldInput = container.querySelector('[data-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    const summary = container.querySelector('[data-field="groupMessageSummary"]')
    expect(fieldInput.value).toBe('record.fld_2')
    expect(summary?.textContent).toContain('Name (record.fld_2)')
    expect(container.querySelector('[data-group-destination-field="fld_2"]')).not.toBeNull()
  })

  it('warns when a dynamic DingTalk group destination path points to a user or member group field', async () => {
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

    const fieldInput = container.querySelector('[data-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    fieldInput.value = 'record.assigneeUserIds, record.watcherGroupIds'
    fieldInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('record.assigneeUserIds is a user field')
    expect(container.textContent).toContain('record.watcherGroupIds is a member group field')
  })

  it('warns when a DingTalk group message selects a disabled public form link', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithDisabledPublicForm,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing is disabled for "Public Form"')
  })

  it('disables saving a DingTalk group message when the selected public form link cannot work', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithDisabledPublicForm,
      client,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Notify DingTalk'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const destinationSelect = container.querySelector('[data-field="dingtalkDestinationPickerId"]') as HTMLSelectElement
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
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(container.textContent).toContain('Public form sharing is disabled for "Public Form"')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  })

  it('warns when a DingTalk group message includes a fully public form link', async () => {
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

    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing for "Public Form" is fully public')
    expect(container.textContent).toContain('Use DingTalk-protected access and an allowlist')
    expect(container.querySelector('[data-field="groupMessageSummary"]')?.textContent).toContain('Fully public; anyone with the link can submit')
  })

  it('warns when a DingTalk group message uses a protected public form without an allowlist', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithProtectedPublicFormWithoutAllowlist,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing for "Public Form" allows all bound DingTalk users to submit')
    expect(container.textContent).toContain('add allowed users or member groups')
  })

  it('does not warn when a DingTalk group message uses a protected public form with an allowlist', async () => {
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithProtectedPublicFormAllowlist,
      client,
    })
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(container.textContent).not.toContain('allows all bound DingTalk users to submit')
    expect(container.textContent).not.toContain('is fully public')
    expect(container.querySelector('[data-field="groupMessageSummary"]')?.textContent).toContain('DingTalk-bound users in allowlist can submit')
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

    expect(container.querySelector('[data-field="personMessageSummary"]')?.textContent).toContain('Fully public; anyone with the link can submit')

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

  it('disables saving a DingTalk group message when the internal processing view is missing', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const config = {
      destinationIds: ['dt_1'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      internalViewId: 'missing_view',
    }
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
      rule: fakeRule({
        actionType: 'send_dingtalk_group_message',
        actionConfig: config,
        actions: [{ type: 'send_dingtalk_group_message', config }],
      }),
      onSave: saved,
    })
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(container.textContent).toContain('Internal processing view "missing_view" is not available in this sheet')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  })

  it('disables saving a DingTalk person message when the selected public form link cannot work', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithDisabledPublicForm,
      client,
      onSave: saved,
    })
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Notify People'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1'
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
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(container.textContent).toContain('Public form sharing is disabled for "Public Form"')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  })

  it('disables saving a DingTalk person message when the internal processing view is missing', async () => {
    const saved = vi.fn()
    const client = mockClient()
    const config = {
      userIds: ['user_1'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      internalViewId: 'missing_view',
    }
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views,
      client,
      rule: fakeRule({
        actionType: 'send_dingtalk_person_message',
        actionConfig: config,
        actions: [{ type: 'send_dingtalk_person_message', config }],
      }),
      onSave: saved,
    })
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(container.textContent).toContain('Internal processing view "missing_view" is not available in this sheet')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
  })

  it('emits DingTalk person action config with only a dynamic record recipient path', async () => {
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
    nameInput.value = 'Notify dynamic recipients'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.assigneeUserIds'
    recipientFieldInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionConfig).toEqual({
      userIds: [],
      userIdFieldPath: 'record.assigneeUserIds',
      userIdFieldPaths: ['record.assigneeUserIds'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
    })
    expect(payload.actions[0]).toEqual({
      type: 'send_dingtalk_person_message',
      config: {
        userIds: [],
        userIdFieldPath: 'record.assigneeUserIds',
        userIdFieldPaths: ['record.assigneeUserIds'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please review {{record.status}}',
      },
    })
    expect(container.textContent).toContain('Record recipients:')
    expect(container.textContent).toContain('Assignees (record.assigneeUserIds)')
  })

  it('emits DingTalk person action config with only a dynamic member group record path', async () => {
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
    nameInput.value = 'Notify dynamic member groups'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.watcherGroupIds'
    memberGroupFieldInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(saved).toHaveBeenCalledTimes(1)
    const payload = saved.mock.calls[0][0]
    expect(payload.actionConfig).toEqual({
      userIds: [],
      memberGroupIdFieldPath: 'record.watcherGroupIds',
      memberGroupIdFieldPaths: ['record.watcherGroupIds'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
    })
    expect(container.textContent).toContain('Record member groups:')
    expect(container.textContent).toContain('record.watcherGroupIds')
  })

  it('can remove a selected dynamic member group recipient field chip in the rule editor', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.watcherGroupIds, record.escalationGroupId'
    memberGroupFieldInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const firstChip = container.querySelector('[data-member-group-recipient-field="watcherGroupIds"]') as HTMLButtonElement
    expect(firstChip?.textContent).toContain('record.watcherGroupIds')
    firstChip.click()
    await flushPromises()

    expect(memberGroupFieldInput.value).toBe('record.escalationGroupId')
    expect(container.querySelector('[data-member-group-recipient-field="watcherGroupIds"]')).toBeNull()
  })

  it('warns when a dynamic member group recipient path is unknown in the rule editor', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.unknownGroupField'
    memberGroupFieldInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('record.unknownGroupField is not a known field in this sheet')
  })

  it('warns when a dynamic member group recipient path points at a user field in the rule editor', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.assigneeUserIds'
    memberGroupFieldInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('record.assigneeUserIds is a user field; use Record recipient field paths instead.')
  })

  it('can pick a member group recipient field in the rule editor', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'watcherGroupIds'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    expect(memberGroupFieldInput.value).toBe('record.watcherGroupIds')
    expect(container.textContent).toContain('Watcher groups (record.watcherGroupIds)')
  })

  it('only lists explicit member group fields in the member group recipient picker for the rule editor', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldSelect"]') as HTMLSelectElement
    const optionValues = Array.from(fieldSelect.options).map((option) => option.value)
    expect(optionValues).toContain('watcherGroupIds')
    expect(optionValues).toContain('escalationGroupId')
    expect(optionValues).not.toContain('assigneeUserIds')
    expect(optionValues).not.toContain('fld_1')
  })

  it('can pick a record recipient field in the rule editor', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds')
    expect(container.textContent).toContain('Assignees (record.assigneeUserIds)')
  })

  it('only lists user fields in the DingTalk person recipient picker for the rule editor', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    const optionValues = Array.from(fieldSelect.options).map((option) => option.value)
    expect(optionValues).toContain('assigneeUserIds')
    expect(optionValues).toContain('reviewerUserId')
    expect(optionValues).not.toContain('fld_1')
  })

  it('can append multiple record recipient fields in the rule editor', async () => {
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
    nameInput.value = 'Notify multiple recipients'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()
    fieldSelect.value = 'reviewerUserId'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds, record.reviewerUserId')

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please review {{record.status}}'
    bodyInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const payload = saved.mock.calls[0][0]
    expect(payload.actionConfig).toEqual({
      userIds: [],
      userIdFieldPath: 'record.assigneeUserIds',
      userIdFieldPaths: ['record.assigneeUserIds', 'record.reviewerUserId'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
    })
  })

  it('can remove a selected dynamic recipient field chip in the rule editor', async () => {
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

    const fieldSelect = container.querySelector('[data-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()
    fieldSelect.value = 'reviewerUserId'
    fieldSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const firstChip = container.querySelector('[data-field-recipient="assigneeUserIds"]') as HTMLButtonElement
    expect(firstChip?.textContent).toContain('Assignees')
    firstChip.click()
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.reviewerUserId')
    expect(container.querySelector('[data-field-recipient="assigneeUserIds"]')).toBeNull()
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

    const suggestion = container.querySelector('[data-person-recipient-suggestion="user:user_1"]') as HTMLButtonElement
    expect(suggestion).toBeTruthy()
    suggestion.click()
    await flushPromises()

    searchInput.value = 'sales'
    searchInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const groupSuggestion = container.querySelector('[data-person-recipient-suggestion="member-group:group_1"]') as HTMLButtonElement
    expect(groupSuggestion).toBeTruthy()
    groupSuggestion.click()
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    expect(userIdsInput.value).toBe('user_1')
    const memberGroupIdsInput = container.querySelector('[data-field="dingtalkPersonMemberGroupIds"]') as HTMLTextAreaElement
    expect(memberGroupIdsInput.value).toBe('group_1')

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
    expect(payload.actionConfig.memberGroupIds).toEqual(['group_1'])
    expect(client.listFormShareCandidates).toHaveBeenCalledTimes(2)
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

    const destinationSelect = container.querySelector('[data-field="dingtalkDestinationPickerId"]') as HTMLSelectElement
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

  it('warns when a DingTalk person recipient path is not a user field in the rule editor', async () => {
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

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.fld_1'
    recipientFieldInput.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(container.textContent).toContain('record.fld_1 is not a user field')
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
