import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// 备料分批拉取第一期 step 6a-3 (S6-3; step-6 design §3.5, §3.8, §3.11, §5.4 as amended by the 2026-11-09 rebaseline;
// register R-91) — 「拉取待确认」's RECOVERY CARD (StockPreparationRefreshRecoveryCard.vue) and the client it is built
// from (refreshRecovery.ts, the three calls on refreshQueue.ts's one api seam).
//
//   RC-W1        visibility by state: the card (and the audited executions read) ONLY while the page's summary says
//                failed_pending_recovery — never for not_governed / pending / complete / unreadable (dormancy); its own
//                rendering (never 「无待处理」); a running execution under a live lease is shown but cannot be checked.
//   RC-NONE      失败待恢复 with nothing unfinished on the pages read (an abandoned lease alone): the way out in words
//                (re-read; then ONE applicable preview on the project page; then the platform admin), no 「核对上次写入」
//                lead over it, and 更多执行记录 still offered while the list has a next page.
//   RC-W2        verify (report + one page of the pending list, paged, each page a fresh digest) and close with a typed
//                number, echoing the LAST digest; after the close 「请重新试算」 and the page re-reads.
//   RC-W3        UNPROVABLE: the reasons in words + 「请平台管理员按手册处理」, no close; the admin's runbook flow (inspect,
//                runbook ticket, acknowledgement, typed number) and its exact body; absent for a puller.
//   RC-W4        words for every token the card shows, read LIVE from the plugin (results, refusal reasons, entry
//                classes, execution statuses, closed modes, plan and batch outcomes); the card's own readings of the
//                refusals; the holder-neutral lease_in_flight copy (the S6-2 follow-up).
//   RC-W5        RECOVERY_BUSY / `generationBumped: false` copy; STALE drops the report (a new verify, never a resend).
//   RC-BODY      the bodies ⊆ the server's allow-lists (parsed out of http-routes.cjs) and pass the plugin's REAL
//                normalizers; tenantId only when non-blank, never workspaceId; `limit` never sent.
//   RC-CONTRACT  the mirrored constants (unfinished statuses, the runbook-ticket pattern, the page size).
//   RC-SWITCH    N-SWITCH by KEY PRESENCE: no batch key => no batch line (list, report, the admin's inspect report); a
//                present null => 「没有关联」.
//   RC-RELIST    NOT_UNFINISHED / NOT_FOUND => the page re-reads (the card follows its summary).
//   RC-VALUES    the pending page's values on the page only — never in storage, an emit, the clipboard or any console call.
//   RC-ALIGN     through the REAL shell, per actor: the three recovery control ids rendered == the manifest grant ∩ three.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
  route: { path: '/stock-prep', fullPath: '/stock-prep', meta: {} as Record<string, unknown>, query: {} as Record<string, unknown> },
  router: { push: vi.fn(), replace: vi.fn() },
  clipboard: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(h.locale), isZh: ref(h.locale === 'zh-CN'), setLocale: vi.fn() }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => h.route, useRouter: () => h.router }
})

vi.mock('../src/views/plm/plmClipboard', () => ({
  copyTextToClipboard: (text: string) => { h.clipboard(text); return Promise.resolve(true) },
}))

import StockPreparationRefreshQueueView from '../src/components/integration/stockPreparation/StockPreparationRefreshQueueView.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import {
  STOCK_PREP_RECOVERY_PENDING_PAGE_SIZE,
  STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN,
  STOCK_PREP_REFRESH_CLOSE_UNVERIFIED_KEYS,
  STOCK_PREP_REFRESH_EXECUTIONS_QUERY_KEYS,
  STOCK_PREP_REFRESH_RECOVER_KEYS,
  STOCK_PREP_UNFINISHED_EXECUTION_STATUSES,
  buildCloseUnverifiedCloseBody,
  buildCloseUnverifiedInspectBody,
  buildRecoverCloseBody,
  buildRecoverVerifyBody,
  stockPrepRecoveryBatchOf,
  stockPrepRecoveryCardShown,
  type StockPrepRecoveryReport,
} from '../src/services/integration/stockPreparation/refreshRecovery'
import {
  STOCK_PREP_EXECUTION_CLOSED_MODE_PLAIN,
  STOCK_PREP_EXECUTION_STATUS_PLAIN,
  STOCK_PREP_RECOVERY_BATCH_OUTCOME_PLAIN,
  STOCK_PREP_RECOVERY_CLASS_PLAIN,
  STOCK_PREP_RECOVERY_KIND_PLAIN,
  STOCK_PREP_RECOVERY_PLAN_OUTCOME_PLAIN,
  STOCK_PREP_RECOVERY_REASON_PLAIN,
  STOCK_PREP_RECOVERY_RESULT_PLAIN,
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  stockPrepErrorPlain,
  stockPrepRecoveryErrorPlain,
  stockPrepRefreshTokenPlain,
} from '../src/services/integration/stockPreparation/plainLanguage'
import { STOCK_PREP_WORKBENCH_CAPABILITIES, visibleStockPrepControls } from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const nodeRequire = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../plugins/plugin-integration-core/lib/'
const pluginSource = (name: string): string => readFileSync(resolve(REPO_ROOT, 'plugins/plugin-integration-core/lib', name), 'utf8').replace(/\r\n/g, '\n')
const HTTP_ROUTES_SOURCE = pluginSource('http-routes.cjs')
const recovery = nodeRequire(`${PLUGIN_LIB}stock-preparation-execution-recovery.cjs`) as {
  PENDING_PAGE_SIZE: number
  RECOVERY_REFUSAL_REASONS: readonly string[]
  normalizeRecoverBody: (body: unknown) => unknown
  normalizeCloseUnverifiedBody: (body: unknown) => unknown
}
const store = nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-store.cjs`) as {
  UNFINISHED_EXECUTION_STATUSES: readonly string[]
  EXECUTION_STATUSES: readonly string[]
  VERIFIED_RESULTS: readonly string[]
  CLOSED_MODES: readonly string[]
  REFRESH_STORE_ERROR_CODES: Record<string, string>
}
const intent = nodeRequire(`${PLUGIN_LIB}stock-preparation-execution-intent.cjs`) as {
  INTENT_RESULTS: readonly string[]
  INTENT_ENTRY_CLASSES: readonly string[]
}

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'SYN-PROJ-0001'
const SENTINEL = 'SYN-PART-NAME-SENTINEL'
const ISO = '2026-11-09T00:00:00.000Z'
const EXEC = 'exec_syn_0001'
const DIGEST = (n: number) => String(n % 10).repeat(64)
const RECOVERY_CONTROLS = ['stock-prep-refresh-executions', 'stock-prep-refresh-recover', 'stock-prep-refresh-close-unverified']

// ---------------------------------------------------------------------------
// the synthetic server (listExecutionsRead / recoveryReportOf / pendingPageOf / closeExecution / the route's close
// answer, key for key; every value synthetic)
// ---------------------------------------------------------------------------

function execution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXEC,
    status: 'failed',
    verifiedResult: null,
    closedMode: null,
    preCloseStatus: null,
    startedAt: ISO,
    finishedAt: ISO,
    verifiedAt: null,
    plannedCounts: { add: 2, update: 1 },
    counts: { add: 1 },
    written: 1,
    attemptedWrites: 2,
    abortCode: null,
    errorCodes: ['WRITE_FAILED'],
    binding: { continuationCount: 0, changePlanBound: false },
    settlementSubject: true,
    recoverable: true,
    ...overrides,
  }
}

function report(overrides: Partial<StockPrepRecoveryReport> & Record<string, unknown> = {}): Record<string, unknown> {
  const counts = { intended: 3, landed: 1, notLanded: 2, diverged: 0, duplicate: 0, vanished: 0, replaced: 0 }
  return {
    executionId: EXEC,
    preStatus: 'failed',
    result: 'mixed',
    counts,
    byKind: { add: { ...counts }, update: { intended: 0, landed: 0, notLanded: 0, diverged: 0, duplicate: 0, vanished: 0, replaced: 0 }, inactive: { intended: 0, landed: 0, notLanded: 0, diverged: 0, duplicate: 0, vanished: 0, replaced: 0 } },
    refusalReasons: [],
    closeAdmissible: true,
    remaining: { add: 2, update: 0, inactive: 0, manualConfirm: 0, suspended: false, holdCount: 0 },
    settlesIfClosedNow: true,
    changePlan: null,
    pending: { total: 2, pageCount: 1 },
    ...overrides,
  }
}

interface ServerState {
  status: string
  governed: string
  holds: Array<Record<string, unknown>>
  executions: Array<Record<string, unknown>>
  /** The first executions page's `nextCursor` (null = one page); a read WITH a cursor answers `moreExecutions`. */
  listNextCursor: string | null
  moreExecutions: Array<Record<string, unknown>>
  /** Each verify answers the next digest (every verify is a fresh in-lease recompute). */
  verifies: number
  reportOverrides: Record<string, unknown>
  pendingEntries: Array<Record<string, unknown>>
  pageSize: number
  /** The next POST answer, once (a refusal). */
  postAnswer: { status: number; body: unknown } | null
  closeAnswer: Record<string, unknown>
  inspectOverrides: Record<string, unknown>
  requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }>
}

function serverState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    status: 'failed_pending_recovery',
    governed: 'pilot',
    holds: [],
    executions: [execution(), execution({ id: 'exec_syn_old', status: 'succeeded', verifiedResult: null, recoverable: false })],
    listNextCursor: null,
    moreExecutions: [],
    verifies: 0,
    reportOverrides: {},
    pendingEntries: [
      { decisionIndex: 1, kind: 'add', class: 'not_landed', componentCode: 'SYN-PART-0002', componentName: SENTINEL, sourceGone: false },
      { decisionIndex: 2, kind: 'add', class: 'not_landed', componentCode: 'SYN-PART-0003', componentName: 'SYN-PART-NAME-3', sourceGone: true },
    ],
    pageSize: 200,
    postAnswer: null,
    closeAnswer: {},
    inspectOverrides: {},
    requests: [],
    ...overrides,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function refusal(status: number, code: string, details: Record<string, unknown> = {}): { status: number; body: unknown } {
  return { status, body: { ok: false, error: { code, message: 'x', details } } }
}

function summaryOf(state: ServerState): Record<string, unknown> {
  return {
    readable: state.status !== 'unreadable',
    status: state.status,
    governed: state.governed,
    counts: { pendingConfirm: state.holds.length, confirmable: 0, openExecutions: 1, pendingReviews: 0, continuations: 0 },
    pilot: true,
  }
}

function lastVerifyDigest(state: ServerState): string {
  return DIGEST(state.verifies)
}

function router(state: ServerState) {
  return async (path: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    state.requests.push({ url: path, method, body })
    const url = new URL(path, 'https://api.example.test')
    const pathProject = decodeURIComponent(url.pathname.split('/projects/')[1]?.split('/')[0] ?? '')
    if (url.pathname.includes('/refresh/executions')) {
      if (method === 'GET' && url.pathname.endsWith('/refresh/executions')) {
        if (url.searchParams.get('cursor')) {
          return json(200, { ok: true, data: { items: state.moreExecutions, nextCursor: null, total: state.executions.length + state.moreExecutions.length } })
        }
        return json(200, { ok: true, data: { items: state.executions, nextCursor: state.listNextCursor, total: state.executions.length + state.moreExecutions.length } })
      }
      if (method === 'POST') {
        const typed = typeof body?.confirmProjectNo === 'string' ? body.confirmProjectNo.trim() : ''
        if (typed !== pathProject) return json(400, { ok: false, error: { code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID', message: 'x', details: { field: 'confirmProjectNo' } } })
        if (state.postAnswer) {
          const answer = state.postAnswer
          state.postAnswer = null
          return json(answer.status, answer.body)
        }
        if (url.pathname.endsWith('/recover')) {
          if (body?.mode === 'verify') {
            state.verifies += 1
            const cursor = typeof body.pageCursor === 'number' ? body.pageCursor : null
            const start = cursor === null ? 0 : state.pendingEntries.findIndex((entry) => Number(entry.decisionIndex) > cursor)
            const from = start < 0 ? state.pendingEntries.length : start
            const slice = state.pendingEntries.slice(from, from + state.pageSize)
            const nextCursor = from + slice.length < state.pendingEntries.length ? Number(slice[slice.length - 1].decisionIndex) : null
            const pageCount = Math.ceil(state.pendingEntries.length / state.pageSize)
            return json(200, { ok: true, data: { operation: 'verify', report: report({ pending: { total: state.pendingEntries.length, pageCount }, ...state.reportOverrides, verifyDigest: lastVerifyDigest(state) }), pending: { pageIndex: Math.floor(from / state.pageSize), entries: slice, nextCursor } } })
          }
          if (body?.mode === 'close') {
            if (body.verifyDigest !== lastVerifyDigest(state)) return json(409, { ok: false, error: { code: 'STOCK_PREP_REFRESH_RECOVERY_STALE', message: 'x', details: { partial: false } } })
            state.status = 'executed_pending_settlement'
            return json(200, { ok: true, data: { operation: 'close', executionId: EXEC, closed: true, closedMode: 'puller_verified', preStatus: 'failed', result: 'mixed', transparent: false, settlementSubject: true, continuationsConsumed: 0, changePlan: null, settled: false, decisionVersion: 7, generationBumped: true, nextStep: 'preview_again', ...state.closeAnswer } })
          }
        }
        if (url.pathname.endsWith('/close-unverified')) {
          if (body?.mode === 'inspect') {
            return json(200, { ok: true, data: { operation: 'inspect', report: report({ result: 'unprovable', refusalReasons: ['duplicate_rows'], closeAdmissible: false, remaining: null, settlesIfClosedNow: false, inspectDigest: 'e'.repeat(64), ...state.inspectOverrides }) } })
          }
          if (body?.mode === 'close') {
            state.status = 'executed_pending_settlement'
            return json(200, { ok: true, data: { operation: 'close_unverified', executionId: EXEC, closed: true, closedMode: 'runbook', preStatus: 'failed', result: 'unknown', transparent: false, settlementSubject: true, continuationsConsumed: 0, changePlan: null, settled: false, decisionVersion: 8, generationBumped: true, nextStep: 'preview_again' } })
          }
        }
      }
      return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'x' } })
    }
    if (url.pathname.endsWith('/refresh/holds') && method === 'GET') {
      return json(200, {
        ok: true,
        data: {
          refresh: summaryOf(state),
          holdSetFingerprint: '9'.repeat(64),
          decisionVersion: 4,
          page: { holds: state.holds, next: null, limit: 20, pairLimit: 200 },
          readReceipt: state.status === 'not_governed' ? null : { id: 'fedcba9876543210fedcba9876543210', expiresAt: ISO, holds: {} },
        },
      })
    }
    return json(200, { ok: true, data: {} })
  }
}

// ---------------------------------------------------------------------------
// mounting
// ---------------------------------------------------------------------------

let app: VueApp | null = null
let container: HTMLDivElement | null = null
const emitted: Array<{ event: string; args: unknown[] }> = []

async function flush(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

function setup(): void {
  h.locale = 'zh-CN'
  h.permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
  h.roles = []
  h.route.query = {}
  h.apiFetch.mockReset()
  h.router.push.mockReset()
  h.router.replace.mockReset()
  h.clipboard.mockReset()
  resetStockPreparationOperatorHomeDirectoryThrottle()
  try { window.localStorage.clear(); window.sessionStorage.clear() } catch { /* jsdom always has them */ }
  container = document.createElement('div')
  document.body.appendChild(container)
}

function teardown(): void {
  if (app) app.unmount()
  if (container) container.remove()
  app = null
  container = null
}

async function mountView(state: ServerState, projectNo = PROJECT): Promise<HTMLDivElement> {
  emitted.length = 0
  h.apiFetch.mockImplementation(router(state))
  app = createApp(StockPreparationRefreshQueueView as Component, {
    scope: SCOPE,
    projectNo,
    onNavigateStage: (...args: unknown[]) => emitted.push({ event: 'navigate-stage', args }),
    onRefreshChanged: (...args: unknown[]) => emitted.push({ event: 'refresh-changed', args }),
  })
  app.mount(container!)
  await flush()
  return container!
}

function q(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
}

function all(root: ParentNode, testid: string): HTMLElement[] {
  return [...root.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
}

function control(root: ParentNode, testid: string): HTMLButtonElement {
  const el = q(root, testid) as HTMLButtonElement | null
  expect(el, `${testid} renders`).not.toBeNull()
  return el!
}

async function click(el: HTMLElement): Promise<void> {
  el.click()
  await flush()
}

async function typeInto(root: ParentNode, testid: string, value: string): Promise<void> {
  const input = q(root, testid) as HTMLInputElement
  expect(input, `${testid} renders`).not.toBeNull()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush(2)
}

async function tick(root: ParentNode, selector: string, checked = true): Promise<void> {
  const box = root.querySelector(selector) as HTMLInputElement
  expect(box, selector).not.toBeNull()
  box.checked = checked
  box.dispatchEvent(new Event('change'))
  await flush(2)
}

function executionReads(state: ServerState) {
  return state.requests.filter((request) => request.method === 'GET' && request.url.includes('/refresh/executions'))
}

function posts(state: ServerState, suffix: string) {
  return state.requests.filter((request) => request.method === 'POST' && request.url.endsWith(suffix))
}

/** The server's closed allow-list, read out of the PLUGIN SOURCE (so a server change reds here). */
function serverAllowList(name: string): string[] {
  const match = HTTP_ROUTES_SOURCE.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  expect(match, `${name} in http-routes.cjs`).not.toBeNull()
  return [...match![1].matchAll(/'([A-Za-z]+)'/g)].map((entry) => entry[1])
}

/** The string literals `pattern` captures inside `function <name>(` of a plugin source (not exported). */
function scannedLiterals(file: string, functionName: string, pattern: RegExp): string[] {
  const source = pluginSource(file)
  const start = source.indexOf(`function ${functionName}(`)
  expect(start, `${functionName} in ${file}`).toBeGreaterThan(0)
  const next = source.slice(start + 1).search(/\n {0,2}(async )?function /)
  const body = source.slice(start, next > 0 ? start + 1 + next : undefined)
  const tokens = new Set<string>()
  for (const match of body.matchAll(pattern)) tokens.add(match[1])
  return [...tokens].sort()
}

/** closePlanCellWithin's `answer(cell, status, outcome, …)` calls: every literal token of the THIRD argument (not exported). */
function planOutcomes(): string[] {
  const source = pluginSource('stock-preparation-continuation-store.cjs')
  const start = source.indexOf('function closePlanCellWithin(')
  expect(start, 'closePlanCellWithin in the store').toBeGreaterThan(0)
  const next = source.slice(start + 1).search(/\n {0,2}(async )?function /)
  const body = source.slice(start, next > 0 ? start + 1 + next : undefined)
  const tokens = new Set<string>()
  for (const call of body.matchAll(/\banswer\(([^,]+), '([a-z_]+)', ([^,)]+)/g)) {
    for (const literal of call[3].matchAll(/'([a-z_]+)'/g)) tokens.add(literal[1])
  }
  return [...tokens].sort()
}

async function verifyFirst(root: HTMLElement): Promise<void> {
  await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', ` ${PROJECT} `)
  await click(control(root, 'stock-prep-refresh-recover'))
}

// ---------------------------------------------------------------------------

describe('「拉取待确认」 — the recovery card (RC)', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('RC-W1: the card and its audited executions read ONLY while the summary says failed_pending_recovery; its own rendering, never 「无待处理」', async () => {
    for (const status of ['not_governed', 'pending_confirmation', 'complete', 'executed_pending_settlement', 'change_pending_review', 'executing', 'unreadable']) {
      teardown(); setup()
      const state = serverState({ status, governed: status === 'not_governed' ? 'none' : 'pilot' })
      const root = await mountView(state)
      expect(q(root, 'stock-prep-refresh-recovery'), status).toBeNull()
      expect(executionReads(state), `${status}: no executions read (dormancy)`).toEqual([])
    }
    teardown(); setup()
    const state = serverState()
    const root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-recovery')).not.toBeNull()
    expect(executionReads(state)).toHaveLength(1)
    expect(executionReads(state)[0].url).toBe(`/api/integration/stock-preparation/projects/${PROJECT}/refresh/executions?tenantId=tenant-syn`)
    expect(root.querySelector('[data-testid="stock-prep-refresh-queue"]')?.getAttribute('data-refresh-rendering')).toBe('recovery_pending')
    expect(q(root, 'stock-prep-refresh-state')?.textContent).toContain('上次写入未完成')
    expect(q(root, 'stock-prep-refresh-state')?.textContent).not.toContain('无待处理')
    // Only the UNFINISHED execution is offered (the succeeded one is history).
    const items = all(root, 'stock-prep-refresh-recovery-execution')
    expect(items).toHaveLength(1)
    expect(items[0].getAttribute('data-execution-status')).toBe('failed')
    expect(items[0].textContent).toContain('失败')
    // The page's own 「重新读取」 re-reads the card too (one more executions read, not two).
    await click(control(root, 'stock-prep-refresh-holds'))
    expect(executionReads(state)).toHaveLength(2)
  })

  it('RC-W1 (with holds): holds and the card render together; the card stands above the holds', async () => {
    const hold = { id: 'hold_syn_1', kind: 'structure_change', status: 'open', confirmable: false, notConfirmableReason: 'structure_change_only_runbook', shapeToken: null, runbookOnly: false, continuationId: null, fingerprint: '1'.repeat(64), comparisonFingerprint: null, evidenceFingerprint: null, openedAt: ISO, lastSeenAt: ISO, history: 'history_unknown', candidates: [], verification: null, detail: null, pairPage: { index: 0, count: 1, size: 200, next: null } }
    const root = await mountView(serverState({ holds: [hold] }))
    const card = q(root, 'stock-prep-refresh-recovery')
    const holdEl = q(root, 'stock-prep-refresh-hold')
    expect(card).not.toBeNull()
    expect(holdEl).not.toBeNull()
    expect(card!.compareDocumentPosition(holdEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('RC-W1 (running): a running execution under the live lease is shown, its controls present but disabled', async () => {
    const root = await mountView(serverState({ executions: [execution({ status: 'running', recoverable: false })] }))
    expect(q(root, 'stock-prep-refresh-recovery-running')).not.toBeNull()
    await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', PROJECT)
    expect(control(root, 'stock-prep-refresh-recover').disabled).toBe(true)
    expect(control(root, 'stock-prep-refresh-recovery-close').disabled).toBe(true)
  })

  it('RC-W1 (fail closed): a malformed or refused executions answer is never "nothing unfinished"', async () => {
    const state = serverState()
    h.apiFetch.mockImplementation(async (path: string, init: { method?: string } = {}) => {
      if (path.includes('/refresh/executions')) return json(200, { ok: true, data: {} })
      return router(state)(path, init)
    })
    app = createApp(StockPreparationRefreshQueueView as Component, { scope: SCOPE, projectNo: PROJECT })
    app.mount(container!)
    await flush()
    expect(q(container!, 'stock-prep-refresh-recovery-unreadable')).not.toBeNull()
    expect(q(container!, 'stock-prep-refresh-recovery-none')).toBeNull()
    expect(q(container!, 'stock-prep-refresh-recover')).toBeNull()
  })

  it('RC-NONE: 失败待恢复 with no unfinished execution on the first page names a way out (re-read, then ONE applicable preview, then the admin); 更多执行记录 still offered', async () => {
    // The server derives 失败待恢复 from an abandoned lease alone (refresh-state.cjs), e.g. a close that committed but
    // whose release failed, or a crashed pull with no execution row: the list then holds nothing unfinished.
    const state = serverState({ executions: [execution({ id: 'exec_syn_old', status: 'verified_closed', recoverable: false })] })
    const root = await mountView(state)
    const none = q(root, 'stock-prep-refresh-recovery-none')
    expect(none).not.toBeNull()
    expect(none!.textContent).toContain('没有找到未完成的执行')
    expect(none!.textContent).toContain('先点上面的「重新读取」')
    expect(none!.textContent).toContain('中断的写入还占着这张表的写入')
    expect(none!.textContent).toContain('项目备料页重新试算一次')
    expect(none!.textContent).toContain('能应用的试算')
    expect(none!.textContent).toContain('平台管理员')
    // Never the instruction to press a button this state does not render.
    expect(q(root, 'stock-prep-refresh-recovery-intro'), 'no 「核对上次写入」 intro in none').toBeNull()
    expect(root.textContent).not.toContain('先点「核对上次写入」')
    expect(q(root, 'stock-prep-refresh-recover')).toBeNull()
    expect(q(root, 'stock-prep-refresh-recovery-more'), 'one page: no 更多').toBeNull()
    // The page's 「重新读取」 re-reads the same picture (the copy above is what turns it into a way out).
    await click(control(root, 'stock-prep-refresh-holds'))
    expect(executionReads(state)).toHaveLength(2)
    expect(q(root, 'stock-prep-refresh-recovery-none')).not.toBeNull()
    // A later page may still hold the unfinished execution: 更多执行记录 renders in none, and reading it flips to ready.
    teardown(); setup()
    const paged = serverState({
      executions: [execution({ id: 'exec_syn_old', status: 'verified_closed', recoverable: false })],
      listNextCursor: 'cur_syn_2',
      moreExecutions: [execution()],
    })
    const pagedRoot = await mountView(paged)
    expect(q(pagedRoot, 'stock-prep-refresh-recovery-none')).not.toBeNull()
    await click(control(pagedRoot, 'stock-prep-refresh-recovery-more'))
    expect(executionReads(paged)[1].url).toContain('cursor=cur_syn_2')
    expect(pagedRoot.querySelector('[data-testid="stock-prep-refresh-recovery"]')?.getAttribute('data-recovery-state')).toBe('ready')
    expect(all(pagedRoot, 'stock-prep-refresh-recovery-execution')).toHaveLength(1)
    expect(q(pagedRoot, 'stock-prep-refresh-recovery-intro')?.textContent).toContain('先点「核对上次写入」')
  })

  it('RC-W2: verify needs the typed number; the report and the pending page render; page 2 is a fresh verify; close echoes the LAST digest; 「请重新试算」 after', async () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ decisionIndex: index * 2, kind: index === 2 ? 'update' : 'add', class: index === 1 ? 'diverged' : 'not_landed', componentCode: `SYN-PART-00${index}`, componentName: index === 0 ? SENTINEL : `SYN-NAME-${index}`, sourceGone: index === 2 }))
    const state = serverState({ pendingEntries: entries, pageSize: 2 })
    const root = await mountView(state)
    const verifyButton = control(root, 'stock-prep-refresh-recover')
    expect(verifyButton.disabled, 'no typed number yet').toBe(true)
    expect(control(root, 'stock-prep-refresh-recovery-close').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-recovery-close-why')?.textContent).toContain('输入本项目的项目号')
    await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', 'SYN-PROJ-9999')
    expect(control(root, 'stock-prep-refresh-recover').disabled, 'a wrong number').toBe(true)
    await verifyFirst(root)
    expect(posts(state, '/recover')).toHaveLength(1)
    expect(posts(state, '/recover')[0].body).toEqual({ tenantId: 'tenant-syn', confirmProjectNo: PROJECT, mode: 'verify' })
    const shown = control(root, 'stock-prep-refresh-recovery-report')
    expect(shown.getAttribute('data-result')).toBe('mixed')
    expect(q(root, 'stock-prep-refresh-recovery-result')?.textContent).toContain('写入了一部分')
    expect(q(root, 'stock-prep-refresh-recovery-counts')?.textContent).toContain('计划写 3 行:已写入 1,没写入 2')
    expect(q(root, 'stock-prep-refresh-recovery-remaining')?.textContent).toContain('新增 2')
    expect(q(root, 'stock-prep-refresh-recovery-settles')?.getAttribute('data-settles')).toBe('true')
    expect(all(root, 'stock-prep-refresh-recovery-pending-entry')).toHaveLength(2)
    expect(q(root, 'stock-prep-refresh-recovery-pending')?.textContent).toContain(SENTINEL)
    expect(q(root, 'stock-prep-refresh-recovery-pending')?.textContent).toContain('对不上')
    expect(q(root, 'stock-prep-refresh-recovery-pending-pages')?.textContent).toContain('第 1 / 2 页')
    // Page 2: a fresh verify with the decision index cursor; its (new) digest replaces the shown one.
    await click(control(root, 'stock-prep-refresh-recovery-pending-next'))
    expect(posts(state, '/recover')[1].body).toEqual({ tenantId: 'tenant-syn', confirmProjectNo: PROJECT, mode: 'verify', pageCursor: 2 })
    expect(all(root, 'stock-prep-refresh-recovery-pending-entry')).toHaveLength(1)
    expect(q(root, 'stock-prep-refresh-recovery-source-gone')?.textContent).toContain('源中已无')
    expect(q(root, 'stock-prep-refresh-recovery-pending-next')).toBeNull()
    // Close: echoes the digest of the LAST verify (page 2's), never page 1's.
    const close = control(root, 'stock-prep-refresh-recovery-close')
    expect(close.disabled).toBe(false)
    await click(close)
    const closeBody = posts(state, '/recover')[2].body
    expect(closeBody).toEqual({ tenantId: 'tenant-syn', confirmProjectNo: PROJECT, mode: 'close', verifyDigest: DIGEST(2) })
    // After the close: the page re-read (the card is gone with the status) and says 「请重新试算」.
    expect(q(root, 'stock-prep-refresh-recovery')).toBeNull()
    const again = control(root, 'stock-prep-refresh-preview-again')
    expect(again.getAttribute('data-preview-again')).toBe('recovered')
    expect(again.textContent).toContain('请重新试算')
    expect(q(root, 'stock-prep-refresh-recovery-not-bumped')).toBeNull()
    await click(control(root, 'stock-prep-refresh-go-preview'))
    expect(emitted.find((entry) => entry.event === 'navigate-stage')?.args).toEqual(['project-board', PROJECT])
  })

  it('RC-W3: UNPROVABLE — the reasons in words, 「请平台管理员按手册处理」, no close; a puller has no runbook control', async () => {
    const state = serverState({ reportOverrides: { result: 'unprovable', refusalReasons: ['duplicate_rows', 'diverged', 'reason_from_a_newer_server'], closeAdmissible: false, settlesIfClosedNow: false } })
    const root = await mountView(state)
    await verifyFirst(root)
    const reasons = all(root, 'stock-prep-refresh-recovery-reason')
    expect(reasons.map((el) => el.getAttribute('data-reason'))).toEqual(['duplicate_rows', 'diverged', 'reason_from_a_newer_server'])
    expect(reasons[0].textContent).toContain('同一行出现了不止一次')
    // An unknown reason reads 「未识别」 with the token apart from the sentence.
    expect(reasons[2].querySelector('[data-testid="stock-prep-refresh-recovery-unknown-token"]')?.textContent).toBe('reason_from_a_newer_server')
    expect(q(root, 'stock-prep-refresh-recovery-unprovable')?.textContent).toContain('请平台管理员按手册处理')
    expect(control(root, 'stock-prep-refresh-recovery-close').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-recovery-close-why')?.textContent).toContain('证明不了')
    expect(q(root, 'stock-prep-refresh-recovery-settles')).toBeNull()
    expect(q(root, 'stock-prep-refresh-close-unverified')).toBeNull()
    expect(q(root, 'stock-prep-refresh-close-unverified-fieldset')).toBeNull()
  })

  it('RC-W3 (admin): inspect → ticket + acknowledgement + typed number → close-unverified, exact bodies; 「结果未知」 after', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    const state = serverState()
    const root = await mountView(state)
    const closeUnverified = control(root, 'stock-prep-refresh-close-unverified')
    expect(closeUnverified.disabled).toBe(true)
    expect(control(root, 'stock-prep-refresh-close-unverified-inspect').disabled, 'no typed number').toBe(true)
    await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', PROJECT)
    await click(control(root, 'stock-prep-refresh-close-unverified-inspect'))
    expect(posts(state, '/close-unverified')[0].body).toEqual({ tenantId: 'tenant-syn', confirmProjectNo: PROJECT, mode: 'inspect' })
    expect(q(root, 'stock-prep-refresh-close-unverified-report')?.textContent).toContain('计划写 3 行')
    expect(q(root, 'stock-prep-refresh-close-unverified-reason')?.getAttribute('data-reason')).toBe('duplicate_rows')
    expect(q(root, 'stock-prep-refresh-close-unverified-why')?.textContent).toContain('手册工单号')
    await typeInto(root, 'stock-prep-refresh-close-unverified-runbook-ref', 'bad ticket with spaces')
    expect(control(root, 'stock-prep-refresh-close-unverified').disabled, 'a ticket outside the pattern').toBe(true)
    await typeInto(root, 'stock-prep-refresh-close-unverified-runbook-ref', 'RB-2026.11:07')
    expect(control(root, 'stock-prep-refresh-close-unverified').disabled, 'no acknowledgement').toBe(true)
    expect(q(root, 'stock-prep-refresh-close-unverified-why')?.textContent).toContain('不核对结果')
    await tick(root, '[data-testid="stock-prep-refresh-close-unverified-ack"] input')
    await click(control(root, 'stock-prep-refresh-close-unverified'))
    expect(posts(state, '/close-unverified')[1].body).toEqual({ tenantId: 'tenant-syn', confirmProjectNo: PROJECT, mode: 'close', inspectDigest: 'e'.repeat(64), runbookRef: 'RB-2026.11:07', acknowledge: { resultUnknown: true } })
    expect(control(root, 'stock-prep-refresh-preview-again').getAttribute('data-preview-again')).toBe('recovered')
  })

  it('RC-W5: RECOVERY_BUSY reads 「请稍后重试」 and keeps the report; STALE drops it — a new verify, never a resend', async () => {
    const state = serverState()
    const root = await mountView(state)
    await verifyFirst(root)
    state.postAnswer = refusal(409, 'STOCK_PREP_REFRESH_RECOVERY_BUSY', { step: 'state_row', retryAfterMs: 2000, partial: false })
    await click(control(root, 'stock-prep-refresh-recovery-close'))
    expect(q(root, 'stock-prep-refresh-recovery-error')?.textContent).toContain('请稍后重试')
    expect(q(root, 'stock-prep-refresh-recovery-error')?.textContent).toContain('STOCK_PREP_REFRESH_RECOVERY_BUSY')
    expect(q(root, 'stock-prep-refresh-recovery-report'), 'BUSY keeps the report').not.toBeNull()
    expect(control(root, 'stock-prep-refresh-recovery-close').disabled).toBe(false)
    state.postAnswer = refusal(409, 'STOCK_PREP_REFRESH_RECOVERY_STALE', { partial: false })
    await click(control(root, 'stock-prep-refresh-recovery-close'))
    expect(q(root, 'stock-prep-refresh-recovery-error')?.textContent).toContain('重新核对上次写入')
    expect(q(root, 'stock-prep-refresh-recovery-report'), 'STALE drops the report').toBeNull()
    expect(control(root, 'stock-prep-refresh-recovery-close').disabled).toBe(true)
    const before = posts(state, '/recover').length
    await click(control(root, 'stock-prep-refresh-recovery-close'))
    expect(posts(state, '/recover').length, 'a disabled close sends nothing').toBe(before)
    // The holder-in-write and lease-lost readings say what happened in a RECOVERY (not a preview / sync).
    for (const [code, reason, words] of [
      ['STOCK_PREP_PROJECT_WRITE_LOCKED', 'holder_in_write', '卡在一次表格写入里'],
      ['STOCK_PREP_PROJECT_WRITE_LEASE_LOST', null, '重新核对上次写入'],
      ['STOCK_PREP_PULL_STATE_MOVED', 'intent_moved', '写入计划记录变了'],
    ] as const) {
      await verifyFirst(root)
      state.postAnswer = refusal(409, code, reason ? { reason } : {})
      await click(control(root, 'stock-prep-refresh-recovery-close'))
      expect(q(root, 'stock-prep-refresh-recovery-error')?.textContent, code).toContain(words)
    }
  })

  it('RC-W5 (generationBumped false): the close stands, and the page says to preview again all the more', async () => {
    const state = serverState({ closeAnswer: { generationBumped: false } })
    const root = await mountView(state)
    await verifyFirst(root)
    await click(control(root, 'stock-prep-refresh-recovery-close'))
    expect(control(root, 'stock-prep-refresh-preview-again').getAttribute('data-preview-again')).toBe('recovered')
    expect(q(root, 'stock-prep-refresh-recovery-not-bumped')?.textContent).toContain('写入标记')
  })

  it('RC-RELIST: NOT_UNFINISHED (verified_closed) on a verify re-reads the page; the card follows the summary', async () => {
    const state = serverState()
    const root = await mountView(state)
    const holdsBefore = state.requests.filter((request) => request.url.includes('/refresh/holds')).length
    state.postAnswer = refusal(409, 'STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED', { reason: 'verified_closed', partial: false })
    await verifyFirst(root)
    expect(state.requests.filter((request) => request.url.includes('/refresh/holds')).length).toBe(holdsBefore + 1)
    expect(executionReads(state)).toHaveLength(2)
    expect(q(root, 'stock-prep-refresh-recovery-error')?.textContent).toContain('已经核对并结束了')
  })

  it('RC-SWITCH (N-SWITCH): batch lines only where the server SENT a batch key — absent key, no line; present null, 「没有关联」', async () => {
    // OFF: no key on the item, none on the report.
    let state = serverState()
    let root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-recovery-execution-batch')).toBeNull()
    await verifyFirst(root)
    expect(q(root, 'stock-prep-refresh-recovery-report-batch')).toBeNull()
    expect(root.textContent).not.toContain('拉取批次')
    // ON: the item carries `batch: null`, the report a linked batch.
    teardown(); setup()
    state = serverState({ executions: [execution({ batch: null })], reportOverrides: { batch: { linked: true, batchNo: 3, statusSeen: 'open', verifiedCreatedRows: 1 } } })
    root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-recovery-execution-batch')?.textContent).toContain('没有关联拉取批次')
    await verifyFirst(root)
    expect(q(root, 'stock-prep-refresh-recovery-report-batch')?.textContent).toContain('第 3 批')
    expect(q(root, 'stock-prep-refresh-recovery-report-batch')?.textContent).toContain('1 行')
    // ON, linked item.
    teardown(); setup()
    state = serverState({ executions: [execution({ batch: { batchNo: 2, label: 'SYN-BATCH-LABEL-2', status: 'open' } })] })
    root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-recovery-execution-batch')?.textContent).toContain('SYN-BATCH-LABEL-2')
    // The helper is key presence, not truthiness.
    // ADMIN leg (the runbook fieldset renders for the admin tier only): OFF — the inspect report sends no batch key, so
    // no batch line and no 拉取批次 anywhere; ON — the inspect report's batch renders its line.
    teardown(); setup()
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    state = serverState()
    root = await mountView(state)
    await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', PROJECT)
    await click(control(root, 'stock-prep-refresh-close-unverified-inspect'))
    expect(q(root, 'stock-prep-refresh-close-unverified-report'), 'admin inspect report').not.toBeNull()
    expect(q(root, 'stock-prep-refresh-close-unverified-batch')).toBeNull()
    expect(root.textContent).not.toContain('拉取批次')
    teardown(); setup()
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    state = serverState({ executions: [execution({ batch: null })], inspectOverrides: { batch: { linked: true, batchNo: 4, statusSeen: 'open', verifiedCreatedRows: 2 } } })
    root = await mountView(state)
    await typeInto(root, 'stock-prep-refresh-recovery-typed-project-no', PROJECT)
    await click(control(root, 'stock-prep-refresh-close-unverified-inspect'))
    expect(q(root, 'stock-prep-refresh-close-unverified-batch')?.textContent).toContain('第 4 批')
    expect(stockPrepRecoveryBatchOf({}, 'batch')).toEqual({ shown: false })
    expect(stockPrepRecoveryBatchOf({ batch: undefined }, 'batch')).toEqual({ shown: true, value: null })
    expect(stockPrepRecoveryBatchOf({ batch: null }, 'batch')).toEqual({ shown: true, value: null })
  })

  it('RC-VALUES: the pending page shows on the page only — never in storage, an emit, the clipboard or any console call; a project switch clears it first', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}))
    const sweep = (leg: string): void => {
      const everywhere = [JSON.stringify(h.clipboard.mock.calls), JSON.stringify(emitted), JSON.stringify(spies.map((spy) => spy.mock.calls))]
      for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) everywhere.push(`${storage.key(index)}=${storage.getItem(storage.key(index) ?? '')}`)
      }
      for (const text of everywhere) {
        expect(text, leg).not.toContain(SENTINEL)
        expect(text, leg).not.toContain('SYN-PART-0002')
      }
    }
    try {
      const state = serverState()
      const root = await mountView(state)
      await verifyFirst(root)
      expect(root.textContent).toContain(SENTINEL)
      sweep('after the verify')
      state.postAnswer = refusal(409, 'STOCK_PREP_REFRESH_RECOVERY_BUSY', { step: 'audit' })
      await click(control(root, 'stock-prep-refresh-recovery-close'))
      await click(control(root, 'stock-prep-refresh-recovery-error-copy'))
      expect(h.clipboard).toHaveBeenCalled()
      sweep('after a refusal and its copied code')
      await click(control(root, 'stock-prep-refresh-recovery-close'))
      sweep('after the close')
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// RC-BODY / RC-CONTRACT / RC-WORDS — the cross-side tripwires (pure)
// ---------------------------------------------------------------------------

describe('RC-BODY / RC-CONTRACT / RC-WORDS', () => {
  it('RC-BODY: the mirrored allow-lists equal the server source; web-built bodies pass the plugin\'s REAL normalizers', () => {
    expect([...STOCK_PREP_REFRESH_EXECUTIONS_QUERY_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_EXECUTIONS_QUERY_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_RECOVER_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_RECOVER_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_CLOSE_UNVERIFIED_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CLOSE_UNVERIFIED_KEYS').sort())
    const shown = report({ verifyDigest: 'a'.repeat(64), inspectDigest: 'b'.repeat(64) }) as unknown as StockPrepRecoveryReport
    const bodies: Array<[string, Record<string, unknown> | null, (body: unknown) => unknown, readonly string[]]> = [
      ['verify', buildRecoverVerifyBody({ confirmProjectNo: ` ${PROJECT} ` }) as Record<string, unknown> | null, recovery.normalizeRecoverBody, STOCK_PREP_REFRESH_RECOVER_KEYS],
      ['verify page 2', buildRecoverVerifyBody({ confirmProjectNo: PROJECT, pageCursor: 199 }) as Record<string, unknown> | null, recovery.normalizeRecoverBody, STOCK_PREP_REFRESH_RECOVER_KEYS],
      ['close', buildRecoverCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: shown }) as Record<string, unknown> | null, recovery.normalizeRecoverBody, STOCK_PREP_REFRESH_RECOVER_KEYS],
      ['inspect', buildCloseUnverifiedInspectBody({ confirmProjectNo: PROJECT }) as Record<string, unknown> | null, recovery.normalizeCloseUnverifiedBody, STOCK_PREP_REFRESH_CLOSE_UNVERIFIED_KEYS],
      ['close-unverified', buildCloseUnverifiedCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: shown, runbookRef: ' RB-1 ', acknowledged: true }) as Record<string, unknown> | null, recovery.normalizeCloseUnverifiedBody, STOCK_PREP_REFRESH_CLOSE_UNVERIFIED_KEYS],
    ]
    for (const [name, body, normalize, keys] of bodies) {
      expect(body, name).not.toBeNull()
      expect(Object.keys(body!).filter((key) => !keys.includes(key)), `${name}: keys outside the allow-list`).toEqual([])
      expect(body!.confirmProjectNo, `${name}: the TYPED number, trimmed`).toBe(PROJECT)
      expect(() => normalize(body), name).not.toThrow()
    }
    expect(bodies[0][1]).toEqual({ confirmProjectNo: PROJECT, mode: 'verify' })
    expect(bodies[4][1]).toMatchObject({ runbookRef: 'RB-1', acknowledge: { resultUnknown: true } })
    // What the builders refuse to build, the server refuses too (never sent).
    expect(buildRecoverVerifyBody({ confirmProjectNo: PROJECT, pageCursor: -1 })).toBeNull()
    expect(() => recovery.normalizeRecoverBody({ confirmProjectNo: PROJECT, mode: 'verify', pageCursor: -1 })).toThrow()
    expect(buildRecoverCloseBody({ confirmProjectNo: PROJECT, executionId: 'exec_other', report: shown }), 'another execution\'s report').toBeNull()
    expect(buildRecoverCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: { ...shown, closeAdmissible: false } }), 'not admissible').toBeNull()
    expect(buildRecoverCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: { ...shown, refusalReasons: ['diverged'] } }), 'a refusal reason').toBeNull()
    expect(buildRecoverCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: { ...shown, verifyDigest: 'x' } }), 'a malformed digest').toBeNull()
    expect(() => recovery.normalizeRecoverBody({ confirmProjectNo: PROJECT, mode: 'close', verifyDigest: 'x' })).toThrow()
    expect(buildCloseUnverifiedCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: shown, runbookRef: 'RB-1', acknowledged: false })).toBeNull()
    expect(buildCloseUnverifiedCloseBody({ confirmProjectNo: PROJECT, executionId: EXEC, report: shown, runbookRef: 'a'.repeat(65), acknowledged: true })).toBeNull()
    expect(() => recovery.normalizeCloseUnverifiedBody({ confirmProjectNo: PROJECT, mode: 'close', inspectDigest: 'b'.repeat(64), runbookRef: 'a'.repeat(65), acknowledge: { resultUnknown: true } })).toThrow()
    expect(() => recovery.normalizeCloseUnverifiedBody({ confirmProjectNo: PROJECT, mode: 'inspect', acknowledge: { resultUnknown: true } }), 'an inspect carries no acknowledgement').toThrow()
    expect(buildCloseUnverifiedInspectBody({ confirmProjectNo: '  ' })).toBeNull()
  })

  it('RC-BODY (client): tenantId only when non-blank, never workspaceId; `limit` never sent', async () => {
    setup()
    try {
      const state = serverState()
      h.apiFetch.mockImplementation(router(state))
      const { createStockPrepRefreshQueueApi } = await import('../src/services/integration/stockPreparation/refreshQueue')
      await createStockPrepRefreshQueueApi({ tenantId: '  ', workspaceId: 'workspace-syn' }).listExecutions(PROJECT)
      await createStockPrepRefreshQueueApi({ tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }).listExecutions(PROJECT, { cursor: 'cursor_syn' })
      await createStockPrepRefreshQueueApi({ workspaceId: 'workspace-syn' }).recoverExecution(PROJECT, EXEC, { confirmProjectNo: PROJECT, mode: 'verify' })
      expect(state.requests.map((request) => request.url)).toEqual([
        `/api/integration/stock-preparation/projects/${PROJECT}/refresh/executions`,
        `/api/integration/stock-preparation/projects/${PROJECT}/refresh/executions?tenantId=tenant-syn&cursor=cursor_syn`,
        `/api/integration/stock-preparation/projects/${PROJECT}/refresh/executions/${EXEC}/recover`,
      ])
      expect(state.requests[2].body).toEqual({ confirmProjectNo: PROJECT, mode: 'verify' })
      for (const request of state.requests) {
        expect(request.url).not.toContain('workspaceId')
        expect(request.url).not.toContain('limit=')
      }
    } finally {
      teardown()
    }
  })

  it('RC-CONTRACT: the unfinished statuses, the runbook-ticket pattern and the page size mirror the plugin', () => {
    expect([...STOCK_PREP_UNFINISHED_EXECUTION_STATUSES]).toEqual([...store.UNFINISHED_EXECUTION_STATUSES])
    expect(STOCK_PREP_RECOVERY_PENDING_PAGE_SIZE).toBe(recovery.PENDING_PAGE_SIZE)
    const literal = String(STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN)
    for (const file of ['stock-preparation-execution-recovery.cjs', 'stock-preparation-continuation-store.cjs']) {
      expect(pluginSource(file), file).toContain(`const RUNBOOK_REF_PATTERN = ${literal}`)
    }
    expect(stockPrepRecoveryCardShown({ readable: true, status: 'failed_pending_recovery' })).toBe(true)
    expect(stockPrepRecoveryCardShown({ readable: false, status: 'failed_pending_recovery' })).toBe(false)
    expect(stockPrepRecoveryCardShown({ readable: true, status: 'executing' })).toBe(false)
    expect(stockPrepRecoveryCardShown(null)).toBe(false)
  })

  function expectWords(label: string, map: Record<string, { zh: string; en: string }>, tokens: readonly string[], minimum: number): void {
    expect(tokens.length, `${label}: the live list`).toBeGreaterThanOrEqual(minimum)
    const missing = tokens.filter((token) => stockPrepRefreshTokenPlain(map, token) === null)
    expect(missing, `${label} without words:\n${missing.join('\n')}`).toEqual([])
    for (const token of tokens) {
      expect(map[token].zh.trim().length, `${label}.${token}.zh`).toBeGreaterThan(0)
      expect(map[token].en.trim().length, `${label}.${token}.en`).toBeGreaterThan(0)
      expect(map[token].zh, `${label}.${token}: no raw token`).not.toMatch(/[a-z]+_[a-z_]+/)
    }
    expect(Object.keys(map).filter((key) => !tokens.includes(key)), `${label}: words for tokens the server no longer has`).toEqual([])
  }

  it('RC-WORDS: every token the card shows has words, read LIVE from the plugin', () => {
    expectWords('result', STOCK_PREP_RECOVERY_RESULT_PLAIN, [...new Set([...intent.INTENT_RESULTS, ...store.VERIFIED_RESULTS])].sort(), 5)
    expectWords('refusal reason', STOCK_PREP_RECOVERY_REASON_PLAIN, recovery.RECOVERY_REFUSAL_REASONS, 8)
    expectWords('entry class', STOCK_PREP_RECOVERY_CLASS_PLAIN, intent.INTENT_ENTRY_CLASSES, 6)
    expectWords('execution status', STOCK_PREP_EXECUTION_STATUS_PLAIN, store.EXECUTION_STATUSES, 6)
    expectWords('closed mode', STOCK_PREP_EXECUTION_CLOSED_MODE_PLAIN, store.CLOSED_MODES, 4)
    // The entry kinds the pending page answers (execution-recovery.cjs KIND_OF values).
    const kindSource = pluginSource('stock-preparation-execution-recovery.cjs').match(/const KIND_OF = Object\.freeze\(\{([^}]*)\}\)/)
    expect(kindSource, 'KIND_OF in the recovery source').not.toBeNull()
    expectWords('entry kind', STOCK_PREP_RECOVERY_KIND_PLAIN, [...kindSource![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(), 3)
    // The plan cell outcomes the close answers (closePlanCellWithin's `answer(cell, status, outcome)`).
    expectWords('plan outcome', STOCK_PREP_RECOVERY_PLAN_OUTCOME_PLAIN, planOutcomes(), 4)
    // 批次标识's batchWithin outcomes (shown only while the switch is on).
    expectWords('batch outcome', STOCK_PREP_RECOVERY_BATCH_OUTCOME_PLAIN, scannedLiterals('stock-preparation-pull-batch-store.cjs', 'batchWithin', /return '([a-z_]+)'/g), 4)
  })

  it('RC-W4: every S6-1 / S6-2 recovery code has its own copy; the card reads its refusals in recovery words; lease_in_flight is holder-neutral', () => {
    for (const key of ['EXECUTION_NOT_FOUND', 'EXECUTION_NOT_UNFINISHED', 'RECOVERY_UNPROVABLE', 'RECOVERY_STALE', 'RECOVERY_RECOMPUTE_INCOMPLETE', 'RECOVERY_BUSY']) {
      const code = store.REFRESH_STORE_ERROR_CODES[key]
      expect(Object.prototype.hasOwnProperty.call(STOCK_PREP_ERROR_PLAIN, code), code).toBe(true)
      const plain = stockPrepRecoveryErrorPlain(code)
      expect(plain, code).not.toBe(STOCK_PREP_ERROR_GENERIC)
      expect(String(plain.zhNext ?? '').length, code).toBeGreaterThan(0)
      expect(plain.zh, `${code}: no raw token inside the sentence`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/)
    }
    expect(stockPrepErrorPlain('STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE').zhNext).toContain('平台管理员按手册')
    expect(stockPrepErrorPlain('STOCK_PREP_REFRESH_RECOVERY_BUSY').zhNext).toContain('稍后重试')
    // A preview / sync sentence is not the recovery's: the card's own readings win, the shared lookup is unchanged.
    expect(stockPrepRecoveryErrorPlain('STOCK_PREP_PROJECT_WRITE_LEASE_LOST').zhNext).toContain('重新核对')
    expect(stockPrepErrorPlain('STOCK_PREP_PROJECT_WRITE_LEASE_LOST').zhNext).toContain('重新试算')
    expect(stockPrepRecoveryErrorPlain('STOCK_PREP_PROJECT_WRITE_LOCKED', 'holder_in_write').zh).toContain('卡在')
    expect(stockPrepRecoveryErrorPlain('STOCK_PREP_PULL_STATE_MOVED', 'not_a_reason')).toBe(stockPrepRecoveryErrorPlain('STOCK_PREP_PULL_STATE_MOVED'))
    expect(stockPrepRecoveryErrorPlain('SOME_UNRELATED_CODE')).toBe(STOCK_PREP_ERROR_GENERIC)
    // The S6-2 follow-up: a held write turn is not always a pull writing — during a recovery check (and between a
    // close's commit and its release) the formal surfaces see the RECOVERY's lease.
    for (const [code, reason] of [['STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE', 'lease_in_flight'], ['STOCK_PREP_EXPORT_BLOCKED', 'lease_in_flight'], ['STOCK_PREP_EXPORT_STATE_CHANGED', 'lease_in_flight']]) {
      const plain = stockPrepErrorPlain(code, reason)
      expect(plain, `${code}/${reason}`).not.toBe(STOCK_PREP_ERROR_PLAIN[code])
      expect(plain.zh, `${code}/${reason}`).toContain('恢复核对')
      expect(plain.zh, `${code}/${reason}: never claims a pull is writing`).not.toMatch(/^一次拉取正在写/)
    }
    expect(stockPrepErrorPlain('STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE', 'lease_in_flight').zh).toContain('最后一步通知')
    expect(stockPrepErrorPlain('STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED', 'verified_closed').zh).toContain('已经核对并结束了')
  })
})

// ---------------------------------------------------------------------------
// RC-ALIGN — through the real shell
// ---------------------------------------------------------------------------

const ALIGN_ACTORS: Array<{ name: string; roles: string[]; permissions: string[] }> = [
  { name: 'no codes', roles: [], permissions: [] },
  { name: 'integration:write holder', roles: [], permissions: ['integration:write'] },
  { name: 'read', roles: [], permissions: ['stock-prep:read'] },
  { name: 'floor (read+operate)', roles: [], permissions: ['stock-prep:read', 'stock-prep:operate'] },
  { name: 'puller (read+operate+pull)', roles: [], permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] },
  { name: 'pull without operate', roles: [], permissions: ['stock-prep:read', 'stock-prep:pull'] },
  { name: 'orphan pull', roles: [], permissions: ['stock-prep:pull'] },
  { name: 'workbench admin', roles: [], permissions: ['stock-prep:read', 'stock-prep:admin'] },
  { name: 'platform admin', roles: ['admin'], permissions: ['integration:admin'] },
  { name: 'integration:admin without role', roles: [], permissions: ['integration:admin'] },
  { name: 'stock-prep:* wildcard', roles: [], permissions: ['stock-prep:*'] },
]

describe('RC-ALIGN — the three recovery controls render for exactly the actors the manifest grants', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('RC-ALIGN: rendered recovery control ids == visibleStockPrepControls ∩ three, both directions, every actor', async () => {
    for (const id of RECOVERY_CONTROLS) {
      expect(STOCK_PREP_WORKBENCH_CAPABILITIES.some((capability) => capability.control === id), id).toBe(true)
    }
    let pullerSawTwo = false
    let adminSawThree = false
    for (const actor of ALIGN_ACTORS) {
      teardown(); setup()
      h.permissions = actor.permissions
      h.roles = actor.roles
      h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
      h.apiFetch.mockImplementation(router(serverState()))
      app = createApp(StockPreparationWorkspace as Component)
      app.mount(container!)
      await flush(14)
      const rendered = RECOVERY_CONTROLS.filter((id) => container!.querySelector(`[data-testid="${id}"]`) !== null)
      const granted = visibleStockPrepControls({ roles: actor.roles, permissions: actor.permissions }).filter((id) => RECOVERY_CONTROLS.includes(id))
      expect(rendered.sort(), actor.name).toEqual(granted.sort())
      if (granted.length === 2 && !granted.includes('stock-prep-refresh-close-unverified')) pullerSawTwo = true
      if (granted.length === 3) adminSawThree = true
    }
    // The positive controls: a puller sees the two PULL controls, an admin all three (the fixture offers every one).
    expect(pullerSawTwo).toBe(true)
    expect(adminSawThree).toBe(true)
  })

  it('RC-ALIGN (board): the floor gets the banner sentence and no link; a puller the link to 「拉取待确认」', async () => {
    const { stockPrepRefreshBanner, parseStockPrepRefreshStanza } = await import('../src/services/integration/stockPreparation/refreshState')
    const stanza = parseStockPrepRefreshStanza({ readable: true, status: 'failed_pending_recovery', governed: 'pilot', settled: false, counts: { pendingConfirm: 0 } })
    expect(stockPrepRefreshBanner(stanza, { canOpenQueue: false })?.link).toBe(false)
    expect(stockPrepRefreshBanner(stanza, { canOpenQueue: false })?.zh).toContain('等待拉取人员核对')
    expect(stockPrepRefreshBanner(stanza, { canOpenQueue: true })?.link).toBe(true)
  })
})
