import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ElementPlus, { ElMessageBox } from 'element-plus'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import type { AutomationRule } from '../src/multitable/types'
import { epOptions, epSelectValue, epSetSelect } from './helpers/epControls'
import { useLocale } from '../src/composables/useLocale'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let fwbFlag = false
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'approvalFwbWriteback' ? fwbFlag : false,
  }),
}))

const getTemplateMock = vi.fn()
vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    getTemplate: (id: string) => getTemplateMock(id),
  }
})

const fields = [
  { id: 'fld_name', name: 'Name', type: 'string' },
  { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'open' }, { value: 'done' }] },
  { id: 'fld_amount', name: 'Amount', type: 'number' },
  { id: 'fld_date', name: 'Due', type: 'date' },
]

function fakeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    sheetId: 'sheet_1',
    name: 'FWB Rule',
    triggerType: 'approval.completed',
    triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
    actionType: 'send_notification',
    actionConfig: {},
    enabled: true,
    actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ok' } }],
    ...overrides,
  }
}

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    listDingTalkGroups: vi.fn(async () => []),
    listApprovalTemplates: vi.fn(async () => ({
      data: [{ id: 'tpl_1', name: 'Leave' }],
      total: 1,
    })),
    listSheets: vi.fn(async () => ({ sheets: [] })),
    listFields: vi.fn(async () => ({ fields })),
    listFormShareCandidates: vi.fn(async () => ({ items: [], total: 0, limit: 8, query: '' })),
    confirmFwbWriteback: vi.fn(async () => ({
      confirmationHash: 'server-hash-abc',
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetSheetId: 'sheet_1',
      targetBaseId: 'base_1',
    })),
    ...overrides,
  }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const reactiveProps = reactive(props)
  // Register Element Plus globally so ApprovalFwbMappingEditor's el-* tags resolve
  // (production does app.use(ElementPlus) in main.ts; createApp hosts need the same).
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, reactiveProps) })
  app.use(ElementPlus)
  app.mount(container)
  return { container, app, props: reactiveProps }
}

function actionTypeSelect(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
}

function actionTypeOptions(container: HTMLElement): string[] {
  const select = actionTypeSelect(container)
  if (!select) return []
  return epOptions(select).map((opt) => opt.value)
}

describe('MetaAutomationRuleEditor — FWB production authoring', () => {
  beforeEach(() => {
    fwbFlag = false
    getTemplateMock.mockReset()
    getTemplateMock.mockResolvedValue({
      id: 'tpl_1',
      name: 'Leave',
      activeVersionId: 'ver_1',
      formSchema: {
        fields: [
          { id: 'form_reason', type: 'text', label: 'Reason', required: true },
          { id: 'form_type', type: 'select', label: 'Type', required: true, options: [{ label: 'A', value: 'a' }] },
        ],
      },
    })
    useLocale().setLocale('en')
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('flag off hides new FWB selection', async () => {
    fwbFlag = false
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({ triggerType: 'approval.completed', triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] } }),
    })
    await flushPromises()
    expect(actionTypeOptions(container)).not.toContain('write_approval_form_values')
  })

  it('flag on + approval.completed offers FWB selection', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({ triggerType: 'approval.completed', triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] } }),
    })
    await flushPromises()
    expect(actionTypeOptions(container)).toContain('write_approval_form_values')
  })

  it('authors update mode against the template-pinned record-link target', async () => {
    fwbFlag = true
    getTemplateMock.mockResolvedValue({
      id: 'tpl_1',
      name: 'Leave',
      activeVersionId: 'ver_1',
      formSchema: {
        fields: [
          { id: 'form_reason', type: 'text', label: 'Reason', required: true },
          {
            id: 'linked_order',
            type: 'record-link',
            label: 'Order',
            required: true,
            props: { baseId: 'base_target', sheetId: 'sheet_target' },
          },
        ],
      },
    })
    const client = mockClient({
      listFields: vi.fn(async (sheetId: string) => ({
        fields: sheetId === 'sheet_target'
          ? [{ id: 'target_name', name: 'Name', type: 'string' }]
          : fields,
      })),
      confirmFwbWriteback: vi.fn(async () => ({
        confirmationHash: 'server-update-hash',
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        targetSheetId: 'sheet_target',
        targetBaseId: 'base_target',
      })),
    })
    const onSave = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      onSave,
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mode: 'update',
          recordLinkFieldId: 'linked_order',
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mode: 'update',
            recordLinkFieldId: 'linked_order',
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()

    expect(epSelectValue(container.querySelector('[data-testid="fwb-write-mode"]') as HTMLElement)).toBe('update')
    expect(epSelectValue(container.querySelector('[data-testid="fwb-record-link-field"]') as HTMLElement)).toBe('linked_order')
    expect(client.listFields).toHaveBeenCalledWith('sheet_target')

    ;(container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(client.confirmFwbWriteback).toHaveBeenCalledWith('sheet_1', {
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      mode: 'update',
      recordLinkFieldId: 'linked_order',
      mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_name', targetType: 'text' }],
    })
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]?.[0] as {
      actions: Array<{ type: string; config: Record<string, unknown> }>
    }
    expect(payload.actions[0]?.config).toMatchObject({
      mode: 'update',
      recordLinkFieldId: 'linked_order',
      confirmationHash: 'server-update-hash',
    })
  })

  it('marks a removed record-link field unavailable without exposing its raw id as the label', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mode: 'update',
          recordLinkFieldId: 'removed_link_internal_id',
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'old-hash',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mode: 'update',
            recordLinkFieldId: 'removed_link_internal_id',
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'old-hash',
          },
        }],
      }),
    })
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()

    const options = epOptions(container.querySelector('[data-testid="fwb-record-link-field"]') as HTMLElement)
    expect(options).toContainEqual(expect.objectContaining({
      value: 'removed_link_internal_id',
      textContent: 'Unavailable record-link field',
      disabled: true,
    }))
    const hint = container.querySelector('[data-testid="fwb-target-sheet-hint"]')?.textContent ?? ''
    expect(hint).toMatch(/previous record-link field is unavailable/i)
    expect(hint).not.toContain('removed_link_internal_id')
  })

  it('surfaces a transient linked-sheet load failure and retries without reopening the drawer', async () => {
    fwbFlag = true
    getTemplateMock.mockResolvedValue({
      id: 'tpl_1',
      name: 'Leave',
      activeVersionId: 'ver_1',
      formSchema: {
        fields: [
          { id: 'form_reason', type: 'text', label: 'Reason', required: true },
          {
            id: 'linked_order',
            type: 'record-link',
            label: 'Order',
            required: true,
            props: { baseId: 'base_target', sheetId: 'sheet_target' },
          },
        ],
      },
    })
    const listFields = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ fields: [{ id: 'target_name', name: 'Name', type: 'string' }] })
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient({ listFields }),
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mode: 'update',
          recordLinkFieldId: 'linked_order',
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mode: 'update',
            recordLinkFieldId: 'linked_order',
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()

    expect(listFields).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="fwb-linked-target-error"]')?.textContent)
      .toMatch(/could not be loaded/i)
    ;(container.querySelector('[data-testid="fwb-linked-target-retry"]') as HTMLButtonElement).click()
    await flushPromises()
    await flushPromises()
    expect(listFields).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="fwb-linked-target-error"]')).toBeNull()
    expect(epOptions(container.querySelector('[data-testid="fwb-target-field-select"]') as HTMLElement))
      .toContainEqual(expect.objectContaining({ value: 'target_name', textContent: 'Name' }))
  })

  it('ignores a linked-sheet response from a previous drawer generation', async () => {
    fwbFlag = true
    getTemplateMock.mockResolvedValue({
      id: 'tpl_1',
      name: 'Leave',
      activeVersionId: 'ver_1',
      formSchema: {
        fields: [
          { id: 'form_reason', type: 'text', label: 'Reason', required: true },
          {
            id: 'linked_order',
            type: 'record-link',
            label: 'Order',
            required: true,
            props: { baseId: 'base_target', sheetId: 'sheet_target' },
          },
        ],
      },
    })
    const first = deferred<{ fields: Array<{ id: string; name: string; type: string }> }>()
    const listFields = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ fields: [{ id: 'target_new', name: 'New field', type: 'string' }] })
    const mounted = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient({ listFields }),
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mode: 'update',
          recordLinkFieldId: 'linked_order',
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_new', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mode: 'update',
            recordLinkFieldId: 'linked_order',
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'target_new', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    expect(listFields).toHaveBeenCalledTimes(1)

    mounted.props.visible = false
    await flushPromises()
    mounted.props.visible = true
    await flushPromises()
    await flushPromises()
    expect(listFields).toHaveBeenCalledTimes(2)

    first.resolve({ fields: [{ id: 'target_old', name: 'Old field', type: 'string' }] })
    await flushPromises()
    ;(mounted.container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()
    const options = epOptions(mounted.container.querySelector('[data-testid="fwb-target-field-select"]') as HTMLElement)
    expect(options).toContainEqual(expect.objectContaining({ value: 'target_new', textContent: 'New field' }))
    expect(options.some((option) => option.value === 'target_old')).toBe(false)
  })

  it('does not clear authored mappings when a destructive write-mode switch is cancelled', async () => {
    fwbFlag = true
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce(new Error('cancelled'))
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'old-hash',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'old-hash',
          },
        }],
      }),
    })
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()

    const modeSelect = container.querySelector('[data-testid="fwb-write-mode"]') as HTMLElement
    await epSetSelect(modeSelect, 'update')
    await flushPromises()
    expect(epSelectValue(modeSelect)).toBe('create')
    expect(container.querySelectorAll('[data-testid="fwb-mapping-row"]')).toHaveLength(1)
  })

  it('does not offer a new FWB action when completion outcomes include rejected', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1', outcomes: ['approved', 'rejected'] },
      }),
    })
    await flushPromises()
    expect(actionTypeOptions(container)).not.toContain('write_approval_form_values')
  })

  it('flag on + wrong trigger does not offer new FWB selection', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({ triggerType: 'record.created', triggerConfig: {} }),
    })
    await flushPromises()
    expect(actionTypeOptions(container)).not.toContain('write_approval_form_values')
  })

  it('persisted FWB action remains visible and read-only while flag is off', async () => {
    fwbFlag = false
    const { container, app } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'persisted-hash',
          mode: 'create',
          extension: { nested: ['keep-me'] },
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'persisted-hash',
            mode: 'create',
            extension: { nested: ['keep-me'] },
          },
        }],
      }),
    })
    await flushPromises()

    expect(actionTypeOptions(container)).toContain('write_approval_form_values')
    expect(container.querySelector('[data-testid="fwb-readonly-status"]')?.textContent).toMatch(/disabled|未启用|read-only|只读/i)
    expect(container.querySelector('[data-testid="approval-fwb-mapping-editor"]')).toBeTruthy()
    // Controls stay disabled (not silently dropped).
    const addBtn = container.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement | null
    expect(addBtn?.disabled || addBtn?.getAttribute('disabled') != null).toBeTruthy()

    const onSave = vi.fn()
    app.unmount()
    document.body.innerHTML = ''
    const remount = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        name: 'Keep FWB',
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'persisted-hash',
          mode: 'create',
          extension: { nested: ['keep-me'] },
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'persisted-hash',
            mode: 'create',
            extension: { nested: ['keep-me'] },
          },
        }],
      }),
      onSave,
    })
    await flushPromises()
    // Save should remain available for a lossless re-emit (no silent delete).
    const saveBtn = remount.container.querySelector('[data-action="save"]') as HTMLButtonElement
    // Name is filled; read-only FWB should not require re-confirm.
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()
    expect(onSave).toHaveBeenCalled()
    const payload = onSave.mock.calls[0][0] as {
      actions: Array<{ type: string; config: Record<string, unknown> }>
    }
    expect(payload.actions[0]?.type).toBe('write_approval_form_values')
    expect(payload.actions[0]?.config.confirmationHash).toBe('persisted-hash')
    expect(payload.actions[0]?.config.mappings).toEqual([
      { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
    ])
    expect(payload.actions[0]?.config.mode).toBe('create')
    expect(payload.actions[0]?.config.extension).toEqual({ nested: ['keep-me'] })
    remount.app.unmount()
  })

  it('wrong trigger with persisted FWB blocks save', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'persisted-hash',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'persisted-hash',
          },
        }],
      }),
    })
    await flushPromises()
    expect(container.querySelector('[data-testid="fwb-readonly-status"]')?.textContent).toMatch(
      /approval\.completed|审批完成/,
    )
    const reasons = container.querySelector('[data-field="saveBlockReasons"]')?.textContent ?? ''
    expect(reasons).toMatch(/approval\.completed|审批完成/)
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('server confirmation round trip stores the server hash (never client-owned)', async () => {
    fwbFlag = true
    const client = mockClient()
    const onSave = vi.fn()
    // Seed a valid unconfirmed mapping so we exercise the confirm API without driving EP selects.
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      onSave,
      rule: fakeRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()

    // Expand the action card so the mapping editor controls are interactable.
    const summary = container.querySelector('[data-field="actionSummary"]') as HTMLElement | null
    summary?.click()
    await flushPromises()

    expect(container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state')).toBe('unconfirmed')
    const confirmBtn = container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement
    expect(confirmBtn.hasAttribute('disabled')).toBe(false)
    confirmBtn.click()
    await flushPromises()

    expect(client.confirmFwbWriteback).toHaveBeenCalledTimes(1)
    const [, body] = client.confirmFwbWriteback.mock.calls[0]
    expect(body).toMatchObject({
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      mappings: [
        { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
      ],
    })
    expect(container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state')).toBe('confirmed')

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()
    expect(onSave).toHaveBeenCalled()
    const payload = onSave.mock.calls[0][0] as {
      actions: Array<{ type: string; config: Record<string, unknown> }>
    }
    expect(payload.actions[0]?.config.confirmationHash).toBe('server-hash-abc')
    // No client-side hash algorithm artifact — only the server response value.
    expect(String(payload.actions[0]?.config.confirmationHash)).not.toMatch(/^client-/)
  })

  it('ignores a late confirmation response after the action changes type', async () => {
    fwbFlag = true
    const pending = deferred<{
      confirmationHash: string
      templateId: string
      sourceTemplateVersionId: string
      targetSheetId: string
      targetBaseId: string
    }>()
    const client = mockClient({ confirmFwbWriteback: vi.fn(() => pending.promise) })
    const onSave = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      onSave,
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()
    ;(container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(client.confirmFwbWriteback).toHaveBeenCalledTimes(1)

    epSetSelect(actionTypeSelect(container), 'send_webhook')
    await flushPromises()
    pending.resolve({
      confirmationHash: 'late-server-hash',
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetSheetId: 'sheet_1',
      targetBaseId: 'base_1',
    })
    await flushPromises()
    await flushPromises()

    expect(epSelectValue(actionTypeSelect(container))).toBe('send_webhook')
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()
    const payload = onSave.mock.calls[0][0] as {
      actions: Array<{ type: string; config: Record<string, unknown> }>
    }
    expect(payload.actions[0]?.type).toBe('send_webhook')
    expect(payload.actions[0]?.config.confirmationHash).toBeUndefined()
    expect(payload.actions[0]?.config.mappings).toBeUndefined()
    expect(JSON.stringify(payload.actions[0])).not.toContain('late-server-hash')
  })

  it('ignores a late confirmation response after the target schema changes', async () => {
    fwbFlag = true
    const pending = deferred<{
      confirmationHash: string
      templateId: string
      sourceTemplateVersionId: string
      targetSheetId: string
      targetBaseId: string
    }>()
    const client = mockClient({ confirmFwbWriteback: vi.fn(() => pending.promise) })
    const mounted = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    ;(mounted.container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()
    ;(mounted.container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(client.confirmFwbWriteback).toHaveBeenCalledTimes(1)

    mounted.props.fields = [...fields, { id: 'fld_new', name: 'New', type: 'string' }]
    await flushPromises()
    pending.resolve({
      confirmationHash: 'late-schema-hash',
      templateId: 'tpl_1',
      sourceTemplateVersionId: 'ver_1',
      targetSheetId: 'sheet_1',
      targetBaseId: 'base_1',
    })
    await flushPromises()
    await flushPromises()

    expect(mounted.container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state'))
      .toBe('unconfirmed')
  })

  it('does not request a server hash when the author cancels the explicit disclosure confirmation', async () => {
    fwbFlag = true
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce(new Error('cancelled'))
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      rule: fakeRule({
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    ;(container.querySelector('[data-field="actionSummary"]') as HTMLElement | null)?.click()
    await flushPromises()
    ;(container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(client.confirmFwbWriteback).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state'))
      .toBe('unconfirmed')
  })

  it('mapping mutation invalidates a stale confirmation', async () => {
    fwbFlag = true
    const client = mockClient()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client,
      rule: fakeRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'old-hash',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'old-hash',
          },
        }],
      }),
    })
    await flushPromises()
    const summary = container.querySelector('[data-field="actionSummary"]') as HTMLElement | null
    summary?.click()
    await flushPromises()
    expect(container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state')).toBe('confirmed')

    // Any mapping mutation (add row) must tear down the confirmed state immediately.
    const addBtn = container.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement
    addBtn.click()
    await flushPromises()
    expect(container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state')).toBe('unconfirmed')

    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    expect(container.querySelector('[data-field="saveBlockReasons"]')?.textContent).toMatch(/confirmation|确认/i)
  })

  it('target schema changes invalidate a stale confirmation before save', async () => {
    fwbFlag = true
    const mounted = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: 'old-hash',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [{ formFieldId: 'form_reason', targetFieldId: 'fld_name', targetType: 'text' }],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: 'old-hash',
          },
        }],
      }),
    })
    await flushPromises()
    const summary = mounted.container.querySelector('[data-field="actionSummary"]') as HTMLElement | null
    summary?.click()
    await flushPromises()
    expect(mounted.container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state'))
      .toBe('confirmed')

    mounted.props.fields = fields.map((field) => field.id === 'fld_name'
      ? { ...field, type: 'date' }
      : field)
    await flushPromises()

    expect(mounted.container.querySelector('[data-testid="fwb-confirmation-state"]')?.getAttribute('data-state'))
      .toBe('unconfirmed')
    expect((mounted.container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exact-number mapping remains blocked in the mounted editor', async () => {
    fwbFlag = true
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      rule: fakeRule({
        triggerType: 'approval.completed',
        triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: {
          mappings: [
            { formFieldId: 'form_reason', targetFieldId: 'fld_amount', targetType: 'number' },
          ],
          sourceTemplateVersionId: 'ver_1',
          confirmationHash: '',
        },
        actions: [{
          type: 'write_approval_form_values',
          config: {
            mappings: [
              { formFieldId: 'form_reason', targetFieldId: 'fld_amount', targetType: 'number' },
            ],
            sourceTemplateVersionId: 'ver_1',
            confirmationHash: '',
          },
        }],
      }),
    })
    await flushPromises()
    const summary = container.querySelector('[data-field="actionSummary"]') as HTMLElement | null
    summary?.click()
    await flushPromises()
    const issues = container.querySelector('[data-testid="fwb-row-issues"]')?.textContent ?? ''
    expect(issues).toMatch(/number|数值|exact/i)
    const confirmBtn = container.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLElement
    expect(
      confirmBtn.hasAttribute('disabled')
      || confirmBtn.getAttribute('aria-disabled') === 'true'
      || confirmBtn.classList.contains('is-disabled'),
    ).toBe(true)
  })

  it('legacy non-FWB actions remain unchanged when the flag is on', async () => {
    fwbFlag = true
    const onSave = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      client: mockClient(),
      onSave,
      rule: fakeRule({
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'update_record',
        actionConfig: { fields: { fld_name: 'x' } },
        actions: [{
          type: 'update_record',
          config: { fields: { fld_name: 'x' } },
        }],
      }),
    })
    await flushPromises()
    expect(actionTypeOptions(container)).toContain('update_record')
    expect(actionTypeOptions(container)).toContain('create_record')
    expect(actionTypeOptions(container)).not.toContain('write_approval_form_values')
    expect(epSelectValue(actionTypeSelect(container))).toBe('update_record')
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()
    expect(onSave).toHaveBeenCalled()
    const payload = onSave.mock.calls[0][0] as {
      actions: Array<{ type: string; config: Record<string, unknown> }>
    }
    expect(payload.actions[0]?.type).toBe('update_record')
    expect(payload.actions[0]?.config).toEqual({ fields: { fld_name: 'x' } })
  })
})
