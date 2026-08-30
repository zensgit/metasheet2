/**
 * O2 / R-11 — the FRONT-END half of the stock-preparation confirmation-queue permission matrix.
 *
 * The plugin suite (plugins/plugin-integration-core/__tests__/stock-preparation-operator-permission-matrix.test.cjs)
 * owns the server half and cross-checks the FE's DECLARATIONS by reading them as source text. This
 * file owns what that one structurally cannot: the FE's actual BEHAVIOR — what
 * `resolveRouteGuardDecision` really decides for each actor tier, and which controls the queue view
 * really puts in the DOM for each tier.
 *
 * The two together are what make R-11's second direction checkable. "Nothing permitted-but-hidden"
 * is a claim about rendering, and only a mounted component can answer it.
 *
 * ACTOR TIERS (the same five the server matrix uses, plus the two pre-O2 integration tiers as
 * negative controls):
 *   unauthenticated · logged-in-no-codes · stockprep:read · stockprep:read+confirm · admin
 *   integration:read · integration:write
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRouteGuardDecision } from '../src/router/guardPolicy'

const h = vi.hoisted(() => ({
  locale: 'en' as string,
  grants: [] as string[],
  admin: false,
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(h.locale), isZh: ref(h.locale === 'zh-CN'), setLocale: vi.fn() }),
}))

// Mirrors the real `useAuth().hasPermission` decision surface: an admin short-circuit, then the
// principal's own grants. The wildcard shapes the real composable also honors are unreachable here
// because the vocabulary is closed to two plain codes (asserted on the plugin side).
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    getAccessSnapshot: () => ({ isAdmin: h.admin, email: '', roles: [], permissions: h.grants }),
    hasAdminAccess: () => h.admin,
    hasPermission: (permission: string) => h.admin || h.grants.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch, clearStoredAuthState: vi.fn(), getApiBase: () => 'https://api.example.com' }
})

import StockPreparationConfirmationQueueView from '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'
import {
  canConfirmStockPrepDecision,
  canReadStockPrepQueue,
  STOCK_PREP_CONFIRM_PERMISSION,
  STOCK_PREP_PERMISSIONS,
  STOCK_PREP_READ_PERMISSION,
} from '../src/services/integration/stockPreparation/permissions'

type Tier = {
  id: string
  authenticated: boolean
  admin: boolean
  grants: string[]
  /** May open `/stock-prep` and read the values-free queue. */
  read: boolean
  /** May read back a value entry and confirm a decision. */
  confirm: boolean
}

const TIERS: Tier[] = [
  { id: 'unauthenticated', authenticated: false, admin: false, grants: [], read: false, confirm: false },
  { id: 'logged-in-no-codes', authenticated: true, admin: false, grants: [], read: false, confirm: false },
  { id: 'stockprep:read', authenticated: true, admin: false, grants: [STOCK_PREP_READ_PERMISSION], read: true, confirm: false },
  {
    id: 'stockprep:read+confirm',
    authenticated: true,
    admin: false,
    grants: [STOCK_PREP_READ_PERMISSION, STOCK_PREP_CONFIRM_PERMISSION],
    read: true,
    confirm: true,
  },
  { id: 'admin', authenticated: true, admin: true, grants: [], read: true, confirm: true },
  // Pre-O2 tiers. `integration:write` is the one that used to be admitted to a page where
  // everything 403'd — it must now be refused by the router, which is the fix rather than a move.
  { id: 'integration:read', authenticated: true, admin: false, grants: ['integration:read'], read: false, confirm: false },
  { id: 'integration:write', authenticated: true, admin: false, grants: ['integration:write'], read: false, confirm: false },
  // A confirm grant with no read grant. Not provisionable (the access preset always issues the
  // pair) but hand-craftable, and the tier that would break direction B if either side honored it.
  { id: 'confirm-only (misconfigured)', authenticated: true, admin: false, grants: [STOCK_PREP_CONFIRM_PERMISSION], read: false, confirm: false },
]

function hasPermissionFor(tier: Tier): (permission: string) => boolean {
  return (permission: string) => tier.admin || tier.grants.includes(permission)
}

/* ───────────────────────── 1. the route guard, per tier ───────────────────────── */

describe('O2 / R-11 — /stock-prep route admission, per actor tier', () => {
  // The meta is read from the ROUTE TABLE's source rather than restated, so this suite cannot pass
  // against a route that has drifted. (Importing appRoutes eagerly pulls every view into jsdom —
  // the repo idiom is a source read; see approvalTemplateRouteGuard.spec.ts.)
  const SRC = readFileSync(join(__dirname, '../src/router/appRoutes.ts'), 'utf8')
  const blockStart = SRC.indexOf("path: '/stock-prep'")
  const block = SRC.slice(blockStart, SRC.indexOf('\n  },', blockStart))
  const declared = /permissions:\s*\[([^\]]*)\]/.exec(block)
  const routePermissions = (declared ? declared[1] : '')
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)

  it('declares exactly the read code as its admission gate', () => {
    expect(routePermissions).toEqual([STOCK_PREP_READ_PERMISSION])
  })

  const decide = (tier: Tier) => resolveRouteGuardDecision(
    { path: '/stock-prep', meta: { requiresAuth: true, permissions: routePermissions } },
    {
      hasFeature: () => true,
      hasPermission: hasPermissionFor(tier),
      attendanceFocused: false,
      plmWorkbenchFocused: false,
      resolveHomePath: () => '/HOME',
    },
  )

  for (const tier of TIERS) {
    it(`${tier.id}: ${tier.read ? 'admitted' : 'redirected home'}`, () => {
      expect(decide(tier)).toEqual(tier.read ? { action: 'allow' } : { action: 'redirect', target: '/HOME' })
    })
  }

  it('POSITIVE CONTROL — the same guard admits a tier that holds the code, so "redirect" is a real decision', () => {
    expect(decide(TIERS.find((t) => t.id === 'stockprep:read')!)).toEqual({ action: 'allow' })
  })
})

/* ──────────────────── 2. the shared capability predicates, per tier ──────────────────── */

describe('O2 / R-11 — the web permission predicates, per actor tier', () => {
  for (const tier of TIERS) {
    it(`${tier.id}: read=${tier.read} confirm=${tier.confirm}`, () => {
      const hasPermission = hasPermissionFor(tier)
      expect(canReadStockPrepQueue(hasPermission)).toBe(tier.read)
      expect(canConfirmStockPrepDecision(hasPermission)).toBe(tier.confirm)
    })
  }

  it('the vocabulary is exactly two codes — the closure the FE/BE wildcard divergence depends on', () => {
    expect([...STOCK_PREP_PERMISSIONS]).toEqual(['stockprep:read', 'stockprep:confirm'])
  })

  it('ADMISSION TICKET — confirm is never honored without read, in either direction', () => {
    const confirmOnly = hasPermissionFor(TIERS.find((t) => t.id === 'confirm-only (misconfigured)')!)
    expect(canConfirmStockPrepDecision(confirmOnly)).toBe(false)
    expect(canReadStockPrepQueue(confirmOnly)).toBe(false)
    // …and the pair IS honored, so the rule above is a rule and not a predicate that always refuses.
    const pair = hasPermissionFor(TIERS.find((t) => t.id === 'stockprep:read+confirm')!)
    expect(canConfirmStockPrepDecision(pair)).toBe(true)
  })
})

/* ─────────────── 3. what the queue view actually renders, per tier ─────────────── */

describe('O2 / R-11 — confirmation-queue control rendering, per actor tier', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  const QUEUE_PAYLOAD = {
    ok: true,
    data: {
      rowCount: 1,
      byStatus: { pending: 1 },
      byResolutionAction: {},
      parkedCount: 0,
      rows: [{
        decisionId: 'decision_1',
        conflictType: 'duplicate_expanded_key',
        status: 'pending',
        resolutionAction: null,
        inputFingerprint: 'fp_1',
        sourceRevisionPresent: true,
        confirmedByPresent: false,
        confirmedAtPresent: false,
        notesPresent: false,
        resolvedValuePresent: false,
        resolvedAuxValuePresent: false,
      }],
    },
  }

  beforeEach(() => {
    h.locale = 'en'
    h.admin = false
    h.grants = []
    h.apiFetch.mockReset()
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify(QUEUE_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
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

  async function mountQueue(tier: Tier): Promise<HTMLElement> {
    h.admin = tier.admin
    h.grants = tier.grants
    app = createApp(StockPreparationConfirmationQueueView as Component, { scope: { tenantId: 't1' } })
    app.mount(container!)
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
    return container!
  }

  /** Drive the queue load the way an operator does, then let the rows render. */
  async function loadQueue(root: HTMLElement): Promise<void> {
    const input = root.querySelector('[data-testid="stock-prep-confirmation-project-no"]') as HTMLInputElement
    input.value = 'PRJ-1'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-confirmation-load"]') as HTMLButtonElement).click()
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  const CONFIRM_TIER_CONTROLS = [
    'stock-prep-confirmation-open',
    'stock-prep-confirmation-reveal-value',
  ]

  for (const tier of TIERS.filter((t) => t.read)) {
    it(`${tier.id}: sees the queue rows, and the confirm controls ${tier.confirm ? 'ARE' : 'are NOT'} rendered`, async () => {
      const root = await mountQueue(tier)
      await loadQueue(root)

      // Direction B on the read surface: a permitted tier must actually get the queue.
      expect(root.querySelectorAll('[data-testid="stock-prep-confirmation-row"]').length).toBe(1)

      for (const testId of CONFIRM_TIER_CONTROLS) {
        const control = root.querySelector(`[data-testid="${testId}"]`)
        if (tier.confirm) {
          // Direction B: permitted, therefore visible.
          expect(control, `${testId} must render for ${tier.id}`).not.toBeNull()
        } else {
          // Direction A: not permitted, therefore not visible — no control that would 403.
          expect(control, `${testId} must NOT render for ${tier.id}`).toBeNull()
        }
      }
    })
  }

  it('read-tier: the value-bearing detail pane is absent entirely, not merely disabled', async () => {
    // A disabled control is still a visible one; R-11 asks for absence. This also pins that the
    // read tier can never reach the value-entry request, which is the O1′ values-free boundary.
    const root = await mountQueue(TIERS.find((t) => t.id === 'stockprep:read')!)
    await loadQueue(root)
    expect(root.querySelector('[data-testid="stock-prep-confirmation-detail"]')).toBeNull()
    const requested = h.apiFetch.mock.calls.map((call) => String(call[0]))
    expect(requested.some((url) => url.includes('/value-entry'))).toBe(false)
  })

  it('confirm-tier: opening a row reveals the detail pane and its submit control', async () => {
    const root = await mountQueue(TIERS.find((t) => t.id === 'stockprep:read+confirm')!)
    await loadQueue(root)
    ;(root.querySelector('[data-testid="stock-prep-confirmation-open"]') as HTMLButtonElement).click()
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-confirmation-detail"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-confirmation-submit"]')).not.toBeNull()
  })

  it('NO tier renders a reconcile control — the owner-level surface is absent from the page', async () => {
    for (const tier of TIERS.filter((t) => t.read)) {
      const root = await mountQueue(tier)
      await loadQueue(root)
      expect(root.textContent).not.toMatch(/reconcile/i)
      expect(h.apiFetch.mock.calls.map((call) => String(call[0])).some((url) => url.includes('reconcile'))).toBe(false)
      if (app) app.unmount()
      app = null
      container!.innerHTML = ''
    }
  })
})
