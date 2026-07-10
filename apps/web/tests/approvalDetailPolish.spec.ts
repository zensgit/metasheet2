import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// B3-13 (batch-3 approval FE polish) — ApprovalDetailView behavior contracts:
//
// 1. 撤回策略感知 — the 撤回 popconfirm renders ONLY when the instance policy snapshot carries
//    `allowRevoke === true` (plus the pre-existing requester/desktop/pending gates). The
//    shown-when-true + hidden-when-false PAIR (all other gates identical) makes the guard
//    mutation-proof in both directions: drop `&& allowRevoke` → the false case fails; hardcode
//    the computed → the true case fails.
// 2. 按动作 loading — each action button binds `:loading` to its OWN in-flight marker, so only
//    the button whose request is running spins/disables; siblings stay enabled.
// 3. 骨架/空态 — first-paint skeleton and the not-found empty state both render via the shared
//    AsyncStateBlock (with 返回列表/重新加载 CTAs on the empty state).
// 4. 打印/复制 — header 复制摘要 writes the key fields + link to the clipboard; 打印 calls
//    window.print().
//
// Same mount scaffold as approvalResubmitButton.spec.ts (store/router/auth/permissions mocked
// directly; the real ApprovalDetailView.vue + a broad Element Plus stub set).
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

// Per-test control over the approver-side action bar (approve/reject/transfer/...).
const mockCanAct = ref(false)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

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
    get pendingApprovals() { return [] },
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

// Exposes `loading` as a queryable attribute so the per-action loading assertions can tell
// exactly WHICH button is spinning (EP disables a loading button, so `disabled` mirrors it too).
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean },
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
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, this.title) },
})
// Renders the reference slot plus a confirm trigger so tests can fire @confirm (= handleRevoke).
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
// Unlike the generic stub, renders the #footer slot too — the dialogs' confirm buttons live
// there and the per-action loading assertions click them.
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

async function flushUi(cycles = 5): Promise<void> {
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
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    formSnapshot: { fld_reason: '出差报销' },
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [],
    ...overrides,
  }
}

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

describe('ApprovalDetailView — B3-13 curated FE polish', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = []
    mockLoading.value = false
    mockCanAct.value = false
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag']) {
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

  // -------------------------------------------------------------------------
  // Item 1 — 撤回策略感知 (policy.allowRevoke)
  // -------------------------------------------------------------------------
  describe('撤回策略感知', () => {
    it('shows 撤回 for the requester when policy.allowRevoke === true (guard is non-vacuous)', async () => {
      mockCurrentUserId.value = 'user_99'
      mockActiveApproval.value = baseInstance({ policy: { rejectCommentRequired: true, allowRevoke: true } })
      await mountView()

      expect(q(container!, 'approval-revoke-button')).toBeTruthy()
    })

    it('hides 撤回 when policy.allowRevoke === false — same requester, ONLY the flag flipped', async () => {
      mockCurrentUserId.value = 'user_99'
      mockActiveApproval.value = baseInstance({ policy: { rejectCommentRequired: true, allowRevoke: false } })
      await mountView()

      expect(q(container!, 'approval-revoke-button')).toBeNull()
    })

    it('hides 撤回 when the policy snapshot has no allowRevoke key (legacy instance, fail-closed)', async () => {
      mockCurrentUserId.value = 'user_99'
      mockActiveApproval.value = baseInstance({ policy: { rejectCommentRequired: true } })
      await mountView()

      expect(q(container!, 'approval-revoke-button')).toBeNull()
    })

    it('hides 撤回 when policy is null (externally-synced instance, fail-closed)', async () => {
      mockCurrentUserId.value = 'user_99'
      mockActiveApproval.value = baseInstance({ policy: null })
      await mountView()

      expect(q(container!, 'approval-revoke-button')).toBeNull()
    })

    it('still hides 撤回 from a NON-requester even with allowRevoke === true (existing gate intact)', async () => {
      mockCurrentUserId.value = 'user_someone_else'
      mockActiveApproval.value = baseInstance({ policy: { allowRevoke: true } })
      await mountView()

      expect(q(container!, 'approval-revoke-button')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Item 2 — 按动作 loading
  // -------------------------------------------------------------------------
  describe('按动作 loading', () => {
    it('revoke in flight: ONLY the 撤回 button spins; approve/reject/transfer stay enabled', async () => {
      mockCurrentUserId.value = 'user_99'
      mockCanAct.value = true
      const gate = deferred<any>()
      executeActionSpy.mockReturnValue(gate.promise)
      await mountView()

      const revokeBtn = q(container!, 'approval-revoke-button')!
      expect(revokeBtn.getAttribute('data-loading')).toBe('false')

      q(container!, 'popconfirm-confirm-trigger')!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledTimes(1)
      expect(executeActionSpy).toHaveBeenCalledWith('apv_1', { action: 'revoke' })
      expect(revokeBtn.getAttribute('data-loading')).toBe('true')
      expect((revokeBtn as HTMLButtonElement).disabled).toBe(true)
      // The RIGHT button and only that button — siblings untouched and clickable.
      for (const sibling of ['approval-approve-button', 'approval-reject-button', 'approval-transfer-button', 'approval-comment-button']) {
        const el = q(container!, sibling)! as HTMLButtonElement
        expect(el.getAttribute('data-loading')).toBe('false')
        expect(el.disabled).toBe(false)
      }

      gate.resolve({})
      await flushUi()
      expect(revokeBtn.getAttribute('data-loading')).toBe('false')
      expect((revokeBtn as HTMLButtonElement).disabled).toBe(false)
    })

    it('approve dialog confirm in flight: confirm + bar 通过 spin, bar 驳回 stays enabled; re-enables on FAILURE', async () => {
      mockCanAct.value = true
      const gate = deferred<any>()
      executeActionSpy.mockReturnValue(gate.promise)
      await mountView()

      // Open the approve dialog (sets currentAction), then confirm.
      q(container!, 'approval-approve-button')!.click()
      await flushUi()
      q(container!, 'approval-action-dialog-confirm')!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledTimes(1)
      expect(executeActionSpy).toHaveBeenCalledWith('apv_1', { action: 'approve', comment: undefined })
      expect(q(container!, 'approval-action-dialog-confirm')!.getAttribute('data-loading')).toBe('true')
      expect(q(container!, 'approval-approve-button')!.getAttribute('data-loading')).toBe('true')
      const rejectBtn = q(container!, 'approval-reject-button')! as HTMLButtonElement
      expect(rejectBtn.getAttribute('data-loading')).toBe('false')
      expect(rejectBtn.disabled).toBe(false)

      // Failure path: the button re-enables and the dialog-scoped error renders.
      gate.reject(new Error('该审批已被处理'))
      await flushUi()
      expect(q(container!, 'approval-action-dialog-confirm')!.getAttribute('data-loading')).toBe('false')
      expect(q(container!, 'approval-approve-button')!.getAttribute('data-loading')).toBe('false')
      expect(q(container!, 'approval-action-dialog-error')?.textContent).toContain('该审批已被处理')
    })
  })

  // -------------------------------------------------------------------------
  // Item 3 — 骨架/空态 via AsyncStateBlock
  // -------------------------------------------------------------------------
  describe('骨架/空态', () => {
    it('renders the AsyncStateBlock skeleton on first-paint loading (no approval yet + loading)', async () => {
      mockActiveApproval.value = null
      mockLoading.value = true
      await mountView()

      const skeleton = q(container!, 'detail-skeleton')
      expect(skeleton).toBeTruthy()
      // Two sections: form (3 rows) + timeline (6 rows) — the UF-8 texture, now via the block.
      expect(skeleton!.querySelectorAll('.ms-async-state__section')).toHaveLength(2)
      expect(q(container!, 'detail-not-found')).toBeNull()
    })

    it('renders the not-found empty state (with CTAs) when not loading and nothing loaded', async () => {
      mockActiveApproval.value = null
      mockLoading.value = false
      await mountView()

      const empty = q(container!, 'detail-not-found')
      expect(empty).toBeTruthy()
      expect(empty!.textContent).toContain('未找到该审批')
      expect(q(container!, 'detail-skeleton')).toBeNull()
      // Header utilities have nothing to copy/print without a detail.
      expect(q(container!, 'approval-copy-summary-button')).toBeNull()
      expect(q(container!, 'approval-print-button')).toBeNull()
      // Both CTAs render; 返回列表 navigates back to the list route.
      expect(q(container!, 'approval-not-found-retry')).toBeTruthy()
      q(container!, 'approval-not-found-back')!.click()
      await flushUi()
      expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-list' })
    })

    it('renders neither skeleton nor empty state once the detail is loaded', async () => {
      await mountView()

      expect(q(container!, 'detail-skeleton')).toBeNull()
      expect(q(container!, 'detail-not-found')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Item 4 — 打印/复制
  // -------------------------------------------------------------------------
  describe('打印/复制', () => {
    it('复制摘要 writes the key fields + link to the clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      await mountView()

      q(container!, 'approval-copy-summary-button')!.click()
      await flushUi()

      expect(writeText).toHaveBeenCalledTimes(1)
      const text = writeText.mock.calls[0][0] as string
      const lines = text.split('\n')
      expect(lines).toHaveLength(7)
      expect(lines[0]).toBe('审批：出差报销')
      expect(lines[1]).toBe('编号：AP-100001')
      expect(lines[2]).toBe('状态：待处理')
      expect(lines[3]).toBe('发起人：张三')
      expect(lines[4]).toMatch(/^发起时间：/)
      expect(lines[5]).toBe('进度：1 / 2')
      expect(lines[6]).toBe(`链接：${window.location.href}`)
    })

    it('复制摘要 failure (clipboard rejects) is caught — no unhandled rejection', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'))
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      await mountView()

      q(container!, 'approval-copy-summary-button')!.click()
      await flushUi()

      expect(writeText).toHaveBeenCalledTimes(1)
      // The error toast is rendered by the real ElMessage into document.body.
      expect(document.body.textContent).toContain('复制失败')
    })

    it('打印 calls window.print()', async () => {
      const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
      await mountView()

      q(container!, 'approval-print-button')!.click()
      await flushUi()

      expect(printSpy).toHaveBeenCalledTimes(1)
      printSpy.mockRestore()
    })
  })
})
