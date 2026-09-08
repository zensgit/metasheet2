import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  route: {
    path: '/stock-prep',
    fullPath: '/stock-prep',
    meta: {} as Record<string, unknown>,
    query: {} as Record<string, unknown>,
  },
  router: { push: vi.fn(), replace: vi.fn() },
  apiFetch: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => h.route, useRouter: () => h.router }
})

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
    getAccessSnapshot: () => ({ isAdmin: false, roles: [], permissions: ['stock-prep:read', 'stock-prep:operate'] }),
    hasAdminAccess: () => false,
    hasPermission: (permission: string) => ['stock-prep:read', 'stock-prep:operate'].includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationOperatorHome from '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'
import StockPreparationProjectQueryView from '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'
import {
  STOCK_PREP_HOME_FILTER_KEYS,
  STOCK_PREP_HOME_STATUS_LABELS,
  stockPrepHomeStatusLabel,
} from '../src/services/integration/stockPreparation/operatorHomeCards'
import {
  resolveStockPrepPullBanner,
  STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE,
  STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED,
  STOCK_PREP_HOME_PULL_TARGET_UNREADABLE,
} from '../src/services/integration/stockPreparation/plainLanguage'

// D4 (hardening wave, 2026-09-08) — 共享常量.
//
// 今天要处理 (StockPreparationOperatorHome.vue) and 项目查询 (StockPreparationProjectQueryView.vue)
// render the SAME five status words in their filter/status chip rows, and the SAME three-sentence
// pull-target priority chain above them. Before this wave each `.vue` file carried its OWN literal
// copy of both — two `Record<..., [string, string]>` maps and two `if`/`if`/`if` chains, byte-
// identical on the day they were written and with nothing tying them together afterwards. This file
// tests the ONE shared implementation both views now call (`stockPrepHomeStatusLabel` /
// `resolveStockPrepPullBanner`), plus a SOURCE-LEVEL check that neither `.vue` file re-introduces a
// local copy — a component-level mount would only prove today's wiring, not that a later edit cannot
// quietly grow a second copy the way the original duplication did.
//
// 「两视图渲染出的 chip 文案逐字相同」 IS ASSERTED AT THE RENDER LEVEL, at the bottom of this file:
// both components are mounted against the same directory and their five chips' words compared
// character for character, in both locales. The source guards stay alongside it rather than instead of
// it — they answer a different question (「can a second copy grow back later」, which one mounting can
// never prove), and the first cut of this wave shipped only the guards and argued the render-level
// equality 「by construction」, which is exactly the sort of reasoning a test is supposed to replace.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME_SRC = fs.readFileSync(
  path.join(HERE, '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'),
  'utf8',
)
const QUERY_SRC = fs.readFileSync(
  path.join(HERE, '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'),
  'utf8',
)

describe('StockPreparationHomeQueryLabels — 今天要处理 / 项目查询 共享文案常量', () => {
  it('all five status keys have a bilingual pair, and stockPrepHomeStatusLabel is a plain lookup over the same map', () => {
    for (const key of STOCK_PREP_HOME_FILTER_KEYS) {
      const [zh, en] = STOCK_PREP_HOME_STATUS_LABELS[key]
      expect(zh.length, `${key}: zh label must not be empty`).toBeGreaterThan(0)
      expect(en.length, `${key}: en label must not be empty`).toBeGreaterThan(0)
      expect(stockPrepHomeStatusLabel(key)).toBe(STOCK_PREP_HOME_STATUS_LABELS[key])
    }
    // Exactly the five §3/§4.1 words, in the frozen key order — a sixth key or a reorder here is a
    // structural change to the chip row, not a wording tweak.
    expect(STOCK_PREP_HOME_FILTER_KEYS).toEqual(['all', 'pending_decision', 'blocked', 'ready', 'not_pulled'])
  })

  it('resolveStockPrepPullBanner — null directory, and the priority order (unreadable > capped > incomplete)', () => {
    expect(resolveStockPrepPullBanner(null)).toBeNull()
    expect(resolveStockPrepPullBanner(undefined)).toBeNull()
    expect(resolveStockPrepPullBanner({})).toBeNull()

    expect(resolveStockPrepPullBanner({ pullTargetReady: false })).toEqual({
      key: 'pull_target_unreadable',
      text: STOCK_PREP_HOME_PULL_TARGET_UNREADABLE,
    })
    expect(resolveStockPrepPullBanner({ pullTargetScanCapped: true })).toEqual({
      key: 'pull_target_scan_capped',
      text: STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED,
    })
    expect(resolveStockPrepPullBanner({ directoryMayBeIncomplete: true })).toEqual({
      key: 'directory_may_be_incomplete',
      text: STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE,
    })

    // Priority: `pullTargetReady === false` beats BOTH of the other two, whichever else is also set.
    expect(resolveStockPrepPullBanner({
      pullTargetReady: false,
      pullTargetScanCapped: true,
      directoryMayBeIncomplete: true,
    })!.key).toBe('pull_target_unreadable')
    // ...and `pullTargetScanCapped` beats `directoryMayBeIncomplete` when both are set.
    expect(resolveStockPrepPullBanner({
      pullTargetScanCapped: true,
      directoryMayBeIncomplete: true,
    })!.key).toBe('pull_target_scan_capped')
  })

  it('resolveStockPrepPullBanner — every check is `=== true` / `=== false`, never a truthiness test', () => {
    // An older backend OMITS these fields; `undefined` must read as "unknown", never as `false` (which
    // would show the most alarming sentence on every deployment that predates the U2 contract).
    expect(resolveStockPrepPullBanner({ pullTargetReady: undefined })).toBeNull()
    expect(resolveStockPrepPullBanner({ pullTargetReady: true })).toBeNull()
    expect(resolveStockPrepPullBanner({ pullTargetScanCapped: false })).toBeNull()
    expect(resolveStockPrepPullBanner({ directoryMayBeIncomplete: false })).toBeNull()
  })

  it('SOURCE GUARD: 今天要处理 calls the shared label lookup, not a local FILTER_LABELS table', () => {
    expect(HOME_SRC).toContain('stockPrepHomeStatusLabel')
    expect(HOME_SRC).not.toMatch(/\bFILTER_LABELS\b/)
    expect(HOME_SRC).not.toMatch(/\bSTATUS_LABELS\b/)
  })

  it('SOURCE GUARD: 项目查询 calls the shared label lookup, not a local STATUS_LABELS table', () => {
    expect(QUERY_SRC).toContain('stockPrepHomeStatusLabel')
    expect(QUERY_SRC).not.toMatch(/\bSTATUS_LABELS\b/)
    expect(QUERY_SRC).not.toMatch(/\bFILTER_LABELS\b/)
  })

  // -------------------------------------------------------------------------
  // RENDER-LEVEL: the two views' chips, mounted, compared word for word
  // -------------------------------------------------------------------------

  const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

  function project(projectNo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      projectId: `id-${projectNo}`,
      projectNo,
      projectName: null,
      projectStatus: 'active',
      lastSyncRunId: null,
      snapshotBatchCount: 1,
      openExceptionCount: 0,
      heldLineCount: 0,
      readyLineCount: 2,
      pendingDecisionCount: 0,
      ...overrides,
    }
  }

  /** VALUES-FREE: the two project numbers below are synthetic fixtures, not customer data. */
  const DIRECTORY = {
    tenantId: 'tenant-a',
    directoryReady: true,
    ledgerReady: true,
    projectCount: 2,
    pendingProjectCount: 1,
    projects: [project('LBL-0001'), project('LBL-0002', { pendingDecisionCount: 3 })],
    pullTargetReady: true,
    directoryMayBeIncomplete: false,
    pullTargetScanCapped: false,
    lastExportAtMayBeIncomplete: false,
  }

  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  async function flushUi(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
      await nextTick()
      await Promise.resolve()
    }
  }

  async function mountView(component: Component, props: Record<string, unknown>): Promise<HTMLElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(component, props)
    app.mount(container)
    await flushUi()
    return container
  }

  /** `{{ label }} {{ count }}` — the count is the reader's number, the words are what must match. */
  function chipWords(root: HTMLElement, testidOf: (key: string) => string): string[] {
    return STOCK_PREP_HOME_FILTER_KEYS.map((key) => {
      const chip = root.querySelector(`[data-testid="${testidOf(key)}"]`)
      expect(chip, `${testidOf(key)} 必须渲染出来,否则这条比对是空转`).not.toBeNull()
      return String(chip?.textContent ?? '').replace(/\s*\d+\s*$/, '').trim()
    })
  }

  async function homeChips(): Promise<string[]> {
    const root = await mountView(StockPreparationOperatorHome as Component, {
      scope: SCOPE,
      directory: DIRECTORY,
      directoryLoaded: true,
      memory: [],
    })
    return chipWords(root, (key) => `stock-prep-operator-home-filter-${key}`)
  }

  async function queryChips(): Promise<string[]> {
    h.apiFetch.mockImplementation(async () => (
      new Response(JSON.stringify({ ok: true, data: DIRECTORY }), { status: 200 })
    ))
    const root = await mountView(StockPreparationProjectQueryView as Component, { scope: SCOPE })
    return chipWords(root, (key) => `stock-prep-project-query-status-${key}`)
  }

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
    h.router.push.mockReset()
    h.router.replace.mockReset()
    h.apiFetch.mockReset()
    localStorage.clear()
    resetStockPreparationOperatorHomeDirectoryThrottle()
  })

  afterEach(() => {
    app?.unmount()
    app = null
    container?.remove()
    container = null
  })

  it('RENDER: 今天要处理 与 项目查询 挂载出来的五个 chip,中文逐字相同', async () => {
    const home = await homeChips()
    app?.unmount(); app = null; container?.remove(); container = null
    const query = await queryChips()
    expect(home).toEqual(query)
    // Anchored, so a shared-but-wrong map cannot make both sides equally wrong and still pass.
    expect(home).toEqual(STOCK_PREP_HOME_FILTER_KEYS.map((key) => STOCK_PREP_HOME_STATUS_LABELS[key][0]))
  })

  it('RENDER: 英文一样 —— 同一份 map 的第二个元素,两边同时切语言', async () => {
    h.locale = 'en-US'
    const home = await homeChips()
    app?.unmount(); app = null; container?.remove(); container = null
    const query = await queryChips()
    expect(home).toEqual(query)
    expect(home).toEqual(STOCK_PREP_HOME_FILTER_KEYS.map((key) => STOCK_PREP_HOME_STATUS_LABELS[key][1]))
    // ...and the two locales really do differ, so the case above is not comparing zh to zh twice.
    expect(home).not.toEqual(STOCK_PREP_HOME_FILTER_KEYS.map((key) => STOCK_PREP_HOME_STATUS_LABELS[key][0]))
  })

  it('SOURCE GUARD: both views call the shared pullBanner resolver, not their own if/if/if chain', () => {
    // Matched as the CALL SHAPE the old inline chain actually had (`dir.pullTargetReady === false`,
    // reading straight off the local `dir` binding each view's own computed used to declare) rather
    // than the bare comparison text — ProjectQueryView.vue's `sourceAvailable` section legitimately
    // documents the SAME field name for an unrelated reason a few hundred lines away, and a bare
    // substring match would have falsely flagged that prose as a regrown local chain.
    for (const src of [HOME_SRC, QUERY_SRC]) {
      expect(src).toContain('resolveStockPrepPullBanner(')
      expect(src).not.toMatch(/dir\.pullTargetReady\s*===\s*false/)
      expect(src).not.toMatch(/dir\.pullTargetScanCapped\s*===\s*true/)
      expect(src).not.toMatch(/dir\.directoryMayBeIncomplete\s*===\s*true/)
    }
  })
})
