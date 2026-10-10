// Browser harness for admin form chrome checks.
// Mounts the real AttendanceView in admin mode (same router-less provide the
// admin regression suite uses). API calls are fulfilled by the Playwright spec.
// Not part of the app build. Holidays and Settings stay in the known set so the
// calendar-policy move spec can reuse this page.
import { createApp } from 'vue'
import { routerKey } from 'vue-router'
import '../src/styles/tokens.css'
import AttendanceView from '../src/views/AttendanceView.vue'

const KNOWN = new Set([
  'attendance-admin-holidays',
  'attendance-admin-settings',
  'attendance-admin-default-rule',
  'attendance-admin-rule-sets',
  'attendance-admin-rule-template-library',
  'attendance-admin-import',
  'attendance-admin-payroll-templates',
  'attendance-admin-payroll-cycles',
  'attendance-admin-makeup-punch-policy',
  'attendance-admin-shifts',
  'attendance-admin-leave-types',
  'attendance-admin-overtime-rules',
  'attendance-admin-approval-flows',
])
const requested = new URLSearchParams(window.location.search).get('section') ?? 'attendance-admin-holidays'
const initialSectionId = KNOWN.has(requested) ? requested : 'attendance-admin-holidays'

const app = createApp(AttendanceView, {
  mode: 'admin',
  initialSectionId,
})
app.provide(routerKey, undefined)
app.mount('#app')
