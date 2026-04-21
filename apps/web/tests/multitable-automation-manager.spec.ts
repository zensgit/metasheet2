import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

const routerPushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}))

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}
import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { AppRouteNames } from '../src/router/types'
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

function mockClient(
  rules: AutomationRule[] = [],
  options: {
    testExecution?: Record<string, unknown> | Promise<Record<string, unknown>>
    testErrorMessage?: string
    groupDeliveryErrorMessage?: string
    personDeliveryErrorMessage?: string
    stats?: Record<string, unknown>
  } = {},
) {
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const apiError = (message: string) => new Response(
    JSON.stringify({ error: { code: 'INTERNAL_ERROR', message } }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  )
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
        destinations: [
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
        ],
      })
    }
    if (method === 'POST' && url.includes('/automations/') && url.endsWith('/test')) {
      if (options.testErrorMessage) {
        return new Response(
          JSON.stringify({ error: options.testErrorMessage }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return ok(await (options.testExecution ?? {
        id: 'exec_1',
        ruleId: 'rule_1',
        status: 'success',
        triggerType: 'record.created',
        startedAt: '2026-04-21T00:00:00.000Z',
        duration: 32,
        steps: [],
      }))
    }
    if (method === 'GET' && url.includes('/automations')) {
      if (url.includes('/dingtalk-group-deliveries')) {
        if (options.groupDeliveryErrorMessage) return apiError(options.groupDeliveryErrorMessage)
        return ok({ deliveries: groupDeliveries })
      }
      if (url.includes('/dingtalk-person-deliveries')) {
        if (options.personDeliveryErrorMessage) return apiError(options.personDeliveryErrorMessage)
        return ok({ deliveries: personDeliveries })
      }
      if (url.endsWith('/stats')) {
        return ok(options.stats ?? { total: 1, success: 1, failed: 0, skipped: 0, avgDurationMs: 32 })
      }
      return ok({ rules })
    }
    if (method === 'POST' && url.includes('/automations')) {
      const body = JSON.parse(init?.body as string)
      return ok({
        rule: {
          id: 'rule_new',
          sheetId: 'sheet_1',
          enabled: true,
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          ...body,
        },
      })
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
  client.listFormShareCandidates = vi.fn(async () => ({
    items: [
      { subjectType: 'user', subjectId: 'user_1', label: 'Lin Lan', subtitle: 'lin@example.com', isActive: true },
      { subjectType: 'user', subjectId: 'user_2', label: 'Zhao Ming', subtitle: 'zhao@example.com', isActive: true },
      { subjectType: 'member-group', subjectId: 'group_1', label: 'Sales Team', subtitle: '3 members', isActive: true },
    ],
    total: 3,
    limit: 8,
    query: '',
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

const viewsWithMissingPublicToken = [
  views[0],
  {
    ...views[1],
    config: { publicForm: { enabled: true, publicToken: '' } },
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
        allowedMemberGroupIds: ['group_1'],
      },
    },
  },
]

describe('MetaAutomationManager', () => {
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    routerPushMock.mockClear()
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

  it('renders rule list when visible', async () => {
    const { client } = mockClient([fakeRule()])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const cards = container.querySelectorAll('[data-automation-rule]')
    expect(cards.length).toBe(1)
    expect(container.querySelector('.meta-automation__card-name')?.textContent).toBe('Notify on create')
    expect(container.querySelector('.meta-automation__card-desc')?.textContent).toContain('Send notification')
  })

  it('describes V1 multi-action DingTalk group rules in the list', async () => {
    const { client } = mockClient([
      fakeRule({
        name: 'Multi-step group notify',
        actionType: 'notify',
        actionConfig: { message: 'Internal note' },
        actions: [
          { type: 'notify', config: { message: 'Internal note' } },
          {
            type: 'send_dingtalk_group_message',
            config: {
              destinationId: 'dt_1',
              titleTemplate: 'Ticket {{recordId}}',
              bodyTemplate: 'Please fill {{record.status}}',
              publicFormViewId: 'view_form',
              internalViewId: 'view_grid',
            },
          },
        ],
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const desc = container.querySelector('[data-automation-rule="rule_1"] .meta-automation__card-desc')
    expect(desc?.textContent).toContain('Send notification')
    expect(desc?.textContent).toContain('Send DingTalk group message')
    expect(desc?.textContent).toContain('Public form: Public Form')
    expect(desc?.textContent).toContain('Internal processing: Grid')

    const publicLink = container.querySelector('[data-automation-card-link="public-form:view_form"]') as HTMLAnchorElement
    expect(publicLink).not.toBeNull()
    expect(publicLink.textContent).toContain('Open public form: Public Form')
    expect(publicLink.getAttribute('href')).toBe(`${window.location.origin}/multitable/public-form/sheet_1/view_form?publicToken=pub_view_form`)
    expect(publicLink.getAttribute('target')).toBe('_blank')

    const internalLink = container.querySelector('[data-automation-card-link="internal-view:view_grid"]') as HTMLButtonElement
    expect(internalLink).not.toBeNull()
    expect(internalLink.textContent).toContain('Open internal view: Grid')
    internalLink.click()
    await flushPromises()

    expect(routerPushMock).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: {
        sheetId: 'sheet_1',
        viewId: 'view_grid',
      },
    })
  })

  it('describes V1 multi-action DingTalk person rules in the list', async () => {
    const { client } = mockClient([
      fakeRule({
        name: 'Multi-step person notify',
        actionType: 'notify',
        actionConfig: { message: 'Internal note' },
        actions: [
          { type: 'notify', config: { message: 'Internal note' } },
          {
            type: 'send_dingtalk_person_message',
            config: {
              userIds: ['user_1'],
              titleTemplate: 'Ticket {{recordId}}',
              bodyTemplate: 'Please fill {{record.status}}',
              publicFormViewId: 'view_form',
              internalViewId: 'view_grid',
            },
          },
        ],
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const desc = container.querySelector('[data-automation-rule="rule_1"] .meta-automation__card-desc')
    expect(desc?.textContent).toContain('Send notification')
    expect(desc?.textContent).toContain('Send DingTalk person message')
    expect(desc?.textContent).toContain('Public form: Public Form')
    expect(desc?.textContent).toContain('Internal processing: Grid')
  })

  it('does not render a public form card link when sharing is missing a public token', async () => {
    const { client } = mockClient([
      fakeRule({
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'dt_1',
          publicFormViewId: 'view_form',
          internalViewId: 'view_grid',
        },
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views: viewsWithMissingPublicToken, client })
    await flushPromises()

    expect(container.querySelector('[data-automation-card-link="public-form:view_form"]')).toBeNull()
    expect(container.querySelector('[data-automation-card-link="internal-view:view_grid"]')).not.toBeNull()
  })

  it('shows empty state when no rules', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const el = container.querySelector('[data-automation-empty]')
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain('No automations yet')
  })

  it('opens the advanced rule editor from the primary new automation entry', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const advancedButton = container.querySelector('[data-automation-new-rule="advanced"]') as HTMLButtonElement
    expect(advancedButton?.textContent).toContain('+ New Automation')
    advancedButton.click()
    await flushPromises()

    expect(container.querySelector('.meta-rule-editor__title')?.textContent).toContain('New Automation Rule')
    expect(container.querySelector('[data-field="triggerType"]')).not.toBeNull()
    expect(container.querySelector('[data-field="dingtalkDestinationPickerId"]')).toBeNull()
    expect(container.querySelector('[data-automation-field="name"]')).toBeNull()
  })

  it('creates DingTalk group automation via the advanced rule editor', async () => {
    const { client, fetchFn } = mockClient([])
    const updatedSpy = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client, onUpdated: updatedSpy })
    await flushPromises()

    ;(container.querySelector('[data-automation-new-rule="advanced"]') as HTMLButtonElement).click()
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Advanced DingTalk group'
    nameInput.dispatchEvent(new Event('input'))

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

    const destinationFieldInput = container.querySelector('[data-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    destinationFieldInput.value = 'record.fld_2'
    destinationFieldInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
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

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body).toMatchObject({
      name: 'Advanced DingTalk group',
      triggerType: 'record.created',
      actionType: 'send_dingtalk_group_message',
      actionConfig: {
        destinationId: 'dt_1',
        destinationIds: ['dt_1', 'dt_2'],
        destinationIdFieldPath: 'record.fld_2',
        destinationIdFieldPaths: ['record.fld_2'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please fill {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    })
    expect(body.actions).toEqual([{
      type: 'send_dingtalk_group_message',
      config: {
        destinationId: 'dt_1',
        destinationIds: ['dt_1', 'dt_2'],
        destinationIdFieldPath: 'record.fld_2',
        destinationIdFieldPaths: ['record.fld_2'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please fill {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    }])
    expect(updatedSpy).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-automation-rule="rule_new"]')?.textContent).toContain('Advanced DingTalk group')
    expect(container.querySelector('[data-automation-rule="rule_new"] .meta-automation__card-desc')?.textContent).toContain('Send DingTalk group message')
    expect(container.querySelector('.meta-rule-editor__overlay')).toBeNull()
  })

  it('creates DingTalk person automation via the advanced rule editor', async () => {
    const { client, fetchFn } = mockClient([])
    const updatedSpy = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client, onUpdated: updatedSpy })
    await flushPromises()

    ;(container.querySelector('[data-automation-new-rule="advanced"]') as HTMLButtonElement).click()
    await flushPromises()

    const nameInput = container.querySelector('[data-field="name"]') as HTMLInputElement
    nameInput.value = 'Advanced DingTalk person'
    nameInput.dispatchEvent(new Event('input'))

    const actionSelect = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change'))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1, user_2'
    userIdsInput.dispatchEvent(new Event('input'))

    const memberGroupIdsInput = container.querySelector('[data-field="dingtalkPersonMemberGroupIds"]') as HTMLTextAreaElement
    memberGroupIdsInput.value = 'group_1'
    memberGroupIdsInput.dispatchEvent(new Event('input'))

    const recipientFieldInput = container.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.assigneeUserIds'
    recipientFieldInput.dispatchEvent(new Event('input'))

    const memberGroupFieldInput = container.querySelector('[data-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.watcherGroupIds'
    memberGroupFieldInput.dispatchEvent(new Event('input'))

    const titleInput = container.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input'))

    const bodyInput = container.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please process {{record.status}}'
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

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body).toMatchObject({
      name: 'Advanced DingTalk person',
      triggerType: 'record.created',
      actionType: 'send_dingtalk_person_message',
      actionConfig: {
        userIds: ['user_1', 'user_2'],
        memberGroupIds: ['group_1'],
        userIdFieldPath: 'record.assigneeUserIds',
        userIdFieldPaths: ['record.assigneeUserIds'],
        memberGroupIdFieldPath: 'record.watcherGroupIds',
        memberGroupIdFieldPaths: ['record.watcherGroupIds'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please process {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    })
    expect(body.actions).toEqual([{
      type: 'send_dingtalk_person_message',
      config: {
        userIds: ['user_1', 'user_2'],
        memberGroupIds: ['group_1'],
        userIdFieldPath: 'record.assigneeUserIds',
        userIdFieldPaths: ['record.assigneeUserIds'],
        memberGroupIdFieldPath: 'record.watcherGroupIds',
        memberGroupIdFieldPaths: ['record.watcherGroupIds'],
        titleTemplate: 'Ticket {{recordId}}',
        bodyTemplate: 'Please process {{record.status}}',
        publicFormViewId: 'view_form',
        internalViewId: 'view_grid',
      },
    }])
    expect(updatedSpy).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-automation-rule="rule_new"]')?.textContent).toContain('Advanced DingTalk person')
    expect(container.querySelector('[data-automation-rule="rule_new"] .meta-automation__card-desc')?.textContent).toContain('Send DingTalk person message')
    expect(container.querySelector('.meta-rule-editor__overlay')).toBeNull()
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

    const destinationSelect = container.querySelector('[data-automation-field="dingtalkDestinationPickerId"]') as HTMLSelectElement
    destinationSelect.value = 'dt_1'
    destinationSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    destinationSelect.value = 'dt_2'
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

    expect(container.querySelector('[data-automation-group-destination="dt_1"]')).not.toBeNull()
    expect(container.querySelector('[data-automation-group-destination="dt_2"]')).not.toBeNull()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionType).toBe('send_dingtalk_group_message')
    expect(body.actionConfig).toEqual({
      destinationId: 'dt_1',
      destinationIds: ['dt_1', 'dt_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
      publicFormViewId: 'view_form',
      internalViewId: 'view_grid',
    })
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/dingtalk-groups?sheetId=sheet_1'))).toBe(true)
  })

  it('filters internal processing options to the current sheet in the inline form', async () => {
    const { client } = mockClient([])
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: [
        ...views,
        { id: 'view_other_sheet', sheetId: 'sheet_2', name: 'Other Sheet Grid', type: 'grid' },
      ],
      client,
    })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const internalViewSelect = container.querySelector('[data-automation-field="internalViewId"]') as HTMLSelectElement
    const optionValues = Array.from(internalViewSelect.options).map((option) => option.value)
    expect(optionValues).toContain('view_grid')
    expect(optionValues).not.toContain('view_other_sheet')
  })

  it('filters public form options to the current sheet in the inline form', async () => {
    const { client } = mockClient([])
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: [
        ...views,
        { id: 'view_other_form', sheetId: 'sheet_2', name: 'Other Sheet Form', type: 'form' },
      ],
      client,
    })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    const optionValues = Array.from(publicFormSelect.options).map((option) => option.value)
    expect(optionValues).toContain('view_form')
    expect(optionValues).not.toContain('view_other_form')
  })

  it('disables creating a DingTalk group automation when the selected public form link cannot work', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views: viewsWithMissingPublicToken, client })
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

    const destinationSelect = container.querySelector('[data-automation-field="dingtalkDestinationPickerId"]') as HTMLSelectElement
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
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(container.textContent).toContain('Public form sharing for "Public Form" is missing a public token')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(0)
  })

  it('creates DingTalk group automation with only dynamic record destination paths', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk dynamic groups'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const destinationFieldInput = container.querySelector('[data-automation-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    destinationFieldInput.value = 'record.fld_2'
    destinationFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionConfig).toEqual({
      destinationIdFieldPath: 'record.fld_2',
      destinationIdFieldPaths: ['record.fld_2'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
    })
  })

  it('disables creating a DingTalk group automation when dynamic destination paths parse empty', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk invalid dynamic groups'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const destinationFieldInput = container.querySelector('[data-automation-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    destinationFieldInput.value = 'record., ,'
    destinationFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(0)
  })

  it('can pick a dynamic DingTalk group destination field in the inline form', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkDestinationFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'fld_2'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const fieldInput = container.querySelector('[data-automation-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    const summary = container.querySelector('[data-automation-summary="group"]')
    expect(fieldInput.value).toBe('record.fld_2')
    expect(summary?.textContent).toContain('Name (record.fld_2)')
    expect(container.querySelector('[data-automation-group-destination-field="fld_2"]')).not.toBeNull()
  })

  it('warns when a dynamic DingTalk group destination path points to a user or member group field in the inline form', async () => {
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

    const fieldInput = container.querySelector('[data-automation-field="dingtalkDestinationFieldPath"]') as HTMLInputElement
    fieldInput.value = 'record.assigneeUserIds, record.watcherGroupIds'
    fieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('record.assigneeUserIds is a user field')
    expect(container.textContent).toContain('record.watcherGroupIds is a member group field')
  })

  it('warns when a DingTalk group message includes a fully public form link in the inline form', async () => {
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

    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing for "Public Form" is fully public')
    expect(container.textContent).toContain('Use DingTalk-protected access and an allowlist')
    expect(container.querySelector('[data-automation-summary="group"]')?.textContent).toContain('Fully public; anyone with the link can submit')
  })

  it('warns when a DingTalk group message uses a protected public form without an allowlist in the inline form', async () => {
    const { client } = mockClient([])
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithProtectedPublicFormWithoutAllowlist,
      client,
    })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing for "Public Form" allows all bound DingTalk users to submit')
    expect(container.textContent).toContain('add allowed users or member groups')
  })

  it('does not warn when a DingTalk group message uses a protected public form with an allowlist in the inline form', async () => {
    const { client } = mockClient([])
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      views: viewsWithProtectedPublicFormAllowlist,
      client,
    })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_group_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-automation-field="publicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).not.toContain('allows all bound DingTalk users to submit')
    expect(container.textContent).not.toContain('is fully public')
    expect(container.querySelector('[data-automation-summary="group"]')?.textContent).toContain('DingTalk-bound users in allowlist can submit')
  })

  it('warns when a DingTalk person message selects a public form without a token in the inline form', async () => {
    const { client } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views: viewsWithMissingPublicToken, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const publicFormSelect = container.querySelector('[data-automation-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('Public form sharing for "Public Form" is missing a public token')
  })

  it('disables creating a DingTalk person automation when the selected public form link cannot work', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views: viewsWithMissingPublicToken, client })
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
    userIdsInput.value = 'user_1'
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
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(container.textContent).toContain('Public form sharing for "Public Form" is missing a public token')
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(0)
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

  it('creates DingTalk person automation with only a dynamic record recipient path', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk dynamic notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.assigneeUserIds'
    recipientFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const summary = container.querySelector('[data-automation-summary="person"]')
    expect(summary?.textContent).toContain('Record recipients:')
    expect(summary?.textContent).toContain('record.assigneeUserIds')

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionConfig).toEqual({
      userIds: [],
      userIdFieldPath: 'record.assigneeUserIds',
      userIdFieldPaths: ['record.assigneeUserIds'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
    })
  })

  it('creates DingTalk person automation with only a dynamic member group record path', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk dynamic member-group notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.watcherGroupIds'
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const summary = container.querySelector('[data-automation-summary="person"]')
    expect(summary?.textContent).toContain('Record member groups:')
    expect(summary?.textContent).toContain('record.watcherGroupIds')

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(1)
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionConfig).toEqual({
      userIds: [],
      memberGroupIdFieldPath: 'record.watcherGroupIds',
      memberGroupIdFieldPaths: ['record.watcherGroupIds'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
    })
  })

  it('disables creating a DingTalk person automation when dynamic recipient paths parse empty', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk invalid dynamic recipients'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record., ,'
    recipientFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = ','
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(0)
  })

  it('disables creating a DingTalk person automation when static recipient lists parse empty', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk invalid static recipients'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = ',\n,'
    userIdsInput.dispatchEvent(new Event('input', { bubbles: true }))

    const memberGroupIdsInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupIds"]') as HTMLTextAreaElement
    memberGroupIdsInput.value = ','
    memberGroupIdsInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Ticket {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Please fill {{record.status}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = container.querySelector('.meta-automation__btn--primary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await flushPromises()

    const postCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit | undefined]) => init?.method === 'POST')
    expect(postCalls.length).toBe(0)
  })

  it('can remove a selected dynamic member group recipient field chip in the inline form', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.watcherGroupIds, record.escalationGroupId'
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const firstChip = container.querySelector('[data-automation-member-group-recipient-field="watcherGroupIds"]') as HTMLButtonElement
    expect(firstChip?.textContent).toContain('record.watcherGroupIds')
    firstChip.click()
    await flushPromises()

    expect(memberGroupFieldInput.value).toBe('record.escalationGroupId')
    expect(container.querySelector('[data-automation-member-group-recipient-field="watcherGroupIds"]')).toBeNull()
  })

  it('warns when a dynamic member group recipient path is unknown in the inline form', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.unknownGroupField'
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('record.unknownGroupField is not a known field in this sheet')
  })

  it('warns when a dynamic member group recipient path points at a user field in the inline form', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.assigneeUserIds'
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('record.assigneeUserIds is a user field; use Record recipient field paths instead.')
  })

  it('can pick a member group recipient field for DingTalk person automation', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'watcherGroupIds'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    const summary = container.querySelector('[data-automation-summary="person"]')
    expect(memberGroupFieldInput.value).toBe('record.watcherGroupIds')
    expect(summary?.textContent).toContain('Watcher groups (record.watcherGroupIds)')
  })

  it('only lists explicit member group fields in the member group recipient picker', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldSelect"]') as HTMLSelectElement
    const optionValues = Array.from(fieldSelect.options).map((option) => option.value)
    expect(optionValues).toContain('watcherGroupIds')
    expect(optionValues).toContain('escalationGroupId')
    expect(optionValues).not.toContain('assigneeUserIds')
    expect(optionValues).not.toContain('fld_1')
  })

  it('can pick a record recipient field for DingTalk person automation', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    const summary = container.querySelector('[data-automation-summary="person"]')
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds')
    expect(summary?.textContent).toContain('Assignees (record.assigneeUserIds)')
  })

  it('only lists user fields in the DingTalk person recipient picker', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    const optionValues = Array.from(fieldSelect.options).map((option) => option.value)
    expect(optionValues).toContain('assigneeUserIds')
    expect(optionValues).toContain('reviewerUserId')
    expect(optionValues).not.toContain('fld_1')
  })

  it('can append multiple record recipient fields for DingTalk person automation', async () => {
    const { client, fetchFn } = mockClient([])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const addBtn = container.querySelector('.meta-automation__btn-add') as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const nameInput = container.querySelector('[data-automation-field="name"]') as HTMLInputElement
    nameInput.value = 'DingTalk multi dynamic notify'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const actionSelect = container.querySelector('[data-automation-field="actionType"]') as HTMLSelectElement
    actionSelect.value = 'send_dingtalk_person_message'
    actionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    fieldSelect.value = 'reviewerUserId'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds, record.reviewerUserId')

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
    const body = JSON.parse(postCalls[0][1]?.body as string)
    expect(body.actionConfig).toEqual({
      userIds: [],
      userIdFieldPath: 'record.assigneeUserIds',
      userIdFieldPaths: ['record.assigneeUserIds', 'record.reviewerUserId'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please fill {{record.status}}',
    })
  })

  it('can remove a selected dynamic recipient field chip in the inline form', async () => {
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

    const fieldSelect = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldSelect"]') as HTMLSelectElement
    fieldSelect.value = 'assigneeUserIds'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    fieldSelect.value = 'reviewerUserId'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const firstChip = container.querySelector('[data-automation-recipient-field="assigneeUserIds"]') as HTMLButtonElement
    expect(firstChip?.textContent).toContain('Assignees')
    firstChip.click()
    await flushPromises()

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.reviewerUserId')
    expect(container.querySelector('[data-automation-recipient-field="assigneeUserIds"]')).toBeNull()
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

    const suggestion = container.querySelector('[data-automation-person-suggestion="user:user_1"]') as HTMLButtonElement
    expect(suggestion).toBeTruthy()
    suggestion.click()
    await flushPromises()

    searchInput.value = 'sales'
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const groupSuggestion = container.querySelector('[data-automation-person-suggestion="member-group:group_1"]') as HTMLButtonElement
    expect(groupSuggestion).toBeTruthy()
    groupSuggestion.click()
    await flushPromises()

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    expect(userIdsInput.value).toBe('user_1')
    const memberGroupIdsInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupIds"]') as HTMLTextAreaElement
    expect(memberGroupIdsInput.value).toBe('group_1')

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
    expect(body.actionConfig.memberGroupIds).toEqual(['group_1'])
    expect(client.listFormShareCandidates).toHaveBeenCalledTimes(2)
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
    const { client, fetchFn } = mockClient([
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
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-group-deliveries'))).toBe(true)
  })

  it('shows DingTalk group delivery load errors instead of an empty history', async () => {
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
    ], { groupDeliveryErrorMessage: 'Delivery history unavailable' })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const deliveriesBtn = container.querySelector('[data-automation-group-deliveries="rule_1"]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    const error = document.querySelector('[data-group-delivery-error="true"]')
    expect(error?.textContent).toContain('Delivery history unavailable')
    expect(document.querySelector('[data-group-delivery-id="dgd_1"]')).toBeNull()
    expect(document.querySelector('.meta-group-delivery [data-empty="true"]')).toBeNull()
  })

  it('opens DingTalk group delivery viewer for V1 multi-action rules', async () => {
    const { client, fetchFn } = mockClient([
      fakeRule({
        name: 'Multi-step group notify',
        actionType: 'notify',
        actionConfig: { message: 'Internal note' },
        actions: [
          { type: 'notify', config: { message: 'Internal note' } },
          {
            type: 'send_dingtalk_group_message',
            config: {
              destinationId: 'dt_1',
              titleTemplate: 'Ticket {{recordId}}',
              bodyTemplate: 'Please fill {{record.status}}',
            },
          },
        ],
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
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-group-deliveries'))).toBe(true)
  })

  it('opens DingTalk person delivery viewer for V1 multi-action rules', async () => {
    const { client, fetchFn } = mockClient([
      fakeRule({
        name: 'Multi-step person notify',
        actionType: 'notify',
        actionConfig: { message: 'Internal note' },
        actions: [
          { type: 'notify', config: { message: 'Internal note' } },
          {
            type: 'send_dingtalk_person_message',
            config: {
              userIds: ['user_1'],
              titleTemplate: 'Ticket {{recordId}}',
              bodyTemplate: 'Please fill {{record.status}}',
            },
          },
        ],
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
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/sheets/sheet_1/automations/rule_1/dingtalk-person-deliveries'))).toBe(true)
  })

  it('shows DingTalk person delivery load errors instead of an empty history', async () => {
    const { client } = mockClient([
      fakeRule({
        name: 'Multi-step person notify',
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: ['user_1'],
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill {{record.status}}',
        },
      }),
    ], { personDeliveryErrorMessage: 'Person delivery query failed' })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const deliveriesBtn = container.querySelector('[data-automation-person-deliveries="rule_1"]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    const error = document.querySelector('[data-person-delivery-error="true"]')
    expect(error?.textContent).toContain('Person delivery query failed')
    expect(document.querySelector('[data-person-delivery-id="dpd_1"]')).toBeNull()
    expect(document.querySelector('.meta-person-delivery [data-empty="true"]')).toBeNull()
  })

  it('shows a generic running status for non-DingTalk automation test runs', async () => {
    let resolveExecution!: (value: Record<string, unknown>) => void
    const testExecutionPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveExecution = resolve
    })
    const { client } = mockClient([
      fakeRule({
        name: 'Internal notification',
        actionType: 'notify',
        actionConfig: { message: 'Internal only' },
        actions: [{ type: 'notify', config: { message: 'Internal only' } }],
      }),
    ], { testExecution: testExecutionPromise })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    ;(container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()
    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await nextTick()

    const status = container.querySelector('[data-field="testRunStatus"]')
    expect(status?.textContent).toContain('Running test.')
    expect(status?.textContent).not.toContain('DingTalk')

    resolveExecution({
      id: 'exec_1',
      ruleId: 'rule_1',
      status: 'success',
      triggerType: 'record.created',
      startedAt: '2026-04-21T00:00:00.000Z',
      durationMs: 32,
      steps: [],
    })
    await flushPromises()

    expect(container.querySelector('[data-field="testRunStatus"]')?.textContent).toContain('Test run succeeded')
  })

  it('shows a successful automation test run status and refreshes stats', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client, fetchFn } = mockClient([
      fakeRule({
        name: 'DingTalk group notify',
        actionType: 'send_dingtalk_group_message',
        actionConfig: {
          destinationId: 'dt_1',
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill {{record.status}}',
        },
        actions: [{
          type: 'send_dingtalk_group_message',
          config: { destinationId: 'dt_1', titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        }],
      }),
    ])
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    ;(container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()

    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    expect(container.textContent).toContain('can send real DingTalk messages')

    testBtn.click()
    await flushPromises()

    expect(fetchFn.mock.calls.some(([url, init]) =>
      String(url).includes('/api/multitable/sheets/sheet_1/automations/rule_1/test') && init?.method === 'POST',
    )).toBe(true)
    expect(container.querySelector('[data-field="testRunStatus"]')?.textContent).toContain('Test run succeeded (32 ms)')
    expect(container.querySelector('[data-automation-test-status="rule_1"]')?.textContent).toContain('Test run succeeded (32 ms)')
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/stats')).length).toBeGreaterThanOrEqual(2)
  })

  it('uses a generic running message for non-DingTalk automation tests', async () => {
    let resolveExecution!: (value: Record<string, unknown>) => void
    const testExecution = new Promise<Record<string, unknown>>((resolve) => {
      resolveExecution = resolve
    })
    const { client } = mockClient([
      fakeRule({
        actionType: 'update_record',
        actionConfig: { fieldId: 'fld_1', value: 'Done' },
        actions: [{ type: 'update_record', config: { fieldId: 'fld_1', value: 'Done' } }],
      }),
    ], { testExecution })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    ;(container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()
    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await nextTick()

    const runningStatus = container.querySelector('[data-field="testRunStatus"]')
    expect(runningStatus?.textContent).toContain('Running test.')
    expect(runningStatus?.textContent).not.toContain('DingTalk actions may send real messages')

    resolveExecution({
      id: 'exec_1',
      ruleId: 'rule_1',
      status: 'success',
      triggerType: 'record.created',
      startedAt: '2026-04-21T00:00:00.000Z',
      duration: 10,
      steps: [],
    })
    await flushPromises()
  })

  it('shows failed automation test run step errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client } = mockClient([
      fakeRule({
        name: 'DingTalk group notify',
        actionType: 'send_dingtalk_group_message',
        actionConfig: { destinationId: 'dt_1', titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        actions: [{ type: 'send_dingtalk_group_message', config: { destinationId: 'dt_1' } }],
      }),
    ], {
      testExecution: {
        id: 'exec_failed',
        ruleId: 'rule_1',
        status: 'failed',
        triggerType: 'record.created',
        startedAt: '2026-04-21T00:00:00.000Z',
        steps: [{
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: 'DingTalk robot keyword blocked',
        }],
      },
    })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    ;(container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()
    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await flushPromises()

    const status = container.querySelector('[data-field="testRunStatus"]')
    expect(status?.textContent).toContain('DingTalk robot keyword blocked')
    expect(status?.getAttribute('data-status')).toBe('failed')
  })

  it('shows automation test run API errors instead of failing silently', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client } = mockClient([
      fakeRule({
        name: 'DingTalk person notify',
        actionType: 'send_dingtalk_person_message',
        actionConfig: { userIds: ['user_1'], titleTemplate: 'Ticket {{recordId}}', bodyTemplate: 'Please fill' },
        actions: [{ type: 'send_dingtalk_person_message', config: { userIds: ['user_1'] } }],
      }),
    ], { testErrorMessage: 'Automation service unavailable' })
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    ;(container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()
    ;(container.querySelector('[data-action="test"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(container.querySelector('[data-field="testRunStatus"]')?.textContent).toContain('Automation service unavailable')
    expect(container.querySelector('[data-field="testRunStatus"]')?.getAttribute('data-status')).toBe('failed')
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

  it('shows DingTalk person message summary in the inline create form', async () => {
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

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.assigneeUserIds'
    recipientFieldInput.dispatchEvent(new Event('input', { bubbles: true }))

    const userIdsInput = container.querySelector('[data-automation-field="dingtalkPersonUserIds"]') as HTMLTextAreaElement
    userIdsInput.value = 'user_1'
    userIdsInput.dispatchEvent(new Event('input', { bubbles: true }))

    const titleInput = container.querySelector('[data-automation-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement
    titleInput.value = 'Need action {{recordId}}'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Handle {{record.xxx}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))

    const publicFormSelect = container.querySelector('[data-automation-field="dingtalkPersonPublicFormViewId"]') as HTMLSelectElement
    publicFormSelect.value = 'view_form'
    publicFormSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const summary = container.querySelector('[data-automation-summary="person"]')
    expect(summary?.textContent).toContain('user_1')
    expect(summary?.textContent).toContain('Need action {{recordId}}')
    expect(summary?.textContent).toContain('Handle {{record.xxx}}')
    expect(summary?.textContent).toContain('Need action record_demo_001')
    expect(summary?.textContent).toContain('Handle 示例字段值')
    expect(summary?.textContent).toContain('Assignees (record.assigneeUserIds)')
    expect(summary?.textContent).toContain('Public Form')
    expect(summary?.textContent).toContain('Fully public; anyone with the link can submit')
    expect(summary?.textContent).toContain('No internal link')
  })

  it('loads dynamic record recipient path into the edit form', async () => {
    const rules = [
      fakeRule({
        id: 'rule_dynamic',
        actionType: 'send_dingtalk_person_message',
        actionConfig: {
          userIds: [],
          userIdFieldPath: 'record.assigneeUserIds',
          userIdFieldPaths: ['record.assigneeUserIds'],
          titleTemplate: 'Ticket {{recordId}}',
          bodyTemplate: 'Please fill {{record.status}}',
        },
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: [],
            userIdFieldPath: 'record.assigneeUserIds',
            userIdFieldPaths: ['record.assigneeUserIds'],
            titleTemplate: 'Ticket {{recordId}}',
            bodyTemplate: 'Please fill {{record.status}}',
          },
        }],
      }),
    ]
    const { client } = mockClient(rules)
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const editBtn = container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()
    await flushPromises()

    const recipientFieldInput = document.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds')
    expect(document.body.textContent).toContain('Record recipients:')
    expect(document.body.textContent).toContain('Assignees (record.assigneeUserIds)')
  })

  it('opens the rule editor with DingTalk group config from V1 actions when legacy action fields are stale', async () => {
    const rules = [
      fakeRule({
        id: 'rule_stale_group',
        name: 'Stale group action',
        actionType: 'notify',
        actionConfig: { message: 'stale legacy notification' },
        actions: [{
          type: 'send_dingtalk_group_message',
          config: {
            destinationId: 'dt_1',
            destinationIds: ['dt_1', 'dt_2'],
            titleTemplate: 'Ticket {{recordId}}',
            bodyTemplate: 'Please review {{record.status}}',
            publicFormViewId: 'view_form',
            internalViewId: 'view_grid',
          },
        }],
      }),
    ]
    const { client } = mockClient(rules)
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const editBtn = container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()
    await flushPromises()

    const actionSelect = document.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    expect(actionSelect.value).toBe('send_dingtalk_group_message')
    expect(document.querySelector('[data-group-destination="dt_1"]')?.textContent).toContain('Ops Group')
    expect(document.querySelector('[data-group-destination="dt_2"]')?.textContent).toContain('Escalation Group')
    expect((document.querySelector('[data-field="dingtalkTitleTemplate"]') as HTMLInputElement).value).toBe('Ticket {{recordId}}')
    expect((document.querySelector('[data-field="dingtalkBodyTemplate"]') as HTMLTextAreaElement).value).toBe('Please review {{record.status}}')
  })

  it('opens the rule editor with DingTalk person dynamic recipients from V1 actions when legacy action fields are stale', async () => {
    const rules = [
      fakeRule({
        id: 'rule_stale_person',
        name: 'Stale person action',
        actionType: 'notify',
        actionConfig: { message: 'stale legacy notification' },
        actions: [{
          type: 'send_dingtalk_person_message',
          config: {
            userIds: [],
            userIdFieldPath: 'record.assigneeUserIds',
            userIdFieldPaths: ['record.assigneeUserIds'],
            titleTemplate: 'Ticket {{recordId}}',
            bodyTemplate: 'Please fill {{record.status}}',
          },
        }],
      }),
    ]
    const { client } = mockClient(rules)
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const editBtn = container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()
    await flushPromises()

    const actionSelect = document.querySelector('[data-action-index="0"] .meta-rule-editor__action-header select') as HTMLSelectElement
    const recipientFieldInput = document.querySelector('[data-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    expect(actionSelect.value).toBe('send_dingtalk_person_message')
    expect(recipientFieldInput.value).toBe('record.assigneeUserIds')
    expect((document.querySelector('[data-field="dingtalkPersonTitleTemplate"]') as HTMLInputElement).value).toBe('Ticket {{recordId}}')
    expect((document.querySelector('[data-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement).value).toBe('Please fill {{record.status}}')
    expect(document.body.textContent).toContain('Record recipients:')
    expect(document.body.textContent).toContain('Assignees (record.assigneeUserIds)')
  })

  it('shows a blocking warning when editing a rule with a missing internal processing view', async () => {
    const config = {
      destinationIds: ['dt_1'],
      titleTemplate: 'Ticket {{recordId}}',
      bodyTemplate: 'Please review {{record.status}}',
      internalViewId: 'missing_view',
    }
    const rules = [
      fakeRule({
        id: 'rule_missing_internal',
        actionType: 'send_dingtalk_group_message',
        actionConfig: config,
        actions: [{ type: 'send_dingtalk_group_message', config }],
      }),
    ]
    const { client } = mockClient(rules)
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, views, client })
    await flushPromises()

    const editBtn = container.querySelector('[data-automation-edit="true"]') as HTMLButtonElement
    editBtn.click()
    await flushPromises()

    const saveBtn = document.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(document.body.textContent).toContain('Internal processing view "missing_view" is not available in this sheet')
    expect(saveBtn.disabled).toBe(true)
  })

  it('shows DingTalk template syntax warnings in the inline create form', async () => {
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

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = '{{recordId'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('Unclosed placeholder braces detected')
  })

  it('shows DingTalk unknown placeholder warnings in the inline create form', async () => {
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

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = '{{record}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('Unknown placeholder {{record}}')
  })

  it('warns when a DingTalk person recipient path is not a user field in the inline create form', async () => {
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

    const recipientFieldInput = container.querySelector('[data-automation-field="dingtalkPersonRecipientFieldPath"]') as HTMLInputElement
    recipientFieldInput.value = 'record.fld_1'
    recipientFieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('record.fld_1 is not a user field')
  })

  it('warns when a DingTalk person member-group recipient path is not a member group field in the inline create form', async () => {
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

    const memberGroupFieldInput = container.querySelector('[data-automation-field="dingtalkPersonMemberGroupRecipientFieldPath"]') as HTMLInputElement
    memberGroupFieldInput.value = 'record.fld_1'
    memberGroupFieldInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(container.textContent).toContain('record.fld_1 is not a member group field')
  })

  it('copies rendered DingTalk person body example in the inline create form', async () => {
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

    const bodyInput = container.querySelector('[data-automation-field="dingtalkPersonBodyTemplate"]') as HTMLTextAreaElement
    bodyInput.value = 'Handle {{record.xxx}}'
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    ;(container.querySelector('[data-automation-copy="person-rendered-body"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(navigator.clipboard?.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard!.writeText).mock.calls[0]?.[0]).toBe('Handle 示例字段值')
    expect(container.textContent).toContain('Copied')
  })
})
