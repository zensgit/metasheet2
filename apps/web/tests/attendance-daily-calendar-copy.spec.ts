import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS } from '../src/views/attendance/attendanceEmployeeWorkspaceCommonIcons'
import AttendanceSettingsSection from '../src/views/attendance/AttendanceSettingsSection.vue'

describe('auto-absence daily calendar disclosure', () => {
  it('shows the org-default timezone contract at the existing settings time field', async () => {
    const container = document.createElement('div')
    const app = createApp(AttendanceSettingsSection, {
      tr: (_en: string, zh: string) => zh,
      settings: {
        saveSettings: () => {}, settingsLoading: ref(false),
        settingsForm: {
          autoAbsenceEnabled: false, autoAbsenceRunAt: '00:15', autoAbsenceLookbackDays: 1,
          ipAllowlist: '', geoFenceLat: '', geoFenceLng: '', geoFenceRadius: '', minPunchIntervalMinutes: 0,
          employeeQuickActionIcons: { ...DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS },
        },
      },
    })
    try {
      app.mount(container)
      await nextTick()
      expect(container.querySelector('label[for="attendance-auto-absence-run-at"]')?.textContent).toContain('按各组织默认考勤时区执行。')
      expect(container.querySelector('[name="autoAbsenceTimezone"]')).toBeNull()
    } finally { app.unmount() }
  })
  it('also discloses the same contract at the existing inline settings entry', () => {
    const source = readFileSync(resolve(__dirname, '../src/views/AttendanceView.vue'), 'utf8')
    const field = source.slice(source.indexOf('for="attendance-auto-absence-run-at"'))
    expect(field.slice(0, field.indexOf('</label>'))).toContain("tr('Runs in each organization’s default attendance timezone.', '按各组织默认考勤时区执行。')")
  })
})
