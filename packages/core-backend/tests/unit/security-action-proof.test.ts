import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const cryptoMocks = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  cryptoMocks.timingSafeEqual.mockImplementation(actual.timingSafeEqual)
  return { ...actual, timingSafeEqual: cryptoMocks.timingSafeEqual }
})
const pgMocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: pgMocks.query, transaction: pgMocks.transaction }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: pgMocks.query, transaction: pgMocks.transaction, getInternalPool: () => null }) },
}))
const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn(async () => undefined) }))
vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))
const loggerSpy = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../../src/core/logger', () => ({
  Logger: class { info(m: string) { loggerSpy.lines.push(String(m)) } warn(m: string) { loggerSpy.lines.push(String(m)) } error(m: string) { loggerSpy.lines.push(String(m)) } debug(m: string) { loggerSpy.lines.push(String(m)) } },
}))

import { SECURITY_ACTION_PURPOSES } from '../../src/auth/external-login-assurance'
import { assessSecurityActionPrivilege } from '../../src/auth/security-action-privilege'
import {
  clientBindingDigestOf,
  computeCredentialWitness,
  consumeSecurityActionProof,
  hashProofSecret,
  issueSecurityActionProof,
  parseProof,
  parseSecurityActionVerifyRequest,
  readAuthenticatedSessionContext,
  SECURITY_ACTION_FAILURE_LIMIT,
  SECURITY_ACTION_FAILURE_WINDOW_SECONDS,
  SECURITY_ACTION_PROOF_HASH_DOMAIN,
  SECURITY_ACTION_PROOF_TTL_SECONDS,
  SECURITY_ACTION_SQL,
  SecurityActionProofContractError,
  SecurityActionProofError,
} from '../../src/auth/security-action-proof'
import type { AuthenticatedSessionContext, SecurityActionConsumeInput, SecurityActionErrorCode } from '../../src/auth/security-action-proof'
import { privilegeFixture, privilegeHarness, privilegeRow } from '../helpers/security-action-privilege-harness'
import type { PrivilegeRow } from '../helpers/security-action-privilege-harness'
import {
  accountState,
  bindRequest,
  CONNECTION,
  contextFor,
  defaultState,
  fakeClient,
  issuedProofRow,
  ORG,
  PASSWORD_HASH,
  requestShape,
  serviceWith,
  SESSION,
  TARGET_WITNESS,
  tokenFor,
  USER,
  verifyRequest,
} from '../helpers/security-action-proof-harness'
import type { HarnessEvent, HarnessState, StatementKey } from '../helpers/security-action-proof-harness'

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'src', 'auth', 'security-action-proof.ts')
const SOURCE = readFileSync(MODULE_PATH, 'utf8')
const SECRET = 'A'.repeat(43)
const PROOF_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
const PROOF = `sap1.${PROOF_ID}.${SECRET}`

async function expectRefusal(promise: Promise<unknown>, code: SecurityActionErrorCode): Promise<SecurityActionProofError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityActionProofError)
    const refusal = error as SecurityActionProofError
    expect(refusal.code).toBe(code)
    expect(refusal.message).toBe('Security action refused')
    expect((refusal as { cause?: unknown }).cause).toBeUndefined()
    return refusal
  }
  throw new Error(`expected ${code}`)
}

async function expectContract(promise: Promise<unknown>): Promise<SecurityActionProofContractError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityActionProofContractError)
    return error as SecurityActionProofContractError
  }
  throw new Error('expected a contract error')
}

function keys(events: HarnessEvent[], tx?: number): StatementKey[] {
  return events.flatMap((event) => (event.type === 'statement' && (tx === undefined || event.tx === tx) ? [event.key] : []))
}

function accountRowOf(state: HarnessState) {
  const account = state.account!
  return {
    passwordHash: String(account.password_hash),
    localPasswordSet: account.local_password_set as boolean,
    mustChangePassword: account.must_change_password as boolean,
    activationStatus: String(account.activation_status),
    isActive: account.is_active as boolean,
    role: account.role as string | null,
    deletedAt: account.deleted_at as string | null,
    purgedAt: account.purged_at as string | null,
    accessGeneration: String(account.access_generation),
  }
}

async function privilegeWitnessFor(row: PrivilegeRow): Promise<string> {
  const { executor } = privilegeHarness(privilegeFixture({ rows: [row] }))
  return (await assessSecurityActionPrivilege(executor, USER)).witness
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.SECURITY_ACTION_PROOF_ENABLED
  process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  auditMocks.auditLog.mockClear()
  cryptoMocks.timingSafeEqual.mockClear()
  loggerSpy.lines.length = 0
})
afterEach(() => {
  if (saved === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
  else process.env.SECURITY_ACTION_PROOF_ENABLED = saved
})

// ---------------------------------------------------------------------------
// Tokens and hashes
// ---------------------------------------------------------------------------

describe('proof token', () => {
  it('issues sap1.<uuid>.<43 base64url characters> and stores only the domain-separated hash', async () => {
    const { service, runner } = serviceWith()
    const issued = await service.issue(contextFor(), verifyRequest())
    const parsed = parseProof(issued.proof)
    expect(parsed).not.toBeNull()
    expect(parsed!.secret).toHaveLength(43)
    expect(Buffer.from(parsed!.secret, 'base64url')).toHaveLength(32)
    const insert = runner.statements.find((s) => s.key === 'insertIssued')!
    expect(insert.params[0]).toBe(parsed!.id)
    expect(insert.params[10]).toBe(hashProofSecret(parsed!.secret))
    expect(JSON.stringify(insert.params)).not.toContain(parsed!.secret)
  })

  it('refuses every malformed token shape', () => {
    const upper = PROOF_ID.toUpperCase()
    for (const bad of [
      `sap2.${PROOF_ID}.${SECRET}`, `sap1.not-a-uuid.${SECRET}`, `sap1.${upper}.${SECRET}`, `sap1.${PROOF_ID}.${'A'.repeat(42)}`,
      `sap1.${PROOF_ID}.${'A'.repeat(44)}`, `sap1.${PROOF_ID}.${'A'.repeat(42)}+`, `${PROOF}.extra`, '', undefined, null, 42,
    ]) {
      expect(parseProof(bad)).toBeNull()
    }
    expect(parseProof(PROOF)).toEqual({ id: PROOF_ID, secret: SECRET })
  })

  it('hashes the secret under a fixed domain prefix', () => {
    expect(SECURITY_ACTION_PROOF_HASH_DOMAIN).toBe('metasheet:security-action:proof:v1|')
    expect(hashProofSecret('x')).toBe(createHash('sha256').update('metasheet:security-action:proof:v1|x').digest('hex'))
    expect(hashProofSecret('x')).not.toBe(createHash('sha256').update('x').digest('hex'))
    expect(clientBindingDigestOf('raw')).toBe(createHash('sha256').update('raw').digest('hex'))
  })

  it('compares the stored hash in constant time', async () => {
    const state = defaultState({ proof: issuedProofRow({ proof_hash: hashProofSecret(SECRET) }) })
    const { service } = serviceWith({ state })
    const { client } = fakeClient(state)
    await expectRefusal(service.consume(client, contextFor(), consumeInput({ proof: `sap1.${PROOF_ID}.${'B'.repeat(43)}` })), 'SECURITY_ACTION_PROOF_INVALID')
    expect(cryptoMocks.timingSafeEqual).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

describe('session context', () => {
  it('reads the user, the session id, the issue time and the authenticated organization', () => {
    const context = contextFor()
    expect(context.userId).toBe(USER)
    expect(context.sessionId).toBe(SESSION)
    expect(Number.isSafeInteger(context.tokenIssuedAt) && context.tokenIssuedAt > 0).toBe(true)
    expect(context.orgId).toBe(ORG)
    expect(Object.isFrozen(context)).toBe(true)
  })

  it('returns null without a bearer token, a session id, a user, or a matching user claim', () => {
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, SESSION), ORG, { headers: {} }))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, undefined)))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, '   ')))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, SESSION), ORG, { user: undefined }))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, SESSION), ORG, { user: { id: 42 } }))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape('other-user', tokenFor(USER, SESSION)))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, 'not.a.jwt'))).toBeNull()
  })

  it('returns null for an expired token', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
      const token = tokenFor(USER, SESSION)
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      expect(readAuthenticatedSessionContext(requestShape(USER, token))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the organization from the authenticated session only, and requires the token to claim the same one', () => {
    const token = tokenFor(USER, SESSION, ORG)
    const context = readAuthenticatedSessionContext(requestShape(USER, token, ORG, { user: { id: USER, tenantId: 'header-org' }, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'header-org' } }))
    expect(context?.orgId).toBe(ORG)
    expect(readAuthenticatedSessionContext(requestShape(USER, token, null))?.orgId).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, token, 'another-org'))).toBeNull()
    expect(readAuthenticatedSessionContext(requestShape(USER, tokenFor(USER, SESSION, null), ORG))).toBeNull()
  })

  it('refuses a plain object with the same shape before any statement', async () => {
    const real = contextFor()
    const forged = { ...real } as unknown as AuthenticatedSessionContext
    const { service, runner } = serviceWith()
    await expectContract(service.issue(forged, verifyRequest()))
    const { client, statements } = fakeClient(defaultState())
    await expectContract(service.consume(client, forged, consumeInput()))
    expect(runner.events).toEqual([])
    expect(statements).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

describe('verify request schema', () => {
  it.each([
    ['an unknown key', { extra: 1 }, ['_unknown']],
    ['a bind request naming a target', { purpose: 'external_identity_bind', targetIdentityId: CONNECTION, expectedBindingRevision: 1 }, ['targetIdentityId']],
    ['a non-bind request without a target', { targetIdentityId: undefined, expectedBindingRevision: undefined }, ['targetIdentityId']],
    ['a negative revision', { expectedBindingRevision: -1 }, ['expectedBindingRevision']],
    ['a fractional revision', { expectedBindingRevision: 1.5 }, ['expectedBindingRevision']],
    ['a string revision', { expectedBindingRevision: '4' }, ['expectedBindingRevision']],
    ['a revision without a target', { targetIdentityId: undefined }, ['expectedBindingRevision', 'targetIdentityId']],
    ['the external method', { method: 'external_reauth' }, ['method']],
    ['an empty password', { password: '' }, ['password']],
    ['an overlong password', { password: 'p'.repeat(1025) }, ['password']],
    ['a non-string password', { password: 123 }, ['password']],
    ['an uppercase digest', { clientBindingDigest: 'A'.repeat(64) }, ['clientBindingDigest']],
    ['a short digest', { clientBindingDigest: 'a'.repeat(63) }, ['clientBindingDigest']],
    ['a non-uuid connection', { connectionId: 'conn' }, ['connectionId']],
    ['an unknown purpose', { purpose: 'constructor' }, ['purpose']],
    ['userId and orgId keys', { userId: USER, orgId: ORG }, ['_unknown']],
  ])('refuses %s naming only schema fields', (_label, overrides, fields) => {
    const result = parseSecurityActionVerifyRequest(verifyRequest(overrides as Record<string, unknown>))
    expect(result.ok).toBe(false)
    if (result.ok === false) expect([...result.fields]).toEqual([...fields].sort())
  })

  it('refuses bodies that are not plain objects', () => {
    for (const body of [null, undefined, [], 'x', 1, new Map()]) {
      const result = parseSecurityActionVerifyRequest(body)
      expect(result).toEqual({ ok: false, fields: ['_unknown'] })
    }
  })

  it('accepts the two shapes, lowercases identifiers and never trims the password', () => {
    const unbind = parseSecurityActionVerifyRequest(verifyRequest({ connectionId: CONNECTION.toUpperCase(), password: ' p ' }))
    expect(unbind.ok).toBe(true)
    if (unbind.ok) {
      expect(unbind.request.connectionId).toBe(CONNECTION)
      expect(unbind.request.password).toBe(' p ')
      expect(unbind.request.expectedBindingRevision).toBe(4)
      expect(Object.isFrozen(unbind.request)).toBe(true)
    }
    const bind = parseSecurityActionVerifyRequest(bindRequest())
    expect(bind.ok).toBe(true)
    if (bind.ok) expect(Object.keys(bind.request).sort()).toEqual(['connectionId', 'method', 'password', 'purpose'])
    const digest = parseSecurityActionVerifyRequest(verifyRequest({ clientBindingDigest: 'f'.repeat(64) }))
    expect(digest.ok && digest.request.clientBindingDigest).toBe('f'.repeat(64))
  })
})

// ---------------------------------------------------------------------------
// Refusals that need no data
// ---------------------------------------------------------------------------

describe('refusals before any statement', () => {
  it('refuses with 503 while the switch is not exactly true, without a statement', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', ' true', '1']) {
      if (value === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
      else process.env.SECURITY_ACTION_PROOF_ENABLED = value
      const { service, runner, audits } = serviceWith()
      await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_PROOF_UNAVAILABLE')
      const { client, statements } = fakeClient(defaultState())
      await expectRefusal(service.consume(client, contextFor(), consumeInput()), 'SECURITY_ACTION_PROOF_UNAVAILABLE')
      expect(runner.events).toEqual([])
      expect(statements).toEqual([])
      expect(audits).toEqual([])
    }
  })

  it('refuses every purpose before any statement while no purpose is available (production binding)', async () => {
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      const request = purpose === 'external_identity_bind' ? bindRequest() : verifyRequest({ purpose })
      const refusal = await expectRefusal(issueSecurityActionProof(contextFor(), request), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
      expect(refusal.status).toBe(403)
      const { client, statements } = fakeClient(defaultState())
      await expectRefusal(consumeSecurityActionProof(client, contextFor(), consumeInput({ purpose, target: { kind: purpose === 'external_identity_bind' ? 'empty_slot' : 'identity_revision', witness: TARGET_WITNESS } })), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
      expect(statements).toEqual([])
    }
    expect(pgMocks.query).not.toHaveBeenCalled()
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('refuses an unavailable purpose before any statement even when a resolver for it is registered', async () => {
    const unavailable = serviceWith({ isPurposeAvailable: () => false })
    const refusal = await expectRefusal(unavailable.service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    expect(refusal.status).toBe(403)
    expect(unavailable.runner.events).toEqual([])
    expect(unavailable.verifyCalls).toEqual([])
    expect(unavailable.audits).toEqual([])
    const { client, statements } = fakeClient(defaultState())
    await expectRefusal(unavailable.service.consume(client, contextFor(), consumeInput()), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    expect(statements).toEqual([])
  })

  it('refuses an available purpose that has no resolver, and an empty organization, before any statement', async () => {
    const noResolver = serviceWith({ resolvers: {} })
    await expectRefusal(noResolver.service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    expect(noResolver.runner.events).toEqual([])
    const inherited = serviceWith({ resolvers: Object.create({ external_identity_unbind: async () => ({ ok: true, kind: 'identity_revision', witness: TARGET_WITNESS }) }) })
    await expectRefusal(inherited.service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    const noOrg = serviceWith()
    const refusal = await expectRefusal(noOrg.service.issue(contextFor(USER, SESSION, null), verifyRequest()), 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED')
    expect(refusal.status).toBe(409)
    expect(noOrg.runner.events).toEqual([])
    expect(noOrg.audits).toEqual([])
  })

  it('refuses a request object that does not satisfy the schema as a contract violation', async () => {
    const { service, runner } = serviceWith()
    await expectContract(service.issue(contextFor(), verifyRequest({ method: 'external_reauth' })))
    expect(runner.events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The first transaction
// ---------------------------------------------------------------------------

describe('first read', () => {
  it('fixes read committed as the first statement and never opens the transaction read only', async () => {
    const { service, runner } = serviceWith()
    await service.issue(contextFor(), verifyRequest())
    const first = runner.statements.filter((s) => s.tx === 1)
    expect(first[0].sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(first.slice(1, 3).map((s) => s.sql)).toEqual(["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '30s'"])
    for (const statement of first) expect(statement.sql).not.toMatch(/READ ONLY/)
    expect(keys(runner.events, 1).slice(3, 8)).toEqual(['session', 'watermark', 'failureCount', 'account', 'membership'])
    // The failure count is keyed by the user id alone.
    expect(first.filter((s) => s.key === 'failureCount').map((s) => s.params)).toEqual([[USER]])
  })

  it.each([
    ['the session row is missing', { session: null }],
    ['the session row belongs to another user', { session: { user_id: 'someone-else', live: true } }],
    ['the session is revoked or expired', { session: { user_id: USER, live: false } }],
  ] satisfies Array<[string, Partial<HarnessState>]>)('refuses with 401 when %s', async (_label, overrides) => {
    const { service, verifyCalls, runner } = serviceWith({ state: defaultState(overrides) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_SESSION_REQUIRED')
    expect(refusal.status).toBe(401)
    expect(verifyCalls).toEqual([])
    expect(runner.statements.some((s) => s.key === 'insertFailed' || s.key === 'insertIssued')).toBe(false)
  })

  it('treats a token issued at or before the revocation watermark as revoked, in milliseconds', async () => {
    const context = contextFor()
    const issuedMs = context.tokenIssuedAt * 1000
    for (const [watermark, expected] of [[issuedMs + 500, 'revoked'], [issuedMs, 'revoked'], [issuedMs - 1, 'issued']] as const) {
      const { service, verifyCalls } = serviceWith({ state: defaultState({ watermarkMs: String(watermark) }) })
      if (expected === 'revoked') {
        await expectRefusal(service.issue(context, verifyRequest()), 'SECURITY_ACTION_SESSION_REQUIRED')
        expect(verifyCalls).toEqual([])
      } else {
        await expect(service.issue(context, verifyRequest())).resolves.toMatchObject({ ttlSeconds: 300 })
      }
    }
  })

  it('refuses with 429 before the password is compared once the per-user failure limit is reached', async () => {
    const { service, verifyCalls, runner } = serviceWith({ state: defaultState({ failures: SECURITY_ACTION_FAILURE_LIMIT, retryAfter: 123 }) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_RATE_LIMITED')
    expect(refusal.status).toBe(429)
    expect(refusal.details).toEqual({ retryAfter: 123, nextStep: 'admin_assisted_local_credential' })
    expect(verifyCalls).toEqual([])
    expect(runner.statements.some((s) => s.key === 'account')).toBe(false)
    const below = serviceWith({ state: defaultState({ failures: SECURITY_ACTION_FAILURE_LIMIT - 1 }) })
    await expect(below.service.issue(contextFor(), verifyRequest())).resolves.toBeTruthy()
  })

  it.each([
    ['no local password is set', accountState({ local_password_set: false })],
    ['a password change is required', accountState({ must_change_password: true })],
  ])('refuses with 403 METHOD_UNAVAILABLE and a next step when %s, without comparing the password', async (_label, account) => {
    const { service, verifyCalls, runner } = serviceWith({ state: defaultState({ account }) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_METHOD_UNAVAILABLE')
    expect(refusal.status).toBe(403)
    expect(refusal.details).toEqual({ nextStep: 'admin_assisted_local_credential' })
    expect(verifyCalls).toEqual([])
    expect(runner.statements.some((s) => s.key === 'insertFailed')).toBe(false)
  })

  it('refuses the exact row of an otherwise active account without a local password with 403, not 401', async () => {
    const account = accountState({ local_password_set: false, must_change_password: false, is_active: true, activation_status: 'activated' })
    const { service, verifyCalls } = serviceWith({ state: defaultState({ account }) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_METHOD_UNAVAILABLE')
    expect(refusal.status).toBe(403)
    expect(refusal.details?.nextStep).toBe('admin_assisted_local_credential')
    expect(verifyCalls).toEqual([])
  })

  it.each([
    ['the account row is missing', null],
    ['the account is inactive', accountState({ is_active: false })],
    ['the account is disabled by role', accountState({ role: 'disabled' })],
    ['the account is in the recycle bin', accountState({ deleted_at: '2026-01-01T00:00:00Z' })],
    ['the account is purged', accountState({ purged_at: '2026-01-01T00:00:00Z' })],
    ['the account is pending activation', accountState({ activation_status: 'pending_activation' })],
    ['the activation status is invalid', accountState({ activation_status: '' })],
  ])('refuses with 401 when %s', async (_label, account) => {
    const { service, verifyCalls } = serviceWith({ state: defaultState({ account }) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_SESSION_REQUIRED')
    expect(refusal.status).toBe(401)
    expect(verifyCalls).toEqual([])
  })

  it('refuses with 409 when the user is not an active member of the authenticated organization', async () => {
    const { service, runner } = serviceWith({ state: defaultState({ member: false }) })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED')
    const membership = runner.statements.find((s) => s.key === 'membership')!
    expect(membership.params).toEqual([USER, ORG])
  })

  it('refuses self-service bind and grant enable for a high-privilege user before comparing the password, and allows unbind', async () => {
    const admin = privilegeRow({ id: USER, is_admin: true })
    for (const purpose of ['external_identity_bind', 'login_grant_enable'] as const) {
      const { service, verifyCalls } = serviceWith({ state: defaultState({ privilege: admin }) })
      const request = purpose === 'external_identity_bind' ? bindRequest() : verifyRequest({ purpose })
      const refusal = await expectRefusal(service.issue(contextFor(), request), 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED')
      expect(refusal.status).toBe(403)
      expect(verifyCalls).toEqual([])
    }
    const { service } = serviceWith({ state: defaultState({ privilege: admin }) })
    await expect(service.issue(contextFor(), verifyRequest({ purpose: 'external_identity_unbind' }))).resolves.toBeTruthy()
  })

  it('maps resolver refusals, contract violations and failures without comparing the password', async () => {
    const cases: Array<[() => Promise<unknown>, SecurityActionErrorCode, number]> = [
      [async () => ({ ok: false, refused: 'connection_not_permitted' }), 'SECURITY_ACTION_CONNECTION_NOT_PERMITTED', 403],
      [async () => ({ ok: false, refused: 'target_conflict' }), 'SECURITY_ACTION_TARGET_CONFLICT', 409],
      [async () => ({ ok: true, kind: 'empty_slot', witness: TARGET_WITNESS }), 'SECURITY_ACTION_UNAVAILABLE', 503],
      [async () => ({ ok: true, kind: 'identity_revision', witness: 'nothex' }), 'SECURITY_ACTION_UNAVAILABLE', 503],
      [async () => { throw new Error('resolver_private_detail') }, 'SECURITY_ACTION_UNAVAILABLE', 503],
      [async () => null, 'SECURITY_ACTION_UNAVAILABLE', 503],
    ]
    for (const [resolver, code, status] of cases) {
      const { service, verifyCalls } = serviceWith({ resolvers: { external_identity_unbind: resolver as never } })
      const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), code)
      expect(refusal.status).toBe(status)
      expect(verifyCalls).toEqual([])
      expect(JSON.stringify(refusal)).not.toContain('resolver_private_detail')
    }
  })

  it('passes the resolver the authenticated organization, the connection and the target as strings', async () => {
    const seen: unknown[] = []
    const { service } = serviceWith({ resolvers: { external_identity_unbind: async (_executor, request) => { seen.push(request); return { ok: true, kind: 'identity_revision', witness: TARGET_WITNESS } } } })
    await service.issue(contextFor(), verifyRequest())
    expect(seen[0]).toEqual({ userId: USER, orgId: ORG, connectionId: CONNECTION, targetIdentityId: verifyRequest().targetIdentityId!.toLowerCase(), expectedBindingRevision: '4' })
  })

  it('refuses with 503 when the privilege inputs cannot be read', async () => {
    const { service, verifyCalls } = serviceWith({ state: defaultState({ privilege: privilegeRow({ id: 'wrong-subject' }) }) })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_UNAVAILABLE')
    expect(refusal.status).toBe(503)
    expect(verifyCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The password comparison and the second transaction
// ---------------------------------------------------------------------------

describe('password comparison and the second transaction', () => {
  it('compares the password after the first transaction commits and before the second begins', async () => {
    const { service, runner, verifyCalls } = serviceWith()
    await service.issue(contextFor(), verifyRequest())
    const types = runner.events.filter((e) => e.type !== 'statement').map((e) => e.type)
    expect(types).toEqual(['begin', 'commit', 'verifyPassword', 'begin', 'commit', 'audit'])
    expect(verifyCalls).toEqual([{ hash: PASSWORD_HASH }])
  })

  it('takes the advisory lock and the user row before any proof statement, after fixing read committed', async () => {
    const { service, runner } = serviceWith()
    await service.issue(contextFor(), verifyRequest())
    const second = runner.statements.filter((s) => s.tx === 2)
    expect(second.slice(0, 5).map((s) => s.key)).toEqual(['setReadCommitted', 'setLockTimeout', 'setStatementTimeout', 'advisoryLock', 'userKeyShare'])
    expect(second[3].params).toEqual([`security-action:${USER}`])
    expect(second[4].params).toEqual([USER])
    expect(second[5].key).toBe('failureCount')
    expect(second[5].params).toEqual([USER])
    const proofIndex = second.findIndex((s) => ['failureCount', 'supersede', 'insertIssued', 'insertFailed'].includes(s.key))
    expect(proofIndex).toBeGreaterThan(second.findIndex((s) => s.key === 'userKeyShare'))
  })

  it('refuses with 503 when the user row cannot be locked', async () => {
    const { service, runner } = serviceWith({ state: defaultState({ userExists: false }) })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_UNAVAILABLE')
    expect(runner.statements.some((s) => s.key === 'insertIssued')).toBe(false)
  })

  it.each([true, false])('refuses with 429 in the second count whatever the password (ok=%s), writing no row', async (passwordOk) => {
    const { service, runner, verifyCalls } = serviceWith({
      passwordOk,
      options: { before: { failureCount: (state, occurrence) => { if (occurrence === 2) state.failures = SECURITY_ACTION_FAILURE_LIMIT } } },
    })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_RATE_LIMITED')
    expect(verifyCalls).toHaveLength(1)
    expect(runner.statements.filter((s) => s.tx === 2).some((s) => s.key === 'insertFailed' || s.key === 'insertIssued')).toBe(false)
    expect(runner.events.filter((e) => e.type === 'rollback')).toEqual([{ type: 'rollback', tx: 2 }])
  })

  it('writes a failed row from the first read, commits it, and only then refuses with 403 and a next step', async () => {
    const { service, runner, audits } = serviceWith({ passwordOk: false })
    const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    expect(refusal.status).toBe(403)
    expect(refusal.details).toEqual({ nextStep: 'admin_assisted_local_credential' })
    const types = runner.events.filter((e) => e.type !== 'statement').map((e) => e.type)
    expect(types).toEqual(['begin', 'commit', 'verifyPassword', 'begin', 'commit', 'audit'])
    const insert = runner.statements.find((s) => s.key === 'insertFailed')!
    expect(insert.tx).toBe(2)
    expect(runner.events.findIndex((e) => e.type === 'commit' && e.tx === 2)).toBeGreaterThan(runner.events.findIndex((e) => e.type === 'statement' && e.key === 'insertFailed'))
    expect(runner.statements.some((s) => s.key === 'insertIssued' || s.key === 'supersede')).toBe(false)
    expect(audits.map((a) => a.meta.result)).toEqual(['credential_rejected'])
  })

  it('counts a rejected credential with the first read even when the inputs changed after it, and never stores the client binding', async () => {
    const state = defaultState()
    const firstWitness = computeCredentialWitness(accountRowOf(state))
    const { service, runner } = serviceWith({
      state,
      passwordOk: false,
      options: { before: { account: (s, occurrence) => { if (occurrence === 2) { s.account = accountState({ access_generation: '9', password_hash: 'changed' }) } } } },
    })
    await expectRefusal(service.issue(contextFor(), verifyRequest({ clientBindingDigest: 'e'.repeat(64) })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    const insert = runner.statements.find((s) => s.key === 'insertFailed')!
    expect(insert.params).toHaveLength(15)
    expect(insert.params[11]).toBe('3')
    expect(insert.params[12]).toBe(firstWitness)
    expect(insert.params[9]).toBe(TARGET_WITNESS)
    expect(JSON.stringify(insert.params)).not.toContain('e'.repeat(64))
    expect(insert.sql).toMatch(/'failed', 'credential_rejected', NULL, NULL,/)
    expect(insert.sql).toMatch(/NULL\)$/)
    expect(runner.statements.filter((s) => s.key === 'account')).toHaveLength(1)
  })

  it.each([
    ['the access generation', (s: HarnessState) => { s.account = accountState({ access_generation: '4' }) }],
    ['the credential witness', (s: HarnessState) => { s.account = accountState({ password_hash: 'rotated' }) }],
    ['the privilege witness', (s: HarnessState) => { s.privilege = privilegeRow({ id: USER, direct_codes: ['tasks:read'] }) }],
    ['the privilege class', (s: HarnessState) => { s.privilege = privilegeRow({ id: USER, is_admin: true }) }],
    ['the session', (s: HarnessState) => { s.session = { user_id: USER, live: false } }],
    ['the watermark', (s: HarnessState, context: AuthenticatedSessionContext) => { s.watermarkMs = String(context.tokenIssuedAt * 1000) }],
    ['the membership', (s: HarnessState) => { s.member = false }],
  ])('refuses and writes nothing when %s changed between the two reads (STATE_CHANGED, or the session or organisation refusal that the second read meets first)', async (_label, drift) => {
    const context = contextFor()
    const { service, runner } = serviceWith({ options: { before: { advisoryLock: (state) => drift(state, context) } } })
    const refusal = await expectRefusal(service.issue(context, verifyRequest({ purpose: 'external_identity_unbind' })), ['the session', 'the watermark', 'the membership'].includes(_label) ? (_label === 'the membership' ? 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED' : 'SECURITY_ACTION_SESSION_REQUIRED') : 'SECURITY_ACTION_STATE_CHANGED')
    expect([401, 409]).toContain(refusal.status)
    expect(runner.statements.some((s) => s.key === 'insertIssued' || s.key === 'insertFailed')).toBe(false)
  })

  it('refuses with 409 STATE_CHANGED when the target witness changed between the two reads', async () => {
    let calls = 0
    const { service, runner } = serviceWith({ resolvers: { external_identity_unbind: async () => ({ ok: true, kind: 'identity_revision', witness: (++calls === 1 ? 'a' : 'b').repeat(64) }) } })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_STATE_CHANGED')
    expect(runner.statements.some((s) => s.key === 'insertIssued')).toBe(false)
  })

  it('supersedes the live proof of the same user, session and purpose before inserting, and reads the expiry from the database', async () => {
    const state = defaultState()
    const { service, runner } = serviceWith({ state })
    const issued = await service.issue(contextFor(), verifyRequest({ clientBindingDigest: 'd'.repeat(64) }))
    const second = runner.statements.filter((s) => s.tx === 2)
    const supersede = second.findIndex((s) => s.key === 'supersede')
    const insert = second.findIndex((s) => s.key === 'insertIssued')
    expect(supersede).toBeGreaterThan(0)
    expect(insert).toBe(supersede + 1)
    expect(second[supersede].params).toEqual([USER, SESSION, 'external_identity_unbind'])
    const params = second[insert].params
    expect(params).toHaveLength(17)
    expect(params[11]).toBe('d'.repeat(64))
    expect(params.some((p) => p instanceof Date || (typeof p === 'number' && p > 1_000_000))).toBe(false)
    expect(second[insert].sql).toContain("now() + interval '300 seconds'")
    expect(second[insert].sql.split('VALUES')[0]).not.toContain('created_at')
    expect(issued.expiresAt).toBe(state.issuedReturning!.expires_at.toISOString())
    expect(issued).toEqual({
      proof: issued.proof, purpose: 'external_identity_unbind', connectionId: CONNECTION, method: 'local_password', assurance: 'local_password',
      expiresAt: issued.expiresAt, ttlSeconds: SECURITY_ACTION_PROOF_TTL_SECONDS,
    })
    expect(Object.isFrozen(issued)).toBe(true)
  })

  it('refuses with 503 when the insert returns no expiry', async () => {
    const { service } = serviceWith({ state: defaultState({ issuedReturning: null }) })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_UNAVAILABLE')
  })
})

// ---------------------------------------------------------------------------
// Error mapping, audit, no shortcuts
// ---------------------------------------------------------------------------

describe('error mapping and audit', () => {
  const codes = ['55P03', '57014', '40P01', '40001', '42P01', '42703', '23505', '55000', null]
  const issueKeys: StatementKey[] = ['setReadCommitted', 'session', 'watermark', 'failureCount', 'account', 'membership', 'privilegeData', 'advisoryLock', 'userKeyShare', 'supersede', 'insertIssued', 'insertFailed']

  it.each(issueKeys)('maps a failure of %s to 503 without a cause or driver text', async (key) => {
    for (const code of codes) {
      const { service, runner, audits } = serviceWith({ passwordOk: key !== 'insertFailed', options: { failAt: { key, code } } })
      const refusal = await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_UNAVAILABLE')
      expect(refusal.status).toBe(503)
      expect(JSON.stringify(refusal)).not.toContain('synthetic_private_sql_detail')
      expect(runner.statements.some((s) => s.key === 'insertIssued' && s.tx === 2 && key !== 'insertIssued')).toBe(false)
      expect(audits.map((a) => a.meta.result)).toEqual(['unavailable'])
    }
  })

  it('audits once per outcome after the transactions end, with closed-set fields and no secret, hash or password', async () => {
    const { service, runner, audits } = serviceWith()
    const issued = await service.issue(contextFor(), verifyRequest())
    expect(audits).toHaveLength(1)
    expect(runner.events.at(-1)).toEqual({ type: 'audit', result: 'issued' })
    const event = audits[0]
    expect(event).toEqual({
      action: 'security_action_verify', resourceType: 'user-security-action', resourceId: `user:${USER}`,
      meta: { userId: USER, purpose: 'external_identity_unbind', method: 'local_password', result: 'issued', code: null, connectionId: CONNECTION, privilegeClass: 'standard' },
    })
    const serialized = JSON.stringify(event) + loggerSpy.lines.join('\n')
    expect(serialized).not.toContain(parseProof(issued.proof)!.secret)
    expect(serialized).not.toContain(hashProofSecret(parseProof(issued.proof)!.secret))
    expect(serialized).not.toContain('correct horse battery staple')
    expect(serialized).not.toContain(PASSWORD_HASH)
  })

  it('audits each refusal reached after the first transaction began, and nothing before it', async () => {
    const limited = serviceWith({ state: defaultState({ failures: 5 }) })
    await expectRefusal(limited.service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_RATE_LIMITED')
    expect(limited.audits.map((a) => [a.meta.result, a.meta.code])).toEqual([['rate_limited', 'SECURITY_ACTION_RATE_LIMITED']])
    const method = serviceWith({ state: defaultState({ account: accountState({ must_change_password: true }) }) })
    await expectRefusal(method.service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_METHOD_UNAVAILABLE')
    expect(method.audits.map((a) => a.meta.result)).toEqual(['method_unavailable'])
    const failing = serviceWith({ recordAudit: async () => { throw new Error('audit down') } })
    await expect(failing.service.issue(contextFor(), verifyRequest())).resolves.toBeTruthy()
  })

  it('has no session-age shortcut: a fresh token with a wrong password is still rejected', async () => {
    const { service } = serviceWith({ passwordOk: false })
    await expectRefusal(service.issue(contextFor(), verifyRequest()), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    expect(SOURCE).not.toMatch(/last_login_at|issued_at|last_seen_at/)
  })
})

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

function consumeInput(overrides: Partial<SecurityActionConsumeInput> & Record<string, unknown> = {}): SecurityActionConsumeInput {
  return {
    proof: PROOF,
    purpose: 'external_identity_unbind',
    connectionId: CONNECTION,
    target: { kind: 'identity_revision', witness: TARGET_WITNESS },
    lockedUser: { id: USER, name: null, email: null, username: null, mobile: null, role: 'user', activationStatus: 'activated', isActive: true, accessGeneration: 3, deletedAt: null, purgedAt: null },
    ...overrides,
  }
}

async function consumableState(overrides: Partial<HarnessState> = {}, row: Record<string, unknown> = {}): Promise<HarnessState> {
  const state = defaultState(overrides)
  state.proof = issuedProofRow({
    proof_hash: hashProofSecret(SECRET),
    credential_witness: computeCredentialWitness(accountRowOf(state)),
    privilege_witness: await privilegeWitnessFor(state.privilege),
    ...row,
  })
  return state
}

describe('consumption contract', () => {
  it('refuses a missing or mismatching locked user, a malformed input and a malformed token before any statement', async () => {
    const { service } = serviceWith()
    for (const bad of [
      consumeInput({ lockedUser: undefined }),
      consumeInput({ lockedUser: { ...consumeInput().lockedUser, id: 'other' } }),
      consumeInput({ purpose: 'constructor' as unknown as SecurityActionConsumeInput['purpose'] }),
      consumeInput({ connectionId: 'not-a-uuid' }),
      consumeInput({ target: { kind: 'identity_revision', witness: 'short' } }),
      consumeInput({ actionRef: 'has space' }),
      consumeInput({ actionRef: 'x'.repeat(129) }),
      consumeInput({ clientBinding: '' }),
    ]) {
      const { client, statements } = fakeClient(defaultState())
      await expectContract(service.consume(client, contextFor(), bad))
      expect(statements).toEqual([])
    }
    const { client, statements } = fakeClient(defaultState())
    await expectRefusal(service.consume(client, contextFor(), consumeInput({ proof: 'sap1.bad.token' })), 'SECURITY_ACTION_PROOF_INVALID')
    expect(statements).toEqual([])
  })

  it.each([
    ['repeatable read', { isolation: 'repeatable read' }],
    ['serializable', { isolation: 'serializable' }],
    ['autocommit', { xids: ['100', '101'] }],
  ] satisfies Array<[string, Partial<HarnessState>]>)('refuses a %s handle before taking the user lock', async (_label, overrides) => {
    const state = await consumableState(overrides)
    const { service } = serviceWith({ state })
    const { client, statements } = fakeClient(state)
    const error = await expectContract(service.consume(client, contextFor(), consumeInput()))
    expect(error.code).toBe('SECURITY_ACTION_TRANSACTION_REQUIRED')
    expect(statements.some((s) => s.key === 'lockUser' || s.key === 'lockProof' || s.key === 'sessionForShare')).toBe(false)
  })

  it('locks the user row, then the session row, then the proof row by id and user', async () => {
    const state = await consumableState()
    const { service } = serviceWith({ state })
    const { client, statements } = fakeClient(state)
    await service.consume(client, contextFor(), consumeInput())
    // D21 (access-graph mutex): the subject authorization version row is bumped before the users row is locked.
    expect(statements.slice(0, 7).map((s) => s.key)).toEqual(['isolation', 'xid', 'xid', 'versionBump', 'lockUser', 'sessionForShare', 'lockProof'])
    expect(statements[3].params).toEqual([[USER]])
    expect(statements[5].sql).toContain('FOR SHARE')
    expect(statements[6].sql).toContain('user_id = $2')
    expect(statements[6].sql).toContain('FOR UPDATE')
    expect(statements[6].params).toEqual([PROOF_ID, USER])
    expect(statements.at(-1)!.key).toBe('consume')
  })

  it('refuses with STALE when the user row no longer exists under the lock', async () => {
    const state = await consumableState({ userExists: false })
    const { service } = serviceWith({ state })
    const { client } = fakeClient(state)
    await expectRefusal(service.consume(client, contextFor(), consumeInput()), 'SECURITY_ACTION_PROOF_STALE')
  })
})

describe('consumption decisions', () => {
  it.each([
    ['no row', (s: HarnessState) => { s.proof = null }, 'SECURITY_ACTION_PROOF_INVALID'],
    ['a failed row', (s: HarnessState) => { s.proof!.status = 'failed'; s.proof!.proof_hash = null }, 'SECURITY_ACTION_PROOF_INVALID'],
    ['a hash mismatch', (s: HarnessState) => { s.proof!.proof_hash = hashProofSecret('other') }, 'SECURITY_ACTION_PROOF_INVALID'],
    ['a client binding that is required but missing', (s: HarnessState) => { s.proof!.client_binding_digest = clientBindingDigestOf('bound') }, 'SECURITY_ACTION_PROOF_INVALID'],
    ['another session', (s: HarnessState) => { s.proof!.session_id = 'other-session' }, 'SECURITY_ACTION_PROOF_SESSION_MISMATCH'],
    ['a consumed row', (s: HarnessState) => { s.proof!.status = 'consumed' }, 'SECURITY_ACTION_PROOF_ALREADY_USED'],
    ['a superseded row', (s: HarnessState) => { s.proof!.status = 'superseded' }, 'SECURITY_ACTION_PROOF_ALREADY_USED'],
    ['an expired row', (s: HarnessState) => { s.proof!.live = false }, 'SECURITY_ACTION_PROOF_EXPIRED'],
    ['another purpose', (s: HarnessState) => { s.proof!.purpose = 'login_grant_disable' }, 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'],
    ['another connection', (s: HarnessState) => { s.proof!.connection_id = '99999999-9999-4999-8999-999999999999' }, 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'],
    ['another organization', (s: HarnessState) => { s.proof!.org_id = 'other-org' }, 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'],
    ['another target kind', (s: HarnessState) => { s.proof!.target_kind = 'empty_slot' }, 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'],
    ['another target witness', (s: HarnessState) => { s.proof!.target_witness = 'b'.repeat(64) }, 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'],
    ['an account the gate refuses', (s: HarnessState) => { s.account = accountState({ is_active: false }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['an account the gate refuses by role alone, with an unchanged credential witness', (s: HarnessState) => { s.account = accountState({ role: 'disabled' }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['an account whose local password was unset', (s: HarnessState) => { s.account = accountState({ local_password_set: false }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['an advanced access generation', (s: HarnessState) => { s.account = accountState({ access_generation: '4' }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a changed credential witness', (s: HarnessState) => { s.account = accountState({ password_hash: 'rotated' }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a changed privilege witness that stays standard', (s: HarnessState) => { s.privilege = privilegeRow({ id: USER, direct_codes: ['tasks:read'] }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a changed privilege witness that becomes high, for an unbind', (s: HarnessState) => { s.privilege = privilegeRow({ id: USER, is_admin: true }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['another policy revision', (s: HarnessState) => { s.proof!.policy_revision = 2 }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a session that is no longer live', (s: HarnessState) => { s.session = { user_id: USER, live: false } }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a watermark later than the proof', (s: HarnessState) => { s.watermarkMs = '1800000000000' }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a watermark equal to the proof creation time', (s: HarnessState) => { s.watermarkMs = String(Math.floor(Number(s.proof!.created_at_us) / 1000)); s.watermarkUs = String(s.proof!.created_at_us) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a membership that ended', (s: HarnessState) => { s.member = false }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a recorded method that the policy now refuses', (s: HarnessState) => { s.proof!.assurance = 'external_platform_asserted' }, 'SECURITY_ACTION_ASSURANCE_INSUFFICIENT'],
    ['an update that affects no row and finds it consumed', (s: HarnessState) => { s.consumeRows = 0; s.reload = { status: 'consumed', live: true } }, 'SECURITY_ACTION_PROOF_ALREADY_USED'],
    ['an update that affects no row and finds it expired', (s: HarnessState) => { s.consumeRows = 0; s.reload = { status: 'issued', live: false } }, 'SECURITY_ACTION_PROOF_EXPIRED'],
    ['an update that affects no row for another reason', (s: HarnessState) => { s.consumeRows = 0; s.reload = { status: 'issued', live: true } }, 'SECURITY_ACTION_PROOF_STALE'],
  ])('refuses %s', async (_label, mutate, code) => {
    const state = await consumableState()
    mutate(state)
    const { service } = serviceWith({ state })
    const { client, statements } = fakeClient(state)
    await expectRefusal(service.consume(client, contextFor(), consumeInput()), code as SecurityActionErrorCode)
    if (code !== 'SECURITY_ACTION_PROOF_ALREADY_USED' && code !== 'SECURITY_ACTION_PROOF_EXPIRED' && code !== 'SECURITY_ACTION_PROOF_STALE') {
      expect(statements.some((s) => s.key === 'consume')).toBe(false)
    }
  })

  it('refuses a consuming token issued at or before the watermark, in milliseconds, with STALE', async () => {
    const context = contextFor()
    const issuedMs = context.tokenIssuedAt * 1000
    for (const [watermarkMs, code] of [[issuedMs, 'SECURITY_ACTION_PROOF_STALE'], [issuedMs - 1, null]] as const) {
      const state = await consumableState({ watermarkMs: String(watermarkMs), watermarkUs: `${watermarkMs}000` }, { created_at_us: String(issuedMs + 60_000) + '000' })
      const { service } = serviceWith({ state })
      const { client } = fakeClient(state)
      if (code) await expectRefusal(service.consume(client, context, consumeInput()), code)
      else await expect(service.consume(client, context, consumeInput())).resolves.toBeTruthy()
    }
  })

  it('refuses a bind proof with HIGH when the privilege witness changed and the user is now high', async () => {
    const state = await consumableState({ privilege: privilegeRow({ id: USER, is_admin: true }) }, { purpose: 'external_identity_bind', target_kind: 'empty_slot', privilege_witness: await privilegeWitnessFor(privilegeRow({ id: USER })) })
    const { service } = serviceWith({ state })
    const { client } = fakeClient(state)
    await expectRefusal(service.consume(client, contextFor(), consumeInput({ purpose: 'external_identity_bind', target: { kind: 'empty_slot', witness: TARGET_WITNESS } })), 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED')
  })

  it('accepts a matching client binding and refuses a wrong one', async () => {
    const bound = await consumableState({}, { client_binding_digest: clientBindingDigestOf('bound') })
    const { service } = serviceWith({ state: bound })
    await expectRefusal(service.consume(fakeClient(bound).client, contextFor(), consumeInput({ clientBinding: 'wrong' })), 'SECURITY_ACTION_PROOF_INVALID')
    await expect(service.consume(fakeClient(bound).client, contextFor(), consumeInput({ clientBinding: 'bound' }))).resolves.toBeTruthy()
  })

  it('returns a frozen verification with the recorded creation time and the action reference bound to the update', async () => {
    const state = await consumableState()
    const { service } = serviceWith({ state })
    const { client, statements } = fakeClient(state)
    const verified = await service.consume(client, contextFor(), consumeInput({ actionRef: 'bind:1' }))
    expect(verified).toEqual({
      proofId: PROOF_ID, verifiedAt: '2026-01-01T00:00:00.000Z', method: 'local_password', assurance: 'local_password',
      privilegeClass: 'standard', purpose: 'external_identity_unbind', connectionId: CONNECTION,
    })
    expect(Object.isFrozen(verified)).toBe(true)
    expect(JSON.stringify(verified)).not.toContain(SECRET)
    const update = statements.find((s) => s.key === 'consume')!
    expect(update.params).toEqual([PROOF_ID, USER, SESSION, 'external_identity_unbind', 'bind:1'])
  })

  it('maps a read failure during consumption to 503 without a cause', async () => {
    for (const key of ['lockUser', 'sessionForShare', 'lockProof', 'account', 'privilegeData', 'watermark', 'membership', 'consume'] as StatementKey[]) {
      const state = await consumableState()
      const { service } = serviceWith({ state })
      const { client } = fakeClient(state, { failAt: { key, code: '40001' } })
      const refusal = await expectRefusal(service.consume(client, contextFor(), consumeInput()), 'SECURITY_ACTION_UNAVAILABLE')
      expect(JSON.stringify(refusal)).not.toContain('synthetic_private_sql_detail')
    }
  })
})

// ---------------------------------------------------------------------------
// Static pins
// ---------------------------------------------------------------------------

describe('statement pins', () => {
  it('pins the consume predicate, the proof lock, the supersede scope and the session liveness expressions', () => {
    expect(SECURITY_ACTION_SQL.consume).toContain("status = 'issued'")
    expect(SECURITY_ACTION_SQL.consume).toContain('expires_at > clock_timestamp()')
    expect(SECURITY_ACTION_SQL.consume).toMatch(/WHERE id = \$1::uuid AND user_id = \$2 AND session_id = \$3 AND purpose = \$4/)
    expect(SECURITY_ACTION_SQL.lockProof).toContain('WHERE id = $1::uuid AND user_id = $2')
    expect(SECURITY_ACTION_SQL.lockProof).toContain('FOR UPDATE')
    expect(SECURITY_ACTION_SQL.supersede).toMatch(/WHERE user_id = \$1 AND session_id = \$2 AND purpose = \$3 AND status = 'issued'$/)
    for (const statement of [SECURITY_ACTION_SQL.session, SECURITY_ACTION_SQL.sessionForShare]) {
      expect(statement).toContain('(s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) AS live')
      expect(statement).toContain('WHERE s.id = $1')
    }
    expect(SECURITY_ACTION_SQL.sessionForShare).toMatch(/FOR SHARE$/)
    expect(SECURITY_ACTION_SQL.membership).toContain('WHERE uo.user_id = $1 AND uo.org_id = $2 AND uo.is_active = true AND u.is_active = true')
    expect(SECURITY_ACTION_SQL.userKeyShare).toBe('SELECT 1 AS present FROM users WHERE id = $1 FOR KEY SHARE')
    expect(SECURITY_ACTION_SQL.advisoryLock).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))')
  })

  it('counts failures per user only: the predicate names the user, the status and the window, never the session or the purpose', () => {
    const count = SECURITY_ACTION_SQL.failureCount
    expect(count).toContain("WHERE user_id = $1 AND status = 'failed' AND created_at > clock_timestamp() - interval '900 seconds'")
    expect(count).not.toContain('session_id')
    expect(count).not.toContain('purpose')
    expect(count.split('$1')).toHaveLength(2)
    expect(count).not.toContain('$2')
    expect(SECURITY_ACTION_FAILURE_WINDOW_SECONDS).toBe(900)
    expect(SECURITY_ACTION_FAILURE_LIMIT).toBe(5)
    expect(SOURCE.split('SECURITY_ACTION_SQL.failureCount')).toHaveLength(2)
  })

  it('never deletes from the table, never reads the application clock, and never writes created_at', () => {
    expect(SOURCE).not.toContain('DELETE FROM security_action_challenges')
    expect(SOURCE).not.toContain('Date.now(')
    expect(SOURCE).not.toMatch(/new Date\(\)/)
    // The inserted column list never names created_at; the column keeps its database default.
    expect(SECURITY_ACTION_SQL.insertIssued.split('VALUES')[0]).not.toContain('created_at')
    expect(SECURITY_ACTION_SQL.insertFailed.split('VALUES')[0]).not.toContain('created_at')
    expect(SECURITY_ACTION_SQL.insertIssued.split('VALUES')[1].split('RETURNING')[0]).not.toContain('created_at')
    expect(SECURITY_ACTION_SQL.insertFailed.split('VALUES')[1]).not.toContain('created_at')
    expect(SECURITY_ACTION_SQL.insertIssued).toContain("now() + interval '300 seconds'")
    expect(SECURITY_ACTION_PROOF_TTL_SECONDS).toBe(300)
  })
})
