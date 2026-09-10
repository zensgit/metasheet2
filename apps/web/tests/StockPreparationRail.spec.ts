import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// P1-1 (设计稿 §2.2 / D3=A / D2=A) — 备料工作台的左栏 rail, and where each principal LANDS on it.
//
// The tab strip became a grouped vertical rail. Structurally it is still ONE tablist of the same
// tabs under the same testids, so this file's job is to hold that claim down at the four places it
// could quietly stop being true:
//
//   R-01 IT IS STILL A TABLIST. `stock-prep-tabs` + role=tablist + aria-orientation=vertical, every
//        item still `role="tab"` + `stock-prep-tab-<key>` under its ORIGINAL key, and the number of
//        `role="tab"` nodes equals the number of `stock-prep-tab-*` nodes — i.e. the three GROUP
//        HEADINGS are not tabs and never became tabs.
//   R-02 THE THREE GROUPS FILTER PER ITEM, per actor, for all four tiers. Asserted as the exact SET
//        of visible keys rather than a count, so a tab that silently swaps tier is caught by name.
//   R-03 深度工具 ▾ FOLDS THE LEGACY TABS, collapsed by default and NOT retired: all seven legacy MVP
//        keys live inside the disclosure panel, the panel starts `hidden`, and the toggle opens it.
//   R-04 THE NARROW-SCREEN FORM IS STILL THE SAME TABLIST. The fold to a horizontal strip is CSS
//        only — there is no second container and no `v-if` on the nav — which is the R11 lesson from
//        ApprovalCenterView's conditionally-rendered split container that became a no-op div.
//
// ...plus the D2=A landing, asserted at the DOM level (the predicate-level half lives in
// stockPrepPermissionMatrix.spec.ts F-09): 未装完 → 开始使用, 装完 → 记录与排查, 读不到 → 开始使用,
// 一线 → 今天要处理.
//
// VALUES-FREE: no project number, no part number, no host name, no token appears in this file.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read'] as string[],
  roles: [] as string[],
  route: {
    path: '/stock-prep',
    fullPath: '/stock-prep',
    meta: {} as Record<string, unknown>,
    query: {} as Record<string, unknown>,
  },
  router: { push: vi.fn(), replace: vi.fn() },
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

/**
 * The REAL permission ladder, not an exact-code stub — the same double
 * StockPreparationProjectBoard.spec.ts uses, and the choice matters twice here:
 *   * `stock-prep:admin` really does satisfy `stock-prep:operate` through it, so a workbench admin
 *     sees 【工作】 as well as 【部署与接入】 — a fact an exact-code stub would have hidden; and
 *   * `role:admin` really is the platform admin, so 深度工具's seven legacy tabs appear for exactly
 *     one of the four actors rather than for whoever happens to be handed the literal code.
 */
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
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => realHasPermission(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch, clearStoredAuthState: vi.fn(), getApiBase: () => 'https://api.example.com' }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => h.route, useRouter: () => h.router }
})

import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import {
  STOCK_PREP_RAIL_GROUPS,
  canOpenStockPrepRailItem,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const RAIL_SRC = readFileSync(
  join(__dirname, '../src/components/integration/stockPreparation/StockPreparationRail.vue'),
  'utf8',
)

/** The seven legacy MVP keys. 折叠, 不下线 — every one of them must still be reachable. */
const LEGACY_MVP_VIEW_KEYS = [
  'dashboard',
  'project-workspace',
  'bom-snapshot-diff',
  'material-mapping',
  'unit-conversion',
  'prep-line',
  'exception-queue',
] as const

interface RailActor {
  name: string
  permissions: string[]
  roles: string[]
  /** The EXACT set of `stock-prep-tab-*` keys this actor may see, 深度工具's members included. */
  keys: string[]
}

const ACTORS: RailActor[] = [
  {
    // 纯 read — the values-free queue watcher. 【工作】's two value-bearing items are refused (they
    // are operate-tier), the whole 【部署与接入】 group is refused, and 【帮助】 is not, because it is
    // static copy plus a词表 and issues no request at all.
    name: '纯 read',
    permissions: ['stock-prep:read'],
    roles: [],
    keys: ['confirmation-queue', 'help'],
  },
  {
    // 一线 (operate ∧ read). 【工作】 in full; nothing from 【部署与接入】.
    name: 'operate ∧ read',
    permissions: ['stock-prep:read', 'stock-prep:operate'],
    roles: [],
    // P2-1 添加 项目查询:与 今天要处理 / 项目备料 同一层(operate ∧ read),所以一线四项变五项。
    keys: ['home', 'project-board', 'project-query', 'confirmation-queue', 'help'],
  },
  {
    // stock-prep:admin — the workbench ceiling. It opens the WHOLE 【部署与接入】 group (开始使用 and
    // 记录与排查 ride exactly the `canOpenStockPrepInstallView` gate the install tab always did), and
    // through the ladder it also satisfies operate, so 【工作】 comes with it. 深度工具 does NOT:
    // the legacy tabs stayed platform-admin, which is what 「canUseLegacyMvpTabs 不变」 means.
    name: 'stock-prep:admin',
    permissions: ['stock-prep:read', 'stock-prep:admin'],
    roles: [],
    keys: ['home', 'project-board', 'project-query', 'confirmation-queue', 'getting-started', 'install', 'ops', 'help'],
  },
  {
    // 平台管理员 — everything, 深度工具's seven included.
    name: '平台管理员',
    permissions: [],
    roles: ['admin'],
    keys: [
      'home', 'project-board', 'project-query', 'confirmation-queue',
      'getting-started', 'install', 'ops',
      ...LEGACY_MVP_VIEW_KEYS,
      'help',
    ],
  },
  {
    // 裸 `integration:admin`,没有 admin 角色 —— 服务端一直把它算平台管理员
    // (`PLATFORM_ADMIN_PERMISSIONS`),PR #5555 起工作台也这么算,所以它看到的与上面一档完全相同。
    // 这一档以前在浏览器侧只开得出 深度工具,于是【部署与接入】的标题下面除了折叠什么都没有。
    name: '裸 integration:admin(无 admin 角色)',
    permissions: ['integration:admin'],
    roles: [],
    keys: [
      'home', 'project-board', 'project-query', 'confirmation-queue',
      'getting-started', 'install', 'ops',
      ...LEGACY_MVP_VIEW_KEYS,
      'help',
    ],
  },
]

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * Bounded macrotask wait. The landing for a workbench admin is decided by a REAL `Response.json()`
 * read, which takes macrotask turns; microtask-only flushing would make these cases timing-fragile.
 */
async function waitForActive(container: HTMLElement, cycles = 40): Promise<string> {
  for (let i = 0; i < cycles; i += 1) {
    const panel = container.querySelector('[data-testid="stock-prep-panel"]')
    const active = panel?.getAttribute('data-active')
    if (active) return active
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error('Timed out waiting for the panel to settle on a landing key')
}

/**
 * Answer every read this page makes. `preflight` is the ONE input D2 turns on:
 *   an object -> the deployment answered with it
 *   null      -> the read FAILS (500), i.e. 「读不到」
 * Everything else answers with an empty, valid envelope — the panels are not what this file tests.
 */
function answerReads(preflight: Record<string, unknown> | null): void {
  h.apiFetch.mockImplementation(async (url: string) => {
    const target = String(url)
    if (target.includes('/stock-preparation/preflight')) {
      if (preflight === null) return new Response(JSON.stringify({ ok: false }), { status: 500 })
      return new Response(JSON.stringify({ ok: true, data: preflight }), { status: 200 })
    }
    if (target.includes('/operator/projects')) {
      return new Response(JSON.stringify({
        ok: true,
        data: { tenantId: 't1', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] },
      }), { status: 200 })
    }
    // `eligibleSources` is carried on the generic envelope because 记录与排查's source-binding cell
    // indexes into it directly; an empty ARRAY is the honest "nothing bound yet" answer and keeps
    // this file's subject (the rail) rather than that panel's null-handling.
    return new Response(JSON.stringify({ ok: true, data: { eligibleSources: [] } }), { status: 200 })
  })
}

const INSTALLED = { ready: true, blockerCount: 0, blockers: [], posture: {} }
const NOT_INSTALLED = { ready: false, blockerCount: 2, blockers: [], posture: {} }

describe('StockPreparationRail — 左栏 rail(工作 / 部署与接入 / 帮助)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:read']
    h.roles = []
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
    h.apiFetch.mockReset()
    answerReads(NOT_INSTALLED)
    resetStockPreparationOperatorHomeDirectoryThrottle()
    localStorage.removeItem('tenantId')
    localStorage.removeItem('workspaceId')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    h.apiFetch.mockReset()
    vi.clearAllMocks()
  })

  async function mountShell(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flushUi()
    return container!
  }

  function tabKeys(root: HTMLElement): string[] {
    return [...root.querySelectorAll('[data-testid^="stock-prep-tab-"]')]
      .map((el) => String(el.getAttribute('data-testid')).replace('stock-prep-tab-', ''))
  }

  // -------------------------------------------------------------------------
  // R-01 — it is still one tablist, and the group headings are not tabs
  // -------------------------------------------------------------------------

  it('R-01: the rail is the SAME tablist — same container testid, role=tablist, aria-orientation=vertical', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]')
    expect(tablist, 'the rail must keep the tab strip\'s container testid').not.toBeNull()
    expect(tablist!.getAttribute('role')).toBe('tablist')
    // The one attribute that is NEW: the strip turned vertical, and a vertical tablist has to say so
    // or a screen reader announces the wrong arrow keys. `vertical` is what this environment reads,
    // because jsdom has no `window.matchMedia` and the guarded composable answers 「not narrow」.
    expect(tablist!.getAttribute('aria-orientation')).toBe('vertical')
    // ...BUT IT MUST NOT BE A CONSTANT. The same component lays this tablist out as a horizontal
    // strip under `@media (max-width: 899px)`, so a hard-coded 「vertical」 announces an orientation
    // the narrow layout does not have. jsdom cannot reach that width, so the guard is at source
    // level: the attribute is bound, and it is bound to the SAME query the stylesheet uses.
    expect(RAIL_SRC).toContain(':aria-orientation="orientation"')
    expect(RAIL_SRC).not.toContain('aria-orientation="vertical"')
    expect(RAIL_SRC).toContain("RAIL_NARROW_QUERY = '(max-width: 899px)'")
    // Exactly one tablist. A rail that shipped alongside the old strip would render two.
    expect(root.querySelectorAll('[role="tablist"]').length).toBe(1)
  })

  it('R-01: every item is a role=tab under its ORIGINAL key, and the group HEADINGS are not tabs', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const tabs = [...root.querySelectorAll('[data-testid^="stock-prep-tab-"]')]
    for (const tab of tabs) {
      expect(tab.getAttribute('role'), `${tab.getAttribute('data-testid')} must still be a tab`).toBe('tab')
      expect(tab.getAttribute('aria-selected'), 'a tab must state its selection').not.toBeNull()
    }
    // 组标题不是 tab. Asserted BOTH ways: the headings carry neither marker, and the counts agree —
    // so a heading cannot become a tab by acquiring one of the two and keeping the other.
    const headings = [...root.querySelectorAll('[data-testid^="stock-prep-rail-group-title-"]')]
    expect(headings.length).toBe(3)
    for (const heading of headings) {
      expect(heading.getAttribute('role')).not.toBe('tab')
      expect(String(heading.getAttribute('data-testid'))).not.toContain('stock-prep-tab-')
    }
    expect(root.querySelectorAll('[role="tab"]').length).toBe(tabs.length)
    // 深度工具's disclosure is a control, not a tab either.
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('role')).not.toBe('tab')
  })

  it('R-01: the three group ids are the manifest\'s, in the manifest\'s order', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const rendered = [...root.querySelectorAll('[data-testid^="stock-prep-rail-group-"]')]
      .map((el) => String(el.getAttribute('data-testid')))
      .filter((testid) => !testid.includes('group-title-'))
      .map((testid) => testid.replace('stock-prep-rail-group-', ''))
    expect(rendered).toEqual(STOCK_PREP_RAIL_GROUPS.map((group) => group.group))
  })

  // -------------------------------------------------------------------------
  // R-02 — per-item filtering, four tiers, asserted as a SET of keys
  // -------------------------------------------------------------------------

  for (const actor of ACTORS) {
    it(`R-02: ${actor.name} sees exactly the rail items their tier opens`, async () => {
      h.permissions = actor.permissions
      h.roles = actor.roles
      const root = await mountShell()
      expect([...tabKeys(root)].sort()).toEqual([...actor.keys].sort())
    })
  }

  it('R-02: 【部署与接入】 disappears WHOLE rather than rendering an empty heading', async () => {
    // A group whose every item is refused must not leave its heading behind — an empty 【部署与接入】
    // heading reads as "there is something here you cannot have", which is exactly the "visible but
    // not actionable" shape R-11 forbids.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-rail-group-deploy"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-rail-group-title-deploy"]')).toBeNull()
    // ...while the two that DO have items are both there.
    expect(root.querySelector('[data-testid="stock-prep-rail-group-work"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-rail-group-help"]')).not.toBeNull()
  })

  it('R-02: the manifest gate each item declares matches the item the shell actually renders', async () => {
    // WHAT THIS CLOSES. `STOCK_PREP_RAIL_GROUPS` is mirrored to the plugin module and asserted
    // byte-equal there (F-09), but the shell filters on the `views[]` flags rather than on the
    // manifest's gate token — so re-tiering an item IN THE MANIFEST changed the server's mirrored
    // answer and moved nothing on screen, with every cross-side assertion still green. This ties the
    // two together at the only place that matters: what is on the page.
    //
    // The domain is the principals who can actually OPEN /stock-prep (route meta:
    // `permissions: ['stock-prep:read']`), which is every actor in this file. `canOpenStockPrepRailItem`
    // is called here rather than in the shell deliberately — the shell's filtering is unchanged and
    // this is a guard, not a second implementation.
    for (const actor of ACTORS) {
      h.permissions = actor.permissions
      h.roles = actor.roles
      const root = await mountShell()
      const expected: string[] = []
      for (const group of STOCK_PREP_RAIL_GROUPS) {
        for (const item of group.items) {
          if (canOpenStockPrepRailItem(item.gate, { roles: h.roles, permissions: h.permissions })) expected.push(item.key)
        }
        const advancedGate = group.advancedGate
        if (advancedGate && canOpenStockPrepRailItem(advancedGate, { roles: h.roles, permissions: h.permissions })) {
          for (const key of group.advanced ?? []) expected.push(key)
        }
      }
      expect([...tabKeys(root)].sort(), `${actor.name}: manifest gates vs rendered rail`).toEqual(expected.sort())
      app!.unmount()
      app = null
    }
  })

  it('R-02: 通配持有者只剩确认队列 —— 侧栏不再画一整排会 403 的项', async () => {
    // 不吃通配 (PR #5555), AT THE DOM LEVEL. `stock-prep:*` / `*:*` / `stock-prep:write` are all
    // expanded by `useAuth().hasPermission` and refused by the server, so while the workbench decided
    // on that probe these principals were shown 【工作】 and 【部署与接入】 in full and every control
    // under them 403'd. The workbench now decides on the server's own literal ladder, so their rail
    // collapses to the ONE item the shell renders ungated.
    //
    // NOT AN `ACTORS` ROW, and the reason is the expected value itself: R-02's manifest-vs-DOM loop
    // asserts 「rendered == what the manifest's gates admit」, and 确认队列 is exactly where those two
    // part company — its `views[]` entry carries no gate flag, so the shell renders it for anyone who
    // got through the route guard. That is stated here with its value rather than hidden by leaving
    // the principal out. Nothing behind it opens: `stockPrepPermissionMatrix.spec.ts` F-10 asserts
    // the capability set is empty on both sides, so the queue paints its refusal, not its controls.
    for (const permissions of [['stock-prep:*'], ['*:*'], ['stock-prep:write']]) {
      h.permissions = [...permissions]
      h.roles = []
      const root = await mountShell()
      expect([...tabKeys(root)].sort(), `${permissions[0]}: 只剩确认队列`).toEqual(['confirmation-queue'])
      expect(root.querySelector('[data-testid="stock-prep-rail-group-deploy"]'), `${permissions[0]}: 没有【部署与接入】`).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]'), `${permissions[0]}: 没有深度工具`).toBeNull()
      expect(await waitForActive(root), `${permissions[0]}: 落确认队列`).toBe('confirmation-queue')
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('R-02: the rail decides nothing — it holds no permission probe of its own', () => {
    // 「侧栏项的可见性只能调 workbenchAccess.ts 既有/新增谓词,不得在组件里重算权限」. The shell hands
    // the rail an ALREADY-FILTERED list; a rail that grew its own probe would make the two lists
    // able to disagree, and the disagreement would be invisible.
    expect(RAIL_SRC).not.toContain('hasPermission')
    expect(RAIL_SRC).not.toContain('workbenchAccess')
    expect(RAIL_SRC).not.toContain('useAuth')
  })

  // -------------------------------------------------------------------------
  // R-03 — 深度工具 ▾: folded, default-collapsed, and nothing retired
  // -------------------------------------------------------------------------

  it('R-03: the seven legacy MVP tabs are INSIDE 深度工具 and it starts collapsed', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const panel = root.querySelector('[data-testid="stock-prep-rail-advanced-panel"]') as HTMLElement
    expect(panel, '深度工具 must have a disclosure panel').not.toBeNull()
    // 默认收起. `hidden` is a real collapse — not painted, out of the tab order, out of the a11y
    // tree — which is what makes 「默认收起」 honest rather than a styling claim.
    expect(panel.hasAttribute('hidden')).toBe(true)
    // ...AND THE ATTRIBUTE HAS TO STILL MEAN THAT. `hidden`'s whole effect is the UA stylesheet's
    // `[hidden] { display: none }`, which ANY author-origin `display` on the same element outranks —
    // and this panel carries `display: flex` for its own layout, scoped by Vue into a
    // specificity-(0,2,0) selector. The first cut of this component shipped exactly that pair, so
    // the seven folded tabs stayed painted, stayed focusable and stayed in the accessibility tree
    // while this very assertion passed. The DOM cannot show it: vitest's jsdom environment runs no
    // cascade and `apps/web/vite.config.ts`'s test block sets no `css` option, so an SFC's scoped
    // styles are never even injected. So the guard is at SOURCE level, and it is deliberately
    // stronger than 「a rule exists」: the element that gets `display` for its layout must also carry
    // an explicit `[hidden]` branch turning it off.
    //
    // AND THE RULE IS LOOKED UP BY THE CLASS THE PANEL ACTUALLY WEARS, not by a class name copied
    // into this file. A literal `.sp-rail__advanced-panel[hidden]` needle passes for ever once
    // written: renaming the panel's class leaves the old, now-dead rule in the style block and the
    // assertion still finds it, while the live element is back to being painted. So the class is read
    // out of the panel's own tag first, and the stylesheet is then required to switch THAT class off.
    const panelTag = RAIL_SRC.slice(
      RAIL_SRC.lastIndexOf('<', RAIL_SRC.indexOf('data-testid="stock-prep-rail-advanced-panel"')),
      RAIL_SRC.indexOf('>', RAIL_SRC.indexOf('data-testid="stock-prep-rail-advanced-panel"')),
    )
    const panelClass = /\bclass="([^"]+)"/.exec(panelTag)?.[1]?.trim()
    expect(panelClass, '深度工具 的面板必须有一个静态 class,样式表才有东西可关').toBeTruthy()
    expect(panelClass!.split(/\s+/).length, 'one static class, so the rule below is unambiguous').toBe(1)
    const hiddenRule = new RegExp(
      `\\.${panelClass!.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`,
    )
    expect(RAIL_SRC, `${panelClass} 必须有一条 [hidden] 分支把 display 关掉`).toMatch(hiddenRule)
    // And no `!important` smuggled in to make it work by force — a fold whose off state needs to
    // out-shout its own layout rule is a fold that will lose the next time the layout changes.
    expect(RAIL_SRC).not.toContain('!important')
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // 不下线: every legacy key is in there, under its original testid, and none escaped into a group.
    for (const key of LEGACY_MVP_VIEW_KEYS) {
      const tab = root.querySelector(`[data-testid="stock-prep-tab-${key}"]`)
      expect(tab, `${key} must still exist`).not.toBeNull()
      expect(panel.contains(tab), `${key} must be folded into 深度工具`).toBe(true)
    }
    // ...and nothing that is NOT a legacy tab was swept in with them.
    expect(panel.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(LEGACY_MVP_VIEW_KEYS.length)
  })

  it('R-03: opening 深度工具 reveals them, and one of them still activates its panel', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLButtonElement
    toggle.click()
    await flushUi()
    const panel = root.querySelector('[data-testid="stock-prep-rail-advanced-panel"]') as HTMLElement
    expect(panel.hasAttribute('hidden')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // A folded tab is still a tab: clicking it switches the view, exactly as it did on the strip.
    ;(root.querySelector('[data-testid="stock-prep-tab-dashboard"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('dashboard')
  })

  // -------------------------------------------------------------------------
  // R-04 — the narrow-screen form is the same DOM
  // -------------------------------------------------------------------------

  it('R-04: 窄屏 is a media query, not a second container — the tablist is unconditional', () => {
    // R11's lesson, in the one shape that can regress silently: ApprovalCenterView shipped a
    // conditionally-rendered split container that became a no-op div at narrow widths. A CSS media
    // query cannot do that — there is one `<nav>` wrapping one `role="tablist"` (the hardening wave
    // split them; before it the `<nav>` WAS the tablist), both rendered at every width, and the fold
    // only changes the tablist's flex direction.
    expect(RAIL_SRC).toContain('@media (max-width: 899px)')
    expect(RAIL_SRC).toMatch(/<nav\s/)
    expect(RAIL_SRC).toMatch(/class="sp-rail__tablist"/)
    // No `v-if` / `v-show` anywhere on the container or on the group loop: the ONLY conditional
    // rendering in this component is 深度工具's own presence and its `hidden` fold.
    expect(RAIL_SRC).not.toMatch(/<nav[^>]*v-(if|show)/)
    expect(RAIL_SRC).not.toContain('v-if="group.items')
    // The shell's own two-column layout folds the same way, and its container is unconditional too.
    const shell = readFileSync(
      join(__dirname, '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'),
      'utf8',
    )
    expect(shell).toContain('.stock-prep__layout')
    expect(shell).toContain('@media (max-width: 899px)')
    expect(shell).not.toMatch(/class="stock-prep__layout"[^>]*v-if/)
  })

  // -------------------------------------------------------------------------
  // R-05 — keyboard roving (hardening wave, WAI-ARIA tabs pattern)
  // -------------------------------------------------------------------------

  function dispatchArrow(el: Element, key: string): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  it('R-05: roving tabindex — exactly one tab is 0, and it is the last VISITED one', async () => {
    // 项目查询, not 项目备料: clicking 项目备料 with no project number open is D3's OWN fold (see
    // below), and conflating the two here would make this test assert on two features at once.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-project-query"]') as HTMLButtonElement).click()
    await flushUi()
    const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLButtonElement[]
    const zeroTabbable = tabs.filter((tab) => tab.getAttribute('tabindex') === '0')
    expect(zeroTabbable.map((tab) => tab.dataset.testid)).toEqual(['stock-prep-tab-project-query'])
    for (const tab of tabs) {
      if (tab.dataset.testid !== 'stock-prep-tab-project-query') {
        expect(tab.getAttribute('tabindex'), `${tab.dataset.testid} must be -1`).toBe('-1')
      }
    }
  })

  it('R-05: ArrowDown/ArrowUp move focus among the VISIBLE tabs and select NOTHING (manual activation)', async () => {
    // 项目查询 ⇄ 确认队列, not 今天要处理 ⇄ 项目备料: the latter pair is D3's fold subject (see below)
    // and would make the panel's key move for a reason unrelated to this test.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-project-query"]') as HTMLButtonElement).click()
    await flushUi()
    const query = root.querySelector('[data-testid="stock-prep-tab-project-query"]') as HTMLButtonElement
    query.focus()

    dispatchArrow(query, 'ArrowDown')
    await flushUi()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-confirmation-queue')
    // F-ACT: the panel does NOT follow the focus. Arrowing PAST an item is free, which is the whole
    // point — the shell's `handleRailSelect` has side effects (it can close the open project), so
    // "moving focus selects" would make a roam of the rail destructive to keyboard readers only.
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-query')
    // The roving stop follows the FOCUS, not the selection — otherwise Tab away and back would land
    // the reader somewhere they never put the cursor.
    expect(root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]')?.getAttribute('tabindex')).toBe('0')
    expect(root.querySelector('[data-testid="stock-prep-tab-project-query"]')?.getAttribute('tabindex')).toBe('-1')
    // `aria-selected` stays on the tab whose panel is showing, never on the merely-focused one.
    expect(root.querySelector('[data-testid="stock-prep-tab-project-query"]')?.getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]')?.getAttribute('aria-selected')).toBe('false')

    const queueTab = document.activeElement as HTMLButtonElement
    dispatchArrow(queueTab, 'ArrowUp')
    await flushUi()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-project-query')
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-query')
  })

  it('R-05: Enter/Space is what selects — the click every tab already has, no extra listener', async () => {
    // jsdom does NOT implement a native button's default activation behaviour for Enter/Space, so
    // dispatching a KeyboardEvent here would prove nothing either way; the REAL keystroke is asserted
    // in the browser lane (P1-08). What this case pins is the half jsdom CAN judge: activation goes
    // through the tab's own `click`, i.e. the identical path a pointer takes, with no keyboard-only
    // branch that could drift from it — and the component's keydown handler adds no selection of its
    // own (`selectTab` appears exactly once outside the template's `@click`).
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    const queue = root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement
    queue.focus()
    dispatchArrow(queue, 'ArrowUp')
    await flushUi()
    const focused = document.activeElement as HTMLButtonElement
    expect(focused.getAttribute('data-testid')).toBe('stock-prep-tab-project-query')
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).not.toBe('project-query')
    focused.click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-query')
    // SOURCE-LEVEL half of the same claim: the keydown handler moves focus and nothing else.
    expect(RAIL_SRC).not.toMatch(/selectTab\(key\)/)
    expect(RAIL_SRC).toContain('focusedKey.value = key')
  })

  it('R-05: 方向键/Home/End 打在「深度工具」折叠按钮上时什么都不做 —— disclosure 不是 tab 部件的一部分', async () => {
    // THE MOVE OUT OF THE TABLIST HAS TO BE A BEHAVIOURAL MOVE, NOT ONLY AN ARIA ONE. The keydown
    // handler is bound on `<nav>` (it must be: 深度工具's folded tabs are a DOM sibling of the tablist),
    // and `<nav>` also contains the disclosure. Without an event-source gate, a reader who Tabs off the
    // roving stop onto the disclosure — the very next stop in the tab order — and presses ArrowDown to
    // open it gets focus yanked into the tablist instead, with the page scroll eaten by preventDefault.
    h.roles = ['admin']
    const root = await mountShell()
    // Settle the D2 landing read first — an in-flight posture response is the one thing that could
    // move `data-active` for a reason that has nothing to do with the keys under test. Each key then
    // re-reads it immediately before pressing, so the comparison is never against a stale landing.
    await waitForActive(root)
    await flushUi()
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLButtonElement
    toggle.focus()
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const panelBefore = root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')
      dispatchArrow(toggle, key)
      await flushUi()
      expect(document.activeElement, `${key} must leave focus on the disclosure`).toBe(toggle)
      expect(
        root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active'),
        `${key} must not switch the panel`,
      ).toBe(panelBefore)
    }
    // ...and the key is not swallowed either: an ungated handler calls preventDefault() on all six.
    const probe = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    toggle.dispatchEvent(probe)
    expect(probe.defaultPrevented, '方向键在 disclosure 上必须留给浏览器(滚动)').toBe(false)
  })

  it('R-05: ArrowLeft/ArrowRight move focus too — a superset, not a width-gated alternative (F-KB)', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    const query = root.querySelector('[data-testid="stock-prep-tab-project-query"]') as HTMLButtonElement
    query.focus()
    dispatchArrow(query, 'ArrowRight')
    await flushUi()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-confirmation-queue')
    dispatchArrow(document.activeElement as HTMLButtonElement, 'ArrowLeft')
    await flushUi()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-project-query')
  })

  // -------------------------------------------------------------------------
  // D3 — 无项目号时两入口收敛 (hardening wave)
  // -------------------------------------------------------------------------

  it('D3: 点「项目备料」且无项目号时,高亮回落到「今天要处理」——不再高亮 A 却显示 B', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('home')
    ;(root.querySelector('[data-testid="stock-prep-tab-project-board"]') as HTMLButtonElement).click()
    await flushUi()
    // The panel was ALWAYS correct here (same component, empty projectNo) — what was wrong is that
    // 项目备料 stayed highlighted while the screen showed 今天要处理's content. The fold moves the
    // highlight to match what is actually on screen.
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('home')
    expect(root.querySelector('[data-testid="stock-prep-tab-home"]')?.getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('[data-testid="stock-prep-tab-project-board"]')?.getAttribute('aria-selected')).toBe('false')
  })

  it('D3: `?tab=project-board` 不带项目号的深链 —— 面板与高亮都落在「今天要处理」', async () => {
    // THE CASE THAT ACTUALLY CHANGED BEHAVIOUR, and it had no coverage: the existing 「旧 key 仍然认」
    // regression below was given a `projectNo` so it would keep testing what it was written to test,
    // which left the number-less deep link — the one the fold DOES move — asserted nowhere. The panel
    // content is what it always was (same component, empty projectNo); what moved is the label, the
    // description and the highlight, which now agree with it instead of contradicting it.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { tab: 'project-board' } }
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('home')
    expect(root.querySelector('[data-testid="stock-prep-tab-home"]')?.getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('[data-testid="stock-prep-tab-project-board"]')?.getAttribute('aria-selected')).toBe('false')
    // The fold does NOT rewrite the URL — `?tab=project-board` is still an accepted, still-honoured
    // key, and a reader who later opens a project from this very screen gets the board back.
    expect(h.router.replace).not.toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ tab: 'home' }) }))
  })

  it('D3: 带项目号时行为不变 —— 「项目备料」照常高亮', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    // `?projectNo=` seeded BEFORE mount, so `selectedProjectNo` starts non-empty — the fold's guard
    // condition (`selectedProjectNo.value.length > 0`) is false, so it never engages below.
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { projectNo: 'PROJECT-A' } }
    const root = await mountShell()
    expect(await waitForActive(root), 'sanity: §2.3 deep link lands on 项目备料').toBe('project-board')
    ;(root.querySelector('[data-testid="stock-prep-tab-project-board"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-board')
    expect(root.querySelector('[data-testid="stock-prep-tab-project-board"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('R-05: Home/End jump to the first/last VISIBLE tab', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const anyTab = root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement
    anyTab.focus()
    dispatchArrow(anyTab, 'End')
    await flushUi()
    // 深度工具 is collapsed, so the last VISIBLE tab is 帮助's one item — never a folded legacy tab.
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-help')
    dispatchArrow(document.activeElement as HTMLButtonElement, 'Home')
    await flushUi()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-home')
  })

  it('R-05: 折叠内(hidden)的 tab 不进入漫游 — closed, End cannot reach a legacy tab; opened, it can', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const helpTab = root.querySelector('[data-testid="stock-prep-tab-help"]') as HTMLButtonElement
    helpTab.focus()
    dispatchArrow(helpTab, 'ArrowDown')
    await flushUi()
    // 帮助 is the last group; with 深度工具 collapsed there is nothing after it to roll onto, so
    // ArrowDown from the last visible tab wraps to the FIRST visible tab — never a folded one.
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-home')

    ;(root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const helpTabAgain = root.querySelector('[data-testid="stock-prep-tab-help"]') as HTMLButtonElement
    helpTabAgain.focus()
    dispatchArrow(helpTabAgain, 'End')
    await flushUi()
    // Opened, the seven legacy tabs are reachable — End now lands on the LAST one.
    expect(document.activeElement?.getAttribute('data-testid')).toBe('stock-prep-tab-exception-queue')
  })

  it('R-05: 深度工具的 disclosure button is a DOM sibling of the tablist, never a descendant of it', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLElement
    expect(tablist.contains(toggle), 'the disclosure must not be nested inside role="tablist"').toBe(false)
    // ...and every element the tablist DOES contain is either a tab or explicitly presentational —
    // the exact leak `role="presentation"` on a WRAPPER alone does not close, because a child with its
    // own implicit role (a `<p>`, a `<button>`) is re-parented up to the tablist rather than pruned.
    for (const el of [...tablist.querySelectorAll('*')]) {
      const role = el.getAttribute('role')
      expect(['tab', 'presentation'], `${el.tagName}.${el.className || '(no class)'} inside the tablist must be role=tab or role=presentation, got ${role}`)
        .toContain(role)
    }
  })

  it('R-05: tablist 本体有可访问名,且和外层 <nav> 的名字不是同一个词', async () => {
    // MAIN HAD ONE ELEMENT (`<nav role="tablist" aria-label="备料视图">`), so the name and the role sat
    // together. Splitting the tablist down into an inner `<div>` without moving the label would leave
    // the widget APG requires to be named anonymous, and hand its old name to a `<nav>` that had just
    // become a landmark — a screen reader would announce 「备料视图 navigation」 and then a nameless tab
    // list. Both are named here, and DIFFERENTLY, so neither borrows the other's words.
    h.roles = ['admin']
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    const nav = root.querySelector('nav.sp-rail') as HTMLElement
    expect(tablist.getAttribute('role')).toBe('tablist')
    expect(tablist.getAttribute('aria-label')).toBe('备料视图')
    expect(String(nav.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0)
    expect(nav.getAttribute('aria-label')).not.toBe(tablist.getAttribute('aria-label'))
    expect(nav.contains(tablist)).toBe(true)
  })

  it('R-05: aria-controls / aria-expanded on the disclosure stay wired to the panel, and aria-owns follows the fold', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    const toggle = root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLElement
    const panel = root.querySelector('[data-testid="stock-prep-rail-advanced-panel"]') as HTMLElement
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // `aria-owns` IS THE WHOLE CORRECTNESS ARGUMENT for tabs that live outside their tablist, and it
    // had no assertion at all until this case: delete the attribute and both lanes stayed green.
    // Closed, it must be ABSENT — `hidden` has already pruned those seven, so claiming them would have
    // the tablist announce fifteen children of which seven do not exist.
    expect(tablist.getAttribute('aria-owns'), '收起时不得宣称拥有折叠区的七个 tab').toBeNull()
    toggle.click()
    await flushUi()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const owned = String(tablist.getAttribute('aria-owns') ?? '').split(/\s+/).filter(Boolean)
    const advancedIds = [...panel.querySelectorAll('[role="tab"]')].map((tab) => tab.id)
    expect(advancedIds.length).toBe(7)
    expect(owned).toEqual(advancedIds)
    // Every owned id must actually resolve — a stale id is a dangling reference, not a tab.
    for (const id of owned) expect(root.querySelector(`#${id}`), `${id} must exist`).not.toBeNull()
  })

  it('R-05: 组标题的文字不在 tablist 的可访问内容里(role=presentation 只摘元素,aria-hidden 才摘文字)', async () => {
    // THE FIRST CUT'S GUARD COULD NOT SEE ITS OWN FAILURE MODE. It enumerated `role` attributes, and a
    // `role="presentation"` heading passes that census while its TEXT is re-parented up into the
    // tablist — which is the very thing 「组标题不在 tablist 内」 was asking to remove. This case reads
    // TEXT instead: the tablist's accessible content, with `aria-hidden` subtrees removed, must be
    // exactly the tab labels and nothing else. Drop `aria-hidden` from the heading and this reddens.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement

    const heading = root.querySelector('[data-testid="stock-prep-rail-group-title-work"]') as HTMLElement
    expect(heading.getAttribute('role')).toBe('presentation')
    expect(heading.getAttribute('aria-hidden'), 'presentation alone leaves the WORDS in the tablist').toBe('true')
    expect(tablist.contains(heading), 'the heading stays nested — the CSS grouping needs it there').toBe(true)

    const clone = tablist.cloneNode(true) as HTMLElement
    for (const hidden of [...clone.querySelectorAll('[aria-hidden="true"]')]) hidden.remove()
    const accessibleText = (clone.textContent ?? '').replace(/\s+/g, '')
    const tabText = [...tablist.querySelectorAll('[role="tab"]')]
      .map((tab) => (tab.textContent ?? '').replace(/\s+/g, ''))
      .join('')
    expect(accessibleText).toBe(tabText)
    expect(accessibleText).not.toContain('工作')
    expect(accessibleText).toContain('今天要处理')
  })

  it('R-05: 每个 tab 都用 aria-labelledby 借组标题的词 —— 折叠区那七个也一样,一条 rail 不许两套命名', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-rail-advanced-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[]
    expect(tabs.length, '8 常驻 + 7 折叠').toBe(15)
    for (const tab of tabs) {
      const refs = String(tab.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      expect(refs.length, `${tab.dataset.testid} 必须借组标题 + 自己两个 id`).toBe(2)
      expect(refs[1], `${tab.dataset.testid} 的第二个引用必须是它自己`).toBe(tab.id)
      const groupHeading = root.querySelector(`#${refs[0]}`)
      expect(groupHeading, `${tab.dataset.testid} 引用的组标题 ${refs[0]} 必须存在`).not.toBeNull()
      expect(groupHeading?.getAttribute('role')).toBe('presentation')
    }
    // 折叠区那七个借的是【部署与接入】的标题 —— 它们在 manifest 里就挂在那一组下面。
    const legacy = root.querySelector('[data-testid="stock-prep-tab-exception-queue"]') as HTMLElement
    expect(String(legacy.getAttribute('aria-labelledby')).split(/\s+/)[0]).toBe('stock-prep-rail-group-title-deploy')
  })

  // -------------------------------------------------------------------------
  // R-06 — useMobileViewport 监听 matchMedia 的 change 事件 (hardening wave)
  // -------------------------------------------------------------------------

  /**
   * A minimal, controllable `MediaQueryList` stub. Unlike `approvalMobileResponsive.spec.ts`'s
   * `setViewport` (whose `addEventListener` is a permanent no-op — it exists only so code that
   * REGISTERS a listener does not throw), this one actually KEEPS the registered callback and lets
   * the test fire it — that is the one thing `resize`-only coverage cannot exercise: devtools'
   * responsive-mode width picker, an external-display connect/disconnect, or any other change that
   * flips a media query's match state WITHOUT the window itself firing `resize`.
   */
  function stubMatchMedia(): { fire: (matches: boolean) => void; restore: () => void } {
    const original = window.matchMedia
    let matches = false
    const listeners = new Set<() => void>()
    const mql = {
      get matches() { return matches },
      media: RAIL_NARROW_QUERY,
      addEventListener: (type: string, cb: () => void) => { if (type === 'change') listeners.add(cb) },
      removeEventListener: (type: string, cb: () => void) => { listeners.delete(cb) },
    } as unknown as MediaQueryList
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).matchMedia = () => mql
    return {
      fire(next: boolean) {
        matches = next
        listeners.forEach((cb) => cb())
      },
      restore() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).matchMedia = original
      },
    }
  }

  const RAIL_NARROW_QUERY = '(max-width: 899px)'

  it('R-06: matchMedia 的 change 触发后 aria-orientation 立即变化 —— 不需要 resize 事件', async () => {
    const stub = stubMatchMedia()
    try {
      h.roles = ['admin']
      const root = await mountShell()
      const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
      expect(tablist.getAttribute('aria-orientation'), 'stub starts not-narrow').toBe('vertical')
      // Fire ONLY the media query's own `change` event — no `resize` dispatched at all — so a pass
      // here is proof the `change` listener itself is what moved `isMobile`, not the resize fallback.
      stub.fire(true)
      await flushUi()
      expect(tablist.getAttribute('aria-orientation')).toBe('horizontal')
      stub.fire(false)
      await flushUi()
      expect(tablist.getAttribute('aria-orientation')).toBe('vertical')
    } finally {
      stub.restore()
    }
  })

  it('R-06: resize 仍是兜底 —— matchMedia 不可用时退回 window resize', async () => {
    // No `stubMatchMedia()` here: jsdom's own `window.matchMedia` is undefined, exactly the
    // environment `useMobileViewport`'s guard exists for, and `updateMobileState` still runs on
    // `resize` — reading `matchesMediaQuery`, which answers `false` without a real `matchMedia` either
    // way. This is the "nothing throws, the fallback path still executes" half of the guarantee.
    h.roles = ['admin']
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    expect(tablist.getAttribute('aria-orientation')).toBe('vertical')
    window.dispatchEvent(new Event('resize'))
    await flushUi()
    expect(tablist.getAttribute('aria-orientation'), 'no matchMedia to answer true from — stays vertical').toBe('vertical')
  })

  // -------------------------------------------------------------------------
  // D2=A — the landing, at the DOM level, all four postures
  // -------------------------------------------------------------------------

  it('D2=A: 未装完 → 平台管理员/工作台管理员落「开始使用」', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    answerReads(NOT_INSTALLED)
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('getting-started')
  })

  it('D2=A: 装完 → 落「记录与排查」(总览)', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    answerReads(INSTALLED)
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('ops')
  })

  it('D2=A: 读不到 → 仍落「开始使用」,绝不落「记录与排查」', async () => {
    // 「看不到」 is not 「装完了」. A refused/failed preflight must not send an admin to a health page
    // about a deployment nobody could read — that would be telling them a story we do not have.
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    answerReads(null)
    const root = await mountShell()
    const active = await waitForActive(root)
    expect(active).toBe('getting-started')
    expect(active).not.toBe('ops')
  })

  it('D2=A: 一线落「今天要处理」,且不为落地发任何 preflight 读', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    answerReads(INSTALLED)
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('home')
    // An operator's landing is decided from permissions alone. If it ever started depending on the
    // preflight, the floor's first paint would wait on a read their tier may not even be allowed.
    const preflightReads = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/stock-preparation/preflight'))
    expect(preflightReads).toEqual([])
  })

  it('D2=A: 纯 read 的落地一个字没改 —— 仍是确认队列', async () => {
    h.permissions = ['stock-prep:read']
    h.roles = []
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('confirmation-queue')
  })

  // -------------------------------------------------------------------------
  // §2.3 — `?projectNo=` is the 首页 ⇄ 工作区 state bit, and it outranks the landing
  // -------------------------------------------------------------------------

  it('§2.3: `?projectNo=` 深链/刷新仍然打开那个项目,而不是落回「今天要处理」', async () => {
    // THE REGRESSION THIS PINS. Before P1-1 an operator's landing WAS 项目备料, so a URL carrying a
    // project number opened it by accident of the default. P1-1 moved the landing to 今天要处理 —
    // whose branch passes an EMPTY project number on purpose — and nothing carried the state bit
    // across, so a reload or a shared link painted the task list while the number sat in the address
    // bar. §2.3 says in so many words that a reload, a shared link and the back button reopen the
    // same project, and `?tab=` cannot compensate: this wave writes it in, never out.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    h.route = {
      path: '/stock-prep',
      fullPath: '/stock-prep',
      meta: {},
      // Values-free: a shape, not a customer's number.
      query: { projectNo: 'PROJECT-A' },
    }
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('project-board')
  })

  it('§2.3: 没有 `?projectNo=` 时一线仍落「今天要处理」—— 深链是加法,不是新落地页', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('home')
  })

  it('§2.3: 点左栏「今天要处理」会把 `?projectNo=` 清掉 —— 地址栏和屏幕不许各说各话', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { projectNo: 'PROJECT-A' } }
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('project-board')
    ;(root.querySelector('[data-testid="stock-prep-tab-home"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('home')
    // The number is REMOVED rather than blanked: `?projectNo=` with an empty value is not the same
    // URL as one carrying none, and the shell's own comment says why.
    const lastReplace = h.router.replace.mock.calls.at(-1)?.[0] as { query?: Record<string, unknown> } | undefined
    expect(lastReplace, 'picking 今天要处理 with a project open must rewrite the query').toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(lastReplace!.query ?? {}, 'projectNo')).toBe(false)
  })

  it('§2.3: 纯 read 带着 `?projectNo=` 仍落确认队列 —— 深链不能开一扇本来关着的门', async () => {
    // Folded through `visibleViews` like every other landing branch: 项目备料 is not this tier's, so
    // a link naming a project cannot conjure it.
    h.permissions = ['stock-prep:read']
    h.roles = []
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { projectNo: 'PROJECT-A' } }
    const root = await mountShell()
    expect(await waitForActive(root)).toBe('confirmation-queue')
  })

  // -------------------------------------------------------------------------
  // 开始使用 / 数据来源与体检 — ONE component, two modes, and what each must render
  // -------------------------------------------------------------------------

  it('mode: 「开始使用」出向导 + 源绑定面板 + ② 的检查按钮,不出安装页三分区', async () => {
    // The install view's `mode` prop is the whole of P1-1's 「不重复渲染」 claim, and until now no
    // assertion touched either shipped value — the only spec that mounts that component uses the
    // default `'full'`, which no caller passes. Nesting the `mode !== 'wizard'` wrapper one level
    // wrong would blank 数据来源与体检 with every suite still green.
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-getting-started"]') as HTMLButtonElement).click()
    await flushUi()
    const install = root.querySelector('[data-testid="stock-prep-install"]')
    expect(install?.getAttribute('data-mode')).toBe('wizard')
    expect(root.querySelector('[data-testid="stock-prep-getting-started"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-install-intro"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-install-review-section"]')).toBeNull()
    // ③「告诉备料用这条源」的执行位必须跟着向导走 —— 少了它,①③ 永远是「? 看不到」。
    expect(root.querySelector('[data-testid="stock-prep-source-binding"]')).not.toBeNull()
    // ②「证明它只能读」的执行位:这一档跑不了(要 integration 权限),所以出的是说明而不是按钮。
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-verify-denied"]')).not.toBeNull()
  })

  it('mode: 「开始使用」读不到时也说得出为什么 —— 报错条与「复制这条报错」都在', async () => {
    // THE BLIND MODE. `mode="wizard"` renders the wizard and (before this fix) nothing else, so the
    // one paragraph this component uses to report its OWN failed reads sat inside the review-only
    // wrapper. D2 lands a brand-new deployment's admin here, and a refused/500 manifest read left
    // them looking at 「? 看不到」 on every step with no HTTP code, no next step and no
    // 复制这条报错 — 「读不到」 rendered as 「没完成」, manufactured by us.
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    h.apiFetch.mockImplementation(async (url: string) => {
      const target = String(url)
      if (target.includes('/platform/apps/stock-preparation')) {
        return new Response(JSON.stringify({ ok: false }), { status: 500 })
      }
      if (target.includes('/stock-preparation/preflight')) {
        return new Response(JSON.stringify({ ok: true, data: NOT_INSTALLED }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { eligibleSources: [] } }), { status: 200 })
    })
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-getting-started"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(root.querySelector('[data-testid="stock-prep-install"]')?.getAttribute('data-mode')).toBe('wizard')
    // 仍然只出向导 —— 这条报错不是把复查区偷偷带回来了。
    expect(root.querySelector('[data-testid="stock-prep-install-intro"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-install-review-section"]')).toBeNull()
    const error = root.querySelector('[data-testid="stock-prep-install-error"]')
    expect(error, '向导模式下读不到也要说读不到').not.toBeNull()
    expect(error!.textContent).toContain('500')
    expect(root.querySelector('[data-testid="stock-prep-install-error-copy"]'), '「复制这条报错」是这条报错唯一的出口').not.toBeNull()
  })

  it('mode: 「数据来源与体检」出三分区,不再出向导', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-install"]') as HTMLButtonElement).click()
    await flushUi()
    const install = root.querySelector('[data-testid="stock-prep-install"]')
    expect(install?.getAttribute('data-mode')).toBe('review')
    expect(root.querySelector('[data-testid="stock-prep-getting-started"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-install-intro"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-install-review-section"]')).not.toBeNull()
    // 源绑定面板在两种形态里都在 —— 它是「数据来源」这一段本身。
    expect(root.querySelector('[data-testid="stock-prep-source-binding"]')).not.toBeNull()
  })

  it('mode: 能跑源预检的人,在向导里就有 ②「检查这个源」这颗按钮', async () => {
    // 线框 B's step table puts ②「在哪做 = 本页」. The card that carries this action lives in the
    // install page's region ③, i.e. NOT on 开始使用 — so without this entry point ② would read
    // 「未检查」 for ever on the page D2 lands a new deployment's admin on, with nothing to press.
    h.permissions = []
    h.roles = ['admin']
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-getting-started"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-run-source-preflight"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-verify-denied"]')).toBeNull()
  })

  it('A1 死路:空队列的「去装:开始使用」按钮真的到得了向导', async () => {
    // 设计稿 §2.3's minimal fix for A1 sends an admin stranded on an empty queue to the wizard. While
    // the wizard rode the install page's first screen, `navigate-stage('install')` did that; P1-1
    // made the install page render `mode="review"`, so the same emit would now land on a page with
    // no 开始使用 on it. The destination is asserted here rather than in the queue's own suite
    // because only the shell knows what a stage name resolves to.
    const queue = readFileSync(
      join(__dirname, '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'),
      'utf8',
    )
    const at = queue.indexOf('data-testid="stock-prep-confirmation-empty-go-install"')
    expect(at).toBeGreaterThan(-1)
    expect(queue.slice(at, at + 220)).toContain("emit('navigate-stage', 'getting-started')")
  })

  // -------------------------------------------------------------------------
  // 旧 key 不删:`?tab=` 深链与既有 key
  // -------------------------------------------------------------------------

  it('?tab= 接受旧 key(project-board)与新 key(ops),未知值回落到落地页', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    h.roles = []

    // `projectNo` rides along (hardening wave, D3): `project-board` with NO number now folds its
    // highlight to `home` (see the D3 block above), so this old-key-still-works assertion needs a
    // number in the URL to stay about what it was written to test — that `?tab=project-board` is
    // still an accepted key — rather than incidentally exercising the new fold.
    h.route = {
      path: '/stock-prep',
      fullPath: '/stock-prep',
      meta: {},
      query: { tab: 'project-board', projectNo: 'PROJECT-A' },
    }
    let root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-board')
    app!.unmount()
    app = null

    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { tab: 'ops' } }
    root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('ops')
    app!.unmount()
    app = null

    // A stale or mistyped key is not an error page: it falls through to whatever D2 decided.
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { tab: 'no-such-view' } }
    answerReads(NOT_INSTALLED)
    root = await mountShell()
    expect(await waitForActive(root)).toBe('getting-started')
  })

  // -------------------------------------------------------------------------
  // 【帮助】 — 怎么用这个页面 + 错误码对照, one rail item, two sections
  // -------------------------------------------------------------------------

  it('【帮助】 renders the static card AND the code reference, and links only to reachable views', async () => {
    h.permissions = ['stock-prep:read']
    h.roles = []
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-help"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-help-card"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-help-code-reference"]')).not.toBeNull()
    // All three flows are described for everyone — that is what a help page is for — but a LINK is a
    // control, so this actor (who has neither 今天要处理 nor 开始使用 nor 记录与排查) gets none of
    // the three jump buttons.
    for (const flow of ['daily', 'onboarding', 'troubleshooting']) {
      expect(root.querySelector(`[data-testid="stock-prep-help-flow-${flow}"]`), `${flow} copy`).not.toBeNull()
      expect(root.querySelector(`[data-testid="stock-prep-help-link-${flow}"]`), `${flow} link`).toBeNull()
    }
  })

  it('【帮助】 的直链会真的切过去(平台管理员:三条都在)', async () => {
    h.roles = ['admin']
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-help"]') as HTMLButtonElement).click()
    await flushUi()
    for (const flow of ['daily', 'onboarding', 'troubleshooting']) {
      expect(root.querySelector(`[data-testid="stock-prep-help-link-${flow}"]`), `${flow} link`).not.toBeNull()
    }
    ;(root.querySelector('[data-testid="stock-prep-help-link-troubleshooting"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('ops')
  })

  // -------------------------------------------------------------------------
  // 位置纪律 — the notice that must stay out of the chain
  // -------------------------------------------------------------------------

  it('stock-prep-admin-action-notice 仍在整条 v-if/v-else-if 链之外', () => {
    // The shell carries an all-caps comment about the one time this went wrong: inserting the notice
    // into the middle of the chain swallowed the rest of it. Moving the whole chain inside a new
    // two-column layout is exactly the kind of edit that could have re-done it, so the pin moves with
    // it — the notice's <section> must not carry a `v-else-if`.
    const shell = readFileSync(
      join(__dirname, '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'),
      'utf8',
    )
    const at = shell.indexOf('data-testid="stock-prep-admin-action-notice"')
    expect(at).toBeGreaterThan(-1)
    const opening = shell.lastIndexOf('<p', at)
    const tag = shell.slice(opening, at)
    // Its OWN `v-if`, never a `v-else-if` — the latter would attach it to the preceding branch.
    expect(tag).toContain('v-if="adminActionNotice"')
    expect(tag).not.toContain('v-else')
    // ...and it sits AFTER the chain's terminal `v-else` (the container placeholder), with no
    // `v-else-if` between the two — i.e. the chain is closed before the notice begins.
    const terminal = shell.indexOf('data-testid="stock-prep-panel-pending"')
    expect(terminal).toBeGreaterThan(-1)
    expect(terminal).toBeLessThan(opening)
    // Comments stripped first: the shell carries a long PROSE warning about `v-else-if` in exactly
    // this gap, and matching it would make the pin pass on the explanation rather than on the markup.
    const between = shell.slice(terminal, opening).replace(/<!--[\s\S]*?-->/g, '')
    expect(between).not.toContain('v-else-if')
  })
})
