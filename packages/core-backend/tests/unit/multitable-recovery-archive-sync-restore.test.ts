import { describe, expect, test, vi } from 'vitest'
import { prepareArchiveAttachmentBatch } from '../../src/multitable/recovery-archive-attachment-prepare'
import { ApplyRefusalError } from '../../src/multitable/exact-anchor-recovery-execute'
import { loadArchiveAttachmentMetadataBindings } from '../../src/multitable/recovery-archive-attachment-apply'
import type { QueryFn } from '../../src/multitable/permission-service'
import { createArchiveAttachmentStageLedger } from '../../src/multitable/recovery-archive-attachment-stage-ledger'
import { stageRecoveryArchiveAttachment } from '../../src/multitable/recovery-archive-attachment-stage'

import {
  materializeRecoveryArchiveLinksForSync,
  RecoveryArchiveSyncRestoreError,
} from '../../src/multitable/recovery-archive-sync-restore'

const row = (
  linkId: string,
  fieldId: string,
  recordId: string,
  foreignRecordId: string,
) => ({
  entity_key: `link/${linkId}`,
  payload: {
    link_id: linkId,
    field_id: fieldId,
    record_id: recordId,
    foreign_record_id: foreignRecordId,
  },
})

describe('recovery archive sync restore facade', () => {
  test('stage and ledger preserve explicit permission denial without IO', async () => {
    const query = vi.fn()
    const transaction = async <T>(work: (q: QueryFn) => Promise<T>) => work(query)
    const ledger = createArchiveAttachmentStageLedger({ actorId: '11111111-1111-4111-8111-111111111111',
      tokenHash: 'a'.repeat(64), tokenExpiresAt: '2099-01-01T00:00:00.000Z', transaction,
      authorize: async () => false })
    await expect(ledger.reserve({ generationId: 'g', workspaceId: 'w', baseId: 'b', sheetId: 's',
      recordId: 'r', fieldId: 'f', attachmentId: 'att-original', sourceVersion: '1',
      plaintextSha256: 'b'.repeat(64), sizeBytes: '1' })).rejects
      .toMatchObject({ name: 'ArchiveAttachmentStageAuthorizationError' })
    const storage = { uploadByKey: vi.fn(), readRecoveryAttachment: vi.fn(), reserveRecoveryAttachment: vi.fn() }
    await expect(stageRecoveryArchiveAttachment({ original: {}, transactionDepth: { currentTransactionDepth: () => 0 },
      authorize: async () => false, storage } as unknown as Parameters<typeof stageRecoveryArchiveAttachment>[0]))
      .rejects.toMatchObject({ name: 'ArchiveAttachmentStageAuthorizationError' })
    expect(query).not.toHaveBeenCalled()
    for (const operation of Object.values(storage)) expect(operation).not.toHaveBeenCalled()
  })

  test('preparation permission revocation is a typed forbidden refusal before any source or storage access', async () => {
    const query = vi.fn()
    const storage = { uploadByKey: vi.fn(), readRecoveryAttachment: vi.fn(), reserveRecoveryAttachment: vi.fn() }
    const input = {
      apply: { token: 'synthetic', preliminaryFullRead: async () => false },
      archive: { selectedBinding: { workspaceId: 'w', baseId: 'b' } },
      transaction: async (work: (q: typeof query) => Promise<unknown>) => work(query),
      storage,
    } as unknown as Parameters<typeof prepareArchiveAttachmentBatch>[0]
    await expect(prepareArchiveAttachmentBatch(input)).rejects.toMatchObject({ name: 'ApplyRefusalError', reason: 'forbidden' })
    await expect(prepareArchiveAttachmentBatch(input)).rejects.toBeInstanceOf(ApplyRefusalError)
    expect(query).not.toHaveBeenCalled()
    for (const operation of Object.values(storage)) expect(operation).not.toHaveBeenCalled()
  })

  test('missing original attachment metadata has a distinct binding refusal; DB failures stay infrastructure errors', async () => {
    const cells = [{ recordId: 'r', fieldId: 'f', beforeIds: [], targetIds: ['att-original'] }]
    const query = vi.fn(async () => ({ rows: [] })) as unknown as QueryFn
    await expect(loadArchiveAttachmentMetadataBindings(query, 's', cells)).rejects
      .toMatchObject({ name: 'ArchiveAttachmentMetadataBindingError' })
    const failure = new Error('synthetic database failure')
    const broken = vi.fn(async () => { throw failure }) as unknown as QueryFn
    await expect(loadArchiveAttachmentMetadataBindings(broken, 's', cells)).rejects.toBe(failure)
  })

  test('materializes the authenticated link section into one canonical authority projection', () => {
    expect(materializeRecoveryArchiveLinksForSync([
      row('link-b', 'field-a', 'record-b', 'target-a'),
      row('link-a', 'field-b', 'record-a', 'target-b'),
    ])).toEqual([
      { fieldId: 'field-b', recordId: 'record-a', foreignRecordId: 'target-b' },
      { fieldId: 'field-a', recordId: 'record-b', foreignRecordId: 'target-a' },
    ])
  })

  test.each([
    [{ ...row('link-a', 'field-a', 'record-a', 'target-a'), extra: true }],
    [{ ...row('link-a', 'field-a', 'record-a', 'target-a'), entity_key: 'link/wrong' }],
    [{ ...row('link-a', 'field-a', 'record-a', 'target-a'), payload: {
      ...row('link-a', 'field-a', 'record-a', 'target-a').payload,
      extra: true,
    } }],
    [row('link-a', 'field-a', 'record-a', 'target-a'), row('link-a', 'field-a', 'record-b', 'target-b')],
    [row('link-a', 'field-a', 'record-a', 'target-a'), row('link-b', 'field-a', 'record-a', 'target-a')],
  ])('refuses malformed, duplicate-id, and duplicate-edge archive rows', (candidate) => {
    expect(() => materializeRecoveryArchiveLinksForSync(candidate)).toThrow(RecoveryArchiveSyncRestoreError)
  })

  test('refuses accessor-backed values without invoking them', () => {
    let getterCalls = 0
    const payload = Object.defineProperty({}, 'link_id', {
      enumerable: true,
      get() {
        getterCalls++
        return 'link-a'
      },
    }) as Record<string, unknown>
    Object.assign(payload, {
      field_id: 'field-a',
      record_id: 'record-a',
      foreign_record_id: 'target-a',
    })
    expect(() => materializeRecoveryArchiveLinksForSync([{
      entity_key: 'link/link-a',
      payload,
    }])).toThrow(RecoveryArchiveSyncRestoreError)
    expect(getterCalls).toBe(0)
  })
})
