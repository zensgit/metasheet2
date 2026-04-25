import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalSlaScheduler } from '../../src/services/ApprovalSlaScheduler'

describe('ApprovalSlaScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('invokes checkSlaBreaches and the onBreach hook with breached ids', async () => {
    const checkSlaBreaches = vi.fn<(now: Date) => Promise<string[]>>().mockResolvedValue(['apr-1', 'apr-2'])
    const onBreach = vi.fn().mockResolvedValue(undefined)

    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
      intervalMs: 60_000,
      onBreach,
    })

    const breached = await scheduler.tick(new Date('2026-04-25T10:00:00Z'))

    expect(breached).toEqual(['apr-1', 'apr-2'])
    expect(checkSlaBreaches).toHaveBeenCalledTimes(1)
    expect(onBreach).toHaveBeenCalledWith(['apr-1', 'apr-2'])
  })

  it('swallows checkSlaBreaches errors and returns an empty list', async () => {
    const checkSlaBreaches = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
    })
    const breached = await scheduler.tick()
    expect(breached).toEqual([])
  })

  it('prevents reentrant ticks from overlapping', async () => {
    let resolveFirst: ((v: string[]) => void) | null = null
    const checkSlaBreaches = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue([])

    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
    })

    const firstPromise = scheduler.tick()
    const secondResult = await scheduler.tick()
    expect(secondResult).toEqual([])
    expect(checkSlaBreaches).toHaveBeenCalledTimes(1)

    resolveFirst?.([])
    await firstPromise
  })
})
