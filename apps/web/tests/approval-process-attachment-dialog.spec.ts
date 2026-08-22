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

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: { id: 'apv_1' }, query: {}, path: '/approvals/apv_1', meta: {} }),
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
