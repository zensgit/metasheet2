import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  syncDirectoryIntegration: vi.fn(),
  reclaimStaleDirectorySyncRuns: vi.fn(),
}))

const alertDeliveryMocks = vi.hoisted(() => ({
  deliverDirectoryInactiveLinkedAlert: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  // The real directory-sync (loaded below via importOriginal for its error class)
  // imports { query, transaction }; a factory missing either export fails at load.
  transaction: vi.fn(),
}))

vi.mock('../../src/directory/directory-sync-alert-delivery', () => ({
  deliverDirectoryInactiveLinkedAlert: alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert,
}))

vi.mock('../../src/directory/directory-sync', async (importOriginal) => ({
  // DT-HARDEN-05: runScheduledSync discriminates lease conflicts with
  // `error instanceof DirectorySyncInProgressError`. Re-export the REAL class so the
  // skip test below exercises the same discrimination production performs. The old
  // factory omitted it (and reclaimStaleDirectorySyncRuns), leaving the module under
  // test holding `undefined` — the boot sweep threw into its own catch and every
  // DT-HARDEN-05 guard in this file was unfalsifiable.
  DirectorySyncInProgressError: (await importOriginal<typeof import('../../src/directory/directory-sync')>())
    .DirectorySyncInProgressError,
  syncDirectoryIntegration: directoryMocks.syncDirectoryIntegration,
  reclaimStaleDirectorySyncRuns: directoryMocks.reclaimStaleDirectorySyncRuns,
}))

import { DirectorySyncInProgressError } from '../../src/directory/directory-sync'
import {
  refreshDirectoryIntegrationSchedule,
  resetDirectorySyncSchedulerForTests,
  startDirectorySyncScheduler,
} from '../../src/directory/directory-sync-scheduler'

function createSchedulerMock() {
  return {
    schedule: vi.fn(),
    reschedule: vi.fn(),
    unschedule: vi.fn(),
    getJob: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('directory-sync-scheduler', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    directoryMocks.syncDirectoryIntegration.mockReset()
    directoryMocks.reclaimStaleDirectorySyncRuns.mockReset()
    directoryMocks.reclaimStaleDirectorySyncRuns.mockResolvedValue(0)
    alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert.mockReset()
    alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert.mockResolvedValue(false)
    resetDirectorySyncSchedulerForTests()
  })

  it('registers a job for active sync-enabled integrations with a cron schedule and forwards the handler to directory sync', async () => {
    const scheduler = createSchedulerMock()
    scheduler.getJob.mockResolvedValue(null)

    pgMocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '*/5 * * * *',
          },
          {
            id: 'dir-2',
            name: 'Inactive',
            status: 'inactive',
            sync_enabled: true,
            schedule_cron: '*/5 * * * *',
          },
          {
            id: 'dir-3',
            name: 'Disabled',
            status: 'active',
            sync_enabled: false,
            schedule_cron: '*/5 * * * *',
          },
          {
            id: 'dir-4',
            name: 'Blank cron',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '   ',
          },
        ],
      })
      // Fire-time name resolution (P3-2 fix): the schedule callback now re-reads the row
      // instead of closing over `row.name`, so firing it triggers one more `query()` call.
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '*/5 * * * *',
          },
        ],
      })

    await startDirectorySyncScheduler({ scheduler: scheduler as never })

    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM directory_integrations"),
    )
    expect(scheduler.schedule).toHaveBeenCalledTimes(1)
    expect(scheduler.schedule).toHaveBeenCalledWith(
      'directory-sync:dir-1',
      '*/5 * * * *',
      expect.any(Function),
      {
        timezone: 'UTC',
      },
    )
    expect(scheduler.reschedule).not.toHaveBeenCalled()
    expect(scheduler.unschedule).not.toHaveBeenCalled()

    const scheduleHandler = scheduler.schedule.mock.calls[0][2] as () => Promise<void>
    await scheduleHandler()

    expect(directoryMocks.syncDirectoryIntegration).toHaveBeenCalledWith(
      'dir-1',
      'system:directory-sync-scheduler',
      'scheduler',
    )
    // §7.1 offboarding blind-spot digest: fires after a successful scheduled sync, carrying
    // the integration's display name through for the alert message.
    expect(alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert).toHaveBeenCalledWith({
      integrationId: 'dir-1',
      integrationName: 'DingTalk CN',
    })
  })

  it.each([
    {
      label: 'disabled integration',
      row: {
        id: 'dir-disabled',
        name: 'Disabled',
        status: 'active',
        sync_enabled: false,
        schedule_cron: '*/10 * * * *',
      },
    },
    {
      label: 'blank cron',
      row: {
        id: 'dir-blank-cron',
        name: 'Blank cron',
        status: 'active',
        sync_enabled: true,
        schedule_cron: '   ',
      },
    },
  ])('cancels an existing job for a $label during schedule refresh', async ({ row }) => {
    const scheduler = createSchedulerMock()
    scheduler.getJob.mockResolvedValue({ name: `directory-sync:${row.id}` })

    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })

    await startDirectorySyncScheduler({ scheduler: scheduler as never })
    await refreshDirectoryIntegrationSchedule(row.id)

    expect(scheduler.unschedule).toHaveBeenCalledWith(`directory-sync:${row.id}`)
    expect(scheduler.schedule).not.toHaveBeenCalled()
    expect(scheduler.reschedule).not.toHaveBeenCalled()
  })

  // DT-HARDEN-05 gate P2-2: the boot sweep and the in-progress skip are the scheduler's
  // two consumer-side lease guards. Each gets its own pin so a refactor that drops
  // either one goes red instead of degrading silently.
  it('sweeps stale runs once at boot', async () => {
    const scheduler = createSchedulerMock()
    scheduler.getJob.mockResolvedValue(null)
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    await startDirectorySyncScheduler({ scheduler: scheduler as never })

    expect(directoryMocks.reclaimStaleDirectorySyncRuns).toHaveBeenCalledTimes(1)
  })

  it('skips a scheduled tick on a lease conflict but keeps any other failure a job error', async () => {
    const scheduler = createSchedulerMock()
    scheduler.getJob.mockResolvedValue(null)
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'dir-1', name: 'DingTalk CN', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
      ],
    })

    await startDirectorySyncScheduler({ scheduler: scheduler as never })
    const scheduleHandler = scheduler.schedule.mock.calls[0][2] as () => Promise<void>

    directoryMocks.syncDirectoryIntegration.mockRejectedValueOnce(new DirectorySyncInProgressError('run-held'))
    await expect(scheduleHandler()).resolves.toBeUndefined()
    expect(alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert).not.toHaveBeenCalled()

    directoryMocks.syncDirectoryIntegration.mockRejectedValueOnce(new Error('DingTalk 500'))
    await expect(scheduleHandler()).rejects.toThrow('DingTalk 500')
    // §7.1 digest is a POST-run check: neither failure path (lease conflict skip, nor a
    // real sync error) should reach it.
    expect(alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert).not.toHaveBeenCalled()
  })

  // P3-1 (#4053's gate): legacy rows saved before save-time cron validation may hold a
  // schedule_cron the runtime can never fire. applySchedule already unschedules/skips them
  // safely; boot should additionally log ONE structured summary so ops can find them,
  // without ever mutating the offending rows.
  describe('boot-time invalid-cron telemetry (P3-1)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(Logger.prototype, 'warn')
    })

    const summaryCalls = () => warnSpy.mock.calls.filter(([message]) =>
      typeof message === 'string' && message.includes('schedule_cron the runtime can never fire'),
    )

    it('logs one structured summary of invalid-cron integrations found at boot; valid rows still schedule', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)
      scheduler.schedule.mockImplementation((jobName: string) => {
        if (jobName === 'directory-sync:dir-bad') {
          return Promise.reject(new Error('Invalid cron expression: no future execution times'))
        }
        return Promise.resolve({})
      })

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          { id: 'dir-good', name: 'Good', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
          { id: 'dir-bad', name: 'Bad Legacy', status: 'active', sync_enabled: true, schedule_cron: '0 0 30 2 *' },
        ],
      })

      await startDirectorySyncScheduler({ scheduler: scheduler as never })

      expect(summaryCalls()).toHaveLength(1)
      expect(summaryCalls()[0][1]).toMatchObject({
        invalidCronIntegrations: [
          { id: 'dir-bad', name: 'Bad Legacy', cron: '0 0 30 2 *', error: 'Invalid cron expression: no future execution times' },
        ],
      })

      // The valid row is unaffected: it schedules normally and is not part of the summary.
      expect(scheduler.schedule).toHaveBeenCalledWith(
        'directory-sync:dir-good',
        '*/5 * * * *',
        expect.any(Function),
        { timezone: 'UTC' },
      )
      // Read-only: no row mutation of any kind — this scheduler module never issues an
      // UPDATE/DELETE against directory_integrations.
      expect(pgMocks.query).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE|DELETE/i), expect.anything())
    })

    it('does not log an invalid-cron summary when every integration schedules cleanly', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)
      scheduler.schedule.mockResolvedValue({})

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          { id: 'dir-good-1', name: 'Good 1', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
          { id: 'dir-good-2', name: 'Good 2', status: 'active', sync_enabled: true, schedule_cron: '*/10 * * * *' },
        ],
      })

      await startDirectorySyncScheduler({ scheduler: scheduler as never })

      expect(summaryCalls()).toHaveLength(0)
    })
  })

  // P3-2 (#4057's gate): the schedule callback used to close over the mutable `row.name`
  // at job-creation time; reschedule() keeps the same job/handler, so a renamed
  // integration alerted under its stale name until the job was recreated. The fix resolves
  // the display name at fire time instead of carrying it in the closure.
  it('resolves the CURRENT integration name at fire time, even for a handler captured before a rename', async () => {
    const scheduler = createSchedulerMock()
    scheduler.getJob.mockResolvedValue(null) // no existing job yet -> create path

    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'dir-1', name: 'DingTalk CN', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
      ],
    })

    await startDirectorySyncScheduler({ scheduler: scheduler as never })
    // This is the SAME handler reference the reschedule-in-place path below will keep using.
    const scheduleHandler = scheduler.schedule.mock.calls[0][2] as () => Promise<void>

    // Admin renames the integration; the update route's refresh call finds an existing job
    // and takes the reschedule-in-place branch (same handler, only the cron args differ).
    scheduler.getJob.mockResolvedValue({ name: 'directory-sync:dir-1' })
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'dir-1', name: 'DingTalk CN Renamed', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
      ],
    })
    await refreshDirectoryIntegrationSchedule('dir-1')
    expect(scheduler.reschedule).toHaveBeenCalledWith('directory-sync:dir-1', '*/5 * * * *')
    expect(scheduler.schedule).toHaveBeenCalledTimes(1) // reschedule-in-place: no second schedule() call

    // Firing the ORIGINAL handler must reflect the rename, not the name captured at creation.
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'dir-1', name: 'DingTalk CN Renamed', status: 'active', sync_enabled: true, schedule_cron: '*/5 * * * *' },
      ],
    })
    await scheduleHandler()

    expect(alertDeliveryMocks.deliverDirectoryInactiveLinkedAlert).toHaveBeenCalledWith({
      integrationId: 'dir-1',
      integrationName: 'DingTalk CN Renamed',
    })
  })

  // Roadmap §7.8 "Add timezone support".
  describe('per-integration timezone', () => {
    it('passes a configured IANA zone from schedule_timezone into the cron registration', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '0 2 * * *',
            schedule_timezone: 'Asia/Shanghai',
          },
        ],
      })

      await startDirectorySyncScheduler({ scheduler: scheduler as never })

      expect(scheduler.schedule).toHaveBeenCalledWith(
        'directory-sync:dir-1',
        '0 2 * * *',
        expect.any(Function),
        { timezone: 'Asia/Shanghai' },
      )
    })

    // Q6-style runtime defense (mirrors automation-scheduler.ts's resolveCronTimeZone): a
    // persisted-junk timezone (e.g. a direct-DB write that bypassed the save-time validator
    // in admin-directory.ts) must fall back to UTC at the scheduler, never be handed through
    // verbatim or crash the boot sweep.
    it('falls back to UTC when the persisted schedule_timezone is not a real IANA zone', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '*/5 * * * *',
            schedule_timezone: 'Not/AZone',
          },
        ],
      })

      await startDirectorySyncScheduler({ scheduler: scheduler as never })

      expect(scheduler.schedule).toHaveBeenCalledWith(
        'directory-sync:dir-1',
        '*/5 * * * *',
        expect.any(Function),
        { timezone: 'UTC' },
      )
    })

    // `SchedulerServiceImpl.reschedule()` only swaps the cron expression; it has no way to
    // update a job's `options.timezone` in place (see SchedulerService.ts). Without special
    // handling, an admin editing ONLY the timezone (or the timezone alongside the cron) on an
    // already-scheduled integration would silently keep firing under the STALE zone until the
    // process restarts — this pins the fix: detect the change and unschedule+schedule fresh.
    it('unschedules and re-schedules (not reschedule-in-place) when the timezone changes on an existing job', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '0 2 * * *',
            schedule_timezone: null, // UTC
          },
        ],
      })
      await startDirectorySyncScheduler({ scheduler: scheduler as never })
      expect(scheduler.schedule).toHaveBeenCalledTimes(1)

      // Admin now sets a non-UTC timezone (cron unchanged). getJob reflects the job's
      // ORIGINAL options (UTC) — the scheduler mock does not itself track state.
      scheduler.getJob.mockResolvedValue({ name: 'directory-sync:dir-1', options: { timezone: 'UTC' } })
      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '0 2 * * *',
            schedule_timezone: 'Asia/Shanghai',
          },
        ],
      })
      await refreshDirectoryIntegrationSchedule('dir-1')

      expect(scheduler.unschedule).toHaveBeenCalledWith('directory-sync:dir-1')
      expect(scheduler.schedule).toHaveBeenCalledTimes(2)
      expect(scheduler.schedule).toHaveBeenLastCalledWith(
        'directory-sync:dir-1',
        '0 2 * * *',
        expect.any(Function),
        { timezone: 'Asia/Shanghai' },
      )
      // The stale-zone job was dropped, not patched in place.
      expect(scheduler.reschedule).not.toHaveBeenCalled()
    })

    it('keeps the reschedule-in-place path when the resolved timezone is unchanged (cron-only edit)', async () => {
      const scheduler = createSchedulerMock()
      scheduler.getJob.mockResolvedValue(null)

      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '0 2 * * *',
            schedule_timezone: 'Asia/Shanghai',
          },
        ],
      })
      await startDirectorySyncScheduler({ scheduler: scheduler as never })

      // Admin edits ONLY the cron; the resolved timezone ('Asia/Shanghai') is unchanged.
      scheduler.getJob.mockResolvedValue({ name: 'directory-sync:dir-1', options: { timezone: 'Asia/Shanghai' } })
      pgMocks.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dir-1',
            name: 'DingTalk CN',
            status: 'active',
            sync_enabled: true,
            schedule_cron: '0 3 * * *',
            schedule_timezone: 'Asia/Shanghai',
          },
        ],
      })
      await refreshDirectoryIntegrationSchedule('dir-1')

      expect(scheduler.reschedule).toHaveBeenCalledWith('directory-sync:dir-1', '0 3 * * *')
      expect(scheduler.schedule).toHaveBeenCalledTimes(1) // no second schedule() call
      expect(scheduler.unschedule).not.toHaveBeenCalled()
    })
  })
})
