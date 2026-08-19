/**
 * UI-6 (master §4 UI-6 / P5 "add detail tabs/record projection … only from existing
 * authoritative data") — ApprovalDetailView chrome:
 *
 *   1. Tab anchors (审批详情 | 审批记录 | 全文评论) above the right column. Anchor-style nav
 *      only — clicking a tab never dispatches a store action or fetches; desktop-only (mobile
 *      keeps current behavior, degrades to no tabs at all).
 *   2. 审批记录 view toggle: the pre-existing parallel-aware timeline (default, byte-for-byte
 *      unchanged — covered by approvalDetailPolish.spec.ts / approval-e2e-lifecycle.spec.ts /
 *      approval-e2e-permissions.spec.ts, all of which stay green UNMODIFIED) vs a NEW compact
 *      table projection of the SAME already-fetched `store.history` array — no new endpoint, no
 *      second fetch. Synthetic 提交/结束 bookend rows are computed at presentation time only
 *      (from the instance's own createdAt/requester/status/updatedAt) and are never written back
 *      into `store.history` or any outgoing payload.
 *
 * Same mount scaffold as approvalDetailPolish.spec.ts (store/router/auth/permissions/
 * templateStore mocked directly; the real ApprovalDetailView.vue + a broad Element Plus stub
 * set) plus a provide/inject el-table/el-table-column stub (same pattern as
 * approvalTemplateGovernance.spec.ts) so the new record table's rows are actually queryable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, ref, type App as VueApp } from 'vue'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: { id: 'apv_1' }, query: {}, path: '/approvals/apv_1', meta: {} }),
  }
})

const mockApprovalMobileFlag = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => (feature === 'approvalMobile' ? mockApprovalMobileFlag.value : false),
    features: ref({}),
  }),
}))

const mockCanAct = ref(false)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

// member-display-identity (2026-08-19): defaults to "nothing resolves" — this file's raw-id-shaped
// fixtures have no producer of `metadata.assigneeName`, matching the existing count-fallback
// pinned assertions unless a specific test overrides it.
const resolveApprovalDirectoryUsersSpy = vi.fn().mockResolvedValue([])
vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  resolveApprovalDirectoryUsers: (...args: unknown[]) => resolveApprovalDirectoryUsersSpy(...args),
  resolveApprovalDirectoryRoles: vi.fn().mockResolvedValue([]),
}))

const mockCurrentUserId = ref<string | null>(null)
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => (mockCurrentUserId.value ? { id: mockCurrentUserId.value } : null),
    getCurrentUserId: vi.fn().mockImplementation(async () => mockCurrentUserId.value),
  }),
}))

// P7-R2: settable (was hardcoded `null`/`null`) so the candidate #3 (nodeLabel values-free
// fallback) tests below can construct a live/pinned template drift shape. Defaults to null/null,
// so every pre-existing test in this file (none of which sets these) is unaffected.
const mockDetailActiveTemplate = ref<any>(null)
const mockDetailActiveVersion = ref<any>(null)
vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockDetailActiveTemplate.value },
    get activeVersion() { return mockDetailActiveVersion.value },
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

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean },
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
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String, confirmButtonText: String, cancelButtonText: String },
  emits: ['confirm'],
  render() {
    return h('div', { 'data-el-popconfirm': this.title }, [
      this.$slots.reference?.(),
      h('button', { 'data-testid': 'popconfirm-confirm-trigger', onClick: () => this.$emit('confirm') }),
    ])
  },
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

// -----------------------------------------------------------------------------------------------
// el-table / el-table-column — same provide/inject registry stub as
// approvalTemplateGovernance.spec.ts, so `#default="{ row }"` scoped-slot content (node/actor/
// result cells + reused badge markup) is actually rendered and queryable, not swallowed by a
// no-op generic stub.
// -----------------------------------------------------------------------------------------------
interface ColumnRegistryEntry {
  key: string
  label?: string
  defaultSlot?: (scope: { row: any }) => any
}
interface ColumnRegistry {
  columns: ColumnRegistryEntry[]
  register: (entry: ColumnRegistryEntry) => void
}
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, border: Boolean, size: String },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) { registry.columns.push(entry) },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('table', { 'data-el-table': 'true' }, [
        h('thead', { style: 'display:none' }, columnInstances),
        h('tbody', {}, rows.map((row, i) =>
          h('tr', { 'data-el-row': String(i), 'data-testid': 'approval-detail-record-table-row', key: (row?.id as string) ?? String(i) },
            registry.columns.map((col) =>
              h('td', { 'data-el-cell': col.label || col.key }, col.defaultSlot ? col.defaultSlot({ row }) : ''),
            ),
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
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) {
      registry.register({ key: `col-${columnSeq++}`, label: props.label, defaultSlot: slots.default })
    }
    return () => null
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
    currentNodeKey: 'approval_1',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    formSnapshot: { fld_reason: '出差报销' },
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [],
    ...overrides,
  }
}

function historyFixture(): any[] {
  return [
    {
      id: 'hist_1',
      action: 'created',
      actorId: 'user_99',
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: '2026-07-01T09:00:00.000Z',
      metadata: { nodeKey: 'start' },
    },
    {
      id: 'hist_2',
      action: 'approve',
      actorId: 'user_100',
      actorName: '李四',
      comment: '同意报销',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: '2026-07-01T10:00:00.000Z',
      metadata: { nodeKey: 'approval_1' },
    },
  ]
}

function autoApproveHistoryFixture(): any[] {
  return [
    ...historyFixture(),
    {
      id: 'hist_3',
      action: 'approve',
      actorId: null,
      actorName: '系统',
      comment: null,
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: '2026-07-01T11:00:00.000Z',
      metadata: { nodeKey: 'approval_2', autoApproved: true },
    },
  ]
}

// P2-2 fix: a history fixture with NO 'created' row — the structural predicate
// (`store.history.some((h) => h.action === 'created')`) must synthesize 提交 for this shape,
// unlike `historyFixture()` above (whose hist_1 IS a 'created' row and therefore suppresses it).
function historyFixtureNoCreated(): any[] {
  return [
    {
      id: 'hist_2',
      action: 'approve',
      actorId: 'user_100',
      actorName: '李四',
      comment: '同意报销',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: '2026-07-01T10:00:00.000Z',
      metadata: { nodeKey: 'approval_1' },
    },
  ]
}

function setViewport(mobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}
// Rows are scoped INSIDE the record-table container (not a bare document-wide testid query) so
// this can never accidentally pick up a future form-snapshot 明细 table that reuses the same
// ElTable stub if a fixture grows a `formSchema`.
function recordTableRows(container: HTMLElement): HTMLElement[] {
  const table = q(container, 'approval-detail-record-table')
  if (!table) return []
  return Array.from(table.querySelectorAll('[data-testid="approval-detail-record-table-row"]'))
}

describe('ApprovalDetailView — UI-6 detail tab anchors + audit-derived record table', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = historyFixture()
    mockLoading.value = false
    mockCanAct.value = false
    mockApprovalMobileFlag.value = false
    mockDetailActiveTemplate.value = null
    mockDetailActiveVersion.value = null
    setViewport(false)
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    pushSpy.mockClear()
    mockCurrentUserId.value = null
    resolveApprovalDirectoryUsersSpy.mockReset().mockResolvedValue([])
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag']) {
      app.component(name, stub(name))
    }
    app.component('ElDialog', ElDialog)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // -----------------------------------------------------------------------------------------
  // 1. Tab anchors
  // -----------------------------------------------------------------------------------------
  describe('tab anchors', () => {
    it('renders exactly the three named tabs on desktop (审批详情 | 审批记录 | 全文评论)', async () => {
      await mountView()

      const nav = q(container!, 'approval-detail-tabs')
      expect(nav).toBeTruthy()
      const texts = [
        q(container!, 'approval-detail-tab-info')?.textContent?.trim(),
        q(container!, 'approval-detail-tab-record')?.textContent?.trim(),
        q(container!, 'approval-detail-tab-comments')?.textContent?.trim(),
      ]
      expect(texts).toEqual(['审批详情', '审批记录', '全文评论'])
      // Exact set — no extra tab buttons inside the nav.
      expect(nav!.querySelectorAll('button')).toHaveLength(3)
    })

    it('degrades gracefully on mobile — no tabs, no record-view toggle, current mobile behavior unchanged', async () => {
      mockApprovalMobileFlag.value = true
      setViewport(true)
      mockCanAct.value = true
      await mountView()

      expect(q(container!, 'approval-detail-tabs')).toBeNull()
      expect(q(container!, 'approval-detail-record-toggle')).toBeNull()
      // The mobile action set itself is untouched by this slice.
      expect(q(container!, 'approval-approve-button')).toBeTruthy()
      expect(q(container!, 'approval-transfer-button')).toBeNull()
    })

    // P2-1 fix (gate PROBE B): a fresh mobile mount structurally cannot reach the trap state —
    // `isMobileLayout` is a LIVE computed (useMobileViewport registers a `resize` listener on
    // mount, not a mount-time-frozen value), so the real hazard is a DESKTOP→MOBILE transition
    // while `recordView === 'table'`. This test starts desktop, toggles to the table, then fires
    // the exact live transition the gate reproduced.
    it('desktop→mobile viewport transition while the table is active falls back to the timeline — no orphaned table (P2-1)', async () => {
      mockApprovalMobileFlag.value = true
      setViewport(false)
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      expect(q(container!, 'approval-detail-record-table')).toBeTruthy()
      expect(container!.querySelectorAll('[data-stub="ElTimelineItem"]')).toHaveLength(0)

      // Live viewport transition: matchMedia now matches max-width, then the resize event fires
      // the listener useMobileViewport registered on mount.
      setViewport(true)
      window.dispatchEvent(new Event('resize'))
      await flushUi()

      // No orphaned table — gated on !isMobileLayout AND the watcher resets recordView to
      // 'timeline' (belt+suspenders; either alone would satisfy this assertion).
      expect(q(container!, 'approval-detail-record-table')).toBeNull()
      expect(q(container!, 'approval-detail-record-toggle')).toBeNull()
      expect(q(container!, 'approval-detail-tabs')).toBeNull()
      // The timeline is back, not blank: same row count as the underlying history fixture.
      expect(container!.querySelectorAll('[data-stub="ElTimelineItem"]')).toHaveLength(mockHistory.value.length)
    })

    it('switching tabs mutates nothing (no fetch, no action dispatch) — positive control proves the SAME spies fire on a real action', async () => {
      mockCanAct.value = true
      await mountView()

      const detailCallsBefore = loadDetailSpy.mock.calls.length
      const historyCallsBefore = loadHistorySpy.mock.calls.length

      q(container!, 'approval-detail-tab-info')!.click()
      await flushUi()
      q(container!, 'approval-detail-tab-record')!.click()
      await flushUi()
      q(container!, 'approval-detail-tab-comments')!.click()
      await flushUi()

      expect(loadDetailSpy.mock.calls.length).toBe(detailCallsBefore)
      expect(loadHistorySpy.mock.calls.length).toBe(historyCallsBefore)
      expect(executeActionSpy).not.toHaveBeenCalled()

      // Positive control: the SAME executeActionSpy fires from a real action, proving the spy
      // wiring above isn't just silently inert.
      q(container!, 'approval-approve-button')!.click()
      await flushUi()
      q(container!, 'approval-action-dialog-confirm')!.click()
      await flushUi()
      expect(executeActionSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------------------------
  // 2. 审批记录 view toggle + table projection
  // -----------------------------------------------------------------------------------------
  describe('审批记录 table view', () => {
    it('defaults to the unchanged timeline — table not rendered until toggled', async () => {
      await mountView()

      expect(q(container!, 'approval-detail-record-table')).toBeNull()
      expect(q(container!, 'approval-detail-record-view-timeline')).toBeTruthy()
      expect(q(container!, 'approval-detail-record-view-table')).toBeTruthy()
    })

    // P2-2 fix, case 1 — fixture WITH a 'created' row (the default `historyFixture()`, and per
    // the PR body the shape the backend produces in practice): the audit trail's own 'created'
    // row IS the submission event, so NO synthetic 提交 is added on top of it — suppression is a
    // STRUCTURAL predicate (`store.history.some((h) => h.action === 'created')`), not a value
    // heuristic on actor/timestamp. Table rows are then a plain 1:1 projection of `store.history`.
    it('table rows equal timeline entries 1:1, NO synthetic 提交, when history already carries a created row (P2-2 fix, case 1)', async () => {
      // Fixture has exactly 2 history entries (hist_1 'created', hist_2 'approve') — asserted
      // directly so this test can't silently pass a mutation that inflates both the fixture and
      // the rendered rows together (see the mutation-probe note in this file's header comment).
      expect(mockHistory.value).toHaveLength(2)
      expect(mockHistory.value[0].action).toBe('created')
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      const rows = recordTableRows(container!)
      // Hardcoded, not derived from `mockHistory.value.length`: 0 synthetic 提交 (created row
      // already present) + 2 real history rows (1:1 with the fixture above) + 0 结束 (pending).
      expect(rows).toHaveLength(2)

      // Row 0 IS the real 'created' history row, rendered as itself (发起), not relabelled 提交.
      // P7-R2 candidate #3 fix: this file's templateStore mock stays `activeTemplate: null` /
      // `activeVersion: null` (no template ever loaded), which is exactly `nodeLabel`'s
      // no-template-reachable case — it now renders the values-free fallback instead of the raw
      // node key ('start'/'approval_1' below). This assertion USED TO pin the raw-key leak; the
      // updated value is the fix landing, not a relaxed check (see approval-flow-canvas-a11y-
      // adjacent P7-R2 slice / ApprovalDetailView.vue `nodeLabel`).
      expect(rows[0].querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()).toBe('节点已变更')
      expect(rows[0].querySelector('[data-el-cell="审批人"]')?.textContent?.trim()).toBe('张三')
      expect(rows[0].querySelector('[data-el-cell="审批结果/时间"]')?.textContent).toContain('发起')

      // Real row 2 (hist_2 'approve') — a specific row's actor/node, matching the fixture.
      expect(rows[1].querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()).toBe('节点已变更')
      expect(rows[1].querySelector('[data-el-cell="审批人"]')?.textContent?.trim()).toBe('李四')
      expect(rows[1].querySelector('[data-el-cell="审批结果/时间"]')?.textContent).toContain('通过')

      // A row with plain metadata (only `nodeKey`, which the table already shows via its own
      // 节点名称 column) renders no empty badge container — hasRecordTableBadgeMetadata is not
      // just hasTimelineMetadata reused verbatim.
      expect(rows[0].querySelector('.approval-detail__timeline-meta')).toBeNull()
    })

    // P2-2 fix, case 2 — fixture WITHOUT a 'created' row: the structural predicate must still
    // synthesize 提交 from the instance's own requester/createdAt so instances whose audit trail
    // (for whatever reason) never recorded a 'created' action don't silently lose the submission
    // row entirely.
    it('synthesizes the 提交 bookend when history has no created row (P2-2 fix, case 2)', async () => {
      mockHistory.value = historyFixtureNoCreated()
      expect(mockHistory.value).toHaveLength(1)
      expect(mockHistory.value.some((h) => h.action === 'created')).toBe(false)
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      const rows = recordTableRows(container!)
      // Hardcoded: 1 synthetic 提交 (no created row to defer to) + 1 real history row + 0 结束.
      expect(rows).toHaveLength(2)
      expect(rows[0].querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()).toBe('提交')
      expect(rows[0].querySelector('[data-el-cell="审批人"]')?.textContent?.trim()).toBe('张三')
      // P7-R2 candidate #3 fix — see the comment on the sibling assertion above.
      expect(rows[1].querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()).toBe('节点已变更')
    })

    it('appends a synthetic 结束 row only once the instance is terminal', async () => {
      mockActiveApproval.value = baseInstance({ status: 'approved' })
      expect(mockHistory.value).toHaveLength(2)
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      const rows = recordTableRows(container!)
      // Hardcoded: 0 提交 (default fixture's hist_1 is a 'created' row) + 2 history + 1 结束
      // (terminal status).
      expect(rows).toHaveLength(3)
      const last = rows[rows.length - 1]
      expect(last.querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()).toBe('结束')
      expect(last.querySelector('[data-el-cell="审批人"]')?.textContent?.trim()).toBe('-')
      expect(last.querySelector('[data-el-cell="审批结果/时间"]')?.textContent).toContain('已通过')
    })

    it('reuses the existing badge helpers — auto-approval badge appears in the table exactly as the timeline shows it', async () => {
      mockHistory.value = autoApproveHistoryFixture()
      expect(mockHistory.value).toHaveLength(3)
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      const rows = recordTableRows(container!)
      expect(rows).toHaveLength(3) // 0 提交 (hist_1 is 'created') + 3 history rows, still pending.
      const autoRow = rows[rows.length - 1] // last real history row (hist_3, autoApproved)
      expect(autoRow.textContent).toContain('系统自动审批')
      expect(autoRow.querySelector('.approval-detail__meta-badge--auto')?.textContent?.trim()).toBe('自动审批')
    })

    it('parallel region: the timeline still groups by branch (untouched, EXCLUDED from this slice); the table renders a flat 1:1 projection instead', async () => {
      mockActiveApproval.value = baseInstance({ currentNodeKeys: ['approval_1', 'approval_2'] })
      await mountView()

      // Default view: the pre-existing parallel-aware timeline groups by branch — this slice
      // does not replace it (master lock §4 UI-6 EXCLUDED clause).
      expect(q(container!, 'approval-detail-record-table')).toBeNull()
      expect(container!.querySelector('.approval-detail__timeline-group')).toBeTruthy()

      // Table view: same underlying history, rendered flat (no branch grouping) — still 1:1.
      // 0 提交 (default fixture's hist_1 is a 'created' row) + 2 history rows.
      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      expect(recordTableRows(container!)).toHaveLength(2)
      expect(container!.querySelector('.approval-detail__timeline-group')).toBeNull()
    })

    it('toggling back to timeline restores the original, unmodified el-timeline-item markup', async () => {
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      expect(q(container!, 'approval-detail-record-table')).toBeTruthy()

      q(container!, 'approval-detail-record-view-timeline')!.click()
      await flushUi()
      expect(q(container!, 'approval-detail-record-table')).toBeNull()
      expect(container!.querySelectorAll('[data-stub="ElTimelineItem"]')).toHaveLength(mockHistory.value.length)
    })

    // P3-1 fix: zero audit rows must show the "暂无审批历史" empty state, not a lone synthetic
    // row that reads as a plausible (but fabricated) record — regardless of what any bookend
    // predicate alone would produce. The table's own `v-if` is gated on `store.history.length` in
    // addition to `recordView === 'table' && !isMobileLayout`, so an empty history falls through
    // to the SAME `v-else` empty-state branch the timeline already used before this PR.
    it('zero audit rows in table mode renders the empty state, not a lone synthetic row (P3-1)', async () => {
      mockHistory.value = []
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      expect(q(container!, 'approval-detail-record-table')).toBeNull()
      expect(recordTableRows(container!)).toHaveLength(0)
      // The timeline region's empty-state stub renders (scoped to that region so this can't
      // accidentally match the unrelated "暂无表单数据" empty state on the form side).
      expect(container!.querySelector('.approval-detail__timeline [data-stub="ElEmpty"]')).toBeTruthy()
    })
  })

  // -----------------------------------------------------------------------------------------
  // 3. No second fetch / synthetic rows never persisted
  // -----------------------------------------------------------------------------------------
  describe('no second fetch, no persistence of synthetic rows', () => {
    it('switching to the table view triggers no additional store fetch — table derives from the SAME already-fetched history', async () => {
      await mountView()

      const detailCallsBefore = loadDetailSpy.mock.calls.length
      const historyCallsBefore = loadHistorySpy.mock.calls.length

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()

      expect(loadDetailSpy.mock.calls.length).toBe(detailCallsBefore)
      expect(loadHistorySpy.mock.calls.length).toBe(historyCallsBefore)
    })

    it('the synthetic 结束 bookend (terminal fixture) is presentation-only — store.history stays byte-identical', async () => {
      mockActiveApproval.value = baseInstance({ status: 'approved' })
      const originalHistory = mockHistory.value
      expect(originalHistory).toHaveLength(2) // hardcoded fixture size, not derived
      const originalSnapshot = JSON.stringify(originalHistory)
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      // Confirm the table actually grew the synthetic 结束 bookend (sanity: this isn't vacuous;
      // 提交 stays suppressed here — the default fixture's hist_1 is a 'created' row) — hardcoded
      // count, so a mutation that leaks a synthetic row into `store.history` (which would inflate
      // BOTH this count and `originalHistory.length` together) cannot hide behind a
      // self-referential `originalLength + 1` comparison.
      expect(recordTableRows(container!)).toHaveLength(3)

      // The underlying store array — what a real submit path would send onward — must stay
      // byte-identical: no synthetic row was spliced into it.
      expect(mockHistory.value).toBe(originalHistory)
      expect(mockHistory.value.length).toBe(2)
      expect(JSON.stringify(mockHistory.value)).toBe(originalSnapshot)
      // No new endpoint, no write purely from toggling/rendering the table.
      expect(executeActionSpy).not.toHaveBeenCalled()
    })

    it('the synthetic 提交 bookend is absent from a real outgoing action payload (positive-control outcome assertion, not just a bare negative)', async () => {
      // No-created-row fixture so 提交 actually renders (the default fixture's hist_1 IS a
      // 'created' row, which per the P2-2 fix suppresses the synthetic bookend entirely — that
      // would make this payload assertion vacuously true, not a real proof).
      mockHistory.value = historyFixtureNoCreated()
      mockCanAct.value = true
      await mountView()

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      expect(recordTableRows(container!)).toHaveLength(2) // 1 提交 + 1 history, still pending

      // A REAL action fires while the table view (with its synthetic 提交 row) is active — assert
      // the exact payload, proving the synthetic row is absent from what actually goes out, not
      // merely that no call happened to occur.
      q(container!, 'approval-approve-button')!.click()
      await flushUi()
      q(container!, 'approval-action-dialog-confirm')!.click()
      await flushUi()
      expect(executeActionSpy).toHaveBeenCalledTimes(1)
      expect(executeActionSpy).toHaveBeenCalledWith('apv_1', { action: 'approve', comment: undefined })
    })
  })
})

// -----------------------------------------------------------------------------------------------
// P7-R2 (P7 phase-A evidence ledger §2 "raw-exposure candidates", ApprovalDetailView.vue) — three
// template-reachable, member-facing sites the ledger recorded as CANDIDATES (not FAILs) because
// their triggering data shape was never constructed. Each block below constructs the exact named
// shape, so it is both the confirmation (the shape reaches this code path in the real component)
// and the fix pin (the humanized/values-free copy renders; the raw JSON/id/key never does). Each
// was independently confirmed against the pre-fix source by a manual mutation revert
// (cp-backup + sha256 restore) during P7-R2 verification — see the PR body for the mutation log.
// -----------------------------------------------------------------------------------------------
describe('ApprovalDetailView — P7-R2 values-free candidates', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = []
    mockLoading.value = false
    mockCanAct.value = false
    mockApprovalMobileFlag.value = false
    mockDetailActiveTemplate.value = null
    mockDetailActiveVersion.value = null
    setViewport(false)
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    pushSpy.mockClear()
    mockCurrentUserId.value = null
    resolveApprovalDirectoryUsersSpy.mockReset().mockResolvedValue([])
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
    for (const name of ['ElDivider', 'ElEmpty', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag']) {
      app.component(name, stub(name))
    }
    app.component('ElDialog', ElDialog)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  // -----------------------------------------------------------------------------------------
  // Candidate #1 — formatFieldValue: an object-valued detail/sub-form cell used to render raw
  // JSON via JSON.stringify (ApprovalDetailView.vue formatFieldValue, formerly :1629).
  // -----------------------------------------------------------------------------------------
  describe('candidate #1 — formatFieldValue never renders raw JSON for an object-valued detail cell', () => {
    function detailFieldInstance(cellValue: unknown): any {
      return baseInstance({
        formSchema: {
          fields: [
            { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'note', type: 'text', label: '备注' }] },
          ],
        },
        formSnapshot: { items: [{ note: cellValue }] },
      })
    }

    it('a known display key (displayValue) resolves to that value, not the raw object', async () => {
      mockActiveApproval.value = detailFieldInstance({ displayValue: '出差申请-001', internalRecordId: 'rec_secret_9f2' })
      await mountView()

      const cell = container!.querySelector('table.approval-detail__detail-table td[data-el-cell="备注"]')
      expect(cell?.textContent?.trim()).toBe('出差申请-001')
      expect(container!.textContent).not.toContain('rec_secret_9f2')
      expect(container!.textContent).not.toContain('internalRecordId')
    })

    it('no known display key falls back to a values-free placeholder, never JSON.stringify', async () => {
      mockActiveApproval.value = detailFieldInstance({ internalRowId: 'row_secret_7ac1', weird: true })
      await mountView()

      const cell = container!.querySelector('table.approval-detail__detail-table td[data-el-cell="备注"]')
      expect(cell?.textContent?.trim()).toBe('复杂内容')
      expect(container!.textContent).not.toContain('row_secret_7ac1')
      expect(container!.textContent).not.toContain('internalRowId')
      // No raw-object punctuation anywhere inside the rendered cell (the pre-fix JSON.stringify
      // shape always contains a brace) — a mutation-proof net wider than the specific id string.
      expect(cell?.textContent).not.toMatch(/[{}]/)
    })

    // P7-R2 gate hardening (P2-2/P3-2): the Array.isArray branch was untouched by the original
    // fix and rendered raw ids verbatim (['rec_secret_aaa', …] joined as-is). Constructs the
    // gate's exact leak shape through the REAL production call path (`formatFieldValue(value,
    // column)` — the column carries the field's OWN authored `options` whitelist).
    function multiSelectFieldInstance(cellValue: unknown, options: Array<{ label: string; value: string }>): any {
      return baseInstance({
        formSchema: {
          fields: [
            {
              id: 'items', type: 'detail', label: '明细',
              columns: [{ id: 'tags', type: 'multi-select', label: '标签', options }],
            },
          ],
        },
        formSnapshot: { items: [{ tags: cellValue }] },
      })
    }

    it('array values: a value found in the column\'s own options whitelist renders its label', async () => {
      mockActiveApproval.value = multiSelectFieldInstance(['opt_a', 'opt_b'], [
        { label: '紧急', value: 'opt_a' },
        { label: '常规', value: 'opt_b' },
      ])
      await mountView()

      const cell = container!.querySelector('table.approval-detail__detail-table td[data-el-cell="标签"]')
      expect(cell?.textContent?.trim()).toBe('紧急, 常规')
    })

    it('array values: a raw id NOT in the options whitelist never renders verbatim (P2-2/P3-2 fix)', async () => {
      // The gate's exact repro shape — a leaf-contract-violating array of raw record ids.
      mockActiveApproval.value = multiSelectFieldInstance(['rec_secret_aaa', 'rec_secret_bbb'], [
        { label: '紧急', value: 'opt_a' },
      ])
      await mountView()

      const cell = container!.querySelector('table.approval-detail__detail-table td[data-el-cell="标签"]')
      expect(cell?.textContent).not.toContain('rec_secret_aaa')
      expect(cell?.textContent).not.toContain('rec_secret_bbb')
      expect(cell?.textContent?.trim()).toBe('未知选项, 未知选项')
    })

    it('array values: object elements resolve through the same known-key-or-placeholder logic, never [object Object]', async () => {
      mockActiveApproval.value = baseInstance({
        formSchema: {
          fields: [
            { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'note', type: 'text', label: '备注' }] },
          ],
        },
        formSnapshot: { items: [{ note: [{ internalRecordId: 'rec_x' }, { displayValue: '张三' }] }] },
      })
      await mountView()

      const cell = container!.querySelector('table.approval-detail__detail-table td[data-el-cell="备注"]')
      expect(cell?.textContent).not.toContain('rec_x')
      expect(cell?.textContent).not.toContain('[object Object]')
      expect(cell?.textContent?.trim()).toBe('复杂内容, 张三')
    })
  })

  // -----------------------------------------------------------------------------------------
  // Candidate #2 — cancelledAssigneesLabel: an any-mode (或签) cancellation badge used to join
  // raw `String(id)` user ids (ApprovalDetailView.vue cancelledAssigneesLabel, formerly :1612).
  // -----------------------------------------------------------------------------------------
  describe('candidate #2 — cancelledAssigneesLabel never renders a raw user id', () => {
    function historyWithCancelled(cancelled: string[]): any[] {
      return [{
        id: 'hist_1', action: 'sign', actorId: 'user_100', actorName: '李四', comment: null,
        fromStatus: 'pending', toStatus: 'pending', occurredAt: '2026-07-01T10:00:00.000Z',
        metadata: { nodeKey: 'approval_1', aggregateCancelled: cancelled },
      }]
    }

    it('resolves to the display name when the instance already carries it in assignment metadata', async () => {
      mockActiveApproval.value = baseInstance({
        assignments: [
          { id: 'asg_1', type: 'user', assigneeId: 'user_secret_42', sourceStep: 1, nodeKey: 'approval_1', isActive: false, metadata: { assigneeName: '王五' } },
        ],
      })
      mockHistory.value = historyWithCancelled(['user_secret_42'])
      await mountView()

      expect(container!.textContent).toContain('其他审批人已失效: 王五')
      expect(container!.textContent).not.toContain('user_secret_42')
    })

    it('falls back to a values-free count when no display name is reachable, never the raw id', async () => {
      mockActiveApproval.value = baseInstance({ assignments: [] })
      mockHistory.value = historyWithCancelled(['user_secret_42', 'user_secret_43'])
      await mountView()

      expect(container!.textContent).toContain('其他 2 位审批人已失效')
      expect(container!.textContent).not.toContain('user_secret_42')
      expect(container!.textContent).not.toContain('user_secret_43')
    })

    // POSITIVE CONTROL, resolver path (member-display-identity, 2026-08-19): proves the NEW
    // `getResolvedUserName` path — not just the pre-existing assignment-metadata path the first
    // test in this block already covers — turns the cancelled ids into real names.
    it('resolves to real names via the directory resolver when no assignment metadata carries them (positive control)', async () => {
      resolveApprovalDirectoryUsersSpy.mockResolvedValue([
        { id: 'user_secret_42', name: '钱八' },
        { id: 'user_secret_43', name: '周九' },
      ])
      mockActiveApproval.value = baseInstance({ assignments: [] })
      mockHistory.value = historyWithCancelled(['user_secret_42', 'user_secret_43'])
      await mountView()
      await flushUi(12)

      expect(container!.textContent).toContain('其他审批人已失效: 钱八、周九')
      expect(container!.textContent).not.toContain('user_secret_42')
      expect(container!.textContent).not.toContain('user_secret_43')
    })

    // Mixed case: ONE of two cancelled ids resolves, the other doesn't -- the all-or-nothing
    // convention (mirrors the pre-existing assignment-metadata behavior) must fall back to the
    // values-free count rather than a partial name list padded with a placeholder.
    it('a PARTIAL resolve (one id resolves, one does not) still falls back to the values-free count', async () => {
      resolveApprovalDirectoryUsersSpy.mockResolvedValue([{ id: 'user_secret_42', name: '钱八' }])
      mockActiveApproval.value = baseInstance({ assignments: [] })
      mockHistory.value = historyWithCancelled(['user_secret_42', 'user_secret_43'])
      await mountView()
      await flushUi(12)

      expect(container!.textContent).toContain('其他 2 位审批人已失效')
      expect(container!.textContent).not.toContain('钱八')
      expect(container!.textContent).not.toContain('user_secret_42')
      expect(container!.textContent).not.toContain('user_secret_43')
    })
  })

  // -----------------------------------------------------------------------------------------
  // Candidate #3 (ledger's HIGHEST PRIORITY — fires on ORDINARY template drift, not an exotic
  // shape) — nodeLabel: a node absent from the live template used to fall back to the raw
  // `nodeKey` (ApprovalDetailView.vue nodeLabel, formerly :1617).
  // -----------------------------------------------------------------------------------------
  describe('candidate #3 — nodeLabel never renders a raw node key on template drift', () => {
    function historyWithNodeKey(nodeKey: string): any[] {
      return [{
        id: 'hist_1', action: 'approve', actorId: 'user_100', actorName: '李四', comment: null,
        fromStatus: 'pending', toStatus: 'pending', occurredAt: '2026-07-01T10:00:00.000Z',
        metadata: { nodeKey },
      }]
    }

    it('a node key absent from the live template renders a values-free fallback, never the raw key', async () => {
      mockHistory.value = historyWithNodeKey('ghost_node_removed_9f2')
      mockDetailActiveTemplate.value = { approvalGraph: { nodes: [{ key: 'start', type: 'start', name: '开始', config: {} }], edges: [] } }
      mockDetailActiveVersion.value = null
      await mountView()

      expect(container!.textContent).toContain('节点已变更')
      expect(container!.textContent).not.toContain('ghost_node_removed_9f2')
    })

    // P7-R2 gate hardening (P2-1): an earlier revision of this test asserted a PINNED
    // (`activeVersion`) fallback that only ever fires for template admins — `loadVersion`'s
    // endpoint is `approvalTemplateAdminGuard`-gated, so an ordinary member's `activeVersion`
    // never populates and that branch always re-searched the same live graph it had already
    // missed. Removed (see the `nodeLabel` comment). This test now proves the removal directly:
    // even when `activeVersion` WOULD carry the drifted node under a name (an admin-only shape a
    // member's app state would never actually reach), `nodeLabel` must not consult it — the
    // values-free fallback fires regardless, so a member is never shown a name from a graph they
    // have no way to have loaded.
    it('does NOT consult a pinned/admin-only activeVersion on drift — values-free fallback fires regardless (P2-1 fix)', async () => {
      mockHistory.value = historyWithNodeKey('approval_1')
      // Live template: node renamed/removed since this history row's node ran.
      mockDetailActiveTemplate.value = { approvalGraph: { nodes: [{ key: 'start', type: 'start', name: '开始', config: {} }], edges: [] } }
      // Even if some future/admin code path populated activeVersion with the historical name,
      // nodeLabel must not reach for it — this shape must never leak through.
      mockDetailActiveVersion.value = { approvalGraph: { nodes: [{ key: 'approval_1', type: 'approval', name: '部门主管审批（历史）', config: {} }], edges: [] } }
      await mountView()

      expect(container!.textContent).toContain('节点已变更')
      expect(container!.textContent).not.toContain('部门主管审批（历史）')
      expect(container!.textContent).not.toContain('approval_1')
    })

    it('a node key present in the live template resolves to its live name (unaffected, still the common case)', async () => {
      mockHistory.value = historyWithNodeKey('approval_1')
      mockDetailActiveTemplate.value = { approvalGraph: { nodes: [{ key: 'approval_1', type: 'approval', name: '部门主管审批', config: {} }], edges: [] } }
      await mountView()

      expect(container!.textContent).toContain('部门主管审批')
      expect(container!.textContent).not.toContain('节点已变更')
    })
  })
})
