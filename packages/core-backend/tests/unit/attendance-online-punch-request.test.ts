import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import { describe, expect, it } from 'vitest'
import { buildOnlinePunchRequestV1, requireOnlinePunchRequestV1, makeOnlinePunchReceiptV1, parseOnlinePunchReceiptV1,
  retryOnlinePunchClaimV1, OnlinePunchClaimCollisionError, isOnlinePunchClaimPrimaryKeyCollision, OnlinePunchConnectionUncertainError } from '../../src/attendance/online-punch-request'
const input = { orgId: 'd16158b5-f5bb-45bb-bb26-76c79c219d01', userId: 'actor', tokenSubjectUserId: 'actor', operationId: 'd16158b5-f5bb-45bb-bb26-76c79c219d02',
  client: { eventType: 'check_in' as const, timezone: null, source: null, location: null, meta: null, photoFileId: null, requestNamedOrgId: null } }
const normal = { ok: true as const, data: { event: { occurred_at: '2026-10-10T00:00:00Z' }, record: { work_date: '2026-10-10' } } }
const outdoor = { ok: true as const, data: { pendingApproval: true, request: { requestedInAt: '2026-10-10T00:00:00Z' } } }
describe('closed online punch domain', () => {
  it('is immutable, branded, stable across operation IDs and excludes generated time/workday', () => {
    const a = buildOnlinePunchRequestV1(input)
    const b = buildOnlinePunchRequestV1({ ...input, operationId: 'd16158b5-f5bb-45bb-bb26-76c79c219d03' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.registryInput.commands[0])).toBe(true)
    expect(requireOnlinePunchRequestV1(a)).toBe(a)
    expect(() => requireOnlinePunchRequestV1({ ...a })).toThrow('ATTENDANCE_OPERATION_CONFLICT')
    expect(a.registryInput.commands[0]?.normalizedBusinessInputSnapshot).toBeUndefined()
  })
  it.each([
    { eventType: 'check_out' }, { timezone: 'Asia/Singapore' }, { source: 'mobile' }, { location: { lat: 1, lng: 2 } },
    { meta: { note: 'changed', nested: { photo: 'evidence' } } }, { photoFileId: 'photo' }, { requestNamedOrgId: input.orgId },
  ])('binds every real client field %j', change => {
    expect(buildOnlinePunchRequestV1({ ...input, client: { ...input.client, ...change } } as Parameters<typeof buildOnlinePunchRequestV1>[0]).fingerprint)
      .not.toBe(buildOnlinePunchRequestV1(input).fingerprint)
  })
  it('canonicalizes nested object key order and isolates caller mutation', () => {
    const client = { ...input.client, meta: { a: 1, nested: { b: 2, c: 3 } } }
    const a = buildOnlinePunchRequestV1({ ...input, client })
    expect(a.fingerprint).toBe(buildOnlinePunchRequestV1({ ...input, client: { ...input.client, meta: { nested: { c: 3, b: 2 }, a: 1 } } }).fingerprint)
    client.meta.nested.b = 4
    expect(a.fingerprint).not.toBe(buildOnlinePunchRequestV1({ ...input, client }).fingerprint)
  })
  it('refuses an unbound actor and unknown client fields rather than inventing defaults', () => {
    expect(() => buildOnlinePunchRequestV1({ ...input, tokenSubjectUserId: 'other' })).toThrow('ATTENDANCE_OPERATION_CONFLICT')
    expect(() => buildOnlinePunchRequestV1({ ...input, client: { ...input.client, occurredAt: 'x' } } as unknown as Parameters<typeof buildOnlinePunchRequestV1>[0])).toThrow('ATTENDANCE_OPERATION_CONFLICT')
  })
  it('retains exact 200/202 full body and version', () => {
    expect(makeOnlinePunchReceiptV1(200, normal)).toEqual({ version: 'attendance-online-punch-v1', status: 200, body: normal })
    expect(makeOnlinePunchReceiptV1(202, outdoor)).toEqual({ version: 'attendance-online-punch-v1', status: 202, body: outdoor })
  })
  it.each([normal, {}, { version: 'old', status: 200, body: normal }, { version: 'attendance-online-punch-v1', status: 201, body: normal },
    { version: 'attendance-online-punch-v1', status: 200, body: outdoor }, { version: 'attendance-online-punch-v1', status: 202, body: normal },
    { version: 'attendance-online-punch-v1', status: 200, body: normal, extra: true },
  ])('refuses legacy or malformed frame %j', value => { expect(() => parseOnlinePunchReceiptV1(value)).toThrow('ATTENDANCE_OPERATION_CONFLICT') })
  it('classifies only the known operation claim primary key', () => {
    expect(isOnlinePunchClaimPrimaryKeyCollision({ code: '23505', constraint: 'pk_attendance_result_operations', table: 'attendance_result_operations' })).toBe(true)
    for (const error of [{ code: '23505' }, { code: '40001', constraint: 'pk_attendance_result_operations' }, { code: '23505', constraint: 'other' }, { code: '23505', constraint: 'pk_attendance_result_operations', table: 'other' }]) {
      expect(isOnlinePunchClaimPrimaryKeyCollision(error)).toBe(false)
    }
  })
  it('retries only the owned private collision and bounds fresh attempts', async () => {
    let attempts = 0
    await expect(retryOnlinePunchClaimV1(async () => { if (++attempts < 3) throw new OnlinePunchClaimCollisionError(); return 7 })).resolves.toBe(7)
    expect(attempts).toBe(3)
    attempts = 0
    await expect(retryOnlinePunchClaimV1(async () => { attempts++; throw new OnlinePunchClaimCollisionError() })).rejects.toThrow('ATTENDANCE_OPERATION_CONFLICT')
    expect(attempts).toBe(3)
    const raw = { code: '23505', constraint: 'pk_attendance_result_operations' }
    attempts = 0
    await expect(retryOnlinePunchClaimV1(async () => { attempts++; throw raw })).rejects.toBe(raw)
    expect(attempts).toBe(1)
  })
  it('a failed rollback after an owned collision is nonretryable and never starts a second transaction', async () => {
    let begins = 0
    const client = { query: async (sql: string) => {
      if (sql === 'SAVEPOINT w4c5_idle_probe') throw { code: '25P01' }
      if (sql.startsWith('BEGIN')) begins++
      if (sql === 'ROLLBACK') throw new Error('OWNED_ROLLBACK_FAILED')
      return { rows: [] }
    } }
    await expect(retryOnlinePunchClaimV1(() => runAttendanceResultOperationTransactionV1(client,
      async () => { throw new OnlinePunchClaimCollisionError() }))).rejects.toBeInstanceOf(OnlinePunchConnectionUncertainError)
    expect(begins).toBe(1)
  })

})
