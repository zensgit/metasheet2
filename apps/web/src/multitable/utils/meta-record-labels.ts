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
  | 'record.delete' | 'record.close'
  | 'record.tabsAria'
  | 'record.details' | 'record.history'
  | 'record.historyLoading' | 'record.historyUnavailable' | 'record.historyEmpty'
  | 'record.historyActionCreated' | 'record.historyActionDeleted' | 'record.historyActionUpdated'
  // FE-owned static fallback strings (the `error?.message ?? l(...)`
  // pattern from T3A2). Backend error.message remains raw when present.
  | 'record.errorHistoryLoad' | 'record.errorWatchLoad' | 'record.errorWatchUpdate'
  | 'record.noRecord'
  // --- MetaFormView static ---
  | 'form.loading' | 'form.readOnly'
  | 'form.discardConfirm'
  | 'form.save' | 'form.saving' | 'form.create' | 'form.reset'

const META_RECORD_LABELS: Record<MetaRecordLabelKey, { en: string; zh: string }> = {
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
  'record.errorHistoryLoad': { en: 'Failed to load history', zh: '加载历史失败' },
  'record.errorWatchLoad': { en: 'Failed to load watch status', zh: '加载关注状态失败' },
  'record.errorWatchUpdate': { en: 'Failed to update watch status', zh: '更新关注状态失败' },
  'record.noRecord': { en: 'No record selected', zh: '未选择记录' },

  'form.loading': { en: 'Loading...', zh: '正在加载...' },
  'form.readOnly': { en: 'This form is read-only', zh: '此表单为只读' },
  'form.discardConfirm': { en: 'Discard unsaved changes?', zh: '放弃未保存的更改吗？' },
  'form.save': { en: 'Save', zh: '保存' },
  'form.saving': { en: 'Saving...', zh: '正在保存...' },
  'form.create': { en: 'Create', zh: '创建' },
  'form.reset': { en: 'Reset', zh: '重置' },
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
