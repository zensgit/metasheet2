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
    keys: ['home', 'project-board', 'confirmation-queue', 'help'],
  },
  {
    // stock-prep:admin — the workbench ceiling. It opens the WHOLE 【部署与接入】 group (开始使用 and
    // 记录与排查 ride exactly the `canOpenStockPrepInstallView` gate the install tab always did), and
    // through the ladder it also satisfies operate, so 【工作】 comes with it. 深度工具 does NOT:
    // the legacy tabs stayed platform-admin, which is what 「canUseLegacyMvpTabs 不变」 means.
    name: 'stock-prep:admin',
    permissions: ['stock-prep:read', 'stock-prep:admin'],
    roles: [],
    keys: ['home', 'project-board', 'confirmation-queue', 'getting-started', 'install', 'ops', 'help'],
  },
  {
    // 平台管理员 — everything, 深度工具's seven included.
    name: '平台管理员',
    permissions: [],
    roles: ['admin'],
    keys: [
      'home', 'project-board', 'confirmation-queue',
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
      'home', 'project-board', 'confirmation-queue',
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
    // query cannot do that — there is one `<nav role="tablist">`, rendered at every width, and the
    // fold only changes its flex direction.
    expect(RAIL_SRC).toContain('@media (max-width: 899px)')
    expect(RAIL_SRC).toMatch(/<nav\s/)
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

  it('mode: 「安装 / 体检」出三分区,不再出向导', async () => {
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

    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: { tab: 'project-board' } }
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
