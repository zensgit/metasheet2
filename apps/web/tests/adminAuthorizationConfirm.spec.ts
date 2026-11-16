import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import AdminAuthorizationConfirmDialog from '../src/views/AdminAuthorizationConfirmDialog.vue'
import {
  PLATFORM_ADMIN_AUTHORITY_NOTE,
  admissionChangesForRevoke,
  buildAdmissionEnableAuthorization,
  buildCreateUserAuthorization,
  buildRoleMembershipAuthorization,
  catalogPermissionCodesForRoles,
  readAdmissionNamespaceFact,
  readAdmissionNamespaceList,
  readExplicitNamespaceAdmissionCapability,
} from '../src/views/AdminAuthorizationConfirm'

function flush(): Promise<void> {
  return nextTick()
}

describe('admin authorization confirmation', () => {
  it('accepts explicit namespace admission only when the flag is exactly true', () => {
    expect(readExplicitNamespaceAdmissionCapability({ capabilities: { explicitNamespaceAdmission: true } })).toBe(true)
    expect(readExplicitNamespaceAdmissionCapability({ data: { capabilities: { explicitNamespaceAdmission: true } } })).toBe(true)
    expect(readExplicitNamespaceAdmissionCapability({ capabilities: { explicitNamespaceAdmission: 'true' } })).toBe(false)
    expect(readExplicitNamespaceAdmissionCapability({ capabilities: { explicitNamespaceAdmission: 1 } })).toBe(false)
    expect(readExplicitNamespaceAdmissionCapability({ capabilities: {} })).toBe(false)
    expect(readExplicitNamespaceAdmissionCapability(null)).toBe(false)
  })

  it('does not split permission codes into namespaces', () => {
    expect(readAdmissionNamespaceList([' crm:admin ', 'crm:admin', '', 12])).toEqual(['crm:admin'])
    expect(readAdmissionNamespaceList('crm:admin')).toEqual([])
    expect(readAdmissionNamespaceFact(['stock-prep'])).toEqual({ known: true, namespaces: ['stock-prep'] })
    expect(readAdmissionNamespaceFact([])).toEqual({ known: true, namespaces: [] })
    expect(readAdmissionNamespaceFact(undefined)).toEqual({ known: false, namespaces: [] })
  })

  it('treats missing admission metadata as unknown and closes only uncovered explicit namespaces', () => {
    expect(admissionChangesForRevoke('crm_admin', ['crm_admin'], {})).toEqual({ known: false, changes: [] })
    expect(admissionChangesForRevoke('crm_admin', ['crm_admin', 'other'], {
      crm_admin: ['stock-prep'],
      other: 'stock-prep',
    })).toEqual({ known: false, changes: [] })
    expect(admissionChangesForRevoke('crm_admin', ['crm_admin', 'finance_admin'], {
      crm_admin: ['stock-prep', 'crm'],
      finance_admin: ['crm'],
    })).toEqual({
      known: true,
      changes: [{ namespace: 'stock-prep', effect: 'may-close' }],
    })
    expect(admissionChangesForRevoke('crm_admin', ['crm_admin'], {
      crm_admin: [],
    })).toEqual({ known: true, changes: [] })
    expect(admissionChangesForRevoke('workshop_clerk', ['workshop_clerk'], {
      workshop_clerk: [],
    })).toEqual({ known: true, changes: [] })
  })

  it('previews attendance opt-out when an emptied attendance_employee role is removed', () => {
    expect(admissionChangesForRevoke('attendance_employee', ['attendance_employee'], {
      attendance_employee: [],
    })).toEqual({
      known: true,
      changes: [
        { namespace: 'attendance', effect: 'may-close' },
        { namespace: 'attendance', effect: 'source-opt-out' },
      ],
    })
    expect(admissionChangesForRevoke('attendance_employee', ['attendance_employee', 'attendance_admin'], {
      attendance_employee: [],
      attendance_admin: ['attendance'],
    })).toEqual({
      known: true,
      changes: [{ namespace: 'attendance', effect: 'source-opt-out' }],
    })
    expect(admissionChangesForRevoke('attendance_employee', ['attendance_employee'], {
      attendance_employee: ['attendance'],
    })).toEqual({
      known: true,
      changes: [
        { namespace: 'attendance', effect: 'may-close' },
        { namespace: 'attendance', effect: 'source-opt-out' },
      ],
    })
    expect(admissionChangesForRevoke('attendance_employee', ['attendance_employee', 'other'], {
      attendance_employee: [],
    })).toEqual({ known: false, changes: [] })

    const removal = buildRoleMembershipAuthorization({
      action: 'unassign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'attendance_employee',
      roleName: '考勤员工',
      permissionCodes: [],
      expectedUpdatedAt: null,
      heldRoleIds: ['attendance_employee'],
      heldRolesKnown: true,
      namespacesByRoleId: { attendance_employee: [] },
      dropdownRoleId: 'attendance_employee',
    })
    expect(removal.admissionKnown).toBe(true)
    expect(removal.admissionChanges).toEqual([
      { namespace: 'attendance', effect: 'may-close' },
      { namespace: 'attendance', effect: 'source-opt-out' },
    ])
    expect(removal.notes.join('\n')).toContain('可能会关闭对应的插件使用')
    expect(removal.notes.join('\n')).toContain('会记下默认角色已撤销，避免之后自动重新开通插件使用：attendance')
    expect(removal.notes.join('\n')).not.toContain('这次撤销不会关闭插件使用')
    expect(removal.requiresTypedPhrase).toBeNull()

    const custom = buildRoleMembershipAuthorization({
      action: 'unassign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'workshop_clerk',
      roleName: '车间文员',
      permissionCodes: [],
      expectedUpdatedAt: null,
      heldRoleIds: ['workshop_clerk'],
      heldRolesKnown: true,
      namespacesByRoleId: { workshop_clerk: [] },
      dropdownRoleId: 'workshop_clerk',
    })
    expect(custom.admissionKnown).toBe(true)
    expect(custom.admissionChanges).toEqual([])
    expect(custom.notes).toContain('按目前的角色目录，这次撤销不会关闭插件使用。')
    expect(custom.notes.join('\n')).not.toContain('会记下默认角色已撤销')
    expect(custom.fingerprint).not.toBe(removal.fingerprint)
  })

  it('keeps create notes in user language and explains an empty platform-admin permission list', () => {
    const created = buildCreateUserAuthorization({
      targetName: '林岚',
      roleId: 'admin',
      roleName: '平台管理员',
      directPermissionCodes: ['crm:read'],
      inheritedPermissionCodes: [],
      inheritedKnown: true,
      admissionNamespaces: [],
      createPayload: { name: '林岚', admissionNamespaces: [] },
    })
    expect(created.notes.join('\n')).toContain('创建后不会开通插件使用。')
    expect(created.notes.join('\n')).toContain(PLATFORM_ADMIN_AUTHORITY_NOTE)
    expect(created.notes.join('\n')).not.toContain('admissionNamespaces')
    expect(created.notes.join('\n')).not.toContain('前缀')
    expect(created.platformAdminAuthority).toBe(true)

    const removal = buildRoleMembershipAuthorization({
      action: 'unassign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'admin',
      roleName: '平台管理员',
      permissionCodes: [],
      expectedUpdatedAt: null,
      heldRoleIds: ['admin'],
      heldRolesKnown: false,
      namespacesByRoleId: { admin: [] },
      dropdownRoleId: '',
    })
    expect(removal.admissionKnown).toBe(false)
    expect(removal.inheritedKnown).toBe(true)
    expect(removal.notes).toContain('目前看不出这次会不会关闭插件使用。')
    expect(removal.notes).toContain(PLATFORM_ADMIN_AUTHORITY_NOTE)
    expect(removal.requiresTypedPhrase).toBe('取消平台管理员')

    const orphan = buildRoleMembershipAuthorization({
      action: 'unassign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'admin',
      roleName: '平台管理员',
      permissionCodes: ['should-not-render'],
      permissionKnown: false,
      expectedUpdatedAt: null,
      heldRoleIds: ['admin'],
      heldRolesKnown: true,
      namespacesByRoleId: {},
      dropdownRoleId: 'admin',
    })
    expect(orphan.kind).toBe('unassign-role')
    expect(orphan.inheritedKnown).toBe(false)
    expect(orphan.inheritedPermissionCodes).toEqual([])
    expect(orphan.requiresTypedPhrase).toBe('取消平台管理员')
    expect(orphan.notes.join('\n')).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
    expect(orphan.notes.join('\n')).not.toContain('should-not-render')
    expect(orphan.notes.join('\n')).not.toContain('下列权限码是这个角色会继承的权限。')
    const knownEmpty = buildRoleMembershipAuthorization({
      action: 'unassign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'admin',
      roleName: '平台管理员',
      permissionCodes: [],
      expectedUpdatedAt: null,
      heldRoleIds: ['admin'],
      heldRolesKnown: true,
      namespacesByRoleId: {},
      dropdownRoleId: 'admin',
    })
    expect(knownEmpty.inheritedKnown).toBe(true)
    expect(knownEmpty.fingerprint).not.toBe(orphan.fingerprint)
    const explicitKnown = buildRoleMembershipAuthorization({
      action: 'assign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'crm_admin',
      roleName: 'CRM',
      permissionCodes: ['crm:read'],
      permissionKnown: true,
      expectedUpdatedAt: null,
      heldRoleIds: [],
      heldRolesKnown: true,
      namespacesByRoleId: {},
      dropdownRoleId: 'crm_admin',
    })
    const omittedKnown = buildRoleMembershipAuthorization({
      action: 'assign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'crm_admin',
      roleName: 'CRM',
      permissionCodes: ['crm:read'],
      expectedUpdatedAt: null,
      heldRoleIds: [],
      heldRolesKnown: true,
      namespacesByRoleId: {},
      dropdownRoleId: 'crm_admin',
    })
    expect(explicitKnown.inheritedKnown).toBe(true)
    expect(explicitKnown.inheritedPermissionCodes).toEqual(['crm:read'])
    expect(explicitKnown.fingerprint).toBe(omittedKnown.fingerprint)

    const assign = buildRoleMembershipAuthorization({
      action: 'assign',
      userId: 'user-1',
      userName: 'Alpha',
      roleId: 'crm_admin',
      roleName: 'CRM',
      permissionCodes: ['crm:read'],
      expectedUpdatedAt: 'stamp-1',
      heldRoleIds: [],
      heldRolesKnown: true,
      namespacesByRoleId: { crm_admin: [] },
      dropdownRoleId: 'crm_admin',
    })
    const changedRole = buildRoleMembershipAuthorization({
      ...{
        action: 'assign' as const,
        userId: 'user-1',
        userName: 'Alpha',
        roleId: 'finance_admin',
        roleName: '财务',
        permissionCodes: ['crm:read'],
        expectedUpdatedAt: 'stamp-1',
        heldRoleIds: [],
        heldRolesKnown: true,
        namespacesByRoleId: { crm_admin: [] },
        dropdownRoleId: 'finance_admin',
      },
    })
    expect(assign.fingerprint).not.toBe(changedRole.fingerprint)
    const withNamespace = buildCreateUserAuthorization({
      targetName: '林岚',
      roleId: '',
      roleName: '',
      directPermissionCodes: [],
      inheritedPermissionCodes: [],
      inheritedKnown: true,
      admissionNamespaces: ['stock-prep'],
      createPayload: { admissionNamespaces: ['stock-prep'] },
    })
    const withoutNamespace = buildCreateUserAuthorization({
      targetName: '林岚',
      roleId: '',
      roleName: '',
      directPermissionCodes: [],
      inheritedPermissionCodes: [],
      inheritedKnown: true,
      admissionNamespaces: [],
      createPayload: { admissionNamespaces: [] },
    })
    expect(withNamespace.fingerprint).not.toBe(withoutNamespace.fingerprint)
  })

  it('uses only complete role-catalog permission arrays for admission enable', () => {
    expect(catalogPermissionCodesForRoles(['crm_admin', 'finance_admin'], {
      crm_admin: [' crm:read ', 'crm:read'],
      finance_admin: ['finance:read'],
    })).toEqual({ known: true, codes: ['crm:read', 'finance:read'] })
    expect(catalogPermissionCodesForRoles(['crm_admin'], { crm_admin: [] })).toEqual({ known: true, codes: [] })
    expect(catalogPermissionCodesForRoles([], { crm_admin: ['crm:read'] })).toEqual({ known: true, codes: [] })
    expect(catalogPermissionCodesForRoles(['missing'], { crm_admin: ['catalog:only'] })).toEqual({ known: false, codes: [] })
    expect(catalogPermissionCodesForRoles(['crm_admin'], { crm_admin: 'catalog:only' })).toEqual({ known: false, codes: [] })
    expect(catalogPermissionCodesForRoles(['crm_admin'], { crm_admin: ['catalog:only', 1] })).toEqual({ known: false, codes: [] })

    const unknown = buildAdmissionEnableAuthorization({
      userId: 'user-1',
      userName: 'Alpha',
      namespace: 'crm',
      roleIds: ['crm_admin', 'missing'],
      catalogPermissionsByRoleId: { crm_admin: ['catalog:only'] },
      dropdownRoleId: '',
    })
    expect(unknown.inheritedKnown).toBe(false)
    expect(unknown.inheritedPermissionCodes).toEqual([])
    expect(unknown.directPermissionCodes).toEqual([])
    expect(unknown.notes.join('\n')).toContain('角色目录不完整，不能把当前访问快照里的权限码说成角色继承。')
    expect(unknown.notes.join('\n')).not.toContain('catalog:only')
    expect(unknown.notes.join('\n')).not.toContain('aggregate:only')

    const known = buildAdmissionEnableAuthorization({
      userId: 'user-1',
      userName: 'Alpha',
      namespace: 'crm',
      roleIds: ['crm_admin'],
      catalogPermissionsByRoleId: { crm_admin: ['catalog:only'] },
      dropdownRoleId: 'crm_admin',
    })
    expect(known.inheritedKnown).toBe(true)
    expect(known.inheritedPermissionCodes).toEqual(['catalog:only'])
    expect(known.notes.join('\n')).toContain('下列权限码来自这些角色在角色目录中的清单。')
    const changedCatalog = buildAdmissionEnableAuthorization({
      userId: 'user-1',
      userName: 'Alpha',
      namespace: 'crm',
      roleIds: ['crm_admin'],
      catalogPermissionsByRoleId: { crm_admin: ['other:code'] },
      dropdownRoleId: 'crm_admin',
    })
    expect(known.fingerprint).not.toBe(changedCatalog.fingerprint)
  })

  describe('dialog keyboard and focus', () => {
    let host: HTMLElement | null = null
    let opener: HTMLButtonElement | null = null

    afterEach(() => {
      host?.remove()
      opener?.remove()
      host = null
      opener = null
    })

    function draft(admissionKnown: boolean) {
      return buildRoleMembershipAuthorization({
        action: 'unassign',
        userId: 'user-1',
        userName: 'Alpha',
        roleId: 'admin',
        roleName: '平台管理员',
        permissionCodes: [],
        expectedUpdatedAt: null,
        heldRoleIds: ['admin'],
        heldRolesKnown: admissionKnown,
        namespacesByRoleId: admissionKnown ? { admin: [] } : {},
        dropdownRoleId: '',
      })
    }

    async function mountDialog(admissionKnown: boolean): Promise<{ cancelled: { value: boolean } }> {
      opener = document.createElement('button')
      opener.type = 'button'
      opener.textContent = '打开'
      document.body.appendChild(opener)
      opener.focus()
      host = document.createElement('div')
      document.body.appendChild(host)
      const cancelled = { value: false }
      const dialogProps = {
        draft: draft(admissionKnown),
        phrase: '',
        busy: false,
        'onUpdate:phrase': () => undefined,
        onCancel: () => {
          cancelled.value = true
        },
        onConfirm: () => undefined,
      }
      const app = createApp(AdminAuthorizationConfirmDialog, dialogProps)
      app.mount(host)
      await flush()
      return { cancelled }
    }

    it('shows an orphan role unassign as unknown inherited permissions, not an empty list', async () => {
      opener = document.createElement('button')
      opener.type = 'button'
      document.body.appendChild(opener)
      opener.focus()
      host = document.createElement('div')
      document.body.appendChild(host)
      const dialogProps = {
        draft: buildRoleMembershipAuthorization({
          action: 'unassign',
          userId: 'user-1',
          userName: 'Alpha',
          roleId: 'admin',
          roleName: '平台管理员',
          permissionCodes: [],
          permissionKnown: false,
          expectedUpdatedAt: null,
          heldRoleIds: ['admin'],
          heldRolesKnown: true,
          namespacesByRoleId: { admin: [] },
          dropdownRoleId: 'admin',
        }),
        phrase: '',
        busy: false,
        'onUpdate:phrase': () => undefined,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }
      const app = createApp(AdminAuthorizationConfirmDialog, dialogProps)
      app.mount(host)
      try {
        await flush()
        const inherited = host.querySelector('[data-testid="admin-authorization-inherited-permissions"]')
        expect(inherited?.textContent).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
        expect(inherited?.textContent).not.toContain('无')
        expect(host.querySelector('[data-testid="admin-authorization-phrase"]')).toBeTruthy()
        const confirm = host.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
        expect(confirm.disabled).toBe(true)
      } finally {
        app.unmount()
      }
    })

    it('shows an emptied attendance_employee removal as a possible close and a recorded opt-out', async () => {
      host = document.createElement('div')
      document.body.appendChild(host)
      const dialogProps = {
        draft: buildRoleMembershipAuthorization({
          action: 'unassign',
          userId: 'user-1',
          userName: 'Alpha',
          roleId: 'attendance_employee',
          roleName: '考勤员工',
          permissionCodes: [],
          expectedUpdatedAt: null,
          heldRoleIds: ['attendance_employee'],
          heldRolesKnown: true,
          namespacesByRoleId: { attendance_employee: [] },
          dropdownRoleId: 'attendance_employee',
        }),
        phrase: '',
        busy: false,
        'onUpdate:phrase': () => undefined,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }
      const app = createApp(AdminAuthorizationConfirmDialog, dialogProps)
      app.mount(host)
      try {
        await flush()
        const admissions = host.querySelector('[data-testid="admin-authorization-admissions"]')
        expect(admissions?.textContent).toContain('可能会关闭插件使用：attendance')
        expect(admissions?.textContent).toContain('会记下默认角色已撤销，避免之后自动重新开通插件使用：attendance')
        expect(admissions?.textContent).not.toContain('不会改变插件使用')
        expect(host.textContent).not.toContain('这次撤销不会关闭插件使用')
      } finally {
        app.unmount()
      }
    })

    it('explains empty platform-admin authority and unknown admission, then traps focus', async () => {
      const { cancelled } = await mountDialog(false)
      const dialog = host?.querySelector('[data-testid="admin-authorization-dialog"]') as HTMLElement | null
      expect(dialog).toBeTruthy()
      expect(document.activeElement).toBe(dialog)
      expect(host?.querySelector('[data-testid="admin-authorization-platform-admin"]')?.textContent).toContain('权限码列表即使为空')
      const unknown = host?.querySelector('[data-testid="admin-authorization-admissions-unknown"]')
      expect(unknown?.textContent?.trim()).toBe('目前看不出这次会不会改变插件使用。')
      expect(host?.textContent).not.toContain('按目前的角色目录，这次撤销不会关闭插件使用。')
      const admissionText = host?.querySelector('[data-testid="admin-authorization-admissions"]')?.textContent || ''
      expect(admissionText.replace('目前看不出这次会不会改变插件使用。', '')).not.toContain('不会改变插件使用')

      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      const phrase = host?.querySelector('[data-testid="admin-authorization-phrase"]')
      expect(document.activeElement).toBe(phrase)

      const cancel = host?.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement
      cancel.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      expect(document.activeElement).toBe(phrase)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(cancelled.value).toBe(true)
    })

    it('restores focus to the opener when the dialog closes', async () => {
      opener = document.createElement('button')
      opener.type = 'button'
      document.body.appendChild(opener)
      opener.focus()
      host = document.createElement('div')
      document.body.appendChild(host)
      const app = createApp({
        components: { AdminAuthorizationConfirmDialog },
        data: () => ({ open: true, draft: draft(true), phrase: '' }),
        template: `
          <AdminAuthorizationConfirmDialog
            v-if="open"
            :draft="draft"
            :phrase="phrase"
            :busy="false"
            @cancel="open = false"
          />
        `,
      })
      const vm = app.mount(host) as unknown as { open: boolean }
      await flush()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      vm.open = false
      await flush()
      expect(host.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
      expect(document.activeElement).toBe(opener)
    })
  })
})
