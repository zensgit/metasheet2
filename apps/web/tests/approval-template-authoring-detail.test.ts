import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/types/approval'
import {
  AUTHORABLE_FIELD_TYPES,
  buildFormSchema,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  draftFromTemplate,
  validateTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import type { DetailColumnDraft } from '../src/approvals/detailField'

function detailColumnDraft(overrides: Partial<DetailColumnDraft> = {}): DetailColumnDraft {
  return {
    localId: `l_${Math.random().toString(16).slice(2)}`,
    id: 'product',
    type: 'text',
    label: '品名',
    required: false,
    optionsText: '',
    ...overrides,
  }
}

function detailFieldDraft(overrides: Partial<FieldAuthoringDraft> = {}): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(1),
    id: 'items',
    type: 'detail',
    label: '明细',
    detailColumns: [detailColumnDraft()],
    minRowsText: '',
    maxRowsText: '',
    ...overrides,
  }
}

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'k',
    name: 'n',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

describe('templateAuthoring — detail is authorable', () => {
  it('includes detail in AUTHORABLE_FIELD_TYPES (top-level), excludes attachment', () => {
    expect(AUTHORABLE_FIELD_TYPES).toContain('detail')
    expect(AUTHORABLE_FIELD_TYPES).not.toContain('attachment')
  })

  it('a fresh field draft seeds empty detail authoring state', () => {
    const draft = createEmptyFieldDraft(1)
    expect(draft.detailColumns).toEqual([])
    expect(draft.minRowsText).toBe('')
    expect(draft.maxRowsText).toBe('')
  })
})

describe('templateAuthoring — buildFormSchema emits detail shape', () => {
  it('emits columns + minRows/maxRows for a detail field', () => {
    const schema = buildFormSchema(
      draftWith([
        detailFieldDraft({
          detailColumns: [
            detailColumnDraft({ id: 'product', type: 'text', label: '品名', required: true }),
            detailColumnDraft({ id: 'tags', type: 'multi-select', label: '标签', optionsText: 'A:a\nB:b' }),
          ],
          minRowsText: '1',
          maxRowsText: '200',
        }),
      ]),
    )
    const field = schema.fields[0]
    expect(field.type).toBe('detail')
    expect(field.columns?.map((c) => c.id)).toEqual(['product', 'tags'])
    expect(field.columns?.find((c) => c.id === 'product')?.required).toBe(true)
    expect(field.columns?.find((c) => c.id === 'tags')?.options).toEqual([
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ])
    expect(field.minRows).toBe(1)
    expect(field.maxRows).toBe(200)
  })

  it('omits minRows/maxRows when their inputs are blank', () => {
    const schema = buildFormSchema(draftWith([detailFieldDraft({ minRowsText: '', maxRowsText: '' })]))
    expect(schema.fields[0]).not.toHaveProperty('minRows')
    expect(schema.fields[0]).not.toHaveProperty('maxRows')
    expect(schema.fields[0].columns).toHaveLength(1)
  })

  it('deletes stale detail keys when a field is no longer a detail (original spread guard)', () => {
    // Simulate hydrating a detail field from server, then changing its type to text.
    const original: FormField = {
      id: 'items',
      type: 'detail',
      label: '明细',
      columns: [{ id: 'product', type: 'text', label: '品名' }],
      minRows: 1,
      maxRows: 5,
    }
    const field = detailFieldDraft({ type: 'text', original })
    const schema = buildFormSchema(draftWith([field]))
    expect(schema.fields[0].type).toBe('text')
    expect(schema.fields[0]).not.toHaveProperty('columns')
    expect(schema.fields[0]).not.toHaveProperty('minRows')
    expect(schema.fields[0]).not.toHaveProperty('maxRows')
  })
})

describe('templateAuthoring — validateTemplateDraft detail branch', () => {
  it('passes a valid detail field', () => {
    const errors = validateTemplateDraft(draftWith([detailFieldDraft()]))
    expect(errors).toEqual([])
  })

  it('rejects a detail field with no sub-fields', () => {
    const errors = validateTemplateDraft(draftWith([detailFieldDraft({ detailColumns: [] })]))
    expect(errors.some((e) => e.includes('至少需要一个子字段'))).toBe(true)
  })

  it('rejects a nested detail sub-field', () => {
    const errors = validateTemplateDraft(
      draftWith([
        detailFieldDraft({ detailColumns: [detailColumnDraft({ type: 'detail' as DetailColumnDraft['type'] })] }),
      ]),
    )
    expect(errors.some((e) => e.includes('类型不支持'))).toBe(true)
  })

  it('rejects duplicate sub-field ids', () => {
    const errors = validateTemplateDraft(
      draftWith([
        detailFieldDraft({
          detailColumns: [detailColumnDraft({ id: 'dup' }), detailColumnDraft({ id: 'dup', label: '其他' })],
        }),
      ]),
    )
    expect(errors.some((e) => e.includes('不能重复'))).toBe(true)
  })

  it('rejects minRows > maxRows', () => {
    const errors = validateTemplateDraft(draftWith([detailFieldDraft({ minRowsText: '9', maxRowsText: '2' })]))
    expect(errors.some((e) => e.includes('最小行数不能大于最大行数'))).toBe(true)
  })
})

describe('templateAuthoring — draftFromTemplate hydrates detail columns (round-trip)', () => {
  it('hydrates columns + bounds from a stored detail template', () => {
    const draft = draftFromTemplate({
      id: 't1',
      key: 'k',
      name: 'n',
      description: null,
      category: null,
      status: 'draft',
      version: 1,
      visibilityScope: { type: 'all', ids: [] },
      slaHours: null,
      formSchema: {
        fields: [
          {
            id: 'items',
            type: 'detail',
            label: '明细',
            columns: [
              { id: 'product', type: 'text', label: '品名', required: true },
              { id: 'qty', type: 'number', label: '数量' },
            ],
            minRows: 1,
            maxRows: 50,
          },
        ],
      },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'approval_1', type: 'approval', name: '审批', config: { assigneeSources: [{ kind: 'requester' }] } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)

    const field = draft.fields.find((f) => f.id === 'items')
    expect(field?.type).toBe('detail')
    expect(field?.detailColumns.map((c) => c.id)).toEqual(['product', 'qty'])
    expect(field?.detailColumns.find((c) => c.id === 'product')?.required).toBe(true)
    expect(field?.minRowsText).toBe('1')
    expect(field?.maxRowsText).toBe('50')

    // And re-emitting reproduces the columns.
    const rebuilt = buildFormSchema(draft)
    const rebuiltField = rebuilt.fields.find((f) => f.id === 'items')
    expect(rebuiltField?.columns?.map((c) => c.id)).toEqual(['product', 'qty'])
    expect(rebuiltField?.minRows).toBe(1)
    expect(rebuiltField?.maxRows).toBe(50)
  })

  // P1 regression: unmanaged sub-field metadata must NOT be silently flattened on save.
  it('preserves a sub-field props / visibilityRule / placeholder / defaultValue through save (no flatten)', () => {
    const storedColumns: FormField[] = [
      {
        id: 'qty',
        type: 'number',
        label: '数量',
        required: true,
        placeholder: '请输入数量',
        defaultValue: 1,
        // backend-contract constraints the v1 UI does NOT manage:
        props: { min: 1, max: 999, step: 1 },
      },
      {
        id: 'note',
        type: 'text',
        label: '备注',
        // a same-row sub-field visibilityRule the v1 UI does NOT author:
        visibilityRule: { fieldId: 'qty', operator: 'notEmpty' },
      },
    ]
    const draft = draftFromTemplate({
      id: 't1',
      key: 'k',
      name: 'n',
      description: null,
      category: null,
      status: 'draft',
      version: 1,
      visibilityScope: { type: 'all', ids: [] },
      slaHours: null,
      formSchema: { fields: [{ id: 'items', type: 'detail', label: '明细', columns: storedColumns }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'approval_1', type: 'approval', name: '审批', config: { assigneeSources: [{ kind: 'requester' }] } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)

    const rebuilt = buildFormSchema(draft)
    const rebuiltColumns = rebuilt.fields.find((f) => f.id === 'items')?.columns
    expect(rebuiltColumns).toBeDefined()
    // The detail columns round-trip preserving ALL unmanaged metadata. `required` is the one
    // UI-managed field that is normalized to an explicit boolean (mirrors top-level buildFormSchema
    // `required: field.required`), so the only delta vs the stored input is `note.required: false`
    // becoming explicit — no metadata is dropped.
    expect(rebuiltColumns).toEqual([
      storedColumns[0],
      { ...storedColumns[1], required: false },
    ])
    const qty = rebuiltColumns?.find((c) => c.id === 'qty')
    expect(qty?.props).toEqual({ min: 1, max: 999, step: 1 })
    expect(qty?.placeholder).toBe('请输入数量')
    expect(qty?.defaultValue).toBe(1)
    expect(rebuiltColumns?.find((c) => c.id === 'note')?.visibilityRule).toEqual({ fieldId: 'qty', operator: 'notEmpty' })
  })
})
