import { describe, expect, it } from 'vitest'
import {
  AUTHORABLE_FIELD_TYPES,
  DETAIL_LEAF_FIELD_TYPES,
  buildFormSchema,
  createEmptyFieldDraft,
  createEmptyTemplateDraft,
  draftFromTemplate,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import { addFormField, updateFormFieldProperties } from '../src/approvals/approvalFormCommands'
import { formatDisplayValue as _unused } from '../src/approvals/detailField'
import {
  computeDateRangeDurationText,
  dateRangePickerElementType,
  dateRangePickerValueFormat,
  isDateRangeEndpointValid,
} from '../src/approvals/dateRangeField'
import type { ApprovalTemplateDetailDTO, FormField } from '../src/types/approval'
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from '../src/approvals/components/ApprovalFormPalette.vue'

void _unused // formatDisplayValue is not exported; imported only to prove the module still resolves.

// Lock-8 L8-B (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2) — date_range
// (日期区间) FE registration completeness + OD-L8-4 + OD-L8-8.
//
// Registration completeness (N-1 style, family-scoped — the FULL MS-1..MS-13 mechanical census is
// L8-A's deliverable per §2.1; this proves date_range specifically is admitted consistently, not a
// substitute for that broader gate): AUTHORABLE_FIELD_TYPES, the palette groups (cross-checking the
// existing forcing-function test at approval-form-palette-chips.spec.ts:107), FIELD_LABELS-derived
// authorable set (via addFormField), buildFormSchema's props arm, and draftFromTemplate hydration
// all agree date_range is admitted; DETAIL_LEAF_FIELD_TYPES agrees it is EXCLUDED (OD-L8-4).

function buildTemplate(overrides: Partial<ApprovalTemplateDetailDTO> = {}): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z',
    formSchema: { fields: [] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: '审批人 1', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
    ...overrides,
  }
}

describe('Lock-8 L8-B registration completeness (FE)', () => {
  it('date_range IS in AUTHORABLE_FIELD_TYPES', () => {
    expect(AUTHORABLE_FIELD_TYPES).toContain('date_range')
  })

  it('date_range IS in the date_range palette group, and the census is exact (mirrors :107 forcing function)', () => {
    const groupedTypes = APPROVAL_FORM_PALETTE_GROUPS.flatMap((group) => group.entries.map((entry) => entry.type))
    expect([...groupedTypes].sort()).toEqual([...AUTHORABLE_FIELD_TYPES].sort())
    const dateGroup = APPROVAL_FORM_PALETTE_GROUPS.find((group) => group.id === 'date')
    expect(dateGroup?.entries.map((entry) => entry.type)).toContain('date_range')
    expect(APPROVAL_FORM_FIELD_TYPE_LABELS.date_range).toBe('日期区间')
  })

  it('date_range IS admitted by the approvalFormCommands authorable-type gate (addFormField)', () => {
    const draft = createEmptyTemplateDraft()
    const result = addFormField(draft, 'date_range', { persistentId: 'range', localId: 'local_range' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const field = result.draft.fields.find((f) => f.localId === 'local_range')
      expect(field?.type).toBe('date_range')
    }
  })

  it('date_range stays admitted for a property update (not rejected as unsupported_field_type)', () => {
    const draft = createEmptyTemplateDraft()
    const added = addFormField(draft, 'date_range', { persistentId: 'range', localId: 'local_range' })
    if (!added.ok) throw new Error('setup failed')
    const result = updateFormFieldProperties(added.draft, 'local_range', { label: '出差区间' })
    expect(result.ok).toBe(true)
  })

  it('date_range is NOT in DETAIL_LEAF_FIELD_TYPES — OD-L8-4 exclusion (correct BY OMISSION)', () => {
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('date_range')
  })
})

describe('Lock-8 L8-B draft carrier + buildFormSchema', () => {
  it('createEmptyFieldDraft seeds neutral/unset date_range defaults (dateType empty, no absent-default coercion)', () => {
    const draft = createEmptyFieldDraft(1)
    expect(draft.dateRangeDateType).toBe('')
    expect(draft.dateRangeStartLabel).toBe('')
    expect(draft.dateRangeEndLabel).toBe('')
    expect(draft.dateRangeDurationLabel).toBe('')
  })

  it('buildFormSchema emits dateType/startLabel/endLabel/durationLabel props for a date_range field', () => {
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'range', type: 'date_range', label: '出差区间',
        dateRangeDateType: 'date', dateRangeStartLabel: '起始', dateRangeEndLabel: '结束', dateRangeDurationLabel: '时长',
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].props).toEqual({
      dateType: 'date', startLabel: '起始', endLabel: '结束', durationLabel: '时长',
    })
  })

  it('buildFormSchema OMITS durationLabel when blank (optional, no residual key)', () => {
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'range', type: 'date_range', label: '出差区间',
        dateRangeDateType: 'date_minute', dateRangeStartLabel: '起始', dateRangeEndLabel: '结束', dateRangeDurationLabel: '',
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].props).toEqual({ dateType: 'date_minute', startLabel: '起始', endLabel: '结束' })
    expect(Object.prototype.hasOwnProperty.call(schema.fields[0].props as object, 'durationLabel')).toBe(false)
  })

  it('buildFormSchema emits NO dateType key when the draft is unset (§1.2 no absent-default — publish rejects, client never silently picks an arm)', () => {
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'range', type: 'date_range', label: '出差区间',
        dateRangeDateType: '', dateRangeStartLabel: '起始', dateRangeEndLabel: '结束',
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(Object.prototype.hasOwnProperty.call(schema.fields[0].props as object, 'dateType')).toBe(false)
  })

  it('buildFormSchema strips date_range keys when the field is retyped away (no stale props on the new type)', () => {
    const original: FormField = {
      id: 'range', type: 'date_range', label: '区间',
      props: { dateType: 'date', startLabel: '起始', endLabel: '结束', durationLabel: '时长' },
    }
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'range', type: 'text', label: '区间', original,
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].props).toBeUndefined()
  })

  it('draftFromTemplate hydrates date_range props typeof-guarded (a malformed stored value hydrates to "unset", not a throw/coercion)', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{
          id: 'range', type: 'date_range', label: '区间',
          props: { dateType: 'date_half_day', startLabel: '起始', endLabel: '结束' },
        }],
      },
    })
    const draft = draftFromTemplate(template)
    const field = draft.fields.find((f) => f.id === 'range')
    expect(field?.dateRangeDateType).toBe('date_half_day')
    expect(field?.dateRangeStartLabel).toBe('起始')
    expect(field?.dateRangeEndLabel).toBe('结束')
    expect(field?.dateRangeDurationLabel).toBe('')

    const malformed = buildTemplate({
      formSchema: {
        fields: [{
          id: 'range', type: 'date_range', label: '区间',
          props: { dateType: 'not-a-real-arm', startLabel: 42 },
        }],
      },
    })
    const malformedDraft = draftFromTemplate(malformed)
    const malformedField = malformedDraft.fields.find((f) => f.id === 'range')
    expect(malformedField?.dateRangeDateType).toBe('')
    expect(malformedField?.dateRangeStartLabel).toBe('')
  })
})

describe('Lock-8 L8-B OD-L8-8 — derived duration is display-only, renders and updates', () => {
  it('computes a whole-day duration for the civil-date arm', () => {
    expect(computeDateRangeDurationText('date', '2026-08-01', '2026-08-05')).toBe('4 天')
    expect(computeDateRangeDurationText('date', '2026-08-01', '2026-08-01')).toBe('0 天')
  })

  it('computes an hours/minutes duration for the time-bearing arms, and the text CHANGES when an endpoint changes (not vacuous)', () => {
    const first = computeDateRangeDurationText('date_minute', '2026-08-01T09:00:00', '2026-08-01T17:30:00')
    expect(first).toBe('8 小时 30 分钟')
    const second = computeDateRangeDurationText('date_minute', '2026-08-01T09:00:00', '2026-08-01T18:00:00')
    expect(second).toBe('9 小时')
    expect(second).not.toBe(first) // the positive control: changing ONE endpoint changes the rendered text.
  })

  it('renders null (no duration) for an out-of-order or incomplete pair — not negative/nonsensical text', () => {
    expect(computeDateRangeDurationText('date', '2026-08-05', '2026-08-01')).toBeNull()
    expect(computeDateRangeDurationText('date', '2026-08-01', '')).toBeNull()
    expect(computeDateRangeDurationText('date', '', '2026-08-01')).toBeNull()
    expect(computeDateRangeDurationText(undefined, '2026-08-01', '2026-08-05')).toBeNull()
  })

  it('isDateRangeEndpointValid fails closed on a missing/off-enum dateType — never the permissive instant branch', () => {
    expect(isDateRangeEndpointValid(undefined, '2026-08-01')).toBe(false)
    expect(isDateRangeEndpointValid('week', '2026-08-01')).toBe(false)
    expect(isDateRangeEndpointValid('date', '2026-08-01')).toBe(true)
    expect(isDateRangeEndpointValid('date_minute', '2026-08-01T09:00:00')).toBe(true)
  })

  it('the picker widget contract: civil arm -> date/YYYY-MM-DD; both time-bearing arms -> datetime/full string (D-2: two contracts, not three)', () => {
    expect(dateRangePickerElementType('date')).toBe('date')
    expect(dateRangePickerValueFormat('date')).toBe('YYYY-MM-DD')
    expect(dateRangePickerElementType('date_half_day')).toBe('datetime')
    expect(dateRangePickerElementType('date_minute')).toBe('datetime')
    expect(dateRangePickerValueFormat('date_half_day')).toBe('YYYY-MM-DDTHH:mm:ss')
    expect(dateRangePickerValueFormat('date_minute')).toBe('YYYY-MM-DDTHH:mm:ss')
  })
})
