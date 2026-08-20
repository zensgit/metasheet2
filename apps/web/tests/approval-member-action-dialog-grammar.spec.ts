import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App as VueApp } from 'vue'

/**
 * P5-C-1 — member-action dialog grammar (chrome-only unification).
 * Source: scout brief "P5-C IMPLEMENTATION BRIEF" (2026-08-20), master lock §4 UI-5, ledger P5-C row.
 *
 * This file is the NEW coverage the slice adds, on top of (never instead of) the pre-existing
 * `approval-member-bar-operation-policy.spec.ts` (whose own tests keep proving the four deferred
 * verbs' policy-denial branch, wiring, comment-required tri-state, and 减签's dual doors — none of
 * that is re-proved here). Three things this slice actually changed:
 *
 *   1. Six dialog-root `data-testid`s (Detail had none; Center already did) — purely additive.
 *   2. Confirm-disabled predicates for transfer / return / comment (add-sign / reduce-sign already
 *      had one). The submit-handler early-return guards stay in place as defense-in-depth — this is
 *      an ADDITIONAL door, not a replacement for the existing one.
 *   3. `handleMemberActionFailure`'s non-policy branch now renders inline via the shared
 *      `actionDialogError` ref (same slot approve/reject/comment already used) instead of a toast —
 *      and every dialog's own `open*` resets that ref, so a stale error from one verb's dialog can
 *      never bleed into a freshly-opened OTHER dialog (no existing test covered that reset).
 *   4. Best-effort focus-on-open of each dialog's primary NATIVE control (the two
 *      `ApprovalUserPicker`-backed dialogs — transfer / add-sign — are excluded; see the source
 *      comment on `actionDialogCommentRef` in ApprovalDetailView.vue for why).
 *
 * C7 (scout brief) applies here as much as it does to the shipped code: this vitest lane stubs
 * `ElDialog`/`ElInput`/`ElSelect`, so real focus-TRAP, focus-RETURN, and ESC-dismissal are NOT
 * verified by anything in this file — only "the component calls `.focus()` on its primary control's
 * ref after opening" is asserted, via a stub that exposes a spyable `focus` method. Real-browser
 * a11y evidence is out of scope for this slice (P5-C-3, per the scout brief).
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

// Emits an id on click so `submitTransfer`/`onAddSignUserSelected` have a real target to act on —
// mirrors `approval-member-bar-operation-policy.spec.ts`'s own stub.
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

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
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
    return () => h('div', { 'data-stub': 'ElPopconfirm' }, [slots.reference ? slots.reference() : null])
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  setup(props) {
    return () => h('div', { 'data-el-alert': props.type || 'default' }, props.title)
  },
})

// `data-testid` is not a declared prop on any dialog/input/select stub below — Vue's automatic
// attribute-inheritance falls it through onto each stub's single root element without any of them
// needing to spread `attrs` explicitly, exactly like every OTHER non-prop attribute already used
// across the sibling spec files (`data-loading`, etc.).
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

// Exposes a `focus()` that forwards to the REAL underlying DOM node's `.focus()` — so "the
// component moved focus into the dialog's primary control on open" is checked the same way a
// real browser test would (`document.activeElement === thatNode`), not merely "a spy fired". Per
// the scout's C7 this is the one half of focus management this jsdom lane CAN verify; real
// focus-TRAP / focus-RETURN / ESC-dismissal are Element Plus's own native `<el-dialog>` behavior
// and are not re-implemented or re-verified here.
function makeFocusable(tag: 'input' | 'select', extra: (props: any, emit: any) => Record<string, unknown>) {
  return defineComponent({
    props: { modelValue: [String, Number, null] as never, placeholder: String, rows: Number, type: String },
    emits: ['update:modelValue'],
    setup(props, { emit, expose, slots }) {
      const el = ref<HTMLElement | null>(null)
      expose({ focus: () => el.value?.focus() })
      return () => h(tag, { ref: el, ...extra(props, emit) }, tag === 'select' ? (slots.default ? slots.default() : []) : undefined)
    },
  })
}
const ElInput = makeFocusable('input', (props, emit) => ({
  value: props.modelValue,
  placeholder: props.placeholder,
  onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
}))
const ElSelect = makeFocusable('select', (props, emit) => ({
  'data-el-select': 'true',
  value: props.modelValue ?? '',
  onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value),
}))

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
    await new Promise((r) => setTimeout(r, 0))
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
    currentStep: 2,
    totalSteps: 3,
    currentNodeKey: 'approval_2',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [
      { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
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

describe('P5-C-1 — member-action dialog grammar', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockHistory.value = [{ id: 'h1', action: 'approve', metadata: { nodeKey: 'approval_1' } }]
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
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
      'ElForm', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag',
    ]) {
      app.component(name, stub(name))
    }
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
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

  // ---------------------------------------------------------------------------------------------
  // 1. Dialog-root data-testid — purely additive, matching the Center convention.
  // ---------------------------------------------------------------------------------------------
  describe('dialog-root data-testid', () => {
    const CASES = [
      { open: 'approval-approve-button', testid: 'approval-action-dialog' },
      { open: 'approval-transfer-button', testid: 'approval-transfer-dialog' },
      { open: 'approval-add-sign-button', testid: 'approval-add-sign-dialog' },
      { open: 'approval-comment-button', testid: 'approval-comment-dialog' },
    ] as const

    for (const { open, testid } of CASES) {
      it(`${open} → [data-testid="${testid}"] on the dialog root`, async () => {
        mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
        await mountView()
        ;(q(container!, open) as HTMLButtonElement).click()
        await flushUi()
        expect(q(container!, testid), `${testid} must be present`).toBeTruthy()
      })
    }

    it('approval-reduce-sign-button → [data-testid="approval-reduce-sign-dialog"]', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
      await flushUi()
      expect(q(container!, 'approval-reduce-sign-dialog')).toBeTruthy()
    })

    it('approval-return-button → [data-testid="approval-return-dialog"]', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-return-button') as HTMLButtonElement).click()
      await flushUi()
      expect(q(container!, 'approval-return-dialog')).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------------------------
  // 2. Uniform confirm-disabled predicate for transfer / return / comment (add-sign / reduce-sign
  //    already had one before this slice — not re-proved here, see
  //    approval-member-bar-operation-policy.spec.ts's own reduce-sign coverage).
  // ---------------------------------------------------------------------------------------------
  describe('confirm-disabled predicate (NEW for transfer / return / comment)', () => {
    it('transfer: disabled with no target picked, enabled after picking one', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-transfer-button') as HTMLButtonElement).click()
      await flushUi()
      const confirm = q(container!, 'approval-transfer-submit') as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      ;(container!.querySelector('[data-testid="stub-user-picker"]') as HTMLButtonElement).click()
      await flushUi()
      expect(confirm.disabled).toBe(false)
    })

    it('return: disabled with no target node picked, enabled after selecting one', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-return-button') as HTMLButtonElement).click()
      await flushUi()
      const confirm = q(container!, 'approval-return-submit') as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      // Scoped to the return dialog specifically — every dialog's body is always in the DOM (the
      // `ElDialog` stub does not conditionally render), and the reduce-sign dialog's OWN
      // `[data-el-select]` appears earlier in template order, so an unscoped query would silently
      // grab the wrong `<select>`.
      const select = q(container!, 'approval-return-dialog')!.querySelector('[data-el-select]') as HTMLSelectElement
      const option = select.querySelector('option') as HTMLOptionElement
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(confirm.disabled).toBe(false)
    })

    it('comment: disabled while blank/whitespace-only, enabled once real text is typed', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-comment-button') as HTMLButtonElement).click()
      await flushUi()
      const confirm = q(container!, 'approval-comment-submit') as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      const input = container!.querySelector('[data-testid="approval-comment-dialog"] input') as HTMLInputElement
      input.value = '   '
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
      expect(confirm.disabled, 'whitespace-only must still be disabled').toBe(true)
      input.value = '同意'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
      expect(confirm.disabled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // 3. Stale-error-on-reopen — no existing test covered this before P5-C-1 extended
  //    `actionDialogError` from two dialogs (approve/reject + comment) to all six. Mutation:
  //    delete any ONE `open*`'s `actionDialogError.value = null` line and its OWN case here reds.
  // ---------------------------------------------------------------------------------------------
  describe('stale error never bleeds into a freshly-opened OTHER dialog', () => {
    async function triggerNonPolicyFailureOnTransfer(): Promise<void> {
      executeActionSpy.mockRejectedValueOnce(Object.assign(new Error('目标用户不存在'), { status: 400, code: 'VALIDATION_ERROR' }))
      ;(q(container!, 'approval-transfer-button') as HTMLButtonElement).click()
      await flushUi()
      ;(container!.querySelector('[data-testid="stub-user-picker"]') as HTMLButtonElement).click()
      await flushUi()
      ;(q(container!, 'approval-transfer-submit') as HTMLButtonElement).click()
      await flushUi(12)
      expect(q(container!, 'approval-action-dialog-error')?.textContent).toBe('目标用户不存在')
      // Deliberately does NOT close the transfer dialog here — each dialog's own visibility flag
      // is independent, so the guard under test (does the NEXT dialog's `open*` reset the shared
      // error ref) does not depend on the transfer dialog having been dismissed first.
    }

    const REOPEN_CASES = [
      { open: 'approval-add-sign-button', dialog: 'approval-add-sign-dialog' },
      { open: 'approval-reduce-sign-button', dialog: 'approval-reduce-sign-dialog' },
      { open: 'approval-return-button', dialog: 'approval-return-dialog' },
      { open: 'approval-comment-button', dialog: 'approval-comment-dialog' },
    ] as const

    for (const { open, dialog } of REOPEN_CASES) {
      it(`a transfer-dialog error does not reappear when ${dialog} is opened next`, async () => {
        mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
        await mountView()
        await triggerNonPolicyFailureOnTransfer()

        ;(q(container!, open) as HTMLButtonElement).click()
        await flushUi()
        const freshDialog = q(container!, dialog) as HTMLElement
        expect(freshDialog, dialog).toBeTruthy()
        expect(freshDialog.querySelector('[data-testid="approval-action-dialog-error"]'), `${dialog} must not show the stale error`).toBeNull()
      })
    }
  })

  // ---------------------------------------------------------------------------------------------
  // 4. Focus-on-open for the dialogs whose primary control is a plain Element Plus input/select
  //    rendered directly in ApprovalDetailView.vue (transfer/add-sign are excluded — see the
  //    doc comment on `actionDialogCommentRef` in the source for why).
  // ---------------------------------------------------------------------------------------------
  describe('focus-on-open (mutation-testable half only — see C7 in the file header)', () => {
    // `document.activeElement === thatNode` is the same check a real-browser test would make —
    // the stub's exposed `focus()` forwards to the real DOM node's `.focus()` (see `makeFocusable`
    // above), so this is genuine behavioral proof, not "a spy fired". Mutation: delete either the
    // `ref="…"` binding or its `focusPrimaryControl(...)` call in `ApprovalDetailView.vue` and the
    // matching case here reds.
    it('opening the comment dialog focuses its textarea', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-comment-button') as HTMLButtonElement).click()
      await flushUi()
      const input = q(container!, 'approval-comment-dialog')!.querySelector('input')
      expect(document.activeElement).toBe(input)
    })

    it('opening the return dialog focuses its target-node select', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-return-button') as HTMLButtonElement).click()
      await flushUi()
      const select = q(container!, 'approval-return-dialog')!.querySelector('[data-el-select]')
      expect(document.activeElement).toBe(select)
    })

    it('opening the reduce-sign dialog focuses its target select', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-reduce-sign-button') as HTMLButtonElement).click()
      await flushUi()
      const select = q(container!, 'approval-reduce-sign-dialog')!.querySelector('[data-el-select]')
      expect(document.activeElement).toBe(select)
    })

    it('opening the approve dialog focuses its comment textarea', async () => {
      mockActiveApproval.value = baseInstance({ nodeOperations: { ...ALL_ALLOWED } })
      await mountView()
      ;(q(container!, 'approval-approve-button') as HTMLButtonElement).click()
      await flushUi()
      const input = q(container!, 'approval-action-dialog')!.querySelector('input')
      expect(document.activeElement).toBe(input)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// 5. The grammar module itself — pure, values-free, byte-identical-to-shipped assertions. No DOM.
// ---------------------------------------------------------------------------------------------
describe('memberActionDialogGrammar (pure module)', () => {
  it('every verb entry is byte-identical to what already shipped (de-duplication, not a rewrite)', async () => {
    const { MEMBER_ACTION_DIALOG_GRAMMAR, ACTION_DIALOG_TEST_ID } = await import('../src/approvals/memberActionDialogGrammar')

    expect(MEMBER_ACTION_DIALOG_GRAMMAR.transfer).toEqual({
      dialogTitle: '转交审批',
      dialogTestId: 'approval-transfer-dialog',
      commentLabel: '转交说明',
      commentPlaceholder: '请输入转交说明',
      commentRows: 2,
      confirmLabel: '确认转交',
    })
    expect(MEMBER_ACTION_DIALOG_GRAMMAR.add_sign).toEqual({
      dialogTitle: '加签',
      dialogTestId: 'approval-add-sign-dialog',
      commentLabel: '加签说明',
      commentPlaceholder: '请输入加签说明',
      commentRows: 2,
      confirmLabel: '确认加签',
    })
    expect(MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign).toEqual({
      dialogTitle: '减签',
      dialogTestId: 'approval-reduce-sign-dialog',
      commentLabel: '减签说明',
      commentPlaceholder: '请输入减签说明',
      commentRows: 2,
      confirmLabel: '确认减签',
    })
    expect(MEMBER_ACTION_DIALOG_GRAMMAR.return).toEqual({
      dialogTitle: '退回审批',
      dialogTestId: 'approval-return-dialog',
      commentLabel: '退回说明',
      commentPlaceholder: '请输入退回说明',
      commentRows: 2,
      confirmLabel: '确认退回',
    })
    expect(MEMBER_ACTION_DIALOG_GRAMMAR.comment).toEqual({
      dialogTitle: '添加评论',
      dialogTestId: 'approval-comment-dialog',
      commentLabel: '评论内容',
      commentPlaceholder: '请输入评论内容',
      commentRows: 3,
      confirmLabel: '提交评论',
    })
    expect(ACTION_DIALOG_TEST_ID).toBe('approval-action-dialog')
  })
})
