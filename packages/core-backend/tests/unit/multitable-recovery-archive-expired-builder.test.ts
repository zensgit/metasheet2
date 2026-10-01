import { randomUUID } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { abandonExpiredRecoveryArchiveBuilder } from '../../src/multitable/recovery-archive-expired-builder'
import { lockRecoveryArchiveObjectScope } from '../../src/multitable/recovery-archive-abandoned-object-cleanup'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
vi.mock('../../src/multitable/recovery-archive-abandoned-object-cleanup', () => ({ lockRecoveryArchiveObjectScope: vi.fn(async () => 'key') }))
beforeEach(() => { vi.clearAllMocks() })
const refusal = /^RECOVERY_ARCHIVE_EXPIRED_BUILDER_REFUSED$/
function fixture() {
  const input = { identity: { workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet', actorId: 'actor' },
    owner: { generationId: randomUUID(), ownerKind: 'archive_builder', ownerId: 'owner', ownerFence: '1', sourceVectorHash: 'a'.repeat(64) } }
  const query = vi.fn<Parameters<SealQuery>, ReturnType<SealQuery>>(async () => ({ rows: [{ generation_id: input.owner.generationId }] }))
  const transaction = async <T,>(work: (query: SealQuery) => Promise<T>) => work(query)
  return { input, query, transaction }
}
test('snapshots the exact server-owned scope before awaiting and uses cleanup key posture', async () => {
  const { input, query, transaction } = fixture()
  const original = structuredClone(input)
  await abandonExpiredRecoveryArchiveBuilder(transaction, async () => {
    input.owner.ownerId = 'changed'; input.identity.baseId = 'changed'; return true
  }, input)
  expect(lockRecoveryArchiveObjectScope).toHaveBeenCalledWith(query, original.identity, original.owner.generationId, false)
  expect(query).toHaveBeenCalledTimes(2)
  expect(query.mock.calls.map(call => call[1])).toEqual(Array(2).fill([
    original.owner.generationId, 'archive_builder', 'owner', '1', 'a'.repeat(64), 'workspace', 'base', 'sheet',
  ]))
})
test.each([0, 2])('requires exactly one locked generation: %i', async count => {
  const { input, query, transaction } = fixture()
  query.mockResolvedValueOnce({ rows: Array(count).fill({}) })
  await expect(abandonExpiredRecoveryArchiveBuilder(transaction, async () => true, input)).rejects.toThrow(refusal)
  expect(query).toHaveBeenCalledTimes(1)
})
test.each([0, 2])('requires exactly one CAS returned row: %i', async count => {
  const { input, query, transaction } = fixture()
  query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: Array(count).fill({}) })
  await expect(abandonExpiredRecoveryArchiveBuilder(transaction, async () => true, input)).rejects.toThrow(refusal)
})
test('authority rejection and private query failures remain values-free', async () => {
  const { input, query, transaction } = fixture()
  await expect(abandonExpiredRecoveryArchiveBuilder(transaction, async () => false, input)).rejects.toThrow(refusal)
  expect(query).not.toHaveBeenCalled()
  query.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_VALUE'))
  await expect(abandonExpiredRecoveryArchiveBuilder(transaction, async () => true, input)).rejects.toThrow(refusal)
})
test('malformed owner and snapshot exceptions refuse before a transaction', async () => {
  const { input, transaction } = fixture()
  const entered = vi.fn()
  const tx = async <T,>(work: (query: SealQuery) => Promise<T>) => { entered(); return transaction(work) }
  await expect(abandonExpiredRecoveryArchiveBuilder(tx, async () => true, { ...input, owner: { ...input.owner, ownerFence: '0' } })).rejects.toThrow(refusal)
  Object.defineProperty(input, 'identity', { get() { throw new Error('PRIVATE_INPUT_VALUE') } })
  await expect(abandonExpiredRecoveryArchiveBuilder(tx, async () => true, input)).rejects.toThrow(refusal)
  expect(entered).not.toHaveBeenCalled()
})
