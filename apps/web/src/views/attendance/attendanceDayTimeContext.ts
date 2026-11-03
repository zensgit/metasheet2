import { normalizeAttendanceTimeZone } from './attendanceDateTimePresentation'

export interface AttendanceDayTimeContext {
  targetWorkDate: string
  effectiveTimezone: string
  timezoneSource: 'system_default' | 'trip' | 'employee_override' | 'calculation_group' | 'legacy_record'
  mode: 'default_only' | 'multi_timezone' | null
  policyVersion: number | null
  contextFingerprint: string | null
  frozen: boolean
}

export function parseAttendanceDayTimeContext(value: unknown, workDate: string): AttendanceDayTimeContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(workDate)) return null
  const date = new Date(workDate + 'T00:00:00.000Z')
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== workDate) return null
  const context = value as Record<string, unknown>
  const keys = ['targetWorkDate', 'effectiveTimezone', 'timezoneSource', 'mode', 'policyVersion', 'contextFingerprint', 'frozen']
  if (Object.keys(context).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(context, key))
    || context.targetWorkDate !== workDate
    || typeof context.effectiveTimezone !== 'string'
    || normalizeAttendanceTimeZone(context.effectiveTimezone) !== context.effectiveTimezone
    || typeof context.timezoneSource !== 'string'
    || !['system_default', 'trip', 'employee_override', 'calculation_group', 'legacy_record'].includes(context.timezoneSource)
    || typeof context.frozen !== 'boolean') return null
  if (context.timezoneSource === 'legacy_record') {
    if (context.mode !== null || context.policyVersion !== null || context.frozen !== true) return null
  } else if ((context.mode !== 'default_only' && context.mode !== 'multi_timezone')
    || !Number.isSafeInteger(context.policyVersion) || Number(context.policyVersion) < 0
    || (context.mode === 'default_only' && context.timezoneSource !== 'system_default')
    || context.contextFingerprint === null) return null
  if (context.contextFingerprint !== null && (typeof context.contextFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(context.contextFingerprint))) return null
  return context as unknown as AttendanceDayTimeContext
}

export function attendanceDayTimezoneLabel(context: AttendanceDayTimeContext | null, isZh: boolean): string {
  if (!context) return isZh ? '考勤时区不可用' : 'Attendance timezone unavailable'
  const sources = {
    system_default: isZh ? '系统默认' : 'System default',
    trip: isZh ? '已批准出差' : 'Approved business trip',
    employee_override: isZh ? '员工配置' : 'Employee configuration',
    calculation_group: isZh ? '考勤组' : 'Attendance group',
    legacy_record: isZh ? '历史记录（来源版本未知）' : 'Historical record (source version unknown)',
  }
  return (isZh ? '考勤时区：' : 'Attendance timezone: ') + context.effectiveTimezone + ' · '
    + sources[context.timezoneSource] + (context.frozen ? (isZh ? ' · 已保存的班次' : ' · Saved shift') : '')
}
