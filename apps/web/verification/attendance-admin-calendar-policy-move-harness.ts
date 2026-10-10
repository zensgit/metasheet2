// Browser harness for the Holidays move of effective calendar overrides.
// Mounts the real AttendanceView in admin mode (same router-less provide the
// admin regression suite uses). API calls are fulfilled by the Playwright spec.
// Not part of the app build.
import { createApp } from 'vue'
import { routerKey } from 'vue-router'
import '../src/styles/tokens.css'
import AttendanceView from '../src/views/AttendanceView.vue'

const KNOWN = new Set(['attendance-admin-holidays', 'attendance-admin-settings'])
const requested = new URLSearchParams(window.location.search).get('section') ?? 'attendance-admin-holidays'
const initialSectionId = KNOWN.has(requested) ? requested : 'attendance-admin-holidays'

const app = createApp(AttendanceView, {
  mode: 'admin',
  initialSectionId,
})
app.provide(routerKey, undefined)
app.mount('#app')
