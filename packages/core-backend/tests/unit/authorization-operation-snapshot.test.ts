import { describe, expect, it } from 'vitest'
import { expectedDelegationActivationReset, operationVersion } from '../../src/admin/authorization-operation-snapshot'
import type { OperationSnapshot } from '../../src/admin/authorization-operation-snapshot'

const input = { targetUserId: 'target', action: { kind: 'admission.set' as const }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }
const snapshot: OperationSnapshot = {
  actor: { id: 'actor', role: 'admin', is_active: true }, target: { id: 'target', role: 'user' },
  memberships: [], roles: [], rolePermissions: [], direct: [], admissions: [], departmentScopes: [], groupScopes: [],
  requestedCodes: [], permissionCatalog: [], template: null, delegatedWitness: null,
  delegationActivations: [], delegationActivationEnabled: false,
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

  it('invalidates a preview after a disable and re-enable even if the original configured range is unchanged', () => {
    const activation = { admin_user_id: 'actor', namespace: 'attendance', enabled: true, revision: 'first' }
    const before = { ...snapshot, delegationActivations: [activation] }
    const after = { ...snapshot, delegationActivations: [{ ...activation, revision: 'later' }] }
    expect(operationVersion('actor', input, before)).not.toBe(operationVersion('actor', input, after))
  })
})

describe('delegation lifecycle on role changes', () => {
  const roleId = 'attendance_admin'
  const assign = { ...input, action: { kind: 'role.assign' as const, roleId } }
  const revoke = { ...input, action: { kind: 'role.revoke' as const, roleId } }
  const membership = { user_id: 'target', role_id: roleId }
  const activation = { admin_user_id: 'target', namespace: 'attendance', enabled: true, revision: 'earlier' }

  it('only creates new activation state during rollout and keeps existing managed subjects disabled afterward', () => {
    expect(expectedDelegationActivationReset(assign, snapshot)).toBeNull()
    expect(expectedDelegationActivationReset(assign, { ...snapshot, delegationActivationEnabled: true })).toBe('attendance')
    expect(expectedDelegationActivationReset(assign, { ...snapshot, delegationActivations: [{ ...activation, admin_user_id: 'actor' }] })).toBeNull()
    expect(expectedDelegationActivationReset(revoke, { ...snapshot, memberships: [membership], delegationActivations: [activation] })).toBe('attendance')
    expect(expectedDelegationActivationReset(assign, { ...snapshot, delegationActivations: [{ ...activation, enabled: false }] })).toBe('attendance')
  })

  it('keeps activation state when the role is already held or the same namespace still has another role', () => {
    const managed = { ...snapshot, memberships: [membership], delegationActivations: [activation] }
    const historical = { ...membership, role_id: `${roleId} ` }
    expect(expectedDelegationActivationReset(assign, managed)).toBeNull()
    expect(expectedDelegationActivationReset(assign, { ...managed, memberships: [historical] })).toBeNull()
    expect(expectedDelegationActivationReset(revoke, { ...managed, memberships: [membership, historical] })).toBeNull()
    expect(expectedDelegationActivationReset(revoke, { ...managed, memberships: [] })).toBeNull()
  })
})
