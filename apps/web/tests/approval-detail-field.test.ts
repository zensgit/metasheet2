import { describe, expect, it } from 'vitest'
import type { FormField, FormSchema } from '../src/types/approval'
import {
  buildDetailColumns,
  buildDetailRowsForDisplay,
  buildDisplayFields,
  createEmptyDetailColumnDraft,
  createEmptyDetailRow,
  detailColumnDraftsFromField,
  DETAIL_LEAF_FIELD_TYPES,
  findDetailFieldInSchema,
  formatSummaryLine,
  isDetailCellVisible,
  isDetailField,
  isDetailLeafFieldType,
  parseRowBound,
  pruneHiddenDetailRow,
  pruneHiddenFormDataWithDetail,
  summaryFields,
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

describe('detailField — buildDisplayFields (B1-02 humanized scalar snapshot)', () => {
  const displaySchema: FormSchema = {
    fields: [
      {
        id: 'fld_type',
        type: 'select',
        label: '类型',
        options: [{ label: '采购', value: 'purchase' }, { label: '报销', value: 'reimbursement' }],
      },
      {
        id: 'fld_tags',
        type: 'multi-select',
        label: '标签',
        options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      },
      { id: 'fld_amount', type: 'number', label: '金额' },
      { id: 'fld_date', type: 'date', label: '日期' },
      { id: 'fld_reason', type: 'textarea', label: '原因' },
      { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'text', label: 'X' }] },
    ],
  }

  it('orders scalar entries by schema order regardless of snapshot key order, skipping detail fields', () => {
    const snapshot = {
      fld_reason: '出差',
      fld_date: '2026-01-02T03:04:05Z',
      fld_amount: 1234.5,
      fld_tags: ['a', 'b'],
      fld_type: 'reimbursement',
      items: [{ x: '1' }],
    }
    const fields = buildDisplayFields(displaySchema, snapshot)
    expect(fields.map((f) => f.key)).toEqual(['fld_type', 'fld_tags', 'fld_amount', 'fld_date', 'fld_reason'])
  })

  it('maps a select value to its option label, falling back to the raw value when unmatched', () => {
    const known = buildDisplayFields(displaySchema, { fld_type: 'reimbursement' })
    expect(known[0]).toEqual({ key: 'fld_type', label: '类型', value: '报销' })

    const unknown = buildDisplayFields(displaySchema, { fld_type: 'unknown_value' })
    expect(unknown[0].value).toBe('unknown_value')
  })

  it('multi-select maps each stored value to its option label and joins with 、, falling back per-entry', () => {
    const fields = buildDisplayFields(displaySchema, { fld_tags: ['a', 'b', 'c'] })
    // 'c' has no matching option -> falls back to the raw value for that entry only.
    expect(fields[0].value).toBe('A、B、c')
  })

  it('localizes a finite number via zh-CN grouping, falling back to String(value) when not finite', () => {
    const finite = buildDisplayFields(displaySchema, { fld_amount: 1234567.5 })
    expect(finite[0].value).toBe((1234567.5).toLocaleString('zh-CN'))

    const notFinite = buildDisplayFields(displaySchema, { fld_amount: 'not-a-number' })
    expect(notFinite[0].value).toBe('not-a-number')
  })

  it('formats a parsable date value and passes an unparsable one through unchanged', () => {
    const parsable = buildDisplayFields(displaySchema, { fld_date: '2026-01-02T03:04:05Z' })
    expect(parsable[0].value).toBe(new Date('2026-01-02T03:04:05Z').toLocaleString('zh-CN'))

    // datetime fields format through the same branch (review fix: the spec's list named only `date`)
    const dt = buildDisplayFields(
      { fields: [{ id: 'fld_dt', label: '会议时间', type: 'datetime' }] } as never,
      { fld_dt: '2026-01-02T03:04:05Z' },
    )
    expect(dt[0].value).toBe(new Date('2026-01-02T03:04:05Z').toLocaleString('zh-CN'))

    const unparsable = buildDisplayFields(displaySchema, { fld_date: 'not-a-date' })
    expect(unparsable[0].value).toBe('not-a-date')
  })

  it('appends snapshot keys absent from the schema after schema-ordered entries, using the raw key as label', () => {
    const fields = buildDisplayFields(displaySchema, {
      fld_reason: '原因内容',
      legacy_field: 'some-legacy-value',
      fld_type: 'purchase',
    })
    expect(fields.map((f) => f.key)).toEqual(['fld_type', 'fld_reason', 'legacy_field'])
    const legacy = fields.find((f) => f.key === 'legacy_field')!
    expect(legacy.label).toBe('legacy_field')
    expect(legacy.value).toBe('some-legacy-value')
  })

  it('excludes detail fields entirely — they render elsewhere as tables, never as a raw/unknown entry', () => {
    const fields = buildDisplayFields(displaySchema, { items: [{ x: '1' }], fld_reason: 'r' })
    expect(fields.map((f) => f.key)).toEqual(['fld_reason'])
    expect(fields.some((f) => f.key === 'items')).toBe(false)
  })

  it('renders null/undefined/empty-string scalar values as \'-\' regardless of field type', () => {
    const fields = buildDisplayFields(displaySchema, { fld_reason: '', fld_amount: null, fld_date: undefined })
    expect(fields.map((f) => f.value)).toEqual(['-', '-', '-'])
  })

  it('falls back to field.id as the label when label is empty, and skips fields absent from the snapshot', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'no_label_field', type: 'text', label: '' },
        { id: 'absent_field', type: 'text', label: '不会出现' },
      ],
    }
    const fields = buildDisplayFields(schema, { no_label_field: 'v' })
    expect(fields).toEqual([{ key: 'no_label_field', label: 'no_label_field', value: 'v' }])
  })

  it('tolerates a missing schema and/or snapshot without throwing', () => {
    expect(buildDisplayFields(null, { a: 'b' })).toEqual([{ key: 'a', label: 'a', value: 'b' }])
    expect(buildDisplayFields(displaySchema, null)).toEqual([])
    expect(buildDisplayFields(undefined, undefined)).toEqual([])
  })
})

describe('summaryFields (B2-01 list row key-field summary)', () => {
  const summarySchema: FormSchema = {
    fields: [
      {
        id: 'fld_leave_type',
        type: 'select',
        label: '请假类型',
        options: [{ label: '年假', value: 'annual' }, { label: '事假', value: 'personal' }],
      },
      { id: 'fld_duration', type: 'number', label: '时长' },
      { id: 'fld_reason', type: 'textarea', label: '事由' },
      { id: 'fld_attachment', type: 'attachment', label: '附件' },
      { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'text', label: 'X' }] },
    ],
  }

  it('returns the first `limit` eligible fields in schema order, formatted like buildDisplayFields', () => {
    const snapshot = {
      fld_leave_type: 'annual',
      fld_duration: 2,
      fld_reason: '出差',
      fld_attachment: ['f1'],
      items: [{ x: '1' }],
    }
    const fields = summaryFields(summarySchema, snapshot, 3)
    expect(fields.map((f) => f.key)).toEqual(['fld_leave_type', 'fld_duration', 'fld_reason'])
    // Option-label mapping is reused verbatim from buildDisplayFields, not re-derived here.
    expect(fields[0]).toEqual({ key: 'fld_leave_type', label: '请假类型', value: '年假' })
  })

  it('excludes attachment fields even when present in the snapshot and earlier in schema order', () => {
    const schemaAttachmentFirst: FormSchema = {
      fields: [
        { id: 'fld_attachment', type: 'attachment', label: '附件' },
        { id: 'fld_reason', type: 'textarea', label: '事由' },
      ],
    }
    const fields = summaryFields(schemaAttachmentFirst, { fld_attachment: ['f1'], fld_reason: '出差' }, 3)
    expect(fields.map((f) => f.key)).toEqual(['fld_reason'])
  })

  it('excludes detail fields (mirrors buildDisplayFields, which never surfaces them as raw/unknown either)', () => {
    const fields = summaryFields(summarySchema, { items: [{ x: '1' }], fld_reason: '出差' }, 3)
    expect(fields.map((f) => f.key)).toEqual(['fld_reason'])
  })

  it('never falls back to snapshot keys absent from the schema (unlike buildDisplayFields\'s own tail)', () => {
    const fields = summaryFields(summarySchema, { legacy_field: 'x', fld_reason: '出差' }, 3)
    expect(fields.map((f) => f.key)).toEqual(['fld_reason'])
  })

  it('honors the limit: 0 returns none, and a limit above the eligible count returns all available', () => {
    const snapshot = { fld_leave_type: 'annual', fld_duration: 2, fld_reason: '出差' }
    expect(summaryFields(summarySchema, snapshot, 0)).toEqual([])
    expect(summaryFields(summarySchema, snapshot, 1).map((f) => f.key)).toEqual(['fld_leave_type'])
    expect(summaryFields(summarySchema, snapshot, 50).map((f) => f.key)).toEqual([
      'fld_leave_type', 'fld_duration', 'fld_reason',
    ])
  })

  it('defaults the limit to 3 when omitted', () => {
    const snapshot = { fld_leave_type: 'annual', fld_duration: 2, fld_reason: '出差' }
    expect(summaryFields(summarySchema, snapshot).map((f) => f.key)).toEqual([
      'fld_leave_type', 'fld_duration', 'fld_reason',
    ])
  })

  it('returns [] for a missing/empty schema, a schema with no eligible field, or no matching snapshot data', () => {
    expect(summaryFields(null, { a: 'b' })).toEqual([])
    expect(summaryFields(undefined, undefined)).toEqual([])
    expect(summaryFields({ fields: [] }, { a: 'b' })).toEqual([])

    const onlyAttachmentAndDetail: FormSchema = {
      fields: [
        { id: 'fld_attachment', type: 'attachment', label: '附件' },
        { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'text', label: 'X' }] },
      ],
    }
    expect(summaryFields(onlyAttachmentAndDetail, { fld_attachment: ['f1'], items: [] })).toEqual([])
    expect(summaryFields(summarySchema, {})).toEqual([])
  })
})

describe('formatSummaryLine (B2-01)', () => {
  it('joins label：value pairs with " · "', () => {
    const line = formatSummaryLine([
      { key: 'a', label: '请假类型', value: '年假' },
      { key: 'b', label: '时长', value: '2' },
    ])
    expect(line).toBe('请假类型：年假 · 时长：2')
  })

  it('returns a single entry without a separator', () => {
    expect(formatSummaryLine([{ key: 'a', label: '事由', value: '出差' }])).toBe('事由：出差')
  })

  it('returns an empty string for an empty array', () => {
    expect(formatSummaryLine([])).toBe('')
  })
})
