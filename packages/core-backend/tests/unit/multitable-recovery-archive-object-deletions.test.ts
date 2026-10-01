import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import {
  prepareRecoveryArchiveObjectDeletion,
  requestRecoveryArchiveObjectDeletion,
  type RecoveryArchiveObjectDeletionInput,
} from '../../src/multitable/recovery-archive-object-deletions'

const input: RecoveryArchiveObjectDeletionInput = {
  id: '00000000-0000-4000-8000-000000000001',
  generationId: '00000000-0000-4000-8000-000000000002',
  ownerRequestId: '00000000-0000-4000-8000-000000000003',
  anchorOperationId: '00000000-0000-4000-8000-000000000004',
  objectId: 'a'.repeat(64), providerOperationKey: 'b'.repeat(64),
  workspaceId: 'synthetic_workspace', baseId: 'synthetic_base', sheetId: 'synthetic_sheet',
  anchorSeq: '9007199254753001', checkpointId: 'synthetic_checkpoint',
}
const row = {
  id: input.id, generation_id: input.generationId, object_id: input.objectId,
  owner_request_id: input.ownerRequestId, provider_operation_key: input.providerOperationKey,
  workspace_id: input.workspaceId, base_id: input.baseId, sheet_id: input.sheetId,
  anchor_operation_id: input.anchorOperationId, anchor_seq: input.anchorSeq, checkpoint_id: input.checkpointId,
  state: 'requested', row_version: '1', xid: '42',
}
function query(result = row) {
  return vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [result] })
}

describe('expired archive deletion storage authority wrapper', () => {
  test('requests exact identity and operation key; prepares an exact bigint CAS', async () => {
    const request = query()
    await expect(requestRecoveryArchiveObjectDeletion(request, input)).resolves.toEqual({ ...input, state: 'requested', rowVersion: '1' })
    expect(request.mock.calls[2]?.[1]).toEqual([
      input.id, input.generationId, input.objectId, input.ownerRequestId, input.providerOperationKey,
      input.workspaceId, input.baseId, input.sheetId, input.anchorOperationId, input.anchorSeq,
      input.checkpointId, 'request', null,
    ])
    await expect(prepareRecoveryArchiveObjectDeletion(query({ ...row, state: 'ready', row_version: '9007199254753002' }), {
      ...input, expectedRowVersion: '9007199254753001',
    })).resolves.toEqual({ ...input, state: 'ready', rowVersion: '9007199254753002' })
  })

  test.each([
    { generationId: 'SENSITIVE_INVALID_UUID' }, { objectId: 'SENSITIVE_URI' },
    { providerOperationKey: 'short' }, { anchorSeq: '01' }, { anchorSeq: '9223372036854775808' },
    { workspaceId: '' }, { checkpointId: 'bad\nline' },
  ])('malformed input refuses before queries (%j)', async (patch) => {
    const noQuery = vi.fn()
    await expect(requestRecoveryArchiveObjectDeletion(noQuery, { ...input, ...patch })).rejects.toMatchObject({
      message: 'RECOVERY_ARCHIVE_OBJECT_DELETION_INVALID_INPUT',
    })
    expect(noQuery).not.toHaveBeenCalled()
  })

  test.each(['0', '-1', '1.0', '9223372036854775808'])('invalid CAS refuses before queries (%s)', async expectedRowVersion => {
    const noQuery = vi.fn()
    await expect(prepareRecoveryArchiveObjectDeletion(noQuery, { ...input, expectedRowVersion })).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_DELETION_INVALID_INPUT',
    })
    expect(noQuery).not.toHaveBeenCalled()
  })

  test('autocommit query adapter refuses before authority mutation', async () => {
    const unstable = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '2' }] })
    await expect(requestRecoveryArchiveObjectDeletion(unstable, input)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_DELETION_TRANSACTION_REQUIRED' })
    expect(unstable).toHaveBeenCalledTimes(2)
  })

  test.each([{ generation_id: input.ownerRequestId }, { object_id: 'c'.repeat(64) },
    { anchor_seq: '9007199254753002' }, { checkpoint_id: 'different' }, { state: 'deleted' },
    { row_version: '2' }, { xid: '43' }])('malformed or rebound result refuses (%j)', async patch => {
    await expect(requestRecoveryArchiveObjectDeletion(query({ ...row, ...patch }), input)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_DELETION_RESULT_INVALID' })
  })

  test('malformed database result refuses with a fixed values-free code', async () => {
    const malformed = query()
    malformed.mockReset().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] }).mockResolvedValueOnce({ rowCount: 1 })
    await expect(requestRecoveryArchiveObjectDeletion(malformed, input)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_DELETION_RESULT_INVALID' })
  })

  test('unknown database failure is values-free', async () => {
    const failing = query()
    failing.mockReset().mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ xid: '42' }] })
      .mockRejectedValueOnce(new Error('SENSITIVE_PROVIDER_URL'))
    await expect(requestRecoveryArchiveObjectDeletion(failing, input)).rejects.toMatchObject({ message: 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED' })
  })
})

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
test('deletion admission real-DB suite is selected by the actual Node20 CI step and excluded from no-DB tests', () => {
  const suite = 'tests/integration/multitable-recovery-archive-object-deletion-admission-realdb.test.ts'
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const offset = workflow.indexOf('        id: multitable-real-db-integration')
  const end = workflow.indexOf('\n      - name:', offset)
  expect(offset).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(offset)
  const step = workflow.slice(offset, end)
  expect(step).toContain("METASHEET_REAL_DB_TEST_STEP: '1'")
  expect(step).toContain('vitest --config vitest.integration.config.ts run')
  expect(step.split(suite).length - 1).toBe(1)
  const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  expect(config.split(`'${suite}'`).length - 1).toBe(1)
})
