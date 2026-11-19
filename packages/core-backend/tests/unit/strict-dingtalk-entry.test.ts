import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jwtMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  sign: vi.fn(),
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  const transaction = vi.fn(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }))
  return {
    query,
    transaction,
    poolManager: { get: () => ({ query, transaction, getInternalPool: () => null }) },
  }
})

const sessionMocks = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(),
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(),
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))
vi.mock('jsonwebtoken', () => jwtMocks)
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: poolMocks.poolManager }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))
vi.mock('../../src/auth/session-revocation', () => ({ isUserSessionRevoked: sessionMocks.isUserSessionRevoked }))
vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: sessionMocks.createUserSession,
  isUserSessionActive: sessionMocks.isUserSessionActive,
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: vi.fn(() => 'unit-test-secret-abcdefghijklmnopqrstuvwxyz123456') },
}))

import { AuthService } from '../../src/auth/AuthService'
import { adminGrantApplicationMaterialFingerprint } from '../../src/auth/admin-grant-application-material'
import {
  STRICT_DINGTALK_ENTRY_GATES,
  STRICT_SESSION_MAX_AGE_ENV,
  bindStrictDingTalkEntryLocal,
  classifyVerifiedSessionPayload,
  currentStrictGrantUsable,
  readConfiguredStrictSessionMaxAgeSeconds,
  refreshStrictSession,
  signInStrictDingTalkWeb,
  strictSelectorMismatch,
  strictSessionOrgIdOf,
  verifyPersistedStrictSession,
} from '../../src/auth/strict-dingtalk-entry'

const user = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User',
  role: 'user',
  permissions: ['spreadsheet:read'],
  created_at: new Date('2026-11-18T00:00:00.000Z'),
  updated_at: new Date('2026-11-18T00:00:00.000Z'),
}

function trustedPayload(extra: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    role: 'user',
    roles: ['user'],
    perms: ['spreadsheet:read'],
    iat: 1,
    exp: 9,
    ...extra,
  }
}

// Synthetic query results exercise the real continuation, pin and privilege predicates.
// This fixture does not establish PostgreSQL clock, catalog or transaction semantics.
function continuationFixture() {
  const context = {
    v: 1, provider: 'dingtalk', assurance: 'self_authenticated', scopeAsserted: false,
    connectionId: '11111111-1111-4111-8111-111111111111',
    identityId: '22222222-2222-4222-8222-222222222222',
    grantId: `slg.${'ab'.repeat(32)}`, evidenceId: 'evidence-1', orgId: 'org-1',
    subjectKey: 'corp-1:open-1', subjectAppScope: 'scope-1', bindingRevision: '1',
    applicationRevision: '2', accessGeneration: '3', capRev: '4', policyRevision: 1,
  }
  const config = { appKey: 'synthetic-app', appSecret: 'synthetic-secret' }
  const fingerprint = adminGrantApplicationMaterialFingerprint(config)
  const session: Record<string, unknown> = {
    id: 'xs.session-1', user_id: user.id, external_auth_context: context,
    session_open: true, unexpired: true, within_lifetime: true, watermark_clear: true,
  }
  const grant: Record<string, unknown> = {
    grant_id: context.grantId, local_user_id: user.id, connection_id: context.connectionId,
    identity_id: context.identityId, live_identity_id: context.identityId,
    binding_revision_text: '1', grant_application_revision: '2', access_generation_text: '3',
    grant_org_id: 'org-1', subject_key: context.subjectKey, app_scope: 'scope-1',
    grant_material_fingerprint: fingerprint, capability_revision_seen: '4',
    grant_assurance: 'self_authenticated', enabled: true,
    identity_provider: 'dingtalk', identity_user_id: user.id, external_key: 'external-1',
    identity_corp_id: 'corp-1', provider_open_id: 'open-1', provider_union_id: 'union-1',
    pin_binding_revision: '1', pin_provider: 'dingtalk', pin_user_id: user.id,
    pin_external_key: 'external-1', pin_corp_id: 'corp-1', pin_open_id: 'open-1', pin_union_id: 'union-1',
    evidence_id: context.evidenceId, evidence_identity_id: context.identityId,
    evidence_live_identity_id: context.identityId, evidence_binding_revision: '1',
    evidence_assurance: 'self_authenticated', evidence_subject_key: context.subjectKey,
    evidence_app_scope: 'scope-1', evidence_org_id: 'org-1', evidence_connection_id: context.connectionId,
    evidence_capability_revision: '4', evidence_application_revision: '2', evidence_material_fingerprint: fingerprint,
    slot_snapshot: { provider: 'dingtalk', localUserId: user.id, externalKey: 'external-1',
      corpId: 'corp-1', providerOpenId: 'open-1', providerUnionId: 'union-1' }, evidence_open: true,
    integration_org_id: 'org-1', integration_provider: 'dingtalk', integration_corp_id: 'corp-1',
    integration_status: 'active', integration_config: config, application_revision: '2',
    application_material_fingerprint: fingerprint, capability_revision: '4', login_enabled: true,
    login_bound_tenant: 'corp-1', login_bound_app_scope: 'scope-1', bound_provider: 'dingtalk', bound_org_id: 'org-1',
    email: user.email, name: user.name, user_role: 'user', permissions: user.permissions,
    is_active: true, must_change_password: false, activation_status: 'activated', local_password_set: true,
    created_at: user.created_at, updated_at: user.updated_at, access_generation: '3',
    deleted: false, purged: false, membership_present: 1, strict_scope_present: true,
  }
  const privilege: Record<string, unknown> = {
    id: user.id, is_admin: false, role: 'user', legacy_permissions: [], role_ids: [],
    direct_codes: [], role_permission_pairs: [], admissions: [], department_scopes: [], member_group_scopes: [],
    delegation_activations: [],
  }
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    let rows: Record<string, unknown>[]
    if (sql.includes('AS schema_name')) rows = [{ schema_name: 'unit_strict' }]
    else if (sql.includes('kysely_migration')) rows = [{ present: 1 }]
    else if (sql.includes("SELECT 'table'::text AS kind")) {
      rows = ['table', 'function', 'trigger', 'check', 'index', 'column', 'named'].flatMap((kind, index) => {
        const requested = params[index === 6 ? 1 : index + 1]
        const names = Array.isArray(requested) ? requested : [requested]
        return names.map((name) => ({ kind, name }))
      })
    } else if (sql.includes('FROM user_sessions') && !sql.startsWith('UPDATE')) {
      expect(params).toEqual([session.id, 3600])
      rows = [session]
    } else if (sql.includes('FROM user_external_identity_login_grants grant_row')) {
      expect(params).toEqual([context.grantId, user.id])
      rows = [grant]
    } else if (sql.includes("current_setting('transaction_isolation')")) rows = [{ isolation: 'read committed' }]
    else if (sql.includes('pg_current_xact_id()')) rows = [{ xid: 'synthetic-transaction' }]
    else if (sql.includes('FROM users u')) {
      expect(params).toEqual([user.id])
      rows = [privilege]
    } else if (sql.startsWith('UPDATE user_sessions')) rows = [{ id: session.id }]
    else throw new Error('Unexpected continuation fixture query')
    return { rows, rowCount: rows.length }
  })
  const createToken = vi.fn(() => 'synthetic-refreshed-token')
  const readExp = vi.fn(() => 2_000_000_000)
  const payload = trustedPayload({ sid: session.id, xa: true, tenantId: 'org-1' })
  const env = { [STRICT_SESSION_MAX_AGE_ENV]: '3600' }
  return { context, session, grant, privilege, query, createToken, readExp, payload, env,
    verify: () => verifyPersistedStrictSession({ query }, payload, env),
    refresh: () => refreshStrictSession({ caller: { query }, payload, env, createToken, readExp }),
  }
}

describe('persisted strict session continuation', () => {
  it('verifies and refreshes an eligible persisted session through the real privilege reader', async () => {
    const fixture = continuationFixture()
    const principal = { ...user, tenantId: 'org-1', strictSessionOrgId: 'org-1', is_active: true,
      must_change_password: false, activation_status: 'activated', local_password_set: true }
    expect(await fixture.verify()).toEqual(principal)
    expect(await fixture.refresh()).toEqual({ token: 'synthetic-refreshed-token', user: principal })
    expect(fixture.createToken).toHaveBeenCalledTimes(1)
    expect(fixture.createToken).toHaveBeenCalledWith(principal, { sid: 'xs.session-1', externalAuth: true })
    expect(fixture.query.mock.calls.filter(([sql]) => sql.includes('FROM users u'))).toHaveLength(2)
    expect(fixture.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE user_sessions'))).toHaveLength(1)
  })

  it.each([
    ['membership inactive', 'grant', 'membership_present', null],
    ['user inactive', 'grant', 'is_active', false],
    ['user deleted', 'grant', 'deleted', true],
    ['user purged', 'grant', 'purged', true],
    ['user pending activation', 'grant', 'activation_status', 'pending_activation'],
    ['user watermark revoked', 'session', 'watermark_clear', false],
    ['session revoked', 'session', 'session_open', false],
    ['session expired', 'session', 'unexpired', false],
    ['session lifetime exceeded', 'session', 'within_lifetime', false],
    ['privilege elevated', 'privilege', 'is_admin', true],
    ['application material changed', 'grant', 'integration_config', { appKey: 'changed', appSecret: 'synthetic-secret' }],
    ['access generation changed', 'grant', 'access_generation', '4'],
  ] as const)('refuses verify and refresh when %s', async (_label, target, field, value) => {
    const fixture = continuationFixture()
    fixture[target][field] = value
    expect(fixture.grant.enabled).toBe(true)
    expect(fixture.grant.evidence_open).toBe(true)
    expect(await fixture.verify()).toBeNull()
    expect(await fixture.refresh()).toBeNull()
    expect(fixture.createToken).not.toHaveBeenCalled()
    expect(fixture.readExp).not.toHaveBeenCalled()
    expect(fixture.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toEqual([])
  })
})

describe('classifyVerifiedSessionPayload', () => {
  it('accepts an agreed xs sid and boolean xa as strict', () => {
    expect(classifyVerifiedSessionPayload({ sid: 'xs.1', xa: true })).toBe('strict')
  })

  it('accepts a session payload with neither marker as standard', () => {
    expect(classifyVerifiedSessionPayload({ sid: 'sid-1', userId: 'user-1' })).toBe('standard')
    expect(classifyVerifiedSessionPayload({ userId: 'user-1' })).toBe('standard')
  })

  it('refuses a one-sided or non-boolean marker as conflict', () => {
    expect(classifyVerifiedSessionPayload({ sid: 'xs.1' })).toBe('conflict')
    expect(classifyVerifiedSessionPayload({ sid: 'sid-1', xa: true })).toBe('conflict')
    expect(classifyVerifiedSessionPayload({ sid: 'sid-1', xa: false })).toBe('conflict')
    expect(classifyVerifiedSessionPayload({ sid: 'xs.1', xa: 'true' })).toBe('conflict')
    expect(classifyVerifiedSessionPayload({ xa: true })).toBe('conflict')
    expect(classifyVerifiedSessionPayload(Object.assign(Object.create({ xa: true }), { sid: 'xs.1' }))).toBe('conflict')
  })

  it('treats a non-object as none', () => {
    expect(classifyVerifiedSessionPayload(null)).toBe('none')
    expect(classifyVerifiedSessionPayload('xs.1')).toBe('none')
  })
})

describe('readConfiguredStrictSessionMaxAgeSeconds', () => {
  it('accepts only an integer in the closed range and supplies no default', () => {
    expect(readConfiguredStrictSessionMaxAgeSeconds({})).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: undefined })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '299' })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '2592001' })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '0300' })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: ' 300' })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '300.0' })).toBeNull()
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '300' })).toBe(300)
    expect(readConfiguredStrictSessionMaxAgeSeconds({ [STRICT_SESSION_MAX_AGE_ENV]: '2592000' })).toBe(2592000)
  })
})

describe('strict selector and org marker', () => {
  it('reads only a non-empty string org marker', () => {
    expect(strictSessionOrgIdOf({ strictSessionOrgId: 'org-1' })).toBe('org-1')
    expect(strictSessionOrgIdOf({ strictSessionOrgId: '' })).toBeNull()
    expect(strictSessionOrgIdOf({ strictSessionOrgId: 1 })).toBeNull()
    expect(strictSessionOrgIdOf(null)).toBeNull()
    expect(strictSessionOrgIdOf(Object.create({ strictSessionOrgId: 'org-1' }))).toBeNull()
  })

  it('refuses a present selector that is not exactly the strict org, including a non-string', () => {
    expect(strictSelectorMismatch({
      orgId: 'org-1',
      headers: { 'x-tenant-id': 'org-1', 'x-org-id': 'org-1', 'x-workspace-id': 'org-1' },
      query: { orgId: 'org-1' },
      body: { tenant_id: 'org-1' },
    })).toBe(false)
    expect(strictSelectorMismatch({ orgId: 'org-1', headers: { 'x-org-id': 'org-2' } })).toBe(true)
    expect(strictSelectorMismatch({ orgId: 'org-1', query: { workspaceId: ['org-1'] } })).toBe(true)
    expect(strictSelectorMismatch({ orgId: 'org-1', body: { org_id: 1 } })).toBe(true)
    expect(strictSelectorMismatch({ orgId: 'org-1', body: { nested: { orgId: 'org-2' } } })).toBe(false)
    expect(strictSelectorMismatch({ orgId: 'org-1', headers: {}, query: {}, body: {} })).toBe(false)
  })
})

describe('AuthService strict classification fence', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    delete process.env.RBAC_TOKEN_TRUST
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.transaction.mockClear()
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionRevoked.mockReset()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('keeps an omitted or false discriminator on the ordinary payload', () => {
    const auth = new AuthService()
    jwtMocks.sign.mockImplementation((payload: unknown) => JSON.stringify(payload))
    const omitted = JSON.parse(auth.createToken(user)) as Record<string, unknown>
    const disabled = JSON.parse(auth.createToken(user, { sid: 'sid-1', externalAuth: false })) as Record<string, unknown>
    expect(omitted).not.toHaveProperty('xa')
    expect(omitted).not.toHaveProperty('sid')
    expect(disabled).toMatchObject({ userId: 'user-1', sid: 'sid-1' })
    expect(disabled).not.toHaveProperty('xa')
  })

  it('mints xa only with an xs sid', () => {
    const auth = new AuthService()
    jwtMocks.sign.mockImplementation((payload: unknown) => JSON.stringify(payload))
    const minted = JSON.parse(auth.createToken({ ...user, tenantId: 'org-1' }, { sid: 'xs.1', externalAuth: true })) as Record<string, unknown>
    expect(minted).toMatchObject({ sid: 'xs.1', xa: true, tenantId: 'org-1' })
    expect(() => auth.createToken(user, { externalAuth: true })).toThrow(/STRICT_SESSION_SID_REQUIRED/)
    expect(() => auth.createToken(user, { sid: 'xs.1', externalAuth: false })).toThrow(/STRICT_SESSION_SID_REFUSED/)
    expect(() => auth.createToken(user, { sid: 'xs.1' })).toThrow(/STRICT_SESSION_SID_REFUSED/)
  })

  it('refuses conflict before SQL and does not trust a strict payload', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    process.env[STRICT_SESSION_MAX_AGE_ENV] = '300'
    const auth = new AuthService()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'xs.1' }))
    await expect(auth.verifyToken('conflict')).resolves.toBeNull()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'sid-1', xa: false }))
    await expect(auth.verifyToken('xa-false')).resolves.toBeNull()
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(poolMocks.transaction).not.toHaveBeenCalled()
    poolMocks.query.mockReset()
    poolMocks.transaction.mockClear()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'xs.1', xa: true }))
    poolMocks.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const strict = await auth.verifyToken('strict')
    expect(strict).toBeNull()
    expect(poolMocks.transaction).toHaveBeenCalled()
    poolMocks.query.mockReset()
    poolMocks.transaction.mockClear()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'sid-1' }))
    const ordinary = await auth.verifyToken('ordinary')
    expect(ordinary?.id).toBe('user-1')
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(poolMocks.transaction).not.toHaveBeenCalled()
  })

  it('returns null when the strict transaction rejects asynchronously without trusting the payload', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    process.env[STRICT_SESSION_MAX_AGE_ENV] = '300'
    const auth = new AuthService()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'xs.1', xa: true, tenantId: 'org-1' }))
    poolMocks.transaction.mockRejectedValueOnce(new Error('synthetic transaction failed'))
    await expect(auth.verifyToken('strict')).resolves.toBeNull()
    expect(poolMocks.transaction).toHaveBeenCalledTimes(1)
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(jwtMocks.sign).not.toHaveBeenCalled()
    expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
  })

  it('returns null from refresh for a strict or conflict payload before SQL', async () => {
    const auth = new AuthService()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'xs.1', xa: true }))
    await expect(auth.refreshToken('strict')).resolves.toBeNull()
    jwtMocks.verify.mockReturnValue(trustedPayload({ sid: 'sid-1', xa: true }))
    await expect(auth.refreshToken('conflict')).resolves.toBeNull()
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
  })

  it('keeps the local binding gates false and does not call a replacement signer', async () => {
    const binding = await bindStrictDingTalkEntryLocal({ env: {} })
    expect(binding.gates).toEqual(STRICT_DINGTALK_ENTRY_GATES)
    expect(binding.gates.implementationPermit).toBe(false)
    expect(binding.gates.productionAvailable).toBe(false)
    expect(binding.gates.b2Complete).toBe(false)
    expect(binding.gates.delivered).toBe(false)
    expect(binding.gates.containerAdapterProved).toBe(false)
    expect(binding.currentStrictGrantUsable).toBe(currentStrictGrantUsable)
    const replacement = vi.fn(() => {
      throw new Error('replacement signer')
    })
    poolMocks.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const result = await binding.signInWeb({
      code: 'auth-code',
      createToken: replacement,
      readExp: replacement,
      readIssuedAt: replacement,
      transaction: replacement,
    } as never)
    expect(result).toEqual({ status: 'not-strict' })
    expect(replacement).not.toHaveBeenCalled()
    expect(poolMocks.transaction).toHaveBeenCalled()
  })

  it('does not turn a usable-grant read failure into false', async () => {
    const caller = {
      query: vi.fn(async () => {
        throw Object.assign(new Error('db'), { code: '57014' })
      }),
    }
    await expect(currentStrictGrantUsable(caller, { userId: 'user-1' })).rejects.toMatchObject({
      code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED',
    })
    await expect(currentStrictGrantUsable(caller, { userId: ' user-1' })).rejects.toMatchObject({
      code: 'STRICT_LOGIN_INPUT_REFUSED',
    })
  })

  it('returns not-strict for an unknown corp without calling transport', async () => {
    const fetchFn = vi.fn(async () => new Response('unused'))
    const mint = vi.fn(() => {
      throw new Error('mint')
    })
    const result = await signInStrictDingTalkWeb({
      code: 'auth-code',
      selector: { corpId: 'missing-corp' },
      transport: { fetchFn },
      env: { [STRICT_SESSION_MAX_AGE_ENV]: '300' },
      transaction: async (handler) => handler({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
      createToken: mint,
      readExp: () => null,
      readIssuedAt: () => null,
    })
    expect(result).toEqual({ status: 'not-strict' })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(mint).not.toHaveBeenCalled()
  })
})
