import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

/**
 * `confirmationQueue.ts` is the client for the ONLY tab a floor stock-prep operator can see
 * (O1' ruling — docs/development/takeover-beiliao-20260821/o1-ruling-20260829.md §附). It had ZERO
 * spec coverage before this file. That absence is what let the three read routes ship building their
 * request URL as `${path}${query}` — `buildQueryString` (workbench.ts) returns a BARE
 * `a=1&b=2` querystring with no leading `?`, and `apiFetch` (utils/api.ts) does no normalization
 * (`fetch(\`${base}${path}\`)`), so a non-empty query merged straight into the path with no separator,
 * e.g. `/api/.../confirmation-decisionsprojectNo=230920006` — a guaranteed 404. `projectNo` is
 * REQUIRED on the list call and `decisionId` is required on the value-entry call, so those two were
 * ALWAYS broken; the readiness call broke only when tenantId/workspaceId were set.
 *
 * Modeled on approval-comments-client.spec.ts's approach: mock `../src/utils/api`'s `apiFetch`
 * directly and assert on the URL string it was called with.
 */
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// P0-8's shell-mounting describe block (below) needs the same three composables every other
// component-level stock-prep spec mocks. Kept as plain module state (not `vi.hoisted`) — the SAME
// idiom `apiFetchMock` above already relies on: both this and the `vi.mock` calls below sit ABOVE
// every `import` in this file, so no reordering is needed for the factories to see them initialised.
const shellState = { locale: 'zh-CN', permissions: ['integration:admin', 'stock-prep:read'] as string[] }

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(shellState.locale),
    isZh: ref(shellState.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    // `roles` / `permissions` are the shape `workbenchAccess.ts` decides on (it takes the SNAPSHOT,
    // never the expanding probe), so this double has to carry them or every stock-prep predicate
    // reads an empty principal.
    getAccessSnapshot: () => ({ isAdmin: false, email: '', roles: [], permissions: shellState.permissions }),
    hasPermission: (permission: string) => shellState.permissions.includes(permission),
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import {
  listStockPreparationDecisions,
  readStockPreparationDecisionReadiness,
  readStockPreparationValueEntry,
} from '../src/services/integration/stockPreparation/confirmationQueue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import StockPreparationConfirmationQueueView from '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'
import { STOCK_PREP_ADMIN_ACTION_PLAIN, stockPrepErrorPlain } from '../src/services/integration/stockPreparation/plainLanguage'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('confirmationQueue request URLs (O1 — the query string must be separated from the path by "?")', () => {
  it('listStockPreparationDecisions: a projectNo (ALWAYS present — required on this call) is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { rowCount: 0, byStatus: {}, byResolutionAction: {}, parkedCount: 0, rows: [] },
    }))

    await listStockPreparationDecisions({ projectNo: '230920006' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions?projectNo=230920006')
    expect(url).toContain('?projectNo=')
    // The historical bug's exact shape — never regress to this.
    expect(url).not.toBe('/api/integration/stock-preparation/confirmation-decisionsprojectNo=230920006')
  })

  it('readStockPreparationValueEntry: a decisionId (ALWAYS present — required on this call) is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: {
        decisionId: 'stockprep_confirm_decision_0123456789abcdef',
        conflictType: null,
        status: null,
        resolutionAction: null,
        inputFingerprint: null,
        valueEntry: { resolvedValue: null, resolvedAuxValue: null, notes: null },
      },
    }))

    await readStockPreparationValueEntry({ decisionId: 'stockprep_confirm_decision_0123456789abcdef' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/value-entry?decisionId=stockprep_confirm_decision_0123456789abcdef')
    expect(url).toContain('?decisionId=')
  })

  it('readStockPreparationDecisionReadiness: a set tenantId/workspaceId is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { ready: true } }))

    await readStockPreparationDecisionReadiness({ tenantId: 'default', workspaceId: 'ws_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/readiness?tenantId=default&workspaceId=ws_1')
    expect(url).toContain('?tenantId=')
  })

  it('readStockPreparationDecisionReadiness: an all-empty scope produces a path with NO trailing "?" (the fix must not overcorrect into a dangling "?")', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { ready: true } }))

    await readStockPreparationDecisionReadiness({})

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/readiness')
    expect(url.endsWith('?')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P0-8 — action → result → AUTO-RELOAD. Mounts the REAL shell (StockPreparationWorkspace), because
// the reconcile call and the reload-after-success wiring both live there, not in the queue view
// alone: the shell owns the POST, and the queue only exposes `loadQueue()` for the shell to call.
// ---------------------------------------------------------------------------

describe('P0-8 — 对账(reconcile)成功后队列自动重读,失败不重读', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null
  const PROJECT_NO = '230920006'

  function directoryPayload(): Record<string, unknown> {
    return { tenantId: 'default', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
  }

  function queuePayload(rowCount: number): Record<string, unknown> {
    return { rowCount, byStatus: {}, byResolutionAction: {}, parkedCount: 0, rows: [] }
  }

  function ok(data: unknown): Response {
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
  }

  async function flush(cycles = 8): Promise<void> {
    for (let turn = 0; turn < cycles; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  beforeEach(() => {
    shellState.locale = 'zh-CN'
    shellState.permissions = ['integration:admin', 'stock-prep:read']
    apiFetchMock.mockReset()
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

  /**
   * Mount the shell and put 确认队列 on screen.
   *
   * THE TAB CLICK IS NOT DECORATION. This block's actor holds `integration:admin`, and since PR #5555
   * the workbench counts that as a platform admin exactly as the server always has — so D2 lands them
   * on 开始使用 (a not-installed deployment) rather than on the queue. The queue is still one click
   * away and is still theirs; these tests are about what 对账 / 建立确认账本 do once it is open, so
   * they open it. Asserting the landing is stockPrepPermissionMatrix.spec.ts / StockPreparationRail
   * .spec.ts's job, not this file's.
   */
  async function mountShellOnTheQueue(): Promise<void> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush()
    const tab = container!.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement | null
    expect(tab, '确认队列 must still be a tab this actor can open').not.toBeNull()
    tab!.click()
    await flush()
  }

  async function openQueueFor(projectNo: string): Promise<void> {
    await mountShellOnTheQueue()
    const input = container!.querySelector('[data-testid="stock-prep-confirmation-project-input"]') as HTMLInputElement
    input.value = projectNo
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(container!.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement).click()
    await flush()
  }

  function countsText(): string {
    return container!.querySelector('[data-testid="stock-prep-confirmation-counts"]')?.textContent ?? ''
  }

  it('a SUCCESSFUL reconcile reloads the queue on THIS SAME tab — no manual refresh needed', async () => {
    let queueGetCount = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (method === 'POST' && path.includes('/confirmation-decisions/reconcile')) {
        return ok({ counts: { created: 0, existing: 0, pending: 5 } })
      }
      if (method === 'GET' && path.includes('/confirmation-decisions')) {
        queueGetCount += 1
        // The FIRST read (the operator's own 刷新列表 press) sees nothing pending; the SECOND — the
        // auto-reload this test is about, pressed by nobody — sees what the reconcile just found.
        return ok(queuePayload(queueGetCount === 1 ? 0 : 5))
      }
      return ok({})
    })

    await openQueueFor(PROJECT_NO)
    expect(queueGetCount, 'the operator\'s own 刷新列表 press').toBe(1)
    expect(countsText()).toContain('0')

    ;(container!.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    await flush()

    expect(queueGetCount, 'the shell reloaded the queue after the reconcile succeeded — nobody pressed refresh a second time').toBe(2)
    expect(countsText()).toContain('5')
  })

  it('a FAILED reconcile does NOT reload the queue — the numbers on screen are exactly what they were', async () => {
    let queueGetCount = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (method === 'POST' && path.includes('/confirmation-decisions/reconcile')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'no' } }), { status: 403 })
      }
      if (method === 'GET' && path.includes('/confirmation-decisions')) {
        queueGetCount += 1
        return ok(queuePayload(0))
      }
      return ok({})
    })

    await openQueueFor(PROJECT_NO)
    expect(queueGetCount).toBe(1)

    ;(container!.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    await flush()

    // The refusal DID produce a notice — but it did not trigger a second queue read.
    expect(container!.querySelector('[data-testid="stock-prep-admin-action-notice"]')).not.toBeNull()
    expect(queueGetCount, 'a failure reloads nothing — the numbers on screen stay exactly what they were').toBe(1)
  })

  // 验收 9's other half: 「页面上不再出现『再手动点一次刷新』」. The reload above is only half the fix —
  // while the success sentence still ended with 「请点上面的「刷新列表」」 the screen said both things at
  // once, and the copy contradicted the behaviour rather than describing it.
  it('验收 9: the success notice does not send the reader back to a button the shell already pressed', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (method === 'POST' && path.includes('/confirmation-decisions/reconcile')) return ok({ counts: {} })
      if (method === 'GET' && path.includes('/confirmation-decisions')) return ok(queuePayload(0))
      return ok({})
    })

    await openQueueFor(PROJECT_NO)
    ;(container!.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    await flush()

    const notice = container!.querySelector('[data-testid="stock-prep-admin-action-notice"]')!
    expect(notice.textContent).toContain('已经重新扫描过一遍')
    expect(notice.textContent, 'the queue was reloaded FOR them — telling them to press it is now a lie').not.toContain('刷新列表')
    // Read from the SHIPPED table, so the sentence cannot be fixed on screen and left stale at source.
    expect(STOCK_PREP_ADMIN_ACTION_PLAIN.RECONCILE_OK.zh).not.toContain('刷新列表')
    expect(STOCK_PREP_ADMIN_ACTION_PLAIN.RECONCILE_OK.en).not.toContain('Refresh the list')
  })

  // I-18 says 「任一管理动作完成 → 动作 → 结果 → 自动重读」, and 建立确认账本 is the action whose result is
  // most visible: it flips `ledgerReady`, which is what the `ledger_missing` empty state (and its
  // 去装 button) hangs off. That flag arrives in the DIRECTORY payload, so the DIRECTORY is what has
  // to be re-read — reloading the queue would leave the dead end sitting there until a manual refresh.
  it('P0-8: a successful 建立确认账本 re-reads the directory, so the ledger_missing dead end does not survive its own fix', async () => {
    shellState.permissions = ['integration:admin', 'stock-prep:read', 'stock-prep:operate']
    let directoryGetCount = 0
    let ledgerReady = false
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      if (path.includes('/operator/projects')) {
        directoryGetCount += 1
        return ok({ ...directoryPayload(), ledgerReady })
      }
      if (method === 'POST' && path.includes('/confirmation-decisions/ensure')) {
        ledgerReady = true
        return ok({})
      }
      if (method === 'GET' && path.includes('/confirmation-decisions')) return ok(queuePayload(0))
      return ok({})
    })

    await mountShellOnTheQueue()
    expect(directoryGetCount, 'the queue reads its directory once on mount').toBe(1)

    ;(container!.querySelector('[data-testid="stock-prep-confirmation-ensure"]') as HTMLButtonElement).click()
    await flush()

    expect(container!.querySelector('[data-testid="stock-prep-admin-action-notice"]')?.textContent).toContain('确认账本已经就位')
    expect(directoryGetCount, 'and re-reads it once the table it was waiting for exists').toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P1-2 (§6.2 P1-2) — the `embedded` prop, mounted directly (not through the shell): the three claims
// StockPreparationProjectBoardView's own Panel 2 depends on. The non-embedded half of each assertion
// is what proves the "一个字节不改" guarantee — every render checked below with `embedded` OMITTED is
// byte-for-byte the render path this view had before this prop existed.
// ---------------------------------------------------------------------------

describe('P1-2 — the `embedded` prop (composed by StockPreparationProjectBoardView\'s Panel 2)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null
  const PROJECT_NO = '230920006'

  function ok(data: unknown): Response {
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
  }

  function directoryPayload(pendingDecisionCount = 0): Record<string, unknown> {
    return {
      tenantId: 'default',
      directoryReady: true,
      ledgerReady: true,
      projectCount: 1,
      pendingProjectCount: pendingDecisionCount > 0 ? 1 : 0,
      projects: [{
        projectId: 'stockprep_project_a1',
        projectNo: PROJECT_NO,
        projectName: 'RY2注射水缓冲罐部件',
        projectStatus: 'active',
        lastSyncRunId: null,
        snapshotBatchCount: 0,
        openExceptionCount: 0,
        heldLineCount: 0,
        readyLineCount: 0,
        pendingDecisionCount,
      }],
    }
  }

  /** Two confirmed, zero pending — `nothing_pending` (the resync button's own empty state) AND a
   *  non-trivial progress ratio (已处理 2 / 共 2) in one fixture. */
  function queuePayload(): Record<string, unknown> {
    return { rowCount: 2, byStatus: { confirmed: 2, pending: 0 }, byResolutionAction: {}, parkedCount: 0, rows: [] }
  }

  /** The bare LIST route only — `/confirmation-decisions` immediately followed by `?` or end of
   *  string. NOT a `path.includes('/confirm')` check: `'/confirmation-decisions'.includes('/confirm')`
   *  is itself `true` (the word "confirmation" starts with "confirm"), which would silently exclude
   *  this exact call — the sibling `/confirmation-decisions/confirm` action route is a DIFFERENT path
   *  with a `/` before the differing suffix, so anchoring on that `/` is what tells them apart. */
  function isDecisionsListUrl(path: string): boolean {
    return /\/confirmation-decisions(\?|$)/.test(path)
  }

  async function flush(cycles = 6): Promise<void> {
    for (let turn = 0; turn < cycles; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  beforeEach(() => {
    shellState.locale = 'zh-CN'
    shellState.permissions = ['stock-prep:read', 'stock-prep:operate']
    apiFetchMock.mockReset()
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

  function mount(props: Record<string, unknown>): HTMLDivElement {
    app = createApp(StockPreparationConfirmationQueueView as Component, {
      scope: { tenantId: 'default' },
      ...props,
    })
    app.mount(container!)
    return container!
  }

  it('P1-2: embedded hides the project-no input and the scope title; non-embedded keeps both unchanged', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      return ok({})
    })

    const embedded = mount({ projectNo: PROJECT_NO, embedded: true })
    await flush()
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-project-input"]')).toBeNull()
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-scope"]')).toBeNull()
    // The controls that act on THIS view alone stay: they do what they say in either mode.
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]')).not.toBeNull()
    expect(
      embedded.querySelector('[data-testid="stock-prep-operator-project-directory"]'),
      'the directory read still decides WHICH empty state 面板 2 shows, so its retry stays',
    ).not.toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    const standalone = mount({ projectNo: PROJECT_NO })
    await flush()
    expect(
      standalone.querySelector('[data-testid="stock-prep-confirmation-project-input"]'),
      'non-embedded (the confirmation-queue TAB, unchanged): the input renders exactly as before',
    ).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-confirmation-scope"]')).not.toBeNull()
  })

  it('P1-2 (G4): embedded hides the status filter — a filtered `byStatus` would let the host draw a full green bar over open rows', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      return ok({})
    })

    const embedded = mount({ projectNo: PROJECT_NO, embedded: true })
    await flush()
    expect(
      embedded.querySelector('[data-testid="stock-prep-confirmation-status-filter"]'),
      'the server tallies byStatus over the rows the FILTER returned, and the host 进度条 reads that field',
    ).toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    const standalone = mount({ projectNo: PROJECT_NO })
    await flush()
    expect(
      standalone.querySelector('[data-testid="stock-prep-confirmation-status-filter"]'),
      'the TAB keeps it — there is no progress bar there for a filtered tally to mislead',
    ).not.toBeNull()
  })

  it('P1-2 (R-11): embedded renders NO control whose click goes nowhere and NO second way to change project', async () => {
    // `integration:admin` is the code the two PLATFORM_ADMIN_GATE capabilities actually probe
    // (workbenchAccess.ts's `canStockPrepCapability`), so this is the account that sees both buttons.
    shellState.permissions = ['integration:admin', 'stock-prep:read', 'stock-prep:operate']
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      // A project with work waiting — otherwise the worklist is data-empty and proves nothing.
      if (path.includes('/operator/projects')) return ok(directoryPayload(4))
      return ok({})
    })

    const embedded = mount({ projectNo: PROJECT_NO, embedded: true })
    await flush()
    // The two `admin-action` emitters: the host that composes this view is NOT the shell, so nothing
    // would answer them there.
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-ensure"]')).toBeNull()
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-reconcile"]')).toBeNull()
    expect(
      embedded.querySelector('[data-testid="stock-prep-confirmation-reconcile-note"]'),
      'and the note describing that scan goes with it — it describes an action that is not on screen',
    ).toBeNull()
    // The cross-project worklist: `pickProject` rewrites this view's OWN projectNo, which in a host
    // would point 面板 2 at another project while the whole page above stayed on this one.
    expect(embedded.querySelector('[data-testid="stock-prep-operator-project-worklist"]')).toBeNull()
    expect(embedded.querySelector('[data-testid="stock-prep-operator-project-pick"]')).toBeNull()
    // G1: the host renders its own 导出 / 通知下一步 for the same project.
    expect(embedded.querySelector('[data-testid="stock-prep-confirmation-export"]')).toBeNull()
    expect(embedded.querySelector('[data-testid="stock-prep-handoff-advance"]')).toBeNull()
    expect(embedded.querySelector('[data-testid="stock-prep-handoff-status"]')).toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // THE OTHER HALF: every one of those is still exactly where it was on the confirmation-queue TAB,
    // for the same account. Nothing above is a capability change.
    const standalone = mount({ projectNo: PROJECT_NO })
    await flush()
    expect(standalone.querySelector('[data-testid="stock-prep-confirmation-ensure"]')).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-confirmation-reconcile"]')).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-confirmation-reconcile-note"]')).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-operator-project-worklist"]')).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-operator-project-pick"]')).not.toBeNull()
    expect(standalone.querySelector('[data-testid="stock-prep-confirmation-export"]')).not.toBeNull()
  })

  it('P1-2: embedded fetches the PARENT-supplied projectNo — no typing required to see this project\'s queue', async () => {
    let requestedProjectNo = ''
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (isDecisionsListUrl(path)) {
        requestedProjectNo = decodeURIComponent(path.match(/projectNo=([^&]+)/)?.[1] ?? '')
        return ok(queuePayload())
      }
      return ok({})
    })

    const root = mount({ projectNo: PROJECT_NO, embedded: true })
    await flush()
    // The input is gone (asserted above); the queue's own 刷新列表 button — untouched by `embedded` —
    // is what a host presses (StockPreparationProjectBoardView's Panel 2 does this via `loadQueue()`
    // through the exposed ref; pressing the same control by hand here proves the SAME code path).
    ;(root.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement).click()
    await flush()
    expect(requestedProjectNo, 'the request went out for the PROP\'S number — nothing was typed').toBe(PROJECT_NO)
    expect(root.querySelector('[data-testid="stock-prep-confirmation-counts"]')?.textContent).toContain('2')
  })

  it('P1-2: embedded routes 「回到上面再同步一次」 through `embedded-resync`, never a tab switch; non-embedded keeps `navigate-stage`', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (isDecisionsListUrl(path)) return ok(queuePayload())
      return ok({})
    })

    const navigateStageSpy = vi.fn()
    const embeddedResyncSpy = vi.fn()
    const root = mount({
      projectNo: PROJECT_NO,
      embedded: true,
      onNavigateStage: navigateStageSpy,
      onEmbeddedResync: embeddedResyncSpy,
    })
    await flush()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement).click()
    await flush()
    const resync = root.querySelector('[data-testid="stock-prep-confirmation-empty-resync"]') as HTMLButtonElement
    expect(resync, 'nothing_pending (2 confirmed, 0 pending) renders the closed-loop button').not.toBeNull()
    expect(
      resync.textContent?.trim(),
      '线框 D ④ writes the embedded label out in full — it goes back UP the page, and says so',
    ).toBe('回到上面再同步一次')
    resync.click()
    await flush()
    expect(embeddedResyncSpy, 'embedded mode: the host handles it — the panel is already "上面"').toHaveBeenCalledTimes(1)
    expect(navigateStageSpy, 'and it must NOT also ask the shell to switch tabs').not.toHaveBeenCalled()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // Non-embedded (the confirmation-queue TAB): the SAME button keeps its ORIGINAL behaviour.
    const standaloneNavigateSpy = vi.fn()
    const standaloneResyncSpy = vi.fn()
    const standalone = mount({
      projectNo: PROJECT_NO,
      onNavigateStage: standaloneNavigateSpy,
      onEmbeddedResync: standaloneResyncSpy,
    })
    await flush()
    ;(standalone.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement).click()
    await flush()
    const standaloneResync = standalone.querySelector('[data-testid="stock-prep-confirmation-empty-resync"]') as HTMLButtonElement
    expect(
      standaloneResync.textContent?.trim(),
      'the TAB keeps the short label it always had — there is no "上面" to go back to from here',
    ).toBe('再同步一次')
    standaloneResync.click()
    await flush()
    expect(standaloneNavigateSpy).toHaveBeenCalledWith('project-board', PROJECT_NO)
    expect(standaloneResyncSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2026-09-10 field report (a): 确认队列点「导出物料清单(Excel)」→ the export route answers 404
// PREP_LINE_EXPORT_PROJECT_NOT_FOUND when the project table has never had a stock-preparation row
// written to it (e.g. all 1137 rows still sitting in the confirmation queue). The export client
// already forwards `error.code` from the response body (confirmationQueue.ts's
// `exportStockPreparationPrepLines`); this closes the OTHER half — the view must resolve that code
// through `stockPrepErrorPlain`, not the generic write-shaped `STOCK_PREPARATION_EXPORT_REQUEST_FAILED`
// fallback its own `recordError` used before this code had a row in the table.
// ---------------------------------------------------------------------------
describe('2026-09-10: export failure names the actual reason, not the generic write-shaped fallback', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null
  const PROJECT_NO = '230920006'

  function ok(data: unknown): Response {
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
  }

  function directoryPayload(): Record<string, unknown> {
    return { tenantId: 'default', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
  }

  function queuePayload(rows: unknown[] = []): Record<string, unknown> {
    return { rowCount: rows.length, byStatus: {}, byResolutionAction: {}, parkedCount: 0, rows }
  }

  function row(conflictType: string, decisionId = 'decision_1'): Record<string, unknown> {
    return {
      decisionId,
      conflictType,
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

  async function flush(cycles = 8): Promise<void> {
    for (let turn = 0; turn < cycles; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  function q(testid: string): HTMLElement | null {
    return container!.querySelector(`[data-testid="${testid}"]`)
  }

  beforeEach(() => {
    shellState.locale = 'zh-CN'
    shellState.permissions = ['stock-prep:read', 'stock-prep:operate']
    apiFetchMock.mockReset()
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

  function mount(): HTMLDivElement {
    app = createApp(StockPreparationConfirmationQueueView as Component, { scope: { tenantId: 'default' }, projectNo: PROJECT_NO })
    app.mount(container!)
    return container!
  }

  it('a 404 PREP_LINE_EXPORT_PROJECT_NOT_FOUND renders its own plain-language sentence, never the generic export fallback', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (path.includes('/confirmation-decisions')) return ok(queuePayload())
      if (path.includes('/prep-lines/export')) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: 'PREP_LINE_EXPORT_PROJECT_NOT_FOUND', message: 'no stock-preparation rows exist for this project' } }),
          { status: 404 },
        )
      }
      return ok({})
    })

    mount()
    await flush()
    ;(q('stock-prep-confirmation-export') as HTMLButtonElement).click()
    await flush()

    const errorNode = q('stock-prep-confirmation-error')
    expect(errorNode, 'the export failure must surface on the shared error line').not.toBeNull()
    expect(errorNode!.textContent).toContain(stockPrepErrorPlain('PREP_LINE_EXPORT_PROJECT_NOT_FOUND').zh)
    expect(errorNode!.textContent, 'the read-shaped, actionable sentence — not the generic write fallback').not.toContain('导出没有做完')
    expect(errorNode!.textContent).toContain('PREP_LINE_EXPORT_PROJECT_NOT_FOUND')
  })

  it('「什么情况」renders the plain-language conflict type, with the raw server token kept in `title`', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (path.includes('/confirmation-decisions')) return ok(queuePayload([row('SOURCE_VALUE_NOT_A_STRING')]))
      return ok({})
    })

    mount()
    await flush()
    ;(q('stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()

    const cell = q('stock-prep-confirmation-conflict-type')
    expect(cell, '什么情况 cell renders for the row').not.toBeNull()
    expect(cell!.textContent).toBe('源值不是文本(多为数字型属性)')
    expect(cell!.textContent).not.toContain('SOURCE_VALUE_NOT_A_STRING')
    expect(cell!.getAttribute('title')).toBe('SOURCE_VALUE_NOT_A_STRING')
  })

  it('an unknown/future conflict type keeps rendering its raw token (fail-soft), title matches the visible text', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (path.includes('/confirmation-decisions')) return ok(queuePayload([row('some_future_conflict_type')]))
      return ok({})
    })

    mount()
    await flush()
    ;(q('stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
    await flush()

    const cell = q('stock-prep-confirmation-conflict-type')
    expect(cell!.textContent).toBe('some_future_conflict_type')
    expect(cell!.getAttribute('title')).toBe('some_future_conflict_type')
  })
})
