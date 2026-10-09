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
// legal set is exactly [approval_1], and the `server-list` fixture is what a real server sends.
//
// HISTORY, newest-first (the order `GET /api/approvals/:id/history` serves): created @start,
// approve @approval_1, cc @cc_1, handle @handler_1, approve @approval_p1 (joinMode 'any', so that
// branch alone joined the region), approve @approval_2, and a 退回 @approval_3 back to approval_2 —
// the cursor, which is why history still holds approval_3, downstream of it. The client mirror must
// therefore drop cc_1 / handler_1 (not approval nodes), approval_p1 (inside the parallel region),
// approval_3 (not upstream of the cursor) and approval_2 (the cursor) and keep only approval_1.
//
// `?scenario=` (required; an unknown or missing value throws instead of falling back):
//   server-list    — the DTO carries `returnableNodeKeys: ['approval_1']` (detail-read shape:
//                    `currentNodeType: 'approval'`, the viewer's seat on approval_2).
//   server-empty   — server-list with `returnableNodeKeys: []`.
//   client-mirror  — server-list with the field DELETED (an older server): the mirror decides.
//   handler-cursor — client-mirror with `currentNodeType: 'handler'` and nothing else changed, so the
//                    DTO's own type is the only thing that differs from client-mirror.
//   parallel-state — client-mirror in the ACTION-RESPONSE shape: cursor at the fork `parallel_1`,
//                    `currentNodeKeys: ['approval_p1', 'approval_p2']`, no `currentNodeType`, the
//                    viewer's seat on approval_p1.
//   submit         — server-list, with ONLY the store's `executeAction` wrapped: every request is
//                    recorded on `window.__RC_ACTION_REQUESTS__` and resolved with the displayed
//                    instance. No HTTP, and the original action is never called.
// `&template=drifted` (with server-list or client-mirror): the template has moved on to a LATER
// version (`latestVersionId: 'ver_1_2'`, same graph) and no pinned version is loaded — what an
// ordinary member has once the template is edited (the version endpoint is admin-gated). The view
// then has no graph of its own: the server's list still decides, and without it the legacy
// unfiltered list comes back. This pair is what makes a NON-empty server list discriminating: with
// the graph in place the mirror happens to compute the same [approval_1].
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
  'client-mirror',
  'handler-cursor',
  'parallel-state',
  'submit',
] as const
type Scenario = (typeof SCENARIOS)[number]

const INSTANCE_ID = 'apv_5'
const TEMPLATE_ID = 'tpl_1'
const PINNED_VERSION_ID = 'ver_1_1'
const LATER_VERSION_ID = 'ver_1_2'
const VIEWER_ID = 'user_current'

function approvalNode(key: string, name: string): ApprovalNode {
  return {
    key,
    type: 'approval',
    name,
    config: { assigneeType: 'user', assigneeIds: [VIEWER_ID], approvalMode: 'single', emptyAssigneePolicy: 'error' },
  }
}

const RETURN_GATE_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '提交申请', config: {} },
    approvalNode('approval_1', '部门经理初审'),
    { key: 'cc_1', type: 'cc', name: '抄送人事', config: { targetType: 'user', targetIds: ['user_hr'] } },
    { key: 'handler_1', type: 'handler', name: '资料补正办理', config: { assigneeSources: [] } },
    {
      key: 'parallel_1',
      type: 'parallel',
      name: '并行会签',
      config: { branches: ['edge_p1', 'edge_p2'], joinMode: 'any', joinNodeKey: 'join_1' },
    },
    approvalNode('approval_p1', '法务会签'),
    approvalNode('approval_p2', '合规会签'),
    { key: 'join_1', type: 'cc', name: '会签结果抄送', config: { targetType: 'user', targetIds: ['user_hr'] } },
    approvalNode('approval_2', '财务复核'),
    approvalNode('approval_3', '总经理终审'),
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

function historyRow(
  id: string,
  action: string,
  actor: { id: string; name: string },
  comment: string | null,
  hours: number,
  metadata: Record<string, unknown>,
): UnifiedApprovalHistoryDTO {
  return {
    id,
    action,
    actorId: actor.id,
    actorName: actor.name,
    comment,
    fromStatus: action === 'created' ? null : 'pending',
    toStatus: 'pending',
    occurredAt: hoursIn(hours),
    metadata,
  }
}

// Newest first, as `/history` serves it (`ORDER BY occurred_at DESC`).
const HISTORY: UnifiedApprovalHistoryDTO[] = [
  historyRow('rc_hist_7', 'return', { id: 'user_gm', name: '总经理' }, '请财务重新核对金额', 30, {
    nodeKey: 'approval_3',
    targetNodeKey: 'approval_2',
  }),
  historyRow('rc_hist_6', 'approve', { id: VIEWER_ID, name: '当前审批人' }, '金额无误', 26, { nodeKey: 'approval_2' }),
  historyRow('rc_hist_5', 'approve', { id: 'user_legal', name: '法务专员' }, '条款无异议', 20, { nodeKey: 'approval_p1' }),
  historyRow('rc_hist_4', 'handle', { id: 'user_clerk', name: '行政专员' }, '资料已补正', 12, { nodeKey: 'handler_1' }),
  historyRow('rc_hist_3', 'cc', { id: 'system', name: 'System' }, null, 4, { nodeKey: 'cc_1' }),
  historyRow('rc_hist_2', 'approve', { id: 'user_manager', name: '部门经理' }, '同意', 3, { nodeKey: 'approval_1' }),
  historyRow('rc_hist_1', 'created', { id: 'user_1', name: '张三' }, null, 0, { nodeKey: 'start' }),
]

function viewerSeat(nodeKey: string): ApprovalAssignmentDTO {
  return {
    id: `rc_seat_${nodeKey}`,
    type: 'user',
    assigneeId: VIEWER_ID,
    sourceStep: 3,
    nodeKey,
    isActive: true,
    metadata: { assigneeName: '当前审批人' },
  }
}

function parseScenario(raw: string | null): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate === raw)
  if (!scenario) {
    throw new Error(`return-candidates harness: unknown ?scenario=${String(raw)} (expected one of ${SCENARIOS.join(', ')})`)
  }
  return scenario
}

function fixtureFor(scenario: Scenario, loaded: UnifiedApprovalDTO): UnifiedApprovalDTO {
  const serverList: UnifiedApprovalDTO = {
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
    assignments: [viewerSeat('approval_2')],
    returnableNodeKeys: ['approval_1'],
  }
  const clientMirror: UnifiedApprovalDTO = { ...serverList }
  delete clientMirror.returnableNodeKeys

  switch (scenario) {
    case 'server-list':
    case 'submit':
      return serverList
    case 'server-empty':
      return { ...serverList, returnableNodeKeys: [] }
    case 'client-mirror':
      return clientMirror
    case 'handler-cursor':
      return { ...clientMirror, currentNodeType: 'handler' }
    case 'parallel-state': {
      const actionResponse: UnifiedApprovalDTO = {
        ...clientMirror,
        currentNodeKey: 'parallel_1',
        currentNodeKeys: ['approval_p1', 'approval_p2'],
        assignments: [viewerSeat('approval_p1')],
      }
      delete actionResponse.currentNodeType
      return actionResponse
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
  if (drifted && scenario !== 'server-list' && scenario !== 'client-mirror') {
    throw new Error('return-candidates harness: &template=drifted pairs only with server-list or client-mirror')
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
        id: VIEWER_ID,
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
  store.history = HISTORY
  store.activeApproval = fixtureFor(scenario, loaded)

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
