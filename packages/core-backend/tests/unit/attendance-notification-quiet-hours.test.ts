/**
 * R8 — attendance DingTalk (and other outbox channel) notification quiet hours.
 * Pure unit: the worker already injects `query` and `now()` (no real DB / no real clock needed).
 * v1 = deployment-wide env config (ATTENDANCE_NOTIFICATION_QUIET_HOURS / _TZ); the gate sits BEFORE
 * claimDueDeliveries() in runBatch() so an in-window tick issues ZERO SQL and leaves due rows untouched
 * (no lease taken, no attempt_count burned) — see AttendanceNotificationDeliveryWorker.ts runBatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AttendanceNotificationDeliveryWorker,
  resolveAttendanceNotificationQuietHours,
  isAttendanceNotificationQuietHours,
  type AttendanceNotificationQuietHoursConfig,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import type { Logger } from '../../src/core/logger'

function makeQuery(rows: unknown[] = []): AttendanceNotificationDeliveryQuery {
  return vi.fn(async () => ({ rows, rowCount: rows.length })) as unknown as AttendanceNotificationDeliveryQuery
}

const ZERO_RESULT = { claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 }

describe('AttendanceNotificationDeliveryWorker.runBatch quiet-hours gate', () => {
  it('inside a non-wrapping window: returns the zero-result shape and issues ZERO SQL', async () => {
    const query = makeQuery()
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '09:00', end: '17:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      quietHours,
      now: () => new Date('2026-07-09T12:00:00Z'),
    })

    const result = await worker.runBatch()

    expect(result).toEqual(ZERO_RESULT)
    expect(query).not.toHaveBeenCalled()
  })

  it('outside the window: claims normally (the real claim SQL is actually issued)', async () => {
    const query = makeQuery()
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '09:00', end: '17:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      quietHours,
      now: () => new Date('2026-07-09T20:00:00Z'),
    })

    const result = await worker.runBatch()

    expect(result.claimed).toBe(0) // mock returns no rows, but the claim WAS attempted
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'), expect.any(Array))
  })

  it('cross-midnight window 22:00-08:00: 23:30 and 07:30 both defer, 12:00 sends', async () => {
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }

    const late = makeQuery()
    const lateWorker = new AttendanceNotificationDeliveryWorker({
      query: late,
      quietHours,
      now: () => new Date('2026-07-09T23:30:00Z'),
    })
    expect(await lateWorker.runBatch()).toEqual(ZERO_RESULT)
    expect(late).not.toHaveBeenCalled()

    const early = makeQuery()
    const earlyWorker = new AttendanceNotificationDeliveryWorker({
      query: early,
      quietHours,
      now: () => new Date('2026-07-09T07:30:00Z'),
    })
    expect(await earlyWorker.runBatch()).toEqual(ZERO_RESULT)
    expect(early).not.toHaveBeenCalled()

    const noon = makeQuery()
    const noonWorker = new AttendanceNotificationDeliveryWorker({
      query: noon,
      quietHours,
      now: () => new Date('2026-07-09T12:00:00Z'),
    })
    const noonResult = await noonWorker.runBatch()
    expect(noonResult.claimed).toBe(0) // mock returns no rows, but dispatch was NOT gated
    expect(noon).toHaveBeenCalledTimes(1)
  })

  it('logs the deferral once per window entry, not on every tick', async () => {
    const info = vi.fn()
    const warn = vi.fn()
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query: makeQuery(),
      quietHours,
      now: () => new Date('2026-07-09T23:30:00Z'),
      logger: { info, warn } as unknown as Logger,
    })

    await worker.runBatch()
    await worker.runBatch()
    await worker.runBatch()

    expect(info).toHaveBeenCalledTimes(1)
  })
})

describe('resolveAttendanceNotificationQuietHours env parsing', () => {
  it('unset/empty ATTENDANCE_NOTIFICATION_QUIET_HOURS → off, no warn (unchanged behavior)', () => {
    const warn = vi.fn()
    expect(resolveAttendanceNotificationQuietHours({} as NodeJS.ProcessEnv, { warn })).toBeNull()
    expect(resolveAttendanceNotificationQuietHours(
      { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '' } as NodeJS.ProcessEnv,
      { warn },
    )).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('malformed "HH:MM-HH:MM" shape → off + exactly one warn', () => {
    const warn = vi.fn()
    const env = { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '22:00 to 08:00' } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('out-of-range HH:MM (e.g. 25:00) → off + one warn', () => {
    const warn = vi.fn()
    const env = { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '25:00-08:00' } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('unrecognized IANA timezone → off + one warn', () => {
    const warn = vi.fn()
    const env = {
      ATTENDANCE_NOTIFICATION_QUIET_HOURS: '22:00-08:00',
      ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ: 'Not/AZone',
    } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('valid window, TZ unset → defaults to Asia/Shanghai', () => {
    const env = { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '22:00-08:00' } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn: vi.fn() })).toEqual({
      start: '22:00',
      end: '08:00',
      timeZone: 'Asia/Shanghai',
    })
  })

  it('valid window + explicit TZ → both honored', () => {
    const env = {
      ATTENDANCE_NOTIFICATION_QUIET_HOURS: '21:15-06:45',
      ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ: 'UTC',
    } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn: vi.fn() })).toEqual({
      start: '21:15',
      end: '06:45',
      timeZone: 'UTC',
    })
  })
})

describe('isAttendanceNotificationQuietHours timezone correctness', () => {
  it('computes local HH:MM in the CONFIGURED timezone, not the process/system default', () => {
    // 2026-07-08T17:30:00Z is 2026-07-09 01:30 in Asia/Shanghai (UTC+8, no DST) and 17:30 in UTC.
    const now = new Date('2026-07-08T17:30:00Z')
    const shanghai: AttendanceNotificationQuietHoursConfig = { start: '00:00', end: '06:00', timeZone: 'Asia/Shanghai' }
    const utc: AttendanceNotificationQuietHoursConfig = { start: '00:00', end: '06:00', timeZone: 'UTC' }

    expect(isAttendanceNotificationQuietHours(now, shanghai)).toBe(true)
    expect(isAttendanceNotificationQuietHours(now, utc)).toBe(false)
  })
})

describe('AttendanceNotificationDeliveryWorker: quiet-hours env resolution at construction', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('malformed ATTENDANCE_NOTIFICATION_QUIET_HOURS → gate off, worker claims normally', async () => {
    process.env.ATTENDANCE_NOTIFICATION_QUIET_HOURS = 'garbage'
    const query = makeQuery()
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      now: () => new Date('2026-07-09T23:30:00Z'),
    })

    await worker.runBatch()

    expect(query).toHaveBeenCalledTimes(1)
  })

  it('unset ATTENDANCE_NOTIFICATION_QUIET_HOURS → gate off (default), worker claims normally', async () => {
    delete process.env.ATTENDANCE_NOTIFICATION_QUIET_HOURS
    const query = makeQuery()
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      now: () => new Date('2026-07-09T23:30:00Z'),
    })

    await worker.runBatch()

    expect(query).toHaveBeenCalledTimes(1)
  })
})
