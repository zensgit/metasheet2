import { describe, expect, test, vi } from 'vitest'
import { claimRecoveryArchiveObjectDeletion, takeOverRecoveryArchiveObjectDeletion,
  type RecoveryArchiveObjectClaimInput } from '../../src/multitable/recovery-archive-object-claims'

const input: RecoveryArchiveObjectClaimInput = {
  id: '00000000-0000-4000-8000-000000000001', generationId: '00000000-0000-4000-8000-000000000002',
  ownerRequestId: '00000000-0000-4000-8000-000000000003', anchorOperationId: '00000000-0000-4000-8000-000000000004',
  objectId: 'a'.repeat(64), providerOperationKey: 'b'.repeat(64), workspaceId: 'synthetic_workspace',
  baseId: 'synthetic_base', sheetId: 'synthetic_sheet', anchorSeq: '9007199254753001',
  checkpointId: 'synthetic_checkpoint', expectedRowVersion: '2', workerOwnerId: 'synthetic_worker',
}
const row = {
  id: input.id, generation_id: input.generationId, object_id: input.objectId,
  owner_request_id: input.ownerRequestId, provider_operation_key: input.providerOperationKey,
  state: 'deleting', row_version: '3', worker_owner_id: input.workerOwnerId, worker_fence: '1', attempt_count: '1',
  lease_until: '2099-01-01T00:00:00.000Z', store_id: '00000000-0000-4000-8000-000000000005',
  staging_object_id: '00000000-0000-4000-8000-000000000006', key_id: 'synthetic_key', provider_version: 'synthetic_version',
  ciphertext_sha256: 'c'.repeat(64), size_bytes: '0', object_expires_at: '2000-01-01T00:00:00.000Z', xid: '42',
}
function query(result = row) {
  return vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [result] })
}
const takeover = { ...input, expectedRowVersion: '3', previousWorkerOwnerId: input.workerOwnerId,
  previousWorkerFence: '1', previousLeaseUntil: row.lease_until }

describe('expired archive worker claim storage wrapper', () => {
  test('claim returns frozen provider binding without accepting caller namespace or lease', async () => {
    const call = query()
    const { expectedRowVersion: _version, workerOwnerId: _worker, ...identity } = input
    await expect(claimRecoveryArchiveObjectDeletion(call, input)).resolves.toEqual({ ...identity, state: 'deleting',
      rowVersion: '3', workerOwnerId: input.workerOwnerId, workerFence: '1', attemptCount: '1', leaseUntil: row.lease_until,
      storeId: row.store_id, stagingObjectId: row.staging_object_id, keyId: row.key_id, providerVersion: row.provider_version,
      ciphertextSha256: row.ciphertext_sha256, sizeBytes: '0', objectExpiresAt: row.object_expires_at })
    expect(call.mock.calls[2]?.[1]).toEqual([input.id, input.generationId, input.objectId, input.ownerRequestId,
      input.providerOperationKey, input.workspaceId, input.baseId, input.sheetId, input.anchorOperationId,
      input.anchorSeq, input.checkpointId, 'claim', '2', input.workerOwnerId, null, null, null])
  })

  test('takeover transmits exact old lease/fence/version without number truncation', async () => {
    const call = query({ ...row, row_version: '9007199254753002', worker_fence: '9007199254753002' })
    await expect(takeOverRecoveryArchiveObjectDeletion(call, { ...takeover,
      expectedRowVersion: '9007199254753001', previousWorkerFence: '9007199254753001' })).resolves.toMatchObject({
      rowVersion: '9007199254753002', workerFence: '9007199254753002', storeId: row.store_id,
    })
    expect(call.mock.calls[2]?.[1]?.slice(-3)).toEqual([input.workerOwnerId, '9007199254753001', row.lease_until])
  })

  test.each([{ id: 'bad' }, { objectId: 'SENSITIVE_URI' }, { providerOperationKey: 'bad' },
    { workspaceId: '' }, { anchorSeq: '01' }, { expectedRowVersion: '0' },
    { expectedRowVersion: '9223372036854775807' }, { workerOwnerId: 'bad\nworker' }])('input refuses before DB (%j)', async patch => {
    const call = vi.fn()
    await expect(claimRecoveryArchiveObjectDeletion(call, { ...input, ...patch })).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_INVALID_INPUT',
    })
    expect(call).not.toHaveBeenCalled()
  })
  test.each([{ previousWorkerOwnerId: '' }, { previousWorkerFence: '0' },
    { previousWorkerFence: '9223372036854775807' }, { previousLeaseUntil: 'not-a-date' },
    { previousLeaseUntil: '2099-01-01T00:00:00Z' }])('takeover tuple refuses before DB (%j)', async patch => {
    const call = vi.fn()
    await expect(takeOverRecoveryArchiveObjectDeletion(call, { ...takeover, ...patch })).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_INVALID_INPUT',
    })
    expect(call).not.toHaveBeenCalled()
  })
  test('unstable transaction adapter cannot call authority', async () => {
    const call = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '43' }] })
    await expect(claimRecoveryArchiveObjectDeletion(call, input)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_TRANSACTION_REQUIRED' })
    expect(call).toHaveBeenCalledTimes(2)
  })
  test.each([{ provider_operation_key: 'd'.repeat(64) }, { state: 'deleted' }, { row_version: '2' },
    { worker_owner_id: 'another' }, { worker_fence: '0' }, { attempt_count: '0' }, { store_id: 'bad' },
    { staging_object_id: 'bad' }, { key_id: '' }, { provider_version: '' }, { ciphertext_sha256: 'bad' },
    { size_bytes: '-1' }, { lease_until: 'bad' }, { object_expires_at: 'bad' }, { xid: '43' }])('invalid or rebound result refuses (%j)', async patch => {
    await expect(claimRecoveryArchiveObjectDeletion(query({ ...row, ...patch }), input)).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_RESULT_INVALID',
    })
  })
  test('takeover returned fence must be exactly old fence plus one', async () => {
    await expect(takeOverRecoveryArchiveObjectDeletion(query({ ...row, row_version: '4', worker_fence: '3' }), takeover))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_RESULT_INVALID' })
  })
  test('unknown query failure stays values-free', async () => {
    const call = query().mockReset().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] }).mockRejectedValueOnce(new Error('SENSITIVE_PROVIDER'))
    await expect(claimRecoveryArchiveObjectDeletion(call, input)).rejects.toMatchObject({ message: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED' })
  })
})
