import { resolveAttendanceWallTime } from './attendanceWallTime'

export interface AttendanceTimezoneTarget {
  orgId: string; userId: string; workDate: string; timezone: string; contextFingerprint: string
  frozen: boolean; referenceId: string | null; provenance: Record<string, unknown> | null
  window: { startAt: string; endAt: string }; rule: Record<string, unknown>; isWorkingDay: boolean
}
export interface AttendanceTimezoneTargetExpected { orgId: string; userId: string; workDate: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const hasKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k))
const validDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(y, m - 1, d)
  return y >= 1 && date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d
}
const validZone = (v: unknown): v is string => {
  if (typeof v !== 'string' || !v || v !== v.trim() || /^[+-]/.test(v)) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(0); return true } catch { return false }
}
interface Instant { epoch: number; canonical: string }

// HTTP Date DTO precision is milliseconds; reject finer RFC3339 fractions rather than lose precision.
const parseInstant = (v: unknown): Instant | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(v)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, frac = '', zone] = m
  const [y, mo, d, h, mi, s] = [ys, mos, ds, hs, mis, ss].map(Number)
  const ms = Number(frac.padEnd(3, '0') || '0')
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(h, mi, s, ms)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== mo || date.getUTCDate() !== d
    || date.getUTCHours() !== h || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== s
    || date.getUTCMilliseconds() !== ms) return null
  let offset = 0
  if (zone !== 'Z') {
    if (zone === '-00:00') return null
    const sign = zone[0] === '+' ? 1 : -1
    const oh = Number(zone.slice(1, 3)); const om = Number(zone.slice(4, 6))
    if (oh > 23 || om > 59) return null
    offset = sign * (oh * 60 + om)
  }
  const epoch = date.getTime() - offset * 60_000
  return Number.isFinite(epoch) ? { epoch, canonical: new Date(epoch).toISOString() } : null
}

export function parseAttendanceTimezoneTarget(
  value: unknown, expected: AttendanceTimezoneTargetExpected,
): AttendanceTimezoneTarget | null {
  if (!expected || !expected.orgId || !expected.userId || !validDate(expected.workDate)) return null
  if (!isRecord(value) || !hasKeys(value, ['ok', 'data']) || value.ok !== true || !isRecord(value.data)) return null
  const d = value.data
  if (!hasKeys(d, ['orgId', 'userId', 'workDate', 'timezone', 'contextFingerprint', 'frozen',
    'referenceId', 'provenance', 'window', 'rule', 'isWorkingDay'])) return null
  if (d.orgId !== expected.orgId || d.userId !== expected.userId || d.workDate !== expected.workDate
    || !validZone(d.timezone) || typeof d.contextFingerprint !== 'string'
    || !/^[a-f\d]{64}$/i.test(d.contextFingerprint) || typeof d.frozen !== 'boolean'
    || !(d.referenceId === null || (typeof d.referenceId === 'string' && d.referenceId.length > 0))
    || !(d.provenance === null || isRecord(d.provenance)) || !isRecord(d.window)
    || !hasKeys(d.window, ['startAt', 'endAt']) || !isRecord(d.rule)
    || typeof d.isWorkingDay !== 'boolean') return null
  const start = parseInstant(d.window.startAt); const end = parseInstant(d.window.endAt)
  if (!start || !end || end.epoch <= start.epoch) return null
  return {
    orgId: d.orgId as string, userId: d.userId as string, workDate: d.workDate as string,
    timezone: d.timezone, contextFingerprint: d.contextFingerprint, frozen: d.frozen,
    referenceId: d.referenceId as string | null, provenance: d.provenance as Record<string, unknown> | null,
    window: { startAt: d.window.startAt as string, endAt: d.window.endAt as string },
    rule: d.rule, isWorkingDay: d.isWorkingDay,
  }
}

const localMatch = (v: string) => /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(v)
const originalMatchesWall = (epoch: number, local: string, timezone: string): boolean => {
  const m = localMatch(local)
  if (!m) return false
  try {
    const f = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', fractionalSecondDigits: 3,
    })
    const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]))
    const expected = m.slice(1, 6).map(Number)
    const actual = ['year', 'month', 'day', 'hour', 'minute'].map(k => Number(p[k]))
    if (!expected.every((n, i) => n === actual[i])) return false
    if (m[6] !== undefined && Number(m[6]) !== Number(p.second)) return false
    if (m[7] !== undefined && m[7] !== p.fractionalSecond?.slice(0, m[7].length)) return false
    return true
  } catch { return false }
}

export function resolveTargetRequestInstant(
  local: string, timezone: string, selected?: string, original?: string,
): string | null {
  const result = resolveAttendanceWallTime(local, timezone)
  if (result.kind !== 'unique' && result.kind !== 'fold') return null
  if (selected !== undefined) {
    const chosen = parseInstant(selected)
    if (!chosen) return null
    return result.choices.find(c => parseInstant(c.instant)?.epoch === chosen.epoch)?.instant ?? null
  }
  const prior = parseInstant(original)
  if (prior && originalMatchesWall(prior.epoch, local, timezone)) return prior.canonical
  if (result.kind === 'unique') return result.choices[0]?.instant ?? null
  return null
}
