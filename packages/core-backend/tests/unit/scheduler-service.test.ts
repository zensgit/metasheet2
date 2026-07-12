import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulerServiceImpl, SimpleCronExpression } from '../../src/services/SchedulerService'

// Node clamps setTimeout delays above 2^31-1 ms (~24.86 days) to 1ms. A validated
// far-future cron (e.g. a yearly schedule saved mid-year) must not be handed a raw delay
// that crosses that ceiling, or it fires immediately and hot-loops. These tests pin the
// chunked delay-arming mechanics in SchedulerService's JobScheduler.scheduleCronJob.
const NODE_MAX_TIMEOUT_MS = 2 ** 31 - 1

describe('SchedulerService cron delay arming (far-future crons)', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    // SimpleCronExpression matches against local-time Date getters, not UTC — pin TZ so
    // the test is deterministic regardless of the machine/CI runner's default zone.
    process.env.TZ = 'UTC'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTz === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = originalTz
    }
  })

  function totalDelayToNextJan1(): number {
    // Mirrors what SimpleCronExpression.next() resolves '0 0 1 1 *' to from the fixed
    // system time above: the next Jan 1 00:00 (2026-01-01 has already passed).
    return Date.parse('2027-01-01T00:00:00.000Z') - Date.parse('2026-07-10T00:00:00.000Z')
  }

  it('does not fire a far-future cron early, and fires once the full delay elapses', async () => {
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job', '0 0 1 1 *', handler, { timezone: 'UTC' })

    const totalDelayMs = totalDelayToNextJan1()
    expect(totalDelayMs).toBeGreaterThan(NODE_MAX_TIMEOUT_MS) // sanity: this case actually crosses the clamp

    // Advance through several chunk boundaries but stop short of the real target time.
    await vi.advanceTimersByTimeAsync(totalDelayMs - 1_000)
    expect(handler).not.toHaveBeenCalled()

    // Cross the remaining delay: now it must fire, exactly once.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(handler).toHaveBeenCalledTimes(1)

    service.destroy()
  })

  it('kills a far-future cron unscheduled mid-chain — it must never fire', async () => {
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job-cancel', '0 0 1 1 *', handler, { timezone: 'UTC' })

    // Advance partway through the chain — past at least two chunk boundaries (~24.86 days
    // each) — while still well short of the total delay.
    await vi.advanceTimersByTimeAsync(60 * 24 * 60 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()

    await service.unschedule('yearly-job-cancel')

    // Advance well past what would have been the remaining delay.
    await vi.advanceTimersByTimeAsync(200 * 24 * 60 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()

    service.destroy()
  })

  it('ZOMBIE (review P2-1): a cron unscheduled DURING an in-flight run must NOT re-arm itself when that run finishes', async () => {
    // armCronTimeout's post-run callback re-schedules the job object it CAPTURED when the timer was
    // armed. Unscheduling mid-run used to be undone by the finishing run: `jobs` no longer held the
    // job and getJob() returned null, yet the timer kept firing — an admin who DISABLES directory
    // sync would get a sync that keeps calling DingTalk until the process restarts.
    // The existing "unscheduled mid-chain" test above cancels BEFORE the handler ever runs, so it
    // cannot see this; the resurrection happens on the completion path.
    // RED-before (drop the stale-job guard in scheduleCronJob): handler keeps firing after unschedule.
    const service = new SchedulerServiceImpl()
    let releaseRun: (() => void) | null = null
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRun = resolve // park the run IN FLIGHT until we release it
        }),
    )

    await service.schedule('zombie-job', '* * * * *', handler, { timezone: 'UTC' })

    // Fire once — the run is now parked in flight.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(handler).toHaveBeenCalledTimes(1)

    // The admin disables the sync WHILE that run is still in flight.
    await service.unschedule('zombie-job')
    expect(await service.getJob('zombie-job')).toBeNull()

    // The in-flight run now completes → the post-run callback tries to re-schedule the captured job.
    releaseRun!()
    await vi.advanceTimersByTimeAsync(0)

    // It must stay dead. Without the guard the job re-arms and fires every minute forever.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await service.getJob('zombie-job')).toBeNull()

    service.destroy()
  })

  it('STALE ZONE (review P2-1): a timezone change during an in-flight run must not be reverted by that run finishing', async () => {
    // The timezone-edit path is unschedule + schedule (reschedule() cannot update options.timezone in
    // place). If the edit lands mid-run, the finishing run re-arms the OLD job object — silently
    // reverting to the stale zone. It does not self-heal: `jobs` holds the NEW job, so the next
    // applySchedule sees an unchanged timezone and reschedules in place, never rebuilding the
    // expression. Here the replacement must survive, and the stale object must not fire.
    const service = new SchedulerServiceImpl()
    let releaseRun: (() => void) | null = null
    const oldHandler = vi.fn(
      () => new Promise<void>((resolve) => { releaseRun = resolve }),
    )
    const newHandler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('tz-job', '* * * * *', oldHandler, { timezone: 'UTC' })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(oldHandler).toHaveBeenCalledTimes(1) // parked in flight

    // Admin edits the timezone mid-run: unschedule + schedule a NEW job object under the same name.
    await service.unschedule('tz-job')
    await service.schedule('tz-job', '* * * * *', newHandler, { timezone: 'Asia/Shanghai' })

    // The old run finishes and tries to re-arm ITSELF (the stale UTC job object).
    releaseRun!()
    await vi.advanceTimersByTimeAsync(0)

    // The registered job must still be the NEW one, on the NEW zone.
    const registered = await service.getJob('tz-job')
    expect(registered?.options?.timezone).toBe('Asia/Shanghai')

    // And the stale object must never fire again — only the replacement runs.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(oldHandler).toHaveBeenCalledTimes(1)
    expect(newHandler.mock.calls.length).toBeGreaterThan(0)

    service.destroy()
  })

  it('never arms a raw setTimeout delay beyond Node\'s clamp ceiling for a far-future cron', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job-armed-delay', '0 0 1 1 *', handler, { timezone: 'UTC' })

    // At least one chunk timer must have been armed already (the total delay for this
    // case exceeds the ceiling), and every delay ever passed to setTimeout for this run
    // must stay under Node's clamp point — including delays armed later as the chain
    // advances.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of setTimeoutSpy.mock.calls) {
      const delay = call[1]
      if (typeof delay === 'number') {
        expect(delay).toBeLessThanOrEqual(NODE_MAX_TIMEOUT_MS)
      }
    }

    await vi.advanceTimersByTimeAsync(totalDelayToNextJan1() + 2_000)
    expect(handler).toHaveBeenCalledTimes(1)

    for (const call of setTimeoutSpy.mock.calls) {
      const delay = call[1]
      if (typeof delay === 'number') {
        expect(delay).toBeLessThanOrEqual(NODE_MAX_TIMEOUT_MS)
      }
    }

    service.destroy()
    setTimeoutSpy.mockRestore()
  })

  it('does not chunk a near-term cron — delay under the ceiling arms unchanged', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    // Next run is at most a few minutes out — nowhere near the ~24.86-day ceiling.
    await service.schedule('near-term-job', '*/5 * * * *', handler, { timezone: 'UTC' })

    const cronTimeoutCalls = setTimeoutSpy.mock.calls.filter((call) => {
      const delay = call[1]
      return typeof delay === 'number' && delay > 0
    })
    expect(cronTimeoutCalls.length).toBe(1) // single arm, no chunking
    const armedDelay = cronTimeoutCalls[0][1] as number
    expect(armedDelay).toBeLessThanOrEqual(5 * 60 * 1000)

    await vi.advanceTimersByTimeAsync(armedDelay + 1_000)
    expect(handler).toHaveBeenCalledTimes(1)

    service.destroy()
    setTimeoutSpy.mockRestore()
  })
})

// Roadmap §7.8 "Add timezone support": SimpleCronExpression.matches() used to ignore its
// `timezone` constructor argument entirely and match against LOCAL Date getters (host-TZ
// wall clock) regardless of what was passed. These pin the FIX directly against the class
// the directory sync scheduler and its save-time validator both depend on.
describe('SimpleCronExpression timezone (roadmap §7.8)', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    // The UNCHANGED default/'UTC' path still reads LOCAL Date getters (byte-identical to
    // pre-§7.8) — pin the host TZ so that path is deterministic regardless of the
    // machine/CI runner's own zone. The zoned (non-UTC) path below is Intl-based and does
    // NOT depend on this at all — it is asserted BECAUSE it stays correct even with the
    // host pinned to UTC.
    process.env.TZ = 'UTC'
  })

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = originalTz
    }
  })

  // Anchor before both target instants below (2026-07-10T12:00:00Z = 2026-07-10 20:00 in
  // Asia/Shanghai, UTC+8, no DST).
  const ANCHOR = new Date('2026-07-10T12:00:00.000Z')
  const DAILY_2AM_CRON = '0 2 * * *'

  it('the SAME cron fires at DIFFERENT absolute instants for UTC vs a configured IANA zone', () => {
    const utcExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'UTC')
    utcExpr.reset(new Date(ANCHOR))
    const utcNext = utcExpr.next()

    const shanghaiExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'Asia/Shanghai')
    shanghaiExpr.reset(new Date(ANCHOR))
    const shanghaiNext = shanghaiExpr.next()

    // UTC: next 02:00 UTC after the anchor is the following day.
    expect(utcNext?.toISOString()).toBe('2026-07-11T02:00:00.000Z')
    // Asia/Shanghai (UTC+8): next 02:00 LOCAL Shanghai time is 18:00 UTC the day before —
    // exactly 8 hours EARLIER than the UTC case, proving the timezone argument now changes
    // which absolute instant fires (not merely that a string was threaded through).
    expect(shanghaiNext?.toISOString()).toBe('2026-07-10T18:00:00.000Z')

    const deltaMs = utcNext!.getTime() - shanghaiNext!.getTime()
    expect(deltaMs).toBe(8 * 60 * 60 * 1000)
  })

  it('absent timezone still matches LOCAL Date getters — byte-identical to pre-§7.8 (host pinned to UTC)', () => {
    const defaultExpr = new SimpleCronExpression(DAILY_2AM_CRON) // no timezone arg at all
    defaultExpr.reset(new Date(ANCHOR))
    const utcExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'UTC')
    utcExpr.reset(new Date(ANCHOR))

    expect(defaultExpr.next()?.toISOString()).toBe(utcExpr.next()?.toISOString())
  })

  it('an unresolvable/invalid IANA zone falls back to the UTC fast path rather than throwing', () => {
    const junkExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'Not/AZone')
    junkExpr.reset(new Date(ANCHOR))
    const utcExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'UTC')
    utcExpr.reset(new Date(ANCHOR))

    expect(junkExpr.next()?.toISOString()).toBe(utcExpr.next()?.toISOString())
  })

  it("'Etc/UTC' takes the same fast path as 'UTC' (both are the default state)", () => {
    const etcUtcExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'Etc/UTC')
    etcUtcExpr.reset(new Date(ANCHOR))
    const utcExpr = new SimpleCronExpression(DAILY_2AM_CRON, 'UTC')
    utcExpr.reset(new Date(ANCHOR))

    expect(etcUtcExpr.next()?.toISOString()).toBe(utcExpr.next()?.toISOString())
  })
})

// ─── owner review P2 (2026-07-12) ────────────────────────────────────────────────────────────────
//
// These run under a NON-UTC host TZ ON PURPOSE. The suite above pins process.env.TZ='UTC', and that
// pin is exactly why two real bugs survived: on a UTC-clocked runner you cannot tell "real UTC" from
// "whatever the host clock says". The owner measured both under TZ=Asia/Taipei.
describe('SchedulerService P2: firing must not depend on the HOST timezone; DST fall-back fires ONCE', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    process.env.TZ = 'Asia/Taipei' // UTC+8 — a UTC cron must STILL fire at real UTC here
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  const nextFrom = (nowIso: string, cron: string, tz?: string): string | null => {
    vi.setSystemTime(new Date(nowIso))
    const n = new SimpleCronExpression(cron, tz as string).next()
    return n ? n.toISOString() : null
  }

  it('a UTC cron fires at REAL UTC on a non-UTC host — it used to fire on the host clock', () => {
    // RED-before (the local-getter path): on TZ=Asia/Taipei (UTC+8) each of these returned
    // 2026-05-31T18:00:00.000Z — i.e. 02:00 TAIPEI, 8 hours off. directory-sync-scheduler passes
    // 'UTC', so directory sync has never actually run in UTC on a non-UTC host.
    expect(nextFrom('2026-06-01T00:00:00.000Z', '0 2 * * *', 'UTC')).toBe('2026-06-01T02:00:00.000Z')
    expect(nextFrom('2026-06-01T00:00:00.000Z', '0 2 * * *', 'Etc/UTC')).toBe('2026-06-01T02:00:00.000Z')
    expect(nextFrom('2026-06-01T00:00:00.000Z', '0 2 * * *', undefined)).toBe('2026-06-01T02:00:00.000Z')
  })

  it('an invalid zone degrades to REAL UTC, never to the host clock (the runtime must stay deterministic)', () => {
    expect(nextFrom('2026-06-01T00:00:00.000Z', '0 2 * * *', 'Not/AZone')).toBe('2026-06-01T02:00:00.000Z')
  })

  it('a configured zone is genuinely DISTINCT from UTC (positive control — the gate is not just "everything is UTC")', () => {
    // Load-bearing: without it, the assertions above could pass simply because zoning was broken shut.
    expect(nextFrom('2026-06-01T00:00:00.000Z', '0 2 * * *', 'Asia/Shanghai')).toBe('2026-06-01T18:00:00.000Z')
  })

  it('DST fall-back fires ONCE: the repeated wall-clock minute emits the FIRST instant and suppresses the second', () => {
    // 2026-11-01 is America/New_York's fall-back day: 01:30 local exists TWICE — 05:30Z (EDT) and
    // 06:30Z (EST). Both used to match, so the job ran twice, an HOUR apart. The previously-documented
    // mitigation ("the sync lease absorbs it") is false: a lease only blocks a CONCURRENT run.
    vi.setSystemTime(new Date('2026-11-01T04:00:00.000Z'))
    const e = new SimpleCronExpression('30 1 * * *', 'America/New_York')

    expect(e.next()?.toISOString()).toBe('2026-11-01T05:30:00.000Z') // the FIRST occurrence
    // RED-before: this was 2026-11-01T06:30:00.000Z — the SAME wall-clock minute, fired a second time.
    expect(e.next()?.toISOString()).toBe('2026-11-02T06:30:00.000Z') // straight to the next day
  })
})
