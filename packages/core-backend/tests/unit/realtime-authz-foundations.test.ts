import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import {
  ADMISSION_BEFORE_FIRST_READ,
  decideRealtimeAdmission,
  type AdmissionInput,
  type ListenerState,
} from '../../src/realtime-authz/admission'
import {
  ORDINARY_SESSION_AUTHORITY_SQL,
  ORDINARY_SUBJECT_AUTHORITY_SQL,
  createRealtimeAuthorityReader,
  type AuthorityQuery,
} from '../../src/realtime-authz/authority-read'
import { createRealtimeDiagnostics } from '../../src/realtime-authz/diagnostics'
import {
  enablementRecordNotDefinedInThisBuild,
  probeRealtimeInstallation,
  type EnablementGeneration,
  type ProbeCaller,
  type RealtimeInstallationFacts,
  type StrictScopeGeneration,
} from '../../src/realtime-authz/installation-probe'
import {
  REALTIME_REVALIDATION_FLAG,
  isRealtimeRevalidationEnabled,
  readExactSwitch,
  type ExactSwitchReading,
} from '../../src/realtime-authz/revalidation-flag'
import {
  bindVerifiedSessionClaims,
  bindingKey,
  type RealtimeSessionBinding,
  type SessionClassifier,
} from '../../src/realtime-authz/session-binding'
import { adminRealtimeDiagnosticsRouter } from '../../src/routes/admin-realtime-diagnostics'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

const classify: SessionClassifier = (payload) => {
  const claims = payload as Record<string, unknown>
  const xs = typeof claims.sid === 'string' && claims.sid.startsWith('xs.')
  const xa = Object.prototype.hasOwnProperty.call(claims, 'xa')
  if (!xs && !xa) return 'standard'
  if (xs && xa && claims.xa === true) return 'strict'
  return 'conflict'
}

function ordinary(overrides: Record<string, unknown> = {}): RealtimeSessionBinding {
  const binding = bindVerifiedSessionClaims({ userId: 'u1', iat: 1000, exp: 9_999_999_999, ...overrides }, classify)
  if (!binding) throw new Error('fixture did not bind')
  return binding
}

function strict(overrides: Record<string, unknown> = {}): RealtimeSessionBinding {
  const binding = bindVerifiedSessionClaims(
    { userId: 'u9', iat: 1000, exp: 9_999_999_999, sid: 'xs.s9', xa: true, tenantId: 'org-9', ...overrides },
    classify,
  )
  if (!binding) throw new Error('fixture did not bind')
  return binding
}

describe('realtime revalidation switch', () => {
  it('is on for the exact literal true only', () => {
    const values = ['true', undefined, '', 'false', '0', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']
    expect(values.map((value) => isRealtimeRevalidationEnabled({ [REALTIME_REVALIDATION_FLAG]: value })))
      .toEqual([true, ...Array(11).fill(false)])
  })

  it('reports a value that only resembles true without activating it', () => {
    const readings: Array<[string | undefined, ExactSwitchReading]> = [
      ['true', 'on'], [undefined, 'off'], ['', 'off'], ['false', 'off'], ['0', 'off'], ['no', 'off'],
      ['TRUE', 'near-true'], ['True', 'near-true'], [' true', 'near-true'], ['true ', 'near-true'],
      ['1', 'near-true'], ['yes', 'near-true'], ['on', 'near-true'],
    ]
    for (const [raw, expected] of readings) expect(readExactSwitch(raw), JSON.stringify(raw)).toBe(expected)
  })
})

describe('session binding', () => {
  it('binds an ordinary session to its user, organization, issue time and registered session', () => {
    const binding = bindVerifiedSessionClaims({ userId: ' u1 ', tenantId: 'org-1', sid: 's1', iat: 10, exp: 20 }, classify)
    expect(binding).toMatchObject({
      sessionClass: 'ordinary', userId: 'u1', organizationId: 'org-1', sessionId: 's1', issuedAtSeconds: 10, expiresAtSeconds: 20,
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding?.claims)).toBe(true)
  })

  it('falls back through the id claims in a fixed order and keeps absent facts absent', () => {
    expect(bindVerifiedSessionClaims({ id: 'a', sub: 'b' }, classify)?.userId).toBe('a')
    expect(bindVerifiedSessionClaims({ sub: 'b' }, classify)).toMatchObject({
      userId: 'b', organizationId: null, sessionId: null, issuedAtSeconds: null, expiresAtSeconds: null,
    })
  })

  it('refuses claim sets that are not exactly an ordinary or a strict session', () => {
    expect(bindVerifiedSessionClaims(null, classify)).toBeNull()
    expect(bindVerifiedSessionClaims('token', classify)).toBeNull()
    expect(bindVerifiedSessionClaims([], classify)).toBeNull()
    expect(bindVerifiedSessionClaims({ iat: 1 }, classify)).toBeNull()
    expect(bindVerifiedSessionClaims({ userId: 'u', sid: 'xs.1' }, classify)).toBeNull()
    expect(bindVerifiedSessionClaims({ userId: 'u', sid: 's', xa: true }, classify)).toBeNull()
    expect(bindVerifiedSessionClaims({ userId: 'u' }, () => 'none')).toBeNull()
  })

  it('requires a registered session and an organization for a strict session', () => {
    expect(strict().sessionClass).toBe('strict')
    expect(bindVerifiedSessionClaims({ userId: 'u', sid: 'xs.1', xa: true }, classify)).toBeNull()
  })

  it('gives one key to the same subject and different keys to different subjects', () => {
    expect(bindingKey(ordinary())).toBe(bindingKey(ordinary({ email: 'other@example.test' })))
    const keys = new Set([
      bindingKey(ordinary()), bindingKey(ordinary({ userId: 'u2' })), bindingKey(ordinary({ iat: 1001 })),
      bindingKey(ordinary({ sid: 's1' })), bindingKey(ordinary({ tenantId: 'org-1' })), bindingKey(strict()),
    ])
    expect(keys.size).toBe(6)
  })
})

type SubjectRow = Record<string, unknown>
function subjectRow(ord: number, overrides: SubjectRow = {}): SubjectRow {
  return {
    ord, user_found: true, is_active: true, role: 'user', activation_status: 'activated',
    deleted_at: null, purged_at: null, watermark_found: false, revoked_after_ms: null, membership_ok: true,
    ...overrides,
  }
}

function fakeQuery(subjects: SubjectRow[], sessions: SubjectRow[] = []): { query: AuthorityQuery; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query: AuthorityQuery = async (sql, params) => {
    calls.push({ sql, params })
    if (sql === ORDINARY_SUBJECT_AUTHORITY_SQL) return { rows: subjects }
    if (sql === ORDINARY_SESSION_AUTHORITY_SQL) return { rows: sessions }
    throw new Error('unexpected statement')
  }
  return { query, calls }
}

const neverStrict = async (): Promise<boolean> => {
  throw new Error('strict verifier must not be called')
}

describe('strict three-valued authority read', () => {
  it('allows a session whose user is active, with no applicable watermark and an open registered session', async () => {
    const binding = ordinary({ sid: 's1', tenantId: 'org-1' })
    const { query, calls } = fakeQuery([subjectRow(1)], [{ id: 's1', user_id: 'u1', open: true }])
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([binding])
    expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'allowed' })
    expect(calls.map((call) => call.params)).toEqual([[['u1'], ['org-1']], [['s1']]])
  })

  it.each([
    ['a missing user', { user_found: false }, 'user-missing'],
    ['an inactive user', { is_active: false }, 'user-not-active'],
    ['a user whose active state is not recorded', { is_active: null }, 'user-not-active'],
    ['a disabled role', { role: 'disabled' }, 'user-not-active'],
    ['a user in the recycle bin', { deleted_at: '2026-01-01T00:00:00Z' }, 'user-not-active'],
    ['a purged user', { purged_at: '2026-01-01T00:00:00Z' }, 'user-not-active'],
    ['a user pending activation', { activation_status: 'pending_activation' }, 'user-not-active'],
    ['an unrecognised activation state', { activation_status: null }, 'user-not-active'],
    ['a watermark at the issue time', { watermark_found: true, revoked_after_ms: 1_000_000 }, 'watermark-applies'],
    ['a watermark after the issue time', { watermark_found: true, revoked_after_ms: 1_000_000.5 }, 'watermark-applies'],
    ['a watermark whose time cannot be read', { watermark_found: true, revoked_after_ms: null }, 'watermark-applies'],
    ['a lost organization membership', { membership_ok: false }, 'membership-lost'],
  ])('denies %s', async (_label, overrides, reason) => {
    const binding = ordinary({ tenantId: 'org-1' })
    const { query } = fakeQuery([subjectRow(1, overrides)])
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([binding])
    expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'denied', reason })
  })

  it('allows a credential issued after the watermark and denies one without an issue time', async () => {
    const after = ordinary({ iat: 1001 })
    const noIssueTime = ordinary({ userId: 'u2', iat: undefined })
    const { query } = fakeQuery([
      subjectRow(1, { watermark_found: true, revoked_after_ms: 1_000_999.999 }),
      subjectRow(2, { watermark_found: true, revoked_after_ms: 5 }),
    ])
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([after, noIssueTime])
    expect(verdicts.get(bindingKey(after))).toEqual({ state: 'allowed' })
    expect(verdicts.get(bindingKey(noIssueTime))).toEqual({ state: 'denied', reason: 'watermark-applies' })
  })

  it.each([
    ['is missing', []],
    ['belongs to another user', [{ id: 's1', user_id: 'someone-else', open: true }]],
    ['is revoked', [{ id: 's1', user_id: 'u1', open: false }]],
  ])('denies a credential whose registered session %s', async (_label, sessions) => {
    const binding = ordinary({ sid: 's1' })
    const { query } = fakeQuery([subjectRow(1)], sessions)
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([binding])
    expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'denied', reason: 'session-not-current' })
  })

  it('answers unknown for every session when a statement fails, whatever the failure is', async () => {
    for (const failure of [
      Object.assign(new Error('relation "user_session_revocations" does not exist'), { code: '42P01' }),
      Object.assign(new Error('permission denied for table user_sessions'), { code: '42501' }),
      Object.assign(new Error('column does not exist'), { code: '42703' }),
      new Error('connection terminated'),
    ]) {
      const a = ordinary()
      const b = ordinary({ userId: 'u2', sid: 's2' })
      const query: AuthorityQuery = async () => { throw failure }
      const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([a, b])
      expect([...verdicts.values()]).toEqual([
        { state: 'unknown', reason: 'authority-read-failed' },
        { state: 'unknown', reason: 'authority-read-failed' },
      ])
    }
  })

  it('answers unknown when the session statement fails after the subject statement succeeded', async () => {
    const binding = ordinary({ sid: 's1' })
    const query: AuthorityQuery = async (sql) => {
      if (sql === ORDINARY_SUBJECT_AUTHORITY_SQL) return { rows: [subjectRow(1)] }
      throw Object.assign(new Error('relation "user_sessions" does not exist'), { code: '42P01' })
    }
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([binding])
    expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'unknown', reason: 'authority-read-failed' })
  })

  it('answers unknown when the read returns no row, or an unreadable watermark flag, for a session', async () => {
    const a = ordinary()
    const b = ordinary({ userId: 'u2' })
    const { query } = fakeQuery([subjectRow(2, { watermark_found: null })])
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([a, b])
    expect(verdicts.get(bindingKey(a))).toEqual({ state: 'unknown', reason: 'authority-row-missing' })
    expect(verdicts.get(bindingKey(b))).toEqual({ state: 'unknown', reason: 'authority-row-missing' })
  })

  it('answers unknown, never allowed, when the read does not finish in time', async () => {
    vi.useFakeTimers()
    try {
      const binding = ordinary()
      let release: (value: { rows: SubjectRow[] }) => void = () => undefined
      const query: AuthorityQuery = () => new Promise((resolve) => { release = resolve })
      const reading = createRealtimeAuthorityReader({ query, verifyStrict: neverStrict, timeoutMs: 50 }).read([binding])
      await vi.advanceTimersByTimeAsync(51)
      const verdicts = await reading
      expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'unknown', reason: 'authority-read-timeout' })
      release({ rows: [subjectRow(1)] })
      await vi.advanceTimersByTimeAsync(1)
      expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'unknown', reason: 'authority-read-timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads a whole batch with two statements however many sessions it holds', async () => {
    const bindings = Array.from({ length: 200 }, (_unused, index) => ordinary({ userId: `u${index}`, sid: `s${index}` }))
    const { query, calls } = fakeQuery(
      bindings.map((_binding, index) => subjectRow(index + 1)),
      bindings.map((binding) => ({ id: binding.sessionId, user_id: binding.userId, open: true })),
    )
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([...bindings, ...bindings])
    expect(calls).toHaveLength(2)
    expect(verdicts.size).toBe(200)
    expect([...verdicts.values()].every((verdict) => verdict.state === 'allowed')).toBe(true)
  })

  it('issues no statement for an empty batch and no session statement when no credential carries one', async () => {
    const empty = fakeQuery([])
    expect((await createRealtimeAuthorityReader({ query: empty.query, verifyStrict: neverStrict }).read([])).size).toBe(0)
    expect(empty.calls).toHaveLength(0)
    const noSid = fakeQuery([subjectRow(1)])
    await createRealtimeAuthorityReader({ query: noSid.query, verifyStrict: neverStrict }).read([ordinary()])
    expect(noSid.calls.map((call) => call.sql)).toEqual([ORDINARY_SUBJECT_AUTHORITY_SQL])
  })

  it('verifies a strict session once per distinct session: current, not current, undecidable, expired', async () => {
    const current = strict()
    const stale = strict({ userId: 'u8', sid: 'xs.s8' })
    const undecidable = strict({ userId: 'u7', sid: 'xs.s7' })
    const expired = strict({ userId: 'u6', sid: 'xs.s6', exp: 100 })
    const verifyStrict = vi.fn(async (binding: RealtimeSessionBinding) => {
      if (binding.sessionId === 'xs.s9') return true
      if (binding.sessionId === 'xs.s8') return false
      throw new Error('read failed')
    })
    const { query, calls } = fakeQuery([])
    const reader = createRealtimeAuthorityReader({ query, verifyStrict, nowSeconds: () => 200 })
    const verdicts = await reader.read([current, current, stale, undecidable, expired])
    expect(verdicts.get(bindingKey(current))).toEqual({ state: 'allowed' })
    expect(verdicts.get(bindingKey(stale))).toEqual({ state: 'denied', reason: 'strict-session-not-current' })
    expect(verdicts.get(bindingKey(undecidable))).toEqual({ state: 'unknown', reason: 'authority-read-failed' })
    expect(verdicts.get(bindingKey(expired))).toEqual({ state: 'denied', reason: 'credential-expired' })
    expect(verifyStrict).toHaveBeenCalledTimes(3)
    expect(calls).toHaveLength(0)
  })

  it('never reads the trusted-claim fields of a credential', async () => {
    const binding = ordinary({ roles: ['admin'], perms: ['*:*'], role: 'admin' })
    const { query } = fakeQuery([subjectRow(1, { is_active: false })])
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read([binding])
    expect(verdicts.get(bindingKey(binding))).toEqual({ state: 'denied', reason: 'user-not-active' })
  })
})

const NEVER: StrictScopeGeneration = { state: 'never-installed' }
const EMPTY: StrictScopeGeneration = { state: 'installed', hasScope: false }
const SCOPED: StrictScopeGeneration = { state: 'installed', hasScope: true }
const UNKNOWN_SCOPE: StrictScopeGeneration = { state: 'unknown' }
const NO_RECORD: EnablementGeneration = { state: 'never-installed', definedInThisBuild: true }
const NO_RECORD_UNDEFINED: EnablementGeneration = { state: 'never-installed', definedInThisBuild: false }
const RECORD_EMPTY: EnablementGeneration = { state: 'installed', purposes: [] }
const RECORD_CHAIN: EnablementGeneration = { state: 'installed', purposes: ['credential-chain'] }
const RECORD_STRICT: EnablementGeneration = { state: 'installed', purposes: ['strict-switch'] }
const UNKNOWN_RECORD: EnablementGeneration = { state: 'unknown' }

function input(overrides: Partial<AdmissionInput> & { strictScope?: StrictScopeGeneration; enablement?: EnablementGeneration } = {}): AdmissionInput {
  const facts: RealtimeInstallationFacts = {
    strictScope: overrides.strictScope ?? NEVER,
    enablement: overrides.enablement ?? NO_RECORD,
  }
  return {
    revalidation: overrides.revalidation ?? 'off',
    credentialChain: overrides.credentialChain ?? 'off',
    facts,
    listener: overrides.listener ?? 'not-started',
  }
}

describe('realtime admission table', () => {
  it('row: switch off, both generations decidable, no scope and no enablement purpose -> baseline', () => {
    for (const strictScope of [NEVER, EMPTY]) {
      for (const enablement of [NO_RECORD, RECORD_EMPTY]) {
        for (const revalidation of ['off', 'near-true'] as const) {
          const decision = decideRealtimeAdmission(input({ strictScope, enablement, revalidation }))
          expect(decision).toMatchObject({
            row: 'off-baseline', ordinaryHandshake: 'baseline', strictHandshake: 'baseline', established: 'baseline', listenerRequired: false,
          })
        }
      }
    }
  })

  it('row: switch on and listener ready, no scope -> ordinary sessions are re-checked, strict handshakes refused', () => {
    for (const strictScope of [NEVER, EMPTY]) {
      const decision = decideRealtimeAdmission(input({ strictScope, revalidation: 'on', listener: 'ready' }))
      expect(decision).toMatchObject({
        row: 'on-without-scope', ordinaryHandshake: 'revalidate', strictHandshake: 'refuse', established: 'revalidate', listenerRequired: true,
      })
      expect(decision.notices).toEqual([])
    }
  })

  it('row: switch on and listener ready, scope present -> both session classes are re-checked', () => {
    for (const credentialChain of ['off', 'on'] as const) {
      const decision = decideRealtimeAdmission(input({ strictScope: SCOPED, enablement: RECORD_CHAIN, revalidation: 'on', listener: 'ready', credentialChain }))
      expect(decision).toMatchObject({
        row: 'on-with-scope', ordinaryHandshake: 'revalidate', strictHandshake: 'revalidate', established: 'revalidate', listenerRequired: true,
      })
    }
  })

  it('row: switch off while a scope or any enablement purpose exists -> handshakes refused, connections end', () => {
    const cases: Array<[StrictScopeGeneration, EnablementGeneration]> = [
      [SCOPED, NO_RECORD], [SCOPED, RECORD_EMPTY], [EMPTY, RECORD_CHAIN], [NEVER, RECORD_STRICT], [SCOPED, RECORD_CHAIN],
    ]
    for (const [strictScope, enablement] of cases) {
      for (const revalidation of ['off', 'near-true'] as const) {
        for (const credentialChain of ['off', 'on', 'near-true'] as const) {
          const decision = decideRealtimeAdmission(input({ strictScope, enablement, revalidation, credentialChain }))
          expect(decision).toMatchObject({
            row: 'off-enabled-environment', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'terminate', listenerRequired: false,
          })
          expect(decision.notices).toContain('REVALIDATION_OFF_IN_ENABLED_ENVIRONMENT')
        }
      }
    }
  })

  it('row: credential-chain switch on locally, environment certainly not enabled for it -> a notice only', () => {
    const off = decideRealtimeAdmission(input({ credentialChain: 'on' }))
    expect(off).toMatchObject({ row: 'off-baseline', ordinaryHandshake: 'baseline', established: 'baseline' })
    expect(off.notices).toEqual(['CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED'])

    const on = decideRealtimeAdmission(input({ credentialChain: 'on', revalidation: 'on', listener: 'ready' }))
    expect(on).toMatchObject({ row: 'on-without-scope', ordinaryHandshake: 'revalidate', established: 'revalidate' })
    expect(on.notices).toEqual(['CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED'])

    const strictOnly = decideRealtimeAdmission(input({ credentialChain: 'on', revalidation: 'on', listener: 'ready', strictScope: SCOPED, enablement: RECORD_STRICT }))
    expect(strictOnly.row).toBe('on-with-scope')
    expect(strictOnly.notices).toEqual(['CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED'])

    const enabled = decideRealtimeAdmission(input({ credentialChain: 'on', revalidation: 'on', listener: 'ready', strictScope: SCOPED, enablement: RECORD_CHAIN }))
    expect(enabled.notices).toEqual([])
  })

  it('the configuration conflict never changes a policy: same inputs with the credential-chain switch off decide the same', () => {
    const switches: ExactSwitchReading[] = ['on', 'off', 'near-true']
    const listeners: ListenerState[] = ['not-started', 'ready', 'not-ready']
    for (const strictScope of [NEVER, EMPTY, SCOPED, UNKNOWN_SCOPE]) {
      for (const enablement of [NO_RECORD, NO_RECORD_UNDEFINED, RECORD_EMPTY, RECORD_CHAIN, RECORD_STRICT, UNKNOWN_RECORD]) {
        for (const revalidation of switches) {
          for (const listener of listeners) {
            const without = decideRealtimeAdmission(input({ strictScope, enablement, revalidation, listener, credentialChain: 'off' }))
            for (const credentialChain of switches) {
              const withSwitch = decideRealtimeAdmission(input({ strictScope, enablement, revalidation, listener, credentialChain }))
              expect({ ...withSwitch, notices: [] }).toEqual({ ...without, notices: [] })
            }
          }
        }
      }
    }
  })

  it('row: a generation that cannot be decided -> handshakes refused and established traffic suspended, whatever the switches say', () => {
    const cases: Array<[StrictScopeGeneration, EnablementGeneration]> = [
      [UNKNOWN_SCOPE, NO_RECORD], [NEVER, UNKNOWN_RECORD], [SCOPED, UNKNOWN_RECORD], [UNKNOWN_SCOPE, UNKNOWN_RECORD],
    ]
    for (const [strictScope, enablement] of cases) {
      for (const revalidation of ['on', 'off', 'near-true'] as const) {
        for (const listener of ['not-started', 'ready', 'not-ready'] as const) {
          const decision = decideRealtimeAdmission(input({ strictScope, enablement, revalidation, listener }))
          expect(decision).toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend' })
          expect(decision.notices).toContain('INSTALLATION_UNDETERMINED')
          expect(decision.listenerRequired).toBe(revalidation === 'on')
        }
      }
    }
  })

  it('row: switch on without a ready listener -> handshakes refused and established traffic suspended', () => {
    for (const listener of ['not-started', 'not-ready'] as const) {
      for (const strictScope of [NEVER, EMPTY, SCOPED]) {
        const decision = decideRealtimeAdmission(input({ strictScope, revalidation: 'on', listener }))
        expect(decision).toMatchObject({
          row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend', listenerRequired: true,
        })
        expect(decision.notices).toContain('LISTENER_NOT_READY')
      }
    }
  })

  it('a listener that is not ready does not disturb an instance whose switch is off', () => {
    const decision = decideRealtimeAdmission(input({ listener: 'not-ready' }))
    expect(decision.row).toBe('off-baseline')
  })

  it('reports near-true switch values and a generation this build cannot read, without changing the row', () => {
    const decision = decideRealtimeAdmission(input({ revalidation: 'near-true', credentialChain: 'near-true', enablement: NO_RECORD_UNDEFINED }))
    expect(decision.row).toBe('off-baseline')
    expect(decision.notices).toEqual([
      'REVALIDATION_SWITCH_RESEMBLES_TRUE', 'CREDENTIAL_CHAIN_SWITCH_RESEMBLES_TRUE', 'ENABLEMENT_RECORD_NOT_READABLE_BY_THIS_BUILD',
    ])
  })

  it('serves nothing protected before the first successful read', () => {
    expect(ADMISSION_BEFORE_FIRST_READ).toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend' })
  })
})

function probeCaller(responses: { schema?: unknown[]; scope?: unknown[] | Error }): ProbeCaller {
  return {
    query: async (sql: string) => {
      if (sql.includes('current_schemas')) return { rows: (responses.schema ?? [{ schema_name: 'public' }]) as Array<Record<string, unknown>> }
      if (sql.includes('directory_connection_login_scope')) {
        if (responses.scope instanceof Error) throw responses.scope
        return { rows: (responses.scope ?? [{ has_scope: false }]) as Array<Record<string, unknown>> }
      }
      throw new Error('unexpected statement')
    },
  }
}

describe('installation probe', () => {
  const snapshotOf = (caller: ProbeCaller) => async <T>(work: (inner: ProbeCaller) => Promise<T>): Promise<T> => work(caller)

  it('reports never-installed, installed-and-empty and installed-with-scope', async () => {
    const neverInstalled = await probeRealtimeInstallation({
      withReadOnlySnapshot: snapshotOf(probeCaller({})), readStrictInstallation: async () => 'never-installed', readEnablement: enablementRecordNotDefinedInThisBuild,
    })
    expect(neverInstalled).toEqual({ strictScope: { state: 'never-installed' }, enablement: { state: 'never-installed', definedInThisBuild: false } })
    const empty = await probeRealtimeInstallation({
      withReadOnlySnapshot: snapshotOf(probeCaller({ scope: [{ has_scope: false }] })), readStrictInstallation: async () => 'installed', readEnablement: async () => RECORD_EMPTY,
    })
    expect(empty).toEqual({ strictScope: { state: 'installed', hasScope: false }, enablement: RECORD_EMPTY })
    const scoped = await probeRealtimeInstallation({
      withReadOnlySnapshot: snapshotOf(probeCaller({ scope: [{ has_scope: true }] })), readStrictInstallation: async () => 'installed', readEnablement: async () => RECORD_CHAIN,
    })
    expect(scoped.strictScope).toEqual({ state: 'installed', hasScope: true })
  })

  it('reads the scope table of the first non-system schema of the search path', async () => {
    const statements: string[] = []
    const caller: ProbeCaller = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('current_schemas')) return { rows: [{ schema_name: 'pg_temp_3' }, { schema_name: 'tenant_a' }, { schema_name: 'public' }] }
        return { rows: [{ has_scope: true }] }
      },
    }
    await probeRealtimeInstallation({ withReadOnlySnapshot: snapshotOf(caller), readStrictInstallation: async () => 'installed', readEnablement: async () => NO_RECORD })
    expect(statements[1]).toBe('SELECT EXISTS (SELECT 1 FROM "tenant_a"."directory_connection_login_scope") AS has_scope')
  })

  it.each([
    ['the installation read is refused', { install: new Error('refused') }],
    ['the installation read answers something else', { install: 'partial' }],
    ['the scope read fails', { scope: new Error('permission denied') }],
    ['the scope read returns no row', { scope: [] }],
    ['the scope read returns a non-boolean', { scope: [{ has_scope: null }] }],
    ['no install schema can be decided', { schema: [{ schema_name: 'pg_catalog' }] }],
    ['the install schema is not a plain identifier', { schema: [{ schema_name: 'a"b' }] }],
  ])('reports the strict scope generation unknown when %s', async (_label, shape) => {
    const facts = await probeRealtimeInstallation({
      withReadOnlySnapshot: snapshotOf(probeCaller(shape as { schema?: unknown[]; scope?: unknown[] | Error })),
      readStrictInstallation: async () => {
        const install = (shape as { install?: unknown }).install
        if (install instanceof Error) throw install
        return (install ?? 'installed') as 'installed'
      },
      readEnablement: async () => NO_RECORD,
    })
    expect(facts.strictScope).toEqual({ state: 'unknown' })
    expect(decideRealtimeAdmission({ revalidation: 'off', credentialChain: 'off', facts, listener: 'not-started' }).row).toBe('undetermined')
  })

  it('reports the enablement generation unknown when its read fails, and both unknown when no snapshot can be opened', async () => {
    const failing = await probeRealtimeInstallation({
      withReadOnlySnapshot: snapshotOf(probeCaller({})), readStrictInstallation: async () => 'never-installed',
      readEnablement: async () => { throw new Error('refused') },
    })
    expect(failing).toEqual({ strictScope: { state: 'never-installed' }, enablement: { state: 'unknown' } })
    const noSnapshot = await probeRealtimeInstallation({
      withReadOnlySnapshot: async () => { throw new Error('connect ECONNREFUSED') },
      readStrictInstallation: async () => 'never-installed', readEnablement: async () => NO_RECORD,
    })
    expect(noSnapshot).toEqual({ strictScope: { state: 'unknown' }, enablement: { state: 'unknown' } })
  })

  it('reports both generations unknown when the probe does not finish in time', async () => {
    vi.useFakeTimers()
    try {
      const probing = probeRealtimeInstallation({
        withReadOnlySnapshot: () => new Promise(() => undefined),
        readStrictInstallation: async () => 'never-installed', readEnablement: async () => NO_RECORD, timeoutMs: 100,
      })
      await vi.advanceTimersByTimeAsync(101)
      expect(await probing).toEqual({ strictScope: { state: 'unknown' }, enablement: { state: 'unknown' } })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('administrator diagnostics', () => {
  it('records the current decision, activates and deactivates notices, and counts events', () => {
    let clock = Date.parse('2026-11-21T00:00:00.000Z')
    const diagnostics = createRealtimeDiagnostics(() => new Date(clock))
    expect(diagnostics.snapshot().admission).toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', established: 'suspend', decidedAt: null })

    diagnostics.recordDecision(decideRealtimeAdmission(input({ credentialChain: 'on' })))
    clock += 1000
    diagnostics.recordDecision(decideRealtimeAdmission(input({ credentialChain: 'on' })))
    clock += 1000
    diagnostics.recordDecision(decideRealtimeAdmission(input({})))
    diagnostics.recordEvent('handshake-refused')
    diagnostics.recordEvent('handshake-refused', 2)

    const snapshot = diagnostics.snapshot()
    expect(snapshot.admission).toMatchObject({ row: 'off-baseline', decidedAt: '2026-11-21T00:00:02.000Z' })
    expect(snapshot.notices).toEqual([{
      code: 'CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED', active: false, count: 2,
      firstSeenAt: '2026-11-21T00:00:00.000Z', lastSeenAt: '2026-11-21T00:00:01.000Z',
    }])
    expect(snapshot.events).toEqual([{ code: 'handshake-refused', count: 3, lastAt: '2026-11-21T00:00:02.000Z' }])
  })

  function appWith(user: Record<string, unknown> | null, isAdmin: boolean) {
    const diagnostics = createRealtimeDiagnostics()
    diagnostics.recordDecision(decideRealtimeAdmission(input({ credentialChain: 'on' })))
    const app = express()
    app.use((req, _res, next) => {
      if (user) (req as unknown as { user: unknown }).user = user
      next()
    })
    app.use('/api/admin/realtime', adminRealtimeDiagnosticsRouter({
      diagnostics,
      ensureAdmin: async (req, res) => {
        const current = (req as unknown as { user?: { id?: string } }).user
        if (!current?.id) { res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } }); return null }
        if (!isAdmin) { res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } }); return null }
        return current.id
      },
    }))
    return app
  }

  it('refuses an unauthenticated caller and a caller without administrator access before anything is read', async () => {
    pinned.setApp(appWith(null, false))
    const anonymous = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(anonymous.status).toBe(401)
    expect(JSON.stringify(anonymous.body)).not.toMatch(/CREDENTIAL_CHAIN|notices|admission/)
    pinned.setApp(appWith({ id: 'u1' }, false))
    const member = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(member.status).toBe(403)
    expect(JSON.stringify(member.body)).not.toMatch(/CREDENTIAL_CHAIN|notices|admission/)
  })

  it('shows the decision and notices to an administrator', async () => {
    pinned.setApp(appWith({ id: 'admin-1' }, true))
    const response = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data.admission.row).toBe('off-baseline')
    expect(response.body.data.notices.map((notice: { code: string }) => notice.code)).toEqual(['CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED'])
  })

  it('the default gate refuses a request that carries no authenticated user', async () => {
    const app = express()
    app.use('/api/admin/realtime', adminRealtimeDiagnosticsRouter())
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
  })
})
