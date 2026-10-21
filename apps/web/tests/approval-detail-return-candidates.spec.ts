import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'

// The first mounted test pays for the dynamic `import()` of ApprovalDetailView.vue plus a full
// mount — the same ~10 s cold start approval-member-bar-operation-policy.spec.ts measured against
// vitest's 5 s default — so the budget is raised the same way.
vi.setConfig({ testTimeout: 15_000 })
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

/**
 * 退回 (return) candidates on the mounted ApprovalDetailView: the server's list, else the legacy list.
 *
 * Both instance DTO carriers ship `returnableNodeKeys` (#6293): the targets the server's return gate
 * would accept right now, walked server-side on the instance's FROZEN runtime graph. That list is the
 * only source of truth. The client-side mirror of the gate that #6291 added (own-graph identity,
 * drift, node-type / parallel-region / upstream filters, a graph-derived cursor type) is gone (G-4):
 *
 *   | the DTO's `returnableNodeKeys`        | 退回 offers                                                    | tests          |
 *   |---------------------------------------|----------------------------------------------------------------|----------------|
 *   | an array                              | that list verbatim, in the server's order, labelled from the   | TS1, TS3, TS3b |
 *   |                                       | template; history and graph play no part                       |                |
 *   | `[]`                                  | nothing: the button is hidden although history holds keys      | TS2, TS2b, L2  |
 *   | absent / `null` — not computed (an    | the legacy list: every visited key but the cursor, `start` and | T1, TS4, L1    |
 *   | older server, or no walkable frozen   | `end`, first occurrence in history order. The graph is NOT     |                |
 *   | graph)                                | consulted; the server's gate still 409s an illegal target      |                |
 *   | anything, on a non-pending instance   | nothing                                                        | L3, L3b        |
 *
 * T1 is the positive control the `[]` cases lean on (TS2 is T1's fixture with `[]` as the only
 * difference), and L1 is L2's (the same fixture, field absent vs `[]`).
 *
 * The instance's own template is loaded in every test. Under its graph the server's legal set for a
 * cursor at approval_2 is exactly [approval_1], so a test that still sees cc / handler /
 * parallel-branch / downstream keys proves the graph was not used to filter (the canvas joins a
 * parallel region at the next real node, as `insertParallelGateway` does — there is no "join" node
 * type):
 *
 *   start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ approval_2 → approval_3 → end
 *
 * TS1 / TS3b use a plain linear start → approval_1 → approval_2 → approval_3 → end. History is in
 * `/history`'s own newest-first order, and a 退回 row carries the RETURNING node's key, as the server
 * writes it.
 *
 * Two DTO shapes are exercised (TS2b), because the store publishes an action response
 * (ApprovalProductService `toUnifiedApprovalDTO`, never a `currentNodeType`) into the slot the detail
 * read (ApprovalBridgeService `toUnifiedDTO`) fills.
 *
 * Harness copied from approval-member-bar-operation-policy.spec.ts (mocked approvals store exposing
 * `activeApproval` / `history` as getters, element-plus stubs that render a real <select>/<option>),
 * with the template store mock's `activeTemplate` / `activeVersion` held in mutable refs: the view
 * still reads both (`nodeLabel` names the options from the own template, `pinnedGraph` feeds the
 * upcoming-node timeline).
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

/** The instance's own template DTO; its latest version is the one this instance is pinned to. */
function template(id: string, approvalGraph: unknown) {
  return {
    id,
    name: '报销',
    status: 'published',
    activeVersionId: VERSION_ID,
    latestVersionId: VERSION_ID,
    formSchema: { fields: [] },
    approvalGraph,
  }
}

function seat(nodeKey: string) {
  return { id: `as_${nodeKey}`, type: 'user', assigneeId: 'user_1', sourceStep: 2, nodeKey, isActive: true, metadata: {} }
}

/**
 * The DETAIL-READ shape at approval_2 (`currentNodeType` present, no `currentNodeKeys`), WITHOUT
 * `returnableNodeKeys` — what a server before #6293 sends; a test adds the field to model #6293.
 * `user_1` holds the seat, so 退回's other gates (canDecide, allowReturn, desktop layout) are all open.
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

/** A `/history` row: `metadata.nodeKey` is the node the row was written at (for a 退回, the RETURNING node). */
function historyRow(id: string, nodeKey: string, action = 'approve') {
  return { id, action, actorId: 'user_2', actorName: '李四', comment: null, metadata: { nodeKey } }
}

const VISITED = ['approval_1', 'cc_1', 'handler_1', 'approval_p1', 'approval_2']

/**
 * L1–L3's history, newest first: approval_3 returned the instance to approval_2 (the cursor) after a
 * full first pass — approve @approval_2, both parallel branches, handle @handler_1, cc @cc_1,
 * approve and an earlier 评论 @approval_1, created @start. It holds every kind of key the legacy rule
 * keeps or drops: a downstream key (approval_3), parallel-branch keys, a handler and a cc key, a
 * repeated key (approval_1), the cursor and `start`.
 */
const RETURNED_TO_APPROVAL_2 = [
  historyRow('h9', 'approval_3', 'return'),
  historyRow('h8', 'approval_2'),
  historyRow('h7', 'approval_p2'),
  historyRow('h6', 'approval_p1'),
  historyRow('h5', 'handler_1', 'handle'),
  historyRow('h4', 'cc_1', 'cc'),
  historyRow('h3', 'approval_1'),
  historyRow('h2', 'approval_1', 'comment'),
  historyRow('h1', 'start', 'created'),
]

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

describe('退回 candidates: the server list, else the legacy list (mounted ApprovalDetailView)', () => {
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

  it('T1 positive control: with no server list, approval_1 (visited, not the cursor) is offered and 退回 renders', async () => {
    await mountView()
    await openReturnDialog()
    expect(offered()).toContainEqual(['approval_1', '一级审批'])
  })

  it('L1 field absent: the legacy list — every visited key but the cursor and start, first occurrence in history order; the graph is not consulted', async () => {
    // The pre-#6293 DTO shape (`detailRead` never sets `returnableNodeKeys`). The instance's own
    // template is loaded, and under it only approval_1 is legal at approval_2, so offering the
    // downstream approval_3, both parallel branches, handler_1 and cc_1 proves no client-side filter
    // is applied (the owner-approved fallback; the server's gate answers an illegal pick with its own
    // 409). approval_1 appears once although history holds it twice; approval_2 (the cursor) and
    // start never appear. Labels come from the own template.
    mockHistory.value = RETURNED_TO_APPROVAL_2
    await mountView()
    await openReturnDialog()
    expect(offered()).toEqual([
      ['approval_3', '三级审批'],
      ['approval_p2', '并行审批 2'],
      ['approval_p1', '并行审批 1'],
      ['handler_1', '办理'],
      ['cc_1', '抄送'],
      ['approval_1', '一级审批'],
    ])
  })

  it('L2 server []: 退回 is hidden although the same history gives L1 six legacy targets', async () => {
    // L1's fixture with the server's empty list as the ONLY difference: `[]` is "nothing is legal",
    // never "not computed".
    mockActiveApproval.value = detailRead({ returnableNodeKeys: [] })
    mockHistory.value = RETURNED_TO_APPROVAL_2
    await mountView()
    expectNoReturnOffered('the server computed no legal target')
  })

  it('L3 a non-pending instance offers nothing (the field-absent shape the server sends for it)', async () => {
    // The server leaves `returnableNodeKeys` absent on a non-pending instance; L1's history alone
    // would give six legacy targets.
    mockActiveApproval.value = detailRead({ status: 'approved' })
    mockHistory.value = RETURNED_TO_APPROVAL_2
    await mountView()
    expectNoReturnOffered('the instance is no longer pending')
  })

  it('L3b defence in depth: a non-pending instance offers nothing even if its DTO carried a server list', async () => {
    // Unreachable from the #6293 server (L3 is the shape it sends); pins that the status check comes
    // before the server list.
    mockActiveApproval.value = detailRead({ status: 'approved', returnableNodeKeys: ['approval_1'] })
    mockHistory.value = RETURNED_TO_APPROVAL_2
    await mountView()
    expectNoReturnOffered('the status check precedes the server list')
  })

  it("TS1 server list preferred: the legacy list would offer approval_2 and approval_1; only the server's key appears", async () => {
    // Linear graph, cursor at approval_3, both earlier approvals in history: the legacy list would be
    // ['approval_2', 'approval_1'] (history order). The server's list is a strict subset of it.
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

  it('TS2 server []: 退回 is hidden even though the legacy list would offer approval_1', async () => {
    // Same fixture as T1 (the positive control), with the server's empty list as the ONLY difference.
    mockActiveApproval.value = detailRead({ returnableNodeKeys: [] })
    await mountView()
    expectNoReturnOffered('the server computed no legal target')
  })

  it('TS2b the server list is read on the action-response shape too (no currentNodeType; the store publishes it into the same slot)', async () => {
    mockActiveApproval.value = actionResponse({ returnableNodeKeys: [] })
    await mountView()
    expectNoReturnOffered('an action response carrying an empty server list')
  })

  it('TS3 no client filter over the server list: approval_p1 (a parallel-branch node) is offered when the server lists it', async () => {
    // T1's fixture, where the legacy list would offer four keys. The server's two keys appear as
    // given — in its order, labelled from the own template — and nothing drops approval_p1, which a
    // client-side gate mirror would (it sits inside a parallel region).
    mockActiveApproval.value = detailRead({ returnableNodeKeys: ['approval_1', 'approval_p1'] })
    await mountView()
    await openReturnDialog()
    expect(offered()).toEqual([['approval_1', '一级审批'], ['approval_p1', '并行审批 1']])
  })

  it('TS3b server wins over history: a trail node nobody visited (an admin forward jump skipped approval_2) is offered', async () => {
    // History never held approval_2, so the legacy list could not offer it; the server's walk lists
    // it, and the view offers the server's list verbatim.
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

  it('TS4 null is "not computed", exactly like an absent field: the legacy list (T1\'s fixture, every visited key but the cursor)', async () => {
    mockActiveApproval.value = detailRead({ returnableNodeKeys: null })
    await mountView()
    await openReturnDialog()
    expect(offeredKeys()).toEqual(['approval_1', 'cc_1', 'handler_1', 'approval_p1'])
  })
})
