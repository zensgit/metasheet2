import { describe, expect, it } from 'vitest'
import {
  buildUpdateExportCsv,
  parseCsv,
  parsePastedEmails,
  previewUpdateRows,
  validateImportRows,
} from '../src/views/adminUserBatch'

describe('adminUserBatch', () => {
  it('parses pasted emails and drops duplicates', () => {
    expect(parsePastedEmails('a@example.com, A@example.com；b@example.com\nc@example.com')).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ])
  })

  it('validates import rows for format, duplicates, and unknown roles', () => {
    const rows = validateImportRows(parseCsv([
      'name,email,roleId,department',
      '林岚,bad-email,user,装配',
      '周衡,zhou@example.com,missing,信息部',
      '吴敏,wu@example.com,user,计划部',
      '吴敏,wu@example.com,user,计划部',
    ].join('\n')), new Set(['user']))
    expect(rows.map((row) => row.message)).toEqual([
      '邮箱格式不正确',
      '角色不存在',
      '可以导入',
      '本批中邮箱重复',
    ])
  })

  it('builds an update export and previews a department diff', () => {
    const csv = buildUpdateExportCsv([{
      id: 'user-lin',
      email: 'linlan@example.com',
      name: '林岚',
      role: 'user',
      department: '装配车间',
      is_active: true,
    }])
    const parsed = parseCsv(csv)
    parsed[0].department = '质量部'
    const preview = previewUpdateRows(parsed, [{
      id: 'user-lin',
      email: 'linlan@example.com',
      name: '林岚',
      role: 'user',
      department: '装配车间',
      is_active: true,
    }], new Set(['user']))
    expect(preview[0]?.changes).toEqual([{ field: '部门', before: '装配车间', after: '质量部' }])
  })

  it('rejects a userId and email that do not name the same person', () => {
    const preview = previewUpdateRows([
      { userId: 'user-lin', email: 'other@example.com', name: '林岚', department: '质量部' },
      { userId: 'user-lin', email: 'not-lin@example.com', department: '质量部' },
      { userId: 'missing-user', email: 'linlan@example.com', department: '质量部' },
    ], [
      {
        id: 'user-lin',
        email: 'linlan@example.com',
        name: '林岚',
        role: 'user',
        department: '装配车间',
        is_active: true,
      },
      {
        id: 'user-other',
        email: 'other@example.com',
        name: '其他人',
        role: 'user',
        department: '仓储',
        is_active: true,
      },
    ], new Set(['user']))

    expect(preview.map((row) => row.ok)).toEqual([false, false, false])
    expect(preview.map((row) => row.message)).toEqual([
      '用户 ID 与邮箱不是同一个人',
      '用户 ID 与邮箱不是同一个人',
      '用户 ID 与邮箱不是同一个人',
    ])
    expect(preview.map((row) => [row.userId, row.email])).toEqual([
      ['user-lin', 'other@example.com'],
      ['user-lin', 'not-lin@example.com'],
      ['missing-user', 'linlan@example.com'],
    ])
    expect(preview.every((row) => row.changes.length === 0)).toBe(true)
  })
})
