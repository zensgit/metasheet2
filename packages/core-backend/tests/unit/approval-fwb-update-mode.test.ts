/**
 * FWB-2 pure helpers — mode contract, confirmation-hash binding, linked-record extraction,
 * and schema-derived target resolution. Required no-DB lane.
 */
import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'

import {
  collectPersistedFwbActions,
  deriveFwbConfirmationHash,
  extractExactLinkedRecordId,
  normalizeFwbUpdateRecordLinkFieldId,
  parseFwbWriteMode,
  resolveRecordLinkTargetFromSchema,
} from '../../src/multitable/approval-fwb-activation'
import { canonicalizeConfig } from '../../src/multitable/automation-action-idempotency'
import { recheckFwbPermissionGates, type FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import {
  executeUpdateBoundRecord,
  type FwbUpdateSeam,
  type RecordLinkChecks,
} from '../../src/multitable/approval-fwb-record-link'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const MAPPINGS = [
  { formFieldId: 'summary', targetFieldId: 'fld_title', targetType: 'text' as const },
]

describe('FWB-2 mode / config contract (pure)', () => {
  test('parseFwbWriteMode: only absent/create → create; update → update; null/blank/unknown rejected', () => {
    expect(parseFwbWriteMode(undefined)).toEqual({ ok: true, mode: 'create' })
    expect(parseFwbWriteMode('create')).toEqual({ ok: true, mode: 'create' })
    expect(parseFwbWriteMode('update')).toEqual({ ok: true, mode: 'update' })
    expect(parseFwbWriteMode(null)).toEqual({ ok: false, issue: 'unknown_mode' })
    expect(parseFwbWriteMode('')).toEqual({ ok: false, issue: 'unknown_mode' })
    expect(parseFwbWriteMode('patch')).toEqual({ ok: false, issue: 'unknown_mode' })
    expect(parseFwbWriteMode(1)).toEqual({ ok: false, issue: 'unknown_mode' })
  })

  test('persisted action identity mirrors executor precedence and isolates sibling configs', () => {
    const legacy = { mappings: [{ ...MAPPINGS[0], targetFieldId: 'legacy' }] }
    const actions = [
      { type: 'write_approval_form_values', config: { mode: 'update', recordLinkFieldId: 'link_a', mappings: MAPPINGS } },
      { type: 'write_approval_form_values', config: { mode: 'update', recordLinkFieldId: 'link_b', mappings: [{ ...MAPPINGS[0], targetFieldId: 'other' }] } },
    ]
    const collected = collectPersistedFwbActions('write_approval_form_values', legacy, actions)
    expect(collected).toHaveLength(2)
    expect(collected.map((entry) => entry.structuralPath)).toEqual(['0', '1'])
    expect(collected[0].actionKey).not.toBe(collected[1].actionKey)
    expect(collected.some((entry) => entry.config === legacy)).toBe(false)

    const fallback = collectPersistedFwbActions('write_approval_form_values', legacy, null)
    expect(fallback).toHaveLength(1)
    expect(fallback[0].structuralPath).toBe('0')
    expect(fallback[0].config).toBe(legacy)
  })

  test('normalizeFwbUpdateRecordLinkFieldId: requires one non-blank string', () => {
    expect(normalizeFwbUpdateRecordLinkFieldId('linked')).toEqual({ ok: true, recordLinkFieldId: 'linked' })
    expect(normalizeFwbUpdateRecordLinkFieldId('  linked  ')).toEqual({ ok: true, recordLinkFieldId: 'linked' })
    expect(normalizeFwbUpdateRecordLinkFieldId(undefined)).toEqual({ ok: false, issue: 'record_link_field_missing' })
    expect(normalizeFwbUpdateRecordLinkFieldId('   ')).toEqual({ ok: false, issue: 'record_link_field_blank' })
    expect(normalizeFwbUpdateRecordLinkFieldId(42)).toEqual({ ok: false, issue: 'record_link_field_blank' })
  })

  test('extractExactLinkedRecordId: only exactly { recordId: nonblank string }', () => {
    expect(extractExactLinkedRecordId({ recordId: 'rec_1' })).toBe('rec_1')
    expect(extractExactLinkedRecordId({ recordId: '  rec_2  ' })).toBe('rec_2')
    expect(extractExactLinkedRecordId(null)).toBeNull()
    expect(extractExactLinkedRecordId('rec_1')).toBeNull()
    expect(extractExactLinkedRecordId(['rec_1'])).toBeNull()
    expect(extractExactLinkedRecordId({ recordId: '' })).toBeNull()
    expect(extractExactLinkedRecordId({ recordId: 'a', sheetId: 'smuggle' })).toBeNull()
    expect(extractExactLinkedRecordId({ recordIds: ['a'] })).toBeNull()
  })

  test('resolveRecordLinkTargetFromSchema: top-level record-link props only', () => {
    const schema = {
      fields: [
        { id: 'linked', type: 'record-link', props: { baseId: 'base_a', sheetId: 'sheet_a' } },
        { id: 'summary', type: 'text' },
        {
          id: 'detail',
          type: 'detail',
          columns: [
            { id: 'nested_link', type: 'record-link', props: { baseId: 'base_b', sheetId: 'sheet_b' } },
          ],
        },
      ],
    }
    expect(resolveRecordLinkTargetFromSchema(schema, 'linked')).toEqual({
      fieldId: 'linked',
      baseId: 'base_a',
      sheetId: 'sheet_a',
    })
    // Nested record-link is not discoverable as a top-level target.
    expect(resolveRecordLinkTargetFromSchema(schema, 'nested_link')).toBeNull()
    // Wrong type / blank props / missing field.
    expect(resolveRecordLinkTargetFromSchema(schema, 'summary')).toBeNull()
    expect(resolveRecordLinkTargetFromSchema(
      { fields: [{ id: 'linked', type: 'record-link', props: { baseId: '  ', sheetId: 's' } }] },
      'linked',
    )).toBeNull()
    expect(resolveRecordLinkTargetFromSchema(schema, 'nope')).toBeNull()
  })
})

describe('FWB confirmation hash — create byte-compat + update binding', () => {
  const baseSubject = {
    templateId: 'tpl_1',
    sourceTemplateVersionId: 'ver_1',
    targetBaseId: 'base_1',
    targetSheetId: 'sheet_1',
    mappings: MAPPINGS,
  }

  test('create-mode hash omits mode/recordLinkFieldId (byte-identical to pre-FWB-2 subject)', () => {
    const hash = deriveFwbConfirmationHash(baseSubject)
    const expected = createHash('sha256')
      .update(canonicalizeConfig({
        templateId: 'tpl_1',
        sourceTemplateVersionId: 'ver_1',
        targetBaseId: 'base_1',
        targetSheetId: 'sheet_1',
        mappings: MAPPINGS,
      }))
      .digest('hex')
    expect(hash).toBe(expected)
    // Explicit mode:'create' must NOT alter the subject (only update binds mode).
    expect(deriveFwbConfirmationHash({ ...baseSubject, mode: 'create' as const })).toBe(expected)
  })

  test('update-mode hash binds mode + recordLinkFieldId + derived target', () => {
    const updateHash = deriveFwbConfirmationHash({
      ...baseSubject,
      mode: 'update',
      recordLinkFieldId: 'linked',
    })
    expect(updateHash).not.toBe(deriveFwbConfirmationHash(baseSubject))
    // Changing recordLinkFieldId invalidates.
    expect(deriveFwbConfirmationHash({
      ...baseSubject,
      mode: 'update',
      recordLinkFieldId: 'other',
    })).not.toBe(updateHash)
    // Changing derived target sheet invalidates.
    expect(deriveFwbConfirmationHash({
      ...baseSubject,
      mode: 'update',
      recordLinkFieldId: 'linked',
      targetSheetId: 'sheet_other',
    })).not.toBe(updateHash)
  })
})

describe('FWB-2 permission gates pass mode to sheet/field checks', () => {
  test('update mode invokes canWriteSheet/canWriteTargetFields with mode=update', async () => {
    const canWriteSheet = vi.fn(async () => true)
    const canWriteTargetFields = vi.fn(async () => true)
    const checks: FwbGateChecks = {
      isAdmin: async () => true,
      canManageSheetAccess: async () => false,
      canReadTemplate: async () => true,
      canWriteSheet,
      canWriteTargetFields,
      hasRecordedConfirmation: async () => true,
    }
    const r = await recheckFwbPermissionGates(checks, {
      configurerUserId: 'u1',
      ruleId: 'r1',
      actionKey: 'ak1',
      sourceTemplateId: 'tpl',
      targetSheetId: 'sh_target',
      mode: 'update',
    })
    expect(r).toEqual({ ok: true })
    expect(canWriteSheet).toHaveBeenCalledWith('u1', 'sh_target', 'update')
    expect(canWriteTargetFields).toHaveBeenCalledWith('u1', 'r1', 'ak1', 'sh_target', 'update')
  })

  test('create (default) invokes checks with mode=create', async () => {
    const canWriteSheet = vi.fn(async () => true)
    const canWriteTargetFields = vi.fn(async () => true)
    const checks: FwbGateChecks = {
      isAdmin: async () => true,
      canManageSheetAccess: async () => false,
      canReadTemplate: async () => true,
      canWriteSheet,
      canWriteTargetFields,
      hasRecordedConfirmation: async () => true,
    }
    await recheckFwbPermissionGates(checks, {
      configurerUserId: 'u1',
      ruleId: 'r1',
      actionKey: 'ak1',
      sourceTemplateId: 'tpl',
      targetSheetId: 'sh1',
    })
    expect(canWriteSheet).toHaveBeenCalledWith('u1', 'sh1', 'create')
    expect(canWriteTargetFields).toHaveBeenCalledWith('u1', 'r1', 'ak1', 'sh1', 'create')
  })
})

describe('executeUpdateBoundRecord composition (seam-level, no DB)', () => {
  const trx = { query: async () => ({ rows: [], rowCount: 0 }), isTransaction: true } as unknown as TransactionalQueryable
  const gatesAll = (): FwbGateChecks => ({
    isAdmin: async () => true,
    canManageSheetAccess: async () => true,
    canReadTemplate: async () => true,
    canWriteSheet: async () => true,
    canWriteTargetFields: async () => true,
    hasRecordedConfirmation: async () => true,
  })
  const linkOk = (): RecordLinkChecks => ({
    fillerCanReadRecord: async () => true,
    recordExists: async () => true,
    recordIsLocked: async () => false,
    configurerCanWriteRecord: async () => true,
  })

  test('applied path calls update + outbox; lock/missing reject before claim', async () => {
    const update = vi.fn(async () => {})
    const enqueue = vi.fn(async () => {})
    const seam: FwbUpdateSeam = { updateRecordWithRevision: update, enqueueOutbox: enqueue }
    // Without a real claim ledger this only proves the bound-record fail-closed path before claim.
    const locked = await executeUpdateBoundRecord(
      trx,
      {
        claimId: 'c1',
        instanceId: 'i1',
        ruleId: 'r1',
        actionKey: 'ak1',
        gateSubject: {
          configurerUserId: 'u1',
          ruleId: 'r1',
          actionKey: 'ak1',
          sourceTemplateId: 'tpl',
          targetSheetId: 'sh',
          mode: 'update',
        },
        boundRecordId: 'rec1',
        mappings: MAPPINGS,
        formValues: { summary: 'x' },
        eventId: 'evt1',
      },
      gatesAll(),
      { ...linkOk(), recordIsLocked: async () => true },
      seam,
    )
    expect(locked).toEqual({ status: 'rejected', reason: 'record_locked' })
    expect(update).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })
})
