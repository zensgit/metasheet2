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
// Dynamic / interpolated / permission / host-context / "Failed to ..." toasts
// are T3 and intentionally absent here.

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
  | 'toast.datesUpdated' | 'toast.hierarchyUpdated' | 'toast.recordDeleted'
  | 'toast.loadedLatest' | 'toast.changeReapplied' | 'toast.recordUpdated'
  | 'toast.formSubmitted' | 'toast.commentUpdated' | 'toast.commentAdded'
  | 'toast.commentResolved' | 'toast.commentDeleted' | 'toast.linkedRecordsUpdated'
  | 'toast.viewSettingsSaved'
  // T3E-1 template-library fallback/toast residuals
  | 'toast.templateInstallBlocked' | 'toast.templateRefreshFailed'
  | 'toast.templateInstallFailed'
  // §3.6 MetaTemplateCard button (counts use the card* helpers below)
  | 'card.install' | 'card.installing'

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
  'toast.loadedLatest': { en: 'Loaded the latest row state', zh: '已加载最新行状态' },
  'toast.changeReapplied': { en: 'Change reapplied', zh: '修改已重新应用' },
  'toast.recordUpdated': { en: 'Record updated', zh: '记录已更新' },
  'toast.formSubmitted': { en: 'Form submitted', zh: '表单已提交' },
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

  'card.install': { en: 'Use template', zh: '使用模板' },
  'card.installing': { en: 'Installing...', zh: '创建中...' },
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
