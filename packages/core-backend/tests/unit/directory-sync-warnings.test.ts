import { describe, expect, it } from 'vitest'
import {
  buildDirectoryIntegrationDiagnosticSummary,
  buildDirectoryIntegrationTestWarnings,
} from '../../src/directory/directory-sync'

describe('buildDirectoryIntegrationTestWarnings', () => {
  it('keeps scope warnings when the root department returns no child departments', () => {
    expect(
      buildDirectoryIntegrationTestWarnings({
        rootDepartmentId: '1',
        departmentSampleCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
      }),
    ).toEqual([
      '根部门 1 未返回任何子部门。',
      '根部门 1 当前仅返回 1 个直属成员；如果钉钉企业通讯录里实际成员更多，通常是应用通讯录接口范围未覆盖，或根部门 ID 配置不正确。',
      '开启“包含访问受限成员”后返回结果没有变化，说明当前问题不是受限成员过滤导致的。',
    ])
  })

  it('suppresses root-member warnings when child departments are present', () => {
    expect(
      buildDirectoryIntegrationTestWarnings({
        rootDepartmentId: '1',
        departmentSampleCount: 4,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
      }),
    ).toEqual([])
  })
})

describe('buildDirectoryIntegrationDiagnosticSummary', () => {
  it('flags scope/root misconfiguration when no child departments and sparse root members', () => {
    expect(
      buildDirectoryIntegrationDiagnosticSummary({
        departmentSampleCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
      }),
    ).toEqual({
      code: 'scope_or_root_misconfigured',
      title: '通讯录范围或根部门疑似配置不当',
      nextAction: '请检查应用「通讯录管理」权限范围是否覆盖全员，并确认根部门 ID 是否正确。',
    })
  })

  it('reports missing child departments when root members look healthy', () => {
    expect(
      buildDirectoryIntegrationDiagnosticSummary({
        departmentSampleCount: 0,
        rootDepartmentDirectUserCount: 42,
        rootDepartmentDirectUserHasMore: true,
      }),
    ).toEqual({
      code: 'no_child_departments',
      title: '根部门未返回子部门',
      nextAction: '如企业通讯录确有部门层级，请检查应用通讯录可见范围配置。',
    })
  })

  it('reports healthy connectivity when child departments are present', () => {
    expect(
      buildDirectoryIntegrationDiagnosticSummary({
        departmentSampleCount: 4,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
      }),
    ).toEqual({
      code: 'healthy',
      title: '通讯录连通正常',
      nextAction: '通讯录范围正常，可执行目录同步。',
    })
  })
})
