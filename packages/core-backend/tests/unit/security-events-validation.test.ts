import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import types from '../fixtures/security-events/registered-types.json'
import { EVENT_REGISTRY, eventRule, type EventType } from '../../src/security-events/registry'
import { auditSource, encodeSource, resolveEventScope, validateEvent, sameEventIdentity, writeFailure, EventIdentityConflict, type EventCandidate, type ScopeAuthority } from '../../src/security-events/validation'
import { estimateSteadyState, eventDto } from '../../src/security-events/repository'

let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_VALIDATION=' + assertionCount) })
function candidate(type: EventType): EventCandidate {
  const rule = eventRule(type)!
  return { id: randomUUID(), producer: rule.producer, event_type: type, source_kind: rule.sourceKinds[0], source_id: randomUUID(), source_step: rule.steps[0],
    actor_kind: 'system', actor_user_id: null, subject_user_id: null, target_kind: null, target_id: null, reason_code: null,
    record_origin: 'live', occurred_at: '2026-11-22T00:00:00.123456Z', facts: {} }
}
function valid(type: EventType, orgId: string | null): [EventCandidate, ScopeAuthority] {
  const input = candidate(type), rule = eventRule(type)!
  if (input.source_kind === 'request_window') { input.actor_kind = 'anonymous'; input.reason_code = 'refusal_window'; input.facts = { attempt_count: 2 } }
  if (type === 'directory.sync_failed') input.reason_code = 'sync_failed'
  if (type === 'directory.projection_observed') {
    input.source_step = orgId === null ? 'governance_roles' : 'membership_active'
    input.source_kind = orgId === null ? 'sync_run' : 'runtime_probe'
    input.subject_user_id = orgId === null ? null : 'local-user'
    input.facts = orgId === null ? { affected_count: 2 } : {}
    if (orgId !== null) input.source_id = encodeSource(['local-user', orgId, '2026-11-22'])
  }
  if (type === 'deprovision.strict_grant_revoked') { input.facts = { grant_revoked: true }; input.subject_user_id = 'local-user'; input.source_id = encodeSource([randomUUID(), randomUUID(), orgId!, 'local-user']) }
  if (type === 'admin_grant.enabled') input.source_id = auditSource('42', '1732233600123456')
  if (type === 'system.event_store_gap') { input.facts = { count_unknown: true }; input.reason_code = 'startup_tail_unverified' }
  return [input, { kind: rule.authority, orgId, ...(rule.authority === 'deprovision' ? { parentOrgId: orgId } : {}) }]
}

describe('E1-A registry and values-free boundary', () => {
  it('T38 registers exactly the 92 locked types and scopes', () => {
    expect(Object.keys(EVENT_REGISTRY).sort()).toEqual(Object.keys(types).sort())
    for (const [type, scopes] of Object.entries(types)) expect([...eventRule(type)!.scopes].sort()).toEqual([...scopes].sort())
  })
  for (const [type, scopes] of Object.entries(types)) for (const scope of scopes) {
    it(`T22 ${type} ${scope}: permits its registered authority and rejects substituted scope`, () => {
      const args = valid(type as EventType, scope === 'system' ? null : 'org-B')
      expect(validateEvent(...args).scope_kind).toBe(scope)
      expect(() => validateEvent(args[0], { kind: 'untrusted_request' as never, orgId: 'org-B' })).toThrow('E1_WRITE_UNAVAILABLE')
      const alternate = scope === 'system' ? 'organization' : 'system'
      if (!scopes.includes(alternate)) expect(() => validateEvent(args[0], { ...args[1], orgId: alternate === 'system' ? null : 'org-B', parentOrgId: null })).toThrow()
    })
  }
  it('T02 rejects arbitrary payload keys, types, source kinds, steps, actor and target values', () => {
    const [input, authority] = valid('auth.password_changed', null)
    for (const patch of [{ body: 'secret' }, { event_type: 'unknown.valid' }, { source_kind: 'session' }, { source_step: 'user-supplied' }, { actor_user_id: 'user' }, { target_kind: 'session', target_id: randomUUID() }, { source_id: 'person@example.test' }, { reason_code: 'raw_error' }]) {
      expect(() => validateEvent({ ...input, ...patch } as EventCandidate, authority)).toThrow('E1_WRITE_UNAVAILABLE')
    }
    for (const key of ['password', 'token', 'digest', 'fingerprint', 'email', 'ip', 'recipient', 'webhook', 'body', 'raw', '__proto__']) {
      expect(() => validateEvent({ ...input, facts: JSON.parse(`{"${key}":"synthetic"}`) }, authority)).toThrow()
    }
  })
  it('T02 rejects nested, boolean counts, negative, fractional, overflow and unknown facts', () => {
    const [input, authority] = valid('directory.projection_observed', null)
    for (const value of [null, {}, [], true, -1, 0.5, 2147483648, NaN, Infinity, '1']) {
      expect(() => validateEvent({ ...input, facts: { affected_count: value } as never }, authority)).toThrow()
    }
    expect(validateEvent({ ...input, facts: { affected_count: 2147483647 } }, authority).facts.affected_count).toBe(2147483647)
  })
  it('T03 keeps text actors and exact audit microseconds; source encoding is unambiguous and bounded', () => {
    const [input, authority] = valid('auth.password_changed', null)
    expect(validateEvent({ ...input, actor_kind: 'user', actor_user_id: 'text:user:alpha' }, authority).actor_user_id).toBe('text:user:alpha')
    expect(auditSource('42', '1732233600123456')).not.toBe(auditSource('42', '1732233600123457'))
    expect(encodeSource(['a:b', 'c'])).not.toBe(encodeSource(['a', 'b:c']))
    expect(encodeSource(['😀'])).toBe('4:😀')
    expect(Buffer.byteLength(encodeSource(['😀'.repeat(128), '😀'.repeat(128), randomUUID()]))).toBeLessThanOrEqual(2048)
    expect(() => encodeSource(['x'.repeat(129)])).toThrow()
    expect(() => encodeSource(Array(10).fill('a'.repeat(128)))).toThrow()
    expect(() => validateEvent({ ...input, actor_kind: 'user', actor_user_id: 'person@example.test' }, authority)).toThrow()
  })
  it('AUTH-25 NULL effect org inherits only its verified parent; strict-only needs no legacy parent', () => {
    expect(resolveEventScope('deprovision.effect_applied', 'applied', { kind: 'deprovision', orgId: null, parentOrgId: 'B' })).toEqual({ scope_kind: 'organization', org_id: 'B' })
    for (const authority of [{ kind: 'deprovision', orgId: null }, { kind: 'deprovision', orgId: 'A', parentOrgId: 'B' }]) expect(() => resolveEventScope('deprovision.effect_applied', 'applied', authority as ScopeAuthority)).toThrow()
    expect(resolveEventScope('deprovision.strict_grant_revoked', 'strict_revoked', { kind: 'deprovision', orgId: 'B' }).org_id).toBe('B')
  })
  it('P3-g reserves organization/day scan completion and organization summaries without claiming a grant', () => {
    const [input, authority] = valid('directory.projection_observed', 'B')
    for (const step of ['scan_completed', 'organization_daily_summary']) {
      const row = validateEvent({ ...input, source_step: step, source_id: encodeSource(['B', '2026-11-22']), subject_user_id: null, facts: { affected_count: 0 } }, authority)
      expect(eventDto(row).time_semantics).toBe('observed_state_not_grant_time')
      expect(() => validateEvent({ ...input, source_step: step, source_id: encodeSource(['B', '2026-11-22']), subject_user_id: null, facts: { affected_count: 0 } }, { ...authority, orgId: null })).toThrow()
    }
  })
  it('T04 immutable identity conflicts while preserving first timestamps, origin and retention', () => {
    const row = validateEvent(...valid('auth.password_changed', null))
    expect(sameEventIdentity({ ...row, id: randomUUID(), occurred_at: 'old', record_origin: 'backfill', recorded_at: 'old', expires_at: 'old' }, row)).toBe(true)
    for (const field of ['org_id', 'actor_user_id', 'subject_user_id', 'outcome', 'facts', 'target_kind', 'target_id', 'reason_code', 'actor_kind']) expect(sameEventIdentity({ ...row, [field]: 'changed' }, row)).toBe(false)
  })
  it('T02 unknown DTO drops unknown facts and raw non-column payloads', () => {
    const dto = eventDto({ event_type: 'new.future', facts: { token: 'secret' }, response: 'secret', lease_id: 'secret', source_step: 'secret', reason_code: 'secret' })
    expect(JSON.stringify(dto)).not.toContain('secret')
    expect(dto.event_type).toBe('unknown_event_type')
    expect(dto.facts).toEqual({})
  })
  it('T18/T02 known probe DTO retains sample limits while dropping raw sample rows', () => {
    const [input, authority] = valid('encrypted_store.undecryptable', null)
    const row = validateEvent({ ...input, facts: { affected_count: 2, sampled: true, truncated: true } }, authority)
    const dto = eventDto({ ...row, facts: { ...row.facts, raw: 'synthetic-secret' }, sample_rows: ['synthetic-secret'] })
    expect(dto.facts).toEqual({ affected_count: 2, sampled: true, truncated: true })
    expect(dto).not.toHaveProperty('sample_rows')
    expect(JSON.stringify(dto)).not.toContain('synthetic-secret')
  })
  it('T35 steady-state accumulation N=20000: 365/90 and 90/90, plus session sensitivity', () => {
    expect(estimateSteadyState(20000, 365, 90, 0)).toEqual({ dailyObservations: 40000, dailySessions: 0, events: 14600000, deliveries: 3600000, total: 18200000 })
    expect(estimateSteadyState(20000, 90, 90, 0).total).toBe(7200000)
    expect(estimateSteadyState(20000, 365, 90, 4).total).toBe(54600000)
    expect(estimateSteadyState(20000, 90, 90, 4).total).toBe(21600000)
  })
})

for (const value of ['https://hooks.example.test/abc', '192.0.2.1', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln']) {
  it(`T02 rejects sensitive identifier shape ${value.split('.')[0]}`, () => {
    const [input, authority] = valid('auth.session_registered', 'B')
    for (const patch of [
      { actor_kind: 'user', actor_user_id: value }, { subject_user_id: value },
      { target_kind: 'user', target_id: value },
      { source_id: `${Buffer.byteLength(value)}:${value}` },
    ]) expect(() => validateEvent({ ...input, ...patch } as EventCandidate, authority)).toThrow('E1_WRITE_UNAVAILABLE')
    expect(() => validateEvent(input, { ...authority, orgId: value })).toThrow('E1_WRITE_UNAVAILABLE')
  })
}
it('T04 preserves the identity-conflict diagnostic through error normalization', () => {
  expect(writeFailure(new EventIdentityConflict())).toBeInstanceOf(EventIdentityConflict)
})
it('T22 refusal windows are anonymous multi-subject aggregates', () => {
  const [input, authority] = valid('auth.login_denied', 'B')
  expect(validateEvent(input, authority).actor_kind).toBe('anonymous')
  for (const patch of [
    { actor_kind: 'system' }, { actor_kind: 'user', actor_user_id: 'local-user' },
    { subject_user_id: 'local-user' }, { target_kind: 'user', target_id: 'local-user' },
  ]) expect(() => validateEvent({ ...input, ...patch } as EventCandidate, authority)).toThrow('E1_WRITE_UNAVAILABLE')
})
it('T22 projection scope is bound to the step independently of source-shape validation', () => {
  const [input] = valid('directory.projection_observed', 'B')
  const governanceAsOrg = { ...input, source_step: 'governance_roles', source_id: encodeSource(['account', 'local-user', 'B', '2026-11-22']) }
  expect(() => validateEvent(governanceAsOrg, { kind: 'projection', orgId: 'B' })).toThrow('E1_WRITE_UNAVAILABLE')
  const memberAsSystem = { ...input, source_kind: 'sync_run', source_id: randomUUID(), subject_user_id: null, facts: { affected_count: 4 } }
  expect(() => validateEvent(memberAsSystem, { kind: 'projection', orgId: null })).toThrow('E1_WRITE_UNAVAILABLE')
})
for (const [type, steps, expected] of [
  ['auth.session_revocation_applied', ['all_sessions', 'specified_session'], 'system'],
  ['auth.session_registered', ['strict', 'refresh_strict', 'session_org_strict', 'session_org_ordinary'], 'organization'],
] as const) for (const step of steps) {
  it(`T22 ${type}:${step} permits only ${expected}`, () => {
    const [input, authority] = valid(type, expected === 'system' ? null : 'B')
    input.source_step = step
    expect(validateEvent(input, authority).scope_kind).toBe(expected)
    expect(() => validateEvent(input, { ...authority, orgId: expected === 'system' ? 'B' : null })).toThrow('E1_WRITE_UNAVAILABLE')
  })
}
it('T03 rejects leading-zero length prefixes for an otherwise identical source', () => {
  const [input, authority] = valid('directory.projection_observed', 'B')
  const summary = { ...input, source_step: 'scan_completed', subject_user_id: null, facts: { affected_count: 0 } }
  expect(validateEvent({ ...summary, source_id: '1:B10:2026-11-22' }, authority).source_id).toBe('1:B10:2026-11-22')
  expect(() => validateEvent({ ...summary, source_id: '01:B010:2026-11-22' }, authority)).toThrow('E1_WRITE_UNAVAILABLE')
})
describe('E1-A one snapshot of each event', () => {
  it('T03 each top-level value is read once and the returned value is the checked one', () => {
    const [input, authority] = valid('auth.password_changed', null)
    const reads: Record<string, number> = {}
    const later = { source_step: 'free text', source_id: 'not a source', actor_kind: 'user' }
    const candidate = {} as EventCandidate
    for (const [key, value] of Object.entries(input)) {
      Object.defineProperty(candidate, key, { enumerable: true, get: () => { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? value : (later as Record<string, unknown>)[key] ?? value } })
    }
    const row = validateEvent(candidate, authority)
    expect(row.source_step).toBe(input.source_step)
    expect(row.source_id).toBe(input.source_id)
    expect(row.actor_kind).toBe('system')
    expect(Object.values(reads).every(count => count === 1)).toBe(true)
    expect(Object.keys(reads).sort()).toEqual(Object.keys(input).sort())
  })
})
