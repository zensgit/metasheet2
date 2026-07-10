import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  syncDirectoryIntegration: vi.fn(),
  reclaimStaleDirectorySyncRuns: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  // The real directory-sync (loaded below via importOriginal for its error class)
  // imports { query, transaction }; a factory missing either export fails at load.
  transaction: vi.fn(),
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
    resetDirectorySyncSchedulerForTests()
  })

  it('registers a job for active sync-enabled integrations with a cron schedule and forwards the handler to directory sync', async () => {
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

    directoryMocks.syncDirectoryIntegration.mockRejectedValueOnce(new Error('DingTalk 500'))
    await expect(scheduleHandler()).rejects.toThrow('DingTalk 500')
  })
})
