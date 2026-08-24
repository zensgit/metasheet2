/**
 * B0 (owner-approved draft-save UX slice, 20260824) — the SAVE-BLOCKING validation minimum.
 *
 * Every check below is cross-referenced against `ApprovalProductService`'s actual create/update
 * reject-set (packages/core-backend/src/services/ApprovalProductService.ts — `assertFormSchema`,
 * `normalizeFormField`, `normalizeDetailFieldParts`, `normalizeApprovalGraph`), read directly for
 * this slice. See the doc comments on `validateTemplateFormFields` / `validateTemplateApprovalFlow`
 * / `validateDetailColumnsDraft` (the functions under test) for the exact line citations — this
 * file only pins the BEHAVIOR, not the citations.
 */
import { describe, expect, it } from 'vitest'
import {
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  seedDraftIdentityForSave,
  validateTemplateApprovalFlow,
  validateTemplateFormFields,
  validateTemplateSaveMinimum,
  type RecordLinkCatalogValidationContext,
} from '../src/approvals/templateAuthoring'
import { createEmptyDetailColumnDraft, validateDetailColumnsDraft } from '../src/approvals/detailField'
import type { TemplateAuthoringDraft } from '../src/approvals/templateAuthoring'

function validDraft(): TemplateAuthoringDraft {
  const draft = createEmptyTemplateDraft()
  draft.key = 'purchase_request'
  draft.name = '采购申请'
  draft.fields[0].id = 'reason'
  draft.fields[0].label = '申请原因'
  draft.fields[0].type = 'text'
  draft.steps[0].name = '审批人'
  draft.steps[0].sourceKind = 'static_user'
  draft.steps[0].idsText = 'u_1'
  return draft
}

describe('B0: validateTemplateFormFields({ minimal: true }) — the server-verified save-blocking subset', () => {
  it('positive control: a fully valid draft yields zero errors in BOTH modes', () => {
    const draft = validDraft()
    expect(validateTemplateFormFields(draft, null, null)).toEqual([])
    expect(validateTemplateFormFields(draft, null, null, { minimal: true })).toEqual([])
  })

  it('an option-less top-level select field is NOT save-blocking (backend accepts `options: []`) but IS a full-validation gap', () => {
    const draft = validDraft()
    draft.fields[0].type = 'select'
    draft.fields[0].optionsText = ''
    const full = validateTemplateFormFields(draft, null, null)
    const minimal = validateTemplateFormFields(draft, null, null, { minimal: true })
    expect(full.some((e) => e.includes('需要至少一个选项'))).toBe(true)
    expect(minimal.some((e) => e.includes('需要至少一个选项'))).toBe(false)
    expect(minimal).toEqual([])
  })

  it('a select field with a malformed (empty label/value) option IS save-blocking in BOTH modes (the backend rejects a malformed non-empty options array)', () => {
    const draft = validDraft()
    draft.fields[0].type = 'select'
    draft.fields[0].optionsText = 'A:'
    const full = validateTemplateFormFields(draft, null, null)
    const minimal = validateTemplateFormFields(draft, null, null, { minimal: true })
    expect(full.some((e) => e.includes('选项名称和值不能为空'))).toBe(true)
    expect(minimal.some((e) => e.includes('选项名称和值不能为空'))).toBe(true)
  })

  it('a record-link field with blank baseId/sheetId IS save-blocking in BOTH modes (backend `normalizeFormField` requires non-blank props.baseId/sheetId)', () => {
    const draft = validDraft()
    draft.fields[0].type = 'record-link'
    draft.fields[0].recordLinkBaseId = ''
    draft.fields[0].recordLinkSheetId = ''
    const full = validateTemplateFormFields(draft, null, null)
    const minimal = validateTemplateFormFields(draft, null, null, { minimal: true })
    expect(full.some((e) => e.includes('需要选择目标空间与目标表'))).toBe(true)
    expect(minimal.some((e) => e.includes('需要选择目标空间与目标表'))).toBe(true)
  })

  it('a record-link catalog/pin mismatch is NOT save-blocking (publish-only server-side: `assertRecordLinkTargetsReadableByCreator` runs only inside `publishTemplate`) — minimal mode never even receives a loaded catalog', () => {
    const draft = validDraft()
    draft.fields[0].type = 'record-link'
    draft.fields[0].recordLinkBaseId = 'base_x'
    draft.fields[0].recordLinkSheetId = 'sheet_x'
    const mismatchedCatalog: RecordLinkCatalogValidationContext = {
      loaded: true,
      sheets: [{ id: 'sheet_y', baseId: 'base_other' }],
    }
    const full = validateTemplateFormFields(draft, null, mismatchedCatalog)
    expect(full.length).toBeGreaterThan(0)
    // Minimal mode: caller passes no catalog (or `null`) — `validateTemplateSaveMinimum` never
    // forwards one — so the mismatch branch (gated on `recordLinkCatalog?.loaded`) never runs.
    const minimal = validateTemplateFormFields(draft, null, null, { minimal: true })
    expect(minimal).toEqual([])
  })

  it('field id/label requirements and the visibility-rule reject-set stay save-blocking in BOTH modes (unaffected by `minimal`)', () => {
    const draft = validDraft()
    draft.fields[0].label = ''
    const full = validateTemplateFormFields(draft, null, null)
    const minimal = validateTemplateFormFields(draft, null, null, { minimal: true })
    expect(full.some((e) => e.includes('名称必填'))).toBe(true)
    expect(minimal.some((e) => e.includes('名称必填'))).toBe(true)
  })
})

describe('B0: validateDetailColumnsDraft({ minimal: true })', () => {
  it('positive control: a valid detail column set yields zero errors in BOTH modes', () => {
    const col = createEmptyDetailColumnDraft(1)
    col.id = 'note'
    col.label = '备注'
    expect(validateDetailColumnsDraft('明细', [col], '', '')).toEqual([])
    expect(validateDetailColumnsDraft('明细', [col], '', '', { minimal: true })).toEqual([])
  })

  it('a detail group with ZERO sub-fields IS save-blocking in BOTH modes (backend `normalizeDetailFieldParts` rejects an empty `columns` array — this is NOT the same rule as "select needs options")', () => {
    const full = validateDetailColumnsDraft('明细', [], '', '')
    const minimal = validateDetailColumnsDraft('明细', [], '', '', { minimal: true })
    expect(full.some((e) => e.includes('至少需要一个子字段'))).toBe(true)
    expect(minimal.some((e) => e.includes('至少需要一个子字段'))).toBe(true)
  })

  it('an option-less select SUB-COLUMN is NOT save-blocking (same backend gap as the top-level case) but IS a full-validation gap', () => {
    const col = createEmptyDetailColumnDraft(1)
    col.id = 'kind'
    col.label = '类型'
    col.type = 'select'
    col.optionsText = ''
    const full = validateDetailColumnsDraft('明细', [col], '', '')
    const minimal = validateDetailColumnsDraft('明细', [col], '', '', { minimal: true })
    expect(full.some((e) => e.includes('需要至少一个选项'))).toBe(true)
    expect(minimal.some((e) => e.includes('需要至少一个选项'))).toBe(false)
    expect(minimal).toEqual([])
  })

  it('a malformed (non-empty but empty label/value) sub-column options list IS save-blocking in BOTH modes', () => {
    const col = createEmptyDetailColumnDraft(1)
    col.id = 'kind'
    col.label = '类型'
    col.type = 'select'
    col.optionsText = 'A:'
    const full = validateDetailColumnsDraft('明细', [col], '', '')
    const minimal = validateDetailColumnsDraft('明细', [col], '', '', { minimal: true })
    expect(full.some((e) => e.includes('选项 label/value 不能为空'))).toBe(true)
    expect(minimal.some((e) => e.includes('选项 label/value 不能为空'))).toBe(true)
  })

  it('sub-column id/label/leaf-type/minRows-maxRows requirements stay save-blocking in BOTH modes', () => {
    const col = createEmptyDetailColumnDraft(1)
    col.id = ''
    const full = validateDetailColumnsDraft('明细', [col], '5', '1')
    const minimal = validateDetailColumnsDraft('明细', [col], '5', '1', { minimal: true })
    expect(full.some((e) => e.includes('子字段 id 必填'))).toBe(true)
    expect(minimal.some((e) => e.includes('子字段 id 必填'))).toBe(true)
    expect(full.some((e) => e.includes('最小行数不能大于最大行数'))).toBe(true)
    expect(minimal.some((e) => e.includes('最小行数不能大于最大行数'))).toBe(true)
  })
})

describe('B0: validateTemplateApprovalFlow({ minimal: true })', () => {
  it('positive control: a valid linear flow yields zero errors in BOTH modes', () => {
    const draft = validDraft()
    expect(validateTemplateApprovalFlow(draft)).toEqual([])
    expect(validateTemplateApprovalFlow(draft, { minimal: true })).toEqual([])
  })

  it('a linear draft with ZERO steps is NOT save-blocking (backend `normalizeApprovalGraph` accepts empty `nodes`/`edges` arrays) but IS a full-validation gap', () => {
    const draft = validDraft()
    draft.steps = []
    const full = validateTemplateApprovalFlow(draft)
    const minimal = validateTemplateApprovalFlow(draft, { minimal: true })
    expect(full).toEqual(['至少需要一个审批步骤'])
    expect(minimal).toEqual([])
  })

  it('a step with an empty static_user id list IS save-blocking in BOTH modes (the built node would fail the backend\'s assignee-source check regardless of draft-save vs publish)', () => {
    const draft = validDraft()
    draft.steps[0].sourceKind = 'static_user'
    draft.steps[0].idsText = ''
    const full = validateTemplateApprovalFlow(draft)
    const minimal = validateTemplateApprovalFlow(draft, { minimal: true })
    expect(full.some((e) => e.includes('需要填写用户/角色 id'))).toBe(true)
    expect(minimal.some((e) => e.includes('需要填写用户/角色 id'))).toBe(true)
  })

  it('a threshold-mode step with an invalid threshold IS save-blocking in BOTH modes', () => {
    const draft = validDraft()
    draft.steps[0].approvalMode = 'threshold'
    draft.steps[0].approvalThreshold = 0
    const full = validateTemplateApprovalFlow(draft)
    const minimal = validateTemplateApprovalFlow(draft, { minimal: true })
    expect(full.some((e) => e.includes('门槛会签人数必须是不小于 1 的整数'))).toBe(true)
    expect(minimal.some((e) => e.includes('门槛会签人数必须是不小于 1 的整数'))).toBe(true)
  })
})

describe('B0: validateTemplateSaveMinimum — composition matches direct calls', () => {
  it('equals the concatenation of both validators in minimal mode, for a mix of blocking and non-blocking gaps', () => {
    const draft = validDraft()
    draft.fields[0].type = 'select'
    draft.fields[0].optionsText = '' // non-blocking gap only
    const blockingStep = createEmptyStepDraft(2)
    blockingStep.sourceKind = 'static_user'
    blockingStep.idsText = '' // blocking
    draft.steps.push(blockingStep)
    const combined = validateTemplateSaveMinimum(draft, null)
    const expected = [
      ...validateTemplateFormFields(draft, null, null, { minimal: true }),
      ...validateTemplateApprovalFlow(draft, { minimal: true }),
    ]
    expect(combined).toEqual(expected)
    // Blank select options never leaks into the minimum, empty-steps floor never fires (there ARE
    // steps), but the pushed step's blank id list still blocks.
    expect(combined.some((e) => e.includes('需要至少一个选项'))).toBe(false)
    expect(combined.some((e) => e.includes('需要填写用户/角色 id'))).toBe(true)
  })

  it('still requires key/name when NOT pre-seeded (composition does not auto-seed by itself — that is `seedDraftIdentityForSave`\'s job, called separately by the view before this)', () => {
    const draft = createEmptyTemplateDraft()
    const errors = validateTemplateSaveMinimum(draft, null)
    expect(errors).toContain('模板 Key 必填')
    expect(errors).toContain('模板名称必填')
  })
})

describe('B0: seedDraftIdentityForSave', () => {
  it('is a no-op (same object reference back) when key and name are already non-blank', () => {
    const draft = validDraft()
    expect(seedDraftIdentityForSave(draft)).toBe(draft)
  })

  it('seeds a placeholder name ("未命名审批") when name is blank, leaving a real key untouched', () => {
    const draft = validDraft()
    draft.name = '  '
    const seeded = seedDraftIdentityForSave(draft)
    expect(seeded).not.toBe(draft)
    expect(seeded.key).toBe('purchase_request')
    expect(seeded.name).toBe('未命名审批')
  })

  it('seeds a non-blank, non-colliding-by-construction key when key is blank, leaving a real name untouched', () => {
    const draft = validDraft()
    draft.key = ''
    const seeded = seedDraftIdentityForSave(draft)
    expect(seeded).not.toBe(draft)
    expect(seeded.key.trim().length).toBeGreaterThan(0)
    expect(seeded.name).toBe('采购申请')
  })

  it('two seeds in the same tick never collide (in-session monotonic counter)', () => {
    const a = seedDraftIdentityForSave(createEmptyTemplateDraft())
    const b = seedDraftIdentityForSave(createEmptyTemplateDraft())
    expect(a.key).not.toBe(b.key)
  })

  it('composes with validateTemplateSaveMinimum: seeding first removes the key/name errors', () => {
    const draft = createEmptyTemplateDraft()
    const seeded = seedDraftIdentityForSave(draft)
    const errors = validateTemplateSaveMinimum(seeded, null)
    expect(errors).not.toContain('模板 Key 必填')
    expect(errors).not.toContain('模板名称必填')
  })
})
