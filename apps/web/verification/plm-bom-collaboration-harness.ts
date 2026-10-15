// Verification entry only. Real panel, native host, auth bootstrap and route policy; no API stubs.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import PlmBomReviewPanel from '../src/components/plm/PlmBomReviewPanel.vue'
import MultitableEmbedHost from '../src/multitable/views/MultitableEmbedHost.vue'
import { buildMultitableRoute, resolveMultitableRouteProps } from '../src/router/multitableRoute'
import { buildRouteGuardContext, buildRouteGuardInput, resolveRouteGuardDecision } from '../src/router/guardPolicy'
import { useAuth } from '../src/composables/useAuth'
import { useFeatureFlags } from '../src/stores/featureFlags'

const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/plm', component: { render: () => h(PlmBomReviewPanel, { dataSourceId: 'w20-y-source' }) }, meta: { requiresAuth: true } },
  buildMultitableRoute(MultitableEmbedHost),
  // Red-only observation route: the old focus gate otherwise prevents reaching the grid defect.
  { path: '/plm/native-probe/:sheetId/:viewId', component: MultitableEmbedHost, props: resolveMultitableRouteProps, meta: { requiresAuth: true } },
] })
router.beforeEach(async (to) => {
  const auth = useAuth(), flags = useFeatureFlags()
  if (!(await auth.bootstrapSession()).ok) throw new Error('Real authentication bootstrap failed')
  await flags.loadProductFeatures()
  const decision = resolveRouteGuardDecision(buildRouteGuardInput(to), buildRouteGuardContext({ auth, flags }))
  if (decision.action === 'redirect') return decision.target
})
createApp({ render: () => h(RouterView) }).use(createPinia()).use(router).mount('#app')
