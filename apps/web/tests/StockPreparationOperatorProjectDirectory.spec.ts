import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 一线看得见自己工厂的项目 — the FRONT-END half of the operator project directory.
//
// The problem this closes: a floor operator could not find their own project. The only directory was
// admin-only and values-free (status + counts + runId, no number and no name), and the confirmation
// queue demanded a hand-typed `projectNo` — so an operator had to memorise, out of band, that
// 230920006 is the RY2 注射水缓冲罐部件. Worse, when nothing came back they got ONE sentence,
// 「都清了」, whether the project had never been synced, the number was mistyped, or the project
// really was clear. Only the last is good news.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   W-01 the worklist LOADS ON MOUNT — the page opens on the operator's work, not on an empty box
//   W-02 every row shows the NUMBER and the NAME
//   W-03 the datalist carries the whole directory, number as value and name as label, so the
//        browser's own type-ahead filters by EITHER — the point of the change
//   W-04 picking from the worklist fills the number and loads that project's queue
//   W-05 the HAND-TYPED path still works, unchanged
//   W-06 the four empty states are DISTINCT, and 「都清了」 appears only when it is true
//   W-07 the directory load does not disable the queue's own controls (they are independent)
//   W-08 a caller without the capability renders no directory control and issues NO directory request
//   W-09 a degraded/partial payload degrades to the most conservative diagnosis, never a crash and
//        never a false "all clear"

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: [] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

// The real permission algebra, same reproduction the alignment suite uses — a constant probe would
// make the capability-gating guards vacuous.
function realHasPermission(required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true
  if (h.roles.includes('admin') || h.permissions.includes('*:*') || h.permissions.includes('admin:all')) return true
  if (h.permissions.includes(normalized)) return true
  const [resource, action] = normalized.split(':')
  if (!resource || !action) return false
  if (h.permissions.includes(`${resource}:*`)) return true
  if (h.permissions.includes(`${resource}:admin`) && action !== 'admin') return true
  if (action === 'read' && h.permissions.includes(`${resource}:write`)) return true
  return false
}

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => realHasPermission(permission),
    hasAdminAccess: () => h.roles.includes('admin'),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), roles: h.roles, permissions: h.permissions }),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationConfirmationQueueView from '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'
import {
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import {
  STOCK_PREP_DIRECTORY_EMPTY_PLAIN,
  stockPrepDirectoryEmptyState,
} from '../src/services/integration/stockPreparation/plainLanguage'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

const DIRECTORY_URL = '/api/integration/stock-preparation/operator/projects'
const QUEUE_URL = '/api/integration/stock-preparation/confirmation-decisions'

// The real shape of the problem: a number nobody remembers, and the name everybody uses.
const P1 = { no: '230920006', name: 'RY2注射水缓冲罐部件' }
const P2 = { no: '230920007', name: 'RY2纯化水储罐部件' }

function project(entry: { no: string; name: string }, pendingDecisionCount: number) {
  return {
    projectId: `stockprep_${entry.no}`,
    projectNo: entry.no,
    projectName: entry.name,
    projectStatus: 'active',
    lastSyncRunId: `run_${entry.no}`,
    snapshotBatchCount: 1,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 4,
    pendingDecisionCount,
  }
}

function directoryPayload(overrides: Record<string, unknown> = {}) {
  const projects = [project(P1, 2), project(P2, 0)]
  return {
    tenantId: SCOPE.tenantId,
    directoryReady: true,
    ledgerReady: true,
    projectCount: projects.length,
    pendingProjectCount: 1,
    projects,
    ...overrides,
  }
}

function queuePayload(rows: unknown[] = []) {
  return {
    rowCount: rows.length,
    byStatus: {},
    byResolutionAction: {},
    parkedCount: 0,
    rows,
  }
}

function pendingRow() {
  return {
    decisionId: 'decision_1',
    conflictType: 'duplicate_expanded_key',
    status: 'pending',
    resolutionAction: null,
    inputFingerprint: 'sha16:0123456789abcdef',
    sourceRevisionPresent: true,
    confirmedByPresent: false,
    confirmedAtPresent: false,
    notesPresent: false,
    resolvedValuePresent: false,
    resolvedAuxValuePresent: false,
  }
}

/** Route the mock by URL, so the directory and the queue can disagree — which is the whole point. */
function routeFetch(options: {
  directory?: Record<string, unknown> | null
  /** A named server refusal for the directory read, e.g. the tenantless-principal 403. */
  directoryError?: { status: number; code: string }
  queueRows?: unknown[]
} = {}) {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (String(url).includes(DIRECTORY_URL)) {
      if (options.directoryError) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: options.directoryError.code, message: 'refused' } }),
          { status: options.directoryError.status },
        )
      }
      if (options.directory === null) return new Response('{"ok":false}', { status: 500 })
      return new Response(JSON.stringify({ ok: true, data: options.directory ?? directoryPayload() }), { status: 200 })
    }
    if (String(url).includes(QUEUE_URL)) {
      return new Response(JSON.stringify({ ok: true, data: queuePayload(options.queueRows ?? []) }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
  })
}

let app: VueApp | null = null
let container: HTMLDivElement | null = null

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => nextTick()).then(() => undefined)
}

function mountView(): HTMLDivElement {
  app = createApp(StockPreparationConfirmationQueueView as Component, { scope: SCOPE })
  app.mount(container!)
  return container!
}

function q(root: HTMLElement, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`)
}

function all(root: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(`[data-testid="${testid}"]`))
}

function directoryCalls(): string[] {
  return h.apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(DIRECTORY_URL))
}

describe('一线看得见自己工厂的项目 — the operator project directory', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    // The full operator tier. `operate` is a CONJUNCTION with `read` server-side and the browser
    // mirror computes it the same way, so both are held.
    h.permissions = [STOCK_PREP_READ, STOCK_PREP_OPERATE]
    h.roles = []
    routeFetch()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('W-01 loads the worklist ON MOUNT — the page opens on the operator’s work', async () => {
    const root = mountView()
    await flush()
    expect(directoryCalls(), 'the directory is read without the operator asking').toHaveLength(1)
    expect(q(root, 'stock-prep-operator-project-worklist')).not.toBeNull()
  })

  it('W-02 every worklist row carries the NUMBER and the NAME', async () => {
    const root = mountView()
    await flush()
    const worklist = q(root, 'stock-prep-operator-project-worklist')!
    const text = worklist.textContent ?? ''
    expect(text, 'the number a person quotes on the phone').toContain(P1.no)
    expect(text, 'the name a person actually recognises').toContain(P1.name)
    // Only the project with pending work is in the WORKLIST — the other is still in the datalist.
    expect(text).not.toContain(P2.no)
  })

  it('W-03 the datalist carries the WHOLE directory: number as value, name as label', async () => {
    const root = mountView()
    await flush()
    const datalist = q(root, 'stock-prep-operator-project-datalist')
    expect(datalist).not.toBeNull()
    const options = Array.from(datalist!.querySelectorAll('option'))
    expect(options.map((option) => option.getAttribute('value'))).toEqual([P1.no, P2.no])
    // The LABEL is the name, which is what lets the browser's native type-ahead match on either —
    // an operator who only remembers 「注射水缓冲罐」 can still reach 230920006.
    expect(options.map((option) => option.textContent)).toEqual([P1.name, P2.name])
    // The input is wired to it.
    expect(q(root, 'stock-prep-confirmation-project-input')!.getAttribute('list'))
      .toBe(datalist!.getAttribute('id'))
  })

  it('W-04 picking from the worklist fills the number and loads that project’s queue', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const root = mountView()
    await flush()
    const pick = all(root, 'stock-prep-operator-project-pick')[0] as HTMLButtonElement
    expect(pick).toBeTruthy()
    pick.click()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    expect(input.value, 'the pick fills the SAME field the typed path uses').toBe(P1.no)
    const queueCall = h.apiFetch.mock.calls.map((call) => String(call[0])).find((url) => url.includes(QUEUE_URL))
    expect(queueCall, 'and it loads that project').toContain(`projectNo=${P1.no}`)
    expect(q(root, 'stock-prep-confirmation-rows')).not.toBeNull()
  })

  it('W-05 the HAND-TYPED path is unchanged', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const root = mountView()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P2.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const queueCall = h.apiFetch.mock.calls.map((call) => String(call[0])).find((url) => url.includes(QUEUE_URL))
    expect(queueCall).toContain(`projectNo=${P2.no}`)
  })

  it('W-06a “nothing synced yet” is NOT reported as 都清了', async () => {
    routeFetch({ directory: directoryPayload({ directoryReady: false, projectCount: 0, projects: [], pendingProjectCount: 0 }) })
    const root = mountView()
    await flush()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('nothing_synced')
    expect(empty.textContent).not.toContain('都清了')
    expect(empty.textContent, 'and it says whose job the next step is').toContain('管理员')
  })

  it('W-06b a number that is not in the directory says so, instead of “all clear”', async () => {
    const root = mountView()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = '999999999'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('project_not_found')
    expect(empty.textContent).not.toContain('都清了')
    expect(empty.textContent).toContain('查不到')
  })

  it('W-06c a missing ledger is its own state, and the directory still answers', async () => {
    routeFetch({ directory: directoryPayload({ ledgerReady: false, pendingProjectCount: 0 }) })
    const root = mountView()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P1.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    expect(q(root, 'stock-prep-confirmation-empty')!.getAttribute('data-empty-state')).toBe('ledger_missing')
    expect(q(root, 'stock-prep-operator-project-datalist')!.querySelectorAll('option')).toHaveLength(2)
  })

  it('W-06d 都清了 renders ONLY when the project is real, provisioned and genuinely clear', async () => {
    const root = mountView()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P2.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('nothing_pending')
    expect(empty.textContent).toContain('都清了')
  })

  it('W-06e the four states are genuinely four DIFFERENT sentences', async () => {
    const sentences = Object.values(STOCK_PREP_DIRECTORY_EMPTY_PLAIN).map((entry) => entry.zh)
    expect(new Set(sentences).size, 'no two states may share copy').toBe(sentences.length)
    // ...and the pure decision function orders them as documented.
    const base = { directoryReady: true, ledgerReady: true, projectCount: 2, projectNo: P1.no, projectKnown: true, pendingRowCount: 0 }
    expect(stockPrepDirectoryEmptyState({ ...base, directoryReady: false })).toBe('nothing_synced')
    expect(stockPrepDirectoryEmptyState({ ...base, projectCount: 0 })).toBe('nothing_synced')
    expect(stockPrepDirectoryEmptyState({ ...base, projectKnown: false })).toBe('project_not_found')
    expect(stockPrepDirectoryEmptyState({ ...base, ledgerReady: false })).toBe('ledger_missing')
    expect(stockPrepDirectoryEmptyState(base)).toBe('nothing_pending')
    expect(stockPrepDirectoryEmptyState({ ...base, pendingRowCount: 3 }), 'work waiting means no empty state at all').toBeNull()
    // An empty box is not a mistyped number: with nothing typed, "not found" must not fire.
    expect(stockPrepDirectoryEmptyState({ ...base, projectNo: '', projectKnown: false })).toBe('nothing_pending')
  })

  it('W-07 the directory load does not disable the queue’s own controls', async () => {
    const root = mountView()
    await nextTick()
    // Measured BEFORE the directory request settles: the two concerns are independent, and a shared
    // busy flag would leave the operator unable to click 刷新列表 during a fetch they never asked for.
    const refresh = q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement
    expect(refresh.disabled).toBe(false)
    await flush()
  })

  it('W-08 without the capability: no control, and NO directory request at all', async () => {
    h.permissions = [STOCK_PREP_READ]
    const root = mountView()
    await flush()
    expect(q(root, 'stock-prep-operator-project-directory'), 'not permitted must not be visible').toBeNull()
    expect(q(root, 'stock-prep-operator-project-worklist')).toBeNull()
    expect(q(root, 'stock-prep-operator-project-datalist')!.querySelectorAll('option')).toHaveLength(0)
    expect(directoryCalls(), 'and the client does not even ask').toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // W-10 / W-11 / W-12 — THE PRINCIPALS WHO GET NO DIRECTORY AT ALL
  //
  // The four empty states above are all decided FROM a loaded directory. Three real principals never
  // get one: a `stock-prep:read`-only queue watcher (W-08 correctly issues no request for them), an
  // operate-holder whose load failed, and a tenantless platform admin whom the server refuses by
  // design. Before this fix each of them rendered NOTHING where the pre-change page had said
  // 「都清了」 — a strictly worse answer than the wrong one it replaced. There is now a fifth state
  // for exactly that situation, and it says both halves of the truth: nothing is pending for this
  // number, and we cannot tell you whether the project was ever synced.
  // -------------------------------------------------------------------------

  it('W-10 a stock-prep:read-only watcher still gets an honest empty line, not a blank page', async () => {
    h.permissions = [STOCK_PREP_READ]
    const root = mountView()
    await flush()
    expect(directoryCalls(), 'precondition: no directory is even requested for this tier').toHaveLength(0)
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P1.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')
    expect(empty, 'an empty queue must still say something').not.toBeNull()
    expect(empty!.getAttribute('data-empty-state')).toBe('directory_unavailable')
    // It must not claim the good news it cannot know...
    expect(empty!.textContent).not.toContain('都清了')
    // ...nor blame the admin for a sync that may well have happened.
    expect(empty!.getAttribute('data-empty-state')).not.toBe('nothing_synced')
    expect(empty!.textContent, 'and it says plainly which half is unknown').toContain('项目清单')
  })

  it('W-11 a directory load that FAILS surfaces as an error, and still leaves an honest empty line', async () => {
    routeFetch({ directory: null })
    const root = mountView()
    await flush()
    // A GENUINE failure IS news, and is reported the moment it happens — the silence in W-12 is only
    // for the principals the server refuses by design. (It is then cleared by the next queue action,
    // like every other error on this page: `run()` resets the line before each task.)
    expect(q(root, 'stock-prep-confirmation-error'), 'a 500 is a real failure and still surfaces').not.toBeNull()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')
    expect(empty).not.toBeNull()
    expect(empty!.getAttribute('data-empty-state')).toBe('directory_unavailable')
    expect(empty!.textContent).not.toContain('都清了')
  })

  it('W-12 a principal the server refuses BY DESIGN sees no error banner — just the honest empty line', async () => {
    // The tenantless platform admin: `stock-prep:operate` is satisfied (role:admin short-circuits it),
    // so the client asks — and the server refuses, correctly, because they have no tenant of their
    // own. That is not a fault, and narrating it as one put a write-flavoured red line on every page
    // open for every consultant and support engineer.
    h.roles = ['admin']
    h.permissions = ['integration:admin']
    routeFetch({ directoryError: { status: 403, code: 'OPERATOR_SCOPE_TENANT_REQUIRED' } })
    const root = mountView()
    await flush()
    expect(directoryCalls(), 'precondition: this principal DOES ask').toHaveLength(1)
    expect(q(root, 'stock-prep-confirmation-error'), 'a by-design refusal is not an error to report').toBeNull()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')
    expect(empty).not.toBeNull()
    expect(empty!.getAttribute('data-empty-state')).toBe('directory_unavailable')
    expect(empty!.textContent).not.toContain('都清了')
  })

  it('W-12b …and a deployment with no host directory seam is the same silence, not a red line', async () => {
    routeFetch({ directoryError: { status: 501, code: 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE' } })
    const root = mountView()
    await flush()
    expect(q(root, 'stock-prep-confirmation-error'), 'nothing the operator can act on').toBeNull()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    expect(q(root, 'stock-prep-confirmation-empty')!.getAttribute('data-empty-state')).toBe('directory_unavailable')
  })

  it('W-12c the silence is NARROW: an unrelated refusal still reaches the operator', async () => {
    // The guard must key on the two by-design codes, not on "any 4xx from the directory" — otherwise
    // a genuinely broken deployment would go quiet too.
    routeFetch({ directoryError: { status: 403, code: 'FORBIDDEN' } })
    const root = mountView()
    await flush()
    expect(q(root, 'stock-prep-confirmation-error')).not.toBeNull()
  })

  it('W-09 a degraded payload degrades conservatively — no crash, and never a false “all clear”', async () => {
    // A truncated/older response with no `projects` array at all. The page must still render.
    routeFetch({ directory: { tenantId: SCOPE.tenantId } as unknown as Record<string, unknown> })
    const root = mountView()
    await flush()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    expect(q(root, 'stock-prep-confirmation-project-input'), 'the page is still alive').not.toBeNull()
    const empty = q(root, 'stock-prep-confirmation-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('nothing_synced')
    expect(empty.textContent).not.toContain('都清了')
  })
})
