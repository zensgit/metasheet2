import type { PoolClient } from 'pg'
import { describe, expect, test, vi } from 'vitest'

import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim,
  type RecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'

const identity = { actorId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'synthetic_workspace', baseId: 'synthetic_base', sheetId: 'synthetic_sheet' }
const policy = { keyId: 'synthetic_key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }
const limits = { maxBytes: 1000, timeoutMs: 100 }
const authorize = async () => true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('internal committed archive claim native lifetime', () => {
  test.each([
    { ...policy, keyId: '' }, { ...policy, keyRowVersion: '01' },
    { ...policy, leaseSeconds: 0 }, { ...policy, expiresAfterSeconds: 59 },
    { ...policy, extra: 'SENSITIVE_UNUSED_VALUE' },
  ])('invalid server policy refuses before acquisition (%#)', (bad) => {
    const pool = { connect: vi.fn(), options: { connectionTimeoutMillis: 10 } }
    expect(() => bindRecoveryArchiveOwnedClaim(pool, authorize, bad, limits))
      .toThrow('RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  test.each([
    { ...limits, maxBytes: 0 }, { ...limits, maxBytes: 1.5 },
    { ...limits, timeoutMs: 0 }, { ...limits, timeoutMs: 2147483648 },
    { ...limits, extra: true },
  ])('invalid explicit budget refuses before acquisition (%#)', (bad) => {
    const pool = { connect: vi.fn(), options: { connectionTimeoutMillis: 10 } }
    expect(() => bindRecoveryArchiveOwnedClaim(pool, authorize, policy, bad))
      .toThrow('RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  test.each([
    { ...identity, actorId: 'SENSITIVE_INVALID_ACTOR' }, { ...identity, requestId: 'SENSITIVE_INVALID_REQUEST' },
    { ...identity, workspaceId: '' }, { ...identity, baseId: ' padded ' },
    { ...identity, sheetId: '' }, { ...identity, extra: 'SENSITIVE_ALIAS' },
  ])('invalid identity refuses before acquisition (%#)', async (bad) => {
    const pool = { connect: vi.fn(), options: { connectionTimeoutMillis: 10 } }
    await expect(bindRecoveryArchiveOwnedClaim(pool, authorize, policy, limits)(bad))
      .rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_INVALID_INPUT')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  test.each([undefined, 0, -1, 1.5, 101])('native pool acquisition timeout must be explicit finite and within budget (%#)', async (timeout) => {
    const pool = { connect: vi.fn(), options: { connectionTimeoutMillis: timeout } }
    await expect(bindRecoveryArchiveOwnedClaim(pool, authorize, policy, limits)(identity))
      .rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  test('late acquisition is discarded without any policy, BEGIN or business SQL', async () => {
    const acquire = deferred<PoolClient>()
    const query = vi.fn()
    const release = vi.fn()
    const pool = { connect: vi.fn(() => acquire.promise), options: { connectionTimeoutMillis: 10 } }
    await expect(bindRecoveryArchiveOwnedClaim(pool, authorize, policy, { ...limits, timeoutMs: 30 })(identity))
      .rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_TIME_EXCEEDED')
    acquire.resolve({ query, release } as unknown as PoolClient)
    await vi.waitFor(() => expect(release.mock.calls).toEqual([[true]]))
    expect(query).not.toHaveBeenCalled()
    expect(pool.connect).toHaveBeenCalledTimes(1)
  })

  test('stalled source-free policy response cannot issue BEGIN after expiry', async () => {
    const response = deferred<{ rows: unknown[] }>()
    const query = vi.fn(() => response.promise)
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => ({ query, release } as unknown as PoolClient)), options: { connectionTimeoutMillis: 10 } }
    await expect(bindRecoveryArchiveOwnedClaim(pool, authorize, policy, { ...limits, timeoutMs: 30 })(identity))
      .rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_TIME_EXCEEDED')
    response.resolve({ rows: [{ statement_timeout: '0' }] })
    await vi.waitFor(() => expect(release.mock.calls).toEqual([[true]]))
    await Promise.resolve()
    expect(query.mock.calls).toEqual([['SHOW statement_timeout', undefined]])
  })

  test('native acquisition errors stay values-free and do not retry', async () => {
    const pool = { connect: vi.fn(async () => { throw new Error('SENSITIVE_NATIVE_CONNECTION_VALUE') }), options: { connectionTimeoutMillis: 10 } }
    await expect(bindRecoveryArchiveOwnedClaim(pool, authorize, policy, limits)(identity))
      .rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    expect(pool.connect).toHaveBeenCalledTimes(1)
  })

  test.each([{}, { claim: true }, null])('forged capability never reads a persisted binding (%#)', (fake) => {
    expect(() => readRecoveryArchiveCommittedClaim(fake as RecoveryArchiveCommittedClaim))
      .toThrow('RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE')
  })
})
