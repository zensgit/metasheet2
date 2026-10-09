// 退回 (return) candidates — real-browser acceptance harness. It mounts the real ApprovalDetailView
// with the production Router, Pinia stores and Element Plus (dialog + select dropdown), the same way
// approval-member-action-dialog-harness.ts does, and changes ONLY deterministic fixture state once
// the dev-mode API has populated the stores. Which targets the 退回 dialog offers, and whether the
// 退回 button renders at all, stay production code: `returnableNodes` in ApprovalDetailView.vue.
//
// WHY THE TEMPLATE IS REPLACED. The dev-mode template (start → approval_1 → approval_2 → end, named
// 部门主管审批 / 财务审批) is too small to exercise the return gate: under it every non-approval key
// of the history below is simply "not a node", so a client-mirror pass would prove nothing about the
// type / parallel-region / upstream rules. Once the view's own template loads have SETTLED (it issues
// `loadTemplate` and `loadVersion` after the detail read; overriding earlier races them), BOTH store
// slots are replaced with the one graph below, identity-consistent with the instance: template
// `tpl_1` with `latestVersionId` `ver_1_1`, and the pinned version `ver_1_1` of `tpl_1`. None of its
// node names occurs in the dev mock, so a label in the dialog proves the view judged by THIS graph.
//
//   start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ join_1 → approval_2 → approval_3 → end
//
// `join_1` is a cc node. There is no join node type: the canvas joins a parallel region at the next
// real node, and a cc join is a pass-through for the server's trail walker
// (`ApprovalGraphExecutor.listVisitedApprovalNodeKeysUntil`), which lets only approval nodes join
// the trail and jumps the fork straight to its join. So for a cursor at approval_2 the server's own
// legal set is exactly [approval_1]. Every node names the person who acts there — approval_1 部门经理,
// approval_p1 法务专员, approval_3 总经理, and the viewer at handler_1, approval_p2 and approval_2 — so
// the seats, the history actors and the graph agree.
//
// EVERY FIXTURE IS A STATE THE SERVER CAN BE IN, in the shape the wire carries:
//   * the detail read (`GET /api/approvals/:id`, ApprovalBridgeService.getApproval) ships
//     `currentNodeType` — the frozen graph's type at the stored cursor, which is THIS graph's type
//     there, since the graph is the pinned version — plus `canDecideCurrentNode` /
//     `canAttachProcessEvidence` (both `true`: a template-runtime instance and a seat at a decidable
//     node; the uploader stays off because the attachment pipeline is off below) and, from #6293
//     on, `returnableNodeKeys`; never `currentNodeKeys`. An action response
//     (ApprovalProductService.getApproval) ships `currentNodeKeys` and never `currentNodeType`;
//   * `/history` rows carry only the whitelisted metadata keys (routes/approval-history.ts selects
//     five single-key paths). Of those, this story writes just `nodeKey`: `targetNodeKey`,
//     `nextNodeKey`, `targetType`, `handlerMode`, … never reach a client, and a row with no
//     whitelisted key at all — the admin jump — has no `metadata` on the wire. Rows the server
//     writes in ONE transaction share `occurred_at` (`DEFAULT now()`) and `ORDER BY occurred_at
//     DESC` has no tiebreak, so the order among them below is one order the server may serve (newest
//     insert first). The view keeps the order it is given.
//
// THE MAIN HISTORY (cursor approval_2), newest first: a 退回 @approval_3 back to approval_2; approve
// @approval_2; the region's any-mode join in one transaction — cc @join_1, the system `sign`
// @approval_p1 that cancelled the viewer's approval_p2 seat, approve @approval_p1; handle
// @handler_1; cc @cc_1 and approve @approval_1 in one transaction; created @start. The client mirror
// must drop cc_1 / join_1 / handler_1 (not approval nodes), approval_p1 (inside the parallel region),
// approval_3 (not upstream of the cursor) and approval_2 (the cursor) and keep only approval_1.
//
// `?scenario=` (required; an unknown or missing value throws instead of falling back):
//   server-list      — detail read: cursor approval_2, the viewer's seat there, the main history,
//                      `returnableNodeKeys: ['approval_1']` (what the walker yields here).
//   server-empty     — server-list with `returnableNodeKeys: []`.
//   server-list-wins — server-list, but the instance reached approval_2 by an ADMIN FORWARD JUMP from
//                      approval_1 (`adminJump`): history is created @start plus the jump row, which
//                      has no `nodeKey`. The mirror (history ∩ graph) has nothing to offer; the
//                      server's walker reads the graph only and still lists approval_1. This is the
//                      graph-present case where the server list and the mirror disagree.
//   client-mirror    — server-list with the field DELETED (a server before #6293): the mirror decides.
//   handler-cursor   — older-server detail read with the cursor AT handler_1 (so `currentNodeType:
//                      'handler'` and this graph agree) and the viewer's seat there; history is the
//                      first pass up to cc @cc_1, which already holds approval_1 — upstream, visited,
//                      so the mirror would offer it if the handler gate did not hide 退回.
//   parallel-state   — older-server ACTION RESPONSE right after the viewer handled handler_1: cursor
//                      at the fork `parallel_1`, `currentNodeKeys: ['approval_p1', 'approval_p2']`,
//                      no `currentNodeType`, seats for 法务专员 on approval_p1 and the viewer on
//                      approval_p2; history is the first pass up to handle @handler_1.
//   submit           — server-list, with ONLY the store's `executeAction` wrapped: every request is
//                      recorded on `window.__RC_ACTION_REQUESTS__` and resolved with the displayed
//                      instance. No HTTP, and the original action is never called.
// `&template=drifted` (with server-list, client-mirror or handler-cursor): the template has moved on
// to a LATER version (`latestVersionId: 'ver_1_2'`, same graph) and no pinned version is loaded —
// what an ordinary member has once the template is edited (the version endpoint is admin-gated).
// The view then has no graph of its own: the server's list still decides; without it the legacy
// unfiltered list comes back; and at a handler cursor the DTO's own `currentNodeType` is the only
// thing left that says "handler".
//
// `window.__RC_READY__` turns true once the fixture is in place; a harness failure sets
// `window.__RC_ERROR__` instead, so the paired spec (approval-return-candidates.spec.ts) fails with
// the reason rather than a ready-wait timeout.
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import ApprovalDetailView from '../src/views/approval/ApprovalDetailView.vue'
import { useApprovalStore } from '../src/approvals/store'
import { useApprovalTemplateStore } from '../src/approvals/templateStore'
import { useAuth } from '../src/composables/useAuth'
import { useLocale } from '../src/composables/useLocale'
import { useFeatureFlags } from '../src/stores/featureFlags'
import type {
  ApprovalActionRequest,
  ApprovalAssignmentDTO,
  ApprovalGraph,
  ApprovalNode,
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
} from '../src/types/approval'

declare global {
  interface Window {
    __RC_READY__?: boolean
    /** Set instead of `__RC_READY__` when the harness itself fails, so the spec fails with the reason. */
    __RC_ERROR__?: string
    __RC_ACTION_REQUESTS__?: Array<{ id: string; req: ApprovalActionRequest }>
  }
}

const SCENARIOS = [
  'server-list',
  'server-empty',
  'server-list-wins',
  'client-mirror',
  'handler-cursor',
  'parallel-state',
  'submit',
] as const
type Scenario = (typeof SCENARIOS)[number]
const DRIFTABLE: readonly Scenario[] = ['server-list', 'client-mirror', 'handler-cursor']

const INSTANCE_ID = 'apv_5'
const TEMPLATE_ID = 'tpl_1'
const PINNED_VERSION_ID = 'ver_1_1'
const LATER_VERSION_ID = 'ver_1_2'

type Person = { id: string; name: string }
const VIEWER: Person = { id: 'user_current', name: '当前审批人' }
/** The dev-mode instance's requester (`mockApproval`). */
const REQUESTER: Person = { id: 'user_1', name: '张三' }
const MANAGER: Person = { id: 'user_manager', name: '部门经理' }
const LEGAL: Person = { id: 'user_legal', name: '法务专员' }
const GM: Person = { id: 'user_gm', name: '总经理' }
const FLOW_ADMIN: Person = { id: 'user_flow_admin', name: '流程管理员' }
/** The engine's own actor for cc and aggregate-cancel `sign` rows (`insertCcEvents`). */
const SYSTEM: Person = { id: 'system', name: 'System' }

function approvalNode(key: string, name: string, assignee: Person): ApprovalNode {
  return {
    key,
    type: 'approval',
    name,
    config: { assigneeType: 'user', assigneeIds: [assignee.id], approvalMode: 'single', emptyAssigneePolicy: 'error' },
  }
}

const RETURN_GATE_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '提交申请', config: {} },
    approvalNode('approval_1', '部门经理初审', MANAGER),
    { key: 'cc_1', type: 'cc', name: '抄送人事', config: { targetType: 'user', targetIds: ['user_hr'] } },
    {
      key: 'handler_1',
      type: 'handler',
      name: '资料补正办理',
      config: { assigneeSources: [{ kind: 'static_user', userIds: [VIEWER.id] }] },
    },
    {
      key: 'parallel_1',
      type: 'parallel',
      name: '并行会签',
      config: { branches: ['edge_p1', 'edge_p2'], joinMode: 'any', joinNodeKey: 'join_1' },
    },
    approvalNode('approval_p1', '法务会签', LEGAL),
    approvalNode('approval_p2', '合规会签', VIEWER),
    { key: 'join_1', type: 'cc', name: '会签结果抄送', config: { targetType: 'user', targetIds: ['user_hr'] } },
    approvalNode('approval_2', '财务复核', VIEWER),
    approvalNode('approval_3', '总经理终审', GM),
    { key: 'end', type: 'end', name: '流程结束', config: {} },
  ],
  edges: [
    { key: 'edge_1', source: 'start', target: 'approval_1' },
    { key: 'edge_2', source: 'approval_1', target: 'cc_1' },
    { key: 'edge_3', source: 'cc_1', target: 'handler_1' },
    { key: 'edge_4', source: 'handler_1', target: 'parallel_1' },
    { key: 'edge_p1', source: 'parallel_1', target: 'approval_p1' },
    { key: 'edge_p2', source: 'parallel_1', target: 'approval_p2' },
    { key: 'edge_j1', source: 'approval_p1', target: 'join_1' },
    { key: 'edge_j2', source: 'approval_p2', target: 'join_1' },
    { key: 'edge_5', source: 'join_1', target: 'approval_2' },
    { key: 'edge_6', source: 'approval_2', target: 'approval_3' },
    { key: 'edge_7', source: 'approval_3', target: 'end' },
  ],
}

// Fixed instants (no `Date.now()`), so the fixture is the same on every run.
const STORY_START = Date.parse('2026-10-01T01:00:00.000Z')
function hoursIn(hours: number): string {
  return new Date(STORY_START + hours * 3_600_000).toISOString()
}

/**
 * One `/history` row as the platform wire serves it: `metadata` holds `nodeKey` (the only
 * whitelisted key this story writes) or is ABSENT when the stored row has none. The DTO type
 * declares `metadata` as always present, which that wire does not honour, hence the one assertion.
 */
function historyRow(
  id: string,
  action: string,
  actor: Person,
  comment: string | null,
  hours: number,
  nodeKey: string | null,
): UnifiedApprovalHistoryDTO {
  const row: Omit<UnifiedApprovalHistoryDTO, 'metadata'> = {
    id,
    action,
    actorId: actor.id,
    actorName: actor.name,
    comment,
    fromStatus: action === 'created' ? null : 'pending',
    toStatus: 'pending',
    occurredAt: hoursIn(hours),
  }
  return nodeKey === null ? (row as UnifiedApprovalHistoryDTO) : { ...row, metadata: { nodeKey } }
}

// The first pass, oldest rows; every history below ends with (newest-first) a suffix of these.
const CREATED = historyRow('rc_hist_created', 'created', REQUESTER, null, 0, 'start')
const APPROVE_1 = historyRow('rc_hist_approve_1', 'approve', MANAGER, '同意', 3, 'approval_1')
const CC_1 = historyRow('rc_hist_cc_1', 'cc', SYSTEM, null, 3, 'cc_1')
const HANDLE_1 = historyRow('rc_hist_handle_1', 'handle', VIEWER, '资料已补正', 12, 'handler_1')

// Newest first, as `/history` serves it (`ORDER BY occurred_at DESC`); see the header for ties.
const MAIN_HISTORY: UnifiedApprovalHistoryDTO[] = [
  historyRow('rc_hist_return_3', 'return', GM, '请财务重新核对金额', 30, 'approval_3'),
  historyRow('rc_hist_approve_2', 'approve', VIEWER, '金额无误', 26, 'approval_2'),
  historyRow('rc_hist_cc_join', 'cc', SYSTEM, null, 20, 'join_1'),
  historyRow('rc_hist_sign_p1', 'sign', SYSTEM, null, 20, 'approval_p1'),
  historyRow('rc_hist_approve_p1', 'approve', LEGAL, '条款无异议', 20, 'approval_p1'),
  HANDLE_1,
  CC_1,
  APPROVE_1,
  CREATED,
]
/** Cursor at handler_1: approval_1 decided, the flow passed cc_1 in the same transaction. */
const HANDLER_FIRST_PASS: UnifiedApprovalHistoryDTO[] = [CC_1, APPROVE_1, CREATED]
/** Cursor at the fork: the viewer's handle at handler_1 opened both branches. */
const PARALLEL_FIRST_PASS: UnifiedApprovalHistoryDTO[] = [HANDLE_1, CC_1, APPROVE_1, CREATED]
/** An admin moved the instance from approval_1 straight to approval_2 (no `nodeKey` on that row). */
const ADMIN_JUMP_HISTORY: UnifiedApprovalHistoryDTO[] = [
  historyRow('rc_hist_jump', 'jump', FLOW_ADMIN, '部门经理长期休假，流程管理员跳过初审', 6, null),
  CREATED,
]

/** An ordinary seat as the detail read lists it (`metadata` is the row's own, `{}` here). */
function seat(person: Person, nodeKey: string): ApprovalAssignmentDTO {
  return {
    id: `rc_seat_${nodeKey}_${person.id}`,
    type: 'user',
    assigneeId: person.id,
    sourceStep: 3,
    nodeKey,
    isActive: true,
    metadata: {},
  }
}

function parseScenario(raw: string | null): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate === raw)
  if (!scenario) {
    throw new Error(`return-candidates harness: unknown ?scenario=${String(raw)} (expected one of ${SCENARIOS.join(', ')})`)
  }
  return scenario
}

interface Fixture {
  approval: UnifiedApprovalDTO
  history: UnifiedApprovalHistoryDTO[]
}

function fixtureFor(scenario: Scenario, loaded: UnifiedApprovalDTO): Fixture {
  const detailRead: UnifiedApprovalDTO = {
    ...loaded,
    status: 'pending',
    currentStep: 3,
    totalSteps: 4,
    currentNodeKey: 'approval_2',
    currentNodeType: 'approval',
    nodeOperations: {
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    },
    assignments: [seat(VIEWER, 'approval_2')],
    canDecideCurrentNode: true,
    canAttachProcessEvidence: true,
    returnableNodeKeys: ['approval_1'],
  }
  const olderServer: UnifiedApprovalDTO = { ...detailRead }
  delete olderServer.returnableNodeKeys

  switch (scenario) {
    case 'server-list':
    case 'submit':
      return { approval: detailRead, history: MAIN_HISTORY }
    case 'server-empty':
      return { approval: { ...detailRead, returnableNodeKeys: [] }, history: MAIN_HISTORY }
    case 'server-list-wins':
      return { approval: detailRead, history: ADMIN_JUMP_HISTORY }
    case 'client-mirror':
      return { approval: olderServer, history: MAIN_HISTORY }
    case 'handler-cursor':
      return {
        approval: {
          ...olderServer,
          currentNodeKey: 'handler_1',
          currentNodeType: 'handler',
          assignments: [seat(VIEWER, 'handler_1')],
        },
        history: HANDLER_FIRST_PASS,
      }
    case 'parallel-state': {
      const actionResponse: UnifiedApprovalDTO = {
        ...olderServer,
        currentNodeKey: 'parallel_1',
        currentNodeKeys: ['approval_p1', 'approval_p2'],
        assignments: [seat(LEGAL, 'approval_p1'), seat(VIEWER, 'approval_p2')],
      }
      delete actionResponse.currentNodeType
      return { approval: actionResponse, history: PARALLEL_FIRST_PASS }
    }
  }
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`return-candidates harness timed out waiting for ${what}`)
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const scenario = parseScenario(params.get('scenario'))
  const templateMode = params.get('template')
  if (templateMode !== null && templateMode !== 'drifted') {
    throw new Error(`return-candidates harness: unknown &template=${templateMode}`)
  }
  const drifted = templateMode === 'drifted'
  if (drifted && !DRIFTABLE.includes(scenario)) {
    throw new Error(`return-candidates harness: &template=drifted pairs only with ${DRIFTABLE.join(', ')}`)
  }

  // Same session/locale setup as the member-action harness: the spec asserts the shipped zh-CN
  // accessible names, so pin zh-CN rather than inherit the browser's language.
  useLocale().setLocale('zh-CN')
  localStorage.setItem('metasheet_features', JSON.stringify({
    approvalMobile: true,
    approvalAttachments: false,
  }))
  localStorage.setItem('user_roles', JSON.stringify(['admin']))
  localStorage.setItem('user_permissions', JSON.stringify(['approvals:read', 'approvals:act']))

  useAuth().primeSession({
    data: {
      user: {
        id: VIEWER.id,
        roles: ['admin'],
        permissions: ['approvals:read', 'approvals:act'],
      },
    },
  })

  const { loadProductFeatures } = useFeatureFlags()
  await loadProductFeatures(true, { skipSessionProbe: true })

  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/approvals/:id', component: ApprovalDetailView }],
  })

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(pinia)
  app.use(router)
  app.use(ElementPlus)

  await router.push(`/approvals/${INSTANCE_ID}`)
  await router.isReady()
  app.mount('#app')

  const store = useApprovalStore(pinia)
  const templateStore = useApprovalTemplateStore(pinia)

  await waitUntil(
    () => store.activeApproval?.id === INSTANCE_ID && store.history.length > 0,
    'the approval detail and history loads',
  )
  // The view loads the template and the pinned version only AFTER the detail read; replacing the
  // slots before both have landed would be overwritten by the dev mock's 4-node graph.
  await waitUntil(
    () => templateStore.activeTemplate?.id === TEMPLATE_ID
      && templateStore.activeVersion?.id === PINNED_VERSION_ID
      && !templateStore.loading,
    'the template and pinned-version loads',
  )

  const loaded = store.activeApproval
  const loadedTemplate = templateStore.activeTemplate
  const loadedVersion = templateStore.activeVersion
  if (!loaded || !loadedTemplate || !loadedVersion) throw new Error('return-candidates harness loaded nothing')
  // The identity the fixture relies on comes from the dev mock; fail loudly if it ever moves.
  if (loaded.templateId !== TEMPLATE_ID || loaded.templateVersionId !== PINNED_VERSION_ID) {
    throw new Error('return-candidates harness: the dev-mode instance is no longer pinned to tpl_1 / ver_1_1')
  }

  templateStore.activeTemplate = {
    ...loadedTemplate,
    id: TEMPLATE_ID,
    latestVersionId: drifted ? LATER_VERSION_ID : PINNED_VERSION_ID,
    approvalGraph: RETURN_GATE_GRAPH,
  }
  templateStore.activeVersion = drifted
    ? null
    : {
        ...loadedVersion,
        id: PINNED_VERSION_ID,
        templateId: TEMPLATE_ID,
        approvalGraph: RETURN_GATE_GRAPH,
        runtimeGraph: { ...RETURN_GATE_GRAPH, policy: { allowRevoke: true } },
      }
  const fixture = fixtureFor(scenario, loaded)
  store.history = fixture.history
  store.activeApproval = fixture.approval

  if (scenario === 'submit') {
    window.__RC_ACTION_REQUESTS__ = []
    store.executeAction = async (id: string, req: ApprovalActionRequest) => {
      window.__RC_ACTION_REQUESTS__!.push({ id, req: JSON.parse(JSON.stringify(req)) })
      const displayed = store.activeApproval
      if (!displayed || displayed.id !== id) {
        throw new Error('return-candidates harness: an action for an instance that is not displayed')
      }
      return displayed
    }
  }

  await nextTick()
  window.__RC_READY__ = true
  window.dispatchEvent(new Event('rc-ready'))
}

main().catch((error: unknown) => {
  window.__RC_ERROR__ = error instanceof Error ? error.message : String(error)
  throw error
})
