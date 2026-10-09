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
import { useLocale } from '../src/composables/useLocale'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, ref, type App as VueApp } from 'vue'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'

const pushSpy = vi.fn().mockResolvedValue(undefined)
// Reactive so the P2-2 fix-round guard below can flip `route.params.id` mid-test (a route-param-
// only navigation, e.g. 下一条) and observe how ApprovalCommentsPanel.vue reacts to it — every
// OTHER test in this file only ever reads the initial 'apv_1' and is unaffected.
const mockRouteParams = reactive({ id: 'apv_1' })

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: mockRouteParams, query: {}, path: '/approvals/apv_1', meta: {} }),
  }
})

// ElMessage stub (same flake and fix as approval-e2e-lifecycle.spec.ts). A real toast is mounted
// into document.body, outside the test app, and closes itself after ~3 s. When that timer fires
// after this file's jsdom environment is torn down, the toast's leave transition calls the missing
// requestAnimationFrame and vitest fails the lane with an unhandled ReferenceError although every
// test passed. No test here asserts on toast DOM, so only ElMessage is replaced; every other
// element-plus export stays real.
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return {
    ...actual,
    ElMessage: Object.assign(vi.fn(), {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      closeAll: vi.fn(),
    }),
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
}))

// S3b: ApprovalDetailView.vue now unconditionally imports ApprovalCommentsPanel.vue (the 全文评论
// tab wrapper), which is real, unstubbed component in this harness — mocking its transport layer
// here keeps the "switching tabs mutates nothing" test below from making a real, unmocked
// `fetch` call the moment it activates the comments tab. Every method returns an empty/no-op
// result; nothing in this file asserts on comment CONTENT (that lives in
// approval-comments-panel.spec.ts / approval-comments-client.spec.ts).
// `createApprovalCommentsClientSpy` (gate P2-2 fix-round guard, 2026-08-22): counts factory
// invocations — `ApprovalCommentsPanel.vue` calls it exactly once in its own `setup()`, so this
// call count is a direct proxy for "did the panel instance remount". See the
// `:key="route.params.id"` describe block below, which asserts on it directly.
const createApprovalCommentsClientSpy = vi.fn()
vi.mock('../src/approvals/approvalCommentsClient', () => ({
  createApprovalCommentsClient: (...args: unknown[]) => {
    createApprovalCommentsClientSpy(...args)
    return {
      truncated: { value: false },
      listComments: vi.fn().mockResolvedValue({ comments: [] }),
      createComment: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
      updateComment: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
      deleteComment: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
      resolveComment: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
      addReaction: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
      removeReaction: vi.fn().mockRejectedValue(new Error('not exercised in this spec')),
    }
  },
  fetchApprovalCommentMentionCandidates: vi.fn().mockResolvedValue([]),
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

// O-8 / F8-1: the approval member surfaces follow the shell locale (useLocale); this suite asserts
// their zh-CN copy, so pin zh-CN before every test (a describe that needs English sets it itself).
beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

describe('ApprovalDetailView — UI-6 detail tab anchors + audit-derived record table', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockRouteParams.id = 'apv_1'
    createApprovalCommentsClientSpy.mockClear()
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
  // 1b. 全文评论 panel: `:key="route.params.id"` (gate finding P2-2, 2026-08-22)
  // -----------------------------------------------------------------------------------------
  describe('全文评论 panel — :key="route.params.id" forces a remount on instance navigation (gate P2-2)', () => {
    it('a route-param-only navigation (下一条) while the comments tab is active REMOUNTS ApprovalCommentsPanel — the client factory runs a second time', async () => {
      await mountView()
      q(container!, 'approval-detail-tab-comments')!.click()
      await flushUi()
      // One panel mount so far -> one client construction.
      expect(createApprovalCommentsClientSpy).toHaveBeenCalledTimes(1)

      // 下一条 / deep-link: only `route.params.id` changes, nothing else about the mount.
      mockRouteParams.id = 'apv_2'
      await flushUi()

      // Without `:key`, the SAME panel instance survives and its own `watch(instanceId, activate)`
      // re-activates in place — the client is constructed ONCE in `setup()` and never again, so
      // this count would stay 1 (this is exactly the shape of the instanceId settle race, gate
      // P2-2 / PROBE-F: the panel's composable/client never get replaced, only re-fed). Keying on
      // the route param unmounts the old instance and mounts a fresh one, so a SECOND, independent
      // client is constructed for `apv_2` — this is the actual mechanism the fix relies on, not
      // just its downstream symptom.
      expect(createApprovalCommentsClientSpy).toHaveBeenCalledTimes(2)
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
    mockRouteParams.id = 'apv_1'
    createApprovalCommentsClientSpy.mockClear()
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
      mockDetailActiveTemplate.value = { id: 'tpl_1', approvalGraph: { nodes: [{ key: 'start', type: 'start', name: '开始', config: {} }], edges: [] } }
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
      mockDetailActiveTemplate.value = { id: 'tpl_1', approvalGraph: { nodes: [{ key: 'start', type: 'start', name: '开始', config: {} }], edges: [] } }
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
      // The instance's own template (baseInstance's templateId) — T4cd: only that one may name nodes.
      mockDetailActiveTemplate.value = { id: 'tpl_1', approvalGraph: { nodes: [{ key: 'approval_1', type: 'approval', name: '部门主管审批', config: {} }], edges: [] } }
      await mountView()

      expect(container!.textContent).toContain('部门主管审批')
      expect(container!.textContent).not.toContain('节点已变更')
    })
  })
})

// -----------------------------------------------------------------------------------------------
// Test report 2026-10-08 T4cd — the 审批记录 timeline/table on a PLATFORM instance. The platform
// branch of GET /api/approvals/:id/history used to send only the snake_case columns, so this view
// (which reads the camelCase DTO) showed 「-」 for every time and 「系统」 for every actor. The
// server now adds camelCase copies beside the snake_case columns (unit-pinned in
// approval-history-routing.test.ts, real-DB-pinned in approval-history-authz-guard.db.test.ts);
// the rows below are that wire shape, taken through the REAL envelope normalizer.
//
// Once the stored actor reaches the view, the engine's own sentinels arrive as written ('system'
// named 'System'; `system:*` sentinels named after themselves) and an account with no name and no
// email arrives with its id as the name — none of which may render. These cases are RED at base,
// where the actor label was `actorName ?? '系统'`.
// -----------------------------------------------------------------------------------------------
describe('ApprovalDetailView — T4cd platform /history rows (snake_case + camelCase copies)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockRouteParams.id = 'apv_1'
    createApprovalCommentsClientSpy.mockClear()
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

  /** One platform row as the server now sends it: snake_case columns plus the camelCase copies. */
  function wireRow(id: string, action: string, actorId: string | null, actorName: string | null, occurredAt: string, fromStatus: string | null, toStatus: string): Record<string, unknown> {
    return {
      id,
      occurred_at: occurredAt,
      actor_id: actorId,
      actor_name: actorName,
      action,
      comment: null,
      from_status: fromStatus,
      to_status: toStatus,
      version: 1,
      from_version: null,
      to_version: 1,
      actorId,
      actorName,
      occurredAt,
      fromStatus,
      toStatus,
    }
  }

  async function historyFromWire(rows: Array<Record<string, unknown>>): Promise<any[]> {
    const { normalizeApprovalHistoryEnvelope } = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
    return normalizeApprovalHistoryEnvelope({ ok: true, data: { items: rows, page: 1, pageSize: 50, total: rows.length } })
  }

  function timelineItems(): HTMLElement[] {
    return Array.from(container!.querySelectorAll<HTMLElement>('[data-stub="ElTimelineItem"]'))
  }

  // The tester's own instance shape: approved by a person, a cc row the engine wrote, and the
  // requester's submission (newest first, as the route orders them).
  const APPROVED_AT = '2026-10-08T02:30:00.000Z'
  const CC_AT = '2026-10-08T02:30:00.000Z'
  const CREATED_AT = '2026-10-08T01:00:00.000Z'
  function testerInstanceRows(): Array<Record<string, unknown>> {
    return [
      wireRow('rec_3', 'approve', 'user_100', '李四', APPROVED_AT, 'pending', 'approved'),
      wireRow('rec_2', 'cc', 'system', 'System', CC_AT, 'pending', 'pending'),
      wireRow('rec_1', 'created', 'user_99', '张三', CREATED_AT, null, 'pending'),
    ]
  }

  it('timeline: every row shows its action time and the real actor; the engine-written cc row shows 系统, never the stored English name', async () => {
    mockHistory.value = await historyFromWire(testerInstanceRows())
    await mountView()

    const items = timelineItems()
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.getAttribute('timestamp'))).toEqual([
      new Date(APPROVED_AT).toLocaleString('zh-CN'),
      new Date(CC_AT).toLocaleString('zh-CN'),
      new Date(CREATED_AT).toLocaleString('zh-CN'),
    ])
    const actorLabels = items.map((item) => item.querySelector('.approval-detail__timeline-header strong')?.textContent?.trim())
    expect(actorLabels).toEqual(['李四', '系统', '张三'])
    const avatars = items.map((item) => item.querySelector('.approval-detail__actor-avatar')?.textContent?.trim())
    expect(avatars).toEqual(['李', '系', '张'])
    expect(container!.textContent).not.toContain('System')
  })

  it('table view: the 审批人 column names the real actors and every row carries its time', async () => {
    mockHistory.value = await historyFromWire(testerInstanceRows())
    await mountView()
    q(container!, 'approval-detail-record-view-table')!.click()
    await flushUi()

    const rows = recordTableRows(container!)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('[data-el-cell="审批人"]')?.textContent?.trim())).toEqual(['李四', '系统', '张三'])
    for (const [index, at] of [APPROVED_AT, CC_AT, CREATED_AT].entries()) {
      expect(rows[index].querySelector('.approval-detail__record-time')?.textContent?.trim()).toBe(new Date(at).toLocaleString('zh-CN'))
    }
  })

  it('every engine sentinel renders as 系统 / 系统自动审批 — never the sentinel or the stored English name', async () => {
    mockHistory.value = await historyFromWire([
      wireRow('rec_auto', 'approve', 'system:auto-approval', 'System Auto Approval', APPROVED_AT, 'pending', 'pending'),
      wireRow('rec_timeout', 'transfer', 'system:approval-timeout', 'system:approval-timeout', APPROVED_AT, 'pending', 'pending'),
      wireRow('rec_departure', 'transfer', 'system:approval-departure', 'system:approval-departure', APPROVED_AT, 'pending', 'pending'),
      wireRow('rec_1', 'created', 'user_99', '张三', CREATED_AT, null, 'pending'),
    ])
    await mountView()

    const actorLabels = timelineItems().map((item) => item.querySelector('.approval-detail__timeline-header strong')?.textContent?.trim())
    expect(actorLabels).toEqual(['系统自动审批', '系统', '系统', '张三'])
    const text = container!.textContent ?? ''
    expect(text).not.toContain('system:')
    expect(text).not.toContain('System Auto Approval')
    // No sentinel is ever sent to the directory resolver as if it were a person.
    for (const call of resolveApprovalDirectoryUsersSpy.mock.calls) {
      expect((call[0] as string[]).some((id) => id.startsWith('system'))).toBe(false)
    }
  })

  // Gate r1 P2-2: only a row whose stored name IS its id is named through the directory. A row with
  // NO stored name is left alone: no platform writer stores one (every route falls back to the id),
  // and the rows that carry none are a `plm:` instance's upstream rows (ApprovalBridgeService
  // getPlmHistory: `actorName: null`, the upstream user id as `actorId`). Those ids belong to the
  // upstream system, so a local lookup could name an unrelated local account; the rows keep the
  // baseline 系统 label. A blank stored name takes the same fallback instead of an empty label.
  it('a row with no stored name (a plm: upstream row) keeps 系统 and its id never reaches the directory resolver', async () => {
    mockRouteParams.id = 'plm:eco-approval-7'
    mockActiveApproval.value = baseInstance({ id: 'plm:eco-approval-7', sourceSystem: 'plm' })
    // A local account that happens to share the upstream id: resolving the upstream id would name it.
    resolveApprovalDirectoryUsersSpy.mockReset().mockResolvedValue([
      { id: '1', name: '赵六' },
      { id: 'user_blank_5', name: '孙七' },
    ])
    mockHistory.value = await historyFromWire([
      {
        id: '9',
        action: 'approve',
        actorId: '1',
        actorName: null,
        comment: null,
        fromStatus: null,
        toStatus: 'approved',
        occurredAt: APPROVED_AT,
        metadata: { ecoId: 3, stageId: 2, approvalType: 'stage', requiredRole: null },
      },
      wireRow('rec_blank', 'created', 'user_blank_5', '  ', CREATED_AT, null, 'pending'),
    ])
    await mountView()
    await flushUi(12)

    const items = timelineItems()
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.querySelector('.approval-detail__timeline-header strong')?.textContent?.trim())).toEqual(['系统', '系统'])
    expect(items.map((item) => item.querySelector('.approval-detail__actor-avatar')?.textContent?.trim())).toEqual(['系', '系'])
    expect(container!.textContent).not.toContain('赵六')
    expect(container!.textContent).not.toContain('孙七')
    const resolvedIds = resolveApprovalDirectoryUsersSpy.mock.calls.flatMap((call) => call[0] as string[])
    expect(resolvedIds).not.toContain('1')
    expect(resolvedIds).not.toContain('user_blank_5')
  })

  it('a row whose stored name is only the id shows the directory-resolved name, or 未知用户 — never the id', async () => {
    // Unresolved (inactive / nameless account): values-free fallback.
    mockHistory.value = await historyFromWire([
      wireRow('rec_idonly', 'approve', 'user_secret_77', 'user_secret_77', APPROVED_AT, 'pending', 'approved'),
    ])
    await mountView()
    await flushUi(12)
    expect(timelineItems()[0].querySelector('.approval-detail__timeline-header strong')?.textContent?.trim()).toBe('未知用户')
    expect(container!.textContent).not.toContain('user_secret_77')
    expect(resolveApprovalDirectoryUsersSpy).toHaveBeenCalled()
    expect(resolveApprovalDirectoryUsersSpy.mock.calls.flatMap((call) => call[0] as string[])).toContain('user_secret_77')

    // POSITIVE CONTROL: the same row resolves to the person's name once the directory has one.
    app!.unmount()
    app = null
    __resetResolvedDirectoryNamesForTests()
    resolveApprovalDirectoryUsersSpy.mockReset().mockResolvedValue([{ id: 'user_secret_77', name: '赵六' }])
    await mountView()
    await flushUi(12)
    expect(timelineItems()[0].querySelector('.approval-detail__timeline-header strong')?.textContent?.trim()).toBe('赵六')
    expect(container!.textContent).not.toContain('user_secret_77')
  })

  // T4cd node half (owner approval pending under the 2026-09-20 whitelist ruling): the server now
  // projects each row's `nodeKey` and `autoApproved`, so a platform row names its node and an
  // engine approval reads as one.
  describe('node half — metadata.nodeKey / metadata.autoApproved on platform rows', () => {
    const OWN_TEMPLATE = {
      id: 'tpl_1',
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'approval_1', type: 'approval', name: '部门主管审批', config: {} },
          { key: 'cc_1', type: 'cc', name: '抄送财务', config: {} },
        ],
        edges: [],
      },
    }

    function withMetadata(row: Record<string, unknown>, metadata: Record<string, unknown>): Record<string, unknown> {
      return { ...row, metadata }
    }

    it('timeline badges and the table node column name each row\'s node from the instance\'s own template', async () => {
      const [approve, cc, created] = testerInstanceRows()
      mockHistory.value = await historyFromWire([
        withMetadata(approve, { nodeKey: 'approval_1' }),
        withMetadata(cc, { nodeKey: 'cc_1' }),
        withMetadata(created, { nodeKey: 'start' }),
      ])
      mockDetailActiveTemplate.value = OWN_TEMPLATE
      await mountView()

      const badges = timelineItems().map((item) => Array.from(item.querySelectorAll('.approval-detail__meta-badge')).map((b) => b.textContent?.trim()))
      expect(badges).toEqual([['节点: 部门主管审批'], ['节点: 抄送财务'], ['节点: 发起']])

      q(container!, 'approval-detail-record-view-table')!.click()
      await flushUi()
      expect(recordTableRows(container!).map((row) => row.querySelector('[data-el-cell="节点名称"]')?.textContent?.trim()))
        .toEqual(['部门主管审批', '抄送财务', '发起'])
      expect(container!.textContent).not.toContain('approval_1')
    })

    it('an engine auto-approval row reads 系统自动审批 with the 自动审批 badge', async () => {
      mockHistory.value = await historyFromWire([
        withMetadata(
          wireRow('rec_auto', 'approve', 'system:auto-approval', 'System Auto Approval', APPROVED_AT, 'pending', 'approved'),
          { nodeKey: 'approval_1', autoApproved: true },
        ),
      ])
      mockDetailActiveTemplate.value = OWN_TEMPLATE
      await mountView()

      const item = timelineItems()[0]
      expect(item.querySelector('.approval-detail__timeline-header strong')?.textContent?.trim()).toBe('系统自动审批')
      const badges = Array.from(item.querySelectorAll('.approval-detail__meta-badge')).map((b) => b.textContent?.trim())
      expect(badges).toContain('自动审批')
      expect(badges).toContain('节点: 部门主管审批')
    })

    // T4cd-verify E1: projecting nodeKey is what first turns the parallel-branch grouping on for a
    // platform instance (before, every platform row fell into one 「其他」 bucket).
    it('a pending platform instance in a parallel region groups each branch\'s rows under its node name; 发起 and 抄送 land in 其他', async () => {
      mockActiveApproval.value = baseInstance({ currentNodeKey: null, currentNodeKeys: ['branch_a', 'branch_b'] })
      mockDetailActiveTemplate.value = {
        id: 'tpl_1',
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', name: '发起', config: {} },
            { key: 'cc_1', type: 'cc', name: '抄送财务', config: {} },
            { key: 'branch_a', type: 'approval', name: '财务审批', config: {} },
            { key: 'branch_b', type: 'approval', name: '法务审批', config: {} },
          ],
          edges: [],
        },
      }
      mockHistory.value = await historyFromWire([
        withMetadata(wireRow('rec_4', 'approve', 'user_201', '王五', APPROVED_AT, 'pending', 'pending'), { nodeKey: 'branch_b' }),
        withMetadata(wireRow('rec_3', 'approve', 'user_200', '赵六', APPROVED_AT, 'pending', 'pending'), { nodeKey: 'branch_a' }),
        withMetadata(wireRow('rec_2', 'cc', 'system', 'System', CC_AT, 'pending', 'pending'), { nodeKey: 'cc_1' }),
        withMetadata(wireRow('rec_1', 'created', 'user_99', '张三', CREATED_AT, null, 'pending'), { nodeKey: 'start' }),
      ])
      await mountView()

      const groups = Array.from(container!.querySelectorAll('.approval-detail__timeline-group'))
      expect(groups.map((group) => group.querySelector('.approval-detail__timeline-group-label')?.textContent?.trim()))
        .toEqual(['法务审批', '财务审批', '其他'])
      expect(groups.map((group) => Array.from(group.querySelectorAll('.approval-detail__timeline-header strong')).map((el) => el.textContent?.trim())))
        .toEqual([['王五'], ['赵六'], ['系统', '张三']])
    })

    it('a template store still holding ANOTHER template (this one failed to load) never names this instance\'s nodes', async () => {
      mockHistory.value = await historyFromWire([
        withMetadata(testerInstanceRows()[0], { nodeKey: 'approval_1' }),
      ])
      // Same default node key, different template: its name must not leak onto this instance.
      mockDetailActiveTemplate.value = { ...OWN_TEMPLATE, id: 'tpl_other', approvalGraph: { nodes: [{ key: 'approval_1', type: 'approval', name: '别的模板的节点', config: {} }], edges: [] } }
      await mountView()

      const badges = Array.from(timelineItems()[0].querySelectorAll('.approval-detail__meta-badge')).map((b) => b.textContent?.trim())
      expect(badges).toEqual(['节点: 节点已变更'])
      expect(container!.textContent).not.toContain('别的模板的节点')
    })
  })
})

// -----------------------------------------------------------------------------------------------
// Test report 2026-10-08 T4b — the 表单信息 「人员」 (user) field. Its value is stored as member ids,
// and the detail page printed them verbatim. UUID-shaped fixtures, so the discriminating negative
// ("the id never appears anywhere in the page") has a matching positive control (the same id renders
// the resolved name once the directory resolver returns one).
// -----------------------------------------------------------------------------------------------
describe('ApprovalDetailView — T4b form user (人员) values render names, never ids', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const OWNER = '5b9e2d47-8c13-4f6a-9b20-7e1d3c5a8f42'
  const MEMBER = 'c41f7a92-3d58-4b6e-a017-2f9d8e6b3c15'

  beforeEach(() => {
    mockRouteParams.id = 'apv_1'
    createApprovalCommentsClientSpy.mockClear()
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
    await flushUi(12)
  }

  function userFieldInstance(formSnapshot: Record<string, unknown>): any {
    return baseInstance({
      formSchema: {
        fields: [
          { id: 'fld_owner', type: 'user', label: '人员' },
          { id: 'fld_members', type: 'user', label: '参与人', props: { selection: 'multi' } },
          { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'who', type: 'user', label: '负责人' }] },
        ],
      },
      formSnapshot,
    })
  }

  function formValue(label: string): string | undefined {
    const row = Array.from(container!.querySelectorAll('.approval-detail__field'))
      .find((el) => el.querySelector('.approval-detail__label')?.textContent?.trim() === label)
    return row?.querySelectorAll('span')[1]?.textContent?.trim()
  }

  it('the 表单信息 人员 field shows the directory-resolved name, and the stored id appears nowhere on the page', async () => {
    resolveApprovalDirectoryUsersSpy.mockResolvedValue([{ id: OWNER, name: '王五' }])
    mockActiveApproval.value = userFieldInstance({ fld_owner: OWNER })
    await mountView()

    expect(formValue('人员')).toBe('王五')
    expect(resolveApprovalDirectoryUsersSpy.mock.calls.flatMap((call) => call[0] as string[])).toContain(OWNER)
    expect(container!.textContent).not.toContain(OWNER)
  })

  it('an id the directory cannot name (inactive or nameless account) shows 未知用户 — still never the id', async () => {
    mockActiveApproval.value = userFieldInstance({ fld_owner: OWNER })
    await mountView()

    expect(formValue('人员')).toBe('未知用户')
    expect(container!.textContent).not.toContain(OWNER)
  })

  it('a multi-person value and a 明细 person column resolve the same way; a historical {id, name} value is named by id, not by its stored name', async () => {
    resolveApprovalDirectoryUsersSpy.mockResolvedValue([{ id: OWNER, name: '王五' }])
    mockActiveApproval.value = userFieldInstance({
      fld_owner: { id: OWNER, name: '旧名字' },
      fld_members: [OWNER, MEMBER],
      // Lock-2B report §3: display metadata stored with a value is not authoritative — in a 明细
      // cell too, whatever display keys the stored object carries.
      items: [{ who: OWNER }, { who: MEMBER }, { who: { id: OWNER, name: '旧名字', displayValue: '旧显示名' } }],
    })
    await mountView()

    expect(formValue('人员')).toBe('王五')
    expect(formValue('参与人')).toBe('王五、未知用户')
    const cells = Array.from(container!.querySelectorAll('table.approval-detail__detail-table td[data-el-cell="负责人"]'))
      .map((cell) => cell.textContent?.trim())
    expect(cells).toEqual(['王五', '未知用户', '王五'])
    const text = container!.textContent ?? ''
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain(MEMBER)
    expect(text).not.toContain('旧名字')
    expect(text).not.toContain('旧显示名')
    expect(text).not.toContain('[object Object]')
  })
})
