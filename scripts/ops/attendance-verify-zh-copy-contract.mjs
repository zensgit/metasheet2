import fs from 'node:fs/promises'

const attendanceViewPath = 'apps/web/src/views/AttendanceView.vue'
const experienceViewPath = 'apps/web/src/views/attendance/AttendanceExperienceView.vue'
const workflowDesignerPath = 'apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue'

const legacySnippets = [
  '<h3>Records</h3>',
  "{{ exporting ? 'Exporting...' : 'Export CSV' }}",
  '<div v-if="records.length === 0" class="attendance__empty">No records.</div>',
  '<h4>User Access</h4>',
  "{{ provisionLoading ? 'Loading...' : 'Load' }}",
  "{{ provisionLoading ? 'Working...' : 'Assign role' }}",
  "{{ provisionLoading ? 'Working...' : 'Remove role' }}",
  '<span>User search (email/name/id)</span>',
  '<h4>Batch Provisioning</h4>',
  '<h4>Audit Logs</h4>',
  "{{ auditLogLoading ? 'Loading...' : 'Reload logs' }}",
  "{{ auditLogExporting ? 'Exporting...' : 'Export CSV' }}",
  '<h4>Rule Sets</h4>',
  "{{ ruleSetLoading ? 'Loading...' : 'Reload rule sets' }}",
  '<h4>Rule Template Library</h4>',
  '<h4>Attendance groups</h4>',
  '<h4>Group members</h4>',
  '<h4>Import (DingTalk / Manual)</h4>',
  "{{ importLoading ? 'Loading...' : 'Load template' }}",
  '<span>Import mode</span>',
  '<span>CSV file (optional)</span>',
  '<span>User map key field</span>',
  '<h4>Import batches</h4>',
  '<h5 class="attendance__subheading">Batch items</h5>',
  '<h4>Approval Flows</h4>',
  "{{ approvalFlowLoading ? 'Loading...' : 'Reload flows' }}",
  '<div v-if="approvalFlows.length === 0" class="attendance__empty">No approval flows yet.</div>',
  '<h4>Rotation Rules</h4>',
  "{{ rotationRuleLoading ? 'Loading...' : 'Reload rotation rules' }}",
  '<h4>Rotation Assignments</h4>',
  "{{ rotationAssignmentLoading ? 'Loading...' : 'Reload rotations' }}",
  '<h4>Shifts</h4>',
  "{{ shiftLoading ? 'Loading...' : 'Reload shifts' }}",
  '<h4>Assignments</h4>',
  "{{ assignmentLoading ? 'Loading...' : 'Reload assignments' }}",
  '<h4>Holidays</h4>',
  "{{ holidayLoading ? 'Loading...' : 'Reload holidays' }}",
  "if (!window.confirm('Delete this approval flow?')) return",
  "if (!window.confirm('Delete this rotation rule?')) return",
  "if (!window.confirm('Delete this rotation assignment?')) return",
  "if (!window.confirm('Delete this shift? Assignments will be removed.')) return",
  "if (!window.confirm('Delete this assignment?')) return",
  "if (!window.confirm('Delete this holiday?')) return",
  "if (!window.confirm('Rollback this import batch?')) return",
  "if (!window.confirm('Delete this leave type?')) return",
  "if (!window.confirm('Delete this overtime rule?')) return",
  "if (!window.confirm('Delete this rule set?')) return",
  "if (!window.confirm('Delete this attendance group?')) return",
  "if (!window.confirm('Restore this template version? This will overwrite the current library.')) return",
  "if (!window.confirm('Delete this payroll template?')) return",
  "if (!window.confirm('Delete this payroll cycle?')) return",
]

const expectedZhSnippets = [
  { path: experienceViewPath, snippet: "desktopRecommended: '建议使用桌面端'" },
  { path: experienceViewPath, snippet: "adminCenter: '管理中心'" },
  { path: experienceViewPath, snippet: "workflowDesigner: '流程设计'" },
  { path: workflowDesignerPath, snippet: "title: '审批流程设计器'" },
  { path: workflowDesignerPath, snippet: "empty: '当前租户未启用流程能力。'" },
]

const templateEnglishLeaks = [
  {
    path: experienceViewPath,
    snippets: [
      'Desktop recommended',
      'Back to Overview',
      'Capability not available',
      'Workflow designer is desktop-only in this release.',
      'Admin center is desktop-first.',
    ],
  },
  {
    path: workflowDesignerPath,
    snippets: [
      'Approval Workflow Designer',
      'Workflow capability is not enabled for this tenant.',
    ],
  },
]

function fail(message) {
  console.error(`[attendance-verify-zh-copy-contract] FAIL: ${message}`)
  process.exit(1)
}

function extractTemplateSection(vueSource) {
  const match = vueSource.match(/<template>[\s\S]*?<\/template>/)
  return match ? match[0] : ''
}

async function run() {
  const attendanceSource = await fs.readFile(attendanceViewPath, 'utf8')
  const foundLegacy = legacySnippets.filter((snippet) => attendanceSource.includes(snippet))
  if (foundLegacy.length > 0) {
    fail(`legacy hard-coded English snippets detected in ${attendanceViewPath} (${foundLegacy.length}):\n${foundLegacy.map(item => `- ${item}`).join('\n')}`)
  }

  const sourceMap = new Map()
  for (const filePath of [experienceViewPath, workflowDesignerPath]) {
    sourceMap.set(filePath, await fs.readFile(filePath, 'utf8'))
  }

  const missingZh = expectedZhSnippets.filter(({ path, snippet }) => {
    const source = sourceMap.get(path) || ''
    return !source.includes(snippet)
  })
  if (missingZh.length > 0) {
    fail(`expected zh snippets missing:\n${missingZh.map((item) => `- ${item.path}: ${item.snippet}`).join('\n')}`)
  }

  const englishLeakHits = []
  for (const { path, snippets } of templateEnglishLeaks) {
    const source = sourceMap.get(path) || ''
    const template = extractTemplateSection(source)
    for (const snippet of snippets) {
      if (template.includes(snippet)) {
        englishLeakHits.push(`- ${path}: ${snippet}`)
      }
    }
  }

  if (englishLeakHits.length > 0) {
    fail(`hard-coded English text leaked into zh-guarded templates:\n${englishLeakHits.join('\n')}`)
  }

  console.log('[attendance-verify-zh-copy-contract] PASS: zh copy contract holds for attendance view shell + wrappers')
}

run().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
