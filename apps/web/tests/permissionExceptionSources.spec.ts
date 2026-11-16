import { describe, expect, it } from 'vitest'
import {
  PERMISSION_EXCEPTION_OBJECT_NOTE,
  describePermissionExceptionConfirm,
  describePermissionExceptionInheritedSources,
  describePermissionExceptionLegacyRevoke,
  permissionExceptionRoleRemovalHref,
  readPermissionExceptionInheritedRoles,
  readPermissionExceptionLegacyRevokeAcknowledgement,
} from '../src/views/permissionExceptionSources'

describe('permissionExceptionSources', () => {
  it('keeps orphan roles and refuses to invent a role id', () => {
    expect(readPermissionExceptionInheritedRoles(undefined)).toBeNull()
    expect(readPermissionExceptionInheritedRoles([{ roleName: '现场角色', permissions: ['crm:read'] }])).toBeNull()
    expect(readPermissionExceptionInheritedRoles([
      { roleId: 'role-orphan', roleName: null, permissions: ['crm:read'] },
    ])).toEqual([
      { roleId: 'role-orphan', roleName: null, nameKnown: false, permissions: ['crm:read'] },
    ])
    expect(permissionExceptionRoleRemovalHref('role 1', 'user 1')).toBe('/admin/roles?roleId=role+1&userId=user+1')
    expect(describePermissionExceptionInheritedSources({
      userId: 'user-1',
      readable: true,
      inheritedRoles: null,
    }).mode).toBe('generic')
  })

  it('requires changed:true on the same user and code before a legacy clear counts', () => {
    expect(readPermissionExceptionLegacyRevokeAcknowledgement(
      { success: true, userId: 'user-1', permission: 'crm:read' },
      'user-1',
      'crm:read',
    ).accepted).toBe(false)
    expect(readPermissionExceptionLegacyRevokeAcknowledgement(
      { success: true, userId: 'user-1', permission: 'crm:read', changed: true },
      'user-1',
      'crm:read',
    ).accepted).toBe(true)
    const retained = describePermissionExceptionLegacyRevoke({
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'crm:read',
      ok: true,
      writeAcknowledged: true,
      inspection: {
        degraded: false,
        subjectMatched: true,
        sourceKnown: true,
        direct: ['crm:read'],
        inherited: ['crm:read'],
        legacy: [],
      },
    })
    expect(retained.tone).toBe('info')
    expect(retained.message).toContain('crm:read')
    expect(retained.message).toContain('历史授权')
    expect(retained.message).toContain('直接授权')
    expect(retained.message).toContain('角色继承')
    expect(retained.message).toContain('平台管理员身份')
    expect(retained.message).toContain('插件准入')
    expect(retained.message).toContain('不是整项权限的总撤销')
    expect(retained.message).not.toContain('users.permissions')
    expect(retained.message).not.toContain('changed:true')
    expect(retained.message).not.toContain('规范化')
    expect(retained.offerReadOnlyReread).toBe(false)

    const conflict = describePermissionExceptionLegacyRevoke({
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'crm:read',
      ok: false,
      httpStatus: 409,
      errorMessage: 'Legacy permission conflict',
    })
    expect(conflict.offerReadOnlyReread).toBe(false)
    expect(conflict.message).toContain('没有清除')
    expect(conflict.message).toContain('409')
    expect(conflict.message).not.toContain('未能确认清除结果')

    for (const httpStatus of [undefined, 500]) {
      const unknown = describePermissionExceptionLegacyRevoke({
        requestedUserId: 'user-1',
        selectedUserId: 'user-1',
        permission: 'crm:read',
        ok: false,
        httpStatus,
        errorMessage: 'boom',
      })
      expect(unknown.applyInspection).toBe(false)
      expect(unknown.offerReadOnlyReread).toBe(true)
      expect(unknown.message).toContain('未能确认清除结果')
      expect(unknown.message).toContain('crm:read')
      expect(unknown.message).toContain('只读重新读取')
      expect(unknown.message).not.toContain('没有清除')
      expect(unknown.message).not.toContain('已清除')
      expect(unknown.message).not.toContain('boom')
    }
  })

  it('freezes the confirmed direct codes and says roles and admissions stay unchanged', () => {
    const summary = describePermissionExceptionConfirm({
      kind: 'template',
      userId: 'user-1',
      userLabel: 'Alpha',
      templateId: 'tpl-1',
      templateName: '现场模板',
      permissions: ['workflow:read', 'crm:read'],
    }).summary
    expect(summary).toContain('workflow:read、crm:read')
    expect(summary).toContain('角色不会改变')
    expect(summary).toContain('准入不会改变')
    expect(summary).toContain('插件准入不会改变')
    expect(summary).toContain('参考角色（不会分配）')
    expect(PERMISSION_EXCEPTION_OBJECT_NOTE).toContain('权限管理')
    expect(PERMISSION_EXCEPTION_OBJECT_NOTE).toContain('记录详情')
    expect(PERMISSION_EXCEPTION_OBJECT_NOTE).not.toContain('数据表编号')
    expect(PERMISSION_EXCEPTION_OBJECT_NOTE).not.toContain('全局对象权限接口')
  })
})
