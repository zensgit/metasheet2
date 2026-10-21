// Instance-consistency browser acceptance harness (2026-09-06). Mounts the REAL
// ApprovalDetailView with the REAL Vue Router, Pinia store and Element Plus, exactly as the app
// composes it, and drives the REAL fetch path so a Playwright `page.route()` can choose the
// response ORDER of two overlapping detail requests (the outgoing instance answered slowly, the
// incoming one answered fast).
//
// `__APPROVAL_MOCK__ = false` is what makes that possible: the approval api layer reads that flag
// ONCE at module initialization and otherwise short-circuits every request to an in-process fixture
// under Vite DEV, which would make a network-delay test vacuously green. Everything that pulls the
// api layer in is therefore imported DYNAMICALLY, after the assignment — a static top-level import
// would evaluate `approvals/api.ts` first (same discipline as
// approval-form-builder-mounted-harness.ts).
//
// The harness deliberately signals ready as soon as the view is mounted, WITHOUT waiting for a
// loaded instance: the window under test is precisely the one where the first instance has not
// arrived yet.
import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

declare global {
  interface Window {
    __P0B_READY__?: boolean
    __P0B_NAVIGATE__?: (id: string) => Promise<void>
  }
}

async function main(): Promise<void> {
  const globalScope = globalThis as { __APPROVAL_MOCK__?: boolean }
  globalScope.__APPROVAL_MOCK__ = false

  localStorage.setItem('metasheet_features', JSON.stringify({
    approvalMobile: false,
    approvalAttachments: false,
  }))
  localStorage.setItem('user_roles', JSON.stringify(['admin']))
  localStorage.setItem('user_permissions', JSON.stringify(['approvals:read', 'approvals:act']))

  const { useAuth } = await import('../src/composables/useAuth')
  useAuth().primeSession({
    data: {
      user: {
        id: 'user_current',
        roles: ['admin'],
        permissions: ['approvals:read', 'approvals:act'],
      },
    },
  })

  const { useFeatureFlags } = await import('../src/stores/featureFlags')
  const { loadProductFeatures } = useFeatureFlags()
  await loadProductFeatures(true, { skipSessionProbe: true })

  const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')

  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/approvals/:id', component: ApprovalDetailView }],
  })

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(pinia)
  app.use(router)
  app.use(ElementPlus)

  const params = new URLSearchParams(window.location.search)
  await router.push(`/approvals/${params.get('start') ?? 'apv_race_a'}`)
  await router.isReady()
  app.mount('#app')

  // Params-only navigation, i.e. the reuse-this-component path the fix is about.
  window.__P0B_NAVIGATE__ = async (id: string) => {
    await router.push(`/approvals/${id}`)
  }
  window.__P0B_READY__ = true
  window.dispatchEvent(new Event('p0b-instance-consistency-ready'))
}

void main()
