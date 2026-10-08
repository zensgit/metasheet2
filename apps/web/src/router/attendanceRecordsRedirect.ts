/**
 * `/attendance/records` had no declared route (it fell through the `/:pathMatch(.*)*`
 * catch-all to `/`). This is the single source of truth for its target, imported by both
 * `appRoutes.ts` (the real route declaration) and its behavior spec
 * (`tests/attendance-records-route-redirect.spec.ts`, which builds an isolated router over
 * THIS constant — not a hand-copied literal — so a change here or in `appRoutes.ts` alone
 * can't silently drift the two apart; GATE-5047 P3-1).
 *
 * The target tab query key/value ('tab' / 'reports') is the real one: confirmed against
 * AttendanceExperienceView.vue's normalizeTab()/availableTabs(), not guessed.
 */
export const ATTENDANCE_RECORDS_PATH = '/attendance/records'

export const ATTENDANCE_RECORDS_REDIRECT_TARGET = {
  path: '/attendance',
  query: { tab: 'reports' },
} as const
