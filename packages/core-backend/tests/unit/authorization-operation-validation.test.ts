import { describe, expect, it } from 'vitest'
import { parseAuthorizationOperation } from '../../src/admin/authorization-operation-validation'

const base = { targetUserId: 'user-1', action: { kind: 'role.assign', roleId: 'attendance_member' }, admissionChanges: [] }
const commit = { ...base, clientOperationId: '00000000-0000-4000-8000-000000000001', expectedVersion: `opaque-v1:${'a'.repeat(64)}` }

describe('authorization operation request schema', () => {
  it('normalizes only reason and sorts explicitly chosen admissions', () => {
    expect(parseAuthorizationOperation({ ...base, reason: '  example  ', admissionChanges: [{ namespace: 'y', enabled: false }, { namespace: 'x', enabled: true }] }, false)).toEqual({ ...base, reason: 'example', admissionChanges: [{ namespace: 'x', enabled: true }, { namespace: 'y', enabled: false }] })
    expect(parseAuthorizationOperation(commit, true)).toEqual(commit)
  })
  it.each([
    null, { ...base, extra: true }, { ...base, targetUserId: ' x ' }, { ...base, targetUserId: '' },
    { ...base, targetUserId: 'x'.repeat(256) }, { ...base, action: { kind: 'bogus', roleId: 'x' } },
    { ...base, action: { kind: 'role.assign', roleId: '' } }, { ...base, action: { kind: 'role.assign', roleId: 'x', extra: true } },
    { ...base, action: { kind: 'admission.set', roleId: 'x' }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }, { ...base, action: { kind: 'admission.set' } },
    { ...base, admissionChanges: undefined }, { ...base, admissionChanges: Array.from({ length: 21 }, (_, i) => ({ namespace: `n${i}`, enabled: true })) },
    { ...base, admissionChanges: [{ namespace: 'x', enabled: true }, { namespace: 'x', enabled: false }] },
    { ...base, admissionChanges: [{ namespace: 'roles', enabled: true }] }, { ...base, admissionChanges: [{ namespace: ' x ', enabled: true }] },
    { ...base, admissionChanges: [{ namespace: 'x', enabled: 'true' }] }, { ...base, admissionChanges: [{ namespace: 'x', enabled: true, extra: true }] },
    { ...base, reason: '' }, { ...base, reason: 4 }, { ...base, reason: '😀'.repeat(256) },
  ])('rejects an invalid preview request %#', (input) => {
    expect(() => parseAuthorizationOperation(input, false)).toThrowError(expect.objectContaining({ code: 'INVALID_AUTHORIZATION_OPERATION' }))
  })
  it.each([
    { ...commit, clientOperationId: 'bad' }, { ...commit, clientOperationId: commit.clientOperationId.toUpperCase().replace('A', 'B') + 'x' },
    { ...commit, expectedVersion: 'opaque-v1:bad' }, { ...commit, extra: 1 },
  ])('rejects an invalid commit request %#', (input) => {
    expect(() => parseAuthorizationOperation(input, true)).toThrowError(expect.objectContaining({ code: 'INVALID_AUTHORIZATION_OPERATION' }))
  })
  it('rejects oversized input before parsing it', () => {
    expect(() => parseAuthorizationOperation({ ...base, reason: 'x'.repeat(33000) }, false)).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_OPERATION_TOO_LARGE' }))
  })
  it('accepts standalone explicit admission and a 255-codepoint reason', () => {
    expect(parseAuthorizationOperation({ ...base, action: { kind: 'admission.set' }, admissionChanges: [{ namespace: 'attendance', enabled: false }], reason: '😀'.repeat(255) }, false).reason).toHaveLength(510)
  })
})
