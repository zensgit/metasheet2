import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LOOKUP_TIMEOUT_MS,
  useDingTalkPersonRecipientStatus,
} from '../src/multitable/composables/useDingTalkPersonRecipientStatus'
import type { DingTalkPersonRecipientStatus } from '../src/multitable/types'

// 客户反馈 2026-10-21 item 1 (review round 2, 3b + timeout): the DingTalk person-recipient preflight state.

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const linked = (userId: string): DingTalkPersonRecipientStatus => ({ userId, exists: true, active: true, dingtalkLinked: true })

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useDingTalkPersonRecipientStatus', () => {
  it('drops an answer that arrives after reset() (the editor was reopened meanwhile)', async () => {
    const held = deferred<DingTalkPersonRecipientStatus[]>()
    const lookup = vi.fn(() => held.promise)
    const status = useDingTalkPersonRecipientStatus({ client: () => ({ getDingTalkPersonRecipientStatus: lookup }), sheetId: () => 'sheet_1' })

    const first = status.check(['user_fake_a'])
    await settle()
    // the request is really in flight when the editor reopens
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(status.stateOf('user_fake_a')).toBe('checking')

    status.reset()
    held.resolve([linked('user_fake_a')])
    await first

    // the stale answer must not land in the new open's state
    expect(status.stateOf('user_fake_a')).toBe('unknown')
    expect(status.statuses.value).toEqual({})
    expect(status.pending.value).toEqual({})
  })

  it('a reopened editor does not wait for the request of the previous open', async () => {
    const held = deferred<DingTalkPersonRecipientStatus[]>()
    const lookup = vi.fn()
      .mockImplementationOnce(() => held.promise)
      .mockImplementation(async (_sheetId: string, ids: string[]) => ids.map(linked))
    const status = useDingTalkPersonRecipientStatus({ client: () => ({ getDingTalkPersonRecipientStatus: lookup }), sheetId: () => 'sheet_1' })

    void status.check(['user_fake_a'])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(1)
    status.reset()
    await status.check(['user_fake_b'])
    expect(status.stateOf('user_fake_b')).toBe('ready')
    held.resolve([linked('user_fake_a')])
    await settle()
    expect(status.stateOf('user_fake_a')).toBe('unknown')
  })

  it('abandons a hung lookup after the timeout: the id reads "failed", the signal is aborted, the queue moves on', async () => {
    vi.useFakeTimers()
    let seenSignal: AbortSignal | undefined
    const lookup = vi.fn()
      .mockImplementationOnce((_sheetId: string, _ids: string[], options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal
        return new Promise<DingTalkPersonRecipientStatus[]>(() => {})
      })
      .mockImplementation(async (_sheetId: string, ids: string[]) => ids.map(linked))
    const status = useDingTalkPersonRecipientStatus({ client: () => ({ getDingTalkPersonRecipientStatus: lookup }), sheetId: () => 'sheet_1' })

    const first = status.check(['user_fake_a'])
    const second = status.check(['user_fake_b'])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(status.stateOf('user_fake_a')).toBe('checking')

    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS)
    await first
    await second

    expect(seenSignal?.aborted).toBe(true)
    expect(status.stateOf('user_fake_a')).toBe('failed')
    expect(status.counts(['user_fake_a', 'user_fake_b'])).toEqual({ notLinked: 0, inactive: 0, notFound: 0, checking: 0, unchecked: 1 })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(status.stateOf('user_fake_b')).toBe('ready')
  })

  it('a failed id is not re-sent until the retry wait has passed', async () => {
    let clock = 1_000_000
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockImplementation(async (_sheetId: string, ids: string[]) => ids.map(linked))
    const status = useDingTalkPersonRecipientStatus({
      client: () => ({ getDingTalkPersonRecipientStatus: lookup }),
      sheetId: () => 'sheet_1',
      now: () => clock,
    })

    await status.check(['user_fake_a'])
    expect(status.stateOf('user_fake_a')).toBe('failed')
    await status.check(['user_fake_a'])
    expect(lookup).toHaveBeenCalledTimes(1)

    clock += 15_001
    await status.check(['user_fake_a'])
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(status.stateOf('user_fake_a')).toBe('ready')
  })
})
