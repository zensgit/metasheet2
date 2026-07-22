// W4-2 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §5/§9 W4-2) — OD-W4-7② leave
// confirmation for IN-APP navigations. An applied-but-unsaved template prefill lives ONLY in
// AttendanceView's in-memory reactive forms. `beforeunload` (owned by AttendanceView) covers page
// unload/refresh, and in-host admin section switches lose nothing (v-show sections inside the same
// host) — but two in-app navigations unmount the host itself and would silently discard the
// prefill without ever firing beforeunload:
//   1. leaving the /attendance route entirely (vue-router navigation to another top-level view);
//   2. switching the attendance-shell top tab (AttendanceExperienceView swaps `component :is`,
//      which unmounts the admin host — including the admin↔import switch, whose differing
//      `key` also remounts).
// Both seams live in AttendanceExperienceView and consult this module-scoped signal before
// proceeding (lock OD-W4-7② "beforeunload/切区确认" — this is the 切区确认 leg). AttendanceView
// syncs the signal from its pending-prefill tracker and clears it on unmount (host gone ⇒ nothing
// left to protect; the reset also prevents a stale `true` from blocking navigation afterwards).
import { ref } from 'vue'

export type AttendanceSetupLeaveTranslateFn = (en: string, zh: string) => string

/** True while AttendanceView holds an applied-but-unsaved template prefill (either form). */
export const attendanceSetupPrefillPending = ref(false)

/**
 * Gate an in-app navigation that would unmount the AttendanceView host.
 * Returns true when navigation may proceed: no pending prefill, or the user explicitly confirmed
 * losing it. `confirmFn` is injectable for tests; production callers use the window.confirm
 * default. The message promises nothing about recovery — the prefill is gone once the host
 * unmounts (§5.2③ only saved resources are promised to persist).
 */
export function confirmAttendanceSetupPrefillLeave(
  tr: AttendanceSetupLeaveTranslateFn,
  confirmFn: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  if (!attendanceSetupPrefillPending.value) return true
  return confirmFn(
    tr(
      'A template prefill has been applied but not saved — leaving attendance discards it. Leave anyway?',
      '模板预填已应用但尚未保存——离开考勤页将丢失该预填。仍要离开吗？',
    ),
  )
}
