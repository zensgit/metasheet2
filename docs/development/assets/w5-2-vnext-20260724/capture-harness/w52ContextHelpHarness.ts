// W5-2 evidence harness entry (copied to apps/web/src/dev-harness/w52ContextHelpHarness.ts at
// capture time by capture-context-help.mjs; removed afterwards). Mounts the REAL
// AttendanceContextHelp.vue with the REAL design tokens and the REAL pure module
// (attendanceContextHelp.ts) — every string on screen is produced by the same closed-set content
// module the specs assert against. Zero user data anywhere (the module takes no runtime input
// beyond a closed-set contextId and a translator function — there is nothing to synthesize).
// Scenario/locale come from the query string: ?context=setup-wizard|import|self-request-center
// &locale=zh|en
import { createApp } from 'vue'
import '../styles/tokens.css'
import AttendanceContextHelp from '../views/attendance/AttendanceContextHelp.vue'
import {
  isAttendanceContextHelpContextId,
  type AttendanceContextHelpContextId,
} from '../views/attendance/attendanceContextHelp'

const params = new URLSearchParams(window.location.search)
const contextParam = params.get('context') || 'setup-wizard'
if (!isAttendanceContextHelpContextId(contextParam)) {
  throw new Error(`harness: unknown context '${contextParam}'`)
}
const contextId: AttendanceContextHelpContextId = contextParam
const locale = params.get('locale') === 'en' ? 'en' : 'zh'
const tr = (en: string, zh: string): string => (locale === 'en' ? en : zh)

createApp(AttendanceContextHelp, { tr, contextId }).mount('#app')
