import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
// This existing CI lane must exercise the native-isolation contract as well.
import './stock-preparation-browser-network-isolation.test.mjs'
import './stock-preparation-plm-namespace-contract.test.mjs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual, types } from 'node:util'
import { EventEmitter, errorMonitor } from 'node:events'
import * as yidaStatic from '../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'
import { cleanEnvironment, parseArguments, validateProductionStopEvidence, validateK3Evidence, validateYidaEvidence, validateAutomationEvidence,
  createOwnedProcessCapture, createFullAppStageRunner, publicBrowserFailure, verifyStageLogs, recoverUnobservedProcessLogs,
  validateYidaOwnerOffEvidence, verifyYidaOwnerOffRawLogs, validateYidaInitializationEvidence,
  validateBrowserProcessEvidence, initializationFailurePhases, validateYidaInitializationFailureMarker } from './run-stock-preparation-plm-full-app.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = relative => readFileSync(path.join(repoRoot, relative), 'utf8')
const workflow = parseYamlDocument(read('.github/workflows/plugin-tests.yml'))
const acceptanceId = 'stock-preparation-plm-full-app'
const contractsId = 'stock-preparation-plm-full-app-contracts'
// YiDa and PLM share the actual Chromium installation step after stack alignment.
const browserId = 'stock-preparation-yida-owner-browser-install'
const dependencyInstallId = 'workspace-dependency-install'
const node20 = "matrix.node-version == '20.x'"
const acceptanceCommand = 'node scripts/ops/run-stock-preparation-plm-full-app.mjs --pg-bin=/usr/lib/postgresql/14/bin'
const intervalAcceptanceCommand = acceptanceCommand + ' --automation-scenario=interval'
const acceptanceCommands = acceptanceCommand + '\n' + intervalAcceptanceCommand
const contractsCommand = 'node --test scripts/ops/stock-preparation-plm-full-app-contract.test.mjs scripts/ops/stock-preparation-plm-owned-pg.test.mjs scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs'
const dependencyInstallCommand = 'set -o pipefail\npnpm install --frozen-lockfile 2>&1 | tee install.log'
const backendTypeCheckCommand = 'tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json'
  + ' && tsc -p scripts/tsconfig.stock-preparation-plm-full-app.json && tsc -p scripts/tsconfig.stock-preparation-yida-synthetic-trial.json'
const pgBin = path.join(path.parse(repoRoot).root, 'synthetic-postgresql', 'bin')

const mainContractPath = 'packages/core-backend/tests/utils/stock-preparation-main-migration-contract.ts'
function loadMainMigrationContract(source = read(mainContractPath)) {
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  Function('require', 'module', 'exports', compiled)(requireCore, module, module.exports)
  return module.exports
}
function removeMainContractGuard(exact) {
  const source = read(mainContractPath)
  assert.equal(source.split(exact).length - 1, 1)
  return loadMainMigrationContract(source.replace(exact, ''))
}
function mainCatalogInput() {
  const source = read('packages/core-backend/src/db/migrations/zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets.ts')
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript'), module = { exports: {} }
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  Function('require', 'module', 'exports', compiled)(requireCore, module, module.exports)
  return { pullCode: 'stock-prep:pull', adminDescriptionAfter: module.exports.STOCK_PREP_ADMIN_DESCRIPTION_AFTER }
}
function mainCatalogQuery(module, override = {}) {
  const input = mainCatalogInput(), calls = []
  const query = async (sql, values) => {
    calls.push({ sql, values })
    if (sql === 'SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)') {
      assert(module.requiredMainCatalogTables.some(table => values[0] === 'public.' + table))
      return { rows: values[0] === override.table ? override.rows : [{ schema: 'public' }] }
    }
    if (sql === 'SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3') {
      assert.deepEqual(values, ['public', 'tasks', 'remind_at'])
      return { rows: override.reminder ?? [{ data_type: 'timestamp with time zone', is_nullable: 'YES' }] }
    }
    if (sql === 'SELECT code FROM public.permissions WHERE code=$1') {
      assert.deepEqual(values, ['stock-prep:pull']); return { rows: override.pull ?? [{ code: 'stock-prep:pull' }] }
    }
    if (sql === 'SELECT description FROM public.permissions WHERE code=$1') {
      assert.deepEqual(values, ['stock-prep:admin']); return { rows: override.admin ?? [{ description: input.adminDescriptionAfter }] }
    }
    assert.equal(sql, "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.integration_stock_prep_audit'::regclass AND conname='integration_stock_prep_audit_action_check'")
    const actions = ['project_target_create', 'project_target_archive', 'project_target_restore',
      'project_target_grant', 'project_fields_update', 'project_overview_refresh']
    return { rows: override.audit ?? [{ definition: actions.map(value => "'" + value + "'").join(',') }] }
  }
  return { query, calls, input }
}

test('aligned full provider and ledger require all five actual main basenames even if both shrink together', () => {
  const module = loadMainMigrationContract(), names = [...module.requiredMainMigrationNames, '089_create_integration_stock_prep_read_plan_versions', '090_create_integration_yida_delivery_ledger']
  module.assertRequiredMainMigrationInventory(names, [...names].reverse())
  for (const name of module.requiredMainMigrationNames) {
    const missing = names.filter(value => value !== name)
    assert.throws(() => module.assertRequiredMainMigrationInventory(missing, missing))
    assert.throws(() => module.assertRequiredMainMigrationInventory(names, missing))
    assert.throws(() => module.assertRequiredMainMigrationInventory(missing, names))
  }
  assert.throws(() => module.assertRequiredMainMigrationInventory([...names, names[0]], [...names, names[0]]))
  const mutant = removeMainContractGuard("  for (const name of requiredMainMigrationNames) {\n    assert(provider.includes(name), 'APP_CONFIGURED_MAIN_MIGRATION_PROVIDER_REQUIRED')\n    assert(ledger.includes(name), 'APP_CONFIGURED_MAIN_MIGRATION_LEDGER_REQUIRED')\n  }")
  for (const name of module.requiredMainMigrationNames) {
    const missing = names.filter(value => value !== name)
    assert.throws(() => assert.throws(() => mutant.assertRequiredMainMigrationInventory(missing, missing)), { code: 'ERR_ASSERTION' })
  }
  for (const relative of ['packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts',
    'packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts']) {
    const worker = read(relative)
    assert.match(worker, /assertRequiredMainMigrationInventory\((?:migrationNames, appliedNames|names, ledger)\)/u)
    assert.match(worker, /createCoreBackendMigrationProvider\(\)\.getMigrations\(\)/u)
    assert.match(worker, /SELECT name FROM kysely_migration/u)
  }
})

test('actual shared catalog verifier queries main tables, reminder and actual migration AFTER without repair', async () => {
  const module = loadMainMigrationContract(), positive = mainCatalogQuery(module)
  await module.verifyRequiredMainMigrationCatalog(positive.query, positive.input)
  assert.equal(positive.calls.length, module.requiredMainCatalogTables.length + 4)
  assert(positive.calls.every(call => call.sql.startsWith('SELECT ')))
  assert.equal(module.requiredMainCatalogTables.length, 9)
  for (const table of module.requiredMainCatalogTables) {
    for (const rows of [[], [{ schema: 'foreign' }], [{ schema: 'public' }, { schema: 'public' }]]) {
      const bad = mainCatalogQuery(module, { table: 'public.' + table, rows })
      await assert.rejects(module.verifyRequiredMainMigrationCatalog(bad.query, bad.input))
    }
  }
  for (const override of [{ reminder: [] }, { reminder: [{ data_type: 'text', is_nullable: 'YES' }] },
    { pull: [] }, { admin: [] }, { admin: [{ description: 'synthetic-stale-description' }] }, { audit: [] },
    { audit: [{ definition: "'project_target_create'" }] }]) {
    const bad = mainCatalogQuery(module, override)
    await assert.rejects(module.verifyRequiredMainMigrationCatalog(bad.query, bad.input))
  }
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-fixture.ts')
  assert.match(fixture, /await verifyRequiredMainMigrationCatalog\(query,/u)
  assert.match(fixture, /adminDescriptionAfter: STOCK_PREP_ADMIN_DESCRIPTION_AFTER/u)
  assert.match(fixture, /db\/migrations\/zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets\.ts/u)
})

test('independent finite removals from the actual main catalog verifier make its matching negatives red', async () => {
  const cases = [
    ["assert.equal(resolved.rows.length, 1, 'APP_CONFIGURED_MAIN_CATALOG_TABLE_REQUIRED')", { table: 'public.task_lists', rows: [{ schema: 'public' }, { schema: 'public' }] }],
    ["assert.equal(resolved.rows[0].schema, 'public', 'APP_CONFIGURED_MAIN_CATALOG_PUBLIC_REQUIRED')", { table: 'public.task_lists', rows: [{ schema: 'foreign' }] }],
    ["assert.deepEqual(reminder.rows, [{ data_type: 'timestamp with time zone', is_nullable: 'YES' }],\n    'APP_CONFIGURED_MAIN_REMIND_AT_REQUIRED')", { reminder: [] }],
    ["assert.deepEqual(pull.rows, [{ code: input.pullCode }], 'APP_CONFIGURED_MAIN_PULL_PERMISSION_REQUIRED')", { pull: [] }],
    ["assert.deepEqual(admin.rows, [{ description: input.adminDescriptionAfter }], 'APP_CONFIGURED_MAIN_ADMIN_DESCRIPTION_REQUIRED')", { admin: [{ description: 'synthetic-stale-description' }] }],
    ["assert((definition as string).includes(\"'\" + action + \"'\"), 'APP_CONFIGURED_MAIN_AUDIT_ACTION_REQUIRED')", { audit: [{ definition: "'project_target_create'" }] }],
  ]
  for (const [guard, override] of cases) {
    const original = loadMainMigrationContract(), bad = mainCatalogQuery(original, override)
    await assert.rejects(original.verifyRequiredMainMigrationCatalog(bad.query, bad.input))
    const mutant = removeMainContractGuard(guard), changed = mainCatalogQuery(mutant, override)
    await assert.rejects(async () => { await assert.rejects(mutant.verifyRequiredMainMigrationCatalog(changed.query, changed.input)) }, { code: 'ERR_ASSERTION' })
  }
})

function mainOffWindow(module, options = {}) {
  const input = { origin: 'http://127.0.0.1:43210', tenantId: 'synthetic-tenant', token: () => 'synthetic-token',
    phase: () => 'BOARD', projectNo: () => 'SYN-YIDA-PREVIEW', allowedPhases: ['BOARD'], ...options }
  const request = (options = {}) => ({ url: () => options.url ?? input.origin + '/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/target?tenantId=synthetic-tenant',
    method: () => options.method ?? 'GET', postData: () => options.body === undefined ? null : options.body,
    headers: () => options.headers ?? { authorization: 'Bearer synthetic-token' } })
  return { window: module.createProjectSheetsOffWindow(input), input, request }
}
const mainOffPayload = { ok: false, error: { code: 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED' } }
const mainOffConsole = 'Failed to load resource: the server responded with a status of 404 (Not Found)'

test('actual OFF window admits only scoped two GETs and validates original request-correlated refusals and console', () => {
  const module = loadMainMigrationContract(), fixture = mainOffWindow(module), target = fixture.request()
  const list = fixture.request({ url: fixture.input.origin + '/api/integration/stock-preparation/project-targets?tenantId=synthetic-tenant' })
  for (const request of [target, list]) {
    assert(fixture.window.isCandidate(request)); fixture.window.accept(request)
    // Real Chromium can signal its native console before JSON body completion.
    assert(fixture.window.consoleRefusal(request.url(), mainOffConsole))
    fixture.window.response(request, 404, mainOffPayload)
  }
  fixture.window.verify(); assert.deepEqual(fixture.window.counts, { requests: 2, responses: 2, consoleErrors: 2, targetRequests: 1, listRequests: 1 })
  assert.equal(fixture.window.consoleRefusal(fixture.input.origin + '/api/foreign', mainOffConsole), false)
  assert.equal(fixture.window.isCandidate(fixture.request({ url: fixture.input.origin + '/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/board' })), false)
  for (const options of [{ method: 'POST' }, { body: '' }, { headers: { authorization: 'Bearer foreign' } },
    { url: 'http://foreign.invalid/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/target?tenantId=synthetic-tenant' },
    { url: fixture.input.origin + '/api/integration/stock-preparation/projects/FOREIGN/target?tenantId=synthetic-tenant' },
    { url: target.url() + '&workspaceId=synthetic-tenant' }, { url: target.url().replace('synthetic-tenant', 'foreign') },
    { url: target.url() + '#foreign' }]) {
    assert.throws(() => mainOffWindow(module).window.accept(fixture.request(options)))
  }
  assert.throws(() => mainOffWindow(module, { phase: () => 'SEND' }).window.accept(target))
  assert.throws(() => fixture.window.accept(target))
  assert.throws(() => fixture.window.response(fixture.request(), 404, mainOffPayload))
  assert.throws(() => fixture.window.response(target, 404, mainOffPayload))
  assert.throws(() => fixture.window.consoleRefusal(target.url(), mainOffConsole))
  for (const [status, payload] of [[200, mainOffPayload], [404, null], [404, { ok: true, error: mainOffPayload.error }],
    [404, { ok: false, error: { code: 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND' } }]]) {
    const bad = mainOffWindow(module), request = bad.request(); bad.window.accept(request)
    assert.throws(() => bad.window.response(request, status, payload))
  }
  const badConsole = mainOffWindow(module), request = badConsole.request(); badConsole.window.accept(request)
  assert.throws(() => badConsole.window.consoleRefusal(request.url(), mainOffConsole + ' synthetic-other'))
  assert.throws(() => badConsole.window.verify())
})

test('finite removals of actual OFF request/response/console guards make independent negatives red', () => {
  const cases = [
    ["assert(input.allowedPhases.includes(phase), 'APP_BROWSER_PROJECT_SHEETS_OFF_PHASE_DENIED')", { phase: () => 'SEND' }, {}, 'accept'],
    ["assert(url.origin === input.origin && !url.username && !url.password && !url.hash, 'APP_BROWSER_PROJECT_SHEETS_OFF_ORIGIN_DENIED')", {}, { url: 'http://foreign.invalid/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/target?tenantId=synthetic-tenant' }, 'accept'],
    ["assert(request.method() === 'GET' && request.postData() === null, 'APP_BROWSER_PROJECT_SHEETS_OFF_READ_ONLY')", {}, { method: 'POST' }, 'accept'],
    ["assert(input.token() && request.headers().authorization === 'Bearer ' + input.token(), 'APP_BROWSER_PROJECT_SHEETS_OFF_SESSION_REQUIRED')", {}, { headers: {} }, 'accept'],
    ["assert(url.search === '?' + new URLSearchParams({ tenantId: input.tenantId }), 'APP_BROWSER_PROJECT_SHEETS_OFF_SCOPE_DENIED')", {}, { url: 'http://127.0.0.1:43210/api/integration/stock-preparation/projects/SYN-YIDA-PREVIEW/target?tenantId=foreign' }, 'accept'],
    ["assert(url.pathname === base + '/project-targets' || url.pathname === base + '/projects/' + input.projectNo() + '/target',\n      'APP_BROWSER_PROJECT_SHEETS_OFF_PROJECT_DENIED')", {}, { url: 'http://127.0.0.1:43210/api/integration/stock-preparation/projects/FOREIGN/target?tenantId=synthetic-tenant' }, 'accept'],
    ["assert.equal(status, 404, 'APP_BROWSER_PROJECT_SHEETS_OFF_STATUS_REQUIRED')", {}, {}, 'status'],
    ["assert(envelope.ok === false && envelope.error?.code === 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED',\n      'APP_BROWSER_PROJECT_SHEETS_OFF_CODE_REQUIRED')", {}, {}, 'code'],
    ["assert.equal(text, 'Failed to load resource: the server responded with a status of 404 (Not Found)',\n      'APP_BROWSER_PROJECT_SHEETS_OFF_CONSOLE_INVALID')", {}, {}, 'console'],
  ]
  for (const [guard, input, options, operation] of cases) {
    const attempt = module => {
      const fixture = mainOffWindow(module, input), request = fixture.request(options)
      if (operation === 'accept') return fixture.window.accept(request)
      fixture.window.accept(request)
      if (operation === 'console') return fixture.window.consoleRefusal(request.url(), 'synthetic-other')
      return fixture.window.response(request, operation === 'status' ? 200 : 404,
        operation === 'code' ? { ok: false, error: { code: 'SYNTHETIC_FOREIGN' } } : mainOffPayload)
    }
    assert.throws(() => attempt(loadMainMigrationContract()))
    const mutant = removeMainContractGuard(guard)
    assert.throws(() => assert.throws(() => attempt(mutant)), { code: 'ERR_ASSERTION' })
  }
  for (const relative of ['packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts',
    'packages/core-backend/tests/utils/stock-preparation-yida-initialization-full-app.ts']) {
    const browser = read(relative)
    for (const call of ['projectSheetsOff.accept(request)', 'projectSheetsOff.response(response.request(), response.status(), await response.json())',
      'projectSheetsOff.consoleRefusal(', 'projectSheetsOff.verify()', 'membersOff.accept(request)',
      'membersOff.response(response.request(), response.status(), await response.json())',
      'membersOff.consoleRefusal(', 'membersOff.verify()']) assert(browser.includes(call))
    assert(browser.includes('await route.continue()'))
    assert(!/route\.fulfill\(/u.test(browser))
  }
})

test('actual OFF final equality rejects missing real probes, bodies or console; finite removals are red', () => {
  const cases = [
    ["assert(counts.targetRequests > 0 && counts.listRequests > 0, 'APP_BROWSER_PROJECT_SHEETS_OFF_REAL_UI_PROBES_REQUIRED')", 'empty'],
    ["assert.equal(counts.responses, counts.requests, 'APP_BROWSER_PROJECT_SHEETS_OFF_RESPONSES_REQUIRED')", 'no-body'],
    ["assert.equal(counts.consoleErrors, counts.requests, 'APP_BROWSER_PROJECT_SHEETS_OFF_CONSOLES_REQUIRED')", 'no-console'],
  ]
  for (const [guard, kind] of cases) {
    const attempt = module => {
      const fixture = mainOffWindow(module)
      if (kind !== 'empty') for (const request of [fixture.request(), fixture.request({
        url: fixture.input.origin + '/api/integration/stock-preparation/project-targets?tenantId=synthetic-tenant' })]) {
        fixture.window.accept(request)
        if (kind !== 'no-body') fixture.window.response(request, 404, mainOffPayload)
        if (kind !== 'no-console') fixture.window.consoleRefusal(request.url(), mainOffConsole)
      }
      fixture.window.verify()
    }
    assert.throws(() => attempt(loadMainMigrationContract()))
    assert.throws(() => assert.throws(() => attempt(removeMainContractGuard(guard))), { code: 'ERR_ASSERTION' })
  }
})

function initializationRecords() {
  return [
    { stage: 'yida-owner-log-http-verified' },
    { stage: 'yida-initialization-ready', managedBootstrap: true, bootstrapCommitted: true, defaultOff: true,
      separateFromOriginalOffWindow: true, anchorRows: 1, initializationRows: 0 },
    { stage: 'yida-initialization-browser-network', forbiddenConnections: 0, forbiddenEnvReads: 0, allowedConnections: 1 },
    { stage: 'yida-initialization-browser-and-authority-verified', evidence: {
      realPasswordLogin: true, freshBrowserContext: true, productionBundle: true, servedBundleBytesVerified: true,
      realProjectBoardNavigation: true, actualInitializationPanel: true, openingNoInitializationRequests: true,
      explicitEmptySlotGet: true, realSdkPost201: true, manualGetSameDraft: true, reloadSamePrincipalAndDraft: true,
      privateControlsCleared: true, defaultOff: true, tokenIssued: false, externalWriteAttempted: false },
    counts: { loginSubmissions: 1, loginResponses: 1, initializationGets: 3, initializationPosts: 1,
      initializationResponses: 4, reloads: 1, boardResponses: 2, bundleDocuments: 2,
      externalRequests: 0, forbiddenRequests: 0, responseStubs: 0, storageInjections: 0 },
    authority: { managedAnchorCommitted: true, actualDurableChainMatched: true, singleInitialization: true,
      credentialMaterials: 1, draftOperations: 1, draftRows: 2, approvedTargets: 1, sendRows: 0,
      originalBusinessSnapshotUnchanged: true } },
    { stage: 'actual-stop-resolved' }, { stage: 'production-stop-verified' },
  ]
}

test('initialization acceptance requires independent OFF-after-proof full-app and exact durable receipt', () => {
  validateYidaInitializationEvidence(initializationRecords())
  const rejects = value => assert.throws(() => validateYidaInitializationEvidence(value))
  rejects(null); rejects([null]); rejects(initializationRecords().map(({ stage }) => ({ stage })))
  for (const ordinal of [0, 1, 2, 3, 4, 5]) {
    const absent = initializationRecords(); absent.splice(ordinal, 1); rejects(absent)
    const duplicate = initializationRecords(); duplicate.splice(ordinal, 0, duplicate[ordinal]); rejects(duplicate)
    const reordered = initializationRecords(); [reordered[ordinal], reordered[(ordinal + 1) % 6]] = [reordered[(ordinal + 1) % 6], reordered[ordinal]]; rejects(reordered)
  }
  for (const ordinal of [1, 2, 3]) {
    const unknown = initializationRecords(); unknown[ordinal].foreign = 'SYNTHETIC_PRIVATE_VALUE'; rejects(unknown)
  }
  for (const ordinal of [1, 2]) for (const key of Object.keys(initializationRecords()[ordinal]).filter(key => key !== 'stage')) {
    const bad = initializationRecords(); bad[ordinal][key] = typeof bad[ordinal][key] === 'boolean' ? !bad[ordinal][key] : -1; rejects(bad)
  }
  for (const group of ['evidence', 'authority', 'counts']) {
    for (const key of Object.keys(initializationRecords()[3][group])) {
      const bad = initializationRecords(); bad[3][group][key] = typeof bad[3][group][key] === 'boolean' ? !bad[3][group][key] : -1; rejects(bad)
    }
    const unknown = initializationRecords(); unknown[3][group].foreign = 'SYNTHETIC_PRIVATE_VALUE'; rejects(unknown)
  }
  rejects([...initializationRecords(), { stage: 'yida-initialization-browser-failed' }])
})

function browserProcessRecords() {
  return [0, 1].map(ordinal => ({ stage: 'owned-process-diagnostics', kind: 'isolated-browser', diagnostics: {
    name: 'isolated-browser', ordinal, code: 0, signal: null, timedOut: false, complete: true,
    outputLimitExceeded: false, malformedMarker: false, spawnFailed: false, terminationReason: 'exit' } }))
}
test('two browser raw-log receipts require distinct fixed ordinals and both real successful closes', () => {
  assert.equal(validateBrowserProcessEvidence(browserProcessRecords()).length, 2)
  for (const ordinal of [0, 1]) {
    const absent = browserProcessRecords(); absent.splice(ordinal, 1); assert.throws(() => validateBrowserProcessEvidence(absent))
    for (const key of Object.keys(browserProcessRecords()[ordinal].diagnostics)) {
      const bad = browserProcessRecords(); bad[ordinal].diagnostics[key] = 'foreign'; assert.throws(() => validateBrowserProcessEvidence(bad))
    }
    const kind = browserProcessRecords(); kind[ordinal].kind = 'foreign'; assert.throws(() => validateBrowserProcessEvidence(kind))
  }
  const reversed = browserProcessRecords().reverse(); assert.throws(() => validateBrowserProcessEvidence(reversed))
  const duplicate = browserProcessRecords(); duplicate[1] = duplicate[0]; assert.throws(() => validateBrowserProcessEvidence(duplicate))
})

const initializationSource = 'packages/core-backend/tests/utils/stock-preparation-yida-initialization-full-app.ts'
function loadInitializationContract(source = read(initializationSource)) {
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript')
  // Execute only the actual pure capability boundary; the browser entry's
  // import.meta/native launch is deliberately outside these offline contracts.
  const pureSource = source.slice(0, source.indexOf('/** A fresh process/context'))
  assert(pureSource.length > 0)
  const compiled = ts.transpileModule(pureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const localRequire = name => name === './stock-preparation-yida-owner-off-full-app'
    ? { ownerOffDraftBody() {
      const example = yidaStatic.createYidaProtocolExample('primary')
      return { config: yidaStatic.validateYidaStaticConfig(example.config).normalized, rowsText: example.text, allocation: { mode: 'original' } }
    } } : requireCore(name)
  Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports)
  return module.exports
}
const initCommand = 'a0000000-0000-4000-8000-000000000001'
function initializationRequest(module, options = {}) {
  const body = options.body ?? module.initializationBody(initCommand)
  return { url: () => options.url ?? 'http://127.0.0.1:8123' + module.initializationEndpoint,
    method: () => options.method ?? 'POST', headers: () => options.headers ?? { authorization: 'Bearer synthetic.jwt.only', 'content-type': 'application/json' },
    postDataJSON: () => body, postData: () => options.method === 'GET' ? null : JSON.stringify(body) }
}
function readyInitializationWindow(module) {
  const window = module.createInitializationRequestWindow('http://127.0.0.1:8123', () => 'synthetic.jwt.only', initCommand)
  window.arm('GET'); window.accept(initializationRequest(module, { method: 'GET' })); return window
}
test('initialization fixed write capability consumes a ready GET and admits only actual SDK body without principal headers', () => {
  const module = loadInitializationContract(), window = readyInitializationWindow(module)
  window.arm('POST'); window.accept(initializationRequest(module));
  for (let count = 0; count < 2; count += 1) { window.arm('GET'); window.accept(initializationRequest(module, { method: 'GET' })) }
  window.verify(); assert.deepEqual(window.counts, { gets: 3, posts: 1 })
  assert.throws(() => window.arm('POST'))
  const unready = module.createInitializationRequestWindow('http://127.0.0.1:8123', () => 'synthetic.jwt.only', initCommand)
  assert.throws(() => unready.arm('POST')); assert.throws(() => unready.accept(initializationRequest(module)))
  const rejected = [
    { url: 'http://127.0.0.1:8124' + module.initializationEndpoint },
    { url: 'http://127.0.0.1:8123' + module.initializationEndpoint + '?tenantId=foreign' },
    { url: 'http://127.0.0.1:8123/api/integration/yida-owner-send/drafts' }, { method: 'PUT' },
    { headers: { authorization: 'Bearer foreign', 'content-type': 'application/json' } },
    { headers: { authorization: 'Bearer synthetic.jwt.only', 'content-type': 'text/plain' } },
    ...['x-tenant-id', 'x-workspace-id'].map(key => ({ headers: { authorization: 'Bearer synthetic.jwt.only', 'content-type': 'application/json', [key]: 'foreign' } })),
    { body: { ...module.initializationBody(initCommand), ownerId: 'foreign' } },
    { body: { ...module.initializationBody(initCommand), commandId: 'foreign' } },
  ]
  for (const options of rejected) { const current = readyInitializationWindow(module); current.arm('POST'); assert.throws(() => current.accept(initializationRequest(module, options))) }
  assert.throws(() => readyInitializationWindow(module).verify())
})

test('actual App plugin catalog bare GET is exact and never admits initialization or other session reads', () => {
  const module = loadInitializationContract()
  const request = options => ({ url: () => options.url ?? 'http://127.0.0.1:8123/api/plugins',
    method: () => options.method ?? 'GET', headers: () => options.headers ?? {}, postData: () => options.body ?? null })
  module.assertFixedPublicPluginRequest('http://127.0.0.1:8123', request({}))
  for (const options of [{ url: 'http://127.0.0.1:8124/api/plugins' }, { url: 'http://127.0.0.1:8123/api/plugins?tenantId=foreign' },
    { url: 'http://127.0.0.1:8123/api/plugins#foreign' }, { method: 'POST' }, { body: '{}' },
    { url: 'http://127.0.0.1:8123/api/auth/me' }, { url: 'http://127.0.0.1:8123' + module.initializationEndpoint },
    ...['authorization', 'x-tenant-id', 'x-workspace-id'].map(key => ({ headers: { [key]: 'foreign' } }))]) {
    assert.throws(() => module.assertFixedPublicPluginRequest('http://127.0.0.1:8123', request(options)))
  }
  const window = readyInitializationWindow(module); window.arm('POST')
  assert.throws(() => window.accept(initializationRequest(module, { headers: { 'content-type': 'application/json' } })))
  const source = read(initializationSource)
  const guard = "assert(target.origin === origin && target.pathname === '/api/plugins' && !target.search && !target.hash\n    && !target.username && !target.password && request.method() === 'GET' && request.postData() === null\n    && !('authorization' in headers) && !('x-tenant-id' in headers) && !('x-workspace-id' in headers),\n  'APP_BROWSER_YIDA_INIT_PUBLIC_PLUGIN_REQUEST_INVALID')"
  assert(source.includes(guard))
  const mutant = loadInitializationContract(source.replace(guard, 'void 0'))
  const foreign = request({ url: 'http://127.0.0.1:8123' + module.initializationEndpoint })
  assert.throws(() => module.assertFixedPublicPluginRequest('http://127.0.0.1:8123', foreign))
  assert.throws(() => assert.throws(() => mutant.assertFixedPublicPluginRequest('http://127.0.0.1:8123', foreign)), assert.AssertionError)
  console.log('YIDA_INIT_MUTATION fixed-public-plugin-GET: original rejects; removed guard rejection contract RED')
})

test('real production authHeaders plugin catalog contract is accepted only for the checked login token and tenant', () => {
  const module = loadInitializationContract()
  const token = 'synthetic.jwt.only', tenant = 'synthetic-catalog-tenant'
  // Execute the actual production header producer. Only its local session readers
  // receive a synthetic context; no response, token storage or browser is injected.
  const apiSource = read('apps/web/src/utils/api.ts')
  const headerSource = apiSource.slice(apiSource.indexOf('export function authHeaders('), apiSource.indexOf('\nfunction isAuthRoute('))
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript')
  const compiled = ts.transpileModule(headerSource.replace('export function', 'function'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const actualHeaders = Function('getStoredAuthToken', 'explicitSessionOrg', 'getStoredTenantHint', 'getLocationTenantHint',
    'extractTenantHintFromPayload', 'decodeJwtPayload', compiled + '\nreturn authHeaders')(
    () => token, () => '', () => tenant, () => '', () => '', () => null)
  const headers = Object.fromEntries(Object.entries(actualHeaders()).map(([key, value]) => [key.toLowerCase(), value]))
  assert.deepEqual(headers, { authorization: 'Bearer ' + token, 'x-tenant-id': tenant })
  assert.equal('x-workspace-id' in headers, false)
  assert.match(read('apps/web/src/views/LoginView.vue'), /await loadProductFeatures\(true, \{ skipSessionProbe: true \}\)/u)
  assert.match(read('apps/web/src/stores/featureFlags.ts'), /apiFetch\('\/api\/plugins'\)/u)
  const request = options => ({ url: () => options.url ?? 'http://127.0.0.1:8123/api/plugins',
    method: () => options.method ?? 'GET', headers: () => options.headers ?? headers, postData: () => options.body ?? null })
  const accepts = options => module.assertFixedAuthenticatedPluginRequest('http://127.0.0.1:8123', token, tenant, request(options))
  accepts({})
  for (const options of [
    { headers: { ...headers, authorization: 'Bearer foreign' } }, { headers: { ...headers, 'x-tenant-id': 'foreign' } },
    { headers: { authorization: headers.authorization } }, { headers: { ...headers, 'x-workspace-id': tenant } },
    { url: 'http://127.0.0.1:8124/api/plugins' }, { url: 'http://127.0.0.1:8123/api/plugins?tenantId=foreign' },
    { url: 'http://127.0.0.1:8123' + module.initializationEndpoint }, { method: 'POST' }, { body: '{}' },
  ]) assert.throws(() => accepts(options))
  assert.throws(() => module.assertFixedAuthenticatedPluginRequest('http://127.0.0.1:8123', '', tenant, request({})))
  assert.throws(() => module.assertFixedAuthenticatedPluginRequest('http://127.0.0.1:8123', token, '', request({})))
  const window = readyInitializationWindow(module); window.arm('POST')
  assert.throws(() => window.accept(initializationRequest(module, { headers: { ...headers, 'content-type': 'application/json' } })))
  const source = read(initializationSource)
  const guard = "assert(target.origin === origin && target.pathname === '/api/plugins' && !target.search && !target.hash\n    && !target.username && !target.password && request.method() === 'GET' && request.postData() === null\n    && expectedToken && expectedTenant && headers.authorization === 'Bearer ' + expectedToken\n    && headers['x-tenant-id'] === expectedTenant && !('x-workspace-id' in headers),\n  'APP_BROWSER_YIDA_INIT_AUTHENTICATED_PLUGIN_REQUEST_INVALID')"
  assert(source.includes(guard))
  const mutant = loadInitializationContract(source.replace(guard, 'void 0'))
  const foreign = request({ headers: { ...headers, 'x-tenant-id': 'foreign' } })
  assert.throws(() => module.assertFixedAuthenticatedPluginRequest('http://127.0.0.1:8123', token, tenant, foreign))
  assert.throws(() => assert.throws(() => mutant.assertFixedAuthenticatedPluginRequest('http://127.0.0.1:8123', token, tenant, foreign)), assert.AssertionError)
  console.log('YIDA_INIT_MUTATION actual-authenticated-plugin-GET: actual production headers pass; removed guard rejection contract RED')
})

test('closed initialization phase diagnostics never read foreign errors or getters and reject foreign markers', () => {
  const module = loadInitializationContract()
  assert.deepEqual(module.initializationBrowserPhases, initializationFailurePhases)
  const scope = module.createInitializationBrowserFailureScope()
  for (const phase of initializationFailurePhases) {
    scope.enter(phase)
    const marker = module.initializationBrowserFailure(scope.failure())
    assert.deepEqual(marker, { stage: 'yida-initialization-browser-failed', diagnostic: 'APP_BROWSER_YIDA_INIT_FAILED', phase })
    assert.deepEqual(validateYidaInitializationFailureMarker(marker), { diagnostic: 'APP_BROWSER_YIDA_INIT_FAILED', phase })
  }
  scope.enter('FOREIGN_PRIVATE_PHASE')
  assert.equal(module.initializationBrowserFailure(scope.failure()).phase, 'OTHER')
  let foreignReads = 0
  const foreign = Object.defineProperties({}, Object.fromEntries(['message', 'stack', 'phase', 'diagnostic'].map(key =>
    [key, { enumerable: true, get() { foreignReads += 1; throw new Error('FOREIGN_PRIVATE_ERROR') } }])))
  assert.equal(module.initializationBrowserFailure(foreign).phase, 'OTHER')
  assert.equal(module.initializationBrowserFailure(new Proxy(foreign, { get() { foreignReads += 1; throw new Error('FOREIGN_PRIVATE_ERROR') } })).phase, 'OTHER')
  assert.throws(() => validateYidaInitializationFailureMarker(foreign))
  const good = { stage: 'yida-initialization-browser-failed', diagnostic: 'APP_BROWSER_YIDA_INIT_FAILED', phase: 'LOGIN' }
  const getter = { ...good }; Object.defineProperty(getter, 'phase', { enumerable: true, get() { foreignReads += 1; throw new Error('FOREIGN_PRIVATE_ERROR') } })
  assert.throws(() => validateYidaInitializationFailureMarker(getter))
  assert.equal(foreignReads, 0)
  const runner = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const decoder = runner.slice(runner.indexOf('export function validateYidaInitializationFailureMarker'), runner.indexOf('export function validateYidaInitializationEvidence'))
  const guards = [
    { name: 'marker-object', guard: "assert(value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value),\n    'PLM_FULL_APP_YIDA_INIT_FAILURE_OBJECT_INVALID')", bad: () => new Proxy(good, {}) },
    { name: 'marker-closed-keys', guard: "assert.deepEqual(Reflect.ownKeys(fields).sort(), ['diagnostic', 'phase', 'stage'], 'PLM_FULL_APP_YIDA_INIT_FAILURE_KEYS_INVALID')", bad: () => ({ ...good, privateValue: 'FOREIGN_PRIVATE_VALUE' }) },
    { name: 'marker-data-descriptors', guard: "assert(Object.values(fields).every(field => field.enumerable && Object.hasOwn(field, 'value')),\n    'PLM_FULL_APP_YIDA_INIT_FAILURE_DESCRIPTOR_INVALID')", bad: () => Object.defineProperty({ ...good }, 'phase', { value: 'LOGIN', enumerable: false }) },
    { name: 'marker-fixed-values', guard: "assert(fields.stage.value === 'yida-initialization-browser-failed' && fields.diagnostic.value === 'APP_BROWSER_YIDA_INIT_FAILED'\n    && initializationFailurePhases.includes(fields.phase.value), 'PLM_FULL_APP_YIDA_INIT_FAILURE_VALUE_INVALID')", bad: () => ({ ...good, phase: 'FOREIGN_PRIVATE_PHASE' }) },
  ]
  for (const mutation of guards) {
    assert(decoder.includes(mutation.guard)); assert.throws(() => validateYidaInitializationFailureMarker(mutation.bad()))
    const mutant = Function('assert', 'types', 'initializationFailurePhases', decoder.replace('export function', 'function').replace(mutation.guard, 'void 0') + '\nreturn validateYidaInitializationFailureMarker')(assert, types, initializationFailurePhases)
    assert.throws(() => assert.throws(() => mutant(mutation.bad())), assert.AssertionError)
    console.log('YIDA_INIT_DIAGNOSTIC_MUTATION ' + mutation.name + ': original rejects; removed guard rejection contract RED')
  }
})

test('in-memory removal of initialization request and receipt guards makes their rejection contracts red', () => {
  const source = read(initializationSource)
  const mutations = [
    { name: 'ready-GET-and-single-POST', guard: "assert(!armed && (method !== 'POST' || (counts.gets === 1 && counts.posts === 0)), 'APP_BROWSER_YIDA_INIT_ARM_INVALID')",
      probe(module) { const window = module.createInitializationRequestWindow('http://127.0.0.1:8123', () => 'synthetic.jwt.only', initCommand); window.arm('POST') } },
    { name: 'exact-origin-path-method', guard: "assert(target.origin === origin && target.pathname === initializationEndpoint && !target.search && !target.hash\n        && method === armed && (method === 'GET' || method === 'POST'), 'APP_BROWSER_YIDA_INIT_REQUEST_DENIED')",
      probe(module) { const window = readyInitializationWindow(module); window.arm('POST'); window.accept(initializationRequest(module, { url: 'http://127.0.0.1:8124' + module.initializationEndpoint })) } },
    { name: 'no-principal-steering', guard: "assert(token() && headers.authorization === 'Bearer ' + token()\n        && !('x-tenant-id' in headers) && !('x-workspace-id' in headers), 'APP_BROWSER_YIDA_INIT_PRINCIPAL_HEADERS_INVALID')",
      probe(module) { const window = readyInitializationWindow(module); window.arm('POST'); window.accept(initializationRequest(module, { headers: { authorization: 'Bearer synthetic.jwt.only', 'content-type': 'application/json', 'x-tenant-id': 'foreign' } })) } },
    { name: 'exact-detached-input', guard: "assert(method === 'GET' ? request.postData() === null\n        : /^application\\/json(?:\\s*;|$)/iu.test(headers['content-type'] ?? '')\n          && isDeepStrictEqual(request.postDataJSON(), initializationBody(commandId)), 'APP_BROWSER_YIDA_INIT_BODY_INVALID')",
      probe(module) { const window = readyInitializationWindow(module); window.arm('POST'); window.accept(initializationRequest(module, { body: { ...module.initializationBody(initCommand), ownerId: 'foreign' } })) } },
    { name: 'complete-explicit-journey', guard: "assert(!armed && counts.gets === 3 && counts.posts === 1, 'APP_BROWSER_YIDA_INIT_JOURNEY_INCOMPLETE')",
      probe(module) { readyInitializationWindow(module).verify() } },
  ]
  for (const mutation of mutations) {
    assert(source.includes(mutation.guard)); const original = loadInitializationContract(source)
    assert.throws(() => mutation.probe(original))
    const mutant = loadInitializationContract(source.replace(mutation.guard, 'void 0'))
    assert.throws(() => assert.throws(() => mutation.probe(mutant)), assert.AssertionError)
    console.log('YIDA_INIT_MUTATION ' + mutation.name + ': original rejects; removed guard rejection contract RED')
  }
  const runner = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const receiptSource = runner.slice(runner.indexOf('export function validateYidaInitializationEvidence'), runner.indexOf('export function validateBrowserProcessEvidence'))
  const guard = "assert.equal(found.length, 1, 'PLM_FULL_APP_YIDA_INIT_STAGE_REQUIRED')"
  const mutant = Function('assert', receiptSource.replace('export function', 'function').replace(guard, 'void 0') + '\nreturn validateYidaInitializationEvidence')(assert)
  const duplicated = initializationRecords(); duplicated.splice(2, 0, duplicated[2])
  assert.throws(() => validateYidaInitializationEvidence(duplicated))
  assert.throws(() => assert.throws(() => mutant(duplicated)), assert.AssertionError)
  console.log('YIDA_INIT_MUTATION unique-new-step-receipt: original rejects; removed guard rejection contract RED')
  const processSource = runner.slice(runner.indexOf('export function validateBrowserProcessEvidence'), runner.indexOf('export async function verifyYidaOwnerOffRawLogs'))
  const processGuards = [
    { name: 'exact-two-browser-receipts', guard: "assert.equal(nested.length, 2, 'PLM_FULL_APP_BROWSER_LOG_REQUIRED')",
      bad: () => browserProcessRecords().slice(0, 1) },
    { name: 'actual-successful-ordered-child-close', guard: "assert(record.kind === 'isolated-browser' && record.diagnostics?.name === 'isolated-browser'\n      && record.diagnostics.ordinal === ordinal && record.diagnostics.code === 0 && record.diagnostics.signal === null\n      && record.diagnostics.timedOut === false && record.diagnostics.complete === true\n      && record.diagnostics.outputLimitExceeded === false && record.diagnostics.malformedMarker === false\n      && record.diagnostics.spawnFailed === false && record.diagnostics.terminationReason === 'exit',\n    'PLM_FULL_APP_BROWSER_LOG_INVALID')",
      bad() { const records = browserProcessRecords(); records[1].diagnostics.signal = 'SIGKILL'; return records } },
  ]
  for (const mutation of processGuards) {
    assert(processSource.includes(mutation.guard))
    const mutated = Function('assert', processSource.replace('export function', 'function').replace(mutation.guard, 'void 0') + '\nreturn validateBrowserProcessEvidence')(assert)
    assert.throws(() => validateBrowserProcessEvidence(mutation.bad()))
    assert.throws(() => assert.throws(() => mutated(mutation.bad())), assert.AssertionError)
    console.log('YIDA_INIT_MUTATION ' + mutation.name + ': original rejects; removed guard rejection contract RED')
  }
})

function membersOffFixture(module, inputOverrides = {}) {
  const input = { origin: 'http://127.0.0.1:43210', tenantId: 'synthetic-tenant', token: () => 'synthetic-token',
    phase: () => 'TOPBAR', allowedPhases: ['TOPBAR'], ...inputOverrides }
  const request = (overrides = {}) => ({
    url: () => overrides.url ?? input.origin + '/api/integration/stock-preparation/members',
    method: () => overrides.method ?? 'GET', postData: () => overrides.body ?? null,
    headers: () => overrides.headers ?? { authorization: 'Bearer synthetic-token', 'x-tenant-id': input.tenantId },
  })
  return { window: module.createMembersOffWindow(input), request }
}
const membersOffPayload = { ok: false, error: { code: 'STOCK_PREP_MEMBERS_PAGE_DISABLED' } }
const membersOffConsole = 'Failed to load resource: the server responded with a status of 404 (Not Found)'

test('members OFF observer requires the real correlated request, refusal and console event', () => {
  const module = loadMainMigrationContract(), f = membersOffFixture(module), request = f.request()
  assert(f.window.isCandidate(request))
  assert.throws(() => f.window.verify())
  f.window.accept(request)
  assert.throws(() => f.window.accept(request))
  assert.throws(() => f.window.response(f.request(), 404, membersOffPayload))
  assert.throws(() => f.window.verify())
  // Chromium's console event may arrive before JSON parsing. Final verification
  // must still require the exact original request's validated response.
  assert.equal(f.window.consoleRefusal(request.url(), membersOffConsole), true)
  assert.throws(() => f.window.verify())
  f.window.response(request, 404, membersOffPayload)
  f.window.verify()
  assert.deepEqual(f.window.counts, { requests: 1, responses: 1, consoleErrors: 1 })
  assert.throws(() => f.window.response(request, 404, membersOffPayload))
  assert.throws(() => f.window.consoleRefusal(request.url(), membersOffConsole))
  assert.equal(f.window.consoleRefusal(request.url() + '/other', membersOffConsole), false)
  const bounded = membersOffFixture(module)
  for (let i = 0; i < 64; i++) bounded.window.accept(bounded.request())
  assert.throws(() => bounded.window.accept(bounded.request()))
})

test('members OFF observer rejects writes, foreign scope and any non-OFF refusal', () => {
  const module = loadMainMigrationContract()
  for (const options of [{ method: 'POST' }, { body: '{}' },
    { url: 'http://foreign.invalid/api/integration/stock-preparation/members' },
    { url: 'http://127.0.0.1:43210/api/integration/stock-preparation/members?tenantId=foreign' },
    { url: 'http://127.0.0.1:43210/api/integration/stock-preparation/members#fragment' },
    { url: 'http://127.0.0.1:43210/api/integration/stock-preparation/members/custom-roles' },
    { headers: {} }, { headers: { authorization: 'Bearer other', 'x-tenant-id': 'synthetic-tenant' } },
    ...['x-tenant-id', 'x-workspace-id', 'x-user-role', 'x-permissions'].map(key => ({ headers: {
      authorization: 'Bearer synthetic-token', 'x-tenant-id': 'synthetic-tenant', [key]: 'foreign',
    } }))]) {
    const f = membersOffFixture(module)
    assert.throws(() => f.window.accept(f.request(options)))
  }
  const wrongPhase = membersOffFixture(module, { phase: () => 'YIDA_OWNER_DEFAULT_OFF' })
  assert.throws(() => wrongPhase.window.accept(wrongPhase.request()))
  for (const [status, payload] of [[200, membersOffPayload], [403, membersOffPayload], [500, membersOffPayload],
    [404, null], [404, []], [404, { ok: true, error: membersOffPayload.error }],
    [404, { ok: false, error: { code: 'OTHER_DISABLED' } }]]) {
    const f = membersOffFixture(module), request = f.request(); f.window.accept(request)
    assert.throws(() => f.window.response(request, status, payload))
  }
  const f = membersOffFixture(module), request = f.request(); f.window.accept(request)
  assert.throws(() => f.window.consoleRefusal(request.url(), membersOffConsole + ' extra'))
})

test('members OFF finite guard removals are killed by independent matching negative controls', () => {
  const cases = [
    ["assert(input.allowedPhases.includes(input.phase()), 'APP_BROWSER_MEMBERS_OFF_PHASE_DENIED')", { phase: () => 'SEND' }, {}, 'accept'],
    ["assert(url.origin === input.origin && !url.username && !url.password && !url.hash,\n      'APP_BROWSER_MEMBERS_OFF_ORIGIN_DENIED')", {}, { url: 'http://foreign.invalid/api/integration/stock-preparation/members' }, 'accept'],
    ["assert(url.pathname === endpoint && !url.search, 'APP_BROWSER_MEMBERS_OFF_PATH_DENIED')", {}, { url: 'http://127.0.0.1:43210/other' }, 'accept'],
    ["assert(request.method() === 'GET' && request.postData() === null, 'APP_BROWSER_MEMBERS_OFF_READ_ONLY')", {}, { method: 'POST' }, 'accept'],
    ["assert(input.token() && headers.authorization === 'Bearer ' + input.token(), 'APP_BROWSER_MEMBERS_OFF_SESSION_REQUIRED')", {}, { headers: { authorization: 'Bearer foreign', 'x-tenant-id': 'synthetic-tenant' } }, 'accept'],
    ["assert(headers['x-tenant-id'] === input.tenantId && !('x-workspace-id' in headers)\n      && !('x-user-role' in headers) && !('x-permissions' in headers), 'APP_BROWSER_MEMBERS_OFF_SCOPE_DENIED')", {}, { headers: { authorization: 'Bearer synthetic-token', 'x-tenant-id': 'foreign' } }, 'accept'],
    ["assert.equal(status, 404, 'APP_BROWSER_MEMBERS_OFF_STATUS_REQUIRED')", {}, {}, 'status'],
    ["assert(envelope.ok === false && envelope.error?.code === 'STOCK_PREP_MEMBERS_PAGE_DISABLED',\n      'APP_BROWSER_MEMBERS_OFF_CODE_REQUIRED')", {}, {}, 'code'],
  ]
  for (const [guard, input, options, operation] of cases) {
    const attempt = module => {
      const f = membersOffFixture(module, input), request = f.request(options)
      if (operation === 'accept') return f.window.accept(request)
      f.window.accept(request)
      return f.window.response(request, operation === 'status' ? 200 : 404,
        operation === 'code' ? { ok: false, error: { code: 'OTHER_DISABLED' } } : membersOffPayload)
    }
    assert.throws(() => attempt(loadMainMigrationContract()))
    assert.throws(() => assert.throws(() => attempt(removeMainContractGuard(guard))), { code: 'ERR_ASSERTION' })
  }
})

async function ownedLogFixture() {
  const nonce = randomUUID()
  const scratchDir = path.join(repoRoot, 'tmp', 'stock-preparation-plm-full-app-' + nonce)
  await fs.mkdir(scratchDir, { mode: 0o700 })
  await fs.writeFile(path.join(scratchDir, 'owner.json'), JSON.stringify({ owner: 'PLM_FULL_APP_SCRATCH',
    nonce, repoRoot, pid: process.pid }), { flag: 'wx', mode: 0o600 })
  const emitted = []
  return { repoRoot, scratchDir, emitted, run: createFullAppStageRunner({ repoRoot, scratchDir, emit: line => emitted.push(line) }) }
}
test('browser failure public projection rejects unknown strings and private frame fields', () => {
  const secret = 'SYNTHETIC_PRIVATE_VALUE'
  for (const input of [null, [], secret, { stage: secret }, { stage: 'browser-failure-counts', counts: secret }]) {
    assert.equal(publicBrowserFailure(input), null)
  }
  assert.deepEqual(publicBrowserFailure({ stage: 'browser-api-denied', routeCategory: secret, method: secret,
    path: secret, token: secret }), { stage: 'browser-api-denied', routeCategory: 'OTHER', method: 'OTHER' })
  for (const diagnostic of [secret, 'APP_BROWSER_TOPBAR_' + secret, 'APP_BROWSER_' + secret + '_TIMEOUT']) {
    const projected = publicBrowserFailure({ stage: 'isolated-browser-failed', diagnostic, token: secret })
    assert(!JSON.stringify(projected).includes(secret))
    assert.equal(projected.reason, 'OTHER')
  }
})

test('actual stage runner publishes closed browser failure diagnostics without private payloads', async () => {
  const f = await ownedLogFixture()
  const secret = 'SYNTHETIC_PRIVATE_VALUE'
  const records = [
    { stage: 'browser-request-failure', method: 'GET', apiKey: 'automationOptions', surface: 'API', failure: 'ABORTED',
      url: secret, headers: { authorization: secret }, body: secret, requestSequence: secret, errorCode: secret },
    { stage: 'browser-request-failure', method: secret, apiKey: secret, surface: secret, failure: secret },
    { stage: 'browser-api-denied', routeCategory: 'OTHER_STOCK_PREPARATION', method: 'GET', path: secret },
    { stage: 'isolated-browser-failed', diagnostic: 'APP_BROWSER_TOPBAR_UNEXPECTED_API_GET_INTEGRATION_STOCK_PREPARATION_MEMBERS', payload: secret },
    { stage: 'isolated-browser-failed', diagnostic: 'APP_BROWSER_TOPBAR_' + secret },
    { stage: 'browser-failure-counts', counts: { secret } },
  ]
  const result = await f.run('browser-failure', ['-e',
    `for (const record of ${JSON.stringify(records)}) console.log('PLM_FULL_APP_PROBE ' + JSON.stringify(record)); process.exitCode = 1`],
  cleanEnvironment(process.env))
  assert.equal(result.code, 1)
  assert.equal(result.markers.length, 6)
  const frames = f.emitted.filter(line => line.startsWith('PLM_FULL_APP_PROBE '))
    .map(line => JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length)))
  assert.deepEqual(frames, [
    { stage: 'browser-request-failure', method: 'GET', apiKey: 'automationOptions', surface: 'API', failure: 'ABORTED' },
    { stage: 'browser-request-failure', method: 'OTHER', apiKey: 'unknown', surface: 'OTHER', failure: 'OTHER' },
    { stage: 'browser-api-denied', routeCategory: 'OTHER_STOCK_PREPARATION', method: 'GET' },
    { stage: 'isolated-browser-failed', phase: 'TOPBAR', reason: 'UNEXPECTED_API_GET_INTEGRATION_STOCK_PREPARATION_MEMBERS' },
    { stage: 'isolated-browser-failed', phase: 'TOPBAR', reason: 'OTHER' },
  ])
  assert(!f.emitted.join('\n').includes(secret))
  await verifyStageLogs({ ...f, stages: [result] })
})

test('actual stage runner preserves closed host failure and browser exit diagnostics on nonzero exit', async () => {
  const f = await ownedLogFixture()
  const secret = 'SYNTHETIC_PRIVATE_VALUE'
  const records = [
    { stage: 'isolated-browser-exit', code: 7, signal: null, malformedFrame: false, hasResult: false,
      token: secret, stderr: secret },
    { stage: 'failed', diagnostic: 'APP_BROWSER_ISOLATED_PROCESS_FAILED', code: secret, frames: [secret] },
    { stage: 'production-stop-failed', diagnostic: 'APP_CONFIGURED_PROBE_MUST_PASS_BEFORE_STOP_PROOF', payload: secret },
    { stage: 'failed', diagnostic: 'APP_BROWSER_' + secret, code: secret },
    { stage: 'production-stop-failed', diagnostic: 'APP_CONFIGURED_' + secret },
    { stage: 'isolated-browser-exit', code: secret, signal: secret, malformedFrame: secret,
      hasResult: secret, captureFailed: secret },
  ]
  const result = await f.run('host-failure', ['-e',
    `for (const record of ${JSON.stringify(records)}) console.log('PLM_FULL_APP_PROBE ' + JSON.stringify(record)); process.exitCode = 1`],
  cleanEnvironment(process.env))
  assert.equal(result.code, 1)
  assert.equal(result.complete, true)
  assert.equal(result.markers.length, records.length)
  const frames = f.emitted.filter(line => line.startsWith('PLM_FULL_APP_PROBE '))
    .map(line => JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length)))
  assert.deepEqual(frames, [
    { stage: 'isolated-browser-exit', code: 7, signal: null, malformedFrame: false, hasResult: false, captureFailed: null },
    { stage: 'configured-app-failed', reason: 'BROWSER_PROCESS_FAILED' },
    { stage: 'production-stop-failed', reason: 'EARLIER_PROBE_FAILED' },
    { stage: 'configured-app-failed', reason: 'OTHER' },
    { stage: 'production-stop-failed', reason: 'OTHER' },
    { stage: 'isolated-browser-exit', code: null, signal: 'OTHER', malformedFrame: null, hasResult: null, captureFailed: null },
  ])
  assert(!f.emitted.join('\n').includes(secret))
  await verifyStageLogs({ ...f, stages: [result] })
})

test('host failure projection accepts only exact fixed reasons and bounded lifecycle metadata', () => {
  for (const diagnostic of ['APP_BROWSER_CAPTURE_FAILED', 'APP_CONFIGURED_MAINTENANCE_REMAINS']) {
    const stage = diagnostic.includes('MAINTENANCE') ? 'production-stop-failed' : 'failed'
    const result = publicBrowserFailure({ stage, diagnostic })
    assert.notEqual(result.reason, 'OTHER')
    assert.equal(publicBrowserFailure({ stage, diagnostic: diagnostic + '_SYNTHETIC_PRIVATE_VALUE' }).reason, 'OTHER')
  }
  for (const code of [-1, 256, 1.5, '1', true, { private: 'SYNTHETIC_PRIVATE_VALUE' }]) {
    assert.equal(publicBrowserFailure({ stage: 'isolated-browser-exit', code }).code, null)
  }
  assert.deepEqual(publicBrowserFailure({ stage: 'isolated-browser-exit', code: 0, signal: 'SIGKILL',
    malformedFrame: true, hasResult: true, captureFailed: true }),
  { stage: 'isolated-browser-exit', code: 0, signal: 'SIGKILL', malformedFrame: true, hasResult: true, captureFailed: true })
})

test('actual stage runner preserves separate binary raw streams and Unicode split frames', async () => {
  const f = await ownedLogFixture()
  const marker = 'PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-phase', phase: '汉字' }) + '\n'
  const result = await f.run('binary-child', ['-e', `
    const bytes=Buffer.from(${JSON.stringify(marker)});
    process.stdout.write(Buffer.from([0,255,10]));
    for(const byte of bytes) process.stdout.write(Buffer.from([byte]));
    process.stderr.write(Buffer.from([255,0,13,10]));
  `], cleanEnvironment(process.env))
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.equal(result.complete, true)
  assert.equal(result.terminationReason, 'exit')
  assert(result.elapsedMs >= 0)
  assert.deepEqual(await fs.readFile(path.join(repoRoot, result.logs.stdout.path)), Buffer.concat([Buffer.from([0,255,10]), Buffer.from(marker)]))
  assert.deepEqual(await fs.readFile(path.join(repoRoot, result.logs.stderr.path)), Buffer.from([255,0,13,10]))
  assert.deepEqual(result.markers, [marker.trimEnd()])
  assert(f.emitted.includes(marker.trimEnd()))
  await verifyStageLogs({ ...f, stages: [result] })
})
test('actual nonzero, spawn failure, signal and timeout retain diagnostics without passing status', async () => {
  const f = await ownedLogFixture()
  const env = cleanEnvironment(process.env)
  const exited = await f.run('nonzero', ['-e', 'process.stderr.write("synthetic failure\\n");process.exitCode=7'], env)
  assert.equal(exited.code, 7)
  assert.equal(exited.terminationReason, 'exit')
  const failed = await f.run('spawn-failed', ['-e', ''], env, path.join(f.scratchDir, 'absent-cwd'))
  assert.equal(failed.spawnFailed, true)
  assert.equal(failed.terminationReason, 'spawn-failure')
  assert.notEqual(failed.code, 0)
  const signaled = await f.run('signal', ['-e', 'process.kill(process.pid,"SIGTERM")'], env)
  assert.notEqual(signaled.code, 0)
  const timeout = await f.run('timeout', ['-e', 'setInterval(()=>{},1000)'], env, repoRoot, 300)
  assert.equal(timeout.timedOut, true)
  assert.equal(timeout.terminationReason, 'timeout')
  assert.notEqual(timeout.code, 0)
  await verifyStageLogs({ ...f, stages: [exited, failed, signaled, timeout] })
})
test('actual malformed marker and bounded raw output refuse the original stage', async () => {
  const f = await ownedLogFixture()
  const env = cleanEnvironment(process.env)
  const malformed = await f.run('bad-frame', ['-e', 'console.log("PLM_FULL_APP_PROBE {bad}");setInterval(()=>{},1000)'], env)
  assert.equal(malformed.malformedMarker, true)
  assert.equal(malformed.terminationReason, 'malformed-marker')
  const large = await f.run('output-limit', ['-e', 'process.stdout.write(Buffer.alloc(33*1024*1024,65))'], env)
  assert.equal(large.outputLimitExceeded, true)
  assert.equal(large.complete, false)
  assert.equal(large.terminationReason, 'output-limit')
  assert.equal(large.logs.stdout.bytes + large.logs.stderr.bytes, 32 * 1024 * 1024)
  await verifyStageLogs({ ...f, stages: [malformed, large] })
})
test('log verifier rejects missing, changed, truncated, swapped, redirected and unowned evidence', async () => {
  const f = await ownedLogFixture()
  const result = await f.run('tamper', ['-e', 'process.stdout.write("captured");process.stderr.write("error bytes")'], cleanEnvironment(process.env))
  await verifyStageLogs({ ...f, stages: [result] })
  for (const mutate of [
    value => { value.logs.stdout.path = '../outside.raw.log' },
    value => { value.logs.stdout = value.logs.stderr },
    value => { value.ordinal += 1 },
    value => { value.logs.stdout.sha256 = '0'.repeat(64) },
    value => { value.logs.stdout.bytes += 1 },
    value => { value.complete = false },
  ]) {
    const value = structuredClone(result)
    mutate(value)
    await assert.rejects(verifyStageLogs({ ...f, stages: [value] }))
  }
  const stdout = path.join(repoRoot, result.logs.stdout.path)
  const original = await fs.readFile(stdout)
  await fs.writeFile(stdout, original.subarray(0, original.length - 1))
  await assert.rejects(verifyStageLogs({ ...f, stages: [result] }))
  await fs.writeFile(stdout, original)
  const directory = path.dirname(stdout)
  const retained = directory + '-retained'
  await fs.rename(directory, retained)
  await fs.symlink(retained, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyStageLogs({ ...f, stages: [result] }))
  const owner = JSON.parse(await fs.readFile(path.join(f.scratchDir, 'owner.json'), 'utf8'))
  await fs.writeFile(path.join(f.scratchDir, 'owner.json'), JSON.stringify({ ...owner, owner: 'NOT_THIS_TASK' }))
  await assert.rejects(verifyStageLogs({ ...f, stages: [result] }))
})
test('raw capture writes received bytes before close and separates completeness from success', async () => {
  const f = await ownedLogFixture()
  const capture = await createOwnedProcessCapture({ ...f, name: 'isolated-browser', ordinal: 0 })
  const privateBytes = Buffer.from('synthetic-private-output\n')
  capture.accept('stderr', privateBytes)
  const logPath = path.join(f.scratchDir, 'diagnostics', '000-isolated-browser', 'stderr.raw.log')
  assert.deepEqual(await fs.readFile(logPath), privateBytes)
  const metadata = await capture.finalize({ code: 7, signal: null, terminationReason: 'exit', elapsedMs: 1 })
  assert.equal(metadata.complete, true)
  assert.equal(metadata.code, 7)
  assert.equal(metadata.logs.stderr.sha256, createHash('sha256').update(privateBytes).digest('hex'))
  await verifyStageLogs({ ...f, stages: [metadata] })
  assert(!JSON.stringify(metadata).includes(privateBytes.toString().trim()))
  await assert.rejects(capture.finalize({ code: 0, signal: null, terminationReason: 'exit', elapsedMs: 1 }))
})
test('capture rejects same-length replacement before finalization against received stream hashes', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = await ownedLogFixture()
    const capture = await createOwnedProcessCapture({ ...f, name: 'pre-finalize-tamper', ordinal: 0 })
    const received = Buffer.from('received-original-bytes')
    capture.accept(stream, received)
    const logPath = path.join(f.scratchDir, 'diagnostics', '000-pre-finalize-tamper', stream + '.raw.log')
    await fs.writeFile(logPath, Buffer.alloc(received.length, 88))
    await assert.rejects(capture.finalize({ code: 0, signal: null, terminationReason: 'exit', elapsedMs: 1 }),
      /PLM_FULL_APP_LOG_HASH_CHANGED/u)
  }
})

test('actual killed capture owner leaves accepted raw bytes without a fake child-close attestation', async () => {
  const f = await ownedLogFixture()
  const moduleUrl = new URL('./run-stock-preparation-plm-full-app.mjs', import.meta.url).href
  const script = `
    import(${JSON.stringify(moduleUrl)}).then(async ({createOwnedProcessCapture})=>{
      const capture=await createOwnedProcessCapture({repoRoot:${JSON.stringify(repoRoot)},scratchDir:${JSON.stringify(f.scratchDir)},name:'isolated-browser',ordinal:0});
      capture.accept('stderr',Buffer.from('accepted-before-native-exit'));
      process.kill(process.pid,'SIGTERM');
    });
  `
  const result = await f.run('capture-owner-exit', ['-e', script], cleanEnvironment(process.env))
  assert.notEqual(result.code, 0)
  const recovered = await recoverUnobservedProcessLogs({ ...f, name: 'isolated-browser', ordinal: 0 })
  assert.equal(recovered.lifecycleObserved, false)
  assert.equal(recovered.captureComplete, false)
  assert.equal(recovered.streams.length, 2)
  const stderr = recovered.streams.find(stream => stream.stream === 'stderr')
  assert.deepEqual(await fs.readFile(path.join(repoRoot, stderr.path)), Buffer.from('accepted-before-native-exit'))
  assert.equal(Object.hasOwn(recovered, 'code'), false)
  assert.equal(Object.hasOwn(recovered, 'signal'), false)
  assert(!JSON.stringify(recovered).includes('accepted-before-native-exit'))
  await verifyStageLogs({ ...f, stages: [result] })
})

test('owned durable acceptance enables the required recovery dependency with an empty outbound queue', () => {
  const runner = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  assert.match(runner, /AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true'/u)
  assert.match(runner, /WEBHOOK_RETRY_SCHEDULER_DISABLED: '0'/u)
  const verifier = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assert.match(verifier, /for \(const table of \[[^\]]*'multitable_webhooks', 'multitable_webhook_deliveries'/u)
  assert(verifier.indexOf("'multitable_webhook_deliveries'") < verifier.indexOf('await host.start()'))
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-fixture.ts')
  assert.match(fixture, /assert\.equal\(await count\('multitable_webhooks'\), 0/u)
  assert.match(fixture, /assert\.equal\(await count\('multitable_webhook_deliveries'\), 0/u)
})

function requiredStep(steps, id) {
  const matches = steps.filter(step => step.id === id)
  assert.equal(matches.length, 1, `exactly one ${id} step is required`)
  return matches[0]
}

function assertWorkspaceDependencyInstall(step) {
  assert.equal(step.if, undefined, 'dependency installation must not acquire a skip condition')
  assert.ok(step['continue-on-error'] === undefined || step['continue-on-error'] === false,
    'dependency installation must not ignore a failed install')
  assert.deepEqual(step.env ?? {}, {}, 'dependency installation must not supply ambient settings')
  assert.equal(step['working-directory'], undefined, 'dependency installation resolves from the repository root')
  assert.equal(step.shell, undefined, 'dependency installation uses the default fail-fast shell')
  assert.equal(step.uses, undefined, 'dependency installation must execute the actual pnpm command')
  assert.equal(step.run?.trim(), dependencyInstallCommand, 'dependency installation must retain pipefail and the exact frozen install')
}

function assertWorkflowContract(document) {
  const job = document.jobs?.test
  assert.ok(job, 'required test job must exist')
  assert.ok(job.strategy?.matrix?.['node-version']?.includes('20.x'), 'Node 20 matrix leg must exist')
  assert.ok(!(job.strategy.matrix.exclude ?? []).some(entry => entry['node-version'] === undefined || entry['node-version'] === '20.x'),
    'Node 20 matrix leg must not be excluded')
  assert.equal(job.if, undefined, 'required job must not acquire a skip condition')
  for (const scope of [document, job]) {
    assert.ok(scope['continue-on-error'] === undefined || scope['continue-on-error'] === false)
    const inheritedEnv = { ...scope.env }
    if ('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24' in inheritedEnv) {
      assert.equal(inheritedEnv.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, 'true')
      delete inheritedEnv.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24
    }
    assert.deepEqual(inheritedEnv, {}, 'acceptance must not inherit workflow/job application environment overrides')
    assert.deepEqual(scope.defaults?.run ?? {}, {}, 'acceptance must retain the default fail-fast shell and root directory')
  }
  const steps = job.steps
  const acceptance = requiredStep(steps, acceptanceId)
  const contracts = requiredStep(steps, contractsId)
  const browser = requiredStep(steps, browserId)
  const dependencyInstall = requiredStep(steps, dependencyInstallId)
  assertWorkspaceDependencyInstall(dependencyInstall)
  for (const step of [acceptance, contracts, browser]) {
    assert.equal(step.if, node20, `${step.id} must execute on the required Node 20 leg`)
    assert.ok(step['continue-on-error'] === undefined || step['continue-on-error'] === false)
    assert.deepEqual(step.env ?? {}, {}, `${step.id} must not supply ambient DB/auth settings`)
    assert.equal(step['working-directory'], undefined, 'commands resolve from the repository root')
    assert.equal(step.shell, undefined, 'commands use the default fail-fast shell')
  }
  assert.equal(acceptance.run.trim(), acceptanceCommands,
    'execute independent manual and interval owned-fixture runs in order with only explicit PG binaries and scenario')
  assert.equal(contracts.run.trim(), contractsCommand, 'all three no-DB suites must be executable whole-file arguments')
  assert.equal(browser.run.trim(), 'pnpm exec playwright install --with-deps chromium')
  assert.ok(Number.isInteger(acceptance['timeout-minutes'])
    && acceptance['timeout-minutes'] > 0 && acceptance['timeout-minutes'] <= 20,
  'full-app acceptance must have a positive timeout of at most 20 minutes')
  assert.ok(steps.indexOf(acceptance) > steps.indexOf(browser), 'Chromium must be installed before acceptance')
  const realDb = requiredStep(steps, 'external-system-delete-bind-lock-protocol-real-db')
  assert.ok(steps.indexOf(realDb) < steps.indexOf(acceptance), 'real-DB proof must precede full-app browser acceptance')
  const postgres = steps.find(step => step.uses === 'ankane/setup-postgres@v1')
  assert.ok(postgres && String(postgres.with?.['postgres-version']) === '14', 'reuse the PostgreSQL 14 installation')
  assert.ok(steps.indexOf(postgres) < steps.indexOf(acceptance), 'PostgreSQL binaries must already be installed')
  assert.ok(steps.indexOf(contracts) > steps.indexOf(dependencyInstall), 'source-derived contracts require successful dependency installation first')
}

test('formal synthetic acceptance and all three no-DB suites execute in the required CI lane', () => {
  assertWorkflowContract(workflow)
})

test('CI rejects browser acceptance masking the real-DB proof', () => {
  const candidate = structuredClone(workflow)
  const steps = candidate.jobs.test.steps
  const acceptance = requiredStep(steps, acceptanceId)
  steps.splice(steps.indexOf(acceptance), 1)
  steps.splice(steps.indexOf(requiredStep(steps, 'external-system-delete-bind-lock-protocol-real-db')), 0, acceptance)
  assert.throws(() => assertWorkflowContract(candidate), /real-DB proof must precede full-app browser acceptance/u)
})

test('CI contract rejects missing or skipped Node 20 acceptance and contracts', () => {
  const mutations = [
    document => { document.jobs.test.strategy.matrix['node-version'] = ['18.x'] },
    document => { document.jobs.test.strategy.matrix.exclude = [{ 'node-version': '20.x' }] },
    document => { document.jobs.test.strategy.matrix.exclude = [{}] },
    document => { document.jobs.test.if = false },
    document => { document.jobs.test['continue-on-error'] = true },
    document => { document.env.NODE_OPTIONS = '--require=synthetic-value' },
    document => { document.jobs.test.env = { RBAC_BYPASS: 'true' } },
    document => { document.defaults = { run: { shell: 'echo {0}' } } },
    document => { document.jobs.test.defaults = { run: { shell: 'bash {0}' } } },
    ...[acceptanceId, contractsId, browserId].flatMap(id => [
      document => { requiredStep(document.jobs.test.steps, id).if = "matrix.node-version == '18.x'" },
      document => { requiredStep(document.jobs.test.steps, id)['continue-on-error'] = true },
      document => { requiredStep(document.jobs.test.steps, id).shell = 'bash {0}' },
      document => { document.jobs.test.steps = document.jobs.test.steps.filter(step => step.id !== id) },
    ]),
  ]
  for (const mutate of mutations) {
    const candidate = structuredClone(workflow)
    mutate(candidate)
    assert.throws(() => assertWorkflowContract(candidate))
  }
})

test('CI contract rejects non-executable invocations, overrides, and unbounded timeouts', () => {
  for (const command of [
    acceptanceCommand,
    intervalAcceptanceCommand,
    `${intervalAcceptanceCommand}\n${acceptanceCommand}`,
    `${acceptanceCommand}\n${acceptanceCommand}`,
    `${acceptanceCommands}\n${intervalAcceptanceCommand}`,
    `${acceptanceCommand}\n# ${intervalAcceptanceCommand}`,
    `${acceptanceCommand}\necho ${intervalAcceptanceCommand}`,
    `${acceptanceCommand}\n${intervalAcceptanceCommand} || true`,
    `${acceptanceCommand} && ${intervalAcceptanceCommand}`,
    `${acceptanceCommand}\n${intervalAcceptanceCommand.replace('=interval', '=manual')}`,
    `echo ${acceptanceCommand}`,
    `# ${acceptanceCommand}`,
    `${acceptanceCommand} || true`,
    `${acceptanceCommand} --existing-db`,
    acceptanceCommand.replace('/14/bin', '/15/bin'),
    'pnpm --filter @metasheet/core-backend exec vitest run',
  ]) {
    const candidate = structuredClone(workflow)
    requiredStep(candidate.jobs.test.steps, acceptanceId).run = command
    assert.throws(() => assertWorkflowContract(candidate))
  }
  for (const timeout of [undefined, 0, 21, '20']) {
    const candidate = structuredClone(workflow)
    requiredStep(candidate.jobs.test.steps, acceptanceId)['timeout-minutes'] = timeout
    assert.throws(() => assertWorkflowContract(candidate))
  }
  for (const id of [acceptanceId, contractsId]) {
    const candidate = structuredClone(workflow)
    requiredStep(candidate.jobs.test.steps, id).env = { DATABASE_URL: 'ambient-value' }
    assert.throws(() => assertWorkflowContract(candidate))
  }
})

test('CI contract rejects acceptance before its dependencies and an omitted owned-PG suite', () => {
  for (const before of [browserId, 'postgres']) {
    const candidate = structuredClone(workflow)
    const steps = candidate.jobs.test.steps
    const acceptance = requiredStep(steps, acceptanceId)
    const dependency = before === 'postgres'
      ? steps.find(step => step.uses === 'ankane/setup-postgres@v1') : requiredStep(steps, before)
    steps.splice(steps.indexOf(acceptance), 1)
    steps.splice(steps.indexOf(dependency), 0, acceptance)
    assert.throws(() => assertWorkflowContract(candidate))
  }
  const candidate = structuredClone(workflow)
  requiredStep(candidate.jobs.test.steps, contractsId).run =
    'node --test scripts/ops/stock-preparation-plm-full-app-contract.test.mjs'
  assert.throws(() => assertWorkflowContract(candidate))
})

test('CI contracts reject missing, skipped, ignored or non-executed dependency installation and pre-install ordering', () => {
  const mutations = [
    document => { document.jobs.test.steps = document.jobs.test.steps.filter(step => step.id !== dependencyInstallId) },
    document => { document.jobs.test.steps.push(structuredClone(requiredStep(document.jobs.test.steps, dependencyInstallId))) },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).if = false },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId)['continue-on-error'] = true },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).env = { DATABASE_URL: 'ambient-value' } },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId)['working-directory'] = 'packages/core-backend' },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).shell = 'bash {0}' },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).uses = 'actions/cache@v4' },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).run = `echo ${dependencyInstallCommand}` },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).run = 'pnpm install --frozen-lockfile 2>&1 | tee install.log' },
    document => { requiredStep(document.jobs.test.steps, dependencyInstallId).run = `${dependencyInstallCommand} || true` },
    document => {
      const steps = document.jobs.test.steps, contracts = requiredStep(steps, contractsId)
      steps.splice(steps.indexOf(contracts), 1)
      steps.splice(steps.indexOf(requiredStep(steps, dependencyInstallId)), 0, contracts)
    },
  ]
  assert.equal(mutations.length, 12)
  for (const mutate of mutations) {
    const candidate = structuredClone(workflow)
    mutate(candidate)
    assert.throws(() => assertWorkflowContract(candidate))
  }
})

test('CI contracts require all three unfiltered, non-echoed whole-file arguments', () => {
  const commands = [
    contractsCommand.replace(' scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs', ''),
    contractsCommand.replace(' scripts/ops/stock-preparation-plm-owned-pg.test.mjs', ''),
    contractsCommand.replace('node --test ', 'node --test --test-name-pattern=actual '),
    `echo ${contractsCommand}`,
    `# ${contractsCommand}`,
    `${contractsCommand} || true`,
    `${contractsCommand}\n${contractsCommand}`,
    'node --test scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs',
  ]
  assert.equal(commands.length, 8)
  for (const command of commands) {
    const candidate = structuredClone(workflow)
    requiredStep(candidate.jobs.test.steps, contractsId).run = command
    assert.throws(() => assertWorkflowContract(candidate))
  }
})

test('dependency and whole-file wiring guard removals make the actual rejection contracts red', () => {
  const step = requiredStep(workflow.jobs.test.steps, dependencyInstallId)
  const guards = [
    ["assert.equal(step.if, undefined, 'dependency installation must not acquire a skip condition')", candidate => { candidate.if = false }],
    ["assert.ok(step['continue-on-error'] === undefined || step['continue-on-error'] === false,\n    'dependency installation must not ignore a failed install')", candidate => { candidate['continue-on-error'] = true }],
    ["assert.deepEqual(step.env ?? {}, {}, 'dependency installation must not supply ambient settings')", candidate => { candidate.env = { DATABASE_URL: 'ambient-value' } }],
    ["assert.equal(step['working-directory'], undefined, 'dependency installation resolves from the repository root')", candidate => { candidate['working-directory'] = 'packages/core-backend' }],
    ["assert.equal(step.shell, undefined, 'dependency installation uses the default fail-fast shell')", candidate => { candidate.shell = 'bash {0}' }],
    ["assert.equal(step.uses, undefined, 'dependency installation must execute the actual pnpm command')", candidate => { candidate.uses = 'actions/cache@v4' }],
    ["assert.equal(step.run?.trim(), dependencyInstallCommand, 'dependency installation must retain pipefail and the exact frozen install')", candidate => { candidate.run = `echo ${dependencyInstallCommand}` }],
  ]
  const remove = (source, exact) => {
    assert.equal(source.split(exact).length - 1, 1)
    return source.replace(exact, 'void 0')
  }
  for (const [guard, mutate] of guards) {
    const candidate = structuredClone(step); mutate(candidate)
    assert.throws(() => assertWorkspaceDependencyInstall(candidate))
    const mutant = Function('assert', 'dependencyInstallCommand',
      remove(assertWorkspaceDependencyInstall.toString(), guard) + '\nreturn assertWorkspaceDependencyInstall')(assert, dependencyInstallCommand)
    assert.throws(() => assert.throws(() => mutant(candidate)), assert.AssertionError)
  }
  const bindings = { assert, requiredStep, acceptanceId, contractsId, browserId, dependencyInstallId,
    node20, acceptanceCommands, contractsCommand, assertWorkspaceDependencyInstall }
  const workflowGuards = [
    ["assert.ok(steps.indexOf(contracts) > steps.indexOf(dependencyInstall), 'source-derived contracts require successful dependency installation first')", document => {
      const steps = document.jobs.test.steps, contracts = requiredStep(steps, contractsId)
      steps.splice(steps.indexOf(contracts), 1); steps.splice(steps.indexOf(requiredStep(steps, dependencyInstallId)), 0, contracts)
    }],
    ["assert.equal(contracts.run.trim(), contractsCommand, 'all three no-DB suites must be executable whole-file arguments')", document => {
      requiredStep(document.jobs.test.steps, contractsId).run = contractsCommand.replace(' scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs', '')
    }],
  ]
  for (const [guard, mutate] of workflowGuards) {
    const candidate = structuredClone(workflow); mutate(candidate)
    assert.throws(() => assertWorkflowContract(candidate))
    const mutant = Function(...Object.keys(bindings),
      remove(assertWorkflowContract.toString(), guard) + '\nreturn assertWorkflowContract')(...Object.values(bindings))
    assert.throws(() => assert.throws(() => mutant(candidate)), assert.AssertionError)
  }
  assert.equal(guards.length + workflowGuards.length, 9)
  console.log('YIDA_SYNTHETIC_TRIAL_WIRING_MUTATION nine-install-and-invocation-guards: removed guard rejection contracts RED')
})

test('runner accepts explicit absolute PostgreSQL binaries and only the closed optional automation scenario', () => {
  assert.deepEqual(parseArguments([`--pg-bin=${pgBin}`]), { pgBin, automationScenario: 'manual' })
  for (const automationScenario of ['manual', 'interval']) {
    for (const args of [[`--pg-bin=${pgBin}`, `--automation-scenario=${automationScenario}`],
      [`--automation-scenario=${automationScenario}`, `--pg-bin=${pgBin}`]]) {
      assert.deepEqual(parseArguments(args), { pgBin, automationScenario })
    }
  }
  assert.deepEqual(parseArguments(['--help']), { help: true })
  for (const args of [[], ['--pg-bin='], ['--pg-bin=relative/bin'], ['--pg-bin', pgBin],
    ['--help', `--pg-bin=${pgBin}`], [`--pg-bin=${pgBin}`, `--pg-bin=${pgBin}`]]) {
    assert.throws(() => parseArguments(args), /PLM_FULL_APP_(?:EXPLICIT|ABSOLUTE)_PG_BIN_REQUIRED/u)
  }
  for (const value of ['', 'auto', 'schedule', 'INTERVAL', ' interval', 'interval ', 'interval=manual', 'true']) {
    assert.throws(() => parseArguments([`--pg-bin=${pgBin}`, `--automation-scenario=${value}`]),
      /PLM_FULL_APP_AUTOMATION_SCENARIO_INVALID/u)
  }
  for (const args of [['--automation-scenario=interval'], ['--automation-scenario', 'interval'],
    [`--pg-bin=${pgBin}`, '--automation-scenario', 'interval'],
    [`--pg-bin=${pgBin}`, '--automation-scenario=manual', '--automation-scenario=interval'],
    [`--pg-bin=${pgBin}`, '--automation-scenario=interval', '--automation-scenario=interval'],
    [`--pg-bin=${pgBin}`, '--automationScenario=interval'], [`--pg-bin=${pgBin}`, null]]) {
    assert.throws(() => parseArguments(args), /PLM_FULL_APP_EXPLICIT_PG_BIN_REQUIRED/u)
  }
})

test('runner has no existing-database, auth, environment-file, or skip override arguments', () => {
  for (const override of [
    '--existing-db', '--existingDB=true', '--database-url=synthetic-value', '--db-url=synthetic-value',
    '--pg-host=synthetic-value', '--pg-data=synthetic-value', '--env-file=.env', '--node-options=synthetic-value',
    '--rbac-bypass=true', '--skip-build', '--skip-migrations', '--skip-browser', '--force',
  ]) {
    assert.throws(() => parseArguments([override]), /PLM_FULL_APP_EXPLICIT_PG_BIN_REQUIRED/u)
    assert.throws(() => parseArguments([`--pg-bin=${pgBin}`, override]), /PLM_FULL_APP_EXPLICIT_PG_BIN_REQUIRED/u)
  }
})

test('cleanEnvironment drops ambient database, auth, Node options, and runtime overrides', () => {
  const denied = [
    'DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SSL',
    'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
    'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE', 'PGDATA',
    'JWT_SECRET', 'AUTH_TOKEN', 'RBAC_BYPASS', 'RBAC_TOKEN_TRUST', 'RBAC_OPTIONAL', 'ALLOW_UNSAFE_ADMIN',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'CONFIG_FILE', 'DOTENV_CONFIG_PATH',
    'MIGRATION_EXCLUDE', 'MIGRATION_INCLUDE', 'REDIS_URL', 'PLM_FULL_APP_DATABASE_URL',
    'PLM_FULL_APP_ALLOW_OWN_HTTP', 'PLM_FULL_APP_PARENT_HTTP_PORT', 'PLM_FULL_APP_SCRATCH',
    'AUTOMATION_SCENARIO', 'PLM_FULL_APP_AUTOMATION_SCENARIO',
  ]
  const environment = Object.fromEntries(denied.flatMap(key => [
    [key, 'synthetic-ambient-value'], [key.toLowerCase(), 'synthetic-ambient-value'],
  ]))
  const original = { ...environment }
  assert.deepEqual(cleanEnvironment(environment), {})
  assert.deepEqual(environment, original, 'sanitizing must not mutate its caller input')
})

test('cleanEnvironment retains only string-valued operating-system launch settings', () => {
  const allowed = Object.fromEntries([
    'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME',
  ].map(key => [key, `synthetic-${key}`]))
  assert.deepEqual(cleanEnvironment({ ...allowed, APP_TOKEN: 'synthetic-secret', EXTRA: 'value' }), allowed)
  assert.deepEqual(cleanEnvironment({ PATH: null, TEMP: 1, HOME: undefined, TMP: false }), {})
})

const productionStopRecords = () => [
  { stage: 'configured-browser-result', status: 'passed' },
  { stage: 'actual-stop-resolved' },
  { stage: 'production-stop-verified', emergencyCleanupUsed: false, mainPoolEnded: true,
    sourcePoolEnded: true, sourceRegistrationsRetained: true,
    httpListenerClosed: true, collaborationClosed: true, collaborationDisconnects: 2,
    referencedTimers: 0, maintenanceTimers: 0 },
]

test('production stop evidence accepts one resolved stop followed by exact verified state without mutating input', () => {
  const records = productionStopRecords()
  const original = structuredClone(records)
  assert.doesNotThrow(() => validateProductionStopEvidence(records))
  assert.deepEqual(records, original)
  // Other probe stages may occur between or after the two stop records.
  records.splice(2, 0, { stage: 'synthetic-other-observation' })
  records.push({ stage: 'synthetic-end' })
  assert.doesNotThrow(() => validateProductionStopEvidence(records))
})

test('production stop evidence rejects missing, duplicate, and out-of-order stop records', () => {
  assert.throws(() => validateProductionStopEvidence([]), /PLM_FULL_APP_ACTUAL_STOP_RESOLVED_REQUIRED/u)
  for (const [stage, code] of [
    ['actual-stop-resolved', 'PLM_FULL_APP_ACTUAL_STOP_RESOLVED_REQUIRED'],
    ['production-stop-verified', 'PLM_FULL_APP_PRODUCTION_STOP_VERIFIED_REQUIRED'],
  ]) {
    const missing = productionStopRecords().filter(record => record.stage !== stage)
    assert.throws(() => validateProductionStopEvidence(missing), new RegExp(code, 'u'))
    const duplicate = productionStopRecords()
    duplicate.push(structuredClone(duplicate.find(record => record.stage === stage)))
    assert.throws(() => validateProductionStopEvidence(duplicate), new RegExp(code, 'u'))
  }
  const reversed = productionStopRecords().reverse()
  assert.throws(() => validateProductionStopEvidence(reversed), /PLM_FULL_APP_STOP_STAGE_ORDER_INVALID/u)
})

test('production stop evidence rejects failure or emergency cleanup markers anywhere in the probe', () => {
  for (const stage of ['actual-stop-failed', 'production-stop-failed', 'harness-emergency-cleanup']) {
    for (const index of [0, 2, 3]) {
      const records = productionStopRecords()
      records.splice(index, 0, { stage })
      assert.throws(() => validateProductionStopEvidence(records), /PLM_FULL_APP_STOP_FAILURE_REPORTED/u)
    }
  }
})

test('production stop evidence requires every boolean and numeric count without coercion', () => {
  const invalidValues = {
    emergencyCleanupUsed: [true, 0, 1, 'false', '', null, undefined, {}, []],
    mainPoolEnded: [false, 0, 1, 'true', '', null, undefined, {}, []],
    sourcePoolEnded: [false, 0, 1, 'true', '', null, undefined, {}, []],
    sourceRegistrationsRetained: [false, 0, 1, 'true', '', null, undefined, {}, []],
    httpListenerClosed: [false, 0, 1, 'true', '', null, undefined, {}, []],
    collaborationClosed: [false, 0, 1, 'true', '', null, undefined, {}, []],
    collaborationDisconnects: [0, 1, 3, -1, '2', false, true, null, undefined, NaN, Infinity, {}, []],
    referencedTimers: [1, -1, -0, '0', false, true, null, undefined, NaN, Infinity, {}, []],
    maintenanceTimers: [1, -1, -0, '0', false, true, null, undefined, NaN, Infinity, {}, []],
  }
  for (const [field, values] of Object.entries(invalidValues)) {
    const missing = productionStopRecords()
    delete missing[2][field]
    assert.throws(() => validateProductionStopEvidence(missing), /PLM_FULL_APP_PRODUCTION_STOP_STATE_INVALID/u)
    for (const value of values) {
      const records = productionStopRecords()
      records[2][field] = value
      assert.throws(() => validateProductionStopEvidence(records), /PLM_FULL_APP_PRODUCTION_STOP_STATE_INVALID/u)
    }
  }
})

test('production stop evidence rejects malformed records instead of treating them as absent evidence', () => {
  for (const value of [null, undefined, {}, 'synthetic', false]) {
    assert.throws(() => validateProductionStopEvidence(value), /PLM_FULL_APP_STOP_RECORDS_REQUIRED/u)
  }
  for (const record of [null, [], false, 'synthetic', {}, { stage: 1 }]) {
    assert.throws(() => validateProductionStopEvidence([...productionStopRecords(), record]),
      /PLM_FULL_APP_STOP_RECORD_INVALID/u)
  }
})

test('formal runner validates parsed stop records and no longer permits harness-cleanup success', () => {
  const source = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  assert.match(source, /const records = probe\.markers\.filter\(line => line\.startsWith\('PLM_FULL_APP_PROBE '\)\)\r?\n\s*\.map\(line => JSON\.parse\(line\.slice\('PLM_FULL_APP_PROBE '\.length\)\)\)\r?\n\s*validateProductionStopEvidence\(records\)\r?\n\s*validateK3Evidence\(records\)\r?\n\s*validateYidaEvidence\(records\)\r?\n\s*validateYidaOwnerOffEvidence\(records\)\r?\n\s*validateYidaInitializationEvidence\(records\)\r?\n\s*validateAutomationEvidence\(records, automationScenario\)\r?\n\s*yidaOwnerOffLogs = await verifyYidaOwnerOffRawLogs\(\{ repoRoot, scratchDir, stage: probe, records \}\)\r?\n\s*const nestedDiagnostics = validateBrowserProcessEvidence\(records\)\r?\n\s*await verifyStageLogs\(\{ repoRoot, scratchDir, stages: nestedDiagnostics \}\)\r?\n\s*const browser =/u)
  assert.match(source, /result: failure \? 'failed' : 'passed'/u)
  assert.doesNotMatch(source, /passed-with-explicit-harness-cleanup|Production stop needs explicit harness cleanup\./u)
  for (const limitation of ['Synthetic PostgreSQL/K3 HTTP and fixture principals only; not customer protocols.',
    'Business snapshots unchanged is not a DML audit count.', 'Node IO observations do not attest native tooling/OS isolation.']) {
    assert.ok(source.includes(limitation))
  }
})

function assertBackendTypeCheck(backend) {
  assert.equal(backend.scripts['type-check'], backendTypeCheckCommand)
}

test('backend type-check includes full-app and synthetic trial without replacing existing checks', () => {
  const backend = JSON.parse(read('packages/core-backend/package.json'))
  assertBackendTypeCheck(backend)
  const config = JSON.parse(read('packages/core-backend/scripts/tsconfig.stock-preparation-plm-full-app.json'))
  assert.equal(config.compilerOptions.noEmit, true)
  assert.equal(config.compilerOptions.strict, true)
  for (const file of ['verify-stock-preparation-plm-full-app.mts',
    '../tests/utils/stock-preparation-plm-full-app-fixture.ts',
    '../tests/utils/stock-preparation-plm-full-app-browser.ts',
    '../tests/utils/stock-preparation-k3-full-app-fixture.ts',
    '../tests/utils/stock-preparation-k3-full-app-browser.ts',
    '../tests/utils/stock-preparation-yida-full-app-browser.ts',
    '../tests/utils/stock-preparation-automation-full-app-fixture.ts',
    '../tests/utils/stock-preparation-automation-full-app-browser.ts',
    '../tests/utils/stock-preparation-automation-interval-full-app-fixture.ts',
    '../tests/utils/stock-preparation-automation-interval-full-app-browser.ts',
    '../tests/utils/stock-preparation-plm-full-app-ui.mts',
    '../tests/utils/stock-preparation-plm-full-app-sockets.mts']) assert.ok(config.include.includes(file))
})

test('backend type-check refuses omission, filters, echoed or ignored synthetic checks; guard removal is red', () => {
  const backend = JSON.parse(read('packages/core-backend/package.json'))
  const commands = [
    backendTypeCheckCommand.replace(' && tsc -p scripts/tsconfig.stock-preparation-yida-synthetic-trial.json', ''),
    backendTypeCheckCommand.replace('tsc -p scripts/tsconfig.stock-preparation-yida-synthetic-trial.json', 'echo tsc -p scripts/tsconfig.stock-preparation-yida-synthetic-trial.json'),
    backendTypeCheckCommand + ' || true',
    backendTypeCheckCommand.replace('scripts/tsconfig.stock-preparation-yida-synthetic-trial.json', 'scripts/tsconfig.stock-preparation-plm-full-app.json'),
  ]
  assert.equal(commands.length, 4)
  for (const command of commands) {
    const candidate = structuredClone(backend); candidate.scripts['type-check'] = command
    assert.throws(() => assertBackendTypeCheck(candidate))
  }
  const guard = "assert.equal(backend.scripts['type-check'], backendTypeCheckCommand)"
  const source = assertBackendTypeCheck.toString(); assert.equal(source.split(guard).length - 1, 1)
  const mutant = Function('assert', 'backendTypeCheckCommand', source.replace(guard, 'void 0')
    + '\nreturn assertBackendTypeCheck')(assert, backendTypeCheckCommand)
  const missing = structuredClone(backend); missing.scripts['type-check'] = commands[0]
  assert.throws(() => assert.throws(() => mutant(missing)), assert.AssertionError)
  console.log('YIDA_SYNTHETIC_TRIAL_WIRING_MUTATION complete-four-command-type-chain: removed guard rejection contract RED')
})

const k3Records = () => [
  { stage: 'k3-synthetic-server-ready', listening: true },
  { stage: 'k3-browser-and-authority-verified', browser: {
    b4SavedAndApproved: true, b4PreviewOnly: true, bl2SavedAndApproved: true, uniqueBomRead: true,
    ambiguousBomRejected: true, reloadVersionsPersisted: true, reloadDidNotReadK3: true, realBundleJourney: true,
    responseStubs: 0, storageInjections: 0,
  }, authority: {
    realK3Login: true, encryptedCredentials: true, approvedVersionsPersisted: true, sameTenantReaderRead: true,
    readerWritesDenied: true, noPermissionDenied: true, crossTenantDenied: true, unapprovedReadDenied: true,
    bomAmbiguityFailClosed: true, deniedRequestsNoK3Io: true, externalWriteRequests: 0, unexpectedK3Requests: 0,
    loginRequests: 1, b4ReadRequests: 2, bl2ReadRequests: 3,
  } },
  { stage: 'k3-synthetic-server-closed', closed: true },
]

test('combined acceptance requires exact K3 evidence and does not mutate its input', () => {
  const records = k3Records()
  const before = structuredClone(records)
  assert.doesNotThrow(() => validateK3Evidence([...productionStopRecords(), ...records]))
  assert.deepEqual(records, before)
})

test('combined acceptance rejects missing, duplicate, reversed and malformed K3 records', () => {
  for (const record of k3Records()) {
    assert.throws(() => validateK3Evidence(k3Records().filter(row => row.stage !== record.stage)), /KTHREE_STAGE_REQUIRED/u)
    assert.throws(() => validateK3Evidence([...k3Records(), record]), /KTHREE_STAGE_REQUIRED/u)
  }
  assert.throws(() => validateK3Evidence(k3Records().reverse()), /KTHREE_STAGE_ORDER_INVALID/u)
  for (const value of [null, undefined, {}, false, 'synthetic']) assert.throws(() => validateK3Evidence(value), /KTHREE_RECORDS_REQUIRED/u)
  for (const value of [null, [], {}, { stage: false }]) assert.throws(() => validateK3Evidence([...k3Records(), value]), /KTHREE_RECORD_INVALID/u)
})

test('combined acceptance rejects missing or downgraded K3 browser and authority facts independently', () => {
  for (const group of ['browser', 'authority']) {
    for (const [key, expected] of Object.entries(k3Records()[1][group])) {
      const values = expected === true ? [undefined, false, 'true', 1, null] : expected === 0 ? [undefined, 1, '0', false, null] : [undefined, 0, -1, 1.5, '1', NaN, Infinity]
      for (const value of values) {
        const records = k3Records()
        records[1][group][key] = value
        assert.throws(() => validateK3Evidence(records), /PLM_FULL_APP_KTHREE_/u)
      }
    }
    for (const value of [null, undefined, [], false]) {
      const records = k3Records()
      records[1][group] = value
      assert.throws(() => validateK3Evidence(records), /KTHREE_EVIDENCE_REQUIRED/u)
    }
  }
})

test('combined acceptance cannot pass without a live positive control and closed synthetic service', () => {
  for (const [index, key] of [[0, 'listening'], [2, 'closed']]) {
    for (const value of [undefined, false, 'true', 1]) {
      const records = k3Records()
      records[index][key] = value
      assert.throws(() => validateK3Evidence(records), /KTHREE_(?:LIVE|CLOSED)_LISTENER_REQUIRED/u)
    }
  }
  assert.throws(() => validateK3Evidence([...k3Records(), { stage: 'k3-synthetic-server-close-failed' }]), /KTHREE_CLOSE_FAILED/u)
})

test('formal verifier wires the real K3 fixture before browser input and verifies its private result', () => {
  const source = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assert.match(source, /k3 = await createK3FullAppFixture\(/u)
  assert.match(source, /k3: k3!\.browserInput/u)
  assert.match(source, /await k3\.verifyBrowserResultAndPermissions\(browserResult\.k3\)/u)
  assert.match(source, /await k3\.close\(\)[\s\S]*?k3\.stats\(\)\.closed/u)
  assert.match(source, /finally \{\r?\n\s*try \{ ownerOffQueryObservation\?\.restore\(\) \}\r?\n\s*catch \{ stage\('yida-owner-query-observer-restore-failed'\); process\.exitCode = 1 \}\r?\n\s*try \{\r?\n\s*assert\(k3,/u)
  assert.doesNotMatch(source, /stage\([^\n]*browserResult\.k3\)/u)
})

const yidaRecords = () => [
  { stage: 'yida-synthetic-board-ready', seededTargetRows: 1, seededActiveRows: 0, separateFromPlmProject: true },
  { stage: 'yida-static-browser-verified', businessSnapshotUnchanged: true, evidence: {
    realProjectBoardNavigation: true, v1CreatePreview: true, v2CreatePreview: true,
    explicitInstanceUpdatePreview: true, renamedLayoutPreview: true, exactProjectAllocation: true,
    duplicateRowsRejected: true, invalidNumberRejected: true, ruleExportImportClearsInputs: true,
    editsClearResults: true, closeReopenClearsInputs: true, preparationEntryOpensOnlyLocalPreview: true,
    noBusinessRequests: true, storageSnapshotUnchanged: true, responseStubs: 0, storageInjections: 0,
  }, counts: { previewRuns: 11, acceptedPreviews: 8, rejectedPreviews: 3,
    localApiRequests: 0, externalRequests: 0, backgroundOverviewRequests: 0 } },
  ...productionStopRecords(),
]

test('formal verifier preserves the actual YiDa preparation-entry fact in its closed projection', () => {
  const source = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  const begin = source.indexOf('  const yidaEvidence = Object.fromEntries(')
  const end = source.indexOf('  const yidaCounts = Object.fromEntries(', begin)
  assert(begin >= 0 && end > begin, 'actual verifier projection is required')
  const projection = source.slice(begin, end)
  const input = { ...yidaRecords()[1].evidence, unexpectedPrivateMaterial: 'not-exportable' }
  const project = code => runInNewContext(code + '\nyidaEvidence', { yidaResult: { evidence: input } })
  const projected = project(projection)
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), yidaRecords()[1].evidence)
  const records = yidaRecords()
  records[1].evidence = JSON.parse(JSON.stringify(projected))
  assert.doesNotThrow(() => validateYidaEvidence(records))
  const downgraded = projection.replace("'preparationEntryOpensOnlyLocalPreview'", "'sendButtonDisabled'")
  assert.notEqual(downgraded, projection, 'downgrade must reach the actual projection')
  records[1].evidence = JSON.parse(JSON.stringify(project(downgraded)))
  assert.throws(() => validateYidaEvidence(records), /YIDA_BROWSER_EVIDENCE_INVALID/u)
})

test('YiDa acceptance requires all local UI facts before real stop and does not mutate its records', () => {
  for (const backgroundOverviewRequests of [0, 1, 10, Number.MAX_SAFE_INTEGER]) {
    const records = yidaRecords()
    records[1].counts.backgroundOverviewRequests = backgroundOverviewRequests
    const original = structuredClone(records)
    assert.doesNotThrow(() => validateYidaEvidence(records))
    assert.deepEqual(records, original)
  }
})

test('YiDa acceptance rejects missing, duplicated, reordered and malformed stages', () => {
  for (const stage of ['yida-synthetic-board-ready', 'yida-static-browser-verified',
    'actual-stop-resolved', 'production-stop-verified']) {
    const missing = yidaRecords().filter(record => record.stage !== stage)
    assert.throws(() => validateYidaEvidence(missing), /YIDA_STAGE_REQUIRED/u)
    const duplicate = yidaRecords()
    duplicate.push(structuredClone(duplicate.find(record => record.stage === stage)))
    assert.throws(() => validateYidaEvidence(duplicate), /YIDA_STAGE_REQUIRED/u)
  }
  for (const swap of [[0, 1], [1, 3], [3, 4]]) {
    const records = yidaRecords()
    ;[records[swap[0]], records[swap[1]]] = [records[swap[1]], records[swap[0]]]
    assert.throws(() => validateYidaEvidence(records), /YIDA_STAGE_ORDER_INVALID/u)
  }
  for (const value of [undefined, null, {}, false, 'synthetic']) {
    assert.throws(() => validateYidaEvidence(value), /YIDA_RECORDS_REQUIRED/u)
  }
  for (const value of [null, [], {}, false, { stage: 1 }]) {
    assert.throws(() => validateYidaEvidence([...yidaRecords(), value]), /YIDA_RECORD_INVALID/u)
  }
})

test('YiDa acceptance rejects an unseeded project or a seed sharing the PLM project', () => {
  for (const [field, values] of Object.entries({ seededTargetRows: [undefined, 0, 2, '1', true],
    seededActiveRows: [undefined, 1, -1, -0, '0', false],
    separateFromPlmProject: [undefined, false, 'true', 1] })) {
    for (const value of values) {
      const records = yidaRecords()
      records[0][field] = value
      assert.throws(() => validateYidaEvidence(records), /YIDA_SEED_INVALID/u)
    }
  }
})

test('YiDa acceptance rejects each omitted or downgraded UI fact and unchanged-snapshot claim', () => {
  for (const [field, expected] of Object.entries(yidaRecords()[1].evidence)) {
    const values = expected === true ? [undefined, false, 'true', 1, null]
      : [undefined, 1, -0, '0', false, null]
    for (const value of values) {
      const records = yidaRecords()
      records[1].evidence[field] = value
      assert.throws(() => validateYidaEvidence(records), /YIDA_BROWSER_EVIDENCE_INVALID/u)
    }
  }
  for (const value of [undefined, false, 'true', 1]) {
    const records = yidaRecords()
    records[1].businessSnapshotUnchanged = value
    assert.throws(() => validateYidaEvidence(records), /YIDA_BUSINESS_SNAPSHOT_INVALID/u)
  }
  for (const group of ['evidence', 'counts']) {
    for (const value of [undefined, null, [], false]) {
      const records = yidaRecords()
      records[1][group] = value
      assert.throws(() => validateYidaEvidence(records), /YIDA_EVIDENCE_REQUIRED/u)
    }
  }
  const legacy = yidaRecords()
  delete legacy[1].evidence.storageSnapshotUnchanged
  legacy[1].evidence.storageUnchanged = true
  assert.throws(() => validateYidaEvidence(legacy), /YIDA_BROWSER_EVIDENCE_INVALID/u)
})

test('YiDa acceptance rejects missing, coercible, fractional and nonfinite counts', () => {
  for (const field of Object.keys(yidaRecords()[1].counts)) {
    for (const value of [undefined, null, false, '0', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const records = yidaRecords()
      records[1].counts[field] = value
      assert.throws(() => validateYidaEvidence(records), /YIDA_COUNT_INVALID/u)
    }
  }
})

test('YiDa acceptance rejects false-green case totals and any local business or external request', () => {
  for (const counts of [
    { previewRuns: 10 }, { acceptedPreviews: 7 }, { rejectedPreviews: 2 },
    { previewRuns: 12, acceptedPreviews: 9 }, { acceptedPreviews: 7, rejectedPreviews: 4 },
    { localApiRequests: 1 }, { externalRequests: 1 },
  ]) {
    const records = yidaRecords()
    Object.assign(records[1].counts, counts)
    assert.throws(() => validateYidaEvidence(records), /YIDA_CASE_(?:SUM|OR_IO)_INVALID/u)
  }
})

test('formal runner executes YiDa validation on parsed records before accepting the configured browser', () => {
  const source = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const body = source.slice(source.indexOf('export async function runAcceptance'))
  assert.match(body, /const records = probe\.markers\.filter\(line => line\.startsWith\('PLM_FULL_APP_PROBE '\)\)\r?\n\s*\.map\(line => JSON\.parse\(line\.slice\('PLM_FULL_APP_PROBE '\.length\)\)\)\r?\n\s*validateProductionStopEvidence\(records\)\r?\n\s*validateK3Evidence\(records\)\r?\n\s*validateYidaEvidence\(records\)\r?\n\s*validateYidaOwnerOffEvidence\(records\)\r?\n\s*validateYidaInitializationEvidence\(records\)\r?\n\s*validateAutomationEvidence\(records, automationScenario\)\r?\n\s*yidaOwnerOffLogs = await verifyYidaOwnerOffRawLogs\(\{ repoRoot, scratchDir, stage: probe, records \}\)\r?\n\s*const nestedDiagnostics = validateBrowserProcessEvidence\(records\)\r?\n\s*await verifyStageLogs\(\{ repoRoot, scratchDir, stages: nestedDiagnostics \}\)\r?\n\s*const browser =/u)
  assert.equal((body.match(/validateYidaEvidence\(records\)/gu) ?? []).length, 1)
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  assert.match(browser, /const yida = await runConfiguredYidaBrowser\(page, input\.yida\.projectNo,/u)
  assert.match(browser, /yidaLocalWindow = true[\s\S]*?const yida = await runConfiguredYidaBrowser[\s\S]*?yidaLocalWindow = false/u)
  const helper = read('packages/core-backend/tests/utils/stock-preparation-yida-full-app-browser.ts')
  assert.match(helper, /storageSnapshotUnchanged: true/u)
  assert.doesNotMatch(helper, /storageWrites|armWrite\(/u)
})

const automationRecords = () => {
  const records = [
  { stage: 'automation-manual-fixture-ready', realRuleHttpCreated: true, ruleEditorDomVerified: false,
    dedicatedOneShotPermit: true, hostProfileRegistered: true, manualOnly: true },
  ...['before-grant', 'after-grant'].map(phase => ({
    stage: 'automation-manual-checkpoint', phase, verified: true,
  })),
  ...[503, 200].map((httpStatus, index) => ({ stage: 'automation-manual-observation', poll: index + 1,
    httpStatus, incomingRequests: 1, finishedResponses: 1, sourceMirrorQueries: 1,
    sourceMirror55P03: httpStatus === 503 ? 1 : 0, otherQueryErrors: 0, verified: true, afterCompletion: false })),
  ...['completed', 'refreshed', 'revoked'].flatMap(phase => [{
    stage: 'automation-manual-checkpoint', phase, verified: true,
  }, ...(phase === 'completed' ? [{ stage: 'automation-manual-observation', poll: 3,
    httpStatus: 200, incomingRequests: 1, finishedResponses: 1, sourceMirrorQueries: 1,
    sourceMirror55P03: 0, otherQueryErrors: 0, verified: true, afterCompletion: true }] : [])]),
  { stage: 'automation-manual-browser-and-authority-verified', businessSnapshotUnchanged: true,
    browser: { realFullAppOwnerPanel: true, emptyProjectBoardRefused: true, explicitManualConsent: true, grantCreatedThroughDom: true,
      submitThroughDom: true, durableQueuedObserved: true, succeededCountsRendered: true,
      canApplyFalse: true, refreshThroughDom: true, revokeThroughDom: true, manualOnly: true,
      ruleEditorDomVerified: false, responseStubs: 0, storageInjections: 0,
      detailPolls: 3, verifiedBusyPolls: 1, detailRefreshBounded: true, temporaryRefusalsRequestCorrelated: true,
      fixtureCompletionWaits: 1, historyRecoveries: 1, recoveryAfterFixtureCompletionOnly: true },
    authority: { realRuleHttpCreated: true, manualOnly: true, independentOneShotPermit: true,
      sourceQueryObserverPassThrough: true, emptyProjectNoTargetOrArchive: true, grantZeroSourceIo: true, realOutboxConsumerNativeSql: true,
      readonlyCountsPersisted: true, refreshZeroSourceIo: true, revokeZeroSourceIo: true,
      sessionAndRevokedRequestsDenied: true, deniedRequestsZeroSourceIo: true, noNewApplyToken: true,
      ruleEditorDomVerified: false, requests: 1, grants: 1, nativeReadOperations: 1, automaticActivations: 0,
      sourceQueries: 6, sourceQueryCompletions: 6, detailPolls: 3, verifiedBusyPolls: 1,
      fixtureCompletionWaits: 1, historyRecoveries: 1, recoveryAfterFixtureCompletionOnly: true,
      requestScopedQueryObserverPassThrough: true, observationProxiesRestored: true } },
  ...productionStopRecords(),
  ]
  records.splice(4, 0, { stage: 'automation-manual-recovery-ready', afterPoll: 1, sameRequest: true,
    consumerDone: true, requestSucceeded: true, readOnlyFixtureWait: true, maxWaitMs: 30000, elapsedMs: 500 })
  return records
}
const automationResult = records => records.find(record => record.stage === 'automation-manual-browser-and-authority-verified')

test('manual Automation acceptance requires the complete chain without mutating records or claiming editor authoring', () => {
  const records = automationRecords()
  const original = structuredClone(records)
  assert.doesNotThrow(() => validateAutomationEvidence(records))
  assert.deepEqual(records, original)
  records.splice(2, 0, { stage: 'synthetic-other-observation' })
  assert.doesNotThrow(() => validateAutomationEvidence(records))
})

test('manual Automation acceptance rejects missing, duplicate, reordered and malformed records', () => {
  for (const stage of ['automation-manual-fixture-ready', 'automation-manual-browser-and-authority-verified',
    'actual-stop-resolved', 'production-stop-verified']) {
    assert.throws(() => validateAutomationEvidence(automationRecords().filter(record => record.stage !== stage)), /AUTOMATION_STAGE_REQUIRED/u)
    const duplicate = automationRecords()
    duplicate.push(structuredClone(duplicate.find(record => record.stage === stage)))
    assert.throws(() => validateAutomationEvidence(duplicate), /AUTOMATION_STAGE_REQUIRED/u)
  }
  assert.throws(() => validateAutomationEvidence(automationRecords().reverse()), /AUTOMATION_STAGE_ORDER_INVALID/u)
  for (const value of [undefined, null, {}, false, 'synthetic']) {
    assert.throws(() => validateAutomationEvidence(value), /AUTOMATION_RECORDS_REQUIRED/u)
  }
  for (const value of [undefined, null, [], {}, false, { stage: 1 }]) {
    assert.throws(() => validateAutomationEvidence([...automationRecords(), value]), /AUTOMATION_RECORDS_REQUIRED/u)
  }
})

test('manual Automation acceptance rejects absent, repeated, relocated or unverified checkpoints', () => {
  for (const index of [1, 2, 6, 8, 9]) {
    const missing = automationRecords()
    missing.splice(index, 1)
    assert.throws(() => validateAutomationEvidence(missing), /AUTOMATION_CHECKPOINTS_REQUIRED/u)
    const duplicate = automationRecords()
    duplicate.splice(index, 0, { ...duplicate[index] })
    assert.throws(() => validateAutomationEvidence(duplicate), /AUTOMATION_CHECKPOINTS_REQUIRED/u)
    for (const value of [undefined, false, 'true', 1]) {
      const invalid = automationRecords()
      invalid[index].verified = value
      assert.throws(() => validateAutomationEvidence(invalid), /AUTOMATION_CHECKPOINT_INVALID/u)
    }
  }
  const reordered = automationRecords()
  ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
  assert.throws(() => validateAutomationEvidence(reordered), /AUTOMATION_CHECKPOINTS_REQUIRED/u)
  for (const position of ['before-fixture', 'after-result']) {
    const records = automationRecords()
    if (position === 'before-fixture') records.unshift(...records.splice(1, 1))
    else records.splice(10, 0, ...records.splice(9, 1))
    assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_CHECKPOINT_INVALID/u)
  }
  for (const stage of ['automation-manual-checkpoint-failed', 'automation-manual-observer-close-failed']) {
    assert.throws(() => validateAutomationEvidence([...automationRecords(), { stage }]), /AUTOMATION_FAILURE_REPORTED/u)
  }
})

test('manual Automation acceptance rejects each missing or downgraded setup, DOM and authority fact', () => {
  for (const group of ['setup', 'browser', 'authority']) {
    const original = automationRecords()
    const facts = group === 'setup' ? original[0] : automationResult(original)[group]
    for (const [key, expected] of Object.entries(facts)) {
      if (key === 'stage' || key.startsWith('sourceQuer')
        || ['detailPolls', 'verifiedBusyPolls', 'fixtureCompletionWaits', 'historyRecoveries'].includes(key)) continue
      const values = typeof expected === 'boolean' ? [undefined, !expected, String(expected), Number(expected), null]
        : [undefined, expected + 1, String(expected), false, null, -0]
      for (const value of values) {
        const records = automationRecords()
        const candidate = group === 'setup' ? records[0] : automationResult(records)[group]
        candidate[key] = value
        assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_(?:SETUP|BROWSER|AUTHORITY)_INVALID/u)
      }
    }
  }
  for (const group of ['browser', 'authority']) for (const value of [undefined, null, [], false]) {
    const records = automationRecords()
    automationResult(records)[group] = value
    assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_EVIDENCE_REQUIRED/u)
  }
  for (const value of [undefined, false, 'true', 1]) {
    const records = automationRecords()
    automationResult(records).businessSnapshotUnchanged = value
    assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_BUSINESS_CHANGED/u)
  }
})

test('manual Automation acceptance requires positive completed native SQL without inventing a fixed query count', () => {
  for (const value of [1, 6, 19, Number.MAX_SAFE_INTEGER]) {
    const records = automationRecords()
    automationResult(records).authority.sourceQueries = value
    automationResult(records).authority.sourceQueryCompletions = value
    assert.doesNotThrow(() => validateAutomationEvidence(records))
  }
  for (const key of ['sourceQueries', 'sourceQueryCompletions']) {
    for (const value of [undefined, null, 0, -1, 1.5, '6', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 7]) {
      const records = automationRecords()
      automationResult(records).authority[key] = value
      assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_NATIVE_QUERIES_REQUIRED/u)
    }
  }
})

test('manual detail refusal requires one exact request-scoped source-mirror 55P03, never an arbitrary 503', () => {
  for (const [key, values] of Object.entries({ poll: [undefined, 0, 2, '1'], httpStatus: [undefined, 200, 500, '503'],
    incomingRequests: [undefined, 0, 2, '1'], finishedResponses: [undefined, 0, 2, '1'],
    sourceMirrorQueries: [undefined, 0, 2, '1'], sourceMirror55P03: [undefined, 0, 2, '1'],
    otherQueryErrors: [undefined, 1, '0'], verified: [undefined, false, 'true'] })) {
    for (const value of values) {
      const records = automationRecords()
      records[3][key] = value
      assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_OBSERVATION_INVALID/u)
    }
  }
  const successWithLockError = automationRecords()
  successWithLockError[5].sourceMirror55P03 = 1
  assert.throws(() => validateAutomationEvidence(successWithLockError), /AUTOMATION_OBSERVATION_INVALID/u)
})

test('manual detail polls must be bounded, in-phase, one-to-one and end on success', () => {
  const absent = automationRecords().filter(record => record.stage !== 'automation-manual-observation')
  assert.throws(() => validateAutomationEvidence(absent), /AUTOMATION_OBSERVATIONS_REQUIRED/u)
  const duplicate = automationRecords()
  duplicate.splice(3, 0, { ...duplicate[3] })
  assert.throws(() => validateAutomationEvidence(duplicate), /AUTOMATION_OBSERVATION_INVALID/u)
  const outside = automationRecords()
  outside.unshift(...outside.splice(3, 1))
  assert.throws(() => validateAutomationEvidence(outside), /AUTOMATION_OBSERVATION_INVALID/u)
  const unresolved = automationRecords()
  unresolved[7].httpStatus = 503
  unresolved[7].sourceMirror55P03 = 1
  assert.throws(() => validateAutomationEvidence(unresolved), /AUTOMATION_FINAL_OBSERVATION_REQUIRED/u)
  const excessive = automationRecords()
  excessive.splice(3, 2, ...Array.from({ length: 61 }, (_, index) => ({ ...automationRecords()[5], poll: index + 1 })))
  assert.throws(() => validateAutomationEvidence(excessive), /AUTOMATION_OBSERVATIONS_REQUIRED/u)
  for (const group of ['browser', 'authority']) for (const field of ['detailPolls', 'verifiedBusyPolls']) {
    for (const value of [undefined, 0, 4, '1', false, null]) {
      const records = automationRecords()
      automationResult(records)[group][field] = value
      assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_OBSERVATION_TOTAL_INVALID/u)
    }
  }
})

test('manual detail success without contention makes no lock-cause claim', () => {
  const records = automationRecords()
  records[3].httpStatus = 200
  records[3].sourceMirror55P03 = 0
  records.splice(4, 1)
  for (const group of ['browser', 'authority']) {
    automationResult(records)[group].verifiedBusyPolls = 0
    automationResult(records)[group].fixtureCompletionWaits = 0
    automationResult(records)[group].historyRecoveries = 0
  }
  assert.doesNotThrow(() => validateAutomationEvidence(records))
})

test('history recovery requires one bounded fixture completion observation between refusal and reopening', () => {
  const missing = automationRecords().filter(record => record.stage !== 'automation-manual-recovery-ready')
  assert.throws(() => validateAutomationEvidence(missing), /AUTOMATION_RECOVERY_BOUND/u)
  const duplicate = automationRecords()
  duplicate.splice(4, 0, { ...duplicate[4] })
  assert.throws(() => validateAutomationEvidence(duplicate), /AUTOMATION_RECOVERY_BOUND/u)
  for (const [field, values] of Object.entries({ afterPoll: [undefined, 0, 2, '1'], sameRequest: [undefined, false, 'true'],
    consumerDone: [undefined, false, 'true'], requestSucceeded: [undefined, false, 'true'],
    readOnlyFixtureWait: [undefined, false, 'true'], maxWaitMs: [undefined, 15000, 30001, '30000'],
    elapsedMs: [undefined, -1, 30000, Infinity, 0.5, '500'] })) {
    for (const value of values) {
      const records = automationRecords()
      records[4][field] = value
      assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_RECOVERY_INVALID/u)
    }
  }
  for (const target of [0, 6]) {
    const records = automationRecords()
    records.splice(target, 0, ...records.splice(4, 1))
    assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_RECOVERY_INVALID/u)
  }
  for (const group of ['browser', 'authority']) for (const field of ['fixtureCompletionWaits', 'historyRecoveries']) {
    for (const value of [undefined, 0, 2, '1', false]) {
      const records = automationRecords()
      automationResult(records)[group][field] = value
      assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_RECOVERY_TOTAL_INVALID/u)
    }
  }
})

test('post-completion refresh must retain its own ALS observation and original bounded count', () => {
  const missing = automationRecords()
  missing.splice(7, 1)
  assert.throws(() => validateAutomationEvidence(missing), /AUTOMATION_FINAL_OBSERVATION_REQUIRED/u)
  for (const value of [undefined, false, 'true']) {
    const records = automationRecords()
    records[7].afterCompletion = value
    assert.throws(() => validateAutomationEvidence(records), /AUTOMATION_OBSERVATION_INVALID/u)
  }
  const moved = automationRecords()
  moved.splice(5, 0, ...moved.splice(7, 1))
  assert.throws(() => validateAutomationEvidence(moved), /AUTOMATION_OBSERVATION_INVALID/u)
})

test('recovery follows real history without resubmitting and extends only its bounded completion IPC frame', () => {
  const browser = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-browser.ts')
  assert.match(browser, /checkpoint\(\{ phase: 'await-completed', grantId, requestId \}\)/u)
  assert.match(browser, /getByTestId\('automation-read-history-only'\)\.click\(\)/u)
  assert.match(browser, /getByTestId\('automation-read-open-grant'\)/u)
  assert.equal((browser.match(/getByTestId\('automation-read-submit'\)\.click\(\)/gu) ?? []).length, 1)
  const bridge = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  assert.match(bridge, /getByTestId\('automation-read-open-request'\)/u)
  assert.match(bridge, /getByTestId\('automation-read-current-request'\)\.count\(\) === 0/u)
  assert.match(bridge, /getByTestId\('automation-read-current-grant'\)\.count\(\) === 0/u)
  assert.match(bridge, /getByTestId\('automation-read-refresh-request'\)\.count\(\) === 0/u)
  assert.doesNotMatch(bridge, /getByTestId\('automation-read-refresh-request'\)\.isEnabled\(\)/u)
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-fixture.ts')
  assert.match(fixture, /Math\.min\(started \+ 30000, detailDeadline\)/u)
  assert.match(fixture, /row\.consumer_status === 'done'/u)
  assert.match(fixture, /APP_AUTOMATION_RECOVERY_TERMINAL_REFUSAL/u)
  assert.match(fixture, /APP_AUTOMATION_HISTORY_RECOVERY_REREAD_SOURCE/u)
  const ui = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-ui.mts')
  assert.match(ui, /id <= 126/u)
  assert.match(ui, /CHECKPOINT_TIMEOUT'\)\) \},\r?\n\s*command\.phase === 'await-completed' \|\| command\.phase === 'interval-completed' \? 35000\r?\n\s*:\s*\['interval-preactivation-tick', 'interval-admitted', 'interval-budget-tick'\]\.includes\(command\.phase\) \? 40000 : 20000\)/u)
})

test('readiness diagnostics sample the existing query without additional SQL, lock clauses or timeout expansion', () => {
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-fixture.ts')
  const block = fixture.slice(fixture.indexOf("if (command.phase === 'await-completed')"),
    fixture.indexOf("if (command.phase === 'observe-begin'"))
  assert.equal((block.match(/\bquery\(/gu) ?? []).length, 1)
  assert.doesNotMatch(block, /FOR UPDATE|FOR SHARE|pg_sleep|pg_stat_activity|pg_locks/u)
  assert.match(block, /Math\.min\(started \+ 30000, detailDeadline\)/u)
  assert.match(block, /setInterval\(\(\) => diagnostic\('sample'\), 1000\)/u)
  assert.match(block, /diagnosticTimer\.unref\(\)/u)
  assert.match(block, /finally \{ clearInterval\(diagnosticTimer\) \}/u)
  assert.match(block, /diagnostic\(performance\.now\(\) >= deadline \? 'timeout' : 'failed'\)\r?\n\s*throw error/u)
  assert.match(block, /row\.consumer_status === 'done'[\s\S]*?assert\.equal\(row\.request_status, 'succeeded'/u)
  assert.match(block, /assert\.deepEqual\(row\.result, expectedPreview\)/u)
})

test('readiness diagnostic output contains only closed enums and counts, never raw source or connection material', () => {
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-fixture.ts')
  const projection = fixture.slice(fixture.indexOf('const diagnostic ='), fixture.indexOf("diagnostic('start')"))
  for (const field of ['requestState', 'consumerState', 'metadataError', 'afterPoll', 'elapsedMs', 'rowCount', 'attempts',
    'metadataStarted', 'metadataCompleted', 'metadataRejected', 'metadataPending', 'nativeCalls', 'nativeCompleted',
    'nativeRejected', 'nativePending', 'hostPoolTotal', 'hostPoolIdle', 'hostPoolWaiting',
    'sourcePoolTotal', 'sourcePoolIdle', 'sourcePoolWaiting']) assert.ok(projection.includes(field))
  assert.doesNotMatch(projection, /\.\.\.|requestId|grantId|connectionId|tenantId|ownerToken|request_status|consumer_status|\.result|\.query/u)
  assert.match(fixture, /typeof observed\?\.request_status === 'string'/u)
  assert.match(fixture, /typeof observed\?\.consumer_status === 'string'/u)
  assert.match(fixture, /metadataError = code === '55P03' \? 'lock-unavailable' : code === '40P01' \? 'deadlock'/u)
  const verifier = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assert.match(verifier, /reportReadiness: data => stage\(`\$\{automationStage\}-readiness-diagnostic`, \{ \.\.\.data \}\)/u)
})

const intervalPhases = ['interval-before-authoring', 'interval-authored', 'interval-preactivation-tick', 'interval-activated',
  'interval-admitted', 'interval-completed', 'interval-budget-tick', 'interval-refreshed', 'interval-revoked']
const intervalStage = name => 'automation-interval-' + name
const intervalResult = records => records.find(record => record.stage === intervalStage('browser-and-authority-verified'))
const intervalRecords = () => {
  const records = [{ stage: intervalStage('fixture-ready'), noPrecreatedRule: true,
    dedicatedOneShotPermit: true, hostProfileRegistered: true, intervalOnly: true }]
  for (const [index, phase] of intervalPhases.entries()) {
    if (index === 2 || index === 6) {
      const exhausted = index === 6
      records.push({ stage: intervalStage('natural-tick'), phase: exhausted ? 'budget-exhausted' : 'preactivation',
        intervalMs: 30000, maxWaitMs: 35000, elapsedMs: 1000, realCandidateQueries: 1, returnedCandidates: 0,
        phaseAligned: true, plannedDueByDatabase: true, ruleUnchanged: true, grantActiveAndUnexpired: exhausted,
        maxExecutions: exhausted ? 1 : 0, usedExecutions: exhausted ? 1 : 0,
        requests: exhausted ? 1 : 0, sourceOperations: exhausted ? 1 : 0,
        afterTerminal: exhausted, sourceQueries: exhausted ? 6 : 0 })
    }
    if (index === 4) records.push({ stage: intervalStage('natural-tick'), phase: 'admitted', intervalMs: 30000,
      maxWaitMs: 35000, elapsedMs: 1000, realCandidateQueries: 1, returnedCandidates: 1,
      phaseAligned: true, plannedDueByDatabase: true, strictlyAfterActivation: true, invocationHashMatched: true })
    if (index === 5) records.push({ stage: intervalStage('natural-tick'), phase: 'completed', maxWaitMs: 30000,
      elapsedMs: 1000, sameRequest: true, consumerDone: true, consumerAttempts: 1, requestSucceeded: true, readOnlyFixtureWait: true })
    if (index === 7) for (const poll of [1, 2]) records.push({ stage: intervalStage('observation'), poll,
      httpStatus: 200, incomingRequests: 1, finishedResponses: 1, sourceMirrorQueries: 1, sourceMirror55P03: 0,
      otherQueryErrors: 0, verified: true, afterCompletion: true })
    records.push({ stage: intervalStage('checkpoint'), phase, verified: true })
  }
  records.push({ stage: intervalStage('browser-and-authority-verified'), businessSnapshotUnchanged: true,
    browser: { realFullAppOwnerPanel: true, realBoardWorkbenchNavigation: true, emptyProjectBoardRefused: true,
      ruleEditorDomVerified: true, realEmptyFillView: true, explicitScheduleConsent: true, activationThroughDom: true,
      manualSubmitAbsent: true, naturalRequestObserved: true, succeededCountsRendered: true, canApplyFalse: true,
      refreshThroughDom: true, revokeThroughDom: true, historyAfterFixtureCompletionOnly: true,
      boundedBudgetTickBeforeRevoke: true, detailPolls: 2, responseStubs: 0, storageInjections: 0,
      verifiedBusyPolls: 0, automaticActivations: 1, intervalMs: 30000 },
    authority: { ruleEditorDomVerified: true, independentOneShotPermit: true, emptyProjectNoTargetOrArchive: true,
      ruleRevisionConfigAnchorOwnerVerified: true, activationBoundToRule: true, realNaturalSchedule: true,
      preactivationTickZeroSourceIo: true, exhaustedActiveGrantTickZeroSourceIo: true,
      realOutboxConsumerNativeSql: true, readonlyCountsPersisted: true, refreshZeroSourceIo: true, revokeZeroSourceIo: true,
      sessionAndRevokedRequestsDenied: true, deniedRequestsZeroSourceIo: true, noNewApplyToken: true,
      sourceQueryObserverPassThrough: true, requestScopedQueryObserverPassThrough: true, candidateQueryObserverPassThrough: true,
      observationProxiesRestored: true,
      requests: 1, grants: 1, automaticActivations: 1, nativeReadOperations: 1, detailPolls: 2,
      naturalTickNegatives: 2, maxExecutions: 1, usedExecutions: 1, historyAfterFixtureCompletionOnly: true,
      sourceQueries: 6, sourceQueryCompletions: 6 } }, ...productionStopRecords())
  return records
}
const validateInterval = records => validateAutomationEvidence(records, 'interval')

test('interval Automation accepts the independent DOM-to-natural-timer chain without changing its records', () => {
  const records = intervalRecords()
  const original = structuredClone(records)
  assert.doesNotThrow(() => validateInterval(records))
  assert.deepEqual(records, original)
  records.splice(2, 0, { stage: 'synthetic-other-observation' })
  assert.doesNotThrow(() => validateInterval(records))
  assert.doesNotThrow(() => validateAutomationEvidence(automationRecords(), 'manual'))
})

test('interval browser diagnostics stay outside the closed authority marker namespace', () => {
  for (const stage of ['browser-interval-owner-controls', 'browser-interval-home-directory', 'browser-api-denied']) {
    const records = intervalRecords()
    records.splice(2, 0, { stage })
    assert.doesNotThrow(() => validateInterval(records))
    records[2].stage = stage.replace(/^browser-/u, 'automation-interval-')
    assert.throws(() => validateInterval(records), /INTERVAL_UNKNOWN_OR_FAILURE_MARKER/u)
  }
  const helper = read('packages/core-backend/tests/utils/stock-preparation-automation-interval-full-app-browser.ts')
  assert.doesNotMatch(helper, /stage: 'automation-interval-/u)
})

test('Automation scenario dispatch rejects unknown enum values and cross-scenario marker substitution', () => {
  for (const scenario of ['', null, false, {}, [], 1, 'schedule', 'INTERVAL', 'interval ', 'manual|interval']) {
    assert.throws(() => validateAutomationEvidence(intervalRecords(), scenario), /AUTOMATION_SCENARIO_INVALID/u)
  }
  assert.throws(() => validateAutomationEvidence(intervalRecords()), /AUTOMATION_SCENARIO_MISMATCH/u)
  assert.throws(() => validateInterval(automationRecords()), /AUTOMATION_SCENARIO_MISMATCH/u)
  for (const scenario of ['manual', 'interval']) {
    const own = scenario === 'manual' ? automationRecords : intervalRecords
    const opposite = scenario === 'manual' ? 'interval' : 'manual'
    for (const suffix of ['fixture-ready', 'browser-and-authority-verified', 'checkpoint', 'observation', 'unknown']) {
      assert.throws(() => validateAutomationEvidence([...own(), { stage: `automation-${opposite}-${suffix}` }], scenario),
        /AUTOMATION_SCENARIO_MISMATCH/u)
    }
  }
})

test('interval Automation rejects missing, duplicate, reordered, malformed and failure markers', () => {
  for (const name of [intervalStage('fixture-ready'), intervalStage('browser-and-authority-verified'),
    'actual-stop-resolved', 'production-stop-verified']) {
    assert.throws(() => validateInterval(intervalRecords().filter(record => record.stage !== name)), /INTERVAL_STAGE_REQUIRED/u)
    const duplicate = intervalRecords()
    duplicate.push(structuredClone(duplicate.find(record => record.stage === name)))
    assert.throws(() => validateInterval(duplicate), /INTERVAL_STAGE_REQUIRED/u)
  }
  assert.throws(() => validateInterval(intervalRecords().reverse()), /INTERVAL_STAGE_ORDER_INVALID/u)
  for (const value of [undefined, null, {}, false, 'synthetic']) {
    assert.throws(() => validateInterval(value), /AUTOMATION_RECORDS_REQUIRED/u)
  }
  for (const value of [undefined, null, [], {}, false, { stage: 1 }]) {
    assert.throws(() => validateInterval([...intervalRecords(), value]), /AUTOMATION_RECORDS_REQUIRED/u)
  }
  for (const suffix of ['checkpoint-failed', 'observer-close-failed', 'unknown', 'recovery-ready', 'readiness-diagnostic']) {
    assert.throws(() => validateInterval([...intervalRecords(), { stage: intervalStage(suffix) }]),
      /INTERVAL_UNKNOWN_OR_FAILURE_MARKER/u)
  }
})

test('interval Automation requires nine unique verified checkpoints in the original phase order', () => {
  for (const phase of intervalPhases) {
    const select = records => records.findIndex(record => record.stage === intervalStage('checkpoint') && record.phase === phase)
    const missing = intervalRecords()
    missing.splice(select(missing), 1)
    assert.throws(() => validateInterval(missing), /INTERVAL_CHECKPOINTS_REQUIRED/u)
    const duplicate = intervalRecords()
    duplicate.splice(select(duplicate), 0, { ...duplicate[select(duplicate)] })
    assert.throws(() => validateInterval(duplicate), /INTERVAL_CHECKPOINTS_REQUIRED/u)
    for (const value of [undefined, false, 1, 'true', null]) {
      const records = intervalRecords()
      records[select(records)].verified = value
      assert.throws(() => validateInterval(records), /INTERVAL_CHECKPOINT_INVALID/u)
    }
  }
  const reordered = intervalRecords()
  ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
  assert.throws(() => validateInterval(reordered), /INTERVAL_CHECKPOINTS_REQUIRED/u)
  const early = intervalRecords()
  early.unshift(...early.splice(1, 1))
  assert.throws(() => validateInterval(early), /INTERVAL_CHECKPOINT_INVALID/u)
  const late = intervalRecords()
  const last = late.findIndex(record => record.phase === 'interval-revoked')
  late.splice(last + 1, 0, ...late.splice(last, 1))
  assert.throws(() => validateInterval(late), /INTERVAL_CHECKPOINT_INVALID/u)
})

test('interval Automation requires each exact setup, DOM and authority fact without coercion', () => {
  for (const group of ['setup', 'browser', 'authority']) {
    const select = records => group === 'setup' ? records[0] : intervalResult(records)[group]
    for (const [key, expected] of Object.entries(select(intervalRecords()))) {
      if (key === 'stage' || ['sourceQueries', 'sourceQueryCompletions'].includes(key)) continue
      const values = typeof expected === 'boolean' ? [undefined, !expected, String(expected), Number(expected), null]
        : [undefined, expected + 1, String(expected), false, null, -0]
      for (const value of values) {
        const records = intervalRecords()
        select(records)[key] = value
        assert.throws(() => validateInterval(records), /INTERVAL_(?:SETUP|BROWSER|AUTHORITY)_INVALID/u)
      }
      const records = intervalRecords()
      delete select(records)[key]
      assert.throws(() => validateInterval(records), /INTERVAL_(?:SETUP|BROWSER|AUTHORITY)_INVALID/u)
    }
  }
  for (const group of ['browser', 'authority']) for (const value of [undefined, null, [], false]) {
    const records = intervalRecords()
    intervalResult(records)[group] = value
    assert.throws(() => validateInterval(records), /INTERVAL_(?:BROWSER|AUTHORITY)_INVALID/u)
  }
  for (const value of [undefined, false, 'true', 1, null]) {
    const records = intervalRecords()
    intervalResult(records).businessSnapshotUnchanged = value
    assert.throws(() => validateInterval(records), /INTERVAL_BUSINESS_CHANGED/u)
  }
})

test('interval natural tick evidence is complete, unique, ordered and enclosed by its authority checkpoints', () => {
  for (const phase of ['preactivation', 'admitted', 'completed', 'budget-exhausted']) {
    const select = records => records.findIndex(record => record.stage === intervalStage('natural-tick') && record.phase === phase)
    const missing = intervalRecords()
    missing.splice(select(missing), 1)
    assert.throws(() => validateInterval(missing), /INTERVAL_TICKS_REQUIRED/u)
    const duplicate = intervalRecords()
    duplicate.splice(select(duplicate), 0, { ...duplicate[select(duplicate)] })
    assert.throws(() => validateInterval(duplicate), /INTERVAL_TICKS_REQUIRED/u)
    for (const direction of [-1, 1]) {
      const moved = intervalRecords()
      const at = select(moved)
      moved.splice(at + direction, 0, ...moved.splice(at, 1))
      assert.throws(() => validateInterval(moved), /INTERVAL_TICK_ORDER_INVALID/u)
    }
    for (const [key, expected] of Object.entries(intervalRecords()[select(intervalRecords())])) {
      if (['stage', 'phase', 'elapsedMs'].includes(key)) continue
      const values = typeof expected === 'boolean' ? [undefined, !expected, String(expected), Number(expected), null]
        : [undefined, expected + 1, String(expected), false, null, -0]
      for (const value of values) {
        const records = intervalRecords()
        records[select(records)][key] = value
        assert.throws(() => validateInterval(records), /INTERVAL_TICK_INVALID/u)
      }
    }
  }
  const reordered = intervalRecords()
  const ticks = reordered.flatMap((record, index) => record.stage === intervalStage('natural-tick') ? [index] : [])
  ;[reordered[ticks[0]], reordered[ticks[1]]] = [reordered[ticks[1]], reordered[ticks[0]]]
  assert.throws(() => validateInterval(reordered), /INTERVAL_TICKS_REQUIRED/u)
})

test('interval waits retain separate finite natural occurrence and original consumer completion bounds', () => {
  for (const phase of ['preactivation', 'admitted', 'completed', 'budget-exhausted']) {
    const select = records => records.find(record => record.stage === intervalStage('natural-tick') && record.phase === phase)
    const limit = phase === 'completed' ? 30000 : 35000
    for (const value of [0, limit - 1]) {
      const records = intervalRecords()
      select(records).elapsedMs = value
      assert.doesNotThrow(() => validateInterval(records))
    }
    for (const value of [undefined, null, false, '1000', -1, 0.5, NaN, Infinity, limit, limit + 1]) {
      const records = intervalRecords()
      select(records).elapsedMs = value
      assert.throws(() => validateInterval(records), /INTERVAL_TICK_WAIT_INVALID/u)
    }
  }
})

test('interval native SQL is positive and complete, and the terminal budget tick cannot hide a reread', () => {
  for (const count of [1, 6, 19, Number.MAX_SAFE_INTEGER]) {
    const records = intervalRecords()
    intervalResult(records).authority.sourceQueries = count
    intervalResult(records).authority.sourceQueryCompletions = count
    records.find(record => record.phase === 'budget-exhausted').sourceQueries = count
    assert.doesNotThrow(() => validateInterval(records))
  }
  for (const key of ['sourceQueries', 'sourceQueryCompletions']) {
    for (const value of [undefined, null, 0, -1, 1.5, '6', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 7]) {
      const records = intervalRecords()
      intervalResult(records).authority[key] = value
      assert.throws(() => validateInterval(records), /INTERVAL_NATIVE_QUERIES_REQUIRED/u)
    }
  }
  for (const count of [0, 5, 7, '6']) {
    const records = intervalRecords()
    records.find(record => record.phase === 'budget-exhausted').sourceQueries = count
    assert.throws(() => validateInterval(records), /INTERVAL_TICK_INVALID/u)
  }
})

test('interval history and refresh require exactly two post-terminal request-scoped successful observations', () => {
  const select = records => records.flatMap((record, index) => record.stage === intervalStage('observation') ? [index] : [])
  for (const ordinal of [0, 1]) {
    const missing = intervalRecords()
    missing.splice(select(missing)[ordinal], 1)
    assert.throws(() => validateInterval(missing), /INTERVAL_OBSERVATIONS_REQUIRED/u)
    const duplicate = intervalRecords()
    duplicate.splice(select(duplicate)[ordinal], 0, { ...duplicate[select(duplicate)[ordinal]] })
    assert.throws(() => validateInterval(duplicate), /INTERVAL_OBSERVATIONS_REQUIRED/u)
    for (const [key, expected] of Object.entries(intervalRecords()[select(intervalRecords())[ordinal]])) {
      if (key === 'stage') continue
      const values = typeof expected === 'boolean' ? [undefined, !expected, String(expected), Number(expected), null]
        : [undefined, expected + 1, String(expected), false, null, -0]
      for (const value of values) {
        const records = intervalRecords()
        records[select(records)[ordinal]][key] = value
        assert.throws(() => validateInterval(records), /INTERVAL_OBSERVATION_INVALID/u)
      }
    }
  }
  const refused = intervalRecords()
  Object.assign(refused[select(refused)[0]], { httpStatus: 503, sourceMirror55P03: 1 })
  assert.throws(() => validateInterval(refused), /INTERVAL_OBSERVATION_INVALID/u)
  for (const after of [false, true]) {
    const moved = intervalRecords()
    const observation = moved.splice(select(moved)[after ? 1 : 0], 1)[0]
    const boundary = moved.findIndex(record => record.phase === (after ? 'interval-refreshed' : 'interval-budget-tick'))
    moved.splice(boundary + (after ? 1 : 0), 0, observation)
    assert.throws(() => validateInterval(moved), /INTERVAL_OBSERVATION_INVALID/u)
  }
})

test('interval public markers reject extra keys rather than carrying opaque handles or widening evidence', () => {
  const original = intervalRecords()
  for (const [index, record] of original.entries()) {
    if (!record.stage.startsWith(intervalStage(''))) continue
    const records = intervalRecords()
    records[index].unexpected = 'synthetic-private-value'
    assert.throws(() => validateInterval(records), /AUTOMATION_INTERVAL_/u)
  }
  for (const group of ['browser', 'authority']) {
    const records = intervalRecords()
    intervalResult(records)[group].unexpected = 'synthetic-private-value'
    assert.throws(() => validateInterval(records), /INTERVAL_(?:BROWSER|AUTHORITY)_INVALID/u)
  }
})

test('formal runner forwards a closed scenario as verifier argv and records it without an environment flag', () => {
  const source = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const body = source.slice(source.indexOf('export async function runAcceptance'))
  assert.match(body, /const automationScenario = options\.automationScenario \?\? 'manual'/u)
  assert.match(body, /assert\(\['manual', 'interval'\]\.includes\(automationScenario\)/u)
  assert.match(body, /verify-stock-preparation-plm-full-app\.mts'\),\r?\n\s*`--automation-scenario=\$\{automationScenario\}`\]/u)
  assert.match(body, /validateAutomationEvidence\(records, automationScenario\)/u)
  assert.match(body, /failure, cleanup, stages, automationScenario,/u)
  assert.match(body, /const nonce = randomUUID\(\)/u)
  assert.doesNotMatch(body, /(?:process\.env|runtimeEnv)\.(?:AUTOMATION_SCENARIO|PLM_FULL_APP_AUTOMATION_SCENARIO)/u)
})

test('interval composition preserves manual selection, private scenario input and bounded checkpoint replies', () => {
  const verifier = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assert.match(verifier, /assert\(process\.argv\.length === 3 && \['--automation-scenario=manual', '--automation-scenario=interval'\]\.includes\(process\.argv\[2\]\)/u)
  assert.match(verifier, /automation = await \(automationScenario === 'interval' \? createAutomationIntervalFullAppFixture : createAutomationFullAppFixture\)\(/u)
  assert.match(verifier, /automation: \{ \.\.\.automation!\.browserInput, scenario: automationScenario \}/u)
  assert.match(verifier, /authorityCheckpoints === \(automationScenario === 'interval' \? 9 : 5\)/u)
  assert.match(verifier, /reportTick: data => stage\('automation-interval-natural-tick', data\)/u)
  assert.match(verifier, /const reply = await automation\.checkpoint\(frame\.command\)/u)
  assert.match(verifier, /await automation\.verify\(automationResult\)[\s\S]*?automation\.dispose\(\)[\s\S]*?observationProxiesRestored: true/u)
  assert.doesNotMatch(verifier, /process\.env\.(?:AUTOMATION_SCENARIO|PLM_FULL_APP_AUTOMATION_SCENARIO)/u)
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  assert.match(browser, /check\(\['manual', 'interval'\]\.includes\(input\.automation\.scenario\)/u)
  assert.match(browser, /input\.automation\.scenario === 'interval' \? runConfiguredIntervalBrowser : runConfiguredAutomationBrowser/u)
  assert.match(browser, /input\.automation\.scenario === 'interval' \? \{ editorRules: 1, automationScheduleActivation: 1, automationRevoke: 1 \}/u)
  assert.match(browser, /: \{ automationGrants: 1, automationRequests: 1, automationRevoke: 1 \}/u)
  const ui = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-ui.mts')
  assert.match(ui, /expectsRequest: command\.phase === 'interval-admitted'/u)
  assert.match(ui, /Object\.keys\(response\)\.sort\(\), \['id', 'ok', \.\.\.\(pending\.expectsRequest && response\.ok \? \['requestId'\] : \[\]\)\]\.sort\(\)/u)
})

test('interval helper authors via the production DOM and observes natural ticks without adding a source permit', () => {
  const browser = read('packages/core-backend/tests/utils/stock-preparation-automation-interval-full-app-browser.ts')
  for (const token of ["getByTestId('stock-prep-project-board-open-multitable').click()",
    "'[data-automation-new-rule=\"advanced\"]'", "'input[data-field=\"name\"]'", "'input[data-field=\"intervalSeconds\"]'",
    "'[data-action=\"save\"]'", "getByTestId('automation-read-schedule-confirm').check()",
    "getByTestId('automation-read-activate-schedule').click()", "getByTestId('automation-read-submit').isDisabled()"])
    assert.ok(browser.includes(token), 'interval production DOM path must remain present')
  for (const oldSelector of ['[data-field="name"] input', '[data-field="intervalSeconds"] input'])
    assert.ok(!browser.includes(oldSelector), 'ElementPlus data-field belongs to the native input, not its parent')
  assert.match(browser, /throw new Error\(`APP_BROWSER_INTERVAL_EDITOR_\$\{step\}_FAILED`\)/u)
  assert.match(browser, /Number\(option\.budget\.timeoutMs\) <= 25000/u)
  assert.doesNotMatch(browser, /\bfetch\(|\.evaluate\(|\.route\(|\.fulfill\(|\.dispatch(?:Event|Invocation)\(|getByTestId\('automation-read-submit'\)\.click/u)
  assert(browser.indexOf("phase: 'interval-budget-tick'") < browser.indexOf("getByTestId('automation-read-revoke').click()"))
  assert(browser.indexOf("phase: 'interval-completed'") < browser.indexOf("getByTestId('automation-read-history-only').click()"))
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-interval-full-app-fixture.ts')
  assert.match(fixture, /assert\.equal\(await count\('automation_rules'\), 0/u)
  assert.match(fixture, /sql\.replace\([^\n]+!== candidateSql/u)
  assert.match(fixture, /values\[0\] !== ruleId/u)
  assert.match(fixture, /values\[2\] !== 'schedule.interval'/u)
  assert.match(fixture, /ticks\.slice\(after\)\.find\(value => value\.completed && \(ordinal !== 6 \|\| value\.began > terminalAt\)\)/u)
  assert.match(fixture, /assert\(aligned\(tick\)\); assert\.deepEqual\(tick\.ids, \[\]\)/u)
  assert.match(fixture, /pg_catalog\.to_timestamp\(\$1::double precision\/1000\)<=pg_catalog\.clock_timestamp\(\) AS due/u)
  assert.match(fixture, /pg_catalog\.to_timestamp\(\$2::double precision\/1000\)>activated_at/u)
  assert.match(fixture, /assert\.equal\(row\.max_executions, 1\); assert\.equal\(row\.used_executions, expectedUsed\)/u)
  assert.match(fixture, /sourceQueries: nativeCalls/u)
  assert.match(fixture, /assert\.equal\(nativeCalls, completedCount, 'APP_AUTOMATION_INTERVAL_REREAD_SOURCE'\)/u)
  assert.doesNotMatch(fixture, /\b(?:produceSchedule|produceReadSchedule|dispatchInvocation|registerReadInterval|useFakeTimers|setSystemTime)\s*\(|INSERT INTO|UPDATE automation_rules|DELETE FROM|pg_sleep|vi\.(?:mock|spyOn)/u)
  const plm = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-fixture.ts')
  assert.match(plm, /registrations: \['stock-preparation\.read-plan-validation', 'stock-preparation\.table-action', 'stock-preparation\.automation-preview'\]\.map/u)
  assert.match(plm, /forbidReuse: true, sourceReadOperationLimit: 1/u)
  assert.match(plm, /createB2aRegistry\(\{ config: \{ b2aTrialRegistry: registry \} \}\)\.registrationCount, 3/u)
})

test('interval router return waits for the original real board and handoff before changing project scope', () => {
  const helper = read('packages/core-backend/tests/utils/stock-preparation-automation-interval-full-app-browser.ts')
  const returning = helper.slice(helper.indexOf('// Browser history returns'), helper.indexOf('export async function runConfiguredIntervalBrowser'))
  assert.match(helper, /new URL\(boardUrl\)\.searchParams\.get\('projectNo'\) === input\.projectNo/u)
  assert.match(returning, /const returningBoardResponse = waitApi\('yidaBoard', 'GET',/u)
  assert.match(returning, /const returningHandoffResponse = waitApi\('handoff'\)/u)
  assert(returning.indexOf('const returningBoardResponse') < returning.indexOf("getByTestId('stock-prep-tab-project-board').click()"))
  assert(returning.indexOf('const returningHandoffResponse') < returning.indexOf("getByTestId('stock-prep-tab-project-board').click()"))
  for (const token of ['await data(await returningBoardResponse)', 'await data(await returningHandoffResponse)',
    'returningBoard.projectNo === input.projectNo', 'returningBoard.tenantId === input.tenantId',
    'returningBoard.activePulledRowCount === 0', 'returningBoard.archivedSnapshotPresent === false',
    'returningBoard.fillTarget.sheetId === input.sheetId', 'returningBoard.fillTarget.viewId === input.viewId',
    'returningHandoff.configured === false', "getByTestId('stock-prep-project-board-title')"])
    assert(returning.includes(token), 'returning real board must be verified before returning its rule handle')
  assert(returning.indexOf('await data(await returningHandoffResponse)') < returning.indexOf('return ruleId'))
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  assert(browser.indexOf('automationRuleId = await authorConfiguredIntervalRule(') < browser.indexOf('boardProject = input.projectNo'))
  const allowlist = browser.slice(browser.indexOf('const allowedApi ='), browser.indexOf("await context.route('**/*'"))
  assert.doesNotMatch(allowlist, /EDITOR_RULE_(?:STATS|LOGS)|OTHER_MULTITABLE|OTHER_STOCK_PREPARATION/u)
  assert.match(allowlist, /url\.pathname === apiPaths\.projects \+ '\/' \+ boardProject \+ '\/board'/u)
  const denied = browser.slice(browser.indexOf('const routeCategory ='), browser.indexOf('// Only disclose static lower-case route words'))
  assert.match(denied, /stage: 'browser-api-denied', routeCategory/u)
  for (const flag of ['queryEmpty', 'tenantMatches', 'workspacePresent', 'sheetMatches', 'viewMatches',
    'activeBoardMatches', 'yidaBoardMatches', 'automationBoardMatches', 'exactBoardQuery'])
    assert(denied.includes(flag + ':'), 'denial diagnostic retains fixed scope-match flags')
  assert.doesNotMatch(denied, /^\s*(?:url|pathname|query|tenantId|projectNo|sheetId|viewId|body|headers|message):/mu)
})

test('interval restores the real home-directory target and diagnoses disabled owner controls without preflight or injection', () => {
  const helper = read('packages/core-backend/tests/utils/stock-preparation-automation-interval-full-app-browser.ts')
  const returning = helper.slice(helper.indexOf('const beforeHome ='), helper.indexOf('export async function runConfiguredIntervalBrowser'))
  assert.match(returning, /const beforeHome = capabilities\.observedHomeDirectory\(\)/u)
  assert.match(returning, /getByTestId\('stock-prep-project-board-back-home'\)\.click\(\)/u)
  assert.match(returning, /const afterHome = capabilities\.observedHomeDirectory\(\)/u)
  assert.match(returning, /afterHome\.responseCount >= beforeHome\.responseCount/u)
  assert.match(returning, /const directory = afterHome\.data/u)
  for (const fact of ['directory.tenantId === input.tenantId', 'directory.pullTargetReady === true',
    'directory.directoryMayBeIncomplete === false', 'directory.pullTargetScanCapped === false',
    'directory.fillTarget.sheetId === input.sheetId', 'directory.fillTarget.viewId === input.viewId',
    "getByTestId('stock-prep-operator-home-open-multitable').waitFor()"])
    assert(returning.includes(fact), 'observed real directory target must be verified before opening the empty project')
  assert(returning.indexOf("getByTestId('stock-prep-operator-home-open-multitable').waitFor()") < returning.indexOf('const afterHome'))
  assert.match(returning, /stage: 'browser-interval-home-directory'/u)
  assert.match(returning, /priorResponseEvidenceRetained: afterHome\.responseCount === beforeHome\.responseCount/u)
  assert.match(returning, /cacheInspected: false/u)
  assert.doesNotMatch(returning, /waitApi\('operatorProjects'\)/u)
  assert.doesNotMatch(helper, /stock-prep-install-preflight-run|resetStockPreparationOperatorHomeDirectoryThrottle|waitForTimeout|useFakeTimers|setSystemTime|\.evaluate\(|\.fulfill\(/u)
  assert(helper.includes('if (error instanceof Error && /^APP_BROWSER_[A-Z_]+$/.test(error.message)) throw error'))
  const owner = helper.slice(helper.indexOf('export async function runConfiguredIntervalBrowser'))
  assert.match(owner, /stage: 'browser-interval-owner-controls', \.\.\.controls/u)
  assert(owner.indexOf("check(controls.loadEnabled, 'OWNER_LOAD_DISABLED')") < owner.indexOf("waitApi('automationOptions')"))
  assert.match(owner, /check\(!controls\.missingContextMessage, 'OWNER_TARGET_CONTEXT_UNAVAILABLE'\)/u)
  assert.match(owner, /check\(!controls\.signedOutMessage, 'OWNER_SIGNED_OUT'\)/u)
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  const capture = browser.slice(browser.indexOf("if (input.automation.scenario === 'interval' && key === 'operatorProjects'"), browser.indexOf('successes[key] += 1'))
  assert.match(capture, /response\.request\(\)\.method\(\) === 'GET'/u)
  assert.match(capture, /target\.search === '\?' \+ new URLSearchParams\(\{ tenantId: input\.tenantId, includePullTargets: '1' \}\)/u)
  assert.match(capture, /response\.status\(\) === 200 && response\.request\(\)\.postData\(\) === null/u)
  assert.match(capture, /payload\.ok === true && object\(payload\.data\)/u)
  assert.match(capture, /observedHomeDirectory = \{ responseCount: \(observedHomeDirectory\?\.responseCount \?\? 0\) \+ 1, data: payload\.data \}/u)
  assert.match(browser, /observedHomeDirectory: \(\) => observedHomeDirectory/u)
  assert.match(browser, /key === 'operatorProjects' && input\.automation\.scenario === 'interval' && phase === 'AUTOMATION_INTERVAL_EDITOR'/u)
  assert.match(browser, /return request\.method\(\) === 'GET' && \(url\.search === plain \|\| url\.search === home\)/u)
})

const diagnosticApiKeys = [
  'login', 'me', 'dingTalkProbe', 'plugins', 'todoCount', 'approvalCapability', 'methodProbe', 'adapters',
  'externalSystems', 'stagingDescriptors', 'tableActions', 'hubOverview', 'readSourceConfigs', 'readSourceCompositions',
  'manifest', 'preflight', 'sourceBinding', 'roleCatalog', 'dataSources', 'plans', 'projects', 'operatorProjects',
  'handoff', 'preview', 'automationOptions', 'automationGrants', 'automationRequests', 'automationScheduleActivation',
  'editorContext', 'editorFields', 'editorView', 'editorBases', 'editorAiAvailability', 'editorMentionSummary',
  'editorUnreadCount', 'editorSubscriptionCount', 'editorDingtalkGroups', 'editorApprovalTemplates', 'editorSheets',
  'conflictPolicies', 'validate', 'confirmSample', 'approve', 'activate', 'k3Approve', 'k3Read', 'yidaBoard',
  'automationGrantDetail', 'automationRequestDetail', 'automationRevoke', 'editorRules',
]
const diagnosticStages = ['REQUEST_FAILED', 'API_ROUTE', 'API_BODY', 'API_DETAIL', 'API_EMPTY_BOARD', 'API_STATUS',
  'API_SHAPE', 'API_ENVELOPE', 'API_PLUGIN', 'API_TODO', 'API_ACTIONS', 'API_DIRECTORY',
  'BUNDLE_SHAPE', 'BUNDLE_BODY', 'BUNDLE_HASH', 'EXPLICIT_STATUS', 'OTHER']
const diagnosticFailures = ['ABORTED', 'FAILED', 'BLOCKED_BY_CLIENT', 'CONNECTION_RESET', 'CONNECTION_CLOSED',
  'CONNECTION_REFUSED', 'EMPTY_RESPONSE', 'TIMED_OUT', 'NETWORK_CHANGED', 'NAME_NOT_RESOLVED', 'INTERNET_DISCONNECTED']

function assertPublicRequestFailureProjection(project) {
  const defaults = { stage: 'browser-request-failure', method: 'OTHER', apiKey: 'unknown', surface: 'OTHER', failure: 'OTHER' }
  const fields = { method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    apiKey: diagnosticApiKeys, surface: ['API', 'SOCKET', 'DOCUMENT', 'ASSET'], failure: diagnosticFailures }
  for (const [field, values] of Object.entries(fields)) {
    for (const value of values) assert.deepEqual(project({ stage: defaults.stage, [field]: value }), { ...defaults, [field]: value })
    for (const value of [undefined, null, 1, {}, [], 'PRIVATE_SENTINEL', 'GET_PRIVATE_SENTINEL', ' ABORTED', 'ABORTED_PRIVATE_SENTINEL']) {
      assert.deepEqual(project({ stage: defaults.stage, [field]: value }), defaults)
    }
  }
  assert.deepEqual(project({ ...defaults, url: 'PRIVATE_SENTINEL', headers: { authorization: 'PRIVATE_SENTINEL' },
    body: 'PRIVATE_SENTINEL', errorCode: 'PRIVATE_SENTINEL', requestSequence: 'PRIVATE_SENTINEL' }), defaults)
}

test('public request failure projection preserves only finite classifications from the real browser producer', () => {
  assertPublicRequestFailureProjection(publicBrowserFailure)
})

test('removing each public request classification guard makes its real projection contract fail', () => {
  const source = publicBrowserFailure.toString()
  for (const field of ['method', 'apiKey', 'surface', 'failure']) {
    const expression = new RegExp(`[^\\n]+\\.includes\\(record\\.${field}\\) \\? record\\.${field} : '[^']+'`)
    const line = source.split('\n').find(value => expression.test(value))
    assert(line, 'each classification must have its own guard')
    const changed = line.replace(/: .*\.includes\(record\.(\w+)\) \? record\.\1 : '[^']+'/, ': record.$1')
    assert.notEqual(changed, line)
    const mutant = runInNewContext('(' + source.replace(line, changed) + ')', Object.create(null),
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } })
    const project = input => JSON.parse(JSON.stringify(mutant(input)))
    assert.throws(() => assertPublicRequestFailureProjection(project), assert.AssertionError)
  }
})
const diagnosticStaticCodes = ['UNEXPECTED_API_RESPONSE', 'AUTOMATION_DETAIL_NOT_CORRELATED',
  'AUTOMATION_DETAIL_REFUSAL_INVALID', 'AUTOMATION_EMPTY_PROJECT_REFUSAL_REQUIRED', 'AUTOMATION_DUPLICATE_BOARD_REFUSAL',
  'EXACT_PLUGIN_LIST_REQUIRED', 'EXACT_INTEGRATION_PLUGIN_ACTIVE_REQUIRED', 'TODO_COUNT_DEGRADED',
  'CONFIGURED_ACTION_CATALOG_REQUIRED', 'INTERVAL_HOME_DIRECTORY_RESPONSE_REQUIRED',
  'BUNDLE_RESPONSE_REQUIRED', 'BUNDLE_RESPONSE_BYTES_CHANGED', 'REQUIRED_HTTP_STATUS',
  'REQUIRED_JSON_ENVELOPE', 'REQUIRED_DATA_ENVELOPE']
const diagnosticDefault = { method: 'OTHER', apiKey: 'unknown', surface: 'OTHER', failure: 'OTHER',
  validationStage: 'OTHER', errorCode: 'OTHER' }

function diagnosticHelperSource(source) {
  const begin = '// Browser failure diagnostic contract: begin'
  const end = '// Browser failure diagnostic contract: end'
  assert.equal(source.split(begin).length, 2, 'one diagnostic helper start marker is required')
  assert.equal(source.split(end).length, 2, 'one diagnostic helper end marker is required')
  assert(source.indexOf(begin) < source.indexOf(end), 'diagnostic helper markers must be ordered')
  const helper = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end))
  const annotation = 'input: Record<string, unknown>'
  assert.equal(helper.split(annotation).length, 2, 'erase only the single agreed input type annotation')
  assert.match(helper, /function browserFailureDiagnostic\(input: Record<string, unknown>\)/u)
  assert.doesNotMatch(helper, /\b(?:import|require|fetch|process|writeFile|appendFile|mkdir|XMLHttpRequest|WebSocket)\b/u,
    'the extracted diagnostic must remain self-contained and have no browser, network or file side effects')
  return helper.replace(annotation, 'input')
}

function loadBrowserFailureDiagnostic() {
  const helper = diagnosticHelperSource(read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts'))
  // Do not import the browser module or install/transpile dependencies. Its
  // actual pure JavaScript body is unchanged; only the one input type is erased.
  // Construct errors inside this VM so instanceof checks use the same realm.
  const invoke = runInNewContext(helper + `
    (serializedInput, errorKind, message) => {
      const input = JSON.parse(serializedInput)
      if (errorKind === 'Error') input.error = new Error(message)
      if (errorKind === 'SyntaxError') input.error = new SyntaxError(message)
      if (errorKind === 'TypeError') input.error = new TypeError(message)
      return JSON.stringify(browserFailureDiagnostic(input))
    }
  `, Object.create(null), { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } })
  return (input = {}, errorKind, message) => JSON.parse(invoke(JSON.stringify(input), errorKind, message))
}

test('browser failure diagnostic runs its actual pure helper with exactly one type erasure and no module import', () => {
  const source = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  const invoke = loadBrowserFailureDiagnostic()
  assert.deepEqual(invoke(), diagnosticDefault)
  const helper = diagnosticHelperSource(source)
  assert.doesNotMatch(helper, /Record<string, unknown>|\b(?:as const|export|interface|type)\b/u)
  for (const replacement of [source.replace('// Browser failure diagnostic contract: begin', ''),
    source + '\n// Browser failure diagnostic contract: end',
    source.replace('input: Record<string, unknown>', 'input: unknown'),
    source.replace('input: Record<string, unknown>', 'input: Record<string, unknown> /* input: Record<string, unknown> */')]) {
    assert.throws(() => diagnosticHelperSource(replacement))
  }
  for (const code of ["fetch('synthetic-value')", "require('node:fs')", 'process.env', "writeFile('synthetic-value')"])
    assert.throws(() => diagnosticHelperSource(source.replace('// Browser failure diagnostic contract: end',
      code + '\n// Browser failure diagnostic contract: end')))
})

test('browser failure diagnostic accepts only the closed method, API key, surface and validation-stage enumerations', () => {
  const invoke = loadBrowserFailureDiagnostic()
  const choices = { method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'],
    apiKey: [...diagnosticApiKeys, 'unknown'], surface: ['API', 'SOCKET', 'DOCUMENT', 'ASSET', 'OTHER'],
    validationStage: diagnosticStages }
  for (const [field, values] of Object.entries(choices)) {
    for (const value of values) assert.deepEqual(invoke({ [field]: value }), { ...diagnosticDefault, [field]: value })
    for (const value of [null, false, true, 0, {}, [], 'private', '\nGET', 'GET ', 'get', 'API/private',
      ...values.flatMap(item => [`prefix_${item}`, `${item}_suffix`])]) {
      assert.deepEqual(invoke({ [field]: value }), diagnosticDefault)
    }
  }
})

test('browser failure diagnostic maps only exact Chromium failure literals without prefix or suffix matches', () => {
  const invoke = loadBrowserFailureDiagnostic()
  for (const failure of diagnosticFailures) {
    const literal = `net::ERR_${failure}`
    assert.deepEqual(invoke({ failureText: literal }), { ...diagnosticDefault, failure })
    for (const failureText of [failure, `ERR_${failure}`, literal.toLowerCase(), ` ${literal}`, `${literal} `,
      `${literal}: synthetic-private-value`, `prefix_${literal}`, `${literal}\nsynthetic-private-value`]) {
      assert.deepEqual(invoke({ failureText }), diagnosticDefault)
    }
  }
  for (const failureText of [null, false, 0, {}, [], 'net::ERR_UNKNOWN_PRIVATE'])
    assert.deepEqual(invoke({ failureText }), diagnosticDefault)
})

test('browser failure diagnostic recognizes only finite monitor error codes and maps realm-local parse/body errors', () => {
  const invoke = loadBrowserFailureDiagnostic()
  const known = diagnosticStaticCodes.map(code => 'APP_BROWSER_' + code)
    .concat(diagnosticApiKeys.flatMap(key => ['HTTP_STATUS', 'JSON_SHAPE', 'ERROR_ENVELOPE']
      .map(suffix => `APP_BROWSER_${key.toUpperCase()}_${suffix}`)))
  for (const errorCode of known) {
    assert.deepEqual(invoke({}, 'Error', errorCode), { ...diagnosticDefault, errorCode })
    assert.equal(invoke({ validationStage: 'API_BODY' }, 'Error', errorCode).errorCode, errorCode)
    assert.equal(invoke({ validationStage: 'BUNDLE_BODY' }, 'SyntaxError', errorCode).errorCode, errorCode)
    for (const message of [`prefix_${errorCode}`, `${errorCode}_PRIVATE`, `${errorCode}: synthetic-private-value`,
      `${errorCode}\nsynthetic-private-value`, errorCode.toLowerCase()]) {
      assert.equal(invoke({}, 'Error', message).errorCode, 'OTHER')
    }
  }
  for (const error of [{ message: known[0] }, known[0], { name: 'SyntaxError', message: 'synthetic-private-value' }])
    assert.deepEqual(invoke({ error }), diagnosticDefault)
  for (const validationStage of diagnosticStages) {
    assert.equal(invoke({ validationStage }, 'SyntaxError', 'synthetic-private-value').errorCode, 'JSON_SYNTAX')
    for (const errorKind of ['Error', 'TypeError']) {
      assert.equal(invoke({ validationStage }, errorKind, 'synthetic-private-value').errorCode,
        ['API_BODY', 'BUNDLE_BODY'].includes(validationStage) ? 'BODY_READ' : 'OTHER')
    }
  }
  for (const message of ['APP_BROWSER_PRIVATE_CREDENTIAL', 'APP_BROWSER_UNKNOWN_HTTP_STATUS',
    'APP_BROWSER_EDITORCONTEXT_PRIVATE', 'APP_BROWSER_EDITORCONTEXT_HTTP_STATUS_PRIVATE'])
    assert.equal(invoke({}, 'Error', message).errorCode, 'OTHER')
})

test('browser failure diagnostic pure helper never forwards URL, query, headers, body or arbitrary uppercase secret sentinels', () => {
  const invoke = loadBrowserFailureDiagnostic()
  const secret = 'SYNTHETIC_PRIVATE_SENTINEL_7E91'
  const input = { method: secret, apiKey: secret, surface: secret, validationStage: secret, failureText: secret,
    url: `https://example.invalid/${secret}?token=${secret}`, query: { token: secret },
    headers: { authorization: `Bearer ${secret}`, cookie: secret }, body: { credential: secret },
    payload: { ok: false, error: { code: secret, message: secret } }, errorCode: secret,
    stack: secret, message: secret }
  for (const errorKind of [undefined, 'Error', 'TypeError', 'SyntaxError']) {
    const result = invoke(input, errorKind, `APP_BROWSER_${secret}`)
    assert.deepEqual(result, { ...diagnosticDefault, errorCode: errorKind === 'SyntaxError' ? 'JSON_SYNTAX' : 'OTHER' })
    const encoded = JSON.stringify(result)
    for (const value of [secret, 'example.invalid', 'Bearer', 'credential', 'authorization', 'token=', 'stack', 'payload'])
      assert(!encoded.includes(value), 'diagnostic output must contain only the closed public projection')
    assert.deepEqual(Object.keys(result).sort(), Object.keys(diagnosticDefault).sort())
  }
})

test('browser failure diagnostic uses one private Request identity sequence across failed and response events', () => {
  const source = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  const sequence = source.slice(source.indexOf('const requestSequences ='), source.indexOf('const allowedApi ='))
  assert.match(sequence, /new WeakMap<Request, number>\(\)/u)
  assert.match(sequence, /const existing = requestSequences\.get\(request\)\r?\n\s*if \(existing !== undefined\) return existing/u)
  assert.match(sequence, /const sequence = \+\+nextRequestSequence\r?\n\s*requestSequences\.set\(request, sequence\)\r?\n\s*return sequence/u)
  assert.match(sequence, /return \{ requestSequence: requestSequence\(request\), \.\.\.browserFailureDiagnostic\(\{/u)
  assert.match(sequence, /method: request\.method\(\), apiKey: classify\(request\), surface, validationStage, error, failureText/u)
  assert.match(sequence, /context\.on\('request', request => \{ requestSequence\(request\) \}\)/u)
  const failed = source.slice(source.indexOf("context.on('requestfailed'"), source.indexOf('const diagnosedResponses ='))
  assert.match(failed, /if \(!closing\)/u)
  assert.match(failed, /counts\.requestFailures \+= 1; note\('REQUEST_FAILED'\)/u)
  assert.match(failed, /stage: 'browser-request-failure'/u)
  assert.match(failed, /\.\.\.requestDiagnostic\(request, 'REQUEST_FAILED', undefined, request\.failure\(\)\?\.errorText\)/u)
  const diagnosis = source.slice(source.indexOf('const diagnosedResponses ='), source.indexOf("context.on('response'"))
  assert.match(diagnosis, /new WeakMap<Response, Promise<void>>\(\)/u)
  assert.match(diagnosis, /const existing = diagnosedResponses\.get\(response\)\r?\n\s*if \(existing\) return existing/u)
  assert.match(diagnosis, /requestDiagnostic\(response\.request\(\), validationStage, error\)/u)
  assert.match(diagnosis, /errorCode: validationErrorCode/u)
  assert.match(diagnosis, /stage: classification\.surface === 'API' \? 'browser-api-failure' : 'browser-bundle-failure'/u)
  assert.match(diagnosis, /\.\.\.classification, status: response\.status\(\), validationErrorCode/u)
  assert.match(diagnosis, /diagnosedResponses\.set\(response, diagnostic\)/u)
  assert.doesNotMatch(diagnosis, /response\.(?:json|body|text|headers)\(|request\.url\(|\.stack|\.message/u)
  assert.doesNotMatch(failed + diagnosis, /setTimeout|waitForTimeout|\.retry\(|route\.continue|route\.fulfill|route\.fetch/u)
})

function browserDispatchNodes(source) {
  const ts = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))('typescript')
  const file = ts.createSourceFile('actual-browser.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const routes = [], responses = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === 'context' && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.name.text === 'route' && node.arguments[0].text === '**/*') routes.push(node.arguments[1])
      if (node.expression.name.text === 'on' && node.arguments[0].text === 'response') responses.push(node.arguments[1])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(routes.length, 1, 'the actual HTTP route must be wired exactly once')
  assert.equal(responses.length, 1, 'the actual response listener must be wired exactly once')
  for (const callback of [...routes, ...responses]) assert(ts.isArrowFunction(callback) && ts.isBlock(callback.body))
  return { ts, file, route: routes[0], response: responses[0], text: node => node.getText(file) }
}

function browserDispatchWindows(source) {
  const nodes = browserDispatchNodes(source), { ts, text } = nodes
  const unique = (statements, predicate, label) => {
    const matches = statements.filter(predicate)
    assert.equal(matches.length, 1, label)
    return matches[0]
  }
  const ownerCondition = "target.pathname === ownerOffPrefix || target.pathname.startsWith(ownerOffPrefix + '/')"
  const windows = {}
  for (const [kind, callback, counter, candidate] of [
    ['request', nodes.route, 'counts.apiRequests += 1', 'projectSheetsOff.isCandidate(request)'],
    ['response', nodes.response, 'counts.apiResponses += 1', 'projectSheetsOff.isCandidate(response.request())'],
  ]) {
    const statements = [...callback.body.statements]
    const branch = condition => unique(statements,
      node => ts.isIfStatement(node) && text(node.expression) === condition, kind + ' branch must be unique: ' + condition)
    const precise = branch(candidate), owner = branch(ownerCondition)
    const members = branch(kind === 'request' ? 'membersOff.isCandidate(request)' : 'membersOff.isCandidate(response.request())')
    const business = kind === 'request'
      ? unique(statements, node => ts.isIfStatement(node) && text(node.expression) === "target.pathname.startsWith('/api/')"
        && node.thenStatement.statements?.[0] && text(node.thenStatement.statements[0]) === counter,
      'the original business request counter must be anchored to its actual API branch')
      : unique(statements, node => ts.isExpressionStatement(node) && text(node) === counter,
        'the original business response counter must be a unique listener-level statement')
    for (const [label, node] of [['precise', precise], ['members', members], ['owner', owner]]) {
      assert(ts.isBlock(node.thenStatement) && !node.elseStatement, kind + ' ' + label + ' must be a separate closed branch')
      assert(ts.isReturnStatement(node.thenStatement.statements.at(-1)), kind + ' ' + label + ' must return before business dispatch')
      assert(node.end < business.pos, kind + ' ' + label + ' must precede the original business counter')
    }
    assert.doesNotMatch(text(owner), /counts\.api(?:Requests|Responses)\s*\+=/u)
    assert.equal((text(precise).match(new RegExp(counter.replaceAll('.', '\\.').replaceAll('+', '\\+'), 'gu')) ?? []).length, 1)
    assert.equal((text(members).match(new RegExp(counter.replaceAll('.', '\\.').replaceAll('+', '\\+'), 'gu')) ?? []).length, 1)
    windows[kind] = { precise, members, owner, business, statements }
  }
  const responseStatements = windows.response.statements
  const beforeBusiness = responseStatements.slice(0, responseStatements.indexOf(windows.response.business))
    .filter(node => node !== windows.response.precise && node !== windows.response.members).map(text).join('\n')
  assert.equal((text(windows.response.precise).match(/response\.json\(\)/gu) ?? []).length, 1,
    'only the precise project-sheets OFF branch may read its correlated refusal body')
  assert.equal((text(windows.response.members).match(/response\.json\(\)/gu) ?? []).length, 1,
    'only the precise members OFF branch may read its correlated refusal body')
  assert.doesNotMatch(beforeBusiness, /response\.json\(\)/u, 'other pre-business branches must not reread API JSON')
  return { ...nodes, ...windows, responses: text(nodes.response),
    apiResponses: responseStatements.slice(responseStatements.indexOf(windows.response.business)).map(text).join('\n') }
}

test('browser diagnostic wiring retains exact status gates, correlation, fatal counters and existing timeouts', () => {
  const source = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  const { responses, apiResponses } = browserDispatchWindows(source)
  assert.match(responses, /check\(key && allowedApi\(response\.request\(\), key\), 'UNEXPECTED_API_RESPONSE'\)/u)
  assert.match(responses, /validationStage = 'API_BODY'\r?\n\s*payload = await response\.json\(\)/u)
  assert.equal((apiResponses.match(/response\.json\(\)/gu) ?? []).length, 1,
    'the original API failure-diagnostic window still reads its response body exactly once')
  assert.equal((responses.match(/response\.body\(\)/gu) ?? []).length, 1)
  assert.match(responses, /validationStage = 'BUNDLE_BODY'\r?\n\s*const bytes = await response\.body\(\)\r?\n\s*validationStage = 'BUNDLE_HASH'/u)
  assert.match(responses, /check\(expected && response\.status\(\) === 200, 'BUNDLE_RESPONSE_REQUIRED'\)/u)
  assert.match(responses, /await diagnoseResponseFailure\(response, validationStage, error\)\r?\n\s*note\('BUNDLE_RESPONSE_VERIFICATION_FAILED'\)/u)
  assert.match(responses, /await diagnoseResponseFailure\(response, validationStage, error, payload\)/u)
  assert.match(responses, /'API_RESPONSE_VALIDATION_FAILED'\r?\n\s*note\(code\)/u)
  assert.match(responses, /observation\.responses === 1 && await observation\.validated, 'AUTOMATION_DETAIL_NOT_CORRELATED'/u)
  assert.match(responses, /response\.status\(\) === 503/u)
  assert.match(responses, /isDeepStrictEqual\(payload, \{ ok: false, error: \{ code: 'AUTOMATION_READ_UNAVAILABLE' \} \}\)/u)
  assert.match(responses, /response\.headers\(\)\['cache-control'\] === 'no-store'/u)
  assert.match(responses, /response\.status\(\) === 404 && object\(payload\) && payload\.ok === false/u)
  assert.match(responses, /payload\.error\.code === 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND'/u)
  assert.match(responses, /\? \['plans', 'readSourceConfigs', 'automationGrants', 'automationScheduleActivation'\]\.includes\(key\) \? 201 : key === 'automationRequests' \? 202 : 200 : 200/u)
  assert.match(responses, /check\(response\.status\(\) === expectedStatus, `\$\{key\.toUpperCase\(\)\}_HTTP_STATUS`\)/u)
  assert.match(source, /response\.status\(\) !== status\) await diagnoseResponseFailure\(response, 'EXPLICIT_STATUS', new Error\('APP_BROWSER_REQUIRED_HTTP_STATUS'\)\)/u)
  assert.match(source, /check\(response\.status\(\) === status, 'REQUIRED_HTTP_STATUS'\)/u)
  assert.match(source, /page\.setDefaultTimeout\(30000\)/u)
  assert.match(source, /page\.setDefaultNavigationTimeout\(60000\)/u)
  assert.match(source, /check\(faults\.length === 0, `NETWORK_OR_PAGE_\$\{faults\[0\] \?\? 'NONE'\}`\)/u)
})

async function assertActualBrowserOffDispatch(source) {
  // Execute the actual registered callbacks, not a reimplementation of their
  // ordering. Both OFF contracts and the path catalog are real; transport and
  // ordinary diagnostic collaborators are bounded doubles, with no browser IO.
  const { ts, file, route, response } = browserDispatchNodes(source)
  const compileText = text => ts.transpileModule('(' + text + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const catalogs = file.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .filter(node => node.name.getText(file) === 'apiPaths')
  assert.equal(catalogs.length, 1)
  const apiPaths = Function('return ' + compileText(catalogs[0].initializer.getText(file)))()
  const ownerHelper = loadOwnerOffHelper()
  for (const mode of ['project', 'owner', 'members']) {
    const owner = mode === 'owner', members = mode === 'members'
    const phase = owner ? 'YIDA_OWNER_DEFAULT_OFF' : members ? 'TOPBAR' : 'YIDA_BOARD_NAVIGATION'
    const fixture = mainOffWindow(loadMainMigrationContract(), { origin: 'http://127.0.0.1:8910',
      phase: () => phase, allowedPhases: ['YIDA_BOARD_NAVIGATION'] })
    const counts = { apiRequests: 0, apiResponses: 0, forbiddenRequests: 0 }, notes = [], pendingChecks = new Set()
    const ownerWindow = freshOwnerOffWindow(ownerHelper), successes = { operatorProjects: 0 }
    const memberFixture = membersOffFixture(loadMainMigrationContract(), { origin: fixture.input.origin })
    const bindings = { URL, phase, counts, pendingChecks, successes, apiPaths, projectSheetsOff: fixture.window,
      membersOff: memberFixture.window,
      ownerOffPrefix: ownerHelper.ownerOffPrefix, yidaOwnerOffWindow: ownerWindow, uiOrigin: fixture.input.origin,
      yidaLocalWindow: false, classify: () => 'operatorProjects', allowedApi: () => true,
      note: code => notes.push(code), check: (ok, code) => assert(ok, code), monitorTransport: () => {},
      detailObservation: null, input: { automation: { scenario: 'manual' } },
      object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
      diagnoseResponseFailure: async () => notes.push('BUSINESS_DIAGNOSTIC'), isDeepStrictEqual }
    const compile = callback => {
      const compiled = compileText(callback.getText(file))
      return Function(...Object.keys(bindings), 'return ' + compiled)(...Object.values(bindings))
    }
    const requestListener = compile(route), responseListener = compile(response)
    const observe = async (request, status, payload) => {
      let continued = 0, aborted = 0, reads = 0
      await requestListener({ request: () => request, continue: async () => { continued += 1 }, abort: async () => { aborted += 1 } })
      assert.equal(continued, 1); assert.equal(aborted, 0)
      const observed = owner ? ownerOffResponse(request) : { request: () => request, status: () => status,
        json: async () => payload }
      const json = observed.json
      observed.url = request.url
      observed.json = async () => { reads += 1; return json() }
      responseListener(observed)
      await Promise.all([...pendingChecks])
      assert.equal(reads, 1, 'the actual dispatched response must have exactly one body reader')
      assert.deepEqual(notes, [], 'an admitted closed window must not fall into ordinary business diagnostics')
    }
    if (members) {
      const request = memberFixture.request()
      await observe(request, 404, membersOffPayload)
      assert(memberFixture.window.consoleRefusal(request.url(), membersOffConsole))
      memberFixture.window.verify()
      assert.deepEqual(counts, { apiRequests: 1, apiResponses: 1, forbiddenRequests: 0 })
    } else if (owner) {
      ownerWindow.arm()
      const request = ownerOffRequest(ownerHelper)
      await observe(request, 403)
      assert(ownerWindow.consoleRefusal(request.url(), 'Failed to load resource: the server responded with a status of 403 (Forbidden)'))
      assert.equal(ownerWindow.result().counts.ownerResponses, 1)
      assert.deepEqual(counts, { apiRequests: 0, apiResponses: 0, forbiddenRequests: 0 })
    } else {
      for (const request of [fixture.request(), fixture.request({ url: fixture.input.origin
        + '/api/integration/stock-preparation/project-targets?tenantId=synthetic-tenant' })]) {
        await observe(request, 404, mainOffPayload)
        assert(fixture.window.consoleRefusal(request.url(), mainOffConsole))
      }
      fixture.window.verify()
      assert.deepEqual(counts, { apiRequests: 2, apiResponses: 2, forbiddenRequests: 0 })
      await observe(fixture.request({ url: fixture.input.origin + '/api/integration/stock-preparation/operator/projects' }), 200, { ok: true })
      assert.deepEqual(counts, { apiRequests: 3, apiResponses: 3, forbiddenRequests: 0 })
      assert.equal(successes.operatorProjects, 1, 'the original business response still enters its diagnostic window')
    }
  }
}

test('actual browser callbacks keep precise 404 and owner OFF windows separate from original business dispatch; finite removals turn red', async () => {
  const source = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  await assertActualBrowserOffDispatch(source)
  const nodes = browserDispatchWindows(source)
  for (const branch of [nodes.request.precise, nodes.response.precise, nodes.request.members, nodes.response.members,
    nodes.request.owner, nodes.response.owner]) {
    const terminal = branch.thenStatement.statements.at(-1)
    const mutant = source.slice(0, terminal.getStart(nodes.file)) + source.slice(terminal.end)
    await assert.rejects(assertActualBrowserOffDispatch(mutant), { code: 'ERR_ASSERTION' },
      'removing an actual early return must break the independently executed dispatch contract')
  }
  const needle = 'payload = await response.json()'
  assert.equal(source.split(needle).length - 1, 1)
  const reread = source.replace(needle, needle + '; await response.json()')
  await assert.rejects(assertActualBrowserOffDispatch(reread), { code: 'ERR_ASSERTION' })
  assert.throws(() => browserDispatchNodes(source + '\ncontext.on(\'response\', response => {})'), { code: 'ERR_ASSERTION' })
})

test('formal Automation fixture uses real rule HTTP, separate permit, actual consumer and native query passthrough', () => {
  const verifier = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  assert.match(verifier, /configureAutomationFullAppDeployment\(scratch, fixture\)[\s\S]*?await host\.start\(/u)
  assert.match(verifier, /automation = await \(automationScenario === 'interval' \? createAutomationIntervalFullAppFixture : createAutomationFullAppFixture\)\(/u)
  assert.match(verifier, /await automation\.checkpoint\(frame\.command\)/u)
  assert.match(verifier, /await automation\.verify\(automationResult\)/u)
  assert.doesNotMatch(verifier, /stage\([^\n]*browserResult\.automation/u)
  const fixture = read('packages/core-backend/tests/utils/stock-preparation-automation-full-app-fixture.ts')
  assert.match(fixture, /fetch\(origin \+ `\/api\/multitable\/sheets\//u)
  assert.match(fixture, /Reflect\.apply\(target, receiver, args\)/u)
  assert.match(fixture, /return result\r?\n\s*\} \}\)/u)
  assert.match(fixture, /meta_automation_outbox_consumer/u)
  assert.match(fixture, /APP_AUTOMATION_AUTOMATIC_ACTIVATION_FORBIDDEN/u)
  assert.match(fixture, /new AsyncLocalStorage<DetailObservation>\(\)/u)
  assert.match(fixture, /request\.method !== 'GET' \|\| request\.url !== context\.path/u)
  assert.match(fixture, /sql\.replace\([^\n]+=== mirrorObservationSql/u)
  assert.match(fixture, /values\.length === 1 && values\[0\] === connectionId/u)
  assert.match(fixture, /Object\.getOwnPropertyDescriptor\(error, 'code'\)\?\.value === '55P03'/u)
  assert.match(fixture, /assert\.deepEqual\(server\.rawListeners\('request'\), listeners,/u)
  assert.doesNotMatch(fixture, /removeAllListeners\(/u)
  assert.doesNotMatch(fixture, /vi\.(?:mock|spyOn)|mockResolvedValue|createApp\(/u)
  const plm = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-fixture.ts')
  assert.match(plm, /stock-preparation\.automation-preview/u)
  assert.match(plm, /sourceReadOperationLimit: 1/u)
})

// Execute the actual acceptance helper. TypeScript erases types; the only
// runtime imports are the real pure example builder and explicitly listed Node APIs.
const ownerOffSourcePath = 'packages/core-backend/tests/utils/stock-preparation-yida-owner-off-full-app.ts'
function loadOwnerOffHelper(source = read(ownerOffSourcePath), fetch) {
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const imports = { 'node:assert/strict': assert, 'node:crypto': { randomBytes },
    'node:async_hooks': { AsyncLocalStorage }, 'node:util': { isDeepStrictEqual, types: requireCore('node:util').types },
    '../../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs': yidaStatic }
  const module = { exports: {} }
  runInNewContext(compiled + '\nmodule.exports.contractParse = text => JSON.parse(text)', { module, exports: module.exports, URL, Buffer, AbortSignal, fetch,
    require: name => { assert(Object.hasOwn(imports, name), 'unapproved runtime helper import'); return imports[name] } },
  { timeout: 1000 })
  return module.exports
}
function ownerOffRequest(helper, overrides = {}) {
  return { url: () => 'http://127.0.0.1:8910' + helper.ownerOffPrefix + '/drafts', method: () => 'POST',
    headers: () => ({ authorization: 'Bearer synthetic-session', 'content-type': 'application/json' }),
    postDataJSON: () => helper.ownerOffDraftBody(), contractParse: helper.contractParse, ...overrides }
}
function ownerOffResponse(request, overrides = {}) {
  const response = { request: () => request, status: () => 403,
    headers: () => ({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-correlation-id': '11111111-1111-4111-8111-111111111111' }),
    json: async () => ({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } }), ...overrides }
  const json = response.json
  response.json = async () => request.contractParse(JSON.stringify(await json()))
  return response
}
const freshOwnerOffWindow = helper => helper.createYidaOwnerOffWindow('http://127.0.0.1:8910', 'synthetic-session')

async function assertOwnerOffRequestResponseContract(helper) {
  const request = ownerOffRequest(helper), unarmed = freshOwnerOffWindow(helper)
  assert.throws(() => unarmed.acceptRequest(request), /EXACT_ARMED_DRAFT_REQUIRED/u)
  const invalidRequests = [
    { url: () => 'http://127.0.0.1:8911' + helper.ownerOffPrefix + '/drafts' },
    { url: () => 'http://127.0.0.1:8910' + helper.ownerOffPrefix + '/preview' },
    { url: () => 'http://127.0.0.1:8910' + helper.ownerOffPrefix + '/drafts?private=synthetic' },
    { method: () => 'GET' }, { postDataJSON: () => ({ ...helper.ownerOffDraftBody(), unexpected: true }) },
    { postDataJSON: () => ({ ...helper.ownerOffDraftBody(), rowsText: 'different synthetic input' }) },
    { headers: () => ({ authorization: 'Bearer different-session', 'content-type': 'application/json' }) },
    { headers: () => ({ authorization: 'Bearer synthetic-session', 'content-type': 'text/plain' }) },
    ...['cookie', 'x-tenant-id', 'x-workspace-id', 'x-user-role', 'x-permissions'].map(key => ({
      headers: () => ({ authorization: 'Bearer synthetic-session', 'content-type': 'application/json', [key]: 'synthetic' }) })),
  ]
  for (const overrides of invalidRequests) {
    const window = freshOwnerOffWindow(helper); window.arm()
    assert.throws(() => window.acceptRequest(ownerOffRequest(helper, overrides)), /REQUIRED/u)
  }
  const window = freshOwnerOffWindow(helper); window.arm()
  assert.throws(() => window.arm(), /DRAFT_ALREADY_ARMED/u)
  window.acceptRequest(request)
  assert.throws(() => window.arm(), /DRAFT_ALREADY_ARMED/u)
  assert.throws(() => window.acceptRequest(request), /EXACT_ARMED_DRAFT_REQUIRED/u)
  assert.throws(() => window.result(), /ONE_REAL_DISABLED_DRAFT_REQUIRED/u)
  assert.equal(window.consoleRefusal('http://127.0.0.1:8910' + helper.ownerOffPrefix + '/drafts',
    'Failed to load resource: the server responded with a status of 403 (Forbidden)'), false)
  const invalidResponses = [
    { request: () => ownerOffRequest(helper) }, { status: () => 201 },
    { json: async () => ({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' }, data: { targetRef: 'synthetic' } }) },
    { json: async () => ({ ok: false, error: { code: 'YIDA_OWNER_HTTP_DENIED' } }) },
    ...['cache-control', 'x-content-type-options', 'x-correlation-id'].map(key => ({ headers: () => ({
      ...ownerOffResponse(request).headers(), [key]: key === 'x-correlation-id' ? 'SYN_PRIVATE_INVALID' : 'different' }) })),
  ]
  for (const overrides of invalidResponses) {
    const isolated = freshOwnerOffWindow(helper); isolated.arm(); isolated.acceptRequest(request)
    await assert.rejects(isolated.acceptResponse(ownerOffResponse(request, overrides)), /REQUIRED/u)
  }
  await window.acceptResponse(ownerOffResponse(request))
  await assert.rejects(window.acceptResponse(ownerOffResponse(request)), /EXACT_RESPONSE_IDENTITY_REQUIRED/u)
  const consoleUrl = 'http://127.0.0.1:8910' + helper.ownerOffPrefix + '/drafts'
  const consoleText = 'Failed to load resource: the server responded with a status of 403 (Forbidden)'
  assert.equal(window.consoleRefusal(consoleUrl + '?different=1', consoleText), false)
  assert.equal(window.consoleRefusal(consoleUrl, consoleText + ' private'), false)
  assert.equal(window.consoleRefusal(consoleUrl, consoleText), true)
  assert.throws(() => window.consoleRefusal(consoleUrl, consoleText), /DUPLICATE_REFUSAL_CONSOLE_ERROR/u)
  const result = freshOwnerOffWindow(helper); result.arm(); result.acceptRequest(request)
  await result.acceptResponse(ownerOffResponse(request))
  assert.equal(result.result().counts.ownerPosts, 1)
  for (const key of ['ownerPosts', 'ownerResponses']) {
    result.counts[key] = 2
    assert.throws(() => result.result(), /ONE_REAL_DISABLED_DRAFT_REQUIRED/u)
    result.counts[key] = 1
  }
  for (const key of ['openingBusinessRequests', 'otherBusinessRequests', 'externalRequests']) {
    result.counts[key] += 1
    assert.throws(() => result.result(), /NO_OTHER_BUSINESS_REQUESTS_REQUIRED/u)
    result.counts[key] -= 1
  }
}
test('owner OFF actual helper admits only one exact real SDK request and closed disabled response', async () => {
  await assertOwnerOffRequestResponseContract(loadOwnerOffHelper())
})
test('owner OFF in-memory request and response guard removal makes the actual helper contract red', async () => {
  const source = read(ownerOffSourcePath)
  const mutations = [
    ["target.origin === origin", 'true'], ["target.pathname === ownerOffPrefix + '/drafts'", 'true'],
    ["target.search === ''", 'true'], ["request.method() === 'POST'", 'true'],
    ['armed && !accepted &&', '!accepted &&'], ['!armed && !accepted', '!armed'],
    ['isDeepStrictEqual(request.postDataJSON(), ownerOffDraftBody())', 'true'],
    ["headers.authorization === 'Bearer ' + token", 'true'],
    ["headers['content-type'] === 'application/json'", 'true'],
    ["!['cookie', 'x-tenant-id', 'x-workspace-id', 'x-user-role', 'x-permissions'].some(key => key in headers)", 'true'],
    ['response.request() === accepted', 'true'], ['counts.ownerResponses === 0', 'true'],
    ['response.status() === 403', 'true'], ['isDeepStrictEqual(await response.json(), disabledEnvelope)', 'true'],
    ["headers['cache-control'] === 'no-store'", 'true'], ["headers['x-content-type-options'] === 'nosniff'", 'true'],
    ['serverIdPattern.test(id)', 'true'], ['accepted && responseStatusChecked &&', 'accepted &&'],
    ['counts.expectedConsoleErrors <= 1', 'true'],
    ['counts.ownerResponses === 1', 'true'],
    ['counts.ownerPosts === 1', 'true'],
    ['counts.openingBusinessRequests === 0', 'true'], ['counts.otherBusinessRequests === 0', 'true'],
    ['counts.externalRequests === 0', 'true'],
  ]
  for (const [needle, replacement] of mutations) {
    assert(source.includes(needle), 'mutation anchor required')
    await assert.rejects(assertOwnerOffRequestResponseContract(loadOwnerOffHelper(source.replace(needle, replacement))),
      error => error?.code === 'ERR_ASSERTION', 'removing this actual helper guard must invalidate its contract')
  }
})

test('owner OFF native query observer preserves receiver, arguments, callback, return and throw and excludes only scoped census', async () => {
  const helper = loadOwnerOffHelper(), returned = Promise.resolve('synthetic'), thrown = new Error('synthetic'), calls = []
  function Client() {}
  const native = function (...args) { calls.push({ receiver: this, args }); if (args[0] === 'throw') throw thrown; return returned }
  Object.defineProperty(Client.prototype, 'query', { value: native, configurable: true, writable: true })
  const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, 'query'), client = new Client()
  const observer = helper.observeYidaOwnerOffQueries(Client), callback = () => {}
  try {
    const params = ['synthetic-private']; assert.equal(client.query('SELECT 1', params, callback), returned)
    assert.equal(calls[0].receiver, client); assert.equal(calls[0].args[1], params); assert.equal(calls[0].args[2], callback)
    assert.throws(() => client.query('throw'), error => error === thrown)
    assert.throws(() => observer.verify(), /NATIVE_QUERY_CONTROL_REQUIRED/u)
    await observer.positiveControl(async () => client.query('SELECT count(*) FROM integration_yida_draft_rows'))
    await assert.rejects(observer.positiveControl(async () => client.query('SELECT count(*) FROM integration_yida_draft_rows')), /CONTROL_DUPLICATE/u)
    let traps = 0
    client.query(new Proxy({}, { getOwnPropertyDescriptor() { traps += 1; throw thrown } }))
    assert.equal(traps, 0, 'observer must not touch proxy descriptor traps')
    await observer.suspend(async () => client.query('SELECT count(*) FROM integration_yida_draft_rows'))
    observer.verify()
    client.query('INSERT INTO integration_yida_draft_rows VALUES ($1)', params)
    assert.throws(() => observer.verify(), /QUERY_ATTEMPT_FORBIDDEN/u)
  } finally { observer.restore() }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Client.prototype, 'query'), descriptor)
  observer.restore()
  const inactive = helper.observeYidaOwnerOffQueries(Client)
  await inactive.positiveControl(async () => client.query('SELECT count(*) FROM integration_yida_draft_rows'))
  const retainedClientOriginal = client.query
  inactive.restore()
  assert.equal(Reflect.apply(retainedClientOriginal, client, ['INSERT INTO integration_yida_draft_rows VALUES ($1)', ['synthetic']]), returned)
  inactive.verify()
  const before = helper.observeYidaOwnerOffQueries(Client)
  Object.defineProperty(Client.prototype, 'query', { ...descriptor, value: () => {} })
  assert.throws(() => before.restore(), /QUERY_OBSERVER_CHANGED/u)
  Object.defineProperty(Client.prototype, 'query', descriptor)
})
test('owner OFF actual census rejects nonempty durable state and visits exactly the fourteen real tables', async () => {
  const helper = loadOwnerOffHelper(), queries = []
  assert.equal(helper.ownerOffTables.length, 14)
  const counts = await helper.ownerOffDatabaseCounts(async sql => { queries.push(sql); return { rows: [{ count: 0 }] } })
  assert.equal(counts.length, 14)
  assert.deepEqual(queries, Array.from(helper.ownerOffTables, table => `SELECT count(*)::int AS count FROM ${table}`))
  await assert.rejects(helper.ownerOffDatabaseCounts(async () => ({ rows: [{ count: 1 }] })), /DURABLE_ROWS_FORBIDDEN/u)
  await assert.rejects(helper.ownerOffDatabaseCounts(async () => ({ rows: [] })), /COUNT_REQUIRED/u)
})

test('owner OFF actual host probe produces only three closed owner refusals and one unchanged ordinary positive control', async () => {
  const calls = []
  let helper
  helper = loadOwnerOffHelper(undefined, async (url, options) => {
    calls.push({ url, options })
    const index = calls.length - 1, ordinary = index === 3
    const status = [403, 400, 404, 200][index]
    const payload = ordinary ? { ok: true, method: 'DELETE', overridden: false }
      : { ok: false, error: { code: ['YIDA_OWNER_RUNTIME_DISABLED', 'YIDA_OWNER_HTTP_INPUT', 'NOT_FOUND'][index] } }
    const correlation = ordinary ? options.headers['x-correlation-id'] : randomUUID()
    return { status, json: async () => helper.contractParse(JSON.stringify(payload)),
      headers: { get: key => key === 'x-correlation-id' ? correlation : key === 'cache-control' ? 'no-store' : null } }
  })
  const proof = await helper.probeYidaOwnerOffLogs('http://127.0.0.1:8910', 'synthetic-session')
  assert.equal(calls.length, 4); assert.equal(proof.serverIds.length, 3); assert.equal(proof.sentinels.length, 13)
  assert.equal(new Set(proof.sentinels).size, 13)
  assert.deepEqual(calls.map(call => call.options.method), ['POST', 'POST', 'POST', 'DELETE'])
  assert.equal(new URL(calls[0].url).pathname, helper.ownerOffPrefix + '/drafts')
  assert.match(new URL(calls[1].url).pathname, /^\/api\/integration\/yida-owner-send\/approvals\/SYN_PRIVATE_[a-f0-9]{40}\/revoke$/u)
  assert.match(new URL(calls[2].url).pathname, /^\/api\/integration\/yida-owner-send\/SYN_PRIVATE_[a-f0-9]{40}$/u)
  assert.equal(new URL(calls[3].url).pathname, '/api/method-probe')
  for (const sentinel of proof.sentinels) {
    assert(calls.slice(0, 3).some(call => JSON.stringify(call).includes(sentinel)), 'every forbidden sentinel must really be transmitted')
    assert(!proof.serverIds.includes(sentinel))
  }
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers.authorization, 'Bearer synthetic-session')
  }
})

const ownerOffRecords = () => [
  { stage: 'yida-owner-default-off-ready', defaultOff: true, durableTables: 14, durableRowsBefore: 0 },
  { stage: 'browser-starting' }, { stage: 'yida-static-browser-verified' },
  { stage: 'yida-owner-default-off-verified', evidence: { parentPrimaryPreview: true, openingNoBusinessRequests: true,
    realSdkDraftPost: true, exactDisabled403: true, noTargetOperationOrGrant: true,
    errorRetained: true, retryDisabled: true, approvalAndSubmissionAbsent: true },
    counts: { previewRuns: 1, ownerPosts: 1, ownerResponses: 1, backgroundOverviewRequests: 0,
      openingBusinessRequests: 0, otherBusinessRequests: 0, externalRequests: 0, expectedConsoleErrors: 1 },
    durableTables: 14, durableRowsAfter: 0, durableSnapshotUnchanged: true,
    queryObservation: { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0, nativeQueryPositiveControl: true } },
  { stage: 'yida-owner-log-http-verified', counts: { ownerRequests: 3, ownerResponses: 3,
    ordinaryRequests: 1, ordinaryResponses: 1, distinctSentinels: 13, distinctOwnerServerIds: 4 },
    durableSnapshotUnchanged: true, queryObservation: { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0,
      nativeQueryPositiveControl: true, prototypeRestored: true, observerInactive: true },
    proofBytes: 2048, proofSha256: '1'.repeat(64) },
  { stage: 'actual-stop-resolved' }, { stage: 'production-stop-verified' },
]
function assertOwnerOffReceiptContract(validate) {
  validate(ownerOffRecords())
  for (const index of [0, 3, 4]) {
    const record = ownerOffRecords()[index]
    for (const key of Object.keys(record).filter(key => key !== 'stage')) {
      const changed = ownerOffRecords(); delete changed[index][key]
      assert.throws(() => validate(changed))
    }
    const changed = ownerOffRecords(); changed[index].unexpected = 'synthetic-private'
    assert.throws(() => validate(changed))
  }
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    const records = ownerOffRecords()
    assert.throws(() => validate(records.filter((_, i) => i !== index)))
    assert.throws(() => validate([...records, records[index]]))
  }
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const records = ownerOffRecords(); [records[index], records[index + 1]] = [records[index + 1], records[index]]
    assert.throws(() => validate(records))
  }
  for (const index of [3, 4]) for (const key of Object.keys(ownerOffRecords()[index].counts)) {
    for (const value of [-1, 1.5, '1', null, {}, 100]) {
      const records = ownerOffRecords(); records[index].counts[key] = value
      if (key === 'backgroundOverviewRequests' && value === 100) continue
      assert.throws(() => validate(records))
    }
    const records = ownerOffRecords(); records[index].counts.private = true
    assert.throws(() => validate(records))
  }
  for (const key of Object.keys(ownerOffRecords()[3].evidence)) {
    const records = ownerOffRecords(); records[3].evidence[key] = false
    assert.throws(() => validate(records))
  }
  for (const [index, key, value] of [[0, 'defaultOff', false], [0, 'durableTables', 13], [0, 'durableRowsBefore', 1],
    [3, 'durableTables', 13], [3, 'durableRowsAfter', 1], [3, 'durableSnapshotUnchanged', false],
    [4, 'durableSnapshotUnchanged', false], [4, 'proofBytes', 0], [4, 'proofBytes', 8193], [4, 'proofSha256', 'private']]) {
    const records = ownerOffRecords(); records[index][key] = value
    assert.throws(() => validate(records))
  }
  for (const index of [3, 4]) for (const key of Object.keys(ownerOffRecords()[index].queryObservation)) {
    const records = ownerOffRecords(); records[index].queryObservation[key]
      = ['prototypeRestored', 'observerInactive', 'nativeQueryPositiveControl'].includes(key) ? false : 1
    assert.throws(() => validate(records))
  }
}
test('owner OFF receipt has a closed independent structure, exact counts, uniqueness and ordered real-stage wiring', () => {
  assertOwnerOffReceiptContract(validateYidaOwnerOffEvidence)
})
test('owner OFF in-memory receipt guard removal makes the real validator contract red', () => {
  const source = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const begin = source.indexOf('export function validateYidaOwnerOffEvidence(')
  const end = source.indexOf('/** Read both complete raw streams', begin)
  const actual = source.slice(begin, end).replace('export function ', 'function ')
  const load = code => {
    const invoke = runInNewContext(code + '\nserialized => validateYidaOwnerOffEvidence(JSON.parse(serialized))', { assert }, { timeout: 1000 })
    return records => invoke(JSON.stringify(records))
  }
  // VM inputs and expected literals share one realm; only the actual validator
  // code is changed in memory. The repository and old eleven-case validator stay unchanged.
  assertOwnerOffReceiptContract(load(actual))
  for (const [needle, replacement] of [
    ["assert.equal(found.length, 1,", "assert.equal(1, 1,"],
    ['positions.every((position, index) => index === 0 || positions[index - 1] < position)', 'true'],
    ["Object.keys(value).sort(), [...required].sort()", "[...required].sort(), [...required].sort()"],
    ["browser.counts[key], expected", 'expected, expected'],
    ["browser.durableTables, 14", '14, 14'], ["browser.durableRowsAfter, 0", '0, 0'],
    ["browser.durableSnapshotUnchanged, true", 'true, true'],
    ["http.durableSnapshotUnchanged, true", 'true, true'],
    ['Number.isSafeInteger(http.proofBytes) && http.proofBytes > 0 && http.proofBytes <= 8192', 'true'],
  ]) {
    assert(actual.includes(needle), 'receipt mutation anchor required')
    assert.throws(() => assertOwnerOffReceiptContract(load(actual.replace(needle, replacement))),
      error => error?.code === 'ERR_ASSERTION', 'removing a receipt guard must invalidate its actual contract')
  }
})

test('owner OFF log verifier searches entire actual captured child buffers in both streams and rejects leaks and missing logs', async () => {
  const fixture = await ownedLogFixture(), serverIds = Array.from({ length: 4 }, () => randomUUID())
  const sentinels = Array.from({ length: 13 }, () => 'SYN_PRIVATE_' + randomBytes(20).toString('hex'))
  const proof = { schemaVersion: 1, serverIds, sentinels, positiveId: 'SYN_PUBLIC_' + randomBytes(20).toString('hex') }
  const proofBytes = Buffer.from(JSON.stringify(proof) + '\n')
  await fs.writeFile(path.join(fixture.scratchDir, 'yida-owner-log-proof.json'), proofBytes, { flag: 'wx', mode: 0o600 })
  const records = ownerOffRecords(), http = records.find(item => item.stage === 'yida-owner-log-http-verified')
  http.proofBytes = proofBytes.length; http.proofSha256 = createHash('sha256').update(proofBytes).digest('hex')
  const line = (message, id) => 'info: ' + message + ' ' + JSON.stringify({ context: 'MetaSheetServer',
    service: 'metasheet', timestamp: 'synthetic', correlation_id: id, requestId: id }) + '\n'
  const baseline = serverIds.map(id => line('YIDA_OWNER_HTTP_INFO', id)).join('') + line('DELETE /api/method-probe', proof.positiveId)
  const run = async (stdout, stderr = '') => {
    const script = "process.stdout.write(Buffer.from('" + Buffer.from(stdout).toString('base64') + "','base64'));"
      + "process.stderr.write(Buffer.from('" + Buffer.from(stderr).toString('base64') + "','base64'));"
    return fixture.run('configured-app', ['-e', script], cleanEnvironment(process.env))
  }
  const verify = stage => verifyYidaOwnerOffRawLogs({ repoRoot, scratchDir: fixture.scratchDir, stage, records })
  const result = await verify(await run(baseline, '\u0000\ufffdunrelated raw bytes'))
  assert.equal(result.rawStreams, 2); assert.equal(result.ownerRequestsWithFixedServerLogs, 4)
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(verify(await run(baseline + (stream === 'stdout' ? sentinels[0] : ''),
      stream === 'stderr' ? sentinels[0] : '')), /RAW_LEAK/u)
  }
  await assert.rejects(verify(await run(baseline.replace(line('YIDA_OWNER_HTTP_INFO', serverIds[0]), ''))), /FIXED_LOG_MISSING/u)
  await assert.rejects(verify(await run(baseline.replace(line('DELETE /api/method-probe', proof.positiveId), ''))), /ORDINARY_LOG_MISSING/u)
  await assert.rejects(verify(await run(baseline.replace('"requestId":"' + serverIds[0] + '"', '"requestId":"' + randomUUID() + '"'))),
    /LOG_REQUEST_ID_INVALID/u)
})

test('owner OFF new wiring uses the real startup, SDK, native transport, raw stage and independent original counters', () => {
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts')
  const helper = read(ownerOffSourcePath), verifier = read('packages/core-backend/scripts/verify-stock-preparation-plm-full-app.mts')
  const runner = read('scripts/ops/run-stock-preparation-plm-full-app.mjs')
  const apiList = browser.slice(browser.indexOf('const apiPaths ='), browser.indexOf('type ApiKey ='))
  assert.doesNotMatch(apiList, /owner|yida-owner/u)
  const dispatch = browserDispatchWindows(browser)
  assert.match(dispatch.text(dispatch.request.owner), /yidaOwnerOffWindow\.acceptRequest\(request\)/u)
  assert.match(dispatch.text(dispatch.response.owner), /await yidaOwnerOffWindow\.acceptResponse\(response\)/u)
  assert(browser.indexOf('const yidaOwnerOff = await runConfiguredYidaOwnerOffBrowser') > browser.indexOf('yidaLocalWindow = false'))
  assert(browser.indexOf('const yidaOwnerOff = await runConfiguredYidaOwnerOffBrowser') < browser.indexOf('let automationRuleId ='))
  assert.match(helper, /sp-yida-protocol-example-primary[\s\S]*?sp-yida-run[\s\S]*?sp-yida-owner-open[\s\S]*?window\.arm\(\)[\s\S]*?sp-yida-owner-save/u)
  assert.doesNotMatch(helper, /\.evaluate\(|\.fulfill\(|vi\.|createApp\(|setTimeout|waitForTimeout|readEnablement/u)
  assert.match(helper, /return Reflect\.apply\(original, this, args\)/u)
  assert(verifier.indexOf('observeYidaOwnerOffQueries(Client)') < verifier.indexOf('automation = await (automationScenario'))
  assert.match(verifier, /finally \{\r?\n\s*try \{ ownerOffQueryObservation\?\.restore\(\) \}/u)
  assert.match(verifier, /writeFile\(path\.join\(scratch, 'yida-owner-log-proof\.json'\), ownerProofBytes, \{ flag: 'wx', mode: 0o600 \}\)/u)
  assert(runner.indexOf('yidaOwnerOffLogs = await verifyYidaOwnerOffRawLogs') > runner.indexOf("await checked('configured-app'"))
  assert.match(runner, /raw\.every\(bytes => !bytes\.includes\(Buffer\.from\(sentinel\)\)\)/u)
})

const transportHelperPath = 'packages/core-backend/tests/utils/stock-preparation-plm-full-app-transport-diagnostics.ts'
function loadTransportHelper(source = read(transportHelperPath), window = {}, keepNames = false) {
  const requireCore = createRequire(path.join(repoRoot, 'packages/core-backend/package.json'))
  const ts = requireCore('typescript')
  let compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  if (keepNames) {
    const esbuild = createRequire(requireCore.resolve('tsx'))('esbuild')
    compiled = esbuild.transformSync(compiled, { loader: 'js', format: 'cjs', target: 'es2022', keepNames: true }).code
  }
  const module = { exports: {} }, clock = { value: 100, now() { return this.value } }
  runInNewContext(compiled, { module, exports: module.exports, window, URL, Request, Error, TypeError, SyntaxError,
    Promise, performance: clock, require: name => {
      assert.equal(name, 'node:events', 'transport helper must not gain unreviewed runtime imports')
      return { errorMonitor }
    } }, { timeout: 1000 })
  return { ...module.exports, clock }
}
const transportPath = '/api/integration/automation-read/grants'
function transportWindow(fetch, records, sink) {
  return { fetch, location: { href: 'http://127.0.0.1:8910/', origin: 'http://127.0.0.1:8910' },
    __plmFullAppTransportDiagnostic: sink ?? (record => { records.push(JSON.parse(JSON.stringify(record))); return Promise.resolve() }) }
}
const flushTransport = async () => { await Promise.resolve(); await Promise.resolve() }

async function assertTransportSdkSuccess(source) {
  const records = [], receiver = {}, controller = new AbortController()
  const fetchArgs = [transportPath + '?private=synthetic-secret', { method: 'GET', signal: controller.signal, headers: { authorization: 'synthetic-secret' } }]
  const chunk = { done: false, value: new Uint8Array([7]) }, eof = { done: true, value: undefined }
  const promises = [Promise.resolve(chunk), Promise.resolve(eof)]
  let fetchCalls = 0, getReaderCalls = 0, readCalls = 0, releaseCalls = 0
  const reader = { read(...args) { assert.equal(this, reader); assert.deepEqual(args, ['same-read-arg']); return promises[readCalls++] },
    releaseLock() { assert.equal(this, reader); releaseCalls += 1 } }
  const originalRelease = reader.releaseLock
  const body = { getReader(...args) { assert.equal(this, body); assert.deepEqual(args, ['same-reader-arg']); getReaderCalls += 1; return reader } }
  const response = { status: 200, body,
    clone() { assert.fail('observer must never clone') }, json() { assert.fail('observer must never read json') },
    text() { assert.fail('observer must never read text') } }
  const fetchPromise = Promise.resolve(response)
  const window = transportWindow(function (...args) { assert.equal(this, receiver); assert.equal(args[0], fetchArgs[0]);
    assert.equal(args[1], fetchArgs[1]); fetchCalls += 1; return fetchPromise }, records)
  const helper = loadTransportHelper(source, window)
  helper.installBrowserSdkDiagnostics()
  const result = Reflect.apply(window.fetch, receiver, fetchArgs)
  assert.equal(result, fetchPromise, 'fetch must preserve original Promise identity')
  assert.equal(await result, response, 'fetch must preserve original Response identity')
  assert.equal(body.getReader('same-reader-arg'), reader, 'getReader must preserve original reader identity')
  assert.equal(readCalls, 0, 'observer must not initiate a body read')
  const first = reader.read('same-read-arg')
  assert.equal(first, promises[0], 'read must preserve original Promise identity')
  assert.equal(await first, chunk)
  assert(!records.some(record => record.event === 'BODY_DONE'), 'a chunk is not EOF')
  helper.clock.value = 240
  const last = reader.read('same-read-arg')
  assert.equal(last, promises[1]); assert.equal(await last, eof)
  assert.deepEqual(records.map(record => record.event), ['REQUEST', 'HEADERS', 'BODY_DONE'])
  assert(records.every(record => record.ordinal === 1 && record.apiKey === 'automationGrants' && record.method === 'GET' && !record.signalAborted))
  assert.equal(records.at(-1).elapsedMs, 140)
  assert.equal(records.at(-1).complete, true)
  assert.equal(reader.releaseLock, originalRelease); reader.releaseLock()
  assert.deepEqual([fetchCalls, getReaderCalls, readCalls, releaseCalls], [1, 1, 2, 1], 'only caller-initiated native calls occur')
  // The SDK can reject invalid JSON/envelope/DTO after native EOF. An abort
  // following EOF must remain visible; EOF alone is not SDK parse success.
  helper.clock.value = 390
  controller.abort('synthetic-private-reason')
  await flushTransport()
  assert.equal(records.at(-1).event, 'SIGNAL_ABORT'); assert.equal(records.at(-1).signalAborted, true)
  assert.equal(records.at(-1).elapsedMs, 290); assert.equal(records.at(-1).complete, true)
  assert(!records.some(record => record.event === 'SDK_PARSE_SUCCEEDED'))
  assert(!JSON.stringify(records).includes('synthetic-secret'))
  assert(!JSON.stringify(records).includes('synthetic-private-reason'))
  for (const url of ['/api/integration/other', 'http://example.invalid' + transportPath]) {
    const quiet = [], quietBody = { getReader() { return reader } }, originalReader = quietBody.getReader
    const quietResponse = { status: 200, body: quietBody }, quietPromise = Promise.resolve(quietResponse)
    const quietWindow = transportWindow(function (...args) { assert.equal(this, receiver); assert.equal(args[0], url); return quietPromise }, quiet)
    loadTransportHelper(source, quietWindow).installBrowserSdkDiagnostics()
    assert.equal(Reflect.apply(quietWindow.fetch, receiver, [url]), quietPromise)
    assert.equal(await quietPromise, quietResponse); await flushTransport()
    assert.equal(quietBody.getReader, originalReader); assert.deepEqual(quiet, [], 'non-target calls must have no observations or wrapping')
  }
}

async function assertTransportSdkErrors(source) {
  for (const mode of ['fetch-throw', 'fetch-reject', 'reader-throw', 'read-throw', 'read-reject']) {
    const records = [], error = new TypeError('synthetic-private-error'), controller = new AbortController()
    const receiver = {}, rejection = Promise.reject(error)
    void rejection.catch(() => {})
    const read = mode === 'read-reject' ? function (...args) { assert.equal(this, reader); assert.deepEqual(args, ['read-arg']); return rejection }
      : function (...args) { assert.equal(this, reader); assert.deepEqual(args, ['read-arg']); throw error }
    const reader = { read }, body = { getReader(...args) { assert.equal(this, body); assert.deepEqual(args, ['reader-arg']);
      if (mode === 'reader-throw') throw error; return reader } }, response = { status: 200, body }
    const fetchPromise = mode === 'fetch-reject' ? rejection : Promise.resolve(response)
    const window = transportWindow(function (...args) { assert.equal(this, receiver); assert.equal(args[0], transportPath);
      assert.equal(args[1].signal, controller.signal); if (mode === 'fetch-throw') throw error; return fetchPromise }, records)
    const helper = loadTransportHelper(source, window); helper.installBrowserSdkDiagnostics()
    const invoke = () => Reflect.apply(window.fetch, receiver, [transportPath, { method: 'GET', signal: controller.signal }])
    if (mode === 'fetch-throw') assert.throws(invoke, thrown => thrown === error)
    else {
      const result = invoke(); assert.equal(result, fetchPromise)
      if (mode === 'fetch-reject') await assert.rejects(result, thrown => thrown === error)
      else {
        assert.equal(await result, response)
        if (mode === 'reader-throw') assert.throws(() => body.getReader('reader-arg'), thrown => thrown === error)
        else {
          assert.equal(body.getReader('reader-arg'), reader)
          if (mode === 'read-throw') assert.throws(() => reader.read('read-arg'), thrown => thrown === error)
          else { const result = reader.read('read-arg'); assert.equal(result, rejection); await assert.rejects(result, thrown => thrown === error) }
        }
      }
    }
    await flushTransport()
    const rejected = records.filter(record => record.event === 'SDK_REJECT')
    assert.equal(rejected.length, 1, 'original transport failures must be diagnosed once')
    assert.equal(rejected[0].operation, mode.startsWith('fetch') ? 'FETCH' : mode === 'reader-throw' ? 'GET_READER' : 'READ')
    assert.equal(rejected[0].failure, 'TYPE'); assert.equal(rejected[0].signalAborted, false)
    assert(!records.some(record => record.event === 'BODY_DONE'))
    helper.clock.value = 160; controller.abort(); await flushTransport()
    assert.equal(records.at(-1).event, 'SIGNAL_ABORT'); assert.equal(records.at(-1).signalAborted, true)
    assert(!JSON.stringify(records).includes(error.message))
  }
}

function assertTransportProjection(helper) {
  const project = value => JSON.parse(JSON.stringify(helper.transportDiagnostic(value)))
  const baseline = project({})
  assert.deepEqual(baseline, { transport: 'OTHER', ordinal: 0, requestSequence: 0, apiKey: 'unknown', method: 'OTHER', event: 'OTHER', operation: 'OTHER',
    elapsedMs: 0, signalAborted: false, complete: false, status: 0, failure: 'OTHER' })
  const fields = { transport: ['SDK', 'PROXY', 'PLAYWRIGHT'], apiKey: ['automationOptions', 'automationGrants', 'automationRequests',
    'automationGrantDetail', 'automationRequestDetail', 'automationRevoke', 'automationScheduleActivation'],
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], event: ['REQUEST', 'HEADERS', 'BODY_DONE', 'SDK_REJECT', 'SIGNAL_ABORT',
      'REQUEST_FINISHED', 'REQUEST_FAILED', 'READER_REJECT', 'UPSTREAM_HEADERS', 'UPSTREAM_END', 'UPSTREAM_COMPLETE', 'UPSTREAM_EARLY_CLOSE',
      'DOWNSTREAM_FINISH', 'DOWNSTREAM_EARLY_CLOSE', 'ERROR'], operation: ['FETCH', 'GET_READER', 'READ', 'PROXY', 'MONITOR', 'UPSTREAM_REQUEST', 'UPSTREAM_RESPONSE', 'DOWNSTREAM'],
    failure: ['ABORT', 'TYPE', 'SYNTAX', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ABORTED', 'FAILED', 'BLOCKED_BY_CLIENT', 'CONNECTION_RESET',
      'CONNECTION_CLOSED', 'CONNECTION_REFUSED', 'EMPTY_RESPONSE', 'TIMED_OUT', 'NETWORK_CHANGED', 'NAME_NOT_RESOLVED', 'INTERNET_DISCONNECTED', 'NONE'] }
  for (const [field, allowed] of Object.entries(fields)) {
    for (const value of allowed) assert.deepEqual(project({ [field]: value }), { ...baseline, [field]: value })
    for (const value of [null, true, 123, {}, [], 'synthetic-private', ...allowed.flatMap(value => ['prefix' + value, value + 'suffix'])])
      assert.deepEqual(project({ [field]: value }), baseline)
  }
  for (const field of ['ordinal', 'requestSequence', 'elapsedMs']) {
    for (const value of [0, 1, 100, Number.MAX_SAFE_INTEGER]) assert.equal(project({ [field]: value })[field], value)
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '10', null, true, {}]) assert.equal(project({ [field]: value })[field], 0)
  }
  for (const field of ['signalAborted', 'complete']) {
    assert.equal(project({ [field]: true })[field], true)
    for (const value of ['true', 1, {}, [], null, false]) assert.equal(project({ [field]: value })[field], false)
  }
  for (const value of [100, 200, 599]) assert.equal(project({ status: value }).status, value)
  for (const value of [99, 600, 200.5, '200', null, Infinity]) assert.equal(project({ status: value }).status, 0)
  const sentinel = 'SYN_PRIVATE_QUERY_TOKEN_ERROR'
  const output = project({ url: sentinel, token: sentinel, query: sentinel, body: sentinel, error: new Error(sentinel), [sentinel]: sentinel })
  assert.deepEqual(output, baseline); assert(!JSON.stringify(output).includes(sentinel))
  for (const path of ['toString', '__proto__', '/api/integration/other', transportPath + '/not-a-uuid']) assert.equal(helper.automationTransportKey(path), undefined)
}

function assertTransportProxy(helper) {
  const proxy = new EventEmitter(), records = [], request = { url: transportPath + '?private=synthetic-secret', method: 'GET' }
  const upstreamRequest = new EventEmitter(), downstream = Object.assign(new EventEmitter(), { writableFinished: false })
  const upstreamResponse = Object.assign(new EventEmitter(), { statusCode: 200, complete: false })
  const originalArgs = [upstreamRequest, request, downstream]
  let originalCalls = 0
  proxy.on('proxyReq', function (...args) { assert.equal(this, proxy); assert.deepEqual(args, originalArgs); originalCalls += 1 })
  helper.observeAutomationProxy(proxy, value => records.push(JSON.parse(JSON.stringify(value))))
  assert.equal(proxy.emit('proxyReq', ...originalArgs), true); assert.equal(originalCalls, 1)
  proxy.emit('proxyRes', upstreamResponse, request, downstream)
  assert.equal(upstreamResponse.listenerCount('data'), 0, 'proxy observer must not consume a stream')
  upstreamResponse.emit('end')
  assert(!records.some(record => record.event === 'UPSTREAM_COMPLETE'), 'end without native complete is not complete')
  downstream.emit('close'); upstreamResponse.emit('close')
  assert(records.some(record => record.event === 'DOWNSTREAM_EARLY_CLOSE'))
  assert(records.some(record => record.event === 'UPSTREAM_EARLY_CLOSE'))
  const rawError = Object.assign(new Error('synthetic-private-error'), { code: 'ECONNRESET' })
  for (const [surface, operation] of [[upstreamRequest, 'UPSTREAM_REQUEST'], [upstreamResponse, 'UPSTREAM_RESPONSE'], [downstream, 'DOWNSTREAM'], [proxy, 'PROXY']]) {
    assert.equal(surface.listenerCount('error'), 0, 'diagnostics must not add a swallowing error listener')
    assert.throws(() => surface.emit('error', rawError, request), thrown => thrown === rawError)
    assert.equal(records.at(-1).event, 'ERROR'); assert.equal(records.at(-1).operation, operation)
    assert.equal(records.at(-1).failure, 'ECONNRESET')
  }
  upstreamResponse.complete = true; upstreamResponse.emit('end')
  downstream.writableFinished = true; downstream.emit('finish')
  const earlyBefore = records.filter(record => record.event.endsWith('EARLY_CLOSE')).length
  upstreamResponse.emit('close'); downstream.emit('close')
  assert.equal(records.filter(record => record.event.endsWith('EARLY_CLOSE')).length, earlyBefore)
  assert.equal(records.filter(record => record.event === 'UPSTREAM_COMPLETE').length, 1)
  assert.equal(records.at(-1).event, 'DOWNSTREAM_FINISH'); assert.equal(records.at(-1).complete, true)
  assert(records.every(record => record.ordinal === 1 && record.apiKey === 'automationGrants'))
  assert(!JSON.stringify(records).includes('synthetic-secret')); assert(!JSON.stringify(records).includes(rawError.message))
  const quietRequest = { url: '/api/integration/other', method: 'GET' }, quietDownstream = new EventEmitter(), quietUpstream = new EventEmitter()
  const before = records.length
  // Preserve the original positive-control listener without supplying a new request to it.
  proxy.removeAllListeners('proxyReq'); helper.observeAutomationProxy(proxy, value => records.push(JSON.parse(JSON.stringify(value))))
  proxy.emit('proxyReq', quietUpstream, quietRequest, quietDownstream)
  proxy.emit('proxyRes', quietUpstream, quietRequest, quietDownstream)
  quietUpstream.emit('end'); quietDownstream.emit('close')
  assert.equal(records.length, before); assert.equal(quietUpstream.listenerCount('end'), 0)
  const failing = new EventEmitter(), failedDownstream = new EventEmitter(), failedUpstream = new EventEmitter()
  helper.observeAutomationProxy(failing, () => { throw new Error('synthetic-sink') })
  assert.doesNotThrow(() => failing.emit('proxyReq', failedUpstream, request, failedDownstream))
  assert.throws(() => failedUpstream.emit('error', rawError), thrown => thrown === rawError)
}

test('transport diagnostics execute the actual helper with closed enums, counts and no private values', () => {
  assertTransportProjection(loadTransportHelper())
})
test('SDK diagnostics preserve this, args, original Promise/response/reader/chunk and caller-only body reads', async () => {
  await assertTransportSdkSuccess(read(transportHelperPath))
})
test('SDK diagnostics preserve native sync throws and rejected Promise identity for fetch/getReader/read', async () => {
  await assertTransportSdkErrors(read(transportHelperPath))
})
test('SDK observer bounds target input to primitive URLs with own-data init and leaves non-target accessors untouched', async () => {
  for (const [input, target] of [['/api/integration/other', false], [transportPath, true], [new URL('http://127.0.0.1:8910' + transportPath), false],
    [{ get url() { assert.fail('custom source URL getter must not be inspected') } }, false]]) {
    const records = [], originalError = new Error('synthetic-original'), receiver = {}
    let reads = 0, calls = 0
    const init = { get method() { reads += 1; return 'GET' }, get signal() { reads += 1; return undefined } }
    const window = transportWindow(function (...args) {
      assert.equal(this, receiver); assert.equal(args[0], input); assert.equal(args[1], init)
      calls += 1
      // This native positive control determines whether accessor reads happen.
      if (target) { args[1].method; args[1].signal }
      throw originalError
    }, records)
    loadTransportHelper(undefined, window).installBrowserSdkDiagnostics()
    assert.throws(() => Reflect.apply(window.fetch, receiver, [input, init]), thrown => thrown === originalError)
    assert.equal(calls, 1); assert.equal(reads, target ? 2 : 0); assert.deepEqual(records, [])
  }
})
test('SDK observer script is self-contained under the real esbuild keepNames transform used by tsx', async () => {
  const source = read(transportHelperPath)
  const verify = async source => {
    const records = [], eof = { done: true }, readPromise = Promise.resolve(eof), reader = { read() { return readPromise } }
    const response = { status: 200, body: { getReader() { return reader } } }, fetchPromise = Promise.resolve(response)
    const window = transportWindow(() => fetchPromise, records), helper = loadTransportHelper(source, window, true)
    assert(helper.installBrowserSdkDiagnostics.toString().includes('__name'), 'actual keepNames dependency must be present')
    const script = helper.browserSdkDiagnosticScript()
    // A new realm receives only browser globals, none of the module's closures.
    runInNewContext(script, { window, URL, Error, TypeError, SyntaxError, Promise, performance: helper.clock }, { timeout: 1000 })
    assert.equal(window.fetch(transportPath), fetchPromise); assert.equal(await fetchPromise, response)
    assert.equal(response.body.getReader(), reader); assert.equal(reader.read(), readPromise); assert.equal(await readPromise, eof)
    assert.deepEqual(records.map(record => record.event), ['REQUEST', 'HEADERS', 'BODY_DONE'])
  }
  await verify(source)
  const needle = 'function __name(fn, name) { return Object.defineProperty(fn, "name", { value: name, configurable: true }); }'
  assert(source.includes(needle))
  await assert.rejects(verify(source.replace(needle, '')), error => error?.name === 'ReferenceError')
  console.log('TRANSPORT_MUTATION serialized-name-helper KILLED')
})
async function assertSdkObserverExceptionIsolation(source) {
  const records = [], originalError = new Error('synthetic-original'), getterError = new Error('synthetic-getter')
  Object.defineProperty(originalError, 'name', { get() { throw getterError } })
  const nativeRead = Promise.resolve({ done: true }), reader = Object.preventExtensions(Object.create({ read() { return nativeRead } }))
  const response = { status: 200, body: { getReader() { return reader } } }, nativeFetch = Promise.resolve(response)
  const window = transportWindow(() => nativeFetch, records), helper = loadTransportHelper(source, window)
  helper.installBrowserSdkDiagnostics()
  assert.equal(window.fetch(transportPath), nativeFetch); assert.equal(await nativeFetch, response)
  let obtained
  assert.doesNotThrow(() => { obtained = response.body.getReader() }, 'failed instrumentation must preserve successful getReader return')
  assert.equal(obtained, reader)
  assert.equal(reader.read(), nativeRead); await nativeRead
  assert(records.some(record => record.event === 'ERROR' && record.operation === 'MONITOR'))
  let classified
  assert.doesNotThrow(() => { classified = helper.transportError(originalError) })
  assert.equal(classified, 'OTHER')
  for (const mode of ['fetch', 'reader', 'read']) {
    const records = [], errorReader = { read() { throw originalError } }, errorBody = { getReader() {
      if (mode === 'reader') throw originalError; return errorReader } }
    const nativeResponse = { status: 200, body: errorBody }, promise = Promise.resolve(nativeResponse)
    const window = transportWindow(() => { if (mode === 'fetch') throw originalError; return promise }, records)
    loadTransportHelper(source, window).installBrowserSdkDiagnostics()
    if (mode === 'fetch') assert.throws(() => window.fetch(transportPath), thrown => thrown === originalError)
    else {
      assert.equal(window.fetch(transportPath), promise); await promise
      if (mode === 'reader') assert.throws(() => errorBody.getReader(), thrown => thrown === originalError)
      else { assert.equal(errorBody.getReader(), errorReader); assert.throws(() => errorReader.read(), thrown => thrown === originalError) }
    }
    assert.equal(records.at(-1).event, 'SDK_REJECT'); assert.equal(records.at(-1).failure, 'OTHER')
  }
}
test('SDK observer installation failure and throwing exception getters preserve original return and error identity', async () => {
  await assertSdkObserverExceptionIsolation(read(transportHelperPath))
})
test('SDK diagnostic sink throw/reject cannot replace the original result or create an unhandled rejection', async () => {
  const unhandled = [], listener = error => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    for (const sink of [() => { throw new Error('synthetic-sink') }, () => Promise.reject(new Error('synthetic-sink'))]) {
      const eof = { done: true }, nativeRead = Promise.resolve(eof), reader = { read() { return nativeRead } }
      const response = { status: 200, body: { getReader() { return reader } } }, nativeFetch = Promise.resolve(response)
      const window = transportWindow(() => nativeFetch, [], sink)
      loadTransportHelper(undefined, window).installBrowserSdkDiagnostics()
      assert.equal(window.fetch(transportPath), nativeFetch); assert.equal(await nativeFetch, response)
      assert.equal(response.body.getReader(), reader); assert.equal(reader.read(), nativeRead); assert.equal(await nativeRead, eof)
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', listener) }
})
test('actual proxy observer sees native complete/end/finish/early-close and preserves error throws and non-target behavior', () => {
  assertTransportProxy(loadTransportHelper())
})
test('transport observation is wired into actual SDK startup, Vite proxy and original Playwright body reader without relaxing failures', () => {
  const browser = read('packages/core-backend/tests/utils/stock-preparation-plm-full-app-browser.ts'), helper = read(transportHelperPath)
  assert(browser.indexOf('await context.addInitScript({ content: browserSdkDiagnosticScript() })') < browser.indexOf('const page = await context.newPage()'))
  assert.match(browser, /configure: \(proxy:[^\n]+\) => observeAutomationProxy\(proxy, reportTransport\)/u)
  assert.match(browser, /context\.on\('requestfinished', request => monitorTransport\(request, 'REQUEST_FINISHED'\)\)/u)
  assert.match(browser, /payload = await response\.json\(\)\r?\n\s*monitorTransport\(response\.request\(\), 'BODY_DONE', response\.status\(\)\)/u)
  assert.match(browser, /if \(validationStage === 'API_BODY'\) monitorTransport\(response\.request\(\), 'READER_REJECT', response\.status\(\), error\)/u)
  assert.match(browser, /counts\.requestFailures \+= 1; note\('REQUEST_FAILED'\)/u)
  assert.match(browser, /requestSequence: requestSequence\(request\), complete: event === 'BODY_DONE'/u)
  assert.doesNotMatch(helper, /\.clone\(|\.json\(|\.text\(|\.cancel\(|\.resume\(|\.pipe\(|\.on\('data'|setTimeout|clearTimeout|\.abort\(/u)
  assert.doesNotMatch(helper, /process\.env|\.reason|\.message|\.stack/u)
  assert.match(helper, /EOF is only native stream completion/u)
})
test('actual in-memory transport mutations invalidate the transparency and closed diagnostic contracts', async () => {
  const source = read(transportHelperPath)
  const mutations = [
    ['closed-enum', 'choices.includes(value)', 'true', code => assertTransportProjection(loadTransportHelper(code))],
    ['integer', 'Number.isSafeInteger(value) && Number(value) >= 0', 'true', code => assertTransportProjection(loadTransportHelper(code))],
    ['status', 'Number.isInteger(input.status) && Number(input.status) >= 100 && Number(input.status) <= 599', 'true', code => assertTransportProjection(loadTransportHelper(code))],
    ['boolean-signal', 'input.signalAborted === true', 'Boolean(input.signalAborted)', code => assertTransportProjection(loadTransportHelper(code))],
    ['boolean-complete', 'input.complete === true', 'Boolean(input.complete)', code => assertTransportProjection(loadTransportHelper(code))],
    ['own-path', 'Object.hasOwn(paths, pathname)', 'pathname in paths', code => assertTransportProjection(loadTransportHelper(code))],
    ['same-origin', 'url.origin === window.location.origin', 'true', assertTransportSdkSuccess],
    ['non-target', 'if (!apiKey) return Reflect.apply(originalFetch, this, args)', 'if (false) return Reflect.apply(originalFetch, this, args)', assertTransportSdkSuccess],
    ['fetch-this', 'Reflect.apply(originalFetch, this, args)', 'Reflect.apply(originalFetch, undefined, args)', assertTransportSdkSuccess],
    ['fetch-args', 'Reflect.apply(originalFetch, this, args)', 'Reflect.apply(originalFetch, this, [])', assertTransportSdkSuccess],
    ['get-reader-this', 'Reflect.apply(originalGetReader, this, readerArgs)', 'Reflect.apply(originalGetReader, undefined, readerArgs)', assertTransportSdkSuccess],
    ['get-reader-args', 'Reflect.apply(originalGetReader, this, readerArgs)', 'Reflect.apply(originalGetReader, this, [])', assertTransportSdkSuccess],
    ['read-this', 'Reflect.apply(originalRead, this, readArgs)', 'Reflect.apply(originalRead, undefined, readArgs)', assertTransportSdkSuccess],
    ['read-args', 'Reflect.apply(originalRead, this, readArgs)', 'Reflect.apply(originalRead, this, [])', assertTransportSdkSuccess],
    ['eof', 'chunk.done && !bodyDone', '!bodyDone', assertTransportSdkSuccess],
    ['actual-signal', "signalAborted: signal?.aborted === true", 'signalAborted: false', assertTransportSdkSuccess],
    ['original-error', "throw error", "throw new Error('mutation')", assertTransportSdkErrors],
    ['fetch-promise-identity', "observe(result, instrument, error => { emit('SDK_REJECT', 'FETCH', failureFor(error)) })\n    return result", "observe(result, instrument, error => { emit('SDK_REJECT', 'FETCH', failureFor(error)) })\n    return result.then(value => value)", assertTransportSdkSuccess],
    ['read-promise-identity', '            return result\n          } })', '            return result.then(value => value)\n          } })', assertTransportSdkSuccess],
    ['upstream-complete', 'if (upstream.complete) emit', 'if (true) emit', code => assertTransportProxy(loadTransportHelper(code))],
    ['downstream-early-close', 'if (!downstream.writableFinished) emit', 'if (true) emit', code => assertTransportProxy(loadTransportHelper(code))],
    ['upstream-early-close', 'if (!upstream.complete) emit', 'if (true) emit', code => assertTransportProxy(loadTransportHelper(code))],
    ['error-monitor', '.on(errorMonitor,', ".on('error',", code => assertTransportProxy(loadTransportHelper(code))],
    ['reader-install-isolation', "} catch { emit('ERROR', 'MONITOR', 'OTHER') }\n        return reader", "} catch { throw new Error('mutation') }\n        return reader", assertSdkObserverExceptionIsolation],
    ['sdk-error-classifier-isolation', "} catch { return 'OTHER' }", "} catch { throw new Error('mutation') }", assertSdkObserverExceptionIsolation],
    ['monitor-error-classifier-isolation', '} catch { /* Exception getters are never allowed to replace an original failure. */ }', "} catch { throw new Error('mutation') }", assertSdkObserverExceptionIsolation],
  ]
  for (const [name, needle, replacement, verify] of mutations) {
    assert(source.includes(needle), 'transport mutation anchor required: ' + name)
    await assert.rejects(async () => verify(source.replaceAll(needle, replacement)), error => error?.code === 'ERR_ASSERTION', name)
    console.log('TRANSPORT_MUTATION ' + name + ' KILLED')
  }
})
