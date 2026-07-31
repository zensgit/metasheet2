// Real-browser verification entry for the production approval authoring view.
// It provides only local auth/feature context; all authoring behavior remains in production modules.
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import '../src/styles/form-layout-utilities.css'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import { useFeatureFlags } from '../src/stores/featureFlags'

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
  ],
})

await useFeatureFlags().loadProductFeatures(true, { skipSessionProbe: true })
await router.push('/approval-templates/new')
await router.isReady()

createApp(TemplateAuthoringView)
  .use(createPinia())
  .use(router)
  .use(ElementPlus)
  .mount('#app')
