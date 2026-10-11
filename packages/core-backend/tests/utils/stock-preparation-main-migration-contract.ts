import assert from 'node:assert/strict'

/** Full provider keys, not numeric prefixes or a frozen total. Candidate migrations
 * use distinct names and sequential prefixes; none may hide these main migrations. */
export const requiredMainMigrationNames = Object.freeze([
  '087_create_integration_stock_prep_project_target',
  '088_extend_stock_prep_audit_project_target_actions',
  'zzzz20261008120000_add_stock_prep_pull_permission',
  'zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets',
  'zzzz20261009130000_create_task_m4_tables',
] as const)

export const requiredMainCatalogTables = Object.freeze([
  'integration_stock_prep_project_target', 'task_lists', 'task_list_members', 'task_list_items',
  'task_groups', 'task_group_items', 'task_list_events', 'task_user_settings', 'task_notification_deliveries',
] as const)

export function assertRequiredMainMigrationInventory(provider: readonly string[], ledger: readonly string[]) {
  assert.equal(new Set(provider).size, provider.length, 'APP_CONFIGURED_PROVIDER_NAMES_DUPLICATED')
  assert.equal(new Set(ledger).size, ledger.length, 'APP_CONFIGURED_LEDGER_NAMES_DUPLICATED')
  for (const name of requiredMainMigrationNames) {
    assert(provider.includes(name), 'APP_CONFIGURED_MAIN_MIGRATION_PROVIDER_REQUIRED')
    assert(ledger.includes(name), 'APP_CONFIGURED_MAIN_MIGRATION_LEDGER_REQUIRED')
  }
  assert.deepEqual([...ledger].sort(), [...provider].sort(), 'APP_CONFIGURED_NO_PENDING_MIGRATIONS_REQUIRED')
}

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

/** Observes the real migrated catalog; never repairs, creates or seeds it. The
 * description and pull code are passed from the original compiled migration. */
export async function verifyRequiredMainMigrationCatalog(query: Query, input: { pullCode: string; adminDescriptionAfter: string }) {
  assert.equal(input.pullCode, 'stock-prep:pull', 'APP_CONFIGURED_PULL_MIGRATION_CODE_INVALID')
  assert(typeof input.adminDescriptionAfter === 'string' && input.adminDescriptionAfter.length > 0,
    'APP_CONFIGURED_ADMIN_MIGRATION_DESCRIPTION_REQUIRED')
  for (const table of requiredMainCatalogTables) {
    const resolved = await query('SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', ['public.' + table])
    assert.equal(resolved.rows.length, 1, 'APP_CONFIGURED_MAIN_CATALOG_TABLE_REQUIRED')
    assert.equal(resolved.rows[0].schema, 'public', 'APP_CONFIGURED_MAIN_CATALOG_PUBLIC_REQUIRED')
  }
  const reminder = await query('SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', ['public', 'tasks', 'remind_at'])
  assert.deepEqual(reminder.rows, [{ data_type: 'timestamp with time zone', is_nullable: 'YES' }],
    'APP_CONFIGURED_MAIN_REMIND_AT_REQUIRED')
  const pull = await query('SELECT code FROM public.permissions WHERE code=$1', [input.pullCode])
  assert.deepEqual(pull.rows, [{ code: input.pullCode }], 'APP_CONFIGURED_MAIN_PULL_PERMISSION_REQUIRED')
  const admin = await query('SELECT description FROM public.permissions WHERE code=$1', ['stock-prep:admin'])
  assert.deepEqual(admin.rows, [{ description: input.adminDescriptionAfter }], 'APP_CONFIGURED_MAIN_ADMIN_DESCRIPTION_REQUIRED')
  const vocabulary = await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.integration_stock_prep_audit'::regclass AND conname='integration_stock_prep_audit_action_check'")
  assert.equal(vocabulary.rows.length, 1, 'APP_CONFIGURED_MAIN_AUDIT_CONSTRAINT_REQUIRED')
  const definition = vocabulary.rows[0].definition
  assert.equal(typeof definition, 'string', 'APP_CONFIGURED_MAIN_AUDIT_CONSTRAINT_REQUIRED')
  for (const action of ['project_target_create', 'project_target_archive', 'project_target_restore',
    'project_target_grant', 'project_fields_update', 'project_overview_refresh']) {
    assert((definition as string).includes("'" + action + "'"), 'APP_CONFIGURED_MAIN_AUDIT_ACTION_REQUIRED')
  }
}

interface ProjectSheetsOffRequest {
  url(): string
  method(): string
  postData(): string | null
  headers(): Record<string, string>
}

/** The aligned main UI really probes these two OFF routes. Preserve those
 * original requests and refusals; do not stub a response or admit arbitrary 404s. */
export function createProjectSheetsOffWindow(input: { origin: string; tenantId: string; token(): string;
  phase(): string; projectNo(): string; allowedPhases: readonly string[] }) {
  const base = '/api/integration/stock-preparation'
  const records = new Map<ProjectSheetsOffRequest, { url: string; phase: string; response: boolean; console: boolean }>()
  const counts = { requests: 0, responses: 0, consoleErrors: 0, targetRequests: 0, listRequests: 0 }
  const isCandidate = (request: ProjectSheetsOffRequest) => {
    const pathname = new URL(request.url()).pathname
    return pathname === base + '/project-targets' || /^\/api\/integration\/stock-preparation\/projects\/[^/]+\/target$/u.test(pathname)
  }
  const accept = (request: ProjectSheetsOffRequest) => {
    const url = new URL(request.url()), phase = input.phase()
    assert(input.allowedPhases.includes(phase), 'APP_BROWSER_PROJECT_SHEETS_OFF_PHASE_DENIED')
    assert(url.origin === input.origin && !url.username && !url.password && !url.hash, 'APP_BROWSER_PROJECT_SHEETS_OFF_ORIGIN_DENIED')
    assert(request.method() === 'GET' && request.postData() === null, 'APP_BROWSER_PROJECT_SHEETS_OFF_READ_ONLY')
    assert(input.token() && request.headers().authorization === 'Bearer ' + input.token(), 'APP_BROWSER_PROJECT_SHEETS_OFF_SESSION_REQUIRED')
    assert(url.search === '?' + new URLSearchParams({ tenantId: input.tenantId }), 'APP_BROWSER_PROJECT_SHEETS_OFF_SCOPE_DENIED')
    assert(url.pathname === base + '/project-targets' || url.pathname === base + '/projects/' + input.projectNo() + '/target',
      'APP_BROWSER_PROJECT_SHEETS_OFF_PROJECT_DENIED')
    assert(!records.has(request), 'APP_BROWSER_PROJECT_SHEETS_OFF_DUPLICATE_REQUEST')
    records.set(request, { url: request.url(), phase, response: false, console: false })
    counts.requests += 1
    if (url.pathname === base + '/project-targets') counts.listRequests += 1; else counts.targetRequests += 1
  }
  const response = (request: ProjectSheetsOffRequest, status: number, payload: unknown) => {
    const record = records.get(request)
    assert(record && !record.response && record.url === request.url(), 'APP_BROWSER_PROJECT_SHEETS_OFF_RESPONSE_UNCORRELATED')
    assert.equal(status, 404, 'APP_BROWSER_PROJECT_SHEETS_OFF_STATUS_REQUIRED')
    assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'APP_BROWSER_PROJECT_SHEETS_OFF_ENVELOPE_REQUIRED')
    const envelope = payload as { ok?: unknown; error?: { code?: unknown } }
    assert(envelope.ok === false && envelope.error?.code === 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED',
      'APP_BROWSER_PROJECT_SHEETS_OFF_CODE_REQUIRED')
    record.response = true; counts.responses += 1
  }
  const consoleRefusal = (url: string, text: string) => {
    const matching = [...records.values()].filter(record => record.url === url)
    if (!matching.length) return false
    assert.equal(text, 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      'APP_BROWSER_PROJECT_SHEETS_OFF_CONSOLE_INVALID')
    const record = matching.find(value => !value.console)
    assert(record, 'APP_BROWSER_PROJECT_SHEETS_OFF_DUPLICATE_CONSOLE')
    // Chromium can deliver its console event before response.json() completes.
    // The final equality below still requires the original validated 404 body.
    record.console = true; counts.consoleErrors += 1
    return true
  }
  const verify = () => {
    assert(counts.targetRequests > 0 && counts.listRequests > 0, 'APP_BROWSER_PROJECT_SHEETS_OFF_REAL_UI_PROBES_REQUIRED')
    assert.equal(counts.responses, counts.requests, 'APP_BROWSER_PROJECT_SHEETS_OFF_RESPONSES_REQUIRED')
    assert.equal(counts.consoleErrors, counts.requests, 'APP_BROWSER_PROJECT_SHEETS_OFF_CONSOLES_REQUIRED')
  }
  return { isCandidate, accept, response, consoleRefusal, verify, counts }
}
