import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'

// The first mounted test pays for the dynamic `import()` of ApprovalDetailView.vue plus a full
// mount — the same ~10 s cold start approval-member-bar-operation-policy.spec.ts measured against
// vitest's 5 s default — so the budget is raised the same way.
vi.setConfig({ testTimeout: 15_000 })
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

/**
 * 退回 (return) candidates on the mounted ApprovalDetailView — the FE mirror of the server's
 * return gate.
 *
 * `dispatchAction` (packages/core-backend/src/services/ApprovalProductService.ts) refuses a return
 * in three places, and every candidate it refuses used to be offered anyway, as an option that could
 * only ever 409:
 *
 *   | server check                                                     | 409 code                                 | FE gate                                          | tests       |
 *   |------------------------------------------------------------------|------------------------------------------|--------------------------------------------------|-------------|
 *   | (a) current node is a handler (Lock-3 §2.2 verb gate)            | APPROVAL_HANDLER_ACTION_NOT_ALLOWED      | cursor type `'handler'` (DTO field, else graph)  | T5, T5b     |
 *   | (b) instance is in a parallel region (`isInParallelRegion`)      | APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED  | `currentNodeKeys` non-empty, or cursor type      | T6, T6b,    |
 *   |                                                                  |                                          | `'parallel'`                                     | T6c         |
 *   | (c) target not in `ApprovalGraphExecutor                         | APPROVAL_RETURN_TARGET_INVALID           | visited key must be a node of the instance's     | T14         |
 *   |     .listVisitedApprovalNodeKeysUntil(current).slice(0, -1)`     |                                          | OWN graph, an `approval` node, outside every     | T2, T3, T4  |
 *   |     — the walker stops AT the cursor                             |                                          | parallel region, and UPSTREAM of the cursor      | T11, T12,   |
 *   |                                                                  |                                          | (skipped for a cursor the graph lacks)           | T15         |
 *
 * plus the choices around (c) that are owner-visible: no graph reachable ⇒ today's unfiltered list
 * (T7); an absent `currentNodeType` is never read as "handler" (T8); only this instance's own
 * template / pinned version may judge it (T9, T9b, T9c), and the template only while its LATEST
 * version IS the pinned one — a later version (drift) or no version id to compare counts as no graph
 * (T13, T13b); with the template drifted, an admin's pinned version still judges (T10). T1 is the
 * positive control every "hidden" assertion leans on.
 *
 * THE SERVER'S OWN LIST (TS1–TS4): both DTO builders now ship `returnableNodeKeys`, the targets the
 * return gate would accept right now, walked server-side on the frozen graph. When the DTO carries
 * that array the view offers it verbatim and bypasses every mirror above — a strict subset of what
 * history + graph would offer is all that appears (TS1), `[]` hides 退回 even where the mirrors would
 * offer a target (TS2), a key the mirrors would drop, or that history never held, is still offered
 * because the server wins (TS3, TS3b) — while `null` / absent means "not computed" and falls through
 * to the mirrors, which every other test here exercises (TS4).
 *
 * NOT mirrored (no test can pin a gate that does not exist; recorded in the view): an approval node
 * on a condition branch the form no longer resolves to is still offered, and a trail node nobody
 * visited (an admin forward jump skipped it) is never offered.
 *
 * Two DTO shapes are exercised on purpose, because the two builders do not ship the same fields and
 * the store publishes an action response into the slot the detail read fills: the DETAIL READ
 * (ApprovalBridgeService `toUnifiedDTO`) carries `currentNodeType` and never `currentNodeKeys`; an
 * ACTION RESPONSE (ApprovalProductService `toUnifiedApprovalDTO`) carries `currentNodeKeys` and
 * never `currentNodeType`.
 *
 * Graph fixture (the canvas joins a parallel region at the next real node, as
 * `insertParallelGateway` does — there is no "join" node type):
 *
 *   start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ approval_2 → approval_3 → end
 *
 * with history rows at approval_1, cc_1, handler_1, approval_p1 and approval_2 (the cursor). The
 * server's legal set for a cursor at approval_2 is exactly [approval_1]. T11/T12 use a plain linear
 * start → approval_1 → approval_2 → approval_3 → end, with history in `/history`'s own newest-first
 * order and a 退回 row carrying the RETURNING node's key, as the server writes it.
 *
 * Harness copied from approval-member-bar-operation-policy.spec.ts (mocked approvals store exposing
 * `activeApproval` / `history` as getters, element-plus stubs that render a real <select>/<option>),
 * with the template store mock made controllable per test through mutable `activeTemplate` /
 * `activeVersion` holders.
 */

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), back: vi.fn() }),
    useRoute: () => ({ params: { id: 'apv_1' }, query: {}, path: '/approvals/apv_1', meta: {} }),
  }
})

// Same ElMessage stub (and reason) as the member-bar spec: a real toast outlives the jsdom teardown.
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

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false }),
}))

const mockCanAct = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: mockCanAct }),
}))

vi.mock('../src/approvals/components/ApprovalUserPicker.vue', () => ({
  default: {
    name: 'ApprovalUserPicker',
    props: ['modelValue', 'placeholder'],
    emits: ['update:modelValue', 'select'],
    setup() {
      return () => h('div', { 'data-testid': 'stub-user-picker' })
    },
  },
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
  resolveApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'user_1' }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
  }),
}))

// Controllable per test. Getters, so the view's computeds track the holders exactly as they track
// the real store's refs.
const mockActiveTemplate = ref<any>(null)
const mockActiveVersion = ref<any>(null)
vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockActiveTemplate.value },
    get activeVersion() { return mockActiveVersion.value },
    loadTemplate: vi.fn().mockResolvedValue(undefined),
    loadVersion: vi.fn().mockResolvedValue(undefined),
  }),
}))

const mockActiveApproval = ref<any>(null)
const mockHistory = ref<any[]>([])
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
    executeAction: vi.fn().mockResolvedValue({}),
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

// Renders its body whether or not it is open (like the member-bar stub), so the option list is
// always in the DOM: visibility is asserted through `data-dialog-visible`, and option queries are
// scoped to the return dialog's own test id.
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

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, type: String, rows: Number },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () => h('input', {
      ...attrs,
      value: props.modelValue,
      placeholder: props.placeholder,
      onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Number, null] as never, placeholder: String, filterable: Boolean },
  emits: ['update:modelValue'],
  setup(props, { slots, emit, attrs }) {
    return () => h('select', {
      ...attrs,
      'data-el-select': 'true',
      value: props.modelValue ?? '',
      onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value),
    }, slots.default ? slots.default() : [])
  },
})

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
    await nextTick()
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures — generic, values-free.
// ---------------------------------------------------------------------------------------------

const TEMPLATE_ID = 'tpl_rc'
const VERSION_ID = 'ver_rc_1'

function approvalNode(key: string, name: string) {
  return { key, type: 'approval', name, config: { assigneeType: 'user', assigneeIds: ['user_1'] } }
}

/** start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ approval_2 → approval_3 → end */
function instanceGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      approvalNode('approval_1', '一级审批'),
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'user', targetIds: ['user_5'] } },
      { key: 'handler_1', type: 'handler', name: '办理', config: { assigneeSources: [] } },
      {
        key: 'parallel_1',
        type: 'parallel',
        name: '并行分支',
        config: { branches: ['edge_p1', 'edge_p2'], joinMode: 'all', joinNodeKey: 'approval_2' },
      },
      approvalNode('approval_p1', '并行审批 1'),
      approvalNode('approval_p2', '并行审批 2'),
      approvalNode('approval_2', '二级审批'),
      approvalNode('approval_3', '三级审批'),
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge_1', source: 'start', target: 'approval_1' },
      { key: 'edge_2', source: 'approval_1', target: 'cc_1' },
      { key: 'edge_3', source: 'cc_1', target: 'handler_1' },
      { key: 'edge_4', source: 'handler_1', target: 'parallel_1' },
      { key: 'edge_p1', source: 'parallel_1', target: 'approval_p1' },
      { key: 'edge_p2', source: 'parallel_1', target: 'approval_p2' },
      { key: 'edge_j1', source: 'approval_p1', target: 'approval_2' },
      { key: 'edge_j2', source: 'approval_p2', target: 'approval_2' },
      { key: 'edge_5', source: 'approval_2', target: 'approval_3' },
      { key: 'edge_6', source: 'approval_3', target: 'end' },
    ],
  }
}

/**
 * A graph under which NONE of this instance's visited keys is a legal target (approval_1 sits inside
 * a parallel region; cc_1 / handler_1 / approval_p1 do not exist). Judging the instance by it empties
 * the list and hides 退回 — so a test that still sees the legacy list proves it was NOT used.
 */
function graphThatRejectsEveryVisitedKey() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'parallel_9',
        type: 'parallel',
        name: '并行分支',
        config: { branches: ['edge_a', 'edge_b'], joinMode: 'all', joinNodeKey: 'approval_2' },
      },
      approvalNode('approval_1', '并行审批 A'),
      approvalNode('approval_9', '并行审批 B'),
      approvalNode('approval_2', '二级审批'),
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge_s', source: 'start', target: 'parallel_9' },
      { key: 'edge_a', source: 'parallel_9', target: 'approval_1' },
      { key: 'edge_b', source: 'parallel_9', target: 'approval_9' },
      { key: 'edge_ja', source: 'approval_1', target: 'approval_2' },
      { key: 'edge_jb', source: 'approval_9', target: 'approval_2' },
      { key: 'edge_e', source: 'approval_2', target: 'end' },
    ],
  }
}

/** The live template after an edit that deleted approval_1 (drift since this instance started). */
function liveGraphWithoutApproval1() {
  const graph = instanceGraph()
  return {
    nodes: graph.nodes.filter((node) => node.key !== 'approval_1'),
    edges: graph.edges
      .filter((edge) => edge.source !== 'approval_1')
      .map((edge) => (edge.target === 'approval_1' ? { ...edge, target: 'cc_1' } : edge)),
  }
}

/** start → approval_1 → approval_2 → approval_3 → end */
function linearGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      approvalNode('approval_1', '一级审批'),
      approvalNode('approval_2', '二级审批'),
      approvalNode('approval_3', '三级审批'),
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'approval_2' },
      { key: 'e3', source: 'approval_2', target: 'approval_3' },
      { key: 'e4', source: 'approval_3', target: 'end' },
    ],
  }
}

/**
 * The template DTO: its `approvalGraph` is the graph of its LATEST version (`getTemplate` serves
 * `latest`), so `latestVersionId` says which version that is. Defaults to this instance's pinned
 * version (no drift).
 */
function template(
  id: string,
  approvalGraph: unknown,
  versionIds: { latestVersionId?: string | null; activeVersionId?: string | null } = {},
) {
  return {
    id,
    name: '报销',
    status: 'published',
    activeVersionId: VERSION_ID,
    latestVersionId: VERSION_ID,
    ...versionIds,
    formSchema: { fields: [] },
    approvalGraph,
  }
}

function version(id: string, templateId: string, approvalGraph: unknown) {
  return { id, templateId, version: 1, status: 'published', formSchema: { fields: [] }, approvalGraph, runtimeGraph: null }
}

function seat(nodeKey: string) {
  return { id: `as_${nodeKey}`, type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey, isActive: true, metadata: {} }
}

/**
 * The DETAIL-READ shape at approval_2 (`currentNodeType` present, no `currentNodeKeys`). `user_1`
 * holds the seat, so 退回's other gates (canDecide, allowReturn, desktop layout) are all open.
 */
function detailRead(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'apv_1',
    title: '出差报销',
    status: 'pending',
    templateId: TEMPLATE_ID,
    templateVersionId: VERSION_ID,
    requester: { id: 'user_99', name: '张三' },
    requestNo: 'AP-100001',
    currentStep: 2,
    totalSteps: 3,
    currentNodeKey: 'approval_2',
    currentNodeType: 'approval',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    formSnapshot: {},
    policy: { allowRevoke: true, sourceOfTruth: 'platform' },
    assignments: [seat('approval_2')],
    ...overrides,
  }
}

/** The ACTION-RESPONSE shape: same instance, never a `currentNodeType`. */
function actionResponse(overrides: Record<string, unknown> = {}): any {
  const { currentNodeType: _dropped, ...rest } = detailRead(overrides)
  return rest
}

function historyRow(id: string, nodeKey: string) {
  return { id, action: 'approve', actorId: 'user_2', actorName: '李四', comment: null, metadata: { nodeKey } }
}

/** A 退回 audit row: `nodeKey` is the node that RETURNED (the server's return branch writes it so). */
function returnRow(id: string, nodeKey: string, targetNodeKey: string) {
  return { id, action: 'return', actorId: 'user_3', actorName: '王五', comment: null, metadata: { nodeKey, targetNodeKey } }
}

const VISITED = ['approval_1', 'cc_1', 'handler_1', 'approval_p1', 'approval_2']

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

describe('退回 candidates mirror the server return gate (mounted ApprovalDetailView)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockCanAct.value = true
    mockActiveApproval.value = detailRead()
    mockHistory.value = VISITED.map((nodeKey, index) => historyRow(`h${index + 1}`, nodeKey))
    mockActiveTemplate.value = template(TEMPLATE_ID, instanceGraph())
    mockActiveVersion.value = null
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

  function returnButton(): HTMLButtonElement | null {
    return q(container!, 'approval-return-button') as HTMLButtonElement | null
  }

  function returnDialog(): HTMLElement {
    const dialog = q(container!, 'approval-return-dialog')
    expect(dialog, 'the return dialog is always in the stubbed DOM').toBeTruthy()
    return dialog!
  }

  /** Every target the dialog offers, as `[value, label]`, in rendered order. */
  function offered(): Array<[string, string]> {
    return Array.from(returnDialog().querySelectorAll('option')).map(
      (option) => [option.getAttribute('value') ?? '', option.textContent ?? ''] as [string, string],
    )
  }

  function offeredKeys(): string[] {
    return offered().map(([value]) => value)
  }

  /** Clicks 退回 and asserts the dialog really opened before its options are read. */
  async function openReturnDialog(): Promise<void> {
    const button = returnButton()
    expect(button, '退回 must render before it can be opened').toBeTruthy()
    expect(returnDialog().getAttribute('data-dialog-visible')).toBe('false')
    button!.click()
    await flushUi()
    expect(returnDialog().getAttribute('data-dialog-visible')).toBe('true')
  }

  /** Hidden for the RIGHT reason: no 退回 button AND an empty candidate list behind it. */
  function expectNoReturnOffered(reason: string): void {
    expect(returnButton(), `退回 must be absent: ${reason}`).toBeNull()
    expect(offeredKeys(), `no candidate may be offered: ${reason}`).toEqual([])
  }

  it('T1 positive control: approval_1 (a linear approval node before the cursor) is offered and 退回 renders', async () => {
    await mountView()
    await openReturnDialog()
    expect(offered()).toContainEqual(['approval_1', '一级审批'])
  })

  it('T2 (c) node type: cc_1 is not offered — a cc node never joins the walker trail', async () => {
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toContain('approval_1')
    expect(offeredKeys()).not.toContain('cc_1')
  })

  it('T3 (c) node type: handler_1 is not offered — a handler node never joins the walker trail', async () => {
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toContain('approval_1')
    expect(offeredKeys()).not.toContain('handler_1')
  })

  it('T4 (c) parallel region: approval_p1 is not offered although its region has already joined', async () => {
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toContain('approval_1')
    expect(offeredKeys()).not.toContain('approval_p1')
    // All three exclusions together leave exactly the server's legal set for a cursor at approval_2.
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it("T5 (a) detail read: currentNodeType 'handler' hides 退回 even with a legal-looking candidate", async () => {
    // Same cursor (approval_2) and graph as T1 — the DTO's type field is the ONLY difference.
    mockActiveApproval.value = detailRead({ currentNodeType: 'handler' })
    await mountView()
    expectNoReturnOffered('the server answers APPROVAL_HANDLER_ACTION_NOT_ALLOWED at a handler node')
  })

  it("T5b (a) action response: no currentNodeType, but the instance's own graph says the cursor is a handler", async () => {
    // An action response (e.g. after a 评论 at the handler) carries no `currentNodeType`; the cursor's
    // type then comes from the instance's own graph. approval_1 would otherwise be a candidate.
    mockActiveApproval.value = actionResponse({ currentNodeKey: 'handler_1', assignments: [seat('handler_1')] })
    mockHistory.value = [historyRow('h1', 'approval_1'), historyRow('h2', 'cc_1')]
    await mountView()
    expectNoReturnOffered('the cursor is a handler node in the instance graph')
  })

  it('T6 (b) action response: two pending branches in currentNodeKeys hide 退回', async () => {
    // No graph, so nothing but `currentNodeKeys` can be what hides it (the fork's graph type would
    // hide it on its own otherwise). Without this arm the legacy list would be offered.
    mockActiveTemplate.value = null
    mockActiveApproval.value = actionResponse({
      currentNodeKey: 'parallel_1',
      currentNodeKeys: ['approval_p1', 'approval_p2'],
      assignments: [seat('approval_p1')],
    })
    mockHistory.value = [historyRow('h1', 'approval_1'), historyRow('h2', 'cc_1'), historyRow('h3', 'handler_1')]
    await mountView()
    expectNoReturnOffered('the server answers APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED')
  })

  it('T6b (b) action response: ONE pending branch left (a joinMode-all sibling finished) still hides 退回', async () => {
    // The 并行中 badge reads `>= 2` and would call this linear; the server still refuses the return
    // (the stored cursor is still the fork — see the wp1 parallel-gateway API test's mid-region
    // `currentNodeKeys: ['compliance_review']`).
    mockActiveTemplate.value = null
    mockActiveApproval.value = actionResponse({
      currentNodeKey: 'parallel_1',
      currentNodeKeys: ['approval_p2'],
      assignments: [seat('approval_p2')],
    })
    mockHistory.value = [
      historyRow('h1', 'approval_1'),
      historyRow('h2', 'cc_1'),
      historyRow('h3', 'handler_1'),
      historyRow('h4', 'approval_p1'),
    ]
    await mountView()
    expectNoReturnOffered('one pending branch is still a parallel region on the server')
  })

  it("T6c (b) detail read: currentNodeType 'parallel' at the fork with no currentNodeKeys hides 退回", async () => {
    // The detail read never ships `currentNodeKeys`; inside a region its `currentNodeType` is the
    // fork's own type. No graph, so the DTO field is the only signal.
    mockActiveTemplate.value = null
    mockActiveApproval.value = detailRead({
      currentNodeKey: 'parallel_1',
      currentNodeType: 'parallel',
      assignments: [seat('approval_p1')],
    })
    mockHistory.value = [historyRow('h1', 'approval_1'), historyRow('h2', 'cc_1'), historyRow('h3', 'handler_1')]
    await mountView()
    expectNoReturnOffered('the detail read says the cursor is the parallel fork')
  })

  it('T7 no graph (activeVersion and activeTemplate both null): the legacy list — every visited key but the cursor', async () => {
    // Owner-visible choice: when the template cannot be loaded the list stays what it was before the
    // filter existed (the server's own check still refuses an illegal target), rather than 退回
    // disappearing for every viewer who cannot read the template.
    mockActiveTemplate.value = null
    mockActiveVersion.value = null
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'cc_1', 'handler_1', 'approval_p1'])
  })

  it('T8 absent currentNodeType (older server / action response) is not read as a handler — candidates still offered', async () => {
    mockActiveApproval.value = actionResponse()
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it("T9 identity: ANOTHER template left in the app-wide store never judges this instance (legacy list)", async () => {
    // A failed load leaves the previous template in the store. Were it used, approval_1 (inside its
    // parallel region) and every other visited key (absent there) would be dropped and 退回 would
    // vanish; ignored, the legacy list is offered.
    mockActiveTemplate.value = template('tpl_other', graphThatRejectsEveryVisitedKey())
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'cc_1', 'handler_1', 'approval_p1'])
  })

  it("T9b identity: a version that is not this instance's pinned version is skipped for the instance's own template", async () => {
    // Same template, different version id (e.g. left over from another instance of it).
    mockActiveVersion.value = version('ver_rc_other', TEMPLATE_ID, graphThatRejectsEveryVisitedKey())
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it("T9c identity: a version with this instance's version id but ANOTHER template id is skipped (defence in depth)", async () => {
    // Version ids are globally unique, so the server cannot produce this; it pins the templateId half
    // of the pinned-version identity check, which the version-id half otherwise masks.
    mockActiveVersion.value = version(VERSION_ID, 'tpl_other', graphThatRejectsEveryVisitedKey())
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it('T10 the pinned (frozen) version wins over a drifted live template', async () => {
    // The template's latest version (ver_rc_2) has since deleted approval_1; the instance's pinned
    // version still has it, and the pinned version is what the server walks. (The drifted template
    // is not this instance's graph at all — T13 — so here the admin-only pinned version is the one
    // graph that can judge; without it the legacy list would be offered.)
    mockActiveVersion.value = version(VERSION_ID, TEMPLATE_ID, instanceGraph())
    mockActiveTemplate.value = template(TEMPLATE_ID, liveGraphWithoutApproval1(), { latestVersionId: 'ver_rc_2' })
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it('T11 (c) upstream: after approval_3 returned to approval_1, nothing at or after the cursor is offered (button absent)', async () => {
    // History still holds approval_2 and approval_3 (the 退回 row carries the RETURNING node), both
    // downstream of the cursor; the walker stops at approval_1, so the server's legal set is [].
    mockActiveTemplate.value = template(TEMPLATE_ID, linearGraph())
    mockActiveApproval.value = detailRead({ currentNodeKey: 'approval_1', currentNodeType: 'approval', assignments: [seat('approval_1')] })
    mockHistory.value = [returnRow('h3', 'approval_3', 'approval_1'), historyRow('h2', 'approval_2'), historyRow('h1', 'approval_1')]
    await mountView()
    expectNoReturnOffered('the walker stops at the cursor; nothing downstream of approval_1 is on the trail')
  })

  it('T12 (c) upstream: after approval_1 re-approves, only approval_1 is offered at approval_2 — not the downstream approval_3', async () => {
    mockActiveTemplate.value = template(TEMPLATE_ID, linearGraph())
    mockActiveApproval.value = detailRead({ currentNodeKey: 'approval_2', currentNodeType: 'approval', assignments: [seat('approval_2')] })
    mockHistory.value = [
      historyRow('h4', 'approval_1'),
      returnRow('h3', 'approval_3', 'approval_1'),
      historyRow('h2', 'approval_2'),
      historyRow('h1', 'approval_1'),
    ]
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it("T13 drift: a template whose LATEST version is not this instance's pinned version never judges it (legacy list)", async () => {
    // An ordinary member's only graph source is the template, which serves its latest version. Here a
    // later version deleted approval_1: judged by it, approval_1 — still legal on the frozen graph the
    // server walks — would be dropped and 退回 would vanish. Unjudged, the legacy list is offered.
    mockActiveTemplate.value = template(TEMPLATE_ID, liveGraphWithoutApproval1(), { latestVersionId: 'ver_rc_2' })
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'cc_1', 'handler_1', 'approval_p1'])
  })

  it('T13b drift: an instance DTO without templateVersionId is never judged — not even by a template DTO without latestVersionId', async () => {
    // Nothing proves which version such a template holds: `undefined === undefined` is not a match.
    mockActiveApproval.value = detailRead({ templateVersionId: undefined })
    mockActiveTemplate.value = template(TEMPLATE_ID, graphThatRejectsEveryVisitedKey(), { latestVersionId: undefined })
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'cc_1', 'handler_1', 'approval_p1'])
  })

  it('T14 (c) a visited key the instance graph does not carry is not offered — the trail holds graph nodes only', async () => {
    mockHistory.value = [...mockHistory.value, historyRow('h6', 'approval_ghost')]
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it('T15 (c) a cursor the instance graph does not carry skips only the upstream filter — node type and region still apply', async () => {
    // Nothing to anchor "upstream" to, and an inconsistent cursor must not empty the list on its own
    // (the server stays the authority): approval_2 and approval_3 stay, cc_1 / handler_1 /
    // approval_p1 are still dropped.
    mockActiveApproval.value = detailRead({ currentNodeKey: 'approval_unknown', assignments: [seat('approval_unknown')] })
    mockHistory.value = [...VISITED, 'approval_3'].map((nodeKey, index) => historyRow(`h${index + 1}`, nodeKey))
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'approval_2', 'approval_3'])
  })

  it('TS1 server list preferred: history + graph would offer approval_2 and approval_1; only the server\'s key appears', async () => {
    // Linear graph, cursor at approval_3, both earlier approvals in history: the client mirror would
    // offer ['approval_2', 'approval_1'] (history order). The server's list is a strict subset.
    mockActiveTemplate.value = template(TEMPLATE_ID, linearGraph())
    mockActiveApproval.value = detailRead({
      currentNodeKey: 'approval_3',
      currentNodeType: 'approval',
      assignments: [seat('approval_3')],
      returnableNodeKeys: ['approval_1'],
    })
    mockHistory.value = [historyRow('h2', 'approval_2'), historyRow('h1', 'approval_1')]
    await mountView()
    await openReturnDialog()
    expect(offered()).toEqual([['approval_1', '一级审批']])
  })

  it('TS2 server []: 退回 is hidden even though history + graph would offer approval_1', async () => {
    // Same fixture as T1 (the positive control), with the server's empty list as the ONLY difference.
    mockActiveApproval.value = detailRead({ returnableNodeKeys: [] })
    await mountView()
    expectNoReturnOffered('the server computed no legal target')
  })

  it('TS3 server wins over the client filter: a key the mirrors would drop (approval_p1, inside a parallel region) is offered', async () => {
    // T4 pins that the client filter drops approval_p1 from exactly this history + graph; the server's
    // list carries it, so it is offered, in the server's order, labelled from the own template.
    mockActiveApproval.value = detailRead({ returnableNodeKeys: ['approval_1', 'approval_p1'] })
    await mountView()
    await openReturnDialog()
    expect(offered()).toEqual([['approval_1', '一级审批'], ['approval_p1', '并行审批 1']])
  })

  it('TS3b server wins over history: a trail node nobody visited (an admin forward jump skipped approval_2) is offered', async () => {
    // The #6291 residual in the other direction: history never held approval_2, so the mirrors could
    // not offer it; the server's walk lists it, and the view offers the server's list verbatim.
    mockActiveTemplate.value = template(TEMPLATE_ID, linearGraph())
    mockActiveApproval.value = detailRead({
      currentNodeKey: 'approval_3',
      currentNodeType: 'approval',
      assignments: [seat('approval_3')],
      returnableNodeKeys: ['approval_1', 'approval_2'],
    })
    mockHistory.value = [historyRow('h1', 'approval_1')]
    await mountView()
    await openReturnDialog()
    expect(offered()).toEqual([['approval_1', '一级审批'], ['approval_2', '二级审批']])
  })

  it('TS4 null / absent is "not computed": the mirrors still decide (same answer as T1 and T4)', async () => {
    mockActiveApproval.value = detailRead({ returnableNodeKeys: null })
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1'])
  })

  it('TS2b the server list is read on the action-response shape too (no currentNodeType; the store publishes it into the same slot)', async () => {
    mockActiveApproval.value = actionResponse({ returnableNodeKeys: [] })
    await mountView()
    expectNoReturnOffered('an action response carrying an empty server list')
  })
})
