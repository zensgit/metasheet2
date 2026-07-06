// Workflow Hub label table — UF-7 i18n convergence.
//
// WorkflowHubView.vue was audited (docs/development/ui-foundation-design-lock-20260706.md §6
// UF-7) as the worst zh/en mixing surface in the repo: English headers/buttons ("Workflow Hub",
// "Save view", "Saved Views", chip text) rendered unconditionally over Chinese descriptions and
// dialog copy, regardless of the active locale. This module follows the repo's established
// key-table + `useLocale().isZh` convention (see apps/web/src/multitable/utils/meta-core-labels.ts
// and apps/web/src/composables/useLocale.ts) — the SOLE i18n extension pattern; no vue-i18n, no
// second mechanism.
//
// Scope discipline (UF-7): this table exists to make WorkflowHubView's visible copy
// locale-correct in BOTH directions (zh locale → Chinese everywhere; en locale → English
// everywhere), including the workflow/role/status/source chip text that was previously a bare
// English enum value shown to every locale ("英文枚举裸显").

export type WorkflowHubLabelKey =
  | 'header.title' | 'header.subtitle'
  | 'actions.saveView' | 'actions.saveTeamView' | 'actions.refreshing' | 'actions.refresh' | 'actions.newWorkflow'
  | 'savedViews.title' | 'savedViews.subtitle' | 'savedViews.saveCurrent' | 'savedViews.chip'
  | 'savedViews.updatedPrefix' | 'savedViews.apply' | 'savedViews.delete'
  | 'teamViews.title' | 'teamViews.subtitle' | 'teamViews.saving' | 'teamViews.chip'
  | 'teamViews.ownerPrefix' | 'teamViews.systemOwner'
  | 'workflowCard.title' | 'workflowCard.subtitle' | 'workflowCard.searchPlaceholder'
  | 'workflowCard.loading' | 'workflowCard.apply' | 'workflowCard.loadingDrafts' | 'workflowCard.noMatch'
  | 'workflowCard.colName' | 'workflowCard.colStatus' | 'workflowCard.colRole' | 'workflowCard.colCategory'
  | 'workflowCard.colUpdated' | 'workflowCard.colActions' | 'workflowCard.unnamed' | 'workflowCard.noDescription'
  | 'statusFilter.all' | 'statusFilter.draft' | 'statusFilter.published' | 'statusFilter.archived'
  | 'sortBy.recentlyUpdated' | 'sortBy.recentlyCreated' | 'sortBy.name'
  | 'role.owner' | 'role.editor' | 'role.viewer'
  | 'action.open' | 'action.duplicate' | 'action.archive' | 'action.restore'
  | 'pager.previous' | 'pager.next' | 'pager.zeroItems'
  | 'templateCard.title' | 'templateCard.subtitle' | 'templateCard.searchPlaceholder'
  | 'templateCard.loading' | 'templateCard.apply' | 'templateCard.loadingTemplates' | 'templateCard.noMatch'
  | 'templateCard.requiredPrefix' | 'templateCard.optionalPrefix' | 'templateCard.usagePrefix'
  | 'templateCard.useTemplate' | 'templateCard.noDescription'
  | 'recentTemplates.title' | 'recentTemplates.subtitle' | 'recentTemplates.lastUsedPrefix' | 'recentTemplates.useAgain'
  | 'sourceFilter.all' | 'sourceFilter.builtin' | 'sourceFilter.database'
  | 'templateSortBy.usage' | 'templateSortBy.name' | 'templateSortBy.updated'
  | 'error.loadWorkflowDrafts' | 'error.loadWorkflowTemplates' | 'error.loadTeamViews'
  | 'label.workflowSearchPrefix' | 'label.statusPrefix' | 'label.templateSearchPrefix' | 'label.sourcePrefix'
  | 'label.workflowPagePrefix' | 'label.templatePagePrefix' | 'label.defaultView'
  | 'dialog.saveView.prompt' | 'dialog.saveView.title' | 'dialog.saveView.confirm' | 'dialog.saveView.cancel'
  | 'dialog.saveView.placeholder' | 'dialog.saveView.success'
  | 'dialog.saveTeamView.prompt' | 'dialog.saveTeamView.title' | 'dialog.saveTeamView.placeholder'
  | 'dialog.saveTeamView.success'
  | 'dialog.deleteView.title' | 'dialog.deleteView.confirm' | 'dialog.deleteView.cancel' | 'dialog.deleteView.success'
  | 'dialog.deleteTeamView.title' | 'dialog.deleteTeamView.success' | 'dialog.deleteTeamView.errorFallback'
  | 'dialog.duplicate.title' | 'dialog.duplicate.confirm' | 'dialog.duplicate.placeholder'
  | 'dialog.duplicate.successFallback' | 'dialog.duplicate.errorFallback'
  | 'dialog.restore.title' | 'dialog.restore.confirm' | 'dialog.restore.successFallback' | 'dialog.restore.errorFallback'
  | 'dialog.archive.title' | 'dialog.archive.confirm' | 'dialog.archive.successFallback' | 'dialog.archive.errorFallback'
  | 'dialog.common.cancel'
  | 'session.restored'

const WORKFLOW_HUB_LABELS: Record<WorkflowHubLabelKey, { en: string; zh: string }> = {
  'header.title': { en: 'Workflow Hub', zh: '工作流中心' },
  'header.subtitle': {
    en: 'Draft catalog, template entry points, and the designer starting point for platform workflows.',
    zh: '面向平台流程的草稿目录、模板入口和设计器起点。',
  },

  'actions.saveView': { en: 'Save view', zh: '保存视图' },
  'actions.saveTeamView': { en: 'Save team view', zh: '保存团队视图' },
  'actions.refreshing': { en: 'Refreshing...', zh: '正在刷新...' },
  'actions.refresh': { en: 'Refresh', zh: '刷新' },
  'actions.newWorkflow': { en: 'New workflow', zh: '新建工作流' },

  'savedViews.title': { en: 'Saved Views', zh: '已保存视图' },
  'savedViews.subtitle': {
    en: 'Save the current filter perspective as a reusable entry point.',
    zh: '把当前过滤视角保存成可复用入口。',
  },
  'savedViews.saveCurrent': { en: 'Save current view', zh: '保存当前视图' },
  'savedViews.chip': { en: 'Saved', zh: '已保存' },
  'savedViews.updatedPrefix': { en: 'Updated:', zh: '更新于:' },
  'savedViews.apply': { en: 'Apply view', zh: '应用视图' },
  'savedViews.delete': { en: 'Delete', zh: '删除' },

  'teamViews.title': { en: 'Team Views', zh: '团队视图' },
  'teamViews.subtitle': {
    en: 'Save the current Workflow Hub perspective as a tenant-wide reusable entry point.',
    zh: '把当前工作流中心视角保存成租户内可复用入口。',
  },
  'teamViews.saving': { en: 'Saving...', zh: '保存中...' },
  'teamViews.chip': { en: 'Team', zh: '团队' },
  'teamViews.ownerPrefix': { en: 'Owner:', zh: '所有者:' },
  'teamViews.systemOwner': { en: 'system', zh: '系统' },

  'workflowCard.title': { en: 'Workflow Drafts', zh: '工作流草稿' },
  'workflowCard.subtitle': {
    en: 'Read directly from the draft model; filterable by status, name, and update time.',
    zh: '从草稿模型直接读取，可按状态、名称和更新时间筛选。',
  },
  'workflowCard.searchPlaceholder': { en: 'Search workflows', zh: '搜索工作流' },
  'workflowCard.loading': { en: 'Loading...', zh: '加载中...' },
  'workflowCard.apply': { en: 'Apply', zh: '应用' },
  'workflowCard.loadingDrafts': { en: 'Loading workflow drafts...', zh: '正在加载工作流草稿...' },
  'workflowCard.noMatch': {
    en: 'No workflow drafts matched the current filters.',
    zh: '没有匹配当前筛选条件的工作流草稿。',
  },
  'workflowCard.colName': { en: 'Name', zh: '名称' },
  'workflowCard.colStatus': { en: 'Status', zh: '状态' },
  'workflowCard.colRole': { en: 'Role', zh: '角色' },
  'workflowCard.colCategory': { en: 'Category', zh: '分类' },
  'workflowCard.colUpdated': { en: 'Updated', zh: '更新时间' },
  'workflowCard.colActions': { en: 'Actions', zh: '操作' },
  'workflowCard.unnamed': { en: 'Unnamed workflow', zh: '未命名工作流' },
  'workflowCard.noDescription': { en: 'No description', zh: '无描述' },

  'statusFilter.all': { en: 'All status', zh: '全部状态' },
  'statusFilter.draft': { en: 'Draft', zh: '草稿' },
  'statusFilter.published': { en: 'Published', zh: '已发布' },
  'statusFilter.archived': { en: 'Archived', zh: '已归档' },

  'sortBy.recentlyUpdated': { en: 'Recently updated', zh: '最近更新' },
  'sortBy.recentlyCreated': { en: 'Recently created', zh: '最近创建' },
  'sortBy.name': { en: 'Name', zh: '名称' },

  'role.owner': { en: 'Owner', zh: '所有者' },
  'role.editor': { en: 'Editor', zh: '编辑者' },
  'role.viewer': { en: 'Viewer', zh: '查看者' },

  'action.open': { en: 'Open', zh: '打开' },
  'action.duplicate': { en: 'Duplicate', zh: '复制' },
  'action.archive': { en: 'Archive', zh: '归档' },
  'action.restore': { en: 'Restore', zh: '恢复' },

  'pager.previous': { en: 'Previous', zh: '上一页' },
  'pager.next': { en: 'Next', zh: '下一页' },
  'pager.zeroItems': { en: '0 items', zh: '0 项' },

  'templateCard.title': { en: 'Template Catalog', zh: '模板目录' },
  'templateCard.subtitle': {
    en: 'Filterable by built-in / database source; jump directly into the designer to instantiate.',
    zh: '支持内置 / 数据库来源过滤，可直接进入设计器实例化。',
  },
  'templateCard.searchPlaceholder': { en: 'Search templates', zh: '搜索模板' },
  'templateCard.loading': { en: 'Loading...', zh: '加载中...' },
  'templateCard.apply': { en: 'Apply', zh: '应用' },
  'templateCard.loadingTemplates': { en: 'Loading templates...', zh: '正在加载模板...' },
  'templateCard.noMatch': {
    en: 'No templates matched the current filters.',
    zh: '没有匹配当前筛选条件的模板。',
  },
  'templateCard.requiredPrefix': { en: 'Required:', zh: '必填:' },
  'templateCard.optionalPrefix': { en: 'Optional:', zh: '可选:' },
  'templateCard.usagePrefix': { en: 'Usage:', zh: '使用次数:' },
  'templateCard.useTemplate': { en: 'Use template', zh: '使用模板' },
  'templateCard.noDescription': { en: 'No description', zh: '无描述' },

  'recentTemplates.title': { en: 'Recent Templates', zh: '最近使用的模板' },
  'recentTemplates.subtitle': {
    en: 'Bring recently used templates forward as high-frequency entry points.',
    zh: '把最近使用过的模板前置成高频入口。',
  },
  'recentTemplates.lastUsedPrefix': { en: 'Last used:', zh: '最近使用:' },
  'recentTemplates.useAgain': { en: 'Use again', zh: '再次使用' },

  'sourceFilter.all': { en: 'All sources', zh: '全部来源' },
  'sourceFilter.builtin': { en: 'Builtin', zh: '内置' },
  'sourceFilter.database': { en: 'Database', zh: '数据库' },

  'templateSortBy.usage': { en: 'Usage', zh: '使用次数' },
  'templateSortBy.name': { en: 'Name', zh: '名称' },
  'templateSortBy.updated': { en: 'Updated', zh: '更新时间' },

  'error.loadWorkflowDrafts': { en: 'Failed to load workflow drafts', zh: '加载工作流草稿失败' },
  'error.loadWorkflowTemplates': { en: 'Failed to load workflow templates', zh: '加载工作流模板失败' },
  'error.loadTeamViews': { en: 'Failed to load team views', zh: '加载团队视图失败' },

  'label.workflowSearchPrefix': { en: 'WF:', zh: '工作流:' },
  'label.statusPrefix': { en: 'Status:', zh: '状态:' },
  'label.templateSearchPrefix': { en: 'TPL:', zh: '模板:' },
  'label.sourcePrefix': { en: 'Source:', zh: '来源:' },
  'label.workflowPagePrefix': { en: 'WF Page:', zh: '工作流页:' },
  'label.templatePagePrefix': { en: 'TPL Page:', zh: '模板页:' },
  'label.defaultView': { en: 'Default workflow hub view', zh: '默认工作流中心视图' },

  'dialog.saveView.prompt': {
    en: 'Enter a name for the current Workflow Hub perspective.',
    zh: '为当前工作流中心视角输入名称。',
  },
  'dialog.saveView.title': { en: 'Save view', zh: '保存视图' },
  'dialog.saveView.confirm': { en: 'Save', zh: '保存' },
  'dialog.saveView.cancel': { en: 'Cancel', zh: '取消' },
  'dialog.saveView.placeholder': { en: 'e.g. Parallel Templates', zh: '例如：并行模板集' },
  'dialog.saveView.success': { en: 'View saved', zh: '视图已保存' },

  'dialog.saveTeamView.prompt': {
    en: 'Enter a name for the current Workflow Hub perspective as a team view.',
    zh: '为当前工作流中心视角输入团队视图名称。',
  },
  'dialog.saveTeamView.title': { en: 'Save team view', zh: '保存团队视图' },
  'dialog.saveTeamView.placeholder': { en: 'e.g. Team Parallel Templates', zh: '例如：团队并行模板集' },
  'dialog.saveTeamView.success': { en: 'Team view saved', zh: '团队视图已保存' },

  'dialog.deleteView.title': { en: 'Delete view', zh: '删除视图' },
  'dialog.deleteView.confirm': { en: 'Delete', zh: '删除' },
  'dialog.deleteView.cancel': { en: 'Cancel', zh: '取消' },
  'dialog.deleteView.success': { en: 'View deleted', zh: '视图已删除' },

  'dialog.deleteTeamView.title': { en: 'Delete team view', zh: '删除团队视图' },
  'dialog.deleteTeamView.success': { en: 'Team view deleted', zh: '团队视图已删除' },
  'dialog.deleteTeamView.errorFallback': { en: 'Failed to delete team view', zh: '删除团队视图失败' },

  'dialog.duplicate.title': { en: 'Duplicate workflow', zh: '复制工作流' },
  'dialog.duplicate.confirm': { en: 'Duplicate', zh: '复制' },
  'dialog.duplicate.placeholder': { en: 'e.g. Approval Flow - Business Line A', zh: '例如：审批流程 - 业务线 A' },
  'dialog.duplicate.successFallback': { en: 'Workflow duplicated', zh: '工作流已复制' },
  'dialog.duplicate.errorFallback': { en: 'Failed to duplicate workflow', zh: '复制工作流失败' },

  'dialog.restore.title': { en: 'Restore workflow', zh: '恢复工作流' },
  'dialog.restore.confirm': { en: 'Restore', zh: '恢复' },
  'dialog.restore.successFallback': { en: 'Workflow restored', zh: '工作流已恢复' },
  'dialog.restore.errorFallback': { en: 'Failed to restore workflow', zh: '恢复工作流失败' },

  'dialog.archive.title': { en: 'Archive workflow', zh: '归档工作流' },
  'dialog.archive.confirm': { en: 'Archive', zh: '归档' },
  'dialog.archive.successFallback': { en: 'Workflow archived', zh: '工作流已归档' },
  'dialog.archive.errorFallback': { en: 'Failed to archive workflow', zh: '归档工作流失败' },

  'dialog.common.cancel': { en: 'Cancel', zh: '取消' },

  'session.restored': { en: 'Restored your last Workflow Hub session', zh: '已恢复上次工作流中心会话' },
}

export function workflowHubLabel(key: WorkflowHubLabelKey, isZh: boolean): string {
  const entry = WORKFLOW_HUB_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation / dynamic helpers (not keys) ---

export function workflowHubRangeLabel(start: number, end: number, total: number, isZh: boolean): string {
  return isZh ? `${start}-${end} / 共 ${total} 项` : `${start}-${end} / ${total}`
}

const WORKFLOW_STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  draft: { en: 'Draft', zh: '草稿' },
  published: { en: 'Published', zh: '已发布' },
  archived: { en: 'Archived', zh: '已归档' },
}
// workflowStatusChipLabel: the draft/published/archived chip text. Unknown statuses (should not
// occur — enum-strict at the API layer) fall back to the raw value in both locales rather than
// silently hiding data.
export function workflowStatusChipLabel(status: string, isZh: boolean): string {
  const entry = WORKFLOW_STATUS_LABELS[status]
  if (!entry) return status
  return isZh ? entry.zh : entry.en
}

const WORKFLOW_ROLE_LABELS: Record<string, { en: string; zh: string }> = {
  owner: { en: 'Owner', zh: '所有者' },
  editor: { en: 'Editor', zh: '编辑者' },
  viewer: { en: 'Viewer', zh: '查看者' },
}
export function workflowRoleChipLabel(role: string, isZh: boolean): string {
  const entry = WORKFLOW_ROLE_LABELS[role]
  if (!entry) return role
  return isZh ? entry.zh : entry.en
}

const TEMPLATE_SOURCE_LABELS: Record<string, { en: string; zh: string }> = {
  builtin: { en: 'Builtin', zh: '内置' },
  database: { en: 'Database', zh: '数据库' },
}
export function templateSourceChipLabel(source: string, isZh: boolean): string {
  const entry = TEMPLATE_SOURCE_LABELS[source]
  if (!entry) return source
  return isZh ? entry.zh : entry.en
}

export function workflowHubSharedByLabel(owner: string, isZh: boolean): string {
  return isZh ? `由 ${owner} 共享` : `Shared by ${owner}`
}

// Full-width curly quotes match this view's pre-existing zh dialog copy convention
// (ElMessageBox confirm/prompt text); en uses straight ASCII quotes.
export function workflowHubSwitchedToViewLabel(viewName: string, isZh: boolean): string {
  return isZh ? `已切换到视图 “${viewName}”` : `Switched to view "${viewName}"`
}

export function workflowHubSwitchedToTeamViewLabel(viewName: string, isZh: boolean): string {
  return isZh ? `已切换到团队视图 “${viewName}”` : `Switched to team view "${viewName}"`
}

export function workflowHubDeleteViewConfirm(viewName: string, isZh: boolean): string {
  return isZh
    ? `删除视图 “${viewName}” 后将无法恢复，是否继续？`
    : `Deleting the view "${viewName}" cannot be undone. Continue?`
}

export function workflowHubDeleteTeamViewConfirm(viewName: string, isZh: boolean): string {
  return isZh
    ? `删除团队视图 “${viewName}” 后，租户内其他同事也将无法再使用，是否继续？`
    : `Deleting the team view "${viewName}" will also remove it for other members of the tenant. Continue?`
}

export function workflowHubDuplicatePrompt(workflowName: string, isZh: boolean): string {
  const name = workflowName || workflowHubLabel('workflowCard.unnamed', isZh)
  return isZh
    ? `为 “${name}” 输入副本名称；留空则使用系统默认命名。`
    : `Enter a name for the copy of "${name}"; leave blank to use the system default name.`
}

export function workflowHubRestoreConfirm(workflowName: string, isZh: boolean): string {
  const name = workflowName || workflowHubLabel('workflowCard.unnamed', isZh)
  return isZh
    ? `恢复后 “${name}” 将重新回到草稿列表，是否继续？`
    : `After restoring, "${name}" will return to the draft list. Continue?`
}

export function workflowHubArchiveConfirm(workflowName: string, isZh: boolean): string {
  const name = workflowName || workflowHubLabel('workflowCard.unnamed', isZh)
  return isZh
    ? `归档后将从默认草稿列表移出 “${name}”，是否继续？`
    : `After archiving, "${name}" will be removed from the default draft list. Continue?`
}
