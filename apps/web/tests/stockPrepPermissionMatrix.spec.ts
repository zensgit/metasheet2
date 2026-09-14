import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// O2 / R-11 — the FRONT-END half of the `/stock-prep` permission matrix.
//
// The alignment principle, restated:
//     what is visible must be actionable, and what is not permitted must not be visible.
//
// The back-end half lives in
// plugins/plugin-integration-core/__tests__/stock-preparation-permission-matrix.test.cjs, which
// drives the REAL routes per actor and proves the answered-route set equals
// `grantedStockPrepCapabilities(permissions)`. This file closes the loop from the other side: it
// proves the DOM this app renders equals that same set — first by pinning the browser mirror
// byte-equal to the authoritative plugin module (imported live, the bomSnapshotDiff.spec.ts
// tripwire pattern), then by mounting the real view per actor and comparing rendered control ids to
// it. Chained, the two suites give: rendered DOM == granted capabilities == routes that answer.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   F-01 the browser mirror is byte-equal to the plugin vocabulary/manifest (no drift channel)
//   F-02 `/stock-prep` route meta declares the new code and NOT integration:write (source pin)
//   F-03 route-guard decision per actor, through the REAL resolveRouteGuardDecision
//   F-04 ALIGNMENT: rendered control ids == granted controls, both directions, per actor
//   F-05 alignment holds for EVERY subset of the vocabulary, not just the named tiers
//   F-06 the legacy MVP tabs (still platform-admin server-side) render for a platform admin only
//   F-07 the nav link follows the route's gate, not integration:write (source pin)
//   F-08 `/stock-prep` declares NO requiredFeature — a feature flag would be a second gate that
//        redirects admins too, which this change must not introduce
//   F-09 the RAIL manifest and the D2 landing mirror the plugin, and the two resolvers agree for
//        EVERY actor — a universal equality, not a table with a footnote
//   F-10 两侧同形,不吃通配: the four principals that used to separate the sides (a bare
//        `integration:admin`, `stock-prep:*`, `*:*` without an admin role, `stock-prep:write`) are
//        answered identically by both, value by value

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

// The REAL `useAuth().hasPermission` semantics, reproduced over an injectable snapshot. Reproduced
// rather than stubbed to `true`/`false`, because the whole point of F-04 is that the app's actual
// permission algebra — its admin short-circuit and its `resource:admin` rule — lines up with the
// server's. A constant probe would make the alignment assertion vacuous.
function realHasPermission(required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true
  const isAdmin = h.roles.includes('admin')
    || h.permissions.includes('*:*')
    || h.permissions.includes('admin:all')
  if (isAdmin || h.roles.includes('admin')) return true
  if (h.permissions.includes(normalized) || h.permissions.includes('*:*')) return true
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

import {
  PLATFORM_ADMIN_GATE,
  PLATFORM_ADMIN_PERMISSIONS,
  STOCK_PREP_ADMIN,
  STOCK_PREP_LANDING_KEYS,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_RAIL_GROUPS,
  STOCK_PREP_READ,
  STOCK_PREP_ROUTE_PERMISSION,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canOpenStockPrepGettingStarted,
  canOpenStockPrepHelp,
  canOpenStockPrepHome,
  canOpenStockPrepInstallView,
  canOpenStockPrepOpsPanel,
  canOpenStockPrepProjectQuery,
  canOpenStockPrepRailItem,
  canUseLegacyMvpTabs,
  grantedStockPrepCapabilities,
  holdsPlatformAdmin,
  landsOnStockPrepGettingStarted,
  satisfiesStockPrepAccess,
  stockPrepLandingKey,
  visibleStockPrepControls,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import {
  KNOWN_REQUIRED_FEATURES,
  buildRouteGuardContext,
  buildRouteGuardInput,
  resolveRouteGuardDecision,
} from '../src/router/guardPolicy'
import StockPreparationConfirmationQueueView from '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'

// The AUTHORITATIVE server-side vocabulary, imported LIVE. A backend change reddens F-01 instead of
// silently desynchronising the two gates.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backendAccess = require('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs')

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const APP_ROUTES_SOURCE = readFileSync(resolve(REPO_ROOT, 'apps/web/src/router/appRoutes.ts'), 'utf8')
const APP_VUE_SOURCE = readFileSync(resolve(REPO_ROOT, 'apps/web/src/App.vue'), 'utf8')

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

/** One pending decision, values-free: ids, enums, fingerprint and PRESENCE booleans only. */
function queuePayload(): Record<string, unknown> {
  return {
    rowCount: 1,
    byStatus: { pending: 1 },
    byResolutionAction: {},
    parkedCount: 0,
    rows: [{
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
    }],
  }
}

interface Actor {
  name: string
  roles: string[]
  permissions: string[]
}

const ACTORS: Actor[] = [
  { name: 'unauthenticated', roles: [], permissions: [] },
  { name: 'logged-in without codes', roles: [], permissions: [] },
  { name: 'integration:write holder', roles: [], permissions: ['integration:write'] },
  { name: 'operator with read', roles: [], permissions: [STOCK_PREP_READ] },
  { name: 'operator with read+confirm', roles: [], permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
  { name: 'orphan operate (no read)', roles: [], permissions: [STOCK_PREP_OPERATE] },
  { name: 'workbench admin', roles: [], permissions: [STOCK_PREP_ADMIN] },
  { name: 'platform admin', roles: ['admin'], permissions: ['integration:admin'] },
  // THE FOUR PRINCIPALS THAT USED TO SIT OUTSIDE THIS TABLE, now inside it — which is the whole
  // point of the change that put them here. Each one separates 「the code the server matches」 from
  // 「the code `useAuth().hasPermission` would expand to」, and the browser predicates are now
  // computed from a literal, server-shaped ladder, so every loop below holds for them too:
  //   · a BARE `integration:admin` — a platform admin to the server, and now to the browser as well;
  //     StockPreparationWorkspace.spec.ts stands its admin up in exactly this shape.
  //   · `stock-prep:*` — a real thing to grant a role, expanded by `hasPermission`, refused by the
  //     server. It must therefore be refused here, or the page renders controls that 403.
  //   · `*:*` WITHOUT the admin role — members get the wildcard in their permission list but not the
  //     `role:admin` pseudo-code, so the server refuses them.
  //   · `stock-prep:write` — `hasPermission` derives `:read` from `:write`; the server does not.
  { name: 'integration:admin without role', roles: [], permissions: ['integration:admin'] },
  { name: 'stock-prep:* wildcard', roles: [], permissions: ['stock-prep:*'] },
  { name: '*:* without the admin role', roles: [], permissions: ['*:*'] },
  { name: 'stock-prep:write holder', roles: [], permissions: ['stock-prep:write'] },
]

/** The seam principals, by name, for the tests that quote them one at a time. */
function actorNamed(name: string): Actor {
  const hit = ACTORS.find((actor) => actor.name === name)
  if (!hit) throw new Error(`no such actor: ${name}`)
  return hit
}

function asActor(actor: Actor): void {
  h.roles = [...actor.roles]
  h.permissions = [...actor.permissions]
}

/**
 * THE PRINCIPAL the workbench predicates take — `useAuth().getAccessSnapshot()`'s `{ roles,
 * permissions }`, which is what the browser mirror computes its literal ladder over.
 *
 * `probe()` (the expanding `hasPermission`) is deliberately NOT what these predicates receive any
 * more, and the two are kept separate here on purpose — but NOT for the reason an earlier version
 * of this comment gave. It said `probe()` "still drives the ROUTE GUARD in F-03, which is app-wide
 * machinery this wave did not change", and as of the gate-alignment change that is simply false:
 * `buildStockPrepAwarePermissionProbe` now answers the three `stock-prep:*` codes from the
 * PRINCIPAL, so in F-03 `probe()` is handed to the adapter and then deliberately BYPASSED for
 * exactly the code that route declares. The file still needs both because `probe()` is what every
 * OTHER permission on every other route still goes through, and F-03 passes it in to prove that the
 * bypass is scoped rather than total.
 */
function principal(): { roles: string[]; permissions: string[] } {
  return { roles: [...h.roles], permissions: [...h.permissions] }
}

/** The same principal in the SERVER's shape — the flattened list `listUserPermissions` produces. */
function flattened(): string[] {
  return [...h.permissions, ...h.roles.map((role) => `role:${role}`)]
}

function probe(): (permission: string) => boolean {
  return (permission: string) => realHasPermission(permission)
}

/** Drain the pending fetch/microtask chain and the Vue render queue. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

describe('O2 / R-11 — /stock-prep permission matrix (front end)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.roles = []
    h.permissions = []
    // Every read resolves to a queue holding ONE pending row. The suite is about which controls
    // exist, not about what they fetch — but the surface has to be POPULATED for the question to be
    // meaningful: the per-row and form controls are data-conditional, so measuring an empty page
    // would report "hidden" for controls the permission actually grants and make the alignment
    // assertion pass vacuously.
    h.apiFetch.mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, data: queuePayload() }),
      { status: 200 },
    ))
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

  function mountQueueView(): HTMLDivElement {
    app = createApp(StockPreparationConfirmationQueueView as Component, { scope: SCOPE })
    app.mount(container!)
    return container!
  }

/**
 * Capabilities whose control does NOT live on the confirmation-queue view, and therefore cannot be
 * measured against that view's DOM. Each needs a reason, and each must be covered elsewhere.
 *
 * `confirmationQueue.projectBoard` is 项目备料页 — its own TAB in the workspace shell, a sibling of
 * this view, not a control inside it. Asserting the queue's DOM renders it would be measuring the
 * wrong DOM (the same argument the backend manifest header already makes about
 * `canRunStockPrepInstall`). Its alignment IS asserted, in
 * apps/web/tests/StockPreparationProjectBoard.spec.ts B-01: the tab is present for exactly the
 * operator tier and absent for everyone below it, and the DOM and `canOpenStockPrepProjectBoard`
 * are asserted to agree for every one of those actors — which is this same both-directions claim,
 * made against the surface the control actually lives on.
 */
const CONTROLS_NOT_ON_THE_QUEUE_VIEW: readonly string[] = Object.freeze([
  'stock-prep-operator-project-board',
])

  /** The control testids actually present in the DOM, restricted to the manifest's control set. */
  function queueViewControls(): string[] {
    return STOCK_PREP_WORKBENCH_CAPABILITIES
      .map((capability) => capability.control)
      .filter((control): control is string => typeof control === 'string')
      .filter((control) => !CONTROLS_NOT_ON_THE_QUEUE_VIEW.includes(control))
  }

  function renderedControls(root: HTMLElement): string[] {
    return queueViewControls()
      .filter((control) => root.querySelector(`[data-testid="${control}"]`) !== null)
      .sort()
  }

  /** What this actor may see ON THIS VIEW — the granted set, minus the controls that live elsewhere. */
  function grantedQueueViewControls(): string[] {
    return visibleStockPrepControls(principal())
      .filter((control) => !CONTROLS_NOT_ON_THE_QUEUE_VIEW.includes(control))
      .sort()
  }

  /**
   * Mount the view and drive it to its FULLY POPULATED state before measuring: load the queue, then
   * select a row. Some controls are data-conditional (the per-row value-entry button, the confirm
   * form), so measuring a blank page would credit the permission gate for absences that are really
   * just "no data yet" — the alignment assertion would then pass while proving nothing.
   *
   * Every step is itself permission-gated, which is the point: an actor with no read control cannot
   * load, so it legitimately renders nothing, and an actor with no confirm control cannot select.
   */
  async function renderFullySettled(): Promise<HTMLElement> {
    const root = mountQueueView()
    await nextTick()
    const refresh = root.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement | null
    if (refresh) {
      refresh.click()
      await flush()
    }
    const select = root.querySelector('[data-testid="stock-prep-confirmation-select"]') as HTMLButtonElement | null
    if (select) {
      select.click()
      await flush()
    }
    return root
  }

  function resetMount(): void {
    if (app) app.unmount()
    app = null
    if (container) container.innerHTML = ''
  }

  // ---------------------------------------------------------------------------
  // F-01 the mirror cannot drift
  // ---------------------------------------------------------------------------

  it('F-01: the browser vocabulary mirror is byte-equal to the plugin module', () => {
    expect(STOCK_PREP_READ).toBe(backendAccess.STOCK_PREP_READ)
    expect(STOCK_PREP_OPERATE).toBe(backendAccess.STOCK_PREP_OPERATE)
    expect(STOCK_PREP_ADMIN).toBe(backendAccess.STOCK_PREP_ADMIN)
    expect(PLATFORM_ADMIN_GATE).toBe(backendAccess.PLATFORM_ADMIN_GATE)
    expect(STOCK_PREP_ROUTE_PERMISSION).toBe(backendAccess.STOCK_PREP_ROUTE_PERMISSION)
    expect([...STOCK_PREP_PERMISSION_CODES]).toEqual([...backendAccess.STOCK_PREP_PERMISSION_CODES])
    // The whole manifest, field for field and in order: capability id, gating code, method, path,
    // and the control testid the view must render.
    expect(STOCK_PREP_WORKBENCH_CAPABILITIES.map((capability) => ({ ...capability })))
      .toEqual(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES.map((capability: Record<string, unknown>) => ({ ...capability })))
  })

  it('F-01: the mirrored capability resolver agrees with the server for every actor', () => {
    // UNIVERSAL, not bounded. The table now includes the four principals that used to be excluded
    // from it precisely because they broke this equality (see ACTORS), so passing here is the claim
    // 「the browser grants exactly what the server grants」 with no footnote attached.
    for (const actor of ACTORS) {
      asActor(actor)
      expect(grantedStockPrepCapabilities(principal()).sort(), `${actor.name} capabilities`)
        .toEqual([...backendAccess.grantedStockPrepCapabilities(flattened())].sort())
    }
  })

  it('F-01: the browser transcribes the two server decisions, not a second reading of them', () => {
    // The mirror is now a mirror of the DECISIONS as well as of the vocabulary: the platform-admin
    // list is byte-equal, and the ladder answers identically for every actor and every code —
    // including the codes outside the frozen set, which must fail closed on both sides.
    expect([...PLATFORM_ADMIN_PERMISSIONS]).toEqual([...backendAccess.PLATFORM_ADMIN_PERMISSIONS])
    for (const actor of ACTORS) {
      asActor(actor)
      expect(holdsPlatformAdmin(principal()), `${actor.name} platform admin`)
        .toBe(backendAccess.holdsPlatformAdmin(flattened()))
      for (const code of [...STOCK_PREP_PERMISSION_CODES, 'stock-prep:*', 'stock-prep:write', '*:*', 'integration:admin', '']) {
        expect(satisfiesStockPrepAccess(principal(), code), `${actor.name} @ ${code || '(empty)'}`)
          .toBe(backendAccess.satisfiesStockPrepAccess(flattened(), code))
      }
    }
  })

  // ---------------------------------------------------------------------------
  // F-02 / F-07 / F-08 the declarations
  // ---------------------------------------------------------------------------

  it('F-02: the /stock-prep route declares the workbench code, not integration:write', () => {
    const block = APP_ROUTES_SOURCE.slice(APP_ROUTES_SOURCE.indexOf("path: '/stock-prep'"))
      .slice(0, 400)
    expect(block).toContain("permissions: ['stock-prep:read']")
    expect(block).not.toContain("permissions: ['integration:write']")
    expect(STOCK_PREP_ROUTE_PERMISSION).toBe('stock-prep:read')
  })

  it('F-07: the nav link is gated on the workbench gate itself, not on integration:write and not on the expanding probe', () => {
    expect(APP_VUE_SOURCE).toContain('v-if="canUseStockPreparation" to="/stock-prep"')
    expect(APP_VUE_SOURCE).not.toContain('v-if="canUseIntegration" to="/stock-prep"')
    expect(APP_VUE_SOURCE).toContain('canReachStockPrepWorkbench(getAccessSnapshot())')
    // The expanding app-wide probe must not be what decides this link — that was the divergence.
    expect(APP_VUE_SOURCE).not.toContain('hasPermission(STOCK_PREP_ROUTE_PERMISSION)')
  })

  it('F-08: /stock-prep declares NO requiredFeature (a flag would be a second gate on admins too)', () => {
    const block = APP_ROUTES_SOURCE.slice(APP_ROUTES_SOURCE.indexOf("path: '/stock-prep'")).slice(0, 400)
    expect(block).not.toContain('requiredFeature')
    // And no stock-prep feature was smuggled into the known set.
    expect([...KNOWN_REQUIRED_FEATURES]).toEqual(['attendance', 'workflow', 'attendanceAdmin', 'attendanceImport', 'plm', 'elearning'])
  })

  // ---------------------------------------------------------------------------
  // F-03 reachability
  // ---------------------------------------------------------------------------

  it('F-03: the route guard admits exactly the actors holding the read code', () => {
    const meta = { title: 'Stock Preparation', requiresAuth: true, permissions: [STOCK_PREP_ROUTE_PERMISSION] }
    const expected: Record<string, 'allow' | 'redirect'> = {
      'unauthenticated': 'redirect',
      'logged-in without codes': 'redirect',
      'integration:write holder': 'redirect',
      'operator with read': 'allow',
      'operator with read+confirm': 'allow',
      'orphan operate (no read)': 'redirect',
      'workbench admin': 'allow',
      'platform admin': 'allow',
      // THE FOUR ROWS THAT USED TO DIVERGE, now closed. They used to read
      // redirect/allow/allow/allow, because the guard ran on `useAuth().hasPermission`, which
      // expands `*:*`, `stock-prep:*` and `stock-prep:write` → read and treats `users:write` as
      // admin — so three principals reached `/stock-prep` and found every panel refusing them,
      // while a bare `integration:admin` (a platform admin to the server) was redirected away from
      // a page it may use in full. `buildStockPrepAwarePermissionProbe` now answers the three
      // stock-prep codes with `satisfiesStockPrepAccess`, so the guard and the workbench give ONE
      // answer per principal. Three of the four moved STRICTLY NARROWER; the fourth stopped hiding
      // a page the server already serves.
      'integration:admin without role': 'allow',
      'stock-prep:* wildcard': 'redirect',
      '*:* without the admin role': 'redirect',
      'stock-prep:write holder': 'redirect',
    }
    for (const actor of ACTORS) {
      asActor(actor)
      const decision = resolveRouteGuardDecision(
        buildRouteGuardInput({ path: '/stock-prep', meta }),
        buildRouteGuardContext({
          auth: { hasPermission: probe(), getAccessSnapshot: () => principal() },
          flags: {
            hasFeature: () => true,
            isAttendanceFocused: () => false,
            isPlmWorkbenchFocused: () => false,
            resolveHomePath: () => '/',
          },
        }),
      )
      expect(decision.action, `${actor.name} guard decision`).toBe(expected[actor.name])
    }
  })

  it('F-03: an integration:write holder loses reachability it should never have had', () => {
    // The pre-change gate. This is the misalignment the PR closes: the page admitted this principal
    // and then 403'd on every endpoint inside it.
    asActor({ name: 'x', roles: [], permissions: ['integration:write'] })
    expect(realHasPermission('integration:write')).toBe(true)
    expect(realHasPermission(STOCK_PREP_ROUTE_PERMISSION)).toBe(false)
    expect(grantedStockPrepCapabilities(principal())).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // F-04 THE ALIGNMENT ASSERTION
  // ---------------------------------------------------------------------------

  it('F-04: rendered controls equal granted capabilities, both directions, for every actor', async () => {
    for (const actor of ACTORS) {
      asActor(actor)
      const root = await renderFullySettled()

      const rendered = renderedControls(root)
      const granted = grantedQueueViewControls()

      const visibleButNotPermitted = rendered.filter((control) => !granted.includes(control))
      expect(visibleButNotPermitted, `${actor.name}: control rendered without the permission behind it`).toEqual([])

      const permittedButHidden = granted.filter((control) => !rendered.includes(control))
      expect(permittedButHidden, `${actor.name}: permitted capability with no control rendered`).toEqual([])

      expect(rendered, `${actor.name}: visible set must EQUAL granted set`).toEqual(granted)

      resetMount()
    }
  })

  it('F-04: a read-only operator sees the rows but no per-row write control (positive control)', async () => {
    // The positive control the alignment loop needs: the row IS rendered for this actor, so the
    // absence of the write controls below is the permission gate at work, not an empty queue.
    asActor({ name: 'read', roles: [], permissions: [STOCK_PREP_READ] })
    const root = await renderFullySettled()
    expect(root.querySelectorAll('[data-testid="stock-prep-confirmation-row"]').length).toBe(1)
    expect(root.querySelector('[data-testid="stock-prep-confirmation-value-entry"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-confirmation-select"]')).toBeNull()
    resetMount()

    // ...whereas the confirming operator, on the SAME data, gets both.
    asActor({ name: 'confirm', roles: [], permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
    const operatorRoot = await renderFullySettled()
    expect(operatorRoot.querySelectorAll('[data-testid="stock-prep-confirmation-row"]').length).toBe(1)
    expect(operatorRoot.querySelector('[data-testid="stock-prep-confirmation-value-entry"]')).not.toBeNull()
    expect(operatorRoot.querySelector('[data-testid="stock-prep-confirmation-confirm"]')).not.toBeNull()
  })

  it('F-05: alignment holds for every subset of the vocabulary, not just the named tiers', async () => {
    const codes = [...STOCK_PREP_PERMISSION_CODES]
    for (let mask = 0; mask < (1 << codes.length); mask += 1) {
      const held = codes.filter((_, index) => (mask & (1 << index)) !== 0)
      asActor({ name: `subset-${mask}`, roles: [], permissions: held })
      const root = await renderFullySettled()
      expect(renderedControls(root), `subset {${held.join(', ')}}`).toEqual(grantedQueueViewControls())
      resetMount()
    }
  })

  it('F-05: the orphan operate grant renders nothing at all', async () => {
    asActor({ name: 'orphan', roles: [], permissions: [STOCK_PREP_OPERATE] })
    const root = mountQueueView()
    await nextTick()
    expect(renderedControls(root)).toEqual([])
    expect(grantedStockPrepCapabilities(principal())).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // F-06 the legacy MVP tabs
  // ---------------------------------------------------------------------------

  it('F-06: the legacy MVP tabs are platform-admin only (their routes never moved)', () => {
    const cases: Array<[Actor, boolean]> = [
      [{ name: 'read', roles: [], permissions: [STOCK_PREP_READ] }, false],
      [{ name: 'confirm', roles: [], permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }, false],
      [{ name: 'workbench admin', roles: [], permissions: [STOCK_PREP_ADMIN] }, false],
      [{ name: 'platform admin', roles: ['admin'], permissions: ['integration:admin'] }, true],
      [{ name: 'integration admin only', roles: [], permissions: ['integration:admin'] }, true],
    ]
    for (const [actor, expected] of cases) {
      asActor(actor)
      expect(canUseLegacyMvpTabs(principal()), `${actor.name} legacy tabs`).toBe(expected)
    }
  })

  it('F-06: the workbench shell filters the tab strip on that same predicate', () => {
    const workspace = readFileSync(
      resolve(REPO_ROOT, 'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue'),
      'utf8',
    )
    const rail = readFileSync(
      resolve(REPO_ROOT, 'apps/web/src/components/integration/stockPreparation/StockPreparationRail.vue'),
      'utf8',
    )
    // The tab strip iterates the FILTERED list, and the panel keys off the effective (visible) key —
    // both halves are needed, since either alone leaves a reachable admin-only panel.
    //
    // P1-1 SPLIT THE FIRST HALF ACROSS TWO FILES, so the pin follows it rather than being dropped:
    // the shell still computes `visibleViews` (and still computes it from `canUseLegacyMvpTabs`), and
    // the rail iterates ONLY what the shell hands it. What must not exist is a rail that reaches for
    // the unfiltered list or re-derives permissions of its own — hence the two negative assertions.
    expect(workspace).toContain('const visibleViews = computed(')
    expect(rail).toContain('v-for="item in group.items"')
    // 深度工具 MOVED OUT OF THE TABLIST (hardening wave, 2026-09-08 — see StockPreparationRail.vue's
    // own top-of-file comment and R-05 in StockPreparationRail.spec.ts), so its `v-for` is no longer
    // written inline inside the SAME `v-for="group in groups"` loop `group.items` sits in — the
    // template loops a single `advancedGroup` computed instead, since only one group (`deploy`) ever
    // carries a non-empty `advanced` list and the disclosure now renders once, as a nav-level sibling
    // of the tablist rather than once per group. The GUARANTEE this line exists to pin is unchanged:
    // `advancedGroup.advanced` still traces straight back to the SAME prop-derived `groups` array (see
    // `advancedGroup = computed(() => props.groups.find(...))` a few lines above the template in that
    // file) — nothing here re-derives or re-filters permissions of its own, which is exactly what the
    // two negative assertions below still hold down.
    expect(rail).toContain('v-for="item in advancedGroup.advanced"')
    expect(rail).toContain('advancedGroup = computed')
    expect(rail).not.toContain('hasPermission')
    expect(rail).not.toContain('workbenchAccess')
    // ...AND THE WIRE BETWEEN THEM. The three above pin each end — the shell filters, the rail
    // iterates what it is handed — and say nothing about whether the list handed over is the
    // filtered one. These two are that link: `railGroups` is assembled FROM `visibleViews.value`,
    // and `railGroups` is what the template passes. Without them, re-pointing the assembly at the
    // unfiltered `views` array leaves every assertion in this test green.
    expect(workspace).toContain('const visible = visibleViews.value')
    expect(workspace).toContain(':groups="railGroups"')
    expect(workspace).toContain('canUseLegacyMvpTabs')
    expect(workspace).toContain("effectiveKey === 'confirmation-queue'")
    expect(workspace).not.toContain("v-if=\"activeKey === 'dashboard'\"")
    // Exactly the seven legacy MVP tabs are marked; the confirmation queue is not.
    expect(workspace.split('legacyMvp: true').length - 1).toBe(7)
  })
  // ---------------------------------------------------------------------------
  // F-09 the RAIL manifest and the D2 landing — the second thing the mirror pins
  // ---------------------------------------------------------------------------
  //
  // P1-1 turned the tab strip into a grouped rail and P1-1's D2=A moved the landing. Both are now
  // DATA (`STOCK_PREP_RAIL_GROUPS`) plus one pure decision (`stockPrepLandingKey`), and both are
  // mirrored by the plugin module, so this block is F-01's shape applied to them: byte-equality of
  // the manifest, then per-actor agreement of the resolvers.

  it('F-09: the rail manifest is byte-equal to the plugin module, gate token for gate token', () => {
    const flatten = (groups: readonly unknown[]): unknown => JSON.parse(JSON.stringify(groups))
    expect(flatten(STOCK_PREP_RAIL_GROUPS)).toEqual(flatten(backendAccess.STOCK_PREP_RAIL_GROUPS))
    expect([...STOCK_PREP_LANDING_KEYS]).toEqual([...backendAccess.STOCK_PREP_LANDING_KEYS])
    // Every gate token used by the manifest is one the resolver knows. An unknown token resolves to
    // a REFUSAL on both sides, so a typo would hide a whole group rather than open one — but it
    // would still be a silent outage, and this is what catches it.
    const tokens = new Set<string>()
    for (const group of STOCK_PREP_RAIL_GROUPS) {
      for (const item of group.items) tokens.add(item.gate)
      if (group.advancedGate) tokens.add(group.advancedGate)
    }
    expect([...tokens].sort()).toEqual([...backendAccess.STOCK_PREP_RAIL_GATES].sort())
  })

  it('F-09: every rail item names a view the shell actually renders, and no key was dropped', () => {
    const workspace = readFileSync(
      resolve(REPO_ROOT, 'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue'),
      'utf8',
    )
    const keys: string[] = []
    for (const group of STOCK_PREP_RAIL_GROUPS) {
      for (const item of group.items) keys.push(item.key)
      for (const key of group.advanced ?? []) keys.push(key)
    }
    // 15 today: 4 【工作】 + 3 【部署与接入】 + 7 深度工具 + 1 【帮助】. Stated as a number so that
    // adding a rail item without a view — or a view without a rail item — has to be deliberate.
    // 14 -> 15 是 P2-1 的 项目查询(设计稿 §6.3 第一行),【工作】里排在 项目备料 之后。
    expect(keys.length).toBe(15)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(workspace, `${key} must be a view key in the shell`).toContain(`key: '${key}',`)
    }
    // 不下线: every legacy MVP key is still in the manifest, folded rather than removed.
    for (const key of ['dashboard', 'project-workspace', 'bom-snapshot-diff', 'material-mapping', 'unit-conversion', 'prep-line', 'exception-queue']) {
      expect(keys, `${key} must still be reachable`).toContain(key)
    }
  })

  it('F-09: the rail gate resolver agrees with the server for EVERY actor and every gate', () => {
    // UNBOUNDED. This loop used to carry a named exception — `integration:admin` without an admin
    // role — because the two sides spelled 「platform admin」 differently. They no longer do: the
    // browser computes this from its own transcription of `satisfiesStockPrepAccess` /
    // `holdsPlatformAdmin` over the same flattened principal, so the equality is universal and the
    // four seam principals are ordinary rows of ACTORS.
    for (const actor of ACTORS) {
      asActor(actor)
      for (const gate of backendAccess.STOCK_PREP_RAIL_GATES as string[]) {
        expect(
          canOpenStockPrepRailItem(gate as never, principal()),
          `${actor.name} @ ${gate}`,
        ).toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), gate))
      }
      // An unknown token refuses on both sides, for everyone — including the platform admin.
      expect(canOpenStockPrepRailItem('not-a-gate' as never, principal())).toBe(false)
      expect(backendAccess.satisfiesStockPrepRailGate(flattened(), 'not-a-gate')).toBe(false)
    }
  })

  it('F-09: the named rail predicates are exactly the gates the manifest assigns them', () => {
    for (const actor of ACTORS) {
      asActor(actor)
      // 【工作】's two value-bearing items ride the operator tier; 【部署与接入】 rides the workbench
      // ceiling; 【帮助】 rides reachability. Asserted through the NAMED predicates, because that is
      // what the rest of the app calls and a manifest that agreed with nothing would prove nothing.
      // The right-hand sides are the SERVER's answers, so this is a cross-side equality as well
      // rather than the browser agreeing with itself.
      expect(canOpenStockPrepHome(principal()), `${actor.name} home`)
        .toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), 'operator-board'))
      // 项目查询 (P2-1) rides the SAME operator tier, through its own named predicate: the shell asks
      // this one, the manifest names `operator-board`, and this line is what stops the two from ever
      // meaning different things.
      expect(canOpenStockPrepProjectQuery(principal()), `${actor.name} project-query`)
        .toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), 'operator-board'))
      expect(canOpenStockPrepInstallView(principal()), `${actor.name} install view`)
        .toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), 'workbench-admin'))
      expect(canOpenStockPrepGettingStarted(principal()), `${actor.name} getting-started`)
        .toBe(canOpenStockPrepInstallView(principal()))
      expect(canOpenStockPrepOpsPanel(principal()), `${actor.name} ops`)
        .toBe(canOpenStockPrepInstallView(principal()))
      expect(canOpenStockPrepHelp(principal()), `${actor.name} help`)
        .toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), 'route'))
      expect(canUseLegacyMvpTabs(principal()), `${actor.name} 深度工具`)
        .toBe(backendAccess.satisfiesStockPrepRailGate(flattened(), 'platform-admin'))
    }
  })

  it('F-09 / D2=A: the landing key agrees with the server for EVERY actor and all three postures', () => {
    // Same universality as the gate loop above: no bound, no enumerated exception.
    for (const actor of ACTORS) {
      asActor(actor)
      for (const ready of [true, false, null]) {
        expect(
          stockPrepLandingKey(principal(), ready),
          `${actor.name} @ deploymentReady=${String(ready)}`,
        ).toBe(backendAccess.stockPrepWorkbenchLandingKey(flattened(), ready))
      }
    }
  })

  it('F-09 / D2=A: 装完落总览,未装完落开始使用,读不到也落开始使用', () => {
    // The workbench admin — the tier the ruling is about.
    asActor({ name: 'workbench admin', roles: [], permissions: [STOCK_PREP_ADMIN] })
    expect(stockPrepLandingKey(principal(), true)).toBe('ops')
    expect(stockPrepLandingKey(principal(), false)).toBe('getting-started')
    // 「看不到」 IS NOT 「装完了」. An unreadable preflight must not send anyone to the health page.
    expect(stockPrepLandingKey(principal(), null)).toBe('getting-started')
    expect(landsOnStockPrepGettingStarted(principal(), null)).toBe(true)
    expect(landsOnStockPrepGettingStarted(principal(), true)).toBe(false)

    // 一线 (operate ∧ read) lands on 今天要处理, and the preflight argument is not consulted for them
    // at all — their landing cannot depend on a read their tier does not make.
    asActor({ name: 'operator', roles: [], permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
    for (const ready of [true, false, null]) {
      expect(stockPrepLandingKey(principal(), ready)).toBe('home')
    }

    // The values-free queue watcher keeps today's landing, in all three postures.
    asActor({ name: 'read only', roles: [], permissions: [STOCK_PREP_READ] })
    for (const ready of [true, false, null]) {
      expect(stockPrepLandingKey(principal(), ready)).toBe('confirmation-queue')
    }
  })

  it('F-09: 确认队列 —— the manifest gate and the shell fallback for a BARE operate grant, stated', () => {
    // THE ONE PLACE THE MANIFEST AND THE SHELL DO NOT SAY THE SAME THING, written down with its
    // expected values rather than left to be rediscovered.
    //
    // `confirmation-queue`'s rail gate is `route` (= `stock-prep:read`), so for an orphan
    // `stock-prep:operate` grant the manifest answers FALSE. The shell's `views` entry carries none
    // of the four gate flags, so `visibleViews` keeps it unconditionally and the landing resolver's
    // last line names it — i.e. the shell's fallback WOULD render a tab this principal's gate refuses.
    //
    // IT IS NOT REACHABLE, and that is the answer rather than an excuse: `/stock-prep`'s route meta is
    // `['stock-prep:read']`, F-03 above asserts this exact principal is REDIRECTED, and the queue view
    // itself renders no control for them (F-05: 「the orphan operate grant renders nothing at all」).
    // So the divergence cannot produce a visible-but-403 control. Closing it properly means giving the
    // shell's `views` a route-gate flag, which is a shell change this wave did not take; it is listed
    // in the PR body's 「没做/偏离」 with this test as its record.
    asActor(actorNamed('orphan operate (no read)'))
    expect(canOpenStockPrepRailItem('route', principal()), 'manifest gate: refused').toBe(false)
    expect(backendAccess.satisfiesStockPrepRailGate(flattened(), 'route'), 'server agrees: refused').toBe(false)
    expect(stockPrepLandingKey(principal(), null), 'the fallback still NAMES the queue').toBe('confirmation-queue')
    expect(backendAccess.stockPrepWorkbenchLandingKey(flattened(), null)).toBe('confirmation-queue')
    // ...and nothing behind it is granted, on either side.
    expect(grantedStockPrepCapabilities(principal())).toEqual([])
    expect([...backendAccess.grantedStockPrepCapabilities(flattened())]).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // F-10 — 两侧同形,不吃通配
  // ---------------------------------------------------------------------------
  //
  // The loops above are universal quantifiers, and a universal quantifier over a table is only as
  // strong as the table. This block is the table's teeth: the four principals that separate 「the
  // code the server matches」 from 「the code `useAuth().hasPermission` would expand to」, each with
  // LITERAL expected values on BOTH sides. They are rows of ACTORS too, so the loops already cover
  // them; what these add is a statement of WHAT the shared answer is, so that changing either
  // algebra reddens here with the new answer visible in the diff.

  it('F-10: a BARE `integration:admin` is a platform admin on BOTH sides', () => {
    asActor(actorNamed('integration:admin without role'))
    // The browser's `holdsPlatformAdmin` accepts the literal code, exactly as the server's does, so
    // every gate opens and D2's posture rule applies. This is the principal
    // StockPreparationWorkspace.spec.ts stands its admin up as, so it is not a hypothetical.
    expect(holdsPlatformAdmin(principal())).toBe(true)
    for (const gate of ['route', 'operator-board', 'workbench-admin', 'platform-admin'] as const) {
      expect(canOpenStockPrepRailItem(gate, principal()), `browser @ ${gate}`).toBe(true)
      expect(backendAccess.satisfiesStockPrepRailGate(flattened(), gate), `server @ ${gate}`).toBe(true)
    }
    expect(stockPrepLandingKey(principal(), true)).toBe('ops')
    expect(stockPrepLandingKey(principal(), false)).toBe('getting-started')
    expect(stockPrepLandingKey(principal(), null)).toBe('getting-started')
    expect(backendAccess.stockPrepWorkbenchLandingKey(flattened(), true)).toBe('ops')
    expect(backendAccess.stockPrepWorkbenchLandingKey(flattened(), false)).toBe('getting-started')
    expect(backendAccess.stockPrepWorkbenchLandingKey(flattened(), null)).toBe('getting-started')
    // ...and the WHOLE capability manifest, on both sides — the assertion that used to record the
    // fork's widest consequence now records its closure.
    const everything = STOCK_PREP_WORKBENCH_CAPABILITIES.map((capability) => capability.capability).sort()
    expect(grantedStockPrepCapabilities(principal()).sort()).toEqual(everything)
    expect([...backendAccess.grantedStockPrepCapabilities(flattened())].sort()).toEqual(everything)
    // An unknown token still refuses on both sides — being a platform admin is not being exempt.
    expect(canOpenStockPrepRailItem('not-a-gate' as never, principal())).toBe(false)
    expect(backendAccess.satisfiesStockPrepRailGate(flattened(), 'not-a-gate')).toBe(false)
  })

  it('F-10: the three WILDCARD / DERIVED grants open NOTHING, on either side', () => {
    // `useAuth().hasPermission` says yes to all three; the server says no to all three; the workbench
    // now says no as well, which is the only answer that keeps 「visible == actionable」 true — the
    // page would otherwise render the queue, the board and their controls straight into a 403.
    for (const name of ['stock-prep:* wildcard', '*:* without the admin role', 'stock-prep:write holder']) {
      const actor = actorNamed(name)
      asActor(actor)
      // The expanding probe really would have admitted them — the positive control that makes the
      // refusals below a decision rather than an empty permission list.
      expect(realHasPermission(STOCK_PREP_READ), `${name}: hasPermission expands`).toBe(true)

      expect(holdsPlatformAdmin(principal()), `${name} platform admin`).toBe(false)
      for (const gate of ['route', 'operator-board', 'workbench-admin', 'platform-admin'] as const) {
        expect(canOpenStockPrepRailItem(gate, principal()), `${name} browser @ ${gate}`).toBe(false)
        expect(backendAccess.satisfiesStockPrepRailGate(flattened(), gate), `${name} server @ ${gate}`).toBe(false)
      }
      for (const ready of [true, false, null]) {
        expect(stockPrepLandingKey(principal(), ready), `${name} browser landing`).toBe('confirmation-queue')
        expect(backendAccess.stockPrepWorkbenchLandingKey(flattened(), ready), `${name} server landing`)
          .toBe('confirmation-queue')
      }
      expect(grantedStockPrepCapabilities(principal()), `${name} browser capabilities`).toEqual([])
      expect([...backendAccess.grantedStockPrepCapabilities(flattened())], `${name} server capabilities`).toEqual([])
    }
  })

  it('F-10: the browser refuses the wildcards BY MATCHING LITERALLY, not by accident of the table', () => {
    // The MECHANISM, pinned at source level: swapping the literal ladder back for the expanding probe
    // reddens here even if some future edit to ACTORS stopped exercising it.
    const source = readFileSync(
      resolve(REPO_ROOT, 'apps/web/src/services/integration/stockPreparation/workbenchAccess.ts'),
      'utf8',
    )
    // No predicate in the module may consult the expanding probe, and no predicate may take one.
    // COMMENTS ARE STRIPPED FIRST: the module's header argues at length about `hasPermission`, and
    // matching that prose would make this pin pass on the explanation rather than on the code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('hasPermission')
    expect(code).not.toContain('(permission: string) => boolean')
    // ...and the platform-admin list is the server's, verbatim.
    expect(source).toContain("Object.freeze(['role:admin', INTEGRATION_ADMIN])")
    expect([...PLATFORM_ADMIN_PERMISSIONS]).toEqual([...backendAccess.PLATFORM_ADMIN_PERMISSIONS])
  })
})
