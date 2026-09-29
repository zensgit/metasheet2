/**
 * 请假撤销入口(阶段 B)—— 审批中心(待我处理)上撤销轮的办理:行内「通过」、行「驳回」、批量「通过」都改走
 * `POST /api/attendance/requests/:id/cancel-round/actions`(owner 2026-09-29 11:0x 「Attendance-side +
 * OFF flag」),请假 id 经 撤销轮.businessKey → 原实例.businessKey(`attendance-request:<id>`)解析;
 * 普通行不变,仍走 `dispatchAction`。Stubs follow approval-center.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, ref, Teleport, type App as VueApp, type Slot } from 'vue'

const elSuccessSpy = vi.fn()
const elErrorSpy = vi.fn()
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('element-plus').catch(() => ({}))
  return { ...actual, ElMessage: { success: elSuccessSpy, warning: vi.fn(), error: elErrorSpy, info: vi.fn() } }
})

const dispatchActionSpy = vi.fn().mockResolvedValue({})
const getApprovalMock = vi.fn()
vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    dispatchAction: (...args: unknown[]) => dispatchActionSpy(...args),
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    getPendingCount: vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 }),
    markAllApprovalsRead: vi.fn().mockResolvedValue({ markedCount: 0 }),
    remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    getTemplate: vi.fn().mockResolvedValue({ formSchema: { fields: [] } }),
    listTemplates: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  }
})

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

const mockRoute = reactive({ name: 'approval-list', params: {}, query: {} as Record<string, string>, path: '/approvals', meta: {} })
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), back: vi.fn() }), useRoute: () => mockRoute }
})

const mockPendingApprovals = ref<any[]>([])
vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get approvals() { return [] },
    get pendingApprovals() { return mockPendingApprovals.value },
    get myApprovals() { return [] },
    get ccApprovals() { return [] },
    get completedApprovals() { return [] },
    get processedApprovals() { return [] },
    get activeApproval() { return null },
    get history() { return [] },
    get loading() { return false },
    get error() { return null },
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return 0 },
    get totalCc() { return 0 },
    get totalCompleted() { return 0 },
    get totalProcessed() { return 0 },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: vi.fn().mockResolvedValue(undefined),
    loadMine: vi.fn().mockResolvedValue(undefined),
    loadCc: vi.fn().mockResolvedValue(undefined),
    loadCompleted: vi.fn().mockResolvedValue(undefined),
    loadProcessed: vi.fn().mockResolvedValue(undefined),
    loadDetail: vi.fn(),
    loadHistory: vi.fn(),
    submitApproval: vi.fn(),
    executeAction: vi.fn(),
  }),
}))

type ColumnRegistryEntry = { key: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')
const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, stripe: Boolean, highlightCurrentRow: Boolean, maxHeight: [String, Number], rowKey: [String, Function] },
  emits: ['row-click', 'selection-change'],
  setup(props, { slots, emit }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        h('button', { type: 'button', 'data-testid': 'test-select-all-rows', onClick: () => emit('selection-change', rows) }, 'select-all'),
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row) =>
          h('div', { 'data-el-row': row.id, key: row.id },
            registry.columns.map((col) => (col.defaultSlot ? h('div', {}, col.defaultSlot({ row })) : h('div'))),
          ),
        ),
      ])
    }
  },
})
let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number], fixed: String, type: String, selectable: Function },
  setup(props, { slots }) {
    inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)?.register({ key: `col-${columnSeq++}`, prop: props.prop, label: props.label, defaultSlot: slots.default })
    return () => null
  },
})
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm', 'cancel'],
  render() {
    return h('span', {}, [
      this.$slots.reference?.(),
      h(Teleport, { to: 'body' }, [h('button', { type: 'button', 'data-el-popconfirm-confirm': this.title ?? '', onClick: () => this.$emit('confirm') }, '确认')]),
    ])
  },
})
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, plain: Boolean, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', { disabled: isDisabled, onClick: (e: Event) => { if (!isDisabled) this.$emit('click', e) } }, this.$slots.default?.())
  },
})
const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  render() { return this.modelValue ? h('div', { 'data-el-dialog': this.title }, [this.$slots.default?.(), this.$slots.footer?.()]) : null },
})
const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, clearable: Boolean, type: String, rows: Number },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', { value: this.modelValue ?? '', onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value) })
  },
})
const simple = (name: string, tag = 'div') => defineComponent({
  name,
  props: { modelValue: {}, label: String, name: String, title: String, type: String, description: String },
  render() { return h(tag, {}, [this.$slots.label?.(), this.$slots.default?.()]) },
})

// `Response.json()` settles on a macrotask, so each cycle also yields one timer turn.
async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apv_1',
    requestNo: 'AP-1',
    title: '出差报销',
    status: 'pending',
    sourceSystem: 'platform',
    workflowKey: 'expense',
    businessKey: null,
    requester: { name: '张三' },
    createdAt: '2026-09-29T00:00:00Z',
    assignments: [],
    policy: null,
    ...overrides,
  }
}
const cancelRow = (id: string, original: string) =>
  pendingRow({ id, title: `撤销「考勤审批 · 请假」${id}`, workflowKey: 'approval.cancel-round', businessKey: original, policy: { allowRevoke: true } })

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

async function mountView() {
  const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
  app = createApp(defineComponent({ setup() { return () => h(ApprovalCenterView as any) } }))
  app.component('ElTabs', simple('ElTabs'))
  app.component('ElTabPane', simple('ElTabPane'))
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElTag', simple('ElTag', 'span'))
  app.component('ElInput', ElInput)
  app.component('ElSelect', simple('ElSelect'))
  app.component('ElOption', simple('ElOption'))
  app.component('ElDatePicker', simple('ElDatePicker'))
  app.component('ElPagination', simple('ElPagination'))
  app.component('ElButton', ElButton)
  app.component('ElAlert', simple('ElAlert'))
  app.component('ElDialog', ElDialog)
  app.component('ElEmpty', simple('ElEmpty'))
  app.component('ElPopconfirm', ElPopconfirm)
  app.directive('loading', { mounted() {}, updated() {} })
  app.mount(container!)
  await flushUi()
}

const ORIGINALS: Record<string, string> = { apv_orig_1: 'attendance-request:req-1', apv_orig_2: 'attendance-request:req-2' }

beforeEach(async () => {
  const { resetCancelRoundLeaveRequestIdCache } = await import('../src/approvals/cancelRound')
  resetCancelRoundLeaveRequestIdCache()
  mockPendingApprovals.value = []
  dispatchActionSpy.mockReset().mockResolvedValue({})
  getApprovalMock.mockReset().mockImplementation(async (id: string) => {
    if (id in ORIGINALS) return { id, businessKey: ORIGINALS[id] }
    throw new Error('API error: 404')
  })
  apiFetchMock.mockReset().mockImplementation(async () =>
    jsonResponse(200, { ok: true, data: { requestId: 'x', roundId: 'apr_1', outcome: 'applied', status: 'leave_cancelled' } }))
  elSuccessSpy.mockClear()
  elErrorSpy.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (app) app.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
  vi.clearAllMocks()
})

const attendanceCalls = () =>
  apiFetchMock.mock.calls.filter((c) => String(c[0]).includes('/cancel-round/actions')).map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))])

describe('ApprovalCenterView — cancel-round approver path', () => {
  it('inline 通过 on a cancel-round row goes to the attendance route, never dispatchAction', async () => {
    mockPendingApprovals.value = [cancelRow('cr_1', 'apv_orig_1')]
    await mountView()
    ;(container!.querySelector('[data-testid="approval-row-approve-cr_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-el-popconfirm-confirm^="确认通过"]') as HTMLButtonElement).click()
    await flushUi()
    expect(dispatchActionSpy).not.toHaveBeenCalled()
    expect(getApprovalMock).toHaveBeenCalledWith('apv_orig_1')
    expect(attendanceCalls()).toEqual([['/api/attendance/requests/req-1/cancel-round/actions', { action: 'approve' }]])
    expect(elSuccessSpy).toHaveBeenCalledWith('审批已通过')
  })

  it('row 驳回 on a cancel-round row sends the comment to the attendance route', async () => {
    mockPendingApprovals.value = [cancelRow('cr_2', 'apv_orig_2')]
    await mountView()
    ;(container!.querySelector('[data-testid="approval-row-reject-cr_2"]') as HTMLButtonElement).click()
    await flushUi()
    const input = container!.querySelector('[data-testid="approval-row-reject-dialog"] input') as HTMLInputElement
    input.value = '时间冲突'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-row-reject-confirm"]') as HTMLButtonElement).click()
    await flushUi()
    expect(dispatchActionSpy).not.toHaveBeenCalled()
    expect(attendanceCalls()).toEqual([['/api/attendance/requests/req-2/cancel-round/actions', { action: 'reject', comment: '时间冲突' }]])
  })

  it('a no-seat 403 keeps the server message (same as the approval side); an unresolvable leave never falls back', async () => {
    apiFetchMock.mockImplementationOnce(async () =>
      jsonResponse(403, { ok: false, error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED', message: 'Approval assignment not found for actor' } }))
    mockPendingApprovals.value = [cancelRow('cr_1', 'apv_orig_1'), cancelRow('cr_9', 'apv_missing')]
    await mountView()
    ;(container!.querySelector('[data-testid="approval-row-approve-cr_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-el-popconfirm-confirm$="cr_1」？"]') as HTMLButtonElement).click()
    await flushUi()
    expect(elErrorSpy).toHaveBeenLastCalledWith('Approval assignment not found for actor')

    ;(container!.querySelector('[data-testid="approval-row-approve-cr_9"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-el-popconfirm-confirm$="cr_9」？"]') as HTMLButtonElement).click()
    await flushUi()
    expect(elErrorSpy).toHaveBeenLastCalledWith(expect.stringContaining('无法定位这条撤销申请对应的请假'))
    expect(dispatchActionSpy).not.toHaveBeenCalled()
    expect(attendanceCalls()).toHaveLength(1)
  })

  it('batch 通过 splits: cancel-round rows → attendance route, ordinary rows → dispatchAction', async () => {
    mockPendingApprovals.value = [pendingRow({ id: 'apv_plain' }), cancelRow('cr_1', 'apv_orig_1')]
    await mountView()
    ;(container!.querySelector('[data-testid="test-select-all-rows"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-batch-approve"]') as HTMLButtonElement).click()
    await flushUi()
    expect(dispatchActionSpy).toHaveBeenCalledTimes(1)
    expect(dispatchActionSpy).toHaveBeenCalledWith('apv_plain', { action: 'approve' })
    expect(attendanceCalls()).toEqual([['/api/attendance/requests/req-1/cancel-round/actions', { action: 'approve' }]])
  })
})
