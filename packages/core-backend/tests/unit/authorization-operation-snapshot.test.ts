import { describe, expect, it } from 'vitest'
import { operationVersion } from '../../src/admin/authorization-operation-snapshot'
import type { OperationSnapshot } from '../../src/admin/authorization-operation-snapshot'

const input = { targetUserId: 'target', action: { kind: 'admission.set' as const }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }
const snapshot: OperationSnapshot = {
  actor: { id: 'actor', role: 'admin', is_active: true }, target: { id: 'target', role: 'user' },
  memberships: [], roles: [], rolePermissions: [], direct: [], admissions: [], departmentScopes: [], groupScopes: [],
  exactDepartment: 'false', policy: { roleNamespaces: [], codeNamespaces: [{ code: 'attendance:read', namespace: 'attendance' }] },
}
describe('operation version witness', () => {
  it('binds the acting principal, complete input, policy classification, feature value and source rows', () => {
    const original = operationVersion('actor', input, snapshot)
    expect(operationVersion('other', input, snapshot)).not.toBe(original)
    expect(operationVersion('actor', { ...input, reason: 'changed' }, snapshot)).not.toBe(original)
    expect(operationVersion('actor', input, { ...snapshot, policy: { ...snapshot.policy, codeNamespaces: [{ code: 'attendance:read', namespace: null }] } })).not.toBe(original)
    expect(operationVersion('actor', input, { ...snapshot, exactDepartment: null })).not.toBe(original)
    expect(operationVersion('actor', input, { ...snapshot, direct: [{ permission_code: 'attendance:read' }] })).not.toBe(original)
  })
})
