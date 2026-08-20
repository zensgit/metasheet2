import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'
import { ATTENDANCE_RECORDS_PATH, ATTENDANCE_RECORDS_REDIRECT_TARGET } from '../src/router/attendanceRecordsRedirect'

/**
 * /attendance/records had no declared route before this fix, so it fell through to the
 * '/:pathMatch(.*)*' catch-all and redirected to '/'. This locks the explicit redirect to
 * the attendance shell's Reports tab (query key 'tab', value 'reports' — confirmed against
 * AttendanceExperienceView.vue's normalizeTab()/availableTabs(), not guessed).
 *
 * GATE-5047 P3-1: the "behavior" describe below now builds its router from the REAL
 * ATTENDANCE_RECORDS_PATH / ATTENDANCE_RECORDS_REDIRECT_TARGET constants
 * (src/router/attendanceRecordsRedirect.ts) — the same module appRoutes.ts imports for its
 * actual route declaration — instead of a hand-copied literal. A change to either the
 * shared module or appRoutes.ts's usage of it now reds these tests, not just the
 * source-text pair below.
 */

// Asserted on SOURCE, not an import of appRoutes.ts itself — appRoutes.ts top-level
// imports real .vue views, which pull in Element Plus CSS that vitest can't transform
// (same pattern as attendanceGroupContextRoute.spec.ts / myDelegationRoute.spec.ts). The
// shared attendanceRecordsRedirect.ts module (imported above) has no such problem — it's a
// plain data module — so the REDIRECT TARGET is verified by real import; only the
// declaration's wiring into appRoutes.ts (which import it, which path key) is checked
// against source text here.
const routesSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router/appRoutes.ts'),
  'utf8',
)

describe('/attendance/records route declaration (appRoutes source)', () => {
  it('declares the route using the shared ATTENDANCE_RECORDS_PATH / ATTENDANCE_RECORDS_REDIRECT_TARGET constants', () => {
    expect(routesSrc).toContain(
      `import { ATTENDANCE_RECORDS_PATH, ATTENDANCE_RECORDS_REDIRECT_TARGET } from './attendanceRecordsRedirect'`,
    )

    // Derive the route entry's window from its OWN boundaries (the opening `{` of the
    // route object literal through its matching closing `},`) instead of a fixed-size
    // slice, which over-reads into the next entry (this repo's documented
    // "fixed-width slice reads past the boundary" trap). This entry's `redirect` value is
    // a bare identifier reference (no nested `{ ... }`), so the first `{`/`},` pair after
    // the `path:` key IS the entry's own boundary — no brace-depth counting needed.
    const pathKeyIndex = routesSrc.indexOf('path: ATTENDANCE_RECORDS_PATH')
    expect(pathKeyIndex, 'route entry using ATTENDANCE_RECORDS_PATH is not declared').toBeGreaterThanOrEqual(0)
    const entryStart = routesSrc.lastIndexOf('{', pathKeyIndex)
    expect(entryStart).toBeGreaterThanOrEqual(0)
    const entryEnd = routesSrc.indexOf('},', pathKeyIndex)
    expect(entryEnd).toBeGreaterThan(pathKeyIndex)
    const entry = routesSrc.slice(entryStart, entryEnd + 2)

    expect(entry).toContain('path: ATTENDANCE_RECORDS_PATH')
    expect(entry).toContain(`name: 'attendance-records-redirect'`)
    expect(entry).toContain('redirect: ATTENDANCE_RECORDS_REDIRECT_TARGET')
    // No stray inline literal duplicating the shared module's values — a hand-inlined
    // fallback would silently decouple the route from ATTENDANCE_RECORDS_REDIRECT_TARGET.
    expect(entry).not.toContain(`path: '/attendance/records'`)
  })

  it('is declared BEFORE the not-found catch-all (so the catch-all cannot shadow it)', () => {
    const recordsIndex = routesSrc.indexOf('path: ATTENDANCE_RECORDS_PATH')
    const catchAllIndex = routesSrc.indexOf(`path: '/:pathMatch(.*)*'`)
    expect(recordsIndex).toBeGreaterThanOrEqual(0)
    expect(catchAllIndex).toBeGreaterThanOrEqual(0)
    expect(recordsIndex).toBeLessThan(catchAllIndex)
  })
})

describe('attendanceRecordsRedirect.ts (shared source of truth)', () => {
  it('pins the exact path and redirect target', () => {
    expect(ATTENDANCE_RECORDS_PATH).toBe('/attendance/records')
    expect(ATTENDANCE_RECORDS_REDIRECT_TARGET).toEqual({ path: '/attendance', query: { tab: 'reports' } })
  })
})

describe('/attendance/records redirect behavior (isolated vue-router over the REAL shared module)', () => {
  // Confirms the *shape* actually resolves to the expected path+query under vue-router's
  // own redirect handling. Uses dummy components (not the real .vue views) to sidestep the
  // CSS transform issue above, but the redirect PATH and TARGET are imported from the real
  // attendanceRecordsRedirect.ts module — not copied — so a mutation to that module (or to
  // appRoutes.ts's usage of it) reds this describe block too, not just the source-text one.
  const Dummy = defineComponent({ render: () => h('div') })

  function buildRouter() {
    const routes: RouteRecordRaw[] = [
      { path: '/attendance', name: 'attendance', component: Dummy },
      { path: ATTENDANCE_RECORDS_PATH, name: 'attendance-records-redirect', redirect: ATTENDANCE_RECORDS_REDIRECT_TARGET },
      { path: '/:pathMatch(.*)*', name: 'not-found', redirect: '/' },
      { path: '/', name: 'home', component: Dummy },
    ]
    return createRouter({ history: createMemoryHistory(), routes })
  }

  it('resolves /attendance/records to /attendance?tab=reports', async () => {
    const router = buildRouter()
    await router.push(ATTENDANCE_RECORDS_PATH)
    expect(router.currentRoute.value.path).toBe('/attendance')
    expect(router.currentRoute.value.query).toEqual({ tab: 'reports' })
    expect(router.currentRoute.value.fullPath).toBe('/attendance?tab=reports')
  })

  it('does not fall through to the not-found catch-all', async () => {
    const router = buildRouter()
    await router.push(ATTENDANCE_RECORDS_PATH)
    expect(router.currentRoute.value.name).not.toBe('not-found')
    expect(router.currentRoute.value.path).not.toBe('/')
  })
})
