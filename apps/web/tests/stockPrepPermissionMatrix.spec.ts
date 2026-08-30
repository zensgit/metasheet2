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
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_READ,
  STOCK_PREP_ROUTE_PERMISSION,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canUseLegacyMvpTabs,
  grantedStockPrepCapabilities,
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
]

function asActor(actor: Actor): void {
  h.roles = [...actor.roles]
  h.permissions = [...actor.permissions]
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

  /** The control testids actually present in the DOM, restricted to the manifest's control set. */
  function renderedControls(root: HTMLElement): string[] {
    const manifestControls = STOCK_PREP_WORKBENCH_CAPABILITIES
      .map((capability) => capability.control)
      .filter((control): control is string => typeof control === 'string')
    return manifestControls.filter((control) => root.querySelector(`[data-testid="${control}"]`) !== null).sort()
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
    for (const actor of ACTORS) {
      asActor(actor)
      const flattened = [...actor.permissions, ...actor.roles.map((role) => `role:${role}`)]
      expect(grantedStockPrepCapabilities(probe()).sort())
        .toEqual([...backendAccess.grantedStockPrepCapabilities(flattened)].sort())
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

  it('F-07: the nav link is gated on the route permission, not on integration:write', () => {
    expect(APP_VUE_SOURCE).toContain('v-if="canUseStockPreparation" to="/stock-prep"')
    expect(APP_VUE_SOURCE).not.toContain('v-if="canUseIntegration" to="/stock-prep"')
    expect(APP_VUE_SOURCE).toContain('hasPermission(STOCK_PREP_ROUTE_PERMISSION)')
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
    }
    for (const actor of ACTORS) {
      asActor(actor)
      const decision = resolveRouteGuardDecision(
        buildRouteGuardInput({ path: '/stock-prep', meta }),
        buildRouteGuardContext({
          auth: { hasPermission: probe() },
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
    expect(grantedStockPrepCapabilities(probe())).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // F-04 THE ALIGNMENT ASSERTION
  // ---------------------------------------------------------------------------

  it('F-04: rendered controls equal granted capabilities, both directions, for every actor', async () => {
    for (const actor of ACTORS) {
      asActor(actor)
      const root = await renderFullySettled()

      const rendered = renderedControls(root)
      const granted = visibleStockPrepControls(probe()).sort()

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
      expect(renderedControls(root), `subset {${held.join(', ')}}`).toEqual(visibleStockPrepControls(probe()).sort())
      resetMount()
    }
  })

  it('F-05: the orphan operate grant renders nothing at all', async () => {
    asActor({ name: 'orphan', roles: [], permissions: [STOCK_PREP_OPERATE] })
    const root = mountQueueView()
    await nextTick()
    expect(renderedControls(root)).toEqual([])
    expect(grantedStockPrepCapabilities(probe())).toEqual([])
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
      expect(canUseLegacyMvpTabs(probe()), `${actor.name} legacy tabs`).toBe(expected)
    }
  })

  it('F-06: the workbench shell filters the tab strip on that same predicate', () => {
    const workspace = readFileSync(
      resolve(REPO_ROOT, 'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue'),
      'utf8',
    )
    // The tab strip iterates the FILTERED list, and the panel keys off the effective (visible) key —
    // both halves are needed, since either alone leaves a reachable admin-only panel.
    expect(workspace).toContain('v-for="view in visibleViews"')
    expect(workspace).toContain('canUseLegacyMvpTabs')
    expect(workspace).toContain("effectiveKey === 'confirmation-queue'")
    expect(workspace).not.toContain("v-if=\"activeKey === 'dashboard'\"")
    // Exactly the seven legacy MVP tabs are marked; the confirmation queue is not.
    expect(workspace.split('legacyMvp: true').length - 1).toBe(7)
  })
})
