/**
 * O2-S2 — per-surface discriminating tests, SERVICE layer.
 *
 * For each enumerated service write surface: inject the marker 40001 at the surface's
 * database seam → the surface throws the NAMED retryable RecoveryConflictError (positive
 * exact assertions — code + retryable, never notEqual); inject a non-40001 error → the
 * SAME error object comes back out (`toBe`), proving the non-conflict path is
 * byte-identical.
 *
 * Surfaces covered here:
 *   - auth/invite-accept-writes.ts  (applyInviteAcceptanceWrites)
 *   - auth/user-activate.ts         (activatePendingUser)
 *   - directory/deprovision-ledger.ts (applyDirectoryDeprovisionCandidate)
 *   - directory/deprovision-evidence-api.ts (restoreDeprovisionEvent,
 *     compensateSupersededDenyGrant)
 *   - directory/directory-sync.ts   (unbindDirectoryAccount, bindDirectoryAccount,
 *     admitDirectoryAccountUser, syncDirectoryIntegration's local-apply — O2-A1)
 *   - auth/dingtalk-oauth.ts        (createProvisionedUser via the test seam,
 *     bindDingTalkIdentityToUser, unbindSelfManagedDingTalkIdentity — O2-A1)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))

// O2-A1: the full-run sync leg needs the DingTalk pull seams stubbed (zero directories /
// zero users — the apply body still opens the local-apply transaction, which is the
// census call site under test).
const dingtalkClientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/dingtalk/client')>()
  return {
    ...actual,
    fetchDingTalkAppAccessToken: dingtalkClientMocks.fetchDingTalkAppAccessToken,
    listDingTalkDepartments: dingtalkClientMocks.listDingTalkDepartments,
    listDingTalkDepartmentUsers: dingtalkClientMocks.listDingTalkDepartmentUsers,
    getDingTalkUserDetail: dingtalkClientMocks.getDingTalkUserDetail,
    getDingTalkDepartmentDetail: dingtalkClientMocks.getDingTalkDepartmentDetail,
  }
})

// Keep the admission leg fast: real bcrypt at minimal cost.
vi.mock('../../src/security/auth-runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/auth-runtime-config')>()
  return {
    ...actual,
    getBcryptSaltRounds: () => 4,
  }
})

import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RecoveryConflictError,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { applyInviteAcceptanceWrites } from '../../src/auth/invite-accept-writes'
import { activatePendingUser } from '../../src/auth/user-activate'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  compensateSupersededDenyGrant,
  restoreDeprovisionEvent,
} from '../../src/directory/deprovision-evidence-api'
import {
  admitDirectoryAccountUser,
  bindDirectoryAccount,
  syncDirectoryIntegration,
  unbindDirectoryAccount,
} from '../../src/directory/directory-sync'
import {
  __dingtalkOAuthInternalsForTests,
  bindDingTalkIdentityToUser,
  unbindSelfManagedDingTalkIdentity,
} from '../../src/auth/dingtalk-oauth'

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function otherDbError(): Error & { code: string } {
  return Object.assign(new Error('column "ghost" does not exist'), { code: '42703' })
}

/** transaction() runs the handler against a client whose FIRST query rejects. */
function installRejectingTransaction(error: unknown): void {
  pgMocks.transaction.mockImplementation(async (
    handler: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
  ) => handler({ query: vi.fn().mockRejectedValue(error) }))
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the surface to reject, but it resolved')
    },
    (error: unknown) => error,
  )
}

function expectNamedConflict(caught: unknown): void {
  expect(caught).toBeInstanceOf(RecoveryConflictError)
  expect((caught as RecoveryConflictError).code).toBe(RECOVERY_CONFLICT_HTTP_CODE)
  expect((caught as RecoveryConflictError).retryable).toBe(true)
}

beforeEach(() => {
  vi.unstubAllEnvs()
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  for (const mock of Object.values(dingtalkClientMocks)) mock.mockReset()
})

describe('applyInviteAcceptanceWrites (auth/invite-accept-writes.ts)', () => {
  const input = {
    inviteToken: 'tok',
    userId: 'user-1',
    email: 'user-1@example.com',
    passwordHash: 'hash',
    requestedName: '',
  }

  it('[recovery-census:invite-accept-writes:apply] marker 40001 at the users write seam → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(applyInviteAcceptanceWrites(input)))
  })

  it('non-40001 error → the SAME object rethrows (byte-identical path)', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(applyInviteAcceptanceWrites(input))).toBe(original)
  })
})

describe('activatePendingUser (auth/user-activate.ts)', () => {
  const input = { userId: 'user-1', mode: 'admin_no_password' as const, adminUserId: 'admin-1' }

  it('[recovery-census:user-activate:activate] marker 40001 at the users write seam → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(activatePendingUser(input)))
  })

  it('non-40001 error → the SAME object rethrows (ACTIVATE_* semantics untouched)', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(activatePendingUser(input))).toBe(original)
  })
})

describe('applyDirectoryDeprovisionCandidate (directory/deprovision-ledger.ts)', () => {
  const input = {
    localUserId: 'user-1',
    orgId: 'org-1',
    integrationId: '11111111-1111-4111-8111-111111111111',
    directoryAccountId: '22222222-2222-4222-8222-222222222222',
    runId: '33333333-3333-4333-8333-333333333333',
    triggeredBy: 'admin-1',
    policy: 'mark_inactive' as const,
    write: true,
  }

  it('[recovery-census:deprovision-ledger:apply] marker 40001 from the caller-supplied client → named retryable RecoveryConflictError', async () => {
    const client = { query: vi.fn().mockRejectedValue(markerError()) }
    expectNamedConflict(await caughtFrom(applyDirectoryDeprovisionCandidate(client, input)))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    const original = otherDbError()
    const client = { query: vi.fn().mockRejectedValue(original) }
    expect(await caughtFrom(applyDirectoryDeprovisionCandidate(client, input))).toBe(original)
  })
})

describe('deprovision evidence writers (directory/deprovision-evidence-api.ts)', () => {
  it('[recovery-census:deprovision-evidence:restore] restoreDeprovisionEvent: marker 40001 → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(restoreDeprovisionEvent({
      eventId: '44444444-4444-4444-8444-444444444444',
      mode: 'rehire',
      adminUserId: 'admin-1',
    })))
  })

  it('restoreDeprovisionEvent: non-40001 error → the SAME object rethrows', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(restoreDeprovisionEvent({
      eventId: '44444444-4444-4444-8444-444444444444',
      mode: 'rehire',
      adminUserId: 'admin-1',
    }))).toBe(original)
  })

  it('[recovery-census:deprovision-evidence:compensate] compensateSupersededDenyGrant: marker 40001 → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(compensateSupersededDenyGrant({
      eventId: '44444444-4444-4444-8444-444444444444',
      adminUserId: 'admin-1',
      confirm: true,
      note: 'compensating orphan deny row',
    })))
  })

  it('compensateSupersededDenyGrant: coded refusals still surface UNCHANGED (fail-closed intact)', async () => {
    // The confirm gate throws BEFORE any transaction — the wiring must not touch it.
    const caught = await caughtFrom(compensateSupersededDenyGrant({
      eventId: '44444444-4444-4444-8444-444444444444',
      adminUserId: 'admin-1',
      confirm: false,
    }))
    expect((caught as { code?: string }).code).toBe('COMPENSATION_CONFIRM_REQUIRED')
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })
})

describe('unbindDirectoryAccount (directory/directory-sync.ts)', () => {
  it('[recovery-census:directory-sync:unbind] marker 40001 inside the unbind transaction → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(unbindDirectoryAccount(
      '22222222-2222-4222-8222-222222222222',
      { adminUserId: 'admin-1' },
    )))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(unbindDirectoryAccount(
      '22222222-2222-4222-8222-222222222222',
      { adminUserId: 'admin-1' },
    ))).toBe(original)
  })
})

describe('createProvisionedUser (auth/dingtalk-oauth.ts JIT users INSERT)', () => {
  const dtUser = {
    openId: 'open-1',
    unionId: 'union-1',
    nick: 'JIT User',
    email: null as string | null,
    mobile: null as string | null,
  }

  it('[recovery-census:dingtalk-oauth:provision] marker 40001 at the users INSERT → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(
      __dingtalkOAuthInternalsForTests.createProvisionedUser(dtUser as never),
    ))
  })

  it('non-40001 error → the SAME object rethrows (fail-closed mappings untouched)', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(
      __dingtalkOAuthInternalsForTests.createProvisionedUser(dtUser as never),
    )).toBe(original)
  })
})

// O2-A1 (census reachability): the remaining translateRecoveryConflict call sites in
// auth/dingtalk-oauth.ts and directory/directory-sync.ts each get their own
// discriminating leg — dead-branching (unwrapping) any one translate site makes exactly
// its leg red (the raw marker 40001 would escape instead of the named conflict).
describe('bindDingTalkIdentityToUser (auth/dingtalk-oauth.ts self/admin bind)', () => {
  const input = {
    localUserId: 'user-1',
    dtUser: {
      openId: 'open-1',
      unionId: 'union-1',
      nick: 'Alpha',
      email: null as string | null,
      mobile: null as string | null,
    },
    boundBy: 'user-1',
    enableGrant: true,
  }

  function stubOauthEnv(): void {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'client-id')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://example.com/callback')
  }

  it('[recovery-census:dingtalk-oauth:bind-identity] marker 40001 under the access-graph mutex → named retryable RecoveryConflictError', async () => {
    stubOauthEnv()
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(bindDingTalkIdentityToUser(input as never)))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    stubOauthEnv()
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(bindDingTalkIdentityToUser(input as never))).toBe(original)
  })
})

describe('unbindSelfManagedDingTalkIdentity (auth/dingtalk-oauth.ts)', () => {
  const input = { localUserId: 'user-1', actorId: 'user-1' }

  it('[recovery-census:dingtalk-oauth:self-unbind] marker 40001 under the access-graph mutex → named retryable RecoveryConflictError', async () => {
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(unbindSelfManagedDingTalkIdentity(input)))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(unbindSelfManagedDingTalkIdentity(input))).toBe(original)
  })
})

describe('bindDirectoryAccount (directory/directory-sync.ts manual bind)', () => {
  function installBindLoaders(): void {
    pgMocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM directory_accounts')) {
        return {
          rows: [{
            id: 'account-1',
            integration_id: 'dir-1',
            provider: 'dingtalk',
            corp_id: 'dingcorp',
            external_user_id: 'ext-1',
            union_id: 'union-1',
            open_id: 'open-1',
            external_key: 'union-1',
            name: '林岚',
            email: null,
            mobile: null,
            is_active: true,
          }],
        }
      }
      if (text.includes('FROM directory_account_links')) return { rows: [] }
      if (text.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            name: 'Alpha',
            role: 'user',
            is_active: true,
          }],
        }
      }
      return { rows: [] }
    })
  }

  it('[recovery-census:directory-sync:bind] marker 40001 inside the bind transaction → named retryable RecoveryConflictError', async () => {
    installBindLoaders()
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(bindDirectoryAccount('account-1', {
      localUserRef: 'user-1',
      adminUserId: 'admin-1',
    })))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    installBindLoaders()
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(bindDirectoryAccount('account-1', {
      localUserRef: 'user-1',
      adminUserId: 'admin-1',
    }))).toBe(original)
  })
})

describe('admitDirectoryAccountUser (directory/directory-sync.ts manual admission)', () => {
  function installAdmitLoaders(): void {
    pgMocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM directory_accounts')) {
        return {
          rows: [{
            id: 'account-1',
            integration_id: 'dir-1',
            provider: 'dingtalk',
            corp_id: 'dingcorp',
            external_user_id: 'ext-1',
            union_id: 'union-1',
            open_id: 'open-1',
            external_key: 'union-1',
            name: '林岚',
            email: null,
            mobile: null,
            is_active: true,
          }],
        }
      }
      if (text.includes('FROM directory_account_links')) return { rows: [] }
      return { rows: [] }
    })
  }

  it('[recovery-census:directory-sync:admit] marker 40001 inside the admission transaction → named retryable RecoveryConflictError', async () => {
    installAdmitLoaders()
    installRejectingTransaction(markerError())
    expectNamedConflict(await caughtFrom(admitDirectoryAccountUser('account-1', {
      adminUserId: 'admin-1',
      name: 'New User',
      email: 'new@example.com',
    })))
  })

  it('non-40001 error → the SAME object rethrows', async () => {
    installAdmitLoaders()
    const original = otherDbError()
    installRejectingTransaction(original)
    expect(await caughtFrom(admitDirectoryAccountUser('account-1', {
      adminUserId: 'admin-1',
      name: 'New User',
      email: 'new@example.com',
    }))).toBe(original)
  })
})

describe('syncDirectoryIntegration (directory/directory-sync.ts local-apply transaction)', () => {
  const INTEGRATION_ROW = {
    id: 'dir-1',
    org_id: 'default',
    provider: 'dingtalk',
    name: 'DingTalk CN',
    status: 'active',
    corp_id: 'dingcorp',
    config: { appKey: 'k', appSecret: 's' },
    sync_enabled: true,
    schedule_cron: null,
    default_deprovision_policy: 'mark_inactive',
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
  }

  /**
   * Full-run harness (same dispatcher idiom as directory-sync-run-lease.test.ts): the
   * lease machinery runs against scripted bare queries; the DingTalk pull returns zero
   * departments/users; the local-apply transaction is the injection seam.
   */
  function installFullRunMocks(): void {
    pgMocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('INSERT INTO directory_sync_runs')) {
        return {
          rows: [{
            id: 'run-1',
            integration_id: 'dir-1',
            status: 'running',
            started_at: '2026-07-09T00:00:00.000Z',
            finished_at: null,
            stats: {},
            error_message: null,
            triggered_by: 'admin-1',
            trigger_source: 'scheduler',
            created_at: '2026-07-09T00:00:00.000Z',
            updated_at: '2026-07-09T00:00:00.000Z',
          }],
        }
      }
      if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
      return { rows: [] }
    })
    dingtalkClientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
    dingtalkClientMocks.listDingTalkDepartments.mockResolvedValue([])
    dingtalkClientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    dingtalkClientMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false, nextCursor: null })
  }

  /**
   * Only the FIRST transaction (the local apply) rejects; the failure-path bookkeeping
   * (markSyncFailure's own transaction) must still succeed, or its raw error would
   * REPLACE the translated conflict on the way out.
   */
  function installApplyRejection(error: unknown): void {
    pgMocks.transaction.mockImplementation(async (
      handler: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => handler({ query: async () => ({ rows: [] }) }))
    pgMocks.transaction.mockRejectedValueOnce(error)
  }

  it('[recovery-census:directory-sync:sync-local-apply] marker 40001 from the local-apply transaction → named retryable RecoveryConflictError', async () => {
    installFullRunMocks()
    installApplyRejection(markerError())
    expectNamedConflict(await caughtFrom(
      syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler'),
    ))
  })

  it('non-40001 apply failure → the SAME object rethrows (run-failure semantics unchanged)', async () => {
    installFullRunMocks()
    const original = otherDbError()
    installApplyRejection(original)
    expect(await caughtFrom(
      syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler'),
    )).toBe(original)
  })
})
