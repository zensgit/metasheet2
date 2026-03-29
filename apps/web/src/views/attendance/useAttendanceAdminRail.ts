import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'

export type TranslateFn = (en: string, zh: string) => string

export const ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY = 'metasheet_attendance_admin_nav_collapsed_groups'
export const ADMIN_NAV_RECENTS_STORAGE_KEY = 'metasheet_attendance_admin_nav_recent_sections'
export const ADMIN_NAV_LAST_SECTION_STORAGE_KEY = 'metasheet_attendance_admin_nav_last_section'
export const ADMIN_NAV_DEFAULT_STORAGE_SCOPE = 'default'
const ADMIN_NAV_RECENT_LIMIT = 5

export const ATTENDANCE_ADMIN_SECTION_IDS = {
  settings: 'attendance-admin-settings',
  userAccess: 'attendance-admin-user-access',
  batchProvisioning: 'attendance-admin-batch-provisioning',
  auditLogs: 'attendance-admin-audit-logs',
  holidaySync: 'attendance-admin-holiday-sync',
  defaultRule: 'attendance-admin-default-rule',
  ruleSets: 'attendance-admin-rule-sets',
  ruleTemplateLibrary: 'attendance-admin-rule-template-library',
  attendanceGroups: 'attendance-admin-groups',
  groupMembers: 'attendance-admin-group-members',
  import: 'attendance-admin-import',
  importBatches: 'attendance-admin-import-batches',
  payrollTemplates: 'attendance-admin-payroll-templates',
  payrollCycles: 'attendance-admin-payroll-cycles',
  leaveTypes: 'attendance-admin-leave-types',
  overtimeRules: 'attendance-admin-overtime-rules',
  approvalFlows: 'attendance-admin-approval-flows',
  rotationRules: 'attendance-admin-rotation-rules',
  rotationAssignments: 'attendance-admin-rotation-assignments',
  shifts: 'attendance-admin-shifts',
  assignments: 'attendance-admin-assignments',
  holidays: 'attendance-admin-holidays',
} as const

export type AdminSectionNavItem = {
  id: string
  label: string
}

export type AdminSectionNavDisplayItem = AdminSectionNavItem & {
  groupLabel: string | null
  contextLabel: string
}

type AdminSectionNavGroupDefinition = {
  id: string
  label: string
  itemIds: string[]
}

export type AdminSectionNavGroup = {
  id: string
  label: string
  countLabel: string
  expanded: boolean
  items: AdminSectionNavItem[]
}

type NotifyFn = (message: string, kind?: 'info' | 'error') => void

type UseAttendanceAdminRailOptions = {
  tr: TranslateFn
  resolveStorageScope: () => string | undefined
  showAdmin: Readonly<Ref<boolean> | ComputedRef<boolean>>
  notify: NotifyFn
}

function resolveAdminNavStorageKey(baseKey: string, scope: string): string {
  const normalizedScope = scope.trim().length > 0 ? scope.trim() : ADMIN_NAV_DEFAULT_STORAGE_SCOPE
  return `${baseKey}:${normalizedScope}`
}

function loadAdminNavCollapsedGroups(scope: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(resolveAdminNavStorageKey(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY, scope))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function persistAdminNavCollapsedGroups(scope: string, groupIds: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(resolveAdminNavStorageKey(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY, scope), JSON.stringify(groupIds))
  } catch {
    // ignore storage write failures (private mode, quota).
  }
}

function loadAdminNavRecentSections(scope: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(resolveAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY, scope))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function persistAdminNavRecentSections(scope: string, sectionIds: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(resolveAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY, scope), JSON.stringify(sectionIds))
  } catch {
    // ignore storage write failures (private mode, quota).
  }
}

function readLastAdminSection(scope: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(resolveAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY, scope))
    return raw && raw.trim().length > 0 ? raw.trim() : null
  } catch {
    return null
  }
}

function persistLastAdminSection(scope: string, id: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(resolveAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY, scope), id)
  } catch {
    // ignore storage write failures (private mode, quota).
  }
}

export function useAttendanceAdminRail({
  tr,
  resolveStorageScope,
  showAdmin,
  notify,
}: UseAttendanceAdminRailOptions) {
  const adminSectionNavItems = computed<AdminSectionNavItem[]>(() => [
    { id: ATTENDANCE_ADMIN_SECTION_IDS.settings, label: tr('Settings', '设置') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.userAccess, label: tr('User Access', '用户权限') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.batchProvisioning, label: tr('Batch Provisioning', '批量授权') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.auditLogs, label: tr('Audit Logs', '审计日志') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.holidaySync, label: tr('Holiday Sync', '节假日同步') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.defaultRule, label: tr('Default Rule', '默认规则') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.ruleSets, label: tr('Rule Sets', '规则集') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.ruleTemplateLibrary, label: tr('Rule Template Library', '规则模板库') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.attendanceGroups, label: tr('Attendance groups', '考勤组') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.groupMembers, label: tr('Group members', '分组成员') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.import, label: tr('Import', '导入') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.importBatches, label: tr('Import batches', '导入批次') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.payrollTemplates, label: tr('Payroll Templates', '计薪模板') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles, label: tr('Payroll Cycles', '计薪周期') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.leaveTypes, label: tr('Leave Types', '请假类型') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.overtimeRules, label: tr('Overtime Rules', '加班规则') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.approvalFlows, label: tr('Approval Flows', '审批流') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.rotationRules, label: tr('Rotation Rules', '轮班规则') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.rotationAssignments, label: tr('Rotation Assignments', '轮班分配') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.shifts, label: tr('Shifts', '班次') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.assignments, label: tr('Assignments', '排班分配') },
    { id: ATTENDANCE_ADMIN_SECTION_IDS.holidays, label: tr('Holidays', '节假日') },
  ])
  const adminSectionItemMap = computed(() => new Map(adminSectionNavItems.value.map(item => [item.id, item])))
  const adminSectionNavGroups = computed<AdminSectionNavGroupDefinition[]>(() => [
    {
      id: 'workspace',
      label: tr('Workspace', '工作台'),
      itemIds: [
        ATTENDANCE_ADMIN_SECTION_IDS.settings,
        ATTENDANCE_ADMIN_SECTION_IDS.userAccess,
        ATTENDANCE_ADMIN_SECTION_IDS.batchProvisioning,
        ATTENDANCE_ADMIN_SECTION_IDS.auditLogs,
      ],
    },
    {
      id: 'scheduling',
      label: tr('Scheduling', '排班执行'),
      itemIds: [
        ATTENDANCE_ADMIN_SECTION_IDS.rotationRules,
        ATTENDANCE_ADMIN_SECTION_IDS.rotationAssignments,
        ATTENDANCE_ADMIN_SECTION_IDS.shifts,
        ATTENDANCE_ADMIN_SECTION_IDS.assignments,
        ATTENDANCE_ADMIN_SECTION_IDS.holidays,
      ],
    },
    {
      id: 'organization',
      label: tr('Organization', '组织分组'),
      itemIds: [
        ATTENDANCE_ADMIN_SECTION_IDS.attendanceGroups,
        ATTENDANCE_ADMIN_SECTION_IDS.groupMembers,
      ],
    },
    {
      id: 'policies',
      label: tr('Policies', '规则策略'),
      itemIds: [
        ATTENDANCE_ADMIN_SECTION_IDS.holidaySync,
        ATTENDANCE_ADMIN_SECTION_IDS.defaultRule,
        ATTENDANCE_ADMIN_SECTION_IDS.ruleSets,
        ATTENDANCE_ADMIN_SECTION_IDS.ruleTemplateLibrary,
        ATTENDANCE_ADMIN_SECTION_IDS.leaveTypes,
        ATTENDANCE_ADMIN_SECTION_IDS.overtimeRules,
        ATTENDANCE_ADMIN_SECTION_IDS.approvalFlows,
      ],
    },
    {
      id: 'data-payroll',
      label: tr('Data & Payroll', '数据与计薪'),
      itemIds: [
        ATTENDANCE_ADMIN_SECTION_IDS.import,
        ATTENDANCE_ADMIN_SECTION_IDS.importBatches,
        ATTENDANCE_ADMIN_SECTION_IDS.payrollTemplates,
        ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles,
      ],
    },
  ])
  const adminSectionGroupLabelByItemId = computed(() => {
    const groupLabels = new Map<string, string>()
    for (const group of adminSectionNavGroups.value) {
      for (const itemId of group.itemIds) {
        groupLabels.set(itemId, group.label)
      }
    }
    return groupLabels
  })

  const adminSectionFilter = ref('')
  const adminSectionFilterQuery = computed(() => adminSectionFilter.value.trim().toLowerCase())
  const adminSectionFilterActive = computed(() => adminSectionFilterQuery.value.length > 0)
  const adminNavStorageScope = computed(() => resolveStorageScope() ?? ADMIN_NAV_DEFAULT_STORAGE_SCOPE)
  const adminCollapsedGroupIds = ref<string[]>(loadAdminNavCollapsedGroups(adminNavStorageScope.value))
  const adminRecentSectionIds = ref<string[]>(loadAdminNavRecentSections(adminNavStorageScope.value))
  const isCompactAdminNav = ref(false)
  const adminCompactNavOpen = ref(false)
  const adminActiveSectionId = ref<string>(ATTENDANCE_ADMIN_SECTION_IDS.settings)
  const adminNavScopeFeedback = ref('')
  let adminNavScopeFeedbackTimer: ReturnType<typeof setTimeout> | null = null

  const knownAdminSectionIds = computed(() => adminSectionNavItems.value.map(item => item.id))
  const knownAdminSectionGroupIds = computed(() => adminSectionNavGroups.value.map(group => group.id))

  function isKnownAdminSectionId(id: string | null | undefined): id is string {
    if (!id) return false
    return adminSectionNavItems.value.some(item => item.id === id)
  }

  function formatAdminSectionContextLabel(item: AdminSectionNavItem | undefined | null): string {
    if (!item) return tr('Sections', '区块')
    const groupLabel = adminSectionGroupLabelByItemId.value.get(item.id)
    if (!groupLabel || groupLabel === item.label) return item.label
    return `${groupLabel} · ${item.label}`
  }

  function isAdminSectionGroupExpanded(groupId: string, items: AdminSectionNavItem[]): boolean {
    if (adminSectionFilterActive.value) return true
    if (items.some(item => item.id === adminActiveSectionId.value)) return true
    return !adminCollapsedGroupIds.value.includes(groupId)
  }

  function toggleAdminSectionGroup(groupId: string): void {
    if (adminSectionFilterActive.value) return
    if (adminCollapsedGroupIds.value.includes(groupId)) {
      adminCollapsedGroupIds.value = adminCollapsedGroupIds.value.filter(id => id !== groupId)
      return
    }
    adminCollapsedGroupIds.value = [...adminCollapsedGroupIds.value, groupId]
  }

  function expandAllAdminSectionGroups(): void {
    adminCollapsedGroupIds.value = []
  }

  function collapseAllAdminSectionGroups(): void {
    adminCollapsedGroupIds.value = adminSectionNavGroups.value.map(group => group.id)
  }

  function buildCurrentAdminSectionLink(): string | null {
    if (typeof window === 'undefined' || !isKnownAdminSectionId(adminActiveSectionId.value)) return null
    const { origin, pathname, search } = window.location
    return `${origin}${pathname}${search}#${adminActiveSectionId.value}`
  }

  function trackRecentAdminSection(id: string): void {
    if (!isKnownAdminSectionId(id)) return
    const nextIds = [id, ...adminRecentSectionIds.value.filter(candidate => candidate !== id)].slice(0, ADMIN_NAV_RECENT_LIMIT)
    if (nextIds.length === adminRecentSectionIds.value.length && nextIds.every((candidate, index) => candidate === adminRecentSectionIds.value[index])) {
      return
    }
    adminRecentSectionIds.value = nextIds
  }

  function clearAdminNavScopeFeedbackTimer(): void {
    if (adminNavScopeFeedbackTimer) {
      clearTimeout(adminNavScopeFeedbackTimer)
      adminNavScopeFeedbackTimer = null
    }
  }

  function setAdminNavScopeFeedback(scope: string): void {
    adminNavScopeFeedback.value = scope === ADMIN_NAV_DEFAULT_STORAGE_SCOPE
      ? tr('Switched to default navigation memory.', '已切换到默认导航记忆。')
      : tr(`Switched to navigation memory for ${scope}.`, `已切换到 ${scope} 的导航记忆。`)
    clearAdminNavScopeFeedbackTimer()
    adminNavScopeFeedbackTimer = setTimeout(() => {
      adminNavScopeFeedback.value = ''
      adminNavScopeFeedbackTimer = null
    }, 3200)
  }

  function clearRecentAdminSections(): void {
    if (adminRecentSectionIds.value.length === 0) return
    adminRecentSectionIds.value = []
    notify(tr('Recent admin shortcuts cleared.', '已清空最近访问快捷入口。'))
  }

  async function copyCurrentAdminSectionLink(): Promise<void> {
    const link = buildCurrentAdminSectionLink()
    if (!link) {
      notify(tr('No admin section is active yet.', '当前还没有激活的管理区块。'), 'error')
      return
    }
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable')
      }
      await navigator.clipboard.writeText(link)
      notify(tr('Current admin section link copied.', '当前管理区块链接已复制。'))
    } catch {
      notify(tr('Failed to copy current admin section link.', '复制当前管理区块链接失败。'), 'error')
    }
  }

  const visibleAdminSectionNavGroups = computed<AdminSectionNavGroup[]>(() => {
    const query = adminSectionFilterQuery.value
    const groups = adminSectionNavGroups.value
      .map(group => {
        const allItems = group.itemIds
          .map(id => adminSectionItemMap.value.get(id))
          .filter((item): item is AdminSectionNavItem => Boolean(item))
        const items = query
          ? allItems.filter(item => item.label.toLowerCase().includes(query))
          : allItems
        if (items.length === 0) return null
        const countLabel = query && items.length !== allItems.length
          ? `${items.length}/${allItems.length}`
          : `${allItems.length}`
        return {
          id: group.id,
          label: group.label,
          items,
          countLabel,
          expanded: isAdminSectionGroupExpanded(group.id, items),
        }
      })
      .filter((group): group is AdminSectionNavGroup => Boolean(group))
    if (!isCompactAdminNav.value || query) return groups
    const activeIndex = groups.findIndex(group => group.items.some(item => item.id === adminActiveSectionId.value))
    if (activeIndex <= 0) return groups
    const activeGroup = groups[activeIndex]
    return [activeGroup, ...groups.slice(0, activeIndex), ...groups.slice(activeIndex + 1)]
  })

  const visibleAdminSectionNavItems = computed(() => visibleAdminSectionNavGroups.value.flatMap(group => group.items))
  const orderedAdminSectionNavItems = computed<AdminSectionNavDisplayItem[]>(() => {
    return adminSectionNavGroups.value.flatMap(group => {
      return group.itemIds
        .map(id => adminSectionItemMap.value.get(id))
        .filter((item): item is AdminSectionNavItem => Boolean(item))
        .map(item => {
          const groupLabel = adminSectionGroupLabelByItemId.value.get(item.id) ?? null
          const contextLabel = formatAdminSectionContextLabel(item)
          return {
            ...item,
            groupLabel,
            contextLabel,
          }
        })
    })
  })
  const visibleRecentAdminSectionNavItems = computed<AdminSectionNavDisplayItem[]>(() => {
    const query = adminSectionFilterQuery.value
    return adminRecentSectionIds.value
      .map(id => adminSectionItemMap.value.get(id))
      .filter((item): item is AdminSectionNavItem => Boolean(item))
      .map(item => {
        const groupLabel = adminSectionGroupLabelByItemId.value.get(item.id) ?? null
        const contextLabel = formatAdminSectionContextLabel(item)
        return {
          ...item,
          groupLabel,
          contextLabel,
        }
      })
      .filter(item => !query || item.contextLabel.toLowerCase().includes(query))
  })
  const activeAdminSectionContextLabel = computed(() => {
    const activeItem = adminSectionItemMap.value.get(adminActiveSectionId.value)
    return formatAdminSectionContextLabel(activeItem)
  })
  const activeAdminSectionOrderedIndex = computed(() => {
    return orderedAdminSectionNavItems.value.findIndex(item => item.id === adminActiveSectionId.value)
  })
  const previousAdminSectionNavItem = computed<AdminSectionNavDisplayItem | null>(() => {
    const activeIndex = activeAdminSectionOrderedIndex.value
    if (activeIndex <= 0) return null
    return orderedAdminSectionNavItems.value[activeIndex - 1] ?? null
  })
  const nextAdminSectionNavItem = computed<AdminSectionNavDisplayItem | null>(() => {
    const activeIndex = activeAdminSectionOrderedIndex.value
    if (activeIndex < 0 || activeIndex >= orderedAdminSectionNavItems.value.length - 1) return null
    return orderedAdminSectionNavItems.value[activeIndex + 1] ?? null
  })
  const allAdminSectionGroupsExpanded = computed(() => adminCollapsedGroupIds.value.length === 0)
  const allAdminSectionGroupsCollapsed = computed(() => {
    const allGroupIds = knownAdminSectionGroupIds.value
    return allGroupIds.length > 0 && allGroupIds.every(id => adminCollapsedGroupIds.value.includes(id))
  })
  const adminSectionNavCountLabel = computed(() => {
    const visible = visibleAdminSectionNavItems.value.length
    const total = adminSectionNavItems.value.length
    if (!adminSectionFilterQuery.value || visible === total) {
      return `${total} ${tr('items', '项')}`
    }
    return `${visible}/${total} ${tr('items', '项')}`
  })

  watch(adminActiveSectionId, id => {
    if (!showAdmin.value || !isKnownAdminSectionId(id)) return
    trackRecentAdminSection(id)
    persistLastAdminSection(adminNavStorageScope.value, id)
  })

  watch(knownAdminSectionGroupIds, groupIds => {
    const known = new Set(groupIds)
    const nextIds = Array.from(new Set(adminCollapsedGroupIds.value.filter(id => known.has(id))))
    if (nextIds.length !== adminCollapsedGroupIds.value.length || nextIds.some((id, index) => id !== adminCollapsedGroupIds.value[index])) {
      adminCollapsedGroupIds.value = nextIds
    }
  }, { immediate: true })

  watch(adminCollapsedGroupIds, groupIds => {
    persistAdminNavCollapsedGroups(adminNavStorageScope.value, Array.from(new Set(groupIds)))
  })

  watch(knownAdminSectionIds, sectionIds => {
    const known = new Set(sectionIds)
    const nextIds = Array.from(new Set(adminRecentSectionIds.value.filter(id => known.has(id)))).slice(0, ADMIN_NAV_RECENT_LIMIT)
    if (nextIds.length !== adminRecentSectionIds.value.length || nextIds.some((id, index) => id !== adminRecentSectionIds.value[index])) {
      adminRecentSectionIds.value = nextIds
    }
  }, { immediate: true })

  watch(adminRecentSectionIds, sectionIds => {
    persistAdminNavRecentSections(adminNavStorageScope.value, Array.from(new Set(sectionIds)).slice(0, ADMIN_NAV_RECENT_LIMIT))
  })

  watch(adminNavStorageScope, (scope, previousScope) => {
    if (scope === previousScope) return
    adminCollapsedGroupIds.value = loadAdminNavCollapsedGroups(scope)
    adminRecentSectionIds.value = loadAdminNavRecentSections(scope)
    if (previousScope !== undefined) {
      setAdminNavScopeFeedback(scope)
    }
  })

  onScopeDispose(() => {
    clearAdminNavScopeFeedbackTimer()
  })

  return {
    adminActiveSectionId,
    adminCompactNavOpen,
    adminNavDefaultStorageScope: ADMIN_NAV_DEFAULT_STORAGE_SCOPE,
    adminNavScopeFeedback,
    adminNavStorageScope,
    adminSectionFilter,
    adminSectionFilterActive,
    adminSectionNavCountLabel,
    adminSectionNavItems,
    allAdminSectionGroupsCollapsed,
    allAdminSectionGroupsExpanded,
    activeAdminSectionContextLabel,
    clearRecentAdminSections,
    copyCurrentAdminSectionLink,
    expandAllAdminSectionGroups,
    isCompactAdminNav,
    isKnownAdminSectionId,
    nextAdminSectionNavItem,
    orderedAdminSectionNavItems,
    previousAdminSectionNavItem,
    readLastAdminSection,
    collapseAllAdminSectionGroups,
    toggleAdminSectionGroup,
    visibleAdminSectionNavGroups,
    visibleRecentAdminSectionNavItems,
  }
}
