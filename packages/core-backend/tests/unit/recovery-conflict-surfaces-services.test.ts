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
 *   - directory/directory-sync.ts   (unbindDirectoryAccount)
 *   - auth/dingtalk-oauth.ts        (createProvisionedUser via the test seam)
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
import { unbindDirectoryAccount } from '../../src/directory/directory-sync'
import { __dingtalkOAuthInternalsForTests } from '../../src/auth/dingtalk-oauth'

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
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
})

describe('applyInviteAcceptanceWrites (auth/invite-accept-writes.ts)', () => {
  const input = {
    inviteToken: 'tok',
    userId: 'user-1',
    email: 'user-1@example.com',
    passwordHash: 'hash',
    requestedName: '',
  }

  it('marker 40001 at the users write seam → named retryable RecoveryConflictError', async () => {
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

  it('marker 40001 at the users write seam → named retryable RecoveryConflictError', async () => {
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

  it('marker 40001 from the caller-supplied client → named retryable RecoveryConflictError', async () => {
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
  it('restoreDeprovisionEvent: marker 40001 → named retryable RecoveryConflictError', async () => {
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

  it('compensateSupersededDenyGrant: marker 40001 → named retryable RecoveryConflictError', async () => {
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
  it('marker 40001 inside the unbind transaction → named retryable RecoveryConflictError', async () => {
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

  it('marker 40001 at the users INSERT → named retryable RecoveryConflictError', async () => {
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
