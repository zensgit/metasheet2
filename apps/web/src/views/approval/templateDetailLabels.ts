// TemplateDetailView label table — continuation of report item O-8 (approval UI locale
// consistency), PR #5545.
//
// TemplateDetailView.vue shipped with every visible string as an unconditional Chinese literal —
// it never called `useLocale()` at all, exactly like TemplateCenterView.vue before its own O-8
// retrofit. This is a SIBLING file to templateCenterLabels.ts, following its exact convention
// (a flat `ZH`/`EN` object pair + `EN: Record<keyof typeof ZH, string>` so vue-tsc enforces key
// parity, consumed via `const t = computed(() => (isZh.value ? ZH : EN))`) — not a shared import
// from templateCenterLabels.ts, matching how ApprovalBatchTransferView.vue and
// TemplateCenterView.vue each already carry their own independent ZH/EN table even where a word
// (e.g. "取消"/"Cancel") happens to repeat across files.
//
// A handful of per-VALUE lookup maps (field type / node type / approval mode / empty-assignee
// policy / node-timeout effect / version status / version-change kind / version-change entity)
// live here too as separate ZH/EN Record pairs, because TemplateDetailView.vue's own script
// already expressed them as maps keyed by a domain union — moving only the VALUES here (not the
// key set) keeps that structure while making both locales available.
//
// Deliberately NOT moved here (see the view's own file-level comment for the full list): the two
// `resolvedIdsOrCount` branches whose exact Chinese wording is pinned BY EXACT TEXT as
// OUT-OF-SCOPE allowlist entries in
// apps/web/tests/approval-member-identity-coverage-enumeration.spec.ts (file-keyed to
// TemplateDetailView.vue itself, group "a COUNT, never the raw ids") — moving them into this file
// would make that census's staleness check fail. Those two stay inline in the view, English
// branch added alongside without touching the pinned Chinese line. (Not reproduced verbatim here,
// on purpose: this file is itself scanned by that same census, and quoting the exact interpolated
// form would retrigger the pattern it exists to catch — a comment, not a render.)
//
// Also deliberately left untouched (out of scope for this slice, same class as the
// templateArchiveConfirm.ts precedent templateCenterLabels.ts already established): the archive/
// unarchive confirm-dialog BODY text (approvals/templateArchiveConfirm.ts, shared with
// TemplateCenterView.vue), the field-visibility RULE SUMMARY text (approvals/fieldVisibility.ts),
// and the version-diff/read-summary/dual-canvas change labels and summary lines
// (approvals/templateVersionDiff.ts, approvalVersionReadSummary.ts, approvalVersionDualCanvas.ts,
// versionGraphOverlay.ts) — all separate shared modules with their own Chinese-literal surface,
// not this view's own chrome.

export const ZH = {
  headerFallback: '审批模板',
  backLabel: '返回模板列表',
  startApproval: '发起审批',
  editTemplate: '编辑模板',
  archiveButton: '停用',
  unarchiveButton: '启用',
  reload: '重新加载',

  categoryLabel: '模板分类:',
  categoryEmpty: '未分组',
  edit: '编辑',
  categoryPlaceholder: '分组标识，用于模板中心筛选，留空表示未分组',
  save: '保存',
  cancel: '取消',

  visibilityLabel: '可见范围:',
  visibilityAllLabel: '全员可见',
  visibilityDeptLabel: '按部门',
  visibilityRoleLabel: '按角色',
  visibilityUserLabel: '按用户',
  unitAll: '全员',
  unitDept: '部门',
  unitRole: '角色',
  unitUser: '用户',
  visibilityIdsPlaceholder: '逗号分隔 id，如 dept-finance, role-manager',

  slaLabel: 'SLA (小时):',
  slaEmpty: '未设置',
  slaPlaceholder: '留空清除',

  metaKeyLabel: '模板 Key:',
  metaVersionLabel: '当前版本:',
  metaVersionNone: '无',
  metaCreatedLabel: '创建时间:',
  metaUpdatedLabel: '更新时间:',

  formFieldsHeading: '表单字段',
  colFieldName: '字段名',
  colType: '类型',
  colRequired: '必填',
  colPlaceholder: '占位文本',
  colOptions: '选项',
  emptyFormFields: '暂无表单字段',

  visibilityRulesHeading: '字段显隐规则',
  emptyVisibilityRules: '暂无字段显隐规则',
  colField: '字段',
  colRuleSummary: '规则说明',

  approvalGraphHeading: '审批流程',
  emptyApprovalNodes: '暂无审批节点',

  versionHistoryHeading: '版本历史',
  colVersion: '版本',
  colVersionStatus: '状态',
  activeTag: '当前生效',
  restoredFromPrefix: '恢复自 ',
  colPublishNote: '发布说明',
  colVersionUpdated: '更新时间',
  colVersionActions: '操作',
  viewChanges: '查看变化',
  restore: '恢复',
  emptyVersionHistory: '暂无版本记录',
  restoredSourceFallback: '历史版本',
  versionDiffTitleFallback: '版本变化',
  versionInitialSuffix: ' 初始内容',
  closeDiffTitle: '关闭版本比较',
  diffFieldsLabel: '表单字段 ',
  diffNodesLabel: '流程节点 ',
  diffEdgesLabel: '连线 ',
  diffOverlayNodesPrefix: '画布叠加：节点 ',
  diffOverlayEdgesSep: ' · 连线 ',
  diffNoStructuralChange: '与上一版本无结构变化',
  diffModeList: '变化列表',
  diffModeCanvas: '流程画布',
  diffModeDual: '双画布',
  restoreConfirmButton: '恢复为新草稿',

  slaInvalid: 'SLA 必须是正整数小时',
  slaClearedToast: '已清除 SLA',
  slaUpdateFailed: '更新 SLA 失败',
  categoryClearedToast: '已清除模板分类',
  categoryUpdateFailed: '更新分类失败',
  visibilityIdsRequired: '可见范围至少需要一个 id',
  visibilityUpdatedToast: '已更新模板可见范围',
  visibilityUpdateFailed: '更新可见范围失败',
  archiveDialogTitle: '停用模板',
  archiveSuccessToast: '已停用模板',
  archiveFailed: '停用模板失败',
  unarchiveDialogTitle: '启用模板',
  unarchiveSuccessToast: '已启用模板',
  unarchiveFailed: '启用模板失败',
  versionHistoryLoadFailed: '版本历史加载失败',
  versionDiffLoadFailed: '版本变化加载失败',
  restoreFailed: '恢复版本失败',

  notFound: '未找到模板',
} as const

export const EN: Record<keyof typeof ZH, string> = {
  headerFallback: 'Approval Template',
  backLabel: 'Back to template list',
  startApproval: 'Start request',
  editTemplate: 'Edit template',
  archiveButton: 'Disable',
  unarchiveButton: 'Enable',
  reload: 'Reload',

  categoryLabel: 'Category:',
  categoryEmpty: 'Uncategorized',
  edit: 'Edit',
  categoryPlaceholder: 'Grouping key used for template-center filtering; leave blank for uncategorized',
  save: 'Save',
  cancel: 'Cancel',

  visibilityLabel: 'Visibility:',
  visibilityAllLabel: 'Visible to everyone',
  visibilityDeptLabel: 'By department',
  visibilityRoleLabel: 'By role',
  visibilityUserLabel: 'By user',
  unitAll: 'Everyone',
  unitDept: 'Department',
  unitRole: 'Role',
  unitUser: 'User',
  visibilityIdsPlaceholder: 'Comma-separated ids, e.g. dept-finance, role-manager',

  slaLabel: 'SLA (hours):',
  slaEmpty: 'Not set',
  slaPlaceholder: 'Leave blank to clear',

  metaKeyLabel: 'Template key:',
  metaVersionLabel: 'Current version:',
  metaVersionNone: 'None',
  metaCreatedLabel: 'Created:',
  metaUpdatedLabel: 'Updated:',

  formFieldsHeading: 'Form fields',
  colFieldName: 'Field name',
  colType: 'Type',
  colRequired: 'Required',
  colPlaceholder: 'Placeholder text',
  colOptions: 'Options',
  emptyFormFields: 'No form fields yet',

  visibilityRulesHeading: 'Field visibility rules',
  emptyVisibilityRules: 'No field visibility rules yet',
  colField: 'Field',
  colRuleSummary: 'Rule summary',

  approvalGraphHeading: 'Approval flow',
  emptyApprovalNodes: 'No approval nodes yet',

  versionHistoryHeading: 'Version history',
  colVersion: 'Version',
  colVersionStatus: 'Status',
  activeTag: 'Active',
  restoredFromPrefix: 'Restored from ',
  colPublishNote: 'Publish note',
  colVersionUpdated: 'Updated',
  colVersionActions: 'Actions',
  viewChanges: 'View changes',
  restore: 'Restore',
  emptyVersionHistory: 'No version history yet',
  restoredSourceFallback: 'a prior version',
  versionDiffTitleFallback: 'Version changes',
  versionInitialSuffix: ' initial content',
  closeDiffTitle: 'Close version comparison',
  diffFieldsLabel: 'Form fields ',
  diffNodesLabel: 'Process nodes ',
  diffEdgesLabel: 'Edges ',
  diffOverlayNodesPrefix: 'Canvas overlay: nodes ',
  diffOverlayEdgesSep: ' · edges ',
  diffNoStructuralChange: 'No structural changes from the previous version',
  diffModeList: 'Change list',
  diffModeCanvas: 'Flow canvas',
  diffModeDual: 'Side-by-side canvas',
  restoreConfirmButton: 'Restore as new draft',

  slaInvalid: 'SLA must be a positive whole number of hours',
  slaClearedToast: 'SLA cleared',
  slaUpdateFailed: 'Failed to update SLA',
  categoryClearedToast: 'Template category cleared',
  categoryUpdateFailed: 'Failed to update category',
  visibilityIdsRequired: 'Visibility scope requires at least one id',
  visibilityUpdatedToast: 'Template visibility updated',
  visibilityUpdateFailed: 'Failed to update visibility',
  archiveDialogTitle: 'Disable template',
  archiveSuccessToast: 'Template disabled',
  archiveFailed: 'Failed to disable template',
  unarchiveDialogTitle: 'Enable template',
  unarchiveSuccessToast: 'Template enabled',
  unarchiveFailed: 'Failed to enable template',
  versionHistoryLoadFailed: 'Failed to load version history',
  versionDiffLoadFailed: 'Failed to load version changes',
  restoreFailed: 'Failed to restore version',

  notFound: 'Template not found',
}

// ---------------------------------------------------------------------------
// Per-value lookup maps. Each pair keys on the SAME domain union
// TemplateDetailView.vue's own map already used — only the VALUES gained an English column.
// ---------------------------------------------------------------------------

export const FIELD_TYPE_ZH: Record<string, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '用户',
  department: '部门',
  attachment: '附件',
  detail: '明细',
  'record-link': '关联记录',
  date_range: '日期区间',
  explanation: '说明',
}

export const FIELD_TYPE_EN: Record<string, string> = {
  text: 'Text',
  textarea: 'Multi-line text',
  number: 'Number',
  date: 'Date',
  datetime: 'Date & time',
  select: 'Single select',
  'multi-select': 'Multi-select',
  user: 'User',
  department: 'Department',
  attachment: 'Attachment',
  detail: 'Detail',
  'record-link': 'Linked record',
  date_range: 'Date range',
  explanation: 'Explanation',
}

export const NODE_TYPE_ZH: Record<string, string> = {
  start: '开始',
  approval: '审批',
  cc: '抄送',
  condition: '条件',
  parallel: '并行',
  handler: '办理',
  end: '结束',
}

export const NODE_TYPE_EN: Record<string, string> = {
  start: 'Start',
  approval: 'Approval',
  cc: 'CC',
  condition: 'Condition',
  parallel: 'Parallel',
  handler: 'Handler',
  end: 'End',
}

export const APPROVAL_MODE_ZH: Record<string, string> = {
  single: '单人审批',
  all: '会签',
  any: '或签',
  threshold: '门槛会签',
  sequential: '依次审批',
}

export const APPROVAL_MODE_EN: Record<string, string> = {
  single: 'Single approver',
  all: 'All must approve',
  any: 'Any approver',
  threshold: 'Threshold approval',
  sequential: 'Sequential approval',
}

export const EMPTY_ASSIGNEE_POLICY_ZH: Record<string, string> = {
  error: '无人时报错',
  'auto-approve': '无人时自动通过',
  designated: '无人时转交指定人员',
}

export const EMPTY_ASSIGNEE_POLICY_EN: Record<string, string> = {
  error: 'Error when empty',
  'auto-approve': 'Auto-approve when empty',
  designated: 'Transfer to a designated person when empty',
}

export const NODE_TIMEOUT_EFFECT_ZH: Record<string, string> = {
  remind: '超时提醒',
  transfer: '超时转交',
  jump: '超时跳转',
}

export const NODE_TIMEOUT_EFFECT_EN: Record<string, string> = {
  remind: 'Timeout reminder',
  transfer: 'Timeout transfer',
  jump: 'Timeout jump',
}

export const VERSION_STATUS_ZH: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已停用',
}

export const VERSION_STATUS_EN: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Disabled',
}

export const VERSION_CHANGE_KIND_ZH: Record<string, string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
  moved: '移动',
}

export const VERSION_CHANGE_KIND_EN: Record<string, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
}

export const VERSION_CHANGE_ENTITY_ZH: Record<string, string> = {
  field: '字段',
  node: '节点',
  edge: '连线',
}

export const VERSION_CHANGE_ENTITY_EN: Record<string, string> = {
  field: 'Field',
  node: 'Node',
  edge: 'Edge',
}

/** Every ZH/EN map pair above, for the label-table completeness test to loop over uniformly. */
export const MAP_PAIRS: Array<{ name: string; zh: Record<string, string>; en: Record<string, string> }> = [
  { name: 'FIELD_TYPE', zh: FIELD_TYPE_ZH, en: FIELD_TYPE_EN },
  { name: 'NODE_TYPE', zh: NODE_TYPE_ZH, en: NODE_TYPE_EN },
  { name: 'APPROVAL_MODE', zh: APPROVAL_MODE_ZH, en: APPROVAL_MODE_EN },
  { name: 'EMPTY_ASSIGNEE_POLICY', zh: EMPTY_ASSIGNEE_POLICY_ZH, en: EMPTY_ASSIGNEE_POLICY_EN },
  { name: 'NODE_TIMEOUT_EFFECT', zh: NODE_TIMEOUT_EFFECT_ZH, en: NODE_TIMEOUT_EFFECT_EN },
  { name: 'VERSION_STATUS', zh: VERSION_STATUS_ZH, en: VERSION_STATUS_EN },
  { name: 'VERSION_CHANGE_KIND', zh: VERSION_CHANGE_KIND_ZH, en: VERSION_CHANGE_KIND_EN },
  { name: 'VERSION_CHANGE_ENTITY', zh: VERSION_CHANGE_ENTITY_ZH, en: VERSION_CHANGE_ENTITY_EN },
]
