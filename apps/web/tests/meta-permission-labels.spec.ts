import { describe, expect, it } from 'vitest'
import { managerLabel } from '../src/multitable/utils/meta-manager-labels'
import {
  fieldStateText,
  fieldStatusClearedOrphans,
  orphanSubjectText,
  permissionLabel,
  recordAccessText,
  sheetAccessText,
  subjectOverrideSummary,
  subjectText,
  viewPermissionText,
  viewStatusClearedOrphans,
} from '../src/multitable/utils/meta-permission-labels'

describe('meta-permission-labels', () => {
  it('maps static permission manager chrome in English and zh-CN', () => {
    expect(permissionLabel('record.title', false)).toBe('Record Permissions')
    expect(permissionLabel('record.title', true)).toBe('记录权限')
    expect(permissionLabel('sheet.title', false)).toBe('Manage Access')
    expect(permissionLabel('sheet.title', true)).toBe('管理访问权限')
    expect(permissionLabel('action.copyAcl', true)).toBe('复制 ACL')
  })

  it('keeps common manager actions in meta-manager-labels', () => {
    expect(managerLabel('action.save', true)).toBe('保存')
    expect(managerLabel('action.remove', true)).toBe('移除')
    expect(managerLabel('action.clear', true)).toBe('清除')
    expect(managerLabel('action.apply', true)).toBe('应用')
  })

  it('keeps access and state values display-only while preserving unknown raw values', () => {
    expect(recordAccessText('write', false)).toBe('Write')
    expect(recordAccessText('write', true)).toBe('写入')
    expect(sheetAccessText('write-own', true)).toBe('仅写入自己')
    expect(viewPermissionText('none', true)).toBe('无')
    expect(fieldStateText('readonly', true)).toBe('只读')
    expect(recordAccessText('custom_acl', true)).toBe('custom_acl')
  })

  it('localizes subject badges without touching raw identities', () => {
    expect(subjectText('user', false)).toBe('User')
    expect(subjectText('user', true)).toBe('用户')
    expect(subjectText('user', true, 'person')).toBe('人员')
    expect(subjectText('member-group', true)).toBe('成员组')
    expect(orphanSubjectText('Member group', false)).toBe('Orphan Member group')
    expect(orphanSubjectText('成员组', true)).toBe('孤立的 成员组')
  })

  it('preserves English singular/plural forks for orphan overrides', () => {
    expect(fieldStatusClearedOrphans(1, false)).toBe('Cleared 1 orphan field override')
    expect(fieldStatusClearedOrphans(2, false)).toBe('Cleared 2 orphan field overrides')
    expect(fieldStatusClearedOrphans(2, true)).toBe('已清除 2 个孤立字段覆盖')
    expect(viewStatusClearedOrphans(1, false)).toBe('Cleared 1 orphan view override')
    expect(viewStatusClearedOrphans(2, false)).toBe('Cleared 2 orphan view overrides')
    expect(viewStatusClearedOrphans(2, true)).toBe('已清除 2 个孤立视图覆盖')
  })

  it('formats field/view override summaries with English plural forks and zh neutral counts', () => {
    expect(subjectOverrideSummary(1, 2, false)).toBe('1 field override · 2 view overrides')
    expect(subjectOverrideSummary(2, 1, false)).toBe('2 field overrides · 1 view override')
    expect(subjectOverrideSummary(2, 1, true)).toBe('2 个字段覆盖 · 1 个视图覆盖')
  })
})
