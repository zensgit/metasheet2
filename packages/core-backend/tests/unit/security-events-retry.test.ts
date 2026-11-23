import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventRetryBuffer } from '../../src/security-events/retry-buffer'
import { validateEvent, type EventCandidate, type ScopeAuthority } from '../../src/security-events/validation'

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
it('T20 retains the frozen validated snapshot, not the caller objects or a later read of them', async () => {
  const buffer = new EventRetryBuffer(() => 0)
  let reads = 0
  const facts = {} as Record<string, number>
  // A count that reads 1 when validated and 7 on any later read: only the checked value may be retried.
  Object.defineProperty(facts, 'affected_count', { enumerable: true, get: () => (++reads === 1 ? 1 : 7) })
  const input: EventCandidate = { id: randomUUID(), producer: 'auth', event_type: 'auth.password_changed', source_kind: 'auth_operation', source_id: randomUUID(), source_step: 'password_changed', actor_kind: 'system', actor_user_id: null, subject_user_id: null, target_kind: null, target_id: null, reason_code: null, record_origin: 'live', occurred_at: '2026-11-22T00:00:00Z', facts }
  const authority = { kind: 'platform', orgId: null } as { kind: ScopeAuthority['kind']; orgId: string | null }
  expect(buffer.offer(input, authority).retained).toBe(true)
  expect(buffer.offer({ ...input, id: randomUUID(), facts: { affected_count: -0 } }, authority).retained).toBe(true)
  // The first write fails; the caller then changes its own objects before the retry.
  input.source_step = 'changed'
  authority.orgId = 'changed'
  const write = vi.fn(async (_candidate: EventCandidate, _authority: ScopeAuthority) => ({ recorded: false }))
  await buffer.retryOne(write)
  await buffer.retryOne(write)
  const [[first, scope], [second]] = write.mock.calls
  expect(first.facts).toEqual({ affected_count: 1 })
  expect(first.source_step).toBe('password_changed')
  expect(scope).toEqual({ kind: 'platform', orgId: null })
  expect(Object.is(second.facts.affected_count, 0)).toBe(true)
  for (const value of [first, first.facts, scope, second, second.facts]) expect(Object.isFrozen(value)).toBe(true)
  expect(Object.keys(first).sort()).toEqual(Object.keys(input).sort())
  expect(validateEvent(first, scope)).toMatchObject({ scope_kind: 'system', facts: { affected_count: 1 } })
})
