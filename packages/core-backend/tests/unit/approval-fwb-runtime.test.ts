/**
 * FWB production runtime — pure config/hash/value-shape unit specs (no DB).
 * Discriminating: positive controls + fail-closed rejects for each parse gate.
 */
import { describe, expect, test } from 'vitest'

import {
  computeFwbConfirmationHash,
  extractApprovalInstanceId,
  parseRecordLinkValue,
  parseWriteApprovalFormValuesConfig,
} from '../../src/multitable/approval-fwb-runtime'

describe('FWB runtime — config parse + confirmation hash + record-link shape', () => {
  test('parse accepts a valid create config (positive control)', () => {
    const r = parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' }],
      confirmationHash: 'abc',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.mode).toBe('create')
  })

  test('parse rejects empty mappings, bad mode, missing confirmation, update without link', () => {
    expect(parseWriteApprovalFormValuesConfig({ mode: 'create', mappings: [], confirmationHash: 'x' }).ok).toBe(false)
    expect(parseWriteApprovalFormValuesConfig({ mode: 'nope', mappings: [{ formFieldId: 'a', targetFieldId: 'b', targetType: 'text' }], confirmationHash: 'x' }).ok).toBe(false)
    expect(parseWriteApprovalFormValuesConfig({ mode: 'create', mappings: [{ formFieldId: 'a', targetFieldId: 'b', targetType: 'text' }] }).ok).toBe(false)
    expect(parseWriteApprovalFormValuesConfig({
      mode: 'update',
      mappings: [{ formFieldId: 'a', targetFieldId: 'b', targetType: 'text' }],
      confirmationHash: 'x',
    }).ok).toBe(false)
  })

  test('parse rejects unsupported target type and duplicate target fields', () => {
    expect(parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [{ formFieldId: 'a', targetFieldId: 'b', targetType: 'attachment' }],
      confirmationHash: 'x',
    }).ok).toBe(false)
    expect(parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [
        { formFieldId: 'a', targetFieldId: 'same', targetType: 'text' },
        { formFieldId: 'b', targetFieldId: 'same', targetType: 'text' },
      ],
      confirmationHash: 'x',
    }).ok).toBe(false)
  })

  test('confirmation hash is stable under mapping reorder and excludes business values', () => {
    const a = computeFwbConfirmationHash({
      sourceTemplateId: 'tpl',
      targetSheetId: 'sheet',
      mappings: [
        { formFieldId: 'f2', targetFieldId: 't2' },
        { formFieldId: 'f1', targetFieldId: 't1' },
      ],
    })
    const b = computeFwbConfirmationHash({
      sourceTemplateId: 'tpl',
      targetSheetId: 'sheet',
      mappings: [
        { formFieldId: 'f1', targetFieldId: 't1' },
        { formFieldId: 'f2', targetFieldId: 't2' },
      ],
    })
    expect(a).toBe(b)
    const c = computeFwbConfirmationHash({
      sourceTemplateId: 'tpl',
      targetSheetId: 'OTHER',
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1' }],
    })
    expect(c).not.toBe(a)
  })

  test('record-link value shape: single { recordId } accepted; free-text / multi rejected', () => {
    expect(parseRecordLinkValue({ recordId: 'rec_1' })).toEqual({ ok: true, recordId: 'rec_1' })
    expect(parseRecordLinkValue('rec_1').ok).toBe(false)
    expect(parseRecordLinkValue({ recordId: 'a', extra: 1 }).ok).toBe(false)
    expect(parseRecordLinkValue({ recordId: '' }).ok).toBe(false)
    expect(parseRecordLinkValue([{ recordId: 'a' }]).ok).toBe(false)
  })

  test('extractApprovalInstanceId reads only the approval trigger envelope', () => {
    expect(extractApprovalInstanceId({ approval: { instanceId: 'inst_1' } })).toBe('inst_1')
    expect(extractApprovalInstanceId({ instanceId: 'nope' })).toBeNull()
    expect(extractApprovalInstanceId(null)).toBeNull()
  })
})
