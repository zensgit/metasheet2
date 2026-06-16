import { describe, it, expect } from 'vitest'
import {
  recordLabel,
  commentOnField,
  historyActor,
  requiredField,
} from '../src/multitable/utils/meta-record-labels'

describe('meta-record-labels static keys', () => {
  it('localizes the record drawer header chrome', () => {
    expect(recordLabel('record.title', true)).toBe('记录详情')
    expect(recordLabel('record.title', false)).toBe('Record Detail')
    expect(recordLabel('record.previous', true)).toBe('上一条记录')
    expect(recordLabel('record.next', true)).toBe('下一条记录')
    expect(recordLabel('record.close', true)).toBe('关闭记录抽屉')
    expect(recordLabel('record.tabsAria', true)).toBe('记录抽屉分区')
    expect(recordLabel('record.delete', true)).toBe('删除')
  })

  it('duplicate button text is separate from its title key (button-suffix pattern)', () => {
    expect(recordLabel('record.duplicate', true)).toBe('复制')
    expect(recordLabel('record.duplicate', false)).toBe('Duplicate')
    expect(recordLabel('record.duplicateTitle', true)).toBe('复制此记录')
    expect(recordLabel('record.duplicateTitle', false)).toBe('Duplicate this record')
  })

  it('distinguishes watch button text from watch/unwatch title (S1/T3A1 pattern)', () => {
    expect(recordLabel('record.watch', true)).toBe('关注')
    expect(recordLabel('record.watching', true)).toBe('已关注')
    expect(recordLabel('record.watchTitle', true)).toBe('关注此记录')
    expect(recordLabel('record.unwatchTitle', true)).toBe('取消关注此记录')
    // en parity
    expect(recordLabel('record.watch', false)).toBe('Watch')
    expect(recordLabel('record.watching', false)).toBe('Watching')
    expect(recordLabel('record.watchTitle', false)).toBe('Watch this record')
    expect(recordLabel('record.unwatchTitle', false)).toBe('Unwatch this record')
  })

  it('S1: workflow button suffix is separate from the title key', () => {
    expect(recordLabel('record.workflow', true)).toBe('工作流')
    expect(recordLabel('record.workflowTitle', true)).toBe('打开工作流设计器')
    expect(recordLabel('record.workflow', false)).toBe('Workflow')
    expect(recordLabel('record.workflowTitle', false)).toBe('Open workflow designer')
  })

  it('S2: permissions button suffix is separate from the title key', () => {
    expect(recordLabel('record.permissions', true)).toBe('权限')
    expect(recordLabel('record.permissionsTitle', true)).toBe('记录权限')
    expect(recordLabel('record.permissions', false)).toBe('Permissions')
    expect(recordLabel('record.permissionsTitle', false)).toBe('Record Permissions')
  })

  it('localizes tabs + history state strings', () => {
    expect(recordLabel('record.details', true)).toBe('详情')
    expect(recordLabel('record.history', true)).toBe('历史')
    expect(recordLabel('record.historyLoading', true)).toBe('正在加载历史...')
    expect(recordLabel('record.historyUnavailable', true)).toBe('此记录的历史不可用。')
    expect(recordLabel('record.historyEmpty', true)).toBe('暂无历史。')
    expect(recordLabel('record.noRecord', true)).toBe('未选择记录')
  })

  it('S5: history action labels cover Created / Deleted / Updated', () => {
    expect(recordLabel('record.historyActionCreated', true)).toBe('已创建')
    expect(recordLabel('record.historyActionDeleted', true)).toBe('已删除')
    expect(recordLabel('record.historyActionUpdated', true)).toBe('已更新')
    expect(recordLabel('record.historyActionCreated', false)).toBe('Created')
    expect(recordLabel('record.historyActionDeleted', false)).toBe('Deleted')
    expect(recordLabel('record.historyActionUpdated', false)).toBe('Updated')
  })

  it('M1: FE error fallbacks are FE chrome, not backend free-form text', () => {
    expect(recordLabel('record.errorHistoryLoad', true)).toBe('加载历史失败')
    expect(recordLabel('record.errorWatchLoad', true)).toBe('加载关注状态失败')
    expect(recordLabel('record.errorWatchUpdate', true)).toBe('更新关注状态失败')
    // en preserved exactly so `error?.message ?? recordLabel(...)` keeps T3A2-style behavior
    expect(recordLabel('record.errorHistoryLoad', false)).toBe('Failed to load history')
    expect(recordLabel('record.errorWatchLoad', false)).toBe('Failed to load watch status')
    expect(recordLabel('record.errorWatchUpdate', false)).toBe('Failed to update watch status')
  })

  it('M1: form submit/reset chain is fully covered (Saving/Save/Create/Reset)', () => {
    expect(recordLabel('form.loading', true)).toBe('正在加载...')
    expect(recordLabel('form.readOnly', true)).toBe('此表单为只读')
    expect(recordLabel('form.discardConfirm', true)).toBe('放弃未保存的更改吗？')
    expect(recordLabel('form.save', true)).toBe('保存')
    expect(recordLabel('form.saving', true)).toBe('正在保存...')
    expect(recordLabel('form.create', true)).toBe('创建')
    expect(recordLabel('form.reset', true)).toBe('重置')
    // en parity for the submit ternary
    expect(recordLabel('form.save', false)).toBe('Save')
    expect(recordLabel('form.saving', false)).toBe('Saving...')
    expect(recordLabel('form.create', false)).toBe('Create')
    expect(recordLabel('form.reset', false)).toBe('Reset')
  })
})

describe('meta-record-labels helpers', () => {
  it('commentOnField interpolates the field name raw (singular EN form)', () => {
    expect(commentOnField('Status', false)).toBe('Comment on Status')
    expect(commentOnField('Status', true)).toBe('评论 Status')
    // distinct from T3A1 commentForField (plural EN form) — different surfaces
    expect(commentOnField('Status', true)).not.toBe('Status 的评论')
  })

  it('commentOnField preserves a chinese-authored field name unchanged', () => {
    expect(commentOnField('负责人', true)).toBe('评论 负责人')
    expect(commentOnField('负责人', false)).toBe('Comment on 负责人')
  })

  it('historyActor interpolates the actor id raw (user data)', () => {
    expect(historyActor('user_42', false)).toBe('by user_42')
    expect(historyActor('user_42', true)).toBe('由 user_42')
    expect(historyActor('张三', true)).toBe('由 张三')
  })

  it('requiredField interpolates the field name raw (validation chrome)', () => {
    expect(requiredField('Email', false)).toBe('Email is required')
    expect(requiredField('Email', true)).toBe('Email 为必填项')
    expect(requiredField('邮箱', true)).toBe('邮箱 为必填项')
  })
})
