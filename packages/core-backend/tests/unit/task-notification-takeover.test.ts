import { describe, expect, it, vi } from 'vitest'
import { createTopicTakeoverReader } from '../../src/services/task-notification-takeover'

describe('persistent takeover reads', () => {
  it('does not reference an absent relation and caches absence for only 15 seconds', async () => {
    let now = 0
    const count = vi.fn(); const query = vi.fn(async () => ({ rows: [{ present: false }] })); const db = { query }
    const read = createTopicTakeoverReader({ now: () => now, count })
    expect(await read(db, 'fixture-a')).toEqual({ state: 'none' })
    now = 14_999; await read(db, 'fixture-b'); expect(query).toHaveBeenCalledTimes(1)
    now = 15_000; await read(db, 'fixture-b'); expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.flat().join(' ')).not.toMatch(/FROM org_notification/)
    expect(count.mock.calls).toEqual([['probe_absent'], ['probe_absent'], ['probe_absent']])
  })
  it.each(['active', 'paused', 'none'])('counts %s and reads the policy even with switches off', async state => {
    const count = vi.fn(); const query = vi.fn().mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValue({ rows: state === 'none' ? [] : [{ state, revision: 2, default_connection_id: null }] })
    const read = createTopicTakeoverReader({ count })
    expect(await read({ query }, 'fixture-b')).toMatchObject({ state })
    expect(count).toHaveBeenCalledWith(state)
    expect(query.mock.calls[1][1]).toEqual(['fixture-b', 'task_reminder'])
  })
  it('invalidates a positive cache on 42P01 and probes again', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockRejectedValueOnce(Object.assign(new Error('hidden'), { code: '42P01' }))
      .mockResolvedValue({ rows: [{ present: false }] })
    const read = createTopicTakeoverReader(); const db = { query }
    expect(await read(db, 'fixture')).toEqual({ state: 'none' })
    expect(await read(db, 'fixture')).toEqual({ state: 'none' })
    expect(query).toHaveBeenCalledTimes(3)
  })
  it.each(['55P03', '57014', '42501', '42703'])('pauses on %s rather than falling back', async code => {
    const count = vi.fn(); const query = vi.fn().mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockRejectedValue(Object.assign(new Error('private driver text'), { code }))
    const read = createTopicTakeoverReader({ count }); const db = { query }
    expect(await read(db, 'fixture')).toEqual({ state: 'unreadable' })
    expect(count).toHaveBeenCalledWith('unreadable')
  })
  it('expires positive probes at five minutes and isolates different executors', async () => {
    let now = 0
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ present: true }] : [] }))
    const read = createTopicTakeoverReader({ now: () => now }); const db = { query }
    await read(db, 'fixture'); now = 299_999; await read(db, 'fixture')
    expect(query.mock.calls.filter(([sql]) => sql.includes('to_regclass'))).toHaveLength(1)
    now = 300_000; await read(db, 'fixture'); await read({ query }, 'fixture')
    expect(query.mock.calls.filter(([sql]) => sql.includes('to_regclass'))).toHaveLength(3)
  })
})
