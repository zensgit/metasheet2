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
  // B3-04 D-2: ApprovalUserPicker (transfer/add-sign dialogs) calls this on mount; this suite
  // never opens those dialogs, but stubbing it keeps the eager mount-time search a clean resolved
  // no-op instead of an unhandled real-fetch attempt.
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

// B1-01: mutable session identity — per-test control over requester/my-turn affordances.
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
    // B1-04: reflect `disabled`/`loading` on the native button (matches real el-button, which
    // also treats `loading` as disabled) so the reject-comment pre-flight is actually testable —
    // a disabled button must not fire its click handler.
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
// B1-04: dialog-scoped error alert needs its `title` text rendered so the SERVER-message
// assertion can read it back; the generic `stub()` helper below only renders the default slot.
const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, this.title) },
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
// B1-05: quick-phrase chips are `<el-tag @click="...">`; the generic `stub()` helper declares
// 'click' under `emits` but never wires a native listener, so a real click would silently no-op.
// A minimal dedicated stub that forwards the click keeps the chip-click test honest.
const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String, effect: String },
  emits: ['click'],
  render() {
    return h('span', {
      'data-el-tag': this.type || 'default',
      onClick: (e: Event) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})
// B1-05: the comment/quick-phrase test needs a real v-model round-trip (fill via ref assignment,
// read back via `.value`); the generic `stub()` helper renders a static div with no such wiring.
const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], type: String, rows: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      'data-el-input': 'true',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
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
    mockCurrentUserId.value = null
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon']) {
      app.component(name, stub(name))
    }
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElDialog', ElDialog)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElTag', ElTag)
    app.component('ElInput', ElInput)
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

  it('B1-01: requester-only actions key off the REAL session identity (RED-before: user_1 mock)', async () => {
    // the reader IS the requester → 催一下 + 撤回 visible on desktop
    mockCurrentUserId.value = 'user_99'
    await mountView()
    let texts = buttonTexts(container!)
    expect(texts.some((t) => t.includes('催一下'))).toBe(true)
    expect(texts).toContain('撤回')
    app!.unmount()
    container!.innerHTML = ''

    // a different reader → requester-only actions hidden
    mockCurrentUserId.value = 'user_someone_else'
    await mountView()
    texts = buttonTexts(container!)
    expect(texts.some((t) => t.includes('催一下'))).toBe(false)
    expect(texts).not.toContain('撤回')
  })

  it('B1-01: 等待你处理 badge shows only for an active assignee at the current node', async () => {
    // fixture assignment: user_add active at approval_1 (the current node)
    mockCurrentUserId.value = 'user_add'
    await mountView()
    expect(container!.querySelector('[data-testid="approval-my-turn-badge"]')).not.toBeNull()
    app!.unmount()
    container!.innerHTML = ''

    mockCurrentUserId.value = 'user_uninvolved'
    await mountView()
    expect(container!.querySelector('[data-testid="approval-my-turn-badge"]')).toBeNull()
  })

  it('B1-05: opening 通过 dialog shows quick-phrase chips; clicking one fills the comment input', async () => {
    await mountView()

    const approveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('通过'))
    expect(approveBtn).toBeTruthy()
    approveBtn!.click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog]')
    expect(dialog).toBeTruthy()

    // Preset chips for 'approve' (no recent phrases yet for this — unresolved — user).
    const chip = dialog!.querySelector('[data-testid="approval-quick-phrase-0"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.textContent?.trim()).toBe('同意')

    chip.click()
    await flushUi()

    const textarea = dialog!.querySelector('[data-el-input]') as HTMLInputElement
    expect(textarea.value).toBe('同意')
  })

  // ---------------------------------------------------------------------------
  // B1-04 (宽恕型错误三件套) — dialog-scoped server errors + reject-comment pre-flight.
  // ---------------------------------------------------------------------------

  it('B1-04: action failure keeps the dialog open and shows the inline SERVER message', async () => {
    await mountView()
    const serverError = Object.assign(new Error('金额合计不一致'), { code: 'AMOUNT_MISMATCH', status: 400 })
    executeActionSpy.mockRejectedValueOnce(serverError)

    const approveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('通过'))
    approveBtn!.click()
    await flushUi()

    const confirmBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')
    confirmBtn!.click()
    await flushUi()

    // Dialog stays open (no generic toast closed it) and shows the server's own message.
    const dialog = container!.querySelector('[data-el-dialog]')
    expect(dialog).toBeTruthy()
    const alert = dialog!.querySelector('[data-testid="approval-action-dialog-error"]')
    expect(alert?.textContent).toBe('金额合计不一致')
  })

  it('B1-04: reject confirm is disabled until a reason is entered when policy.rejectCommentRequired=true', async () => {
    mockActiveApproval.value = { ...pendingInstance(), policy: { rejectCommentRequired: true } }
    await mountView()

    const rejectBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('驳回'))
    rejectBtn!.click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog]')
    const confirmBtn = Array.from(dialog!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    const textarea = dialog!.querySelector('[data-el-input]') as HTMLInputElement
    textarea.value = '金额有误'
    textarea.dispatchEvent(new Event('input'))
    await flushUi()

    expect(confirmBtn.disabled).toBe(false)
    confirmBtn.click()
    await flushUi()
    expect(executeActionSpy).toHaveBeenCalledWith('apv_1', expect.objectContaining({ action: 'reject', comment: '金额有误' }))
  })

  it('B1-04: reject confirm stays enabled with an empty comment when policy.rejectCommentRequired=false', async () => {
    mockActiveApproval.value = { ...pendingInstance(), policy: { rejectCommentRequired: false } }
    await mountView()

    const rejectBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('驳回'))
    rejectBtn!.click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog]')
    const confirmBtn = Array.from(dialog!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
  })

  it('B1-04: a typed error (status property) also triggers refresh-on-4xx, not just the legacy "API error: NNN" string', async () => {
    mockApprovalMobileFlag.value = true
    setViewport(true)
    const typedError = Object.assign(new Error('审批流程已终止，无法执行操作'), { status: 409, code: 'APPROVAL_STATE_CONFLICT' })
    executeActionSpy.mockRejectedValueOnce(typedError)
    await mountView()
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()

    const approveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('通过'))
    approveBtn!.click()
    await flushUi()
    const confirmBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')
    confirmBtn!.click()
    await flushUi()

    expect(loadDetailSpy).toHaveBeenCalledWith('apv_1')
    expect(loadHistorySpy).toHaveBeenCalledWith('apv_1')
  })
})
