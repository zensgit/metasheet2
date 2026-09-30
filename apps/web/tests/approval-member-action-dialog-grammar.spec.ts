import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

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
 *
 * A fourth item — best-effort focus-on-open of each dialog's primary control — shipped in an
 * earlier revision of this slice and was RETRACTED (adversarial-gate finding P2-1 on PR #5030):
 * the real `<el-dialog>`'s own `ElFocusTrap` unconditionally re-takes focus to the dialog
 * container on mount (`focus-trap/src/focus-trap.mjs` `startTrap()`), so the helper's single
 * `nextTick` `.focus()` call never survived to become the resting `document.activeElement` in
 * production — it was provably inert. The green tests for it existed only because this file's
 * `ElDialog` stub does not implement a focus trap; a real-`ElDialog` probe showed the same code
 * with the trap present produced an identical outcome to the code deleted. Real focus management
 * for these dialogs (if ever built) is out of scope here — C7 in the scout brief already deferred
 * it to a real-browser harness (P5-C-3).
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
    setup(props: { placeholder?: string }, { emit }: { emit: (e: string, v: unknown) => void }) {
      return () => h('button', {
        'data-testid': 'stub-user-picker',
        // O-8 / F8-1: surface the host's placeholder so the English render scan below sees it.
        'data-placeholder': props.placeholder,
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

function makeFieldStub(tag: 'input' | 'select', extra: (props: any, emit: any) => Record<string, unknown>) {
  return defineComponent({
    props: { modelValue: [String, Number, null] as never, placeholder: String, rows: Number, type: String },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () => h(tag, extra(props, emit), tag === 'select' ? (slots.default ? slots.default() : []) : undefined)
    },
  })
}
const ElInput = makeFieldStub('input', (props, emit) => ({
  value: props.modelValue,
  placeholder: props.placeholder,
  onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
}))
const ElSelect = makeFieldStub('select', (props, emit) => ({
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
    // O-8 / F8-1: ApprovalDetailView now follows the shell locale; this suite's selectors are the
    // shipped zh-CN copy (C1), so pin zh-CN explicitly rather than relying on jsdom's default.
    useLocale().setLocale('zh-CN')
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

// O-8 / F8-1: the English table — same verbs, same keys, identical testids and row counts (defined
// once in the module), every copy field present, translated and CJK-free.
describe('memberActionDialogGrammar — locale tables (O-8 / F8-1)', () => {
  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
  it('EN table mirrors the zh-CN table: same testids/rows, translated copy, no CJK', async () => {
    const mod = await import('../src/approvals/memberActionDialogGrammar')
    const zh = mod.MEMBER_ACTION_DIALOG_GRAMMAR
    const en = mod.MEMBER_ACTION_DIALOG_GRAMMAR_EN
    const verbs = Object.keys(zh).sort()
    expect(verbs).toEqual(['add_sign', 'comment', 'reduce_sign', 'return', 'transfer'])
    expect(Object.keys(en).sort()).toEqual(verbs)
    for (const verb of verbs as Array<keyof typeof zh>) {
      expect(en[verb].dialogTestId, verb).toBe(zh[verb].dialogTestId)
      expect(en[verb].commentRows, verb).toBe(zh[verb].commentRows)
      for (const key of ['dialogTitle', 'commentLabel', 'commentPlaceholder', 'confirmLabel'] as const) {
        expect(en[verb][key].trim(), `${verb}.${key} empty`).not.toBe('')
        expect(en[verb][key], `${verb}.${key} untranslated`).not.toBe(zh[verb][key])
        expect(en[verb][key], `${verb}.${key} has CJK`).not.toMatch(CJK)
        expect(zh[verb][key], `${verb}.${key} zh has no CJK`).toMatch(CJK)
      }
    }
    expect(mod.memberActionDialogGrammar(true)).toBe(zh)
    expect(mod.memberActionDialogGrammar(false)).toBe(en)
  })
})

// ---------------------------------------------------------------------------------------------
// O-8 / slice F8-1, acceptance gate 2 — English render scan of ApprovalDetailView with each of the
// five member-action dialogs OPEN. Uses the prop-surfacing element stubs (dialog title/body only
// while open, form-item labels as text) and ASCII fixtures, so every CJK hit is chrome. Per verb:
// the dialog is open and shows every copy field of its grammar in English — title, comment label,
// placeholder, confirm label, and the user-picker placeholder where the dialog has one (positive
// control: a field a stub failed to surface would fail here, not pass the scan by being absent);
// nothing else on the page is CJK apart from the named exceptions; and an en -> zh -> en flip
// restores both. The comments tab is not opened here (its panel is scanned in
// approval-comments-panel.spec.ts).
// ---------------------------------------------------------------------------------------------
describe('O-8 / F8-1 — ApprovalDetailView English render scan with the five member-action dialogs open', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('en')
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
    useLocale().setLocale('zh-CN')
  })

  async function mountForScan() {
    const { surfacingElementStubs } = await import('./helpers/approvalLocaleScan')
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    app = createApp(defineComponent({ setup() { return () => h(ApprovalDetailView as any) } }))
    for (const [name, component] of Object.entries(surfacingElementStubs())) app.component(name, component)
    app.component('ElButton', ElButton)
    app.component('ElInput', ElInput)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // Rendered CJK this slice does not convert, by verb (source file:line). The quick-phrase chips
  // are inserted into the comment text as-is, so localising them would change the language of
  // stored comments — left to the owner, not decided in this slice.
  const EXCEPTIONS_BY_VERB: Record<string, Array<{ text: string; count: number; source: string }>> = {
    transfer: [],
    add_sign: [],
    reduce_sign: [],
    return: [],
    comment: [
      { text: '已阅', count: 1, source: 'apps/web/src/approvals/quickPhrases.ts:15 (QUICK_PHRASES.comment[0])' },
      { text: '请尽快处理', count: 1, source: 'apps/web/src/approvals/quickPhrases.ts:15 (QUICK_PHRASES.comment[1])' },
    ],
  }
  // `picker`: the DETAIL_EN / DETAIL_ZH key of the placeholder the view passes to the user picker
  // inside that dialog (the picker stub above surfaces it as `data-placeholder`).
  const VERBS = [
    { verb: 'transfer', open: 'approval-transfer-button', picker: 'transferPickerPlaceholder' },
    { verb: 'add_sign', open: 'approval-add-sign-button', picker: 'addSignPickerPlaceholder' },
    { verb: 'reduce_sign', open: 'approval-reduce-sign-button', picker: null },
    { verb: 'return', open: 'approval-return-button', picker: null },
    { verb: 'comment', open: 'approval-comment-button', picker: null },
  ] as const

  // Every copy field of the verb's grammar that the dialog renders, plus the picker placeholder.
  function expectDialogCopy(text: string, copy: { dialogTitle: string; commentLabel: string; commentPlaceholder: string; confirmLabel: string }, picker: string | null) {
    expect(text).toContain(copy.dialogTitle)
    expect(text).toContain(copy.commentLabel)
    expect(text).toContain(copy.commentPlaceholder)
    expect(text).toContain(copy.confirmLabel)
    if (picker) expect(text).toContain(picker)
  }

  for (const { verb, open, picker } of VERBS) {
    it(`${verb}: dialog open, English chrome only; en -> zh -> en restores`, async () => {
      const { CJK, expectNoCjkOutside, renderedTextAndAttributes } = await import('./helpers/approvalLocaleScan')
      const grammar = await import('../src/approvals/memberActionDialogGrammar')
      const labels = await import('../src/views/approval/approvalDetailLabels')
      const en = grammar.MEMBER_ACTION_DIALOG_GRAMMAR_EN[verb]
      const zh = grammar.MEMBER_ACTION_DIALOG_GRAMMAR[verb]
      const enPicker = picker ? labels.DETAIL_EN[picker] : null
      const zhPicker = picker ? labels.DETAIL_ZH[picker] : null
      mockActiveApproval.value = baseInstance({
        title: 'Travel claim',
        requester: { id: 'user_99', name: 'Requester Nine' },
        nodeOperations: { ...ALL_ALLOWED },
        assignments: [
          { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
          { id: 'as_2', type: 'user', assigneeId: 'user_7', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true, assigneeName: 'Approver Seven' } },
        ],
      })
      await mountForScan()
      expect(q(container!, en.dialogTestId), 'closed dialogs are not rendered by this stub').toBeNull()
      ;(q(container!, open) as HTMLButtonElement).click()
      await flushUi()

      const dialog = q(container!, en.dialogTestId)
      expect(dialog, `${verb} dialog must be open`).toBeTruthy()
      expectDialogCopy(renderedTextAndAttributes(dialog!), en, enPicker)
      expectNoCjkOutside(renderedTextAndAttributes(container!), EXCEPTIONS_BY_VERB[verb]!, `detail+${verb} (en)`)

      useLocale().setLocale('zh-CN')
      await flushUi()
      expectDialogCopy(renderedTextAndAttributes(q(container!, zh.dialogTestId)!), zh, zhPicker)
      expect(CJK.test(renderedTextAndAttributes(container!))).toBe(true)

      useLocale().setLocale('en')
      await flushUi()
      expectDialogCopy(renderedTextAndAttributes(q(container!, en.dialogTestId)!), en, enPicker)
      expectNoCjkOutside(renderedTextAndAttributes(container!), EXCEPTIONS_BY_VERB[verb]!, `detail+${verb} (en again)`)
    })
  }
})

// ---------------------------------------------------------------------------------------------
// O-8 / slice F8-1 (plan R5-5) — the quick-phrase chips write their preset text UNCHANGED, in
// either shell locale. A chip's text goes into the submitted opinion / comment as-is, so
// localising the phrases would change the language of what gets stored; that trade-off is left to
// the owner, and this slice keeps the written text as it was. Pinned for BOTH chip sites of
// ApprovalDetailView (the approve / reject dialog and the comment dialog), in en and in zh-CN:
// the chip texts are the literal presets; a click puts the literal into the input; a second click
// appends after a full-width comma; and the payload the view hands to the approval store's
// `executeAction` (the store double above) carries exactly the literal. In English each dialog is
// also scanned with the chips shown: the presets are its only CJK (named exceptions,
// quickPhrases.ts:13-15).
// ---------------------------------------------------------------------------------------------
describe('O-8 / F8-1 — quick-phrase chips write the preset text unchanged in both locales', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let successSpy: { mockRestore: () => void; mock: { calls: unknown[][] } } | null = null

  // The view remembers a submitted chip per user + action in localStorage and lists remembered
  // phrases first; clear them so every case starts from the preset order.
  function forgetRememberedPhrases() {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith('approval-quick-phrases:')) window.localStorage.removeItem(key)
    }
  }

  beforeEach(async () => {
    forgetRememberedPhrases()
    mockHistory.value = [{ id: 'h1', action: 'approve', metadata: { nodeKey: 'approval_1' } }]
    mockCanAct.value = true
    mockCurrentUserId.value = 'user_1'
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    const { ElMessage } = await import('element-plus')
    successSpy = vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined as never)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    successSpy?.mockRestore()
    successSpy = null
    vi.clearAllMocks()
    forgetRememberedPhrases()
    useLocale().setLocale('zh-CN')
  })

  async function mountWithSurfacingStubs() {
    const { surfacingElementStubs } = await import('./helpers/approvalLocaleScan')
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    app = createApp(defineComponent({ setup() { return () => h(ApprovalDetailView as any) } }))
    for (const [name, component] of Object.entries(surfacingElementStubs())) app.component(name, component)
    app.component('ElButton', ElButton)
    app.component('ElInput', ElInput)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // Literal presets (quickPhrases.ts:13-15), not imported: a change to the constant must red here.
  const CASES = [
    { action: 'approve', open: 'approval-approve-button', dialog: 'approval-action-dialog', submit: 'approval-action-dialog-confirm', presets: ['同意', '情况属实', '已核实无误'], line: 13 },
    { action: 'reject', open: 'approval-reject-button', dialog: 'approval-action-dialog', submit: 'approval-action-dialog-confirm', presets: ['不符合要求', '请补充材料后重新提交'], line: 14 },
    { action: 'comment', open: 'approval-comment-button', dialog: 'approval-comment-dialog', submit: 'approval-comment-submit', presets: ['已阅', '请尽快处理'], line: 15 },
  ] as const

  async function dialogTitle(action: 'approve' | 'reject' | 'comment', isZh: boolean): Promise<string> {
    if (action === 'comment') {
      const grammar = await import('../src/approvals/memberActionDialogGrammar')
      return grammar.memberActionDialogGrammar(isZh).comment.dialogTitle
    }
    const labels = await import('../src/views/approval/approvalDetailLabels')
    const table = isZh ? labels.DETAIL_ZH : labels.DETAIL_EN
    return action === 'approve' ? table.actionDialogApprove : table.actionDialogReject
  }

  for (const locale of ['en', 'zh-CN'] as const) {
    for (const { action, open, dialog, submit, presets, line } of CASES) {
      it(`${action} (${locale}): chips show the presets; click and submit carry them unchanged`, async () => {
        const { expectNoCjkOutside, renderedTextAndAttributes } = await import('./helpers/approvalLocaleScan')
        useLocale().setLocale(locale)
        mockActiveApproval.value = baseInstance({
          title: 'Travel claim',
          requester: { id: 'user_99', name: 'Requester Nine' },
          nodeOperations: { ...ALL_ALLOWED },
          assignments: [
            { id: 'as_1', type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: {} },
            { id: 'as_2', type: 'user', assigneeId: 'user_7', sourceStep: 2, nodeKey: 'approval_2', isActive: true, metadata: { addSign: true, assigneeName: 'Approver Seven' } },
          ],
        })
        await mountWithSurfacingStubs()
        ;(q(container!, open) as HTMLButtonElement).click()
        await flushUi()

        const root = () => q(container!, dialog) as HTMLElement
        const chips = () => Array.from(root().querySelectorAll<HTMLElement>('[data-testid^="approval-quick-phrase-"]'))
        const input = () => root().querySelector('input') as HTMLInputElement
        expect(root(), `${action} dialog open`).toBeTruthy()
        expect(renderedTextAndAttributes(root()), 'dialog title in the shell locale').toContain(await dialogTitle(action, locale === 'zh-CN'))
        expect(chips().map((chip) => chip.textContent?.trim())).toEqual([...presets])
        if (locale === 'en') {
          expectNoCjkOutside(
            renderedTextAndAttributes(container!),
            presets.map((text) => ({ text, count: 1, source: `apps/web/src/approvals/quickPhrases.ts:${line} (QUICK_PHRASES.${action})` })),
            `detail+${action} (en)`,
          )
        }

        chips()[0]!.click()
        await flushUi()
        expect(input().value).toBe(presets[0])
        chips()[1]!.click()
        await flushUi()
        expect(input().value, 'a second chip appends after a full-width comma').toBe(`${presets[0]}，${presets[1]}`)

        // Clear the input, pick the first chip again and submit it.
        input().value = ''
        input().dispatchEvent(new Event('input', { bubbles: true }))
        await flushUi()
        chips()[0]!.click()
        await flushUi()
        expect(input().value).toBe(presets[0])
        ;(q(container!, submit) as HTMLButtonElement).click()
        await flushUi(12)

        expect(q(container!, 'approval-action-dialog-error'), 'no dialog error').toBeNull()
        expect(successSpy!.mock.calls.length, 'success toast shown (the submit succeeded)').toBe(1)
        expect(executeActionSpy).toHaveBeenCalledTimes(1)
        expect(executeActionSpy).toHaveBeenLastCalledWith('apv_1', { action, comment: presets[0] })
      })
    }
  }
})
