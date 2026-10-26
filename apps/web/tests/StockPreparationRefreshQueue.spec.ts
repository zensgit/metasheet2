import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h as vh, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 备料分批拉取第一期 step 4 PR-7 — the COMPONENT half (design §13, §17 PR-7 row; plan §8, §9.5 U03-U04).
//
//   RQ-RENDER  「拉取待确认」's renderings: 未选项目 / 未启用 / 读取失败 / 无待处理 / holds / refused.
//   RQ-PAGE    the read receipt id rides every later read (更多, 下一页对照); confirm is disabled until EVERY pair page
//              of the hold was served, plus the history acknowledgement and the typed project number.
//   RQ-BODY    each body is EXACTLY within the server's closed allow-list (parsed out of the plugin source, so a server
//              change reds here); `acknowledge` only for history_unknown; NO `workspaceId` anywhere.
//   RQ-RECONF  a re-confirm needs the relationship's detail read and sends `continuation: { id, revision }`.
//   RQ-END     release offered only for an integer count of 0 and sends factsHoldId + factsHoldFingerprint; a null or
//              absent count offers no release (delta review N-7); escalate sends neither facts key.
//   RQ-KEEP    「暂不处理」 echoes the hold fingerprint and auto-fills confirmProjectNo (R-62 ⑧).
//   RQ-NEXT    `nextStep: 'preview_again'` ⇒ 「必须重新试算」 + 「去重新试算」 → 项目备料 on this project (E-4).
//   RQ-CHURN   409 CONFIRM_STALE / receipt fingerprint_moved ⇒ page 1 re-read + 「这一项已经更新」 (hold-id churn).
//   RQ-O11     a governed project that left the pilot shows the asymmetry note.
//   RQ-VALUES  hold values never reach localStorage, an emit payload, the error banner or the copy payload.
//   RQ-ALIGN   through the REAL shell, per actor: the six refresh control ids rendered == the manifest's grant ∩ six.
//   PB-RS      项目备料页: banner per status, ledger split, 「可以导出」 never from exportAllowed, export reason copy,
//              not-governed / absent stanza ⇒ the page as before (dormancy), the board's own 409 copy.
//   SP-*       the sync panel: suspended verdict + link (PULL only), awaiting recovery, 「核对」 (dry-run only, the
//              board's re-read is the only authority for 「核对通过」).

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
import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import {
  STOCK_PREP_REFRESH_CONFIRM_REQUEST_KEYS,
  STOCK_PREP_REFRESH_DETAIL_QUERY_KEYS,
  STOCK_PREP_REFRESH_END_REQUEST_KEYS,
  STOCK_PREP_REFRESH_EVIDENCE_QUERY_KEYS,
  STOCK_PREP_REFRESH_HOLDS_QUERY_KEYS,
  STOCK_PREP_REFRESH_KEEP_REQUEST_KEYS,
  releaseAdmissibleOnPage,
} from '../src/services/integration/stockPreparation/refreshQueue'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  visibleStockPrepControls,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'
import type { StockPreparationProjectSyncApi } from '../src/services/integration/stockPreparation/projectSync'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const HTTP_ROUTES_SOURCE = readFileSync(resolve(REPO_ROOT, 'plugins/plugin-integration-core/lib/http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'SYN-PROJ-0001'
const SENTINEL = 'SYN-PART-SENTINEL'
const RECEIPT_ID = '0123456789abcdef0123456789abcdef'
const ISO = '2026-10-26T00:00:00.000Z'

const REFRESH_CONTROLS = [
  'stock-prep-refresh-holds',
  'stock-prep-refresh-evidence',
  'stock-prep-refresh-keep',
  'stock-prep-refresh-confirm',
  'stock-prep-refresh-continuation',
  'stock-prep-refresh-end',
]

// ---------------------------------------------------------------------------
// the synthetic server (the PR-4 routes' shapes; every value synthetic)
// ---------------------------------------------------------------------------

function comparison(): Record<string, unknown> {
  return {
    outcome: 'match',
    items: [{ relativePath: [], componentSourceId: SENTINEL, root: true, fields: { componentCode: { item: 1, status: 'equal', old: SENTINEL, new: SENTINEL } } }],
    parentEdgeUsage: null,
  }
}

function candidateHold(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hold_syn_cand',
    kind: 'continuation_candidate',
    status: 'open',
    confirmable: true,
    notConfirmableReason: null,
    shapeToken: 'moved_under_new_parent',
    runbookOnly: false,
    continuationId: null,
    fingerprint: 'a'.repeat(64),
    comparisonFingerprint: 'b'.repeat(64),
    evidenceFingerprint: 'c'.repeat(64),
    pairingFingerprint: 'd'.repeat(64),
    openedAt: ISO,
    lastSeenAt: ISO,
    history: 'history_unknown',
    candidates: [{ candidateId: 'd'.repeat(64), pairs: [{ relativePath: [], componentSourceId: SENTINEL }], comparison: comparison(), history: 'history_unknown' }],
    verification: null,
    contentChanges: [],
    detail: null,
    pairPage: { index: 0, count: 2, size: 200, next: 1 },
    ...overrides,
  }
}

function relationshipHold(overrides: Record<string, unknown> = {}, verification: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hold_syn_rel',
    kind: 'relationship_reconfirm',
    status: 'open',
    confirmable: true,
    notConfirmableReason: null,
    shapeToken: null,
    runbookOnly: false,
    continuationId: 'cont_syn_1',
    fingerprint: 'e'.repeat(64),
    comparisonFingerprint: 'f'.repeat(64),
    evidenceFingerprint: '1'.repeat(64),
    pairingFingerprint: null,
    openedAt: ISO,
    lastSeenAt: ISO,
    history: 'relationship_snapshot',
    candidates: [],
    verification: { verdict: 'new_position_removed', statusReason: 'new_position_removed', steps: {}, pairs: [], comparison: comparison(), demand: null, componentNewPositionCount: 0, ...verification },
    contentChanges: [],
    detail: null,
    pairPage: { index: 0, count: 1, size: 200, next: null },
    ...overrides,
  }
}

interface ServerState {
  holds: Array<Record<string, unknown>>
  status: string
  governed: string
  readable: boolean
  served: Record<string, number[]>
  /** Answer for the next POST (status + body), else success. */
  postAnswer?: { status: number; body: unknown } | null
  holdsAnswer?: { status: number; body: unknown } | null
  requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }>
}

function serverState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    holds: [candidateHold(), relationshipHold()],
    status: 'pending_confirmation',
    governed: 'pilot',
    readable: true,
    served: {},
    postAnswer: null,
    holdsAnswer: null,
    requests: [],
    ...overrides,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function receiptOf(state: ServerState): Record<string, unknown> {
  const holds: Record<string, unknown> = {}
  for (const hold of state.holds) {
    const page = hold.pairPage as { count: number }
    const served = state.served[String(hold.id)] ?? []
    holds[String(hold.id)] = { pageCount: page.count, pagesServed: served.slice().sort(), complete: served.length >= page.count }
  }
  return { id: RECEIPT_ID, expiresAt: ISO, holds }
}

function refreshRouter(state: ServerState) {
  return async (path: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    state.requests.push({ url: path, method, body })
    const url = new URL(path, 'https://api.example.test')
    if (url.pathname.endsWith('/refresh/holds') && method === 'GET') {
      if (state.holdsAnswer) return json(state.holdsAnswer.status, state.holdsAnswer.body)
      const holdId = url.searchParams.get('holdId')
      const pairCursor = Number(url.searchParams.get('pairCursor') ?? 0)
      let holds = state.holds
      if (holdId) {
        holds = state.holds.filter((hold) => hold.id === holdId).map((hold) => {
          const count = (hold.pairPage as { count: number }).count
          return { ...hold, pairPage: { index: pairCursor, count, size: 200, next: pairCursor + 1 < count ? pairCursor + 1 : null } }
        })
        state.served[holdId] = Array.from(new Set([...(state.served[holdId] ?? []), pairCursor]))
      } else {
        for (const hold of state.holds) state.served[String(hold.id)] = Array.from(new Set([...(state.served[String(hold.id)] ?? []), 0]))
      }
      return json(200, {
        ok: true,
        data: {
          refresh: { readable: state.readable, status: state.status, governed: state.governed, counts: { pendingConfirm: state.holds.length, confirmable: 2, openExecutions: 0, pendingReviews: 0, continuations: 1 }, pilot: state.governed === 'pilot' },
          holdSetFingerprint: '9'.repeat(64),
          decisionVersion: 3,
          page: { holds, next: null, limit: 20, pairLimit: 200 },
          readReceipt: state.status === 'not_governed' ? null : receiptOf(state),
        },
      })
    }
    if (url.pathname.includes('/evidence')) {
      return json(200, { ok: true, data: { holdId: 'hold_syn_cand', kind: 'continuation_candidate', status: 'open', current: { observations: [{ role: 'old_root', componentSourceId: SENTINEL }], completeness: { status: 'complete' } }, history: { status: 'history_unknown' }, next: null } })
    }
    if (url.pathname.includes('/continuations/cont_syn_1') && method === 'GET') {
      return json(200, { ok: true, data: { continuation: { id: 'cont_syn_1', status: 'needs_reconfirmation', revision: 2, statusReason: 'new_position_removed' }, members: [{ recordId: 'rec_syn_1' }], holds: [] } })
    }
    if (method === 'POST' && url.pathname.includes('/refresh/')) {
      if (state.postAnswer) {
        const answer = state.postAnswer
        state.postAnswer = null
        return json(answer.status, answer.body)
      }
      if (url.pathname.endsWith('/keep')) return json(200, { ok: true, data: { kept: true, holdId: 'hold_syn_cand' } })
      if (url.pathname.endsWith('/confirm')) {
        state.holds = state.holds.filter((hold) => hold.id !== body?.holdId)
        return json(201, { ok: true, data: { continuationId: 'cont_syn_2', revision: 1, state: 'confirmed_pending_execution', nextStep: 'preview_again' } })
      }
      if (url.pathname.endsWith('/end')) {
        state.holds = state.holds.filter((hold) => hold.id !== 'hold_syn_rel')
        return json(200, { ok: true, data: { continuationId: 'cont_syn_1', status: 'ended', endedOutcome: body?.outcome, nextStep: 'preview_again' } })
      }
    }
    return json(200, { ok: true, data: {} })
  }
}

// ---------------------------------------------------------------------------
// mounting
// ---------------------------------------------------------------------------

let app: VueApp | null = null
let container: HTMLDivElement | null = null

async function flush(turns = 8): Promise<void> {
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
  try { window.localStorage.clear() } catch { /* jsdom always has it */ }
  container = document.createElement('div')
  document.body.appendChild(container)
}

function teardown(): void {
  if (app) app.unmount()
  if (container) container.remove()
  app = null
  container = null
}

const emitted: Array<{ event: string; args: unknown[] }> = []

async function mountView(state: ServerState, projectNo = PROJECT): Promise<HTMLDivElement> {
  emitted.length = 0
  h.apiFetch.mockImplementation(refreshRouter(state))
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

function holdEl(root: HTMLElement, kind: string): HTMLElement {
  const el = root.querySelector(`[data-testid="stock-prep-refresh-hold"][data-hold-kind="${kind}"]`) as HTMLElement | null
  expect(el, `hold ${kind} renders`).not.toBeNull()
  return el!
}

function control(scope: HTMLElement, testid: string): HTMLButtonElement {
  const el = scope.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null
  expect(el, `${testid} renders`).not.toBeNull()
  return el!
}

async function click(el: HTMLElement): Promise<void> {
  el.click()
  await flush()
}

async function typeNo(scope: HTMLElement, value: string): Promise<void> {
  const input = scope.querySelector('[data-testid="stock-prep-refresh-typed-project-no"]') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush(2)
}

async function ack(scope: HTMLElement): Promise<void> {
  const box = scope.querySelector('[data-testid="stock-prep-refresh-history-ack"] input') as HTMLInputElement
  box.checked = true
  box.dispatchEvent(new Event('change'))
  await flush(2)
}

/** Every localStorage / sessionStorage entry, key and value, as one string (the polyfill does not spread). */
function storageDump(): string {
  const out: string[] = []
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null) out.push(`${key}=${storage.getItem(key)}`)
    }
  }
  return out.join('\n')
}

/** The server's closed allow-list, read out of the PLUGIN SOURCE (so a server change reds here). */
function serverAllowList(name: string): string[] {
  const match = HTTP_ROUTES_SOURCE.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  expect(match, `${name} in http-routes.cjs`).not.toBeNull()
  return [...match![1].matchAll(/'([A-Za-z]+)'/g)].map((entry) => entry[1])
}

// ---------------------------------------------------------------------------

describe('「拉取待确认」 — StockPreparationRefreshQueueView (RQ)', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('RQ-RENDER: 未选项目 / 未启用 / 读取失败 / 无待处理 / holds / refused are distinct', async () => {
    let root = await mountView(serverState(), '')
    expect(root.querySelector('[data-testid="stock-prep-refresh-queue"]')?.getAttribute('data-refresh-rendering')).toBe('no_project')
    expect(h.apiFetch).not.toHaveBeenCalled()
    teardown(); setup()

    root = await mountView(serverState({ status: 'not_governed', governed: 'none', holds: [] }))
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('not_governed')
    expect(root.querySelector('[data-testid="stock-prep-refresh-state"]')?.textContent).toContain('未启用')
    teardown(); setup()

    root = await mountView(serverState({ readable: false, status: 'unreadable', governed: 'unknown', holds: [] }))
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('unreadable')
    expect(root.querySelector('[data-testid="stock-prep-refresh-state"]')?.textContent).toContain('读取失败')
    teardown(); setup()

    root = await mountView(serverState({ holdsAnswer: { status: 503, body: { ok: false, error: { code: 'STOCK_PREP_REFRESH_STORE_FAILED', message: 'x', details: { store: 'hold', operation: 'read' } } } } }))
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('unreadable')
    expect(root.querySelector('[data-testid="stock-prep-refresh-error"]')?.textContent).toContain('稍后再试')
    teardown(); setup()

    root = await mountView(serverState({ status: 'complete', holds: [] }))
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('none_pending')
    expect(root.querySelector('[data-testid="stock-prep-refresh-state"]')?.textContent).toContain('无待处理')
    teardown(); setup()

    root = await mountView(serverState({ holdsAnswer: { status: 403, body: { ok: false, error: { code: 'OPERATOR_SCOPE_TENANT_REQUIRED', message: 'x' } } } }))
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('refused')
    teardown(); setup()

    root = await mountView(serverState())
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('holds')
    expect(root.querySelectorAll('[data-testid="stock-prep-refresh-hold"]').length).toBe(2)
  })

  it('RQ-PAGE: the receipt id rides later reads; confirm opens only after page 2 + ack + typed number', async () => {
    const state = serverState()
    const root = await mountView(state)
    const first = state.requests.find((request) => request.url.includes('/refresh/holds'))!
    expect(first.url).not.toContain('receipt=')
    const cand = holdEl(root, 'continuation_candidate')
    expect(cand.querySelector('[data-testid="stock-prep-refresh-pages"]')?.textContent).toContain('已看 1 / 2 页')
    await ack(cand)
    await typeNo(cand, PROJECT)
    expect(control(cand, 'stock-prep-refresh-confirm').disabled, 'page 1 of 2 only').toBe(true)
    await click(control(cand, 'stock-prep-refresh-next-pair-page'))
    const second = state.requests.filter((request) => request.url.includes('/refresh/holds')).pop()!
    expect(second.url).toContain(`receipt=${RECEIPT_ID}`)
    expect(second.url).toContain('holdId=hold_syn_cand')
    expect(second.url).toContain('pairCursor=1')
    const after = holdEl(root, 'continuation_candidate')
    expect(after.querySelector('[data-testid="stock-prep-refresh-pages"]')?.textContent).toContain('已看 2 / 2 页')
    expect(control(after, 'stock-prep-refresh-confirm').disabled).toBe(false)
  })

  it('RQ-BODY: the candidate confirm body is exactly the allow-listed keys; acknowledge for history_unknown; no workspaceId', async () => {
    expect([...STOCK_PREP_REFRESH_HOLDS_QUERY_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_HOLDS_QUERY_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_EVIDENCE_QUERY_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_EVIDENCE_QUERY_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_DETAIL_QUERY_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_DETAIL_QUERY_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_CONFIRM_REQUEST_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CONFIRM_REQUEST_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_KEEP_REQUEST_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_KEEP_REQUEST_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_END_REQUEST_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_END_REQUEST_KEYS').sort())

    const state = serverState()
    const root = await mountView(state)
    let cand = holdEl(root, 'continuation_candidate')
    await click(control(cand, 'stock-prep-refresh-next-pair-page'))
    cand = holdEl(root, 'continuation_candidate')
    await ack(cand)
    await typeNo(cand, PROJECT)
    await click(control(cand, 'stock-prep-refresh-confirm'))
    const post = state.requests.find((request) => request.method === 'POST' && request.url.endsWith('/continuations/confirm'))!
    expect(post, 'the confirm was sent').toBeDefined()
    expect(Object.keys(post.body!).sort()).toEqual(['acknowledge', 'basis', 'candidateId', 'comparisonFingerprint', 'confirmProjectNo', 'evidenceFingerprint', 'holdFingerprint', 'holdId', 'readReceipt', 'tenantId'])
    for (const key of Object.keys(post.body!)) expect(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CONFIRM_REQUEST_KEYS'), key).toContain(key)
    expect(post.body).toMatchObject({ confirmProjectNo: PROJECT, holdId: 'hold_syn_cand', candidateId: 'd'.repeat(64), readReceipt: RECEIPT_ID, acknowledge: { historyUnknown: true }, basis: { kind: 'puller_confirmed_same_demand' }, tenantId: SCOPE.tenantId })
    for (const request of state.requests) {
      expect(request.url, request.url).not.toContain('workspaceId')
      expect(JSON.stringify(request.body ?? {}), request.url).not.toContain('workspaceId')
    }
  })

  it('RQ-RECONF: a re-confirm needs the detail read and sends continuation { id, revision }', async () => {
    const state = serverState({ holds: [relationshipHold()] })
    const root = await mountView(state)
    const rel = holdEl(root, 'relationship_reconfirm')
    await typeNo(rel, PROJECT)
    expect(control(rel, 'stock-prep-refresh-confirm').disabled, 'no detail read yet').toBe(true)
    await click(control(rel, 'stock-prep-refresh-continuation'))
    const after = holdEl(root, 'relationship_reconfirm')
    expect(control(after, 'stock-prep-refresh-confirm').disabled).toBe(false)
    await click(control(after, 'stock-prep-refresh-confirm'))
    const post = state.requests.find((request) => request.method === 'POST' && request.url.endsWith('/continuations/confirm'))!
    expect(post.body).toMatchObject({ continuation: { id: 'cont_syn_1', revision: 2 }, holdId: 'hold_syn_rel' })
    expect(post.body).not.toHaveProperty('candidateId')
    expect(post.body).not.toHaveProperty('basis')
    expect(post.body).not.toHaveProperty('acknowledge')
  })

  it('RQ-END: release only for an integer count of 0 (both facts keys); null / absent offers none; escalate sends no facts keys', async () => {
    expect(releaseAdmissibleOnPage({ kind: 'relationship_reconfirm', runbookOnly: false, verification: { verdict: 'new_position_removed', statusReason: null, componentNewPositionCount: 0 } })).toBe(true)
    expect(releaseAdmissibleOnPage({ kind: 'relationship_reconfirm', runbookOnly: false, verification: { verdict: 'new_position_removed', statusReason: null, componentNewPositionCount: null } })).toBe(false)
    expect(releaseAdmissibleOnPage({ kind: 'relationship_reconfirm', runbookOnly: false, verification: { verdict: 'new_position_removed', statusReason: null } })).toBe(false)
    expect(releaseAdmissibleOnPage({ kind: 'relationship_reconfirm', runbookOnly: false, verification: { verdict: 'new_position_removed', statusReason: null, componentNewPositionCount: 1 } })).toBe(false)

    const state = serverState({ holds: [relationshipHold()] })
    const root = await mountView(state)
    let rel = holdEl(root, 'relationship_reconfirm')
    await click(control(rel, 'stock-prep-refresh-continuation'))
    rel = holdEl(root, 'relationship_reconfirm')
    const release = rel.querySelector('[data-testid="stock-prep-refresh-end-release"] input') as HTMLInputElement
    expect(release, 'release offered for count 0').not.toBeNull()
    release.checked = true
    release.dispatchEvent(new Event('change'))
    await typeNo(rel, PROJECT)
    await click(control(holdEl(root, 'relationship_reconfirm'), 'stock-prep-refresh-end'))
    const endPost = state.requests.find((request) => request.method === 'POST' && request.url.endsWith('/end'))!
    expect(endPost.body).toMatchObject({ outcome: 'release_to_normal_refresh', revision: 2, factsHoldId: 'hold_syn_rel', factsHoldFingerprint: 'e'.repeat(64), confirmProjectNo: PROJECT })
    teardown(); setup()

    for (const verification of [{ componentNewPositionCount: null }, { componentNewPositionCount: undefined }]) {
      const absent = serverState({ holds: [relationshipHold({}, verification)] })
      const absentRoot = await mountView(absent)
      const hold = holdEl(absentRoot, 'relationship_reconfirm')
      expect(hold.querySelector('[data-testid="stock-prep-refresh-end-release"]'), 'no release for no count').toBeNull()
      expect(hold.querySelector('[data-testid="stock-prep-refresh-end-no-release"]')?.textContent).toContain('没有记录新位置数')
      teardown(); setup()
    }

    const escalate = serverState({ holds: [relationshipHold({}, { verdict: 'structure_changed', componentNewPositionCount: 2 })] })
    const escRoot = await mountView(escalate)
    let esc = holdEl(escRoot, 'relationship_reconfirm')
    await click(control(esc, 'stock-prep-refresh-continuation'))
    esc = holdEl(escRoot, 'relationship_reconfirm')
    const radio = esc.querySelector('[data-testid="stock-prep-refresh-end-escalate"] input') as HTMLInputElement
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
    await flush(2)
    expect(holdEl(escRoot, 'relationship_reconfirm').querySelector('[data-testid="stock-prep-refresh-escalate-warning"]')?.textContent).toContain('运行手册')
    await typeNo(holdEl(escRoot, 'relationship_reconfirm'), PROJECT)
    await click(control(holdEl(escRoot, 'relationship_reconfirm'), 'stock-prep-refresh-end'))
    const escPost = escalate.requests.find((request) => request.method === 'POST' && request.url.endsWith('/end'))!
    expect(escPost.body).toMatchObject({ outcome: 'escalate_special_repair', revision: 2 })
    expect(escPost.body).not.toHaveProperty('factsHoldId')
    expect(escPost.body).not.toHaveProperty('factsHoldFingerprint')
  })

  it('RQ-KEEP: 「暂不处理」 echoes the fingerprint and auto-fills confirmProjectNo', async () => {
    const state = serverState()
    const root = await mountView(state)
    await click(control(holdEl(root, 'continuation_candidate'), 'stock-prep-refresh-keep'))
    const post = state.requests.find((request) => request.method === 'POST' && request.url.endsWith('/keep'))!
    expect(post.url).toContain('/holds/hold_syn_cand/keep')
    expect(post.body).toEqual({ tenantId: SCOPE.tenantId, confirmProjectNo: PROJECT, holdFingerprint: 'a'.repeat(64) })
    expect(root.querySelector('[data-testid="stock-prep-refresh-notice"]')?.textContent).toContain('暂不处理')
  })

  it('RQ-NEXT: a decision says 「必须重新试算」 and 「去重新试算」 opens 项目备料 on this project', async () => {
    const state = serverState({ holds: [relationshipHold()] })
    const root = await mountView(state)
    await click(control(holdEl(root, 'relationship_reconfirm'), 'stock-prep-refresh-continuation'))
    await typeNo(holdEl(root, 'relationship_reconfirm'), PROJECT)
    await click(control(holdEl(root, 'relationship_reconfirm'), 'stock-prep-refresh-confirm'))
    const banner = root.querySelector('[data-testid="stock-prep-refresh-preview-again"]') as HTMLElement
    expect(banner?.textContent).toContain('必须重新试算')
    expect(root.querySelector('[data-testid="stock-prep-refresh-rekey-note"]')?.textContent).toContain('重新对账')
    // The hold list was re-read after the decision.
    expect(state.requests.filter((request) => request.method === 'GET' && request.url.includes('/refresh/holds')).length).toBeGreaterThanOrEqual(2)
    await click(control(root, 'stock-prep-refresh-go-preview'))
    expect(emitted.filter((entry) => entry.event === 'navigate-stage').pop()?.args).toEqual(['project-board', PROJECT])
  })

  it('RQ-CHURN: 409 CONFIRM_STALE re-reads page 1 (same receipt) and says the item was updated', async () => {
    const state = serverState({ holds: [relationshipHold()] })
    const root = await mountView(state)
    await click(control(holdEl(root, 'relationship_reconfirm'), 'stock-prep-refresh-continuation'))
    await typeNo(holdEl(root, 'relationship_reconfirm'), PROJECT)
    state.postAnswer = { status: 409, body: { ok: false, error: { code: 'STOCK_PREP_CONTINUATION_CONFIRM_STALE', message: 'stale', details: { reason: 'fingerprint' } } } }
    const readsBefore = state.requests.filter((request) => request.method === 'GET' && request.url.includes('/refresh/holds')).length
    await click(control(holdEl(root, 'relationship_reconfirm'), 'stock-prep-refresh-confirm'))
    const reads = state.requests.filter((request) => request.method === 'GET' && request.url.includes('/refresh/holds'))
    expect(reads.length).toBe(readsBefore + 1)
    expect(reads[reads.length - 1].url).toContain(`receipt=${RECEIPT_ID}`)
    expect(root.querySelector('[data-testid="stock-prep-refresh-notice"]')?.textContent).toContain('这一项已经更新')
    expect(root.querySelector('[data-testid="stock-prep-refresh-error"] code')?.textContent).toBe('STOCK_PREP_CONTINUATION_CONFIRM_STALE')
  })

  it('RQ-O11: a protected (non-pilot) governed project shows the asymmetry', async () => {
    const root = await mountView(serverState({ governed: 'protected' }))
    expect(root.querySelector('[data-testid="stock-prep-refresh-asymmetry"]')?.textContent).toContain('数量和规格')
    teardown(); setup()
    const pilot = await mountView(serverState({ governed: 'pilot' }))
    expect(pilot.querySelector('[data-testid="stock-prep-refresh-asymmetry"]')).toBeNull()
  })

  it('RQ-VALUES: hold values never reach storage, an emit, the error banner or the copy payload', async () => {
    const state = serverState()
    const root = await mountView(state)
    // The values ARE shown on this PULL-tier page…
    expect(root.textContent).toContain(SENTINEL)
    await click(control(holdEl(root, 'continuation_candidate'), 'stock-prep-refresh-evidence'))
    expect(root.querySelector('[data-testid="stock-prep-refresh-evidence-result"]')?.textContent).toContain(SENTINEL)
    state.postAnswer = { status: 409, body: { ok: false, error: { code: 'STOCK_PREP_CONTINUATION_CONFIRM_NOT_ALLOWED', message: SENTINEL, details: { reason: SENTINEL } } } }
    await click(control(holdEl(root, 'continuation_candidate'), 'stock-prep-refresh-keep'))
    const banner = root.querySelector('[data-testid="stock-prep-refresh-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.textContent).not.toContain(SENTINEL)
    await click(control(root, 'stock-prep-refresh-error-copy'))
    expect(h.clipboard).toHaveBeenCalled()
    expect(JSON.stringify(h.clipboard.mock.calls)).not.toContain(SENTINEL)
    // …and nowhere else.
    expect(storageDump()).not.toContain(SENTINEL)
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL)
    expect(JSON.stringify(emitted)).not.toContain('a'.repeat(64))
  })
})

// ---------------------------------------------------------------------------
// RQ-ALIGN — presence = grant, through the real shell, per actor
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

describe('RQ-ALIGN — the six refresh controls render for exactly the actors the manifest grants', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('RQ-ALIGN: rendered refresh control ids == visibleStockPrepControls ∩ six, both directions, every actor', async () => {
    // The manifest assigns all six (PR-4 left them null).
    for (const id of REFRESH_CONTROLS) {
      expect(STOCK_PREP_WORKBENCH_CAPABILITIES.some((capability) => capability.control === id), id).toBe(true)
    }
    for (const actor of ALIGN_ACTORS) {
      teardown(); setup()
      h.permissions = actor.permissions
      h.roles = actor.roles
      h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
      h.apiFetch.mockImplementation(refreshRouter(serverState()))
      app = createApp(StockPreparationWorkspace as Component)
      app.mount(container!)
      await flush(12)
      const rendered = REFRESH_CONTROLS.filter((id) => container!.querySelector(`[data-testid="${id}"]`) !== null)
      const granted = visibleStockPrepControls({ roles: actor.roles, permissions: actor.permissions }).filter((id) => REFRESH_CONTROLS.includes(id))
      expect(rendered.sort(), actor.name).toEqual(granted.sort())
      // The tab itself follows the same grant.
      expect(container!.querySelector('[data-testid="stock-prep-tab-refresh-queue"]') !== null, `${actor.name} tab`).toBe(granted.length > 0)
    }
  })

  it('RQ-RAIL: the rail count shows the open project\'s holds to a puller only', async () => {
    h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
    h.apiFetch.mockImplementation(refreshRouter(serverState()))
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush(12)
    expect(container!.querySelector('[data-testid="stock-prep-rail-count-refresh-queue"]')?.textContent?.trim()).toBe('2')
    expect(container!.querySelector('[data-testid="stock-prep-rail-count-refresh-queue"]')?.getAttribute('aria-hidden')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// PB-RS — 项目备料页 consumes the stanza
// ---------------------------------------------------------------------------

function boardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: SCOPE.tenantId,
    projectId: null,
    projectNo: PROJECT,
    projectName: null,
    projectStatus: 'active',
    lastSyncRunId: null,
    snapshotBatchCount: 0,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 0,
    archivedSnapshotPresent: false,
    pullTargetReady: true,
    pulledRowCount: 12,
    activePulledRowCount: 12,
    pulledRowCountBounded: false,
    lastChangedFromPlmAt: null,
    lastChangedFromPlmBounded: false,
    pendingDecisionCount: 0,
    lastExportAt: null,
    fillTarget: null,
    directoryReady: true,
    ledgerReady: true,
    ...overrides,
  }
}

function stanza(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { readable: status !== 'unreadable', status, statusLabel: 'x', governed: status === 'not_governed' ? 'none' : 'pilot', exportAllowed: status === 'complete' || status === 'not_governed', settled: false, counts: { pendingConfirm: 3, confirmable: 1, openExecutions: 0, pendingReviews: 0, continuations: 1 }, ...extra }
}

function boardSyncApi(): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 0, update: 0, skip: 3, inactive: 0, manual_confirm: 0 } }),
    reconcile: vi.fn().mockResolvedValue({ counts: { pending: 0 } }),
    apply: vi.fn().mockResolvedValue({ status: 'succeeded', apply: { counts: { created: 0, updated: 0, inactive: 0, skipped: 3, held: 0, failed: 0 } } }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 3, run: 1 } }),
  } as StockPreparationProjectSyncApi
}

async function mountBoard(options: { board?: () => Response; exportAnswer?: () => Response } = {}): Promise<HTMLDivElement> {
  emitted.length = 0
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) return json(200, { ok: true, data: { tenantId: SCOPE.tenantId, directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] } })
    if (path.includes('/prep-lines/export')) return options.exportAnswer ? options.exportAnswer() : json(500, { ok: false })
    if (path.includes('/board')) return options.board ? options.board() : json(200, { ok: true, data: boardPayload() })
    if (path.includes('/handoff')) return new Response('', { status: 404 })
    return json(200, { ok: true, data: {} })
  })
  app = createApp(StockPreparationProjectBoardView as Component, {
    scope: SCOPE,
    projectNo: PROJECT,
    syncApi: boardSyncApi(),
    onNavigateStage: (...args: unknown[]) => emitted.push({ event: 'navigate-stage', args }),
    onRefreshChanged: (...args: unknown[]) => emitted.push({ event: 'refresh-changed', args }),
  })
  app.mount(container!)
  await flush(10)
  return container!
}

function boardWith(refresh: unknown, overrides: Record<string, unknown> = {}): () => Response {
  return () => json(200, { ok: true, data: boardPayload({ ...(refresh === undefined ? {} : { refresh }), ...overrides }) })
}

describe('PB-RS — 项目备料页 and the refresh stanza', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('PB-RS-1/2: an absent stanza and a not_governed one render the page as before (no banner, same posture)', async () => {
    let root = await mountBoard({ board: boardWith(undefined) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]')).toBeNull()
    const absentPosture = root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent
    const absentNext = root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.getAttribute('data-next-step')
    teardown(); setup()
    root = await mountBoard({ board: boardWith(stanza('not_governed', { settled: false })) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent).toBe(absentPosture)
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.getAttribute('data-next-step')).toBe(absentNext)
    expect(absentPosture).toContain('可以导出')
  })

  it('PB-RS-3: holds go to the banner; 「等您拿主意」 counts the ledger part only', async () => {
    let root = await mountBoard({ board: boardWith(stanza('pending_confirmation'), { pendingDecisionCount: 5 }) })
    const banner = root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]') as HTMLElement
    expect(banner.textContent).toContain('本项目有 3 项待拉取人员确认')
    expect(banner.getAttribute('data-refresh-status')).toBe('pending_confirmation')
    expect(root.querySelector('[data-testid="stock-prep-project-board-pending"]')?.textContent).toContain('2 件事')
    expect(root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent).toContain('等您拿主意 2 件')
    // Rule 3 of the 下一步 bar reads the LEDGER part too (never the union).
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.getAttribute('data-next-step')).toBe('pending')
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.textContent).toContain('有 2 件')
    teardown(); setup()
    root = await mountBoard({ board: boardWith(stanza('pending_confirmation'), { pendingDecisionCount: 3 }) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-pending"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent).toContain('待确认 3 件')
  })

  it('PB-RS-4: a puller gets the link and the next-step action; a floor operator neither', async () => {
    let root = await mountBoard({ board: boardWith(stanza('pending_confirmation')) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-open-queue"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.getAttribute('data-next-step')).toBe('refresh')
    await click(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]') as HTMLElement)
    expect(emitted.filter((entry) => entry.event === 'navigate-stage').pop()?.args).toEqual(['refresh-queue'])
    teardown(); setup()
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    root = await mountBoard({ board: boardWith(stanza('pending_confirmation')) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-open-queue"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')?.textContent).toContain('请联系拉取人员')
  })

  it('PB-RS-5: complete + exportAllowed + NOT settled is 「待核对」, never 「可以导出」 (#6566 review N5)', async () => {
    const root = await mountBoard({ board: boardWith(stanza('complete', { exportAllowed: true, settled: false, counts: { pendingConfirm: 0 } })) })
    const posture = root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent ?? ''
    expect(posture).toContain('待核对')
    expect(posture).not.toContain('可以导出')
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]')?.getAttribute('data-refresh-status')).toBe('unsettled')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-check"]'), 'the puller is offered 「核对」').not.toBeNull()
  })

  it('PB-RS-6: unreadable ⇒ 读取失败 banner and posture', async () => {
    const root = await mountBoard({ board: boardWith({ readable: false, status: 'unreadable', statusLabel: '状态读取失败', governed: 'unknown', exportAllowed: false, settled: false, counts: null, unreadable: { reason: 'store_read_failed', store: 'continuation' } }) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-refresh-banner"]')?.textContent).toContain('读取失败')
    expect(root.querySelector('[data-testid="stock-prep-project-board-posture"]')?.textContent).toContain('状态读取失败')
  })

  it('PB-RS-7: the export refusal reads by its reason (lease_in_flight ≠ not_settled)', async () => {
    const texts: string[] = []
    for (const reason of ['lease_in_flight', 'not_settled']) {
      teardown(); setup()
      const root = await mountBoard({
        board: boardWith(stanza('not_governed')),
        exportAnswer: () => json(409, { ok: false, error: { code: 'STOCK_PREP_EXPORT_BLOCKED', message: 'x', details: { reason, status: 'not_governed', partial: false } } }),
      })
      const button = root.querySelector('[data-testid="stock-prep-project-board-export"]') as HTMLButtonElement
      expect(button, 'export renders').not.toBeNull()
      await click(button)
      const error = root.querySelector('[data-testid="stock-prep-project-board-error"]') as HTMLElement
      expect(error, reason).not.toBeNull()
      texts.push(error.textContent ?? '')
    }
    expect(texts[0]).toContain('占着写入')
    expect(texts[1]).toContain('还没有核对过')
    expect(texts[0]).not.toBe(texts[1])
  })

  it('PB-RS-8: the board records blocked_pull_state in this browser\'s memory', async () => {
    await mountBoard({ board: boardWith(stanza('pending_confirmation')) })
    // Also the positive control for `storageDump` (RQ-VALUES reads storage through it).
    expect(storageDump()).toContain('blocked_pull_state')
  })

  it('PB-RS-9: the board read\'s own 409 RETARGETED reads as the board\'s refusal, not the generic read sentence', async () => {
    const root = await mountBoard({ board: () => json(409, { ok: false, error: { code: 'STOCK_PREP_REFRESH_TARGET_RETARGETED', message: 'x', details: {} } }) })
    expect(root.querySelector('[data-testid="stock-prep-project-board-error"]')?.textContent).toContain('另一张备料表')
  })

  it('PB-RS-10: the board emits its values-free stanza for the rail count', async () => {
    await mountBoard({ board: boardWith(stanza('pending_confirmation')) })
    const last = emitted.filter((entry) => entry.event === 'refresh-changed').pop()
    expect((last?.args[0] as { counts?: { pendingConfirm?: number } } | null)?.counts?.pendingConfirm).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// SP — the sync panel
// ---------------------------------------------------------------------------

function panelApi(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 0, update: 0, skip: 3, inactive: 0, manual_confirm: 0 } }),
    reconcile: vi.fn().mockResolvedValue({ counts: { pending: 0 } }),
    apply: vi.fn().mockResolvedValue({ status: 'succeeded', apply: { counts: { created: 0, updated: 0, inactive: 0, skipped: 3, held: 0, failed: 0 } } }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 3, run: 1 } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

const panelProps = reactive<Record<string, unknown>>({})

function mountPanel(props: Record<string, unknown>): HTMLDivElement {
  emitted.length = 0
  for (const key of Object.keys(panelProps)) delete panelProps[key]
  Object.assign(panelProps, { projectNo: PROJECT, ...props })
  const Host = defineComponent({
    setup() {
      return () => vh(StockPreparationProjectSyncPanel as Component, {
        ...panelProps,
        onNavigateStage: (...args: unknown[]) => emitted.push({ event: 'navigate-stage', args }),
        onSynced: (...args: unknown[]) => emitted.push({ event: 'synced', args }),
      })
    },
  })
  app = createApp(Host)
  app.mount(container!)
  return container!
}

async function runPanel(root: HTMLElement): Promise<void> {
  await click(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLElement)
}

describe('SP — the sync panel learns the batch refresh', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('SP-SUS-1: a suspended run says so with its count; the 拉取待确认 link is PULL-only; never the ledger queue link', async () => {
    const suspended = panelApi({ dryRun: vi.fn().mockResolvedValue({ status: 'suspended', canApply: false, dryRunToken: null, counts: { add: 0, update: 0, skip: 2, inactive: 0, manual_confirm: 2 }, refreshHold: { held: true, holdCount: 2, confirmableCount: 1, kinds: {} } }) })
    let root = mountPanel({ api: suspended, canOpenRefreshQueue: true })
    await flush(2)
    await runPanel(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')?.getAttribute('data-verdict')).toBe('suspended')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict-count"]')?.textContent).toContain('2 项待拉取人员确认')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-queue"]'), 'never the ledger queue link').toBeNull()
    await click(root.querySelector('[data-testid="stock-prep-project-sync-open-refresh-queue"]') as HTMLElement)
    expect(emitted.filter((entry) => entry.event === 'navigate-stage').pop()?.args).toEqual(['refresh-queue'])
    expect(suspended.apply).not.toHaveBeenCalled()
    teardown(); setup()
    root = mountPanel({ api: panelApi({ dryRun: suspended.dryRun }), canOpenRefreshQueue: false })
    await flush(2)
    await runPanel(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-refresh-queue"]')).toBeNull()
  })

  it('SP-REC-1: awaiting recovery names the platform admin, not the source', async () => {
    const root = mountPanel({ api: panelApi({ dryRun: vi.fn().mockResolvedValue({ status: 'recovery_pending', canApply: false, dryRunToken: null, counts: {}, refreshRecovery: { pending: true, openExecutions: 1 } }) }) })
    await flush(2)
    await runPanel(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('awaiting_recovery')
    expect(verdict.textContent).toContain('平台管理员')
    expect(verdict.textContent).not.toContain('源数据')
  })

  it('SP-CHK-1: 「核对」 only for a puller with a written-not-checked project; one dry run; 「核对通过」 only after the board says so', async () => {
    const api = panelApi()
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    let root = mountPanel({ api, refreshStatus: 'executed_pending_settlement', refreshSettled: false })
    await flush(2)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-check"]'), 'absent for a floor operator').toBeNull()
    teardown(); setup()
    root = mountPanel({ api, refreshStatus: 'not_governed', refreshSettled: false })
    await flush(2)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-check"]'), 'absent when not governed').toBeNull()
    teardown(); setup()
    root = mountPanel({ api, refreshStatus: 'executed_pending_settlement', refreshSettled: false })
    await flush(2)
    await click(root.querySelector('[data-testid="stock-prep-project-sync-check"]') as HTMLElement)
    expect(api.dryRun).toHaveBeenCalledTimes(1)
    expect(api.reconcile).not.toHaveBeenCalled()
    expect(api.apply).not.toHaveBeenCalled()
    expect(api.archive).not.toHaveBeenCalled()
    expect(emitted.filter((entry) => entry.event === 'synced').pop()?.args).toEqual([null])
    const line = () => root.querySelector('[data-testid="stock-prep-project-sync-check-result"]') as HTMLElement
    expect(line().getAttribute('data-check')).toBe('settled')
    expect(line().textContent).toContain('核对已提交')
    expect(line().textContent).not.toContain('核对通过')
    expect(line().textContent).not.toContain('已完成')
    // The board re-read still says executed_pending_settlement: nothing moves, the line stays 「核对已提交」.
    panelProps.refreshStatus = 'executed_pending_settlement'
    await flush(2)
    expect(line().textContent).not.toContain('核对通过')
    // A re-read that moved but is complete ∧ NOT settled is still not 「核对通过」 (and never 「已完成」).
    panelProps.refreshStatus = 'complete'
    panelProps.refreshSettled = false
    await flush(2)
    expect(line().getAttribute('data-check-phase')).toBe('answered')
    expect(line().textContent).not.toContain('核对通过')
    expect(line().textContent).not.toContain('已完成')
    // The board re-read answers complete ∧ settled — only now.
    panelProps.refreshSettled = true
    await flush(2)
    expect(line().textContent).toContain('核对通过')
  })
})
