/**
 * FWB-3 product flow — approve dialog collects decisionFieldIds and dispatches decisionData.
 * Mount scaffold mirrors approvalDetailPolish.spec.ts (store/router/auth/permissions mocks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import ElementPlus from 'element-plus'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: { id: 'apv_1' }, query: {}, path: '/approvals/apv_1', meta: {} }),
  }
})

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false }),
}))

const mockCanAct = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

const mockCurrentUserId = ref<string | null>('u1')
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => (mockCurrentUserId.value ? { id: mockCurrentUserId.value } : null),
    getCurrentUserId: vi.fn().mockImplementation(async () => mockCurrentUserId.value),
  }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    activeTemplate: null,
    activeVersion: {
      approvalGraph: {
        nodes: [
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Manager',
            config: { decisionFieldIds: ['amount', 'grade'] },
          },
        ],
        edges: [],
      },
    },
    loadTemplate: vi.fn().mockResolvedValue(undefined),
    loadVersion: vi.fn().mockResolvedValue(undefined),
  }),
}))

const mockActiveApproval = ref<Record<string, unknown> | null>(null)
const mockHistory = ref<unknown[]>([])
const mockLoading = ref(false)
const executeActionSpy = vi.fn().mockResolvedValue({ id: 'apv_1', status: 'approved' })
const loadDetailSpy = vi.fn().mockResolvedValue(undefined)
const loadHistorySpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get activeApproval() {
      return mockActiveApproval.value
    },
    get history() {
      return mockHistory.value
    },
    get loading() {
      return mockLoading.value
    },
    get error() {
      return null
    },
    get approvals() {
      return []
    },
    get pendingApprovals() {
      return []
    },
    set error(_v: unknown) {
      /* noop */
    },
    executeAction: executeActionSpy,
    loadDetail: loadDetailSpy,
    loadHistory: loadHistorySpy,
  }),
}))

vi.mock('../src/composables/useMobileViewport', () => ({
  useMobileViewport: () => ({ isMobile: ref(false) }),
}))

import ApprovalDetailView from '../src/views/approval/ApprovalDetailView.vue'

describe('ApprovalDetailView — decisionData approve flow', () => {
  let app: VueApp | null = null
  let container: HTMLElement | null = null

  beforeEach(() => {
    executeActionSpy.mockClear()
    mockCanAct.value = true
    mockCurrentUserId.value = 'u1'
    mockHistory.value = []
    mockLoading.value = false
    mockActiveApproval.value = {
      id: 'apv_1',
      status: 'pending',
      currentNodeKey: 'approval_1',
      title: 'Test approval',
      formSchema: {
        fields: [
          { id: 'amount', type: 'number', label: 'Amount' },
          {
            id: 'grade',
            type: 'select',
            label: 'Grade',
            options: [{ label: 'A', value: 'A' }],
          },
        ],
      },
      formSnapshot: { amount: 100, grade: 'A' },
      assignments: [
        {
          id: 'asg_1',
          isActive: true,
          nodeKey: 'approval_1',
          type: 'user',
          assigneeId: 'u1',
          sourceStep: 1,
          metadata: {},
        },
      ],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
  })

  afterEach(() => {
    if (app) {
      app.unmount()
      app = null
    }
    if (container) {
      container.remove()
      container = null
    }
  })

  async function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ render: () => h(ApprovalDetailView) })
    app.use(ElementPlus)
    app.mount(container)
    await nextTick()
    await nextTick()
  }

  it('renders decision fields on approve and sends decisionData via executeAction', async () => {
    await mountView()

    const approveBtn =
      (container!.querySelector('[data-testid="approval-action-approve"]') as HTMLButtonElement | null)
      || Array.from(container!.querySelectorAll('button')).find((b) =>
        /通过|同意|approve/i.test(b.textContent || ''),
      )
    expect(approveBtn).toBeTruthy()
    ;(approveBtn as HTMLButtonElement).click()
    await nextTick()
    await nextTick()

    const decisionBlock = container!.querySelector('[data-testid="approval-decision-fields"]')
    expect(decisionBlock).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-decision-field-amount"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-decision-field-grade"]')).toBeTruthy()

    const confirm = container!.querySelector(
      '[data-testid="approval-action-dialog-confirm"]',
    ) as HTMLButtonElement
    expect(confirm).toBeTruthy()
    confirm.click()
    await nextTick()
    await new Promise((r) => setTimeout(r, 30))

    expect(executeActionSpy).toHaveBeenCalled()
    const req = executeActionSpy.mock.calls[0][1] as {
      action: string
      decisionData?: Record<string, unknown>
    }
    expect(req.action).toBe('approve')
    expect(req.decisionData).toBeTruthy()
    expect(Object.keys(req.decisionData!)).toEqual(expect.arrayContaining(['amount', 'grade']))
  })
})
