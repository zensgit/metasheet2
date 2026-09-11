import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'

import { appRoutes } from '../src/router/appRoutes'
import { buildRouteGuardInput, resolveRouteGuardDecision } from '../src/router/guardPolicy'
import { matchesPermission } from '../src/utils/permission-match'
import { isPlatformAppAccessible } from '../src/composables/usePlatformApps'

/**
 * THE LEDGER of App Center card-visibility vs. entry-route reachability (G-7 ④).
 *
 * The App Center filter added on this branch decides VISIBILITY with ANY-OF over the manifest's
 * declared `permissions` (routes/platform-apps.ts#canSeePlatformApp + usePlatformApps
 * #isPlatformAppAccessible). REACHABILITY of the card's landing page is decided by a different
 * predicate entirely: the target route's own `meta` in appRoutes.ts, replayed by
 * guardPolicy#resolveRouteGuardDecision. The two are NOT the same quantity, so a subject can land
 * in either off-diagonal cell:
 *   - visible-but-blocked  (card shown, route refuses)  — the fake entry G-7 names;
 *   - permitted-but-hidden (route allows, card gone)    — introduced BY the new filter, because
 *     before it every authenticated account saw every card.
 *
 * This spec is the accounting, not a guard: it asserts the CURRENT contents of both off-diagonal
 * cells so the go-live-gate ledger
 * (docs/development/takeover-beiliao-20260821/beiliao-production-go-live-gate.md, 「④ 的残留」)
 * cannot silently drift. Add an app, change a manifest's codes, or change an entry route's meta,
 * and this file turns red — which is the signal to update that ledger, or to get the owner
 * decision the ledger says is needed. Nothing here widens or narrows any gate.
 *
 * SCOPE OF THE REPLAY (stated because it bounds the claim): every subject below gets all product
 * features ON and neither focus mode. Focus modes are a SEPARATE, path-prefix dimension
 * (guardPolicy.ts:170-188) that redirects /apps itself, so the App Center is not even reachable
 * there; the feature-flag dimension is likewise independent of permission codes. This spec isolates
 * the permission dimension deliberately.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

interface AppManifest {
  id: string
  navigation: Array<{ path: string; order?: number; location?: string }>
  permissions: string[]
}

function loadManifest(pluginDir: string): AppManifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'plugins', pluginDir, 'app.manifest.json'), 'utf8'),
  ) as AppManifest
}

/**
 * Mirrors platform/app-registry.ts#resolveEntryPath for the only case the four shipped manifests
 * exercise: the lowest-order visible `main-nav` item. Each app's expected literal is pinned below
 * as well, so a navigation edit reddens this instead of quietly re-pointing a card.
 */
function mainNavEntryPath(manifest: AppManifest): string | null {
  const items = manifest.navigation
    .filter((item) => item.location === 'main-nav')
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return items[0]?.path ?? null
}

const SHIPPED_APPS = [
  { appId: 'stock-preparation', pluginDir: 'plugin-integration-core', entryPath: '/stock-prep', routeName: 'integration-stock-preparation' },
  { appId: 'attendance', pluginDir: 'plugin-attendance', entryPath: '/attendance', routeName: 'attendance' },
  { appId: 'elearning', pluginDir: 'plugin-elearning', entryPath: '/learn', routeName: 'elearning-learner' },
  { appId: 'after-sales', pluginDir: 'plugin-after-sales', entryPath: '/p/plugin-after-sales/after-sales', routeName: 'plugin-view' },
] as const

const router = createRouter({ history: createMemoryHistory(), routes: appRoutes })

function subject(codes: string[]) {
  const hasPermission = (code: string): boolean => matchesPermission(codes, code)
  return {
    hasPermission,
    auth: { hasAdminAccess: () => false, hasPermission },
    guardContext: {
      hasFeature: () => true,
      hasPermission,
      attendanceFocused: false,
      plmWorkbenchFocused: false,
      resolveHomePath: () => '/home',
    },
  }
}

function classify(entryPath: string, declared: string[], codes: string[]): { visible: boolean; reachable: boolean } {
  const who = subject(codes)
  const resolved = router.resolve(entryPath)
  const decision = resolveRouteGuardDecision(
    buildRouteGuardInput({ path: entryPath, meta: resolved.meta }),
    who.guardContext,
  )
  return {
    visible: isPlatformAppAccessible({ permissions: declared }, who.auth),
    reachable: decision.action === 'allow',
  }
}

describe('App Center card visibility vs. entry-route reachability — the G-7 ④ ledger', () => {
  it.each(SHIPPED_APPS.map((app) => [app.appId, app] as const))(
    '%s: the card lands on the pinned entry path, resolved by the pinned route record',
    (_appId, app) => {
      const manifest = loadManifest(app.pluginDir)
      expect(mainNavEntryPath(manifest)).toBe(app.entryPath)
      expect(router.resolve(app.entryPath).name).toBe(app.routeName)
    },
  )

  it('visible-but-blocked: exactly these (code, app) pairs show a card whose landing route refuses', () => {
    const found: string[] = []
    for (const app of SHIPPED_APPS) {
      const manifest = loadManifest(app.pluginDir)
      for (const code of manifest.permissions) {
        const cell = classify(app.entryPath, manifest.permissions, [code])
        if (cell.visible && !cell.reachable) found.push(`${app.appId}:${code}`)
      }
    }
    // stock-prep `operate` and elearning `grade`/`stats` are not covered by the single `:read`
    // their entry routes require (`admin`/`write`/`*` are — see permission-match.ts), so a holder of
    // only one of them sees the card and is redirected on click. `workflow:design` is declared by
    // the attendance manifest and makes that card visible; /attendance demands no code at all, so it
    // is NOT in this cell.
    expect(found.sort()).toEqual(['elearning:elearning:grade', 'elearning:elearning:stats', 'stock-preparation:stock-prep:operate'])
  })

  it('permitted-but-hidden: exactly these apps keep an open landing route while the card is filtered away', () => {
    const found: string[] = []
    for (const app of SHIPPED_APPS) {
      const manifest = loadManifest(app.pluginDir)
      const cell = classify(app.entryPath, manifest.permissions, [])
      expect(cell.visible, `${app.appId} declares codes, so a code-less subject must not see it`).toBe(false)
      if (cell.reachable) found.push(app.appId)
    }
    // Both landing routes carry NO `permissions` in their meta: /attendance is requiresAuth +
    // requiredFeature only (appRoutes.ts:105) and after-sales has no route of its own at all — its
    // manifest path falls through to the ungated wildcard /p/:plugin/:viewId (appRoutes.ts:195-198).
    // Their manifests declare 5 and 4 codes respectively, so the new any-of filter hides a card whose
    // page the same account may still open. Consciously accepted and written down; closing it by
    // widening visibility to "no route requirement ⇒ public" would be a RELAXATION and is the
    // owner's call (see 「④ 的残留」 in the go-live gate).
    expect(found.sort()).toEqual(['after-sales', 'attendance'])
  })

  it('admin sits in neither off-diagonal cell (bypass on one side, :admin covers :read on the other)', () => {
    for (const app of SHIPPED_APPS) {
      const manifest = loadManifest(app.pluginDir)
      const resolved = router.resolve(app.entryPath)
      const adminCodes = ['*:*']
      const decision = resolveRouteGuardDecision(
        buildRouteGuardInput({ path: app.entryPath, meta: resolved.meta }),
        subject(adminCodes).guardContext,
      )
      expect(isPlatformAppAccessible({ permissions: manifest.permissions }, subject(adminCodes).auth)).toBe(true)
      expect(decision.action).toBe('allow')
    }
  })
})
