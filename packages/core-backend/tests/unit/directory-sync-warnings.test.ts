import { describe, expect, it } from 'vitest'
import { buildDirectoryIntegrationTestWarnings } from '../../src/directory/directory-sync'

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
