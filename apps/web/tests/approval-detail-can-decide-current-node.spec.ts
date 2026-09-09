import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// ApprovalDetailView — viewer-scoped decision affordance (2026-09-07).
//
// The action bar's six decision verbs used to render on `canAct` alone — the COARSE global
// `approvals:act` grant, which says "this reader may act on approvals somewhere", not "the server
// will accept a decision on THIS instance from this reader". The server now answers the narrower
// question itself (`canDecideCurrentNode`, resolved by the dispatch door's own seat predicate) and
// the bar reads that answer.
//
// These tests drive the REAL view against a faked api layer and pin, in the mounted DOM:
//
//   * `true`  → all six verbs render, exactly as before;
//   * `false` → none of them render, while `canAct` is still true;
//   * ABSENT  → all six render (older backend ⇒ today's behaviour; absence must never read as deny);
//   * `canAct` false still hides them even when the server says the seat is there — `canAct`
//     semantics are unchanged, the new field is an additional conjunct;
//   * the #5528 instance-consistency gate is untouched and still applies on top;
//   * 评论 / 撤回 / 催一下 are NOT gated by this field (they never carried `canAct` either) — a
//     disclosure pinned as behaviour rather than left in prose.
//
// Scaffold follows approval-detail-instance-consistency.spec.ts (real ApprovalDetailView + a broad
// Element Plus stub set + the real store, only the api layer faked).
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

const mockHasFeature = vi.fn().mockReturnValue(false)
const mockIsMobile = ref(false)
const mockProductFeatures = ref<Record<string, unknown>>({})
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: (flag: string) => mockHasFeature(flag), features: mockProductFeatures }),
}))
vi.mock('../src/composables/useMobileViewport', () => ({
  useMobileViewport: () => ({ isMobile: mockIsMobile, updateMobileState: () => {} }),
}))

const mockCanAct = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

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
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean, link: Boolean },
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
  emits: ['close'],
  render() {
    return h('div', { 'data-el-alert': this.type || 'default' }, [this.title, this.$slots.default?.()] as any)
  },
})
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm'],
  render() {
    return h('div', { 'data-el-popconfirm': this.title }, [this.$slots.reference?.()])
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
const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, type: String, rows: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('textarea', {
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
  const promise = new Promise<T>((res) => { resolvePromise = res })
  return { promise, resolve: resolvePromise }
}

/**
 * The reader is a seat holder at the current node with an add-signed colleague beside them, and the
 * instance has already visited another node — the shape in which ALL SIX verbs are otherwise
 * eligible, so a missing button in these tests is this field talking and nothing else.
 */
function instance(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `审批 ${id}`,
    status: 'pending',
    templateId: null,
    requester: { id: 'user_requester', name: '张三' },
    requestNo: `AP-${id.toUpperCase()}`,
    currentStep: 2,
    totalSteps: 2,
    currentNodeKey: 'approval_2',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [
      { id: 'as_1', type: 'user', assigneeId: 'user_99', nodeKey: 'approval_2', isActive: true, metadata: {} },
      { id: 'as_2', type: 'user', assigneeId: 'user_co', nodeKey: 'approval_2', isActive: true, metadata: { addSign: true } },
    ],
    ...overrides,
  }
}

const HISTORY = [
  {
    id: 'h_1',
    action: 'approve',
    actorId: 'user_prev',
    actorName: '前一位',
    comment: null,
    fromStatus: 'pending',
    toStatus: 'pending',
    occurredAt: '2026-09-01T10:05:00.000Z',
    metadata: { nodeKey: 'approval_1' },
  },
]

/** Every decision verb the server gates with the same seat predicate and the view renders here. */
const DECISION_BUTTONS = [
  'approval-approve-button',
  'approval-reject-button',
  'approval-return-button',
  'approval-transfer-button',
  'approval-add-sign-button',
  'approval-reduce-sign-button',
] as const

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function renderedDecisionButtons(container: HTMLElement): string[] {
  return DECISION_BUTTONS.filter((testid) => q(container, testid) !== null)
}

describe('ApprovalDetailView — canDecideCurrentNode gates the decision verbs', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    mockRouteParams.id = 'apv_a'
    mockCanAct.value = true
    mockIsMobile.value = false
    mockHasFeature.mockReset()
    mockHasFeature.mockReturnValue(false)
    mockProductFeatures.value = {}
    markApprovalReadMock.mockClear()
    getApprovalMock.mockReset()
    getApprovalHistoryMock.mockReset()
    getApprovalHistoryMock.mockResolvedValue(HISTORY)
    dispatchActionMock.mockReset()
    dispatchActionMock.mockImplementation((id: string) => Promise.resolve(instance(id, { status: 'approved' })))
    remindApprovalMock.mockReset()
    remindApprovalMock.mockResolvedValue({ ok: true, data: {} })
    elMessage.success.mockClear()
    elMessage.warning.mockClear()
    elMessage.error.mockClear()
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

  async function mountWith(canDecideCurrentNode: boolean | undefined) {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(
      canDecideCurrentNode === undefined
        ? instance(id)
        : instance(id, { canDecideCurrentNode }),
    ))
    await mountView()
    expect(container!.textContent).toContain('AP-APV_A')
  }

  it('positive control: with the server saying true, every decision verb renders and is enabled', async () => {
    await mountWith(true)
    expect(renderedDecisionButtons(container!)).toEqual([...DECISION_BUTTONS])
    for (const testid of DECISION_BUTTONS) {
      expect((q(container!, testid) as HTMLButtonElement).disabled, testid).toBe(false)
    }
  })

  it('with the server saying false, NO decision verb renders — even though canAct is true', async () => {
    await mountWith(false)
    expect(mockCanAct.value).toBe(true)
    expect(renderedDecisionButtons(container!)).toEqual([])
  })

  it('with the field ABSENT (older backend) every decision verb renders, exactly as before this change', async () => {
    await mountWith(undefined)
    // Absence is "this server does not compute it", never "deny". Read as `!== false`, so the
    // fallback is today's behaviour and an old server does not lose its action bar.
    expect(renderedDecisionButtons(container!)).toEqual([...DECISION_BUTTONS])
  })

  it('canAct is still required: the server saying true does not surface the verbs for a reader without the grant', async () => {
    mockCanAct.value = false
    await mountWith(true)
    expect(renderedDecisionButtons(container!)).toEqual([])
  })

  it('the instance-consistency gate still applies on top: mid-switch, a true field surfaces nothing', async () => {
    await mountWith(true)
    expect(renderedDecisionButtons(container!)).toEqual([...DECISION_BUTTONS])

    // Navigate to an instance whose detail response has not landed yet. The #5528 gate owns this
    // refusal; the new conjunct must not have replaced it.
    const pendingB = deferred<any>()
    getApprovalMock.mockImplementation((id: string) => (
      id === 'apv_b' ? pendingB.promise : Promise.resolve(instance(id, { canDecideCurrentNode: true }))
    ))
    mockRouteParams.id = 'apv_b'
    await flushUi()
    expect(renderedDecisionButtons(container!)).toEqual([])

    pendingB.resolve(instance('apv_b', { canDecideCurrentNode: true }))
    await flushUi()
    expect(renderedDecisionButtons(container!)).toEqual([...DECISION_BUTTONS])
  })

  it('评论 is NOT gated by this field — it never carried canAct either, so its reach is unchanged', async () => {
    // Disclosed on purpose: the server gates the `comment` action with the SAME seat predicate, but
    // the button has never been gated on `canAct` here, so adding the conjunct would take the
    // affordance away from requesters and CC readers. That is a separate UX decision, not this
    // slice's — pinned here so a later change to it is deliberate rather than incidental.
    await mountWith(false)
    expect(renderedDecisionButtons(container!)).toEqual([])
    expect(q(container!, 'approval-comment-button')).toBeTruthy()
  })

  it('撤回 and 催一下 stay with the requester and are unaffected by this field', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(instance(id, {
      canDecideCurrentNode: false,
      requester: { id: 'user_99', name: '我' },
    })))
    await mountView()
    expect(renderedDecisionButtons(container!)).toEqual([])
    expect(q(container!, 'approval-revoke-button')).toBeTruthy()
    expect(q(container!, 'approval-remind-button')).toBeTruthy()
  })

  it('a closed instance shows the ended notice, whatever the field says', async () => {
    getApprovalMock.mockImplementation((id: string) => Promise.resolve(
      instance(id, { status: 'approved', canDecideCurrentNode: true }),
    ))
    await mountView()
    expect(renderedDecisionButtons(container!)).toEqual([])
    expect(container!.textContent).toContain('该审批已结束')
  })

  it('fixture control: the six verbs are eligible for other reasons in this fixture, so a missing button is this field', async () => {
    // Without this, "no buttons rendered" could mean the fixture simply failed the OTHER conditions
    // (返回 needs a visited node, 减签 needs an add-signed seat, and both need the desktop layout).
    await mountWith(true)
    expect(mockIsMobile.value).toBe(false)
    expect(renderedDecisionButtons(container!)).toHaveLength(DECISION_BUTTONS.length)
  })
})
