/**
 * Unit test for the C1 shared authority primitive `resolveCrossBaseWriteAuthority`.
 *
 * Proves the context-agnostic two-part decision (claim==truth → base-write) and its ORDER (claim is checked
 * before authority, so a bad claim never reaches `resolveBaseWritable`). `resolveBaseWritable` is mocked directly
 * (not driven through a mock queryFn) so the test isolates the primitive's own logic + reason mapping with no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/multitable/permission-service', () => ({
  resolveBaseWritable: vi.fn(),
}))

import { resolveCrossBaseWriteAuthority } from '../../src/multitable/cross-base-write-authority'
import { resolveBaseWritable } from '../../src/multitable/permission-service'
import type { QueryFn } from '../../src/multitable/permission-service'

const mockWritable = resolveBaseWritable as unknown as ReturnType<typeof vi.fn>
// A stand-in queryFn; it is only ever forwarded to (the mocked) resolveBaseWritable, never executed here.
const qf = (async () => ({ rows: [] })) as unknown as QueryFn

describe('resolveCrossBaseWriteAuthority (C1 shared primitive)', () => {
  beforeEach(() => mockWritable.mockReset())

  it('claim_mismatch when the claim is null — authority NOT consulted (claim checked first)', async () => {
    const r = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: 'baseA', declaredBaseClaim: null, queryFn: qf })
    expect(r).toEqual({ ok: false, reason: 'claim_mismatch' })
    expect(mockWritable).not.toHaveBeenCalled()
  })

  it('claim_mismatch when the claim != target base — authority NOT consulted', async () => {
    const r = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: 'baseA', declaredBaseClaim: 'baseB', queryFn: qf })
    expect(r).toEqual({ ok: false, reason: 'claim_mismatch' })
    expect(mockWritable).not.toHaveBeenCalled()
  })

  it('null target base → claim_mismatch up front, authority NOT consulted (a null base is never writable)', async () => {
    // Even with a claim that "matches" a null target, a null base admits no valid opt-in and is not writable.
    const rClaimNull = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: null, declaredBaseClaim: null, queryFn: qf })
    const rClaimStr = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: null, declaredBaseClaim: 'baseA', queryFn: qf })
    expect(rClaimNull).toEqual({ ok: false, reason: 'claim_mismatch' })
    expect(rClaimStr).toEqual({ ok: false, reason: 'claim_mismatch' })
    expect(mockWritable).not.toHaveBeenCalled()
  })

  it('not_writable when claim==target but base-write is denied', async () => {
    mockWritable.mockResolvedValue(false)
    const r = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: 'baseA', declaredBaseClaim: 'baseA', queryFn: qf })
    expect(r).toEqual({ ok: false, reason: 'not_writable' })
    expect(mockWritable).toHaveBeenCalledWith('u1', qf, 'baseA')
  })

  it('ok when claim==target and base-write is granted', async () => {
    mockWritable.mockResolvedValue(true)
    const r = await resolveCrossBaseWriteAuthority({ actorId: 'u1', targetBaseId: 'baseA', declaredBaseClaim: 'baseA', queryFn: qf })
    expect(r).toEqual({ ok: true })
  })

  it('forwards a null actorId through to resolveBaseWritable (fail-closed handled downstream)', async () => {
    mockWritable.mockResolvedValue(false)
    await resolveCrossBaseWriteAuthority({ actorId: null, targetBaseId: 'baseA', declaredBaseClaim: 'baseA', queryFn: qf })
    expect(mockWritable).toHaveBeenCalledWith(null, qf, 'baseA')
  })
})
