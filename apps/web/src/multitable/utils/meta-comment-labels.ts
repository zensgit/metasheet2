// Comments drawer + composer chrome string table (T3B2).
//
// Scope: comment drawer/composer chrome plus row-comment action chip labels in
// alternative views. User content, author names, record labels, field names, and
// backend/composable error bodies stay raw and are never translated here.
// Frontend-owned composable fallback strings live here once no raw backend
// message is available.

export type MetaCommentLabelKey =
  | 'comment.title'
  | 'comment.inbox'
  | 'comment.loading'
  | 'comment.retry'
  | 'comment.cancel'
  | 'comment.reply'
  | 'comment.edit'
  | 'comment.editing'
  | 'comment.delete'
  | 'comment.deleting'
  | 'comment.resolve'
  | 'comment.resolving'
  | 'comment.resolved'
  | 'comment.mentions'
  | 'comment.closeMentions'
  | 'comment.unread'
  | 'comment.placeholderAdd'
  | 'comment.placeholderEdit'
  | 'comment.placeholderReply'
  | 'comment.submitSend'
  | 'comment.submitSave'
  | 'comment.submitSending'
  | 'comment.submitSaving'
  | 'comment.mentionSuggestionsAria'
  | 'comment.hintBase'
  | 'comment.hintWithMention'
  | 'comment.discardDraftConfirm'
  | 'comment.errorLoad'
  | 'comment.errorAdd'
  | 'comment.errorResolve'
  | 'comment.errorUpdate'
  | 'comment.errorDelete'
  | 'comment.errorLoadInbox'
  | 'comment.errorLoadUnreadCount'
  | 'comment.errorMarkRead'
  | 'comment.errorLoadMentionSummary'
  | 'comment.errorLoadPresence'

const META_COMMENT_LABELS: Record<MetaCommentLabelKey, { en: string; zh: string }> = {
  'comment.title': { en: 'Comments', zh: '评论' },
  'comment.inbox': { en: 'Inbox', zh: '收件箱' },
  'comment.loading': { en: 'Loading...', zh: '正在加载...' },
  'comment.retry': { en: 'Retry', zh: '重试' },
  'comment.cancel': { en: 'Cancel', zh: '取消' },
  'comment.reply': { en: 'Reply', zh: '回复' },
  'comment.edit': { en: 'Edit', zh: '编辑' },
  'comment.editing': { en: 'Editing...', zh: '正在编辑...' },
  'comment.delete': { en: 'Delete', zh: '删除' },
  'comment.deleting': { en: 'Deleting...', zh: '正在删除...' },
  'comment.resolve': { en: 'Resolve', zh: '解决' },
  'comment.resolving': { en: 'Resolving...', zh: '正在解决...' },
  'comment.resolved': { en: 'Resolved', zh: '已解决' },
  'comment.mentions': { en: 'Mentions', zh: '提及' },
  'comment.closeMentions': { en: 'Close mentions', zh: '关闭提及' },
  'comment.unread': { en: 'Unread', zh: '未读' },
  'comment.placeholderAdd': { en: 'Add a comment...', zh: '添加评论...' },
  'comment.placeholderEdit': { en: 'Edit comment…', zh: '编辑评论…' },
  'comment.placeholderReply': { en: 'Reply to thread…', zh: '回复线程…' },
  'comment.submitSend': { en: 'Send', zh: '发送' },
  'comment.submitSave': { en: 'Save', zh: '保存' },
  'comment.submitSending': { en: 'Sending...', zh: '正在发送...' },
  'comment.submitSaving': { en: 'Saving...', zh: '正在保存...' },
  'comment.mentionSuggestionsAria': { en: 'Comment mention suggestions', zh: '评论提及建议' },
  'comment.hintBase': { en: 'Ctrl/Cmd + Enter to send', zh: 'Ctrl/Cmd + Enter 发送' },
  'comment.hintWithMention': {
    en: 'Tab to mention, Ctrl/Cmd + Enter to send',
    zh: 'Tab 提及，Ctrl/Cmd + Enter 发送',
  },
  'comment.discardDraftConfirm': {
    en: 'Discard unsaved comment draft?',
    zh: '放弃未保存的评论草稿吗？',
  },
  'comment.errorLoad': { en: 'Failed to load comments', zh: '加载评论失败' },
  'comment.errorAdd': { en: 'Failed to add comment', zh: '添加评论失败' },
  'comment.errorResolve': { en: 'Failed to resolve comment', zh: '解决评论失败' },
  'comment.errorUpdate': { en: 'Failed to update comment', zh: '更新评论失败' },
  'comment.errorDelete': { en: 'Failed to delete comment', zh: '删除评论失败' },
  'comment.errorLoadInbox': { en: 'Failed to load comment inbox', zh: '加载评论收件箱失败' },
  'comment.errorLoadUnreadCount': { en: 'Failed to load unread comment count', zh: '加载未读评论数失败' },
  'comment.errorMarkRead': { en: 'Failed to mark comment as read', zh: '标记评论已读失败' },
  'comment.errorLoadMentionSummary': { en: 'Failed to load mention summary', zh: '加载提及摘要失败' },
  'comment.errorLoadPresence': { en: 'Failed to load comment presence', zh: '加载评论状态失败' },
}

export function commentLabel(key: MetaCommentLabelKey, isZh: boolean): string {
  const entry = META_COMMENT_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function emptyMessage(
  scopeLabel: string | null | undefined,
  targetFieldId: string | null | undefined,
  isZh: boolean,
): string {
  if (targetFieldId && scopeLabel) {
    return isZh ? `${scopeLabel} 暂无评论` : `No comments yet for ${scopeLabel}`
  }
  if (targetFieldId) {
    return isZh ? '该字段暂无评论' : 'No comments yet for this field'
  }
  return isZh ? '暂无评论' : 'No comments yet'
}

export function replyCount(n: number, isZh: boolean): string {
  if (isZh) return `${n} 条回复`
  return `${n} ${n === 1 ? 'reply' : 'replies'}`
}

export function editingBanner(actorLabel: string, isZh: boolean): string {
  return isZh ? `正在编辑 ${actorLabel}` : `Editing ${actorLabel}`
}

export function replyingBanner(actorLabel: string, isZh: boolean): string {
  return isZh ? `正在回复 ${actorLabel}` : `Replying to ${actorLabel}`
}

export function mentionFieldScope(primaryFieldName: string, extraCount: number, isZh: boolean): string {
  if (extraCount <= 0) return primaryFieldName
  return isZh ? `${primaryFieldName} +${extraCount} 个字段` : `${primaryFieldName} +${extraCount} more`
}
