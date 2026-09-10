// TemplateCenterView label table — report item O-8 (approval UI locale consistency).
//
// TemplateCenterView.vue shipped with every visible string as an unconditional Chinese literal
// (title, filter placeholders, tab labels, table/gallery chrome, toasts, dialog titles) — it never
// called `useLocale()` at all, unlike the app shell (App.vue) and the rest of the locale-aware
// surface. This follows the SAME `ZH`/`EN` object + `isZh.value ? ZH : EN` convention
// ApprovalBatchTransferView.vue established in this same directory (not the dotted-key
// `workflowHubLabel(key, isZh)` function from views/workflowHubLabels.ts — both patterns already
// coexist in the repo; this file stays consistent with its nearest neighbour).
//
// Scope: TemplateCenterView.vue's OWN chrome only. The confirm-dialog BODY text (from
// approvals/templateArchiveConfirm.ts) is shared with TemplateDetailView.vue, which is out of
// scope for this slice, so that body text is deliberately left Chinese-only for now — only this
// page's dialog TITLE and buttons are localized here.

export const ZH = {
  title: '审批模板',
  categoryFilterPlaceholder: '全部分类',
  searchPlaceholder: '搜索模板名称',
  newTemplateButton: '新建模板',
  delegationsButton: '委托管理',
  recentLabel: '最近使用',
  reload: '重新加载',
  tabAll: '全部',
  tabPublished: '已发布',
  tabDraft: '草稿',
  tabArchived: '已归档',
  colName: '模板名称',
  colDescription: '描述',
  colCategory: '分类',
  colVisibility: '可见范围',
  colStatus: '状态',
  colUpdated: '最近更新',
  colCreated: '创建时间',
  colActions: '操作',
  categoryEmpty: '未分组',
  startApproval: '发起审批',
  clone: '克隆',
  archive: '停用',
  unarchive: '启用',
  emptyTableSearch: '未找到匹配的模板',
  emptyTableDefault: '暂无审批模板，点击新建模板开始',
  noDescription: '暂无描述',
  galleryStart: '发起申请',
  emptyGalleryDefault: '暂无可用的审批模板',
  visibilityAll: '全员可见',
  visibilityDept: '部门',
  visibilityRole: '角色',
  visibilityUser: '用户',
  clonedPrefix: '已克隆模板：',
  cloneError: '克隆模板失败',
  archiveDialogTitle: '停用模板',
  archiveSuccess: '已停用模板',
  archiveError: '停用模板失败',
  unarchiveDialogTitle: '启用模板',
  unarchiveSuccess: '已启用模板',
  unarchiveError: '启用模板失败',
  cancel: '取消',
} as const

export const EN: Record<keyof typeof ZH, string> = {
  title: 'Approval Templates',
  categoryFilterPlaceholder: 'All categories',
  searchPlaceholder: 'Search template name',
  newTemplateButton: 'New template',
  delegationsButton: 'Delegations',
  recentLabel: 'Recently used',
  reload: 'Reload',
  tabAll: 'All',
  tabPublished: 'Published',
  tabDraft: 'Draft',
  tabArchived: 'Archived',
  colName: 'Template name',
  colDescription: 'Description',
  colCategory: 'Category',
  colVisibility: 'Visibility',
  colStatus: 'Status',
  colUpdated: 'Last updated',
  colCreated: 'Created',
  colActions: 'Actions',
  categoryEmpty: 'Uncategorized',
  startApproval: 'Start request',
  clone: 'Clone',
  archive: 'Disable',
  unarchive: 'Enable',
  emptyTableSearch: 'No matching templates found',
  emptyTableDefault: 'No approval templates yet — click New template to start',
  noDescription: 'No description',
  galleryStart: 'Start request',
  emptyGalleryDefault: 'No approval templates available',
  visibilityAll: 'Visible to everyone',
  visibilityDept: 'Department',
  visibilityRole: 'Role',
  visibilityUser: 'User',
  clonedPrefix: 'Template cloned: ',
  cloneError: 'Failed to clone template',
  archiveDialogTitle: 'Disable template',
  archiveSuccess: 'Template disabled',
  archiveError: 'Failed to disable template',
  unarchiveDialogTitle: 'Enable template',
  unarchiveSuccess: 'Template enabled',
  unarchiveError: 'Failed to enable template',
  cancel: 'Cancel',
}
