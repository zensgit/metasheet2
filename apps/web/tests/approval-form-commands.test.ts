import { describe, expect, it } from 'vitest'

import {
  addFormField,
  applyFormCommands,
  collectFormFieldDependencies,
  moveFormField,
  moveFormFieldByOffset,
  removeFormField,
  type CompleteFormReferenceInventory,
  type FormCommandResult,
  type FormFieldIdentity,
} from '../src/approvals/approvalFormCommands'
import {
  AUTHORABLE_FIELD_TYPES,
  buildApprovalGraph,
  buildFormSchema,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'

const EMPTY_INVENTORY: CompleteFormReferenceInventory = {
  complete: true,
  references: [],
}

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
    key: 'form_commands',
    name: '表单命令',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

function identity(index: number, detail = false): FormFieldIdentity {
  return {
    persistentId: `new_field_${index}`,
    localId: `new_local_${index}`,
    ...(detail
      ? {
          detailColumn: {
            persistentId: `new_column_${index}`,
            localId: `new_column_local_${index}`,
          },
        }
      : {}),
  }
}

function assertOk<T extends FormCommandResult>(
  result: T,
): asserts result is Extract<T, { ok: true }> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
}

describe('approvalFormCommands - add', () => {
  it.each(AUTHORABLE_FIELD_TYPES)(
    'adds each supported %s field with deterministic internal identity',
    (type) => {
      const source = draftWith([field(1)])
      const fieldIdentity = identity(2, type === 'detail')
      const first = addFormField(source, type, fieldIdentity)
      const replay = addFormField(source, type, fieldIdentity)
      assertOk(first)
      assertOk(replay)

      const created = first.draft.fields.at(-1)!
      expect(created.type).toBe(type)
      expect(created.id).toBe('new_field_2')
      expect(created.localId).toBe('new_local_2')
      expect(replay.draft.fields.at(-1)).toEqual(created)
      expect(source.fields).toHaveLength(1)
      if (type === 'detail') {
        expect(created.detailColumns).toEqual([
          expect.objectContaining({
            id: 'new_column_2',
            localId: 'new_column_local_2',
            type: 'text',
          }),
        ])
      } else {
        expect(created.detailColumns).toEqual([])
      }
    },
  )

  it('inserts after the selected internal field key without accepting a persisted id input', () => {
    const result = addFormField(
      draftWith([field(1), field(2)]),
      'number',
      identity(3),
      'local_1',
    )
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'new_field_3',
      'field_2',
    ])
    expect(result.focusLocalId).toBe('new_local_3')
  })

  it('fails closed for unsupported kinds, missing identities, and missing insertion targets', () => {
    expect(
      addFormField(draftWith([field(1)]), 'attachment' as never, identity(2)),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
    expect(
      addFormField(draftWith([field(1)]), 'text', undefined as never),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    expect(
      addFormField(draftWith([field(1)]), 'text', identity(2), 'missing'),
    ).toMatchObject({ ok: false, reason: 'target_not_found' })
  })

  it('rejects blank and field/detail-column identity collisions before it changes the draft', () => {
    const source = draftWith([
      field(1, {
        localId: 'existing_local',
        id: 'existing_field',
        type: 'detail',
        detailColumns: [
          {
            localId: 'existing_column_local',
            id: 'existing_column',
            type: 'text',
            label: '已有子字段',
            required: false,
            optionsText: '',
          },
        ],
      }),
    ])
    expect(
      addFormField(source, 'text', { persistentId: ' ', localId: 'new_local' }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_field_identity',
    })
    expect(
      addFormField(source, 'text', {
        persistentId: 'new_field',
        localId: ' ',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    expect(
      addFormField(source, 'text', {
        persistentId: 'existing_field',
        localId: 'new_local',
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(
      addFormField(source, 'text', {
        persistentId: 'existing_column',
        localId: 'new_local',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'field_identity_conflict',
    })
    expect(
      addFormField(source, 'text', {
        persistentId: 'new_field',
        localId: 'existing_column_local',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'field_identity_conflict',
    })
    expect(
      addFormField(source, 'detail', {
        persistentId: 'new_detail',
        localId: 'new_detail_local',
        detailColumn: { persistentId: 'new_column', localId: 'existing_local' },
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(
      addFormField(source, 'detail', {
        persistentId: 'new_detail',
        localId: 'new_detail_local',
        detailColumn: {
          persistentId: 'existing_column',
          localId: 'new_column_local',
        },
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(source.fields).toHaveLength(1)
  })

  it('does not reuse the deleted final field identity because identity allocation is explicit', () => {
    const source = draftWith([
      field(1, { id: 'retired_field', localId: 'retired_local' }),
    ])
    const deleted = removeFormField(source, 'retired_local', EMPTY_INVENTORY)
    assertOk(deleted)
    const added = addFormField(deleted.draft, 'text', {
      persistentId: 'fresh_field_after_delete',
      localId: 'fresh_local_after_delete',
    })
    assertOk(added)
    expect(added.draft.fields.map((entry) => entry.id)).toEqual([
      'fresh_field_after_delete',
    ])
    expect(added.draft.fields[0].id).not.toBe('retired_field')
  })
})

describe('approvalFormCommands - reorder', () => {
  it('uses the same placement algebra for drag and keyboard ordering', () => {
    const source = draftWith([field(1), field(2), field(3)])
    const drag = moveFormField(source, 'local_3', 'local_1', 'before')
    const keyboardOnce = moveFormFieldByOffset(source, 'local_3', -1)
    assertOk(keyboardOnce)
    const keyboard = moveFormFieldByOffset(keyboardOnce.draft, 'local_3', -1)
    assertOk(drag)
    assertOk(keyboard)
    expect(drag.draft.fields.map((entry) => entry.id)).toEqual([
      'field_3',
      'field_1',
      'field_2',
    ])
    expect(keyboard.draft.fields.map((entry) => entry.id)).toEqual(
      drag.draft.fields.map((entry) => entry.id),
    )
    expect(source.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
      'field_3',
    ])
  })

  it('keeps every field object and dependency value intact while reordering', () => {
    const dependent = field(2, {
      visibility: {
        dependsOnFieldId: 'field_1',
        operator: 'eq',
        valueText: 'yes',
      },
    })
    const source = draftWith([field(1), dependent, field(3)])
    const result = moveFormField(source, 'local_1', 'local_3', 'after')
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual([
      'field_2',
      'field_3',
      'field_1',
    ])
    expect(result.draft.fields[0]).toBe(dependent)
    expect(result.draft.fields[0].visibility.dependsOnFieldId).toBe('field_1')
  })
})

describe('approvalFormCommands - remove', () => {
  it('refuses delete until the out-of-draft reference inventory is explicitly complete', () => {
    const result = removeFormField(draftWith([field(1)]), 'local_1')
    expect(result).toMatchObject({
      ok: false,
      reason: 'reference_inventory_missing',
    })
  })

  it('removes an unreferenced field immutably once the inventory is complete', () => {
    const source = draftWith([field(1), field(2)])
    const result = removeFormField(source, 'local_1', EMPTY_INVENTORY)
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual(['field_2'])
    expect(result.focusLocalId).toBe('local_2')
    expect(source.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
  })

  it('rejects visibility, assignee, permission, condition, formula, graph, amount and external references', () => {
    const source = draftWith([
      field(1, { type: 'user' }),
      field(2, {
        visibility: {
          dependsOnFieldId: 'field_1',
          operator: 'eq',
          valueText: 'yes',
        },
      }),
    ])
    source.steps[0] = {
      ...source.steps[0],
      sourceKind: 'form_field_user',
      fieldId: 'field_1',
      fieldPermissions: [{ fieldId: 'field_1', access: 'hidden' }],
    }
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
            formulaExpression: '{field_1} > 0',
          },
        ],
      },
    }
    source.approvalNodeEdits = {
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [{ kind: 'form_field_user', fieldId: 'field_1' }],
      },
    }
    source.preservedGraph = {
      nodes: [
        {
          key: 'condition_1',
          type: 'condition',
          config: {
            branches: [
              {
                edgeKey: 'e1',
                rules: [{ fieldId: 'field_1', operator: 'eq' }],
                formula: { expression: '{field_1} > 0' },
              },
            ],
          },
        },
      ],
      edges: [],
    }
    source.amountConsistencyCheck = {
      totalFieldId: 'field_1',
      detailFieldId: 'items',
      amountColumnId: 'amount',
    }

    const inventory: CompleteFormReferenceInventory = {
      complete: true,
      references: [{ fieldId: 'field_1', location: 'fwb.mappings.0' }],
    }
    const dependencies = collectFormFieldDependencies(
      source,
      'field_1',
      inventory,
    )
    expect(new Set(dependencies.map((entry) => entry.kind))).toEqual(
      new Set([
        'visibility_rule',
        'step_assignee_source',
        'step_field_permission',
        'condition_rule',
        'condition_formula',
        'approval_node_assignee_source',
        'preserved_graph_reference',
        'amount_consistency_mapping',
        'external_reference',
      ]),
    )
    expect(removeFormField(source, 'local_1', inventory)).toMatchObject({
      ok: false,
      reason: 'field_is_referenced',
    })
  })
})

describe('approvalFormCommands - legacy no-op round-trip', () => {
  it('an empty command sequence preserves a representative legacy authorable form and graph exactly', () => {
    const detail = field(2, {
      id: 'items',
      type: 'detail',
      detailColumns: [
        {
          localId: 'detail_product',
          id: 'product',
          type: 'text',
          label: '品名',
          required: true,
          optionsText: '',
        },
      ],
      minRowsText: '1',
      maxRowsText: '5',
    })
    const legacy = draftWith([
      field(1, { id: 'requester', type: 'user' }),
      detail,
      field(3, {
        id: 'visible_after_requester',
        visibility: {
          dependsOnFieldId: 'requester',
          operator: 'notEmpty',
          valueText: '',
        },
      }),
    ])
    legacy.steps[0] = {
      ...legacy.steps[0],
      sourceKind: 'form_field_user',
      fieldId: 'requester',
    }
    const result = applyFormCommands(legacy, [])
    assertOk(result)
    expect(result.draft).toBe(legacy)
    expect(buildFormSchema(result.draft)).toEqual(buildFormSchema(legacy))
    expect(buildApprovalGraph(result.draft)).toEqual(buildApprovalGraph(legacy))
  })
})
