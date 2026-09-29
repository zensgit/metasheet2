/**
 * 请假撤销入口(阶段 B)—— ApprovalDetailView 上的撤销轮:
 *   P-2:页头 StatusTag、审批记录表的「结束」行、复制摘要、时间线的系统收口行(哨兵 actor 显示为「系统」,
 *        动作词用 V5 / V6 而不是「驳回」)。
 *   ④ 审批人办理:通过 / 驳回改走考勤侧 `POST /api/attendance/requests/:id/cancel-round/actions`,
 *        按钮随该路由实际校验的 `attendance:approve` 显示;请假 id 解析失败不回落到通用动作路由。
 * Mount scaffold follows approval-detail-record-table.spec.ts (store / router / auth / permissions /
 * templateStore mocked; the real ApprovalDetailView.vue with a broad Element Plus stub set).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, ref, type App as VueApp } from 'vue'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'

const mockRouteParams = reactive({ id: 'cr_1' })
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), back: vi.fn() }),
    useRoute: () => ({ params: mockRouteParams, query: {}, path: '/approvals/cr_1', meta: {} }),
  }
})

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false, features: ref({}) }),
}))

const mockCanAct = ref(false)
const mockAccess = ref({ isAdmin: false, permissions: [] as string[] })
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct, permissions: mockAccess }),
}))

const getApprovalMock = vi.fn()
vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
    remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
    resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  }
})

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

vi.mock('../src/approvals/approvalCommentsClient', () => ({
  createApprovalCommentsClient: () => ({
    truncated: { value: false },
    listComments: vi.fn().mockResolvedValue({ comments: [] }),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  }),
  fetchApprovalCommentMentionCandidates: vi.fn().mockResolvedValue([]),
}))

const mockCurrentUserId = ref<string | null>('approver_1')
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
const loadDetailSpy = vi.fn().mockResolvedValue(undefined)
const loadHistorySpy = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return false },
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
    render() { return h(tag, { 'data-stub': name }, this.$slots.default?.()) },
  })
}
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', { disabled: isDisabled, onClick: (e: Event) => { if (!isDisabled) this.$emit('click', e) } }, this.$slots.default?.())
  },
})
const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, [this.title, this.$slots.default?.()]) },
})
const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  render() {
    return h('div', { 'data-el-dialog': this.title, 'data-open': this.modelValue ? 'true' : 'false' }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})
const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: {}, type: String },
  emits: ['update:modelValue'],
  render() {
    return h('textarea', { value: this.modelValue as string, onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLTextAreaElement).value) })
  },
})
interface ColumnRegistryEntry { key: string; label?: string; defaultSlot?: (scope: { row: any }) => any }
interface ColumnRegistry { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')
const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, border: Boolean, size: String },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('table', {}, [
        h('thead', { style: 'display:none' }, columnInstances),
        h('tbody', {}, rows.map((row, i) =>
          h('tr', { 'data-testid': 'approval-detail-record-table-row', key: (row?.id as string) ?? String(i) },
            registry.columns.map((col) => h('td', { 'data-el-cell': col.label || col.key }, col.defaultSlot ? col.defaultSlot({ row }) : '')),
          ),
        )),
      ])
    }
  },
})
let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { label: String, prop: String },
  setup(props, { slots }) {
    inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)?.register({ key: `col-${columnSeq++}`, label: props.label, defaultSlot: slots.default })
    return () => null
  },
})

// `Response.json()` settles on a macrotask, so each cycle also yields one timer turn.
async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const SENTINEL = 'system:approval-cancel-round'

function cancelRoundInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'cr_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: 'approval.cancel-round',
    businessKey: 'apv_orig',
    title: '撤销「考勤审批 · 请假 · 2026-09-20」',
    status: 'pending',
    requester: { id: 'employee_1', name: '张三' },
    subject: {},
    policy: { allowRevoke: true, sourceOfTruth: 'platform' },
    requestNo: 'AP-200001',
    currentStep: 1,
    totalSteps: 1,
    currentNodeKey: 'cancel_approval',
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T02:00:00.000Z',
    formSnapshot: {},
    assignments: [
      { id: 'as_1', type: 'user', assigneeId: 'approver_1', sourceStep: 1, nodeKey: 'cancel_approval', isActive: true, metadata: {} },
    ],
    canDecideCurrentNode: true,
    ...overrides,
  }
}

function q(root: HTMLElement, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`)
}

function setViewport(): void {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

async function mountView() {
  const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
  app = createApp(defineComponent({ setup() { return () => h(ApprovalDetailView as any) } }))
  for (const name of ['ElDivider', 'ElEmpty', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElTag', 'ElPopconfirm']) {
    app.component(name, stub(name))
  }
  app.component('ElDialog', ElDialog)
  app.component('ElInput', ElInput)
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElButton', ElButton)
  app.component('ElAlert', ElAlert)
  app.directive('loading', { mounted() {}, updated() {} })
  app.mount(container!)
  await flushUi()
}

beforeEach(() => {
  mockRouteParams.id = 'cr_1'
  mockActiveApproval.value = cancelRoundInstance()
  mockHistory.value = []
  mockCanAct.value = false
  mockAccess.value = { isAdmin: false, permissions: [] }
  mockCurrentUserId.value = 'approver_1'
  executeActionSpy.mockReset().mockResolvedValue({})
  loadDetailSpy.mockClear()
  loadHistorySpy.mockClear()
  getApprovalMock.mockReset()
  apiFetchMock.mockReset()
  __resetResolvedDirectoryNamesForTests()
  setViewport()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (app) app.unmount()
  container?.remove()
  app = null
  container = null
  vi.clearAllMocks()
})

describe('ApprovalDetailView — P-2 on a cancel-round instance', () => {
  const headerTag = () => container!.querySelector<HTMLElement>('.ms-status-tag')!

  it('header tag: a system closure (business_blocked) renders V6, not 已驳回', async () => {
    mockActiveApproval.value = cancelRoundInstance({ status: 'rejected', cancelRoundCloseReason: 'business_blocked:SOME_CODE' })
    await mountView()
    expect(headerTag().dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_blocked' })
    expect(headerTag().textContent).toBe('该请假已无法撤销(业务原因)')
  })

  it('header tag: an approver rejection (detail DTO without a close reason) renders V3', async () => {
    mockActiveApproval.value = cancelRoundInstance({ status: 'rejected' })
    await mountView()
    expect(headerTag().dataset.status).toBe('cancellation_rejected')
    expect(headerTag().textContent).toBe('撤销申请被驳回')
  })

  it('an ordinary instance keeps the approvalInstance domain', async () => {
    mockActiveApproval.value = cancelRoundInstance({ workflowKey: 'attendance.request', status: 'rejected' })
    await mountView()
    expect(headerTag().dataset).toMatchObject({ domain: 'approvalInstance', status: 'rejected' })
  })

  it('timeline + record table: the system-closure row shows 系统 and the V5 word, never the sentinel or 驳回', async () => {
    mockActiveApproval.value = cancelRoundInstance({ status: 'rejected', cancelRoundCloseReason: 'round_expired' })
    mockHistory.value = [
      { id: 'h1', action: 'created', actorId: 'employee_1', actorName: '张三', comment: null, fromStatus: null, toStatus: 'pending', occurredAt: '2026-09-29T01:00:00.000Z', metadata: { nodeKey: 'start' } },
      { id: 'h2', action: 'reject', actorId: SENTINEL, actorName: SENTINEL, comment: null, fromStatus: 'pending', toStatus: 'rejected', occurredAt: '2026-09-29T02:00:00.000Z', metadata: { nodeKey: 'cancel_approval', cancelRoundCloseReason: 'round_expired' } },
    ]
    await mountView()
    expect(container!.textContent).not.toContain(SENTINEL)
    expect(container!.textContent).toContain('撤销窗口已过,申请自动关闭')
    q(container!, 'approval-detail-record-view-table')!.click()
    await flushUi()
    const rows = Array.from(container!.querySelectorAll('[data-testid="approval-detail-record-table-row"]'))
    const closure = rows.find((r) => r.textContent?.includes('系统'))
    expect(closure).toBeTruthy()
    expect(closure!.textContent).toContain('撤销窗口已过,申请自动关闭')
    expect(closure!.textContent).not.toContain('驳回')
    // synthetic 结束 row states the instance status through the same selector
    expect(rows[rows.length - 1].textContent).toContain('撤销窗口已过,申请自动关闭')
    expect(container!.textContent).not.toContain(SENTINEL)
  })
})

describe('ApprovalDetailView — cancel-round approver path (attendance route)', () => {
  const attendanceCalls = () =>
    apiFetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/cancel-round/actions'))
      .map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))])
  const dialogErrors = () =>
    Array.from(container!.querySelectorAll('[data-testid="approval-action-dialog-error"]')).map((e) => e.textContent ?? '')

  beforeEach(async () => {
    const { resetCancelRoundLeaveRequestIdCache } = await import('../src/approvals/cancelRound')
    resetCancelRoundLeaveRequestIdCache()
    getApprovalMock.mockImplementation(async (id: string) => {
      if (id === 'apv_orig') return { id, businessKey: 'attendance-request:req-77' }
      throw new Error('API error: 404')
    })
    apiFetchMock.mockImplementation(async () =>
      jsonResponse(200, { ok: true, data: { requestId: 'req-77', roundId: 'apr_1', outcome: 'applied', status: 'leave_cancelled' } }))
  })

  it('attendance:approve holder (no approvals:act) sees 通过/驳回 only, and 通过 goes to the attendance route', async () => {
    mockAccess.value = { isAdmin: false, permissions: ['attendance:approve'] }
    await mountView()
    expect(q(container!, 'approval-approve-button')).not.toBeNull()
    expect(q(container!, 'approval-reject-button')).not.toBeNull()
    expect(q(container!, 'approval-transfer-button')).toBeNull()
    expect(q(container!, 'approval-add-sign-button')).toBeNull()
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()
    expect(executeActionSpy).not.toHaveBeenCalled()
    expect(getApprovalMock).toHaveBeenCalledWith('apv_orig')
    expect(attendanceCalls()).toEqual([['/api/attendance/requests/req-77/cancel-round/actions', { action: 'approve' }]])
    // minimal success body ⇒ nothing published from it; the detail is re-read instead
    expect(loadDetailSpy).toHaveBeenCalledWith('cr_1')
  })

  it('approvals:act alone does not show the decision buttons on a cancel round (the route checks attendance:approve)', async () => {
    mockCanAct.value = true
    await mountView()
    expect(q(container!, 'approval-approve-button')).toBeNull()
    expect(q(container!, 'approval-reject-button')).toBeNull()
  })

  it('a retryable refusal shows the V7 copy in the dialog (non-terminal, not a failure)', async () => {
    mockAccess.value = { isAdmin: false, permissions: ['attendance:approve'] }
    apiFetchMock.mockImplementation(async () =>
      jsonResponse(409, { ok: false, error: { code: 'CANCEL_ROUND_WINDOW_ANCHOR_MISSING', message: 'raw' } }))
    await mountView()
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()
    expect(dialogErrors().join('|')).toContain('本次操作未完成,请稍后重试(撤销申请仍在审批中)')
    expect(dialogErrors().join('|')).not.toContain('raw')
  })

  it('an unresolvable leave id is an error in the dialog — never a fallback to the generic route', async () => {
    mockAccess.value = { isAdmin: false, permissions: ['attendance:approve'] }
    mockActiveApproval.value = cancelRoundInstance({ businessKey: 'apv_unknown' })
    await mountView()
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()
    expect(dialogErrors().join('|')).toContain('无法定位这条撤销申请对应的请假')
    expect(executeActionSpy).not.toHaveBeenCalled()
    expect(attendanceCalls()).toHaveLength(0)
  })

  it('an ordinary instance still decides through store.executeAction', async () => {
    mockCanAct.value = true
    mockActiveApproval.value = cancelRoundInstance({ workflowKey: 'expense' })
    await mountView()
    q(container!, 'approval-approve-button')!.click()
    await flushUi()
    q(container!, 'approval-action-dialog-confirm')!.click()
    await flushUi()
    expect(executeActionSpy).toHaveBeenCalledWith('cr_1', { action: 'approve', comment: undefined })
    expect(attendanceCalls()).toHaveLength(0)
  })
})
