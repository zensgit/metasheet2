import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h as createElement, nextTick, ref, type App as VueApp, type Component, type Ref } from 'vue'

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
  canOpenStockPrepProjectBoard,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import {
  STOCK_PREP_DIRECTORY_EMPTY_PLAIN,
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
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
  /**
   * A named server refusal for the QUEUE read. Separate from `directoryError` on purpose: the two
   * reads are refused for different reasons and MUST be narrated differently — the directory load
   * is unprompted, so a by-design refusal there is silent, whereas the queue read is something the
   * person just asked for, so a refusal there owes them a sentence. See W-13.
   */
  queueError?: { status: number; code: string }
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
      if (options.queueError) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: options.queueError.code, message: 'refused' } }),
          { status: options.queueError.status },
        )
      }
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

function mountView(extraProps: Record<string, unknown> = {}): HTMLDivElement {
  app = createApp(StockPreparationConfirmationQueueView as Component, { scope: SCOPE, ...extraProps })
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

  it('I-20: 待确认 (等您处理 count) carries a values-free tooltip', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const root = mountView()
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P1.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const counts = q(root, 'stock-prep-confirmation-counts') as HTMLElement
    const span = counts.querySelector('span') as HTMLElement
    expect(span.title).toContain('不是这个项目全部的行数')
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

  it('W-06d / P0-9 nothing_pending renders ONLY when the project is real, provisioned and genuinely clear — with the closure button', async () => {
    const onNavigateStage = vi.fn()
    const root = mountView({ onNavigateStage })
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P2.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    const empty = q(root, 'stock-prep-confirmation-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('nothing_pending')
    // P0-9 (§4.3): the CLOSED-LOOP wording — the good news alone used to be the whole sentence, which
    // told a reader confirming was the end of the job when writing the data still had not happened.
    expect(empty.textContent).toContain('没有要您拿主意的事')
    expect(empty.textContent).toContain('可以回到上面再同步一次')
    expect(empty.textContent).not.toContain('都清了')

    // 线框 D ④ — the sentence is now ALSO a control: 「再同步一次」 goes back to the project board FOR
    // THE SAME PROJECT NUMBER, through the shell's one navigate-stage surface (P0-1/P0-9 wiring).
    const resync = q(root, 'stock-prep-confirmation-empty-resync') as HTMLButtonElement
    expect(resync).not.toBeNull()
    resync.click()
    expect(onNavigateStage).toHaveBeenCalledWith('project-board', P2.no)
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

  // W-13 — W4: the tenant-claim hard door, as the person at the screen experiences it.
  //
  // Server side, `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` makes the whole tenant-facing surface
  // refuse a principal whose tenant was CARRIED in an `x-tenant-id` header rather than PROVEN by the
  // verified token. On the 222 deployment that is, on day one, every administrator — which is why
  // the rollout order re-issues tokens before the flag is set.
  //
  // The refusal must not arrive as 「这一步没有保存成功」. That generic is a WRITE sentence, it is
  // wrong about a read, and worst of all it invites a retry that will never work: a token without a
  // tenant claim will still have none on the next click. The dedicated row says the account is the
  // reason and that waiting is not the fix, and this pins that the page actually reaches for it.
  //
  // NOTE THE CONTRAST WITH W-12, which is the same code on the same page: on the UNPROMPTED directory
  // load it is deliberately silent, because narrating an unasked-for refusal is noise. Here the person
  // just pressed 刷新列表, so silence would be a lie about what happened to their request.
  // ALL THREE, not just the first. The door raises three codes and they have three different
  // remedies — sign in with a factory account / sign in again / switch back to your own factory. Two
  // of them had no row in the table at all and fell through to the generic until W4 added them, so
  // the loop is the guard: a fourth refusal added without copy fails here rather than in front of an
  // operator. `STOCK_PREP_ERROR_PLAIN[code]` is read from the SHIPPED table, so this cannot pass by
  // agreeing with a sentence retyped in the test.
  const TENANT_DOOR_CODES = [
    'OPERATOR_SCOPE_TENANT_REQUIRED',
    'OPERATOR_SCOPE_TENANT_CONTRADICTED',
    'OPERATOR_SCOPE_TENANT_MISMATCH',
  ] as const

  it.each([...TENANT_DOOR_CODES])(
    'W-13 an admin refused by the tenant-claim door with %s reads the sentence written for it, not the write generic',
    async (code) => {
      h.roles = ['admin']
      h.permissions = ['integration:admin']
      routeFetch({ queueError: { status: 403, code } })
      const root = mountView()
      await flush()
      ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
      await flush()

      const line = q(root, 'stock-prep-confirmation-error')
      expect(line, 'a refusal of something the person just asked for is always reported').not.toBeNull()
      const text = line!.textContent ?? ''
      const plain = STOCK_PREP_ERROR_PLAIN[code]
      expect(plain, `${code} must have a row in the shipped plain-language table`).toBeTruthy()
      expect(plain.zh, 'and it must not be empty').not.toBe('')
      expect(text, 'the dedicated sentence, read out of the shipped table rather than retyped here')
        .toContain(plain.zh)
      expect(text, 'and NOT the write-flavoured generic, which would be wrong twice over')
        .not.toContain(STOCK_PREP_ERROR_GENERIC.zh)
      expect(text, 'the enum stays on screen — it is what a person quotes when they ask us for help')
        .toContain(code)
    },
  )

  it('W-13d the three door codes say three DIFFERENT things — one shared sentence would be no copy at all', () => {
    const sentences = TENANT_DOOR_CODES.map((code) => STOCK_PREP_ERROR_PLAIN[code].zh)
    expect(new Set(sentences).size, '每条拒绝有各自的补救方式,句子就必须各不相同').toBe(TENANT_DOOR_CODES.length)
    for (const code of TENANT_DOOR_CODES) {
      expect(STOCK_PREP_ERROR_PLAIN[code].en, `${code} needs the English half too`).not.toBe('')
      expect(STOCK_PREP_ERROR_PLAIN[code].en).not.toBe(STOCK_PREP_ERROR_GENERIC.en)
    }
  })

  // ---------------------------------------------------------------------------
  // P0-7 —— the `ledger_missing` dead end, and who is actually allowed out of it
  // ---------------------------------------------------------------------------

  async function landOnLedgerMissing(extraProps: Record<string, unknown> = {}): Promise<HTMLDivElement> {
    routeFetch({ directory: directoryPayload({ ledgerReady: false, pendingProjectCount: 0 }) })
    const root = mountView(extraProps)
    await flush()
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = P1.no
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
    expect(q(root, 'stock-prep-confirmation-empty')!.getAttribute('data-empty-state')).toBe('ledger_missing')
    return root
  }

  it('P0-7a a platform admin landing on the empty queue gets [去装:开始使用], and it asks the shell for 开始使用', async () => {
    // P1-1 MOVED THE DESTINATION, NOT THE INTENT. 设计稿 §2.3's fix for A1 was always 「把落在空
    // 队列上的管理员送到向导」; while the wizard rode the install page's first screen, `'install'`
    // WAS the way to reach it. Now 开始使用 is its own rail item and the install page renders
    // `mode="review"` (no wizard), so the old stage name would land this reader on a page with no
    // 开始使用 on it — the same dead end, one screen further along. Same button, same testid, same
    // label, same gate; only the name of where it goes changed.
    h.roles = ['admin']
    const onNavigateStage = vi.fn()
    const root = await landOnLedgerMissing({ onNavigateStage })
    const button = q(root, 'stock-prep-confirmation-empty-go-install') as HTMLButtonElement
    expect(button, 'the one dead end this wave closes').not.toBeNull()
    button.click()
    await nextTick()
    expect(onNavigateStage).toHaveBeenCalledWith('getting-started')
  })

  it('P0-7b an operator sees the SAME empty state without that button — it would teleport them to another tab', async () => {
    // `ledger_missing` is reachable by anyone who can read the directory, and the install tab is
    // filtered out of `visibleViews` without `stock-prep:admin`. A button that silently drops this
    // person on their landing tab is a new dead end, not a closed one (R-11「可见即可用」).
    h.permissions = [STOCK_PREP_READ, STOCK_PREP_OPERATE]
    h.roles = []
    const root = await landOnLedgerMissing()
    expect(q(root, 'stock-prep-confirmation-empty-go-install'), 'no button this caller cannot follow').toBeNull()
    // ...and they still get the sentence that tells them what to do instead.
    expect(q(root, 'stock-prep-confirmation-empty')!.textContent).toContain('管理员')
  })

  it('P0-7c the reconcile note (I-13) rides with the reconcile button and says it runs per FACTORY', async () => {
    h.roles = ['admin']
    const root = mountView()
    await flush()
    const note = q(root, 'stock-prep-confirmation-reconcile-note')
    expect(note, 'the note only exists where the button does').not.toBeNull()
    expect(note!.textContent).toContain('按工厂')
    expect(note!.textContent).toContain('不按项目')
  })

  it('P0-7d an operator, who has no reconcile button, is not shown its note either', async () => {
    h.permissions = [STOCK_PREP_READ, STOCK_PREP_OPERATE]
    h.roles = []
    const root = mountView()
    await flush()
    expect(q(root, 'stock-prep-confirmation-reconcile-note')).toBeNull()
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

  // ---------------------------------------------------------------------------
  // P0-1 (F5) — the shell's `:project-no` prop, and the watcher that keeps this view in step with it
  // ---------------------------------------------------------------------------
  //
  // Mounted through a small reactive Harness (the SAME idiom StockPreparationProjectBoard.spec.ts uses
  // for its own prop-watch coverage) rather than through `mountView()`, because the whole point is a
  // PROP CHANGE on an already-mounted instance — something the shell's real v-else-if tab switch does
  // not exercise today (a fresh mount already carries the right seed) but P1's embedded panel, and a
  // deep-link projectNo change while this tab stays active, will.

  function mountWithReactiveProjectNo(initial: string): { projectNoProp: Ref<string> } {
    const projectNoProp = ref(initial)
    const Harness = defineComponent({
      setup() {
        return () => createElement(StockPreparationConfirmationQueueView as Component, {
          scope: SCOPE,
          projectNo: projectNoProp.value,
        })
      },
    })
    app = createApp(Harness)
    app.mount(container!)
    return { projectNoProp }
  }

  function queueCallCount(): number {
    return h.apiFetch.mock.calls.filter((call) => String(call[0]).includes(QUEUE_URL)).length
  }

  it('P0-1: a projectNo prop CHANGE resets the input and reloads that project’s queue', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const { projectNoProp } = mountWithReactiveProjectNo(P1.no)
    await flush()
    const input = () => q(container!, 'stock-prep-confirmation-project-input') as HTMLInputElement
    expect(input().value, 'the initial SEED already carries the shell’s number').toBe(P1.no)
    // No onMounted/no watcher firing on mount (StockPreparationHandoff.spec.ts’s own contract): the
    // seed alone filled the box, and nothing was fetched for it yet.
    expect(queueCallCount()).toBe(0)

    projectNoProp.value = P2.no
    await flush()
    expect(input().value, 'the watcher resets the box to the NEW number').toBe(P2.no)
    expect(queueCallCount(), 'and reloads — the same project a colleague’s worklist row would open').toBe(1)
    const lastQueueCall = h.apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(QUEUE_URL)).pop()
    expect(lastQueueCall).toContain(`projectNo=${P2.no}`)
  })

  it('P0-1: an EMPTIED projectNo only resets the box — it does not fetch for no project at all', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const { projectNoProp } = mountWithReactiveProjectNo(P1.no)
    await flush()
    expect(queueCallCount()).toBe(0)

    projectNoProp.value = ''
    await flush()
    expect((q(container!, 'stock-prep-confirmation-project-input') as HTMLInputElement).value).toBe('')
    expect(queueCallCount(), 'an empty number is not a project to load a queue for').toBe(0)
  })

  // ---------------------------------------------------------------------------
  // W-09b 「读不出来」不能渲染成「没有」(G4) —— the queue read answered 200 with something that is
  // not a queue
  // ---------------------------------------------------------------------------
  //
  // The real shape of this failure in this repo: an SPA-fallback proxy answering `200 text/html` for
  // an API path (r12–r16 shipped exactly that; the install page carries a dedicated guard for it).
  // `parseStockPreparationConfirmResponse` cannot parse it, so the client hands the view `undefined`.
  // Filling that in with zeros would render 「没有要您拿主意的事」 plus an action button — the page
  // stating, with confidence, that a project is clear because it could not read it.

  function routeUnreadableQueue(body: BodyInit, contentType: string): void {
    h.apiFetch.mockImplementation(async (url: string) => {
      if (String(url).includes(DIRECTORY_URL)) {
        return new Response(JSON.stringify({ ok: true, data: directoryPayload() }), { status: 200 })
      }
      if (String(url).includes(QUEUE_URL)) {
        return new Response(body, { status: 200, headers: { 'content-type': contentType } })
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })
  }

  async function typeAndRefresh(root: HTMLElement, projectNo: string): Promise<void> {
    const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
    input.value = projectNo
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()
  }

  it('W-09b a 200 that is not a queue at all says 读不出来 — it never claims 没有要您拿主意的事', async () => {
    routeUnreadableQueue('<!doctype html><html><body>app shell</body></html>', 'text/html')
    const root = mountView()
    await flush()
    await typeAndRefresh(root, P2.no)

    expect(q(root, 'stock-prep-confirmation-empty'), 'an unread queue is not an empty queue').toBeNull()
    expect(q(root, 'stock-prep-confirmation-empty-resync'), 'and it certainly does not hand out an action button').toBeNull()
    expect(q(root, 'stock-prep-confirmation-counts'), 'nor a 等您处理: 0 that nothing supports').toBeNull()
    const error = q(root, 'stock-prep-confirmation-error')!
    expect(error).not.toBeNull()
    expect(error.querySelector('code')?.textContent).toBe('STOCK_PREPARATION_DECISION_QUEUE_UNREADABLE')
    expect(error.textContent).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_DECISION_QUEUE_UNREADABLE.zh)
  })

  it('W-09b an envelope with no queue in it leaves the LAST GOOD queue on screen rather than blanking it', async () => {
    routeFetch({ queueRows: [pendingRow()] })
    const root = mountView()
    await flush()
    await typeAndRefresh(root, P1.no)
    expect(all(root, 'stock-prep-confirmation-row')).toHaveLength(1)

    routeUnreadableQueue(JSON.stringify({ ok: true, data: {} }), 'application/json')
    ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()

    expect(all(root, 'stock-prep-confirmation-row'), 'the row that WAS read stays — it is still the last thing known').toHaveLength(1)
    expect(q(root, 'stock-prep-confirmation-error')?.querySelector('code')?.textContent)
      .toBe('STOCK_PREPARATION_DECISION_QUEUE_UNREADABLE')
    expect(q(root, 'stock-prep-confirmation-empty')).toBeNull()
  })

  it('W-09b a PARTIAL but genuinely queue-shaped payload is still filled in defensively, not rejected', async () => {
    // The other half of the same discipline: a payload that IS a queue but predates a field must not
    // crash the render (the old code left `rows` undefined and the next render threw) and must not be
    // treated as unreadable either — it carries a real row count.
    routeUnreadableQueue(JSON.stringify({ ok: true, data: { rowCount: 3 } }), 'application/json')
    const root = mountView()
    await flush()
    await typeAndRefresh(root, P2.no)

    expect(q(root, 'stock-prep-confirmation-error'), 'a queue-shaped payload is not an error').toBeNull()
    expect(q(root, 'stock-prep-confirmation-counts')!.textContent).toContain('3')
  })

  // ---------------------------------------------------------------------------
  // P0-9 — 「再同步一次」 is gated on WHO CAN ACTUALLY ARRIVE at 项目备料页 (R-11「可见即可用」)
  // ---------------------------------------------------------------------------
  //
  // The button navigates to the `project-board` tab, whose predicate is `canOpenStockPrepProjectBoard`
  // = operate ∧ read. Its SIBLING in the same `<p>` (去装:开始使用) is gated on the install tab's
  // predicate for exactly this reason: a button that teleports someone to a tab they cannot see is a
  // NEW dead end, not a closed one — it sets `activeKey`, the shell folds it back to their landing
  // tab, and the screen does not move.
  //
  // IS IT REACHABLE TODAY? No — and this case says so rather than pretending otherwise. The directory
  // read that produces every one of these empty states is an OPERATE-tier capability, and
  // `canStockPrepCapability` computes that tier as the SAME conjunction (operate ∧ read). So the two
  // predicates coincide for every principal, and the gate is defence in depth. What this pins is the
  // coincidence itself plus the coupling: the button's presence tracks the BOARD predicate, so on the
  // day either side moves, the button stops being offered instead of quietly becoming inert.

  it('P0-9: 再同步一次 is offered exactly to the callers who can open 项目备料页', async () => {
    const principals: string[][] = [
      [STOCK_PREP_READ],
      [STOCK_PREP_OPERATE],
      [STOCK_PREP_READ, STOCK_PREP_OPERATE],
    ]
    for (const permissions of principals) {
      h.permissions = [...permissions]
      routeFetch()
      // The prop watcher rather than 刷新列表: that control is READ-tier, and two of these three
      // principals do not have it — the watcher is how the queue can load for any of them.
      const { projectNoProp } = mountWithReactiveProjectNo('')
      await flush()
      projectNoProp.value = P2.no
      await flush()

      const mayOpenBoard = canOpenStockPrepProjectBoard(realHasPermission)
      const label = JSON.stringify(permissions)
      expect(
        Boolean(q(container!, 'stock-prep-confirmation-empty-resync')),
        `${label}: the button is offered iff the tab it navigates to is`,
      ).toBe(mayOpenBoard)
      // The DIRECTORY control is the OPERATE-tier capability in DOM form. Its presence matching the
      // board predicate is what makes the empty state unreachable for the two who cannot act on it —
      // the coincidence the paragraph above depends on, asserted rather than assumed.
      expect(
        Boolean(q(container!, 'stock-prep-operator-project-directory')),
        `${label}: the directory tier and the board tier are the same conjunction today`,
      ).toBe(mayOpenBoard)
      if (mayOpenBoard) {
        // ...and for the one who CAN, the sentence and the control say the same thing.
        expect(q(container!, 'stock-prep-confirmation-empty')!.textContent).toContain('可以回到上面再同步一次')
      }

      if (app) app.unmount()
      app = null
      container!.innerHTML = ''
      h.apiFetch.mockClear()
    }
  })

  // ---------------------------------------------------------------------------
  // 目录行的 :key —— projectId 优先,因为它才是可证明唯一的那个
  // ---------------------------------------------------------------------------
  //
  // The server de-duplicates by `projectNo` only BETWEEN the pull-target and archived halves of the
  // union; two ARCHIVED rows are upserted by `projectId` and nothing on the write path forces
  // `projectId` and `sourceProjectNo` to be 1:1. So "two rows, different projectId, same projectNo" is
  // a state the store allows — and keying on `projectNo` would collide there, which for the worklist
  // means two <li> buttons sharing one key.

  it('two archived rows sharing a projectNo still get distinct keys (projectId first)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = mountView()
      await flush()
      expect(q(root, 'stock-prep-operator-project-datalist')!.querySelectorAll('option')).toHaveLength(2)

      // A REFRESH (a patch, not a first render) is what makes Vue check keys at all — and the two
      // colliding rows have to land in the same unkeyed-middle run for the check to reach them, which
      // is why the refreshed list leads with the twins and ends on a row the old list started with.
      const twins = [
        { ...project(P2, 0), projectId: 'stockprep_archive_a' },
        { ...project(P2, 0), projectId: 'stockprep_archive_b', projectName: `${P2.name} 2` },
        project(P1, 0),
      ]
      routeFetch({ directory: directoryPayload({ projects: twins, projectCount: 3, pendingProjectCount: 0 }) })
      ;(q(root, 'stock-prep-operator-project-directory') as HTMLButtonElement).click()
      await flush()

      expect(q(root, 'stock-prep-operator-project-datalist')!.querySelectorAll('option')).toHaveLength(3)
      const duplicates = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Duplicate keys'))
      expect(duplicates, 'keying on projectNo would collide here; projectId does not').toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})
