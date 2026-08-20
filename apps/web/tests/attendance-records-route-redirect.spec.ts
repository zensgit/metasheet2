import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'

/**
 * /attendance/records had no declared route before this fix, so it fell through to the
 * '/:pathMatch(.*)*' catch-all and redirected to '/'. This locks the explicit redirect to
 * the attendance shell's Reports tab (query key 'tab', value 'reports' — confirmed against
 * AttendanceExperienceView.vue's normalizeTab()/availableTabs(), not guessed).
 */

// Asserted on SOURCE, not an import — appRoutes.ts top-level imports real .vue views, which
// pull in Element Plus CSS that vitest can't transform (same pattern as
// attendanceGroupContextRoute.spec.ts / myDelegationRoute.spec.ts).
const routesSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router/appRoutes.ts'),
  'utf8',
)

describe('/attendance/records route declaration (appRoutes source)', () => {
  it('declares an explicit redirect to the attendance Reports tab', () => {
    const start = routesSrc.indexOf(`path: '/attendance/records'`)
    expect(start, 'route /attendance/records is not declared').toBeGreaterThanOrEqual(0)
    // Grab a fixed-size window right after the path declaration — NOT the generic
    // routeBlock()-to-next-"path:'"-helper used elsewhere in this repo's route specs, since
    // that helper mis-truncates here: this route's own redirect value contains a NESTED
    // `path: '...'` key (`redirect: { path: '/attendance', ... }`), which the generic
    // "next path:" scan matches on the same line before reaching the next route entry.
    const window = routesSrc.slice(start, start + 200)
    expect(window).toContain(`redirect: { path: '/attendance', query: { tab: 'reports' } }`)
  })

  it('is declared BEFORE the not-found catch-all (so the catch-all cannot shadow it)', () => {
    const recordsIndex = routesSrc.indexOf(`path: '/attendance/records'`)
    const catchAllIndex = routesSrc.indexOf(`path: '/:pathMatch(.*)*'`)
    expect(recordsIndex).toBeGreaterThanOrEqual(0)
    expect(catchAllIndex).toBeGreaterThanOrEqual(0)
    expect(recordsIndex).toBeLessThan(catchAllIndex)
  })
})

describe('/attendance/records redirect behavior (isolated vue-router — real resolution, no appRoutes import)', () => {
  // Confirms the *shape* `redirect: { path, query }` actually resolves to the expected
  // path+query under vue-router's own redirect handling — not just that the source text
  // contains it. Uses dummy components (not the real .vue views) to sidestep the CSS
  // transform issue above; the route SHAPE under test is copied verbatim from appRoutes.ts.
  const Dummy = defineComponent({ render: () => h('div') })

  function buildRouter() {
    const routes: RouteRecordRaw[] = [
      { path: '/attendance', name: 'attendance', component: Dummy },
      { path: '/attendance/records', name: 'attendance-records-redirect', redirect: { path: '/attendance', query: { tab: 'reports' } } },
      { path: '/:pathMatch(.*)*', name: 'not-found', redirect: '/' },
      { path: '/', name: 'home', component: Dummy },
    ]
    return createRouter({ history: createMemoryHistory(), routes })
  }

  it('resolves /attendance/records to /attendance?tab=reports', async () => {
    const router = buildRouter()
    await router.push('/attendance/records')
    expect(router.currentRoute.value.path).toBe('/attendance')
    expect(router.currentRoute.value.query).toEqual({ tab: 'reports' })
    expect(router.currentRoute.value.fullPath).toBe('/attendance?tab=reports')
  })

  it('does not fall through to the not-found catch-all', async () => {
    const router = buildRouter()
    await router.push('/attendance/records')
    expect(router.currentRoute.value.name).not.toBe('not-found')
    expect(router.currentRoute.value.path).not.toBe('/')
  })
})
