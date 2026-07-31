// Real-browser verification entry for the production approval authoring view.
// It provides only local auth/feature context; all authoring behavior remains in production modules.
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import '../src/styles/form-layout-utilities.css'
import { useFeatureFlags } from '../src/stores/featureFlags'

// This harness verifies the production request wrappers through Playwright-controlled endpoints.
// Set the explicit override before importing the authoring view (and therefore approvals/api).
;(globalThis as { __APPROVAL_MOCK__?: boolean }).__APPROVAL_MOCK__ = false
const { default: TemplateAuthoringView } = await import('../src/views/approval/TemplateAuthoringView.vue')

window.localStorage.setItem('user_permissions', JSON.stringify([
  'approvals:read',
  'approvals:write',
  'approval-templates:manage',
]))
window.localStorage.setItem('metasheet_features', JSON.stringify({
  approvalAttachments: true,
  approvalCanvasV2: true,
}))

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/approval-templates/new',
      name: 'approval-template-create',
      component: TemplateAuthoringView,
    },
    {
      path: '/approval-templates/:id/edit',
      name: 'approval-template-edit',
      component: TemplateAuthoringView,
    },
  ],
})

await useFeatureFlags().loadProductFeatures(true, { skipSessionProbe: true })
const harnessMode = new URL(window.location.href).searchParams.get('mode')
await router.push(harnessMode === 'version' ? '/approval-templates/tpl-browser/edit' : '/approval-templates/new')
await router.isReady()

createApp(TemplateAuthoringView)
  .use(createPinia())
  .use(router)
  .use(ElementPlus)
  .mount('#app')
