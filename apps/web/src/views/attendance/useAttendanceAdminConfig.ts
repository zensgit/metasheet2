import { reactive, ref, type Ref } from 'vue'

type Translate = (en: string, zh: string) => string
type SetStatusFn = (message: string, kind?: 'info' | 'error') => void
type AdminConfigStatusContext = 'admin' | 'save-settings' | 'sync-holidays' | 'save-rule'
type SetStatusFromErrorFn = (error: unknown, fallbackMessage: string, context: AdminConfigStatusContext) => void
type ApiFetchWithTimeoutFn = (path: string, options?: RequestInit) => Promise<Response>
type BuildQueryFn = (params: Record<string, string | undefined>) => URLSearchParams
type GetOrgIdFn = () => string | undefined
type CreateApiErrorFn = (response: { status: number }, payload: unknown, fallbackMessage: string) => Error
type CreateForbiddenErrorFn = (message?: string) => Error

interface HolidayPolicyOverride {
  name: string
  match?: 'contains' | 'regex' | 'equals'
  attendanceGroups?: string[]
  roles?: string[]
  roleTags?: string[]
  userIds?: string[]
  userNames?: string[]
  excludeUserIds?: string[]
  excludeUserNames?: string[]
  dayIndexStart?: number
  dayIndexEnd?: number
  dayIndexList?: number[]
  firstDayEnabled?: boolean
  firstDayBaseHours?: number
  overtimeAdds?: boolean
  overtimeSource?: 'approval' | 'clock' | 'both'
}

interface AttendanceSettings {
  autoAbsence?: {
    enabled?: boolean
    runAt?: string
    lookbackDays?: number
  }
  holidayPolicy?: {
    firstDayEnabled?: boolean
    firstDayBaseHours?: number
    overtimeAdds?: boolean
    overtimeSource?: 'approval' | 'clock' | 'both'
    overrides?: HolidayPolicyOverride[]
  }
  holidaySync?: {
    source?: 'holiday-cn'
    baseUrl?: string
    years?: number[]
    addDayIndex?: boolean
    dayIndexHolidays?: string[]
    dayIndexMaxDays?: number
    dayIndexFormat?: 'name-1' | 'name第1天' | 'name DAY1'
    overwrite?: boolean
    auto?: {
      enabled?: boolean
      runAt?: string
      timezone?: string
    }
    lastRun?: HolidaySyncLastRun | null
  }
  ipAllowlist?: string[]
  geoFence?: {
    lat: number
    lng: number
    radiusMeters: number
  } | null
  minPunchIntervalMinutes?: number
}

interface AttendanceRule {
  id?: string
  orgId?: string
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: number[]
  isDefault?: boolean
}

interface HolidayPolicyOverrideForm {
  name: string
  match: 'contains' | 'regex' | 'equals'
  attendanceGroups?: string
  roles?: string
  roleTags?: string
  userIds?: string
  userNames?: string
  excludeUserIds?: string
  excludeUserNames?: string
  dayIndexStart?: number | null
  dayIndexEnd?: number | null
  dayIndexList?: string
  firstDayEnabled?: boolean
  firstDayBaseHours?: number
  overtimeAdds?: boolean
  overtimeSource?: 'approval' | 'clock' | 'both'
}

interface HolidaySyncLastRun {
  ranAt?: string | null
  success?: boolean | null
  years?: number[] | null
  totalFetched?: number | null
  totalApplied?: number | null
  error?: string | null
}

interface UseAttendanceAdminConfigOptions {
  adminForbidden: Ref<boolean>
  apiFetchWithTimeout: ApiFetchWithTimeoutFn
  buildQuery: BuildQueryFn
  createApiError: CreateApiErrorFn
  createForbiddenError: CreateForbiddenErrorFn
  defaultTimezone: string
  getOrgId: GetOrgIdFn
  setStatus: SetStatusFn
  setStatusFromError: SetStatusFromErrorFn
  tr: Translate
}

function listToText(list?: Array<string | number>): string {
  return Array.isArray(list) ? list.join(',') : ''
}

function splitListText(value?: string): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitNumberList(value?: string): number[] {
  if (!value) return []
  return value
    .split(/[\n,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : undefined
}

function parseWorkingDaysInput(value: string): number[] {
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
}

export function useAttendanceAdminConfig({
  adminForbidden,
  apiFetchWithTimeout,
  buildQuery,
  createApiError,
  createForbiddenError,
  defaultTimezone,
  getOrgId,
  setStatus,
  setStatusFromError,
  tr,
}: UseAttendanceAdminConfigOptions) {
  const settingsLoading = ref(false)
  const holidaySyncLoading = ref(false)
  const holidaySyncLastRun = ref<HolidaySyncLastRun | null>(null)
  const ruleLoading = ref(false)

  const settingsForm = reactive({
    autoAbsenceEnabled: false,
    autoAbsenceRunAt: '00:15',
    autoAbsenceLookbackDays: 1,
    holidayFirstDayEnabled: true,
    holidayFirstDayBaseHours: 8,
    holidayOvertimeAdds: true,
    holidayOvertimeSource: 'approval' as 'approval' | 'clock' | 'both',
    holidayOverrides: [] as HolidayPolicyOverrideForm[],
    holidaySyncBaseUrl: 'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
    holidaySyncYears: '',
    holidaySyncAddDayIndex: true,
    holidaySyncDayIndexHolidays: '春节,国庆',
    holidaySyncDayIndexMaxDays: 7,
    holidaySyncDayIndexFormat: 'name-1' as 'name-1' | 'name第1天' | 'name DAY1',
    holidaySyncOverwrite: false,
    holidaySyncAutoEnabled: false,
    holidaySyncAutoRunAt: '02:00',
    holidaySyncAutoTimezone: 'UTC',
    ipAllowlist: '',
    geoFenceLat: '',
    geoFenceLng: '',
    geoFenceRadius: '',
    minPunchIntervalMinutes: 1,
  })

  const ruleForm = reactive({
    name: 'Default',
    timezone: defaultTimezone,
    workStartTime: '09:00',
    workEndTime: '18:00',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    roundingMinutes: 5,
    workingDays: '1,2,3,4,5',
  })

  function applySettingsToForm(settings: AttendanceSettings) {
    settingsForm.autoAbsenceEnabled = Boolean(settings.autoAbsence?.enabled)
    settingsForm.autoAbsenceRunAt = settings.autoAbsence?.runAt || '00:15'
    settingsForm.autoAbsenceLookbackDays = settings.autoAbsence?.lookbackDays || 1
    settingsForm.holidayFirstDayEnabled = settings.holidayPolicy?.firstDayEnabled ?? true
    settingsForm.holidayFirstDayBaseHours = settings.holidayPolicy?.firstDayBaseHours ?? 8
    settingsForm.holidayOvertimeAdds = settings.holidayPolicy?.overtimeAdds ?? true
    settingsForm.holidayOvertimeSource = settings.holidayPolicy?.overtimeSource ?? 'approval'
    settingsForm.holidayOverrides = Array.isArray(settings.holidayPolicy?.overrides)
      ? settings.holidayPolicy.overrides.map((override) => {
          const overrideSource = override.overtimeSource === 'approval'
            || override.overtimeSource === 'clock'
            || override.overtimeSource === 'both'
            ? override.overtimeSource
            : settingsForm.holidayOvertimeSource
          return {
            name: override.name || '',
            match: override.match ?? 'contains',
            attendanceGroups: listToText(override.attendanceGroups),
            roles: listToText(override.roles),
            roleTags: listToText(override.roleTags),
            userIds: listToText(override.userIds),
            userNames: listToText(override.userNames),
            excludeUserIds: listToText(override.excludeUserIds),
            excludeUserNames: listToText(override.excludeUserNames),
            dayIndexStart: override.dayIndexStart ?? null,
            dayIndexEnd: override.dayIndexEnd ?? null,
            dayIndexList: listToText(override.dayIndexList),
            firstDayEnabled: override.firstDayEnabled ?? settingsForm.holidayFirstDayEnabled,
            firstDayBaseHours: override.firstDayBaseHours ?? settingsForm.holidayFirstDayBaseHours,
            overtimeAdds: override.overtimeAdds ?? settingsForm.holidayOvertimeAdds,
            overtimeSource: overrideSource,
          }
        })
      : []
    settingsForm.holidaySyncBaseUrl = settings.holidaySync?.baseUrl
      || 'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master'
    settingsForm.holidaySyncYears = Array.isArray(settings.holidaySync?.years)
      ? settings.holidaySync.years.join(',')
      : ''
    settingsForm.holidaySyncAddDayIndex = settings.holidaySync?.addDayIndex ?? true
    settingsForm.holidaySyncDayIndexHolidays = Array.isArray(settings.holidaySync?.dayIndexHolidays)
      ? settings.holidaySync.dayIndexHolidays.join(',')
      : '春节,国庆'
    settingsForm.holidaySyncDayIndexMaxDays = settings.holidaySync?.dayIndexMaxDays ?? 7
    settingsForm.holidaySyncDayIndexFormat = settings.holidaySync?.dayIndexFormat ?? 'name-1'
    settingsForm.holidaySyncOverwrite = settings.holidaySync?.overwrite ?? false
    settingsForm.holidaySyncAutoEnabled = settings.holidaySync?.auto?.enabled ?? false
    settingsForm.holidaySyncAutoRunAt = settings.holidaySync?.auto?.runAt ?? '02:00'
    settingsForm.holidaySyncAutoTimezone = settings.holidaySync?.auto?.timezone ?? 'UTC'
    holidaySyncLastRun.value = settings.holidaySync?.lastRun ?? null
    settingsForm.ipAllowlist = (settings.ipAllowlist || []).join('\n')
    settingsForm.geoFenceLat = settings.geoFence?.lat?.toString() ?? ''
    settingsForm.geoFenceLng = settings.geoFence?.lng?.toString() ?? ''
    settingsForm.geoFenceRadius = settings.geoFence?.radiusMeters?.toString() ?? ''
    settingsForm.minPunchIntervalMinutes = settings.minPunchIntervalMinutes ?? 1
  }

  function addHolidayOverride() {
    settingsForm.holidayOverrides.push({
      name: '',
      match: 'contains',
      attendanceGroups: '',
      roles: '',
      roleTags: '',
      userIds: '',
      userNames: '',
      excludeUserIds: '',
      excludeUserNames: '',
      dayIndexStart: null,
      dayIndexEnd: null,
      dayIndexList: '',
      firstDayEnabled: settingsForm.holidayFirstDayEnabled,
      firstDayBaseHours: settingsForm.holidayFirstDayBaseHours,
      overtimeAdds: settingsForm.holidayOvertimeAdds,
      overtimeSource: settingsForm.holidayOvertimeSource,
    })
  }

  function removeHolidayOverride(index: number) {
    settingsForm.holidayOverrides.splice(index, 1)
  }

  async function loadSettings() {
    settingsLoading.value = true
    try {
      const response = await apiFetchWithTimeout('/api/attendance/settings')
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await response.json()
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load settings', '加载设置失败'))
      }
      adminForbidden.value = false
      applySettingsToForm((data.data || {}) as AttendanceSettings)
    } catch (error: unknown) {
      setStatusFromError(error, tr('Failed to load settings', '加载设置失败'), 'admin')
    } finally {
      settingsLoading.value = false
    }
  }

  async function saveSettings() {
    settingsLoading.value = true
    try {
      const ipAllowlist = settingsForm.ipAllowlist
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)

      const latValue = settingsForm.geoFenceLat.trim()
      const lngValue = settingsForm.geoFenceLng.trim()
      const radiusValue = settingsForm.geoFenceRadius.trim()
      const lat = latValue.length > 0 ? Number(latValue) : Number.NaN
      const lng = lngValue.length > 0 ? Number(lngValue) : Number.NaN
      const radius = radiusValue.length > 0 ? Number(radiusValue) : Number.NaN
      const geoFence = Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radius)
        ? { lat, lng, radiusMeters: radius }
        : null

      const overtimeSourceValue = settingsForm.holidayOvertimeSource
      const overtimeSource = overtimeSourceValue === 'approval' || overtimeSourceValue === 'clock' || overtimeSourceValue === 'both'
        ? overtimeSourceValue
        : 'approval'
      const dayIndexFormatValue = settingsForm.holidaySyncDayIndexFormat
      const dayIndexFormat = dayIndexFormatValue === 'name-1'
        || dayIndexFormatValue === 'name第1天'
        || dayIndexFormatValue === 'name DAY1'
        ? dayIndexFormatValue
        : 'name-1'

      const payload: AttendanceSettings = {
        autoAbsence: {
          enabled: settingsForm.autoAbsenceEnabled,
          runAt: settingsForm.autoAbsenceRunAt || '00:15',
          lookbackDays: Number(settingsForm.autoAbsenceLookbackDays) || 1,
        },
        holidayPolicy: {
          firstDayEnabled: settingsForm.holidayFirstDayEnabled,
          firstDayBaseHours: Number(settingsForm.holidayFirstDayBaseHours) || 0,
          overtimeAdds: settingsForm.holidayOvertimeAdds,
          overtimeSource,
          overrides: settingsForm.holidayOverrides
            .map((override) => ({
              name: override.name?.trim() || '',
              match: override.match || 'contains',
              attendanceGroups: splitListText(override.attendanceGroups),
              roles: splitListText(override.roles),
              roleTags: splitListText(override.roleTags),
              userIds: splitListText(override.userIds),
              userNames: splitListText(override.userNames),
              excludeUserIds: splitListText(override.excludeUserIds),
              excludeUserNames: splitListText(override.excludeUserNames),
              dayIndexStart: normalizeOptionalNumber(override.dayIndexStart),
              dayIndexEnd: normalizeOptionalNumber(override.dayIndexEnd),
              dayIndexList: splitNumberList(override.dayIndexList),
              firstDayEnabled: override.firstDayEnabled,
              firstDayBaseHours: Number.isFinite(Number(override.firstDayBaseHours))
                ? Number(override.firstDayBaseHours)
                : undefined,
              overtimeAdds: override.overtimeAdds,
              overtimeSource: override.overtimeSource === 'approval'
                || override.overtimeSource === 'clock'
                || override.overtimeSource === 'both'
                ? override.overtimeSource
                : undefined,
            }))
            .filter((override) => override.name.length > 0),
        },
        holidaySync: {
          source: 'holiday-cn',
          baseUrl: settingsForm.holidaySyncBaseUrl?.trim() || undefined,
          years: settingsForm.holidaySyncYears
            ? settingsForm.holidaySyncYears
                .split(/[\s,]+/)
                .map((item) => Number(item))
                .filter((item) => Number.isFinite(item))
            : undefined,
          addDayIndex: settingsForm.holidaySyncAddDayIndex,
          dayIndexHolidays: settingsForm.holidaySyncDayIndexHolidays
            ? settingsForm.holidaySyncDayIndexHolidays
                .split(/[\s,]+/)
                .map((item) => item.trim())
                .filter(Boolean)
            : undefined,
          dayIndexMaxDays: Number(settingsForm.holidaySyncDayIndexMaxDays) || undefined,
          dayIndexFormat,
          overwrite: settingsForm.holidaySyncOverwrite,
          auto: {
            enabled: settingsForm.holidaySyncAutoEnabled,
            runAt: settingsForm.holidaySyncAutoRunAt || '02:00',
            timezone: settingsForm.holidaySyncAutoTimezone?.trim() || undefined,
          },
        },
        ipAllowlist,
        geoFence,
        minPunchIntervalMinutes: Number(settingsForm.minPunchIntervalMinutes) || 0,
      }

      const response = await apiFetchWithTimeout('/api/attendance/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError()
      }
      const data = await response.json()
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to save settings', '保存设置失败'))
      }
      adminForbidden.value = false
      applySettingsToForm((data.data || payload) as AttendanceSettings)
      setStatus(tr('Settings updated.', '设置已更新。'))
    } catch (error: unknown) {
      setStatusFromError(error, tr('Failed to save settings', '保存设置失败'), 'save-settings')
    } finally {
      settingsLoading.value = false
    }
  }

  function buildHolidaySyncPayload(overrides?: { years?: number[] }) {
    const years = overrides?.years ?? (settingsForm.holidaySyncYears
      ? settingsForm.holidaySyncYears
          .split(/[\s,]+/)
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item))
      : undefined)

    return {
      baseUrl: settingsForm.holidaySyncBaseUrl?.trim() || undefined,
      years,
      addDayIndex: settingsForm.holidaySyncAddDayIndex,
      dayIndexHolidays: settingsForm.holidaySyncDayIndexHolidays
        ? settingsForm.holidaySyncDayIndexHolidays
            .split(/[\s,]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined,
      dayIndexMaxDays: Number(settingsForm.holidaySyncDayIndexMaxDays) || undefined,
      dayIndexFormat: settingsForm.holidaySyncDayIndexFormat || 'name-1',
      overwrite: settingsForm.holidaySyncOverwrite,
    }
  }

  async function syncHolidaysWithPayload(overrides?: { years?: number[] }) {
    holidaySyncLoading.value = true
    try {
      const response = await apiFetchWithTimeout('/api/attendance/holidays/sync', {
        method: 'POST',
        body: JSON.stringify({
          source: 'holiday-cn',
          ...buildHolidaySyncPayload(overrides),
        }),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError()
      }
      const data = await response.json()
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Holiday sync failed', '节假日同步失败'))
      }
      adminForbidden.value = false
      if (data?.data?.lastRun) {
        holidaySyncLastRun.value = data.data.lastRun as HolidaySyncLastRun
      }
      setStatus(tr(
        `Holiday sync complete (${data.data?.totalApplied ?? 0} applied).`,
        `节假日同步完成（已应用 ${data.data?.totalApplied ?? 0} 条）。`,
      ))
    } catch (error: unknown) {
      setStatusFromError(error, tr('Holiday sync failed', '节假日同步失败'), 'sync-holidays')
    } finally {
      holidaySyncLoading.value = false
    }
  }

  async function syncHolidays() {
    await syncHolidaysWithPayload()
  }

  async function syncHolidaysForYears(years: number[]) {
    settingsForm.holidaySyncYears = years.join(',')
    await syncHolidaysWithPayload({ years })
  }

  async function loadRule() {
    ruleLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetchWithTimeout(`/api/attendance/rules/default?${query.toString()}`)
      const data = await response.json()
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load rule', '加载规则失败'))
      }
      const rule = data.data as AttendanceRule
      ruleForm.name = rule.name || 'Default'
      ruleForm.timezone = rule.timezone || defaultTimezone
      ruleForm.workStartTime = rule.workStartTime || '09:00'
      ruleForm.workEndTime = rule.workEndTime || '18:00'
      ruleForm.lateGraceMinutes = rule.lateGraceMinutes ?? 10
      ruleForm.earlyGraceMinutes = rule.earlyGraceMinutes ?? 10
      ruleForm.roundingMinutes = rule.roundingMinutes ?? 5
      ruleForm.workingDays = Array.isArray(rule.workingDays) ? rule.workingDays.join(',') : '1,2,3,4,5'
    } catch (error: unknown) {
      setStatusFromError(error, tr('Failed to load rule', '加载规则失败'), 'admin')
    } finally {
      ruleLoading.value = false
    }
  }

  async function saveRule() {
    ruleLoading.value = true
    try {
      const payload = {
        name: ruleForm.name,
        timezone: ruleForm.timezone,
        workStartTime: ruleForm.workStartTime,
        workEndTime: ruleForm.workEndTime,
        lateGraceMinutes: Number(ruleForm.lateGraceMinutes) || 0,
        earlyGraceMinutes: Number(ruleForm.earlyGraceMinutes) || 0,
        roundingMinutes: Number(ruleForm.roundingMinutes) || 0,
        workingDays: parseWorkingDaysInput(ruleForm.workingDays),
        orgId: getOrgId(),
      }
      const response = await apiFetchWithTimeout('/api/attendance/rules/default', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError()
      }
      const data = await response.json()
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to save rule', '保存规则失败'))
      }
      const rule = data.data as AttendanceRule
      ruleForm.name = rule.name || ruleForm.name
      ruleForm.timezone = rule.timezone || ruleForm.timezone
      ruleForm.workStartTime = rule.workStartTime || ruleForm.workStartTime
      ruleForm.workEndTime = rule.workEndTime || ruleForm.workEndTime
      ruleForm.lateGraceMinutes = rule.lateGraceMinutes ?? ruleForm.lateGraceMinutes
      ruleForm.earlyGraceMinutes = rule.earlyGraceMinutes ?? ruleForm.earlyGraceMinutes
      ruleForm.roundingMinutes = rule.roundingMinutes ?? ruleForm.roundingMinutes
      ruleForm.workingDays = Array.isArray(rule.workingDays) ? rule.workingDays.join(',') : ruleForm.workingDays
      setStatus(tr('Rule updated.', '规则已更新。'))
    } catch (error: unknown) {
      setStatusFromError(error, tr('Failed to save rule', '保存规则失败'), 'save-rule')
    } finally {
      ruleLoading.value = false
    }
  }

  return {
    addHolidayOverride,
    holidaySyncLastRun,
    holidaySyncLoading,
    loadRule,
    loadSettings,
    removeHolidayOverride,
    ruleForm,
    ruleLoading,
    saveRule,
    saveSettings,
    settingsForm,
    settingsLoading,
    syncHolidays,
    syncHolidaysForYears,
  }
}
