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
  DingTalkAttendanceDeliveryChannel,
  WeComAttendanceDeliveryChannel,
  EmailAttendanceDeliveryChannel,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  WECOM_WORK_NOTIFICATION_CHANNEL_NAME,
  EMAIL_SMTP_CHANNEL_NAME,
  type AttendanceNotificationQuietHoursConfig,
  type AttendanceNotificationDeliveryQuery,
  type EmailDeliveryTransport,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import type { Logger } from '../../src/core/logger'
import type { DingTalkMessageConfig } from '../../src/integrations/dingtalk/client'
import type { WeComMessageConfig } from '../../src/integrations/wecom/client'
import { EMAIL_TRANSPORT_ENV } from '../../src/services/email-transport-readiness'

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

  it('quietHoursLogged reset on window-exit is load-bearing: re-entering the window after exiting logs a SECOND deferral message', async () => {
    // Mutation guard for the `this.quietHoursLogged = false` reset in runBatch() (the non-deferral
    // branch). If that reset is deleted, quietHoursLogged latches `true` forever after the first
    // deferral and a later re-entry into the window never logs again — this test is RED under that
    // mutation because `info` stops incrementing on tick 3 below.
    const info = vi.fn()
    const warn = vi.fn()
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }
    let current = new Date('2026-07-09T23:00:00Z') // inside window
    const query = makeQuery()
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      quietHours,
      now: () => current,
      logger: { info, warn } as unknown as Logger,
    })

    // Tick 1: enter window → defer + first deferral log, zero SQL.
    const tick1 = await worker.runBatch()
    expect(tick1).toEqual(ZERO_RESULT)
    expect(info).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()

    // Tick 2: exit window → claims normally (real SQL issued); no additional deferral log (mock query
    // returns 0 rows, so the separate "claimed=N" summary log — gated on claimed>0 — does not fire).
    current = new Date('2026-07-09T12:00:00Z') // outside window
    await worker.runBatch()
    expect(info).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)

    // Tick 3: re-enter window → SECOND deferral log. Only fires if the exit tick reset
    // quietHoursLogged back to false; proves the reset is load-bearing, not deletable.
    current = new Date('2026-07-09T23:30:00Z') // inside window again
    const tick3 = await worker.runBatch()
    expect(tick3).toEqual(ZERO_RESULT)
    expect(info).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenCalledTimes(1) // still deferred: no new SQL on tick 3
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

  it('start === end (e.g. "22:00-22:00") → INVALID config: off + one warn, not a zero-length or full-day window', () => {
    const warn = vi.fn()
    const env = { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '22:00-22:00' } as NodeJS.ProcessEnv
    expect(resolveAttendanceNotificationQuietHours(env, { warn })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('start === end at midnight ("00:00-00:00") is also rejected, not silently treated as full-day-quiet', () => {
    const warn = vi.fn()
    const env = { ATTENDANCE_NOTIFICATION_QUIET_HOURS: '00:00-00:00' } as NodeJS.ProcessEnv
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

describe('isAttendanceNotificationQuietHours: broken Intl fails OPEN, not toward midnight', () => {
  // If formatToParts unexpectedly omits hour/minute (broken ICU data — should not happen given the
  // options passed, but is not impossible), the OLD behavior defaulted both to '00', which — inside a
  // cross-midnight window like 22:00-08:00 — reads as "00:00", i.e. INSIDE the window: notifications
  // would silently and permanently stop. The fix must fail OPEN (outside the window) instead.
  const OriginalDateTimeFormat = Intl.DateTimeFormat

  function stubBrokenIntl() {
    // @ts-expect-error test-only stub: garbage formatToParts result missing hour/minute part types.
    Intl.DateTimeFormat = vi.fn().mockImplementation(() => ({
      formatToParts: () => [{ type: 'literal', value: '' }],
      format: () => '00:00',
    }))
  }

  afterEach(() => {
    Intl.DateTimeFormat = OriginalDateTimeFormat
  })

  it('missing hour/minute parts → returns false (OUTSIDE the window) and warns once, even at what would be midnight', () => {
    stubBrokenIntl()
    const warn = vi.fn()
    // A cross-midnight window where the old '00' fallback would have read as "inside".
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }

    const result = isAttendanceNotificationQuietHours(
      new Date('2026-07-09T00:00:00Z'),
      quietHours,
      { warn } as unknown as Pick<Logger, 'warn'>,
    )

    expect(result).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('runBatch: broken Intl → claims normally (real SQL issued) and warns, instead of silently deferring forever', async () => {
    stubBrokenIntl()
    const info = vi.fn()
    const warn = vi.fn()
    const query = makeQuery()
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      quietHours,
      now: () => new Date('2026-07-09T00:00:00Z'),
      logger: { info, warn } as unknown as Logger,
    })

    const result = await worker.runBatch()

    expect(query).toHaveBeenCalledTimes(1) // claimed normally — NOT deferred
    expect(result.claimed).toBe(0) // mock returns no rows, but the claim WAS attempted
    expect(warn).toHaveBeenCalled()
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

describe('R8 quiet-hours × the FULL channel roster (DingTalk + WeCom S4 + email) — owner-ratified 2026-07-10: ' +
  'the pre-claim gate is channel-agnostic, not DingTalk-only', () => {
  // Real channel instances (not the deterministic fake) with every I/O seam DI-injected, mirroring the
  // patterns in attendance-wecom-delivery-channel.test.ts / attendance-email-delivery-channel.test.ts /
  // attendance-scheduler.test.ts's "real DingTalk channel" case. This proves the combination end-to-end
  // through the SAME channelsByName / deliver() call site the worker actually uses in production — not
  // through a re-implementation of the gate.

  const DT_CONFIG: DingTalkMessageConfig = {
    appKey: 'dt-app-key',
    appSecret: 'dt-app-secret',
    agentId: '123456789',
    baseUrl: 'https://oapi.dingtalk.com',
  }
  const WECOM_CONFIG: WeComMessageConfig = { corpId: 'corp-1', corpSecret: 'corpsecret-value', agentId: '1000002' }
  const READY_SMTP_ENV = {
    [EMAIL_TRANSPORT_ENV]: 'smtp',
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
    MULTITABLE_EMAIL_SMTP_PORT: '587',
    MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
    MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
  } as NodeJS.ProcessEnv

  function makeRoster() {
    const dtSendWorkNotification = vi.fn(async () => ({ taskId: 'dt-task-1', raw: {} }))
    const dtSendActionCard = vi.fn(async () => ({ taskId: 'dt-task-2', raw: {} }))
    const dingTalkChannel = new DingTalkAttendanceDeliveryChannel({
      query: vi.fn(async () => ({ rows: [{ integration_id: 'dt-integ-1', external_user_id: 'dt-user-1' }] })) as never,
      readConfig: async () => DT_CONFIG,
      fetchAccessToken: async () => 'dt-access-token',
      sendWorkNotification: dtSendWorkNotification,
      sendWorkNotificationActionCard: dtSendActionCard,
    })

    const weComSendTextMessage = vi.fn(async () => ({ errcode: 0, errmsg: 'ok', invalidUserIds: [], raw: {} }))
    const weComSendTextCardMessage = vi.fn(async () => ({ errcode: 0, errmsg: 'ok', invalidUserIds: [], raw: {} }))
    const weComChannel = new WeComAttendanceDeliveryChannel({
      query: vi.fn(async () => ({ rows: [{ integration_id: 'we-integ-1', external_user_id: 'we-user-1' }] })) as never,
      readConfig: async () => WECOM_CONFIG,
      fetchAccessToken: async () => 'we-access-token',
      sendTextMessage: weComSendTextMessage,
      sendTextCardMessage: weComSendTextCardMessage,
    })

    const emailSendMail = vi.fn(async () => ({ messageId: 'email-ok' }))
    const emailTransport: EmailDeliveryTransport = { sendMail: emailSendMail }
    const emailChannel = new EmailAttendanceDeliveryChannel({
      env: READY_SMTP_ENV,
      query: vi.fn(async () => ({ rows: [{ email: 'user@example.com' }] })) as never,
      createTransport: () => emailTransport,
    })

    return {
      channels: [dingTalkChannel, weComChannel, emailChannel],
      dtSendWorkNotification,
      dtSendActionCard,
      weComSendTextMessage,
      weComSendTextCardMessage,
      emailSendMail,
    }
  }

  function claimedRow(id: string, channel: string) {
    return {
      id,
      org_id: 'org1',
      source_type: 'unscheduled_reminder',
      source_id: 'src1',
      source_key: `key-${id}`,
      recipient_user_id: 'u1',
      recipient_role: 'member',
      channel,
      attempt_count: 0,
      payload: { title: 'Punch reminder', body: 'You have an unscheduled shift today.' },
    }
  }

  /** Worker-level `query`: claimDueDeliveries' claim SQL vs. every terminal-state UPDATE (mark*). */
  function makeWorkerQuery(claimRows: ReturnType<typeof claimedRow>[]): AttendanceNotificationDeliveryQuery {
    return vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: claimRows, rowCount: claimRows.length }
      // markSent/markFailed/markRetrying/markSkipped: CAS UPDATE — report exactly 1 row matched.
      return { rows: [], rowCount: 1 }
    }) as unknown as AttendanceNotificationDeliveryQuery
  }

  it('inside the window: ZERO claims AND ZERO sends on every channel (DingTalk, WeCom, email) — proves the ' +
    'gate fences the whole batch, not a DingTalk-only path, and that WeCom has no separate claim/send path ' +
    'that could bypass it', async () => {
    const roster = makeRoster()
    const claimQuery = makeWorkerQuery([
      claimedRow('dlv-dt', DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-wecom', WECOM_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-email', EMAIL_SMTP_CHANNEL_NAME),
    ])
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query: claimQuery,
      channels: roster.channels,
      quietHours,
      now: () => new Date('2026-07-09T23:30:00Z'), // inside 22:00-08:00
    })

    const result = await worker.runBatch()

    expect(result).toEqual(ZERO_RESULT)
    // claimDueDeliveries never ran — no SQL at all, not even the claim SQL that WOULD have returned rows
    // for all three channels above.
    expect(claimQuery).not.toHaveBeenCalled()
    // Every channel's real network/DB send seam: zero calls. If WeCom (or any channel) had a separate
    // claim/send path that bypassed runBatch()'s pre-claim gate, its send spy would have fired here.
    expect(roster.dtSendWorkNotification).not.toHaveBeenCalled()
    expect(roster.dtSendActionCard).not.toHaveBeenCalled()
    expect(roster.weComSendTextMessage).not.toHaveBeenCalled()
    expect(roster.weComSendTextCardMessage).not.toHaveBeenCalled()
    expect(roster.emailSendMail).not.toHaveBeenCalled()
  })

  it('outside the window: all three channels flow — claim SQL issued once, one send per channel, all sent', async () => {
    const roster = makeRoster()
    const claimQuery = makeWorkerQuery([
      claimedRow('dlv-dt', DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-wecom', WECOM_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-email', EMAIL_SMTP_CHANNEL_NAME),
    ])
    const quietHours: AttendanceNotificationQuietHoursConfig = { start: '22:00', end: '08:00', timeZone: 'UTC' }
    const worker = new AttendanceNotificationDeliveryWorker({
      query: claimQuery,
      channels: roster.channels,
      quietHours,
      now: () => new Date('2026-07-09T12:00:00Z'), // outside 22:00-08:00
    })

    const result = await worker.runBatch()

    expect(result.claimed).toBe(3)
    expect(result.sent).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    // Claim SQL fired exactly once; every mark* CAS-update call after it is on the SAME query mock, so
    // this only asserts the claim itself was not skipped (mirrors the existing single-channel test above).
    expect(claimQuery).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'), expect.any(Array))
    expect(roster.dtSendWorkNotification).toHaveBeenCalledTimes(1)
    expect(roster.weComSendTextMessage).toHaveBeenCalledTimes(1)
    expect(roster.emailSendMail).toHaveBeenCalledTimes(1)
  })

  it('quiet hours OFF (no config): all three channels flow exactly as if the gate did not exist', async () => {
    const roster = makeRoster()
    const claimQuery = makeWorkerQuery([
      claimedRow('dlv-dt', DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-wecom', WECOM_WORK_NOTIFICATION_CHANNEL_NAME),
      claimedRow('dlv-email', EMAIL_SMTP_CHANNEL_NAME),
    ])
    const worker = new AttendanceNotificationDeliveryWorker({
      query: claimQuery,
      channels: roster.channels,
      quietHours: null, // explicit off
      now: () => new Date('2026-07-09T23:30:00Z'), // would be inside window if the gate were active
    })

    const result = await worker.runBatch()

    expect(result.claimed).toBe(3)
    expect(result.sent).toBe(3)
    expect(roster.dtSendWorkNotification).toHaveBeenCalledTimes(1)
    expect(roster.weComSendTextMessage).toHaveBeenCalledTimes(1)
    expect(roster.emailSendMail).toHaveBeenCalledTimes(1)
  })
})
