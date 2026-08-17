/**
 * F3 typed property update / retype command surface (delta §5 F3, FB-D5/FB-D6,
 * master M3 as amended): reference-aware NAMED retype refusal for every
 * dependency kind (the 9 existing + the 3 new F3 kinds), identity preservation
 * across retype (never re-minted), detail-column retype/update/remove
 * semantics, and the adapter's one-history-entry-per-logical-edit contract
 * (FB-D7) with zero mutation on rejection.
 */
import { describe, expect, it } from 'vitest'

import {
  collectFormDetailColumnDependencies,
  collectFormFieldRetypeDependencies,
  removeFormDetailColumn,
  retypeFormDetailColumn,
  retypeFormField,
  updateFormDetailColumn,
  updateFormFieldProperties,
  type CompleteFormReferenceInventory,
  type FormCommandResult,
  type FormDependencyKind,
} from '../src/approvals/approvalFormCommands'
import {
  createFormAuthoringAdapter,
  type FormAdapterResult,
} from '../src/approvals/approvalFormAuthoringAdapter'
import {
  OPAQUE_IDENTITY_TOKEN_BYTES,
  createOpaqueFormIdentityAllocator,
  type IdentityRandomSource,
} from '../src/approvals/approvalFormIdentity'
import {
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import type { DetailColumnDraft } from '../src/approvals/detailField'

// --- fixtures ---------------------------------------------------------------

function field(
  index: number,
  overrides: Partial<FieldAuthoringDraft> = {},
): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    label: `字段 ${index}`,
    ...overrides,
  }
}

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'form_field_update',
    name: '字段更新命令',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

function column(
  index: number,
  overrides: Partial<DetailColumnDraft> = {},
): DetailColumnDraft {
  return {
    localId: `col_local_${index}`,
    id: `col_${index}`,
    type: 'text',
    label: `子字段 ${index}`,
    required: false,
    optionsText: '',
    ...overrides,
  }
}

/** A PRISTINE fresh detail field (retype-away is allowed: no real config). */
function pristineDetailField(index: number): FieldAuthoringDraft {
  return field(index, {
    type: 'detail',
    detailColumns: [column(9, { label: '子字段 1' })],
  })
}

function assertOk(
  result: FormCommandResult,
): asserts result is Extract<FormCommandResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
}

function assertAdapterOk(
  result: FormAdapterResult,
): asserts result is Extract<FormAdapterResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
}

function dependencyKinds(result: FormCommandResult): FormDependencyKind[] {
  if (result.ok) throw new Error('expected a rejection')
  return result.dependencies.map((entry) => entry.kind)
}

/** Seam that replays scripted 8-byte blocks in order (then wraps). */
function scriptedSource(blocks: number[][]): IdentityRandomSource {
  let cursor = 0
  return {
    nextBytes(length: number): Uint8Array {
      expect(length).toBe(OPAQUE_IDENTITY_TOKEN_BYTES)
      const block = blocks[cursor % blocks.length]!
      cursor += 1
      return Uint8Array.from(block)
    },
  }
}

const BLOCK_A = [0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a]
const BLOCK_B = [0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b]
const BLOCK_C = [0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c]
const BLOCK_D = [0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d]
const HEX_A = '0a'.repeat(8)

// --- retype: identity preservation (FB-D5) ----------------------------------

describe('retypeFormField - identity preservation (FB-D5)', () => {
  it('IDENTITY PIN: retype preserves id and localId byte-identical and never re-mints', () => {
    const source = draftWith([field(1), field(2)])
    const result = retypeFormField(source, 'local_1', 'date')
    assertOk(result)
    const retyped = result.draft.fields[0]
    expect(retyped.id).toBe('field_1')
    expect(retyped.localId).toBe('local_1')
    expect(retyped.type).toBe('date')
    // Non-identity properties survive the retype.
    expect(retyped.label).toBe('字段 1')
    expect(retyped.required).toBe(false)
    expect(result.focusLocalId).toBe('local_1')
    // Zero mutation of the source draft.
    expect(source.fields[0].type).toBe('text')
  })

  it('ADAPTER IDENTITY PIN: adapter retype (incl. to detail) keeps the FIELD identity — the allocator mints only the first column', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const toSelect = adapter.retypeField(session, 'local_1', 'select')
    assertAdapterOk(toSelect)
    expect(toSelect.session.draft.fields[0].id).toBe('field_1')
    expect(toSelect.session.draft.fields[0].localId).toBe('local_1')

    const toDetail = adapter.retypeField(toSelect.session, 'local_2', 'detail')
    assertAdapterOk(toDetail)
    const detail = toDetail.session.draft.fields[1]
    expect(detail.id).toBe('field_2')
    expect(detail.localId).toBe('local_2')
    expect(detail.type).toBe('detail')
    // The FIRST COLUMN identity comes from the opaque allocator.
    expect(detail.detailColumns).toHaveLength(1)
    expect(detail.detailColumns[0].id).toMatch(/^dcol_[0-9a-f]{16}$/)
    expect(detail.detailColumns[0].localId).toMatch(/^dcolloc_[0-9a-f]{16}$/)
  })

  it('value-identical retype (same type) succeeds with an unchanged field list (zero-entry no-op)', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const result = adapter.retypeField(session, 'local_1', 'text')
    assertAdapterOk(result)
    expect(result.changed).toBe(false)
    expect(result.session.history.undoStack).toHaveLength(0)
  })

  it('fails closed on unknown fields and unknown target types', () => {
    expect(retypeFormField(draftWith([field(1)]), 'missing', 'date')).toMatchObject(
      { ok: false, reason: 'field_not_found' },
    )
    expect(
      retypeFormField(draftWith([field(1)]), 'local_1', 'no_such_type' as never),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
  })
})

// --- retype: the 9 + 3 NAMED dependency refusals (FB-D6) --------------------

describe('retypeFormField - named incompatible-type refusal for EVERY dependency kind (FB-D6)', () => {
  function expectRefusal(
    draft: TemplateAuthoringDraft,
    kind: FormDependencyKind,
    nextType: Parameters<typeof retypeFormField>[2] = 'date',
    inventory?: CompleteFormReferenceInventory,
  ): void {
    const before = JSON.stringify(draft)
    const refused = retypeFormField(
      draft,
      'local_1',
      nextType,
      undefined,
      inventory,
    )
    expect(refused).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(refused)).toContain(kind)
    // Rejection = ZERO mutation.
    expect(JSON.stringify(draft)).toBe(before)
  }

  it('visibility_rule refuses, and retype succeeds once the rule is removed (positive control)', () => {
    const dependent = field(2, {
      visibility: { dependsOnFieldId: 'field_1', operator: 'eq', valueText: 'y' },
    })
    expectRefusal(draftWith([field(1), dependent]), 'visibility_rule')
    assertOk(retypeFormField(draftWith([field(1), field(2)]), 'local_1', 'date'))
  })

  it('step_assignee_source refuses, positive control after clearing the source', () => {
    const source = draftWith([field(1, { type: 'user' }), field(2)])
    source.steps[0] = {
      ...source.steps[0],
      sourceKind: 'form_field_user',
      fieldId: 'field_1',
    }
    expectRefusal(source, 'step_assignee_source')
    const cleared = draftWith([field(1, { type: 'user' }), field(2)])
    assertOk(retypeFormField(cleared, 'local_1', 'date'))
  })

  it('step_field_permission refuses, positive control after removing the permission', () => {
    const source = draftWith([field(1), field(2)])
    source.steps[0] = {
      ...source.steps[0],
      fieldPermissions: [{ fieldId: 'field_1', access: 'hidden' }],
    }
    expectRefusal(source, 'step_field_permission')
    assertOk(retypeFormField(draftWith([field(1), field(2)]), 'local_1', 'date'))
  })

  it('condition_rule refuses, positive control after removing the rule', () => {
    const source = draftWith([field(1), field(2)])
    source.conditionEdits = {
      condition_1: {
        nodeKey: 'condition_1',
        defaultEdgeKey: '',
        branches: [
          {
            edgeKey: 'e1',
            predicateMode: 'rules',
            conjunction: 'and',
            rules: [{ fieldId: 'field_1', operator: 'eq', value: 1 }],
            formulaExpression: '',
          },
        ],
      },
    }
    expectRefusal(source, 'condition_rule')
    assertOk(retypeFormField(draftWith([field(1), field(2)]), 'local_1', 'date'))
  })

  it('condition_formula refuses, positive control when the formula names another field', () => {
    function withFormula(expression: string): TemplateAuthoringDraft {
      const source = draftWith([field(1), field(2)])
      source.conditionEdits = {
        condition_1: {
          nodeKey: 'condition_1',
          defaultEdgeKey: '',
          branches: [
            {
              edgeKey: 'e1',
              predicateMode: 'formula',
              conjunction: 'and',
              rules: [],
              formulaExpression: expression,
            },
          ],
        },
      }
      return source
    }
    expectRefusal(withFormula('{field_1} > 0'), 'condition_formula')
    assertOk(retypeFormField(withFormula('{field_2} > 0'), 'local_1', 'date'))
  })

  it('approval_node_assignee_source refuses, positive control after clearing it', () => {
    const source = draftWith([field(1, { type: 'user' }), field(2)])
    source.approvalNodeEdits = {
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [{ kind: 'form_field_user', fieldId: 'field_1' }],
      },
    }
    expectRefusal(source, 'approval_node_assignee_source')
    assertOk(
      retypeFormField(
        draftWith([field(1, { type: 'user' }), field(2)]),
        'local_1',
        'date',
      ),
    )
  })

  it('preserved_graph_reference refuses, positive control when the graph names another field', () => {
    function withGraphRef(fieldId: string): TemplateAuthoringDraft {
      const source = draftWith([field(1), field(2)])
      source.preservedGraph = {
        nodes: [
          {
            key: 'condition_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e1', rules: [{ fieldId, operator: 'eq' }] }],
            },
          },
        ],
        edges: [],
      }
      return source
    }
    expectRefusal(withGraphRef('field_1'), 'preserved_graph_reference')
    assertOk(retypeFormField(withGraphRef('field_2'), 'local_1', 'date'))
  })

  it('amount_consistency_mapping refuses, positive control after removing the mapping', () => {
    const source = draftWith([field(1, { type: 'number' }), field(2)])
    source.amountConsistencyCheck = {
      totalFieldId: 'field_1',
      detailFieldId: 'items',
      amountColumnId: 'amount',
    }
    expectRefusal(source, 'amount_consistency_mapping')
    assertOk(
      retypeFormField(
        draftWith([field(1, { type: 'number' }), field(2)]),
        'local_1',
        'date',
      ),
    )
  })

  it('external_reference refuses through the SAME optional future-owner seam, positive control without it', () => {
    const inventory: CompleteFormReferenceInventory = {
      complete: true,
      references: [{ fieldId: 'field_1', location: 'future.external.0' }],
    }
    expectRefusal(draftWith([field(1), field(2)]), 'external_reference', 'date', inventory)
    // Production callers pass no inventory (FB-D6): same draft retypes fine.
    assertOk(retypeFormField(draftWith([field(1), field(2)]), 'local_1', 'date'))
  })

  it('detail_config (NEW kind): leaving detail with REAL configuration refuses; a pristine fresh detail field is the positive control', () => {
    // Two columns = real configuration that a retype away would destroy.
    const configured = field(1, {
      type: 'detail',
      detailColumns: [column(1, { label: '子字段 1' }), column(2)],
    })
    expectRefusal(draftWith([configured, field(2)]), 'detail_config', 'text')
    // A single edited column (options/required/type/label/original) also counts.
    const editedColumn = field(1, {
      type: 'detail',
      detailColumns: [column(1, { label: '品名', required: true })],
    })
    expectRefusal(draftWith([editedColumn, field(2)]), 'detail_config', 'text')
    // Row bounds count as configuration too.
    const rowBounds = field(1, {
      type: 'detail',
      detailColumns: [column(1, { label: '子字段 1' })],
      minRowsText: '1',
    })
    expectRefusal(draftWith([rowBounds, field(2)]), 'detail_config', 'text')
    // Positive control: the pristine fresh detail field retypes away cleanly,
    // identity preserved, detail keys cleared.
    const ok = retypeFormField(
      draftWith([pristineDetailField(1), field(2)]),
      'local_1',
      'text',
    )
    assertOk(ok)
    expect(ok.draft.fields[0]).toMatchObject({
      id: 'field_1',
      localId: 'local_1',
      type: 'text',
      detailColumns: [],
      minRowsText: '',
      maxRowsText: '',
    })
  })

  it('record_link_config (NEW kind): leaving a CONFIGURED record-link refuses; an unconfigured one is the positive control', () => {
    const configured = field(1, {
      type: 'record-link',
      recordLinkBaseId: 'base_x',
      recordLinkSheetId: 'sheet_y',
    })
    expectRefusal(draftWith([configured, field(2)]), 'record_link_config', 'text')
    const unconfigured = field(1, { type: 'record-link' })
    assertOk(
      retypeFormField(draftWith([unconfigured, field(2)]), 'local_1', 'text'),
    )
  })

  it('attachment_boundary (NEW kind): retype TO attachment is the named boundary refusal; a supported target is the positive control', () => {
    expectRefusal(
      draftWith([field(1), field(2)]),
      'attachment_boundary',
      'attachment' as never,
    )
    assertOk(retypeFormField(draftWith([field(1), field(2)]), 'local_1', 'date'))
  })

  it('a multiply-referenced field reports EVERY dependency kind in one named refusal', () => {
    const source = draftWith([
      field(1, { type: 'user' }),
      field(2, {
        visibility: { dependsOnFieldId: 'field_1', operator: 'eq', valueText: 'y' },
      }),
    ])
    source.steps[0] = {
      ...source.steps[0],
      sourceKind: 'form_field_user',
      fieldId: 'field_1',
      fieldPermissions: [{ fieldId: 'field_1', access: 'hidden' }],
    }
    const refused = retypeFormField(source, 'local_1', 'text')
    expect(refused).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(new Set(dependencyKinds(refused))).toEqual(
      new Set(['visibility_rule', 'step_assignee_source', 'step_field_permission']),
    )
  })

  it('collectFormFieldRetypeDependencies is empty for a same-type "retype" and for unknown fields', () => {
    const configured = draftWith([
      field(1, {
        type: 'record-link',
        recordLinkBaseId: 'b',
        recordLinkSheetId: 's',
      }),
    ])
    expect(
      collectFormFieldRetypeDependencies(configured, 'local_1', 'record-link'),
    ).toEqual([])
    expect(collectFormFieldRetypeDependencies(configured, 'missing', 'text')).toEqual([])
  })
})

// --- retype INTO detail: first-column identity (FB-D5) ----------------------

describe('retypeFormField - retype INTO detail mints only the first-column identity', () => {
  it('requires a usable column identity and validates it against the complete draft', () => {
    const source = draftWith([field(1), field(2)])
    expect(retypeFormField(source, 'local_1', 'detail')).toMatchObject({
      ok: false,
      reason: 'invalid_field_identity',
    })
    expect(
      retypeFormField(source, 'local_1', 'detail', {
        persistentId: ' ',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    expect(
      retypeFormField(source, 'local_1', 'detail', {
        persistentId: 'field_2', // collides with a live field id
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    const ok = retypeFormField(source, 'local_1', 'detail', {
      persistentId: 'dcol_new',
      localId: 'dcolloc_new',
    })
    assertOk(ok)
    expect(ok.draft.fields[0]).toMatchObject({
      id: 'field_1',
      localId: 'local_1',
      type: 'detail',
    })
    expect(ok.draft.fields[0].detailColumns).toEqual([
      expect.objectContaining({ id: 'dcol_new', localId: 'dcolloc_new', type: 'text' }),
    ])
  })

  it('the adapter retries a colliding column candidate with a FRESH one (one history entry)', () => {
    const adapter = createFormAuthoringAdapter({
      identityAllocator: createOpaqueFormIdentityAllocator(
        scriptedSource([BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D]),
      ),
    })
    // Attempt 1 mints dcol_A/dcolloc_B — dcol_A collides with the live field
    // id below — so attempt 2 must land on the FRESH dcol_C/dcolloc_D pair.
    const session = adapter.startSession(
      draftWith([field(1), field(2, { id: `dcol_${HEX_A}` })]),
    )
    const result = adapter.retypeField(session, 'local_1', 'detail')
    assertAdapterOk(result)
    expect(result.session.history.undoStack).toHaveLength(1)
    const detail = result.session.draft.fields[0]
    expect(detail.id).toBe('field_1')
    expect(detail.detailColumns[0].id).not.toBe(`dcol_${HEX_A}`)
  })
})

// --- typed property update ---------------------------------------------------

describe('updateFormFieldProperties - committed inspector edits (FB-D7)', () => {
  it('patches only the named properties and PRESERVES identity and type by construction', () => {
    const source = draftWith([field(1), field(2)])
    const result = updateFormFieldProperties(source, 'local_1', {
      label: '新名称',
      required: true,
      placeholder: '请输入',
      visibility: { dependsOnFieldId: 'field_2', operator: 'neq', valueText: 'x' },
    })
    assertOk(result)
    const updated = result.draft.fields[0]
    expect(updated).toMatchObject({
      id: 'field_1',
      localId: 'local_1',
      type: 'text',
      label: '新名称',
      required: true,
      placeholder: '请输入',
    })
    expect(updated.visibility).toEqual({
      dependsOnFieldId: 'field_2',
      operator: 'neq',
      valueText: 'x',
    })
    expect(result.focusLocalId).toBe('local_1')
    // Source untouched.
    expect(source.fields[0].label).toBe('字段 1')
  })

  it('rejects unknown fields with zero mutation', () => {
    const source = draftWith([field(1)])
    expect(
      updateFormFieldProperties(source, 'missing', { label: 'x' }),
    ).toMatchObject({ ok: false, reason: 'field_not_found' })
    expect(source.fields[0].label).toBe('字段 1')
  })
})

// --- detail column commands --------------------------------------------------

describe('detail column commands - update / retype / remove (F3, master M3 detail-column semantics)', () => {
  function detailDraft(
    columns: DetailColumnDraft[] = [column(1), column(2)],
  ): TemplateAuthoringDraft {
    return draftWith([
      field(1, { id: 'items', type: 'detail', detailColumns: columns }),
      field(2),
    ])
  }

  it('updateFormDetailColumn patches label/required/optionsText and preserves column identity', () => {
    const source = detailDraft()
    const result = updateFormDetailColumn(source, 'local_1', 'col_local_1', {
      label: '品名',
      required: true,
    })
    assertOk(result)
    expect(result.focusLocalId).toBe('local_1')
    expect(result.draft.fields[0].detailColumns[0]).toMatchObject({
      id: 'col_1',
      localId: 'col_local_1',
      type: 'text',
      label: '品名',
      required: true,
    })
    expect(source.fields[0].detailColumns[0].label).toBe('子字段 1')
  })

  it('locating failures are typed: missing owner / non-detail owner / missing column', () => {
    const source = detailDraft()
    expect(
      updateFormDetailColumn(source, 'missing', 'col_local_1', { label: 'x' }),
    ).toMatchObject({ ok: false, reason: 'field_not_found' })
    expect(
      updateFormDetailColumn(source, 'local_2', 'col_local_1', { label: 'x' }),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
    expect(
      updateFormDetailColumn(source, 'local_1', 'missing', { label: 'x' }),
    ).toMatchObject({ ok: false, reason: 'target_not_found' })
  })

  it('COLUMN IDENTITY PIN: retype to another LEAF type preserves the column id/localId', () => {
    const source = detailDraft()
    const result = retypeFormDetailColumn(source, 'local_1', 'col_local_2', 'number')
    assertOk(result)
    expect(result.draft.fields[0].detailColumns[1]).toMatchObject({
      id: 'col_2',
      localId: 'col_local_2',
      type: 'number',
    })
    expect(source.fields[0].detailColumns[1].type).toBe('text')
  })

  it('boundary targets are NAMED refusals: detail → detail_config, record-link → record_link_config, attachment → attachment_boundary', () => {
    const source = detailDraft()
    const nested = retypeFormDetailColumn(source, 'local_1', 'col_local_1', 'detail')
    expect(nested).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(nested)).toEqual(['detail_config'])
    const link = retypeFormDetailColumn(source, 'local_1', 'col_local_1', 'record-link')
    expect(link).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(link)).toEqual(['record_link_config'])
    const attachment = retypeFormDetailColumn(
      source,
      'local_1',
      'col_local_1',
      'attachment',
    )
    expect(attachment).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(attachment)).toEqual(['attachment_boundary'])
    // Same-type is a value-identical no-op success; unknown is fail-closed.
    assertOk(retypeFormDetailColumn(source, 'local_1', 'col_local_1', 'text'))
    expect(
      retypeFormDetailColumn(source, 'local_1', 'col_local_1', 'nope' as never),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
  })

  it('a column referenced by the amount mapping or a {owner.column} formula refuses retype AND remove; positive controls without the reference', () => {
    const source = detailDraft()
    source.amountConsistencyCheck = {
      totalFieldId: 'field_2',
      detailFieldId: 'items',
      amountColumnId: 'col_1',
    }
    source.conditionEdits = {
      condition_1: {
        nodeKey: 'condition_1',
        defaultEdgeKey: '',
        branches: [
          {
            edgeKey: 'e1',
            predicateMode: 'formula',
            conjunction: 'and',
            rules: [],
            formulaExpression: '{items.col_2} > 0',
          },
        ],
      },
    }
    const mapped = retypeFormDetailColumn(source, 'local_1', 'col_local_1', 'number')
    expect(mapped).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(mapped)).toContain('amount_consistency_mapping')
    const formulaRefused = retypeFormDetailColumn(
      source,
      'local_1',
      'col_local_2',
      'date',
    )
    expect(formulaRefused).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    expect(dependencyKinds(formulaRefused)).toContain('condition_formula')
    // Remove is refused with field_is_referenced for the same references.
    expect(removeFormDetailColumn(source, 'local_1', 'col_local_1')).toMatchObject({
      ok: false,
      reason: 'field_is_referenced',
    })
    // Positive controls: an unreferenced draft allows both.
    const free = detailDraft()
    assertOk(retypeFormDetailColumn(free, 'local_1', 'col_local_1', 'number'))
    assertOk(removeFormDetailColumn(free, 'local_1', 'col_local_1'))
  })

  it('collectFormDetailColumnDependencies also walks dotted rules and preserved/original payloads; blank ids collect nothing', () => {
    const source = detailDraft()
    source.conditionEdits = {
      condition_1: {
        nodeKey: 'condition_1',
        defaultEdgeKey: '',
        branches: [
          {
            edgeKey: 'e1',
            predicateMode: 'rules',
            conjunction: 'and',
            rules: [{ fieldId: 'items.col_1', operator: 'eq', value: 1 }],
            formulaExpression: '',
          },
        ],
      },
    }
    source.preservedGraph = {
      nodes: [
        {
          key: 'condition_2',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'e2', formula: { expression: '{items.col_1} > 0' } }],
          },
        },
      ],
      edges: [],
    }
    const kinds = collectFormDetailColumnDependencies(source, 'items', 'col_1').map(
      (entry) => entry.kind,
    )
    expect(kinds).toContain('condition_rule')
    expect(kinds).toContain('condition_formula')
    expect(collectFormDetailColumnDependencies(source, '', 'col_1')).toEqual([])
    expect(collectFormDetailColumnDependencies(source, 'items', ' ')).toEqual([])
    // The sibling column is untouched by these references.
    expect(collectFormDetailColumnDependencies(source, 'items', 'col_2')).toEqual([])
  })

  it('removing the LAST column is the named last_detail_column_removal_forbidden refusal with a positive control', () => {
    const solo = detailDraft([column(1)])
    expect(removeFormDetailColumn(solo, 'local_1', 'col_local_1')).toMatchObject({
      ok: false,
      reason: 'last_detail_column_removal_forbidden',
    })
    expect(solo.fields[0].detailColumns).toHaveLength(1)
    const pair = detailDraft()
    const removed = removeFormDetailColumn(pair, 'local_1', 'col_local_1')
    assertOk(removed)
    expect(removed.draft.fields[0].detailColumns.map((entry) => entry.id)).toEqual([
      'col_2',
    ])
    expect(removed.focusLocalId).toBe('local_1')
  })
})

// --- adapter: one history entry per logical edit (FB-D7) ---------------------

describe('approvalFormAuthoringAdapter - F3 one-entry-per-logical-edit history (FB-D7)', () => {
  function seeded() {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(
      draftWith([
        field(1),
        field(2, { id: 'items', type: 'detail', detailColumns: [column(1), column(2)] }),
      ]),
    )
    return { adapter, session }
  }

  it('a value-changing property edit is EXACTLY ONE history entry; a value-identical patch is ZERO', () => {
    const { adapter, session } = seeded()
    const changed = adapter.updateFieldProperties(session, 'local_1', {
      label: '新名称',
    })
    assertAdapterOk(changed)
    expect(changed.changed).toBe(true)
    expect(changed.session.history.undoStack).toHaveLength(1)
    const identical = adapter.updateFieldProperties(changed.session, 'local_1', {
      label: '新名称',
    })
    assertAdapterOk(identical)
    expect(identical.changed).toBe(false)
    expect(identical.session.history.undoStack).toHaveLength(1)
  })

  it('each logical option/detail-row action commits exactly ONE entry (retype, column update, column retype, column add/remove)', () => {
    const { adapter, session } = seeded()
    let current = session
    const steps: ((s: typeof session) => FormAdapterResult)[] = [
      (s) => adapter.retypeField(s, 'local_1', 'select'),
      (s) => adapter.updateFieldProperties(s, 'local_1', { optionsText: '甲:a\n乙:b' }),
      (s) => adapter.updateDetailColumn(s, 'local_2', 'col_local_1', { label: '品名' }),
      (s) => adapter.retypeDetailColumn(s, 'local_2', 'col_local_2', 'number'),
      (s) => adapter.addDetailColumn(s, 'local_2'),
      (s) => adapter.removeDetailColumn(s, 'local_2', 'col_local_1'),
    ]
    steps.forEach((run, index) => {
      const result = run(current)
      assertAdapterOk(result)
      expect(result.changed).toBe(true)
      expect(result.session.history.undoStack).toHaveLength(index + 1)
      current = result.session
    })
  })

  it('a rejected retype/update/remove leaves the session UNCHANGED (zero draft/history mutation)', () => {
    const { adapter, session } = seeded()
    // Referenced field → named refusal, session identity preserved.
    const withRef = adapter.updateFieldProperties(session, 'local_1', {
      visibility: { dependsOnFieldId: 'items', operator: 'eq', valueText: '' },
    })
    assertAdapterOk(withRef)
    const refused = adapter.retypeField(withRef.session, 'local_2', 'text')
    expect(refused).toMatchObject({
      ok: false,
      reason: 'field_type_incompatible_with_references',
    })
    if (!refused.ok) expect(refused.session).toBe(withRef.session)
    const missing = adapter.updateFieldProperties(withRef.session, 'missing', {
      label: 'x',
    })
    expect(missing).toMatchObject({ ok: false, reason: 'field_not_found' })
    if (!missing.ok) expect(missing.session).toBe(withRef.session)
    const lastColumn = adapter.removeDetailColumn(
      withRef.session,
      'local_2',
      'col_local_1',
    )
    // Two columns exist, so this SUCCEEDS — the refusal arm needs one column.
    assertAdapterOk(lastColumn)
    const soloColumn = adapter.removeDetailColumn(
      lastColumn.session,
      'local_2',
      'col_local_2',
    )
    expect(soloColumn).toMatchObject({
      ok: false,
      reason: 'last_detail_column_removal_forbidden',
    })
    if (!soloColumn.ok) expect(soloColumn.session).toBe(lastColumn.session)
  })

  it('undo/redo restore committed property values as ONE coherent snapshot (field list + focus)', () => {
    const { adapter, session } = seeded()
    const edited = adapter.updateFieldProperties(session, 'local_1', {
      label: '改后',
      required: true,
    })
    assertAdapterOk(edited)
    const undone = adapter.undo(edited.session)
    assertAdapterOk(undone)
    expect(undone.session.draft.fields[0]).toMatchObject({
      label: '字段 1',
      required: false,
    })
    const redone = adapter.redo(undone.session)
    assertAdapterOk(redone)
    expect(redone.session.draft.fields[0]).toMatchObject({
      label: '改后',
      required: true,
    })
    expect(redone.focusLocalId).toBe('local_1')
  })
})
