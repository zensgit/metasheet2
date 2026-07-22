/**
 * FWB-0 Layer 2 — record-link form field contract (frontend/type/command goldens).
 *
 * Mirrors backend shape: top-level only, pinned baseId/sheetId, value exactly
 * `{ recordId: non-blank string }`. Ordinary UI never surfaces raw IDs; security
 * remains server-side.
 */
import { describe, expect, it } from 'vitest'
import {
  RECORD_LINK_SELECTED_GENERIC,
  RECORD_LINK_TARGET_UNAVAILABLE,
  buildRecordLinkBaseSelectOptions,
  buildRecordLinkSheetSelectOptions,
  formatRecordLinkDisplay,
  hasPinnedRecordLinkTarget,
  isRecordLinkField,
  isValidRecordLinkValue,
  parseRecordLinkValue,
  recordLinkBaseId,
  recordLinkSheetId,
  resolvePinnedTargetLabel,
  validateRecordLinkPinAgainstLoadedCatalog,
  RECORD_LINK_TARGET_UNAVAILABLE,
} from '../src/approvals/recordLinkField'
import {
  AUTHORABLE_FIELD_TYPES,
  buildFormSchema,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  validateTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import { DETAIL_LEAF_FIELD_TYPES, buildDisplayFields } from '../src/approvals/detailField'
import { prefillFromSnapshot } from '../src/approvals/prefillFromSnapshot'
import type { FormFieldType } from '../src/types/approval'

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'rl',
    name: 'record-link',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

function recordLinkDraft(overrides: Partial<FieldAuthoringDraft> = {}): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(1),
    id: 'linked',
    type: 'record-link' as FormFieldType,
    label: '关联记录',
    recordLinkBaseId: 'base_a',
    recordLinkSheetId: 'sheet_a',
    ...overrides,
  }
}

describe('record-link — FormFieldType / authoring parity', () => {
  it('is authorable at top level and excluded from detail leaves', () => {
    expect(AUTHORABLE_FIELD_TYPES).toContain('record-link')
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('record-link')
    expect(isRecordLinkField({ type: 'record-link' })).toBe(true)
    expect(isRecordLinkField({ type: 'detail' })).toBe(false)
  })

  it('TemplateAuthoringView: catalog failure is retriable (not sticky loaded=true)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(__dirname, '../src/views/approval/TemplateAuthoringView.vue'),
      'utf8',
    )
    // Catch path must leave loaded=false and surface values-free error + retry.
    expect(src).toMatch(/recordLinkCatalogLoaded\.value\s*=\s*false/)
    expect(src).toContain('关联表目录加载失败，请重试')
    expect(src).toContain('approval-record-link-catalog-retry')
    expect(src).toContain('retryRecordLinkCatalog')
    // Must not permanently mark loaded on catch (the sticky-failure bug).
    const catchBlock = src.slice(src.indexOf('} catch {'), src.indexOf('} finally {', src.indexOf('} catch {')))
    expect(catchBlock).not.toMatch(/recordLinkCatalogLoaded\.value\s*=\s*true/)
  })

  it('buildFormSchema pins only baseId/sheetId and drops them when type changes away', () => {
    const schema = buildFormSchema(draftWith([recordLinkDraft()]))
    expect(schema.fields[0]).toMatchObject({
      type: 'record-link',
      props: { baseId: 'base_a', sheetId: 'sheet_a' },
    })
    expect(Object.keys(schema.fields[0].props as object).sort()).toEqual(['baseId', 'sheetId'])

    const asText = buildFormSchema(draftWith([recordLinkDraft({
      type: 'text',
      original: {
        id: 'linked',
        type: 'record-link',
        label: '关联记录',
        props: { baseId: 'base_a', sheetId: 'sheet_a', minLength: 1 },
      },
    })]))
    expect(asText.fields[0].type).toBe('text')
    expect(asText.fields[0].props).toEqual({ minLength: 1 })
  })

  it('buildFormSchema does not preserve stale unrelated props when retyped to record-link', () => {
    // Retype text → record-link: original.props may carry minLength / displayField / etc.
    // OpenAPI RecordLinkFieldProps is closed — emit exactly { baseId, sheetId }.
    const schema = buildFormSchema(draftWith([{
      ...createEmptyFieldDraft(1),
      id: 'linked',
      type: 'record-link' as FormFieldType,
      label: '关联记录',
      recordLinkBaseId: 'base_new',
      recordLinkSheetId: 'sheet_new',
      original: {
        id: 'linked',
        type: 'text',
        label: '旧文本',
        props: {
          minLength: 3,
          displayField: 'name',
          foreignSheetId: 'stale-sheet',
          baseId: 'stale-base',
          sheetId: 'stale-sheet',
        },
      },
    }]))
    expect(schema.fields[0].type).toBe('record-link')
    expect(schema.fields[0].props).toEqual({ baseId: 'base_new', sheetId: 'sheet_new' })
    expect(JSON.stringify(schema.fields[0].props)).not.toContain('minLength')
    expect(JSON.stringify(schema.fields[0].props)).not.toContain('displayField')
    expect(JSON.stringify(schema.fields[0].props)).not.toContain('foreignSheetId')
    expect(JSON.stringify(schema.fields[0].props)).not.toContain('stale')
  })

  it('validateTemplateDraft requires a chosen target space + sheet (no raw id field names in copy)', () => {
    const missing = validateTemplateDraft(draftWith([recordLinkDraft({
      recordLinkBaseId: '',
      recordLinkSheetId: '',
    })]))
    expect(missing.some((e) => e.includes('关联记录') && e.includes('目标'))).toBe(true)
    expect(missing.some((e) => /baseId|sheetId/i.test(e))).toBe(false)

    const ok = validateTemplateDraft(draftWith([recordLinkDraft()]))
    expect(ok.filter((e) => e.includes('关联记录'))).toEqual([])
  })

  it('loaded catalog: absent or base-mismatched pin blocks save with values-free target-unavailable error', () => {
    const field = recordLinkDraft({
      label: '关联客户',
      recordLinkBaseId: 'base_saved',
      recordLinkSheetId: 'sheet_saved',
    })
    // Catalog proves sheet is missing entirely.
    const absent = validateTemplateDraft(draftWith([field]), null, {
      loaded: true,
      sheets: [{ id: 'other_sheet', baseId: 'base_saved' }],
    })
    expect(absent.some((e) => e.includes('目标不可用') && e.includes('关联客户'))).toBe(true)
    expect(absent.join(' ')).not.toMatch(/base_saved|sheet_saved/)

    // Catalog proves sheet belongs to another base.
    const mismatch = validateTemplateDraft(draftWith([field]), null, {
      loaded: true,
      sheets: [{ id: 'sheet_saved', baseId: 'base_other' }],
    })
    expect(mismatch.some((e) => e.includes('目标不可用'))).toBe(true)
    expect(mismatch.join(' ')).not.toMatch(/base_saved|sheet_saved|base_other/)

    // Positive: sheet present under the pinned base.
    const ok = validateTemplateDraft(draftWith([field]), null, {
      loaded: true,
      sheets: [{ id: 'sheet_saved', baseId: 'base_saved', name: '客户表' } as { id: string; baseId: string }],
    })
    expect(ok.filter((e) => e.includes('目标不可用'))).toEqual([])

    // Catalog not loaded yet — do not block (server remains authority).
    const pending = validateTemplateDraft(draftWith([field]), null, {
      loaded: false,
      sheets: [],
    })
    expect(pending.filter((e) => e.includes('目标不可用'))).toEqual([])

    // Pure helper parity.
    expect(validateRecordLinkPinAgainstLoadedCatalog(field, {
      loaded: true,
      sheets: [{ id: 'sheet_saved', baseId: 'base_other' }],
    })).toMatch(/目标不可用/)
    expect(RECORD_LINK_TARGET_UNAVAILABLE).toBe('目标不可用')

    // Blank / whitespace label: generic human copy only — never the internal field id.
    const blankLabelField = recordLinkDraft({
      id: 'fld_internal_secret_xyz',
      label: '   ',
      recordLinkBaseId: 'base_saved',
      recordLinkSheetId: 'sheet_saved',
    })
    const blankLabelErr = validateRecordLinkPinAgainstLoadedCatalog(blankLabelField, {
      loaded: true,
      sheets: [{ id: 'sheet_saved', baseId: 'base_other' }],
    })
    expect(blankLabelErr).toMatch(/目标不可用/)
    expect(blankLabelErr).toMatch(/该字段|关联记录/)
    expect(blankLabelErr).not.toContain('fld_internal_secret_xyz')
    expect(blankLabelErr).not.toMatch(/fld_/)
  })
})

describe('record-link — value shape (exactly one { recordId })', () => {
  it('accepts a single non-blank recordId object', () => {
    expect(parseRecordLinkValue({ recordId: 'rec_1' })).toEqual({ ok: true, recordId: 'rec_1' })
    expect(parseRecordLinkValue({ recordId: '  rec_2  ' })).toEqual({ ok: true, recordId: 'rec_2' })
    expect(isValidRecordLinkValue({ recordId: 'x' })).toBe(true)
  })

  it('rejects arrays, free-text, empty id, and extra target overrides', () => {
    expect(isValidRecordLinkValue('rec_1')).toBe(false)
    expect(isValidRecordLinkValue(['rec_1'])).toBe(false)
    expect(isValidRecordLinkValue({ recordId: '' })).toBe(false)
    expect(isValidRecordLinkValue({ recordId: '   ' })).toBe(false)
    expect(isValidRecordLinkValue({ recordId: 'a', sheetId: 'override' })).toBe(false)
    expect(isValidRecordLinkValue({ recordIds: ['a'] })).toBe(false)
    expect(isValidRecordLinkValue({})).toBe(false)
    expect(isValidRecordLinkValue(null)).toBe(false)
  })

  it('hasPinnedRecordLinkTarget and sheet/base helpers read trimmed props', () => {
    expect(hasPinnedRecordLinkTarget({ baseId: ' b ', sheetId: ' s ' })).toBe(true)
    expect(hasPinnedRecordLinkTarget({ baseId: '', sheetId: 's' })).toBe(false)
    expect(recordLinkBaseId({ props: { baseId: '  b1  ' } })).toBe('b1')
    expect(recordLinkSheetId({ props: { sheetId: '  s1  ' } })).toBe('s1')
  })
})

describe('record-link — display never echoes raw ids', () => {
  it('formatRecordLinkDisplay uses human label or generic selected-record (never raw id)', () => {
    expect(formatRecordLinkDisplay('客户 A')).toBe('客户 A')
    expect(formatRecordLinkDisplay('  ')).toBe(RECORD_LINK_SELECTED_GENERIC)
    expect(formatRecordLinkDisplay(null)).toBe(RECORD_LINK_SELECTED_GENERIC)
    expect(formatRecordLinkDisplay(undefined)).toBe(RECORD_LINK_SELECTED_GENERIC)
    // The helper does not accept a raw id fallback path — callers must not pass one.
  })

  it('detail snapshot formatting uses the generic label, never the recordId', () => {
    const fields = buildDisplayFields(
      {
        fields: [{ id: 'linked', type: 'record-link', label: '关联记录' }],
      },
      { linked: { recordId: 'rec_secret_id' } },
    )
    expect(fields).toEqual([{
      key: 'linked',
      label: '关联记录',
      value: RECORD_LINK_SELECTED_GENERIC,
    }])
    expect(JSON.stringify(fields)).not.toContain('rec_secret_id')
  })

  it('pinned target options never label with raw ids; unavailable pins are values-free', () => {
    const bases = buildRecordLinkBaseSelectOptions(
      [{ id: 'b1', name: '销售空间' }],
      'b_missing',
    )
    expect(bases).toEqual([
      { value: 'b_missing', label: RECORD_LINK_TARGET_UNAVAILABLE },
      { value: 'b1', label: '销售空间' },
    ])
    expect(bases.every((o) => o.label !== o.value || o.value === '')).toBe(true)
    expect(resolvePinnedTargetLabel([{ id: 'b1', name: '销售空间' }], 'b_missing'))
      .toBe(RECORD_LINK_TARGET_UNAVAILABLE)
    expect(resolvePinnedTargetLabel([{ id: 'b1', name: '销售空间' }], 'b1')).toBe('销售空间')

    const sheets = buildRecordLinkSheetSelectOptions(
      [
        { id: 's1', name: '订单表', baseId: 'b1' },
        { id: 's2', name: '其他表', baseId: 'b2' },
      ],
      'b1',
      's_gone',
    )
    expect(sheets).toEqual([
      { value: 's_gone', label: RECORD_LINK_TARGET_UNAVAILABLE },
      { value: 's1', label: '订单表' },
    ])
    expect(JSON.stringify(sheets)).not.toMatch(/s_gone.*s_gone/)
  })
})

describe('record-link — authoring visibility/conditions fail-closed (P1-2)', () => {
  it('rejects visibility rules that depend on a record-link field', () => {
    const draft = draftWith([
      recordLinkDraft({
        id: 'linked',
        recordLinkBaseId: 'b1',
        recordLinkSheetId: 's1',
      }),
      {
        ...createEmptyFieldDraft(2),
        id: 'note',
        label: '备注',
        type: 'text' as FormFieldType,
        visibility: {
          dependsOnFieldId: 'linked',
          operator: 'notEmpty',
          valueText: '',
        },
      },
    ])
    const errors = validateTemplateDraft(draft)
    expect(errors.some((e) => /关联记录|record-link|显隐/.test(e))).toBe(true)
  })

  it('selectors exclude record-link; retype invalidates stale deps', async () => {
    const {
      isSelectableConditionOrVisibilityDependencyType,
      clearStaleRecordLinkDependencies,
    } = await import('../src/approvals/recordLinkField')
    expect(isSelectableConditionOrVisibilityDependencyType('record-link')).toBe(false)
    expect(isSelectableConditionOrVisibilityDependencyType('detail')).toBe(false)
    expect(isSelectableConditionOrVisibilityDependencyType('text')).toBe(true)

    const fields = [
      {
        id: 'linked',
        type: 'record-link',
        visibility: { dependsOnFieldId: '', operator: 'eq', valueText: '' },
      },
      {
        id: 'note',
        type: 'text',
        visibility: { dependsOnFieldId: 'linked', operator: 'notEmpty', valueText: '' },
      },
    ]
    const rules = [{ fieldId: 'linked' }, { fieldId: 'note' }]
    const cleared = clearStaleRecordLinkDependencies(fields, rules, 'linked', 'record-link')
    expect(cleared.fields[1].visibility.dependsOnFieldId).toBe('')
    expect(cleared.conditionRules[0].fieldId).toBe('')
    expect(cleared.conditionRules[1].fieldId).toBe('note')
  })
})

describe('record-link — prefillFromSnapshot fail-closed (no pin metadata)', () => {
  it('never prefills record-link from a prior snapshot (even shape-valid { recordId })', () => {
    const schema = {
      fields: [
        {
          id: 'linked',
          type: 'record-link' as FormFieldType,
          label: '关联',
          props: { baseId: 'b1', sheetId: 's1' },
        },
        { id: 'title', type: 'text' as FormFieldType, label: '标题' },
      ],
    }
    // Snapshots only freeze { recordId }; without proven pin identity, omit always.
    expect(prefillFromSnapshot(schema, {
      linked: { recordId: 'rec_keep' },
      title: 'hello',
    })).toEqual({ title: 'hello' })

    expect(prefillFromSnapshot(schema, {
      linked: 'rec_free_text',
      title: 'x',
    })).toEqual({ title: 'x' })

    expect(prefillFromSnapshot(schema, {
      linked: { recordId: 'a', sheetId: 'nope' },
    })).toEqual({})
  })
})
