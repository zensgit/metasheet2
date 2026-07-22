import { describe, expect, it } from 'vitest'
import {
  buildFwbActionConfigForSave,
  canSelectNewFwbAction,
  draftConfigFromFwbAction,
  emptyFwbDraftConfig,
  isFwbActionReadOnly,
  isFwbActionSelectable,
  sheetFieldsToFwbTargets,
  templateSchemaToFwbFields,
} from '../src/multitable/fwbRuleAuthoring'

describe('fwbRuleAuthoring helpers', () => {
  it('gates new selection on flag + approval.completed only', () => {
    expect(canSelectNewFwbAction(false, 'approval.completed')).toBe(false)
    expect(canSelectNewFwbAction(true, 'record.created')).toBe(false)
    expect(canSelectNewFwbAction(true, 'approval.completed')).toBe(true)
    expect(canSelectNewFwbAction(true, 'approval.completed', [])).toBe(false)
    expect(canSelectNewFwbAction(true, 'approval.completed', ['approved', 'rejected'])).toBe(false)
  })

  it('keeps a current FWB type selectable when flag is off (persisted visibility)', () => {
    expect(isFwbActionSelectable(false, 'approval.completed', 'write_approval_form_values')).toBe(true)
    expect(isFwbActionSelectable(false, 'approval.completed', 'update_record')).toBe(false)
  })

  it('read-only when flag off or wrong trigger', () => {
    expect(isFwbActionReadOnly(false, 'approval.completed')).toBe(true)
    expect(isFwbActionReadOnly(true, 'record.created')).toBe(true)
    expect(isFwbActionReadOnly(true, 'approval.completed')).toBe(false)
    expect(isFwbActionReadOnly(true, 'approval.completed', false, ['approved', 'rejected'])).toBe(true)
  })

  it('hydrates a persisted config losslessly and starts confirmed when hash present', () => {
    const draft = draftConfigFromFwbAction({
      mappings: [
        { formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' },
        { formFieldId: 'f2', targetFieldId: 't2', targetType: 'select', selectOptions: ['a'] },
      ],
      sourceTemplateVersionId: 'ver_1',
      confirmationHash: 'hash_1',
    })
    expect(draft.fwbMappings).toEqual([
      { formFieldId: 'f1', targetFieldId: 't1' },
      { formFieldId: 'f2', targetFieldId: 't2' },
    ])
    expect(draft.fwbConfirmationState).toBe('confirmed')
    expect(draft.fwbPersistedMappings?.[1]).toMatchObject({
      targetType: 'select',
      selectOptions: ['a'],
    })
  })

  it('flag-off save re-emits the complete persisted config without dropping extension keys', () => {
    const draft = draftConfigFromFwbAction({
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      sourceTemplateVersionId: 'ver_1',
      confirmationHash: 'server-hash',
      mode: 'create',
      extension: { source: 'future-server', nested: ['kept'] },
    })
    const built = buildFwbActionConfigForSave(draft, sheetFieldsToFwbTargets([
      { id: 't1', name: 'Name', type: 'string' },
    ]), { flagEnabled: false, readOnly: true })
    expect(built).toEqual({
      ok: true,
      config: {
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
        sourceTemplateVersionId: 'ver_1',
        confirmationHash: 'server-hash',
        mode: 'create',
        extension: { source: 'future-server', nested: ['kept'] },
      },
    })
  })

  it('editable save requires confirmed state', () => {
    const draft = {
      ...emptyFwbDraftConfig(),
      fwbMappings: [{ formFieldId: 'f1', targetFieldId: 't1' }],
      sourceTemplateVersionId: 'ver_1',
      confirmationHash: '',
      fwbConfirmationState: 'unconfirmed' as const,
    }
    const built = buildFwbActionConfigForSave(draft, sheetFieldsToFwbTargets([
      { id: 't1', name: 'Name', type: 'string' },
    ]), { flagEnabled: true, readOnly: false })
    expect(built).toEqual({ ok: false, error: 'fwb_confirmation_required' })
  })

  it('editable save preserves unknown extension keys and does not confuse an error key with failure', () => {
    const draft = draftConfigFromFwbAction({
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      sourceTemplateVersionId: 'ver_1',
      confirmationHash: 'server-hash',
      error: 'valid-extension-value',
      extension: { future: true },
    })
    const built = buildFwbActionConfigForSave(draft, sheetFieldsToFwbTargets([
      { id: 't1', name: 'Name', type: 'string' },
    ]), { flagEnabled: true, readOnly: false })
    expect(built).toEqual({
      ok: true,
      config: {
        mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
        sourceTemplateVersionId: 'ver_1',
        confirmationHash: 'server-hash',
        error: 'valid-extension-value',
        extension: { future: true },
      },
    })
  })

  it('maps sheet + template fields for the editor', () => {
    expect(sheetFieldsToFwbTargets([
      { id: 's1', name: 'Title', type: 'string' },
      { id: 's2', name: 'Status', type: 'select', options: [{ value: 'open' }] },
    ])).toEqual([
      { id: 's1', label: 'Title', type: 'text' },
      { id: 's2', label: 'Status', type: 'select', selectOptions: ['open'] },
    ])
    expect(templateSchemaToFwbFields({
      fields: [
        { id: 'f1', label: 'Reason' },
        { id: 2, label: 'bad' },
      ],
    })).toEqual([{ id: 'f1', label: 'Reason' }])
  })
})
