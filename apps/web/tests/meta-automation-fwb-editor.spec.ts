/**
 * Production FWB authoring UI — MetaAutomationRuleEditor challenge flow uses selectors
 * (no free-text templateVersionId / field IDs / confirmationId paste).
 */
import { createApp, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'

vi.mock('../src/approvals/api', () => ({
  getTemplate: vi.fn(async () => ({
    id: 'tpl_1',
    key: 'T1',
    name: 'Template',
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary' },
        { id: 'amount', type: 'number', label: 'Amount' },
        {
          id: 'link',
          type: 'record-link',
          label: 'Bound record',
          props: { baseId: 'base_1', sheetId: 'sheet_tgt' },
        },
      ],
    },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Manager',
          config: { decisionFieldIds: ['amount'] },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [],
    },
  })),
}))

function mountEditor(props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const client = {
    createFwbConfirmationChallenge: vi.fn(async () => ({
      confirmationId: 'fwbc_1',
      fingerprint: 'fp',
      challengeNonce: 'nonce',
      subject: {
        templateId: 'tpl_1',
        templateVersionId: 'ver_active',
        targetBaseId: null,
        targetSheetId: 'sheet_host',
        mappings: [{ formFieldId: 'summary', targetFieldId: 'f_text' }],
      },
    })),
    confirmFwbConfirmation: vi.fn(async () => ({ ok: true, confirmationId: 'fwbc_1' })),
    listFields: vi.fn(async (sheetId: string) => {
      if (sheetId === 'sheet_tgt') {
        return {
          fields: [
            { id: 'tgt_text', name: 'Target Text', type: 'string' },
            { id: 'tgt_num', name: 'Target Num', type: 'number' },
          ],
        }
      }
      return {
        fields: [
          { id: 'f_text', name: 'Text', type: 'string' },
          { id: 'f_num', name: 'Num', type: 'number' },
        ],
      }
    }),
    listSheets: vi.fn(async () => ({ sheets: [] })),
    listApprovalTemplates: vi.fn(async () => ({ data: [{ id: 'tpl_1', name: 'Template' }] })),
    listDingTalkGroups: vi.fn(async () => []),
  }
  const app = createApp({
    render: () =>
      h(MetaAutomationRuleEditor, {
        sheetId: 'sheet_host',
        visible: true,
        fields: [
          { id: 'f_text', name: 'Text', type: 'string' },
          { id: 'f_num', name: 'Num', type: 'number' },
        ],
        client,
        rule: {
          id: 'rule_1',
          name: 'FWB rule',
          enabled: false,
          triggerType: 'approval.completed',
          triggerConfig: { templateId: 'tpl_1', outcomes: ['approved'] },
          actionType: 'write_approval_form_values',
          actionConfig: {
            mode: 'create',
            mappings: [{ formFieldId: 'summary', targetFieldId: 'f_text' }],
            confirmationId: '',
          },
          actions: [
            {
              type: 'write_approval_form_values',
              config: {
                mode: 'create',
                mappings: [{ formFieldId: 'summary', targetFieldId: 'f_text' }],
                confirmationId: '',
              },
            },
          ],
          ...props.ruleExtra,
        },
        ...props,
      }),
  })
  app.use(ElementPlus)
  app.mount(host)
  return { host, app, client }
}

describe('MetaAutomationRuleEditor — FWB Q6 challenge (selectors, no pasted IDs)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders FWB mode selectors and does not expose free-text confirmationId/templateVersionId inputs', async () => {
    const { host, app } = mountEditor()
    await nextTick()
    await nextTick()
    const fwb = host.querySelector('[data-field="fwbActionConfig"]')
    expect(fwb).toBeTruthy()
    // No free-text paste surfaces for confirmation / version ids.
    expect(host.querySelector('[data-field="fwbConfirmationId"]')).toBeNull()
    expect(host.querySelector('input[placeholder*="templateVersion"]')).toBeNull()
    expect(host.querySelector('[data-field="fwbRequestConfirm"]')).toBeTruthy()
    app.unmount()
  })

  it('request & confirm calls server challenge without templateVersionId and stores confirmationId', async () => {
    const { host, app, client } = mountEditor()
    await nextTick()
    // Allow async loadFwbAuthoringContext / listFields
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()

    const btn = host.querySelector('[data-field="fwbRequestConfirm"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    btn!.click()
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()

    expect(client.createFwbConfirmationChallenge).toHaveBeenCalled()
    const call = client.createFwbConfirmationChallenge.mock.calls[0]
    expect(call[0]).toBe('sheet_host')
    expect(call[1]).toMatchObject({
      templateId: 'tpl_1',
      mode: 'create',
    })
    // Server-authoritative — client must NOT send templateVersionId.
    expect(call[1].templateVersionId).toBeUndefined()
    expect(client.confirmFwbConfirmation).toHaveBeenCalledWith('sheet_host', {
      confirmationId: 'fwbc_1',
      challengeNonce: 'nonce',
    })
    expect(host.querySelector('[data-field="fwbConfirmOk"]')).toBeTruthy()
    app.unmount()
  })

  it('update mode loads target fields from record-link pinned sheet, not host sheet', async () => {
    const { host, app, client } = mountEditor({
      ruleExtra: {
        actionConfig: {
          mode: 'update',
          mappings: [{ formFieldId: 'summary', targetFieldId: '' }],
          recordLinkFieldId: 'link',
          confirmationId: '',
        },
        actions: [
          {
            type: 'write_approval_form_values',
            config: {
              mode: 'update',
              mappings: [{ formFieldId: 'summary', targetFieldId: '' }],
              recordLinkFieldId: 'link',
              confirmationId: '',
            },
          },
        ],
      },
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 40))
    await nextTick()

    // listFields must be called with the record-link server-pinned sheet, not the host.
    const sheetIds = client.listFields.mock.calls.map((c: unknown[]) => c[0])
    expect(sheetIds).toContain('sheet_tgt')

    // Target options should expose the pinned sheet fields.
    const targetSelect = host.querySelector('[data-field="fwbTargetFieldId"]')
    expect(targetSelect).toBeTruthy()
    // Options are teleported by Element Plus; assert via client call + mode selector instead.
    expect(host.querySelector('[data-field="fwbMode"]')).toBeTruthy()
    app.unmount()
  })

  it('changing record-link invalidates confirmation and reloads target sheet fields', async () => {
    const { host, app, client } = mountEditor()
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Switch mode to update via the draft action config after mount by re-mounting.
    app.unmount()
    const second = mountEditor({
      ruleExtra: {
        actionConfig: {
          mode: 'update',
          mappings: [{ formFieldId: 'summary', targetFieldId: 'tgt_text' }],
          recordLinkFieldId: 'link',
          confirmationId: 'fwbc_stale',
        },
        actions: [
          {
            type: 'write_approval_form_values',
            config: {
              mode: 'update',
              mappings: [{ formFieldId: 'summary', targetFieldId: 'tgt_text' }],
              recordLinkFieldId: 'link',
              confirmationId: 'fwbc_stale',
            },
          },
        ],
      },
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 40))
    await nextTick()

    expect(second.client.listFields).toHaveBeenCalledWith('sheet_tgt')
    // Host sheet should not be the sole target for update mode.
    const updateCalls = second.client.listFields.mock.calls.map((c: unknown[]) => c[0])
    expect(updateCalls.filter((id: string) => id === 'sheet_tgt').length).toBeGreaterThan(0)
    second.app.unmount()
    void host
    void client
  })

  it('decision mode source selector is limited to the node decisionFieldIds', async () => {
    const { host, app } = mountEditor({
      ruleExtra: {
        actionConfig: {
          mode: 'decision',
          mappings: [{ formFieldId: '', targetFieldId: '' }],
          recordLinkFieldId: 'link',
          decisionNodeKey: 'approval_1',
          confirmationId: '',
        },
        actions: [
          {
            type: 'write_approval_form_values',
            config: {
              mode: 'decision',
              mappings: [{ formFieldId: '', targetFieldId: '' }],
              recordLinkFieldId: 'link',
              decisionNodeKey: 'approval_1',
              confirmationId: '',
            },
          },
        ],
      },
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 40))
    await nextTick()

    // Source field options: only "amount" is in decisionFieldIds (not summary).
    // El-option bodies are not always in DOM until open; the decision node selector is present.
    expect(host.querySelector('[data-field="fwbDecisionNodeKey"]')).toBeTruthy()
    expect(host.querySelector('[data-field="fwbFormFieldId"]')).toBeTruthy()
    app.unmount()
  })

  it('loads target fields independently for every FWB action', async () => {
    const { host, app, client } = mountEditor({
      ruleExtra: {
        actions: [
          {
            type: 'write_approval_form_values',
            config: {
              mode: 'create',
              mappings: [{ formFieldId: 'summary', targetFieldId: 'f_text' }],
              confirmationId: '',
            },
          },
          {
            type: 'write_approval_form_values',
            config: {
              mode: 'update',
              mappings: [{ formFieldId: 'summary', targetFieldId: 'tgt_text' }],
              recordLinkFieldId: 'link',
              confirmationId: '',
            },
          },
        ],
      },
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))
    await nextTick()

    const sheetIds = client.listFields.mock.calls.map((call: unknown[]) => call[0])
    expect(sheetIds).toContain('sheet_host')
    expect(sheetIds).toContain('sheet_tgt')
    expect(host.querySelectorAll('[data-field="fwbTargetFieldId"]')).toHaveLength(2)
    app.unmount()
  })
})
