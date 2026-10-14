import { formatAttendanceDateKey, normalizeAttendanceTimeZone } from './attendanceDateTimePresentation'

export interface AttendanceCurrentTimeContext {
  resolvedForInstant: string
  effectiveTimezone: string
  timezoneSource: 'system_default' | 'trip' | 'employee_override' | 'calculation_group'
  mode: 'default_only' | 'multi_timezone'
  policyVersion: number
  referenceId: string
  version: number
  currentLocalDate: string
  nextEffectiveBoundary: string | null
}

function instant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

export function parseAttendanceCurrentTimeContext(value: unknown): AttendanceCurrentTimeContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const context = value as Record<string, unknown>
  const keys = ['resolvedForInstant', 'effectiveTimezone', 'timezoneSource', 'mode', 'policyVersion',
    'referenceId', 'version', 'currentLocalDate', 'nextEffectiveBoundary']
  if (Object.keys(context).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(context, key))) return null
  if (!instant(context.resolvedForInstant)
    || typeof context.effectiveTimezone !== 'string'
    || normalizeAttendanceTimeZone(context.effectiveTimezone) !== context.effectiveTimezone
    || typeof context.timezoneSource !== 'string'
    || !['system_default', 'trip', 'employee_override', 'calculation_group'].includes(String(context.timezoneSource))
    || typeof context.mode !== 'string'
    || !['default_only', 'multi_timezone'].includes(String(context.mode))
    || !Number.isSafeInteger(context.policyVersion) || Number(context.policyVersion) < 0
    || !Number.isSafeInteger(context.version) || Number(context.version) < 0
    || typeof context.referenceId !== 'string' || !context.referenceId.trim()
    || context.currentLocalDate !== formatAttendanceDateKey(new Date(context.resolvedForInstant), context.effectiveTimezone)
    || (context.nextEffectiveBoundary !== null && (!instant(context.nextEffectiveBoundary)
      || Date.parse(context.nextEffectiveBoundary) <= Date.parse(context.resolvedForInstant)))
    || (context.mode === 'default_only' && (context.timezoneSource !== 'system_default'
      || context.nextEffectiveBoundary !== null))) return null
  return context as unknown as AttendanceCurrentTimeContext
}

export function currentAttendanceTimezone(context: AttendanceCurrentTimeContext | null, now: Date | null): string | null {
  if (!context || !now || !Number.isFinite(now.getTime())
    || (context.nextEffectiveBoundary !== null && now.getTime() >= Date.parse(context.nextEffectiveBoundary))) return null
  return context.effectiveTimezone
}
