import { describe, expect, it } from 'vitest'
import {
  collectApprovalFormExternalReferences,
  collectApprovalFormPersistentIds,
  findMissingApprovalFormReferenceIds,
} from '../../src/services/approval-form-authoring-context'

describe('approval form authoring context', () => {
  it('reserves top-level and detail-column ids across deleted historical fields', () => {
    expect(collectApprovalFormPersistentIds([
      {
        fields: [
          { id: 'retired_top', type: 'text' },
          {
            id: 'retired_detail',
            type: 'detail',
            columns: [{ id: 'retired_column', type: 'text' }],
          },
        ],
      },
      { fields: [{ id: 'current', type: 'text' }] },
    ])).toEqual(['current', 'retired_column', 'retired_detail', 'retired_top'])
  })

  it('uses the shared action walker for disabled top-level and nested FWB references', () => {
    const references = collectApprovalFormExternalReferences([
      {
        action_type: 'write_approval_form_values',
        action_config: {
          mappings: [{ formFieldId: 'retired_top', targetFieldId: 'private_target' }],
        },
        actions: null,
      },
      {
        action_type: 'condition_branch',
        action_config: {},
        actions: [
          {
            type: 'condition_branch',
            config: {
              branches: [{
                key: 'yes',
                actions: [{
                  type: 'write_approval_form_values',
                  config: {
                    mappings: [{ formFieldId: 'current', targetFieldId: 'another_private_target' }],
                    recordLinkFieldId: 'record_link',
                  },
                }],
              }],
            },
          },
        ],
      },
    ])

    expect(references).toEqual([
      {
        fieldId: 'current',
        kind: 'fwb_mapping',
        location: 'automation.write_approval_form_values.mappings.formFieldId',
      },
      {
        fieldId: 'record_link',
        kind: 'fwb_record_link',
        location: 'automation.write_approval_form_values.recordLinkFieldId',
      },
      {
        fieldId: 'retired_top',
        kind: 'fwb_mapping',
        location: 'automation.write_approval_form_values.mappings.formFieldId',
      },
    ])
    expect(JSON.stringify(references)).not.toContain('private_target')
  })

  it('finds missing references against top-level and detail-column ids', () => {
    const schema = {
      fields: [
        { id: 'current', type: 'text', label: 'Current' },
        {
          id: 'details',
          type: 'detail',
          label: 'Details',
          columns: [{ id: 'detail_note', type: 'text', label: 'Note' }],
        },
      ],
    } as const
    expect(findMissingApprovalFormReferenceIds(schema, [
      {
        fieldId: 'detail_note',
        kind: 'fwb_mapping',
        location: 'automation.write_approval_form_values.mappings.formFieldId',
      },
      {
        fieldId: 'gone',
        kind: 'fwb_mapping',
        location: 'automation.write_approval_form_values.mappings.formFieldId',
      },
    ])).toEqual(['gone'])
  })
})
