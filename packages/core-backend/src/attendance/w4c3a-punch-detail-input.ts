/**
 * Explicit physical-event input. This does not normalize legacy daily rows,
 * authorize an actor, choose a source policy, or enable a calculation posture.
 */
export type AttendancePunchDetailInputV1 = Readonly<{
  inputKind: 'punch_events_v1'
  userId: string
  workDate: string
  timezone: string
  punches: readonly Readonly<{
    direction: 'check_in' | 'check_out'
    occurredAt: string
  }>[]
}>

// The existing reference calculator and shift contract admit at most 3 segments.
export const ATTENDANCE_PUNCH_DETAIL_MAX_EVENTS_V1 = 6

export class AttendancePunchDetailInputError extends Error {
  readonly code = 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID'
  constructor() {
    super('ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID')
    this.name = 'AttendancePunchDetailInputError'
  }
}

function invalid(): never {
  throw new AttendancePunchDetailInputError()
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (keys.some((key) => !descriptors[key] || !('value' in descriptors[key]))) invalid()
  return value as Record<string, unknown>
}

/** Reject unknown variants; the caller must dispatch before the daily-row parser. */
export function parseAttendancePunchDetailInputV1(value: unknown): AttendancePunchDetailInputV1 {
  const input = exactObject(value, ['inputKind', 'userId', 'workDate', 'timezone', 'punches'])
  if (input.inputKind !== 'punch_events_v1') invalid()
  if (typeof input.userId !== 'string' || input.userId.length === 0 || input.userId.length > 200 || input.userId.trim() !== input.userId) invalid()
  if (typeof input.workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) invalid()
  const day = new Date(input.workDate + 'T00:00:00.000Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== input.workDate) invalid()
  if (typeof input.timezone !== 'string' || input.timezone.length === 0 || input.timezone.length > 100 || input.timezone.trim() !== input.timezone) invalid()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(day)
  } catch {
    invalid()
  }
  if (!Array.isArray(input.punches) || input.punches.length === 0 || input.punches.length > ATTENDANCE_PUNCH_DETAIL_MAX_EVENTS_V1) invalid()
  const punches: Array<{ readonly direction: 'check_in' | 'check_out'; readonly occurredAt: string }> = []
  for (let index = 0; index < input.punches.length; index += 1) {
    const punch = exactObject(input.punches[index], ['direction', 'occurredAt'])
    if (punch.direction !== 'check_in' && punch.direction !== 'check_out') invalid()
    if (typeof punch.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(punch.occurredAt)) invalid()
    const time = new Date(punch.occurredAt)
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== punch.occurredAt) invalid()
    const previous = punches[index - 1]
    if (previous && (previous.occurredAt >= punch.occurredAt || previous.direction === punch.direction)) invalid()
    punches.push(Object.freeze({ direction: punch.direction, occurredAt: punch.occurredAt }))
  }
  return Object.freeze({
    inputKind: 'punch_events_v1',
    userId: input.userId,
    workDate: input.workDate,
    timezone: input.timezone,
    punches: Object.freeze(punches),
  })
}
