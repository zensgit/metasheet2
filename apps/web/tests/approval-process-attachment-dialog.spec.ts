import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

/**
 * Lock-9 OD-L9-10(a) FE slice — ApprovalDetailView 评论 (comment) action dialog:
 *
 *   1. Affordance gating: `attachmentPipelineEnabled && isMyTurn`, deliberately NOT `canAct` (the
 *      coarse `approvals:act` scope grant). Both directions are proven non-vacuous: `isMyTurn`
 *      true with `canAct` FALSE still shows the uploader; `isMyTurn` false with `canAct` TRUE still
 *      hides it.
 *   2. Staged upload / remove through the process-attachment client
 *      (`uploadApprovalProcessAttachmentsAtomic` / `deleteApprovalAttachment`), never the
 *      form-field `templateId`/`fieldId` client.
 *   3. `submitComment` includes `attachmentIds` by KEY PRESENCE only when non-empty.
 *   4. Cancel/close with staged-but-unbound ids issues a DELETE per id (budget-shape mitigation,
 *      OD-L9-8); a successful submit does NOT re-delete the now-bound ids.
 *   5. Timeline render of resolved process refs, reusing `handleAttachmentDownload` verbatim.
 *   6. THE regression the scouting contract flagged as most likely to be missed: the
 *      `loadAttachmentMetadata` watch must depend on `store.history`, or a process id staged on a
 *      history row that loads AFTER `approval` resolves is silently never fetched.
 *
 * New token (`approval-process-attachment-dialog`) — added to `run-required-web-tests.sh` AND
 * both `approval-web-guard.yml` `paths:` blocks (and its targeted job's `vitest run` list) in the
 * SAME PR as this file. See the PR body for the full CI-wiring ledger.
 *
 * Mount scaffold mirrors `approvalDetailPolish.spec.ts` (store/router/auth/permissions mocked
 * directly, the real `ApprovalDetailView.vue` + a broad Element Plus stub set) combined with
 * `approvalNewView.spec.ts`'s spied-attachment-client / controllable-feature-flag pattern.
 */

const pushSpy = vi.fn().mockResolvedValue(undefined)
// Lock-9 FE fix round (gate P3-2 regression): `mockRouteId` is a real `ref`, and `params` is a
// getter re-read on every access — so `ApprovalDetailView`'s own `watch(() => route.params.id, ...)`
// (下一条/deep-link params-only navigation) reacts to `mockRouteId.value = '...'` exactly like the
// real `route.params.id` reacts to a router navigation, without needing to re-mount.
const mockRouteId = ref('apv_1')

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({
      get params() { return { id: mockRouteId.value } },
      query: {},
      get path() { return `/approvals/${mockRouteId.value}` },
      meta: {},
    }),
  }
})

// Controllable per-test — the whole point of the "gate is not canAct" pair below.
const mockCanAct = ref(false)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
    remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
    resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  }
})

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
const executeActionSpy = vi.fn().mockResolvedValue({})
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

// Mutable per-test; every test that doesn't touch it keeps the flag-OFF default.
let approvalAttachmentsFlag = false
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: () => false,
    features: {
      get value() {
        return {
          attendance: false,
          workflow: false,
          attendanceAdmin: false,
          attendanceImport: false,
          plm: false,
          approvalMobile: false,
          approvalAttachments: approvalAttachmentsFlag,
          approvalCanvasV2: false,
          approvalFwbWriteback: false,
          attendanceGroupEffectivePolicyPanel: false,
          mode: 'platform',
        }
      },
    },
  }),
}))

const uploadAtomicSpy = vi.fn()
const deleteAttachmentSpy = vi.fn().mockResolvedValue(undefined)
const fetchRefsSpy = vi.fn().mockResolvedValue([])
vi.mock('../src/approvals/attachmentUpload', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/attachmentUpload')>('../src/approvals/attachmentUpload')
  return {
    ...actual,
    uploadApprovalProcessAttachmentsAtomic: (...args: unknown[]) => uploadAtomicSpy(...args),
    deleteApprovalAttachment: (...args: unknown[]) => deleteAttachmentSpy(...args),
    fetchApprovalAttachmentRefs: (...args: unknown[]) => fetchRefsSpy(...args),
  }
})

const fetchBlobSpy = vi.fn().mockResolvedValue(new Blob(['x']))
vi.mock('../src/approvals/attachmentDownload', () => ({
  fetchApprovalAttachmentBlob: (...args: unknown[]) => fetchBlobSpy(...args),
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
  props: { type: String, loading: Boolean, disabled: Boolean, link: Boolean, text: Boolean, plain: Boolean },
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
// Renders the default + footer slots and reflects `modelValue` as `data-open` — mirrors
// approvalDetailPolish.spec.ts's identical stub. `data-testid` (bound by the real template on
// every `<el-dialog>`) falls through automatically since this component doesn't declare
// `inheritAttrs: false`, so a dialog's own testid scopes queries to just its subtree.
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
// A real v-model-capable textarea so tests can type an actual comment (the generic `stub()` above
// has no modelValue wiring at all, which would leave `actionComment` permanently empty).
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
    currentNodeKey: 'node_1',
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [],
    ...overrides,
  }
}

const MY_TURN_ASSIGNMENTS = [{ id: 'asn_1', isActive: true, type: 'user', assigneeId: 'user_me', nodeKey: 'node_1', sourceStep: 1, metadata: {} }]

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

describe('ApprovalDetailView — Lock-9 process-attachment comment dialog', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = []
    mockLoading.value = false
    mockCanAct.value = false
    mockCurrentUserId.value = null
    mockRouteId.value = 'apv_1'
    approvalAttachmentsFlag = false
    executeActionSpy.mockClear()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    uploadAtomicSpy.mockReset()
    deleteAttachmentSpy.mockReset()
    deleteAttachmentSpy.mockResolvedValue(undefined)
    fetchRefsSpy.mockReset()
    fetchRefsSpy.mockResolvedValue([])
    fetchBlobSpy.mockClear()
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag']) {
      app.component(name, stub(name))
    }
    app.component('ElDialog', ElDialog)
    app.component('ElInput', ElInput)
    app.component('ElTableColumn', stub('ElTableColumn'))
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', defineComponent({
      name: 'ElPopconfirm',
      props: { title: String },
      emits: ['confirm'],
      render() { return h('div', [this.$slots.reference?.()]) },
    }))
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  function commentDialog(): HTMLElement {
    return q(container!, 'approval-comment-dialog')!
  }

  function openCommentDialog(): void {
    q(container!, 'approval-comment-button')!.click()
  }

  async function typeComment(text: string): Promise<void> {
    const textarea = commentDialog().querySelector('textarea[data-el-input]') as HTMLTextAreaElement
    textarea.value = text
    textarea.dispatchEvent(new Event('input'))
    await flushUi() // the submit button's `:disabled` binding needs a tick to reflect the new value
  }

  function commentAttachmentInput(): HTMLInputElement {
    return commentDialog().querySelector('[data-testid="approval-comment-attachment-input"]') as HTMLInputElement
  }

  async function pickFiles(files: File[]): Promise<void> {
    const input = commentAttachmentInput()
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change'))
    await flushUi()
  }

  function removeButtons(): HTMLButtonElement[] {
    return Array.from(commentDialog().querySelectorAll('button')).filter((b) => b.textContent === '移除') as HTMLButtonElement[]
  }

  async function submitComment(): Promise<void> {
    ;(commentDialog().querySelector('[data-testid="approval-comment-submit"]') as HTMLButtonElement).click()
    await flushUi()
  }

  function approvalDetailSetupState(): Record<string, unknown> {
    return (app as any)?._instance?.subTree?.component?.setupState ?? {}
  }

  // -------------------------------------------------------------------------
  // 1. Affordance gating — attachmentPipelineEnabled && isMyTurn, NOT canAct
  // -------------------------------------------------------------------------
  describe('affordance gating', () => {
    it('shows the uploader when isMyTurn is true even though canAct is FALSE (gate is not canAct)', async () => {
      approvalAttachmentsFlag = true
      mockCurrentUserId.value = 'user_me'
      mockActiveApproval.value = baseInstance({ assignments: MY_TURN_ASSIGNMENTS })
      mockCanAct.value = false
      await mountView()
      openCommentDialog()
      await flushUi()

      expect(commentDialog().querySelector('[data-testid="approval-comment-attachment-upload"]')).toBeTruthy()
    })

    it('hides the uploader when isMyTurn is false even though canAct is TRUE (same pair, reversed)', async () => {
      approvalAttachmentsFlag = true
      mockCurrentUserId.value = 'user_someone_else' // assignment below is for 'user_me', not me
      mockActiveApproval.value = baseInstance({ assignments: MY_TURN_ASSIGNMENTS })
      mockCanAct.value = true
      await mountView()
      openCommentDialog()
      await flushUi()

      expect(commentDialog().querySelector('[data-testid="approval-comment-attachment-upload"]')).toBeNull()
    })

    it('hides the uploader when the pipeline flag is OFF regardless of isMyTurn — dialog otherwise byte-identical', async () => {
      approvalAttachmentsFlag = false
      mockCurrentUserId.value = 'user_me'
      mockActiveApproval.value = baseInstance({ assignments: MY_TURN_ASSIGNMENTS })
      await mountView()
      openCommentDialog()
      await flushUi()

      expect(commentDialog().querySelector('[data-testid="approval-comment-attachment-upload"]')).toBeNull()
      expect(commentDialog().querySelector('[data-testid="approval-comment-submit"]')).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // 2/3/4 — staged upload, remove, submit inclusion, cancel-close cleanup
  // -------------------------------------------------------------------------
  describe('staged upload lifecycle', () => {
    beforeEach(() => {
      approvalAttachmentsFlag = true
      mockCurrentUserId.value = 'user_me'
      mockActiveApproval.value = baseInstance({ assignments: MY_TURN_ASSIGNMENTS })
    })

    it('a picked file uploads through the PROCESS client with (files, instanceId) — never templateId/fieldId', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p1', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()

      await pickFiles([new File(['%PDF-1.4'], 'proof.pdf', { type: 'application/pdf' })])

      expect(uploadAtomicSpy).toHaveBeenCalledTimes(1)
      const args = uploadAtomicSpy.mock.calls[0]
      expect(args).toHaveLength(2) // (files, stagedInstanceId) — no templateId/fieldId slot at all
      expect((args[0] as File[])[0].name).toBe('proof.pdf')
      expect(args[1]).toBe('apv_1') // the INSTANCE id
      expect(commentDialog().textContent).toContain('proof.pdf')
    })

    it('removing a staged file calls deleteApprovalAttachment and drops it from the list', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p2', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'toremove.pdf', { type: 'application/pdf' })])
      expect(commentDialog().textContent).toContain('toremove.pdf')

      removeButtons()[0].click()
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_p2')
      expect(commentDialog().textContent).not.toContain('toremove.pdf')
    })

    it('a removal that server-rejects keeps the entry (retry, never a silent client-only drop)', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p2b', sizeBytes: 4 }])
      deleteAttachmentSpy.mockRejectedValueOnce(new Error('attachment delete failed: 500'))
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'stubborn.pdf', { type: 'application/pdf' })])

      removeButtons()[0].click()
      await flushUi()

      expect(commentDialog().textContent).toContain('stubborn.pdf')
    })

    it('submitComment OMITS attachmentIds entirely when nothing is staged (key presence, not [])', async () => {
      await mountView()
      openCommentDialog()
      await flushUi()
      await typeComment('无附件评论')

      await submitComment()

      expect(executeActionSpy).toHaveBeenCalledTimes(1)
      const [, req] = executeActionSpy.mock.calls[0]
      expect(req).toEqual({ action: 'comment', comment: '无附件评论' })
      expect(req).not.toHaveProperty('attachmentIds')
    })

    it('submitComment includes attachmentIds when staged uploads exist, and clears them WITHOUT deleting (already bound)', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p3', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'bound.pdf', { type: 'application/pdf' })])
      await typeComment('带附件评论')

      await submitComment()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_1', {
        action: 'comment',
        comment: '带附件评论',
        attachmentIds: ['att_p3'],
      })
      // The dialog closed on success; the close-watcher must NOT delete an id the server just bound.
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
    })

    it('cancel with a staged-but-unbound upload DELETEs it (budget-shape mitigation, OD-L9-8)', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p4', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'abandoned.pdf', { type: 'application/pdf' })])
      expect(commentDialog().textContent).toContain('abandoned.pdf')

      const cancelBtn = Array.from(commentDialog().querySelectorAll('button')).find((b) => b.textContent === '取消')!
      cancelBtn.click()
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_p4')
      expect(executeActionSpy).not.toHaveBeenCalled() // never submitted — this is a pure retraction
    })

    it('re-opening the dialog after a cancel starts with an empty staged list (no residue)', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_p5', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'first.pdf', { type: 'application/pdf' })])
      const cancelBtn = Array.from(commentDialog().querySelectorAll('button')).find((b) => b.textContent === '取消')!
      cancelBtn.click()
      await flushUi()

      openCommentDialog()
      await flushUi()

      expect(commentDialog().textContent).not.toContain('first.pdf')
    })

    // Lock-9 FE fix round (2026-08-22, gate P3-2): the close-watcher above only fires on a
    // `commentDialogVisible` true→false transition. Unmounting the view entirely (route change to
    // a DIFFERENT view, dialog left open) never produces that transition — no watcher on an
    // unmounted component's own ref runs again. `onBeforeUnmount` is the fix.
    it('unmounting the view with a staged-but-unbound upload still open DELETEs it (was: leaked)', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_unmount_1', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'leaked-on-unmount.pdf', { type: 'application/pdf' })])
      expect(commentDialog().textContent).toContain('leaked-on-unmount.pdf')
      expect(deleteAttachmentSpy).not.toHaveBeenCalled() // not yet — still open, still staged

      app!.unmount()
      app = null // afterEach's own unmount call would double-unmount otherwise

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_unmount_1')
    })

    // Lock-9 FE fix round (gate P3-2, second leak site): 下一条/deep-link navigation changes
    // `route.params.id` IN PLACE without unmounting this component (see this file's `route` mock
    // above) — the close-watcher never fires either, since `commentDialogVisible` never flips.
    // The params-id watch must retract on the OUTGOING instance before loading the new one.
    it('navigating to a different instance (params-only, no unmount) with a staged upload still open DELETEs it', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_nav_1', sizeBytes: 4 }])
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'leaked-on-nav.pdf', { type: 'application/pdf' })])
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()

      mockRouteId.value = 'apv_2' // simulates 下一条 without a remount
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_nav_1')
      expect(loadDetailSpy).toHaveBeenCalledWith('apv_2')
    })
  })

  // -------------------------------------------------------------------------
  // Lock-9 C1 — in-flight pick vs unmount / params-only instance switch
  //
  // The P3-2 retract above only sees ids already in `commentStagedAttachments`.
  // A pick whose `uploadApprovalProcessAttachmentsAtomic` has not yet resolved
  // leaves that list empty, so retract is a no-op; when the deferred success
  // later lands it used to `push` onto the dead/switched instance. These cases
  // keep the upload promise pending across the lifecycle event, then resolve.
  // Dropping the generation guard makes the unmount + switch cases
  // fail (no DELETE, and the switch case would show the stale filename on the
  // reused instance) and makes the positive control fail if every resolve
  // started deleting.
  // -------------------------------------------------------------------------
  describe('in-flight process-attachment pick lifecycle', () => {
    beforeEach(() => {
      approvalAttachmentsFlag = true
      mockCurrentUserId.value = 'user_me'
      mockActiveApproval.value = baseInstance({ assignments: MY_TURN_ASSIGNMENTS })
    })

    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    it('positive control: a deferred upload that resolves on the same mounted instance is staged and not deleted', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'still-current.pdf', { type: 'application/pdf' })])

      expect(commentDialog().textContent).not.toContain('still-current.pdf')
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
      expect(commentAttachmentInput().disabled).toBe(true)

      pending.resolve([{ id: 'att_live_1', sizeBytes: 1 }])
      await flushUi()

      expect(commentDialog().textContent).toContain('still-current.pdf')
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
      expect(commentAttachmentInput().disabled).toBe(false)
    })

    it('a deferred upload that rejects on the same mounted instance surfaces the values-free error and stages nothing', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      const { ElMessage } = await import('element-plus')
      const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'rejected-live.pdf', { type: 'application/pdf' })])

      pending.reject(new Error('attachment rejected: infected'))
      await flushUi()

      expect(errorSpy).toHaveBeenCalledWith('attachment rejected: infected')
      expect(commentDialog().textContent).not.toContain('rejected-live.pdf')
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
      expect(commentAttachmentInput().disabled).toBe(false)
      errorSpy.mockRestore()
    })

    it('blocks comment submission until the in-flight upload is staged, then binds the returned id', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await typeComment('等待附件完成')
      await pickFiles([new File(['x'], 'pending-submit.pdf', { type: 'application/pdf' })])

      const submitButton = commentDialog().querySelector('[data-testid="approval-comment-submit"]') as HTMLButtonElement
      expect(submitButton.disabled).toBe(true)
      await (approvalDetailSetupState().submitComment as () => Promise<void>)()
      expect(executeActionSpy).not.toHaveBeenCalled()

      pending.resolve([{ id: 'att_pending_submit', sizeBytes: 1 }])
      await flushUi()

      expect(submitButton.disabled).toBe(false)
      await submitComment()
      expect(executeActionSpy).toHaveBeenCalledWith('apv_1', {
        action: 'comment',
        comment: '等待附件完成',
        attachmentIds: ['att_pending_submit'],
      })
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
    })

    it('unmounting while a pick is still in flight DELETEs every later-returned id and never stages them', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'inflight-unmount.pdf', { type: 'application/pdf' })])
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()

      app!.unmount()
      app = null
      expect(deleteAttachmentSpy).not.toHaveBeenCalled() // still in flight — staged list was empty

      pending.resolve([{ id: 'att_late_unmount_a', sizeBytes: 1 }, { id: 'att_late_unmount_b', sizeBytes: 1 }])
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_late_unmount_a')
      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_late_unmount_b')
      expect(deleteAttachmentSpy).toHaveBeenCalledTimes(2)
    })

    it('a deferred upload that rejects after unmount does not toast into the dead context', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      const { ElMessage } = await import('element-plus')
      const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'inflight-unmount-fail.pdf', { type: 'application/pdf' })])

      app!.unmount()
      app = null
      pending.reject(new Error('attachment upload failed: 500'))
      await flushUi()

      expect(errorSpy).not.toHaveBeenCalled()
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('params-only instance switch while a pick is still in flight DELETEs every later-returned id and does not append them onto the reused instance', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'inflight-nav.pdf', { type: 'application/pdf' })])
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()
      expect(commentDialog().textContent).not.toContain('inflight-nav.pdf')

      mockRouteId.value = 'apv_2'
      await flushUi()
      expect(deleteAttachmentSpy).not.toHaveBeenCalled() // still in flight — retract saw an empty list
      expect(loadDetailSpy).toHaveBeenCalledWith('apv_2')

      pending.resolve([{ id: 'att_late_nav', sizeBytes: 1 }])
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_late_nav')
      expect(commentDialog().textContent).not.toContain('inflight-nav.pdf')
    })

    it('blocks a new pick while the route has changed but the reused store still exposes the outgoing instance', async () => {
      uploadAtomicSpy.mockResolvedValue([{ id: 'att_wrong_instance', sizeBytes: 1 }])
      await mountView()
      openCommentDialog()
      await flushUi()

      mockRouteId.value = 'apv_2'
      await flushUi()

      expect(loadDetailSpy).toHaveBeenCalledWith('apv_2')
      expect(mockActiveApproval.value.id).toBe('apv_1')
      expect(commentAttachmentInput().disabled).toBe(true)

      await pickFiles([new File(['x'], 'wrong-instance.pdf', { type: 'application/pdf' })])

      expect(uploadAtomicSpy).not.toHaveBeenCalled()
      expect(commentDialog().textContent).not.toContain('wrong-instance.pdf')

      mockActiveApproval.value = baseInstance({ id: 'apv_2', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()
      expect(commentAttachmentInput().disabled).toBe(false)
    })

    it('clears same-generation upload loading when the active detail temporarily reverts to another instance', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()

      mockRouteId.value = 'apv_2'
      mockActiveApproval.value = baseInstance({ id: 'apv_2', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()
      openCommentDialog()
      await flushUi()
      await typeComment('恢复后可提交')

      const submitButton = commentDialog().querySelector('[data-testid="approval-comment-submit"]') as HTMLButtonElement
      await pickFiles([new File(['x'], 'same-generation-stale.pdf', { type: 'application/pdf' })])
      expect(commentAttachmentInput().disabled).toBe(true)
      expect(submitButton.disabled).toBe(true)

      mockActiveApproval.value = baseInstance({ id: 'apv_1', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()
      pending.resolve([{ id: 'att_same_generation_stale', sizeBytes: 1 }])
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_same_generation_stale')
      expect(commentDialog().textContent).not.toContain('same-generation-stale.pdf')

      mockActiveApproval.value = baseInstance({ id: 'apv_2', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()
      expect(commentAttachmentInput().disabled).toBe(false)
      expect(submitButton.disabled).toBe(false)
    })

    it('closing the dialog while a pick is still in flight DELETEs every later-returned id', async () => {
      const pending = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(pending.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'inflight-close.pdf', { type: 'application/pdf' })])

      const cancelBtn = Array.from(commentDialog().querySelectorAll('button')).find((b) => b.textContent === '取消')!
      cancelBtn.click()
      await flushUi()
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()

      pending.resolve([{ id: 'att_late_close', sizeBytes: 1 }])
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_late_close')
      openCommentDialog()
      await flushUi()
      expect(commentDialog().textContent).not.toContain('inflight-close.pdf')
    })

    it('a stale pick finally/catch does not clobber a newer pick after a params-only instance switch', async () => {
      const first = deferred<Array<{ id: string; sizeBytes: number }>>()
      const second = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(first.promise)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'old-instance.pdf', { type: 'application/pdf' })])

      mockRouteId.value = 'apv_2'
      mockActiveApproval.value = baseInstance({ id: 'apv_2', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()

      uploadAtomicSpy.mockReturnValueOnce(second.promise)
      await pickFiles([new File(['y'], 'new-instance.pdf', { type: 'application/pdf' })])
      expect(commentAttachmentInput().disabled).toBe(true)

      first.resolve([{ id: 'att_stale_old', sizeBytes: 1 }])
      await flushUi()

      expect(deleteAttachmentSpy).toHaveBeenCalledWith('att_stale_old')
      expect(commentAttachmentInput().disabled).toBe(true)
      expect(commentDialog().textContent).not.toContain('old-instance.pdf')
      expect(commentDialog().textContent).not.toContain('new-instance.pdf')

      second.resolve([{ id: 'att_live_new', sizeBytes: 1 }])
      await flushUi()

      expect(commentDialog().textContent).toContain('new-instance.pdf')
      expect(commentDialog().textContent).not.toContain('old-instance.pdf')
      expect(deleteAttachmentSpy).not.toHaveBeenCalledWith('att_live_new')
      expect(commentAttachmentInput().disabled).toBe(false)
    })

    it('a stale pick that rejects after a params-only instance switch does not toast or re-enable a newer in-flight pick', async () => {
      const first = deferred<Array<{ id: string; sizeBytes: number }>>()
      const second = deferred<Array<{ id: string; sizeBytes: number }>>()
      uploadAtomicSpy.mockReturnValueOnce(first.promise)
      const { ElMessage } = await import('element-plus')
      const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined as never)
      await mountView()
      openCommentDialog()
      await flushUi()
      await pickFiles([new File(['x'], 'old-fail.pdf', { type: 'application/pdf' })])

      mockRouteId.value = 'apv_2'
      mockActiveApproval.value = baseInstance({ id: 'apv_2', assignments: MY_TURN_ASSIGNMENTS })
      await flushUi()

      uploadAtomicSpy.mockReturnValueOnce(second.promise)
      await pickFiles([new File(['y'], 'new-ok.pdf', { type: 'application/pdf' })])
      expect(commentAttachmentInput().disabled).toBe(true)

      first.reject(new Error('attachment upload failed: 500'))
      await flushUi()

      expect(errorSpy).not.toHaveBeenCalled()
      expect(commentAttachmentInput().disabled).toBe(true)
      expect(deleteAttachmentSpy).not.toHaveBeenCalled()

      second.resolve([{ id: 'att_new_ok', sizeBytes: 1 }])
      await flushUi()
      expect(commentDialog().textContent).toContain('new-ok.pdf')
      expect(commentAttachmentInput().disabled).toBe(false)
      errorSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // 5. Timeline render — reuses handleAttachmentDownload verbatim
  // -------------------------------------------------------------------------
  describe('timeline render of resolved process refs', () => {
    it('renders a bound process attachment on its history entry and downloads through the SAME handler the form-field block uses', async () => {
      approvalAttachmentsFlag = true
      mockActiveApproval.value = baseInstance()
      mockHistory.value = [
        {
          id: 'h1',
          action: 'comment',
          actorName: '李四',
          comment: '请查看附件',
          occurredAt: '2026-08-01T00:00:00.000Z',
          toStatus: 'pending',
          metadata: { attachmentIds: ['att_bound_1'] },
        },
      ]
      fetchRefsSpy.mockResolvedValue([
        { id: 'att_bound_1', tombstone: false, fileName: 'evidence.pdf', sizeBytes: 2048, downloadUrl: '/api/approval/attachments/att_bound_1/download' },
      ])
      await mountView()

      const block = q(container!, 'approval-timeline-process-attachments')
      expect(block).toBeTruthy()
      expect(block!.textContent).toContain('evidence.pdf')

      const link = q(container!, 'approval-timeline-attachment-download') as HTMLAnchorElement
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await flushUi()

      expect(fetchBlobSpy).toHaveBeenCalledWith({ downloadUrl: '/api/approval/attachments/att_bound_1/download', fileName: 'evidence.pdf' })
    })

    it('a tombstoned process ref renders "附件已删除", never a filename', async () => {
      approvalAttachmentsFlag = true
      mockActiveApproval.value = baseInstance()
      mockHistory.value = [
        { id: 'h1', action: 'comment', actorName: '李四', comment: 'c', occurredAt: null, toStatus: 'pending', metadata: { attachmentIds: ['att_gone'] } },
      ]
      fetchRefsSpy.mockResolvedValue([{ id: 'att_gone', tombstone: true }])
      await mountView()

      const block = q(container!, 'approval-timeline-process-attachments')!
      expect(block.textContent).toContain('附件已删除')
    })

    it('flag OFF: no process-attachment block renders even with staged history metadata', async () => {
      approvalAttachmentsFlag = false
      mockActiveApproval.value = baseInstance()
      mockHistory.value = [
        { id: 'h1', action: 'comment', actorName: '李四', comment: 'c', occurredAt: null, toStatus: 'pending', metadata: { attachmentIds: ['att_x'] } },
      ]
      await mountView()

      expect(q(container!, 'approval-timeline-process-attachments')).toBeNull()
      expect(fetchRefsSpy).not.toHaveBeenCalled() // flag OFF never hits the refs endpoint at all
    })
  })

  // -------------------------------------------------------------------------
  // 6. THE regression: the refs watch must depend on store.history
  // -------------------------------------------------------------------------
  describe('loadAttachmentMetadata watch — store.history dependency', () => {
    it('a process id that arrives on a LATER store.history update (approval/formSnapshot/flag unchanged) still triggers a refs fetch', async () => {
      approvalAttachmentsFlag = true
      // Set ONCE, before mount, and never touched again in this test — approval.id/formSnapshot/
      // flag must stay byte-identical across both assertions so `store.history` is the ONLY thing
      // that changes. If the watch dependency array does not track it, the second call below
      // cannot happen through any OTHER tracked source.
      mockActiveApproval.value = baseInstance()
      mockHistory.value = [] // no ids yet — the immediate run resolves to an empty id list

      fetchRefsSpy.mockResolvedValue([])
      await mountView()

      // First run: no form-field ids and no history ids yet ⇒ loadAttachmentMetadata short-circuits
      // BEFORE ever calling the refs client (see ApprovalDetailView.vue's `ids.length === 0` guard).
      expect(fetchRefsSpy).not.toHaveBeenCalled()

      // Simulate the async loadHistory() resolving AFTER approval/formSnapshot/flag were already
      // settled — the exact race the contract's scouting brief warned about.
      fetchRefsSpy.mockResolvedValue([{ id: 'att_late', tombstone: false, fileName: 'late.pdf', downloadUrl: '/api/approval/attachments/att_late/download' }])
      mockHistory.value = [
        { id: 'h1', action: 'comment', actorName: '王五', comment: 'c', occurredAt: null, toStatus: 'pending', metadata: { attachmentIds: ['att_late'] } },
      ]
      await flushUi()

      expect(fetchRefsSpy).toHaveBeenCalledTimes(1)
      expect(fetchRefsSpy).toHaveBeenCalledWith(['att_late'], 'apv_1')
    })
  })
})
