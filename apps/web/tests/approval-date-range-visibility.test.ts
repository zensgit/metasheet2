import { describe, expect, it } from 'vitest'
import {
  describeFieldVisibilityRule,
  getVisibleFormFields,
  pruneHiddenFormData,
  resolveVisibilityFieldReference,
  readVisibilityReferenceValue,
} from '../src/approvals/fieldVisibility'
import {
  clearStaleRecordLinkDependencies,
  dateRangeVisibilityEndpointOptions,
  dateRangeVisibilityFieldId,
  isSelectableConditionOrVisibilityDependencyType,
  visibilityReferenceBaseFieldId,
} from '../src/approvals/recordLinkField'
import { collectFormFieldDependencies } from '../src/approvals/approvalFormCommands'
import { createEmptyFieldDraft, createEmptyTemplateDraft } from '../src/approvals/templateAuthoring'
import type { FormSchema } from '../src/types/approval'

// Lock-8 L8-B OD-L8-5(a) (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2) — a
// per-type visibility/condition-driver predicate on BOTH sides: date_range is refused as a bare
// whole-value dependency ("never as one comparable value") and admitted ONLY via its dotted
// `${fieldId}.start` / `${fieldId}.end` endpoint address — extending the shipped `{fieldId.columnId}`
// detail formula-token grammar to visibility. This file is the FE half (MS-9); the BE half (MS-8) is
// covered by packages/core-backend/tests/unit/approval-lock8-date-range.test.ts.

const schema: FormSchema = {
  fields: [
    { id: 'range', type: 'date_range', label: '出差区间', props: { dateType: 'date', startLabel: '起始', endLabel: '结束' } },
    { id: 'startNote', type: 'text', label: '起始备注', visibilityRule: { fieldId: 'range.start', operator: 'notEmpty' } },
    { id: 'endNote', type: 'text', label: '结束备注', visibilityRule: { fieldId: 'range.end', operator: 'eq', value: '2026-08-10' } },
    { id: 'amount', type: 'number', label: '金额' },
  ],
}

describe('Lock-8 L8-B OD-L8-5(a) resolver (FE fieldVisibility.ts mirror of the BE resolver)', () => {
  it('resolves a bare non-date_range reference to the whole field', () => {
    const ref = resolveVisibilityFieldReference('amount', schema.fields)
    expect(ref).toEqual({ field: schema.fields[3] })
  })

  it('refuses a bare reference to the date_range field itself (null — never one comparable value)', () => {
    expect(resolveVisibilityFieldReference('range', schema.fields)).toBeNull()
  })

  it('resolves .start / .end dotted addresses to the date_range field + endpoint', () => {
    expect(resolveVisibilityFieldReference('range.start', schema.fields)).toEqual({ field: schema.fields[0], endpoint: 'start' })
    expect(resolveVisibilityFieldReference('range.end', schema.fields)).toEqual({ field: schema.fields[0], endpoint: 'end' })
  })

  it('refuses an unknown field, a bad suffix, and a dotted suffix off a non-date_range base', () => {
    expect(resolveVisibilityFieldReference('missing', schema.fields)).toBeNull()
    expect(resolveVisibilityFieldReference('range.middle', schema.fields)).toBeNull()
    expect(resolveVisibilityFieldReference('amount.start', schema.fields)).toBeNull()
  })

  it('readVisibilityReferenceValue reads the endpoint, not the whole { start, end } object', () => {
    const formData = { range: { start: '2026-08-01', end: '2026-08-10' } }
    expect(readVisibilityReferenceValue({ field: schema.fields[0], endpoint: 'start' }, formData)).toBe('2026-08-01')
    expect(readVisibilityReferenceValue({ field: schema.fields[0], endpoint: 'end' }, formData)).toBe('2026-08-10')
  })
})

describe('Lock-8 L8-B runtime visibility (getVisibleFormFields / pruneHiddenFormData, dotted endpoint)', () => {
  it('a field depending on .start is visible/hidden by the START endpoint specifically — not the .end value (positive control against wrong-endpoint leakage)', () => {
    const startFilled = { range: { start: '2026-08-01', end: '' }, startNote: 'hi', endNote: 'hi', amount: 1 }
    expect(getVisibleFormFields(schema, startFilled).map((f) => f.id)).toContain('startNote')
    expect(getVisibleFormFields(schema, startFilled).map((f) => f.id)).not.toContain('endNote')

    const endFilledOnly = { range: { start: '', end: '2026-08-10' }, startNote: 'hi', endNote: 'hi', amount: 1 }
    expect(getVisibleFormFields(schema, endFilledOnly).map((f) => f.id)).not.toContain('startNote')
    expect(getVisibleFormFields(schema, endFilledOnly).map((f) => f.id)).toContain('endNote')
  })

  it('pruneHiddenFormData drops the dependent field data when its endpoint condition is unmet', () => {
    const data = { range: { start: '', end: '' }, startNote: 'stale', endNote: 'stale', amount: 5 }
    const pruned = pruneHiddenFormData(schema, data)
    expect(pruned).toEqual({ range: { start: '', end: '' }, amount: 5 })
  })

  it('describeFieldVisibilityRule labels a dotted endpoint humanely — never leaks the raw "id.start" address (M8)', () => {
    const description = describeFieldVisibilityRule(schema.fields[1], schema)
    expect(description).toContain('出差区间(起始)')
    expect(description).not.toContain('range.start')
  })
})

describe('Lock-8 L8-B MS-9 — FE selectable-dependency predicate + endpoint options', () => {
  it('date_range is NOT selectable as a whole-value dependency (widens the existing record-link/detail exclusion)', () => {
    expect(isSelectableConditionOrVisibilityDependencyType('date_range')).toBe(false)
    expect(isSelectableConditionOrVisibilityDependencyType('record-link')).toBe(false)
    expect(isSelectableConditionOrVisibilityDependencyType('detail')).toBe(false)
    // positive control: an ordinary scalar type stays selectable.
    expect(isSelectableConditionOrVisibilityDependencyType('text')).toBe(true)
    expect(isSelectableConditionOrVisibilityDependencyType('number')).toBe(true)
  })

  it('dateRangeVisibilityEndpointOptions offers exactly {start, end} for date_range, and nothing for any other type', () => {
    expect(dateRangeVisibilityEndpointOptions('date_range')).toEqual([
      { endpoint: 'start', label: '起始' },
      { endpoint: 'end', label: '结束' },
    ])
    expect(dateRangeVisibilityEndpointOptions('text')).toEqual([])
    expect(dateRangeVisibilityEndpointOptions('date')).toEqual([])
  })

  it('dateRangeVisibilityFieldId builds the exact dotted address the resolver expects (M7: the picker affordance writes a REAL address)', () => {
    expect(dateRangeVisibilityFieldId('range', 'start')).toBe('range.start')
    expect(dateRangeVisibilityFieldId('range', 'end')).toBe('range.end')
    expect(resolveVisibilityFieldReference(dateRangeVisibilityFieldId('range', 'start'), schema.fields))
      .toEqual({ field: schema.fields[0], endpoint: 'start' })
  })
})

describe('Lock-8 L8-B dependency-tracking dotted safety (delete/retype must not orphan an endpoint reference)', () => {
  it('visibilityReferenceBaseFieldId strips a .start/.end suffix but leaves a bare id / unrelated dot untouched', () => {
    expect(visibilityReferenceBaseFieldId('range.start')).toBe('range')
    expect(visibilityReferenceBaseFieldId('range.end')).toBe('range')
    expect(visibilityReferenceBaseFieldId('range')).toBe('range')
    expect(visibilityReferenceBaseFieldId('range.middle')).toBe('range.middle')
  })

  it('collectFormFieldDependencies finds a dotted-endpoint reference when checking whether a date_range field is deletable (no silent orphan)', () => {
    const draft = {
      ...createEmptyTemplateDraft(),
      fields: [
        { ...createEmptyFieldDraft(1), localId: 'l_range', id: 'range', type: 'date_range' as const },
        {
          ...createEmptyFieldDraft(2),
          localId: 'l_note', id: 'note', type: 'text' as const,
          visibility: { dependsOnFieldId: 'range.start', operator: 'eq' as const, valueText: 'x' },
        },
      ],
    }
    const dependencies = collectFormFieldDependencies(draft, 'range')
    expect(dependencies).toContainEqual({ kind: 'visibility_rule', location: 'fields.l_note.visibility' })
  })

  it('clearStaleRecordLinkDependencies clears a dotted endpoint reference when the date_range field is retyped away', () => {
    const fields = [
      { id: 'range', type: 'date_range', visibility: undefined },
      { id: 'note', type: 'text', visibility: { dependsOnFieldId: 'range.end', operator: 'eq', valueText: 'x' } },
    ]
    const result = clearStaleRecordLinkDependencies(fields, [], 'range', 'date_range')
    expect(result.fields[1].visibility).toEqual({ dependsOnFieldId: '', operator: 'eq', valueText: '' })
  })

  it('positive control: an UNRELATED retype (e.g. text -> textarea) does NOT touch a date_range endpoint reference', () => {
    const fields = [
      { id: 'range', type: 'date_range', visibility: undefined },
      { id: 'note', type: 'text', visibility: { dependsOnFieldId: 'range.start', operator: 'eq', valueText: 'x' } },
      { id: 'other', type: 'text', visibility: undefined },
    ]
    const result = clearStaleRecordLinkDependencies(fields, [], 'other', 'textarea')
    expect(result.fields[1].visibility).toEqual({ dependsOnFieldId: 'range.start', operator: 'eq', valueText: 'x' })
  })
})
