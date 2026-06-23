import { describe, expect, it } from 'vitest'
import type { FormField, FormSchema } from '../src/types/approval'
import {
  buildDetailColumns,
  buildDetailRowsForDisplay,
  createEmptyDetailColumnDraft,
  createEmptyDetailRow,
  detailColumnDraftsFromField,
  DETAIL_LEAF_FIELD_TYPES,
  findDetailFieldInSchema,
  isDetailCellVisible,
  isDetailField,
  isDetailLeafFieldType,
  parseRowBound,
  pruneHiddenDetailRow,
  pruneHiddenFormDataWithDetail,
  validateDetailColumnsDraft,
  visibleDetailColumnsForRow,
  type DetailColumnDraft,
} from '../src/approvals/detailField'

function leafDraft(overrides: Partial<DetailColumnDraft> = {}): DetailColumnDraft {
  return {
    localId: 'l1',
    id: 'product',
    type: 'text',
    label: '品名',
    required: false,
    optionsText: '',
    ...overrides,
  }
}

const detailField: FormField = {
  id: 'items',
  type: 'detail',
  label: '明细',
  columns: [
    { id: 'product', type: 'text', label: '品名', required: true },
    { id: 'qty', type: 'number', label: '数量' },
    { id: 'tags', type: 'multi-select', label: '标签', options: [{ label: 'A', value: 'a' }] },
  ],
}

describe('detailField — leaf-type guard', () => {
  it('exposes exactly the 8 leaf types (no detail, no attachment)', () => {
    expect([...DETAIL_LEAF_FIELD_TYPES].sort()).toEqual(
      ['date', 'datetime', 'multi-select', 'number', 'select', 'text', 'textarea', 'user'].sort(),
    )
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('detail')
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('attachment')
  })

  it('isDetailLeafFieldType rejects detail/attachment, accepts leaves', () => {
    expect(isDetailLeafFieldType('text')).toBe(true)
    expect(isDetailLeafFieldType('multi-select')).toBe(true)
    expect(isDetailLeafFieldType('detail')).toBe(false)
    expect(isDetailLeafFieldType('attachment')).toBe(false)
  })

  it('isDetailField only true for type detail', () => {
    expect(isDetailField({ type: 'detail' })).toBe(true)
    expect(isDetailField({ type: 'text' })).toBe(false)
  })
})

describe('detailField — buildDetailRowsForDisplay (frozen-schema render)', () => {
  it('builds rows × columns keyed by sub-field id from the frozen columns', () => {
    const table = buildDetailRowsForDisplay(detailField, [
      { product: 'A', qty: 2, tags: ['a'] },
      { product: 'B', qty: 1 },
    ])
    expect(table).not.toBeNull()
    expect(table!.columns.map((c) => c.id)).toEqual(['product', 'qty', 'tags'])
    expect(table!.columns.map((c) => c.label)).toEqual(['品名', '数量', '标签'])
    expect(table!.rows).toHaveLength(2)
    expect(table!.rows[0].cells).toEqual({ product: 'A', qty: 2, tags: ['a'] })
    // Missing cell in row 2 is surfaced as undefined (not dropped) so the column still renders.
    expect(table!.rows[1].cells).toEqual({ product: 'B', qty: 1, tags: undefined })
  })

  it('only emits cells for DEFINED columns — unknown snapshot keys are ignored', () => {
    const table = buildDetailRowsForDisplay(detailField, [
      { product: 'A', qty: 2, rogue: 'should-not-appear' },
    ])
    expect(Object.keys(table!.rows[0].cells).sort()).toEqual(['product', 'qty', 'tags'].sort())
    expect(table!.rows[0].cells).not.toHaveProperty('rogue')
  })

  it('returns null (→ stringify fallback) when columns are absent or value is not an array', () => {
    expect(buildDetailRowsForDisplay(undefined, [])).toBeNull()
    expect(buildDetailRowsForDisplay({ columns: [] }, [])).toBeNull()
    expect(buildDetailRowsForDisplay(detailField, 'not-an-array')).toBeNull()
    expect(buildDetailRowsForDisplay(detailField, null)).toBeNull()
  })

  it('tolerates non-object row entries by treating them as empty rows', () => {
    const table = buildDetailRowsForDisplay(detailField, [null, 42])
    expect(table!.rows).toHaveLength(2)
    expect(table!.rows[0].cells).toEqual({ product: undefined, qty: undefined, tags: undefined })
  })
})

describe('detailField — findDetailFieldInSchema', () => {
  const schema: FormSchema = {
    fields: [
      { id: 'reason', type: 'text', label: '事由' },
      detailField,
      { id: 'broken', type: 'detail', label: '坏明细' }, // detail without columns → not usable
    ],
  }

  it('returns the detail field when it carries columns', () => {
    expect(findDetailFieldInSchema(schema, 'items')?.id).toBe('items')
  })

  it('returns null for scalar fields, detail-without-columns, missing keys, or null schema', () => {
    expect(findDetailFieldInSchema(schema, 'reason')).toBeNull()
    expect(findDetailFieldInSchema(schema, 'broken')).toBeNull()
    expect(findDetailFieldInSchema(schema, 'nope')).toBeNull()
    expect(findDetailFieldInSchema(null, 'items')).toBeNull()
    expect(findDetailFieldInSchema(undefined, 'items')).toBeNull()
  })
})

describe('detailField — fill row seeding', () => {
  it('seeds [] for multi-select and undefined for other leaves; only defined column keys', () => {
    const row = createEmptyDetailRow(detailField.columns)
    expect(row).toEqual({ product: undefined, qty: undefined, tags: [] })
    expect(Object.keys(row)).toEqual(['product', 'qty', 'tags'])
  })

  it('returns an empty object for missing columns', () => {
    expect(createEmptyDetailRow(undefined)).toEqual({})
  })
})

describe('detailField — column draft round-trip', () => {
  it('hydrates drafts from a stored detail field and rebuilds equivalent columns', () => {
    const drafts = detailColumnDraftsFromField(detailField)
    expect(drafts.map((d) => d.id)).toEqual(['product', 'qty', 'tags'])
    expect(drafts.find((d) => d.id === 'product')?.required).toBe(true)
    expect(drafts.find((d) => d.id === 'tags')?.optionsText).toBe('A:a')

    const rebuilt = buildDetailColumns(drafts)
    expect(rebuilt.map((c) => c.id)).toEqual(['product', 'qty', 'tags'])
    expect(rebuilt.find((c) => c.id === 'tags')?.options).toEqual([{ label: 'A', value: 'a' }])
    // Non-option leaves carry no options key.
    expect(rebuilt.find((c) => c.id === 'qty')).not.toHaveProperty('options')
  })

  it('createEmptyDetailColumnDraft defaults to a text leaf', () => {
    const draft = createEmptyDetailColumnDraft(2)
    expect(draft.type).toBe('text')
    expect(draft.id).toBe('col_2')
    expect(draft.required).toBe(false)
  })
})

describe('detailField — parseRowBound', () => {
  it('parses unset / valid / invalid bounds', () => {
    expect(parseRowBound('')).toBeUndefined()
    expect(parseRowBound('  ')).toBeUndefined()
    expect(parseRowBound('0')).toBe(0)
    expect(parseRowBound('200')).toBe(200)
    expect(parseRowBound('-1')).toBe('invalid')
    expect(parseRowBound('1.5')).toBe('invalid')
    expect(parseRowBound('abc')).toBe('invalid')
  })
})

describe('detailField — validateDetailColumnsDraft (mirrors backend reject-set)', () => {
  it('accepts a valid single-leaf detail', () => {
    expect(validateDetailColumnsDraft('明细', [leafDraft()], '', '')).toEqual([])
  })

  it('rejects empty columns', () => {
    const errors = validateDetailColumnsDraft('明细', [], '', '')
    expect(errors.some((e) => e.includes('至少需要一个子字段'))).toBe(true)
  })

  it('rejects a sub-field with empty id', () => {
    const errors = validateDetailColumnsDraft('明细', [leafDraft({ id: '  ' })], '', '')
    expect(errors.some((e) => e.includes('子字段 id 必填'))).toBe(true)
  })

  it('rejects duplicate sub-field ids', () => {
    const errors = validateDetailColumnsDraft(
      '明细',
      [leafDraft({ localId: 'a', id: 'dup' }), leafDraft({ localId: 'b', id: 'dup' })],
      '',
      '',
    )
    expect(errors.some((e) => e.includes('不能重复'))).toBe(true)
  })

  it('rejects a missing sub-field label', () => {
    const errors = validateDetailColumnsDraft('明细', [leafDraft({ label: '' })], '', '')
    expect(errors.some((e) => e.includes('名称必填'))).toBe(true)
  })

  it('rejects a nested detail sub-field (no nesting)', () => {
    // A sub-field can never be `detail`; the draft type is widened to FormFieldType to test it.
    const errors = validateDetailColumnsDraft(
      '明细',
      [leafDraft({ type: 'detail' as DetailColumnDraft['type'] })],
      '',
      '',
    )
    expect(errors.some((e) => e.includes('类型不支持'))).toBe(true)
  })

  it('rejects a select sub-field with no options', () => {
    const errors = validateDetailColumnsDraft('明细', [leafDraft({ type: 'select', optionsText: '' })], '', '')
    expect(errors.some((e) => e.includes('需要至少一个选项'))).toBe(true)
  })

  it('rejects a select sub-field whose option label/value is blank', () => {
    const errors = validateDetailColumnsDraft('明细', [leafDraft({ type: 'select', optionsText: ':v\nlabel:' })], '', '')
    expect(errors.some((e) => e.includes('label/value 不能为空'))).toBe(true)
  })

  it('rejects a non-negative-int violation on minRows/maxRows', () => {
    expect(validateDetailColumnsDraft('明细', [leafDraft()], '-1', '').some((e) => e.includes('最小行数必须是非负整数'))).toBe(true)
    expect(validateDetailColumnsDraft('明细', [leafDraft()], '', '2.5').some((e) => e.includes('最大行数必须是非负整数'))).toBe(true)
  })

  it('rejects minRows > maxRows', () => {
    const errors = validateDetailColumnsDraft('明细', [leafDraft()], '5', '3')
    expect(errors.some((e) => e.includes('最小行数不能大于最大行数'))).toBe(true)
  })

  it('accepts minRows <= maxRows', () => {
    expect(validateDetailColumnsDraft('明细', [leafDraft()], '1', '200')).toEqual([])
  })
})

describe('detailField — per-row sub-field visibility (P2, design-lock §4)', () => {
  // A detail group where `note` is visible only when `kind === 'other'` in the SAME row.
  const visField: FormField = {
    id: 'items',
    type: 'detail',
    label: '明细',
    columns: [
      { id: 'kind', type: 'select', label: '类型', options: [{ label: '常规', value: 'normal' }, { label: '其他', value: 'other' }] },
      { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'other' } },
    ],
  }

  it('visibleDetailColumnsForRow hides a sub-field whose rule is false for the row', () => {
    const hiddenRow = visibleDetailColumnsForRow(visField.columns, { kind: 'normal', note: 'leak' })
    expect(hiddenRow.map((c) => c.id)).toEqual(['kind'])
    const shownRow = visibleDetailColumnsForRow(visField.columns, { kind: 'other', note: 'keep' })
    expect(shownRow.map((c) => c.id)).toEqual(['kind', 'note'])
  })

  it('pruneHiddenDetailRow drops the hidden cell and any unknown key, keeps visible cells', () => {
    expect(pruneHiddenDetailRow(visField.columns, { kind: 'normal', note: 'leak', rogue: 1 })).toEqual({ kind: 'normal' })
    expect(pruneHiddenDetailRow(visField.columns, { kind: 'other', note: 'keep' })).toEqual({ kind: 'other', note: 'keep' })
  })

  it('pruneHiddenFormDataWithDetail prunes hidden cells per row across the whole form', () => {
    const schema: FormSchema = { fields: [{ id: 'reason', type: 'text', label: '事由' }, visField] }
    const pruned = pruneHiddenFormDataWithDetail(schema, {
      reason: 'r',
      items: [
        { kind: 'normal', note: 'should-vanish' }, // note hidden → dropped
        { kind: 'other', note: 'should-stay' }, // note visible → kept
      ],
    })
    expect(pruned).toEqual({
      reason: 'r',
      items: [{ kind: 'normal' }, { kind: 'other', note: 'should-stay' }],
    })
    // The hidden value never reaches the payload for its row, but the shown row keeps it.
    expect((pruned.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty('note')
    expect((pruned.items as Array<Record<string, unknown>>)[1].note).toBe('should-stay')
  })

  it('a detail field with no sub-field rules round-trips every cell (no over-pruning)', () => {
    const plain: FormField = {
      id: 'items',
      type: 'detail',
      label: '明细',
      columns: [{ id: 'product', type: 'text', label: '品名' }, { id: 'qty', type: 'number', label: '数量' }],
    }
    const schema: FormSchema = { fields: [plain] }
    const pruned = pruneHiddenFormDataWithDetail(schema, { items: [{ product: 'A', qty: 2 }] })
    expect(pruned).toEqual({ items: [{ product: 'A', qty: 2 }] })
  })

  it('top-level hidden detail field is dropped entirely (top-level prune still applies)', () => {
    const gatedDetail: FormField = { ...visField, visibilityRule: { fieldId: 'reason', operator: 'eq', value: 'show' } }
    const schema: FormSchema = { fields: [{ id: 'reason', type: 'text', label: '事由' }, gatedDetail] }
    const pruned = pruneHiddenFormDataWithDetail(schema, { reason: 'hide', items: [{ kind: 'other', note: 'x' }] })
    expect(pruned).toEqual({ reason: 'hide' })
    expect(pruned).not.toHaveProperty('items')
  })
})

describe('isDetailCellVisible — per-field (two detail groups may share a sub-field id)', () => {
  const makeGroup = (id: string, noteVisibleWhen: string): FormField => ({
    id,
    type: 'detail',
    label: id,
    columns: [
      { id: 'kind', type: 'select', label: 'kind', options: [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }] },
      { id: 'note', type: 'text', label: 'note', visibilityRule: { fieldId: 'kind', operator: 'eq', value: noteVisibleWhen } },
    ],
  })

  it('judges a same-id sub-field by its OWN group, never a reverse-lookup across the template', () => {
    const groupA = makeGroup('itemsA', 'x') // A.note visible when kind === 'x'
    const groupB = makeGroup('itemsB', 'y') // B.note visible when kind === 'y'
    const noteA = groupA.columns![1]
    const noteB = groupB.columns![1]

    expect(isDetailCellVisible(groupA, noteA, { kind: 'x' })).toBe(true)
    expect(isDetailCellVisible(groupA, noteA, { kind: 'y' })).toBe(false)
    // B.note shares the id 'note' with A.note, but must follow B's OWN rule (kind === 'y'),
    // not A's (kind === 'x') — the bug the reverse-lookup helper would have produced.
    expect(isDetailCellVisible(groupB, noteB, { kind: 'y' })).toBe(true)
    expect(isDetailCellVisible(groupB, noteB, { kind: 'x' })).toBe(false)
  })

  it('a column without a visibilityRule is always visible', () => {
    const group = makeGroup('items', 'x')
    expect(isDetailCellVisible(group, group.columns![0], { kind: 'whatever' })).toBe(true)
  })
})
