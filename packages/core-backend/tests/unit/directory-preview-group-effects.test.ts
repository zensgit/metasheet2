import { describe, expect, it } from 'vitest'
import { orderDirectoryMatchingAccounts } from '../../src/directory/directory-sync-match-state'
import {
  projectDirectoryPreviewGroupEffects,
  type DirectoryPreviewGroupEffectsInput,
} from '../../src/directory/directory-preview-group-effects'

const empty: DirectoryPreviewGroupEffectsInput = {
  plans: [],
  grantSet: { userIds: [], roleIds: [], namespaces: [] },
  existingGroups: [],
  members: [],
  rolePairs: [],
  namespacePairs: [],
}

describe('projectDirectoryPreviewGroupEffects', () => {
  it('returns exactly six zero counts without plans, even with supplied grants', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      grantSet: { userIds: ['user-1'], roleIds: ['role-1'], namespaces: ['sales'] },
    })).toEqual({
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 0,
      wouldAddMemberGroupMemberships: 0,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('creates a group and adds only distinct desired members', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['user-1', 'user-1', 'user-2'] }],
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 2,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('diffs existing members and leaves unrelated groups alone', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['kept', 'added'] }],
      existingGroups: [{ id: 'group-1', description: 'dept-1' }],
      members: [
        { groupId: 'group-1', userId: 'kept' },
        { groupId: 'group-1', userId: 'removed' },
        { groupId: 'group-1', userId: 'removed' },
        { groupId: 'unrelated', userId: 'other' },
      ],
    })).toEqual({
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 1,
      wouldRemoveMemberGroupMemberships: 1,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('counts a sync but no changes for an unchanged existing group', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['user-1'] }],
      existingGroups: [{ id: 'group-1', description: 'dept-1' }],
      members: [{ groupId: 'group-1', userId: 'user-1' }],
    })).toEqual({
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 0,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('counts overlapping memberships separately and grants distinct subjects once', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [
        { marker: 'dept-1', memberUserIds: ['existing:1', 'new:1'] },
        { marker: 'dept-2', memberUserIds: ['new:1', 'new:2'] },
      ],
      grantSet: {
        userIds: ['existing:1', 'new:1', 'new:2', 'new:1'],
        roleIds: ['role-1', 'role-1'],
        namespaces: ['sales', 'sales'],
      },
    })).toEqual({
      wouldCreateMemberGroups: 2,
      wouldSyncMemberGroups: 2,
      wouldAddMemberGroupMemberships: 4,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 3,
      wouldAdmitNamespaces: 3,
    })
  })

  it('reuses a newly created marker and sequentially diffs every duplicate plan', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [
        { marker: 'dept-1', memberUserIds: ['user-1', 'user-2'] },
        { marker: 'dept-1', memberUserIds: ['user-2', 'user-3'] },
        { marker: 'dept-1', memberUserIds: ['user-2', 'user-3'] },
        { marker: 'dept-1', memberUserIds: [] },
      ],
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 4,
      wouldAddMemberGroupMemberships: 3,
      wouldRemoveMemberGroupMemberships: 3,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('uses the last existing row for a marker and reuses its updated member set', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [
        { marker: 'dept-1', memberUserIds: ['user-2'] },
        { marker: 'dept-1', memberUserIds: ['user-2', 'user-3'] },
      ],
      existingGroups: [
        { id: 'first', description: 'dept-1' },
        { id: 'last', description: 'dept-1' },
      ],
      members: [
        { groupId: 'first', userId: 'user-1' },
        { groupId: 'last', userId: 'user-2' },
      ],
    })).toEqual({
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 2,
      wouldAddMemberGroupMemberships: 1,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('counts missing role pairs rather than users or requested pair totals', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['user-1', 'user-2'] }],
      grantSet: { userIds: ['user-1', 'user-2'], roleIds: ['role-1', 'role-2'], namespaces: [] },
      rolePairs: [
        { userId: 'user-1', roleId: 'role-1' },
        { userId: 'user-1', roleId: 'role-1' },
        { userId: 'other', roleId: 'role-2' },
      ],
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 2,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 3,
      wouldAdmitNamespaces: 0,
    })
  })

  it('counts disabled and absent namespaces but skips enabled pairs', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['user-1'] }],
      grantSet: { userIds: ['user-1'], roleIds: [], namespaces: ['enabled', 'disabled', 'absent'] },
      namespacePairs: [
        { userId: 'user-1', namespace: 'enabled', enabled: true },
        { userId: 'user-1', namespace: 'disabled', enabled: false },
        { userId: 'other', namespace: 'absent', enabled: true },
      ],
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 1,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 2,
    })
  })

  it.each([
    { userIds: [], roleIds: ['role-1'], namespaces: ['sales'] },
    { userIds: ['user-1'], roleIds: [], namespaces: [] },
  ])('preserves group effects when governance returns early: %j', (grantSet) => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['user-1'] }],
      grantSet,
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 1,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('removes group membership without revoking existing roles or namespaces', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: [] }],
      existingGroups: [{ id: 'group-1', description: 'dept-1' }],
      members: [{ groupId: 'group-1', userId: 'user-1' }],
      grantSet: { userIds: [], roleIds: ['role-1'], namespaces: ['sales'] },
      rolePairs: [{ userId: 'user-1', roleId: 'role-1' }],
      namespacePairs: [{ userId: 'user-1', namespace: 'sales', enabled: true }],
    })).toEqual({
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 0,
      wouldRemoveMemberGroupMemberships: 1,
      wouldAssignRoles: 0,
      wouldAdmitNamespaces: 0,
    })
  })

  it('keeps opaque IDs and collision-prone role and namespace pairs distinct', () => {
    expect(projectDirectoryPreviewGroupEffects({
      ...empty,
      plans: [{ marker: 'dept-1', memberUserIds: ['a:b', 'a'] }],
      grantSet: { userIds: ['a:b', 'a'], roleIds: ['c', 'b:c'], namespaces: ['c', 'b:c'] },
      rolePairs: [{ userId: 'a:b', roleId: 'c' }],
      namespacePairs: [{ userId: 'a:b', namespace: 'c', enabled: true }],
    })).toEqual({
      wouldCreateMemberGroups: 1,
      wouldSyncMemberGroups: 1,
      wouldAddMemberGroupMemberships: 2,
      wouldRemoveMemberGroupMemberships: 0,
      wouldAssignRoles: 3,
      wouldAdmitNamespaces: 3,
    })
  })

  it('does not mutate any input or retain state between calls', () => {
    const input: DirectoryPreviewGroupEffectsInput = {
      plans: [
        { marker: 'dept-1', memberUserIds: ['user-2', 'user-2'] },
        { marker: 'dept-1', memberUserIds: ['user-3'] },
      ],
      grantSet: { userIds: ['user-2', 'user-3'], roleIds: ['role-1'], namespaces: ['sales'] },
      existingGroups: [{ id: 'group-1', description: 'dept-1' }],
      members: [{ groupId: 'group-1', userId: 'user-1' }],
      rolePairs: [{ userId: 'user-2', roleId: 'role-1' }],
      namespacePairs: [{ userId: 'user-2', namespace: 'sales', enabled: false }],
    }
    const before = structuredClone(input)
    const expected = {
      wouldCreateMemberGroups: 0,
      wouldSyncMemberGroups: 2,
      wouldAddMemberGroupMemberships: 2,
      wouldRemoveMemberGroupMemberships: 2,
      wouldAssignRoles: 1,
      wouldAdmitNamespaces: 2,
    }
    expect(projectDirectoryPreviewGroupEffects(input)).toEqual(expected)
    expect(input).toEqual(before)
    expect(projectDirectoryPreviewGroupEffects(input)).toEqual(expected)
    expect(input).toEqual(before)
  })
})

describe('directory preview deterministic walk', () => {
  it('uses binary external-user ID order for mixed-case and non-ASCII identifiers', () => {
    const ids = ['z', 'a', 'é', 'A', 'a:2', 'a:10']
    expect(orderDirectoryMatchingAccounts(ids.map(external_user_id => ({ external_user_id })))
      .map(account => account.external_user_id)).toEqual(['A', 'a', 'a:10', 'a:2', 'z', 'é'])
  })
  it('copies the input and retains equal-key account identity in stable order', () => {
    const first = { external_user_id: 'same', subject: 'first' }
    const second = { external_user_id: 'same', subject: 'second' }
    const accounts = [first, second], ordered = orderDirectoryMatchingAccounts(accounts)
    expect(ordered).not.toBe(accounts)
    expect(ordered).toEqual([first, second])
    expect(ordered[0]).toBe(first)
    expect(ordered[1]).toBe(second)
    expect(accounts).toEqual([first, second])
  })
})
