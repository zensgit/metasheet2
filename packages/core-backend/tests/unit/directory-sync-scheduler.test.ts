import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  syncDirectoryIntegration: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

vi.mock('../../src/directory/directory-sync', () => ({
  syncDirectoryIntegration: directoryMocks.syncDirectoryIntegration,
}))

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
})
