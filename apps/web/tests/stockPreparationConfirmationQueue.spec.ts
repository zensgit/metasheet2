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
    getAccessSnapshot: () => ({ isAdmin: false, email: '' }),
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

  async function openQueueFor(projectNo: string): Promise<void> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush()
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
})
