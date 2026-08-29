import { describe, expect, test } from 'vitest'

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
