import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
//   * a failed load for ANOTHER instance leaves no stale instance behind (error state + retry),
//     while a failed reload of the instance the reader is ON keeps it, with the error above it;
//   * a refresh whose instance id was CAPTURED before the reader navigated is skipped rather than
//     written into the shared slot the route's own load owns;
//   * an instance switch closes every action dialog and clears every verb payload, so nothing
//     composed on the outgoing instance can be submitted against the incoming one.
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

// Feature flags + viewport are per-test so the mobile-only stale-action refresh path can be reached;
// both default to the desktop shape every other test in this file assumes.
const mockHasFeature = vi.fn().mockReturnValue(false)
const mockIsMobile = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: (flag: string) => mockHasFeature(flag), features: ref({}) }),
}))
vi.mock('../src/composables/useMobileViewport', () => ({
  useMobileViewport: () => ({ isMobile: mockIsMobile, updateMobileState: () => {} }),
}))

const mockCanAct = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

// Round 3 (B10): the reader-facing announcements are the thing under test, so ElMessage is a spy
// rather than the real toast renderer — "no text in the container" is not an oracle for a toast,
// which teleports to document.body.
const elMessage = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('element-plus').catch(() => ({}))
  return { ...actual, ElMessage: elMessage }
})

const getApprovalMock = vi.fn()
const getApprovalHistoryMock = vi.fn()
const dispatchActionMock = vi.fn()
const remindApprovalMock = vi.fn()
const markApprovalReadMock = vi.fn().mockResolvedValue({ ok: true })

vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    getApprovalHistory: (...args: unknown[]) => getApprovalHistoryMock(...args),
    dispatchAction: (...args: unknown[]) => dispatchActionMock(...args),
    markApprovalRead: (...args: unknown[]) => markApprovalReadMock(...args),
    remindApproval: (...args: unknown[]) => remindApprovalMock(...args),
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
import { NODE_OPERATION_DISABLED_CODE, NODE_OPERATION_DISABLED_MESSAGE } from '../src/approvals/memberActionErrorCopy'

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

// A real v-model-capable textarea (mirrors approval-process-attachment-dialog.spec.ts's stub) so a
// test can type an actual comment into a dialog and then observe whether the switch cleared it —
// the generic `stub()` has no modelValue wiring, which would leave `actionComment` always empty.
const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, type: String, rows: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('textarea', {
      'data-el-input': 'true',
      value: this.modelValue,
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLTextAreaElement).value),
    })
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
    mockIsMobile.value = false
    mockHasFeature.mockReset()
    mockHasFeature.mockReturnValue(false)
    markApprovalReadMock.mockClear()
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    getApprovalHistoryMock.mockResolvedValue([])
    dispatchActionMock.mockReset()
    dispatchActionMock.mockImplementation((id: string) => Promise.resolve(instance(id, { status: 'approved' })))
    remindApprovalMock.mockReset()
    remindApprovalMock.mockResolvedValue({ ok: true, data: {} })
    elMessage.success.mockClear()
    elMessage.warning.mockClear()
    elMessage.error.mockClear()
    elMessage.info.mockClear()
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElSkeleton', 'ElSkeletonItem']) {
      app.component(name, stub(name))
    }
    app.component('ElInput', ElInput)
    app.component('ElDialog', ElDialog)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // The mounted view's own setup bindings (refs unwrapped), for the payload refs this file's stub
  // set gives no affordance for.
  function setupState(): Record<string, any> {
    return (app as any)?._instance?.subTree?.component?.setupState ?? {}
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

  // The test above induces the mismatch WHILE a load for the incoming instance is still in flight,
  // so `detailLoading` is true at the same time and either half of `actionsEnabled` could be doing
  // the refusing. This one isolates the id comparison: the switch has completed, B is displayed and
  // nothing is in flight, and only then does a lagging write put A back into the shared slot. The
  // in-flight half is false throughout, so the ONLY thing that can refuse here is
  // `displayedInstanceId === routeInstanceId`. (Its counterpart — the in-flight half in isolation —
  // is the test immediately below, where the route and the displayed instance never disagree.)
  it('refuses a write verb on the id mismatch alone, with no detail request in flight', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()

    mockRouteParams.id = 'apv_b'
    await flushUi()
    expect(container!.textContent).toContain('AP-APV_B')

    const store = useApprovalStore()
    expect(store.detailLoading).toBe(false)

    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    expect((q(container!, 'approval-action-dialog-confirm') as HTMLButtonElement).disabled).toBe(false)

    // Lagging write into the shared detail slot with NOTHING outstanding.
    store.activeApproval = instance('apv_a')
    await flushUi()

    expect(store.detailLoading).toBe(false)
    expect(container!.textContent).toContain('AP-APV_A')
    expect((q(container!, 'approval-approve-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-comment-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-revoke-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-action-dialog-confirm') as HTMLButtonElement).disabled).toBe(true)

    // The popconfirm's own @confirm — the affordance no `disabled` binding reaches.
    q(container!, 'popconfirm-confirm-trigger')!.click()
    await flushUi()

    expect(dispatchActionMock).not.toHaveBeenCalled()
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

  // Round 2 rewrite. The first version of this test asserted the opposite — that a SAME-id reload
  // failure blanks the page to 未找到该审批 — and so froze a rule wider than instance consistency
  // needs. The two cases are not the same problem: a load for ANOTHER instance must leave nothing
  // of the outgoing one behind (the test above), and that is already guaranteed by the synchronous
  // switch clear, before the request is even sent. A refresh of the instance the reader is ON that
  // hits a transient error tells us nothing new about which instance this is, and throwing the
  // instance away turns two ordinary paths — 重新加载 after a failed timeline fetch, and the mobile
  // post-action refresh — into a blank page. The reader keeps what they were reading, with the
  // error (and its retry) above it.
  it('a failed reload of the SAME instance keeps it on screen with the error above it', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')

    getApprovalMock.mockImplementation(() => Promise.reject(new Error('该审批暂时无法加载')))
    const store = useApprovalStore()
    await store.loadDetail('apv_a')
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_A')
    expect(q(container!, 'detail-not-found')).toBeNull()
    expect(container!.textContent).toContain('该审批暂时无法加载')
    // The alert's own 重新加载 is the retry affordance in this state (the not-found block is gone).
    expect(container!.querySelector('[data-el-alert="error"]')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // The mobile post-action refresh, whose id is CAPTURED at submit time.
  // -------------------------------------------------------------------------
  it('skips the captured-id refresh once the route has moved on, and the route instance still lands', async () => {
    mockIsMobile.value = true
    mockHasFeature.mockImplementation((flag: string) => flag === 'approvalMobile')

    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))
    ))
    const pendingAction = deferred<any>()
    dispatchActionMock.mockImplementation(() => pendingAction.promise)

    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')

    // Submit on A; its response is still outstanding when the reader navigates.
    await approveThroughDialog()
    expect(dispatchActionMock).toHaveBeenCalledWith('apv_a', expect.anything())

    mockRouteParams.id = 'apv_b'
    await flushUi()
    getApprovalMock.mockClear()

    // A's submit now fails with a conflict — the shape that used to trigger a reload of the
    // CAPTURED instance into the shared slot the route's own load already owns.
    const conflict: any = new Error('该审批已被处理')
    conflict.status = 409
    pendingAction.reject(conflict)
    await flushUi(12)

    const store = useApprovalStore()
    expect(getApprovalMock.mock.calls.map((call) => call[0])).not.toContain('apv_a')
    expect(store.activeApproval).toBeNull()
    expect(container!.textContent).not.toContain('AP-APV_A')
    expect(store.error).toBeNull()

    // B's own load — never superseded by the captured-id refresh — completes normally.
    pendingB.resolve(instance('apv_b'))
    await flushUi(12)

    expect(store.activeApproval?.id).toBe('apv_b')
    expect(container!.textContent).toContain('AP-APV_B')
  })

  it('positive control: the captured-id refresh still runs when the reader has NOT navigated', async () => {
    mockIsMobile.value = true
    mockHasFeature.mockImplementation((flag: string) => flag === 'approvalMobile')

    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    const conflict: any = new Error('该审批已被处理')
    conflict.status = 409
    dispatchActionMock.mockRejectedValue(conflict)

    await mountView()
    getApprovalMock.mockClear()
    getApprovalHistoryMock.mockClear()

    await approveThroughDialog()
    await flushUi(12)

    expect(getApprovalMock.mock.calls.map((call) => call[0])).toContain('apv_a')
    expect(getApprovalHistoryMock.mock.calls.map((call) => call[0])).toContain('apv_a')
    expect(container!.textContent).toContain('AP-APV_A')
  })

  // -------------------------------------------------------------------------
  // Post-verb timeline refresh, whose id is likewise CAPTURED at submit time.
  // -------------------------------------------------------------------------
  it('does not refresh the outgoing instance timeline when a verb succeeds after the route moved on', async () => {
    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))
    ))
    const pendingAction = deferred<any>()
    dispatchActionMock.mockImplementation(() => pendingAction.promise)

    await mountView()
    await approveThroughDialog()
    expect(dispatchActionMock).toHaveBeenCalledWith('apv_a', expect.anything())

    mockRouteParams.id = 'apv_b'
    await flushUi()
    getApprovalHistoryMock.mockClear()
    getApprovalHistoryMock.mockResolvedValue([
      { id: 'hist_apv_a', instanceId: 'apv_a', action: 'approve', comment: 'A 的记录' },
    ])

    // The verb SUCCEEDS, for the instance it was submitted against — but the reader has moved, and
    // B's own detail response has not landed yet, so the store's own displayed-instance guard is
    // still inert here. Only the call-site check can refuse.
    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    await flushUi(12)

    const store = useApprovalStore()
    expect(getApprovalHistoryMock.mock.calls.map((call) => call[0])).not.toContain('apv_a')
    expect(store.history).toEqual([])

    pendingB.resolve(instance('apv_b'))
    await flushUi(12)
    expect(store.activeApproval?.id).toBe('apv_b')
  })

  // Inertness control for the rule above: the store refuses a `loadHistory` for an instance it is
  // not displaying, and `loadDetailPage` fires detail + history in parallel — so this pins that the
  // ORDINARY switch still populates the incoming instance's timeline. (It does because `loadDetail`
  // empties the slot synchronously before `loadHistory` is even called; if that ordering ever
  // changed, every reader would silently get an empty 审批记录 after 下一条.)
  it('a switch still loads and renders the incoming instance timeline', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    getApprovalHistoryMock.mockImplementation((id: string) => Promise.resolve([
      { id: `hist_${id}`, instanceId: id, action: 'approve', comment: `记录-${id}`, createdAt: '2026-09-01T10:00:00.000Z' },
    ]))
    await mountView()

    const store = useApprovalStore()
    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_a'])

    mockRouteParams.id = 'apv_b'
    await flushUi(12)

    expect(store.activeApproval?.id).toBe('apv_b')
    expect(store.history.map((row: any) => row.instanceId)).toEqual(['apv_b'])
  })

  // -------------------------------------------------------------------------
  // The one deliberate route-id write.
  // -------------------------------------------------------------------------
  // No write VERB reads `route.params.id`; mark-read does, on purpose. It is an `apiPost`, so this
  // pins the intent rather than leaving it to a comment: "the reader opened this URL" is a fact
  // about the route, and it must be recorded for the route's instance even while the shared detail
  // slot still holds the outgoing one.
  it('marks the ROUTE instance read on entry and on every switch, never the outgoing one', async () => {
    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))
    ))
    await mountView()
    expect(markApprovalReadMock.mock.calls.map((call) => call[0])).toEqual(['apv_a'])

    mockRouteParams.id = 'apv_b'
    await flushUi()

    // The switch fires mark-read for B while `activeApproval` is still being replaced.
    expect(markApprovalReadMock.mock.calls.map((call) => call[0])).toEqual(['apv_a', 'apv_b'])

    pendingB.resolve(instance('apv_b'))
    await flushUi()
    expect(markApprovalReadMock.mock.calls.map((call) => call[0])).toEqual(['apv_a', 'apv_b'])
  })

  // -------------------------------------------------------------------------
  // Instance switch — dialog state.
  // -------------------------------------------------------------------------
  it('closes every action dialog and clears its payload when the route moves to another instance', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()

    // Open 通过 on A and type a comment that is about A.
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    const dialog = q(container!, 'approval-action-dialog')!
    expect(dialog.getAttribute('data-open')).toBe('true')
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'A 的审批意见'
    textarea.dispatchEvent(new Event('input'))
    await flushUi()

    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))))
    mockRouteParams.id = 'apv_b'
    await flushUi()
    pendingB.resolve(instance('apv_b'))
    await flushUi()

    expect(container!.textContent).toContain('AP-APV_B')
    expect(q(container!, 'approval-action-dialog')!.getAttribute('data-open')).toBe('false')
    expect((q(container!, 'approval-action-dialog')!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')

    // A dialog freshly opened on B sends only what was composed on B.
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    const bDialog = q(container!, 'approval-action-dialog')!
    expect(bDialog.getAttribute('data-open')).toBe('true')
    const bTextarea = bDialog.querySelector('textarea') as HTMLTextAreaElement
    bTextarea.value = 'B 的审批意见'
    bTextarea.dispatchEvent(new Event('input'))
    await flushUi()

    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()

    expect(dispatchActionMock).toHaveBeenCalledTimes(1)
    expect(dispatchActionMock.mock.calls[0][0]).toBe('apv_b')
    expect(dispatchActionMock.mock.calls[0][1]).toEqual({ action: 'approve', comment: 'B 的审批意见' })
  })

  // The DOM test above covers 通过's comment end to end. The remaining verb payloads (转交 target,
  // 退回 target node, 加签 list, 减签 target) have no affordance reachable through this file's stub
  // set, so they are driven and asserted through the component's own setup state — the exhaustive
  // half of the same rule, so a NEW payload ref cannot be added without noticing this list.
  it('clears every verb payload ref and closes every dialog on the switch', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()

    const before = setupState()
    before.actionDialogVisible = true
    before.transferDialogVisible = true
    before.addSignDialogVisible = true
    before.reduceSignDialogVisible = true
    before.commentDialogVisible = true
    before.returnDialogVisible = true
    before.actionComment = 'A 的审批意见'
    before.actionDialogError = 'A 的失败原因'
    before.returnTargetNodeKey = 'node_of_apv_a'
    before.transferUserId = 'user_of_apv_a'
    before.addSignUserIds = ['user_of_apv_a']
    before.addSignUserLabels = { user_of_apv_a: '张三' }
    before.addSignPickerValue = 'user_of_apv_a'
    before.reduceSignUserId = 'user_of_apv_a'
    await flushUi()

    mockRouteParams.id = 'apv_b'
    await flushUi()

    const after = setupState()
    expect(after.actionDialogVisible).toBe(false)
    expect(after.transferDialogVisible).toBe(false)
    expect(after.addSignDialogVisible).toBe(false)
    expect(after.reduceSignDialogVisible).toBe(false)
    expect(after.commentDialogVisible).toBe(false)
    expect(after.returnDialogVisible).toBe(false)
    expect(after.actionComment).toBe('')
    expect(after.actionDialogError).toBeNull()
    expect(after.returnTargetNodeKey).toBe('')
    expect(after.transferUserId).toBe('')
    expect(after.addSignUserIds).toEqual([])
    expect(after.addSignUserLabels).toEqual({})
    expect(after.addSignPickerValue).toBeNull()
    expect(after.reduceSignUserId).toBe('')
  })

  // -------------------------------------------------------------------------
  // Round 3 (B9) — the gate, pinned at EVERY write-verb site rather than at three of them.
  //
  // Round 2 shipped the same `actionInstanceId()` guard at all eight sites but pinned only
  // 通过 (dialog confirm), 评论 (button `disabled`) and 撤回 (popconfirm `@confirm`): reverting the
  // other five to the pre-change `route.params.id` reded nothing anywhere in the approval batch.
  // That is the exact shape this file's own `handleMemberActionFailure` doc records from PR #4983
  // (four hand-copied handlers, one pinned). Each row below is its own test, so removing the guard
  // from ONE site goes red for that site only.
  //
  // The handlers are driven through the component's own setup bindings: in the mid-switch state the
  // template's controls are `disabled`, which is the OTHER half of the gate and is already pinned
  // above — driving the handler directly is what isolates each site's own refusal. The `typeof`
  // assertion is not decoration: an optional call on a missing binding would pass every
  // "nothing was sent" assertion vacuously.
  // -------------------------------------------------------------------------
  const REDUCIBLE_ASSIGNMENT = {
    assigneeId: 'user_add_signed',
    type: 'user',
    isActive: true,
    nodeKey: 'approval_1',
    metadata: { addSign: true, assigneeName: '李四' },
  }

  function actionable(id: string): any {
    return instance(id, { assignments: [REDUCIBLE_ASSIGNMENT] })
  }

  interface WriteVerbSite {
    label: string
    handler: string
    /** Everything the handler's OWN preconditions need, minus the instance gate. */
    prepare: (state: Record<string, any>) => void
    /** What a non-refused call must have produced. */
    assertSent: (id: string) => void
  }

  const WRITE_VERB_SITES: WriteVerbSite[] = [
    {
      label: '通过/驳回 submitAction',
      handler: 'submitAction',
      prepare: (state) => {
        state.currentAction = 'approve'
        state.actionDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('approve')
      },
    },
    {
      label: '转交 submitTransfer',
      handler: 'submitTransfer',
      prepare: (state) => {
        state.transferUserId = 'user_77'
        state.transferDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('transfer')
      },
    },
    {
      label: '加签 submitAddSign',
      handler: 'submitAddSign',
      prepare: (state) => {
        state.addSignUserIds = ['user_77']
        state.addSignDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('add_sign')
      },
    },
    {
      label: '减签 submitReduceSign',
      handler: 'submitReduceSign',
      prepare: (state) => {
        state.reduceSignUserId = REDUCIBLE_ASSIGNMENT.assigneeId
        state.reduceSignDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('reduce_sign')
      },
    },
    {
      label: '评论 submitComment',
      handler: 'submitComment',
      prepare: (state) => {
        state.actionComment = '一条评论'
        state.commentDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('comment')
      },
    },
    {
      label: '退回 submitReturn',
      handler: 'submitReturn',
      prepare: (state) => {
        state.returnTargetNodeKey = 'approval_0'
        state.returnDialogVisible = true
      },
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('return')
      },
    },
    {
      label: '撤回 handleRevoke',
      handler: 'handleRevoke',
      prepare: () => {},
      assertSent: (id) => {
        expect(dispatchActionMock).toHaveBeenCalledTimes(1)
        expect(dispatchActionMock.mock.calls[0][0]).toBe(id)
        expect(dispatchActionMock.mock.calls[0][1].action).toBe('revoke')
      },
    },
    {
      label: '催办 handleRemind',
      handler: 'handleRemind',
      prepare: () => {},
      assertSent: (id) => {
        expect(remindApprovalMock).toHaveBeenCalledTimes(1)
        expect(remindApprovalMock.mock.calls[0][0]).toBe(id)
      },
    },
  ]

  function assertNothingWasSent(): void {
    expect(dispatchActionMock).not.toHaveBeenCalled()
    expect(remindApprovalMock).not.toHaveBeenCalled()
  }

  it.each(WRITE_VERB_SITES.map((site) => [site.label, site] as [string, WriteVerbSite]))(
    'B9 %s: acts on the displayed instance, and refuses once the page has moved to another one',
    async (_label, site) => {
      getApprovalMock.mockImplementation((id: string) => Promise.resolve(actionable(id)))
      await mountView()

      const state = setupState()
      expect(typeof state[site.handler], `${site.handler} must be reachable on the view's setup state`).toBe('function')

      // Positive control — route and displayed instance agree.
      site.prepare(state)
      await flushUi()
      await state[site.handler]()
      await flushUi(12)
      site.assertSent('apv_a')

      // The page has moved: the route says B, and a lagging write leaves A in the shared slot, so
      // the id comparison is the only thing that can refuse (nothing is in flight).
      dispatchActionMock.mockClear()
      remindApprovalMock.mockClear()
      mockRouteParams.id = 'apv_b'
      await flushUi(12)
      const store = useApprovalStore()
      store.activeApproval = actionable('apv_a')
      await flushUi()
      expect(store.detailLoading).toBe(false)
      expect(container!.textContent).toContain('AP-APV_A')

      const moved = setupState()
      site.prepare(moved)
      await flushUi()
      await moved[site.handler]()
      await flushUi(12)
      assertNothingWasSent()
    },
  )

  // Drift alarm for the table above — NOT a behaviour assertion on its own. A ninth verb site added
  // without a row here is exactly how five of the eight sites shipped unpinned in round 2.
  it('B9 census: the table covers every `actionInstanceId()` call site in the view', () => {
    const source = readFileSync(resolve(__dirname, '../src/views/approval/ApprovalDetailView.vue'), 'utf8')
    const callSites = source.match(/^\s*const id = actionInstanceId\(\)$/gm) ?? []
    expect(callSites).toHaveLength(WRITE_VERB_SITES.length)
    expect(new Set(WRITE_VERB_SITES.map((site) => site.handler)).size).toBe(WRITE_VERB_SITES.length)
  })

  // -------------------------------------------------------------------------
  // Round 3 (B10 / B13) — announcement symmetry across a cross-instance switch.
  //
  // Round 2 left the two outcomes asymmetric: a verb that SUCCEEDED for the instance the reader had
  // left still toasted 审批已通过 and flipped the 下一条 offer on the instance now on screen, while a
  // failure landed in a dialog the switch had already closed. Both directions are pinned here, each
  // against its own positive control on the un-switched page.
  // -------------------------------------------------------------------------
  it('B10 success: a verb that succeeds after the switch announces nothing on the incoming instance', async () => {
    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))
    ))
    const pendingAction = deferred<any>()
    dispatchActionMock.mockImplementation(() => pendingAction.promise)

    await mountView()
    const store = useApprovalStore()
    // 下一条 renders only when the list holds another entry, so seed one: without it the DOM oracle
    // below could not fail even if `showNextEntry` did flip.
    store.pendingApprovals = [instance('apv_c')] as any
    await flushUi()

    await approveThroughDialog()
    expect(dispatchActionMock).toHaveBeenCalledWith('apv_a', expect.anything())

    mockRouteParams.id = 'apv_b'
    await flushUi()
    pendingB.resolve(instance('apv_b'))
    await flushUi(12)
    expect(container!.textContent).toContain('AP-APV_B')
    elMessage.success.mockClear()

    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    await flushUi(12)

    expect(elMessage.success).not.toHaveBeenCalled()
    expect(q(container!, 'approval-next-pending')).toBeNull()
    expect(store.error).toBeNull()
    expect(container!.querySelector('[data-el-alert="error"]')).toBeNull()
    expect(store.activeApproval?.id).toBe('apv_b')
  })

  it('B10 positive control: the same verb, un-switched, announces once and offers 下一条', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    const store = useApprovalStore()
    store.pendingApprovals = [instance('apv_c')] as any
    await flushUi()

    await approveThroughDialog()
    await flushUi(12)

    expect(elMessage.success).toHaveBeenCalledTimes(1)
    expect(elMessage.success).toHaveBeenCalledWith('审批已通过')
    expect(q(container!, 'approval-next-pending')).toBeTruthy()
  })

  it('B10 failure: a policy denial for the departed instance is not toasted over the incoming one', async () => {
    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id))
    ))
    const pendingAction = deferred<any>()
    dispatchActionMock.mockImplementation(() => pendingAction.promise)

    await mountView()
    const state = setupState()
    state.transferUserId = 'user_77'
    state.transferDialogVisible = true
    await flushUi()
    const submitted = state.submitTransfer()
    await flushUi()
    expect(dispatchActionMock).toHaveBeenCalledWith('apv_a', expect.objectContaining({ action: 'transfer' }))

    mockRouteParams.id = 'apv_b'
    await flushUi()
    pendingB.resolve(instance('apv_b'))
    await flushUi(12)
    elMessage.error.mockClear()

    const denial: any = new Error('Operation transfer is disabled at this node')
    denial.code = NODE_OPERATION_DISABLED_CODE
    pendingAction.reject(denial)
    await submitted
    await flushUi(12)

    const store = useApprovalStore()
    expect(elMessage.error).not.toHaveBeenCalled()
    expect(setupState().actionDialogError).toBeNull()
    expect(store.error).toBeNull()
    expect(store.activeApproval?.id).toBe('apv_b')
    expect(container!.querySelector('[data-el-alert="error"]')).toBeNull()
  })

  it('B10 positive control: the same policy denial, un-switched, IS toasted and closes its dialog', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    const denial: any = new Error('Operation transfer is disabled at this node')
    denial.code = NODE_OPERATION_DISABLED_CODE
    dispatchActionMock.mockRejectedValue(denial)

    await mountView()
    const state = setupState()
    state.transferUserId = 'user_77'
    state.transferDialogVisible = true
    await flushUi()
    await state.submitTransfer()
    await flushUi(12)

    expect(elMessage.error).toHaveBeenCalledWith(NODE_OPERATION_DISABLED_MESSAGE)
    expect(setupState().transferDialogVisible).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Round 3 (B12) — an instance whose last refresh is known to have failed is read-only.
  //
  // Round 2 deliberately KEEPS such an instance on screen (blanking it turned an ordinary 重新加载
  // into a blank page). What round 2 left behind is that every write control stayed live over the
  // error banner, dispatching against data of unknown freshness.
  // -------------------------------------------------------------------------
  it('B12: a same-id reload failure refuses the write verbs until a retry succeeds', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    const approveButton = () => q(container!, 'approval-approve-button') as HTMLButtonElement
    expect(approveButton().disabled).toBe(false)

    const store = useApprovalStore()
    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    await flushUi()

    // The instance the reader was on is still rendered — what is refused is ACTING on it.
    expect(container!.textContent).toContain('AP-APV_A')
    expect(container!.querySelector('[data-el-alert="error"]')).toBeTruthy()
    expect(approveButton().disabled).toBe(true)
    expect((q(container!, 'approval-comment-button') as HTMLButtonElement).disabled).toBe(true)
    expect((q(container!, 'approval-revoke-button') as HTMLButtonElement).disabled).toBe(true)

    // A retry that fails AGAIN keeps them refused — this is a state, not a one-shot.
    getApprovalMock.mockRejectedValueOnce(new Error('该审批暂时无法加载'))
    await store.loadDetail('apv_a')
    await flushUi()
    expect(approveButton().disabled).toBe(true)

    // The popconfirm's own @confirm, which no `disabled` binding reaches, refuses too.
    q(container!, 'popconfirm-confirm-trigger')!.click()
    await flushUi()
    expect(dispatchActionMock).not.toHaveBeenCalled()

    // A successful retry re-enables them, and the same affordance now dispatches.
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await store.loadDetail('apv_a')
    await flushUi()
    expect(approveButton().disabled).toBe(false)
    expect(container!.querySelector('[data-el-alert="error"]')).toBeNull()

    q(container!, 'popconfirm-confirm-trigger')!.click()
    await flushUi(12)
    expect(dispatchActionMock).toHaveBeenCalledTimes(1)
    expect(dispatchActionMock.mock.calls[0][0]).toBe('apv_a')
  })

  // -------------------------------------------------------------------------
  // Round 3 (B8, through the view) — the construction that made the verb's own result vanish.
  // -------------------------------------------------------------------------
  // The reported construction, end to end and with no synthetic store poking beyond the api fakes:
  // a verb is in flight, the TIMELINE fetch for the same instance fails, the reader clicks the error
  // banner's 重新加载, and that read comes back with the pre-action row. Round 2 discarded the verb's
  // own response here (any same-id load took a newer generation), so 审批已通过 was announced over a
  // page still showing 待处理 with the action bar live.
  it('B8: a 重新加载 during a verb does not cost the verb its own result on the page', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id)))
    await mountView()
    const store = useApprovalStore()

    const pendingAction = deferred<any>()
    dispatchActionMock.mockImplementation(() => pendingAction.promise)
    await approveThroughDialog()
    expect(dispatchActionMock).toHaveBeenCalledWith('apv_a', expect.anything())

    // The timeline refresh for the SAME instance fails while the verb is still outstanding.
    getApprovalHistoryMock.mockRejectedValueOnce(new Error('加载审批历史失败'))
    await store.loadHistory('apv_a')
    await flushUi()
    const banner = container!.querySelector('[data-el-alert="error"]')
    expect(banner).toBeTruthy()

    // The reader clicks 重新加载 in that banner; the detail read it fires is served BEFORE the
    // action commits, so it carries the pre-action row.
    getApprovalMock.mockResolvedValueOnce(instance('apv_a', { status: 'pending' }))
    getApprovalHistoryMock.mockResolvedValueOnce([])
    ;(banner!.querySelector('button') as HTMLButtonElement).click()
    await flushUi(12)
    expect(store.activeApproval?.status).toBe('pending')
    expect(store.detailLoading).toBe(false)

    pendingAction.resolve(instance('apv_a', { status: 'approved' }))
    await flushUi(12)

    // One success announcement, and the page it is announced over agrees with it.
    expect(elMessage.success).toHaveBeenCalledTimes(1)
    expect(elMessage.success).toHaveBeenCalledWith('审批已通过')
    expect(store.activeApproval?.status).toBe('approved')
    expect(container!.textContent).toContain('该审批已结束')
  })
})
