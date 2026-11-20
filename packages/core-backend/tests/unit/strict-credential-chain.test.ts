import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertOrdinaryIssuerAllowsLegacySession,
  closedDingTalkOrigin,
  credentialRevocationFlagOn,
  finishDeprovisionCredentials,
  guardAdminLegacyGrantSwitch,
  guardAdminLegacyGrantSwitchSet,
  noRemainingLoginMethod,
  selectCredentialLegs,
  StrictCredentialChainError,
  type ClosedCredentialFacts,
  type CredentialLegs,
} from '../../src/auth/strict-credential-chain'

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: vi.fn(),
      transaction: vi.fn(),
      getInternalPool: () => null,
    }),
  },
}))

const CONN_A = '10000000-0000-4000-8000-000000000001'
const CONN_B = '20000000-0000-4000-8000-000000000002'
const CONN_C = '30000000-0000-4000-8000-000000000003'
const IDENT_A = 'a0000000-0000-4000-8000-00000000000a'
const IDENT_B = 'b0000000-0000-4000-8000-00000000000b'
const FLAG = 'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED'

const store = vi.hoisted(() => ({
  readConnectionLoginScope: vi.fn(),
  readCurrentConnectionLoginScope: vi.fn(),
  readStrictLoginInstallation: vi.fn(),
  revokeForIdentity: vi.fn(),
  revokeForScope: vi.fn(),
  revokeForUserInScope: vi.fn(),
  detachEvidenceForIdentities: vi.fn(),
  collectStrictGrantSessionUsers: vi.fn(),
  prelockUserSessionWatermarks: vi.fn(),
  revokeSessionsForExactGrants: vi.fn(),
}))

vi.mock('../../src/auth/strict-login-grant-store', () => store)

type Row = Record<string, unknown>

function clientFor(input: {
  links: Array<{ userId: string; connectionId: string }>
  identities: Array<{ id: string }>
  trace: string[]
  statements?: string[]
}) {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('directory_account_links')) {
        input.trace.push('connections')
        input.statements?.push(sql)
        const requested = new Set((params?.[0] as string[]) ?? [])
        return {
          rows: input.links
            .filter((link) => requested.has(link.userId))
            .map((link) => ({ user_id: link.userId, id: link.connectionId })),
        }
      }
      if (sql.includes('user_external_identities')) {
        input.trace.push('identities')
        return { rows: input.identities.map((identity) => ({ id: identity.id })) }
      }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        input.trace.push('reselect')
        return { rows: [{ id: params?.[0] }] }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
}

function installStore(input: {
  trace: string[]
  strict: ReadonlySet<string>
  installation?: 'installed' | 'never-installed'
  grantIds?: readonly string[]
  sessionUsers?: readonly string[]
}) {
  const installation = input.installation ?? 'installed'
  store.readConnectionLoginScope.mockImplementation(async (_caller: unknown, connectionId: string) => {
    input.trace.push(`scope:${connectionId}`)
    if (installation === 'never-installed') return { installation, scope: null }
    if (!input.strict.has(connectionId)) return { installation, scope: null }
    return {
      installation,
      scope: { connectionId, commandId: 'cmd', transitionedAt: 't' },
    }
  })
  store.revokeForIdentity.mockImplementation(async (_caller: unknown, identityIds: readonly string[]) => {
    input.trace.push(`revoke:${identityIds.join(',')}`)
    return { grantIds: input.grantIds ?? ['slg.a', 'slg.b'] }
  })
  store.collectStrictGrantSessionUsers.mockImplementation(async () => {
    input.trace.push('collect')
    return input.sessionUsers ?? ['watermark-user-z', 'watermark-user-a']
  })
  store.prelockUserSessionWatermarks.mockImplementation(async (_caller: unknown, userIds: readonly string[]) => {
    input.trace.push(`prelock:${userIds.join(',')}`)
  })
  store.revokeSessionsForExactGrants.mockImplementation(async (_caller: unknown, body: { grantIds: readonly string[] }) => {
    input.trace.push(`sessions:${body.grantIds.join(',')}`)
    return { userIds: [], sessionIds: [] }
  })
}

describe('guardAdminLegacyGrantSwitchSet', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env[FLAG]
  })

  it('revokes the whole locked set before one exact-user prelock and one session seal', async () => {
    const trace: string[] = []
    const statements: string[] = []
    installStore({ trace, strict: new Set([CONN_A, CONN_B]) })
    const client = clientFor({
      trace,
      statements,
      links: [
        { userId: 'user-b', connectionId: CONN_B },
        { userId: 'user-a', connectionId: CONN_A },
      ],
      identities: [{ id: IDENT_B }, { id: IDENT_A }],
    })

    const result = await guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-b', 'user-a'],
      actorId: 'actor-1',
      enabled: false,
    })

    expect(result.grantIds).toEqual(['slg.a', 'slg.b'])
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('integration.id::text AS id')
    expect(statements[0]).toContain('link.local_user_id::text AS user_id')
    expect(statements[0]).toContain('ORDER BY id, user_id')
    expect(statements[0]).not.toContain('ORDER BY integration.id')
    expect(trace).toEqual([
      'connections',
      `scope:${CONN_A}`,
      `scope:${CONN_B}`,
      'identities',
      `revoke:${IDENT_A},${IDENT_B}`,
      'collect',
      'prelock:watermark-user-a,watermark-user-z',
      'sessions:slg.a,slg.b',
      'reselect',
    ])
    expect(store.prelockUserSessionWatermarks).toHaveBeenCalledTimes(1)
    expect(store.prelockUserSessionWatermarks).toHaveBeenCalledWith(
      expect.anything(),
      ['watermark-user-a', 'watermark-user-z'],
    )
    expect(store.revokeSessionsForExactGrants).toHaveBeenCalledTimes(1)
    expect(store.revokeForIdentity).toHaveBeenCalledTimes(1)
    expect(store.readCurrentConnectionLoginScope).not.toHaveBeenCalled()
    expect(store.revokeForUserInScope).not.toHaveBeenCalled()
  })

  it('keeps the admin target ids out of the prelock when the credential flag is on', async () => {
    process.env[FLAG] = 'true'
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A, CONN_B]) })
    const client = clientFor({
      trace,
      links: [
        { userId: 'user-a', connectionId: CONN_A },
        { userId: 'user-b', connectionId: CONN_B },
      ],
      identities: [{ id: IDENT_A }, { id: IDENT_B }],
    })

    await guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a', 'user-b'],
      actorId: 'actor-1',
      enabled: false,
    })

    expect(store.prelockUserSessionWatermarks).toHaveBeenCalledTimes(1)
    expect(store.prelockUserSessionWatermarks.mock.calls[0]?.[1]).toEqual([
      'watermark-user-a',
      'watermark-user-z',
    ])
  })

  it('shares one connection once and still seals once', async () => {
    const trace: string[] = []
    installStore({
      trace,
      strict: new Set([CONN_A]),
      grantIds: ['slg.shared'],
      sessionUsers: ['watermark-user-a'],
    })
    const client = clientFor({
      trace,
      links: [
        { userId: 'user-a', connectionId: CONN_A },
        { userId: 'user-b', connectionId: CONN_A },
      ],
      identities: [{ id: IDENT_A }, { id: IDENT_B }],
    })

    await guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a', 'user-b'],
      actorId: 'actor-1',
      enabled: false,
    })

    expect(trace.filter((entry) => entry.startsWith('scope:'))).toEqual([`scope:${CONN_A}`])
    expect(store.revokeForIdentity).toHaveBeenCalledTimes(1)
    expect(store.prelockUserSessionWatermarks).toHaveBeenCalledTimes(1)
    expect(store.revokeSessionsForExactGrants).toHaveBeenCalledTimes(1)
  })

  it('delegates the scalar call through the same one-element seal', async () => {
    const trace: string[] = []
    installStore({
      trace,
      strict: new Set([CONN_A]),
      grantIds: ['slg.one'],
      sessionUsers: ['watermark-user-a'],
    })
    const client = clientFor({
      trace,
      links: [{ userId: 'user-a', connectionId: CONN_A }],
      identities: [{ id: IDENT_A }],
    })

    const result = await guardAdminLegacyGrantSwitch(client, {
      userId: 'user-a',
      actorId: 'actor-1',
      enabled: false,
    })

    expect(result.grantIds).toEqual(['slg.one'])
    expect(trace).toEqual([
      'connections',
      `scope:${CONN_A}`,
      'identities',
      `revoke:${IDENT_A}`,
      'collect',
      'prelock:watermark-user-a',
      'sessions:slg.one',
      'reselect',
    ])
  })

  it('refuses enable for any strict target before a revoke', async () => {
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_B]) })
    const client = clientFor({
      trace,
      links: [
        { userId: 'user-a', connectionId: CONN_A },
        { userId: 'user-b', connectionId: CONN_B },
      ],
      identities: [{ id: IDENT_A }],
    })

    await expect(guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a', 'user-b'],
      actorId: 'actor-1',
      enabled: true,
    })).rejects.toMatchObject({ code: 'strict_connection', statusCode: 403 })

    expect(trace).toEqual(['connections', `scope:${CONN_A}`, `scope:${CONN_B}`])
    expect(store.revokeForIdentity).not.toHaveBeenCalled()
    expect(store.prelockUserSessionWatermarks).not.toHaveBeenCalled()
    expect(store.revokeSessionsForExactGrants).not.toHaveBeenCalled()
  })

  it('refuses ambiguous disable for the whole set before any revoke', async () => {
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A, CONN_B, CONN_C]) })
    const client = clientFor({
      trace,
      links: [
        { userId: 'user-a', connectionId: CONN_A },
        { userId: 'user-b', connectionId: CONN_B },
        { userId: 'user-b', connectionId: CONN_C },
      ],
      identities: [{ id: IDENT_A }],
    })

    await expect(guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a', 'user-b'],
      actorId: 'actor-1',
      enabled: false,
    })).rejects.toMatchObject({ code: 'strict_connection_ambiguous', statusCode: 503 })

    expect(trace).toEqual([
      'connections',
      `scope:${CONN_A}`,
      `scope:${CONN_B}`,
      `scope:${CONN_C}`,
    ])
    expect(store.revokeForIdentity).not.toHaveBeenCalled()
    expect(store.prelockUserSessionWatermarks).not.toHaveBeenCalled()
  })

  it('admits never-installed targets without a revoke or a prelock', async () => {
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A]), installation: 'never-installed' })
    const client = clientFor({
      trace,
      links: [
        { userId: 'user-a', connectionId: CONN_A },
        { userId: 'user-b', connectionId: CONN_B },
      ],
      identities: [{ id: IDENT_A }],
    })

    const result = await guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a', 'user-b'],
      actorId: 'actor-1',
      enabled: false,
    })

    expect(result).toEqual({ grantIds: [] })
    expect(trace).toEqual(['connections', `scope:${CONN_A}`, `scope:${CONN_B}`])
    expect(store.revokeForIdentity).not.toHaveBeenCalled()
    expect(store.prelockUserSessionWatermarks).not.toHaveBeenCalled()
  })

  it('does not call revokeForIdentity when the strict targets have no identities', async () => {
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A]) })
    const client = clientFor({
      trace,
      links: [{ userId: 'user-a', connectionId: CONN_A }],
      identities: [],
    })

    const result = await guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['user-a'],
      actorId: 'actor-1',
      enabled: false,
    })

    expect(result).toEqual({ grantIds: [] })
    expect(trace).toEqual(['connections', `scope:${CONN_A}`, 'identities'])
    expect(store.revokeForIdentity).not.toHaveBeenCalled()
    expect(store.collectStrictGrantSessionUsers).not.toHaveBeenCalled()
  })

  it('asks the real usable-grant reader after password and legacy are absent', async () => {
    const trace: string[] = []
    store.readStrictLoginInstallation.mockImplementation(async () => {
      trace.push('installation')
      return { installation: 'never-installed' }
    })
    const client = {
      async query(sql: string) {
        if (sql.includes('FROM users')) {
          trace.push('password')
          return { rows: [] }
        }
        if (sql.includes('user_external_auth_grants')) {
          trace.push('legacy-grant')
          return { rows: [] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    }

    await expect(noRemainingLoginMethod(client, {
      userId: 'user-a',
      departedConnectionId: CONN_A,
    })).resolves.toBe(true)

    expect(trace).toEqual(['password', 'legacy-grant', 'installation'])
  })

  it('rejects an empty target before any read', async () => {
    const trace: string[] = []
    const client = clientFor({ trace, links: [], identities: [] })

    await expect(guardAdminLegacyGrantSwitchSet(client, {
      userIds: ['  '],
      actorId: 'actor-1',
      enabled: false,
    })).rejects.toBeInstanceOf(StrictCredentialChainError)

    expect(trace).toEqual([])
  })
})

const RUN_ID = '22222222-2222-4222-8222-222222222222'

describe('finishDeprovisionCredentials user intersection', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env[FLAG]
  })

  it('revokes only the candidate user on the departed connection', async () => {
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A]), grantIds: ['slg.candidate'] })
    store.revokeForUserInScope.mockImplementation(async () => {
      trace.push('revoke-user')
      return { grantIds: ['slg.candidate'] }
    })
    const client = {
      async query(sql: string) {
        if (sql.includes('AS usable')) {
          trace.push('password')
          return { rows: [{ usable: true }] }
        }
        if (sql.includes('FOR UPDATE')) {
          trace.push('reselect')
          return { rows: [{ id: 'user-a' }] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    }

    const result = await finishDeprovisionCredentials(client, {
      userId: 'user-a',
      actorId: 'actor-1',
      connectionId: CONN_A,
      runId: RUN_ID,
      eventId: null,
      accountId: 'account-a',
      orgId: 'org-a',
      user: false,
      departAll: false,
      clear: false,
      grant: false,
    })

    expect(result.grantIds).toEqual(['slg.candidate'])
    expect(result.legs).toEqual({ sessions: false, tokens: false })
    expect(store.revokeForScope).not.toHaveBeenCalled()
    expect(store.revokeForUserInScope).toHaveBeenCalledTimes(1)
    expect(store.revokeForUserInScope).toHaveBeenCalledWith(
      expect.anything(),
      CONN_A,
      'user-a',
      {
        reason: 'deprovision',
        revokedBy: 'actor-1',
        revokedEventId: null,
        revokedRunId: RUN_ID,
        revokedAccountId: 'account-a',
        revokedOrgId: 'org-a',
      },
    )
    expect(store.readConnectionLoginScope).toHaveBeenCalledWith(expect.anything(), CONN_A)
    expect(store.readCurrentConnectionLoginScope).not.toHaveBeenCalled()
    expect(trace).toEqual([
      `scope:${CONN_A}`,
      'revoke-user',
      'collect',
      'prelock:watermark-user-a,watermark-user-z',
      'sessions:slg.candidate',
      'reselect',
    ])
  })

  it.each([
    { name: 'flag off', flagOn: false, clear: false, user: false, departAll: false, strict: true, expected: { sessions: false, tokens: false } },
    { name: 'clear already true', flagOn: true, clear: true, user: false, departAll: false, strict: true, expected: { sessions: true, tokens: true } },
    { name: 'user effect already selects both legs', flagOn: true, clear: false, user: true, departAll: false, strict: true, expected: { sessions: true, tokens: true } },
    { name: 'depart-all already selects both legs', flagOn: true, clear: true, user: false, departAll: true, strict: true, expected: { sessions: true, tokens: true } },
    { name: 'no grant or strict effect', flagOn: true, clear: false, user: false, departAll: false, strict: false, expected: { sessions: false, tokens: false } },
  ])('does not read remaining methods when $name', async ({ flagOn, clear, user, departAll, strict, expected }) => {
    if (flagOn) process.env[FLAG] = 'true'
    const trace: string[] = []
    const grantIds = strict ? ['slg.candidate'] : []
    installStore({ trace, strict: new Set([CONN_A]), grantIds })
    store.revokeForUserInScope.mockImplementation(async () => {
      trace.push('revoke-user')
      return { grantIds }
    })
    const statements: string[] = []
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes('AS usable') || sql.includes('user_external_auth_grants')) {
          throw new Error('remaining method read must not run')
        }
        if (sql.includes('UPDATE user_session_revocations')) return { rows: [{ user_id: 'user-a' }] }
        if (sql.includes('FOR UPDATE')) return { rows: [{ id: 'user-a' }] }
        if (sql.includes('UPDATE user_sessions') || sql.includes('UPDATE multitable_api_tokens')) return { rows: [] }
        throw new Error('unexpected query')
      },
    }

    await expect(finishDeprovisionCredentials(client, {
      userId: 'user-a', actorId: 'actor-1', connectionId: CONN_A,
      runId: RUN_ID, eventId: null, user, departAll, clear, grant: false,
    })).resolves.toEqual({ grantIds, legs: expected })

    expect(trace.slice(0, 2)).toEqual([`scope:${CONN_A}`, 'revoke-user'])
    expect(store.revokeForUserInScope).toHaveBeenCalledTimes(1)
    expect(store.revokeSessionsForExactGrants).toHaveBeenCalledTimes(strict ? 1 : 0)
    expect(store.readStrictLoginInstallation).not.toHaveBeenCalled()
    expect(statements.some((sql) => sql.includes('AS usable'))).toBe(false)
    expect(statements.some((sql) => sql.includes('UPDATE user_sessions'))).toBe(expected.sessions)
    expect(statements.some((sql) => sql.includes('UPDATE multitable_api_tokens'))).toBe(expected.tokens)
  })

  it.each([true, false])('still reads remaining methods when strict legs depend on them (usable password %s)', async (usable) => {
    process.env[FLAG] = 'true'
    const trace: string[] = []
    installStore({ trace, strict: new Set([CONN_A]), grantIds: ['slg.candidate'] })
    store.revokeForUserInScope.mockResolvedValue({ grantIds: ['slg.candidate'] })
    store.readStrictLoginInstallation.mockResolvedValue({ installation: 'never-installed' })
    const statements: string[] = []
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes('AS usable')) return { rows: [{ usable }] }
        if (sql.includes('user_external_auth_grants')) return { rows: [] }
        if (sql.includes('UPDATE user_session_revocations')) return { rows: [{ user_id: 'user-a' }] }
        if (sql.includes('FOR UPDATE')) return { rows: [{ id: 'user-a' }] }
        if (sql.includes('UPDATE user_sessions') || sql.includes('UPDATE multitable_api_tokens')) return { rows: [] }
        throw new Error('unexpected query')
      },
    }

    await expect(finishDeprovisionCredentials(client, {
      userId: 'user-a', actorId: 'actor-1', connectionId: CONN_A,
      runId: RUN_ID, eventId: null, user: false, departAll: false, clear: false, grant: false,
    })).resolves.toEqual({ grantIds: ['slg.candidate'], legs: { sessions: !usable, tokens: !usable } })

    expect(statements.filter((sql) => sql.includes('AS usable'))).toHaveLength(1)
    expect(store.revokeSessionsForExactGrants).toHaveBeenCalledTimes(1)
    expect(statements.some((sql) => sql.includes('UPDATE user_sessions'))).toBe(!usable)
    expect(statements.some((sql) => sql.includes('UPDATE multitable_api_tokens'))).toBe(!usable)
  })
})

describe('remaining legacy method plain reader', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks the plain scope reader and does not lock a sibling integration', async () => {
    store.readStrictLoginInstallation.mockResolvedValue({ installation: 'installed' })
    store.readCurrentConnectionLoginScope.mockImplementation(async (_caller: unknown, connectionId: string) => {
      expect(connectionId).toBe(CONN_B)
      return { installation: 'installed', scope: null }
    })
    const statements: string[] = []
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes('AS usable')) return { rows: [{ usable: false }] }
        if (sql.includes('user_external_auth_grants')) return { rows: [{ present: 1 }] }
        if (sql.includes('directory_account_links')) return { rows: [{ id: CONN_B }] }
        throw new Error(`unexpected sql: ${sql}`)
      },
    }

    await expect(noRemainingLoginMethod(client, {
      userId: 'user-a',
      departedConnectionId: CONN_A,
    })).resolves.toBe(false)

    expect(store.readCurrentConnectionLoginScope).toHaveBeenCalledTimes(1)
    expect(store.readConnectionLoginScope).not.toHaveBeenCalled()
    expect(statements.some((sql) => sql.includes('FOR SHARE') || sql.includes('FOR UPDATE'))).toBe(false)
  })

  it('does not count a sibling that the plain reader reports as strict', async () => {
    const trace: string[] = []
    store.readCurrentConnectionLoginScope.mockImplementation(async () => {
      trace.push('plain-scope')
      return {
        installation: 'installed',
        scope: { connectionId: CONN_B, commandId: 'cmd', transitionedAt: 't' },
      }
    })
    store.readStrictLoginInstallation.mockImplementation(async () => {
      trace.push('installation')
      return { installation: 'never-installed' }
    })
    const client = {
      async query(sql: string) {
        if (sql.includes('AS usable')) {
          trace.push('password')
          return { rows: [] }
        }
        if (sql.includes('user_external_auth_grants')) {
          trace.push('legacy-grant')
          return { rows: [{ present: 1 }] }
        }
        if (sql.includes('directory_account_links')) {
          trace.push('links')
          return { rows: [{ id: CONN_B }] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    }

    await expect(noRemainingLoginMethod(client, {
      userId: 'user-a',
      departedConnectionId: CONN_A,
    })).resolves.toBe(true)

    expect(trace).toEqual(['password', 'legacy-grant', 'links', 'plain-scope', 'installation'])
    expect(store.readConnectionLoginScope).not.toHaveBeenCalled()
  })

  it('keeps the ordinary issuer on the locking scope reader', async () => {
    store.readConnectionLoginScope.mockResolvedValue({
      installation: 'installed',
      scope: { connectionId: CONN_A, commandId: 'cmd', transitionedAt: 't' },
    })
    const client = {
      async query() {
        throw new Error('issuer guard does not query')
      },
    }

    await expect(assertOrdinaryIssuerAllowsLegacySession(
      client,
      closedDingTalkOrigin(CONN_A),
    )).rejects.toMatchObject({ code: 'strict_connection', statusCode: 403 })

    expect(store.readConnectionLoginScope).toHaveBeenCalledWith(expect.anything(), CONN_A)
    expect(store.readCurrentConnectionLoginScope).not.toHaveBeenCalled()
  })
})

const OFF: CredentialLegs = { sessions: false, tokens: false }
const BOTH: CredentialLegs = { sessions: true, tokens: true }
const SESSIONS_ONLY: CredentialLegs = { sessions: true, tokens: false }

function deprovision(
  overrides: Partial<Omit<Extract<ClosedCredentialFacts, { surface: 'deprovision' }>, 'surface'>>,
): ClosedCredentialFacts {
  return {
    surface: 'deprovision',
    user: false,
    departAll: false,
    clear: false,
    strict: false,
    grant: false,
    noMethod: false,
    ...overrides,
  }
}

function linked(input: {
  closesAuthorization: boolean
  strict: boolean
  clear: boolean
  noMethod: boolean
}): ClosedCredentialFacts {
  return { surface: 'linked_admin_unbind', ...input }
}

describe('selectCredentialLegs exact literal flag', () => {
  const userLeg = deprovision({ user: true })

  it('arms both broad legs only for the exact true literal', () => {
    const literals: Array<[string, NodeJS.ProcessEnv, boolean]> = [
      ['unset', {}, false],
      ['exact true', { [FLAG]: 'true' }, true],
      ['upper', { [FLAG]: 'TRUE' }, false],
      ['title', { [FLAG]: 'True' }, false],
      ['leading space', { [FLAG]: ' true' }, false],
      ['trailing space', { [FLAG]: 'true ' }, false],
      ['numeric', { [FLAG]: '1' }, false],
      ['false word', { [FLAG]: 'false' }, false],
      ['empty', { [FLAG]: '' }, false],
      ['yes', { [FLAG]: 'yes' }, false],
    ]

    for (const [label, env, on] of literals) {
      expect({ label, on: credentialRevocationFlagOn(env) }).toEqual({ label, on })
      expect({
        label,
        legs: selectCredentialLegs(userLeg, credentialRevocationFlagOn(env)),
      }).toEqual({ label, legs: on ? BOTH : OFF })
    }
  })

  it.each([
    ['deprovision user', deprovision({ user: true }), true, BOTH],
    ['deprovision depart-all with clear', deprovision({ departAll: true, clear: true }), true, BOTH],
    ['deprovision strict and clear', deprovision({ strict: true, clear: true }), true, BOTH],
    ['deprovision strict and no method', deprovision({ strict: true, noMethod: true }), true, BOTH],
    ['deprovision strict while a method remains', deprovision({ strict: true }), true, OFF],
    ['deprovision grant and clear', deprovision({ grant: true, clear: true }), true, BOTH],
    ['deprovision grant without left', deprovision({ grant: true }), true, SESSIONS_ONLY],
    ['linked close without left', linked({ closesAuthorization: true, strict: false, clear: false, noMethod: false }), true, SESSIONS_ONLY],
    ['linked close with clear', linked({ closesAuthorization: true, strict: false, clear: true, noMethod: false }), true, BOTH],
    ['linked close with no method', linked({ closesAuthorization: true, strict: false, clear: false, noMethod: true }), true, BOTH],
    ['linked close and strict without left', linked({ closesAuthorization: true, strict: true, clear: false, noMethod: false }), true, SESSIONS_ONLY],
    ['linked strict left without close', linked({ closesAuthorization: false, strict: true, clear: false, noMethod: true }), true, BOTH],
    ['linked strict without left or close', linked({ closesAuthorization: false, strict: true, clear: false, noMethod: false }), true, OFF],
    ['linked clear without close or strict', linked({ closesAuthorization: false, strict: false, clear: true, noMethod: false }), true, OFF],
    ['unlinked admin unbind', { surface: 'unlinked_admin_unbind' }, true, OFF],
    ['admin disable', { surface: 'admin_disable' }, true, OFF],
    ['privilege elevation', { surface: 'privilege_elevation' }, true, OFF],
    ['recycle purge', { surface: 'recycle_purge' }, true, OFF],
    ['legacy admin grant switch', { surface: 'legacy_admin_grant_switch' }, true, OFF],
    [
      'flag off ignores a full deprovision fact',
      deprovision({ user: true, grant: true, strict: true, clear: true, noMethod: true, departAll: true }),
      false,
      OFF,
    ],
    ['flag off ignores depart-all without clear', deprovision({ departAll: true, user: true, grant: true }), false, OFF],
  ] satisfies Array<[string, ClosedCredentialFacts, boolean, CredentialLegs]>)(
    '%s',
    (_name, facts, flagOn, legs) => {
      const env: NodeJS.ProcessEnv = flagOn ? { [FLAG]: 'true' } : {}
      expect(selectCredentialLegs(facts, credentialRevocationFlagOn(env))).toEqual(legs)
    },
  )

  it('rejects depart-all without clear only after the exact flag is on', () => {
    const facts = deprovision({
      departAll: true,
      clear: false,
      user: true,
      grant: true,
      strict: true,
      noMethod: true,
    })

    expect(selectCredentialLegs(facts, credentialRevocationFlagOn({}))).toEqual(OFF)
    expect(() => selectCredentialLegs(facts, credentialRevocationFlagOn({ [FLAG]: 'true' }))).toThrow(StrictCredentialChainError)
    try {
      selectCredentialLegs(facts, true)
      throw new Error('expected STRICT_CREDENTIAL_FACT')
    } catch (error) {
      expect(error).toBeInstanceOf(StrictCredentialChainError)
      expect(error).toMatchObject({ code: 'STRICT_CREDENTIAL_FACT' })
    }
  })
})
