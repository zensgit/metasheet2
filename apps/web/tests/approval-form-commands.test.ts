import { describe, expect, it } from 'vitest'

import {
  addFormDetailColumn,
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
import type { FormField } from '../src/types/approval'

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

  it('inserts after the anchored internal field key without accepting a persisted id input', () => {
    const result = addFormField(
      draftWith([field(1), field(2)]),
      'number',
      identity(3),
      { kind: 'after', localId: 'local_1' },
    )
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'new_field_3',
      'field_2',
    ])
    expect(result.focusLocalId).toBe('new_local_3')
  })

  it('prepends atomically at the start anchor as ONE command (FB-D3, never add-then-move)', () => {
    const source = draftWith([field(1), field(2)])
    const result = addFormField(source, 'text', identity(3), { kind: 'start' })
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual([
      'new_field_3',
      'field_1',
      'field_2',
    ])
    expect(result.focusLocalId).toBe('new_local_3')
    // Source draft untouched: the prepend is a single immutable command result.
    expect(source.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
  })

  it('re-resolves an after anchor against the current draft: a stale anchor is a no-op rejection', () => {
    const source = draftWith([field(1), field(2), field(3)])
    // Anchor captured while local_2 exists (e.g. at drag start)…
    const anchor = { kind: 'after', localId: 'local_2' } as const
    // Positive control first: the anchor works while its neighbor is live.
    const live = addFormField(source, 'text', identity(9), anchor)
    assertOk(live)
    expect(live.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
      'new_field_9',
      'field_3',
    ])
    // …then the neighbor is removed before the drop lands.
    const removed = removeFormField(source, 'local_2')
    assertOk(removed)
    const stale = addFormField(removed.draft, 'text', identity(9), anchor)
    expect(stale).toMatchObject({ ok: false, reason: 'target_not_found' })
    // Zero mutation: the draft the stale drop targeted is unchanged.
    expect(removed.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_3',
    ])
  })

  it('fails closed for unsupported kinds, missing identities, and missing insertion targets', () => {
    expect(
      addFormField(draftWith([field(1)]), 'attachment' as never, identity(2)),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
    expect(
      addFormField(draftWith([field(1)]), 'text', undefined as never),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    expect(
      addFormField(draftWith([field(1)]), 'text', identity(2), {
        kind: 'after',
        localId: 'missing',
      }),
    ).toMatchObject({ ok: false, reason: 'target_not_found' })
  })

  it('rejects blank and field/detail-column identity collisions against the complete current draft', () => {
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
      addFormField(source, 'text', {
        persistentId: ' ',
        localId: 'new_local',
      }),
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
        persistentId: 'same_internal_token',
        localId: 'same_internal_token',
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
        detailColumn: {
          persistentId: 'new_column',
          localId: 'existing_local',
        },
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
    expect(
      addFormField(source, 'detail', {
        persistentId: 'new_detail',
        localId: 'new_detail_local',
        detailColumn: {
          persistentId: 'new_detail_local',
          localId: 'new_column_local',
        },
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(source.fields).toHaveLength(1)
  })
})

describe('approvalFormCommands - detail column add', () => {
  const detailOwner = () =>
    field(1, {
      localId: 'detail_local',
      id: 'detail_field',
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
    })

  it('appends a column with the supplied opaque identity and leaves the source draft untouched', () => {
    const source = draftWith([detailOwner(), field(2)])
    const result = addFormDetailColumn(source, 'detail_local', {
      persistentId: 'dcol_new',
      localId: 'dcolloc_new',
    })
    assertOk(result)
    expect(result.focusLocalId).toBe('detail_local')
    const owner = result.draft.fields[0]
    expect(owner.detailColumns.map((column) => column.id)).toEqual([
      'existing_column',
      'dcol_new',
    ])
    expect(owner.detailColumns.at(-1)).toMatchObject({
      localId: 'dcolloc_new',
      type: 'text',
      required: false,
      optionsText: '',
    })
    expect(source.fields[0].detailColumns).toHaveLength(1)
  })

  it('fails closed for missing owners, non-detail targets, blank identities, and draft collisions', () => {
    const source = draftWith([detailOwner(), field(2)])
    expect(
      addFormDetailColumn(source, 'missing', {
        persistentId: 'dcol_new',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'field_not_found' })
    expect(
      addFormDetailColumn(source, 'local_2', {
        persistentId: 'dcol_new',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
    expect(
      addFormDetailColumn(source, 'detail_local', {
        persistentId: ' ',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    expect(
      addFormDetailColumn(source, 'detail_local', {
        persistentId: 'dcol_new',
        localId: ' ',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_field_identity' })
    // Collision domain is the COMPLETE draft: existing column id, an existing
    // top-level FIELD id, and internal duplicates all reject.
    expect(
      addFormDetailColumn(source, 'detail_local', {
        persistentId: 'existing_column',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(
      addFormDetailColumn(source, 'detail_local', {
        persistentId: 'field_2',
        localId: 'dcolloc_new',
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(
      addFormDetailColumn(source, 'detail_local', {
        persistentId: 'same_internal_token',
        localId: 'same_internal_token',
      }),
    ).toMatchObject({ ok: false, reason: 'field_identity_conflict' })
    expect(source.fields[0].detailColumns).toHaveLength(1)
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
  it('removes an unreferenced field immutably using the current-draft reference set (FB-D6)', () => {
    const source = draftWith([field(1), field(2)])
    const result = removeFormField(source, 'local_1')
    assertOk(result)
    expect(result.draft.fields.map((entry) => entry.id)).toEqual(['field_2'])
    expect(result.focusLocalId).toBe('local_2')
    expect(source.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
  })

  it('refuses to remove the final remaining field at the command level, BEFORE reference evaluation', () => {
    const solo = draftWith([field(1)])
    // A missing field is still field_not_found, not the last-field refusal.
    expect(removeFormField(solo, 'missing')).toMatchObject({
      ok: false,
      reason: 'field_not_found',
    })
    expect(removeFormField(solo, 'local_1')).toMatchObject({
      ok: false,
      reason: 'last_field_removal_forbidden',
    })
    // Ordering proof: a REFERENCED single field still reports the last-field
    // refusal (with no dependency list) — the guard sits before the walk.
    const referencedSolo = draftWith([field(1)])
    referencedSolo.steps[0] = {
      ...referencedSolo.steps[0],
      fieldPermissions: [{ fieldId: 'field_1', access: 'hidden' }],
    }
    expect(removeFormField(referencedSolo, 'local_1')).toMatchObject({
      ok: false,
      reason: 'last_field_removal_forbidden',
      dependencies: [],
    })
    // Positive control: the same unreferenced field is removable once a second
    // field exists.
    assertOk(removeFormField(draftWith([field(1), field(2)]), 'local_1'))
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

    // The optional inventory remains the collector's seam for a FUTURE
    // authoritative same-version external owner (FB-D6) — production delete
    // itself takes no inventory.
    const inventory: CompleteFormReferenceInventory = {
      complete: true,
      references: [{ fieldId: 'field_1', location: 'future.external.0' }],
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
    // P2-1a: the kind SET alone cannot tell apart the two independent
    // `condition_formula` producers (conditionEdits.branches[].formulaExpression
    // at commands.ts:456, and the preserved-graph walk over `value.expression`
    // at commands.ts:375-380, reached here via `draft.preservedGraph`) — either
    // could be deleted and the kind set would still contain `condition_formula`.
    // Asserting the LOCATION set makes each producer individually load-bearing:
    // the two locations are distinct strings, so killing either producer alone
    // drops one of them from this set.
    const conditionFormulaLocations = dependencies
      .filter((entry) => entry.kind === 'condition_formula')
      .map((entry) => entry.location)
    expect(new Set(conditionFormulaLocations)).toEqual(
      new Set([
        'conditionEdits.condition_1.branches.0.formula',
        'preservedGraph.nodes[0].config.branches[0].formula',
      ]),
    )
    const refused = removeFormField(source, 'local_1')
    expect(refused).toMatchObject({
      ok: false,
      reason: 'field_is_referenced',
    })
    if (!refused.ok) {
      // Production delete evaluates the CURRENT-DRAFT reference set — the six
      // in-draft kinds are all named; no inventory-fed kind is fabricated.
      expect(refused.dependencies.length).toBeGreaterThan(0)
      expect(
        refused.dependencies.every((entry) => entry.kind !== 'external_reference'),
      ).toBe(true)
    }
  })

  it('refuses delete when the only reference lives in a hydrated field.original (P2-1b)', () => {
    // `fieldDraftFromField` (templateAuthoring.ts:425) sets `original: field`
    // UNCONDITIONALLY on every hydrated authorable field, and `DetailColumnDraft`
    // carries no visibility member of its own — so a detail SUB-FIELD's
    // `visibilityRule` naming a top-level field is detectable ONLY through the
    // `field.original` walk (commands.ts:420-427). This fixture's detail field
    // has no typed visibility of its own; the sole reference to `field_1` lives
    // inside `original.columns[0].visibilityRule.fieldId`.
    const detailFieldOriginal: FormField = {
      id: 'detail_field',
      type: 'detail',
      label: '明细',
      columns: [
        {
          id: 'sub_column',
          type: 'text',
          label: '子字段',
          visibilityRule: { fieldId: 'field_1', operator: 'eq' },
        },
      ],
    }
    const source = draftWith([
      field(1),
      field(2, {
        id: 'detail_field',
        type: 'detail',
        original: detailFieldOriginal,
      }),
    ])
    const dependencies = collectFormFieldDependencies(source, 'field_1')
    expect(dependencies).toEqual([
      {
        kind: 'preserved_graph_reference',
        location: 'fields.local_2.original.columns[0].visibilityRule',
      },
    ])
    expect(removeFormField(source, 'local_1')).toMatchObject({
      ok: false,
      reason: 'field_is_referenced',
    })
  })

  it('refuses delete when the field is referenced as the amount-consistency COLUMN id (P3-1)', () => {
    // `AmountConsistencyMapping.amountColumnId` (types/approval.ts:189-193) is a
    // persisted detail-column id; the walk previously checked only
    // `totalFieldId`/`detailFieldId`, orphaning `amountColumnId` on delete.
    const source = draftWith([field(1), field(2)])
    source.amountConsistencyCheck = {
      totalFieldId: 'unrelated_total',
      detailFieldId: 'unrelated_detail',
      amountColumnId: 'field_1',
    }
    const dependencies = collectFormFieldDependencies(source, 'field_1')
    expect(dependencies).toEqual([
      { kind: 'amount_consistency_mapping', location: 'amountConsistencyCheck' },
    ])
    expect(removeFormField(source, 'local_1')).toMatchObject({
      ok: false,
      reason: 'field_is_referenced',
    })
  })

  it('trims whitespace-padded reference ids: permission.fieldId, mapping.totalFieldId, preserved-graph value.fieldId (P3-2)', () => {
    const source = draftWith([field(1), field(2)])
    source.steps[0] = {
      ...source.steps[0],
      fieldPermissions: [{ fieldId: ' field_1 ', access: 'hidden' }],
    }
    source.amountConsistencyCheck = {
      totalFieldId: ' field_1 ',
      detailFieldId: 'items',
      amountColumnId: 'amount',
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
                rules: [{ fieldId: ' field_1 ', operator: 'eq' }],
              },
            ],
          },
        },
      ],
      edges: [],
    }
    const dependencies = collectFormFieldDependencies(source, 'field_1')
    expect(new Set(dependencies.map((entry) => entry.kind))).toEqual(
      new Set([
        'step_field_permission',
        'amount_consistency_mapping',
        'preserved_graph_reference',
      ]),
    )
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
