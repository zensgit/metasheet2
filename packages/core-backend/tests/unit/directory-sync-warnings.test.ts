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
      '开启“包含访问受限成员”后，根部门抽样的成员数量与分页标记没有变化；仅凭这一点不能判断成员偏少的原因。',
    ])
  })

  it('never claims the access-limited comparison rules out a cause', () => {
    const warnings = buildDirectoryIntegrationTestWarnings({
      rootDepartmentId: '1',
      departmentSampleCount: 0,
      rootDepartmentDirectUserCount: 0,
      rootDepartmentDirectUserHasMore: false,
      rootDepartmentDirectUserCountWithAccessLimit: 0,
      rootDepartmentDirectUserHasMoreWithAccessLimit: false,
    })
    expect(warnings.join('\n')).not.toContain('不是受限成员过滤')
    expect(warnings.join('\n')).not.toContain('说明当前问题')
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
      nextAction: '请按预期的同步范围核对应用通讯录权限范围与根部门 ID；正常的叶子部门或小范围目录也可能出现此结果。本次只验证了已抽样的接口，未验证全员可见范围、所有成员详情或扫码登录。',
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
      nextAction: '如企业通讯录确有部门层级，请检查应用通讯录可见范围配置。本次只验证了已抽样的接口，未验证全员可见范围、所有成员详情或扫码登录。',
    })
  })

  it('reports only the sampled list reads as healthy when child departments are present', () => {
    expect(
      buildDirectoryIntegrationDiagnosticSummary({
        departmentSampleCount: 4,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
      }),
    ).toEqual({
      code: 'healthy',
      title: '部门与成员列表抽样读取成功',
      nextAction: '本次只验证了已抽样的接口，未验证全员可见范围、所有成员详情或扫码登录。',
    })
  })

  it('never claims full coverage nor asks to widen the scope to everyone, and never mentions member detail', () => {
    const inputs = [
      { departmentSampleCount: 0, rootDepartmentDirectUserCount: 0, rootDepartmentDirectUserHasMore: false },
      { departmentSampleCount: 0, rootDepartmentDirectUserCount: 42, rootDepartmentDirectUserHasMore: true },
      { departmentSampleCount: 3, rootDepartmentDirectUserCount: 0, rootDepartmentDirectUserHasMore: false },
    ]
    const codes = new Set<string>()
    for (const input of inputs) {
      const summary = buildDirectoryIntegrationDiagnosticSummary(input)
      codes.add(summary.code)
      expect(summary.nextAction).toContain('本次只验证了已抽样的接口，未验证全员可见范围、所有成员详情或扫码登录。')
      expect(`${summary.title}${summary.nextAction}`).not.toContain('覆盖全员')
      expect(`${summary.title}${summary.nextAction}`).not.toContain('范围正常')
      expect(summary.title).not.toContain('成员详情')
    }
    // The shared builder (also used by the manual run's sample, which reads no detail) never yields the probe-only code.
    expect([...codes].sort()).toEqual(['healthy', 'no_child_departments', 'scope_or_root_misconfigured'])
  })
})
