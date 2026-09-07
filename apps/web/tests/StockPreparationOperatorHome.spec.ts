import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 任务首页 + 下一步条 + 状态徽标 (P0-2/P0-3/P0-6) — the four claims 设计稿 §6.1's P0 acceptance list
// requires this spec to pin:
//
//   H-01 operatorNextStep.ts's SEVEN rules, one test each, in the priority order §4.2 lists them.
//   H-02 "三处同词一致": the home card badge, the workspace title badge, and the composed sync
//        panel's own posture line all render the EXACT SAME string for the same underlying state —
//        proven by mounting all three real components, not by asserting the pure function twice.
//   H-03 G3: a directory read that genuinely failed degrades SILENTLY into the honest
//        `directory_unavailable` empty state — no error banner, no alert role.
//   H-04 the three home empty states (`no_projects` / `nothing_today` / `directory_unavailable`)
//        carry copy that shares nothing between them.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate'] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, roles: [], permissions: h.permissions }),
    hasAdminAccess: () => false,
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationOperatorHome from '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'
import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import { operatorNextStep } from '../src/services/integration/stockPreparation/operatorNextStep'
import { stockPrepPosture } from '../src/services/integration/stockPreparation/projectPosture'
import type { StockPreparationOperatorDirectory } from '../src/services/integration/stockPreparation/confirmationQueue'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const PROJECT_NO = 'P2026-001'

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

function emptyDirectory(): StockPreparationOperatorDirectory {
  return { tenantId: 'tenant-a', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
}

function directoryWith(overrides: Record<string, unknown>): StockPreparationOperatorDirectory {
  return {
    tenantId: 'tenant-a',
    directoryReady: true,
    ledgerReady: true,
    projectCount: 1,
    pendingProjectCount: 0,
    projects: [{
      projectId: 'p1',
      projectNo: PROJECT_NO,
      projectName: null,
      projectStatus: 'active',
      lastSyncRunId: null,
      snapshotBatchCount: 0,
      openExceptionCount: 0,
      heldLineCount: 0,
      readyLineCount: 0,
      pendingDecisionCount: 0,
      ...overrides,
    }],
  }
}

/** Mounts a fresh, isolated instance of a component and returns {root, unmount}. */
function mountIsolated(component: Component, props: Record<string, unknown> = {}): { root: HTMLDivElement; unmount: () => void } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const localApp = createApp(component, props)
  localApp.mount(el)
  return {
    root: el,
    unmount: () => {
      localApp.unmount()
      el.remove()
    },
  }
}

describe('operatorNextStep — 设计稿 §4.2 七条规则(优先级从上到下)', () => {
  const base = {
    boardFound: true,
    pulledRowCount: 10,
    missingComponentsCount: 0,
    pendingDecisionCount: 0,
    justConfirmed: false,
    hasExported: true,
    isCurrentHandler: false,
  }

  it('1. 看板 404 → 从 PLM 拉取', () => {
    const result = operatorNextStep({ ...base, boardFound: false, pulledRowCount: 0 })
    expect(result.action).toBe('pull')
    expect(result.zh).toContain('从 PLM 拉进来')
  })

  it('1b. 从没拉过(board 在,但 0 行)→ 从 PLM 拉取', () => {
    const result = operatorNextStep({ ...base, pulledRowCount: 0 })
    expect(result.action).toBe('pull')
  })

  it('2. 缺件 > 0 → 看缺哪些件', () => {
    const result = operatorNextStep({ ...base, missingComponentsCount: 3 })
    expect(result.action).toBe('view-missing')
    expect(result.zh).toContain('3')
  })

  it('3. pendingDecisionCount > 0 → 现在就处理这 N 件事', () => {
    const result = operatorNextStep({ ...base, pendingDecisionCount: 2 })
    expect(result.action).toBe('go-confirm')
    expect(result.actionZh).toContain('2')
  })

  it('4. 刚确认完(justConfirmed)→ 再同步一次', () => {
    const result = operatorNextStep({ ...base, justConfirmed: true })
    expect(result.action).toBe('resync')
  })

  it('5. 已写入且未导出 → 到多维表填写这个项目', () => {
    const result = operatorNextStep({ ...base, hasExported: false })
    expect(result.action).toBe('open-fill')
  })

  it('6. isCurrentHandler → 通知下一步', () => {
    const result = operatorNextStep({ ...base, isCurrentHandler: true })
    expect(result.action).toBe('notify-next')
  })

  it('7. 全清 → 无主按钮', () => {
    const result = operatorNextStep({ ...base })
    expect(result.action).toBeNull()
    expect(result.actionZh).toBe('')
    expect(result.actionEn).toBe('')
  })

  it('priority: 拉取 beats every other condition even when they are also true', () => {
    const result = operatorNextStep({
      ...base,
      boardFound: false,
      pulledRowCount: 0,
      missingComponentsCount: 5,
      pendingDecisionCount: 5,
      justConfirmed: true,
      isCurrentHandler: true,
    })
    expect(result.action).toBe('pull')
  })

  it('priority: 缺件 beats pendingDecisionCount/justConfirmed/isCurrentHandler', () => {
    const result = operatorNextStep({
      ...base,
      missingComponentsCount: 1,
      pendingDecisionCount: 5,
      justConfirmed: true,
      isCurrentHandler: true,
    })
    expect(result.action).toBe('view-missing')
  })
})

describe('三处徽标同词一致 (P0-6) — home card / workspace title / sync-panel status', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    try { window.localStorage.clear() } catch { /* jsdom always has it; guard anyway */ }
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

  function mount(component: Component, props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(component, props)
    app.mount(container!)
    return container!
  }

  async function flush(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise((done) => { setTimeout(done, 0) })
      await nextTick()
    }
  }

  it('the home card badge says exactly what stockPrepPosture() says', () => {
    const root = mount(StockPreparationOperatorHome, {
      directory: directoryWith({ pendingDecisionCount: 2 }),
      directoryLoaded: true,
    })
    const badge = root.querySelector('[data-testid="stock-prep-operator-home-card-badge"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe(stockPrepPosture({ pendingDecisionCount: 2 }).zh)
  })

  it('the workspace title badge says the SAME word as the home card, for the same live state', async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(emptyDirectory())
      if (path.includes('/board')) {
        return ok({
          tenantId: 'tenant-a', projectId: 'p1', projectNo: PROJECT_NO, projectName: null, projectStatus: 'active',
          lastSyncRunId: null, snapshotBatchCount: 0, openExceptionCount: 0, heldLineCount: 0, readyLineCount: 0,
          archivedSnapshotPresent: false, pullTargetReady: true, pulledRowCount: 12, activePulledRowCount: 12,
          pulledRowCountBounded: false, lastChangedFromPlmAt: null, lastChangedFromPlmBounded: false,
          pendingDecisionCount: 2, lastExportAt: null, fillTarget: null, directoryReady: true, ledgerReady: true,
        })
      }
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })
    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO })
    await flush()
    const badge = root.querySelector('[data-testid="stock-prep-project-board-posture"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe(stockPrepPosture({ pendingDecisionCount: 2 }).zh)
  })

  it('the composed sync panel says the SAME word too, once a run reports the same pending count', async () => {
    const api = {
      dryRun: vi.fn().mockResolvedValue({
        status: 'manual_confirm_required', canApply: true, dryRunToken: 'tok_held',
        counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 2 },
      }),
      reconcile: vi.fn().mockResolvedValue({ counts: { created: 0, existing: 0, pending: 2 } }),
      apply: vi.fn(),
      archive: vi.fn(),
    }
    const root = mount(StockPreparationProjectSyncPanel, { api })
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    input.value = PROJECT_NO
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).click()
    await flush()
    const posture = root.querySelector('[data-testid="stock-prep-project-sync-posture"]') as HTMLElement
    expect(posture).not.toBeNull()
    expect(posture.textContent).toBe(stockPrepPosture({ pendingDecisionCount: 2 }).zh)
  })
})

describe('预读失败静默 (G3) + 空态三值互不共享文案 (P0-2)', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
  })

  it('G3: a genuinely failed directory read renders the honest empty state, never a red banner', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, { directory: null, directoryLoaded: true })
    try {
      const empty = root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
      expect(empty).not.toBeNull()
      expect(empty.getAttribute('data-empty-state')).toBe('directory_unavailable')
      expect(root.querySelector('[role="alert"]')).toBeNull()
      expect(root.querySelector('[data-testid*="error"]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('G3: the FIRST read still in flight is not read as a failure (no flash of directory_unavailable)', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, { directory: null, directoryLoaded: false })
    try {
      const empty = root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
      expect(empty).not.toBeNull()
      expect(empty.getAttribute('data-empty-state')).toBe('no_projects')
    } finally {
      unmount()
    }
  })

  it('空态三值互不共享文案: no_projects / nothing_today / directory_unavailable each say something unique', () => {
    const noProjects = mountIsolated(StockPreparationOperatorHome, { directory: emptyDirectory(), directoryLoaded: true })
    const noProjectsEmpty = noProjects.root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
    const noProjectsState = noProjectsEmpty.getAttribute('data-empty-state')
    const noProjectsText = noProjectsEmpty.textContent ?? ''
    noProjects.unmount()

    // A project that IS known but has nothing waiting: readyLineCount > 0 so its posture is `ready`,
    // never `pending_decision`/`blocked` — actionableCount is 0 and the card grid still renders below.
    const nothingToday = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ readyLineCount: 5 }),
      directoryLoaded: true,
    })
    const nothingTodayEmpty = nothingToday.root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
    const nothingTodayState = nothingTodayEmpty.getAttribute('data-empty-state')
    const nothingTodayText = nothingTodayEmpty.textContent ?? ''
    // The hint says "见下面" — and the card it refers to really is there.
    expect(nothingToday.root.querySelector('[data-testid="stock-prep-operator-home-cards"]')).not.toBeNull()
    nothingToday.unmount()

    const unavailable = mountIsolated(StockPreparationOperatorHome, { directory: null, directoryLoaded: true })
    const unavailableEmpty = unavailable.root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
    const unavailableState = unavailableEmpty.getAttribute('data-empty-state')
    const unavailableText = unavailableEmpty.textContent ?? ''
    unavailable.unmount()

    expect([noProjectsState, nothingTodayState, unavailableState]).toEqual(['no_projects', 'nothing_today', 'directory_unavailable'])
    expect(noProjectsText.length).toBeGreaterThan(0)
    expect(nothingTodayText.length).toBeGreaterThan(0)
    expect(unavailableText.length).toBeGreaterThan(0)
    // Mutually exclusive: no two of the three states render the same words.
    expect(new Set([noProjectsText, nothingTodayText, unavailableText]).size).toBe(3)
  })

  it('no_projects offers the fallback input; nothing_today does not repeat an action it has none of', () => {
    const noProjects = mountIsolated(StockPreparationOperatorHome, { directory: emptyDirectory(), directoryLoaded: true })
    expect(noProjects.root.querySelector('[data-testid="stock-prep-operator-home-empty"] .sp-home__link')).not.toBeNull()
    noProjects.unmount()

    const nothingToday = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ readyLineCount: 5 }),
      directoryLoaded: true,
    })
    expect(nothingToday.root.querySelector('[data-testid="stock-prep-operator-home-empty"] .sp-home__link')).toBeNull()
    nothingToday.unmount()
  })
})
