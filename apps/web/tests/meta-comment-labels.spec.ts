import { describe, expect, it } from 'vitest'
import {
  commentLabel,
  editingBanner,
  emptyMessage,
  replyingBanner,
  replyCount,
  type MetaCommentLabelKey,
} from '../src/multitable/utils/meta-comment-labels'

describe('meta-comment-labels static keys', () => {
  it('localizes drawer and composer chrome with a dedicated comment namespace', () => {
    const expectations: Array<[MetaCommentLabelKey, string, string]> = [
      ['comment.title', 'Comments', '评论'],
      ['comment.inbox', 'Inbox', '收件箱'],
      ['comment.loading', 'Loading...', '正在加载...'],
      ['comment.retry', 'Retry', '重试'],
      ['comment.cancel', 'Cancel', '取消'],
      ['comment.reply', 'Reply', '回复'],
      ['comment.edit', 'Edit', '编辑'],
      ['comment.editing', 'Editing...', '正在编辑...'],
      ['comment.delete', 'Delete', '删除'],
      ['comment.deleting', 'Deleting...', '正在删除...'],
      ['comment.resolve', 'Resolve', '解决'],
      ['comment.resolving', 'Resolving...', '正在解决...'],
      ['comment.resolved', 'Resolved', '已解决'],
      ['comment.placeholderAdd', 'Add a comment...', '添加评论...'],
      ['comment.placeholderEdit', 'Edit comment…', '编辑评论…'],
      ['comment.placeholderReply', 'Reply to thread…', '回复线程…'],
      ['comment.submitSend', 'Send', '发送'],
      ['comment.submitSave', 'Save', '保存'],
      ['comment.submitSending', 'Sending...', '正在发送...'],
      ['comment.submitSaving', 'Saving...', '正在保存...'],
      ['comment.mentionSuggestionsAria', 'Comment mention suggestions', '评论提及建议'],
      ['comment.hintBase', 'Ctrl/Cmd + Enter to send', 'Ctrl/Cmd + Enter 发送'],
      ['comment.hintWithMention', 'Tab to mention, Ctrl/Cmd + Enter to send', 'Tab 提及，Ctrl/Cmd + Enter 发送'],
      ['comment.discardDraftConfirm', 'Discard unsaved comment draft?', '放弃未保存的评论草稿吗？'],
    ]

    for (const [key, en, zh] of expectations) {
      expect(commentLabel(key, false)).toBe(en)
      expect(commentLabel(key, true)).toBe(zh)
    }
  })
})

describe('meta-comment-labels helpers', () => {
  it('formats empty states without translating field scope labels', () => {
    expect(emptyMessage('Status', 'fld_status', false)).toBe('No comments yet for Status')
    expect(emptyMessage('Status', 'fld_status', true)).toBe('Status 暂无评论')
    expect(emptyMessage('状态', 'fld_status', true)).toBe('状态 暂无评论')
    expect(emptyMessage(null, 'fld_status', false)).toBe('No comments yet for this field')
    expect(emptyMessage(undefined, 'fld_status', true)).toBe('该字段暂无评论')
    expect(emptyMessage(null, null, false)).toBe('No comments yet')
    expect(emptyMessage(null, null, true)).toBe('暂无评论')
  })

  it('formats reply count singular/plural in English and neutral counts in zh-CN', () => {
    expect(replyCount(1, false)).toBe('1 reply')
    expect(replyCount(2, false)).toBe('2 replies')
    expect(replyCount(1, true)).toBe('1 条回复')
    expect(replyCount(2, true)).toBe('2 条回复')
  })

  it('formats edit and reply banners while preserving actor labels raw', () => {
    expect(editingBanner('Amy Wong', false)).toBe('Editing Amy Wong')
    expect(editingBanner('张三', true)).toBe('正在编辑 张三')
    expect(replyingBanner('Amy Wong', false)).toBe('Replying to Amy Wong')
    expect(replyingBanner('张三', true)).toBe('正在回复 张三')
  })
})
