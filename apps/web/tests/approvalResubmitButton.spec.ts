import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// UX B2-13 (再次提交) — ApprovalDetailView's resubmit entry point.
//
//   - shown ONLY for the CURRENT USER'S OWN instance (isRequester) in a TERMINAL state that
//     means "this didn't go through": rejected / revoked / cancelled.
//   - hidden for 'approved' (nothing to fix) and for a non-requester viewing someone else's
//     terminal instance.
//   - hidden entirely while still 'pending' (the normal approve/reject/... action bar renders
//     instead — see the shared `.approval-detail__actions` v-else branch).
//   - clicking it navigates to the SAME template's fill route with `?fromInstance=<id>`.
//
// Same mount scaffold as approvalMobileDetailActions.spec.ts (store/router/auth/permissions
// mocked directly; the real `ApprovalDetailView.vue` + a broad Element Plus stub set).
// ---------------------------------------------------------------------------

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

// The reader is never an active approver in this suite — only requester-side affordances
// (催一下/撤回/再次提交) are under test, not canAct's approve/reject bar.
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: { value: false } }),
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

// B1-01: mutable session identity — per-test control over requester affordances (mirrors
// approvalMobileDetailActions.spec.ts).
const mockCurrentUserId = ref<string | null>(null)
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => (mockCurrentUserId.value ? { id: mockCurrentUserId.value } : null),
    getCurrentUserId: vi.fn().mockImplementation(async () => mockCurrentUserId.value),
  }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    activeTemplate: null,
    activeVersion: null,
    loadTemplate: vi.fn().mockResolvedValue(undefined),
    loadVersion: vi.fn().mockResolvedValue(undefined),
  }),
}))

const mockActiveApproval = ref<any>(null)
const mockHistory = ref<any[]>([])
const mockLoading = ref(false)
const executeActionSpy = vi.fn()
const loadDetailSpy = vi.fn().mockResolvedValue(undefined)
const loadHistorySpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return mockLoading.value },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    loadDetail: loadDetailSpy,
    loadHistory: loadHistorySpy,
    executeAction: executeActionSpy,
  }),
}))

function stub(name: string, tag = 'div') {
  return defineComponent({
    name,
    props: { modelValue: {}, type: String, label: String, title: String },
    emits: ['update:modelValue', 'click', 'confirm', 'change'],
    render() {
      return h(tag, { 'data-stub': name }, this.$slots.default?.())
    },
  })
}

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', {
      'data-el-button': this.type || 'default',
      disabled: isDisabled,
      onClick: (e: Event) => {
        if (isDisabled) return
        this.$emit('click', e)
      },
    }, this.$slots.default?.())
  },
})
const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, this.title) },
})
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String },
  render() { return h('div', { 'data-el-popconfirm': this.title }, this.$slots.reference?.()) },
})
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function baseInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'apv_1',
    title: '出差报销',
    status: 'pending',
    templateId: 'tpl_1',
    requester: { id: 'user_99', name: '张三' },
    requestNo: 'AP-100001',
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    formSnapshot: { fld_reason: '出差报销' },
    assignments: [],
    ...overrides,
  }
}

function resubmitButton(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="approval-resubmit-button"]')
}

describe('ApprovalDetailView — UX B2-13 再次提交', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = []
    mockLoading.value = false
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    pushSpy.mockClear()
    mockCurrentUserId.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView() {
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    const Host = defineComponent({ setup() { return () => h(ApprovalDetailView as any) } })
    app = createApp(Host)
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag', 'ElDialog']) {
      app.component(name, stub(name))
    }
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('shows 再次提交 for the requester\'s own REJECTED instance', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'rejected' })
    await mountView()

    expect(resubmitButton(container!)).toBeTruthy()
  })

  it('shows 再次提交 for the requester\'s own REVOKED instance', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'revoked' })
    await mountView()

    expect(resubmitButton(container!)).toBeTruthy()
  })

  it('shows 再次提交 for the requester\'s own CANCELLED instance', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'cancelled' })
    await mountView()

    expect(resubmitButton(container!)).toBeTruthy()
  })

  it('hides 再次提交 for an APPROVED instance — nothing to resubmit, even for the requester', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'approved' })
    await mountView()

    expect(resubmitButton(container!)).toBeNull()
    // the "该审批已结束" alert still shows — only the NEW button is gated off.
    expect(container!.querySelector('[data-el-alert="info"]')?.textContent).toContain('该审批已结束')
  })

  it('hides 再次提交 while still PENDING (the normal action bar renders instead)', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'pending' })
    await mountView()

    expect(resubmitButton(container!)).toBeNull()
  })

  it('hides 再次提交 for a NON-REQUESTER viewing someone else\'s rejected instance', async () => {
    mockCurrentUserId.value = 'user_someone_else'
    mockActiveApproval.value = baseInstance({ status: 'rejected' })
    await mountView()

    expect(resubmitButton(container!)).toBeNull()
  })

  it('hides 再次提交 when the session identity is unresolved (fail-closed, no currentUserId)', async () => {
    mockCurrentUserId.value = null
    mockActiveApproval.value = baseInstance({ status: 'rejected' })
    await mountView()

    expect(resubmitButton(container!)).toBeNull()
  })

  it('hides 再次提交 when the instance has no templateId (nothing to route back to)', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'rejected', templateId: null })
    await mountView()

    expect(resubmitButton(container!)).toBeNull()
  })

  it('clicking 再次提交 navigates to the SAME template\'s fill route with ?fromInstance=<id>', async () => {
    mockCurrentUserId.value = 'user_99'
    mockActiveApproval.value = baseInstance({ status: 'rejected', templateId: 'tpl_42', id: 'apv_source_1' })
    await mountView()

    const btn = resubmitButton(container!)
    expect(btn).toBeTruthy()
    btn!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'approval-create',
      params: { templateId: 'tpl_42' },
      query: { fromInstance: 'apv_source_1' },
    })
  })
})
