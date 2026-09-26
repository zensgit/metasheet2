import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 任务首页 + 下一步条 + 状态徽标 (P0-2/P0-3/P0-6) — the claims 设计稿 §6.1's P0 acceptance list
// requires this spec to pin:
//
//   H-01 operatorNextStep.ts's SEVEN rules, one test each, in the priority order §4.2 lists them.
//   H-02 "三处同词一致": the home card badge, the workspace title badge, and the composed sync
//        panel's own posture line all render the EXACT SAME string for the same underlying state —
//        proven by mounting all three real components, not by asserting the pure function twice,
//        and parameterised over every posture key rather than the one easiest to reach.
//   H-03 G3: a directory read that genuinely failed degrades SILENTLY into the honest
//        `directory_unavailable` empty state — no error banner, no alert role — while a read that
//        is merely still in flight produces NO empty state at all (G4: 未检查 ≠ 空).
//   H-04 the three home empty states (`no_projects` / `nothing_today` / `directory_unavailable`)
//        carry copy that shares nothing between them.
//   H-05 G1: mounting the workspace leaves AT MOST ONE filled `--ms-color-primary` button on screen.
//   H-06 D1=A's local half — the module the union depends on and nothing used to touch: what is
//        stored (exactly three keys), what is NOT (`running`), who it is stored for (tenant +
//        principal), and how a corrupt payload degrades.
//   H-07 the merge: a directory row's live pending count wins, its ARCHIVE-derived counts never
//        overwrite this browser's own live conclusion, and a project neither source can speak for
//        renders the honest `unknown` third state rather than a guess in either direction.
//   H-08 §4.2 rule 4 survives the tab unmount that is the ONLY way to reach it in this release.
//   H-09 从列表移除 (客户反馈 2026-09-24 #1a / A8): removing a card drops it from memory AND hides it;
//        reopening a hidden project unhides it; a card is NEVER hidden while its LIVE
//        `pendingDecisionCount > 0`; and an auth transition wipes the hidden list too.

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
import { stockPrepPosture, type StockPrepPostureKey } from '../src/services/integration/stockPreparation/projectPosture'
import {
  buildOperatorHomeCards,
  countActionableOperatorHomeCards,
  resolveOperatorHomeEmptyState,
} from '../src/services/integration/stockPreparation/operatorHomeCards'
import {
  clearStockPrepHiddenProjects,
  clearStockPrepOperatorHomeMemory,
  HIDDEN_MAX_ENTRIES,
  readStockPrepHiddenProjects,
  readStockPrepRecentProjects,
  readStockPrepRememberedPosture,
  recordStockPrepProjectVisit,
  removeStockPrepRecentProject,
} from '../src/services/integration/stockPreparation/operatorHomeMemory'
import type { StockPreparationOperatorDirectory, StockPreparationOperatorProject } from '../src/services/integration/stockPreparation/confirmationQueue'
import {
  readStockPreparationOperatorHomeDirectory,
  resetStockPreparationOperatorHomeDirectoryThrottle,
} from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const OTHER_SCOPE = { tenantId: 'tenant-b', workspaceId: 'workspace-default' }
const PROJECT_NO = 'P2026-001'

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

function emptyDirectory(): StockPreparationOperatorDirectory {
  return { tenantId: 'tenant-a', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
}

function directoryRow(overrides: Record<string, unknown> = {}): StockPreparationOperatorProject {
  return {
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
  } as StockPreparationOperatorProject
}

function directoryWith(overrides: Record<string, unknown>): StockPreparationOperatorDirectory {
  return {
    tenantId: 'tenant-a',
    directoryReady: true,
    ledgerReady: true,
    projectCount: 1,
    pendingProjectCount: 0,
    projects: [directoryRow(overrides)],
  }
}

function boardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-a',
    projectId: 'p1',
    projectNo: PROJECT_NO,
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

describe('本机记忆 (D1=A 的本机那一半 / D8) — operatorHomeMemory.ts', () => {
  beforeEach(() => {
    try { window.localStorage.clear() } catch { /* jsdom always has it; guard anyway */ }
  })

  it('V-01 式反向断言: a stored entry has EXACTLY three keys — no count, no name, nothing typed', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'pending_decision', SCOPE)
    const raw = readStockPrepRecentProjects(SCOPE)
    expect(raw).toHaveLength(1)
    expect(Object.keys(raw[0]).sort()).toEqual(['postureKey', 'projectNo', 'updatedAt'])
    // And the SERIALISED form carries nothing more either — the assertion that survives a refactor
    // which adds a field to the interface but forgets this discipline.
    const serialised = JSON.stringify(raw[0])
    for (const key of Object.keys(JSON.parse(serialised) as Record<string, unknown>)) {
      expect(['projectNo', 'updatedAt', 'postureKey']).toContain(key)
    }
  })

  it('`running` is never persisted — a tab closed mid-sync must not leave a card stuck on 正在跑', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    recordStockPrepProjectVisit(PROJECT_NO, 'running', SCOPE)
    expect(readStockPrepRememberedPosture(PROJECT_NO, SCOPE)).toBe('ready')
  })

  it('another tenant on the same workstation cannot read this one\'s project numbers', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    expect(readStockPrepRecentProjects(OTHER_SCOPE)).toEqual([])
    expect(JSON.stringify(readStockPrepRecentProjects(OTHER_SCOPE))).not.toContain(PROJECT_NO)
  })

  it('a corrupt or hand-edited payload degrades to "no memory", never a throw', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index)
      if (storageKey && storageKey.includes('operatorHomeMemory')) {
        window.localStorage.setItem(storageKey, '{ not json at all')
      }
    }
    expect(() => readStockPrepRecentProjects(SCOPE)).not.toThrow()
    expect(readStockPrepRecentProjects(SCOPE)).toEqual([])
  })

  it('an entry with an unknown posture key is dropped rather than rendered', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index)
      if (storageKey && storageKey.includes('operatorHomeMemory')) {
        window.localStorage.setItem(storageKey, JSON.stringify([{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'nonsense' }]))
      }
    }
    expect(readStockPrepRecentProjects(SCOPE)).toEqual([])
  })

  it('an auth transition wipes every principal\'s memory in this browser profile', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    recordStockPrepProjectVisit('P2026-002', 'ready', OTHER_SCOPE)
    clearStockPrepOperatorHomeMemory()
    expect(readStockPrepRecentProjects(SCOPE)).toEqual([])
    expect(readStockPrepRecentProjects(OTHER_SCOPE)).toEqual([])
  })

  // ---- 从列表移除 (客户反馈 2026-09-24 #1a / A8) — H-09 ---------------------------------------------

  it('B1 (adversarial review 2026-09-26): removeStockPrepRecentProject hides the project WITHOUT touching the remembered memory entry', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    const result = removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    expect(result).toBe('hidden')
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
    // The regression this pins: an earlier revision ALSO deleted this entry, which took the remembered
    // posture away from 项目查询 and the board's rule-4 nudge — neither of which know about the hidden
    // list at all. See StockPreparationProjectQuery.spec.ts's own B1 test for the cross-component proof.
    expect(readStockPrepRecentProjects(SCOPE)).toEqual([
      expect.objectContaining({ projectNo: PROJECT_NO, postureKey: 'ready' }),
    ])
    expect(readStockPrepRememberedPosture(PROJECT_NO, SCOPE)).toBe('ready')
  })

  it('removing an already-hidden project is a no-op — `already_hidden`, not a second hide', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    expect(removeStockPrepRecentProject(PROJECT_NO, SCOPE)).toBe('hidden')
    expect(removeStockPrepRecentProject(PROJECT_NO, SCOPE)).toBe('already_hidden')
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
  })

  it('removal is scoped to one tenant+principal, same as every other write here', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    expect(readStockPrepHiddenProjects(OTHER_SCOPE)).toEqual([])
  })

  it('S4: the PRINCIPAL half of the key means one signed-in user cannot see another user\'s hidden list, same tenant', () => {
    function fakeJwt(sub: string): string {
      return `h.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.s`
    }
    try {
      window.localStorage.setItem('auth_token', fakeJwt('user-a'))
      recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
      expect(removeStockPrepRecentProject(PROJECT_NO, SCOPE)).toBe('hidden')
      expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
      // Same tenant, same browser, a DIFFERENT signed-in principal — must not see user-a's hide.
      window.localStorage.setItem('auth_token', fakeJwt('user-b'))
      expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
      // And user-a's hide is still there once they are signed back in.
      window.localStorage.setItem('auth_token', fakeJwt('user-a'))
      expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
    } finally {
      window.localStorage.removeItem('auth_token')
    }
  })

  it('reopening a hidden project (recordStockPrepProjectVisit) unhides it', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
    recordStockPrepProjectVisit(PROJECT_NO, 'blocked', SCOPE)
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
    expect(readStockPrepRememberedPosture(PROJECT_NO, SCOPE)).toBe('blocked')
  })

  it('unhiding happens even when the reopen settles on `running` — the transient posture is skipped, the unhide is not', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    recordStockPrepProjectVisit(PROJECT_NO, 'running', SCOPE)
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
    // The posture write for THIS visit is still skipped for `running` (pre-existing behaviour,
    // unchanged) — but B1 means the entry from the EARLIER 'ready' visit was never deleted either.
    expect(readStockPrepRememberedPosture(PROJECT_NO, SCOPE)).toBe('ready')
  })

  it('a corrupt hidden-list payload degrades to "nothing hidden", never a throw', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index)
      if (storageKey && storageKey.includes('operatorHomeMemory') && storageKey.includes('hidden')) {
        window.localStorage.setItem(storageKey, '{ not json at all')
      }
    }
    expect(() => readStockPrepHiddenProjects(SCOPE)).not.toThrow()
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
  })

  it('an auth transition ALSO wipes the hidden list — the same startsWith sweep already catches it', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    recordStockPrepProjectVisit('P2026-002', 'ready', OTHER_SCOPE)
    removeStockPrepRecentProject('P2026-002', OTHER_SCOPE)
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
    expect(readStockPrepHiddenProjects(OTHER_SCOPE)).toEqual(['P2026-002'])
    clearStockPrepOperatorHomeMemory()
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
    expect(readStockPrepHiddenProjects(OTHER_SCOPE)).toEqual([])
  })

  // ---- S1: the hidden list's own cap — refuse, never silently evict ---------------------------------

  it('S1: refuses a hide past HIDDEN_MAX_ENTRIES rather than evicting the oldest one', () => {
    for (let i = 0; i < HIDDEN_MAX_ENTRIES; i += 1) {
      const no = `P-CAP-${i}`
      recordStockPrepProjectVisit(no, 'ready', SCOPE)
      expect(removeStockPrepRecentProject(no, SCOPE)).toBe('hidden')
    }
    expect(readStockPrepHiddenProjects(SCOPE)).toHaveLength(HIDDEN_MAX_ENTRIES)
    // One more, past the cap: refused, not silently accepted by dropping the first one.
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    expect(removeStockPrepRecentProject(PROJECT_NO, SCOPE)).toBe('limit_reached')
    const hidden = readStockPrepHiddenProjects(SCOPE)
    expect(hidden).toHaveLength(HIDDEN_MAX_ENTRIES)
    // The FIRST one hidden is still there — nothing was evicted to make room for the refused one.
    expect(hidden).toContain('P-CAP-0')
    expect(hidden).not.toContain(PROJECT_NO)
  })

  it('S2: clearStockPrepHiddenProjects (全部恢复) empties the hidden list for this scope only', () => {
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    recordStockPrepProjectVisit('P2026-002', 'ready', OTHER_SCOPE)
    removeStockPrepRecentProject('P2026-002', OTHER_SCOPE)
    clearStockPrepHiddenProjects(SCOPE)
    expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
    // The OTHER scope's hide is untouched — this is a per-signed-in-operator action, not a wipe.
    expect(readStockPrepHiddenProjects(OTHER_SCOPE)).toEqual(['P2026-002'])
    // And it never touched the memory it left behind either (B1).
    expect(readStockPrepRememberedPosture(PROJECT_NO, SCOPE)).toBe('ready')
  })
})

describe('目录 ∪ 本机记忆的合并方向 (D1=A) — operatorHomeCards.ts', () => {
  it('a directory row\'s LIVE pending count wins over anything remembered', () => {
    const cards = buildOperatorHomeCards(
      [directoryRow({ pendingDecisionCount: 2 })],
      [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].posture.key).toBe('pending_decision')
    expect(cards[0].postureFromMemory).toBe(false)
  })

  it('the archive\'s line counts NEVER overwrite this browser\'s own live conclusion', () => {
    // The regression this pins: a directory row (archive counts all zero, nothing pending) used to
    // be read as 「还没拉过」 and win, so an operator who had just pulled 1,240 rows came back to the
    // home page and watched their card fall back to "never pulled".
    const cards = buildOperatorHomeCards(
      [directoryRow({ readyLineCount: 0, heldLineCount: 0, pendingDecisionCount: 0 })],
      [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    )
    expect(cards[0].posture.key).toBe('ready')
    expect(cards[0].postureFromMemory).toBe(true)
  })

  it('a row neither source can speak for is the honest `unknown` third state, not a guess', () => {
    const cards = buildOperatorHomeCards([directoryRow({ readyLineCount: 9, heldLineCount: 3 })], [])
    expect(cards[0].posture.key).toBe('unknown')
    expect(cards[0].posture.tone).toBe('neutral')
  })

  it('a memory-only project still gets a card — this is the whole point of the union (F1)', () => {
    const cards = buildOperatorHomeCards([], [
      { projectNo: 'P2026-009', updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'pending_decision' },
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].source).toBe('memory')
    expect(cards[0].pendingDecisionCount).toBeNull()
    // No fabricated count in the badge: the key is remembered, the number never was.
    expect(cards[0].posture.zh).toBe('等您拿主意')
  })

  it('a remembered "waiting" is NOT counted as "waiting on you today"', () => {
    const cards = buildOperatorHomeCards([], [
      { projectNo: 'P2026-009', updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'pending_decision' },
    ])
    expect(countActionableOperatorHomeCards(cards)).toEqual({ live: 0, any: 1 })
  })

  // ---- 从列表移除's third argument (客户反馈 2026-09-24 #1a / A8) — H-09 -----------------------------

  it('a project number in `hidden` is skipped entirely when the directory has nothing live for it', () => {
    const cards = buildOperatorHomeCards(
      [directoryRow({ pendingDecisionCount: 0 })],
      [],
      new Set([PROJECT_NO]),
    )
    expect(cards).toHaveLength(0)
  })

  it('a hidden MEMORY-only project is skipped too', () => {
    const cards = buildOperatorHomeCards([], [
      { projectNo: 'P2026-009', updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' },
    ], ['P2026-009'])
    expect(cards).toHaveLength(0)
  })

  it('NEVER hides a directory row whose LIVE pendingDecisionCount > 0, even if it is in `hidden`', () => {
    const cards = buildOperatorHomeCards(
      [directoryRow({ pendingDecisionCount: 3 })],
      [],
      new Set([PROJECT_NO]),
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].posture.key).toBe('pending_decision')
  })

  it('a plain array works the same as a Set — callers are not required to construct one', () => {
    const cards = buildOperatorHomeCards([directoryRow({ pendingDecisionCount: 0 })], [], [PROJECT_NO])
    expect(cards).toHaveLength(0)
  })

  it('an EMPTY hidden list changes nothing — every existing two-argument caller keeps its old shape', () => {
    const withEmptySet = buildOperatorHomeCards([directoryRow({ pendingDecisionCount: 0 })], [], new Set())
    const withoutThirdArg = buildOperatorHomeCards([directoryRow({ pendingDecisionCount: 0 })], [])
    expect(withEmptySet).toEqual(withoutThirdArg)
  })

  // ---- resolveOperatorHomeEmptyState × hiddenCount (S2, adversarial review 2026-09-26) --------------

  it('S2: cardCount 0 with NOTHING hidden is still the honest no_projects', () => {
    expect(resolveOperatorHomeEmptyState({
      directorySettled: true,
      directoryAvailable: true,
      cardCount: 0,
      actionableCount: 0,
      hiddenCount: 0,
    })).toBe('no_projects')
  })

  it('S2: cardCount 0 WITH something hidden is null, not no_projects — there ARE projects, they are just hidden', () => {
    expect(resolveOperatorHomeEmptyState({
      directorySettled: true,
      directoryAvailable: true,
      cardCount: 0,
      actionableCount: 0,
      hiddenCount: 3,
    })).toBeNull()
  })

  it('S2: a genuinely unavailable directory still wins over hiddenCount — nothing to claim either way', () => {
    expect(resolveOperatorHomeEmptyState({
      directorySettled: true,
      directoryAvailable: false,
      cardCount: 0,
      actionableCount: 0,
      hiddenCount: 3,
    })).toBe('directory_unavailable')
  })

  it('S2: hiddenCount does not affect nothing_today — there IS a card, just nothing actionable', () => {
    expect(resolveOperatorHomeEmptyState({
      directorySettled: true,
      directoryAvailable: true,
      cardCount: 2,
      actionableCount: 0,
      hiddenCount: 3,
    })).toBe('nothing_today')
  })
})

describe('三处徽标同词一致 (P0-6) — home card / workspace title / sync-panel status', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    try { window.localStorage.clear() } catch { /* jsdom always has it; guard anyway */ }
    // P0 补项 4c: the board's OWN directory read is throttled (operatorHomeDirectory.ts). Reset
    // between tests so a fixture two tests ago cannot silently answer THIS test's mount — every test
    // below starts with a genuinely cold cache, exactly as it behaved before the throttle existed.
    resetStockPreparationOperatorHomeDirectoryThrottle()
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

  // EVERY key, not just the one easiest to reach. The three call sites feed `stockPrepPosture`
  // different inputs (the panel derives its pulled-ness from `showsSheetLink`, the workspace from
  // `board.pulledRowCount`, the home card from the merge), so the input shapes are exactly where a
  // divergence would hide — but the WORD each produces has to be the same.
  const POSTURE_CASES: { key: StockPrepPostureKey; input: Parameters<typeof stockPrepPosture>[0] }[] = [
    { key: 'pending_decision', input: { pendingDecisionCount: 2 } },
    { key: 'blocked', input: { missingComponentsCount: 7 } },
    { key: 'running', input: { busy: true } },
    { key: 'ready', input: { pulledRowCount: 12 } },
    { key: 'not_pulled', input: {} },
    { key: 'unknown', input: { progressUnknown: true } },
    { key: 'not_yours', input: { notYours: true } },
  ]

  it.each(POSTURE_CASES)('$key renders one and only one wording, whatever produced it', ({ key, input }) => {
    const posture = stockPrepPosture(input)
    expect(posture.key).toBe(key)
    const memoryCards = buildOperatorHomeCards([], [
      { projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: key },
    ])
    // The two count-bearing keys deliberately drop the count a remembered entry does not have; the
    // rest must be byte-identical to the live wording.
    if (key === 'pending_decision' || key === 'blocked') {
      expect(posture.zh.startsWith(memoryCards[0].posture.zh)).toBe(true)
    } else {
      expect(memoryCards[0].posture.zh).toBe(posture.zh)
    }
    expect(memoryCards[0].posture.tone).toBe(posture.tone)
  })

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
      if (path.includes('/board')) return ok(boardPayload({ pendingDecisionCount: 2 }))
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

  // ---- G1 每屏一个主操作位 -----------------------------------------------------------------------
  //
  // §1.2's criterion is literal and falsifiable: "任一屏截图里,--ms-color-primary 填充的按钮 ≤ 1".
  // jsdom cannot read a scoped stylesheet, so the contract is carried by an attribute instead: every
  // component that paints a `--ms-color-primary` FILL on a button stamps `data-primary-cta` on it,
  // and this counts them. Without this assertion the criterion had no witness at all, which is how
  // the workspace ended up shipping two of them.

  it('G1: a mounted workspace with a pending queue has AT MOST ONE filled primary button', async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(emptyDirectory())
      if (path.includes('/board')) return ok(boardPayload({ pendingDecisionCount: 3 }))
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })
    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO })
    await flush()
    // The bar is showing a button…
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')).not.toBeNull()
    // …and the sync panel's own run button is on screen at the same time…
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    // …but only one of the two wears the filled primary.
    expect(root.querySelectorAll('[data-primary-cta]').length).toBe(1)
  })

  it('G1: with no "下一步" bar the sync panel keeps the primary — the slot is never left empty', async () => {
    const root = mount(StockPreparationProjectSyncPanel, {})
    await nextTick()
    expect(root.querySelectorAll('[data-primary-cta]').length).toBe(1)
  })

  // ---- §4.2 rule 4 across the unmount that is the ONLY way to reach it ---------------------------

  it('rule 4: 确认完回来 still says 再同步一次 after the tab unmounted and remounted', async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(emptyDirectory())
      if (path.includes('/board')) return ok(boardPayload({ pendingDecisionCount: 0, pulledRowCount: 12 }))
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })
    // What the PREVIOUS mount left behind: this browser saw this project held, waiting on a person.
    // (The shell mounts these tabs with `v-if`, so going to the confirmation queue and coming back
    // destroys every session-local flag — this is the only thing that survives.)
    recordStockPrepProjectVisit(PROJECT_NO, 'pending_decision', SCOPE)

    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO })
    await flush()
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.getAttribute('data-next-step')).toBe('resync')
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')?.textContent)
      .toContain('再同步一次')
  })

  it('rule 4 does NOT latch: a project this browser never saw held falls through to the later rules', async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(emptyDirectory())
      if (path.includes('/board')) return ok(boardPayload({ pendingDecisionCount: 0, pulledRowCount: 12 }))
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })
    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO })
    await flush()
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar.getAttribute('data-next-step')).not.toBe('resync')
  })
})

describe('打开备料多维表 — 首页那一个入口', () => {
  // WHY THE HOME PAGE CARRIES IT. 项目备料页 has had this button since it shipped, but it needs a
  // project number in hand and 404s without one — so before anything was pulled, nothing on the
  // operator's landing page could reach the sheet they fill. The handle comes from the directory
  // this page is already rendered from; this component fetches nothing for it.

  it('renders ONLY when the directory carried a handle', () => {
    const withHandle = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...directoryWith({}), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } },
      directoryLoaded: true,
    })
    const entry = withHandle.root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]') as HTMLButtonElement
    expect(entry).not.toBeNull()
    expect(entry.textContent).toContain('打开备料多维表')
    withHandle.unmount()

    // `null` — the server looked and could prove nothing for this tenant.
    const nullHandle = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...directoryWith({}), fillTarget: null },
      directoryLoaded: true,
    })
    expect(nullHandle.root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]')).toBeNull()
    nullHandle.unmount()

    // ABSENT — nobody asked (no opt-in), or the backend predates the key. Same silence, and it must
    // not become a button that opens the chooser under a label promising the 备料主表.
    const absent = mountIsolated(StockPreparationOperatorHome, { directory: directoryWith({}), directoryLoaded: true })
    expect(absent.root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]')).toBeNull()
    absent.unmount()
  })

  it('a HALF-SHAPED handle is no handle — the button never routes at a blank id', () => {
    for (const target of [{ sheetId: '', viewId: 'view_x' }, { sheetId: 'sheet_x', viewId: '' }, { sheetId: 'sheet_x' }]) {
      const mounted = mountIsolated(StockPreparationOperatorHome, {
        directory: { ...directoryWith({}), fillTarget: target },
        directoryLoaded: true,
      })
      expect(mounted.root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]')).toBeNull()
      mounted.unmount()
    }
  })

  it('the click asks the PARENT to open it — this component composes no route', () => {
    const onOpenMultitable = vi.fn()
    const mounted = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...directoryWith({}), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } },
      directoryLoaded: true,
      onOpenMultitable,
    })
    ;(mounted.root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]') as HTMLButtonElement).click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })
})

describe('从列表移除 (客户反馈 2026-09-24 #1a / A8) — StockPreparationOperatorHome.vue', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    try { window.localStorage.clear() } catch { /* jsdom always has it; guard anyway */ }
  })

  it('the caption no longer claims "recently opened" — it names the state, not a visit', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      const note = root.querySelector('[data-testid="stock-prep-operator-home-card"] .sp-home__card-note')
      expect(note?.textContent).toBe('这台电脑上次打开时的状态')
      expect(root.textContent ?? '').not.toContain('这台电脑上最近开过的')
    } finally {
      unmount()
    }
  })

  it('the always-on shortcuts explainer is shown above the card grid whenever there is a card, and no longer overclaims a restore-on-login (N2)', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      const explainer = root.querySelector('[data-testid="stock-prep-operator-home-cards-explainer"]')
      expect(explainer).not.toBeNull()
      expect(explainer!.textContent).toContain('这些卡片只是快捷入口')
      expect(explainer!.textContent).toContain('移除不会删除任何数据')
      // N2: the old wording ("列表会恢复") implied removal undoes itself on its own; the corrected
      // wording says what ACTUALLY happens on the next sign-in — this browser's memory AND its hidden
      // list are both cleared (clearStockPrepOperatorHomeMemory sweeps both, per operatorHomeMemory.ts).
      expect(explainer!.textContent).not.toContain('列表会恢复')
      expect(explainer!.textContent).toContain('隐藏也会失效')
    } finally {
      unmount()
    }
  })

  it('clicking 从列表移除 on a memory-only card removes it from the grid, names it in the confirmation line, and leaves the remembered memory alone (B1)', async () => {
    // Seeded into REAL storage (not merely the `memory` prop) so this test can assert on the actual
    // storage this component's `onRemoveCard` writes to — the same storage 项目查询 also reads.
    recordStockPrepProjectVisit(PROJECT_NO, 'ready', SCOPE)
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      scope: SCOPE,
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).not.toBeNull()
      const removeButton = root.querySelector('[data-testid="stock-prep-operator-home-card-remove"]') as HTMLButtonElement
      expect(removeButton).not.toBeNull()
      expect(removeButton.disabled).toBe(false)
      removeButton.click()
      await nextTick()
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).toBeNull()
      const notice = root.querySelector('[data-testid="stock-prep-operator-home-removed-notice"]')
      expect(notice).not.toBeNull()
      expect(notice!.getAttribute('data-notice-kind')).toBe('removed')
      // N4: names the project, rather than a generic sentence.
      expect(notice!.textContent).toContain(PROJECT_NO)
      expect(notice!.textContent).toContain('已从这台电脑的列表里移除')
      expect(notice!.textContent).toContain('数据没有删除')
      // B1: the hidden list gained the project — but the remembered posture is UNTOUCHED. 项目查询 and
      // the board's rule-4 nudge both read this same list; deleting it here silently broke both.
      expect(readStockPrepHiddenProjects(SCOPE)).toEqual([PROJECT_NO])
      expect(readStockPrepRecentProjects(SCOPE)).toEqual([
        expect.objectContaining({ projectNo: PROJECT_NO, postureKey: 'ready' }),
      ])
    } finally {
      unmount()
    }
  })

  it('N4: the removal notice auto-clears after a short delay', async () => {
    vi.useFakeTimers()
    try {
      const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
        scope: SCOPE,
        directory: emptyDirectory(),
        directoryLoaded: true,
        memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
      })
      try {
        const removeButton = root.querySelector('[data-testid="stock-prep-operator-home-card-remove"]') as HTMLButtonElement
        removeButton.click()
        await vi.advanceTimersByTimeAsync(0)
        expect(root.querySelector('[data-testid="stock-prep-operator-home-removed-notice"]')).not.toBeNull()
        await vi.advanceTimersByTimeAsync(6001)
        expect(root.querySelector('[data-testid="stock-prep-operator-home-removed-notice"]')).toBeNull()
      } finally {
        unmount()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('a directory card with a LIVE pendingDecisionCount > 0 disables 从列表移除 (S3) and is NEVER hidden by a click', async () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ pendingDecisionCount: 2 }),
      directoryLoaded: true,
    })
    try {
      const removeButton = root.querySelector('[data-testid="stock-prep-operator-home-card-remove"]') as HTMLButtonElement
      expect(removeButton.disabled).toBe(true)
      expect(removeButton.title).toContain('有等您处理的事')
      removeButton.click()
      await nextTick()
      // Still on screen — the ledger says this operator has something waiting right now — and no
      // notice claims a removal that plainly did not happen.
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card-badge"]')?.textContent)
        .toBe(stockPrepPosture({ pendingDecisionCount: 2 }).zh)
      expect(root.querySelector('[data-testid="stock-prep-operator-home-removed-notice"]')).toBeNull()
    } finally {
      unmount()
    }
  })

  // ---- S2: the persistent hidden-count banner + 全部恢复 ---------------------------------------------

  it('S2: a persistent banner shows the hidden count and 全部恢复 restores every hidden card', async () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      scope: SCOPE,
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [
        { projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' },
        { projectNo: 'P2026-777', updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'blocked' },
      ],
    })
    try {
      expect(root.querySelector('[data-testid="stock-prep-operator-home-hidden-banner"]')).toBeNull()
      const removeButtons = root.querySelectorAll('[data-testid="stock-prep-operator-home-card-remove"]')
      ;(removeButtons[0] as HTMLButtonElement).click()
      await nextTick()
      const banner = root.querySelector('[data-testid="stock-prep-operator-home-hidden-banner"]')
      expect(banner).not.toBeNull()
      expect(banner!.textContent).toContain('1')
      expect(root.querySelectorAll('[data-testid="stock-prep-operator-home-card"]')).toHaveLength(1)
      const restoreAll = root.querySelector('[data-testid="stock-prep-operator-home-restore-all"]') as HTMLButtonElement
      expect(restoreAll).not.toBeNull()
      restoreAll.click()
      await nextTick()
      expect(root.querySelector('[data-testid="stock-prep-operator-home-hidden-banner"]')).toBeNull()
      expect(root.querySelectorAll('[data-testid="stock-prep-operator-home-card"]')).toHaveLength(2)
      expect(readStockPrepHiddenProjects(SCOPE)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('S2: hiding every card does not claim 「这里还没有您的项目」 — the hidden banner explains the empty grid instead', async () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      scope: SCOPE,
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      const removeButton = root.querySelector('[data-testid="stock-prep-operator-home-card-remove"]') as HTMLButtonElement
      removeButton.click()
      await nextTick()
      expect(root.querySelectorAll('[data-testid="stock-prep-operator-home-card"]')).toHaveLength(0)
      expect(root.querySelector('[data-testid="stock-prep-operator-home-empty"]')).toBeNull()
      expect(root.textContent ?? '').not.toContain('这里还没有您的项目')
      const banner = root.querySelector('[data-testid="stock-prep-operator-home-hidden-banner"]')
      expect(banner).not.toBeNull()
      expect(banner!.textContent).toContain('全部恢复')
    } finally {
      unmount()
    }
  })

  // ---- S1: the hidden list's own cap, surfaced in the UI ---------------------------------------------

  it('S1: a refused hide (limit reached) shows a notice that does NOT claim 已移除', async () => {
    for (let i = 0; i < HIDDEN_MAX_ENTRIES; i += 1) {
      removeStockPrepRecentProject(`P-CAP-${i}`, SCOPE)
    }
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      scope: SCOPE,
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      const removeButton = root.querySelector('[data-testid="stock-prep-operator-home-card-remove"]') as HTMLButtonElement
      removeButton.click()
      await nextTick()
      // Refused — the card is still here.
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).not.toBeNull()
      const notice = root.querySelector('[data-testid="stock-prep-operator-home-removed-notice"]')
      expect(notice).not.toBeNull()
      expect(notice!.getAttribute('data-notice-kind')).toBe('limit_reached')
      expect(notice!.textContent).not.toContain('已从这台电脑的列表里移除')
      expect(notice!.textContent).toContain(PROJECT_NO)
    } finally {
      unmount()
    }
  })

  // ---- S4: setup-time read coverage -------------------------------------------------------------------

  it('S4: a hidden list already in storage at mount time is honoured from the FIRST render', () => {
    removeStockPrepRecentProject(PROJECT_NO, SCOPE)
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      scope: SCOPE,
      directory: emptyDirectory(),
      directoryLoaded: true,
      memory: [{ projectNo: PROJECT_NO, updatedAt: '2026-09-08T00:00:00.000Z', postureKey: 'ready' }],
    })
    try {
      // No card at all, from the very first render — never a flash of the card before hiding it.
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-operator-home-hidden-banner"]')?.textContent)
        .toContain('1')
    } finally {
      unmount()
    }
  })

  it('N1: the nothing_today hint no longer claims every card below was "recently opened"', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ readyLineCount: 5 }),
      directoryLoaded: true,
    })
    try {
      const empty = root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
      expect(empty.getAttribute('data-empty-state')).toBe('nothing_today')
      // This directory-only card has never been opened on this computer at all (posture `unknown`),
      // so claiming "below are the projects you recently opened" would be false for it specifically.
      expect(empty.textContent ?? '').not.toContain('最近开过的项目')
      expect(empty.textContent ?? '').toContain('您能看到的项目')
    } finally {
      unmount()
    }
  })

  it('the quick-open fallback hint now says the list also carries projects with data in the sheet, whoever pulled them', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, { directory: emptyDirectory(), directoryLoaded: true })
    try {
      const hint = root.querySelector('[data-testid="stock-prep-operator-home-quick-open"] .sp-home__quick-open-hint')
      expect(hint?.textContent).toContain('备料表里已经有数据的项目')
      expect(hint?.textContent).toContain('不论是谁拉进去的')
    } finally {
      unmount()
    }
  })

  it('the 打开备料多维表 fill-hint no longer claims the sheet holds "所有项目"', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...directoryWith({}), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } },
      directoryLoaded: true,
    })
    try {
      const hint = root.querySelector('.sp-home__fill-hint')
      expect(hint?.textContent ?? '').not.toContain('所有项目')
      expect(hint?.textContent ?? '').toContain('按项目号')
    } finally {
      unmount()
    }
  })
})

describe('预读失败静默 (G3) + 空态三值互不共享文案 (P0-2)', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    try { window.localStorage.clear() } catch { /* jsdom always has it; guard anyway */ }
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

  it('G4: the FIRST read still in flight produces NO empty state at all — 未检查 ≠ 空,也 ≠ 读不到', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, { directory: null, directoryLoaded: false })
    try {
      // Neither the "it failed" state NOR the "there is nothing here for you" one: at this moment
      // the page has not been told either, and both would be assertions it cannot back.
      expect(root.querySelector('[data-testid="stock-prep-operator-home-empty"]')).toBeNull()
      expect(root.textContent ?? '').not.toContain('这里还没有您的项目')
      expect(root.textContent ?? '').not.toContain('项目清单暂时读不到')
      expect(root.querySelector('[data-testid="stock-prep-operator-home-loading"]')).not.toBeNull()
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

    // A project that IS known but has nothing waiting on the operator: the directory has no live
    // pending count and this browser has never opened it, so its posture is the honest `unknown` —
    // never `pending_decision`/`blocked` — and the card grid still renders below.
    const nothingToday = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ readyLineCount: 5 }),
      directoryLoaded: true,
    })
    const nothingTodayEmpty = nothingToday.root.querySelector('[data-testid="stock-prep-operator-home-empty"]') as HTMLElement
    const nothingTodayState = nothingTodayEmpty.getAttribute('data-empty-state')
    const nothingTodayText = nothingTodayEmpty.textContent ?? ''
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

  it('G2: a chip whose count is 0 says so — an empty card grid is its own empty state, not a blank box', async () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ pendingDecisionCount: 2 }),
      directoryLoaded: true,
    })
    try {
      const chip = root.querySelector('[data-testid="stock-prep-operator-home-filter-not_pulled"]') as HTMLButtonElement
      expect(chip.textContent).toContain('0')
      chip.click()
      await nextTick()
      expect(root.querySelectorAll('[data-testid="stock-prep-operator-home-card"]').length).toBe(0)
      const note = root.querySelector('[data-testid="stock-prep-operator-home-filter-empty"]') as HTMLElement
      expect(note).not.toBeNull()
      expect(note.getAttribute('data-empty-state')).toBe('filter_empty')
    } finally {
      unmount()
    }
  })

  it('G1 on the home screen: no card CTA is a filled --ms-color-primary button', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ pendingDecisionCount: 2 }),
      directoryLoaded: true,
    })
    try {
      expect(root.querySelectorAll('[data-primary-cta]').length).toBe(0)
      // …and the card still offers BOTH of 线框 A ⑥'s controls, so "ready" is not export-only.
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card-action"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card-open"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  // P0 补项 5 (U2 契约): a pull-target-only row per 设计稿 N1 has NO archive `projectId` — the row's
  // whole point is that a floor operator's own pull wrote no MVP archive row to take one from. Cards
  // are built and keyed off `projectNo` (operatorHomeCards.ts never reads `projectId` at all), so this
  // must not crash the merge and must not leave the card without its primary button.
  it('a projectId=null (pull-target-only) directory row still gets a card with a working primary action', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: directoryWith({ projectId: null, pendingDecisionCount: 2, sources: ['pull_target'] }),
      directoryLoaded: true,
    })
    try {
      expect(root.querySelector('[data-testid="stock-prep-operator-home-card"]')).not.toBeNull()
      const action = root.querySelector('[data-testid="stock-prep-operator-home-card-action"]') as HTMLButtonElement
      expect(action).not.toBeNull()
      expect(action.disabled).toBe(false)
    } finally {
      unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// U2 契约 (P0 补项 5) — 首页三句提示,互斥、旧后端降级
// ---------------------------------------------------------------------------

describe('首页目录三句提示 (U2 契约) — StockPreparationOperatorHome.vue', () => {
  const BANNER = 'stock-prep-operator-home-pull-banner'

  function bannerText(root: HTMLElement): string {
    return root.querySelector(`[data-testid="${BANNER}"]`)?.textContent ?? ''
  }

  it('pullTargetReady === false renders the FIRST sentence', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...emptyDirectory(), pullTargetReady: false },
      directoryLoaded: true,
    })
    try {
      const banner = root.querySelector(`[data-testid="${BANNER}"]`)
      expect(banner).not.toBeNull()
      expect(banner!.getAttribute('data-pull-banner')).toBe('pull_target_unreadable')
      expect(bannerText(root)).toContain('自助拉取的项目这次读不到')
    } finally {
      unmount()
    }
  })

  it('pullTargetScanCapped === true renders the SECOND sentence (a standing cap, not a broken read)', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...emptyDirectory(), pullTargetReady: true, pullTargetScanCapped: true, directoryMayBeIncomplete: true },
      directoryLoaded: true,
    })
    try {
      const banner = root.querySelector(`[data-testid="${BANNER}"]`)
      expect(banner!.getAttribute('data-pull-banner')).toBe('pull_target_scan_capped')
      expect(bannerText(root)).toContain('超过一次扫描的上限')
    } finally {
      unmount()
    }
  })

  it('directoryMayBeIncomplete === true ALONE (neither of the two more specific flags) renders the THIRD sentence', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...emptyDirectory(), pullTargetReady: true, pullTargetScanCapped: false, directoryMayBeIncomplete: true },
      directoryLoaded: true,
    })
    try {
      const banner = root.querySelector(`[data-testid="${BANNER}"]`)
      expect(banner!.getAttribute('data-pull-banner')).toBe('directory_may_be_incomplete')
      expect(bannerText(root)).toContain('目录本次可能不全')
    } finally {
      unmount()
    }
  })

  it('all three flags false/absent renders NO banner at all', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...emptyDirectory(), pullTargetReady: true, pullTargetScanCapped: false, directoryMayBeIncomplete: false },
      directoryLoaded: true,
    })
    try {
      expect(root.querySelector(`[data-testid="${BANNER}"]`)).toBeNull()
    } finally {
      unmount()
    }
  })

  it('MUTUALLY EXCLUSIVE: pullTargetReady=false wins over directoryMayBeIncomplete=true (priority order, at most one sentence)', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      directory: { ...emptyDirectory(), pullTargetReady: false, pullTargetScanCapped: false, directoryMayBeIncomplete: true },
      directoryLoaded: true,
    })
    try {
      expect(root.querySelectorAll(`[data-testid="${BANNER}"]`).length).toBe(1)
      expect(root.querySelector(`[data-testid="${BANNER}"]`)!.getAttribute('data-pull-banner')).toBe('pull_target_unreadable')
    } finally {
      unmount()
    }
  })

  // THE OLD-BACKEND DEGRADE. A pre-U2 backend (or a directory this page did not opt the union into)
  // OMITS all four keys — `undefined`, not `false`. Coercing "unknown" into "false" would show the
  // most alarming sentence on every deployment that simply predates the contract.
  it('an older backend’s shape (no new fields at all) shows NONE of the three sentences', () => {
    const { root, unmount } = mountIsolated(StockPreparationOperatorHome, {
      // The exact pre-N1 key set — `pullTargetReady`/`pullTargetScanCapped`/`directoryMayBeIncomplete`
      // are absent, not present-and-false.
      directory: emptyDirectory(),
      directoryLoaded: true,
    })
    try {
      expect(root.querySelector(`[data-testid="${BANNER}"]`)).toBeNull()
    } finally {
      unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// P0 补项 4c — 首页目录读的 5 秒节流 (operatorHomeDirectory.ts)
// ---------------------------------------------------------------------------

describe('首页目录读节流 (P0 补项 4c) — operatorHomeDirectory.ts', () => {
  beforeEach(() => {
    resetStockPreparationOperatorHomeDirectoryThrottle()
    h.apiFetch.mockReset()
    h.apiFetch.mockImplementation(async () => ok(emptyDirectory()))
  })

  afterEach(() => {
    resetStockPreparationOperatorHomeDirectoryThrottle()
    vi.clearAllMocks()
  })

  it('two calls within the 5s window share ONE live request', async () => {
    await readStockPreparationOperatorHomeDirectory(SCOPE)
    await readStockPreparationOperatorHomeDirectory(SCOPE)
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('the one request it does make opts into the pull-target U2 flag only', async () => {
    await readStockPreparationOperatorHomeDirectory(SCOPE)
    const url = String(h.apiFetch.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('includePullTargets=1')
    expect(url).not.toContain('includePendingCounts')
  })

  it('a DIFFERENT scope is not held back by another scope’s window', async () => {
    await readStockPreparationOperatorHomeDirectory(SCOPE)
    await readStockPreparationOperatorHomeDirectory(OTHER_SCOPE)
    expect(h.apiFetch).toHaveBeenCalledTimes(2)
  })

  it('a call AFTER the window issues a fresh request', async () => {
    vi.useFakeTimers()
    try {
      await readStockPreparationOperatorHomeDirectory(SCOPE)
      vi.advanceTimersByTime(5001)
      await readStockPreparationOperatorHomeDirectory(SCOPE)
      expect(h.apiFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a FAILED read does not poison the window — the very next call retries rather than replaying the failure', async () => {
    h.apiFetch.mockRejectedValueOnce(new Error('network'))
    await expect(readStockPreparationOperatorHomeDirectory(SCOPE)).rejects.toThrow()
    h.apiFetch.mockImplementation(async () => ok(emptyDirectory()))
    await expect(readStockPreparationOperatorHomeDirectory(SCOPE)).resolves.toBeTruthy()
    expect(h.apiFetch).toHaveBeenCalledTimes(2)
  })
})
