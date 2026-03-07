import { describe, expect, it, vi } from 'vitest'
import {
  clearCopyStatusResetTimer,
  replaceCopyStatusResetTimer,
} from '../src/copyStatusTimer'

describe('copyStatusTimer', () => {
  it('replaces the previous timer before scheduling the next reset', () => {
    const clear = vi.fn()
    const schedule = vi.fn(() => 'timer-2')

    expect(
      replaceCopyStatusResetTimer(
        'timer-1',
        { clear, schedule },
        () => undefined,
        2000,
      ),
    ).toBe('timer-2')

    expect(clear).toHaveBeenCalledWith('timer-1')
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2000)
  })

  it('clears the active timer and normalizes the empty state', () => {
    const clear = vi.fn()

    expect(clearCopyStatusResetTimer('timer-1', { clear })).toBeNull()
    expect(clear).toHaveBeenCalledWith('timer-1')
    expect(clearCopyStatusResetTimer(null, { clear })).toBeNull()
  })
})
