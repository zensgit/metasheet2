// O-8 / slice F8-1 browser acceptance harness (approval member surface follows the shell locale,
// 2026-09-30). Mounts the REAL ApprovalCenterView and ApprovalDetailView with the REAL Vue Router,
// Pinia and Element Plus over the REAL fetch path (`page.route()` stands in for the server), starts
// in English, and exposes the SAME switch the app shell uses (`useLocale().setLocale`) so the
// Playwright spec can flip en -> zh-CN -> en at runtime on a mounted page.
//
// `__APPROVAL_MOCK__ = false` keeps the list / detail requests on the network (the api layer reads
// the flag once at module initialization), so everything that pulls the api layer in is imported
// DYNAMICALLY after the assignment (same discipline as approval-list-csv-download-harness.ts).
//
// The file name avoids every token of the required web lane (vitest path-substring filters), so
// this Playwright spec is not collected there.
import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import { useLocale, type AppLocale } from '../src/composables/useLocale'

declare global {
  interface Window {
    __F81_LOCALE_READY__?: boolean
    __F81_SET_LOCALE__?: (locale: AppLocale) => void
  }
}

const HARNESS_TOKEN = 'tok_f81_locale_switch'

function placeholder(testId: string) {
  return defineComponent({ render: () => h('div', { 'data-testid': testId }, testId) })
}

async function main(): Promise<void> {
  const globalScope = globalThis as { __APPROVAL_MOCK__?: boolean }
  globalScope.__APPROVAL_MOCK__ = false

  useLocale().setLocale('en')
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
  const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')

  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/approvals', name: 'approval-list', component: ApprovalCenterView },
      { path: '/approvals/:id', name: 'approval-detail', component: ApprovalDetailView },
      { path: '/approval-templates', name: 'approval-template-list', component: placeholder('harness-template-list') },
    ],
  })

  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(pinia)
  app.use(router)
  app.use(ElementPlus)

  const params = new URLSearchParams(window.location.search)
  await router.push(params.get('path') ?? '/approvals')
  await router.isReady()
  app.mount('#app')

  window.__F81_SET_LOCALE__ = (locale: AppLocale) => useLocale().setLocale(locale)
  window.__F81_LOCALE_READY__ = true
}

void main()
