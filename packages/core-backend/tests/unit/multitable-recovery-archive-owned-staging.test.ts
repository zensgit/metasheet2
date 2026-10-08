import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
import { persistRecoveryArchiveOwnedPreparedInventory } from '../../src/multitable/recovery-archive-owned-staging'
import { registerRecoveryArchiveStagingObject } from '../../src/multitable/recovery-archive-abandoned-object-cleanup'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), persist: vi.fn() }))
vi.mock('../../src/multitable/recovery-archive-prepared-capture', () => ({ persistRecoveryArchivePreparedCapture: mocks.persist }))
vi.mock('../../src/multitable/recovery-archive-abandoned-object-cleanup', async original => ({
  ...await original<typeof import('../../src/multitable/recovery-archive-abandoned-object-cleanup')>(),
  recoveryArchivePreparedStagingPlan: mocks.plan,
}))
beforeEach(() => { mocks.persist.mockReset(); mocks.plan.mockReset() })
const owner = { generationId: randomUUID(), ownerKind: 'archive_builder', ownerId: randomUUID(), ownerFence: '1', sourceVectorHash: 'a'.repeat(64) }
const storeId = randomUUID(), stagingId = randomUUID(), expires = '2099-01-01T00:00:00.000Z'
const attachment = { objectClass: 'attachment' as const, attachmentId: 'attachment', keyId: 'key',
  binding: { generationId: owner.generationId, objectId: 'b'.repeat(64), expectedVersion: 'b'.repeat(64), expectedSha256: 'b'.repeat(64), expectedSize: '32', expectedExpiresAt: expires } }
const plan = [attachment, { ...attachment, objectClass: 'section', attachmentId: null, binding: { ...attachment.binding, objectId: 'c'.repeat(64), expectedVersion: 'c'.repeat(64), expectedSha256: 'c'.repeat(64) } }]

function fixture(changes: Record<string, unknown> = {}, count = 1) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const intent = { staging_object_id: stagingId, object_class: 'attachment', attachment_id: 'attachment', key_id: 'key', object_state: 'pending', object_id: null,
    terminal_receipt_sha256: null, cleanup_owner_kind: null, cleanup_owner_id: null, cleanup_owner_fence: null, ...changes }
  const query: SealQuery = async (sql, params = []) => {
    calls.push({ sql, params })
    const rows = sql.startsWith('SELECT s.object_class') || sql.startsWith('SELECT s.staging_object_id') ? Array.from({ length: count }, () => ({ ...intent })) : []
    return { rows, rowCount: rows.length }
  }
  mocks.plan.mockReturnValue(plan)
  mocks.persist.mockImplementation(async () => { calls.push({ sql: 'DURABLE_PREPARED', params: [] }) })
  return { calls, query }
}

it('persists payload and complete inventory through the SAME query, reusing exact unbound attachment intent', async () => {
  const f = fixture(), payload = Buffer.from('synthetic sealed envelope')
  await persistRecoveryArchiveOwnedPreparedInventory(f.query, owner, payload, expires, storeId)
  expect(mocks.persist).toHaveBeenCalledWith(f.query, owner, payload)
  const inserts = f.calls.filter(row => row.sql.startsWith('INSERT INTO public.meta_recovery_archive_abandoned_bindings'))
  expect(inserts).toHaveLength(2); expect(inserts[0]!.params[1]).toBe(stagingId)
  expect(inserts.every(row => row.params[11] === storeId)).toBe(true)
  expect(f.calls.filter(row => row.sql.startsWith('INSERT INTO public.meta_recovery_archive_staging_objects'))).toHaveLength(1)
  expect(f.calls.findIndex(row => row.sql === 'DURABLE_PREPARED')).toBeLessThan(f.calls.findIndex(row => row.sql.startsWith('INSERT INTO')))
  expect(f.calls.filter(row => row.sql.startsWith('UPDATE public.meta_recovery_archive_staging_objects'))).toHaveLength(2)
})

it.each([{ key_id: 'foreign' }, { attachment_id: 'replacement' }, { object_state: 'sealed' }, { object_id: 'already-bound' }])(
  'rejects substituted/partial claim inventory before payload commit: %j', async change => {
    const f = fixture(change)
    await expect(persistRecoveryArchiveOwnedPreparedInventory(f.query, owner, Buffer.from('sealed'), expires, storeId)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
    expect(mocks.persist).not.toHaveBeenCalled(); expect(f.calls.some(row => row.sql.startsWith('INSERT'))).toBe(false)
  },
)
it.each([0, 2])('rejects missing or duplicate intent count %d before persistence', async count => {
  const f = fixture({}, count)
  await expect(persistRecoveryArchiveOwnedPreparedInventory(f.query, owner, Buffer.from('sealed'), expires, storeId)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
  expect(mocks.persist).not.toHaveBeenCalled()
})
it.each([{ terminal_receipt_sha256: 'a'.repeat(64) }, { cleanup_owner_id: randomUUID() }, { key_id: 'wrong' }])(
  'registration refuses non-pristine early intent before any binding insert', async change => {
    const f = fixture(change)
    await expect(registerRecoveryArchiveStagingObject(f.query, owner, attachment, storeId)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect(f.calls.some(row => row.sql.startsWith('INSERT'))).toBe(false)
  },
)
it('legacy attachment registration with no early intent still creates its own staging row', async () => {
  const f = fixture({}, 0)
  await registerRecoveryArchiveStagingObject(f.query, owner, attachment, storeId)
  expect(f.calls.filter(row => row.sql.startsWith('INSERT'))).toHaveLength(2)
})

it('missing original namespace refuses BEFORE payload persistence or any SQL', async () => {
  const f = fixture()
  await expect(persistRecoveryArchiveOwnedPreparedInventory(f.query, owner, Buffer.from('sealed'), expires, undefined)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
  expect(mocks.persist).not.toHaveBeenCalled(); expect(f.calls).toEqual([])
})
