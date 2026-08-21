// Navigability audit fix 1 (2026-08-22): AttendanceExperienceView.vue's `activeView === null`
// fallback ("Capability not available") previously rendered a bare heading with no reason, no
// retry, and no way back — and never mentioned that the gating feature flag can be turned on
// locally via the existing, already-sanctioned `isFeatureOverrideAllowed()` override path
// (src/stores/featureFlags.ts). This module is the pure tab -> gating-flag -> display-name
// lookup the enriched empty state renders from; kept out of the `<script setup>` SFC because a
// Vue SFC's `<script setup>` block cannot export a plain function for direct unit testing.
//
// Reachability note (see PR body): `AttendanceExperienceView.vue`'s own `ensureTabAllowed()` /
// `watch(availableTabs, …)` safety net normalizes `activeTab` back to `overview` before a tab
// whose gating flag is off can ever be reactively rendered, in every path this module's tests and
// `attendance-experience-entrypoints.spec.ts` can drive. This lookup make the fallback's CONTENT
// correct and complete for the tabs that COULD reach it (defensive hardening for that invariant
// ever breaking, or for less-guarded embeddings this audit did not enumerate) — it does not itself
// change when the fallback is reached.

/** The three tabs whose `activeView` case can resolve to `null` when their gating flag is off.
 *  `overview`/`reports` are never gated and never reach this branch. */
export type AttendanceUnavailableCapabilityTab = 'admin' | 'import' | 'workflow'

/** The two ProductFeatures flags that gate the three tabs above (`import` shares `admin`'s gate —
 *  see AttendanceExperienceView.vue's `activeView` computed, `case 'import': if
 *  (!canAccessAdmin.value) return null`, which reads `attendanceAdmin`, not a separate
 *  `attendanceImport` flag — that flag exists in ProductFeatures but nothing gates on it). */
export type AttendanceUnavailableCapabilityFlag = 'attendanceAdmin' | 'workflow'

export interface AttendanceCapabilityInfo {
  tab: AttendanceUnavailableCapabilityTab
  flagKey: AttendanceUnavailableCapabilityFlag
  nameEn: string
  nameZh: string
}

const ATTENDANCE_CAPABILITY_BY_TAB: Record<AttendanceUnavailableCapabilityTab, AttendanceCapabilityInfo> = {
  admin: { tab: 'admin', flagKey: 'attendanceAdmin', nameEn: 'Admin Center', nameZh: '管理中心' },
  import: { tab: 'import', flagKey: 'attendanceAdmin', nameEn: 'Import', nameZh: '导入' },
  workflow: { tab: 'workflow', flagKey: 'workflow', nameEn: 'Workflow Designer', nameZh: '流程设计' },
}

function isUnavailableCapabilityTab(value: unknown): value is AttendanceUnavailableCapabilityTab {
  return value === 'admin' || value === 'import' || value === 'workflow'
}

/** Returns the capability metadata for the given tab id, or `null` when the tab is not one of
 *  the three gated tabs (i.e. it never reaches the `activeView === null` fallback). */
export function resolveAttendanceCapabilityInfo(tab: unknown): AttendanceCapabilityInfo | null {
  if (!isUnavailableCapabilityTab(tab)) return null
  return ATTENDANCE_CAPABILITY_BY_TAB[tab]
}

export interface AttendanceCapabilityUnavailableCopy {
  heading: string
  detail: string
}

/** Values-free (no user/org identifiers — only the closed-set capability name) explanatory copy
 *  for the empty state. `isZh` selects the locale, matching every other inline `t.value` bilingual
 *  table in this component tree. */
export function buildAttendanceCapabilityUnavailableCopy(
  info: AttendanceCapabilityInfo,
  isZh: boolean,
): AttendanceCapabilityUnavailableCopy {
  const name = isZh ? info.nameZh : info.nameEn
  return isZh
    ? {
        heading: `${name}当前不可用`,
        detail: `此账号 / 当前会话未启用「${name}」所需的能力。`,
      }
    : {
        heading: `${name} is not available`,
        detail: `The "${name}" capability is not enabled for this account or session.`,
      }
}
