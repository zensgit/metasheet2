/**
 * FWB production runtime — pure config/value-shape unit specs (no DB).
 */
import { describe, expect, test } from 'vitest'

import {
  assertFwbRuntimeActivatable,
  extractApprovalInstanceId,
  parseRecordLinkValue,
  parseWriteApprovalFormValuesConfig,
} from '../../src/multitable/approval-fwb-runtime'

describe('FWB runtime — config parse + record-link shape + activation', () => {
  test('parse accepts create with confirmationId (positive)', () => {
    const r = parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1' }],
      confirmationId: 'fwbc_1',
    })
    expect(r.ok).toBe(true)
  })

  test('parse rejects empty mappings, bad mode, missing confirmation, update without link', () => {
    expect(parseWriteApprovalFormValuesConfig({ mode: 'create', mappings: [], confirmationId: 'x' }).ok).toBe(false)
    expect(parseWriteApprovalFormValuesConfig({
      mode: 'update',
      mappings: [{ formFieldId: 'a', targetFieldId: 'b' }],
      confirmationId: 'x',
    }).ok).toBe(false)
  })

  test('record-link value shape: single { recordId } only', () => {
    expect(parseRecordLinkValue({ recordId: 'rec_1' })).toEqual({ ok: true, recordId: 'rec_1' })
    expect(parseRecordLinkValue('rec_1').ok).toBe(false)
    expect(parseRecordLinkValue({ recordId: 'a', extra: 1 }).ok).toBe(false)
  })

  test('extractApprovalInstanceId reads only approval envelope', () => {
    expect(extractApprovalInstanceId({ approval: { instanceId: 'inst_1' } })).toBe('inst_1')
    expect(extractApprovalInstanceId({ instanceId: 'nope' })).toBeNull()
  })

  test('activation OFF by default; positive control both flags ON; execution always gated', () => {
    expect(assertFwbRuntimeActivatable({})).toBeTruthy()
    expect(assertFwbRuntimeActivatable({
      APPROVAL_FWB_RUNTIME_ENABLED: 'true',
      AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
    })).toBeNull()
  })
})
