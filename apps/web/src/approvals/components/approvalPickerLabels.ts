// Label tables for the three shared approval pickers — report item O-8, slice F8-1 (approval
// member-surface locale). Same convention as views/approval/templateCenterLabels.ts (#5545): a flat
// `*_ZH` / `*_EN` object pair per component, `EN: Record<keyof typeof ZH, string>` so vue-tsc
// enforces key parity, consumed as `computed(() => (isZh.value ? ZH : EN))`.
//
// These pickers are rendered by the member surfaces (ApprovalNewView, ApprovalDetailView,
// MyDelegationView) and also by admin / authoring pages converted in later slices (F8-2 / F8-3).
// Until those land, an admin or authoring page in English shows these pickers in English while its
// own chrome is still Chinese — an accepted intermediate state, declared in the F8-1 note.

export const DEPARTMENT_PICKER_ZH = {
  modeGroupLabel: '部门选择方式',
  modeSearch: '搜索',
  modeBrowse: '浏览',
  browseUpLabel: '返回上级部门',
  browseUp: '返回上级',
  loading: '正在加载部门',
  empty: '暂无部门',
  browseChildren: '下级',
  defaultPlaceholder: '搜索并选择部门',
  defaultAriaLabel: '选择部门',
}

export const DEPARTMENT_PICKER_EN: Record<keyof typeof DEPARTMENT_PICKER_ZH, string> = {
  modeGroupLabel: 'Department selection mode',
  modeSearch: 'Search',
  modeBrowse: 'Browse',
  browseUpLabel: 'Back to the parent department',
  browseUp: 'Up one level',
  loading: 'Loading departments',
  empty: 'No departments',
  browseChildren: 'Sub-departments',
  defaultPlaceholder: 'Search and select a department',
  defaultAriaLabel: 'Select a department',
}

export const RECORD_LINK_PICKER_ZH = {
  title: '选择关联记录',
  searchPlaceholder: '搜索显示名称',
  loading: '加载中…',
  empty: '暂无可用记录',
  loadMore: '加载更多',
  cancel: '取消',
  confirm: '确认',
  errorTargetUnavailable: '目标表不可用',
  errorTargetForbidden: '目标表不可用或无权访问',
  errorLoadFailed: '加载失败，请稍后重试',
}

export const RECORD_LINK_PICKER_EN: Record<keyof typeof RECORD_LINK_PICKER_ZH, string> = {
  title: 'Select a linked record',
  searchPlaceholder: 'Search by display name',
  loading: 'Loading…',
  empty: 'No records available',
  loadMore: 'Load more',
  cancel: 'Cancel',
  confirm: 'Confirm',
  errorTargetUnavailable: 'The target table is unavailable',
  errorTargetForbidden: 'The target table is unavailable or you do not have access',
  errorLoadFailed: 'Loading failed. Please try again later.',
}

export const USER_PICKER_ZH = {
  defaultPlaceholder: '搜索用户名 / 邮箱 / ID',
  // Test report 2026-10-08 (T4b / T4cd): what a member id renders as when no display name can be
  // resolved for it (inactive or nameless account, or a lookup still in flight) — never the id.
  unknownUser: '未知用户',
}

export const USER_PICKER_EN: Record<keyof typeof USER_PICKER_ZH, string> = {
  defaultPlaceholder: 'Search by name / email / ID',
  unknownUser: 'Unknown user',
}

/** The values-free label for a member id with no resolvable display name, in the shell locale. */
export function unknownUserLabel(isZh: boolean): string {
  return (isZh ? USER_PICKER_ZH : USER_PICKER_EN).unknownUser
}
