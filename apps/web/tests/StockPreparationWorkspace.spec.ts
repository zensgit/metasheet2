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
  /**
   * O2 / R-11. Codes the acting principal holds. The default is the PLATFORM-ADMIN pair, because
   * every shell assertion below is about the legacy MVP tab strip, which is platform-admin-only
   * after this change — an operator-tier default would have quietly turned those tests into
   * assertions about an empty page. Tests that care about the operator tier set it explicitly.
   */
  permissions: ['integration:admin', 'stock-prep:read'] as string[],
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

// O2 / R-11: the auth double became a permission SET rather than one boolean. The shell now renders
// a different tab strip per tier (the six legacy MVP tabs are platform-admin only, the confirmation
// queue is the operator's), so a single `hasPerm` flag can no longer express the actors this spec
// needs. Exact-code matching only — the ladder lives in workbenchAccess.ts and is exercised by
// stockPrepPermissionMatrix.spec.ts, so reproducing it here would only let the two drift.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    // `roles` / `permissions` are the shape `workbenchAccess.ts` decides on (it takes the SNAPSHOT,
    // never the expanding probe), so this double has to carry them or every stock-prep predicate
    // reads an empty principal.
    getAccessSnapshot: () => ({ isAdmin: false, email: '', roles: [], permissions: h.permissions }),
    hasPermission: (permission: string) => h.permissions.includes(permission),
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
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

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

// O1' §附 narrowed this page to the CONFIRMATION-QUEUE workbench, so 'confirmation-queue' leads the
// strip and is the landing tab. The seven below it are the legacy MVP tabs, which the same ruling
// did not revive and which stay PLATFORM-ADMIN gated end to end — they render only for this spec's
// default (admin) actor, never for a stock-prep operator.
const LEGACY_MVP_VIEW_KEYS = [
  'dashboard',
  'project-workspace',
  'bom-snapshot-diff',
  'material-mapping',
  'unit-conversion',
  'prep-line',
  'exception-queue',
] as const
const VIEW_KEYS = ['confirmation-queue', ...LEGACY_MVP_VIEW_KEYS] as const

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

  it('registers /stock-prep bound to a lazy shell component and the stock-prep:read gate (O2/R-11)', () => {
    const block = routeBlockByPath('/stock-prep')
    expect(block, 'route /stock-prep must exist in appRoutes.ts').toBeTruthy()
    expect(block).toContain('AppRouteNames.INTEGRATION_STOCK_PREPARATION')
    expect(block).toContain("import('../components/integration/stockPreparation/StockPreparationWorkspace.vue')")
    expect(block).toMatch(/requiresAuth:\s*true/)
    // O2 / R-11: the gate moved off the Data Factory's integration:write onto the workbench's own
    // code. BOTH halves are pinned — the new code present AND the old one gone — because a route
    // that kept both would still admit an integration:write holder the server refuses everywhere,
    // which is the misalignment this change exists to close.
    expect(block).toMatch(/permissions:\s*\[\s*'stock-prep:read'\s*\]/)
    expect(block).not.toMatch(/permissions:\s*\[[^\]]*'integration:write'/)
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

    it('required-feature gate denies and allows elearning', () => {
      expect(decide('/learn', { requiredFeature: 'elearning' }, { hasFeature: () => false }))
        .toEqual({ action: 'redirect', target: '/HOME' })
      expect(decide('/learn', { requiredFeature: 'elearning' }, { hasFeature: (feature) => feature === 'elearning' }))
        .toEqual({ action: 'allow' })
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
            // Round-15 (M22): the input adapter must receive EXACTLY the identifier `to` — a
            // synthesized object ({ path: to.path, meta: {} }) is not an accepted argument.
            (d.initializer.arguments[0] as import('typescript').CallExpression).arguments.length === 1 &&
            ts.isIdentifier((d.initializer.arguments[0] as import('typescript').CallExpression).arguments[0]) &&
            ((d.initializer.arguments[0] as import('typescript').CallExpression).arguments[0] as import('typescript').Identifier).text === 'to' &&
            ts.isCallExpression(d.initializer.arguments[1]) &&
            ts.isIdentifier((d.initializer.arguments[1] as import('typescript').CallExpression).expression) &&
            ((d.initializer.arguments[1] as import('typescript').CallExpression).expression as import('typescript').Identifier).text === 'buildRouteGuardContext' &&
            // Round-15 (M23): the ctx adapter must receive EXACTLY { auth, flags } — two shorthand
            // properties, no spread, no extras, no substitute expressions (where an overriding
            // flags object with hasFeature: () => true could hide).
            (() => {
              const ctxArgs = (d.initializer!.arguments[1] as import('typescript').CallExpression).arguments
              if (ctxArgs.length !== 1 || !ts.isObjectLiteralExpression(ctxArgs[0])) return false
              const props = (ctxArgs[0] as import('typescript').ObjectLiteralExpression).properties
              return (
                props.length === 2 &&
                props.every((pr) => ts.isShorthandPropertyAssignment(pr)) &&
                (props[0] as import('typescript').ShorthandPropertyAssignment).name.text === 'auth' &&
                (props[1] as import('typescript').ShorthandPropertyAssignment).name.text === 'flags'
              )
            })(),
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
    // Restored per test: the operator-tier case below narrows it, and a leaked narrow actor would
    // silently turn every later legacy-tab assertion into an assertion about an empty page.
    h.permissions = ['integration:admin', 'stock-prep:read']
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
    localStorage.removeItem('tenantId')
    localStorage.removeItem('workspaceId')
    h.apiFetch.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    localStorage.removeItem('tenantId')
    localStorage.removeItem('workspaceId')
    h.apiFetch.mockReset()
    vi.clearAllMocks()
  })

  async function mountShell(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flushUi()
    return container!
  }

  /**
   * Mount the shell and put 确认队列 on screen.
   *
   * THE CLICK IS NOT DECORATION. Since PR #5555 this file's default actor (`integration:admin` +
   * `stock-prep:read`) is a PLATFORM ADMIN on the workbench, exactly as it always was on the server:
   * `workbenchAccess.ts` now decides on a `{ roles, permissions }` snapshot with the server's own
   * literal ladder instead of on this file's exact-code `hasPermission` double. D2 therefore lands
   * them on 开始使用 (nothing here answers the preflight, and 「读不到」 lands on the wizard). The
   * queue is one click away and still theirs; the cases below are about what 建立确认账本 / 对账 do
   * once it is open, and the landing itself is asserted in its own case above.
   */
  async function mountShellOnTheQueue(): Promise<HTMLDivElement> {
    const root = await mountShell()
    const tab = root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement | null
    expect(tab, '确认队列 must still be a tab this actor can open').not.toBeNull()
    tab!.click()
    await flushUi()
    return root
  }

  it('renders the tablist with the confirmation queue plus every legacy MVP tab (platform admin)', async () => {
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]')
    expect(tablist).not.toBeNull()
    expect(tablist!.getAttribute('role')).toBe('tablist')
    for (const key of VIEW_KEYS) {
      expect(root.querySelector(`[data-testid="stock-prep-tab-${key}"]`)).not.toBeNull()
    }
    // P1-1 (设计稿 §2.2, D3=A): 8 -> 9 -> 14 -> 15. 14 was PR #5555's alignment, not a new tab:
    // this actor holds a bare `integration:admin`, which the SERVER has always counted as a platform
    // admin (`PLATFORM_ADMIN_PERMISSIONS`) while the browser's `hasPermission` did not.
    // `workbenchAccess.ts` now uses the server's own literal ladder over the auth SNAPSHOT, so this
    // principal is a platform admin here too and sees the whole rail. 14 -> 15 IS a new tab: P2-1's
    // 项目查询, in 【工作】 after 项目备料 — 4 【工作】 + 3 【部署与接入】 + 7 深度工具 (folded, still
    // rendered) + 1 【帮助】.
    expect(root.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(15)
  })

  // O2 / R-11: the operator tier. The tab strip is itself a control surface, so a tab whose panel
  // would 403 on every action must not be there — otherwise the page hands a customer operator seven
  // tabs of dead controls, which is the "visible but not actionable" failure in its purest form.
  it('shows a stock-prep operator ONLY the confirmation queue — every legacy MVP tab is hidden', async () => {
    h.permissions = ['stock-prep:read']
    const root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]')).not.toBeNull()
    for (const key of LEGACY_MVP_VIEW_KEYS) {
      expect(root.querySelector(`[data-testid="stock-prep-tab-${key}"]`), `${key} must be hidden`).toBeNull()
    }
    // P1-1: 1 -> 2, and P2-1 leaves it at 2. 【帮助】 joined, and only 【帮助】: a `stock-prep:read`
    // holder is still refused 今天要处理 / 项目备料 / 项目查询 (all value-bearing, operate tier) and
    // the whole 【部署与接入】 group.
    expect(root.querySelector('[data-testid="stock-prep-tab-project-query"]'), '项目查询 is operate-tier').toBeNull()
    expect(root.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(2)
    expect(root.querySelector('[data-testid="stock-prep-tab-help"]')).not.toBeNull()
    // ...and the panel really is the confirmation queue, not a legacy panel wearing its title.
    //
    // D2=A LEAVES THIS ONE ALONE, and that is the ruling working rather than an omission: this actor
    // is below the workbench-admin ceiling (so no 开始使用 / 记录与排查 landing) and below the
    // operator tier (so no 今天要处理). 确认队列 is what is left, which is where they landed before.
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('confirmation-queue')
    expect(root.querySelector('[data-testid="stock-prep-confirmation-queue"]')).not.toBeNull()
  })

  // §14 (multitable-application-model-20260830.md) — the INSTALL tab. Gated on `stock-prep:admin`,
  // the workbench-scoped ceiling, because everything the PANEL reads (the app-catalog manifest and
  // the read-tier preflight) is answerable to that holder. The run control INSIDE it is
  // platform-admin and does its own gating (StockPreparationInstallView.spec.ts V-05).
  it('hides the install tab from an operator and shows it to a workbench admin', async () => {
    h.permissions = ['stock-prep:read']
    const operatorRoot = await mountShell()
    expect(operatorRoot.querySelector('[data-testid="stock-prep-tab-install"]')).toBeNull()

    if (app) app.unmount()
    app = null
    container!.innerHTML = ''

    h.permissions = ['stock-prep:read', 'stock-prep:admin']
    const adminRoot = await mountShell()
    expect(adminRoot.querySelector('[data-testid="stock-prep-tab-install"]')).not.toBeNull()
    // P1-1: 2 -> 5 -> 7. The workbench-admin code opens the WHOLE 【部署与接入】 group, not just the
    // install page: 开始使用 (the wizard, promoted off the install page's first screen) and
    // 记录与排查 (the ops panel, which shipped mounted-but-unreachable) ride exactly the same
    // `canOpenStockPrepInstallView` gate the install tab always did. Plus 确认队列 and 【帮助】.
    // 5 -> 7 is PR #5555: `stock-prep:admin` satisfies read AND operate on the server's ladder, and
    // the workbench now uses that ladder rather than this file's exact-code double — so 今天要处理
    // and 项目备料 come with the code, which is what StockPreparationRail.spec.ts's own
    // `stock-prep:admin` actor (already on the real ladder) always expected.
    // The seven legacy MVP tabs stay platform-admin and did NOT come along with this code.
    // 7 -> 8 is P2-1's 项目查询: same operate tier as 今天要处理 / 项目备料, which this code satisfies.
    expect(adminRoot.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(8)
    for (const key of ['home', 'project-board', 'project-query', 'getting-started', 'install', 'ops', 'confirmation-queue', 'help']) {
      expect(adminRoot.querySelector(`[data-testid="stock-prep-tab-${key}"]`), `${key} must be visible`).not.toBeNull()
    }
    for (const key of LEGACY_MVP_VIEW_KEYS) {
      expect(adminRoot.querySelector(`[data-testid="stock-prep-tab-${key}"]`), `${key} must stay hidden`).toBeNull()
    }
    // D2=A: 'confirmation-queue' -> 'getting-started'. THIS IS THE RULING, and this is the actor it
    // is about — a workbench admin. Landing them on an empty confirmation queue was the dead end the
    // whole redesign opened with (设计稿 §2.3 A1): the page never said "you have to install this
    // first". They now land on 开始使用 because the preflight could not be read here (this test's
    // apiFetch is reset, so the read rejects) — and 「读不到」 lands on the wizard, never on the health
    // page, since 「看不到」 is not 「装完了」. The installed case lands on 记录与排查; both are
    // asserted directly against the predicate in the D2 block further down this file.
    const panel = adminRoot.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('getting-started')
  })

  it('opens the install tab and badges it as a manifest read plus an idempotent ensure', async () => {
    h.permissions = ['integration:admin', 'stock-prep:read', 'stock-prep:admin']
    h.apiFetch.mockImplementation(async () => new Response(JSON.stringify({
      id: 'stock-preparation',
      displayName: 'BOM备料',
      permissions: [],
      objects: [],
    }), { status: 200 }))

    const root = await mountShell()
    // P1-1: 9 -> 12. The queue, the whole 【部署与接入】 group (开始使用 / 安装 · 体检 / 记录与排查),
    // 【帮助】, and the seven legacy MVP tabs — now folded into 深度工具 ▾ but still rendered, so
    // still counted. This actor holds no `stock-prep:operate`, so 今天要处理 and 项目备料 stay hidden.
    // 12 -> 14 (PR #5555): this actor holds `stock-prep:admin` AND a bare `integration:admin`, and
    // both satisfy operate on the server's ladder — the ladder the workbench now uses — so 今天要处理
    // and 项目备料 join the twelve. 14 -> 15 (P2-1): 项目查询 rides that same operate tier.
    expect(root.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(15)
    ;(root.querySelector('[data-testid="stock-prep-tab-install"]') as HTMLButtonElement).click()
    await flushUi()

    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('install')
    expect(root.querySelector('[data-testid="stock-prep-install"]')).not.toBeNull()

    // The badge must not claim "readonly · GET": the panel's admin-only run calls the existing
    // idempotent ensure / customer-pack routes.
    const endpoint = root.querySelector('[data-testid="stock-prep-panel-endpoint"]') as HTMLElement
    expect(endpoint.textContent).toContain('/api/platform/apps/stock-preparation')
    expect(endpoint.textContent).toContain('幂等建表')
    expect(endpoint.textContent).not.toMatch(/· GET/)
  })

  it('renders Chinese labels + the readonly-boundary copy when locale is zh-CN', async () => {
    h.locale = 'zh-CN'
    const root = await mountShell()
    // THE WHOLE RAIL, not just `[data-testid="stock-prep-tabs"]` (hardening wave, 2026-09-08): 深度工具
    // moved outside the tablist witness element (R-05 in StockPreparationRail.spec.ts has the full
    // reasoning), so the seven legacy labels these three lines check now live in a NAV-level sibling of
    // it, `.sp-rail__advanced`. `.sp-rail` is the outer container both live inside, unaffected by that
    // internal move.
    const rail = root.querySelector('.sp-rail') as HTMLElement
    expect(rail.textContent).toContain('项目工作台')
    // NAMING: snapshot uses 快照批次 / batch vocabulary (collision-avoidance requirement).
    expect(rail.textContent).toContain('BOM 快照批次与差异')
    expect(rail.textContent).toContain('异常队列')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toContain('只读')
    expect(boundary.textContent).toMatch(/K3 Save/)
  })

  it('renders English labels when locale is not zh-CN', async () => {
    h.locale = 'en'
    const root = await mountShell()
    // See the zh-CN case above for why `.sp-rail` rather than the tablist testid.
    const rail = root.querySelector('.sp-rail') as HTMLElement
    expect(rail.textContent).toContain('Project Workspace')
    expect(rail.textContent).toContain('BOM Snapshot Batch & Diff')
    expect(rail.textContent).toContain('Exception Queue')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toMatch(/readonly/i)
  })

  // O1' §附 moved the landing tab: this page is now the confirmation-queue workbench, so the queue —
  // not the MVP dashboard — is what an operator sees on arrival. The dashboard remains reachable for
  // a platform admin via its tab, asserted immediately below.
  //
  // D2=A DOES MOVE THIS ONE, as of PR #5555. The actor holds a bare `integration:admin`, which the
  // SERVER has always counted as a platform admin; the workbench now counts it the same way instead
  // of through this file's exact-code `hasPermission` double, so D2's posture rule applies to them.
  // Nothing here answers the preflight, and 「读不到」 lands on 开始使用, never on 记录与排查.
  // THE QUEUE IS STILL THEIRS — one click away — which is the second half of this case rather than
  // an assertion dropped.
  it('lands where D2 sends a platform admin (开始使用), with the queue one click away', async () => {
    const root = await mountShell()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('getting-started')
    const queueTab = root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement
    expect(queueTab).not.toBeNull()
    queueTab.click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('confirmation-queue')
    expect(root.querySelector('[data-testid="stock-prep-confirmation-queue"]')).not.toBeNull()
  })

  // O1' §附's claim itself, kept and pointed at the tier it is actually about: the values-free
  // `stock-prep:read` queue watcher, whose landing neither D2 nor this PR touched.
  it('lands on the confirmation queue for the read-only tier (O1\': the page this workbench was adopted to be)', async () => {
    h.permissions = ['stock-prep:read']
    const root = await mountShell()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('confirmation-queue')
    expect(root.querySelector('[data-testid="stock-prep-confirmation-queue"]')).not.toBeNull()
  })

  it('still opens the dashboard tab for a platform admin, with no single-endpoint badge', async () => {
    const root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-dashboard"]') as HTMLButtonElement).click()
    await flushUi()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('dashboard')
    // The dashboard aggregates MULTIPLE existing endpoints client-side — it has no single endpoint
    // to badge, so that line is skipped for it only (see StockPreparationViewTab.noEndpointBadge).
    expect(root.querySelector('[data-testid="stock-prep-panel-endpoint"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard"]')).not.toBeNull()
  })

  it('passes the default integration scope to the dashboard readonly request', async () => {
    localStorage.setItem('tenantId', 'tenant-from-integration-scope')
    localStorage.setItem('workspaceId', 'workspace-from-integration-scope')
    h.apiFetch.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      data: { projectCount: 0, statusCounts: {}, projects: [] },
    }), { status: 200 }))

    const shell = await mountShell()
    ;(shell.querySelector('[data-testid="stock-prep-tab-dashboard"]') as HTMLButtonElement).click()
    await waitForSelector(container!, '[data-testid="stock-prep-dashboard-empty"]')

    const call = h.apiFetch.mock.calls.find(([value]) => String(value).includes('/stock-preparation/projects'))
    expect(call).toBeDefined()
    const [url, options] = call as [string, unknown]
    expect(url).toContain('tenantId=tenant-from-integration-scope')
    expect(url).toContain('workspaceId=workspace-from-integration-scope')
    expect(options).toBeUndefined()
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

  // ---- 打开备料多维表 on 项目工作台 (this PR) ---------------------------------------------------
  //
  // The legacy tab's 到多维表 buttons had no sheet to name, so the shell could only ever open the
  // multitable chooser. The operator directory now returns the tenant-gated handle, and the SHELL
  // fetches it — lazily, once, and only for the tab that has a button for it, because the read it
  // rides (`?includePullTargets=1`) is the scan the owner ruled may not be charged on every open.
  it('打开备料多维表: the shell asks for the handle ONLY once 项目工作台 is on screen', async () => {
    resetStockPreparationOperatorHomeDirectoryThrottle()
    h.apiFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/operator/projects')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            tenantId: 'tenant-a',
            directoryReady: true,
            ledgerReady: true,
            projectCount: 0,
            pendingProjectCount: 0,
            projects: [],
            fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' },
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })
    const directoryCalls = (): string[] => h.apiFetch.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((url: string) => url.includes('/operator/projects'))

    const root = await mountShell()
    // THE COST ASSERTION: the tab this actor lands on pays nothing for a handle it has no button for.
    expect(directoryCalls()).toHaveLength(0)

    ;(root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement).click()
    await flushUi()
    const asked = directoryCalls()
    expect(asked.length).toBe(1)
    expect(asked[0]).toContain('includePullTargets=1')

    // ONCE PER MOUNT: leaving the tab and coming back must not re-run the scan.
    ;(root.querySelector('[data-testid="stock-prep-tab-dashboard"]') as HTMLButtonElement).click()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-tab-project-workspace"]') as HTMLButtonElement).click()
    await flushUi()
    expect(directoryCalls().length).toBe(1)
  })
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
    // ONE call now, where it used to be two. The second was the dashboard's own eager stage
    // aggregation on mount, back when the dashboard was the landing tab; O1' §附 made the
    // confirmation queue the landing tab, and that tab reads nothing until the operator asks. So
    // arriving on a deep link no longer fires an admin-tier MVP read the arriving principal may not
    // even be permitted to make — the count dropping is the point, not an omission.
    expect(batchListCalls.length).toBe(1)
    for (const call of batchListCalls) {
      expect(call).toContain('projectId=proj-alpha')
    }
  })

  // -------------------------------------------------------------------------
  // 确认队列's two PLATFORM-ADMIN buttons — the wiring, and what it may say
  // -------------------------------------------------------------------------
  //
  // THE BUG THESE PIN. `StockPreparationConfirmationQueueView` rendered 建立确认账本 and
  // 重新扫描待确认的事 and emitted `admin-action` for both. This shell is the component's ONLY mount
  // point and declared no listener, so both clicks were swallowed entirely: no request left the
  // browser, no error appeared, and the admin who pressed 建账本 had every reason to believe the
  // ensure had run. Every assertion below is about a request that must now be made and a sentence
  // that must now appear.

  /** The queue tab's own on-mount reads answered with empty, valid envelopes. */
  function answerQueueReads(): void {
    h.apiFetch.mockImplementation(async (url: string) => new Response(JSON.stringify({
      ok: true,
      data: String(url).includes('/operator/projects')
        ? { tenantId: 't1', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
        : {},
    }), { status: 200 }))
  }

  function postCalls(pathFragment: string): string[] {
    return h.apiFetch.mock.calls
      .filter((call) => String((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST')
      .map((call) => String(call[0]))
      .filter((url) => url.includes(pathFragment))
  }

  it('the ensure button really calls the confirmation-ledger ensure route and says what happened', async () => {
    answerQueueReads()
    const root = await mountShellOnTheQueue()
    const ensure = root.querySelector('[data-testid="stock-prep-confirmation-ensure"]') as HTMLButtonElement
    expect(ensure).not.toBeNull()
    ensure.click()
    const notice = await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')

    expect(postCalls('/stock-preparation/confirmation-decisions/ensure').length).toBe(1)
    expect(notice.textContent).toContain('确认账本已经就位')
    // A SUCCESS carries no error token — the code element renders only on a failure.
    expect(notice.querySelector('code')).toBeNull()
  })

  it('the reconcile button calls the table-action reconcile route for the number on screen', async () => {
    answerQueueReads()
    const root = await mountShellOnTheQueue()
    const input = root.querySelector('[data-testid="stock-prep-confirmation-project-input"]') as HTMLInputElement
    input.value = '230920006'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    const notice = await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')

    const calls = postCalls('/confirmation-decisions/reconcile')
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/')
    expect(notice.textContent).toContain('已经重新扫描过一遍')
  })

  it('reconcile with no project number asks for one instead of firing a request that cannot succeed', async () => {
    answerQueueReads()
    const root = await mountShellOnTheQueue()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    const notice = await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')

    expect(postCalls('/confirmation-decisions/reconcile').length).toBe(0)
    expect(notice.textContent).toContain('请先填一个项目号')
  })

  // A REFUSED RECONCILE. It reaches the shell as an ordinary clamped code, so the notice must be the
  // code's OWN sentence — not the generic "did not save" — and must carry no project number of its
  // own.
  //
  // THE CODE HERE USED TO BE `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE`, the project gate
  // #5516 put on the server. The owner ruled on 2026-09-06 that stock-prep will not do project
  // ownership; the gate and its copy were deleted, so no server path can produce that code any more
  // and a test that kept asserting its sentence would have been witnessing dead copy. This case is
  // what it was always really about — the notice renders the refusal's own words plus the code —
  // repointed at a refusal this button can genuinely receive: the 403 `FORBIDDEN` that
  // `requireTableActionAccess` raises.
  it('a refused reconcile shows the plain-language refusal plus its code, values-free', async () => {
    h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'nope' },
        }), { status: 403 })
      }
      return new Response(JSON.stringify({
        ok: true,
        data: String(url).includes('/operator/projects')
          ? { tenantId: 't1', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
          : {},
      }), { status: 200 })
    })
    const root = await mountShellOnTheQueue()
    const input = root.querySelector('[data-testid="stock-prep-confirmation-project-input"]') as HTMLInputElement
    input.value = '230920006'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-reconcile"]') as HTMLButtonElement).click()
    const notice = await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')

    expect(notice.textContent).toContain('当前账号没有做这件事的权限')
    expect(notice.querySelector('code')?.textContent).toBe('FORBIDDEN')
    // The wording is the CODE's own, not the write-generic every unknown code falls back to.
    expect(notice.textContent).not.toContain('这一步没有保存成功')
    // ...and the number the admin typed is not echoed back into the notice.
    expect(notice.textContent).not.toContain('230920006')
  })

  // -------------------------------------------------------------------------
  // THE NOTICE IS A NOTICE, NOT A BRANCH — the v-else-if chain must stay whole
  // -------------------------------------------------------------------------
  //
  // Vue attaches `v-else-if` to its immediately preceding sibling branch. An element carrying its own
  // `v-if`, dropped BETWEEN two branches of the panel's chain, therefore splits that chain in two —
  // silently, with no compiler warning. The first cut of the admin notice sat between the queue and
  // the install branch, and the two observable consequences are exactly what these cases pin:
  //   * chain 1 (project-board, confirmation-queue) lost its `v-else`, so the "container placeholder"
  //     paragraph — the fallback for a tab with no view — rendered UNDER both of the only two tabs an
  //     operator ever sees, with no admin action involved at all;
  //   * chain 2 began at the notice, so the moment one appeared, install / dashboard / every legacy
  //     panel stopped rendering.
  // Neither shows up in an assertion about the notice text or the request, which is why the five
  // cases above all passed while this was broken.

  // D2 lands this actor on 开始使用 (see the landing case above), so the queue is opened explicitly —
  // the claim is about the CHAIN under a real tab, and 确认队列 is the tab whose branch lost its
  // `v-else` when this broke.
  it('the container placeholder never renders under a real tab (the notice must not split the chain)', async () => {
    answerQueueReads()
    const root = await mountShellOnTheQueue()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('confirmation-queue')
    expect(root.querySelector('[data-testid="stock-prep-panel-pending"]')).toBeNull()
  })

  it('...including the operator landing tab, which is the other half of the split chain', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    answerQueueReads()
    const root = await mountShell()
    // P1-1 / D2=A: 'project-board' -> 'home'. WHAT THE OPERATOR SEES IS THE SAME PIXELS. P0 shipped
    // the task home INSIDE the board view, keyed on 「?projectNo= 无值即首页」, so a bare landing on
    // 项目备料 already painted 今天要处理. P1-1 gives that page its own rail item and lands on it by
    // name; the branch is literally the same component with the number withheld, which is why this
    // is a key rename in the assertion rather than a behaviour change under it.
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('home')
    expect(root.querySelector('[data-testid="stock-prep-panel-pending"]')).toBeNull()
  })

  // P2-1's URL contract, the half the SHELL owns. 项目查询 is the one panel that mirrors `?tab=`
  // itself, so the shell is the only thing that can clean the bit up when the reader leaves — and a
  // staleness test that looked only at `q`/`status`/`source`/`sel` called a bare `?tab=project-query`
  // clean. Two clicks reach that state (filter once, press the same chip again: every filter key
  // deletes itself at its default and `tab` is what is left), and the next reload then threw the
  // reader back into a panel they had already walked away from.
  it('leaving 项目查询 clears a bare `?tab=project-query` — the four filter keys being absent is not "clean"', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.route.query = { tab: 'project-query' }
    answerQueueReads()
    const root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-query')
    expect(h.router.replace, '深链进来本身不发 replace').not.toHaveBeenCalled()

    ;(root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.router.replace).toHaveBeenCalledTimes(1)
    expect(h.router.replace.mock.calls[0][0]).toEqual({ query: {} })
  })

  // The same guard, keyed off `effectiveKey` rather than the raw `activeKey`: `tabFromQuery()`
  // accepts a key by NAME without asking whether this principal may see it, so a 纯 read 主体 can
  // arrive with `activeKey === 'project-query'` while `activeView` folds them back to their landing.
  // Reading `activeKey` would call that reader's panel "active" and keep five keys belonging to a
  // screen they never saw — forever, and carried forward by every later replace.
  it('a principal who cannot open 项目查询 does not carry its five keys around after a deep link', async () => {
    h.permissions = ['stock-prep:read']
    h.route.query = { tab: 'project-query', status: 'ready', source: 'mvp', q: 'x', sel: 'PRJ-1' }
    answerQueueReads()
    const root = await mountShell()
    // Folded back to their landing, and the panel they cannot see never mounted.
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('confirmation-queue')
    expect(root.querySelector('[data-testid="stock-prep-project-query"]')).toBeNull()

    ;(root.querySelector('[data-testid="stock-prep-tab-help"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.router.replace).toHaveBeenCalledTimes(1)
    expect(h.router.replace.mock.calls[0][0]).toEqual({ query: {} })
  })

  it('a notice never replaces the panel, and does not follow the admin onto the next tab', async () => {
    // The install tab is the nearest branch BELOW the notice in the panel's chain, so it is the one
    // that disappeared; it needs the workbench-admin code to be on screen at all.
    h.permissions = ['integration:admin', 'stock-prep:read', 'stock-prep:admin']
    answerQueueReads()
    const root = await mountShell()
    // NOT one of the nine: a NAVIGATION step, added because D2 moved this actor's landing off the
    // queue and onto 开始使用. The claim under test (a notice sits beside its panel and dies with the
    // tab) is about the queue's two admin buttons, so the test has to be ON the queue to press one.
    // Nothing was weakened — every assertion below is the one that was there.
    ;(root.querySelector('[data-testid="stock-prep-tab-confirmation-queue"]') as HTMLButtonElement).click()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-ensure"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')
    // The panel it was pressed on is still the panel — the notice sits beside the view, not instead
    // of it, and the placeholder is still absent.
    expect(root.querySelector('[data-testid="stock-prep-confirmation-ensure"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-panel-pending"]')).toBeNull()

    ;(root.querySelector('[data-testid="stock-prep-tab-install"]') as HTMLButtonElement).click()
    await flushUi()
    // The install view really renders (it was swallowed whole while a notice was showing) ...
    expect(root.querySelector('[data-testid="stock-prep-install"]')).not.toBeNull()
    // ... and the sentence about the OTHER tab is gone rather than stale-hanging over this one.
    expect(root.querySelector('[data-testid="stock-prep-admin-action-notice"]')).toBeNull()
  })

  // The install client's error type carries a status and no `code` (by design — it never surfaces a
  // server message), so an ensure failure has no token to quote. It must still say something, and it
  // must not invent a code.
  it('a failed ensure says so with the generic sentence and no invented error code', async () => {
    h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ ok: false, error: { code: 'SOMETHING', message: 'nope' } }), { status: 500 })
      }
      return new Response(JSON.stringify({
        ok: true,
        data: String(url).includes('/operator/projects')
          ? { tenantId: 't1', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] }
          : {},
      }), { status: 200 })
    })
    const root = await mountShellOnTheQueue()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-ensure"]') as HTMLButtonElement).click()
    const notice = await waitForSelector(root, '[data-testid="stock-prep-admin-action-notice"]')

    expect(notice.textContent).toContain('这一步没有保存成功')
    expect(notice.querySelector('code')).toBeNull()
  })

  // R-11's other half, restated for the newly-live buttons: wiring them must not have made them
  // reachable by anyone who could not see them before.
  it('a stock-prep operator sees neither admin button, so neither can be pressed', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    answerQueueReads()
    const root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-confirmation-ensure"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-confirmation-reconcile"]')).toBeNull()
    expect(postCalls('/confirmation-decisions/').length).toBe(0)
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
    // O2 / R-11: the nav link follows the ROUTE's gate. A stock-prep:read holder is the minimal
    // principal the link must appear for; integration:write (the old gate) is deliberately absent.
    h.permissions = ['stock-prep:read']
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

  it('renders a /stock-prep nav link with the zh label when the user has stock-prep:read', async () => {
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

  it('hides the /stock-prep nav link when the user lacks stock-prep:read', async () => {
    h.permissions = []
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
