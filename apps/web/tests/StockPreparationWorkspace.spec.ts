import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as vh, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import {
  ATTENDANCE_FOCUS_ALLOWED_PATHS,
  PLM_WORKBENCH_ALLOWED_PREFIXES,
  buildRouteGuardContext,
  buildRouteGuardInput,
  resolveRouteGuardDecision,
} from '../src/router/guardPolicy'
import { join } from 'node:path'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Covers ONLY the new sp-fe-shell surface: the routed tabbed workspace shell, its route
// registration, the permission-gated App nav entry, and four readonly per-view service reads
// (project overview, snapshot-batch list/diff, material-mapping summary, unit-conversion summary —
// each wired into its own view). The prep-line and exception-queue summary stubs that used to live
// here were dead code (zero callers outside this spec; view 5/6 read the real W5a list endpoints
// instead) and were removed under the T6 FE cleanup (#3751 remaining-dev).
// (Unrelated apps/web specs are red on main from api mocks — this spec asserts only its own surface.)

// Shared mutable holder — vi.hoisted so the mock factories below can read it, and the test body can
// flip locale / permission BEFORE each mount (useLocale/useAuth are invoked fresh per mount).
const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  hasPerm: true,
  route: {
    path: '/multitable',
    fullPath: '/multitable',
    meta: {} as Record<string, unknown>,
    query: {} as Record<string, unknown>,
  },
  // Shared router double so tests can assert on replace (shell mirrors projectId into the query).
  router: { push: vi.fn(), replace: vi.fn() },
  apiFetch: vi.fn(),
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  fetchPlugins: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRoute: () => h.route,
    useRouter: () => h.router,
  }
})

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: h.fetchPlugins }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: h.loadProductFeatures,
    isAttendanceFocused: () => false,
    isPlmWorkbenchFocused: () => false,
    hasFeature: () => false,
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, email: '' }),
    hasPermission: (permission: string) => permission === 'integration:write' && h.hasPerm,
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return {
    ...actual,
    apiFetch: h.apiFetch,
    clearStoredAuthState: vi.fn(),
    getApiBase: () => 'https://api.example.com',
  }
})

import App from '../src/App.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import { getStockPreparationWorkspaceOverview } from '../src/services/integration/stockPreparation/projectWorkspace'
import {
  getStockPreparationSnapshotDiff,
  listStockPreparationSnapshotBatches,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'
import { getStockPreparationMaterialMappingSummary } from '../src/services/integration/stockPreparation/materialMapping'
import { getStockPreparationUnitConversionSummary } from '../src/services/integration/stockPreparation/unitConversion'

// Values-free forbidden-substring guard: rendered shell copy must never surface any of these.
const FORBIDDEN_SUBSTRINGS = [
  'password',
  'token',
  'authorityCode',
  'connection-string',
  'connectionString',
  'secret',
]

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// Bounded polling wait (same idiom as waitForText in the AfterSalesView specs) for DOM that appears
// after a REAL Response body read: `new Response(...).json()` can take macrotask turns, so
// microtask-only flushUi cycles are timing-fragile on slower CI runners. Each cycle yields one
// macrotask + nextTick; throws on timeout so a missing element fails loudly, not as a null deref.
async function waitForSelector(container: HTMLElement, selector: string, cycles = 40): Promise<Element> {
  for (let i = 0; i < cycles; i += 1) {
    const el = container.querySelector(selector)
    if (el) return el
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`Timed out waiting for selector: ${selector}`)
}

const VIEW_KEYS = [
  'dashboard',
  'project-workspace',
  'bom-snapshot-diff',
  'material-mapping',
  'unit-conversion',
  'prep-line',
  'exception-queue',
] as const

// Source-level drift pin (matching the repo idiom in approvalTemplateRouteGuard.spec.ts): importing
// appRoutes eagerly pulls every view + element-plus CSS into jsdom, so assert on the source text.
describe('Stock Preparation route registration (source drift pin)', () => {
  const SRC = readFileSync(join(__dirname, '../src/router/appRoutes.ts'), 'utf8')

  function routeBlockByPath(path: string): string | null {
    const i = SRC.indexOf(`path: '${path}'`)
    if (i === -1) return null
    const end = SRC.indexOf('\n  },', i)
    return end === -1 ? SRC.slice(i) : SRC.slice(i, end)
  }

  it('registers /stock-prep bound to a lazy shell component and the integration:write gate', () => {
    const block = routeBlockByPath('/stock-prep')
    expect(block, 'route /stock-prep must exist in appRoutes.ts').toBeTruthy()
    expect(block).toContain('AppRouteNames.INTEGRATION_STOCK_PREPARATION')
    expect(block).toContain("import('../components/integration/stockPreparation/StockPreparationWorkspace.vue')")
    expect(block).toMatch(/requiresAuth:\s*true/)
    expect(block).toMatch(/permissions:\s*\[\s*'integration:write'\s*\]/)
    expect(block).toContain("titleZh: '备料工作台'")
  })

  it('binds the route name constant to the string the router uses', () => {
    const TYPES = readFileSync(join(__dirname, '../src/router/types.ts'), 'utf8')
    expect(TYPES).toContain("INTEGRATION_STOCK_PREPARATION: 'integration-stock-preparation'")
  })

  // Round-12 terminal state (owner-prescribed): guard decision logic is a PURE, directly
  // executable function (src/router/guardPolicy.ts) pinned by BEHAVIOR — permission ordering,
  // focus semantics and redirect targets are exercised, not pattern-matched. main.ts keeps only a
  // thin delegation, pinned structurally below (direct statements of the guard's try block).
  describe('route guard policy (behavior)', () => {
    const ctx = (over: Partial<import('../src/router/guardPolicy').RouteGuardPolicyContext> = {}) => ({
      hasFeature: () => true,
      hasPermission: () => true,
      attendanceFocused: false,
      plmWorkbenchFocused: false,
      resolveHomePath: () => '/HOME',
      ...over,
    })
    const decide = (path: string, meta: unknown, over: Parameters<typeof ctx>[0] = {}) =>
      resolveRouteGuardDecision({ path, meta }, ctx(over))

    it('permission denial redirects home and WINS over a focus-mode allowlist match (ordering)', () => {
      expect(decide('/stock-prep', { permissions: ['integration:write'] }, { hasPermission: () => false, plmWorkbenchFocused: true }))
        .toEqual({ action: 'redirect', target: '/HOME' })
      expect(decide('/stock-prep', { permissions: ['integration:write'] }, { plmWorkbenchFocused: true }))
        .toEqual({ action: 'allow' })
    })

    it('plm-workbench focus: every allowlisted prefix (exact and subpath) is reachable — /stock-prep included', () => {
      for (const prefix of PLM_WORKBENCH_ALLOWED_PREFIXES) {
        expect(decide(prefix, {}, { plmWorkbenchFocused: true })).toEqual({ action: 'allow' })
        expect(decide(`${prefix}/deep/link`, {}, { plmWorkbenchFocused: true })).toEqual({ action: 'allow' })
      }
    })

    it('plm-workbench focus: anything else redirects to /plm (an empty/loose prefix would break this)', () => {
      for (const path of ['/multitable', '/apps', '/stock-preparation', '/x', '']) {
        expect(decide(path, {}, { plmWorkbenchFocused: true })).toEqual({ action: 'redirect', target: '/plm' })
      }
    })

    it('attendance focus: exact paths only — subpaths redirect to /attendance', () => {
      for (const path of ATTENDANCE_FOCUS_ALLOWED_PATHS) {
        expect(decide(path, {}, { attendanceFocused: true })).toEqual({ action: 'allow' })
      }
      expect(decide('/attendance/sub', {}, { attendanceFocused: true })).toEqual({ action: 'redirect', target: '/attendance' })
      expect(decide('/multitable', {}, { attendanceFocused: true })).toEqual({ action: 'redirect', target: '/attendance' })
    })

    it('required-feature gate redirects home before focus handling; unknown feature strings are ignored', () => {
      expect(decide('/plm', { requiredFeature: 'plm' }, { hasFeature: () => false, plmWorkbenchFocused: true }))
        .toEqual({ action: 'redirect', target: '/HOME' })
      expect(decide('/plm', { requiredFeature: 'nonsense' }, { hasFeature: () => false })).toEqual({ action: 'allow' })
    })

    it('the plm allowlist is exactly the five workbench prefixes — all non-empty absolute strings', () => {
      expect([...PLM_WORKBENCH_ALLOWED_PREFIXES]).toEqual(['/plm', '/workflows', '/approvals', '/integrations', '/stock-prep'])
      expect(PLM_WORKBENCH_ALLOWED_PREFIXES.every((p) => typeof p === 'string' && p.startsWith('/') && p.length > 1)).toBe(true)
    })

    // Round-13: pairwise priority matrix — the declared ordering (feature → permission →
    // attendance → plm) is pinned as behavior, not prose. Swapping any two stages breaks a case.
    it('priority matrix: every earlier stage wins over every later stage', () => {
      // feature deny + plm focus (path not plm-allowed): feature wins → /HOME (not /plm).
      expect(decide('/x', { requiredFeature: 'plm' }, { hasFeature: () => false, plmWorkbenchFocused: true }))
        .toEqual({ action: 'redirect', target: '/HOME' })
      // permission deny + attendance focus: permission wins → /HOME (not /attendance).
      expect(decide('/x', { permissions: ['integration:write'] }, { hasPermission: () => false, attendanceFocused: true }))
        .toEqual({ action: 'redirect', target: '/HOME' })
      // attendance AND plm both on, path allowed by neither: attendance wins → /attendance (not /plm).
      expect(decide('/x', {}, { attendanceFocused: true, plmWorkbenchFocused: true }))
        .toEqual({ action: 'redirect', target: '/attendance' })
      // feature deny short-circuits: the permission probe must NOT be consulted (ordering contract).
      let permissionProbed = false
      expect(decide('/x', { requiredFeature: 'plm', permissions: ['integration:write'] }, {
        hasFeature: () => false,
        hasPermission: () => {
          permissionProbed = true
          return true
        },
      })).toEqual({ action: 'redirect', target: '/HOME' })
      expect(permissionProbed, 'feature denial must short-circuit before the permission probe').toBe(false)
    })

    // Round-13: the runtime adapter is executable and fake-injectable — its wiring is behavior.
    it('buildRouteGuardContext delegates hasPermission to auth.hasPermission and keeps the typeof tolerance', () => {
      const seen: string[] = []
      const deps = {
        auth: { hasPermission: (p: string) => { seen.push(p); return p === 'integration:write' } },
        flags: {
          hasFeature: () => true,
          isAttendanceFocused: () => false,
          isPlmWorkbenchFocused: () => true,
          resolveHomePath: () => '/HOME',
        },
      }
      const built = buildRouteGuardContext(deps)
      expect(built.hasPermission('integration:write')).toBe(true)
      expect(built.hasPermission('other:perm')).toBe(false)
      expect(seen).toEqual(['integration:write', 'other:perm'])
      expect(built.plmWorkbenchFocused).toBe(true)
      // typeof tolerance: absent / non-function isPlmWorkbenchFocused folds to false.
      expect(buildRouteGuardContext({ ...deps, flags: { ...deps.flags, isPlmWorkbenchFocused: undefined } }).plmWorkbenchFocused).toBe(false)
      expect(buildRouteGuardContext({ ...deps, flags: { ...deps.flags, isPlmWorkbenchFocused: 42 } }).plmWorkbenchFocused).toBe(false)
      // end-to-end: adapter-built context + real policy = real deny behavior.
      const denyDeps = { ...deps, auth: { hasPermission: () => false } }
      expect(resolveRouteGuardDecision({ path: '/stock-prep', meta: { permissions: ['integration:write'] } }, buildRouteGuardContext(denyDeps)))
        .toEqual({ action: 'redirect', target: '/HOME' })
    })

    // Round-14: the INPUT adapter is behavior-pinned too — meta must pass through IDENTICALLY
    // (an inline meta: {} bypassed every route's requiredFeature/permissions, M20).
    it('buildRouteGuardInput passes meta through identically and folds path to a string', () => {
      const meta = { permissions: ['integration:write'], requiredFeature: 'plm' }
      const input = buildRouteGuardInput({ path: '/stock-prep', meta })
      expect(input.meta).toBe(meta)
      expect(input.path).toBe('/stock-prep')
      expect(buildRouteGuardInput({ path: undefined, meta }).path).toBe('')
      expect(buildRouteGuardInput({ path: 123 as unknown as string, meta }).path).toBe('123')
      // end-to-end: real route meta flows through input adapter + ctx adapter into the policy.
      const deps = {
        auth: { hasPermission: () => false },
        flags: {
          hasFeature: () => true,
          isAttendanceFocused: () => false,
          isPlmWorkbenchFocused: () => false,
          resolveHomePath: () => '/HOME',
        },
      }
      expect(resolveRouteGuardDecision(buildRouteGuardInput({ path: '/stock-prep', meta }), buildRouteGuardContext(deps)))
        .toEqual({ action: 'redirect', target: '/HOME' })
    })

    // Round-14: adapter fields item-by-item (M21 proved hasFeature was unpinned; attendanceFocused
    // and resolveHomePath get the same treatment).
    it('buildRouteGuardContext delegates hasFeature / attendanceFocused / resolveHomePath faithfully', () => {
      const featureSeen: string[] = []
      const deps = {
        auth: { hasPermission: () => true },
        flags: {
          hasFeature: (f: string) => { featureSeen.push(f); return f === 'plm' },
          isAttendanceFocused: () => true,
          isPlmWorkbenchFocused: () => false,
          resolveHomePath: () => '/HOME-LAZY',
        },
      }
      const built = buildRouteGuardContext(deps)
      expect(built.hasFeature('plm' as never)).toBe(true)
      expect(built.hasFeature('workflow' as never)).toBe(false)
      expect(featureSeen).toEqual(['plm', 'workflow'])
      expect(built.attendanceFocused).toBe(true)
      expect(built.resolveHomePath()).toBe('/HOME-LAZY')
      // adapter+policy feature-deny discriminating leg: a real feature denial through the ADAPTER
      // must redirect home (an adapter hasFeature: () => true erases this).
      const denyFeature = { ...deps, flags: { ...deps.flags, hasFeature: () => false, isAttendanceFocused: () => false } }
      expect(resolveRouteGuardDecision({ path: '/plm', meta: { requiredFeature: 'plm' } }, buildRouteGuardContext(denyFeature)))
        .toEqual({ action: 'redirect', target: '/HOME-LAZY' })
    })
  })

  // Thin delegation pin: main.ts must DELEGATE to the policy as DIRECT statements of the guard's
  // try block — `const decision = resolveRouteGuardDecision(...)` followed by the redirect
  // if-statement whose branch is exactly `return next(decision.target)`. Decision logic must not be
  // re-inlined (negative token pins). Dead-branch wrapping breaks the direct-statement requirement.
  it('main.ts delegates guard decisions to guardPolicy (direct statements; no inlined decision logic)', async () => {
    const ts = (await import('typescript')).default
    type TsNode = import('typescript').Node
    const MAIN = readFileSync(join(__dirname, '../src/main.ts'), 'utf8')
    expect(MAIN).not.toContain('allowedPrefixes')
    expect(MAIN).not.toContain('isRoutePermitted(')
    expect(MAIN).not.toContain('hasPermission:')
    expect(MAIN).toContain("import { buildRouteGuardContext, buildRouteGuardInput, resolveRouteGuardDecision } from './router/guardPolicy'")

    const source = ts.createSourceFile('main.ts', MAIN, ts.ScriptTarget.ES2022, true)
    let guardBody: import('typescript').Block | null = null
    const findGuard = (node: TsNode): void => {
      if (
        guardBody === null &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'beforeEach' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'router' &&
        node.arguments.length >= 1 &&
        ts.isArrowFunction(node.arguments[0]) &&
        ts.isBlock((node.arguments[0] as import('typescript').ArrowFunction).body)
      ) {
        guardBody = (node.arguments[0] as import('typescript').ArrowFunction).body as import('typescript').Block
        return
      }
      ts.forEachChild(node, findGuard)
    }
    findGuard(source)
    expect(guardBody, 'router.beforeEach(arrow with block body) must exist').not.toBeNull()

    // The try statement is a DIRECT statement of the guard body; the delegation pair must be DIRECT
    // statements of its try block.
    const tryStmt = guardBody!.statements.find((st) => ts.isTryStatement(st)) as
      | import('typescript').TryStatement
      | undefined
    expect(tryStmt, 'the guard must contain its try/catch as a direct statement').toBeTruthy()
    const stmts = tryStmt!.tryBlock.statements

    const declIdx = stmts.findIndex(
      (st) =>
        ts.isVariableStatement(st) &&
        st.declarationList.declarations.some(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text === 'decision' &&
            !!d.initializer &&
            ts.isCallExpression(d.initializer) &&
            ts.isIdentifier(d.initializer.expression) &&
            d.initializer.expression.text === 'resolveRouteGuardDecision' &&
            // Round-13/14: BOTH arguments must be executable adapter calls — inline objects (where
            // hasPermission: () => true or meta: {} could hide) are not accepted shapes.
            d.initializer.arguments.length === 2 &&
            ts.isCallExpression(d.initializer.arguments[0]) &&
            ts.isIdentifier((d.initializer.arguments[0] as import('typescript').CallExpression).expression) &&
            ((d.initializer.arguments[0] as import('typescript').CallExpression).expression as import('typescript').Identifier).text === 'buildRouteGuardInput' &&
            ts.isCallExpression(d.initializer.arguments[1]) &&
            ts.isIdentifier((d.initializer.arguments[1] as import('typescript').CallExpression).expression) &&
            ((d.initializer.arguments[1] as import('typescript').CallExpression).expression as import('typescript').Identifier).text === 'buildRouteGuardContext',
        ),
    )
    expect(declIdx, 'const decision = resolveRouteGuardDecision(...) must be a DIRECT try-block statement').toBeGreaterThan(-1)

    const redirectIdx = stmts.findIndex((st) => {
      if (!ts.isIfStatement(st)) return false
      // Round-13: the CONDITION must be exactly decision.action === 'redirect' — if (false) around
      // the same branch body previously passed.
      const cond = st.expression
      const condOk =
        ts.isBinaryExpression(cond) &&
        cond.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isPropertyAccessExpression(cond.left) &&
        cond.left.name.text === 'action' &&
        ts.isIdentifier(cond.left.expression) &&
        cond.left.expression.text === 'decision' &&
        ts.isStringLiteral(cond.right) &&
        cond.right.text === 'redirect'
      if (!condOk) return false
      const thenSt = st.thenStatement
      const single = ts.isBlock(thenSt)
        ? thenSt.statements.length === 1
          ? thenSt.statements[0]
          : null
        : thenSt
      return (
        !!single &&
        ts.isReturnStatement(single) &&
        !!single.expression &&
        ts.isCallExpression(single.expression) &&
        ts.isIdentifier(single.expression.expression) &&
        single.expression.expression.text === 'next' &&
        single.expression.arguments.length === 1 &&
        ts.isPropertyAccessExpression(single.expression.arguments[0]) &&
        single.expression.arguments[0].name.text === 'target' &&
        ts.isIdentifier(single.expression.arguments[0].expression) &&
        single.expression.arguments[0].expression.text === 'decision'
      )
    })
    expect(redirectIdx, 'if (…) { return next(decision.target) } must be a DIRECT try-block statement').toBeGreaterThan(declIdx)
  })

})

describe('StockPreparationWorkspace shell', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
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

  async function mountShell(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flushUi()
    return container!
  }

  it('renders the tablist with the dashboard tab (H1/H2) plus all six MVP view tabs', async () => {
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]')
    expect(tablist).not.toBeNull()
    expect(tablist!.getAttribute('role')).toBe('tablist')
    for (const key of VIEW_KEYS) {
      expect(root.querySelector(`[data-testid="stock-prep-tab-${key}"]`)).not.toBeNull()
    }
    expect(root.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(7)
  })

  it('renders Chinese labels + the readonly-boundary copy when locale is zh-CN', async () => {
    h.locale = 'zh-CN'
    const root = await mountShell()
    const tabs = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    expect(tabs.textContent).toContain('项目工作台')
    // NAMING: snapshot uses 快照批次 / batch vocabulary (collision-avoidance requirement).
    expect(tabs.textContent).toContain('BOM 快照批次与差异')
    expect(tabs.textContent).toContain('异常队列')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toContain('只读')
    expect(boundary.textContent).toMatch(/K3 Save/)
  })

  it('renders English labels when locale is not zh-CN', async () => {
    h.locale = 'en'
    const root = await mountShell()
    const tabs = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    expect(tabs.textContent).toContain('Project Workspace')
    expect(tabs.textContent).toContain('BOM Snapshot Batch & Diff')
    expect(tabs.textContent).toContain('Exception Queue')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toMatch(/readonly/i)
  })

  it('defaults to the dashboard tab (H1: "operator enters the system and sees this first"), with no single-endpoint badge', async () => {
    const root = await mountShell()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('dashboard')
    // The dashboard aggregates MULTIPLE existing endpoints client-side — it has no single endpoint
    // to badge, so that line is skipped for it only (see StockPreparationViewTab.noEndpointBadge).
    expect(root.querySelector('[data-testid="stock-prep-panel-endpoint"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard"]')).not.toBeNull()
  })

  it('shows a concrete view panel as a readonly GET placeholder and switches on tab click', async () => {
    const root = await mountShell()
    const projectTab = root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement
    projectTab.click()
    await flushUi()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('project-workspace')
    const endpoint = root.querySelector('[data-testid="stock-prep-panel-endpoint"]') as HTMLElement
    expect(endpoint.textContent).toMatch(/GET/)
    expect(endpoint.textContent).toContain('/api/integration/stock-preparation/projects')

    const exceptionTab = root.querySelector('[data-testid="stock-prep-tab-exception-queue"]') as HTMLButtonElement
    exceptionTab.click()
    await flushUi()
    const panelAfter = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panelAfter.getAttribute('data-active')).toBe('exception-queue')
    expect(panelAfter.querySelector('[data-testid="stock-prep-desc-exception-queue"]')).not.toBeNull()
  })

  // Shared project context (view 1 → view 2): values-free fixtures behind the REAL service modules
  // (only apiFetch is mocked), so the projectId hand-off is asserted across the actual wiring.
  function mockStockPrepReads(): void {
    h.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/integration/stock-preparation/projects')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              projectCount: 1,
              statusCounts: { active: 1 },
              projects: [
                {
                  projectId: 'proj-alpha',
                  projectStatus: 'active',
                  lastSyncRunId: 'sync-run-alpha',
                  snapshotBatchCount: 1,
                  openExceptionCount: 0,
                  readyLineCount: 0,
                  heldLineCount: 0,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/integration/stock-preparation/snapshot-batches')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              projectId: 'proj-alpha',
              batchCount: 2,
              batches: [
                {
                  snapshotBatchId: 'batch-alpha',
                  snapshotVersion: 2,
                  snapshotStatus: 'active',
                  syncRunId: 'sync-run-alpha',
                  lineCount: 3,
                  createdAtPresent: true,
                  incomplete: false,
                },
                {
                  // incomplete:true through the REAL wire (#4002: zero lines / run row absent), so
                  // the badge + disabled-diff rendering is proven end-to-end (apiFetch →
                  // parseIntegrationResponse → real service module → view), not only via the
                  // mocked-service view spec.
                  snapshotBatchId: 'batch-beta',
                  snapshotVersion: 1,
                  snapshotStatus: 'superseded',
                  syncRunId: null,
                  lineCount: 0,
                  createdAtPresent: true,
                  incomplete: true,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      // Views 3/4 confirmation reads (values-free minimal fixtures) — order: sync/candidates
      // fragments are all distinct from the summary fragments, so plain includes() is safe.
      if (url.includes('/api/integration/stock-preparation/material-mappings/summary')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              totalMappingCount: 1,
              activeMappingCount: 1,
              matchStatusCounts: { matched: 0, pending_confirm: 1, multi_candidate: 0, not_found: 0, version_conflict: 0 },
              versionPolicyCounts: { drawing_and_version: 1, drawing_only: 0, category_rule: 0, manual: 0 },
              pendingConfirmCount: 1,
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/integration/stock-preparation/material-mappings/candidates')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              rowCount: 1,
              byMatchStatus: { matched: 0, pending_confirm: 1, multi_candidate: 0, not_found: 0, version_conflict: 0 },
              rows: [
                {
                  mappingId: 'map-handle-alpha',
                  matchStatus: 'pending_confirm',
                  matchMethod: 'exact_code_candidate',
                  versionPolicy: 'drawing_and_version',
                  confidence: 0.9,
                  isActive: true,
                  confirmed: false,
                  hasErpTarget: true,
                  plmVersionPresent: true,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/integration/stock-preparation/unit-conversions/summary')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              totalRuleCount: 1,
              activeRuleCount: 1,
              requiresConfirmationCount: 0,
              scopeTypeCounts: { material: 1, category: 0, generic: 0 },
              roundingRuleCounts: { none: 1, ceil: 0, floor: 0, nearest: 0, pack_size: 0 },
              pendingUnitLineCount: 1,
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/integration/stock-preparation/unit-conversions/candidates')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: 'pending_confirmation',
              snapshotBatchId: 'batch-alpha',
              rowCount: 1,
              byOutcome: { candidate: 1 },
              byReason: { unknown: 1 },
              rows: [{ contextFingerprint: 'fp-handle-alpha', outcome: 'candidate', hasCandidate: true }],
            },
          }),
          { status: 200 },
        )
      }
      // Views 5/6 W5a list reads (values-free minimal fixtures). The bare /exceptions fragment is
      // checked LAST among stock-prep URLs so it can never shadow a more specific path.
      if (url.includes('/api/integration/stock-preparation/prep-lines')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              rowCount: 1,
              byPrepStatus: { draft: 1, held: 0 },
              byMappingStatus: { matched: 1, pending_confirm: 0, multi_candidate: 0, not_found: 0, version_conflict: 0 },
              byUnitStatus: { converted: 1, missing_rule: 0, conflict: 0 },
              rows: [
                {
                  stockPrepLineId: 'line-handle-alpha',
                  prepStatus: 'draft',
                  mappingStatus: 'matched',
                  unitStatus: 'converted',
                  exceptionCount: 0,
                  hasIssueQty: true,
                  hasErpTarget: true,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/integration/stock-preparation/exceptions')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              rowCount: 1,
              unresolvedBlockingCount: 1,
              byType: { missing_mapping: 1, multi_candidate: 0, version_conflict: 0, erp_item_missing: 0, unit_missing: 0, unit_conflict: 0, invalid_qty: 0, missing_child_bom: 0 },
              byStatus: { open: 1, resolved: 0, ignored: 0, deferred: 0 },
              bySeverity: { info: 0, warning: 0, blocking: 1 },
              rows: [
                {
                  exceptionId: 'exc-handle-alpha',
                  exceptionType: 'missing_mapping',
                  severity: 'blocking',
                  status: 'open',
                  resolved: false,
                  resolvedByPresent: false,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })
  }

  it('shares the projectId selected in view 1 with view 2 — no re-select needed', async () => {
    mockStockPrepReads()
    const root = await mountShell()

    // The dashboard (H1) is now the default tab — switch to view 1 explicitly before its row mounts.
    ;(root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement).click()
    await flushUi()

    // Pick a project in view 1 (its row renders after the REAL projects Response settles — poll).
    const selectButton = (await waitForSelector(
      root,
      '[data-testid="stock-prep-project-select"]',
    )) as HTMLButtonElement
    selectButton.click()

    // The shell jumps to view 2 already scoped: no select-a-project state, batch list GET issued
    // with the SAME internal handle view 1 emitted. Wait for the settled data view, not a fixed
    // number of flushes (real Response.json() timing differs between local and CI).
    await waitForSelector(root, '[data-testid="stock-prep-snapshot-overview"]')
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('bom-snapshot-diff')
    expect(root.querySelector('[data-testid="stock-prep-snapshot-no-project"]')).toBeNull()
    const batchListCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/snapshot-batches'))
    expect(batchListCalls.length).toBe(1)
    expect(batchListCalls[0]).toContain('projectId=proj-alpha')

    // NIT-1: close the incomplete wire→render loop — the REAL apiFetch fixture carries an
    // incomplete:true batch, and exactly that row materializes the badge + disabled diff entry.
    const incompleteBadges = root.querySelectorAll('[data-testid="stock-prep-snapshot-incomplete-badge"]')
    expect(incompleteBadges.length).toBe(1)
    expect(incompleteBadges[0].textContent).toContain('不完整')
    const diffButtons = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')
    expect(diffButtons.length).toBe(2)
    expect((diffButtons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((diffButtons[1] as HTMLButtonElement).disabled).toBe(true)

    // The handle is mirrored into the route query (replace, not push) for reload/deep-link parity…
    expect(h.router.replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ projectId: 'proj-alpha' }) }),
    )
    // …but stays values-free in the DOM: the internal handle is never rendered.
    expect(root.textContent || '').not.toContain('proj-alpha')
  })

  it('shares the projectId with views 3 and 4 — confirmation views open already scoped', async () => {
    mockStockPrepReads()
    const root = await mountShell()

    // The dashboard (H1) is now the default tab — switch to view 1 explicitly before its row mounts.
    ;(root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement).click()
    await flushUi()

    // Pick a project in view 1 (REAL wire), then enter the two confirmation tabs.
    const selectButton = (await waitForSelector(
      root,
      '[data-testid="stock-prep-project-select"]',
    )) as HTMLButtonElement
    selectButton.click()
    await waitForSelector(root, '[data-testid="stock-prep-snapshot-overview"]')

    // View 3 (material mapping): opens scoped — no re-select, reads carry the SAME handle.
    ;(root.querySelector('[data-testid="stock-prep-tab-material-mapping"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')
    expect(root.querySelector('[data-testid="stock-prep-mapping-no-project"]')).toBeNull()
    const mappingSummaryCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/material-mappings/summary'))
    expect(mappingSummaryCalls.length).toBe(1)
    expect(mappingSummaryCalls[0]).toContain('projectId=proj-alpha')

    // View 4 (unit conversion): same shared scope.
    ;(root.querySelector('[data-testid="stock-prep-tab-unit-conversion"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-overview"]')
    expect(root.querySelector('[data-testid="stock-prep-unit-no-project"]')).toBeNull()
    const unitSummaryCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/unit-conversions/summary'))
    expect(unitSummaryCalls.length).toBe(1)
    expect(unitSummaryCalls[0]).toContain('projectId=proj-alpha')

    // The internal handle stays values-free in the DOM across all tabs.
    expect(root.textContent || '').not.toContain('proj-alpha')
  })

  it('shares the projectId with views 5 and 6 — prep-line and exception views open already scoped', async () => {
    mockStockPrepReads()
    const root = await mountShell()

    // The dashboard (H1) is now the default tab — switch to view 1 explicitly before its row mounts.
    ;(root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement).click()
    await flushUi()

    // Pick a project in view 1 (REAL wire), then enter the two W5 tabs.
    const selectButton = (await waitForSelector(
      root,
      '[data-testid="stock-prep-project-select"]',
    )) as HTMLButtonElement
    selectButton.click()
    await waitForSelector(root, '[data-testid="stock-prep-snapshot-overview"]')

    // View 5 (prep lines): opens scoped — no re-select, the list read carries the SAME handle.
    ;(root.querySelector('[data-testid="stock-prep-tab-prep-line"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')
    expect(root.querySelector('[data-testid="stock-prep-line-no-project"]')).toBeNull()
    const prepLineCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/prep-lines'))
    expect(prepLineCalls.length).toBe(1)
    expect(prepLineCalls[0]).toContain('projectId=proj-alpha')

    // View 6 (exception queue): same shared scope.
    ;(root.querySelector('[data-testid="stock-prep-tab-exception-queue"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')
    expect(root.querySelector('[data-testid="stock-prep-exception-no-project"]')).toBeNull()
    const exceptionCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.split('?')[0] === '/api/integration/stock-preparation/exceptions')
    expect(exceptionCalls.length).toBe(1)
    expect(exceptionCalls[0]).toContain('projectId=proj-alpha')

    // The internal handle stays values-free in the DOM across all tabs.
    expect(root.textContent || '').not.toContain('proj-alpha')
  })

  it('seeds the shared project context from the ?projectId= route query (deep link / reload)', async () => {
    mockStockPrepReads()
    h.route = {
      path: '/stock-prep',
      fullPath: '/stock-prep?projectId=proj-alpha',
      meta: {},
      query: { projectId: 'proj-alpha' },
    }
    const root = await mountShell()

    const snapshotTab = root.querySelector('[data-testid="stock-prep-tab-bom-snapshot-diff"]') as HTMLButtonElement
    snapshotTab.click()

    // View 2 opens already scoped to the query's project handle — no re-select state. Poll for the
    // settled data view (real Response.json() timing differs between local and CI).
    await waitForSelector(root, '[data-testid="stock-prep-snapshot-overview"]')
    expect(root.querySelector('[data-testid="stock-prep-snapshot-no-project"]')).toBeNull()
    const batchListCalls = h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/snapshot-batches'))
    // TWO calls, not one: the dashboard (H1/H2, now the default landing tab) ALSO eagerly aggregates
    // the sync stage for an already-seeded projectId on its own mount (before the test ever switches
    // to view 2) — this is the dashboard's own reused GET, not a duplicate/bug. Both carry the SAME
    // deep-linked handle either way.
    expect(batchListCalls.length).toBe(2)
    for (const call of batchListCalls) {
      expect(call).toContain('projectId=proj-alpha')
    }
  })

  it('shell copy is values-free (no secrets, no long numeric runs) in both locales', async () => {
    for (const locale of ['zh-CN', 'en']) {
      h.locale = locale
      const root = await mountShell()
      const text = (root.textContent || '').toLowerCase()
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(text).not.toContain(forbidden.toLowerCase())
      }
      // No digit-run >= 5 (no real project/material/BOM identifiers in placeholder copy).
      expect(root.textContent || '').not.toMatch(/\d{5,}/)
      if (app) app.unmount()
      app = null
    }
  })
})

describe('App nav entry for Stock Preparation', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  function mountApp(): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('router-view', { render: () => null })
    // Anchor stub so each nav link's href + label text are queryable.
    app.component('router-link', {
      props: ['to'],
      render() {
        return vh('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
  }

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.hasPerm = true
    h.route = { path: '/multitable', fullPath: '/multitable', meta: {}, query: {} }
    window.localStorage.clear()
    window.localStorage.setItem('auth_token', 'session-token')
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function findStockPrepLink(root: HTMLElement): HTMLAnchorElement | undefined {
    return Array.from(root.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/stock-prep')
  }

  it('renders a /stock-prep nav link with the zh label when the user has integration:write', async () => {
    mountApp()
    await flushUi()
    const link = findStockPrepLink(container as HTMLElement)
    expect(link).toBeTruthy()
    expect(link!.textContent).toContain('备料工作台')
  })

  it('renders the English nav label when locale is not zh-CN', async () => {
    h.locale = 'en'
    mountApp()
    await flushUi()
    const link = findStockPrepLink(container as HTMLElement)
    expect(link).toBeTruthy()
    expect(link!.textContent).toContain('Stock Preparation')
  })

  it('hides the /stock-prep nav link when the user lacks integration:write', async () => {
    h.hasPerm = false
    mountApp()
    await flushUi()
    expect(findStockPrepLink(container as HTMLElement)).toBeUndefined()
  })
})

describe('Stock Preparation per-view service stubs (readonly GET, values-free)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }))
  })

  function lastCall(): [string, unknown?] {
    const calls = h.apiFetch.mock.calls
    return calls[calls.length - 1] as [string, unknown?]
  }

  it('projectWorkspace GETs the projects summary with no write options', async () => {
    await getStockPreparationWorkspaceOverview({ tenantId: 't1' })
    const [url, options] = lastCall()
    expect(url).toContain('/api/integration/stock-preparation/projects')
    expect(url).toContain('tenantId=t1')
    expect(options).toBeUndefined() // no method/body → readonly GET
  })

  it('bomSnapshotDiff lists snapshot batches and diffs by batch id (readonly)', async () => {
    await listStockPreparationSnapshotBatches({ projectId: 'p1' })
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/snapshot-batches')
    expect(lastCall()[0]).toContain('projectId=p1')
    expect(lastCall()[1]).toBeUndefined()

    await getStockPreparationSnapshotDiff('batch-1')
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/snapshot-batches/batch-1/diff')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('materialMapping GETs the mapping summary (readonly)', async () => {
    await getStockPreparationMaterialMappingSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/material-mappings/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('unitConversion GETs the unit-conversion summary (readonly)', async () => {
    await getStockPreparationUnitConversionSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/unit-conversions/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('NONE of the readonly stubs ever issues a write method (no POST/PUT/PATCH/DELETE)', async () => {
    await Promise.all([
      getStockPreparationWorkspaceOverview(),
      listStockPreparationSnapshotBatches(),
      getStockPreparationMaterialMappingSummary(),
      getStockPreparationUnitConversionSummary(),
    ])
    for (const call of h.apiFetch.mock.calls) {
      const options = call[1] as { method?: string } | undefined
      expect(options?.method).toBeUndefined()
    }
  })
})
