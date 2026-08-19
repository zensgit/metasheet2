import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Gate finding P2-R1 on PR #4983: this file's first mounted test needs ~9.8s wall inside the
// 26-file canary block (dynamic `import()` of ApprovalDetailView.vue + a full mount), against
// vitest's 5s default — so it went red in 2 of 3 block runs while the base 25-file block was green
// twice. It is wired into BOTH `run-required-web-tests.sh` and `approval-web-guard`, so that would
// have flaked the REQUIRED web lane on main. The cascade made it worse: a timed-out test never
// unmounts its app, and the next test then warns "There is already an app instance mounted".
vi.setConfig({ testTimeout: 15_000 })
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'

/**
 * Lock-5 gate A-2 (FE door) + gate CR-3 (detail dialog) — the MEMBER action bar.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §0.1 (the actor gate
 * row), §1.3, §2.3, gates A-2 and CR-3.
 *
 * ### What this file is the OTHER HALF of
 *
 * §2.3: "UI hiding and server refusal are two doors and must be proved independently… the gate must
 * neuter each separately and see a distinct named failure: hide-only leaves a direct-HTTP bypass,
 * deny-only leaves a button that always errors, and one test asserting 'hidden and denied' proves
 * nothing about door-level exclusivity."
 *
 * The SERVER door is proved in `packages/core-backend/tests/integration/approval-node-operation-policy.db.test.ts`
 * ("A-1/A-2 (server door): a direct HTTP call with no UI involved is refused"), which stays green if
 * this file is deleted. THIS file is the FE door: it renders the real `ApprovalDetailView` and
 * asserts the affordance itself disappears — and it stays green if the server check is neutered,
 * because the values come from the DTO. Neither test can pass for the other's reason.
 *
 * ### The derivation is NOT a second predicate
 *
 * The flags are RESOLVED SERVER-SIDE (`nodeOperations`, actor-seat-scoped, most-restrictive across
 * seats) and merely rendered here. §2.3 requires exactly that: the FE mirror derives from the SAME
 * config the server enforces. The fixtures below therefore set `nodeOperations` — the shape the
 * server actually ships — rather than re-deriving from a node config the FE never sees.
 *
 * ### Absent ≡ ALLOWED
 *
 * OD-L5-3(a), and the OPPOSITE of `allowRevoke`'s `=== true` fail-closed idiom in the same
 * component. The "no carrier at all" cases below are the regression guard for that inversion: a
 * bridged instance, a legacy instance and a seatless viewer must keep every affordance they have
 * today, not lose the whole bar.
 */

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

// The real picker is imported directly by the view (not resolved globally), so it must be mocked
// rather than stubbed via `app.component`. It exposes a button that emits the id the handler needs —
// without a target, `submitTransfer` early-returns and the catch path is unreachable.
vi.mock('../src/approvals/components/ApprovalUserPicker.vue', () => ({
  default: {
    name: 'ApprovalUserPicker',
    props: ['modelValue', 'placeholder'],
    emits: ['update:modelValue', 'select'],
    setup(_props: unknown, { emit }: { emit: (e: string, v: unknown) => void }) {
      return () => h('button', {
        'data-testid': 'stub-user-picker',
        onClick: () => { emit('update:modelValue', 'user_target'); emit('select', { id: 'user_target', name: 'T' }) },
      }, 'pick')
    },
  },
}))

// member-display-identity (2026-08-19): `resolveApprovalDirectoryUsersMock` defaults to "nothing
// resolves" (matches this file's pre-existing raw-id-shaped fixtures, which have zero producers of
// `metadata.assigneeName`) — tests that need a resolvable name override it per-test.
const resolveApprovalDirectoryUsersMock = vi.fn().mockResolvedValue([])
vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  resolveApprovalDirectoryUsers: (...args: unknown[]) => resolveApprovalDirectoryUsersMock(...args),
}))

const mockCurrentUserId = ref<string | null>('user_1')
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
const executeActionSpy = vi.fn()

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    get pendingApprovals() { return [] },
    loadDetail: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue(undefined),
    executeAction: executeActionSpy,
  }),
}))

function stub(name: string) {
  return defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', { 'data-stub': name }, slots.default ? slots.default() : [])
    },
  })
}

const ElButton = defineComponent({
  name: 'ElButton',
  props: { loading: Boolean, disabled: Boolean, type: String, plain: Boolean, size: String },
  emits: ['click'],
  setup(props, { slots, emit, attrs }) {
    return () => h('button', {
      ...attrs,
      disabled: props.disabled || props.loading,
      'data-loading': props.loading ? 'true' : 'false',
      onClick: (e: Event) => emit('click', e),
    }, slots.default ? slots.default() : [])
  },
})

const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  setup(_props, { slots }) {
    return () => h('div', { 'data-stub': 'ElPopconfirm' }, [
      slots.reference ? slots.reference() : null,
    ])
  },
})

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String },
  setup(props, { slots }) {
    return () => h('div', {
      'data-el-dialog': props.title,
      'data-dialog-visible': props.modelValue ? 'true' : 'false',
    }, [
      ...(slots.default ? slots.default() : []),
      ...(slots.footer ? slots.footer() : []),
    ])
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, type: String, rows: Number },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () => h('input', {
      ...attrs,
      value: props.modelValue,
      placeholder: props.placeholder,
      onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Number, null] as never, placeholder: String, filterable: Boolean },
  emits: ['update:modelValue'],
  setup(props, { slots, emit, attrs }) {
    return () => h('select', {
      ...attrs,
      'data-el-select': 'true',
      value: props.modelValue ?? '',
      onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value),
    }, slots.default ? slots.default() : [])
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: [String, Number] as never, value: [String, Number] as never },
  setup(props) {
    return () => h('option', { value: String(props.value ?? '') }, String(props.label ?? props.value ?? ''))
  },
})

const ElFormItem = defineComponent({
  name: 'ElFormItem',
  props: { label: String },
  setup(props, { slots }) {
    return () => h('div', { 'data-el-form-item-label': props.label }, slots.default ? slots.default() : [])
  },
})

const stubDirective = { mounted() { /* noop */ }, updated() { /* noop */ } }

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * A pending instance where `user_1` holds the current seat, plus a previously add-signed row so 减签
 * is visible, plus a history entry at a DIFFERENT node so `returnableNodes` is non-empty and 退回 is
 * visible. Without those two, 减签/退回 would be hidden for reasons UNRELATED to the policy and the
 * gate would be green against nothing.
 */
function baseInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'apv_1',
    title: '出差报销',
    status: 'pending',
    templateId: 'tpl_1',
    requester: { id: 'user_99', name: '张三' },
    requestNo: 'AP-100001',
    currentStep: 2,
    totalSteps: 3,
    currentNodeKey: 'approval_2',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [
      { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
      // member-display-identity (2026-08-19): `assigneeName` present -- this fixture's seat is
      // RESOLVABLE, matching the ordinary production case. The deliberately-UNRESOLVABLE 减签
      // shape (raw-id, `metadata: {}`) lives in this file's OWN dedicated `reduceSignInstance()`
      // fixture below, whose whole point is to be unresolvable for the disabled/refused-submit
      // negative tests -- this shared base fixture must not accidentally collide with that.
      { id: 'as_2', type: 'user', assigneeId: 'user_7', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true, assigneeName: '七号审批人' } },
    ],
    ...overrides,
  }
}

const ALL_ALLOWED = {
  allowTransfer: true,
  allowAddSign: true,
  allowReduceSign: true,
  allowReturn: true,
  commentRequired: 'reject_only' as const,
}

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

describe('Lock-5 A-2 (FE door) — the member bar mirrors the per-node operation policy', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    // A visited node so `returnableNodes` is non-empty (the 退回 button's OTHER gate).
    mockHistory.value = [{ id: 'h1', action: 'approve', metadata: { nodeKey: 'approval_1' } }]
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    resolveApprovalDirectoryUsersMock.mockReset().mockResolvedValue([])
    __resetResolvedDirectoryNamesForTests()
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
    for (const name of [
      'ElDivider', 'ElEmpty', 'ElTable', 'ElTableColumn', 'ElTimeline', 'ElTimelineItem',
      'ElForm', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElAlert',
    ]) {
      app.component(name, stub(name))
    }
    app.component('ElButton', ElButton)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElDialog', ElDialog)
    app.component('ElInput', ElInput)
    app.component('ElFormItem', ElFormItem)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  const VERBS = [
    { key: 'allowTransfer', testid: 'approval-transfer-button', label: '转交' },
    { key: 'allowAddSign', testid: 'approval-add-sign-button', label: '加签' },
    { key: 'allowReduceSign', testid: 'approval-reduce-sign-button', label: '减签' },
    { key: 'allowReturn', testid: 'approval-return-button', label: '退回' },
  ] as const

  it('POSITIVE CONTROL: with every flag allowed, all four deferred affordances render', async () => {
    // Without this, every "hidden" assertion below would be green against a bar that never renders
    // those buttons at all (wrong seat, empty history, mobile layout, …).
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
    await mountView()
    for (const verb of VERBS) {
      expect(q(container!, verb.testid), `${verb.label} should render when allowed`).toBeTruthy()
    }
  })

  it('each flag hides EXACTLY its own affordance — one flag flipped at a time (verb-selected)', async () => {
    // Iterated over the same table the server's `ACTION_POLICY_KEYS` partitions, so a fifth gated
    // verb cannot be added without appearing here.
    for (const target of VERBS) {
      if (app) { app.unmount(); app = null }
      if (container) { container.remove() }
      container = document.createElement('div')
      document.body.appendChild(container)

      mockActiveApproval.value = baseInstance({
        nodeOperations: { ...ALL_ALLOWED, [target.key]: false },
      })
      await mountView()

      expect(q(container!, target.testid), `${target.label} must be hidden when ${target.key}=false`).toBeNull()
      for (const other of VERBS) {
        if (other.key === target.key) continue
        expect(q(container!, other.testid), `${other.label} must stay visible when only ${target.key} is false`).toBeTruthy()
      }
      // The never-switchable verbs are untouched (§1.1 Scope): a node whose approver may not decide
      // is not an approval node.
      expect(q(container!, 'approval-approve-button')).toBeTruthy()
      expect(q(container!, 'approval-reject-button')).toBeTruthy()
      expect(q(container!, 'approval-comment-button')).toBeTruthy()
    }
  })

  it('ABSENT ≡ ALLOWED: no carrier at all keeps every affordance (the OD-L5-3(a) inversion guard)', async () => {
    // A bridged/legacy instance, or an older server, ships no `nodeOperations`. Copying the sibling
    // `allowRevoke === true` fail-closed idiom would hide the entire deferred set here.
    for (const carrier of [undefined, null]) {
      if (app) { app.unmount(); app = null }
      if (container) { container.remove() }
      container = document.createElement('div')
      document.body.appendChild(container)

      mockActiveApproval.value = baseInstance({ nodeOperations: carrier })
      await mountView()
      for (const verb of VERBS) {
        expect(q(container!, verb.testid), `${verb.label} with carrier=${String(carrier)}`).toBeTruthy()
      }
    }
  })

  it('the policy does NOT resurrect an affordance whose OTHER gate is closed (gates compose, never replace)', async () => {
    // 退回 additionally needs a visited node, and 减签 additionally needs an add-signed row. An
    // ALLOWED policy must not override those — otherwise the mirror would widen the bar rather than
    // narrow it.
    mockHistory.value = []
    mockActiveApproval.value = baseInstance({
      nodeOperations: { ...ALL_ALLOWED },
      assignments: [
        { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
      ],
    })
    await mountView()
    expect(q(container!, 'approval-return-button')).toBeNull()
    expect(q(container!, 'approval-reduce-sign-button')).toBeNull()
    // …while the two with no extra gate still render, so this is not a dead fixture.
    expect(q(container!, 'approval-transfer-button')).toBeTruthy()
    expect(q(container!, 'approval-add-sign-button')).toBeTruthy()
  })

  it('canAct=false still hides everything even with every flag allowed (the existing RBAC gate is intact)', async () => {
    mockCanAct.value = false
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
    await mountView()
    for (const verb of VERBS) {
      expect(q(container!, verb.testid)).toBeNull()
    }
  })
})

describe('Lock-5 §2.3 residual repair — a policy denial says so, and stops inviting a retry', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockHistory.value = []
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    resolveApprovalDirectoryUsersMock.mockReset().mockResolvedValue([])
    __resetResolvedDirectoryNamesForTests()
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
    for (const name of [
      'ElDivider', 'ElEmpty', 'ElTable', 'ElTableColumn', 'ElTimeline', 'ElTimelineItem',
      'ElForm', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElAlert',
    ]) {
      app.component(name, stub(name))
    }
    app.component('ElButton', ElButton)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElDialog', ElDialog)
    app.component('ElInput', ElInput)
    app.component('ElFormItem', ElFormItem)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // Adversarial-gate finding P2-3 on PR #4980: the four deferred-verb handlers used a BARE
  // `catch {`, discarding the server's code and rendering `…失败，请重试` with the dialog left OPEN.
  // With the per-node policy live that is routine, and every invited retry mints another
  // `policy_denied` row that D-3 hides.
  //
  // The first two tests are PURE assertions over the classifier. They are NOT sufficient on their
  // own: gate finding P2-3 on PR #4983 showed that reverting all four handlers to the bare-`catch`
  // shape reded NOTHING, because `vue-tsc` proves neither that `ElMessage.error(failure.message)` is
  // called nor that `*DialogVisible.value = false` runs. The MOUNTED tests that follow close that —
  // they drive the real handler through a rejected `executeAction` carrying the policy code.
  it('a policy 409 produces honest copy with NO retry invitation, and flags the dialog to close', async () => {
    const { memberActionFailure, NODE_OPERATION_DISABLED_MESSAGE } =
      await import('../src/approvals/memberActionErrorCopy')
    const denial = Object.assign(new Error('Operation transfer is disabled at this node'), {
      status: 409,
      code: 'APPROVAL_NODE_OPERATION_DISABLED',
    })
    const result = memberActionFailure(denial, '转交失败，请重试')
    expect(result.isPolicyDenial).toBe(true)
    expect(result.message).toBe(NODE_OPERATION_DISABLED_MESSAGE)
    // The whole point: no retry invitation on a permanently-refused operation.
    expect(result.message).not.toContain('请重试')
    // §2.4 values-free: the fixed string interpolates nothing from the server payload.
    expect(result.message).not.toContain('transfer')
    expect(result.message).not.toContain('approval_')
  })

  it('WIRING (mounted): a policy 409 through the REAL transfer handler surfaces the honest copy AND closes the dialog', async () => {
    // MUTATION M-C: revert `submitTransfer` to `} catch { ElMessage.error('转交失败，请重试') }` and
    // this test reds on BOTH assertions (copy + dialog state).
    const { NODE_OPERATION_DISABLED_MESSAGE } = await import('../src/approvals/memberActionErrorCopy')
    const { ElMessage } = await import('element-plus')
    const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
    try {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      // The server refuses even though the mirror says allowed — exactly the race/stale-config case
      // the two-door design exists for, and the only way the handler path is reachable at all.
      executeActionSpy.mockRejectedValue(Object.assign(new Error('Operation transfer is disabled at this node'), {
        status: 409,
        code: 'APPROVAL_NODE_OPERATION_DISABLED',
      }))
      await mountView()

      ;(q(container!, 'approval-transfer-button') as HTMLButtonElement).click()
      await flushUi()
      const dialog = container!.querySelector('[data-el-dialog="转交审批"]') as HTMLElement
      expect(dialog).toBeTruthy()
      expect(dialog.getAttribute('data-dialog-visible')).toBe('true')
      // `submitTransfer` early-returns without a target, so the catch path needs a real pick first.
      ;(dialog.querySelector('[data-testid="stub-user-picker"]') as HTMLButtonElement).click()
      await flushUi()

      ;(q(container!, 'approval-transfer-submit') as HTMLButtonElement).click()
      await flushUi(12)

      // (a) the honest copy reached the user…
      expect(errorSpy).toHaveBeenCalledWith(NODE_OPERATION_DISABLED_MESSAGE)
      expect(errorSpy).not.toHaveBeenCalledWith('转交失败，请重试')
      // (b) …and the dialog CLOSED, so the retry affordance is gone.
      expect(
        (container!.querySelector('[data-el-dialog="转交审批"]') as HTMLElement).getAttribute('data-dialog-visible'),
      ).toBe('false')
    } finally {
      errorSpy.mockRestore()
    }
  })

  // Gate finding P3-R1 on #4983: pinning only `submitTransfer` left the other three handlers
  // unpinned — neutering `submitReturn` alone reded NOTHING. The four now route through ONE
  // `handleMemberActionFailure`, but factoring alone is not a gate: a single call site can still be
  // neutered. So EVERY verb gets its own pin, and neutering ANY ONE of them reds a NAMED test.
  const DENIAL_VERBS = [
    { verb: 'transfer', open: 'approval-transfer-button', submit: 'approval-transfer-submit', dialog: '转交审批' },
    { verb: 'add_sign', open: 'approval-add-sign-button', submit: 'approval-add-sign-submit', dialog: '加签' },
    { verb: 'reduce_sign', open: 'approval-reduce-sign-button', submit: 'approval-reduce-sign-submit', dialog: '减签' },
    { verb: 'return', open: 'approval-return-button', submit: 'approval-return-submit', dialog: '退回审批' },
  ] as const

  for (const target of DENIAL_VERBS) {
    it(`WIRING (mounted, per-verb): ${target.verb} — a policy 409 shows the honest copy AND closes its dialog`, async () => {
      const { NODE_OPERATION_DISABLED_MESSAGE } = await import('../src/approvals/memberActionErrorCopy')
      const { ElMessage } = await import('element-plus')
      const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
      try {
        // A visited node + an add-signed seat so 退回 and 减签 are reachable at all.
        mockHistory.value = [{ id: 'h1', action: 'approve', metadata: { nodeKey: 'approval_1' } }]
        mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
        executeActionSpy.mockRejectedValue(Object.assign(new Error('disabled at this node'), {
          status: 409,
          code: 'APPROVAL_NODE_OPERATION_DISABLED',
        }))
        await mountView()

        ;(q(container!, target.open) as HTMLButtonElement).click()
        await flushUi()
        const dialog = container!.querySelector(`[data-el-dialog="${target.dialog}"]`) as HTMLElement
        expect(dialog, `${target.verb} dialog`).toBeTruthy()
        expect(dialog.getAttribute('data-dialog-visible')).toBe('true')

        // Each handler early-returns without its own precondition, so satisfy it — otherwise the
        // catch path is unreachable and the test would be green against nothing.
        const picker = dialog.querySelector('[data-testid="stub-user-picker"]') as HTMLButtonElement | null
        if (picker) { picker.click(); await flushUi() }
        const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement | null
        if (select) {
          const option = select.querySelector('option') as HTMLOptionElement | null
          expect(option, `${target.verb} needs a selectable option`).toBeTruthy()
          select.value = option!.value
          select.dispatchEvent(new Event('change', { bubbles: true }))
          await flushUi()
        }

        ;(q(container!, target.submit) as HTMLButtonElement).click()
        await flushUi(12)

        // The handler REALLY ran (otherwise a precondition silently blocked it and this pin is void).
        expect(executeActionSpy, `${target.verb} handler must have dispatched`).toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalledWith(NODE_OPERATION_DISABLED_MESSAGE)
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('请重试'))
        expect(
          (container!.querySelector(`[data-el-dialog="${target.dialog}"]`) as HTMLElement).getAttribute('data-dialog-visible'),
          `${target.verb} dialog must close on a policy denial`,
        ).toBe('false')
      } finally {
        errorSpy.mockRestore()
      }
    })
  }

  it('WIRING (mounted) POSITIVE CONTROL: a NON-policy failure keeps the dialog OPEN', async () => {
    // Without this, "dialog closed" above could be green against a handler that closes on ANY error.
    const { ElMessage } = await import('element-plus')
    const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
    try {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      executeActionSpy.mockRejectedValue(Object.assign(new Error('目标用户不存在'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      }))
      await mountView()
      ;(q(container!, 'approval-transfer-button') as HTMLButtonElement).click()
      await flushUi()
      ;(container!.querySelector('[data-testid="stub-user-picker"]') as HTMLButtonElement).click()
      await flushUi()
      ;(q(container!, 'approval-transfer-submit') as HTMLButtonElement).click()
      await flushUi(12)

      const dialog = container!.querySelector('[data-el-dialog="转交审批"]') as HTMLElement
      expect(dialog.getAttribute('data-dialog-visible')).toBe('true')
      expect(errorSpy).toHaveBeenCalledWith('目标用户不存在')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('POSITIVE CONTROL: any OTHER failure surfaces the SERVER\'s message and leaves the dialog open', async () => {
    const { memberActionFailure } = await import('../src/approvals/memberActionErrorCopy')
    // P3-1 (gate finding on #4983): the earlier title said "keeps the shipped retry copy", which was
    // FALSE — `memberActionFailure` returns `error.message` for ANY `Error` with a message, so a
    // non-policy failure now surfaces the SERVER's own text (which may be internal English). The
    // caller's `fallback` is used ONLY for a message-less / non-`Error` throw. Title and assertions
    // corrected to match the code.
    const other = Object.assign(new Error('目标用户不存在'), { status: 400, code: 'VALIDATION_ERROR' })
    const typed = memberActionFailure(other, '转交失败，请重试')
    expect(typed.isPolicyDenial).toBe(false)
    expect(typed.message).toBe('目标用户不存在')

    // A non-Error throw → the caller's generic copy, never a blank toast.
    const bare = memberActionFailure({}, '转交失败，请重试')
    expect(bare.isPolicyDenial).toBe(false)
    expect(bare.message).toBe('转交失败，请重试')

    // A 409 that is NOT the policy code must not be misclassified as a denial.
    const otherConflict = Object.assign(new Error('nope'), { status: 409, code: 'APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED' })
    expect(memberActionFailure(otherConflict, 'x').isPolicyDenial).toBe(false)
  })
})

// -----------------------------------------------------------------------------------------------
// raw-id-exposure-fix (2026-08-19) — `reducibleAssignees` (ApprovalDetailView.vue, the 减签 picker
// backing the `<el-option v-for="assignee in reducibleAssignees" ... :label="assignee.label"
// :value="assignee.assigneeId" />` list) used to push `label: assignment.assigneeId` verbatim — the
// picker showed the raw internal user id as its visible option text. `metadata.assigneeName` has
// zero producers repo-wide (grep-confirmed), so that was the ORDINARY path, not an exotic shape.
// Reuses THIS file's own real ElSelect/ElOption stubs (unlike the generic no-text div stub used
// elsewhere in the approval spec suite) so option text is actually queryable, and this file's own
// mount scaffold + `baseInstance()`/`ALL_ALLOWED` fixtures so 减签 is reachable exactly as the
// sibling describe blocks above already prove it is.
// -----------------------------------------------------------------------------------------------
describe('raw-id-exposure-fix (20260819) — the 减签 picker never renders a raw assigneeId', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockHistory.value = []
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    resolveApprovalDirectoryUsersMock.mockReset().mockResolvedValue([])
    __resetResolvedDirectoryNamesForTests()
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
    for (const name of [
      'ElDivider', 'ElEmpty', 'ElTable', 'ElTableColumn', 'ElTimeline', 'ElTimelineItem',
      'ElForm', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElAlert',
    ]) {
      app.component(name, stub(name))
    }
    app.component('ElButton', ElButton)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElDialog', ElDialog)
    app.component('ElInput', ElInput)
    app.component('ElFormItem', ElFormItem)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // Two previously add-signed, still-active seats at the current node — reducible per the backend
  // `reduce_sign` `removable` predicate (INV-2) — both `metadata: {}` (no `assigneeName`, the
  // ordinary shape today) with raw-id-shaped ids.
  function reduceSignInstance(): any {
    return baseInstance({
      nodeOperations: { ...ALL_ALLOWED },
      assignments: [
        { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
        { id: 'as_2', type: 'user', assigneeId: 'user_9', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true } },
        { id: 'as_3', type: 'user', assigneeId: 'user_42', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true } },
      ],
    })
  }

  it('discriminating negative: the picker options never render a raw assigneeId, and stay mutually distinguishable', async () => {
    mockActiveApproval.value = reduceSignInstance()
    await mountView()

    ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog="减签"]') as HTMLElement
    expect(dialog).toBeTruthy()
    const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const options = Array.from(select.querySelectorAll('option')) as HTMLOptionElement[]
    expect(options).toHaveLength(2)

    // Neither option's VISIBLE text is the raw internal id.
    for (const option of options) {
      expect(option.textContent).not.toContain('user_9')
      expect(option.textContent).not.toContain('user_42')
    }
    // The two options stay mutually distinguishable — a stable per-list ordinal, not a single
    // repeated generic label an admin couldn't use to tell which seat they're removing.
    const labels = options.map((o) => o.textContent?.trim())
    expect(labels).toEqual(['成员 1', '成员 2'])
    expect(new Set(labels).size).toBe(2)

    // `assigneeId` is still the option VALUE — the real submit payload — even though the raw id is
    // never SHOWN. Proves the fix keeps the wire contract, not just hides the leak by breaking it.
    expect(options.map((o) => o.value)).toEqual(['user_9', 'user_42'])
  })

  // POSITIVE CONTROL: proves the assertions above aren't vacuously true against a component that
  // never actually reads assignment data into the picker at all.
  it('POSITIVE CONTROL: with metadata.assigneeName present, the real name renders as the option label', async () => {
    mockActiveApproval.value = baseInstance({
      nodeOperations: { ...ALL_ALLOWED },
      assignments: [
        { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
        { id: 'as_2', type: 'user', assigneeId: 'user_9', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true, assigneeName: '赵六' } },
      ],
    })
    await mountView()

    ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog="减签"]') as HTMLElement
    const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement
    const options = Array.from(select.querySelectorAll('option')) as HTMLOptionElement[]
    expect(options).toHaveLength(1)
    expect(options[0].textContent?.trim()).toBe('赵六')
    expect(options[0].value).toBe('user_9')
  })

  it('submits the selected assigneeId (the option VALUE, not the fallback LABEL) through the real reduce_sign handler', async () => {
    // member-display-identity (2026-08-19): the target must be RESOLVABLE — an unresolved option
    // is now `disabled` and the submit handler itself refuses it (see the two new tests below), so
    // this "does a real submit work" test needs a name-bearing seat, not the raw-id-shaped default
    // `reduceSignInstance()` fixture (which is deliberately built to stay UNresolved for the
    // negative test above).
    mockActiveApproval.value = baseInstance({
      nodeOperations: { ...ALL_ALLOWED },
      assignments: [
        { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
        { id: 'as_2', type: 'user', assigneeId: 'user_9', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true } },
        { id: 'as_3', type: 'user', assigneeId: 'user_42', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true, assigneeName: '孙七' } },
      ],
    })
    await mountView()

    ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog="减签"]') as HTMLElement
    const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement
    const targetOption = Array.from(select.querySelectorAll('option')).find((o) => (o as HTMLOptionElement).value === 'user_42') as HTMLOptionElement
    expect(targetOption.disabled, 'a resolved (named) option must NOT be disabled').toBe(false)
    select.value = 'user_42'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(q(container!, 'approval-reduce-sign-submit') as HTMLButtonElement).click()
    await flushUi(12)

    expect(executeActionSpy).toHaveBeenCalled()
    const lastCall = executeActionSpy.mock.calls[executeActionSpy.mock.calls.length - 1]
    expect(lastCall[1]).toMatchObject({ action: 'reduce_sign', targetAssignmentUserId: 'user_42' })
  })

  // member-display-identity (2026-08-19) — owner directive: an unresolvable member's 减签 option
  // is DISABLED, not just relabelled with an ordinal and left pickable. Two doors, proved
  // separately (mirrors this file's own §2.3 discipline above): the `<el-option disabled>`
  // attribute is the UI door; `submitReduceSign`'s own resolved-and-not-disabled check is the
  // handler door — neutering either alone must not let the other cover for it.
  it('an unresolvable member: the option is disabled AND the submit handler itself refuses it (both doors)', async () => {
    mockActiveApproval.value = reduceSignInstance() // user_9/user_42, metadata: {} — never resolves (mock returns [])
    await mountView()

    ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-el-dialog="减签"]') as HTMLElement
    const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement
    const options = Array.from(select.querySelectorAll('option')) as HTMLOptionElement[]
    expect(options).toHaveLength(2)
    for (const option of options) {
      expect(option.disabled, `option ${option.value} must be disabled while unresolved`).toBe(true)
    }

    // Handler door: force-set the value the way a real click on a disabled native <option> cannot,
    // and confirm submitReduceSign refuses it anyway — the disabled attribute is not the ONLY gate.
    select.value = 'user_42'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(q(container!, 'approval-reduce-sign-submit') as HTMLButtonElement).click()
    await flushUi(12)

    expect(executeActionSpy, 'an unresolved member must never reach executeAction').not.toHaveBeenCalled()
  })

  // POSITIVE CONTROL for the test above, resolved via the DIRECTORY RESOLVER this time (not
  // `metadata.assigneeName`) — proves the resolver path itself (not just the pre-existing
  // metaName path) turns the ordinal into a real name AND flips the option to selectable.
  it('POSITIVE CONTROL: a member resolvable via the directory resolver gets its real name AND becomes selectable', async () => {
    resolveApprovalDirectoryUsersMock.mockResolvedValue([
      { id: 'user_9', name: '钱八' },
      { id: 'user_42', name: '周九' },
    ])
    mockActiveApproval.value = reduceSignInstance()
    await mountView()

    ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
    await flushUi(12)

    const dialog = container!.querySelector('[data-el-dialog="减签"]') as HTMLElement
    const select = dialog.querySelector('select[data-el-select]') as HTMLSelectElement
    const options = Array.from(select.querySelectorAll('option')) as HTMLOptionElement[]
    const labels = options.map((o) => o.textContent?.trim())
    expect(labels).toEqual(['钱八', '周九'])
    expect(labels.join('|')).not.toContain('user_9')
    expect(labels.join('|')).not.toContain('user_42')
    for (const option of options) {
      expect(option.disabled, `resolved option ${option.value} must NOT be disabled`).toBe(false)
    }
  })
})

describe('Lock-5 CR-3 (detail dialog) — the comment requirement derives from the effective policy', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockHistory.value = []
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    resolveApprovalDirectoryUsersMock.mockReset().mockResolvedValue([])
    __resetResolvedDirectoryNamesForTests()
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
    for (const name of [
      'ElDivider', 'ElEmpty', 'ElTable', 'ElTableColumn', 'ElTimeline', 'ElTimelineItem',
      'ElForm', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElAlert',
    ]) {
      app.component(name, stub(name))
    }
    app.component('ElButton', ElButton)
    app.component('ElPopconfirm', ElPopconfirm)
    app.component('ElDialog', ElDialog)
    app.component('ElInput', ElInput)
    app.component('ElFormItem', ElFormItem)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  async function openDialog(action: 'approve' | 'reject') {
    const btn = q(container!, `approval-${action}-button`) as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    await flushUi()
  }

  function confirmButton(): HTMLButtonElement {
    const dialog = container!.querySelector('[data-dialog-visible="true"]') as HTMLElement
    expect(dialog).toBeTruthy()
    const btn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('确认'))
    expect(btn).toBeTruthy()
    return btn as HTMLButtonElement
  }

  it("'always': the APPROVE dialog also requires a comment — the approve side is WIRED, not just relabelled", async () => {
    // CR-3's exact assertion. This is the half a relabel-only implementation would fail.
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED, commentRequired: 'always' } })
    await mountView()
    await openDialog('approve')
    expect(confirmButton().disabled).toBe(true)
  })

  it("POSITIVE CONTROL 'reject_only': the APPROVE dialog does NOT require a comment (today's behavior)", async () => {
    // Proves the assertion above is value-selected, not "the approve confirm is always disabled".
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED, commentRequired: 'reject_only' } })
    await mountView()
    await openDialog('approve')
    expect(confirmButton().disabled).toBe(false)
  })

  it("'reject_only': the REJECT dialog requires a comment (today's behavior preserved)", async () => {
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED, commentRequired: 'reject_only' } })
    await mountView()
    await openDialog('reject')
    expect(confirmButton().disabled).toBe(true)
  })

  it("'never': NEITHER dialog requires a comment", async () => {
    mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED, commentRequired: 'never' } })
    await mountView()
    await openDialog('reject')
    expect(confirmButton().disabled).toBe(false)
  })

  it('legacy fallback: with NO carrier, the shipped `policy.rejectCommentRequired` literal still governs', async () => {
    // A bridged instance / older server. Both arms asserted so the fallback is not one-sided.
    mockActiveApproval.value = baseInstance({ nodeOperations: undefined, policy: { rejectCommentRequired: true, allowRevoke: true } })
    await mountView()
    await openDialog('reject')
    expect(confirmButton().disabled).toBe(true)

    if (app) { app.unmount(); app = null }
    container!.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    mockActiveApproval.value = baseInstance({ nodeOperations: undefined, policy: { rejectCommentRequired: false, allowRevoke: true } })
    await mountView()
    await openDialog('reject')
    expect(confirmButton().disabled).toBe(false)
  })
})
