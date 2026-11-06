import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h as vh, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// 备料分批拉取第一期 step 5 PR-9 (design §10.3, §13, §17 PR-9 row; register R-77) — 「拉取待确认」's 「变更计划」 and
// 「变更复核」 sections (StockPreparationRefreshChangePlan.vue) and the client they are built from (refreshChangePlan.ts).
//
//   CP-DORMANT   not_governed / unreadable / a governed project with only candidate or relationship holds read NO change
//                plan; a bad answer ({}, 404, 501) is never "nothing to do" — one state line, no confirm, no review.
//   CP-RENDER    the sections per state; the review_pending rendering; root / continuation / earlier-write / human
//                presence words; field labels (a pack column reads 「其他列」 with its id apart).
//   CP-BODY      the confirm body ⊆ the server's allow-list (parsed out of http-routes.cjs); every echo from the
//                proposal verbatim (an id on an unloaded later hold page included); the page's receipt; the typed
//                number trimmed; tenantId only when non-blank; never workspaceId.
//   CP-CONTRACT  the web-built bodies pass the plugin's REAL body normalizers; the store's control-character rule is
//                source-pinned and the web helper driven over every code point it refuses; the mirrored constants.
//   CP-RECEIPT   the confirm waits for every named hold complete on the receipt (pair page 2; a hold read via
//                「更多待确认项」); one receipt id rides every holds and plan read; pages_missing shows its words.
//   CP-ACK / CP-TYPED / CP-CMB / CP-BLOCKED / CP-XCHECK / CP-CHURN / CP-NEXT
//   RV-RECEIPT / RV-BODY / RV-DIGEST / RV-NOTES / RV-BLOCKED / RV-SELF / RV-PERMISSION / RV-NEXT
//   CP-VALUES    values on the page, never in storage, an emit, the error banner, the clipboard or any console call.
//   CP-ALIGN     through the REAL shell, per actor: the three change-plan control ids rendered == the manifest grant ∩ three.
//   CP-RAIL      the rail badge = holds + reviews for a puller; none for the floor.

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
  STOCK_PREP_CHANGE_PLAN_BASIS_NOTE_MAX_LENGTH,
  STOCK_PREP_CHANGE_PLAN_RECORD_PAGE_DEFAULT,
  STOCK_PREP_CHANGE_REVIEW_CONCLUSIONS,
  STOCK_PREP_CHANGE_REVIEW_NOTES_MAX_LENGTH,
  STOCK_PREP_CONTENT_CLASS_HOLD_KINDS,
  STOCK_PREP_REFRESH_CHANGE_PLAN_CONFIRM_KEYS,
  STOCK_PREP_REFRESH_CHANGE_PLAN_QUERY_KEYS,
  STOCK_PREP_REFRESH_CHANGE_REVIEW_KEYS,
  buildChangePlanConfirmBody,
  buildChangeReviewBody,
  stockPrepReviewNotesProblem,
  type StockPrepChangePlanPage,
} from '../src/services/integration/stockPreparation/refreshChangePlan'
import type { StockPrepRefreshReceipt } from '../src/services/integration/stockPreparation/refreshQueue'
import { STOCK_PREP_REFRESH_CHANGE_PLAN_BLOCKED_PLAIN } from '../src/services/integration/stockPreparation/plainLanguage'
import { STOCK_PREP_WORKBENCH_CAPABILITIES, visibleStockPrepControls } from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const nodeRequire = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../plugins/plugin-integration-core/lib/'
const HTTP_ROUTES_SOURCE = readFileSync(resolve(REPO_ROOT, 'plugins/plugin-integration-core/lib/http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
const decisions = nodeRequire(`${PLUGIN_LIB}stock-preparation-refresh-decisions.cjs`) as {
  RECORD_PAGE_LIMIT_DEFAULT: number
  __internals: { normalizeChangePlanConfirmBody: (body: unknown) => unknown; normalizeReviewBody: (body: unknown) => unknown }
}
const store = nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-store.cjs`) as {
  REVIEW_CONCLUSIONS: readonly string[]
  REVIEW_NOTES_MAX_LENGTH: number
  BASIS_NOTE_MAX_LENGTH: number
}
const pairing = nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-pairing.cjs`) as { CONTENT_CLASS_HOLD_KINDS: readonly string[] }

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'SYN-PROJ-0001'
const SENTINEL = 'SYN-CELL-SENTINEL'
const RECEIPT_ID = 'fedcba9876543210fedcba9876543210'
const ISO = '2026-11-06T00:00:00.000Z'
const HOLD_SET = '9'.repeat(64)
const PLAN_FP = 'a'.repeat(64)
const SOURCE_DIGEST = 'b'.repeat(64)
const WRITTEN_DIGEST = 'c'.repeat(64)
const PLAN_CONTROLS = ['stock-prep-refresh-change-plan', 'stock-prep-refresh-change-plan-confirm', 'stock-prep-refresh-change-review-complete']

// ---------------------------------------------------------------------------
// the synthetic server (decisions.cjs `listHolds` / `readChangePlanCurrent` / `confirmChangePlan` /
// `completeChangeReview` shapes, key for key; every value synthetic)
// ---------------------------------------------------------------------------

function contentHold(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hold_syn_c1',
    kind: 'content_change',
    status: 'open',
    confirmable: false,
    notConfirmableReason: 'needs_step5',
    shapeToken: null,
    runbookOnly: false,
    continuationId: null,
    fingerprint: '1'.repeat(64),
    comparisonFingerprint: null,
    evidenceFingerprint: null,
    pairingFingerprint: null,
    openedAt: ISO,
    lastSeenAt: ISO,
    history: 'history_unknown',
    candidates: [],
    verification: null,
    contentChanges: [{ recordId: 'rec_syn_1', recordVersion: 3, key: 'SYN-KEY-1', reason: 'plm_system_refresh', fields: { totalQuantity: { before: 1, after: 2 } }, inContinuation: null, humanColumnsPresent: { procurementReply: true } }],
    detail: null,
    pairPage: { index: 0, count: 1, size: 200, next: null },
    ...overrides,
  }
}

function relationshipContentHold(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return contentHold({ id: 'hold_syn_c2', kind: 'relationship_content_change', continuationId: 'cont_syn_1', fingerprint: '2'.repeat(64), contentChanges: [], pairPage: { index: 0, count: 2, size: 200, next: 1 }, ...overrides })
}

function candidateHold(): Record<string, unknown> {
  return contentHold({ id: 'hold_syn_cand', kind: 'continuation_candidate', confirmable: true, notConfirmableReason: null, contentChanges: [], comparisonFingerprint: 'e'.repeat(64), evidenceFingerprint: 'f'.repeat(64), pairingFingerprint: 'd'.repeat(64), candidates: [{ candidateId: 'd'.repeat(64), pairs: [], comparison: null, history: 'history_unknown' }] })
}

function planRecord(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: `rec_syn_${index}`,
    key: `SYN-KEY-${index}`,
    root: index === 1,
    inContinuation: index === 2 ? { continuationId: 'cont_syn_1' } : null,
    present: true,
    humanColumnsPresent: { procurementReply: true, notes: false },
    fields: {
      totalQuantity: { baseline: 1, before: 1, after: 2, reviewOnly: false, current: 2 },
      ext_syn_pack_column: { baseline: SENTINEL, before: SENTINEL, after: `${SENTINEL}-NEW`, reviewOnly: index === 2, current: `${SENTINEL}-NEW` },
    },
    ...overrides,
  }
}

interface ServerState {
  holds: Array<Record<string, unknown>>
  /** Holds per page (all on one page when absent). */
  holdsPageSize?: number
  status: string
  governed: string
  readable: boolean
  pilot: boolean
  holdSetFingerprint: string
  served: Record<string, number[]>
  /** The proposal — `null` makes the change-plan route answer `{}` (the fail-closed case). */
  proposal: Record<string, unknown> | null
  proposalRecords: Array<Record<string, unknown>>
  confirmed: Record<string, unknown> | null
  written: Record<string, unknown> | null
  writtenRecords: Array<Record<string, unknown>>
  /** The written plan's CURRENT digest per read (index = read count); the last one repeats. */
  writtenDigests: string[]
  recordPageSize: number
  writtenReads: number
  planAnswer: { status: number; body: unknown } | null
  postAnswer: { status: number; body: unknown } | null
  pendingReviews: number
  requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }>
}

function serverState(overrides: Partial<ServerState> = {}): ServerState {
  const holds = overrides.holds ?? [contentHold()]
  const contentIds = holds.filter((hold) => pairing.CONTENT_CLASS_HOLD_KINDS.includes(String(hold.kind))).map((hold) => String(hold.id)).sort()
  return {
    holds,
    status: 'pending_confirmation',
    governed: 'pilot',
    readable: true,
    pilot: true,
    holdSetFingerprint: HOLD_SET,
    served: {},
    proposal: {
      blocked: null,
      holdIds: contentIds,
      holdSetFingerprint: HOLD_SET,
      planFingerprint: PLAN_FP,
      sourceContentDigest: SOURCE_DIGEST,
      recordCount: 1,
      structureHoldOpen: false,
      runbookHoldOpen: false,
      candidates: [],
    },
    proposalRecords: [{ recordId: 'rec_syn_1', key: 'SYN-KEY-1', root: true, inContinuation: null, fields: { totalQuantity: { before: 1, after: 2 }, ext_syn_pack_column: { before: SENTINEL, after: `${SENTINEL}-NEW` } }, present: true, humanColumnsPresent: { procurementReply: true, notes: false } }],
    confirmed: null,
    written: null,
    writtenRecords: [],
    writtenDigests: [WRITTEN_DIGEST],
    recordPageSize: STOCK_PREP_CHANGE_PLAN_RECORD_PAGE_DEFAULT,
    writtenReads: 0,
    planAnswer: null,
    postAnswer: null,
    pendingReviews: 0,
    requests: [],
    ...overrides,
  }
}

/** A written plan awaiting review: two record pages (page size 1), confirmed by this actor. */
function reviewState(overrides: Partial<ServerState> = {}): ServerState {
  return serverState({
    holds: [],
    status: 'change_pending_review',
    pendingReviews: 1,
    proposal: { blocked: 'no_content_hold', holdIds: [], holdSetFingerprint: HOLD_SET, planFingerprint: null, sourceContentDigest: SOURCE_DIGEST, recordCount: 0, structureHoldOpen: false, runbookHoldOpen: false, candidates: [] },
    proposalRecords: [],
    written: { id: 'plan_syn_w', status: 'written', recordCount: 2, writeRecordCount: 2, planFingerprint: PLAN_FP, reviewBaselineDigest: null, absorbedChangePlanIds: ['plan_syn_old'], confirmedAt: ISO, confirmedBySelf: true, writtenAt: ISO, writtenContentDigest: WRITTEN_DIGEST },
    writtenRecords: [planRecord(1), planRecord(2)],
    recordPageSize: 1,
    ...overrides,
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function receiptOf(state: ServerState): Record<string, unknown> {
  const holds: Record<string, unknown> = {}
  for (const [id, served] of Object.entries(state.served)) {
    const hold = state.holds.find((entry) => entry.id === id)
    const count = hold ? (hold.pairPage as { count: number }).count : (id === state.written?.id ? Math.max(1, Math.ceil(state.writtenRecords.length / state.recordPageSize)) : 1)
    holds[id] = { pageCount: count, pagesServed: served.slice().sort(), complete: served.length >= count }
  }
  return { id: RECEIPT_ID, expiresAt: ISO, holds }
}

function serve(state: ServerState, id: string, index: number): void {
  state.served[id] = Array.from(new Set([...(state.served[id] ?? []), index]))
}

function page<T>(list: T[], cursor: number, size: number): { slice: T[]; page: { index: number; count: number; size: number; next: number | null } } {
  const count = Math.max(1, Math.ceil(list.length / size))
  return { slice: cursor < count ? list.slice(cursor * size, cursor * size + size) : [], page: { index: cursor, count, size, next: cursor + 1 < count ? cursor + 1 : null } }
}

function summaryOf(state: ServerState): Record<string, unknown> {
  return {
    readable: state.readable,
    status: state.status,
    governed: state.governed,
    counts: { pendingConfirm: state.holds.length, confirmable: 0, openExecutions: 0, pendingReviews: state.pendingReviews, continuations: 0 },
    pilot: state.pilot,
    holdSetFingerprint: state.holdSetFingerprint,
    decisionVersion: 4,
  }
}

function router(state: ServerState) {
  return async (path: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    state.requests.push({ url: path, method, body })
    const url = new URL(path, 'https://api.example.test')
    // The change-plan routes FIRST: `…/change-plans/confirm` would otherwise read as a generic `/confirm`.
    if (url.pathname.includes('/refresh/change-plans/') || url.pathname.includes('/refresh/change-reviews/')) {
      if (method === 'POST') {
        const pathProject = decodeURIComponent(url.pathname.split('/projects/')[1]?.split('/')[0] ?? '')
        const typed = typeof body?.confirmProjectNo === 'string' ? body.confirmProjectNo.trim() : ''
        if (typed !== pathProject) return json(400, { ok: false, error: { code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID', message: 'x', details: { field: 'confirmProjectNo' } } })
        if (state.postAnswer) {
          const answer = state.postAnswer
          state.postAnswer = null
          return json(answer.status, answer.body)
        }
        if (url.pathname.endsWith('/change-plans/confirm')) {
          const ids = new Set(Array.isArray(body?.holdIds) ? body!.holdIds as string[] : [])
          state.holds = state.holds.filter((hold) => !ids.has(String(hold.id)))
          state.confirmed = { id: 'plan_syn_c', status: 'confirmed', recordCount: 1, writeRecordCount: 1, planFingerprint: PLAN_FP, reviewBaselineDigest: null, absorbedChangePlanIds: [], confirmedAt: ISO, confirmedBySelf: true, writtenAt: null, writtenContentDigest: null }
          state.status = 'confirmed_pending_execution'
          if (state.proposal) state.proposal = { ...state.proposal, holdIds: [], blocked: 'no_content_hold', planFingerprint: null, recordCount: 0 }
          state.proposalRecords = []
          return json(201, { ok: true, data: { changePlanId: 'plan_syn_c', recordCount: 1, holdCount: ids.size, continuationIds: [], decisionVersion: 5, generation: 7, state: 'confirmed_pending_execution', nextStep: 'preview_again' } })
        }
        if (url.pathname.endsWith('/change-reviews/complete')) {
          state.written = null
          state.writtenRecords = []
          state.pendingReviews = 0
          state.status = 'executed_pending_settlement'
          return json(200, { ok: true, data: { changePlanId: body?.changePlanId, status: 'reviewed', recordCount: 2, reviewedContentDigest: WRITTEN_DIGEST, decisionVersion: 6, nextStep: 'preview_again' } })
        }
      }
      if (method === 'GET' && url.pathname.endsWith('/change-plans/current')) {
        if (state.planAnswer) return json(state.planAnswer.status, state.planAnswer.body)
        if (!state.proposal) return json(200, { ok: true, data: {} })
        const cursor = Number(url.searchParams.get('recordCursor') ?? 0)
        const size = state.recordPageSize
        const proposalPage = page(state.proposalRecords, cursor, size)
        let written: Record<string, unknown> | null = null
        if (state.written) {
          const digest = state.writtenDigests[Math.min(state.writtenReads, state.writtenDigests.length - 1)]
          state.writtenReads += 1
          const writtenPage = page(state.writtenRecords, cursor, size)
          if (cursor < writtenPage.page.count) serve(state, String(state.written.id), cursor)
          written = { ...state.written, currentContentDigest: digest, contentMatchesWrite: digest === state.written.writtenContentDigest, recordPage: writtenPage.page, records: writtenPage.slice }
        }
        const confirmed = state.confirmed ? { ...state.confirmed, recordPage: page([], cursor, size).page, records: [] } : null
        return json(200, {
          ok: true,
          data: {
            refresh: summaryOf(state),
            proposal: { ...state.proposal, recordPage: proposalPage.page, records: proposalPage.slice },
            current: { confirmed, written },
            readReceipt: state.status === 'not_governed' || !state.written ? null : receiptOf(state),
          },
        })
      }
      return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'x' } })
    }
    if (url.pathname.endsWith('/refresh/holds') && method === 'GET') {
      const holdId = url.searchParams.get('holdId')
      const pairCursor = Number(url.searchParams.get('pairCursor') ?? 0)
      let holds = state.holds
      let next: string | null = null
      if (holdId) {
        holds = state.holds.filter((hold) => hold.id === holdId).map((hold) => {
          const count = (hold.pairPage as { count: number }).count
          return { ...hold, pairPage: { index: pairCursor, count, size: 200, next: pairCursor + 1 < count ? pairCursor + 1 : null } }
        })
        serve(state, holdId, pairCursor)
      } else {
        const cursor = url.searchParams.get('cursor')
        const start = cursor ? state.holds.findIndex((hold) => hold.id === cursor) + 1 : 0
        const size = state.holdsPageSize ?? state.holds.length
        holds = state.holds.slice(start, start + size)
        next = start + size < state.holds.length ? String(holds[holds.length - 1].id) : null
        for (const hold of holds) serve(state, String(hold.id), 0)
      }
      const summary = summaryOf(state)
      return json(200, {
        ok: true,
        data: {
          refresh: summary,
          holdSetFingerprint: state.holdSetFingerprint,
          decisionVersion: 4,
          page: { holds, next, limit: 20, pairLimit: 200 },
          readReceipt: state.status === 'not_governed' ? null : receiptOf(state),
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

function planReads(state: ServerState): Array<{ url: string }> {
  return state.requests.filter((request) => request.method === 'GET' && request.url.includes('/change-plans/current'))
}

function holdReads(state: ServerState): Array<{ url: string }> {
  return state.requests.filter((request) => request.method === 'GET' && request.url.includes('/refresh/holds'))
}

function posts(state: ServerState, suffix: string): Array<{ url: string; body: Record<string, unknown> | null }> {
  return state.requests.filter((request) => request.method === 'POST' && request.url.endsWith(suffix))
}

/** The server's closed allow-list, read out of the PLUGIN SOURCE (so a server change reds here). */
function serverAllowList(name: string): string[] {
  const match = HTTP_ROUTES_SOURCE.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  expect(match, `${name} in http-routes.cjs`).not.toBeNull()
  return [...match![1].matchAll(/'([A-Za-z]+)'/g)].map((entry) => entry[1])
}

/** Ready the confirm: ack + typed number (every named hold is already complete on page 1 for a single content hold). */
async function readyConfirm(root: HTMLElement, typed = PROJECT): Promise<void> {
  await tick(root, '[data-testid="stock-prep-refresh-change-plan-ack"] input')
  await typeInto(root, 'stock-prep-refresh-change-plan-typed-project-no', typed)
}

/** Ready the review: walk to page 2 (recordPage.next), choose a conclusion, type the number. */
async function readyReview(root: HTMLElement, options: { conclusion?: 'handled' | 'handled_with_notes'; notes?: string; walk?: boolean } = {}): Promise<void> {
  if (options.walk !== false) await click(control(root, 'stock-prep-refresh-change-review-next'))
  await tick(root, `[data-testid="stock-prep-refresh-change-review-conclusion-${options.conclusion === 'handled_with_notes' ? 'handled-with-notes' : 'handled'}"] input`)
  if (options.notes !== undefined) await typeInto(root, 'stock-prep-refresh-change-review-notes', options.notes)
  await typeInto(root, 'stock-prep-refresh-change-review-typed-project-no', PROJECT)
}

// ---------------------------------------------------------------------------

describe('「变更计划」 / 「变更复核」 — StockPreparationRefreshChangePlan (CP / RV)', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('CP-DORMANT: not_governed / unreadable / non-content holds read no change plan; a bad answer is one state line, never "nothing to do"', async () => {
    // (by construction: main has no section) — the dormancy tripwire on the page itself.
    for (const state of [
      serverState({ status: 'not_governed', governed: 'none', holds: [] }),
      serverState({ readable: false, status: 'unreadable', governed: 'unknown', holds: [] }),
      serverState({ holds: [candidateHold()] }),
      serverState({ status: 'complete', holds: [] }),
    ]) {
      teardown(); setup()
      const root = await mountView(state)
      expect(planReads(state), state.status).toEqual([])
      expect(q(root, 'stock-prep-refresh-change-plan-section'), state.status).toBeNull()
      expect(state.requests.some((request) => request.url.includes('/change-plans/') || request.url.includes('/change-reviews/')), state.status).toBe(false)
    }
    // A bad answer — `{}` (the RQ router's fallback), a 404 (an older backend), a 501 (receipts / store not wired), a
    // non-integer record page — renders ONE state line, no confirm and no review; the read control stays.
    const bad: Array<{ label: string; state: ServerState }> = [
      { label: '{}', state: serverState({ proposal: null }) },
      { label: '404', state: serverState({ planAnswer: { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'x' } } } }) },
      { label: '501', state: serverState({ planAnswer: { status: 501, body: { ok: false, error: { code: 'STOCK_PREP_REFRESH_RECEIPT_STORE_UNAVAILABLE', message: 'x', details: { reason: 'receipts' } } } } }) },
      { label: 'non-integer page', state: serverState({ planAnswer: { status: 200, body: { ok: true, data: { refresh: {}, proposal: { blocked: null, holdIds: ['hold_syn_c1'], candidates: [], recordPage: { index: 0.5, count: 1, next: null }, records: [] }, current: { confirmed: null, written: null }, readReceipt: null } } } }) },
    ]
    for (const entry of bad) {
      teardown(); setup()
      const root = await mountView(entry.state)
      expect(q(root, 'stock-prep-refresh-change-plan-state')?.textContent, entry.label).toContain('变更计划读不出来')
      expect(q(root, 'stock-prep-refresh-change-plan-confirm'), entry.label).toBeNull()
      expect(q(root, 'stock-prep-refresh-change-review-complete'), entry.label).toBeNull()
      expect(q(root, 'stock-prep-refresh-change-plan'), `${entry.label}: the read control stays`).not.toBeNull()
      expect(q(root, 'stock-prep-refresh-go-change-plan'), `${entry.label}: no pointer to a missing section`).toBeNull()
      expect(posts(entry.state, '/change-plans/confirm')).toEqual([])
    }
  })

  it('CP-RENDER: sections per state, the review_pending rendering, position / earlier-write / human words, field labels', async () => {
    // (a) the proposal.
    let state = serverState()
    let root = await mountView(state)
    const proposal = q(root, 'stock-prep-refresh-change-plan-proposal')!
    expect(proposal).not.toBeNull()
    expect(q(proposal, 'stock-prep-refresh-change-plan-header')?.textContent).toContain('这次有 1 项内容变化,合起来是一份变更计划(共 1 行)')
    expect(q(proposal, 'stock-prep-refresh-change-plan-scope')?.textContent).toContain('不代表采购或仓库已经处理')
    const rows = [...proposal.querySelectorAll('[data-testid="stock-prep-refresh-change-plan-row"]')].map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('总用量')
    expect(rows[0]).toContain('根件(根件的单层用量按根需求量写入)')
    expect(rows[0]).toContain('采购回复(属于变更前状态)')
    expect(rows[0]).not.toContain('备注')
    expect(rows[1]).toContain('其他列')
    expect(proposal.querySelector('[data-testid="stock-prep-refresh-field-id"]')?.textContent).toBe('ext_syn_pack_column')
    expect(q(root, 'stock-prep-refresh-change-review'), 'no written plan, no review section').toBeNull()
    // The hold card points at the section, which is on the page.
    expect(q(root, 'stock-prep-refresh-content-plan-pointer')?.textContent).toContain('在下面的「变更计划」里统一确认')
    expect(q(root, 'stock-prep-refresh-go-change-plan')).not.toBeNull()
    // The content card's field reads in words and its reason too.
    const card = root.querySelector('[data-testid="stock-prep-refresh-content-change"]')!
    expect(card.textContent).toContain('总用量')
    expect(card.textContent).toContain('PLM 里的数据变了')
    teardown(); setup()

    // (c) 0 holds + a written plan: the review_pending rendering (never 无待处理) and the review section.
    state = reviewState()
    root = await mountView(state)
    expect(root.querySelector('[data-refresh-rendering]')?.getAttribute('data-refresh-rendering')).toBe('review_pending')
    expect(q(root, 'stock-prep-refresh-state')?.textContent).toContain('等您复核')
    expect(q(root, 'stock-prep-refresh-state')?.textContent).not.toContain('无待处理')
    const review = q(root, 'stock-prep-refresh-change-review')!
    expect(q(review, 'stock-prep-refresh-change-review-intro')?.textContent).toContain('共 2 行')
    expect(q(review, 'stock-prep-refresh-change-review-absorbed')?.textContent).toContain('1 份变更')
    expect(q(review, 'stock-prep-refresh-change-review-digest')?.getAttribute('data-content-matches')).toBe('true')
    expect(review.textContent).toContain('根件(根件的单层用量按根需求量写入)')
    expect(q(root, 'stock-prep-refresh-change-plan-proposal'), 'no open content change, no proposal section').toBeNull()
    await click(control(review, 'stock-prep-refresh-change-review-next'))
    const earlier = [...root.querySelectorAll('[data-testid="stock-prep-refresh-change-review-row"][data-review-only="true"]')]
    expect(earlier.length).toBe(1)
    expect(earlier[0].textContent).toContain('上次写入')
    teardown(); setup()

    // (b) a confirmed, unwritten plan.
    state = serverState({ holds: [], status: 'confirmed_pending_execution', proposal: { blocked: 'no_content_hold', holdIds: [], holdSetFingerprint: HOLD_SET, planFingerprint: null, sourceContentDigest: SOURCE_DIGEST, recordCount: 0, structureHoldOpen: false, runbookHoldOpen: false, candidates: [] }, proposalRecords: [], confirmed: { id: 'plan_syn_c', status: 'confirmed', recordCount: 1, writeRecordCount: 1, planFingerprint: PLAN_FP, reviewBaselineDigest: null, absorbedChangePlanIds: [], confirmedAt: ISO, confirmedBySelf: true, writtenAt: null, writtenContentDigest: null } })
    root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-change-plan-confirmed')?.textContent).toContain('还没写入')
    await click(control(root, 'stock-prep-refresh-change-plan-go-preview'))
    expect(emitted.filter((entry) => entry.event === 'navigate-stage').pop()?.args).toEqual(['project-board', PROJECT])
  })

  it('CP-BODY: the confirm body ⊆ the allow-list; every echo from the proposal verbatim (an unloaded-page id included); the page receipt; typed trimmed; tenantId; no workspaceId', async () => {
    expect([...STOCK_PREP_REFRESH_CHANGE_PLAN_QUERY_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CHANGE_PLAN_QUERY_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_CHANGE_PLAN_CONFIRM_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CHANGE_PLAN_CONFIRM_KEYS').sort())
    expect([...STOCK_PREP_REFRESH_CHANGE_REVIEW_KEYS].sort()).toEqual(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CHANGE_REVIEW_KEYS').sort())
    // A third content hold sits on a later holds page the page has NOT loaded; the receipt already covers it (an
    // earlier read on the same receipt). The confirm names it anyway — the set is the server's, never the loaded list.
    const unloaded = contentHold({ id: 'hold_syn_c3', fingerprint: '3'.repeat(64) })
    const state = serverState({ holds: [contentHold(), relationshipContentHold({ pairPage: { index: 0, count: 1, size: 200, next: null } }), unloaded], holdsPageSize: 2, served: { hold_syn_c3: [0] } })
    const root = await mountView(state)
    expect(root.querySelectorAll('[data-testid="stock-prep-refresh-hold"]').length).toBe(2)
    await readyConfirm(root, `  ${PROJECT}  `)
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled).toBe(false)
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    const [post] = posts(state, '/change-plans/confirm')
    expect(post, 'the confirm was sent').toBeDefined()
    for (const key of Object.keys(post.body!)) expect(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CHANGE_PLAN_CONFIRM_KEYS'), key).toContain(key)
    expect(post.body).toEqual({
      tenantId: SCOPE.tenantId,
      confirmProjectNo: PROJECT,
      holdIds: ['hold_syn_c1', 'hold_syn_c2', 'hold_syn_c3'],
      holdSetFingerprint: HOLD_SET,
      planFingerprint: PLAN_FP,
      sourceContentDigest: SOURCE_DIGEST,
      readReceipt: RECEIPT_ID,
    })
    for (const request of state.requests) {
      expect(request.url, request.url).not.toContain('workspaceId')
      expect(request.url, `${request.url}: never recordLimit`).not.toContain('recordLimit')
      expect(JSON.stringify(request.body ?? {}), request.url).not.toContain('workspaceId')
    }
  })

  it('CP-CONTRACT: the web bodies pass the plugin\'s real normalizers; the store\'s control-character rule, source-pinned, drives the web helper exhaustively; the mirrors', () => {
    // The mirrored constants.
    expect([...STOCK_PREP_CHANGE_REVIEW_CONCLUSIONS]).toEqual([...store.REVIEW_CONCLUSIONS])
    expect(STOCK_PREP_CHANGE_REVIEW_NOTES_MAX_LENGTH).toBe(store.REVIEW_NOTES_MAX_LENGTH)
    expect(STOCK_PREP_CHANGE_PLAN_BASIS_NOTE_MAX_LENGTH).toBe(store.BASIS_NOTE_MAX_LENGTH)
    expect(STOCK_PREP_CHANGE_PLAN_RECORD_PAGE_DEFAULT).toBe(decisions.RECORD_PAGE_LIMIT_DEFAULT)
    expect([...STOCK_PREP_CONTENT_CLASS_HOLD_KINDS]).toEqual([...pairing.CONTENT_CLASS_HOLD_KINDS])

    // (a) bodies built by the web pass the REAL normalizers; one echo dropped is 400 on that field.
    const receipt: StockPrepRefreshReceipt = { id: RECEIPT_ID, expiresAt: ISO, holds: { hold_syn_c1: { pageCount: 1, pagesServed: [0], complete: true }, hold_syn_cand: { pageCount: 1, pagesServed: [0], complete: true }, plan_syn_w: { pageCount: 1, pagesServed: [0], complete: true } } }
    const confirmPage = {
      refresh: { readable: true, status: 'pending_confirmation', governed: 'pilot', counts: { pendingConfirm: 2 }, pilot: true },
      proposal: { blocked: null, holdIds: ['hold_syn_c1', 'hold_syn_cand'], holdSetFingerprint: HOLD_SET, planFingerprint: PLAN_FP, sourceContentDigest: SOURCE_DIGEST, recordCount: 1, structureHoldOpen: false, runbookHoldOpen: false, candidates: [{ holdId: 'hold_syn_cand', candidateId: 'd'.repeat(64), history: 'history_unknown' }], recordPage: { index: 0, count: 1, size: 100, next: null }, records: [] },
      current: { confirmed: null, written: null },
      readReceipt: null,
    } as unknown as StockPrepChangePlanPage
    const confirmBody = buildChangePlanConfirmBody(confirmPage, receipt, { confirmProjectNo: PROJECT, typedMatches: true, acknowledged: true, candidateChoices: { hold_syn_cand: { historyAcknowledged: true, note: '同一份需求' } }, holdsPageFingerprint: HOLD_SET, pilot: true })
    expect(confirmBody).not.toBeNull()
    expect(() => decisions.__internals.normalizeChangePlanConfirmBody(confirmBody)).not.toThrow()
    for (const field of ['holdSetFingerprint', 'planFingerprint', 'sourceContentDigest', 'readReceipt', 'holdIds'] as const) {
      const dropped = { ...confirmBody } as Record<string, unknown>
      delete dropped[field]
      expect(() => decisions.__internals.normalizeChangePlanConfirmBody(dropped), field).toThrow(expect.objectContaining({ status: 400, details: expect.objectContaining({ field }) }))
    }
    const reviewPage = {
      refresh: { readable: true, status: 'change_pending_review', governed: 'pilot', counts: { pendingConfirm: 0, pendingReviews: 1 }, pilot: true },
      proposal: { blocked: 'no_content_hold', holdIds: [], holdSetFingerprint: HOLD_SET, planFingerprint: null, sourceContentDigest: SOURCE_DIGEST, recordCount: 0, structureHoldOpen: false, runbookHoldOpen: false, candidates: [], recordPage: { index: 0, count: 1, size: 100, next: null }, records: [] },
      current: { confirmed: null, written: { id: 'plan_syn_w', status: 'written', recordCount: 1, planFingerprint: PLAN_FP, absorbedChangePlanIds: [], confirmedBySelf: false, writtenContentDigest: WRITTEN_DIGEST, currentContentDigest: WRITTEN_DIGEST, contentMatchesWrite: true, recordPage: { index: 0, count: 1, size: 100, next: null }, records: [] } },
      readReceipt: null,
    } as unknown as StockPrepChangePlanPage
    for (const [conclusion, notes] of [['handled', ''], ['handled_with_notes', '已通知采购']] as const) {
      const body = buildChangeReviewBody(reviewPage, receipt, { confirmProjectNo: PROJECT, typedMatches: true, conclusion, notes, block: null })
      expect(body, conclusion).not.toBeNull()
      // The digest echoed is the CURRENT one, sent only when it matches the write — so it equals writtenContentDigest.
      expect(body!.contentDigest).toBe(WRITTEN_DIGEST)
      expect(() => decisions.__internals.normalizeReviewBody(body)).not.toThrow()
      const dropped = { ...body } as Record<string, unknown>
      delete dropped.contentDigest
      expect(() => decisions.__internals.normalizeReviewBody(dropped)).toThrow(expect.objectContaining({ status: 400, details: expect.objectContaining({ field: 'contentDigest' }) }))
    }

    // (b) the store's notes rule. `normalizeReviewNotes` and the pattern are NOT exported, so the declaration is
    // source-pinned (C0, DEL, C1 and the two Unicode line separators) and the WEB helper driven over every code point.
    const storeSource = readFileSync(resolve(__dirname, PLUGIN_LIB, 'stock-preparation-continuation-store.cjs'), 'utf8').replace(/\r\n/g, '\n')
    const declaration = storeSource.split('\n').find((line) => line.startsWith('const CONTROL_CHARACTER_PATTERN = '))
    expect(declaration, 'the store\'s pattern declaration').toBeDefined()
    expect(declaration).toContain('\\\\x00-\\\\x1F\\\\x7F-\\\\x9F')
    expect(declaration).toContain('0x2028')
    expect(declaration).toContain('0x2029')
    const refused = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i), 0x2028, 0x2029]
    expect(refused.length).toBe(32 + 33 + 2)
    for (const code of refused) {
      expect(stockPrepReviewNotesProblem(`已处理${String.fromCharCode(code)}说明`, 'handled_with_notes'), `U+${code.toString(16).padStart(4, '0')}`).toBe('control_character')
    }
    for (const ok of ['已通知采购与仓库', 'Procurement informed; warehouse notified.', '数量 2 → 3 已确认']) {
      expect(stockPrepReviewNotesProblem(ok, 'handled_with_notes'), ok).toBeNull()
    }
    expect(stockPrepReviewNotesProblem('x'.repeat(store.REVIEW_NOTES_MAX_LENGTH), 'handled_with_notes')).toBeNull()
    expect(stockPrepReviewNotesProblem('x'.repeat(store.REVIEW_NOTES_MAX_LENGTH + 1), 'handled_with_notes')).toBe('too_long')
    expect(stockPrepReviewNotesProblem('   ', 'handled_with_notes')).toBe('required')
    expect(stockPrepReviewNotesProblem('', 'handled')).toBeNull()
  })

  it('CP-RECEIPT: the confirm waits for every named hold complete (pair page 2; a hold read via 更多待确认项); one receipt id rides every read; pages_missing reads in words', async () => {
    const third = contentHold({ id: 'hold_syn_c3', fingerprint: '3'.repeat(64) })
    const state = serverState({ holds: [contentHold(), relationshipContentHold(), third], holdsPageSize: 2 })
    const root = await mountView(state)
    await readyConfirm(root)
    const why = () => q(root, 'stock-prep-refresh-change-plan-confirm-why')
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, 'pair page 2 unread, third hold unloaded').toBe(true)
    expect(why()?.getAttribute('data-gap')).toBe('pages_unread')
    expect(q(root, 'stock-prep-refresh-change-plan-receipt')?.textContent).toContain('已打开看完 1 项')
    // Pair page 2 of the relationship content change (the hold card's own control).
    const rcc = root.querySelector('[data-testid="stock-prep-refresh-hold"][data-hold-kind="relationship_content_change"]') as HTMLElement
    await click(control(rcc, 'stock-prep-refresh-next-pair-page'))
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, 'the third hold is still unread').toBe(true)
    // The section's own 「读下一批待确认项」 reads ONE more holds page.
    await click(control(root, 'stock-prep-refresh-change-plan-more-holds'))
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled).toBe(false)
    expect(q(root, 'stock-prep-refresh-change-plan-receipt')?.textContent).toContain('已打开看完 3 项')
    // One receipt id rides every later holds read AND every plan read.
    const reads = [...holdReads(state), ...planReads(state)]
    expect(reads.length).toBeGreaterThanOrEqual(4)
    expect(holdReads(state)[0].url).not.toContain('receipt=')
    for (const request of reads.slice(1)) {
      if (request === holdReads(state)[0]) continue
      expect(request.url, request.url).toContain(`receipt=${RECEIPT_ID}`)
    }
    // A server refusal for a page the server did not see reads in words.
    state.postAnswer = { status: 409, body: { ok: false, error: { code: 'STOCK_PREP_CONTINUATION_CONFIRM_READ_RECEIPT_INCOMPLETE', message: 'x', details: { reason: 'pages_missing', holdId: 'hold_syn_c2', pagesServed: 1, pageCount: 2 } } } }
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    expect(q(root, 'stock-prep-refresh-change-plan-error')?.textContent).toContain('还有对照页没有打开过')
    expect(q(root, 'stock-prep-refresh-preview-again'), 'nothing was confirmed').toBeNull()
  })

  it('CP-ACK / CP-TYPED: the acknowledgement and the typed number are each required; the TYPED number is what is sent', async () => {
    const state = serverState()
    const root = await mountView(state)
    await typeInto(root, 'stock-prep-refresh-change-plan-typed-project-no', PROJECT)
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, 'no acknowledgement').toBe(true)
    expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap')).toBe('ack')
    await tick(root, '[data-testid="stock-prep-refresh-change-plan-ack"] input')
    for (const typed of ['', 'SYN-PROJ-0002', `${PROJECT}X`, PROJECT.toLowerCase()]) {
      await typeInto(root, 'stock-prep-refresh-change-plan-typed-project-no', typed)
      expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, JSON.stringify(typed)).toBe(true)
      expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap'), typed).toBe('typed')
    }
    await typeInto(root, 'stock-prep-refresh-change-plan-typed-project-no', ` ${PROJECT} `)
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    expect(posts(state, '/change-plans/confirm')[0]?.body?.confirmProjectNo).toBe(PROJECT)
  })

  it('CP-CMB: combined candidates — candidates[] with the basis; acknowledge only for history_unknown; a non-pilot project is disabled with words', async () => {
    const proposalBase = { blocked: null, holdSetFingerprint: HOLD_SET, planFingerprint: PLAN_FP, sourceContentDigest: SOURCE_DIGEST, recordCount: 1, structureHoldOpen: false, runbookHoldOpen: false }
    const holds = [contentHold(), contentHold({ id: 'hold_syn_k1', kind: 'candidate_content_differs', fingerprint: '4'.repeat(64), pairingFingerprint: '5'.repeat(64) }), contentHold({ id: 'hold_syn_k2', kind: 'candidate_content_differs', fingerprint: '6'.repeat(64), pairingFingerprint: '7'.repeat(64), history: 'relationship_snapshot' })]
    const candidates = [{ holdId: 'hold_syn_k1', candidateId: '5'.repeat(64), history: 'history_unknown' }, { holdId: 'hold_syn_k2', candidateId: '7'.repeat(64), history: 'demand_evidence_store' }]
    let state = serverState({ holds, proposal: { ...proposalBase, holdIds: ['hold_syn_c1', 'hold_syn_k1', 'hold_syn_k2'], candidates } })
    let root = await mountView(state)
    expect(root.querySelectorAll('[data-testid="stock-prep-refresh-change-plan-candidate"]').length).toBe(2)
    await readyConfirm(root)
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, 'history unknown, not acknowledged').toBe(true)
    expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap')).toBe('history_ack')
    await tick(root, '[data-testid="stock-prep-refresh-change-plan-candidate-history-ack"] input')
    const notes = root.querySelectorAll('[data-testid="stock-prep-refresh-change-plan-candidate-note"]')
    ;(notes[1] as HTMLInputElement).value = '  同一份需求  '
    notes[1].dispatchEvent(new Event('input'))
    await flush(2)
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    const [post] = posts(state, '/change-plans/confirm')
    expect(post?.body?.candidates).toEqual([
      { holdId: 'hold_syn_k1', candidateId: '5'.repeat(64), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } },
      { holdId: 'hold_syn_k2', candidateId: '7'.repeat(64), basis: { kind: 'puller_confirmed_same_demand', note: '同一份需求' } },
    ])
    teardown(); setup()
    state = serverState({ holds, pilot: false, governed: 'protected', proposal: { ...proposalBase, holdIds: ['hold_syn_c1', 'hold_syn_k1', 'hold_syn_k2'], candidates } })
    root = await mountView(state)
    await readyConfirm(root)
    expect(q(root, 'stock-prep-refresh-change-plan-not-pilot')?.textContent).toContain('不是试点')
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap')).toBe('not_pilot')
    // A proposal with NO candidate sends no `candidates` key at all (CP-BODY's exact body pins it too).
  })

  it('CP-BLOCKED: every blocked token reads in words (token on the data attribute only); the confirm is present and disabled; a null plan fingerprint is disabled', async () => {
    const decisionsSource = readFileSync(resolve(__dirname, PLUGIN_LIB, 'stock-preparation-refresh-decisions.cjs'), 'utf8').replace(/\r\n/g, '\n')
    const start = decisionsSource.indexOf('function proposalOf(')
    const body = decisionsSource.slice(start, decisionsSource.indexOf('\nfunction ', start + 1))
    const tokens = new Set<string>()
    for (const match of body.matchAll(/blocked = '([a-z_]+)'/g)) tokens.add(match[1])
    for (const match of body.matchAll(/\? '([a-z_]+)' : '([a-z_]+)'/g)) { tokens.add(match[1]); tokens.add(match[2]) }
    tokens.delete('recordsBlocked')
    expect(tokens.size).toBe(7)
    for (const token of tokens) {
      teardown(); setup()
      const state = serverState()
      state.proposal = { ...state.proposal!, blocked: token }
      const root = await mountView(state)
      const line = q(root, 'stock-prep-refresh-change-plan-blocked')
      expect(line?.getAttribute('data-blocked-token'), token).toBe(token)
      expect(line?.textContent, token).not.toContain(token)
      expect(line?.textContent, token).toContain(STOCK_PREP_REFRESH_CHANGE_PLAN_BLOCKED_PLAIN[token].zh)
      await readyConfirm(root)
      expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled, token).toBe(true)
    }
    teardown(); setup()
    const state = serverState()
    state.proposal = { ...state.proposal!, planFingerprint: null }
    const root = await mountView(state)
    await readyConfirm(root)
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap')).toBe('no_fingerprint')
  })

  it('CP-XCHECK: a holds page naming another hold set than the proposal keeps the confirm disabled, with words', async () => {
    const state = serverState()
    state.proposal = { ...state.proposal!, holdSetFingerprint: '8'.repeat(64) }
    const root = await mountView(state)
    await readyConfirm(root)
    expect(q(root, 'stock-prep-refresh-change-plan-xcheck')?.textContent).toContain('待确认项在您打开页面之后变了')
    expect(control(root, 'stock-prep-refresh-change-plan-confirm').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-change-plan-confirm-why')?.getAttribute('data-gap')).toBe('holds_moved')
  })

  it('CP-CHURN: 409 CHANGE_PLAN_STALE/hold_set_moved re-reads holds page 1 (same receipt) and the plan, and says the item was updated', async () => {
    const state = serverState()
    const root = await mountView(state)
    await readyConfirm(root)
    const holdsBefore = holdReads(state).length
    const plansBefore = planReads(state).length
    state.postAnswer = { status: 409, body: { ok: false, error: { code: 'STOCK_PREP_CHANGE_PLAN_STALE', message: 'x', details: { reason: 'hold_set_moved', partial: false } } } }
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    expect(holdReads(state).length).toBe(holdsBefore + 1)
    expect(holdReads(state).pop()?.url).toContain(`receipt=${RECEIPT_ID}`)
    expect(holdReads(state).pop()?.url).not.toContain('cursor=')
    expect(planReads(state).length).toBeGreaterThan(plansBefore)
    expect(q(root, 'stock-prep-refresh-notice')?.textContent).toContain('这一项已经更新')
    expect(q(root, 'stock-prep-refresh-change-plan-error')?.textContent).toContain('又有一次试算改变了待确认项')
    // The local choices were dropped with the re-read.
    expect((q(root, 'stock-prep-refresh-change-plan-typed-project-no') as HTMLInputElement).value).toBe('')
  })

  it('CP-NEXT: 201 ⇒ the preview-again block names 变更计划 and 必须重新试算 and says the review follows; 「去重新试算」 opens 项目备料', async () => {
    const state = serverState()
    const root = await mountView(state)
    await readyConfirm(root)
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    const block = q(root, 'stock-prep-refresh-preview-again')!
    expect(block.getAttribute('data-preview-again')).toBe('plan_confirmed')
    expect(block.textContent).toContain('变更计划已确认')
    expect(block.textContent).toContain('必须重新试算')
    expect(block.textContent).toContain('变更复核')
    expect(q(root, 'stock-prep-refresh-rekey-note')).not.toBeNull()
    // The section re-read: a confirmed, unwritten plan now.
    expect(q(root, 'stock-prep-refresh-change-plan-confirmed')).not.toBeNull()
    await click(control(root, 'stock-prep-refresh-go-preview'))
    expect(emitted.filter((entry) => entry.event === 'navigate-stage').pop()?.args).toEqual(['project-board', PROJECT])
  })

  it('RV-RECEIPT: the review waits for every written-plan page, walked by recordPage.next and never past it; a digest move between reads says so', async () => {
    const state = reviewState()
    const root = await mountView(state)
    await readyReview(root, { walk: false })
    expect(control(root, 'stock-prep-refresh-change-review-complete').disabled, 'page 2 of 2 unread').toBe(true)
    expect(q(root, 'stock-prep-refresh-change-review-why')?.getAttribute('data-gap')).toBe('pages_unread')
    expect(q(root, 'stock-prep-refresh-change-review-pages')?.textContent).toContain('已看 1 / 2 页')
    await click(control(root, 'stock-prep-refresh-change-review-next'))
    expect(q(root, 'stock-prep-refresh-change-review-pages')?.textContent).toContain('已看 2 / 2 页')
    expect(control(root, 'stock-prep-refresh-change-review-complete').disabled).toBe(false)
    // Never past the last page: the next control is disabled there, and no read asked for a cursor past it.
    expect(control(root, 'stock-prep-refresh-change-review-next').disabled).toBe(true)
    expect(planReads(state).every((request) => !request.url.includes('recordCursor=2'))).toBe(true)
    teardown(); setup()
    // The sheet moved between two page reads: words, and the server restarts that page set.
    const moved = reviewState({ writtenDigests: [WRITTEN_DIGEST, 'e'.repeat(64)] })
    const movedRoot = await mountView(moved)
    await click(control(movedRoot, 'stock-prep-refresh-change-review-next'))
    expect(q(movedRoot, 'stock-prep-refresh-change-review-moved')?.textContent).toContain('请从第一页重新看')
    expect(q(movedRoot, 'stock-prep-refresh-change-review-digest')?.getAttribute('data-content-matches')).toBe('false')
  })

  it('RV-BODY: keys ⊆ the allow-list; contentDigest = current = written; the conclusion; notes only when non-blank; the typed number', async () => {
    const state = reviewState()
    const root = await mountView(state)
    await readyReview(root, { conclusion: 'handled', notes: '   ' })
    await click(control(root, 'stock-prep-refresh-change-review-complete'))
    const [post] = posts(state, '/change-reviews/complete')
    expect(post, 'the review was sent').toBeDefined()
    for (const key of Object.keys(post.body!)) expect(serverAllowList('VALID_STOCK_PREPARATION_REFRESH_CHANGE_REVIEW_KEYS'), key).toContain(key)
    expect(post.body).toEqual({ tenantId: SCOPE.tenantId, confirmProjectNo: PROJECT, changePlanId: 'plan_syn_w', contentDigest: WRITTEN_DIGEST, conclusion: 'handled', readReceipt: RECEIPT_ID })
    teardown(); setup()
    const withNotes = reviewState()
    const notesRoot = await mountView(withNotes)
    await readyReview(notesRoot, { conclusion: 'handled_with_notes', notes: '  已通知采购  ' })
    await click(control(notesRoot, 'stock-prep-refresh-change-review-complete'))
    expect(posts(withNotes, '/change-reviews/complete')[0]?.body).toMatchObject({ conclusion: 'handled_with_notes', notes: '已通知采购' })
  })

  it('RV-DIGEST: contentMatchesWrite false ⇒ disabled with words; no POST', async () => {
    const state = reviewState({ writtenDigests: ['e'.repeat(64)] })
    const root = await mountView(state)
    await readyReview(root)
    expect(q(root, 'stock-prep-refresh-change-review-digest')?.textContent).toContain('写入之后表里的内容又被改过')
    expect(control(root, 'stock-prep-refresh-change-review-complete').disabled).toBe(true)
    expect(q(root, 'stock-prep-refresh-change-review-why')?.getAttribute('data-gap')).toBe('content_moved')
    expect(posts(state, '/change-reviews/complete')).toEqual([])
  })

  it('RV-NOTES: handled_with_notes needs notes; a line break / control character / 2001 characters is refused client-side; a server 400 on notes reads in words', async () => {
    const state = reviewState()
    const root = await mountView(state)
    await readyReview(root, { conclusion: 'handled_with_notes' })
    const gap = () => q(root, 'stock-prep-refresh-change-review-why')?.getAttribute('data-gap')
    expect(control(root, 'stock-prep-refresh-change-review-complete').disabled).toBe(true)
    expect(gap()).toBe('notes')
    expect(q(root, 'stock-prep-refresh-change-review-why')?.textContent).toContain('就要写说明')
    // (An <input type=text> strips LF / CR on its own; U+2028 is the line separator it keeps — the store refuses both.)
    for (const [notes, words] of [[`第一行${String.fromCharCode(0x2028)}第二行`, '只能是一行'],[`说明${String.fromCharCode(7)}`, '只能是一行'], ['x'.repeat(2001), '不能超过 2000 字']] as const) {
      // The input's maxlength stops typing at 2000; a value set past it (a paste in some browsers) is still refused.
      const input = q(root, 'stock-prep-refresh-change-review-notes') as HTMLInputElement
      input.removeAttribute('maxlength')
      await typeInto(root, 'stock-prep-refresh-change-review-notes', notes)
      expect(control(root, 'stock-prep-refresh-change-review-complete').disabled, JSON.stringify(notes.slice(0, 12))).toBe(true)
      expect(q(root, 'stock-prep-refresh-change-review-why')?.textContent).toContain(words)
    }
    await typeInto(root, 'stock-prep-refresh-change-review-notes', '已通知采购')
    expect(control(root, 'stock-prep-refresh-change-review-complete').disabled).toBe(false)
    state.postAnswer = { status: 400, body: { ok: false, error: { code: 'STOCK_PREP_REFRESH_INPUT_INVALID', message: 'x', details: { field: 'notes' } } } }
    await click(control(root, 'stock-prep-refresh-change-review-complete'))
    const error = q(root, 'stock-prep-refresh-change-plan-error')
    expect(error?.querySelector('code')?.textContent).toBe('STOCK_PREP_REFRESH_INPUT_INVALID')
    expect(q(root, 'stock-prep-refresh-preview-again'), 'nothing was reviewed').toBeNull()
  })

  it('RV-BLOCKED (C12): an open hold, a confirmed plan, recovery or a live write each disable the review with their reason', async () => {
    const cases: Array<{ token: string; words: string; state: ServerState }> = [
      { token: 'hold_open', words: '还有待确认项', state: reviewState({ holds: [contentHold({ id: 'hold_syn_new' })], status: 'pending_confirmation' }) },
      { token: 'change_plan_pending', words: '还有一份已确认、待写入的变更计划', state: reviewState({ confirmed: { id: 'plan_syn_c', status: 'confirmed', recordCount: 1, writeRecordCount: 1, planFingerprint: PLAN_FP, reviewBaselineDigest: null, absorbedChangePlanIds: [], confirmedAt: ISO, confirmedBySelf: true, writtenAt: null, writtenContentDigest: null } }) },
      { token: 'recovery', words: '在等恢复', state: reviewState({ status: 'failed_pending_recovery' }) },
      { token: 'executing', words: '正在写入', state: reviewState({ status: 'executing' }) },
    ]
    for (const entry of cases) {
      teardown(); setup()
      const root = await mountView(entry.state)
      await readyReview(root)
      const line = q(root, 'stock-prep-refresh-change-review-blocked')
      expect(line?.getAttribute('data-block-token'), entry.token).toBe(entry.token)
      expect(line?.textContent, entry.token).toContain(entry.words)
      expect(control(root, 'stock-prep-refresh-change-review-complete').disabled, entry.token).toBe(true)
    }
  })

  it('RV-SELF (C11): the confirmedBySelf note; after a confirm on the same mounted page, the review starts empty', async () => {
    const state = reviewState({ holds: [contentHold()], status: 'pending_confirmation', proposal: serverState().proposal, proposalRecords: serverState().proposalRecords })
    const root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-change-review-self')?.textContent).toContain('这份变更计划是您确认的')
    await readyConfirm(root)
    await click(control(root, 'stock-prep-refresh-change-review-next'))
    await typeInto(root, 'stock-prep-refresh-change-review-typed-project-no', PROJECT)
    await tick(root, '[data-testid="stock-prep-refresh-change-review-conclusion-handled"] input')
    await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
    expect(posts(state, '/change-plans/confirm').length).toBe(1)
    // The review section is still there (the written plan) — and nothing of the confirm carried over to it.
    expect((q(root, 'stock-prep-refresh-change-review-typed-project-no') as HTMLInputElement).value).toBe('')
    expect((root.querySelector('[data-testid="stock-prep-refresh-change-review-conclusion-handled"] input') as HTMLInputElement).checked).toBe(false)
  })

  it('RV-PERMISSION / RV-NEXT: the permission ≠ appointment sentence; 200 ⇒ 复核不代替核对 and 「已执行待核对」 / 「核对」', async () => {
    const state = reviewState()
    const root = await mountView(state)
    expect(q(root, 'stock-prep-refresh-change-review-permission')?.textContent).toContain('以客户的指定为准')
    await readyReview(root)
    await click(control(root, 'stock-prep-refresh-change-review-complete'))
    const block = q(root, 'stock-prep-refresh-preview-again')!
    expect(block.getAttribute('data-preview-again')).toBe('reviewed')
    expect(block.textContent).toContain('复核不代替核对')
    expect(block.textContent).toContain('已执行待核对')
    expect(block.textContent).toContain('「核对」')
    expect(control(root, 'stock-prep-refresh-go-preview').textContent).toContain('去项目备料页')
  })

  it('CP-VALUES: cells, keys and notes show on the page, never in storage, an emit, the error banner, the clipboard or any console call; a project switch clears them first', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}))
    try {
      const NOTE = 'SYN-NOTE-SENTINEL'
      const state = reviewState({ holds: [contentHold()], status: 'pending_confirmation', proposal: serverState().proposal, proposalRecords: serverState().proposalRecords })
      const viewProps = reactive({ projectNo: PROJECT })
      h.apiFetch.mockImplementation(router(state))
      emitted.length = 0
      app = createApp(defineComponent({ setup: () => () => vh(StockPreparationRefreshQueueView as Component, { scope: SCOPE, projectNo: viewProps.projectNo, onRefreshChanged: (...args: unknown[]) => emitted.push({ event: 'refresh-changed', args }), onNavigateStage: (...args: unknown[]) => emitted.push({ event: 'navigate-stage', args }) }) }))
      app.mount(container!)
      await flush()
      const root = container!
      expect(root.textContent).toContain(SENTINEL)
      await typeInto(root, 'stock-prep-refresh-change-review-notes', NOTE)
      expect((q(root, 'stock-prep-refresh-change-review-notes') as HTMLInputElement).value).toBe(NOTE)
      state.postAnswer = { status: 409, body: { ok: false, error: { code: 'STOCK_PREP_CHANGE_PLAN_NOT_ALLOWED', message: SENTINEL, details: { reason: SENTINEL } } } }
      await readyConfirm(root)
      await click(control(root, 'stock-prep-refresh-change-plan-confirm'))
      const banner = q(root, 'stock-prep-refresh-change-plan-error')!
      expect(banner).not.toBeNull()
      expect(banner.textContent).not.toContain(SENTINEL)
      await click(control(root, 'stock-prep-refresh-change-plan-error-copy'))
      expect(h.clipboard).toHaveBeenCalled()
      const everywhere = [
        JSON.stringify(h.clipboard.mock.calls),
        JSON.stringify(emitted),
        JSON.stringify(spies.map((spy) => spy.mock.calls)),
      ]
      for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) everywhere.push(`${storage.key(index)}=${storage.getItem(storage.key(index) ?? '')}`)
      }
      for (const text of everywhere) {
        expect(text).not.toContain(SENTINEL)
        expect(text).not.toContain(NOTE)
        expect(text).not.toContain('SYN-KEY-1')
      }
      // A project switch drops every value of the previous one before the next is read.
      viewProps.projectNo = 'SYN-PROJ-0002'
      await nextTick()
      expect(root.textContent).not.toContain(SENTINEL)
      expect(root.textContent).not.toContain(NOTE)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// CP-ALIGN / CP-RAIL — through the real shell
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

/** A content hold AND a written plan: every one of the three controls is offered. */
function alignState(): ServerState {
  return reviewState({ holds: [contentHold()], status: 'pending_confirmation', proposal: serverState().proposal, proposalRecords: serverState().proposalRecords })
}

describe('CP-ALIGN — the three change-plan controls render for exactly the actors the manifest grants', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('CP-ALIGN: rendered change-plan control ids == visibleStockPrepControls ∩ three, both directions, every actor', async () => {
    for (const id of PLAN_CONTROLS) {
      expect(STOCK_PREP_WORKBENCH_CAPABILITIES.some((capability) => capability.control === id), id).toBe(true)
    }
    let pullerSawAll = false
    for (const actor of ALIGN_ACTORS) {
      teardown(); setup()
      h.permissions = actor.permissions
      h.roles = actor.roles
      h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
      h.apiFetch.mockImplementation(router(alignState()))
      app = createApp(StockPreparationWorkspace as Component)
      app.mount(container!)
      await flush(14)
      const rendered = PLAN_CONTROLS.filter((id) => container!.querySelector(`[data-testid="${id}"]`) !== null)
      const granted = visibleStockPrepControls({ roles: actor.roles, permissions: actor.permissions }).filter((id) => PLAN_CONTROLS.includes(id))
      expect(rendered.sort(), actor.name).toEqual(granted.sort())
      if (granted.length === PLAN_CONTROLS.length) pullerSawAll = true
    }
    // The positive control: at least one actor sees all three (the fixture offers every control).
    expect(pullerSawAll).toBe(true)
  })

  it('CP-RAIL: the rail badge counts holds + pending reviews for a puller (2 + 1 = 3); none for the floor', async () => {
    const state = reviewState({ holds: [contentHold(), contentHold({ id: 'hold_syn_c9', fingerprint: '9'.repeat(63) + '1' })], status: 'pending_confirmation', proposal: serverState().proposal, proposalRecords: serverState().proposalRecords })
    h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
    h.apiFetch.mockImplementation(router(state))
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush(14)
    expect(container!.querySelector('[data-testid="stock-prep-rail-count-refresh-queue"]')?.textContent?.trim()).toBe('3')
    teardown(); setup()
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.route.query = { tab: 'refresh-queue', projectNo: PROJECT }
    h.apiFetch.mockImplementation(router(alignState()))
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush(14)
    expect(container!.querySelector('[data-testid="stock-prep-rail-count-refresh-queue"]')).toBeNull()
    expect(container!.querySelector('[data-testid="stock-prep-tab-refresh-queue"]')).toBeNull()
  })
})
