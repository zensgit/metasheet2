import fs from 'node:fs/promises'

const attendanceViewPath = 'apps/web/src/views/AttendanceView.vue'

const legacySnippets = [
  '<h3>Records</h3>',
  '{{ exporting ? \'Exporting...\' : \'Export CSV\' }}',
  '<div v-if="records.length === 0" class="attendance__empty">No records.</div>',
  '<h4>User Access</h4>',
  '{{ provisionLoading ? \'Loading...\' : \'Load\' }}',
  '{{ provisionLoading ? \'Working...\' : \'Assign role\' }}',
  '{{ provisionLoading ? \'Working...\' : \'Remove role\' }}',
  '<span>User search (email/name/id)</span>',
  '<h4>Batch Provisioning</h4>',
  '<h4>Audit Logs</h4>',
  '{{ auditLogLoading ? \'Loading...\' : \'Reload logs\' }}',
  '{{ auditLogExporting ? \'Exporting...\' : \'Export CSV\' }}',
  '<h4>Rule Sets</h4>',
  '{{ ruleSetLoading ? \'Loading...\' : \'Reload rule sets\' }}',
  '<h4>Rule Template Library</h4>',
  '<h4>Attendance groups</h4>',
  '<h4>Group members</h4>',
  '<h4>Import (DingTalk / Manual)</h4>',
  '{{ importLoading ? \'Loading...\' : \'Load template\' }}',
  '<span>Import mode</span>',
  '<span>CSV file (optional)</span>',
  '<span>User map key field</span>',
  '<h4>Import batches</h4>',
  '<h5 class="attendance__subheading">Batch items</h5>',
]

function fail(message) {
  console.error(`[attendance-verify-zh-copy-contract] FAIL: ${message}`)
  process.exit(1)
}

async function run() {
  const source = await fs.readFile(attendanceViewPath, 'utf8')
  const found = legacySnippets.filter((snippet) => source.includes(snippet))
  if (found.length > 0) {
    fail(`legacy hard-coded English snippets detected (${found.length}):\n${found.map(item => `- ${item}`).join('\n')}`)
  }
  console.log('[attendance-verify-zh-copy-contract] PASS: no legacy hard-coded English snippets found in guarded attendance sections')
}

run().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
