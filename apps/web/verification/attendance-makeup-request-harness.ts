// Real parent, form state and submit path. Only HTTP is mocked by Playwright.
import { createApp, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AttendanceView from '../src/views/AttendanceView.vue'
import '../src/styles/tokens.css'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/attendance', component: AttendanceView }],
})
await router.push('/attendance')
await router.isReady()
createApp({ render: () => h(AttendanceView, { mode: 'overview' }) }).use(router).mount('#app')
