/** FWB-1 slice ② — §11 Q6 four-gate execute-time recheck (pure, required no-DB lane). Fail-closed. */
import { describe, expect, test } from 'vitest'

import { recheckFwbPermissionGates, type FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'

const S = { configurerUserId: 'u1', ruleId: 'r1', sourceTemplateId: 'tpl1', targetSheetId: 'sh1' }
const allTrue = (over: Partial<Record<keyof FwbGateChecks, boolean | 'throw'>> = {}): FwbGateChecks => {
  const mk = (k: keyof FwbGateChecks) => async () => {
    const v = over[k]
    if (v === 'throw') throw new Error('acl backend down')
    return v ?? true
  }
  return {
    isAdmin: mk('isAdmin'),
    canManageSheetAccess: mk('canManageSheetAccess'),
    canReadTemplate: mk('canReadTemplate'),
    canWriteSheet: mk('canWriteSheet'),
    hasRecordedConfirmation: mk('hasRecordedConfirmation'),
  }
}

describe('FWB-1 §11 Q6 permission gates (execute-time recheck)', () => {
  test('all gates hold → ok', async () => {
    expect(await recheckFwbPermissionGates(allTrue(), S)).toEqual({ ok: true })
  })

  test('G1 authority: admin OR canManageSheetAccess suffices; neither → configurer_authority fails', async () => {
    expect(await recheckFwbPermissionGates(allTrue({ isAdmin: false }), S)).toEqual({ ok: true }) // manage covers
    expect(await recheckFwbPermissionGates(allTrue({ canManageSheetAccess: false }), S)).toEqual({ ok: true }) // admin covers
    const r = await recheckFwbPermissionGates(allTrue({ isAdmin: false, canManageSheetAccess: false }), S)
    expect(r).toEqual({ ok: false, failed: ['configurer_authority'] })
  })

  test('each remaining gate fails independently and ALL failures are collected', async () => {
    const r = await recheckFwbPermissionGates(
      allTrue({ isAdmin: false, canManageSheetAccess: false, canReadTemplate: false, canWriteSheet: false, hasRecordedConfirmation: false }),
      S,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failed).toEqual(['configurer_authority', 'source_readable', 'target_writable', 'confirmation_recorded'])
  })

  test('fail-closed on error: a THROWING check counts as failed, never as a pass', async () => {
    const r = await recheckFwbPermissionGates(allTrue({ canWriteSheet: 'throw' }), S)
    expect(r).toEqual({ ok: false, failed: ['target_writable'] })
  })
})
