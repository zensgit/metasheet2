import { describe, expect, it } from 'vitest'

import {
  buildPluginPermissionCode,
  buildPluginRoleId,
  buildPluginRoleSeeds,
} from '../../src/rbac/plugin-role-template'

describe('plugin-role-template', () => {
  it('builds normalized role ids and permission codes', () => {
    expect(buildPluginRoleId('PLM Workbench', 'admin')).toBe('plm_workbench_admin')
    expect(buildPluginPermissionCode('PLM Workbench', 'Admin')).toBe('plm-workbench:admin')
  })

  it('builds viewer operator admin seeds with default actions', () => {
    expect(buildPluginRoleSeeds({
      pluginId: 'crm',
      displayName: 'CRM',
    })).toEqual([
      {
        id: 'crm_viewer',
        name: 'CRM Viewer',
        permissions: ['crm:read'],
        legacyRole: 'user',
      },
      {
        id: 'crm_operator',
        name: 'CRM Operator',
        permissions: ['crm:read', 'crm:write'],
        legacyRole: 'user',
      },
      {
        id: 'crm_admin',
        name: 'CRM Admin',
        permissions: ['crm:read', 'crm:write', 'crm:admin'],
        legacyRole: 'user',
      },
    ])
  })

  it('supports custom action sets and optional roles', () => {
    expect(buildPluginRoleSeeds({
      pluginId: 'qa-center',
      displayName: 'QA Center',
      includeViewer: false,
      operatorActions: ['read', 'approve'],
      adminActions: ['read', 'approve', 'admin'],
    })).toEqual([
      {
        id: 'qa_center_operator',
        name: 'QA Center Operator',
        permissions: ['qa-center:read', 'qa-center:approve'],
        legacyRole: 'user',
      },
      {
        id: 'qa_center_admin',
        name: 'QA Center Admin',
        permissions: ['qa-center:read', 'qa-center:approve', 'qa-center:admin'],
        legacyRole: 'user',
      },
    ])
  })
})
