// P5-C browser/mobile/a11y acceptance harness. It mounts the real ApprovalDetailView with the
// production Router, Pinia stores, Element Plus dialogs, focus trap, and responsive composable.
// The harness changes only deterministic fixture state after the dev API has populated the store;
// dialog rendering and interaction remain production code.
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import ApprovalDetailView from '../src/views/approval/ApprovalDetailView.vue'
import { useApprovalStore } from '../src/approvals/store'
import { useAuth } from '../src/composables/useAuth'
import { useFeatureFlags } from '../src/stores/featureFlags'

declare global {
  interface Window {
    __P5C_MEMBER_DIALOG_READY__?: boolean
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
  localStorage.setItem('metasheet_features', JSON.stringify({
    approvalMobile: true,
    approvalAttachments: false,
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
    currentNodeKey: 'approval_1',
    nodeOperations: {
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    },
    assignments: [
      {
        id: 'asgn_current',
        type: 'user',
        assigneeId: 'user_current',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: { assigneeName: '当前审批人' },
      },
      {
        id: 'asgn_added',
        type: 'user',
        assigneeId: 'user_added',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: { addSign: true, assigneeName: '加签审批人' },
      },
    ],
  }

  await nextTick()
  window.__P5C_MEMBER_DIALOG_READY__ = true
  window.dispatchEvent(new Event('p5c-member-dialog-ready'))
}

void main()
