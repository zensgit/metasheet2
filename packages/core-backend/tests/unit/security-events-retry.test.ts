import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventRetryBuffer } from '../../src/security-events/retry-buffer'
import type { EventCandidate } from '../../src/security-events/validation'

let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_RETRY=' + assertionCount) })
it('T20 transient W3 retry freezes payload, caps at 1000, expires at 60s and attempts at most once', async () => {
  let now = 0
  const buffer = new EventRetryBuffer(() => now)
  const input: EventCandidate = { id: randomUUID(), producer: 'auth', event_type: 'auth.session_registered', source_kind: 'auth_operation', source_id: randomUUID(), source_step: 'password', actor_kind: 'user', actor_user_id: 'local-user', subject_user_id: null, target_kind: null, target_id: null, reason_code: null, record_origin: 'live', occurred_at: '2026-11-22T00:00:00Z', facts: {} }
  const authority = { kind: 'session' as const, orgId: 'B' }
  for (let i = 0; i < 1000; i++) expect(buffer.offer(input, authority).retained).toBe(true)
  expect(buffer.offer(input, authority)).toEqual({ retained: false, count_unknown: true })
  const source = input.source_id
  input.source_id = 'invalid mutation'
  const write = vi.fn(async (_candidate: EventCandidate) => ({ recorded: false }))
  expect(await buffer.retryOne(write)).toEqual({ attempted: true, count_unknown: true })
  expect(write.mock.calls[0][0].source_id).toBe(source)
  expect(buffer.size).toBe(999)
  now = 60000
  expect(buffer.size).toBe(0)
  expect((await buffer.retryOne(write)).attempted).toBe(false)
  expect(write).toHaveBeenCalledOnce()
  expect(buffer.offer(input, authority).retained).toBe(false)
})
