/**
 * MetaSheet RC Demo Data Seeder
 *
 * Creates a fully-featured "Project Tracker" demo environment for showcasing
 * all Week 1-7 capabilities. Can be run via:
 *
 *   npx tsx scripts/seed-demo-data.ts [base_url]
 *
 * Prerequisites: a running MetaSheet server with a valid admin session.
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000'
const AUTH_HEADER = { Authorization: `Bearer ${process.env.DEMO_TOKEN || 'demo-admin-token'}` }
const JSON_HEADERS = { ...AUTH_HEADER, 'Content-Type': 'application/json' }

// ─── Helpers ───────────────────────────────────────────────────────────────

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`
  const res = await fetch(url, {
    method,
    headers: JSON_HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

function randomDate(start: Date, end: Date): string {
  const d = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))
  return d.toISOString().split('T')[0]
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ─── Constants ─────────────────────────────────────────────────────────────

const STATUSES = ['Not Started', 'In Progress', 'In Review', 'Done', 'Blocked']
const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
const ASSIGNEES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve']
const TITLES = [
  'Design system tokens',
  'API rate limiter',
  'User onboarding flow',
  'Dark mode support',
  'Export to CSV',
  'Mobile responsive layout',
  'Search indexing',
  'Webhook retry logic',
  'Dashboard drag-and-drop',
  'Comment threading',
  'Notification center',
  'Audit log viewer',
  'Role editor UI',
  'Formula engine v2',
  'Attachment preview',
  'Calendar view',
  'Gantt chart',
  'Template gallery',
  'Bulk import wizard',
  'Performance profiler',
]

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== MetaSheet Demo Data Seeder ===`)
  console.log(`Target: ${BASE_URL}\n`)

  // 1. Create sheet with fields
  console.log('1. Creating "Project Tracker" sheet...')
  const sheet = await api<{ id: string }>('POST', '/api/sheets', {
    name: 'Project Tracker (Demo)',
    fields: [
      { name: 'Title', type: 'string' },
      { name: 'Status', type: 'select', options: { choices: STATUSES } },
      { name: 'Priority', type: 'select', options: { choices: PRIORITIES } },
      { name: 'Assignee', type: 'string' },
      { name: 'Due Date', type: 'date' },
      { name: 'Effort (hours)', type: 'number' },
      { name: 'Description', type: 'text' },
    ],
  })
  console.log(`   Sheet ID: ${sheet.id}`)

  // 2. Set field validation rules
  console.log('2. Setting validation rules...')
  await api('PUT', `/api/sheets/${sheet.id}/validation`, {
    rules: [
      { fieldName: 'Title', rules: [{ type: 'required', message: 'Title is required' }] },
      { fieldName: 'Status', rules: [{ type: 'enum', params: { values: STATUSES } }] },
      { fieldName: 'Priority', rules: [{ type: 'enum', params: { values: PRIORITIES } }] },
      {
        fieldName: 'Effort (hours)',
        rules: [
          { type: 'min', params: { value: 0 }, message: 'Effort must be non-negative' },
          { type: 'max', params: { value: 999 }, message: 'Effort cannot exceed 999 hours' },
        ],
      },
    ],
  })

  // 3. Insert 20 sample records
  console.log('3. Inserting 20 sample records...')
  const recordIds: string[] = []
  for (let i = 0; i < 20; i++) {
    const rec = await api<{ id: string }>('POST', `/api/sheets/${sheet.id}/records`, {
      data: {
        Title: TITLES[i],
        Status: pick(STATUSES),
        Priority: pick(PRIORITIES),
        Assignee: pick(ASSIGNEES),
        'Due Date': randomDate(new Date('2026-05-01'), new Date('2026-08-31')),
        'Effort (hours)': Math.floor(Math.random() * 40) + 1,
        Description: `Demo task ${i + 1}: ${TITLES[i]}`,
      },
    })
    recordIds.push(rec.id)
  }
  console.log(`   Created ${recordIds.length} records`)

  // 4. Create automation rule: when Status = Done, lock the record
  console.log('4. Creating automation rule...')
  const rule = await api<{ id: string }>('POST', '/api/automations', {
    name: 'Auto-lock completed tasks',
    sheetId: sheet.id,
    trigger: { type: 'record.updated', config: {} },
    conditions: [{ fieldId: 'Status', operator: 'equals', value: 'Done' }],
    actions: [
      {
        type: 'update_record',
        config: { fields: { _locked: true } },
      },
    ],
    enabled: true,
  })
  console.log(`   Automation ID: ${rule.id}`)

  // 5. Create charts
  console.log('5. Creating charts...')
  const barChart = await api<{ id: string }>('POST', '/api/charts', {
    name: 'Records by Status',
    type: 'bar',
    sheetId: sheet.id,
    dataSource: {
      groupByFieldId: 'Status',
      aggregation: { function: 'count' },
    },
  })
  console.log(`   Bar chart ID: ${barChart.id}`)

  const lineChart = await api<{ id: string }>('POST', '/api/charts', {
    name: 'Tasks by Due Month',
    type: 'line',
    sheetId: sheet.id,
    dataSource: {
      groupByFieldId: 'Due Date',
      aggregation: { function: 'count' },
      dateGrouping: 'month',
    },
  })
  console.log(`   Line chart ID: ${lineChart.id}`)

  // 6. Create dashboard
  console.log('6. Creating dashboard...')
  const dashboard = await api<{ id: string }>('POST', '/api/dashboards', {
    name: 'Project Overview',
    sheetId: sheet.id,
    panels: [
      { chartId: barChart.id, position: { x: 0, y: 0, w: 6, h: 4 } },
      { chartId: lineChart.id, position: { x: 6, y: 0, w: 6, h: 4 } },
    ],
  })
  console.log(`   Dashboard ID: ${dashboard.id}`)

  // 7. Create public form link
  console.log('7. Creating public form...')
  const form = await api<{ token: string }>('POST', `/api/sheets/${sheet.id}/public-form`, {
    name: 'Submit a Task',
    visibleFields: ['Title', 'Priority', 'Assignee', 'Description'],
    expiresInDays: 30,
  })
  console.log(`   Public form URL: ${BASE_URL}/form/${form.token}`)

  // 8. Create API token
  console.log('8. Creating API token...')
  const token = await api<{ plainTextToken: string }>('POST', '/api/tokens', {
    name: 'Demo External Access',
    scopes: ['records:read', 'records:write'],
    expiresInDays: 90,
  })
  console.log(`   API token: ${token.plainTextToken}`)
  console.log('   (Store this — it will not be shown again)')

  // 9. Create webhook
  console.log('9. Creating webhook...')
  const webhook = await api<{ id: string }>('POST', '/api/webhooks', {
    sheetId: sheet.id,
    url: 'https://httpbin.org/post',
    events: ['record.created', 'record.updated'],
    secret: 'demo-webhook-secret',
  })
  console.log(`   Webhook ID: ${webhook.id}`)

  // 10. Add a sample comment
  console.log('10. Adding sample comment...')
  await api('POST', `/api/comments`, {
    sheetId: sheet.id,
    recordId: recordIds[0],
    body: `Great progress on "${TITLES[0]}"! @[Alice](user_alice) can you review?`,
  })

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n=== Demo Data Seeded Successfully ===')
  console.log(`  Sheet:      ${sheet.id}`)
  console.log(`  Records:    ${recordIds.length}`)
  console.log(`  Automation: ${rule.id}`)
  console.log(`  Charts:     ${barChart.id}, ${lineChart.id}`)
  console.log(`  Dashboard:  ${dashboard.id}`)
  console.log(`  Form URL:   ${BASE_URL}/form/${form.token}`)
  console.log(`  API Token:  ${token.plainTextToken.slice(0, 12)}...`)
  console.log(`  Webhook:    ${webhook.id}`)
  console.log('')
}

main().catch((err) => {
  console.error('Seeder failed:', err.message)
  process.exit(1)
})
