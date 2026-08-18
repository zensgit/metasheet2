// F4 browser-verification harness (delta §5 F4 / F2-gate handoff condition 1) — mounts the REAL
// production `TemplateAuthoringView.vue` (not a bespoke wrapper) with the REAL Vue Router and REAL
// Element Plus, exactly as `apps/main.ts` composes the app. This is the "mounted production
// surface" the B1-B12 matrix (approval-form-builder-mounted-matrix.spec.ts) drives with genuine
// mouse drags (`locator.dragTo`) — the harness under approval-form-builder-harness.ts mounts the
// builder/palette standalone and is NOT this file's replacement (F2 lane, DataTransfer drags).
//
// No backend is reachable from this harness. Two production mechanisms make that safe without any
// framework-level mock:
// - `useFeatureFlags().loadProductFeatures(true, { skipSessionProbe: true })` skips the session/
//   plugin probes entirely and resolves purely from `localStorage.metasheet_features` (the SAME
//   dev-override path `apps/web/src/stores/featureFlags.ts` ships for local development — allowed
//   whenever `import.meta.env.DEV`, which the Vite dev server this harness runs under always is).
// - `useApprovalPermissions()` reads `localStorage.user_roles` synchronously (no network) via
//   `useAuth().getAccessSnapshot()`.
// A `/approval-templates/new` route needs no fetch at all (`loadTemplateForEdit` takes the
// synchronous empty-draft branch). The matrix spec's edit-mode/legacy-compatibility rows use
// Playwright's `page.route()` to intercept `getTemplate`/`createTemplate` at the network layer
// instead — real requests, real responses, no vi.mock.
import { createApp, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import { useFeatureFlags } from '../src/stores/featureFlags'

declare global {
  interface Window {
    __AFB_MOUNT_READY__?: boolean
  }
}

async function main(): Promise<void> {
  // Dev-override path (§ module doc above) — set BEFORE loadProductFeatures reads it.
  const params = new URLSearchParams(window.location.search)
  const canvasV2 = params.get('canvasV2') !== 'off'
  localStorage.setItem('metasheet_features', JSON.stringify({ approvalCanvasV2: canvasV2 }))
  localStorage.setItem('user_roles', JSON.stringify(['admin']))

  const { loadProductFeatures } = useFeatureFlags()
  await loadProductFeatures(true, { skipSessionProbe: true })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/approval-templates/new', component: TemplateAuthoringView },
      { path: '/approval-templates/:id/edit', component: TemplateAuthoringView },
      { path: '/elsewhere', component: defineComponent({ render: () => h('div', { 'data-testid': 'elsewhere-route' }, 'elsewhere') }) },
    ],
  })

  const RootShell = defineComponent({
    name: 'RootShell',
    render: () => h(RouterView),
  })

  const app = createApp(RootShell)
  app.use(router)
  app.use(ElementPlus)
  app.mount('#app')

  const startPath = params.get('route') === 'edit' ? '/approval-templates/afb_harness_1/edit' : '/approval-templates/new'
  await router.push(startPath)
  await router.isReady()

  window.__AFB_MOUNT_READY__ = true
  window.dispatchEvent(new Event('afb-mount-ready'))
}

void main()
