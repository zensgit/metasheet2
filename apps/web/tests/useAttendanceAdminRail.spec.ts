import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY,
  ADMIN_NAV_DEFAULT_STORAGE_SCOPE,
  ADMIN_NAV_FOCUS_MODE_STORAGE_KEY,
  ADMIN_NAV_LAST_SECTION_STORAGE_KEY,
  ADMIN_NAV_RECENTS_STORAGE_KEY,
  ATTENDANCE_ADMIN_SECTION_IDS,
  useAttendanceAdminRail,
} from '../src/views/attendance/useAttendanceAdminRail'

function scopedKey(baseKey: string, scope = ADMIN_NAV_DEFAULT_STORAGE_SCOPE): string {
  return `${baseKey}:${scope}`
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('useAttendanceAdminRail', () => {
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState({}, '', '/attendance?mode=admin')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })

  it('reloads scoped recents and collapsed groups when the org bucket changes', async () => {
    window.localStorage.setItem(
      scopedKey(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY, 'org-b'),
      JSON.stringify(['policies']),
    )
    window.localStorage.setItem(
      scopedKey(ADMIN_NAV_RECENTS_STORAGE_KEY, 'org-b'),
      JSON.stringify([
        ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles,
        ATTENDANCE_ADMIN_SECTION_IDS.importBatches,
      ]),
    )

    const scopeRef = ref<string | undefined>(undefined)
    const showAdmin = ref(true)
    const notices: string[] = []
    const scope = effectScope()
    const rail = scope.run(() =>
      useAttendanceAdminRail({
        tr: (en: string) => en,
        resolveStorageScope: () => scopeRef.value,
        showAdmin,
        notify: (message) => notices.push(message),
      }),
    )!

    await flushUi()
    expect(rail.adminNavStorageScope.value).toBe('default')

    scopeRef.value = 'org-b'
    await flushUi()

    expect(rail.adminNavStorageScope.value).toBe('org-b')
    expect(rail.visibleRecentAdminSectionNavItems.value.map(item => item.contextLabel)).toEqual([
      'Data & Payroll · Payroll Cycles',
      'Data & Payroll · Import batches',
    ])
    expect(rail.visibleAdminSectionNavGroups.value.find(group => group.id === 'policies')?.expanded).toBe(false)
    expect(rail.adminNavScopeFeedback.value).toContain('org-b')

    rail.adminActiveSectionId.value = ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles
    await flushUi()
    expect(window.localStorage.getItem(scopedKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY, 'org-b'))).toBe(
      ATTENDANCE_ADMIN_SECTION_IDS.payrollCycles,
    )

    scope.stop()
  })

  it('copies the current link and clears recent shortcuts with notifications', async () => {
    const showAdmin = ref(true)
    const notifications: Array<{ message: string; kind?: 'info' | 'error' }> = []
    const scope = effectScope()
    const rail = scope.run(() =>
      useAttendanceAdminRail({
        tr: (en: string) => en,
        resolveStorageScope: () => undefined,
        showAdmin,
        notify: (message, kind) => notifications.push({ message, kind }),
      }),
    )!

    rail.adminActiveSectionId.value = ATTENDANCE_ADMIN_SECTION_IDS.importBatches
    await flushUi()
    rail.adminActiveSectionId.value = ATTENDANCE_ADMIN_SECTION_IDS.approvalFlows
    await flushUi()

    await rail.copyCurrentAdminSectionLink()
    expect(navigator.clipboard?.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard!.writeText).mock.calls[0]?.[0]).toContain(
      '#attendance-admin-approval-flows',
    )
    expect(notifications.some(entry => entry.message.includes('Current admin section link copied.'))).toBe(true)

    rail.clearRecentAdminSections()
    await flushUi()
    expect(rail.visibleRecentAdminSectionNavItems.value).toEqual([])
    expect(window.localStorage.getItem(scopedKey(ADMIN_NAV_RECENTS_STORAGE_KEY))).toBe('[]')
    expect(notifications.some(entry => entry.message.includes('Recent admin shortcuts cleared.'))).toBe(true)

    scope.stop()
  })

  it('reloads and persists focused mode per org-scoped storage bucket', async () => {
    window.localStorage.setItem(
      scopedKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY, 'org-b'),
      JSON.stringify(false),
    )

    const scopeRef = ref<string | undefined>(undefined)
    const showAdmin = ref(true)
    const scope = effectScope()
    const rail = scope.run(() =>
      useAttendanceAdminRail({
        tr: (en: string) => en,
        resolveStorageScope: () => scopeRef.value,
        showAdmin,
        notify: () => undefined,
      }),
    )!

    await flushUi()
    expect(rail.adminFocusedMode.value).toBe(true)

    scopeRef.value = 'org-b'
    await flushUi()
    expect(rail.adminFocusedMode.value).toBe(false)

    rail.adminFocusedMode.value = true
    await flushUi()
    expect(window.localStorage.getItem(scopedKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY, 'org-b'))).toBe('true')

    scope.stop()
  })
})
