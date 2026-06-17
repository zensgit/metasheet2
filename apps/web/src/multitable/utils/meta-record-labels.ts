// Record drawer + Form view chrome string table — single source for
// MetaRecordDrawer.vue and MetaFormView.vue (T3B1) localization.
//
// EN + ZH both explicit, same convention as workbench-labels.ts and
// meta-core-labels.ts. Components read `useLocale().isZh` and call
// `recordLabel(key, isZh)` for static strings, or the helpers below
// for interpolated strings.
//
// Scope: see docs/development/multitable-t3b1-record-form-i18n-design-20260520.md.
//
// Intentional cross-module reuse from meta-core-labels.ts (T3A2):
//   - Field-editor placeholders: cell.barcodePlaceholder, cell.locationPlaceholder
//   - Boolean editor: cell.yes, cell.no
//   - Attachment chrome: cell.clearAll, attachmentActionHint (with the new
//     T3B1 `mode='add'` variant), attachmentActivityLabel,
//     cell.uploadFailed / cell.removeFailed / cell.clearFailed
//   - Field comment aria label: commentForField (used by MetaFormView)
//
// These are not duplicated here — T3B1 imports them from meta-core-labels.
//
// T3B2 (comments drawer/composer) and T3B3 (link picker title/search/empty/
// footer) get their own modules per the per-surface decision.

export type MetaRecordLabelKey =
  // --- MetaRecordDrawer static ---
  | 'record.title'
  | 'record.previous' | 'record.next'
  | 'record.watch' | 'record.watching'
  | 'record.watchTitle' | 'record.unwatchTitle'
  | 'record.comments'
  | 'record.workflow' | 'record.workflowTitle'
  | 'record.permissions' | 'record.permissionsTitle'
  // --- Record locking (design #2278 follow-up) ---
  | 'record.locked' | 'record.lockedBy' | 'record.lockedAt'
  | 'record.lock' | 'record.unlock'
  // --- Duplicate / clone record (design 2026-06-16) ---
  | 'record.duplicate' | 'record.duplicateTitle'
  | 'record.delete' | 'record.close'
  | 'record.tabsAria'
  | 'record.details' | 'record.history'
  | 'record.historyLoading' | 'record.historyUnavailable' | 'record.historyEmpty'
  | 'record.historyActionCreated' | 'record.historyActionDeleted' | 'record.historyActionUpdated'
  // --- Layer 1 record-level restore (Slice 3) ---
  | 'record.restore' | 'record.restoreTitle' | 'record.restoreConfirm'
  | 'record.restoreSuccess' | 'record.restoreNoop' | 'record.errorRestore'
  // FE-owned static fallback strings (the `error?.message ?? l(...)`
  // pattern from T3A2). Backend error.message remains raw when present.
  | 'record.errorHistoryLoad' | 'record.errorWatchLoad' | 'record.errorWatchUpdate'
  | 'record.noRecord'
  // --- AI shortcut field-header actions (A3-T3) ---
  | 'record.aiPreview' | 'record.aiRun'
  | 'record.aiPreviewTitle' | 'record.aiRunTitle'
  | 'record.aiPending'
  // --- MetaFormView static ---
  | 'form.loading' | 'form.readOnly'
  | 'form.discardConfirm'
  | 'form.save' | 'form.saving' | 'form.create' | 'form.reset'
  // --- Notification Center S1 (watcher inbox bell) ---
  | 'notification.bell' | 'notification.title' | 'notification.empty'
  | 'notification.markAllRead' | 'notification.loadError'
  | 'notification.eventRecordUpdated' | 'notification.eventCommentCreated'
  // B1-S1 D0-A: durable button-delivered notification (custom message render).
  | 'notification.eventNotificationSent'
  // --- MetaFormView multi-page nav chrome (A4) ---
  | 'form.previousPage' | 'form.nextPage'

const META_RECORD_LABELS: Record<MetaRecordLabelKey, { en: string; zh: string }> = {
  'notification.bell': { en: 'Notifications', zh: '通知' },
  'notification.title': { en: 'Notifications', zh: '通知' },
  'notification.empty': { en: 'No notifications', zh: '暂无通知' },
  'notification.markAllRead': { en: 'Mark all read', zh: '全部标为已读' },
  'notification.loadError': { en: 'Failed to load notifications', zh: '加载通知失败' },
  'notification.eventRecordUpdated': { en: 'Record updated', zh: '记录有更新' },
  'notification.eventCommentCreated': { en: 'New comment', zh: '新增评论' },
  'notification.eventNotificationSent': { en: 'Notification', zh: '通知' },
  'record.title': { en: 'Record Detail', zh: '记录详情' },
  'record.previous': { en: 'Previous record', zh: '上一条记录' },
  'record.next': { en: 'Next record', zh: '下一条记录' },
  'record.watch': { en: 'Watch', zh: '关注' },
  'record.watching': { en: 'Watching', zh: '已关注' },
  'record.watchTitle': { en: 'Watch this record', zh: '关注此记录' },
  'record.unwatchTitle': { en: 'Unwatch this record', zh: '取消关注此记录' },
  'record.comments': { en: 'Comments', zh: '评论' },
  'record.workflow': { en: 'Workflow', zh: '工作流' },
  'record.workflowTitle': { en: 'Open workflow designer', zh: '打开工作流设计器' },
  'record.permissions': { en: 'Permissions', zh: '权限' },
  'record.permissionsTitle': { en: 'Record Permissions', zh: '记录权限' },
  'record.locked': { en: 'This record is locked', zh: '该记录已锁定' },
  'record.lockedBy': { en: 'Locked by', zh: '锁定人' },
  'record.lockedAt': { en: 'Locked at', zh: '锁定时间' },
  'record.lock': { en: 'Lock', zh: '锁定' },
  'record.unlock': { en: 'Unlock', zh: '解锁' },
  'record.duplicate': { en: 'Duplicate', zh: '复制' },
  'record.duplicateTitle': { en: 'Duplicate this record', zh: '复制此记录' },
  'record.delete': { en: 'Delete', zh: '删除' },
  'record.close': { en: 'Close record drawer', zh: '关闭记录抽屉' },
  'record.tabsAria': { en: 'Record drawer sections', zh: '记录抽屉分区' },
  'record.details': { en: 'Details', zh: '详情' },
  'record.history': { en: 'History', zh: '历史' },
  'record.historyLoading': { en: 'Loading history...', zh: '正在加载历史...' },
  'record.historyUnavailable': { en: 'History unavailable for this record.', zh: '此记录的历史不可用。' },
  'record.historyEmpty': { en: 'No history yet.', zh: '暂无历史。' },
  'record.historyActionCreated': { en: 'Created', zh: '已创建' },
  'record.historyActionDeleted': { en: 'Deleted', zh: '已删除' },
  'record.historyActionUpdated': { en: 'Updated', zh: '已更新' },
  'record.restore': { en: 'Restore', zh: '恢复' },
  'record.restoreTitle': { en: 'Restore the record to this version', zh: '将记录恢复到此版本' },
  'record.restoreConfirm': { en: 'Restore this record to the selected version? This creates a new version; it does not erase history.', zh: '将记录恢复到所选版本？这会生成一条新版本，不会抹除历史。' },
  'record.restoreSuccess': { en: 'Restored', zh: '已恢复' },
  'record.restoreNoop': { en: 'Already at this version', zh: '已是该版本' },
  'record.errorRestore': { en: 'Restore failed', zh: '恢复失败' },
  'record.errorHistoryLoad': { en: 'Failed to load history', zh: '加载历史失败' },
  'record.errorWatchLoad': { en: 'Failed to load watch status', zh: '加载关注状态失败' },
  'record.errorWatchUpdate': { en: 'Failed to update watch status', zh: '更新关注状态失败' },
  'record.noRecord': { en: 'No record selected', zh: '未选择记录' },
  // A3: AI shortcut actions. Preview is gated on field readability (a visible
  // drawer field IS readable); run is additionally gated on canEditField —
  // mirroring the backend preview/run gates.
  'record.aiPreview': { en: 'AI preview', zh: 'AI 预览' },
  'record.aiRun': { en: 'AI run', zh: 'AI 运行' },
  'record.aiPreviewTitle': { en: 'Preview the AI output (real call, consumes quota)', zh: '预览 AI 输出（真实调用，消耗配额）' },
  'record.aiRunTitle': { en: 'Run AI and write the output into this field', zh: '运行 AI 并将结果写入此字段' },
  'record.aiPending': { en: 'AI request in progress...', zh: 'AI 请求处理中...' },

  'form.loading': { en: 'Loading...', zh: '正在加载...' },
  'form.readOnly': { en: 'This form is read-only', zh: '此表单为只读' },
  'form.discardConfirm': { en: 'Discard unsaved changes?', zh: '放弃未保存的更改吗？' },
  'form.save': { en: 'Save', zh: '保存' },
  'form.saving': { en: 'Saving...', zh: '正在保存...' },
  'form.create': { en: 'Create', zh: '创建' },
  'form.reset': { en: 'Reset', zh: '重置' },
  'form.previousPage': { en: 'Previous', zh: '上一页' },
  'form.nextPage': { en: 'Next', zh: '下一页' },
}

export function recordLabel(key: MetaRecordLabelKey, isZh: boolean): string {
  const entry = META_RECORD_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation helpers (not keys) ---

// commentOnField: aria-label/title for the comment-on-field button in the
// Record Detail drawer. Field name is user data and is interpolated raw —
// never translated. (Distinct from T3A1's commentForField, which is used
// by MetaGridTable and MetaFormView for the plural "Comments for X" copy.)
export function commentOnField(fieldName: string, isZh: boolean): string {
  return isZh ? `评论 ${fieldName}` : `Comment on ${fieldName}`
}

// historyActor: prefix label for a history entry actor in the record
// history view. Actor id is user data (typically a user_X username) and
// remains raw.
export function historyActor(actorId: string, isZh: boolean): string {
  return isZh ? `由 ${actorId}` : `by ${actorId}`
}

// requiredField: validation error message for a missing required field
// in MetaFormView. Field name is user data and is interpolated raw.
export function requiredField(fieldName: string, isZh: boolean): string {
  return isZh ? `${fieldName} 为必填项` : `${fieldName} is required`
}

// formPageIndicator: "Page X of Y" indicator for the multi-page form view
// (A4). Numbers are not translated; the surrounding copy is.
export function formPageIndicator(current: number, total: number, isZh: boolean): string {
  return isZh ? `第 ${current} / ${total} 页` : `Page ${current} of ${total}`
}
