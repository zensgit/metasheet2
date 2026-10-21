// P5-C browser/mobile/a11y acceptance harness. It mounts the real ApprovalDetailView with the
// production Router, Pinia stores, Element Plus dialogs, focus trap, and responsive composable.
// The harness changes only deterministic fixture state after the dev API has populated the store;
// dialog rendering and interaction remain production code.
//
// `?scenario=role-seat-evidence` swaps the fixture for a ROLE-seated approver with the attachment
// pipeline ON: no assignment names the viewer (so the client-side `isMyTurn` mirror is false) and
// the detail carries the server-resolved `canAttachProcessEvidence` — `true`, or `false` with
// `&evidence=denied`. Without the parameter the fixture is exactly the P5-C one.
//
// The cursor is pinned at `approval_2`, the SECOND approval node of the dev-mode template graph
// (start → approval_1 → approval_2 → end), and every seat sits on that node. 退回 only offers
// approval nodes UPSTREAM of the cursor (the same rule the server's return gate applies), so a
// cursor at the first approval node would legitimately have no 退回 target and no 退回 button;
// at `approval_2` the legal target is `approval_1` (部门主管审批).
//
// `?scenario=add-sign-after` (F4-S1, Lock-5 L5-B) keeps the P5-C fixture and wraps ONLY the store's
// `executeAction`: every request is recorded on `window.__P5C_ACTION_REQUESTS__`, and an `add_sign`
// with `addSignMode:'after'` is refused with the error `dispatchAction` throws for the server's
// round-incomplete 409 — an `ApprovalApiError` built exactly as `approvalRequestError` builds it
// (message, status, `error.code`). Any other request goes to the original action unchanged.
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import ApprovalDetailView from '../src/views/approval/ApprovalDetailView.vue'
import { useApprovalStore } from '../src/approvals/store'
import { ApprovalApiError } from '../src/approvals/api'
import { useAuth } from '../src/composables/useAuth'
import { useLocale } from '../src/composables/useLocale'
import { useFeatureFlags } from '../src/stores/featureFlags'
import type { ApprovalActionRequest } from '../src/types/approval'

declare global {
  interface Window {
    __P5C_MEMBER_DIALOG_READY__?: boolean
    __P5C_ACTION_REQUESTS__?: Array<{ id: string; req: ApprovalActionRequest }>
  }
}

async function waitForLoadedApproval(): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const store = useApprovalStore()
    if (store.activeApproval?.id === 'apv_5' && store.history.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('P5-C harness timed out waiting for the approval detail fixture')
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const roleSeatEvidence = params.get('scenario') === 'role-seat-evidence'
  const addSignAfter = params.get('scenario') === 'add-sign-after'
  const evidenceAllowed = params.get('evidence') !== 'denied'

  // O-8 / F8-1: ApprovalDetailView follows the shell locale; the paired spec asserts the shipped
  // zh-CN accessible names (the C1 selectors), so pin zh-CN instead of inheriting the browser's
  // language. The English copy is covered by the jsdom render scans.
  useLocale().setLocale('zh-CN')
  localStorage.setItem('metasheet_features', JSON.stringify({
    approvalMobile: true,
    approvalAttachments: roleSeatEvidence,
  }))
  localStorage.setItem('user_roles', JSON.stringify(['admin']))
  localStorage.setItem('user_permissions', JSON.stringify(['approvals:read', 'approvals:act']))

  useAuth().primeSession({
    data: {
      user: {
        id: 'user_current',
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
    routes: [
      { path: '/approvals/:id', component: ApprovalDetailView },
      {
        path: '/elsewhere',
        component: defineComponent({
          render: () => h('div', { 'data-testid': 'elsewhere-route' }, 'elsewhere'),
        }),
      },
    ],
  })

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(pinia)
  app.use(router)
  app.use(ElementPlus)

  await router.push('/approvals/apv_5')
  await router.isReady()
  app.mount('#app')

  await waitForLoadedApproval()

  const store = useApprovalStore(pinia)
  const detail = store.activeApproval
  if (!detail) throw new Error('P5-C harness loaded no approval')

  store.activeApproval = {
    ...detail,
    currentNodeKey: 'approval_2',
    nodeOperations: {
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    },
    assignments: roleSeatEvidence
      ? [
          {
            id: 'asgn_role',
            type: 'role',
            assigneeId: 'admin',
            sourceStep: 1,
            nodeKey: 'approval_2',
            isActive: true,
            metadata: {},
          },
        ]
      : [
          {
            id: 'asgn_current',
            type: 'user',
            assigneeId: 'user_current',
            sourceStep: 1,
            nodeKey: 'approval_2',
            isActive: true,
            metadata: { assigneeName: '当前审批人' },
          },
          {
            id: 'asgn_added',
            type: 'user',
            assigneeId: 'user_added',
            sourceStep: 1,
            nodeKey: 'approval_2',
            isActive: true,
            metadata: { addSign: true, assigneeName: '加签审批人' },
          },
        ],
    ...(roleSeatEvidence
      ? { canDecideCurrentNode: true, canAttachProcessEvidence: evidenceAllowed }
      : {}),
  }

  if (addSignAfter) {
    window.__P5C_ACTION_REQUESTS__ = []
    const originalExecuteAction = store.executeAction
    store.executeAction = async (id: string, req: ApprovalActionRequest) => {
      window.__P5C_ACTION_REQUESTS__!.push({ id, req: JSON.parse(JSON.stringify(req)) })
      if (req.action === 'add_sign' && req.addSignMode === 'after') {
        throw new ApprovalApiError(
          'After-mode add_sign requires the current round to complete with this approval',
          409,
          'APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE',
        )
      }
      return originalExecuteAction(id, req)
    }
  }

  await nextTick()
  window.__P5C_MEMBER_DIALOG_READY__ = true
  window.dispatchEvent(new Event('p5c-member-dialog-ready'))
}

void main()
