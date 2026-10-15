import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (handler: (c: { query: typeof pgMocks.query }) => Promise<unknown>) =>
    handler({ query: pgMocks.query }),
  ),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/auth/login-alias-service', () => ({
  claimLoginAlias: vi.fn(async () => ({ ok: true, normalized: 'x' })),
}))

import { activatePendingUser, isActivateMode } from '../../src/auth/user-activate'

/**
 * Closeout review P1 (2026-08-08): EVERY activation mode now resolves the authoritative
 * directory source, so the ordinary positive controls carry a linked active source row and the
 * membership org DERIVES from `integration_org_id` — never from the caller.
 */
const LINKED_ACTIVE_SOURCE = {
  id: 'da-1',
  account_active: true,
  integration_status: 'active',
  local_user_id: 'u1',
  link_status: 'linked',
  account_provider: 'dingtalk',
  integration_provider: 'dingtalk',
  account_corp_id: 'corp-1',
  integration_corp_id: 'corp-1',
  account_open_id: null,
  account_union_id: null,
  integration_org_id: 'org-src',
}

describe('activatePendingUser (T3)', () => {
  beforeEach(async () => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockImplementation(
      async (handler: (c: { query: typeof pgMocks.query }) => Promise<unknown>) =>
        handler({ query: pgMocks.query }),
    )
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockReset()
    vi.mocked(claimLoginAlias).mockResolvedValue({ ok: true, normalized: 'x' })
  })

  it('keeps the runtime activation mode set closed', () => {
    expect(['temp_password', 'sso', 'admin_no_password'].map(isActivateMode)).toEqual([
      true,
      true,
      true,
    ])
    for (const value of ['', 'passwordish', 'SSO', null, 1, {}, []]) {
      expect(isActivateMode(value)).toBe(false)
    }
  })

  it('promotes pending → activated with temp password in one transaction', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: 'alice',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] }) // directory source resolution
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] }) // UPDATE users RETURNING
      .mockResolvedValueOnce({ rows: [] }) // user_orgs membership (derived org)
      .mockResolvedValueOnce({ rows: [] }) // supersede effects
      .mockResolvedValueOnce({ rows: [] }) // supersede events
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] }) // generation

    const result = await activatePendingUser({
      userId: 'u1',
      mode: 'temp_password',
      temporaryPassword: 'TempPass9A!',
    })
    expect(result.activationStatus).toBe('activated')
    expect(result.isActive).toBe(true)
    expect(result.temporaryPassword).toBe('TempPass9A!')
    expect(result.localPasswordSet).toBe(true)
    expect(pgMocks.transaction).toHaveBeenCalled()
    const updateSql = String(pgMocks.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))?.[0] || '')
    expect(updateSql).toContain("activation_status = 'activated'")
    expect(updateSql).toContain('local_password_set')
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_events'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
    // Membership org comes from the SOURCE INTEGRATION (no orgId was supplied at all).
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-src'])
    // Alias claims must run inside the transaction client
    expect(claimLoginAlias).toHaveBeenCalled()
    expect(vi.mocked(claimLoginAlias).mock.calls[0]?.[0]).toMatchObject({
      userId: 'u1',
      kind: 'email',
      client: expect.objectContaining({ query: expect.any(Function) }),
    })
  })

  it('maps alias conflict to ACTIVATE_ALIAS_CONFLICT without echoing claim.message', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockResolvedValueOnce({
      ok: false,
      code: 'ALIAS_CONFLICT',
      message: 'relation "user_login_aliases" does not exist DETAIL: secret',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'taken@x.com',
        username: null,
        mobile: null,
        activation_status: 'pending_activation',
        is_active: false,
      }],
    })
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })

    let thrown: unknown
    try {
      await activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'ACTIVATE_ALIAS_CONFLICT' })
    expect(String((thrown as Error).message)).not.toMatch(/relation|DETAIL|secret/i)
    expect(claimLoginAlias).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.anything() }),
    )
  })

  it('maps ALIAS_WRITE_FAILED to ACTIVATE_ALIAS_FAILED (not conflict)', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockResolvedValueOnce({
      ok: false,
      code: 'ALIAS_WRITE_FAILED',
      message: 'connection refused 5432',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        activation_status: 'pending_activation',
        is_active: false,
      }],
    })
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' }),
    ).rejects.toMatchObject({
      code: 'ACTIVATE_ALIAS_FAILED',
      message: 'Failed to claim login alias during activation',
    })
  })

  it('rejects non-pending users', async () => {
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        activation_status: 'activated',
        is_active: true,
      }],
    })
    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_NOT_PENDING' })
  })

  it('rejects SSO activate when directory account inactive', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          account_active: false,
          integration_status: 'active',
          local_user_id: 'u1',
          link_status: 'linked',
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INACTIVE' })
  })

  it('rejects an explicit account whose link row is missing or unlinked', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          account_active: true,
          integration_status: 'active',
          local_user_id: null,
          link_status: null,
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_MISSING' })
  })

  it('rejects an explicit account linked to another local user', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          account_active: true,
          integration_status: 'active',
          local_user_id: 'u-other',
          link_status: 'linked',
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_LINK_MISMATCH' })
  })

  it.each([
    {
      label: 'account provider is not DingTalk',
      account_provider: 'local',
      integration_provider: 'dingtalk',
      account_corp_id: 'corp-1',
      integration_corp_id: 'corp-1',
    },
    {
      label: 'account and integration corp ids differ',
      account_provider: 'dingtalk',
      integration_provider: 'dingtalk',
      account_corp_id: 'corp-a',
      integration_corp_id: 'corp-b',
    },
  ])('rejects SSO when $label', async (source) => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          account_active: true,
          integration_status: 'active',
          local_user_id: 'u1',
          link_status: 'linked',
          ...source,
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INELIGIBLE' })
  })

  it('accepts an implicit SSO source when at least one linked DingTalk source is active', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            account_active: false,
            integration_status: 'active',
            local_user_id: 'u1',
            link_status: 'linked',
            account_provider: 'dingtalk',
            integration_provider: 'dingtalk',
            account_corp_id: 'corp-1',
            integration_corp_id: 'corp-1',
            integration_org_id: 'org-1',
          },
          {
            account_active: true,
            integration_status: 'active',
            local_user_id: 'u1',
            link_status: 'linked',
            account_provider: 'dingtalk',
            integration_provider: 'dingtalk',
            account_corp_id: 'corp-2',
            integration_corp_id: 'corp-2',
            integration_org_id: 'org-2',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
      }),
    ).resolves.toMatchObject({
      userId: 'u1',
      activationStatus: 'activated',
      localPasswordSet: false,
    })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-2'])
  })

  it('rejects activate when user has no claimable identifier', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ALIAS_REQUIRED' })
  })

  // Closeout review P1 pin-flips: the suite previously pinned "sourceless temp activation
  // succeeds" as its positive control. Pending users exist only via directory admission, and
  // the admission lock forbids activating against a dead or missing source in ANY mode — so
  // sourceless is now a REFUSAL, before any user write.
  it('refuses sourceless temp_password activation (ACTIVATE_SOURCE_MISSING), writing nothing', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: 'alice',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // no linked source at all

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_MISSING' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('refuses admin_no_password activation when the only source is inactive', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ ...LINKED_ACTIVE_SOURCE, account_active: false }],
      })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INACTIVE' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('rejects a client orgId that disagrees with the derived source org (ACTIVATE_ORG_MISMATCH)', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] }) // integration_org_id: 'org-src'

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-other' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ORG_MISMATCH' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('accepts a client orgId that CONFIRMS the derived org, and derives the membership write', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [LINKED_ACTIVE_SOURCE] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-src' }),
    ).resolves.toMatchObject({ activationStatus: 'activated' })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-src'])
  })

  // #4833 quartet: with several ACTIVE sources, "derive" has no unique answer — the caller's
  // orgId is validated against the SET; naming none is a refusal, not a silent pick.
  it('dual-ACTIVE different orgs + no orgId: refuses with ACTIVATE_ORG_AMBIGUOUS, writing nothing', async () => {
    const dualActive = [
      { ...LINKED_ACTIVE_SOURCE, id: 'da-1', integration_org_id: 'org-1' },
      { ...LINKED_ACTIVE_SOURCE, id: 'da-2', integration_org_id: 'org-2' },
    ]
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: dualActive })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ORG_AMBIGUOUS' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('dual-ACTIVE different orgs + orgId naming the SECOND org: activates into exactly that org', async () => {
    const dualActive = [
      { ...LINKED_ACTIVE_SOURCE, id: 'da-1', integration_org_id: 'org-1' },
      { ...LINKED_ACTIVE_SOURCE, id: 'da-2', integration_org_id: 'org-2' },
    ]
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: dualActive })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    // Under the pre-#4833 find-first shape this legitimate request answered 409.
    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-2' }),
    ).resolves.toMatchObject({ activationStatus: 'activated' })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-2'])
  })

  it('dual-ACTIVE different orgs + orgId outside the set: ACTIVATE_ORG_MISMATCH', async () => {
    const dualActive = [
      { ...LINKED_ACTIVE_SOURCE, id: 'da-1', integration_org_id: 'org-1' },
      { ...LINKED_ACTIVE_SOURCE, id: 'da-2', integration_org_id: 'org-2' },
    ]
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: dualActive })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-3' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ORG_MISMATCH' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('dual-ACTIVE SAME org: no ambiguity — the set dedupes and the org derives', async () => {
    const dualSameOrg = [
      { ...LINKED_ACTIVE_SOURCE, id: 'da-1' },
      { ...LINKED_ACTIVE_SOURCE, id: 'da-2' },
    ]
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: dualSameOrg })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).resolves.toMatchObject({ activationStatus: 'activated' })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-src'])
  })

  // Empty-org sub-branch (verify-workflow finding: this fail-closed branch survived every
  // mutation probe untested). An active source whose integration carries no org cannot anchor
  // a membership write: alone it must refuse; alongside a real org it must simply not vote.
  it('sole ACTIVE source with empty integration org: refuses ACTIVATE_SOURCE_INELIGIBLE, writing nothing', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ ...LINKED_ACTIVE_SOURCE, integration_org_id: '  ' }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-src' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INELIGIBLE' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })

  it('empty-org ACTIVE source next to a real one: does not vote — the real org derives without ambiguity', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { ...LINKED_ACTIVE_SOURCE, id: 'da-1', integration_org_id: '' },
          { ...LINKED_ACTIVE_SOURCE, id: 'da-2', integration_org_id: 'org-2' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).resolves.toMatchObject({ activationStatus: 'activated', membershipOrgId: 'org-2' })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-2'])
  })

  // Dual-org: the person's ACTIVE source lives in org-2; a caller pointing at org-1 (their
  // other, inactive badge's org — or any org at all) must not be able to steer the membership.
  it('dual-org: derives the ACTIVE source org and refuses a caller steering to the other org', async () => {
    const dualRows = [
      {
        ...LINKED_ACTIVE_SOURCE,
        id: 'da-1',
        account_active: false,
        integration_org_id: 'org-1',
      },
      {
        ...LINKED_ACTIVE_SOURCE,
        id: 'da-2',
        account_active: true,
        integration_org_id: 'org-2',
      },
    ]
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: dualRows })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password', orgId: 'org-1' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ORG_MISMATCH' })
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE users'))).toBe(false)
  })
})

describe('activatePendingUser — DT-HARDEN-02 grant check (same predicate as the directory page)', () => {
  const PENDING_ROW = {
    id: 'u1',
    email: 'a@x.com',
    username: 'alice',
    mobile: null,
    activation_status: 'pending_activation',
    is_active: false,
  }

  function installQueries(
    linkedAccounts: Array<Record<string, unknown>>,
    sourceRow: Record<string, unknown> = LINKED_ACTIVE_SOURCE,
  ): void {
    pgMocks.query.mockReset()
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (/FROM users[\s\S]*FOR UPDATE/.test(statement)) return { rows: [PENDING_ROW] }
      if (statement.includes('AS linked_identity_open_id')) return { rows: linkedAccounts }
      if (/FROM directory_accounts|FROM directory_account_links/.test(statement)) return { rows: [sourceRow] }
      if (statement.includes('UPDATE users') && statement.includes("activation_status = 'activated'")) return { rows: [{ id: 'u1' }] }
      if (statement.includes('access_generation = COALESCE')) return { rows: [{ access_generation: 1 }] }
      return { rows: [] }
    })
  }

  const grantWrites = () => pgMocks.query.mock.calls.filter((call) =>
    String(call[0]).includes('INSERT INTO user_external_auth_grants'))
  const activationWrites = () => pgMocks.query.mock.calls.filter((call) =>
    String(call[0]).includes("activation_status = 'activated'"))

  it('refuses a non-SSO grant for a corp member with no openId anywhere — before any write', async () => {
    installQueries([{ corp_id: 'corp-1', open_id: null, linked_identity_open_id: null }])
    for (const mode of ['admin_no_password', 'temp_password'] as const) {
      await expect(activatePendingUser({ userId: 'u1', mode, enableDingTalkGrant: true }))
        .rejects.toMatchObject({ code: 'ACTIVATE_DINGTALK_OPEN_ID_REQUIRED' })
    }
    expect(grantWrites()).toHaveLength(0)
    expect(activationWrites()).toHaveLength(0)
    const check = pgMocks.query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes('AS linked_identity_open_id'))
    // the shared corp+union-scoped subquery, over the user's LINKED DingTalk accounts
    expect(check).toContain('identity.corp_id = account.corp_id')
    expect(check).toContain('identity.provider_union_id = account.union_id')
    expect(check).toContain("link.link_status = 'linked'")
  })

  it('grants when the openId is known from the member\'s own DingTalk login (linked identity, same corp+union)', async () => {
    installQueries([{ corp_id: 'corp-1', open_id: null, linked_identity_open_id: 'open-linked' }])
    await activatePendingUser({ userId: 'u1', mode: 'admin_no_password', enableDingTalkGrant: true })
    expect(grantWrites()).toHaveLength(1)
  })

  it('does not run the check when no grant is requested', async () => {
    installQueries([{ corp_id: 'corp-1', open_id: null, linked_identity_open_id: null }])
    await activatePendingUser({ userId: 'u1', mode: 'admin_no_password' })
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('AS linked_identity_open_id'))).toBe(false)
    expect(grantWrites()).toHaveLength(0)
  })

  it('admin-route SSO (mode sso, NO expectedDingTalkIdentity — what POST /activate forwards) cannot grant a corp member with no openId', async () => {
    // exactly the input shape routes/admin-users.ts builds: mode + adminUserId + grant flag, no
    // expected identity — so the SSO source match pins no openId and only this check stands.
    installQueries([{ corp_id: 'corp-1', open_id: null, linked_identity_open_id: null }])
    await expect(activatePendingUser({
      userId: 'u1',
      mode: 'sso',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toMatchObject({ code: 'ACTIVATE_DINGTALK_OPEN_ID_REQUIRED' })
    expect(grantWrites()).toHaveLength(0)
    expect(activationWrites()).toHaveLength(0)
  })

  it('DingTalk-callback SSO (expected identity pins the source openId) still activates and grants', async () => {
    const expected = { corpId: 'corp-1', openId: 'open-scan', unionId: 'union-scan' }
    installQueries(
      [{ corp_id: 'corp-1', open_id: 'open-scan', linked_identity_open_id: null }],
      { ...LINKED_ACTIVE_SOURCE, account_open_id: 'open-scan', account_union_id: 'union-scan' },
    )
    const result = await activatePendingUser({
      userId: 'u1',
      mode: 'sso',
      adminUserId: 'admin-1',
      directoryAccountId: 'da-1',
      enableDingTalkGrant: true,
      expectedDingTalkIdentity: expected,
    })
    expect(result.activationStatus).toBe('activated')
    expect(grantWrites()).toHaveLength(1)
  })

  it('checks only the sources this activation can use: active, linked, and the named account when given', async () => {
    installQueries([{ corp_id: 'corp-1', open_id: 'open-1', linked_identity_open_id: null }])
    await activatePendingUser({ userId: 'u1', mode: 'admin_no_password', directoryAccountId: 'da-1', enableDingTalkGrant: true })
    const check = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('AS linked_identity_open_id'))
    expect(String(check?.[0])).toContain('account.is_active = TRUE')
    expect(String(check?.[0])).toContain('($2::uuid IS NULL OR account.id = $2::uuid)')
    expect(check?.[1]).toEqual(['u1', 'da-1'])
  })
})
