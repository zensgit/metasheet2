import { describe, expect, it } from 'vitest'
import type { FormField, FormSchema } from '../src/types/approval'
import { prefillFromSnapshot } from '../src/approvals/prefillFromSnapshot'

function schema(fields: FormField[]): FormSchema {
  return { fields }
}

describe('approvals/prefillFromSnapshot — UX B2-13 (再次提交)', () => {
  it('prefills fields present in the snapshot with a value matching the CURRENT field type', () => {
    const formSchema = schema([
      { id: 'reason', type: 'text', label: '事由' },
      { id: 'amount', type: 'number', label: '金额' },
      { id: 'urgent', type: 'select', label: '紧急程度', options: [{ label: '高', value: 'high' }] },
    ])
    const snapshot = { reason: '出差报销', amount: 5000, urgent: 'high' }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({
      reason: '出差报销',
      amount: 5000,
      urgent: 'high',
    })
  })

  it('skips a field the current template DROPPED since the original submission', () => {
    // 'legacy_field' is no longer part of the current schema at all.
    const formSchema = schema([{ id: 'reason', type: 'text', label: '事由' }])
    const snapshot = { reason: '出差报销', legacy_field: 'old value' }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({ reason: '出差报销' })
  })

  it('skips a field the current template RETYPED to something the old value no longer fits', () => {
    // Same id ('amount'), but the author retyped it from number -> select; the old numeric value
    // is not a valid shape for a select's stored option value... use a case that is UNAMBIGUOUSLY
    // incompatible instead: retyped number -> multi-select (requires an array), old value a plain
    // number.
    const formSchema = schema([{ id: 'amount', type: 'multi-select', label: '金额档位' }])
    const snapshot = { amount: 5000 }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({})
  })

  it('skips a field retyped from text -> number when the old string value is not numeric-shaped', () => {
    const formSchema = schema([{ id: 'note', type: 'number', label: '备注' }])
    const snapshot = { note: '出差备注文本' }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({})
  })

  it('always skips attachment fields, regardless of the stored value', () => {
    const formSchema = schema([{ id: 'proof', type: 'attachment', label: '证明材料' }])
    const snapshot = { proof: 'some-file-name.pdf' }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({})
  })

  it('always omits record-link on resubmit prefill (snapshots have no pin metadata)', () => {
    // Discriminating: a shape-valid { recordId } still must NOT prefill, even when the current
    // schema still has a record-link field (we cannot prove the prior instance targeted the
    // same baseId+sheetId pin from form_snapshot alone).
    const formSchema = schema([
      { id: 'reason', type: 'text', label: '事由' },
      {
        id: 'linked',
        type: 'record-link',
        label: '关联记录',
        props: { baseId: 'base-a', sheetId: 'sheet-a' },
      },
    ])
    const snapshot = {
      reason: '再次提交',
      linked: { recordId: 'rec-from-prior-instance' },
    }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({ reason: '再次提交' })
    expect(prefillFromSnapshot(formSchema, snapshot)).not.toHaveProperty('linked')
  })

  it('prefills detail rows verbatim when the detail field still exists as type "detail"', () => {
    const formSchema = schema([
      {
        id: 'items',
        type: 'detail',
        label: '报销明细',
        columns: [
          { id: 'item_name', type: 'text', label: '项目' },
          { id: 'amount_text', type: 'text', label: '金额说明' },
        ],
      },
    ])
    const rows = [
      { item_name: '机票', amount_text: '合计 1000 元' },
      { item_name: '酒店', amount_text: '合计 500 元' },
    ]
    const snapshot = { items: rows }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({ items: rows })
  })

  it('skips a detail field whose stored value is not an array (retyped away from detail)', () => {
    const formSchema = schema([{ id: 'items', type: 'detail', label: '报销明细', columns: [] }])
    const snapshot = { items: 'not-an-array' }

    expect(prefillFromSnapshot(formSchema, snapshot)).toEqual({})
  })

  it('empty snapshot -> {}', () => {
    const formSchema = schema([{ id: 'reason', type: 'text', label: '事由' }])
    expect(prefillFromSnapshot(formSchema, {})).toEqual({})
  })

  it('missing snapshot (null/undefined) -> {}', () => {
    const formSchema = schema([{ id: 'reason', type: 'text', label: '事由' }])
    expect(prefillFromSnapshot(formSchema, null)).toEqual({})
    expect(prefillFromSnapshot(formSchema, undefined)).toEqual({})
  })

  it('skips a key present with an explicit null/undefined value', () => {
    const formSchema = schema([{ id: 'reason', type: 'text', label: '事由' }])
    expect(prefillFromSnapshot(formSchema, { reason: null })).toEqual({})
    expect(prefillFromSnapshot(formSchema, { reason: undefined })).toEqual({})
  })

  it('a schema with no fields -> {}', () => {
    expect(prefillFromSnapshot(schema([]), { reason: 'x' })).toEqual({})
  })

  it('multi-select requires an array; a scalar value for a multi-select field is skipped', () => {
    const formSchema = schema([{ id: 'tags', type: 'multi-select', label: '标签' }])
    expect(prefillFromSnapshot(formSchema, { tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] })
    expect(prefillFromSnapshot(formSchema, { tags: 'a' })).toEqual({})
  })

  it('date/datetime require a value Date can actually parse', () => {
    const formSchema = schema([
      { id: 'due', type: 'date', label: '截止日期' },
      { id: 'meet', type: 'datetime', label: '会议时间' },
    ])
    expect(prefillFromSnapshot(formSchema, { due: '2026-07-01', meet: '2026-07-01T10:00:00Z' })).toEqual({
      due: '2026-07-01',
      meet: '2026-07-01T10:00:00Z',
    })
    expect(prefillFromSnapshot(formSchema, { due: 'not-a-date' })).toEqual({})
  })

  it('does not mutate the input snapshot or schema', () => {
    const formSchema = schema([{ id: 'reason', type: 'text', label: '事由' }])
    const snapshot = { reason: '出差报销' }
    const snapshotCopy = { ...snapshot }
    const schemaCopy = JSON.parse(JSON.stringify(formSchema))

    prefillFromSnapshot(formSchema, snapshot)

    expect(snapshot).toEqual(snapshotCopy)
    expect(formSchema).toEqual(schemaCopy)
  })
})
