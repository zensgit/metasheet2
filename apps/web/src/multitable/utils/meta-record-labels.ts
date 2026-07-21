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
  // --- W2 S5 (design-lock multitable-w2-unified-record-inspector-design-lock-20260714.md §2 附件面板
  //     row, §7 S5): the 4th inspector tab label (G-10 term 附件). ---
  | 'record.attachments'
  | 'record.historyLoading' | 'record.historyUnavailable' | 'record.historyEmpty'
  | 'record.historyActionCreated' | 'record.historyActionDeleted' | 'record.historyActionUpdated'
  // --- Layer 1 record-level restore (Slice 3) ---
  | 'record.restore' | 'record.restoreTitle' | 'record.restoreConfirm'
  | 'record.restoreSuccess' | 'record.restoreNoop' | 'record.errorRestore'
  | 'record.restorePreviewTitle' | 'record.restorePreviewWillChange' | 'record.restorePreviewNoChanges'
  | 'record.restorePreviewConflict' | 'record.restorePreviewExecute' | 'record.restorePreviewCancel'
  | 'record.restorePreviewLoading' | 'record.restorePreviewSet' | 'record.restorePreviewUnset'
  // --- BS-4 scoped (multi-record) batch restore ---
  | 'record.batchRestoreTitle' | 'record.batchRestoreRevertOriginal' | 'record.batchRestoreAdvanced'
  | 'record.batchRestoreVersionLabel' | 'record.batchRestoreVersionHint' | 'record.batchRestoreSummaryRestorable' | 'record.batchRestoreSummarySkipped'
  | 'record.batchRestoreLoading' | 'record.batchRestoreNoneRestorable' | 'record.batchRestoreConfirm'
  | 'record.batchRestoreCancel' | 'record.batchRestoreDone' | 'record.batchRestoreResultTitle'
  | 'record.batchRestoreRestored'
  | 'record.batchReasonUnavailable' | 'record.batchReasonVersionUnavailable' | 'record.batchReasonUnsupported'
  | 'record.batchReasonSnapshotUnavailable' | 'record.batchReasonSchemaDrift' | 'record.batchReasonNoChange'
  | 'record.batchReasonDenied' | 'record.batchReasonConflict' | 'record.batchReasonForbidden' | 'record.batchReasonError'
  // --- Global History Center inline per-field diff (read-only detail expansion) ---
  | 'record.historyDiffMasked'
  // --- T9-R4 config-history view ---
  | 'record.configHistoryTitle' | 'record.configHistoryClose' | 'record.configHistoryFilterAll'
  | 'record.configHistoryEntityField' | 'record.configHistoryEntityView' | 'record.configHistoryEntityPermission'
  | 'record.configHistoryEntitySheetConfig' | 'record.configHistoryActionCreate' | 'record.configHistoryActionUpdate'
  | 'record.configHistoryActionDelete' | 'record.configHistoryEmpty' | 'record.configHistoryLoading' | 'record.configHistoryBy'
  // --- T9-W config-restore (revert a config change) ---
  | 'record.configRestoreAction' | 'record.configRestoreTitle' | 'record.configRestoreWillRevert'
  | 'record.configRestoreDrift' | 'record.configRestoreGated' | 'record.configRestoreConfirm'
  | 'record.configRestoreCancel' | 'record.configRestoreError'
  | 'record.configRestoreServerSummary' | 'record.configRestoreEntity' | 'record.configRestoreNote'
  | 'record.configRestoreIdCollision' | 'record.configRestoreIdCollisionBlocked' | 'record.configRestoreScope'
  | 'record.configRestoreDirection' | 'record.configRestoreBlocked'
  | 'record.configRestoreBoolYes' | 'record.configRestoreBoolNo'
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
  // --- T8-2 Reset UI T-source picker (R5b strict-zero closeout; W2 exact-anchor: manual/free-time keys
  //     retired — the picker only ever sources an exact Global History batch) ---
  | 'record.resetPickerHeading' | 'record.resetPickerHistoryLabel' | 'record.resetPickerHistoryPlaceholder'
  | 'record.resetPickerRefresh' | 'record.resetPickerHistoryLoading'
  | 'record.resetPickerHistoryEmpty' | 'record.resetPickerHistoryUnavailable'
  | 'record.resetPickerExactAnchorNote'
  | 'record.resetPickerTargetPrefix' | 'record.resetPickerTargetSuffix' | 'record.resetPickerFromBatch'
  | 'record.resetPickerErrorLoad' | 'record.resetPickerSystemActor' | 'record.resetPickerDefaultAction'
  // --- T8-2 Reset UI confirm dialog (R5c strict-zero closeout, final microslice of this line) ---
  | 'record.resetConfirmDialogAria' | 'record.resetConfirmCancelAria' | 'record.resetConfirmLoading'
  | 'record.resetConfirmSubmitting' | 'record.resetConfirmNoChanges'
  | 'record.resetConfirmViewInTrash'
  | 'record.resetConfirmErrorDisabled' | 'record.resetConfirmErrorForbidden' | 'record.resetConfirmErrorBlocked'
  | 'record.resetConfirmErrorStale' | 'record.resetConfirmErrorTooLarge' | 'record.resetConfirmErrorTypeMismatch'
  | 'record.resetConfirmErrorGeneric'
  // --- W2 exact-anchor kernel refusal mapping (L6-b/L7/L8 reason vocabulary) ---
  | 'record.resetConfirmErrorAnchorInvalid' | 'record.resetConfirmErrorCheckpoint'
  | 'record.resetConfirmErrorTrustRequired' | 'record.resetConfirmErrorSchemaDrift'
  | 'record.resetConfirmErrorLinkIntegrity' | 'record.resetConfirmErrorValueInvalid'
  | 'record.resetConfirmErrorInboundUnprovable'
  | 'record.resetConfirmWarnResetWord' | 'record.resetConfirmWarnNotWord' | 'record.resetConfirmRevertWord'
  | 'record.resetConfirmWarnBeforeNot' | 'record.resetConfirmWarnInstead'
  | 'record.resetConfirmTypePrefix' | 'record.resetConfirmTypeSuffix' | 'record.resetConfirmTypeAria'

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
  'record.attachments': { en: 'Attachments', zh: '附件' },
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
  'record.restorePreviewTitle': { en: 'Review restore', zh: '确认恢复' },
  'record.restorePreviewWillChange': { en: 'These fields will change:', zh: '以下字段将被修改：' },
  'record.restorePreviewNoChanges': { en: 'Nothing would change — the record already matches this version.', zh: '没有变化 — 记录已与该版本一致。' },
  'record.restorePreviewConflict': { en: 'Cannot restore: the schema changed since this version (a field no longer exists). Restore is blocked to avoid a partial result.', zh: '无法恢复：该版本之后数据表结构已变化（某字段已不存在）。为避免部分恢复，已阻止。' },
  'record.restorePreviewExecute': { en: 'Restore', zh: '恢复' },
  'record.restorePreviewCancel': { en: 'Cancel', zh: '取消' },
  'record.restorePreviewLoading': { en: 'Loading preview…', zh: '正在加载预览…' },
  'record.restorePreviewSet': { en: 'set', zh: '设为' },
  'record.restorePreviewUnset': { en: 'clear', zh: '清空' },
  // Global History Center inline diff: a changed field whose value is hidden on BOTH sides (LOCK-3
  // field-level permission mask) — reused for both the before and after slot of a masked row. Distinct
  // from a legitimate set/clear (record.restorePreviewSet / record.restorePreviewUnset, reused below),
  // which are one-sided absences the FE can tell apart from a mask (see changeFieldDiffs in
  // HistoryCenterModal.vue).
  'record.historyDiffMasked': { en: 'Masked', zh: '已脱敏' },
  // BS-4 batch restore
  'record.batchRestoreTitle': { en: 'Batch restore', zh: '批量恢复' },
  'record.batchRestoreRevertOriginal': { en: 'Revert selected records to their original version', zh: '将所选记录恢复到初始版本' },
  'record.batchRestoreAdvanced': { en: 'Advanced', zh: '高级' },
  'record.batchRestoreVersionLabel': { en: 'Restore to version', zh: '恢复到版本' },
  'record.batchRestoreVersionHint': { en: 'Each record is restored to its own version of that number; records without it are skipped.', zh: '每条记录恢复到它自己的该版本号；没有该版本的记录会被跳过。' },
  'record.batchRestoreSummaryRestorable': { en: 'will be restored', zh: '将被恢复' },
  'record.batchRestoreSummarySkipped': { en: 'skipped', zh: '跳过' },
  'record.batchRestoreLoading': { en: 'Previewing…', zh: '预览中…' },
  'record.batchRestoreNoneRestorable': { en: 'No selected records can be restored to this version', zh: '没有所选记录可恢复到该版本' },
  'record.batchRestoreConfirm': { en: 'Restore', zh: '恢复' },
  'record.batchRestoreCancel': { en: 'Cancel', zh: '取消' },
  'record.batchRestoreDone': { en: 'Done', zh: '完成' },
  'record.batchRestoreResultTitle': { en: 'Restore results', zh: '恢复结果' },
  'record.batchRestoreRestored': { en: 'Restored', zh: '已恢复' },
  'record.batchReasonUnavailable': { en: 'Unavailable', zh: '不可用' },
  'record.batchReasonVersionUnavailable': { en: 'No such version', zh: '无该版本' },
  'record.batchReasonUnsupported': { en: 'Not supported', zh: '不支持' },
  'record.batchReasonSnapshotUnavailable': { en: 'No snapshot', zh: '无快照' },
  'record.batchReasonSchemaDrift': { en: 'Schema changed', zh: '结构已变' },
  'record.batchReasonNoChange': { en: 'No change', zh: '无变化' },
  'record.batchReasonDenied': { en: 'Not permitted', zh: '无权限' },
  'record.batchReasonConflict': { en: 'Version conflict', zh: '版本冲突' },
  'record.batchReasonForbidden': { en: 'Field write-denied', zh: '字段不可写' },
  'record.batchReasonError': { en: 'Error', zh: '错误' },
  'record.configHistoryTitle': { en: 'Config history', zh: '配置历史' },
  'record.configHistoryClose': { en: 'Close', zh: '关闭' },
  'record.configHistoryFilterAll': { en: 'All', zh: '全部' },
  'record.configHistoryEntityField': { en: 'Field', zh: '字段' },
  'record.configHistoryEntityView': { en: 'View', zh: '视图' },
  'record.configHistoryEntityPermission': { en: 'Permission', zh: '权限' },
  'record.configHistoryEntitySheetConfig': { en: 'Sheet config', zh: '数据表配置' },
  'record.configHistoryActionCreate': { en: 'Created', zh: '新建' },
  'record.configHistoryActionUpdate': { en: 'Updated', zh: '更新' },
  'record.configHistoryActionDelete': { en: 'Deleted', zh: '删除' },
  'record.configHistoryEmpty': { en: 'No config changes', zh: '暂无配置变更' },
  'record.configHistoryLoading': { en: 'Loading…', zh: '加载中…' },
  'record.configHistoryBy': { en: 'by', zh: '操作人' },
  'record.configRestoreAction': { en: 'Revert', zh: '撤销' },
  'record.configRestoreTitle': { en: 'Revert this change', zh: '撤销此变更' },
  'record.configRestoreWillRevert': { en: 'This will revert:', zh: '将撤销为：' },
  'record.configRestoreDrift': { en: 'The config changed since this revision — re-preview before reverting.', zh: '此后配置已变更 — 请重新预览后再撤销。' },
  'record.configRestoreGated': { en: "This change can't be reverted in this version.", zh: '此变更暂不支持撤销。' },
  'record.configRestoreConfirm': { en: 'Revert', zh: '确认撤销' },
  'record.configRestoreCancel': { en: 'Cancel', zh: '取消' },
  'record.configRestoreError': { en: 'Revert failed', zh: '撤销失败' },
  'record.configRestoreServerSummary': { en: 'Server preview:', zh: '服务端预览：' },
  'record.configRestoreEntity': { en: 'Entity', zh: '对象' },
  'record.configRestoreNote': { en: 'Note', zh: '说明' },
  'record.configRestoreIdCollision': { en: 'ID collision', zh: 'ID 冲突' },
  'record.configRestoreIdCollisionBlocked': { en: 'An entity with this id already exists. Re-preview after resolving the collision.', zh: '已有对象占用此 ID。请处理冲突后重新预览。' },
  'record.configRestoreScope': { en: 'Scope', zh: '范围' },
  'record.configRestoreDirection': { en: 'Direction', zh: '方向' },
  'record.configRestoreBlocked': { en: 'This preview is not executable.', zh: '此预览不可执行。' },
  'record.configRestoreBoolYes': { en: 'yes', zh: '是' },
  'record.configRestoreBoolNo': { en: 'no', zh: '否' },
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

  // T8-2 Reset UI T-source picker (ResetToPointPicker.vue, R5b strict-zero closeout — the component was born
  // after the i18n line closed and shipped all-English; flag (pitResetEnabled) is dormant by default so this
  // is a shape-only migration, no behavior change).
  'record.resetPickerHeading': { en: 'Reset this sheet to a Global History point', zh: '将此数据表重置到某个全局历史点' },
  'record.resetPickerHistoryLabel': { en: 'History point', zh: '历史点' },
  'record.resetPickerHistoryPlaceholder': { en: 'Select a recent history batch', zh: '选择一个最近的历史批次' },
  'record.resetPickerRefresh': { en: 'Refresh', zh: '刷新' },
  'record.resetPickerHistoryLoading': { en: 'Loading history points...', zh: '正在加载历史点...' },
  'record.resetPickerHistoryEmpty': { en: 'No recent history batches found.', zh: '未找到最近的历史批次。' },
  'record.resetPickerHistoryUnavailable': { en: 'History points unavailable.', zh: '历史点不可用。' },
  'record.resetPickerExactAnchorNote': {
    en: 'Reset uses an exact, audited point from Global History only — free time entry is not supported.',
    zh: '重置仅使用来自全局历史的精确、可审计的时间点——不支持自由输入时间。',
  },
  'record.resetPickerTargetPrefix': { en: 'Target:', zh: '目标：' },
  'record.resetPickerTargetSuffix': { en: '(your local time)', zh: '（你的本地时间）' },
  'record.resetPickerFromBatch': { en: 'from history batch', zh: '来自历史批次' },
  'record.resetPickerErrorLoad': { en: 'Failed to load history points', zh: '加载历史点失败' },
  'record.resetPickerSystemActor': { en: 'System', zh: '系统' },
  'record.resetPickerDefaultAction': { en: 'update', zh: '更新' },

  // T8-2 Reset UI confirm dialog (ResetConfirmDialog.vue, R5c strict-zero closeout — the final microslice of
  // this line; ResetToPointPicker/R5b was the other post-closure component, now landed). Static labels only;
  // the asOf/count-interpolated strings live in the helper functions below.
  'record.resetConfirmDialogAria': { en: 'Reset sheet to a point in time', zh: '将数据表重置到某个时间点' },
  'record.resetConfirmCancelAria': { en: 'Cancel', zh: '取消' },
  'record.resetConfirmLoading': { en: 'Loading preview…', zh: '正在加载预览…' },
  'record.resetConfirmSubmitting': { en: 'Applying the recovery…', zh: '正在执行恢复…' },
  'record.resetConfirmNoChanges': { en: 'This history point already matches the current sheet.', zh: '当前数据表已与该历史点一致。' },
  'record.resetConfirmViewInTrash': { en: 'View in Trash', zh: '在回收站中查看' },
  'record.resetConfirmErrorDisabled': { en: 'Reset is not enabled here.', zh: '此处未启用重置。' },
  'record.resetConfirmErrorForbidden': { en: 'You do not have permission to reset this sheet.', zh: '你没有权限重置此数据表。' },
  'record.resetConfirmErrorBlocked': { en: 'A target record is locked or denied — nothing was changed.', zh: '某条目标记录被锁定或拒绝 — 未做任何更改。' },
  'record.resetConfirmErrorStale': { en: 'The sheet changed since the preview — please re-preview and try again.', zh: '数据表在预览之后已发生变化 — 请重新预览后再试。' },
  'record.resetConfirmErrorTooLarge': { en: 'This sheet has too many records for a one-shot reset.', zh: '此数据表记录过多，无法一次性重置。' },
  // The 400 (type-mismatch) response fires when the operator's typed confirm text didn't match the server's
  // expected literal. `reset` is the same server-authoritative token as the type-to-confirm input below — kept
  // untranslated in both locales.
  'record.resetConfirmErrorTypeMismatch': { en: 'Type "reset" to confirm.', zh: '请输入 "reset" 以确认。' },
  'record.resetConfirmErrorGeneric': { en: 'Reset could not be completed. Please re-preview and try again.', zh: '重置未能完成。请重新预览后再试。' },
  'record.resetConfirmErrorAnchorInvalid': {
    en: "This isn't a valid exact history point. Refresh and choose a batch from the list.",
    zh: '这不是一个有效的精确历史点。请刷新并从列表中重新选择一个批次。',
  },
  'record.resetConfirmErrorCheckpoint': {
    en: 'No trusted history checkpoint covers this point any more — choose a more recent one.',
    zh: '没有可信的历史检查点覆盖该时间点了——请选择一个更近的时间点。',
  },
  'record.resetConfirmErrorTrustRequired': {
    en: "Reset is unavailable — this sheet's history trust could not be verified.",
    zh: '重置不可用——无法验证此数据表的历史可信度。',
  },
  'record.resetConfirmErrorSchemaDrift': {
    en: 'The schema changed since this point — re-preview or choose a different point.',
    zh: '自该时间点以来结构已发生变化——请重新预览或选择其他时间点。',
  },
  'record.resetConfirmErrorLinkIntegrity': {
    en: 'A related link target is missing or invalid — nothing was changed.',
    zh: '相关联的链接目标缺失或无效——未做任何更改。',
  },
  'record.resetConfirmErrorValueInvalid': {
    en: 'A target value is no longer valid for the current schema — nothing was changed.',
    zh: '某个目标值对当前结构已不再有效——未做任何更改。',
  },
  'record.resetConfirmErrorInboundUnprovable': {
    en: "This reset can't restore deleted records safely — nothing was changed.",
    zh: '此次重置无法安全地恢复已删除的记录——未做任何更改。',
  },
  // The three inline-bold words in the destructive warning paragraph. Word-for-word bold placement doesn't
  // map 1:1 to Chinese, so the zh values are chosen so the concatenated sentence (built from these plus the
  // resetConfirmWarn* helpers below, in the same fixed template slots) still reads naturally.
  'record.resetConfirmWarnResetWord': { en: 'Reset', zh: '重置' },
  'record.resetConfirmWarnNotWord': { en: 'not', zh: '并不是' },
  'record.resetConfirmRevertWord': { en: 'Revert', zh: '回退' },
  'record.resetConfirmWarnBeforeNot': { en: '— recoverable from Trash, but this is', zh: '——可从回收站中恢复，但这' },
  'record.resetConfirmWarnInstead': { en: 'instead — it changes nothing destructively.', zh: '代替 — 它不会进行任何破坏性更改。' },
  'record.resetConfirmTypePrefix': { en: 'Type', zh: '输入' },
  'record.resetConfirmTypeSuffix': { en: 'to confirm:', zh: '以确认：' },
  'record.resetConfirmTypeAria': { en: 'type reset to confirm', zh: '输入 reset 以确认' },
}

export function recordLabel(key: MetaRecordLabelKey, isZh: boolean): string {
  const entry = META_RECORD_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// BS-4: map a wire skip-reason (preview: unavailable/version_unavailable/unsupported/snapshot_unavailable/
// schema_drift/no_change · execute: denied/conflict/forbidden/error) to its typed label. Unknown → raw reason
// (forward-compatible if the backend adds a reason). Keeps the FE a faithful client of the wire taxonomy.
const BATCH_REASON_KEYS: Record<string, MetaRecordLabelKey> = {
  unavailable: 'record.batchReasonUnavailable',
  version_unavailable: 'record.batchReasonVersionUnavailable',
  unsupported: 'record.batchReasonUnsupported',
  snapshot_unavailable: 'record.batchReasonSnapshotUnavailable',
  schema_drift: 'record.batchReasonSchemaDrift',
  no_change: 'record.batchReasonNoChange',
  denied: 'record.batchReasonDenied',
  conflict: 'record.batchReasonConflict',
  forbidden: 'record.batchReasonForbidden',
  error: 'record.batchReasonError',
}
export function batchSkipReasonLabel(reason: string | undefined, isZh: boolean): string {
  if (!reason) return ''
  const key = BATCH_REASON_KEYS[reason]
  return key ? recordLabel(key, isZh) : reason
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

// configRestoreTypedConfirm: the T9-W destructive-tier typed-confirm input prompt
// (MetaConfigHistoryModal). `confirmToken` is one of the server-defined
// ConfigRestoreExecuteConfirm literals ('uncreate' | 'undelete' | 'revert-permission')
// — it is what the operator must literally type, so it is interpolated raw and
// never translated; only the surrounding copy is.
export function configRestoreTypedConfirm(confirmToken: string, isZh: boolean): string {
  return isZh ? `输入 ${confirmToken} 以确认：` : `Type ${confirmToken} to confirm:`
}

// resetPickerRecordCount: the affected-record count fragment of a Global History batch label
// (ResetToPointPicker's historyBatchLabel, R5b). EN keeps the original singular/plural literal
// ('1 record' / 'N records'); zh uses the measure-word form. The number itself is never translated.
export function resetPickerRecordCount(count: number, isZh: boolean): string {
  if (isZh) return `${count} 条记录`
  return count === 1 ? '1 record' : `${count} records`
}

// R11 back-reference: History Center badge for a `source='restore'` change that carries a source version.
export function restoredFromVersionBadge(version: number, isZh: boolean): string {
  return isZh ? `从版本 ${version} 恢复` : `Restored from v${version}`
}

/**
 * Person before-side name resolution (OD-P2): mark a DEACTIVATED person in a History diff.
 * Scoped to the History Center diff on purpose — the shared `formatFieldDisplay` renders person summaries
 * as bare `display` strings and is also used by the grid/record-drawer, so the marker is applied where the
 * diff builds its own summaries rather than by changing the shared formatter for every surface.
 */
export function inactivePersonDisplay(display: string, isZh: boolean): string {
  return isZh ? `${display}（已停用）` : `${display} (deactivated)`
}

// --- ResetConfirmDialog.vue interpolation helpers (R5c; W2 exact-anchor) ---
// `asOf` here is DISPLAY TEXT ONLY (the selected anchor's createdAt, snapshotted when the dialog opens) —
// it is never sent over the wire; the destructive authority is the exclusive historyBatchId/anchorOperationId
// anchor. Record counts are wire summary numbers. Both are always interpolated raw, never translated. Each
// helper below reconstructs one EN sentence byte-for-byte (verified against a before/after DOM snapshot diff)
// plus its zh counterpart.

// resetConfirmEntryLabel: the destructive entry button ("Reset to <T>…").
export function resetConfirmEntryLabel(asOf: string, isZh: boolean): string {
  return isZh ? `重置到 ${asOf}…` : `Reset to ${asOf}…`
}

// resetConfirmTitle: the dialog header ("Reset sheet to <T>").
export function resetConfirmTitle(asOf: string, isZh: boolean): string {
  return isZh ? `将数据表重置到 ${asOf}` : `Reset sheet to ${asOf}`
}

// resetConfirmBlockedResurrectMessage: preview-time block — a preview whose plan would need to restore
// `resurrectCount` deleted record(s) can never become executable (exact-anchor kernel fails RESURRECT closed
// as `inbound-unprovable`). Rendered INSTEAD of the revert/destructive confirm branches, never alongside them.
export function resetConfirmBlockedResurrectMessage(resurrectCount: number, isZh: boolean): string {
  return isZh
    ? `无法重置到该时间点——这需要恢复 ${resurrectCount} 条已删除的记录，当前不支持该操作。请选择一个更近的历史点。`
    : `Can't reset to this point — it would require restoring ${resurrectCount} deleted record(s), which isn't supported. Choose a more recent history point.`
}

// resetConfirmResultSummary: the post-execute result line. A non-destructive Revert-equivalent
// does not mention the recycle bin; destructive Reset reports both deleted and reverted counts.
export function resetConfirmResultSummary(deletedCount: number, revertedCount: number, asOf: string, isZh: boolean): string {
  if (deletedCount === 0) {
    return isZh
      ? `${revertedCount} 条记录已回退到 ${asOf}。`
      : `${revertedCount} record(s) reverted to ${asOf}.`
  }
  return isZh
    ? `${deletedCount} 条记录已移至回收站 · ${revertedCount} 条记录已回退到 ${asOf}。`
    : `${deletedCount} record(s) moved to the recycle bin · ${revertedCount} reverted to ${asOf}.`
}

// resetConfirmRevertEquivIntro: the non-destructive (deleteCount===0) explanatory sentence, up to
// (not including) the bolded "Revert" word that follows it in the template.
export function resetConfirmRevertEquivIntro(asOf: string, revertCount: number, isZh: boolean): string {
  return isZh
    ? `${asOf} 之后没有新建任何记录。这会将 ${revertCount} 条记录回退到它们在 ${asOf} 时的状态 — 非破坏性操作，等同于`
    : `Nothing was created after ${asOf}. This reverts ${revertCount} record(s) to their state at ${asOf} — non-destructive, the same as`
}

// resetConfirmRevertButtonLabel: the non-destructive confirm button ("Revert to <T>").
export function resetConfirmRevertButtonLabel(asOf: string, isZh: boolean): string {
  return isZh ? `回退到 ${asOf}` : `Revert to ${asOf}`
}

// resetConfirmDestructiveButtonLabel: the destructive confirm button ("Reset — move N to recycle bin").
export function resetConfirmDestructiveButtonLabel(deleteCount: number, isZh: boolean): string {
  return isZh ? `重置 — 将 ${deleteCount} 条记录移至回收站` : `Reset — move ${deleteCount} to recycle bin`
}

// resetConfirmAckLabel: the destructive-path acknowledgement checkbox copy.
export function resetConfirmAckLabel(deleteCount: number, isZh: boolean): string {
  return isZh
    ? `我知道 ${deleteCount} 条记录将被移至回收站。`
    : `I understand ${deleteCount} record(s) will be moved to the recycle bin.`
}

// resetConfirmWarnRevertsAt: destructive-warning clause 1, between the bolded "Reset" and the bolded
// delete-clause below.
export function resetConfirmWarnRevertsAt(asOf: string, isZh: boolean): string {
  return isZh ? `会将每条记录回退到其在 ${asOf} 时的状态` : `reverts every record to its state at ${asOf}`
}

// resetConfirmWarnDeleteClause: the bolded delete clause inside the destructive warning paragraph.
export function resetConfirmWarnDeleteClause(deleteCount: number, asOf: string, isZh: boolean): string {
  return isZh
    ? `并将 ${asOf} 之后新建的 ${deleteCount} 条记录移至回收站`
    : `and moves the ${deleteCount} record(s) created after ${asOf} to the recycle bin`
}

// resetConfirmWarnAfterNot: destructive-warning clause between the bolded "not" and the bolded "Revert"
// that follows (covers the asOf-embedded "Need to keep records created after <T>?" sub-clause).
export function resetConfirmWarnAfterNot(asOf: string, isZh: boolean): string {
  return isZh
    ? `一次普通恢复。如果需要保留 ${asOf} 之后新建的记录，请使用`
    : `a normal restore. Need to keep records created after ${asOf}? Use`
}
