import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/admin/user-recycle', () => ({
  isUserRecycleSweeperDisabled: vi.fn(() => false),
  purgeDueRecycleUsers: vi.fn(async () => 0),
  resolveUserRecycleSweeperIntervalMs: vi.fn(() => 60_000),
}))

import { Logger } from '../../src/core/logger'
import {
  isUserRecycleSweeperDisabled,
  purgeDueRecycleUsers,
  resolveUserRecycleSweeperIntervalMs,
} from '../../src/admin/user-recycle'
import {
  startUserRecycleSweeper,
  stopUserRecycleSweeper,
} from '../../src/admin/user-recycle-scheduler'

describe('user recycle sweeper enable flag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopUserRecycleSweeper()
    delete process.env.USER_RECYCLE_SWEEPER_ENABLED
    vi.mocked(purgeDueRecycleUsers).mockReset()
    vi.mocked(purgeDueRecycleUsers).mockResolvedValue(0)
    vi.mocked(isUserRecycleSweeperDisabled).mockReset()
    vi.mocked(isUserRecycleSweeperDisabled).mockReturnValue(false)
    vi.mocked(resolveUserRecycleSweeperIntervalMs).mockReset()
    vi.mocked(resolveUserRecycleSweeperIntervalMs).mockReturnValue(60_000)
  })

  afterEach(() => {
    stopUserRecycleSweeper()
    vi.useRealTimers()
    delete process.env.USER_RECYCLE_SWEEPER_ENABLED
  })

  test.each([
    ['default', undefined],
    ['false', 'false'],
    ['1', '1'],
    ['TRUE', 'TRUE'],
    ['trailing-space', 'true '],
  ] as const)('%s refuses without tick, interval, or purge', async (_label, value) => {
    if (value === undefined) delete process.env.USER_RECYCLE_SWEEPER_ENABLED
    else process.env.USER_RECYCLE_SWEEPER_ENABLED = value
    expect(startUserRecycleSweeper()).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(purgeDueRecycleUsers).not.toHaveBeenCalled()
    expect(resolveUserRecycleSweeperIntervalMs).not.toHaveBeenCalled()
  })

  test('exact true activates and stop clears the interval', async () => {
    process.env.USER_RECYCLE_SWEEPER_ENABLED = 'true'
    expect(startUserRecycleSweeper()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(purgeDueRecycleUsers).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(purgeDueRecycleUsers).toHaveBeenCalledTimes(2)
    stopUserRecycleSweeper()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(purgeDueRecycleUsers).toHaveBeenCalledTimes(2)
    expect(startUserRecycleSweeper()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(purgeDueRecycleUsers).toHaveBeenCalledTimes(3)
  })

  test('disabled helper still refuses when the enable flag is exact true', async () => {
    process.env.USER_RECYCLE_SWEEPER_ENABLED = 'true'
    vi.mocked(isUserRecycleSweeperDisabled).mockReturnValue(true)
    expect(startUserRecycleSweeper()).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(purgeDueRecycleUsers).not.toHaveBeenCalled()
    expect(resolveUserRecycleSweeperIntervalMs).not.toHaveBeenCalled()
  })

  test('tick failure log does not include the error message', async () => {
    process.env.USER_RECYCLE_SWEEPER_ENABLED = 'true'
    const secret = 'db-secret-should-not-leak'
    vi.mocked(purgeDueRecycleUsers).mockRejectedValueOnce(new Error(secret))
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    expect(startUserRecycleSweeper()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret)
    errorSpy.mockRestore()
  })
})
