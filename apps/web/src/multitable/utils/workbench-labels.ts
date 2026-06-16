// Workbench UI string table — single source for MultitableWorkbench.vue (T2)
// localization, plus MetaTemplateCard's count/button strings.
//
// EN + ZH both explicit (unlike category-labels.ts, where the data layer is
// English and we only translate). Components read `useLocale().isZh` and call
// `workbenchLabel(key, isZh)` for static strings, or the interpolation helpers
// below for strings with counts / ids / optional segments.
//
// Scope: see docs/development/multitable-workbench-i18n-t2-development-20260519.md.
// `<kbd>` physical key names are NOT translated and are NOT in this table.
// Dynamic helpers and fallback toasts are added incrementally in T3E.

export type WorkbenchLabelKey =
  // §3.0 script-computed shell (interpolated variants live in the helpers)
  | 'conflict.fieldFallback'
  // §3.1 conflict banner
  | 'conflict.title' | 'conflict.reload' | 'conflict.retry' | 'conflict.dismiss'
  // §3.2 toolbar
  | 'toolbar.commentInbox' | 'toolbar.fields' | 'toolbar.access' | 'toolbar.views'
  | 'toolbar.workflow' | 'toolbar.automations' | 'toolbar.templates'
  | 'toolbar.dashboard' | 'toolbar.shareForm' | 'toolbar.apiWebhooks'
  | 'toolbar.mentions'
  // §3.3 template library modal
  | 'tpl.title' | 'tpl.subtitle' | 'tpl.loading' | 'tpl.more' | 'tpl.errorLoad'
  // §3.4 keyboard shortcuts modal (explanatory text only)
  | 'kbd.title' | 'kbd.navigateCells' | 'kbd.editCell' | 'kbd.cancelClose'
  | 'kbd.nextCell' | 'kbd.copy' | 'kbd.paste' | 'kbd.undo' | 'kbd.redo'
  | 'kbd.toggleHelp'
  // §3.5 static (non-interpolated) toast subset
  | 'toast.recordCreateBlocked' | 'toast.recordEditBlocked' | 'toast.recordDeleteBlocked'
  | 'toast.datesUpdated' | 'toast.hierarchyUpdated' | 'toast.recordDeleted' | 'toast.recordDuplicated'
  | 'toast.recordLocked' | 'toast.recordUnlocked' | 'toast.recordLockFailed'
  | 'toast.loadedLatest' | 'toast.changeReapplied' | 'toast.recordUpdated'
  | 'toast.commentUpdated' | 'toast.commentAdded'
  | 'toast.commentResolved' | 'toast.commentDeleted' | 'toast.linkedRecordsUpdated'
  | 'toast.viewSettingsSaved'
  // T3E-1 template-library fallback/toast residuals
  | 'toast.templateInstallBlocked' | 'toast.templateRefreshFailed'
  | 'toast.templateInstallFailed'
  // T3E-2 Workbench dynamic fallback/confirm residuals
  | 'toast.timelineDatesUpdateFailed' | 'toast.hierarchyParentUpdateFailed'
  | 'toast.formSubmitFailed'
  | 'toast.commentUpdateFailed' | 'toast.commentAddFailed'
  | 'toast.commentResolveFailed' | 'toast.commentDeleteFailed'
  | 'toast.commentReactFailed'
  | 'toast.buttonRunSuccess' | 'toast.buttonRunFailed'
  | 'toast.linkedRecordsUpdateFailed'
  | 'toast.fieldCreateFailed' | 'toast.fieldUpdateFailed' | 'toast.fieldDeleteFailed'
  | 'toast.viewCreateFailed' | 'toast.viewUpdateFailed' | 'toast.viewDeleteFailed'
  | 'toast.sheetAccessRefreshFailed'
  | 'toast.sheetCreateBlocked' | 'toast.sheetRefreshFailed' | 'toast.sheetCreateFailed'
  | 'toast.baseLoadFailed' | 'toast.contextSyncFailed'
  | 'toast.externalContextBusy' | 'toast.externalContextUnsaved'
  | 'toast.baseCreateBlocked' | 'toast.baseCreateFailed'
  | 'toast.importCancelled' | 'toast.importFailed'
  | 'toast.excelExportFailed' | 'toast.bulkDeleteFailed'
  | 'toast.workbenchInitFailed'
  | 'confirm.discardContextChanges' | 'confirm.discardRecordChanges'
  | 'confirm.pageLeaveBusy' | 'confirm.pageLeaveDirty'
  // §3.6 MetaTemplateCard button (counts use the card* helpers below)
  | 'card.install' | 'card.installing'
  // S2 template detail + dry-run (design 20260611 §2.2)
  | 'card.viewDetail'
  | 'detail.back' | 'detail.loading' | 'detail.notFound'
  | 'detail.fieldsTitle' | 'detail.viewsTitle'
  | 'detail.colFieldName' | 'detail.colFieldType' | 'detail.groupBy'
  | 'detail.checkInstallable' | 'detail.checking' | 'detail.dryRunFailed'
  | 'detail.installableYes' | 'detail.installableNo'
  | 'detail.wouldCreateTitle' | 'detail.conflictsTitle' | 'detail.conflictHint'
  // final audit closure follow-up: composable fallback messages (backend e.message remains raw)
  | 'error.loadSheets' | 'error.loadSheetMetadata' | 'error.loadBaseMetadata'

const WORKBENCH_LABELS: Record<WorkbenchLabelKey, { en: string; zh: string }> = {
  'conflict.fieldFallback': { en: 'cell', zh: '单元格' },

  'conflict.title': { en: 'Update conflict', zh: '更新冲突' },
  'conflict.reload': { en: 'Reload latest', zh: '重新加载最新' },
  'conflict.retry': { en: 'Retry change', zh: '重试本次修改' },
  'conflict.dismiss': { en: 'Dismiss', zh: '忽略' },

  'toolbar.commentInbox': { en: 'Comment Inbox', zh: '评论收件箱' },
  'toolbar.fields': { en: 'Fields', zh: '字段' },
  'toolbar.access': { en: 'Access', zh: '权限' },
  'toolbar.views': { en: 'Views', zh: '视图' },
  'toolbar.workflow': { en: 'Workflow', zh: '工作流' },
  'toolbar.automations': { en: 'Automations', zh: '自动化' },
  'toolbar.templates': { en: 'Templates', zh: '模板' },
  'toolbar.dashboard': { en: 'Dashboard', zh: '仪表盘' },
  'toolbar.shareForm': { en: 'Share Form', zh: '分享表单' },
  'toolbar.apiWebhooks': { en: 'API & Webhooks', zh: 'API 与 Webhook' },
  'toolbar.mentions': { en: 'Mentions', zh: '提及' },

  'tpl.title': { en: 'Template Library', zh: '模板库' },
  'tpl.subtitle': {
    en: 'Start a new base from a built-in workspace pattern.',
    zh: '从内置工作区模板新建一个 Base',
  },
  'tpl.loading': { en: 'Loading templates...', zh: '正在加载模板...' },
  'tpl.more': { en: 'More templates →', zh: '更多模板 →' },
  'tpl.errorLoad': { en: 'Failed to load templates', zh: '加载模板失败' },

  'kbd.title': { en: 'Keyboard Shortcuts', zh: '键盘快捷键' },
  'kbd.navigateCells': { en: 'Navigate cells', zh: '导航单元格' },
  'kbd.editCell': { en: 'Edit cell', zh: '编辑单元格' },
  'kbd.cancelClose': { en: 'Cancel edit / close', zh: '取消编辑 / 关闭' },
  'kbd.nextCell': { en: 'Next cell', zh: '下一个单元格' },
  'kbd.copy': { en: 'Copy cell value', zh: '复制单元格值' },
  'kbd.paste': { en: 'Paste into cell', zh: '粘贴到单元格' },
  'kbd.undo': { en: 'Undo', zh: '撤销' },
  'kbd.redo': { en: 'Redo', zh: '重做' },
  'kbd.toggleHelp': { en: 'Toggle this help', zh: '切换此帮助' },

  'toast.recordCreateBlocked': {
    en: 'Record creation is not allowed in this view.',
    zh: '当前视图不允许创建记录。',
  },
  'toast.recordEditBlocked': {
    en: 'Record editing is not allowed for this row.',
    zh: '该行不允许编辑记录。',
  },
  'toast.recordDeleteBlocked': {
    en: 'Record deletion is not allowed for this row.',
    zh: '该行不允许删除记录。',
  },
  'toast.datesUpdated': { en: 'Dates updated', zh: '日期已更新' },
  'toast.hierarchyUpdated': { en: 'Hierarchy updated', zh: '层级已更新' },
  'toast.recordDeleted': { en: 'Record deleted', zh: '记录已删除' },
  'toast.recordDuplicated': { en: 'Record duplicated', zh: '记录已复制' },
  'toast.recordLocked': { en: 'Record locked', zh: '记录已锁定' },
  'toast.recordUnlocked': { en: 'Record unlocked', zh: '记录已解锁' },
  'toast.recordLockFailed': { en: 'Failed to update record lock', zh: '更新锁定状态失败' },
  'toast.loadedLatest': { en: 'Loaded the latest row state', zh: '已加载最新行状态' },
  'toast.changeReapplied': { en: 'Change reapplied', zh: '修改已重新应用' },
  'toast.recordUpdated': { en: 'Record updated', zh: '记录已更新' },
  'toast.commentUpdated': { en: 'Comment updated', zh: '评论已更新' },
  'toast.commentAdded': { en: 'Comment added', zh: '评论已添加' },
  'toast.commentResolved': { en: 'Comment resolved', zh: '评论已解决' },
  'toast.commentDeleted': { en: 'Comment deleted', zh: '评论已删除' },
  'toast.linkedRecordsUpdated': { en: 'Linked records updated', zh: '关联记录已更新' },
  'toast.viewSettingsSaved': { en: 'View settings saved', zh: '视图设置已保存' },
  'toast.templateInstallBlocked': {
    en: 'Template installation requires multitable write access.',
    zh: '安装模板需要多维表写入权限。',
  },
  'toast.templateRefreshFailed': {
    en: 'Installed template but failed to refresh workbench context',
    zh: '模板已安装，但刷新工作台上下文失败',
  },
  'toast.templateInstallFailed': {
    en: 'Failed to install template',
    zh: '安装模板失败',
  },
  'toast.timelineDatesUpdateFailed': { en: 'Failed to update timeline dates', zh: '更新时间线日期失败' },
  'toast.hierarchyParentUpdateFailed': { en: 'Failed to update hierarchy parent', zh: '更新层级父记录失败' },
  'toast.formSubmitFailed': { en: 'Form submit failed', zh: '表单提交失败' },
  'toast.commentUpdateFailed': { en: 'Failed to update comment', zh: '更新评论失败' },
  'toast.commentAddFailed': { en: 'Failed to add comment', zh: '添加评论失败' },
  'toast.commentResolveFailed': { en: 'Failed to resolve comment', zh: '解决评论失败' },
  'toast.commentDeleteFailed': { en: 'Failed to delete comment', zh: '删除评论失败' },
  'toast.commentReactFailed': { en: 'Failed to update reaction', zh: '更新表情失败' },
  'toast.buttonRunSuccess': { en: 'Button action ran', zh: '按钮已执行' },
  'toast.buttonRunFailed': { en: 'Button action failed', zh: '按钮执行失败' },
  'toast.linkedRecordsUpdateFailed': { en: 'Failed to update linked records', zh: '更新关联记录失败' },
  'toast.fieldCreateFailed': { en: 'Failed to create field', zh: '创建字段失败' },
  'toast.fieldUpdateFailed': { en: 'Failed to update field', zh: '更新字段失败' },
  'toast.fieldDeleteFailed': { en: 'Failed to delete field', zh: '删除字段失败' },
  'toast.viewCreateFailed': { en: 'Failed to create view', zh: '创建视图失败' },
  'toast.viewUpdateFailed': { en: 'Failed to update view', zh: '更新视图失败' },
  'toast.viewDeleteFailed': { en: 'Failed to delete view', zh: '删除视图失败' },
  'toast.sheetAccessRefreshFailed': { en: 'Failed to refresh sheet access', zh: '刷新 Sheet 权限失败' },
  'toast.sheetCreateBlocked': {
    en: 'Sheet creation requires multitable write access.',
    zh: '创建 Sheet 需要多维表写入权限。',
  },
  'toast.sheetRefreshFailed': {
    en: 'Created sheet but failed to refresh workbench context',
    zh: 'Sheet 已创建，但刷新工作台上下文失败',
  },
  'toast.sheetCreateFailed': { en: 'Failed to create sheet', zh: '创建 Sheet 失败' },
  'toast.baseLoadFailed': { en: 'Failed to load base', zh: '加载 Base 失败' },
  'toast.contextSyncFailed': { en: 'Failed to sync workbench context', zh: '同步工作台上下文失败' },
  'toast.externalContextBusy': {
    en: 'Host multitable context change is waiting for the current save or import to finish.',
    zh: '宿主多维表上下文变更正在等待当前保存或导入完成。',
  },
  'toast.externalContextUnsaved': {
    en: 'Host multitable context changed while unsaved drafts are open. Resolve or discard changes to continue.',
    zh: '宿主多维表上下文已变更。请处理或放弃未保存草稿后继续。',
  },
  'toast.baseCreateBlocked': {
    en: 'Base creation requires multitable write access.',
    zh: '创建 Base 需要多维表写入权限。',
  },
  'toast.baseCreateFailed': { en: 'Failed to create base', zh: '创建 Base 失败' },
  'toast.importCancelled': { en: 'Import cancelled', zh: '导入已取消' },
  'toast.importFailed': { en: 'Import failed', zh: '导入失败' },
  'toast.excelExportFailed': { en: 'Excel export failed', zh: 'Excel 导出失败' },
  'toast.bulkDeleteFailed': { en: 'Bulk delete failed', zh: '批量删除失败' },
  'toast.workbenchInitFailed': { en: 'Failed to initialize workbench', zh: '初始化工作台失败' },

  'confirm.discardContextChanges': {
    en: 'Discard unsaved changes before leaving the current sheet or view?',
    zh: '离开当前 Sheet 或视图前放弃未保存的更改吗？',
  },
  'confirm.discardRecordChanges': {
    en: 'Discard unsaved record changes?',
    zh: '放弃未保存的记录更改吗？',
  },
  'confirm.pageLeaveBusy': {
    en: 'Leave the multitable while the current save or import is still running?',
    zh: '当前保存或导入仍在进行，确定离开多维表吗？',
  },
  'confirm.pageLeaveDirty': {
    en: 'Discard unsaved multitable changes before leaving this page?',
    zh: '离开此页面前放弃未保存的多维表更改吗？',
  },

  'card.install': { en: 'Use template', zh: '使用模板' },
  'card.installing': { en: 'Installing...', zh: '创建中...' },

  'card.viewDetail': { en: 'View details', zh: '查看详情' },
  'detail.back': { en: '← Back to template center', zh: '← 返回模板中心' },
  'detail.loading': { en: 'Loading template...', zh: '正在加载模板...' },
  'detail.notFound': { en: 'Template not found.', zh: '未找到该模板。' },
  'detail.fieldsTitle': { en: 'Fields', zh: '字段' },
  'detail.viewsTitle': { en: 'Views', zh: '视图' },
  'detail.colFieldName': { en: 'Field', zh: '字段名称' },
  'detail.colFieldType': { en: 'Type', zh: '类型' },
  'detail.groupBy': { en: 'Grouped by', zh: '分组字段' },
  'detail.checkInstallable': { en: 'Check installability', zh: '检查可安装性' },
  'detail.checking': { en: 'Checking...', zh: '检查中...' },
  'detail.dryRunFailed': { en: 'Installability check failed', zh: '可安装性检查失败' },
  'detail.installableYes': {
    en: 'Ready to install — no conflicts detected.',
    zh: '可以安装——未检测到冲突。',
  },
  'detail.installableNo': {
    en: 'Conflicts detected — install is blocked.',
    zh: '检测到冲突——安装已被阻止。',
  },
  'detail.wouldCreateTitle': { en: 'Will create', zh: '将创建' },
  'detail.conflictsTitle': { en: 'Conflicts', zh: '冲突' },
  // Review 2026-06-11 F4: truthful copy — baseName never enters id
  // derivation (and the detail page has no baseName input), so the hint must
  // not suggest renaming; a re-check is what can change the outcome.
  'detail.conflictHint': {
    en: 'Existing objects conflict with this template. Re-check before installing.',
    zh: '存在与模板冲突的对象，安装前请重新检查。',
  },

  'error.loadSheets': { en: 'Failed to load sheets', zh: '加载 Sheet 失败' },
  'error.loadSheetMetadata': { en: 'Failed to load sheet metadata', zh: '加载 Sheet 元数据失败' },
  'error.loadBaseMetadata': { en: 'Failed to load base metadata', zh: '加载 Base 元数据失败' },
}

export function workbenchLabel(key: WorkbenchLabelKey, isZh: boolean): string {
  const entry = WORKBENCH_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation helpers (not keys) ---

// conflictMessage: `{field} changed elsewhere.[ Latest version is {v}.] Reload
// the row or retry your edit.` — the version segment is OPTIONAL (omitted when
// version is not a finite number). Output never contains literal `[` / `]`.
export function conflictMessage(field: string, version: number | null | undefined, isZh: boolean): string {
  const hasVersion = typeof version === 'number' && Number.isFinite(version)
  if (isZh) {
    const versionPart = hasVersion ? ` 最新版本为 ${version}。` : ''
    return `${field} 已在别处被修改。${versionPart} 请重新加载该行或重试你的修改。`
  }
  const versionPart = hasVersion ? ` Latest version is ${version}.` : ''
  return `${field} changed elsewhere.${versionPart} Reload the row or retry your edit.`
}

// presenceLabel: en pluralizes ("1 active collaborator" / "N active
// collaborators"); zh has no plural.
export function presenceLabel(n: number, isZh: boolean): string {
  if (isZh) return `${n} 位活跃协作者`
  return `${n} active collaborator${n === 1 ? '' : 's'}`
}

// presenceTitle: ids joined as-is (user ids are not translated); empty -> a
// "no collaborators" message.
export function presenceTitle(ids: string[], isZh: boolean): string {
  if (ids.length === 0) return isZh ? '无活跃协作者' : 'No active collaborators'
  return isZh ? `当前在线：${ids.join(', ')}` : `Active now: ${ids.join(', ')}`
}

// commentInboxTitle: n>0 -> "{n} comment updates need attention"; n===0 ->
// "Open comment inbox" (the no-badge title).
export function commentInboxTitle(n: number, isZh: boolean): string {
  if (n > 0) return isZh ? `${n} 条评论待处理` : `${n} comment updates need attention`
  return isZh ? '打开评论收件箱' : 'Open comment inbox'
}

export function mentionsUnread(n: number, isZh: boolean): string {
  return isZh ? `${n} 条未读` : `${n} unread`
}

export function mentionsRecords(n: number, isZh: boolean): string {
  return isZh ? `${n} 条记录` : `${n} record${n === 1 ? '' : 's'}`
}

// Template names are user/data values and pass through raw.
export function templateInstalled(templateName: string, isZh: boolean): string {
  return isZh ? `已安装 ${templateName}` : `Installed ${templateName}`
}

export function formSubmitSuccess(mode: 'create' | 'update', isZh: boolean): string {
  if (mode === 'create') return isZh ? '记录已创建' : 'Record created'
  return isZh ? '更改已保存' : 'Changes saved'
}

export function recordsImported(n: number, isZh: boolean): string {
  return isZh ? `${n} 条记录已导入` : `${n} record${n === 1 ? '' : 's'} imported`
}

export function recordsFailedToImport(
  n: number,
  rowNumbers: number[],
  firstError: string,
  isZh: boolean,
): string {
  const errorPart = firstError.trim()
  if (isZh) {
    const rows = rowNumbers.length > 0 ? `（${rowNumbers.map((row) => `第 ${row} 行`).join('，')}）` : ''
    const error = errorPart ? `。${errorPart}` : ''
    return `${n} 条记录导入失败${rows}${error}`.trim()
  }
  const rows = rowNumbers.length > 0 ? ` (${rowNumbers.map((row) => `row ${row}`).join(', ')})` : ''
  const error = errorPart ? `. ${errorPart}` : ''
  return `${n} record${n === 1 ? '' : 's'} failed to import${rows}${error}`.trim()
}

export function duplicateRowsSkipped(n: number, isZh: boolean): string {
  return isZh ? `${n} 条重复行已跳过` : `${n} duplicate row${n === 1 ? '' : 's'} skipped`
}

export function recordsDeleted(n: number, isZh: boolean): string {
  return isZh ? `${n} 条记录已删除` : `${n} record${n === 1 ? '' : 's'} deleted`
}

export function recordNotFound(recordId: string, isZh: boolean): string {
  return isZh ? `未找到记录：${recordId}` : `Record not found: ${recordId}`
}

// S2 dry-run conflicts: the server emits English messages plus a stable
// `kind`; the client localizes by kind (formula dry-run convention) and may
// show the raw message as secondary detail. Unknown kinds pass through raw.
export function templateConflictKindLabel(kind: string, isZh: boolean): string {
  switch (kind) {
    case 'base_exists': return isZh ? 'Base 已存在' : 'Base already exists'
    case 'sheet_exists': return isZh ? 'Sheet 已存在' : 'Sheet already exists'
    case 'view_exists': return isZh ? '视图已存在' : 'View already exists'
    case 'template_duplicate_id': return isZh ? '模板内部 id 重复' : 'Duplicate id inside template'
    default: return kind
  }
}

// MetaTemplateCard counts: zh "{n} 个 Sheet/字段/视图"; en pluralized.
export function cardSheets(n: number, isZh: boolean): string {
  return isZh ? `${n} 个 Sheet` : `${n} sheet${n === 1 ? '' : 's'}`
}

export function cardFields(n: number, isZh: boolean): string {
  return isZh ? `${n} 个字段` : `${n} field${n === 1 ? '' : 's'}`
}

export function cardViews(n: number, isZh: boolean): string {
  return isZh ? `${n} 个视图` : `${n} view${n === 1 ? '' : 's'}`
}
