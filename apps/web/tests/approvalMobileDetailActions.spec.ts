import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// T3-1 v0 — mobile approval DETAIL action-set restriction + concurrency (Q7/Q8).
//
//   - flag ON + narrow → action bar shows approve/reject/comment ONLY; the
//     deferred set (transfer/return/add-sign/reduce-sign/revoke/remind) is
//     hidden; approve dispatches via the SAME unified /actions endpoint (the
//     mocked store.executeAction); a 4xx failure triggers refresh-on-4xx.
//   - flag OFF → the full desktop action bar is unchanged.
//
// The store is mocked so no action touches the api mock-mode fixtures.
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

const mockApprovalMobileFlag = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) =>
      feature === 'approvalMobile' ? mockApprovalMobileFlag.value : false,
  }),
}))

// The approver can act (canAct = true) so approve/reject are enabled.
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: { value: true } }),
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    activeTemplate: null,
    loadTemplate: vi.fn().mockResolvedValue(undefined),
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

function stub(name: string, tag = 'div', extraProps: Record<string, unknown> = {}) {
  return defineComponent({
    name,
    props: { modelValue: {}, type: String, label: String, title: String, ...extraProps },
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
    return h('button', {
      'data-el-button': this.type || 'default',
      onClick: (e: Event) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})
const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String },
  render() {
    // Respect `v-model` like the real dialog: a CLOSED dialog renders nothing,
    // so a hidden dialog's confirm button (e.g. "确认转交") never leaks into the
    // action-set assertions.
    if (!this.modelValue) return null
    return h('div', { 'data-el-dialog': this.title }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})
// el-table-column's `#default="{ row }"` needs a { row } context the real table
// supplies; render an inert placeholder instead of invoking the scoped slot.
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String },
  render() { return h('div', { 'data-el-popconfirm': this.title }, this.$slots.reference?.()) },
})

const stubDirective = { mounted() {}, updated() {} }

function setViewport(mobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function pendingInstance(): any {
  return {
    id: 'apv_1',
    title: '出差报销',
    status: 'pending',
    requester: { id: 'user_99', name: '张三' },
    requestNo: 'AP-100001',
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    formSnapshot: { fld_reason: '出差报销' },
    assignments: [
      { id: 'a1', type: 'user', assigneeId: 'user_add', sourceStep: 1, nodeKey: 'approval_1', isActive: true, metadata: { addSign: true } },
    ],
  }
}

function buttonTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}

describe('ApprovalDetailView — T3-1 mobile action-set restriction', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockApprovalMobileFlag.value = false
    mockActiveApproval.value = pendingInstance()
    mockHistory.value = []
    mockLoading.value = false
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    pushSpy.mockClear()
    setViewport(false)
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
    // Broad Element Plus stubs; the action buttons are the assertion surface.
    for (const name of ['ElTag', 'ElAlert', 'ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElInput', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon']) {
      app.component(name, stub(name))
    }
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElDialog', ElDialog)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('flag OFF → desktop action bar keeps the full deferred action set', async () => {
    mockApprovalMobileFlag.value = false
    setViewport(true) // narrow viewport alone must NOT restrict when flag is off
    await mountView()

    const texts = buttonTexts(container!).join('|')
    expect(texts).toContain('通过')
    expect(texts).toContain('驳回')
    expect(texts).toContain('评论')
    // Deferred set present on desktop:
    expect(texts).toContain('转交')
    expect(container!.querySelector('[data-testid="approval-add-sign-button"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-reduce-sign-button"]')).toBeTruthy()
  })

  it('flag ON + narrow → exposes approve/reject/comment ONLY, hides the deferred set', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    await mountView()

    const texts = buttonTexts(container!).join('|')
    // v0 mobile action set:
    expect(texts).toContain('通过')
    expect(texts).toContain('驳回')
    expect(texts).toContain('评论')
    // Deferred set hidden:
    expect(texts).not.toContain('转交')
    expect(texts).not.toContain('撤回')
    expect(container!.querySelector('[data-testid="approval-add-sign-button"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-reduce-sign-button"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-remind-button"]')).toBeNull()
  })

  it('flag ON + narrow → approve dispatches via the unified /actions endpoint (store.executeAction)', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    await mountView()

    const approveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('通过'))
    expect(approveBtn).toBeTruthy()
    approveBtn!.click()
    await flushUi()

    // Dialog confirm ("确认") submits the action.
    const confirmBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushUi()

    expect(executeActionSpy).toHaveBeenCalledWith('apv_1', expect.objectContaining({ action: 'approve' }))
  })

  it('flag ON + narrow → a 4xx conflict re-pulls detail + history (refresh-on-4xx)', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    executeActionSpy.mockRejectedValueOnce(new Error('API error: 409 Conflict'))
    await mountView()
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()

    const approveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('通过'))
    approveBtn!.click()
    await flushUi()
    const confirmBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')
    confirmBtn!.click()
    await flushUi()

    expect(executeActionSpy).toHaveBeenCalled()
    expect(loadDetailSpy).toHaveBeenCalledWith('apv_1')
    expect(loadHistorySpy).toHaveBeenCalledWith('apv_1')
  })
})
