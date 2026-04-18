import { describe, expect, it } from 'vitest'
import {
  buildDirectoryProjectedGovernanceGrantSet,
  buildDirectoryProjectedMemberGroupPlans,
} from '../../src/directory/directory-sync'

describe('directory member-group projection', () => {
  it('projects a selected department subtree to linked local users', () => {
    const departments = new Map([
      ['dept-root', { id: 'dept-root', parentId: null, name: '总部' }],
      ['dept-sales', { id: 'dept-sales', parentId: 'dept-root', name: '销售' }],
      ['dept-sales-east', { id: 'dept-sales-east', parentId: 'dept-sales', name: '华东销售' }],
      ['dept-finance', { id: 'dept-finance', parentId: 'dept-root', name: '财务' }],
    ])

    const plans = buildDirectoryProjectedMemberGroupPlans({
      integrationId: 'dir-1',
      integrationName: 'DingTalk CN',
      memberGroupSyncMode: 'sync_scoped_departments',
      memberGroupDepartmentIds: ['dept-sales'],
      departments,
      departmentPathMap: new Map([
        ['dept-root', '总部'],
        ['dept-sales', '总部 / 销售'],
        ['dept-sales-east', '总部 / 销售 / 华东销售'],
        ['dept-finance', '总部 / 财务'],
      ]),
      userDepartmentIdsByExternalUserId: new Map([
        ['ext-1', ['dept-sales']],
        ['ext-2', ['dept-sales-east']],
        ['ext-3', ['dept-finance']],
      ]),
      linkedUserIdByExternalUserId: new Map([
        ['ext-1', 'user-1'],
        ['ext-2', 'user-2'],
        ['ext-3', 'user-3'],
      ]),
    })

    expect(plans).toEqual([
      {
        externalDepartmentId: 'dept-sales',
        marker: 'dingtalk-sync-group:dir-1:dept-sales',
        name: '钉钉同步 · DingTalk CN · 总部 / 销售',
        memberUserIds: ['user-1', 'user-2'],
      },
    ])
  })

  it('returns no plans when member-group projection is disabled', () => {
    const plans = buildDirectoryProjectedMemberGroupPlans({
      integrationId: 'dir-1',
      integrationName: 'DingTalk CN',
      memberGroupSyncMode: 'disabled',
      memberGroupDepartmentIds: ['dept-sales'],
      departments: new Map([
        ['dept-sales', { id: 'dept-sales', parentId: null, name: '销售' }],
      ]),
      departmentPathMap: new Map([
        ['dept-sales', '销售'],
      ]),
      userDepartmentIdsByExternalUserId: new Map([
        ['ext-1', ['dept-sales']],
      ]),
      linkedUserIdByExternalUserId: new Map([
        ['ext-1', 'user-1'],
      ]),
    })

    expect(plans).toEqual([])
  })

  it('builds a deduplicated governance grant set for projected member groups', () => {
    const grantSet = buildDirectoryProjectedGovernanceGrantSet({
      plans: [
        {
          externalDepartmentId: 'dept-sales',
          marker: 'marker-1',
          name: '销售',
          memberUserIds: ['user-1', 'user-2'],
        },
        {
          externalDepartmentId: 'dept-sales-east',
          marker: 'marker-2',
          name: '华东销售',
          memberUserIds: ['user-2', 'user-3'],
        },
      ],
      defaultRoleIds: ['crm_user', 'crm_user', 'sales_user'],
      defaultNamespaces: ['crm', 'crm', 'sales'],
    })

    expect(grantSet).toEqual({
      userIds: ['user-1', 'user-2', 'user-3'],
      roleIds: ['crm_user', 'sales_user'],
      namespaces: ['crm', 'sales'],
    })
  })
})
