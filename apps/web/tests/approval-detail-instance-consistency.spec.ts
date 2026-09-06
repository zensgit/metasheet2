import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// ApprovalDetailView — instance consistency (2026-09-06).
//
// The router REUSES this component instance across a params-only navigation (下一条 →, deep link,
// approval-center row click), so between the route change and the incoming detail response there is
// a window in which the route already says B. These tests drive the REAL store (only the api layer
// is faked) plus the real view, and pin:
//
//   * the displayed instance is the one the actions act on — a write verb refuses to run while the
//     displayed instance is not the route's instance, and the action controls are disabled there;
//   * an A→B switch shows the loading state for B instead of continuing to render A, and a slower
//     response for A never renders once B is displayed;
//   * a failed load for the route's instance leaves no stale instance behind — the error state and
//     its retry are shown instead.
//
// Scaffold follows approvalDetailPolish.spec.ts (real ApprovalDetailView + a broad Element Plus stub
// set), with two differences: the route params are reactive, and the approval store is the REAL one
// so the switch/ordering behaviour under test is the shipped behaviour rather than a test double's.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
const mockRouteParams = reactive<{ id: string }>({ id: 'apv_a' })

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({
      params: mockRouteParams,
      query: {},
      get path() { return `/approvals/${mockRouteParams.id}` },
      meta: {},
    }),
  }
})

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false, features: ref({}) }),
}))

const mockCanAct = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

const getApprovalMock = vi.fn()
const getApprovalHistoryMock = vi.fn()
const dispatchActionMock = vi.fn()

vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    getApprovalHistory: (...args: unknown[]) => getApprovalHistoryMock(...args),
    dispatchAction: (...args: unknown[]) => dispatchActionMock(...args),
    markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
    remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../src/approvals/directoryResolve', () => ({
  ensureUserNamesResolved: vi.fn(),
  getResolvedUserName: () => null,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'user_99' }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_99'),
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

import { useApprovalStore } from '../src/approvals/store'

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

// Exposes `disabled`/`loading` as queryable attributes so the gate assertions can tell exactly which
// control is refusing input (Element Plus disables a loading button, so `disabled` mirrors it too).
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean, link: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', {
      'data-el-button': this.type || 'default',
      'data-loading': this.loading ? 'true' : 'false',
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
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, [this.title, this.$slots.default?.()]) },
})
// Renders the reference slot plus a confirm trigger. The trigger fires `@confirm` DIRECTLY — the
// affordance a disabled reference button cannot gate, which is exactly why the handler carries its
// own instance-consistency guard.
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm'],
  render() {
    return h('div', { 'data-el-popconfirm': this.title }, [
      this.$slots.reference?.(),
      h('button', {
        'data-testid': 'popconfirm-confirm-trigger',
        onClick: () => this.$emit('confirm'),
      }),
    ])
  },
})
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})
const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    return h('div', { 'data-el-dialog': this.title, 'data-open': this.modelValue ? 'true' : 'false' }, [
      this.$slots.default?.(),
      this.$slots.footer?.(),
    ])
  },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolvePromise = res
    rejectPromise = rej
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function instance(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `审批 ${id}`,
    status: 'pending',
    templateId: null,
    requester: { id: 'user_99', name: '张三' },
    requestNo: `AP-${id.toUpperCase()}`,
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [],
    ...overrides,
  }
}

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

describe('ApprovalDetailView — instance consistency', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    mockRouteParams.id = 'apv_a'
    mockCanAct.value = true
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    getApprovalHistoryMock.mockResolvedValue([])
    dispatchActionMock.mockReset()
    dispatchActionMock.mockImplementation((id: string) => Promise.resolve(instance(id, { status: 'approved' })))
    pushSpy.mockClear()
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag', 'ElSkeleton', 'ElSkeletonItem']) {
      app.component(name, stub(name))
    }
    app.component('ElDialog', ElDialog)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  async function approveThroughDialog(): Promise<void> {
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()
  }

  // -------------------------------------------------------------------------
  // Positive control — the steady state still works end to end.
  // -------------------------------------------------------------------------
  it('positive control: with the route and the displayed instance in agreement, 通过 acts on that instance', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()

    expect(container!.textContent).toContain('AP-APV_A')
    const approve = q(container!, 'approval-approve-button') as HTMLButtonElement
    expect(approve).toBeTruthy()
    expect(approve.disabled).toBe(false)

    await approveThroughDialog()

    expect(dispatchActionMock).toHaveBeenCalledTimes(1)
    expect(dispatchActionMock.mock.calls[0][0]).toBe('apv_a')
  })

  // -------------------------------------------------------------------------
  // A→B switch — B's load is slow, A's is slower still.
  // -------------------------------------------------------------------------
  it('a route switch shows the loading state for the new instance instead of continuing to render the old one', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')

    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))))
    mockRouteParams.id = 'apv_b'
    await flushUi()

    // Old instance gone, loading state shown, and NO action bar to act with.
    expect(container!.textContent).not.toContain('AP-APV_A')
    expect(q(container!, 'detail-skeleton')).toBeTruthy()
    expect(q(container!, 'approval-approve-button')).toBeNull()
    expect(q(container!, 'detail-not-found')).toBeNull()

    pendingB.resolve(instance('apv_b'))
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_B')
    const approve = q(container!, 'approval-approve-button') as HTMLButtonElement
    expect(approve.disabled).toBe(false)

    await approveThroughDialog()

    expect(dispatchActionMock).toHaveBeenCalledTimes(1)
    expect(dispatchActionMock.mock.calls[0][0]).toBe('apv_b')
  })

  it('a slower response for the outgoing instance never renders once the incoming one is displayed', async () => {
    const slowA = deferred<any>()
    const fastB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_a' ? slowA.promise : fastB.promise))
    await mountView()

    mockRouteParams.id = 'apv_b'
    await flushUi()
    fastB.resolve(instance('apv_b'))
    await flushUi()
    expect(container!.textContent).toContain('AP-APV_B')

    slowA.resolve(instance('apv_a'))
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_B')
    expect(container!.textContent).not.toContain('AP-APV_A')
  })

  // -------------------------------------------------------------------------
  // The gate itself — displayed instance ≠ route instance.
  // -------------------------------------------------------------------------
  it('refuses a write verb while the displayed instance is not the route instance, then allows it once they agree', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()

    // A dialog opened on the instance the reader was looking at OUTLIVES the switch (it lives
    // outside the `v-if="approval"` action bar), so its confirm is a surface the gate must reach.
    // 通过 needs no comment under this policy, so this confirm's ONLY remaining precondition is the
    // gate itself.
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    expect((q(container!, 'approval-action-dialog-confirm') as HTMLButtonElement).disabled).toBe(false)

    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))))
    mockRouteParams.id = 'apv_b'
    await flushUi()

    // Model a lagging write into the shared detail slot: the route is already B while the slot still
    // carries A. The page renders A, so every control must refuse — and the 撤回 popconfirm fires its
    // own @confirm, which no `disabled` attribute can stop.
    const store = useApprovalStore()
    store.activeApproval = instance('apv_a')
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_A')
    expect((q(container!, 'approval-approve-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-comment-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-revoke-button') as HTMLButtonElement).disabled).toBe(true)
    // The dialog left open across the switch refuses too.
    expect((q(container!, 'approval-action-dialog-confirm') as HTMLButtonElement).disabled).toBe(true)

    q(container!, 'popconfirm-confirm-trigger')!.click()
    await flushUi()

    expect(dispatchActionMock).not.toHaveBeenCalled()

    // Positive control: the SAME affordance, same click, once the page and the route agree again.
    pendingB.resolve(instance('apv_b'))
    await flushUi()
    expect((q(container!, 'approval-revoke-button') as HTMLButtonElement).disabled).toBe(false)
    expect((q(container!, 'approval-action-dialog-confirm') as HTMLButtonElement).disabled).toBe(false)

    q(container!, 'popconfirm-confirm-trigger')!.click()
    await flushUi()

    expect(dispatchActionMock).toHaveBeenCalledTimes(1)
    expect(dispatchActionMock.mock.calls[0][0]).toBe('apv_b')
    expect(dispatchActionMock.mock.calls[0][1]).toEqual({ action: 'revoke' })
  })

  it('disables the action controls while a detail load for the displayed instance is still in flight', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    expect((q(container!, 'approval-approve-button') as HTMLButtonElement).disabled).toBe(false)

    const pendingRefresh = deferred<any>()
    getApprovalMock.mockReturnValueOnce(pendingRefresh.promise)
    const store = useApprovalStore()
    void store.loadDetail('apv_a')
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_A')
    expect((q(container!, 'approval-approve-button') as HTMLButtonElement).disabled).toBe(true)

    pendingRefresh.resolve(instance('apv_a'))
    await flushUi()
    expect((q(container!, 'approval-approve-button') as HTMLButtonElement).disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Failed load.
  // -------------------------------------------------------------------------
  it('a failed load for the new instance leaves no stale instance and shows the error state with a retry', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')

    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? Promise.reject(new Error('该审批暂时无法加载')) : Promise.resolve(instance(id))
    ))
    mockRouteParams.id = 'apv_b'
    await flushUi()

    expect(container!.textContent).not.toContain('AP-APV_A')
    expect(q(container!, 'detail-not-found')).toBeTruthy()
    expect(container!.textContent).toContain('该审批暂时无法加载')

    // Retry re-requests the ROUTE's instance, not the one that used to be displayed.
    getApprovalMock.mockClear()
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    q(container!, 'approval-not-found-retry')!.click()
    await flushUi()

    expect(getApprovalMock.mock.calls.map((call) => call[0])).toContain('apv_b')
    expect(container!.textContent).toContain('AP-APV_B')
  })

  it('a failed reload of the SAME instance clears it rather than leaving it on screen under an error', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')

    getApprovalMock.mockImplementation(() => Promise.reject(new Error('该审批暂时无法加载')))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    await flushUi()

    expect(container!.textContent).not.toContain('AP-APV_A')
    expect(q(container!, 'detail-not-found')).toBeTruthy()
    expect(q(container!, 'approval-not-found-retry')).toBeTruthy()
    expect(container!.textContent).toContain('该审批暂时无法加载')
  })
})
