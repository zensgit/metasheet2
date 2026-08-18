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
import {
  buildDisplayFields,
  summaryFields,
} from '../src/approvals/detailField'
import { prefillFromSnapshot } from '../src/approvals/prefillFromSnapshot'
import {
  isSelectableConditionOrVisibilityDependencyType,
  clearStaleRecordLinkDependencies,
} from '../src/approvals/recordLinkField'
import { resolveVisibilityFieldReference } from '../src/approvals/fieldVisibility'
import {
  approvalFormulaInsertOptions,
  validateConditionEdits,
  type ConditionEdits,
} from '../src/approvals/conditionEdit'
import type { ApprovalTemplateDetailDTO, FormField, FormSchema } from '../src/types/approval'
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from '../src/approvals/components/ApprovalFormPalette.vue'

// Lock-8 L8-A (docs/development/approval-lock8-field-vocabulary-20260817.md §1.1) — explanation
// (说明) FE registration completeness + A-1 valuelessness + display/prefill/condition/visibility
// exclusions.
//
// Registration completeness (N-1 style, family-scoped — the FULL MS-1..MS-13 mechanical census is
// L8-A's OWN deliverable per §2.1, covered by approval-lock8-field-type-census.test.ts on the
// backend and this file's own MS-5/MS-9 loops below on the frontend): AUTHORABLE_FIELD_TYPES, the
// palette groups (cross-checking the existing forcing-function test at
// approval-form-palette-chips.spec.ts:107), FIELD_LABELS-derived authorable set (via addFormField),
// buildFormSchema's props arm, and draftFromTemplate hydration all agree explanation is admitted;
// DETAIL_LEAF_FIELD_TYPES agrees it is EXCLUDED (MS-4/MS-5).

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

describe('Lock-8 L8-A registration completeness (FE)', () => {
  it('explanation IS in AUTHORABLE_FIELD_TYPES', () => {
    expect(AUTHORABLE_FIELD_TYPES).toContain('explanation')
  })

  it('explanation IS in the 其他 palette group, and the census is exact (mirrors :107 forcing function)', () => {
    const groupedTypes = APPROVAL_FORM_PALETTE_GROUPS.flatMap((group) => group.entries.map((entry) => entry.type))
    expect([...groupedTypes].sort()).toEqual([...AUTHORABLE_FIELD_TYPES].sort())
    const otherGroup = APPROVAL_FORM_PALETTE_GROUPS.find((group) => group.id === 'other')
    expect(otherGroup?.entries.map((entry) => entry.type)).toContain('explanation')
    expect(APPROVAL_FORM_FIELD_TYPE_LABELS.explanation).toBe('说明')
  })

  it('explanation IS admitted by the approvalFormCommands authorable-type gate (addFormField)', () => {
    const draft = createEmptyTemplateDraft()
    const result = addFormField(draft, 'explanation', { persistentId: 'note', localId: 'local_note' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const field = result.draft.fields.find((f) => f.localId === 'local_note')
      expect(field?.type).toBe('explanation')
    }
  })

  it('explanation stays admitted for a property update (not rejected as unsupported_field_type)', () => {
    const draft = createEmptyTemplateDraft()
    const added = addFormField(draft, 'explanation', { persistentId: 'note', localId: 'local_note' })
    if (!added.ok) throw new Error('setup failed')
    const result = updateFormFieldProperties(added.draft, 'local_note', { label: '提示说明' })
    expect(result.ok).toBe(true)
  })

  it('explanation is NOT in DETAIL_LEAF_FIELD_TYPES — MS-4/MS-5 exclusion (correct BY OMISSION)', () => {
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('explanation')
  })
})

describe('Lock-8 L8-A draft carrier + buildFormSchema', () => {
  it('createEmptyFieldDraft seeds a neutral/unset explanationText default', () => {
    const draft = createEmptyFieldDraft(1)
    expect(draft.explanationText).toBe('')
  })

  it('buildFormSchema emits { text } props for an explanation field', () => {
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'note', type: 'explanation', label: '说明',
        explanationText: '  仅供参考，请如实填写  ',
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].props).toEqual({ text: '仅供参考，请如实填写' })
  })

  it('A-1: buildFormSchema FORCES required:false and strips placeholder/defaultValue even when the draft/original carries them', () => {
    const original: FormField = {
      id: 'note', type: 'text', label: '说明', required: true, placeholder: '请输入', defaultValue: '默认文字',
    }
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'note', type: 'explanation', label: '说明',
        // Simulates an author who toggled 必填/占位文本 BEFORE retyping to explanation, or a
        // retype-away-and-back where `original` still carries a stale defaultValue.
        required: true, placeholder: '请输入', explanationText: '仅供参考', original,
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].required).toBe(false)
    expect(schema.fields[0].placeholder).toBeUndefined()
    expect(schema.fields[0].defaultValue).toBeUndefined()
    expect(schema.fields[0].options).toBeUndefined()
  })

  it('buildFormSchema strips explanation props.text when the field is retyped away (no stale prop on the new type)', () => {
    const original: FormField = { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }
    const templateDraft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'note', type: 'text', label: '说明', original,
      }],
    }
    const schema = buildFormSchema(templateDraft)
    expect(schema.fields[0].props).toBeUndefined()
  })

  it('draftFromTemplate hydrates explanationText typeof-guarded (a malformed stored value hydrates to "unset", not a throw/coercion)', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
      },
    })
    const draft = draftFromTemplate(template)
    const field = draft.fields.find((f) => f.id === 'note')
    expect(field?.explanationText).toBe('仅供参考')

    const malformed = buildTemplate({
      formSchema: {
        fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: 42 } }],
      },
    })
    const malformedDraft = draftFromTemplate(malformed)
    const malformedField = malformedDraft.fields.find((f) => f.id === 'note')
    expect(malformedField?.explanationText).toBe('')
  })
})

describe('Lock-8 L8-A MS-9: FE selectable-dependency predicate + retype dependency clearing', () => {
  it('isSelectableConditionOrVisibilityDependencyType(explanation) is false', () => {
    expect(isSelectableConditionOrVisibilityDependencyType('explanation')).toBe(false)
  })

  it('positive control: every OTHER authorable type stays selectable (the exclusion is type-selected)', () => {
    for (const type of AUTHORABLE_FIELD_TYPES) {
      if (type === 'explanation' || type === 'record-link' || type === 'detail' || type === 'date_range') continue
      expect(isSelectableConditionOrVisibilityDependencyType(type)).toBe(true)
    }
  })

  it('retyping a field TO explanation clears a stale visibility dependency pointing at it', () => {
    const fields = [
      { id: 'note', type: 'explanation', visibility: { dependsOnFieldId: '', operator: 'eq', valueText: '' } },
      { id: 'reason', type: 'text', visibility: { dependsOnFieldId: 'note', operator: 'notEmpty', valueText: '' } },
    ]
    const result = clearStaleRecordLinkDependencies(fields, [{ fieldId: 'note' }], 'note', 'explanation')
    expect(result.fields[1].visibility).toEqual({ dependsOnFieldId: '', operator: 'eq', valueText: '' })
    expect(result.conditionRules[0].fieldId).toBe('')
  })
})

describe('Lock-8 L8-A FE resolveVisibilityFieldReference (mirrors the backend gate)', () => {
  const fields = [
    { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
    { id: 'kind', type: 'text', label: '类型' },
  ] as FormSchema['fields']

  it('refuses a bare reference to an explanation field (null, no endpoint fallback)', () => {
    expect(resolveVisibilityFieldReference('note', fields)).toBeNull()
  })

  it('positive control: resolves a bare reference to an ordinary text field', () => {
    expect(resolveVisibilityFieldReference('kind', fields)).toEqual({ field: fields[1] })
  })
})

describe('Lock-8 L8-A prefill exclusion (再次提交)', () => {
  it('explanation is never prefilled, even if an out-of-band snapshot carries a stray key', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        { id: 'reason', type: 'textarea', label: '事由' },
      ],
    }
    const result = prefillFromSnapshot(schema, { note: 'someone typed here anyway', reason: '出差申请' })
    expect(result).toEqual({ reason: '出差申请' })
    expect(Object.prototype.hasOwnProperty.call(result, 'note')).toBe(false)
  })
})

describe('Lock-8 L8-A display: buildDisplayFields renders props.text to BOTH the requester (再次提交 review) and the approver (detail view) — the SAME shared function', () => {
  it('renders the authored text when the explanation field is VISIBLE, sourced from props.text NOT the (empty) snapshot', () => {
    const schema: FormSchema = {
      fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考，请如实填写' } }],
    }
    // formSnapshot carries NOTHING for `note` (A-1: it is never a submitted value) — proves the
    // render is sourced from the FROZEN SCHEMA, not the snapshot.
    const fields = buildDisplayFields(schema, {})
    expect(fields).toEqual([{ key: 'note', label: '说明', value: '仅供参考，请如实填写' }])
  })

  it('renders NOTHING when the explanation field is HIDDEN by its own visibilityRule (visibility is not bypassed)', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'kind', type: 'text', label: '类型' },
        {
          id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' },
          visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'special' },
        },
      ],
    }
    // kind !== 'special' -> note's own visibilityRule evaluates false -> hidden.
    const hidden = buildDisplayFields(schema, { kind: 'normal' })
    expect(hidden.find((f) => f.key === 'note')).toBeUndefined()
    // Positive control: kind === 'special' -> note's rule evaluates true -> visible, still
    // sourced from props.text (the snapshot never carries a `note` key either way).
    const visible = buildDisplayFields(schema, { kind: 'special' })
    expect(visible.find((f) => f.key === 'note')).toEqual({ key: 'note', label: '说明', value: '仅供参考' })
  })

  it('an explanation field carrying its OWN visibilityRule stays legal — only rules pointing AT it are refused', () => {
    // This is the same case as above, restated to make the distinction explicit: explanation MAY
    // be the DEPENDENT side of a visibilityRule (its OWN rule, evaluated against another field's
    // value); it may never be the fieldId TARGET another field's rule points AT (MS-8/MS-9).
    const schema: FormSchema = {
      fields: [
        { id: 'kind', type: 'text', label: '类型' },
        {
          id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' },
          visibilityRule: { fieldId: 'kind', operator: 'notEmpty' },
        },
      ],
    }
    expect(buildDisplayFields(schema, { kind: 'x' }).find((f) => f.key === 'note')).toBeDefined()
    expect(buildDisplayFields(schema, {}).find((f) => f.key === 'note')).toBeUndefined()
  })

  it('never reaches formatDisplayValue\'s String() default even when a snapshot DOES carry a stray key for it', () => {
    const schema: FormSchema = {
      fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
    }
    // If this arm fell through to the generic String()-based formatter, an object snapshot value
    // would render as "[object Object]" (M8 dishonesty). It must instead render props.text.
    const fields = buildDisplayFields(schema, { note: { anything: true } })
    expect(fields).toEqual([{ key: 'note', label: '说明', value: '仅供参考' }])
  })

  it('summaryFields (list-row glance line) EXCLUDES explanation — it is authoring copy, not requester-filled data', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        { id: 'reason', type: 'text', label: '事由' },
      ],
    }
    const summary = summaryFields(schema, { reason: '出差申请' })
    expect(summary.map((f) => f.key)).toEqual(['reason'])
  })
})

describe('Lock-8 L8-A condition-branch exclusion (FE preview mirror)', () => {
  it('approvalFormulaInsertOptions never offers an explanation field as an insertable token', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        { id: 'kind', type: 'text', label: '类型' },
      ],
    }
    const options = approvalFormulaInsertOptions(schema)
    expect(options.map((o) => o.token)).not.toContain('{note}')
    expect(options.map((o) => o.token)).toContain('{kind}')
  })

  it('validateConditionEdits rejects a rule referencing an explanation field, both rule-mode and formula-mode', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        { id: 'kind', type: 'text', label: '类型' },
      ],
    }
    const ruleModeEdits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{
          edgeKey: 'edge-yes', predicateMode: 'rules', conjunction: 'and',
          rules: [{ fieldId: 'note', operator: 'eq', value: 'x' }],
          formulaExpression: '',
        }],
        defaultEdgeKey: '',
      },
    }
    expect(validateConditionEdits(ruleModeEdits, schema)).toEqual(
      expect.arrayContaining([expect.stringMatching(/说明字段/)]),
    )

    const formulaModeEdits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{
          edgeKey: 'edge-yes', predicateMode: 'formula', conjunction: 'and',
          rules: [], formulaExpression: '{note} == "x"',
        }],
        defaultEdgeKey: '',
      },
    }
    expect(validateConditionEdits(formulaModeEdits, schema)).toEqual(
      expect.arrayContaining([expect.stringMatching(/说明字段/)]),
    )
  })

  it('positive control: a rule referencing a text field is NOT flagged by either predicate', () => {
    const schema: FormSchema = {
      fields: [{ id: 'kind', type: 'text', label: '类型' }],
    }
    const edits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{
          edgeKey: 'edge-yes', predicateMode: 'rules', conjunction: 'and',
          rules: [{ fieldId: 'kind', operator: 'eq', value: 'x' }],
          formulaExpression: '',
        }],
        defaultEdgeKey: '',
      },
    }
    expect(validateConditionEdits(edits, schema)).toEqual([])
  })
})
