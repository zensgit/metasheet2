import { describe, expect, it } from 'vitest'
import { planArchiveAttachmentCells } from '../../src/multitable/recovery-archive-attachment-plan'

function fixture() {
  return {
    targets: new Map([['row', { exists: true, data: { files: ['att-original'], text: 'old' } }]]),
    live: new Map([['row', { data: { files: ['att-current'], text: 'new' } }]]),
    fieldTypes: new Map([['files', 'attachment'], ['text', 'text']]),
    index: [{ entity_key: 'attachment/att-original', payload: {
      attachment_id: 'att-original', record_id: 'row', field_id: 'files', deleted: false,
    } }],
  }
}

describe('archive attachment descriptive plan', () => {
  it('plans exact ordered references without changing source objects or scalar data', () => {
    const input = fixture()
    const before = structuredClone(input)
    expect(planArchiveAttachmentCells(input)).toEqual([
      { recordId: 'row', fieldId: 'files', beforeIds: ['att-current'], targetIds: ['att-original'] },
    ])
    expect(input).toEqual(before)
  })

  it('preserves scalar-only selection and unchanged attachment no-op', () => {
    const input = fixture()
    expect(planArchiveAttachmentCells({ ...input, selectedFieldIds: ['text'] })).toEqual([])
    input.live.get('row')!.data.files = ['att-original']
    expect(planArchiveAttachmentCells(input)).toEqual([])
  })

  it('can restore an empty reference list without deleting the current file', () => {
    const input = fixture()
    input.targets.get('row')!.data.files = []
    expect(planArchiveAttachmentCells(input)).toEqual([
      { recordId: 'row', fieldId: 'files', beforeIds: ['att-current'], targetIds: [] },
    ])
  })

  it.each(['record_id', 'field_id'] as const)('refuses wrong original %s', key => {
    const input = fixture()
    input.index[0]!.payload[key] = 'other'
    expect(() => planArchiveAttachmentCells(input)).toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
  })

  it('refuses missing, duplicate and archived-deleted attachment evidence', () => {
    for (const change of [
      (input: ReturnType<typeof fixture>) => { input.index = [] },
      (input: ReturnType<typeof fixture>) => { input.index.push(input.index[0]!) },
      (input: ReturnType<typeof fixture>) => { input.index[0]!.payload.deleted = true },
    ]) {
      const input = fixture()
      change(input)
      expect(() => planArchiveAttachmentCells(input)).toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
    }
  })

  it('refuses deleted records and absent selected fields instead of recreating them', () => {
    const input = fixture()
    input.live.clear()
    expect(() => planArchiveAttachmentCells(input)).toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
    expect(() => planArchiveAttachmentCells({ ...fixture(), selectedFieldIds: ['deleted'] }))
      .toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
  })

  it('does not interpret an explicitly empty scope as whole sheet', () => {
    expect(() => planArchiveAttachmentCells({ ...fixture(), selectedRecordIds: [] }))
      .toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
    expect(() => planArchiveAttachmentCells({ ...fixture(), selectedFieldIds: [] }))
      .toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
  })

  it.each([
    { value: 'att-original' }, { value: ['att-original', 'att-original'] },
    { value: [''] }, { value: [1] },
  ])('refuses malformed references $value', ({ value }) => {
    const input = fixture()
    Object.assign(input.targets.get('row')!.data, { files: value })
    expect(() => planArchiveAttachmentCells(input)).toThrow('RECOVERY_ARCHIVE_ATTACHMENT_PLAN_INVALID')
  })
})
