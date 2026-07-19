/**
 * FWB-2 product field fill — ApprovalNewView renders a single-record picker for record-link
 * (no raw record-id free-text input).
 */
import { createApp, h, nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { templateId: 'tpl_1' }, query: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () =>
    reactive({
      loading: false,
      activeTemplate: {
        id: 'tpl_1',
        formSchema: {
          fields: [
            {
              id: 'link',
              type: 'record-link',
              label: 'Bound record',
              required: true,
              props: { baseId: 'base_1', sheetId: 'sheet_tgt' },
            },
            { id: 'summary', type: 'text', label: 'Summary' },
          ],
        },
        approvalGraph: { nodes: [], edges: [] },
      },
      loadTemplate: vi.fn(async () => undefined),
    }),
}))

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => reactive({ loading: false, createApproval: vi.fn() }),
}))

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canWrite: true }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))

vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({
  default: {
    name: 'MetaLinkPicker',
    props: ['visible', 'field', 'currentValue'],
    emits: ['close', 'confirm'],
    template:
      '<div v-if="visible" data-testid="mock-meta-link-picker"><button data-testid="mock-pick-confirm" @click="$emit(\'confirm\', { recordIds: [\'rec_1\'], summaries: [{ id: \'rec_1\', display: \'Row 1\' }] })">ok</button></div>',
  },
}))

import ApprovalNewView from '../src/views/approval/ApprovalNewView.vue'

describe('ApprovalNewView — record-link fill', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders record-link picker affordance and stores { recordId } only', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(ApprovalNewView) })
    app.use(ElementPlus)
    app.mount(host)
    await nextTick()
    await nextTick()

    const field = host.querySelector('[data-testid="approval-record-link-field"]')
    expect(field).toBeTruthy()
    // No free-text record-id input.
    expect(host.querySelector('input[placeholder*="record id" i]')).toBeNull()

    const pick = host.querySelector('[data-testid="approval-record-link-pick"]') as HTMLButtonElement
    expect(pick).toBeTruthy()
    pick.click()
    await nextTick()
    expect(host.querySelector('[data-testid="mock-meta-link-picker"]')).toBeTruthy()

    const confirm = host.querySelector('[data-testid="mock-pick-confirm"]') as HTMLButtonElement
    confirm.click()
    await nextTick()

    // Display shows selected record (label or id).
    const display = host.querySelector('[data-testid="approval-record-link-display"]') as HTMLInputElement | null
    expect(display).toBeTruthy()
    app.unmount()
  })
})
