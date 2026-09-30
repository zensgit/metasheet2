/**
 * 请假撤销入口(阶段 B)—— P-2 在审批侧列表 / 预览面上的渲染:四个面(ApprovalCenterTable、
 * ApprovalMobileList、ApprovalCenterDetailPane、MetaRecordApprovalPanel)经同一个域选择器
 * (`approvalStatusTagProps`)按 `workflowKey === 'approval.cancel-round'` 选 `cancelRound` 域;
 * 第五个面(ApprovalDetailView)见 cancelRoundEntryDetailView.spec.ts。
 *
 * The load-bearing case on the list surfaces: a REJECTED cancel-round row. The list DTO does not carry
 * the close-reason criterion, so the row must read the detail and must never render V3 (or the
 * approvalInstance 「已驳回」) before — or instead of — that read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, type App as VueApp, type Slot } from 'vue'
import type { UnifiedApprovalDTO } from '../src/types/approval'
import type { MetaRecord, MetaRecordApprovalSubmission } from '../src/multitable/types'

const getApprovalMock = vi.fn()

vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: (...args: unknown[]) => getApprovalMock(...args),
    resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  }
})

import ApprovalCenterTable from '../src/views/approval/ApprovalCenterTable.vue'
import ApprovalMobileList from '../src/views/approval/ApprovalMobileList.vue'
import ApprovalCenterDetailPane from '../src/views/approval/ApprovalCenterDetailPane.vue'
import MetaRecordApprovalPanel from '../src/multitable/components/MetaRecordApprovalPanel.vue'
import { resetCancelRoundCloseReasonCache, useCancelRoundCloseReasons } from '../src/approvals/useCancelRoundCloseReasons'
import { useLocale } from '../src/composables/useLocale'

// ---- el-table registry stub (same pattern as approvalCenterTable.spec.ts) -------------------------
type ColumnRegistryEntry = { key: string; type?: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, size: String, stripe: Boolean, highlightCurrentRow: Boolean, maxHeight: [String, Number], rowKey: [String, Function] },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as UnifiedApprovalDTO[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row) =>
          h('div', { 'data-el-row': row.id, key: row.id },
            registry.columns.map((col) => h('div', { 'data-el-cell': col.label || col.key }, col.defaultSlot ? col.defaultSlot({ row }) : null)),
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
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    registry?.register({ key: `col-${columnSeq++}`, type: props.type, prop: props.prop, label: props.label, defaultSlot: slots.default })
    return () => null
  },
})
const passthrough = (name: string) =>
  defineComponent({ name, props: { title: String, type: String, disabled: Boolean, loading: Boolean, link: Boolean, plain: Boolean }, render() { return h('div', { 'data-stub': name }, [this.$slots.default?.(), this.$slots.reference?.()]) } })

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function row(overrides: Partial<UnifiedApprovalDTO> = {}): UnifiedApprovalDTO {
  return {
    id: 'apv_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: 'attendance.request',
    businessKey: null,
    title: '考勤审批 · 请假',
    status: 'pending',
    requester: { id: 'u1', name: '张三' },
    subject: null,
    policy: null,
    currentStep: 1,
    totalSteps: 1,
    assignments: [],
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T01:00:00.000Z',
    ...overrides,
  }
}

const CANCEL = 'approval.cancel-round'

function tagOf(root: HTMLElement, rowId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-el-row="${rowId}"] .ms-status-tag, [data-approval-id="${rowId}"] .ms-status-tag`)
}

const apps: VueApp[] = []
function mount(component: unknown, props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component as never, props) })
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  for (const name of ['ElEmpty', 'ElButton', 'ElPopconfirm', 'ElTooltip', 'ElTag']) app.component(name, passthrough(name))
  app.directive('loading', { mounted() {}, updated() {} })
  app.mount(container)
  apps.push(app)
  return container
}

beforeEach(() => {
  getApprovalMock.mockReset()
  resetCancelRoundCloseReasonCache()
  useLocale().setLocale('zh-CN')
})

afterEach(() => {
  while (apps.length) apps.pop()!.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
})

const TABLE_PROPS = { loading: false, emptyText: '暂无', summaryLineFor: () => '' }

describe('ApprovalCenterTable (P-2 list surface)', () => {
  it('ordinary rows keep the approvalInstance domain; cancel-round rows switch to cancelRound', async () => {
    const root = mount(ApprovalCenterTable, {
      ...TABLE_PROPS,
      rows: [row({ id: 'a1', status: 'rejected' }), row({ id: 'c1', workflowKey: CANCEL, status: 'pending' }), row({ id: 'c2', workflowKey: CANCEL, status: 'revoked' })],
    })
    await flushUi()
    expect(tagOf(root, 'a1')!.dataset).toMatchObject({ domain: 'approvalInstance', status: 'rejected' })
    expect(tagOf(root, 'a1')!.textContent).toBe('已驳回')
    expect(tagOf(root, 'c1')!.dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_pending_approval' })
    expect(tagOf(root, 'c1')!.textContent).toBe('撤销申请审批中')
    expect(tagOf(root, 'c2')!.textContent).toBe('撤销申请已撤回')
    expect(getApprovalMock).not.toHaveBeenCalled()
  })

  it('a rejected cancel-round row reads the detail and renders V5 — never 驳回 while reading', async () => {
    let resolveDetail!: (dto: unknown) => void
    getApprovalMock.mockReturnValueOnce(new Promise((r) => { resolveDetail = r }))
    const root = mount(ApprovalCenterTable, { ...TABLE_PROPS, rows: [row({ id: 'c3', workflowKey: CANCEL, status: 'rejected' })] })
    await flushUi()
    expect(getApprovalMock).toHaveBeenCalledWith('c3')
    expect(tagOf(root, 'c3')!.dataset.status).toBe('status_resolving')
    expect(tagOf(root, 'c3')!.textContent).not.toContain('驳回')
    resolveDetail(row({ id: 'c3', workflowKey: CANCEL, status: 'rejected', cancelRoundCloseReason: 'round_expired' }))
    await flushUi()
    expect(tagOf(root, 'c3')!.dataset.status).toBe('cancellation_window_closed')
    expect(tagOf(root, 'c3')!.textContent).toBe('撤销窗口已过,申请自动关闭')
  })

  it('an approver rejection (detail without a close reason) renders V3; a failed read renders 暂时无法读取', async () => {
    getApprovalMock.mockImplementation(async (id: string) => {
      if (id === 'c4') return row({ id: 'c4', workflowKey: CANCEL, status: 'rejected' })
      throw new Error('API error: 500')
    })
    const root = mount(ApprovalCenterTable, {
      ...TABLE_PROPS,
      rows: [row({ id: 'c4', workflowKey: CANCEL, status: 'rejected' }), row({ id: 'c5', workflowKey: CANCEL, status: 'rejected' })],
    })
    await flushUi()
    expect(tagOf(root, 'c4')!.textContent).toBe('撤销申请被驳回')
    expect(tagOf(root, 'c5')!.dataset.status).toBe('status_unavailable')
    expect(tagOf(root, 'c5')!.textContent).not.toContain('驳回')
  })
})

describe('ApprovalMobileList (P-2 list surface)', () => {
  it('uses the same selector and the same criterion read', async () => {
    getApprovalMock.mockResolvedValueOnce(row({ id: 'm2', workflowKey: CANCEL, status: 'rejected', cancelRoundCloseReason: 'business_blocked:SOME_CODE' }))
    const root = mount(ApprovalMobileList, {
      approvals: [row({ id: 'm1', status: 'rejected' }), row({ id: 'm2', workflowKey: CANCEL, status: 'rejected' })],
    })
    await flushUi()
    expect(tagOf(root, 'm1')!.dataset).toMatchObject({ domain: 'approvalInstance', status: 'rejected' })
    expect(tagOf(root, 'm2')!.dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_blocked' })
    expect(tagOf(root, 'm2')!.textContent).toBe('该请假已无法撤销(业务原因)')
  })
})

describe('ApprovalCenterDetailPane (P-2 preview surface)', () => {
  const PANE = { summaryLine: '', showQuickActions: false, approveLoading: false, actionsDisabled: false, detailLoading: false }
  const paneTag = (root: HTMLElement) => root.querySelector<HTMLElement>('.approval-detail-pane__header .ms-status-tag')!

  it('uses the detail DTO (which carries the criterion) once it has landed', async () => {
    const r = row({ id: 'p1', workflowKey: CANCEL, status: 'rejected' })
    const root = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: { ...r, cancelRoundCloseReason: 'round_expired' }, detailError: '' })
    await flushUi()
    expect(paneTag(root).dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_window_closed' })
    expect(getApprovalMock).not.toHaveBeenCalled()
  })

  it('before the detail lands it says 读取中; if the detail failed it says 暂时无法读取 — never 驳回', async () => {
    const r = row({ id: 'p2', workflowKey: CANCEL, status: 'rejected' })
    const loading = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: null, detailError: '' })
    await flushUi()
    expect(paneTag(loading).dataset.status).toBe('status_resolving')
    const failed = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: null, detailError: '加载失败' })
    await flushUi()
    expect(paneTag(failed).dataset.status).toBe('status_unavailable')
    expect(paneTag(failed).textContent).not.toContain('驳回')
  })

  it('an ordinary row is untouched', async () => {
    const r = row({ id: 'p3', status: 'rejected' })
    const root = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: null, detailError: '' })
    await flushUi()
    expect(paneTag(root).dataset).toMatchObject({ domain: 'approvalInstance', status: 'rejected' })
  })

  // 撤销锁 §15.6 (P-6, ratified; lift conditions not met): a cancel round's progress names no
  // current approver — the V1 word stands in for the 待处理人 line.
  const NAMED_SEATS = [
    { id: 'as_1', type: 'user', assigneeId: 'approver_1', sourceStep: 1, nodeKey: 'cancel_approval', isActive: true, metadata: { assigneeName: '李四' } },
    { id: 'as_2', type: 'user', assigneeId: 'approver_2', sourceStep: 1, nodeKey: 'cancel_approval', isActive: true, metadata: { assigneeName: '王五' } },
  ] as UnifiedApprovalDTO['assignments']

  it('P-6: a pending cancel round shows the V1 word and no approver name', async () => {
    const r = row({ id: 'p6', workflowKey: CANCEL, status: 'pending', currentNodeKey: 'cancel_approval', assignments: NAMED_SEATS })
    const root = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: r, detailError: '' })
    await flushUi()
    const node = root.querySelector<HTMLElement>('.approval-detail-pane__node')!
    expect(root.querySelector('[data-testid="approval-detail-pane-cancel-round-pending"]')?.textContent?.trim()).toBe('撤销申请审批中')
    expect(node.textContent).not.toContain('李四')
    expect(node.textContent).not.toContain('王五')
    expect(node.textContent).not.toContain('待处理人')
  })

  it('P-6: an ordinary pending instance still lists 待处理人 by name', async () => {
    const r = row({ id: 'p7', status: 'pending', currentNodeKey: 'cancel_approval', assignments: NAMED_SEATS })
    const root = mount(ApprovalCenterDetailPane, { ...PANE, row: r, detail: r, detailError: '' })
    await flushUi()
    expect(root.querySelector('[data-testid="approval-detail-pane-cancel-round-pending"]')).toBeNull()
    expect(root.querySelector('.approval-detail-pane__node')!.textContent).toContain('待处理人：李四、王五')
  })
})

describe('MetaRecordApprovalPanel (P-2 record surface)', () => {
  it('routes every submission through the shared selector (a submission has no workflowKey ⇒ approvalInstance)', async () => {
    const submissions = [
      { id: 's1', templateId: 't1', templateName: '请假申请', status: 'rejected', drift: { changed: false, changedFieldIds: [] } },
      // Not a shape the backend produces (a cancel round is never a record submission): injected
      // only to prove the panel renders through the shared selector rather than a hard-coded domain.
      { id: 's2', templateId: 't2', templateName: 'x', status: 'pending', workflowKey: CANCEL, drift: { changed: false, changedFieldIds: [] } },
    ] as unknown as MetaRecordApprovalSubmission[]
    const client = { listRecordApprovals: vi.fn().mockResolvedValue({ submissions, hasMore: false }) }
    const root = mount(MetaRecordApprovalPanel, {
      record: { id: 'rec_1', version: 1, data: {} } as unknown as MetaRecord,
      sheetId: 'sheet_1',
      apiClient: client,
      refreshToken: 0,
    })
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-test="record-approval-toggle"]')!.click()
    await flushUi()
    const tags = root.querySelectorAll<HTMLElement>('.ms-status-tag')
    expect(tags).toHaveLength(2)
    expect(tags[0].dataset).toMatchObject({ domain: 'approvalInstance', status: 'rejected' })
    expect(tags[1].dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_pending_approval' })
  })
})

describe('useCancelRoundCloseReasons (list criterion read)', () => {
  it('a failed read is retried on the next ensure(); a resolved or in-flight read is not repeated', async () => {
    resetCancelRoundCloseReasonCache()
    getApprovalMock.mockReset()
    const target = { id: 'cr_retry', status: 'rejected', workflowKey: 'approval.cancel-round' }
    const { ensure, stateFor } = useCancelRoundCloseReasons()
    getApprovalMock.mockRejectedValueOnce(new Error('API error: 503'))
    ensure([target])
    ensure([target]) // in flight: no second read
    await flushUi()
    expect(getApprovalMock).toHaveBeenCalledTimes(1)
    expect(stateFor(target)).toEqual({ kind: 'unavailable' })
    getApprovalMock.mockResolvedValueOnce({ id: 'cr_retry', cancelRoundCloseReason: 'round_expired' })
    ensure([target])
    await flushUi()
    expect(getApprovalMock).toHaveBeenCalledTimes(2)
    expect(stateFor(target)).toEqual({ kind: 'resolved', closeReason: 'round_expired' })
    ensure([target])
    await flushUi()
    expect(getApprovalMock).toHaveBeenCalledTimes(2)
    resetCancelRoundCloseReasonCache()
  })
})
