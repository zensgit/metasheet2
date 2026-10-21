// F3-E1 browser acceptance harness (审批中心「导出 CSV」, 2026-09-30). Mounts the REAL
// ApprovalCenterView with the REAL Vue Router, Pinia store and Element Plus, and drives the REAL
// fetch path, so the Playwright spec can serve both the list and the CSV export through
// `page.route()` and read back the file the browser actually saved.
//
// `__APPROVAL_MOCK__ = false` is what makes that possible: the approval api layer reads that flag
// ONCE at module initialization and otherwise answers every request from an in-process fixture
// under Vite DEV, which would leave the list requests off the network and make a "the export
// carries the list's filters" comparison vacuous. Everything that pulls the api layer in is
// therefore imported DYNAMICALLY, after the assignment (same discipline as
// approval-instance-consistency-race-harness.ts).
//
// The file name is deliberately NOT `approval-center-*`: the required web lane passes the bare
// token `approval-center` to vitest as a path-substring filter, and vitest's default include also
// collects verification/*.spec.ts, so a Playwright spec with that prefix would be picked up there.
import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

declare global {
  interface Window {
    __F3E1_CSV_EXPORT_READY__?: boolean
  }
}

const HARNESS_TOKEN = 'tok_f3e1_csv_export'

function placeholder(testId: string) {
  return defineComponent({ render: () => h('div', { 'data-testid': testId }, testId) })
}

async function main(): Promise<void> {
  const globalScope = globalThis as { __APPROVAL_MOCK__?: boolean }
  globalScope.__APPROVAL_MOCK__ = false

  // Read at module load by useLocale, so it is set before any dynamic import below.
  localStorage.setItem('metasheet_locale', 'zh-CN')
  localStorage.setItem('auth_token', HARNESS_TOKEN)
  localStorage.setItem('metasheet_features', JSON.stringify({
    approvalMobile: false,
    approvalAttachments: false,
  }))
  localStorage.setItem('user_roles', JSON.stringify(['admin']))
  localStorage.setItem('user_permissions', JSON.stringify(['approvals:read', 'approvals:act', 'approvals:write']))

  const { useAuth } = await import('../src/composables/useAuth')
  useAuth().primeSession({
    data: {
      user: {
        id: 'user_current',
        roles: ['admin'],
        permissions: ['approvals:read', 'approvals:act', 'approvals:write'],
      },
    },
  })

  const { useFeatureFlags } = await import('../src/stores/featureFlags')
  const { loadProductFeatures } = useFeatureFlags()
  await loadProductFeatures(true, { skipSessionProbe: true })

  const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')

  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/approvals', name: 'approval-list', component: ApprovalCenterView },
      { path: '/approvals/:id', name: 'approval-detail', component: placeholder('harness-approval-detail') },
      { path: '/approval-templates', name: 'approval-template-list', component: placeholder('harness-template-list') },
    ],
  })

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(pinia)
  app.use(router)
  app.use(ElementPlus)

  await router.push('/approvals')
  await router.isReady()
  app.mount('#app')

  window.__F3E1_CSV_EXPORT_READY__ = true
}

void main()
