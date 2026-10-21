/// <reference lib="dom" />

import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { SourcePlanReadPlan } from '../../../../apps/web/src/services/integration/stockPreparation/sourcePlanDraft'

import type { Browser, Request, Response } from '@playwright/test'
import type { Logger, PreviewServer } from '../../../../apps/web/node_modules/vite'
import { runConfiguredK3Browser } from './stock-preparation-k3-full-app-browser'
import type { ConfiguredK3BrowserInput, ConfiguredK3BrowserResult } from './stock-preparation-k3-full-app-browser'
import { runConfiguredYidaBrowser } from './stock-preparation-yida-full-app-browser'
import type { ConfiguredYidaBrowserResult, YidaLocalWindowCounts } from './stock-preparation-yida-full-app-browser'
import { createYidaOwnerOffWindow, ownerOffPrefix, runConfiguredYidaOwnerOffBrowser } from './stock-preparation-yida-owner-off-full-app'
import type { YidaOwnerOffWindow } from './stock-preparation-yida-owner-off-full-app'
import { runConfiguredAutomationBrowser } from './stock-preparation-automation-full-app-browser'
import { authorConfiguredIntervalRule, runConfiguredIntervalBrowser } from './stock-preparation-automation-interval-full-app-browser'
import type { AutomationApiKey, AutomationCheckpoint, AutomationCheckpointReply, AutomationScenario, ConfiguredAutomationBrowserResult } from './stock-preparation-automation-full-app-browser'
import { automationTransportKey, browserSdkDiagnosticScript, observeAutomationProxy, transportDiagnostic, transportError } from './stock-preparation-plm-full-app-transport-diagnostics'
import { createDryRunStatusWindow, createMembersOffWindow, createProjectSheetsOffWindow } from './stock-preparation-main-migration-contract'

export interface ConfiguredAppBrowserInput {
  apiOrigin: string
  identifier: string
  password: string
  /** Existing caller-owned tmp/stock-preparation-plm-full-app-UUID directory; never a customer directory. */
  scratchDir: string
  tenantId: string
  systemId: string
  projectNo: string
  readPlan: SourcePlanReadPlan
  k3: ConfiguredK3BrowserInput
  yida: { projectNo: 'SYN-YIDA-PREVIEW' }
  automation: { scenario: AutomationScenario; ruleId: string; sheetId: string }
  /** Parent-verified, owned, original-config Vite output; never an arbitrary directory. */
  compiledWeb: { buildRoot: string; wrapperConfig: string; emittedFiles: Array<{ path: string; bytes: number; sha256: string }> }
}

const apiPaths = {
  login: '/api/auth/login',
  me: '/api/auth/me',
  dingTalkProbe: '/api/auth/dingtalk/launch',
  plugins: '/api/plugins',
  todoCount: '/api/todo/count',
  approvalCapability: '/api/approvals/admin/capability',
  methodProbe: '/api/method-probe',
  adapters: '/api/integration/adapters',
  externalSystems: '/api/integration/external-systems',
  stagingDescriptors: '/api/integration/staging/descriptors',
  tableActions: '/api/integration/table-actions',
  hubOverview: '/api/integration/hub/overview',
  readSourceConfigs: '/api/integration/read-source-configs',
  readSourceCompositions: '/api/integration/read-source-compositions',
  manifest: '/api/platform/apps/stock-preparation',
  preflight: '/api/integration/stock-preparation/preflight',
  sourceBinding: '/api/integration/stock-preparation/source-binding',
  roleCatalog: '/api/admin/roles',
  dataSources: '/api/data-sources',
  plans: '/api/integration/stock-preparation/read-plan-configs',
  projects: '/api/integration/stock-preparation/projects',
  operatorProjects: '/api/integration/stock-preparation/operator/projects',
  handoff: '/api/integration/stock-preparation/handoff',
  preview: '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run',
  automationOptions: '/api/integration/automation-read/options',
  automationGrants: '/api/integration/automation-read/grants',
  automationRequests: '/api/integration/automation-read/requests',
  automationScheduleActivation: '/api/integration/automation-read/schedule-activations',
  editorContext: '/api/multitable/context',
  editorFields: '/api/multitable/fields',
  editorView: '/api/multitable/view',
  editorBases: '/api/multitable/bases',
  editorAiAvailability: '/api/multitable/ai/availability',
  editorMentionSummary: '/api/comments/mention-summary',
  editorUnreadCount: '/api/comments/unread-count',
  editorSubscriptionCount: '/api/multitable/record-subscription-notifications/unread-count',
  editorDingtalkGroups: '/api/multitable/dingtalk-groups',
  editorApprovalTemplates: '/api/approval-templates',
  editorSheets: '/api/multitable/sheets',
} as const
type ApiKey = keyof typeof apiPaths | AutomationApiKey | 'conflictPolicies' | 'validate' | 'confirmSample' | 'approve' | 'activate' | 'k3Approve' | 'k3Read' | 'yidaBoard'
type JsonObject = Record<string, unknown>

export interface ConfiguredAppBrowserResult {
  status: 'passed'
  /** Internal child-to-parent handles. The parent must strip these before evidence output. */
  versionId: string
  validationId: string
  dryRunToken: string
  generation: number
  evidence: Record<string, boolean | number>
  counts: Record<string, unknown>
  k3: ConfiguredK3BrowserResult
  yida: ConfiguredYidaBrowserResult
  yidaOwnerOff: Awaited<ReturnType<typeof runConfiguredYidaOwnerOffBrowser>>
  automation: ConfiguredAutomationBrowserResult
}

const actionId = 'plm.stock-preparation.pull-bom.v1'
const planOperations = { validate: 'validate', 'confirm-sample': 'confirmSample', approve: 'approve', activate: 'activate' } as const
type PlanOperation = keyof typeof planOperations

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`APP_BROWSER_${code}`)
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keyFor(url: URL): ApiKey | undefined {
  for (const [key, pathname] of Object.entries(apiPaths)) {
    if (url.pathname === pathname) return key as keyof typeof apiPaths
  }
  if (/^\/api\/integration\/table-actions\/[A-Za-z0-9._-]+\/conflict-policies$/.test(url.pathname)) return 'conflictPolicies'
  if (/^\/api\/integration\/stock-preparation\/projects\/[A-Za-z0-9_-]+\/board$/.test(url.pathname)) return 'yidaBoard'
  if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}\/revoke$/.test(url.pathname)) return 'automationRevoke'
  if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}$/.test(url.pathname)) return 'automationGrantDetail'
  if (/^\/api\/integration\/automation-read\/requests\/[a-f0-9-]{36}$/.test(url.pathname)) return 'automationRequestDetail'
  if (/^\/api\/multitable\/sheets\/[^/]+\/automations$/.test(url.pathname)) return 'editorRules'
  const k3Match = url.pathname.match(/^\/api\/integration\/read-source-configs\/[A-Za-z0-9_-]+\/(approve|read)$/)
  if (k3Match) return k3Match[1] === 'approve' ? 'k3Approve' : 'k3Read'
  const match = url.pathname.match(/^\/api\/integration\/stock-preparation\/read-plan-configs\/[A-Za-z0-9_-]+\/(validate|confirm-sample|approve|activate)$/)
  if (match) return planOperations[match[1] as PlanOperation]
  return undefined
}

// Browser failure diagnostic contract: begin
function browserFailureDiagnostic(input: Record<string, unknown>) {
  // This is a closed projection, not an error-message scrubber. Unknown inputs
  // cannot become evidence tokens, even if they resemble an APP error code.
  const apiKeys = [
    'login', 'me', 'dingTalkProbe', 'plugins', 'todoCount', 'approvalCapability', 'methodProbe',
    'adapters', 'externalSystems', 'stagingDescriptors', 'tableActions', 'hubOverview',
    'readSourceConfigs', 'readSourceCompositions', 'manifest', 'preflight', 'sourceBinding',
    'roleCatalog', 'dataSources', 'plans', 'projects', 'operatorProjects', 'handoff', 'preview',
    'automationOptions', 'automationGrants', 'automationRequests', 'automationScheduleActivation',
    'editorContext', 'editorFields', 'editorView', 'editorBases', 'editorAiAvailability',
    'editorMentionSummary', 'editorUnreadCount', 'editorSubscriptionCount', 'editorDingtalkGroups',
    'editorApprovalTemplates', 'editorSheets', 'editorRules', 'conflictPolicies', 'validate',
    'confirmSample', 'approve', 'activate', 'k3Approve', 'k3Read', 'yidaBoard',
    'automationGrantDetail', 'automationRequestDetail', 'automationRevoke',
  ]
  const method = typeof input.method === 'string'
    && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method) ? input.method : 'OTHER'
  const apiKey = typeof input.apiKey === 'string' && apiKeys.includes(input.apiKey) ? input.apiKey : 'unknown'
  const surface = typeof input.surface === 'string'
    && ['API', 'SOCKET', 'DOCUMENT', 'ASSET'].includes(input.surface) ? input.surface : 'OTHER'
  const stages = ['REQUEST_FAILED', 'API_ROUTE', 'API_BODY', 'API_DETAIL', 'API_EMPTY_BOARD',
    'API_STATUS', 'API_SHAPE', 'API_ENVELOPE', 'API_PLUGIN', 'API_TODO', 'API_ACTIONS', 'API_DIRECTORY',
    'BUNDLE_SHAPE', 'BUNDLE_BODY', 'BUNDLE_HASH', 'EXPLICIT_STATUS']
  const validationStage = typeof input.validationStage === 'string'
    && stages.includes(input.validationStage) ? input.validationStage : 'OTHER'
  const networkFailures = ['ABORTED', 'FAILED', 'BLOCKED_BY_CLIENT', 'CONNECTION_RESET', 'CONNECTION_CLOSED',
    'CONNECTION_REFUSED', 'EMPTY_RESPONSE', 'TIMED_OUT', 'NETWORK_CHANGED', 'NAME_NOT_RESOLVED', 'INTERNET_DISCONNECTED']
  const failure = networkFailures.find(value => input.failureText === 'net::ERR_' + value) ?? 'OTHER'
  const appCodes = ['UNEXPECTED_API_RESPONSE', 'AUTOMATION_DETAIL_NOT_CORRELATED', 'AUTOMATION_DETAIL_REFUSAL_INVALID',
    'AUTOMATION_EMPTY_PROJECT_REFUSAL_REQUIRED', 'AUTOMATION_DUPLICATE_BOARD_REFUSAL', 'EXACT_PLUGIN_LIST_REQUIRED',
    'EXACT_INTEGRATION_PLUGIN_ACTIVE_REQUIRED', 'TODO_COUNT_DEGRADED', 'CONFIGURED_ACTION_CATALOG_REQUIRED',
    'INTERVAL_HOME_DIRECTORY_RESPONSE_REQUIRED', 'BUNDLE_RESPONSE_REQUIRED', 'BUNDLE_RESPONSE_BYTES_CHANGED',
    'REQUIRED_HTTP_STATUS', 'REQUIRED_JSON_ENVELOPE', 'REQUIRED_DATA_ENVELOPE']
    .map(value => 'APP_BROWSER_' + value)
  for (const key of apiKeys) for (const suffix of ['HTTP_STATUS', 'JSON_SHAPE', 'ERROR_ENVELOPE']) {
    appCodes.push('APP_BROWSER_' + key.toUpperCase() + '_' + suffix)
  }
  const message = input.error instanceof Error ? input.error.message : undefined
  const errorCode = typeof message === 'string' && appCodes.includes(message) ? message
    : input.error instanceof SyntaxError ? 'JSON_SYNTAX'
      : input.error !== undefined && ['API_BODY', 'BUNDLE_BODY'].includes(validationStage) ? 'BODY_READ' : 'OTHER'
  return { method, apiKey, surface, failure, validationStage, errorCode }
}
// Browser failure diagnostic contract: end

/**
 * Actual index.html -> main.ts -> App.vue -> history router + Pinia. No alternate HTML,
 * component mount, token injection, or intercepted response body. Only explicitly
 * armed source binding/plan/K3 configuration metadata writes and readonly previews are permitted.
 * The caller supplies the real, migrated, synthetic backend and the Node egress/.env
 * preloader. Chromium has an independent HTTP + WebSocket origin firewall below.
 */
export async function runConfiguredAppBrowser(input: ConfiguredAppBrowserInput,
  repositoryRoot: string, checkpoint: (command: AutomationCheckpoint) => Promise<AutomationCheckpointReply>): Promise<ConfiguredAppBrowserResult> {
  const webRoot = path.join(repositoryRoot, 'apps', 'web')
  const progress = (phase: string) => console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-phase', phase }))
  const reportTransport = (value: Record<string, unknown>) => console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({
    stage: 'browser-transport-diagnostic', ...transportDiagnostic(value),
  }))
  progress('OWNED_SETUP')
  const api = new URL(input.apiOrigin)
  check(api.protocol === 'http:' && api.hostname === '127.0.0.1' && api.port, 'API_LOOPBACK_REQUIRED')
  check(api.origin === input.apiOrigin && !api.username && !api.password, 'API_ORIGIN_ONLY')
  check(input.identifier.trim() && input.password, 'PASSWORD_LOGIN_REQUIRED')
  check(input.tenantId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.systemId)
    && input.projectNo === 'SYN-VALIDATION' && object(input.readPlan), 'SYNTHETIC_CONFIG_REQUIRED')
  check(object(input.readPlan.part) && typeof input.readPlan.part.nameField === 'string', 'SYNTHETIC_PART_MAPPING_REQUIRED')
  check(object(input.k3) && input.k3.systemId !== input.systemId, 'SEPARATE_K3_FIXTURE_REQUIRED')
  check(object(input.yida) && input.yida.projectNo === 'SYN-YIDA-PREVIEW', 'SEPARATE_YIDA_FIXTURE_REQUIRED')
  check(['manual', 'interval'].includes(input.automation.scenario), 'AUTOMATION_SCENARIO_REQUIRED')
  const partNameField = input.readPlan.part.nameField
  const compiledWeb = input.compiledWeb
  const bundleFiles = new Map<string, { bytes: number; sha256: string }>()
  const scratch = await realpath(input.scratchDir)
  const ownedTmp = await realpath(path.join(repositoryRoot, 'tmp'))
  check(path.relative(scratch, input.scratchDir) === ''
    && path.dirname(scratch) === ownedTmp
    && /^stock-preparation-plm-full-app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path.basename(scratch)),
  'OWNED_SCRATCH_REQUIRED')
  const scratchRelative = path.relative(repositoryRoot, scratch).replaceAll('\\', '/')
  check(compiledWeb && compiledWeb.buildRoot === scratchRelative + '/build/web/dist',
    'OWNED_BUNDLE_PATH_REQUIRED')
  check(compiledWeb.wrapperConfig === scratchRelative + '/build/web/vite.config.mjs',
    'OWNED_BUNDLE_CONFIG_REQUIRED')
  const bundleRoot = path.join(repositoryRoot, compiledWeb.buildRoot)
  for (const entry of [bundleRoot, path.join(repositoryRoot, compiledWeb.wrapperConfig)]) {
    check(path.relative(await realpath(entry), entry) === '', 'OWNED_BUNDLE_REALPATH_REQUIRED')
  }
  for (const file of compiledWeb.emittedFiles) {
    check(file.path.startsWith(compiledWeb.buildRoot + '/') && !file.path.includes('\\')
      && !file.path.split('/').some(part => !part || part === '.' || part === '..')
      && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
    'BUNDLE_FILE_INVALID')
    const urlPath = '/' + file.path.slice(compiledWeb.buildRoot.length + 1)
    check(!bundleFiles.has(urlPath), 'BUNDLE_FILE_DUPLICATED')
    bundleFiles.set(urlPath, file)
  }
  check(bundleFiles.has('/index.html') && bundleFiles.size > 1, 'BUNDLE_ENTRY_REQUIRED')
  const browserScratch = await mkdtemp(path.join(scratch, 'browser-'))
  const emptyEnvDir = path.join(browserScratch, 'empty-env')
  const cacheDir = path.join(browserScratch, 'vite-cache')
  await mkdir(emptyEnvDir)
  await mkdir(cacheDir)
  check((await readdir(emptyEnvDir)).length === 0, 'EMPTY_ENV_DIRECTORY_REQUIRED')

  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  // Resolve the package through the web workspace, then use its published ESM
  // entry. require.resolve('vite') selects index.cjs; dynamic-importing that
  // wrapper does not expose all of Vite's ESM named exports.
  const vitePackage = webRequire('vite/package.json') as { exports: { '.': { import: { default: string } } } }
  const viteEntry = path.resolve(path.dirname(webRequire.resolve('vite/package.json')), vitePackage.exports['.'].import.default)
  progress('VITE_IMPORT')
  const { preview: previewVite } = await import(pathToFileURL(viteEntry).href) as typeof import('../../../../apps/web/node_modules/vite')
  progress('PLAYWRIGHT_IMPORT')
  const { chromium } = webRequire('@playwright/test') as typeof import('@playwright/test')
  let vite: PreviewServer | undefined
  let browser: Browser | undefined
  let phase = 'CONFIG'
  let closing = false
  const faults: string[] = []
  const pendingChecks = new Set<Promise<void>>()
  const bundleServedFiles = new Set<string>()
  let bundleDocumentResponses = 0
  const successes = Object.fromEntries([...Object.keys(apiPaths), 'editorRules', 'conflictPolicies', 'validate', 'confirmSample', 'approve', 'activate', 'k3Approve', 'k3Read', 'yidaBoard', 'automationGrantDetail', 'automationRequestDetail', 'automationRevoke'].map(key => [key, 0])) as Record<ApiKey, number>
  const counts = { loginSubmissions: 0, installTabVisits: 0, reloads: 0, scopeReloads: 0, k3Reloads: 0, apiRequests: 0, apiResponses: 0,
    expectedEmptyBoardRefusals: 0, expectedEmptyBoardConsoleErrors: 0,
    pageErrors: 0, consoleErrors: 0, requestFailures: 0, forbiddenRequests: 0,
    websocketConnections: 0, viteHmrConnections: 0, websocketErrors: 0, viteErrors: 0, viteWarnings: 0,
  }
  const expectedWrites = new Map<ApiKey, { path: string; body: unknown }>()
  let detailObservation: { path: string; validated: Promise<boolean>; finish(valid: boolean): void;
    responses: number; consoleErrors: number; response?: Response } | undefined
  const writeCounts: Partial<Record<ApiKey, number>> = {}
  const observedScopes: Array<{ kind: 'binding' | 'preview'; tenantMatched: boolean; workspaceNull: boolean; workspaceTenantAlias: boolean }> = []
  let configuredActionCatalogVerified = false
  let loginToken = ''
  let canceledActions = 0
  let k3WorkspaceId: string | null | undefined
  let yidaLocalWindow = false
  let yidaOwnerOffWindow: YidaOwnerOffWindow | undefined
  let boardProject = input.yida.projectNo as string
  let editorViewId: string | undefined
  let observedHomeDirectory: { responseCount: number; data: JsonObject } | undefined
  const yidaNetwork: YidaLocalWindowCounts = { apiRequests: 0, backgroundHubOverviewGets: 0,
    nonBackgroundApiRequests: 0, businessPostRequests: 0, externalRequests: 0 }
  const armWrite = (key: ApiKey, pathname: string, body: unknown) => {
    check(!expectedWrites.has(key), 'WRITE_ALREADY_ARMED')
    expectedWrites.set(key, { path: pathname, body })
  }
  const note = (code: string) => { if (faults.length < 24) faults.push(code) }
  const logger: Logger = {
    hasWarned: false,
    info() {},
    warn() { counts.viteWarnings += 1; logger.hasWarned = true },
    warnOnce() { counts.viteWarnings += 1; logger.hasWarned = true },
    error() { counts.viteErrors += 1; note('VITE_ERROR') },
    clearScreen() {},
    hasErrorLogged() { return false },
  }

  // Do not expose inherited VITE_* values to this browser. Restore the caller's
  // environment after Vite resolves its config; no environment file is created.
  const savedEnvironment = new Map<string, string | undefined>()
  for (const key of [...Object.keys(process.env).filter(key => /^VITE_/i.test(key)), 'METASHEET_ENV_DIR']) {
    savedEnvironment.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.METASHEET_ENV_DIR = emptyEnvDir
  try {
    try {
      // Use Vite's real config loader: it supplies the native config's
      // __dirname semantics, which plain ESM import cannot do. Its generated
      // timestamp bundle is removed by Vite; source stays byte-identical.
      // loadEnv sees only our owned empty directory and the read-denial guard.
      phase = 'CONFIG_CREATE'
      progress(phase)
      const commonViteOptions = {
        root: webRoot, base: '/', mode: 'production',
        configFile: path.join(repositoryRoot, compiledWeb.wrapperConfig), envFile: false,
        envDir: emptyEnvDir, cacheDir, customLogger: logger,
        define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      } as const
      const proxy = {
        '/api': { target: input.apiOrigin, changeOrigin: false, ws: true,
          configure: (proxy: import('../../../../apps/web/node_modules/vite').HttpProxy.Server) => observeAutomationProxy(proxy, reportTransport) },
        '/socket.io': { target: input.apiOrigin, changeOrigin: false, ws: true },
      }
      vite = await previewVite({
        ...commonViteOptions,
        build: { outDir: bundleRoot },
        preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false, cors: false, proxy },
      })
      check(vite.config.isProduction && vite.config.mode === 'production', 'PRODUCTION_ENV_REQUIRED')
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    phase = 'LISTEN'
    progress(phase)
    const server = vite.httpServer
    check(server, 'REAL_VITE_HTTP_SERVER_REQUIRED')
    const address = server.address()
    check(address && typeof address !== 'string' && address.port > 0, 'REAL_VITE_ADDRESS_REQUIRED')
    const uiOrigin = `http://127.0.0.1:${address.port}`
    const projectSheetsOff = createProjectSheetsOffWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => loginToken, phase: () => phase, projectNo: () => boardProject,
      allowedPhases: ['YIDA_BOARD_NAVIGATION', 'AUTOMATION_INTERVAL_EDITOR', 'AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'] })
    const dryRunStatus = createDryRunStatusWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => loginToken, phase: () => phase, projectNo: () => boardProject,
      allowedPhases: ['YIDA_BOARD_NAVIGATION', 'AUTOMATION_INTERVAL_EDITOR', 'AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'] })
    const wsOrigin = uiOrigin.replace(/^http:/, 'ws:')
    const membersOff = createMembersOffWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => loginToken, phase: () => phase,
      allowedPhases: ['TOPBAR', 'EXPLICIT_TENANT_SCOPE', 'RELOAD', 'AUTOMATION_INTERVAL_EDITOR'] })

    phase = 'BROWSER'
    progress(phase)
    const nativeIsolation = createRequire(import.meta.url)(path.join(repositoryRoot, 'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs')) as
      { assertBrowserNetworkIsolation(): unknown }
    nativeIsolation.assertBrowserNetworkIsolation()
    const authority = createRequire(import.meta.url)(path.join(repositoryRoot, 'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs')) as {
      installedBrowserCandidate(): { executablePath: string; version: string } | undefined
    }
    const candidate = authority.installedBrowserCandidate()
    browser = await chromium.launch({ headless: true, executablePath: candidate?.executablePath ?? chromium.executablePath() })
    if (candidate) check(browser.version() === candidate.version, 'PINNED_BROWSER_VERSION_REQUIRED')
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' })
    await context.exposeBinding('__plmFullAppTransportDiagnostic', (_source, value: Record<string, unknown>) => reportTransport(value))
    await context.addInitScript({ content: browserSdkDiagnosticScript() })
    const classify = (request: Request): ApiKey | undefined => keyFor(new URL(request.url()))
    const requestSequences = new WeakMap<Request, number>()
    let nextRequestSequence = 0
    const requestSequence = (request: Request): number => {
      const existing = requestSequences.get(request)
      if (existing !== undefined) return existing
      const sequence = ++nextRequestSequence
      requestSequences.set(request, sequence)
      return sequence
    }
    const requestDiagnostic = (request: Request, validationStage: string, error?: unknown, failureText?: unknown) => {
      const target = new URL(request.url())
      const surface = target.pathname.startsWith('/api/') ? 'API'
        : target.pathname.startsWith('/socket.io') ? 'SOCKET'
          : request.resourceType() === 'document' ? 'DOCUMENT' : 'ASSET'
      return { requestSequence: requestSequence(request), ...browserFailureDiagnostic({
        method: request.method(), apiKey: classify(request), surface, validationStage, error, failureText,
      }) }
    }
    context.on('request', request => { requestSequence(request) })
    const transportRequests = new WeakMap<Request, { ordinal: number; apiKey: string; method: string; started: number }>()
    let transportOrdinal = 0
    const monitorTransport = (request: Request, event: string, status = 0, error?: unknown, failure?: string) => {
      const entry = transportRequests.get(request)
      if (entry) reportTransport({ ...entry, transport: 'PLAYWRIGHT', event, operation: 'MONITOR', status,
        requestSequence: requestSequence(request), complete: event === 'BODY_DONE',
        elapsedMs: Math.max(0, Math.floor(performance.now() - entry.started)),
        failure: failure ?? (error === undefined ? 'NONE' : transportError(error)) })
    }
    context.on('request', request => {
      const target = new URL(request.url())
      const apiKey = target.origin === uiOrigin ? automationTransportKey(target.pathname) : undefined
      if (!apiKey) return
      transportRequests.set(request, { ordinal: ++transportOrdinal, apiKey, method: request.method(), started: performance.now() })
      monitorTransport(request, 'REQUEST')
    })
    context.on('requestfinished', request => monitorTransport(request, 'REQUEST_FINISHED'))
    const allowedApi = (request: Request, key: ApiKey | undefined): boolean => {
      if (!key) return false
      const url = new URL(request.url())
      if (key === 'login') return request.method() === 'POST' && !url.search
      if (key === 'methodProbe') return request.method() === 'DELETE' && !url.search
      if (['validate', 'confirmSample', 'approve', 'activate'].includes(key)) return request.method() === 'POST' && !url.search
      if (key === 'preview') return request.method() === 'POST'
      if (key === 'plans') return request.method() === 'GET'
        ? url.search === '?' + new URLSearchParams({ managementScope: 'tenant', systemId: input.systemId })
        : request.method() === 'POST' && !url.search
      if (key === 'sourceBinding') return ['GET', 'POST'].includes(request.method())
      if (key === 'automationOptions') return request.method() === 'GET'
        && url.search === '?' + new URLSearchParams({ sheetId: input.automation.sheetId, limit: '20' })
      if (key === 'automationGrants' || key === 'automationRequests') return request.method() === 'GET'
        ? url.search === '?limit=20' : request.method() === 'POST' && !url.search
      if (key === 'automationGrantDetail' || key === 'automationRequestDetail') return request.method() === 'GET' && !url.search
      if (key === 'automationRevoke') return request.method() === 'POST' && !url.search
      if (key === 'automationScheduleActivation') return input.automation.scenario === 'interval'
        && request.method() === 'POST' && !url.search
      if (key === 'operatorProjects' && input.automation.scenario === 'interval' && phase === 'AUTOMATION_INTERVAL_EDITOR') {
        const plain = '?' + new URLSearchParams({ tenantId: input.tenantId })
        const home = '?' + new URLSearchParams({ tenantId: input.tenantId, includePullTargets: '1' })
        return request.method() === 'GET' && (url.search === plain || url.search === home)
      }
      if (key.startsWith('editor')) {
        if (input.automation.scenario !== 'interval' || !editorViewId) return false
        const sid = input.automation.sheetId
        if (key === 'editorRules') return ['GET', 'POST'].includes(request.method()) && !url.search
          && url.pathname === `/api/multitable/sheets/${encodeURIComponent(sid)}/automations`
        if (request.method() !== 'GET') return false
        const query: Record<string, string> | undefined = key === 'editorContext' ? { sheetId: sid, viewId: editorViewId }
          : key === 'editorView' ? { sheetId: sid, viewId: editorViewId, limit: '50', offset: '0', includeLinkSummaries: 'true' }
            : key === 'editorFields' || key === 'editorDingtalkGroups' ? { sheetId: sid }
              : key === 'editorMentionSummary' ? { spreadsheetId: sid } : undefined
        return url.search === (query ? '?' + new URLSearchParams(query) : '')
      }
      if (key === 'yidaBoard' || key === 'handoff') {
        // The board is opened only after the existing explicit tenant-scope
        // document navigation. No workspace steering or unrelated project is allowed.
        const expectedQuery = '?' + new URLSearchParams({ tenantId: input.tenantId,
          ...(key === 'handoff' ? { projectNo: boardProject } : {}) })
        return request.method() === 'GET' && url.search === expectedQuery
          && (key !== 'yidaBoard' || url.pathname === apiPaths.projects + '/' + boardProject + '/board')
      }
      if (key === 'readSourceConfigs' || key === 'k3Approve' || key === 'k3Read') {
        const workspaceId = url.searchParams.get('workspaceId')
        // The existing composition authoring panel independently loads approved
        // sources on mount. Permit this one real GET filter, never arbitrary query keys.
        const status = url.searchParams.get('status')
        if (status !== null && (key !== 'readSourceConfigs' || request.method() !== 'GET' || status !== 'approved')) return false
        const expectedQuery = key === 'k3Read'
          ? workspaceId ? '?' + new URLSearchParams({ workspaceId }) : ''
          : '?' + new URLSearchParams({ tenantId: input.tenantId, ...(workspaceId ? { workspaceId } : {}),
            ...(status ? { status } : {}) })
        if (url.search !== expectedQuery || (workspaceId !== null && workspaceId !== input.tenantId)
          || (k3WorkspaceId !== undefined && workspaceId !== k3WorkspaceId)) return false
        return key === 'readSourceConfigs' ? ['GET', 'POST'].includes(request.method()) : request.method() === 'POST'
      }
      if (request.method() !== 'GET') return false
      if (key === 'dingTalkProbe') return url.search === '?probe=1'
      return true
    }
    await context.route('**/*', async route => {
      const request = route.request()
      const target = new URL(request.url())
      if (dryRunStatus.isCandidate(request)) {
        try { dryRunStatus.accept(request) }
        catch { counts.forbiddenRequests += 1; note('DRY_RUN_STATUS_REQUEST_DENIED'); await route.abort('blockedbyclient'); return }
        counts.apiRequests += 1
        await route.continue(); return
      }
      if (membersOff.isCandidate(request)) {
        try { membersOff.accept(request) }
        catch { counts.forbiddenRequests += 1; note('MEMBERS_OFF_REQUEST_DENIED'); await route.abort('blockedbyclient'); return }
        counts.apiRequests += 1
        await route.continue(); return
      }
      if (projectSheetsOff.isCandidate(request)) {
        try { projectSheetsOff.accept(request) }
        catch { counts.forbiddenRequests += 1; note('PROJECT_SHEETS_OFF_REQUEST_DENIED'); await route.abort('blockedbyclient'); return }
        counts.apiRequests += 1
        await route.continue(); return
      }
      // A separate closed window admits exactly one real SDK draft request.
      // It does not enter apiPaths, expectedWrites or the PLM/K3/Automation counts.
      if (target.pathname === ownerOffPrefix || target.pathname.startsWith(ownerOffPrefix + '/')) {
        if (yidaOwnerOffWindow && target.origin !== uiOrigin) yidaOwnerOffWindow.counts.externalRequests += 1
        try {
          check(phase === 'YIDA_OWNER_DEFAULT_OFF' && yidaOwnerOffWindow, 'YIDA_OWNER_OFF_WINDOW_REQUIRED')
          yidaOwnerOffWindow.acceptRequest(request)
        } catch {
          counts.forbiddenRequests += 1; note('YIDA_OWNER_OFF_UNEXPECTED_REQUEST')
          await route.abort('blockedbyclient'); return
        }
        await route.continue(); return
      }
      if (yidaOwnerOffWindow && phase === 'YIDA_OWNER_DEFAULT_OFF') {
        if (target.origin !== uiOrigin) yidaOwnerOffWindow.counts.externalRequests += 1
        if (target.pathname.startsWith('/api/')) {
          if (target.origin === uiOrigin && target.pathname === apiPaths.hubOverview
            && request.method() === 'GET' && target.search === '' && request.postData() === null) {
            yidaOwnerOffWindow.counts.backgroundOverviewRequests += 1
          } else {
            yidaOwnerOffWindow.counts.otherBusinessRequests += 1
            if (yidaOwnerOffWindow.counts.ownerPosts === 0) yidaOwnerOffWindow.counts.openingBusinessRequests += 1
            counts.forbiddenRequests += 1; note('YIDA_OWNER_OFF_OTHER_BUSINESS_REQUEST')
            await route.abort('blockedbyclient'); return
          }
        }
      }
      if (yidaLocalWindow) {
        if (target.origin !== uiOrigin) yidaNetwork.externalRequests += 1
        if (target.pathname.startsWith('/api/')) {
          yidaNetwork.apiRequests += 1
          if (target.origin === uiOrigin && keyFor(target) === 'hubOverview' && request.method() === 'GET') {
            yidaNetwork.backgroundHubOverviewGets += 1
          } else {
            yidaNetwork.nonBackgroundApiRequests += 1
            if (request.method() === 'POST') yidaNetwork.businessPostRequests += 1
            counts.forbiddenRequests += 1; note('YIDA_LOCAL_WINDOW_API_REQUEST')
            await route.abort('blockedbyclient'); return
          }
        }
      }
      if (target.origin !== uiOrigin) {
        counts.forbiddenRequests += 1; note('EXTERNAL_HTTP_REQUEST')
        await route.abort('blockedbyclient'); return
      }
      if (target.pathname.startsWith('/api/')) {
        counts.apiRequests += 1
        const key = classify(request)
        if (!allowedApi(request, key)) {
          counts.forbiddenRequests += 1
          // Classify denials without disclosing any path segment, query value or
          // principal. This is diagnostic only; the exact allowlist is unchanged.
          const routeCategory = key ? key.toUpperCase()
            : /^\/api\/multitable\/sheets\/[^/]+\/automations\/[^/]+\/stats$/.test(target.pathname) ? 'EDITOR_RULE_STATS'
              : /^\/api\/multitable\/sheets\/[^/]+\/automations\/[^/]+\/logs$/.test(target.pathname) ? 'EDITOR_RULE_LOGS'
                : target.pathname.startsWith('/api/multitable/') ? 'OTHER_MULTITABLE'
                  : target.pathname.startsWith('/api/integration/stock-preparation/') ? 'OTHER_STOCK_PREPARATION'
                    : 'OTHER_API'
          console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-api-denied', routeCategory,
            method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(request.method()) ? request.method() : 'OTHER',
            queryEmpty: !target.search,
            tenantMatches: target.searchParams.get('tenantId') === input.tenantId,
            workspacePresent: target.searchParams.has('workspaceId'),
            sheetMatches: target.searchParams.get('sheetId') === input.automation.sheetId,
            viewMatches: editorViewId !== undefined && target.searchParams.get('viewId') === editorViewId,
            activeBoardMatches: target.pathname === apiPaths.projects + '/' + boardProject + '/board',
            yidaBoardMatches: target.pathname === apiPaths.projects + '/' + input.yida.projectNo + '/board',
            automationBoardMatches: target.pathname === apiPaths.projects + '/' + input.projectNo + '/board',
            exactBoardQuery: target.search === '?' + new URLSearchParams({ tenantId: input.tenantId }),
          }))
          // Only disclose static lower-case route words, never query/ID/body.
          const staticRoute = /^\/api\/(?:[a-z-]+\/)*[a-z-]+$/.test(target.pathname)
            ? target.pathname.slice(5).replaceAll('/', '_').replaceAll('-', '_').toUpperCase() : 'PARAMETERIZED'
          note(`UNEXPECTED_API_${request.method()}_${staticRoute}`)
          await route.abort('blockedbyclient'); return
        }
        if (request.method() === 'POST') {
          const expected = key && expectedWrites.get(key)
          let body: unknown
          try { body = request.postData() === null ? undefined : request.postDataJSON() } catch { body = null }
          const bodyMatches = expected && (typeof expected.body === 'function'
            ? expected.body(body) === true : isDeepStrictEqual(body, expected.body))
          if (!key || !expected || target.pathname !== expected.path || !bodyMatches) {
            counts.forbiddenRequests += 1; note('UNARMED_OR_DIFFERENT_WRITE')
            await route.abort('blockedbyclient'); return
          }
          expectedWrites.delete(key)
          if (key === 'login') counts.loginSubmissions += 1
          else writeCounts[key] = (writeCounts[key] ?? 0) + 1
        }
        if (key && (['plans', 'validate', 'confirmSample', 'approve', 'activate'].includes(key) || key.startsWith('automation'))) {
          const headers = request.headers()
          if ('x-tenant-id' in headers || 'x-workspace-id' in headers || (loginToken && headers.authorization !== 'Bearer ' + loginToken)) {
            counts.forbiddenRequests += 1; note('MANAGEMENT_SESSION_OR_SCOPE_HEADER')
            await route.abort('blockedbyclient'); return
          }
        }
        if (key?.startsWith('editor')) {
          const headers = request.headers()
          // The existing shared multitable client sends the logged-in tenant hint.
          // Observe that exact session-derived value; never add permission headers.
          if (headers.authorization !== 'Bearer ' + loginToken || headers['x-tenant-id'] !== input.tenantId
            || 'x-workspace-id' in headers || 'x-user-role' in headers || 'x-permissions' in headers) {
            counts.forbiddenRequests += 1; note('EDITOR_SESSION_OR_SCOPE_HEADER')
            await route.abort('blockedbyclient'); return
          }
        }
        if (key === 'k3Read') {
          const headers = request.headers()
          if ('x-tenant-id' in headers || (loginToken && headers.authorization !== 'Bearer ' + loginToken)) {
            counts.forbiddenRequests += 1; note('K3_RUNTIME_SESSION_OR_TENANT_HEADER')
            await route.abort('blockedbyclient'); return
          }
        }
        if (key === 'sourceBinding' || key === 'preview') {
          const tenantMatched = target.searchParams.get('tenantId') === input.tenantId
          const workspace = target.searchParams.get('workspaceId')
          observedScopes.push({ kind: key === 'preview' ? 'preview' : 'binding', tenantMatched,
            workspaceNull: workspace === null, workspaceTenantAlias: workspace === input.tenantId })
          if (!tenantMatched || (workspace !== null && workspace !== input.tenantId)
            || (key === 'preview' && workspace !== null)) {
            counts.forbiddenRequests += 1; note('UNEXPECTED_REAL_SHELL_SCOPE')
            await route.abort('blockedbyclient'); return
          }
        }
      } else if (target.pathname.startsWith('/socket.io')) {
        // Socket.io's authenticated transport is real, proxied to the owned
        // backend. It is not a business mutation or a fabricated empty answer.
        if (!['GET', 'POST'].includes(request.method())) {
          counts.forbiddenRequests += 1; note('UNEXPECTED_SOCKET_TRANSPORT')
          await route.abort('blockedbyclient'); return
        }
      } else if (request.method() !== 'GET') {
        counts.forbiddenRequests += 1; note('UNEXPECTED_UI_MUTATION')
        await route.abort('blockedbyclient'); return
      } else if ((target.pathname.startsWith('/@') || target.pathname.startsWith('/src/')
        || (request.resourceType() !== 'document' && !bundleFiles.has(decodeURIComponent(target.pathname))))) {
        counts.forbiddenRequests += 1; note('NON_BUNDLE_UI_REQUEST')
        await route.abort('blockedbyclient'); return
      }
      await route.continue()
    })
    // HTTP routing does not intercept WebSockets. A separate real-transport
    // firewall is mandatory; an older Playwright without it must fail closed.
    check(typeof context.routeWebSocket === 'function', 'WEBSOCKET_FIREWALL_REQUIRED')
    await context.routeWebSocket('**/*', socket => {
      const target = new URL(socket.url())
      if (target.origin !== wsOrigin || !['/socket.io/'].includes(target.pathname)) {
        counts.forbiddenRequests += 1; note('EXTERNAL_OR_UNEXPECTED_WEBSOCKET')
        void socket.close({ code: 1008, reason: 'APP_BROWSER_NETWORK_DENIED' })
        return
      }
      counts.websocketConnections += 1
      socket.connectToServer()
    })
    context.on('requestfailed', request => {
      monitorTransport(request, 'REQUEST_FAILED', 0, undefined,
        browserFailureDiagnostic({ failureText: request.failure()?.errorText }).failure)
      if (!closing) {
        counts.requestFailures += 1; note('REQUEST_FAILED')
        console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-request-failure',
          ...requestDiagnostic(request, 'REQUEST_FAILED', undefined, request.failure()?.errorText),
        }))
      }
    })
    const diagnosedResponses = new WeakMap<Response, Promise<void>>()
    const diagnoseResponseFailure = (response: Response, validationStage: string, error: unknown,
      payload?: unknown): Promise<void> => {
      const existing = diagnosedResponses.get(response)
      if (existing) return existing
      const diagnostic = (async () => {
        const code = object(payload) && object(payload.error) && typeof payload.error.code === 'string'
          && /^[A-Z][A-Z0-9_]{0,95}$/.test(payload.error.code) ? payload.error.code : undefined
        const { errorCode: validationErrorCode, ...classification } = requestDiagnostic(response.request(), validationStage, error)
        // Preserve a bounded backend code only from the monitor's already-read
        // payload. A failed body is never read again merely for diagnostics.
        console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({
          stage: classification.surface === 'API' ? 'browser-api-failure' : 'browser-bundle-failure',
          ...classification, status: response.status(), validationErrorCode,
          ...(code ? { errorCode: code } : {}),
        }))
      })()
      diagnosedResponses.set(response, diagnostic)
      return diagnostic
    }
    context.on('response', response => {
      monitorTransport(response.request(), 'HEADERS', response.status())
      const target = new URL(response.url())
      if (dryRunStatus.isCandidate(response.request())) {
        counts.apiResponses += 1
        const task = (async () => {
          dryRunStatus.response(response.request(), response.status(), await response.json())
        })().catch(() => note('DRY_RUN_STATUS_RESPONSE_INVALID'))
        pendingChecks.add(task); void task.finally(() => pendingChecks.delete(task))
        return
      }
      if (membersOff.isCandidate(response.request())) {
        counts.apiResponses += 1
        const task = (async () => {
          membersOff.response(response.request(), response.status(), await response.json())
        })().catch(() => note('MEMBERS_OFF_RESPONSE_INVALID'))
        pendingChecks.add(task); void task.finally(() => pendingChecks.delete(task))
        return
      }
      if (projectSheetsOff.isCandidate(response.request())) {
        counts.apiResponses += 1
        const task = (async () => {
          projectSheetsOff.response(response.request(), response.status(), await response.json())
        })().catch(() => note('PROJECT_SHEETS_OFF_RESPONSE_INVALID'))
        pendingChecks.add(task); void task.finally(() => pendingChecks.delete(task))
        return
      }
      if (target.pathname === ownerOffPrefix || target.pathname.startsWith(ownerOffPrefix + '/')) {
        const task = (async () => {
          check(phase === 'YIDA_OWNER_DEFAULT_OFF' && yidaOwnerOffWindow, 'YIDA_OWNER_OFF_RESPONSE_WINDOW_REQUIRED')
          await yidaOwnerOffWindow.acceptResponse(response)
        })().catch(() => note('YIDA_OWNER_OFF_RESPONSE_INVALID'))
        pendingChecks.add(task)
        void task.finally(() => pendingChecks.delete(task))
        return
      }
      if (!target.pathname.startsWith('/api/')) {
        if (response.status() >= 400) note('UI_OR_SOCKET_HTTP_ERROR')
        if (!target.pathname.startsWith('/socket.io')) {
          let validationStage = 'BUNDLE_SHAPE'
          const task = (async () => {
            const isDocument = response.request().resourceType() === 'document'
            const pathname = isDocument ? '/index.html' : decodeURIComponent(target.pathname)
            const expected = bundleFiles.get(pathname)
            check(expected && response.status() === 200, 'BUNDLE_RESPONSE_REQUIRED')
            validationStage = 'BUNDLE_BODY'
            const bytes = await response.body()
            validationStage = 'BUNDLE_HASH'
            check(bytes.length === expected.bytes
              && createHash('sha256').update(bytes).digest('hex') === expected.sha256, 'BUNDLE_RESPONSE_BYTES_CHANGED')
            bundleServedFiles.add(pathname)
            if (isDocument) bundleDocumentResponses += 1
          })().catch(async error => {
            await diagnoseResponseFailure(response, validationStage, error)
            note('BUNDLE_RESPONSE_VERIFICATION_FAILED')
          })
          pendingChecks.add(task)
          void task.finally(() => pendingChecks.delete(task))
        }
        return
      }
      counts.apiResponses += 1
      const key = classify(response.request())
      let validationStage = 'API_ROUTE'
      let payload: unknown
      const task = (async () => {
        check(key && allowedApi(response.request(), key), 'UNEXPECTED_API_RESPONSE')
        validationStage = 'API_BODY'
        payload = await response.json()
        monitorTransport(response.request(), 'BODY_DONE', response.status())
        const observation = detailObservation
        if (observation && key === 'automationRequestDetail' && response.request().method() === 'GET'
          && target.pathname === observation.path && target.search === '') {
          validationStage = 'API_DETAIL'
          observation.responses += 1
          observation.response = response
          check(observation.responses === 1 && await observation.validated, 'AUTOMATION_DETAIL_NOT_CORRELATED')
          if (response.status() === 503) {
            check(isDeepStrictEqual(payload, { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
              && response.headers()['cache-control'] === 'no-store', 'AUTOMATION_DETAIL_REFUSAL_INVALID')
            return
          }
        }
        if (['AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'].includes(phase) && key === 'yidaBoard'
          && target.pathname === apiPaths.projects + '/' + input.projectNo + '/board') {
          validationStage = 'API_EMPTY_BOARD'
          // This project is intentionally not applied to the target. Its real
          // board refusal is preserved; the owner panel uses the directory's
          // server-issued fillTarget outside the board, as the production UI does.
          check(response.status() === 404 && object(payload) && payload.ok === false
            && object(payload.error) && payload.error.code === 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND',
          'AUTOMATION_EMPTY_PROJECT_REFUSAL_REQUIRED')
          counts.expectedEmptyBoardRefusals += 1
          check(counts.expectedEmptyBoardRefusals === 1, 'AUTOMATION_DUPLICATE_BOARD_REFUSAL')
          return
        }
        const expectedStatus = response.request().method() === 'POST'
          ? ['plans', 'readSourceConfigs', 'automationGrants', 'automationScheduleActivation'].includes(key) ? 201 : key === 'automationRequests' ? 202 : 200 : 200
        validationStage = 'API_STATUS'
        check(response.status() === expectedStatus, `${key.toUpperCase()}_HTTP_STATUS`)
        validationStage = 'API_SHAPE'
        check(object(payload) || Array.isArray(payload), `${key.toUpperCase()}_JSON_SHAPE`)
        validationStage = 'API_ENVELOPE'
        if (object(payload)) check(payload.ok !== false && payload.success !== false, `${key.toUpperCase()}_ERROR_ENVELOPE`)
        if (key === 'plugins') {
          validationStage = 'API_PLUGIN'
          check(object(payload) && Array.isArray(payload.list) && payload.list.length === 1,
            'EXACT_PLUGIN_LIST_REQUIRED')
          const plugin = payload.list[0]
          check(object(plugin) && plugin.name === 'plugin-integration-core' && plugin.status === 'active'
            && !plugin.error && object(payload.summary) && payload.summary.failed === 0,
          'EXACT_INTEGRATION_PLUGIN_ACTIVE_REQUIRED')
        }
        if (key === 'todoCount' && object(payload)) {
          validationStage = 'API_TODO'
          const value = object(payload.data) ? payload.data : payload
          check(value.degraded !== true && object(value.sources)
            && Object.values(value.sources).every(status => status === 'ok'), 'TODO_COUNT_DEGRADED')
        }
        if (key === 'tableActions') {
          validationStage = 'API_ACTIONS'
          check(object(payload) && Array.isArray(payload.data) && payload.data.length === 1
            && object(payload.data[0]) && payload.data[0].actionId === actionId
            && payload.data[0].configured === true, 'CONFIGURED_ACTION_CATALOG_REQUIRED')
          configuredActionCatalogVerified = true
        }
        if (input.automation.scenario === 'interval' && key === 'operatorProjects'
          && response.request().method() === 'GET'
          && target.search === '?' + new URLSearchParams({ tenantId: input.tenantId, includePullTargets: '1' })) {
          validationStage = 'API_DIRECTORY'
          check(response.status() === 200 && response.request().postData() === null
            && object(payload) && payload.ok === true && object(payload.data), 'INTERVAL_HOME_DIRECTORY_RESPONSE_REQUIRED')
          // Preserve the actual browser-network response only for private harness
          // comparison. It is never supplied to the page or substituted for a GET.
          observedHomeDirectory = { responseCount: (observedHomeDirectory?.responseCount ?? 0) + 1, data: payload.data }
        }
        successes[key] += 1
      })().catch(async error => {
        if (validationStage === 'API_BODY') monitorTransport(response.request(), 'READER_REJECT', response.status(), error)
        await diagnoseResponseFailure(response, validationStage, error, payload)
        const code = error instanceof Error && /^APP_BROWSER_[A-Z_]+$/.test(error.message)
          ? error.message.slice('APP_BROWSER_'.length) : 'API_RESPONSE_VALIDATION_FAILED'
        note(code)
      })
      pendingChecks.add(task)
      void task.finally(() => pendingChecks.delete(task))
    })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.setDefaultNavigationTimeout(60000)
    page.on('pageerror', () => { counts.pageErrors += 1; note('PAGE_ERROR') })
    page.on('console', message => {
      if (message.type() !== 'error') return
      try { if (dryRunStatus.consoleRefusal(message.location().url, message.text())) return }
      catch { counts.consoleErrors += 1; note('DRY_RUN_STATUS_CONSOLE_INVALID'); return }
      try { if (membersOff.consoleRefusal(message.location().url, message.text())) return }
      catch { counts.consoleErrors += 1; note('MEMBERS_OFF_CONSOLE_INVALID'); return }
      try { if (projectSheetsOff.consoleRefusal(message.location().url, message.text())) return }
      catch { counts.consoleErrors += 1; note('PROJECT_SHEETS_OFF_CONSOLE_INVALID'); return }
      if (phase === 'YIDA_OWNER_DEFAULT_OFF' && yidaOwnerOffWindow) {
        try {
          if (yidaOwnerOffWindow.consoleRefusal(message.location().url, message.text())) return
        } catch { note('YIDA_OWNER_OFF_CONSOLE_INVALID'); return }
      }
      const observation = detailObservation
      if (['AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'].includes(phase) && observation
        && message.location().url === uiOrigin + observation.path
        && message.text().startsWith('Failed to load resource: the server responded with a status of 503')) {
        observation.consoleErrors += 1
        if (observation.consoleErrors > 1) note('DUPLICATE_DETAIL_REFUSAL_CONSOLE_ERROR')
        return
      }
      if (['AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'].includes(phase)
        && message.location().url === uiOrigin + apiPaths.projects + '/' + input.projectNo + '/board'
          + '?' + new URLSearchParams({ tenantId: input.tenantId })
        && message.text().startsWith('Failed to load resource: the server responded with a status of 404')) {
        counts.expectedEmptyBoardConsoleErrors += 1
        if (counts.expectedEmptyBoardConsoleErrors > 1) note('DUPLICATE_EXPECTED_BOARD_CONSOLE_ERROR')
        return
      }
      counts.consoleErrors += 1; note('CONSOLE_ERROR')
    })
    page.on('websocket', socket => socket.on('socketerror', () => {
      if (!closing) { counts.websocketErrors += 1; note('WEBSOCKET_ERROR') }
    }))

    const waitApi = (key: ApiKey, method = 'GET', pathname?: string): Promise<Response> => {
      const pending = page.waitForResponse(response => new URL(response.url()).origin === uiOrigin
        && keyFor(new URL(response.url())) === key && response.request().method() === method
        && (!pathname || new URL(response.url()).pathname === pathname))
      void pending.catch(() => {})
      return pending
    }
    const json = async (response: Response, status = 200): Promise<JsonObject> => {
      if (response.status() !== status) await diagnoseResponseFailure(response, 'EXPLICIT_STATUS', new Error('APP_BROWSER_REQUIRED_HTTP_STATUS'))
      check(response.status() === status, 'REQUIRED_HTTP_STATUS')
      const result: unknown = await response.json()
      check(object(result) && result.ok !== false && result.success !== false, 'REQUIRED_JSON_ENVELOPE')
      return result
    }
    const data = async (response: Response, status = 200): Promise<JsonObject> => {
      const result = await json(response, status)
      check(result.ok === true && object(result.data), 'REQUIRED_DATA_ENVELOPE')
      return result.data
    }
    const settled = async () => {
      await page.waitForLoadState('networkidle')
      while (pendingChecks.size) await Promise.all([...pendingChecks])
      check(faults.length === 0, `NETWORK_OR_PAGE_${faults[0] ?? 'NONE'}`)
    }
    const refreshDetail = async (grantId: string, requestId: string, poll: number, fromHistory = false): Promise<JsonObject | null> => {
      check(!detailObservation && ['AUTOMATION_MANUAL', 'AUTOMATION_INTERVAL'].includes(phase), 'AUTOMATION_DETAIL_OVERLAP')
      await checkpoint({ phase: 'observe-begin', grantId, requestId, poll })
      let finish!: (valid: boolean) => void
      const validated = new Promise<boolean>(resolve => { finish = resolve })
      const observation = { path: `/api/integration/automation-read/requests/${requestId}`,
        validated, finish, responses: 0, consoleErrors: 0, response: undefined as Response | undefined }
      detailObservation = observation
      try {
        const pending = waitApi('automationRequestDetail', 'GET', observation.path)
        if (fromHistory) await page.getByTestId('automation-read-open-request')
          .and(page.locator(`[data-request-id="${requestId}"]`)).click()
        else await page.getByTestId('automation-read-refresh-request').click()
        const response = await pending
        const httpStatus = response.status()
        check(httpStatus === 200 || httpStatus === 503, 'AUTOMATION_DETAIL_STATUS_INVALID')
        const payload: unknown = await response.json()
        if (httpStatus === 503) {
          check(isDeepStrictEqual(payload, { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
            && response.headers()['cache-control'] === 'no-store', 'AUTOMATION_DETAIL_REFUSAL_INVALID')
        } else check(object(payload) && payload.ok === true && object(payload.data), 'AUTOMATION_DETAIL_DATA_REQUIRED')
        // The parent accepts a 503 only after the very same real HTTP GET's
        // source-mirror query returned native 55P03. No worker/global counter is enough.
        await checkpoint({ phase: 'observe-end', grantId, requestId, poll, httpStatus })
        finish(true)
        await settled()
        check(observation.responses === 1 && observation.response === response, 'AUTOMATION_DETAIL_RESPONSE_IDENTITY')
        check(httpStatus === 503 || observation.consoleErrors === 0, 'AUTOMATION_DETAIL_UNEXPECTED_CONSOLE_ERROR')
        if (httpStatus === 503) {
          check(await page.getByTestId('automation-read-error').count() === 1
            && await page.getByTestId('automation-read-current-request').count() === 0
            && await page.getByTestId('automation-read-current-grant').count() === 0
            && await page.getByTestId('automation-read-refresh-request').count() === 0
            && await page.getByTestId('automation-read-history-only').isEnabled(), 'AUTOMATION_DETAIL_REFUSAL_RESET_REQUIRED')
          return null
        }
        return (payload as { data: JsonObject }).data
      } finally {
        finish(false)
        detailObservation = undefined
      }
    }
    const assertSource = async (response: Response, bound: boolean, bindingWorkspace?: string | null) => {
      const source = await data(response)
      check(Array.isArray(source.eligibleSources) && source.eligibleSources.length === 1
        && object(source.eligibleSources[0]) && source.eligibleSources[0].externalSystemId === input.systemId, 'EXACT_SOURCE_CANDIDATE_REQUIRED')
      if (bound) {
        check(source.origin === 'persisted' && object(source.persistedBinding)
          && source.effectiveExternalSystemId === input.systemId
          && source.takesEffectWithoutRestart === true && source.effectiveSourceProblem == null, 'BOUND_SOURCE_READBACK_REQUIRED')
        if (bindingWorkspace !== undefined) check(object(source.persistedBinding)
          && source.persistedBinding.tenantId === input.tenantId
          && source.persistedBinding.workspaceId === bindingWorkspace
          && source.persistedBinding.actionId === actionId, 'EXACT_BINDING_SCOPE_REQUIRED')
      } else check(source.persistedBinding === null && source.effectiveExternalSystemId !== input.systemId, 'UNBOUND_SOURCE_REQUIRED')
      await page.getByTestId('stock-prep-source-current').waitFor({ state: 'visible' })
      check(await page.getByTestId('stock-prep-source-error').count() === 0, 'SOURCE_READ_ERROR_VISIBLE')
      check(await page.getByTestId('stock-prep-source-empty').count() === 0, 'SOURCE_CANDIDATE_EMPTY')
    }
    const openInstall = async (bound: boolean) => {
      const source = waitApi('sourceBinding')
      await page.getByTestId('stock-prep-tab-install').click()
      await page.locator('[data-testid="stock-prep-panel"][data-active="install"]').waitFor()
      check(await page.getByTestId('stock-prep-install').getAttribute('data-mode') === 'review', 'REAL_REVIEW_MODE_REQUIRED')
      await assertSource(await source, bound)
      await page.getByTestId('stock-prep-install-defaults').waitFor({ state: 'visible' })
      counts.installTabVisits += 1
      await settled()
    }
    const loadPlans = async () => {
      await page.getByTestId('stock-prep-source-plan-draft-summary').click()
      await page.getByTestId('stock-prep-plan-management-toggle').check()
      await page.getByTestId('stock-prep-plan-system').fill(input.systemId)
      const response = waitApi('plans')
      await page.getByTestId('stock-prep-plan-refresh').click()
      const state = await data(await response)
      check(Array.isArray(state.versions), 'VERSION_LIST_REQUIRED')
      await page.getByTestId('stock-prep-plan-activation').waitFor()
      return state
    }

    phase = 'LOGIN'
    progress(phase)
    const dingTalkProbe = waitApi('dingTalkProbe')
    const documentResponse = await page.goto(`${uiOrigin}/login?redirect=%2Fintegrations%2Fworkbench`)
    check(documentResponse?.status() === 200, 'REAL_LOGIN_DOCUMENT_REQUIRED')
    await page.locator('.login-form input[autocomplete="username"]').waitFor()
    check(await page.evaluate(() => !localStorage.getItem('auth_token') && !localStorage.getItem('jwt')), 'FRESH_CONTEXT_REQUIRED')
    const dingTalk = await json(await dingTalkProbe)
    check(object(dingTalk.data) && dingTalk.data.available === false, 'SYNTHETIC_DINGTALK_DISABLED_REQUIRED')
    await settled()
    const login = waitApi('login', 'POST')
    const hub = waitApi('hubOverview')
    const externalSystems = waitApi('externalSystems')
    const actions = waitApi('tableActions')
    await page.locator('.login-form input[autocomplete="username"]').fill(input.identifier)
    await page.locator('.login-form input[autocomplete="current-password"]').fill(input.password)
    armWrite('login', apiPaths.login, { identifier: input.identifier, password: input.password })
    await page.locator('.login-form button[type="submit"]').click()
    const loginPayload = await json(await login)
    check(loginPayload.success === true && object(loginPayload.data)
      && typeof loginPayload.data.token === 'string' && loginPayload.data.token.length > 0
      && object(loginPayload.data.user), 'REAL_PASSWORD_LOGIN_REQUIRED')
    loginToken = loginPayload.data.token as string
    const loginUser = loginPayload.data.user
    check(typeof loginUser.id === 'string' && loginUser.id.length > 0
      && loginUser.tenantId === input.tenantId, 'LOGIN_PRINCIPAL_REQUIRED')
    await page.waitForURL(url => url.origin === uiOrigin && url.pathname === '/integrations/workbench')

    phase = 'WORKBENCH'
    progress(phase)
    const hubPayload = await json(await hub)
    check(hubPayload.ok === true && object(hubPayload.data) && Array.isArray(hubPayload.data.systems)
      && hubPayload.data.systems.length === 2 && hubPayload.data.systemCount === 2, 'CONFIGURED_HUB_REQUIRED')
    check(object(hubPayload.data.dataSourceDirectory) && hubPayload.data.dataSourceDirectory.available === true, 'HUB_DIRECTORY_UNAVAILABLE')
    const systemsPayload = await json(await externalSystems)
    check(systemsPayload.ok === true && Array.isArray(systemsPayload.data) && systemsPayload.data.length === 2
      && systemsPayload.data.some(system => object(system) && system.id === input.systemId)
      && systemsPayload.data.some(system => object(system) && system.id === input.k3.systemId
        && system.kind === 'erp:k3-wise-webapi' && system.status === 'active'), 'EXACT_TWO_EXTERNAL_SYSTEMS_REQUIRED')
    await json(await actions)
    await page.getByTestId('data-factory-flow').waitFor({ state: 'visible' })
    check(await page.getByTestId('hub-overview-empty').count() === 0, 'CONFIGURED_HUB_EMPTY')
    check(await page.getByTestId('hub-overview-error').count() === 0, 'HUB_READ_ERROR_VISIBLE')
    await settled()
    check(configuredActionCatalogVerified && successes.adapters > 0 && successes.stagingDescriptors > 0, 'WORKBENCH_REQUIRED_READS_MISSING')

    phase = 'K3_WORKBENCH'
    progress(phase)
    const workbenchScope = await page.evaluate(() => ({ tenantId: localStorage.getItem('tenantId'),
      workspaceId: localStorage.getItem('workspaceId') }))
    check(workbenchScope.tenantId === input.tenantId
      && (workbenchScope.workspaceId === null || workbenchScope.workspaceId === input.tenantId), 'K3_REAL_WORKBENCH_SCOPE_REQUIRED')
    k3WorkspaceId = workbenchScope.workspaceId
    const k3 = await runConfiguredK3Browser(page, input.k3, { armWrite, waitApi, settled,
      data: async (response, status = 200) => {
        const result = await json(response, status)
        check(result.ok === true && (object(result.data) || Array.isArray(result.data)), 'K3_REQUIRED_DATA_ENVELOPE')
        return result.data
      },
      reloadSameSession: async () => {
        check(new URL(page.url()).pathname === '/integrations/workbench', 'K3_RELOAD_WORKBENCH_REQUIRED')
        const session = waitApi('me')
        const document = await page.reload()
        check(document?.status() === 200, 'K3_RELOAD_DOCUMENT_REQUIRED')
        const me = await json(await session)
        check(me.success === true && object(me.data) && object(me.data.user)
          && me.data.user.id === loginUser.id && me.data.user.tenantId === input.tenantId, 'K3_RELOAD_SAME_PRINCIPAL_REQUIRED')
        counts.k3Reloads += 1
        await page.getByTestId('data-factory-flow').waitFor()
        await settled()
        check(isDeepStrictEqual(workbenchScope, await page.evaluate(() => ({ tenantId: localStorage.getItem('tenantId'),
          workspaceId: localStorage.getItem('workspaceId') }))), 'K3_RELOAD_SCOPE_UNCHANGED_REQUIRED')
      },
    })
    check(writeCounts.readSourceConfigs === 2 && writeCounts.k3Approve === 2 && writeCounts.k3Read === 3
      && counts.k3Reloads === 1 && expectedWrites.size === 0, 'K3_EXACT_METADATA_AND_READ_COUNTS_REQUIRED')

    phase = 'TOPBAR'
    progress(phase)
    const preflight = waitApi('preflight')
    await page.locator('nav.app-nav a[href="/stock-prep"]').click()
    await page.waitForURL(url => url.origin === uiOrigin && url.pathname === '/stock-prep')
    const deployment = await data(await preflight)
    check(typeof deployment.ready === 'boolean', 'DEPLOYMENT_POSTURE_REQUIRED')
    await page.getByTestId('stock-prep-tab-install').waitFor({ state: 'visible' })
    await settled()
    phase = 'INSTALL'
    progress(phase)
    await openInstall(false)

    phase = 'BIND'
    progress(phase)
    await page.getByTestId('stock-prep-source-select').selectOption(input.systemId)
    await page.getByTestId('stock-prep-source-save').click()
    await page.getByTestId('stock-prep-source-confirm').waitFor()
    check(!writeCounts.sourceBinding, 'BIND_PRECONFIRM_WRITE')
    await page.getByTestId('stock-prep-source-cancel').click()
    check(!writeCounts.sourceBinding, 'BIND_CANCEL_WRITE')
    canceledActions += 1
    await page.getByTestId('stock-prep-source-save').click()
    const boundPost = waitApi('sourceBinding', 'POST')
    const boundRead = waitApi('sourceBinding')
    armWrite('sourceBinding', apiPaths.sourceBinding, { externalSystemId: input.systemId })
    await page.getByTestId('stock-prep-source-confirm-save').click()
    await data(await boundPost)
    await assertSource(await boundRead, true, input.tenantId)
    await page.getByTestId('stock-prep-source-saved').waitFor({ state: 'visible' })
    check(await page.getByTestId('stock-prep-source-unconfirmed').count() === 0, 'BIND_NOT_CONFIRMED')
    await settled()

    // Exercise the ordinary user's actual scope transition, including an existing
    // workspace binding. Never alter storage or widen B2a to the default plan.
    phase = 'EXPLICIT_TENANT_SCOPE'
    progress(phase)
    const authStorageBefore = await page.evaluate(() => ({ token: localStorage.getItem('auth_token'),
      tenant: localStorage.getItem('tenantId'), workspace: localStorage.getItem('workspaceId') }))
    const scopeLink = page.getByTestId('stock-prep-execution-scope-switch')
    const oldPageUrl = page.url()
    await page.getByTestId('stock-prep-execution-scope-tenant').click()
    await page.getByTestId('stock-prep-execution-scope-confirm').waitFor()
    await page.getByTestId('stock-prep-execution-scope-cancel').click()
    check(page.url() === oldPageUrl && writeCounts.sourceBinding === 1, 'SCOPE_CANCEL_CHANGED_STATE')
    canceledActions += 1
    await settled()
    const scopeDocument = page.waitForResponse(response => response.request().isNavigationRequest()
      && new URL(response.url()).pathname === '/stock-prep'
      && new URL(response.url()).searchParams.get('executionScope') === 'tenant')
    const scopeSession = waitApi('me')
    const fallbackBinding = waitApi('sourceBinding')
    await page.getByTestId('stock-prep-execution-scope-tenant').click()
    await page.getByTestId('stock-prep-execution-scope-confirm').waitFor()
    await scopeLink.click()
    check((await scopeDocument).status() === 200, 'SCOPE_FULL_DOCUMENT_REQUIRED')
    await page.waitForURL(url => url.pathname === '/stock-prep'
      && url.searchParams.get('executionScope') === 'tenant' && url.searchParams.get('tab') === 'install')
    const scopedMe = await json(await scopeSession)
    check(object(scopedMe.data) && object(scopedMe.data.user) && scopedMe.data.user.id === loginUser.id,
      'SCOPE_RELOAD_SAME_PRINCIPAL_REQUIRED')
    await assertSource(await fallbackBinding, true, input.tenantId)
    await page.getByTestId('stock-prep-execution-scope-current').filter({ hasText: /租户/ }).waitFor()
    check(isDeepStrictEqual(authStorageBefore, await page.evaluate(() => ({ token: localStorage.getItem('auth_token'),
      tenant: localStorage.getItem('tenantId'), workspace: localStorage.getItem('workspaceId') }))), 'SCOPE_CHANGED_AUTH_STORAGE')
    counts.scopeReloads = 1
    counts.installTabVisits += 1
    await settled()
    check(writeCounts.sourceBinding === 1 && !writeCounts.validate && !writeCounts.preview,
      'SCOPE_SWITCH_IMPLICIT_MUTATION')
    // The fallback points to the same system, but not an exact tenant binding.
    // The new control must require an explicit second confirmation, then read back
    // the exact null-scope row; the original workspace row remains in the database.
    phase = 'EXACT_TENANT_REBIND'
    progress(phase)
    await page.getByTestId('stock-prep-source-select').selectOption(input.systemId)
    check(await page.getByTestId('stock-prep-source-save').isEnabled(), 'SAME_SYSTEM_SCOPE_REBIND_REQUIRED')
    await page.getByTestId('stock-prep-source-save').click()
    await page.getByTestId('stock-prep-source-confirm').waitFor()
    await page.getByTestId('stock-prep-source-cancel').click()
    check(writeCounts.sourceBinding === 1, 'REBIND_CANCEL_WRITE')
    canceledActions += 1
    await page.getByTestId('stock-prep-source-save').click()
    const tenantPost = waitApi('sourceBinding', 'POST')
    const tenantRead = waitApi('sourceBinding')
    armWrite('sourceBinding', apiPaths.sourceBinding, { externalSystemId: input.systemId })
    await page.getByTestId('stock-prep-source-confirm-save').click()
    await data(await tenantPost)
    await assertSource(await tenantRead, true, null)
    await page.getByTestId('stock-prep-source-saved').waitFor({ state: 'visible' })
    await settled()

    phase = 'SAVE'
    progress(phase)
    const initial = await loadPlans()
    check(Array.isArray(initial.versions) && initial.versions.length === 0 && initial.activation === null, 'FRESH_PLAN_STATE_REQUIRED')
    await page.getByTestId('stock-prep-source-plan-draft-import').setInputFiles({
      name: 'synthetic-read-plan.review.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'stock-preparation-plm-role-draft',
        status: 'confirm-required', validation: 'structure-only', readPlan: input.readPlan })),
    })
    await page.waitForFunction(expected => (document.querySelector('[data-testid="stock-prep-source-plan-draft-input-part-nameField"]') as HTMLInputElement | null)?.value === expected, partNameField)
    await page.getByTestId('stock-prep-source-plan-draft-preview').click()
    await page.getByTestId('stock-prep-source-plan-draft-json').waitFor()
    check(await page.getByTestId('stock-prep-source-plan-draft-issues').count() === 0, 'IMPORTED_PLAN_INVALID')
    check(!writeCounts.plans && !writeCounts.validate && !writeCounts.preview, 'IMPORT_IMPLICIT_WRITE')
    const saveResponse = waitApi('plans', 'POST')
    const saveReadback = waitApi('plans')
    armWrite('plans', apiPaths.plans, { managementScope: 'tenant', config: {
      schemaVersion: 1, actionId, systemId: input.systemId, readPlan: input.readPlan,
    } })
    await page.getByTestId('stock-prep-plan-save').click()
    const created = await data(await saveResponse, 201)
    const saved = await data(await saveReadback)
    check(typeof created.id === 'string' && /^[A-Za-z0-9_-]+$/.test(created.id)
      && typeof created.contentKey === 'string' && created.status === 'draft'
      && object(created.config) && isDeepStrictEqual(created.config.readPlan, input.readPlan), 'SAVED_DRAFT_REQUIRED')
    const versionId = created.id
    check(Array.isArray(saved.versions) && saved.versions.length === 1 && saved.activation === null
      && object(saved.versions[0]) && saved.versions[0].id === versionId, 'SAVED_DRAFT_READBACK_REQUIRED')
    await page.getByTestId('stock-prep-plan-version-' + versionId).check()
    check(await page.getByTestId('stock-prep-plan-approve').isDisabled(), 'UNVALIDATED_APPROVAL_ENABLED')

    phase = 'VALIDATE'
    progress(phase)
    await page.getByTestId('stock-prep-plan-project').fill(input.projectNo)
    const validationPath = apiPaths.plans + '/' + versionId + '/validate'
    const validationResponse = waitApi('validate', 'POST', validationPath)
    armWrite('validate', validationPath, { managementScope: 'tenant', systemId: input.systemId, projectNo: input.projectNo })
    await page.getByTestId('stock-prep-plan-validate').click()
    const measured = await data(await validationResponse)
    check(object(measured.validation) && typeof measured.validation.validationId === 'string'
      && measured.validation.status === 'passed' && object(measured.validation.counts)
      && measured.canApply === false && measured.tokenIssued === false && measured.authorizesExecution === false, 'REAL_VALIDATION_REQUIRED')
    check(object(measured.catalog) && measured.catalog.status === 'matched'
      && measured.catalog.validation === 'physical-columns-only' && measured.catalog.authorizesExecution === false
      && Array.isArray(measured.catalog.issues) && measured.catalog.issues.length === 0, 'PHYSICAL_CATALOG_REQUIRED')
    const validationId = measured.validation.validationId
    check(object(measured.sample) && measured.sample.totalRows === 3 && Array.isArray(measured.sample.rows)
      && measured.sample.rows.length === 3, 'COMPLETE_SAMPLE_REQUIRED')
    const rows = measured.sample.rows
    check(object(rows[0]) && rows[0].sourceVersion === 'P1' && rows[0].orderBomVersion === 'B2'
      && rows.slice(1).every(row => object(row) && !Object.hasOwn(row, 'orderBomVersion')), 'SAMPLE_VERSION_SEMANTICS')
    await page.getByTestId('stock-prep-plan-sample').filter({ hasText: 'SYN-CHILD' }).waitFor()
    check(await page.getByTestId('stock-prep-plan-sample-0-sourceVersion').innerText() === 'P1'
      && await page.getByTestId('stock-prep-plan-sample-0-orderBomVersion').innerText() === 'B2', 'SAMPLE_DOM_REQUIRED')
    check(await page.getByTestId('stock-prep-plan-approve').isDisabled(), 'UNCONFIRMED_APPROVAL_ENABLED')
    await settled()

    phase = 'CONFIRM_SAMPLE'
    progress(phase)
    const confirmationPath = apiPaths.plans + '/' + versionId + '/confirm-sample'
    const confirmationResponse = waitApi('confirmSample', 'POST', confirmationPath)
    armWrite('confirmSample', confirmationPath, { managementScope: 'tenant', systemId: input.systemId, validationId })
    await page.getByTestId('stock-prep-plan-confirm-sample').click()
    const confirmed = await data(await confirmationResponse)
    check(confirmed.validationId === validationId && confirmed.status === 'confirmed', 'EXACT_SAMPLE_CONFIRMATION_REQUIRED')
    await page.getByTestId('stock-prep-plan-validation-' + versionId).filter({ hasText: '已确认样本' }).waitFor()

    const confirmAction = async (action: 'approve' | 'activate') => {
      phase = action.toUpperCase(); progress(phase)
      const before = writeCounts[action] ?? 0
      await page.getByTestId('stock-prep-plan-' + action).click()
      await page.getByTestId('stock-prep-plan-confirm').waitFor()
      check((await page.getByTestId('stock-prep-plan-confirm').innerText()).includes(versionId), 'CONFIRM_EXACT_VERSION')
      check((writeCounts[action] ?? 0) === before, 'PLAN_PRECONFIRM_WRITE')
      await page.getByTestId('stock-prep-plan-confirm-cancel').click()
      await page.getByTestId('stock-prep-plan-confirm').waitFor({ state: 'detached' })
      check((writeCounts[action] ?? 0) === before, 'PLAN_CANCEL_WRITE')
      canceledActions += 1
      await page.getByTestId('stock-prep-plan-' + action).click()
      const pathname = apiPaths.plans + '/' + versionId + '/' + action
      const response = waitApi(action, 'POST', pathname)
      const readback = waitApi('plans')
      armWrite(action, pathname, { managementScope: 'tenant', systemId: input.systemId,
        ...(action === 'activate' ? { expectedGeneration: 0 } : {}) })
      await page.getByTestId('stock-prep-plan-confirm-submit').click()
      const result = await data(await response)
      const state = await data(await readback)
      check(result.contentKey === created.contentKey && Array.isArray(state.versions)
        && state.versions.length === 1 && object(state.versions[0])
        && state.versions[0].id === versionId && state.versions[0].status === 'approved', 'ACTION_VERSION_READBACK_REQUIRED')
      if (action === 'approve') {
        check(result.id === versionId && result.status === 'approved' && state.activation === null, 'APPROVAL_DID_NOT_ACTIVATE')
      } else {
        check(result.versionId === versionId && result.systemId === input.systemId
          && result.generation === 1 && result.status === 'active'
          && object(state.activation) && state.activation.versionId === versionId
          && state.activation.generation === 1 && state.activation.status === 'active', 'ACTIVATION_READBACK_REQUIRED')
        await page.getByTestId('stock-prep-plan-activation').filter({ hasText: '已激活' }).waitFor()
      }
      await settled()
    }
    await confirmAction('approve')
    await confirmAction('activate')

    phase = 'PREVIEW_NAVIGATION'
    progress(phase)
    const projectOverview = waitApi('projects')
    const projectDirectory = waitApi('operatorProjects')
    await page.getByTestId('stock-prep-rail-advanced-toggle').click()
    await page.getByTestId('stock-prep-tab-project-workspace').click()
    await page.locator('[data-testid="stock-prep-panel"][data-active="project-workspace"]').waitFor()
    await data(await projectOverview)
    await data(await projectDirectory)
    await page.getByTestId('stock-prep-project-sync-project-no').fill(input.projectNo)
    check(!writeCounts.preview, 'IMPLICIT_PREVIEW')
    await settled()

    phase = 'PREVIEW'
    progress(phase)
    const previewResponse = waitApi('preview', 'POST')
    armWrite('preview', apiPaths.preview, { parameters: { projectNo: input.projectNo }, includeMissingComponents: true })
    await page.getByTestId('stock-prep-project-preview-run').click()
    const preview = await data(await previewResponse)
    check(preview.status === 'ready' && preview.canApply === true && typeof preview.dryRunToken === 'string'
      && preview.dryRunToken.length > 0 && isDeepStrictEqual(preview.counts,
        { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }), 'CONFIGURED_PREVIEW_REQUIRED')
    await page.getByTestId('stock-prep-project-preview-counts').filter({ hasText:
      /计划新增\s+3\s*·\s*计划更新\s+0\s*·\s*计划跳过\s+0\s*·\s*计划停用\s+0\s*·\s*待人工确认\s+0/,
    }).waitFor()
    check(await page.getByTestId('stock-prep-project-preview').getAttribute('data-status') === 'ready', 'PREVIEW_DOM_READY_REQUIRED')
    check(await page.getByTestId('stock-prep-project-sync-verdict').count() === 0
      && !(await page.locator('body').innerText()).includes(preview.dryRunToken), 'PREVIEW_DID_NOT_SYNC_OR_RENDER_TOKEN')
    await settled()

    phase = 'RELOAD'
    progress(phase)
    const session = waitApi('me')
    const reloadBinding = waitApi('sourceBinding')
    const reloadResponse = await page.reload()
    check(reloadResponse?.status() === 200, 'RELOAD_DOCUMENT_REQUIRED')
    counts.reloads += 1
    const mePayload = await json(await session)
    check(mePayload.success === true && object(mePayload.data) && object(mePayload.data.user)
      && mePayload.data.user.id === loginUser.id && mePayload.data.user.tenantId === input.tenantId, 'RELOAD_SAME_PRINCIPAL_REQUIRED')
    await page.getByTestId('stock-prep-tab-install').waitFor()
    await page.locator('[data-testid="stock-prep-panel"][data-active="install"]').waitFor()
    await assertSource(await reloadBinding, true, null)
    check(await page.getByTestId('stock-prep-install').getAttribute('data-mode') === 'review', 'RELOAD_INSTALL_SCOPE_REQUIRED')
    counts.installTabVisits += 1
    await settled()
    const persisted = await loadPlans()
    check(Array.isArray(persisted.versions) && persisted.versions.length === 1 && object(persisted.versions[0])
      && persisted.versions[0].id === versionId && persisted.versions[0].status === 'approved'
      && persisted.versions[0].contentKey === created.contentKey && isDeepStrictEqual(persisted.versions[0].config, created.config)
      && object(persisted.activation) && persisted.activation.versionId === versionId
      && persisted.activation.status === 'active' && persisted.activation.generation === 1, 'RELOAD_PERSISTED_PLAN_REQUIRED')
    await page.getByTestId('stock-prep-plan-activation').filter({ hasText: '已激活' }).waitFor()
    await settled()

    phase = 'YIDA_BOARD_NAVIGATION'
    progress(phase)
    await page.getByTestId('stock-prep-tab-project-board').click()
    // The real shell folds an unopened project board onto the task home until
    // the operator explicitly opens a project through this shared component.
    await page.getByTestId('stock-prep-project-board').waitFor()
    await page.getByTestId('stock-prep-project-board-input').fill(input.yida.projectNo)
    await settled()
    const boardResponse = waitApi('yidaBoard')
    const handoffResponse = waitApi('handoff')
    await page.getByTestId('stock-prep-project-board-open').click()
    const board = await data(await boardResponse)
    const handoff = await data(await handoffResponse)
    check(board.projectNo === input.yida.projectNo && board.tenantId === input.tenantId
      && board.pullTargetReady === true && board.pulledRowCount === 1 && board.activePulledRowCount === 0
      && board.archivedSnapshotPresent === false,
    'YIDA_REAL_SEEDED_PROJECT_BOARD_REQUIRED')
    check(handoff.configured === false, 'YIDA_UNCONFIGURED_HANDOFF_REQUIRED')
    await page.locator('[data-testid="stock-prep-panel"][data-active="project-board"]').waitFor()
    await page.getByTestId('stock-prep-project-board-title').filter({ hasText: input.yida.projectNo }).waitFor()
    check(await page.getByTestId('stock-prep-project-board-error').count() === 0, 'YIDA_PROJECT_BOARD_FAILED')
    await settled()
    phase = 'YIDA_STATIC_PREVIEW'
    progress(phase)
    check(expectedWrites.size === 0, 'YIDA_LOCAL_WINDOW_MUST_NOT_ARM_WRITE')
    yidaLocalWindow = true
    const yida = await runConfiguredYidaBrowser(page, input.yida.projectNo, { settled,
      localWindowCounts: () => ({ ...yidaNetwork }) })
    yidaLocalWindow = false
    check(yidaNetwork.nonBackgroundApiRequests === 0 && yidaNetwork.businessPostRequests === 0
      && yidaNetwork.externalRequests === 0 && yidaNetwork.apiRequests === yidaNetwork.backgroundHubOverviewGets,
    'YIDA_NO_BUSINESS_OR_EXTERNAL_REQUESTS_REQUIRED')

    phase = 'YIDA_OWNER_DEFAULT_OFF'
    progress(phase)
    check(expectedWrites.size === 0, 'YIDA_OWNER_OFF_NO_GENERAL_WRITE_ARM_REQUIRED')
    yidaOwnerOffWindow = createYidaOwnerOffWindow(uiOrigin, loginToken)
    const yidaOwnerOff = await runConfiguredYidaOwnerOffBrowser(page, yidaOwnerOffWindow, settled)
    yidaOwnerOffWindow = undefined

    let automationRuleId = input.automation.ruleId
    if (input.automation.scenario === 'interval') {
      phase = 'AUTOMATION_INTERVAL_EDITOR'
      progress(phase)
      check(object(board.fillTarget) && board.fillTarget.sheetId === input.automation.sheetId
        && typeof board.fillTarget.viewId === 'string' && board.fillTarget.viewId.length > 0, 'EDITOR_SERVER_FILL_TARGET_REQUIRED')
      editorViewId = board.fillTarget.viewId
      automationRuleId = await authorConfiguredIntervalRule(page, { sheetId: input.automation.sheetId, viewId: editorViewId,
        projectNo: input.yida.projectNo, tenantId: input.tenantId },
        { armWrite, waitApi, data, settled, checkpoint, refreshDetail, observedHomeDirectory: () => observedHomeDirectory })
      counts.installTabVisits += 1
    }
    phase = input.automation.scenario === 'interval' ? 'AUTOMATION_INTERVAL' : 'AUTOMATION_MANUAL'
    progress(phase)
    boardProject = input.projectNo
    await page.getByTestId('stock-prep-project-board-input').fill(input.projectNo)
    const automationBoardResponse = waitApi('yidaBoard')
    await page.getByTestId('stock-prep-project-board-open').click()
    check((await automationBoardResponse).status() === 404, 'AUTOMATION_EMPTY_PROJECT_REFUSAL_REQUIRED')
    await settled()
    check(counts.expectedEmptyBoardRefusals === 1, 'AUTOMATION_REAL_BOARD_REFUSAL_REQUIRED')
    const automation = await (input.automation.scenario === 'interval' ? runConfiguredIntervalBrowser : runConfiguredAutomationBrowser)(page,
      { ...input.automation, ruleId: automationRuleId, projectNo: input.projectNo },
      { armWrite, waitApi, data, settled, checkpoint, refreshDetail })
    automation.evidence.emptyProjectBoardRefused = true

    check(counts.loginSubmissions === 1 && successes.login === 1 && counts.reloads === 1
      && counts.installTabVisits === (input.automation.scenario === 'interval' ? 4 : 3)
      && counts.scopeReloads === 1 && successes.me >= 2, 'JOURNEY_INCOMPLETE')
    check(successes.plugins > 0 && successes.methodProbe > 0 && successes.manifest > 0, 'REQUIRED_APP_READS_MISSING')
    check(isDeepStrictEqual(writeCounts, { readSourceConfigs: 2, k3Approve: 2, k3Read: 3,
      sourceBinding: 2, plans: 1, validate: 1, confirmSample: 1, approve: 1, activate: 1, preview: 1,
      ...(input.automation.scenario === 'interval' ? { editorRules: 1, automationScheduleActivation: 1, automationRevoke: 1 }
        : { automationGrants: 1, automationRequests: 1, automationRevoke: 1 }) })
      && expectedWrites.size === 0 && canceledActions === 5, 'EXACT_WRITE_COUNTS_REQUIRED')
    check(counts.apiRequests === counts.apiResponses && counts.viteErrors === 0 && faults.length === 0, 'FINAL_NETWORK_FAILURE')
    projectSheetsOff.verify()
    membersOff.verify()
    dryRunStatus.verify()
    check(bundleDocumentResponses >= 3 && counts.viteHmrConnections === 0
      && [...bundleServedFiles].filter(file => file.endsWith('.js')).length >= 2
      && [...bundleServedFiles].some(file => file.endsWith('.css')), 'REAL_PRODUCTION_BUNDLE_NOT_EXERCISED')
    check(observedScopes.some(scope => scope.kind === 'preview') && observedScopes.every(scope => scope.tenantMatched), 'REAL_SCOPE_OBSERVATION_REQUIRED')
    return { status: 'passed', versionId, validationId, dryRunToken: preview.dryRunToken, generation: 1, k3, yida, yidaOwnerOff, automation,
      evidence: { realAppEntry: true, realViteConfig: true, realLoginForm: true, realApiProxy: true,
        productionBundle: true, servedBundleBytesVerified: true,
        realTopbarNavigation: true, realInstallTab: true, realProjectWorkspaceNavigation: true,
        reloadSessionVerified: true, loginReloadPrincipalMatched: true, exactIntegrationPluginActive: true,
        sourceBoundThroughUi: true, sourceBindingReadbackVerified: true, freshDraftSavedThroughUi: true,
        explicitTenantScopeFullReload: true, authStorageUnchangedByScopeChoice: true,
        existingWorkspaceBindingExplicitlyReboundToTenant: true, exactTenantBindingReadbackVerified: true,
        physicalCatalogValidated: true, realSampleRendered: true, ownerConfirmedExactReceipt: true,
        unvalidatedApprovalBlocked: true, unconfirmedApprovalBlocked: true, approvalDidNotActivate: true,
        activatedVersionReadbackVerified: true, configuredPreviewAddThree: true, previewCanApply: true, previewDidNotSync: true,
        managementScopeHeadersAbsent: true, reloadPersisted: true, responseStubs: 0, storageInjections: 0,
        sourceIoPostCount: 2, forbiddenBusinessWriteRequests: 0 },
      counts: { ...counts, apiSuccesses: successes, writes: writeCounts, canceledActions,
        membersOff: membersOff.counts,
        dryRunStatus: dryRunStatus.counts,
        bundleDocumentResponses, bundleServedFileCount: bundleServedFiles.size,
        scopeObservations: observedScopes.length,
        shellWorkspaceNull: observedScopes.every(scope => scope.workspaceNull),
        shellWorkspaceTenantAlias: observedScopes.every(scope => scope.workspaceTenantAlias) } }
  } catch (error) {
    console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'browser-failure-counts', phase, counts,
      apiSuccesses: successes }))
    // Neither Playwright call logs nor server error payloads may expose a filled
    // password, auth token, URL/query, principal, or backend row in evidence.
    const errorCode = object(error) && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : null
    const reason = faults[0] ?? (error instanceof Error && /^APP_BROWSER_[A-Z_]+$/.test(error.message)
      ? error.message.slice('APP_BROWSER_'.length) : errorCode ?? (error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT'
        : error instanceof TypeError ? 'TYPE_ERROR' : 'FAILED'))
    throw new Error(`APP_BROWSER_${phase}_${reason}`)
  } finally {
    closing = true
    try {
      try { await browser?.close() } catch { throw new Error('APP_BROWSER_CLOSE_FAILED') }
    } finally {
      try { await vite?.close() } catch { throw new Error('APP_BROWSER_VITE_CLOSE_FAILED') }
    }
  }
}
