import { describe, expect, it } from 'vitest'
import { decideRoute, RESOLVE_EXCLUSIONS, ROUTER_VERSION, type RouteCandidate, type RouteInputs } from '../../src/notifications/router'

function candidate(): RouteCandidate {
  return { provider: 'dingtalk', rank: 0, inProfile: true, adapterAvailable: true, verificationLevel: 'token',
    capability: { effective: true, revision: 1, witness: 'a'.repeat(64) },
    resolution: { ok: true, target: { routeSource: 'user_primary', connectionId: 'connection', endpointId: 'endpoint',
      endpointRevision: 1, proofId: 'proof', addressKind: 'userid', addressWitness: 'b'.repeat(64), proofWitness: 'c'.repeat(64),
      boundTenant: 'tenant', boundAppScope: 'scope' } } }
}
function inputs(): RouteInputs {
  return { state: 'active', policyRevision: 2, permitted: true, preference: null,
    now: new Date('2026-01-01T12:00:00Z'), candidates: [candidate()] }
}

describe('routing allowed-set conjunction and decision order', () => {
  it('pins the router version and all 19 resolver failure mapping keys independently', () => {
    expect(ROUTER_VERSION).toBe(1)
    const codes = ['connection_not_found', 'connection_inactive', 'provider_not_registered', 'proof_kind_unavailable',
      'proof_missing', 'proof_not_linked', 'proof_wrong_user', 'proof_ambiguous', 'proof_account_inactive', 'proof_changed',
      'proof_assurance_insufficient', 'address_missing', 'address_unusable', 'address_kind_not_derivable',
      'address_bound_on_other_connection', 'scope_unproven', 'scope_changed', 'user_not_active_member', 'endpoint_not_found']
    expect(new Set(codes).size).toBe(19)
    expect(Object.keys(RESOLVE_EXCLUSIONS).sort()).toEqual(codes.sort())
    for (const code of codes) expect(RESOLVE_EXCLUSIONS[code]).toBe(`target_${code}`)
  })
  it.each(['none', 'paused', 'unreadable'] as const)('defers %s before considering a valid target', state => {
    expect(decideRoute({ ...inputs(), state })).toEqual({ kind: 'defer', code: 'topic_not_active' })
  })
  it('routes with affirmative evidence and no address fields', () => {
    const decision = decideRoute(inputs())
    expect(decision).toMatchObject({ kind: 'route', policyRevision: 2, preferenceRevision: null, targets: [{ verificationLevel: 'token' }] })
    expect(JSON.stringify(decision)).not.toContain('"address":')
  })
  it('business permission precedes personal preferences', () => {
    expect(decideRoute({ ...inputs(), permitted: false, preference: { enabled: false, revision: 3, quietHours: null } }))
      .toMatchObject({ kind: 'skip', code: 'recipient_not_permitted' })
  })
  it('never overrides a personal opt-out', () => {
    expect(decideRoute({ ...inputs(), preference: { enabled: false, revision: 3, quietHours: null } }))
      .toMatchObject({ kind: 'skip', code: 'user_opted_out', preferenceRevision: 3 })
  })
  it('records quiet suppression rather than delaying a reminder', () => {
    expect(decideRoute({ ...inputs(), preference: { enabled: true, revision: 3,
      quietHours: { start: '11:00', end: '13:00', timeZone: 'UTC' } } })).toMatchObject({ kind: 'skip', code: 'quiet_hours' })
  })
  it.each(['not_enabled', 'integration_missing', 'org_mismatch', 'state_mismatch', 'scope_changed', 'unsupported',
    'implementation_missing', 'integration_inactive', 'provider_not_registered', 'governed_by_legacy_path'] as const)
  ('excludes capability rejection %s', reason => {
    const c = candidate(); c.capability = { effective: false, reason }
    expect(decideRoute({ ...inputs(), candidates: [c] })).toMatchObject({ kind: 'skip', code: 'no_valid_target', excluded: [{ code: `connection_${reason}` }] })
  })
  it.each(['switch_off', 'schema_unavailable', 'read_failed', 'transaction_required', 'input_invalid'] as const)
  ('keeps %s retryable instead of persisting a skip', reason => {
    const c = candidate(); c.capability = { effective: false, reason }
    expect(decideRoute({ ...inputs(), candidates: [c] })).toEqual({ kind: 'defer', code: reason === 'input_invalid' ? 'routed_branch_error' : 'capability_unreadable' })
  })
  it.each(['verification', 'adapter', 'profile', 'endpoint'] as const)('requires %s evidence', item => {
    const c = candidate()
    if (item === 'verification') c.verificationLevel = null
    if (item === 'adapter') c.adapterAvailable = false
    if (item === 'profile') c.inProfile = false
    if (item === 'endpoint') c.resolution = { ok: false, code: 'target_endpoint_stale' }
    expect(decideRoute({ ...inputs(), candidates: [c] })).toMatchObject({ kind: 'skip', code: 'no_valid_target', excluded: [{ code: {
      verification: 'connection_not_verified', adapter: 'adapter_unavailable', profile: 'target_not_in_topic_profile', endpoint: 'target_endpoint_stale',
    }[item] }] })
  })
  it('does not route a stored same-provider fallback', () => {
    const first = candidate(); const second = candidate(); second.rank = 1
    first.capability = { effective: false, reason: 'not_enabled' }
    expect(decideRoute({ ...inputs(), candidates: [first, second] })).toMatchObject({ kind: 'skip', code: 'no_valid_target',
      excluded: [{ code: 'connection_not_enabled' }, { code: 'target_fallback_same_provider' }] })
  })
  it('keeps a test-only different-provider backup ordered after the primary', () => {
    const second = candidate(); second.provider = 'fixture'; second.rank = 1
    expect(decideRoute({ ...inputs(), candidates: [candidate(), second] })).toMatchObject({ kind: 'route', targets: [expect.any(Object), expect.any(Object)] })
  })
  it('no explicit or default candidate means a terminal no_route', () => {
    expect(decideRoute({ ...inputs(), candidates: [] })).toMatchObject({ kind: 'skip', code: 'no_route' })
  })
  it('does not persist any target after a background contract error, even alongside a valid provider', () => {
    const bad = candidate(); bad.provider = 'fixture'; bad.rank = 1
    bad.capability = { effective: false, reason: 'input_invalid' }
    expect(decideRoute({ ...inputs(), candidates: [candidate(), bad] })).toEqual({ kind: 'defer', code: 'routed_branch_error' })
  })
  it('is deterministic for identical inputs and retains at most two targets', () => {
    const input = { ...inputs(), candidates: [candidate(), candidate(), candidate()] }
    const a = decideRoute(input); const b = decideRoute(input)
    expect(a).toEqual(b)
    expect(a.kind === 'route' && a.targets.length).toBe(2)
  })

})
