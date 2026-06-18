// Permission manager chrome string table (T3C-2a).
//
// Scope: MetaRecordPermissionManager.vue and MetaSheetPermissionManager.vue.
// User, role, member-group, field, view, permission code, backend error, and
// persisted ACL values stay raw. This module only maps UI chrome.

export type MetaPermissionLabelKey =
  | 'action.clearOverrides'
  | 'action.copyAcl'
  | 'action.copyFieldViewAcl'
  | 'action.grant'
  | 'access.admin'
  | 'access.none'
  | 'access.read'
  | 'access.write'
  | 'access.writeOwn'
  | 'rowDeny.title'
  | 'rowDeny.toggle'
  | 'rowDeny.warning'
  | 'rowDeny.noneHint'
  | 'rowDeny.enabledNote'
  | 'field.applyAll'
  | 'field.bulkApply'
  | 'field.error.applyTemplate'
  | 'field.error.clear'
  | 'field.error.clearOrphans'
  | 'field.error.copyTemplate'
  | 'field.error.update'
  | 'field.noFields'
  | 'field.noSubjects'
  | 'field.state.default'
  | 'field.state.hidden'
  | 'field.state.readonly'
  | 'field.status.cleared'
  | 'field.status.copiedTemplate'
  | 'field.status.copyTemplateNoop'
  | 'field.status.updated'
  | 'field.title'
  | 'permission.clearOrphanOverrides'
  | 'permission.copyDownstreamPlaceholder'
  | 'permission.copyFromMemberGroup'
  | 'permission.noCurrentSheetAccess'
  | 'record.currentAccess'
  | 'record.empty'
  | 'record.error.grant'
  | 'record.error.loadCandidates'
  | 'record.error.loadPermissions'
  | 'record.error.remove'
  | 'record.error.update'
  | 'record.grantSection'
  | 'record.loadingCandidates'
  | 'record.loadingPermissions'
  | 'record.noCandidates'
  | 'record.noMemberGroups'
  | 'record.noPeople'
  | 'record.noRoles'
  | 'record.searchPlaceholder'
  | 'record.status.granted'
  | 'record.status.removed'
  | 'record.status.updated'
  | 'record.subtitle'
  | 'record.title'
  | 'sheet.currentAccess'
  | 'sheet.eligibleSection'
  | 'sheet.emptyAccess'
  | 'sheet.error.clearSubjectOverrides'
  | 'sheet.error.copyDownstreamAcl'
  | 'sheet.error.loadAccess'
  | 'sheet.error.loadCandidates'
  | 'sheet.error.updateAccess'
  | 'sheet.loadingAccess'
  | 'sheet.noCandidates'
  | 'sheet.searchingCandidates'
  | 'sheet.searchPlaceholder'
  | 'sheet.status.copyDownstreamNoop'
  | 'sheet.status.copiedDownstreamAcl'
  | 'sheet.status.removed'
  | 'sheet.status.saved'
  | 'sheet.status.updated'
  | 'sheet.subtitle'
  | 'sheet.tab.fields'
  | 'sheet.tab.sheet'
  | 'sheet.tab.views'
  | 'sheet.title'
  | 'subject.cleanupOnly'
  | 'subject.grantBlocked'
  | 'subject.inactiveUser'
  | 'subject.memberGroup'
  | 'subject.memberGroups'
  | 'subject.noMemberGroups'
  | 'subject.noPeople'
  | 'subject.noRoles'
  | 'subject.people'
  | 'subject.person'
  | 'subject.role'
  | 'subject.roles'
  | 'subject.user'
  | 'view.applyAll'
  | 'view.bulkApply'
  | 'view.error.applyTemplate'
  | 'view.error.clear'
  | 'view.error.clearOrphans'
  | 'view.error.copyTemplate'
  | 'view.error.update'
  | 'view.noSubjects'
  | 'view.noViews'
  | 'view.state.none'
  | 'view.status.cleared'
  | 'view.status.copiedTemplate'
  | 'view.status.copyTemplateNoop'
  | 'view.status.updated'
  | 'view.title'
  | 'condRule.title'
  | 'condRule.desc'
  | 'condRule.empty'
  | 'condRule.field'
  | 'condRule.operator'
  | 'condRule.value'
  | 'condRule.add'
  | 'condRule.delete'
  | 'condRule.save'
  | 'condRule.saved'
  | 'condRule.unknownField'
  | 'condRule.disabledHint'
  | 'condRule.error.load'
  | 'condRule.error.save'
  | 'condRule.deny'
  | 'condRule.op.eq'
  | 'condRule.op.neq'
  | 'condRule.op.contains'
  | 'condRule.op.isEmpty'
  | 'condRule.op.isNotEmpty'
  | 'condRule.op.gt'
  | 'condRule.op.lt'
  | 'condRule.op.gte'
  | 'condRule.op.lte'
  | 'condRule.op.before'
  | 'condRule.op.after'
  | 'condRule.op.hasAny'
  | 'condRule.op.hasNone'

const LABELS: Record<MetaPermissionLabelKey, { en: string; zh: string }> = {
  'action.clearOverrides': { en: 'Clear overrides', zh: '清除覆盖' },
  'action.copyAcl': { en: 'Copy ACL', zh: '复制 ACL' },
  'action.copyFieldViewAcl': { en: 'Copy field+view ACL', zh: '复制字段+视图 ACL' },
  'action.grant': { en: 'Grant', zh: '授权' },
  'access.admin': { en: 'Admin', zh: '管理员' },
  'access.none': { en: 'No access (deny read)', zh: '无权限（拒绝读取）' },
  'access.read': { en: 'Read', zh: '读取' },
  'access.write': { en: 'Write', zh: '写入' },
  'access.writeOwn': { en: 'Write own', zh: '仅写入自己' },
  'rowDeny.title': { en: 'Row-level read permissions', zh: '行级读取权限' },
  'rowDeny.toggle': { en: 'Enable per-record read-deny for this sheet', zh: '为此表启用按记录的读取拒绝' },
  'rowDeny.warning': { en: 'When enabled, records with a “No access” grant become invisible to non-granted readers across every view, list, summary, aggregate, and export — a real visibility change.', zh: '启用后，带有“无权限”授权的记录将对未被授权的读者在所有视图、列表、汇总、聚合和导出中不可见——这是真实的可见性变更。' },
  'rowDeny.noneHint': { en: 'Only effective when row-level read permissions are enabled for this sheet.', zh: '仅当此表启用了行级读取权限时生效。' },
  'rowDeny.enabledNote': { en: 'Row-level read-deny is ON for this sheet.', zh: '此表已开启行级读取拒绝。' },
  'field.applyAll': { en: 'Apply to all fields', zh: '应用到所有字段' },
  'field.bulkApply': { en: 'Bulk apply to all fields', zh: '批量应用到所有字段' },
  'field.error.applyTemplate': { en: 'Failed to apply field permission template', zh: '应用字段权限模板失败' },
  'field.error.clear': { en: 'Failed to clear field permission', zh: '清除字段权限失败' },
  'field.error.clearOrphans': { en: 'Failed to clear orphan field overrides', zh: '清除孤立字段覆盖失败' },
  'field.error.copyTemplate': { en: 'Failed to copy field ACL template', zh: '复制字段 ACL 模板失败' },
  'field.error.update': { en: 'Failed to update field permission', zh: '更新字段权限失败' },
  'field.noFields': { en: 'No fields available.', zh: '暂无可用字段。' },
  'field.noSubjects': {
    en: 'No subjects with sheet access. Grant sheet access first to configure field permissions.',
    zh: '暂无拥有表访问权限的对象。请先授予表访问权限，再配置字段权限。',
  },
  'field.state.default': { en: 'Default', zh: '默认' },
  'field.state.hidden': { en: 'Hidden', zh: '隐藏' },
  'field.state.readonly': { en: 'Read-only', zh: '只读' },
  'field.status.cleared': { en: 'Field permission cleared', zh: '字段权限已清除' },
  'field.status.copiedTemplate': { en: 'Copied field ACL template from source member group', zh: '已从源成员组复制字段 ACL 模板' },
  'field.status.copyTemplateNoop': { en: 'Field ACL template already matches source member group', zh: '字段 ACL 模板已与源成员组一致' },
  'field.status.updated': { en: 'Field permission updated', zh: '字段权限已更新' },
  'field.title': { en: 'Field-level permissions', zh: '字段级权限' },
  'permission.clearOrphanOverrides': { en: 'Clear orphan overrides', zh: '清除孤立覆盖' },
  'permission.copyDownstreamPlaceholder': { en: 'Copy downstream ACL...', zh: '复制下游 ACL...' },
  'permission.copyFromMemberGroup': { en: 'Copy from member group...', zh: '从成员组复制...' },
  'permission.noCurrentSheetAccess': { en: 'No current sheet access', zh: '当前无表访问权限' },
  'record.currentAccess': { en: 'Current access', zh: '当前访问权限' },
  'record.empty': { en: 'No record-specific permissions yet.', zh: '暂无记录专属权限。' },
  'record.error.grant': { en: 'Failed to grant permission', zh: '授予权限失败' },
  'record.error.loadCandidates': { en: 'Failed to load permission candidates', zh: '加载权限候选项失败' },
  'record.error.loadPermissions': { en: 'Failed to load record permissions', zh: '加载记录权限失败' },
  'record.error.remove': { en: 'Failed to remove permission', zh: '移除权限失败' },
  'record.error.update': { en: 'Failed to update permission', zh: '更新权限失败' },
  'record.grantSection': { en: 'Grant to people, member groups, or roles', zh: '授权给人员、成员组或角色' },
  'record.loadingCandidates': { en: 'Loading eligible people, member groups, and roles...', zh: '正在加载可授权的人员、成员组和角色...' },
  'record.loadingPermissions': { en: 'Loading permissions...', zh: '正在加载权限...' },
  'record.noCandidates': { en: 'No matching eligible people, member groups, or roles.', zh: '没有匹配的可授权人员、成员组或角色。' },
  'record.noMemberGroups': { en: 'No matching member groups.', zh: '没有匹配的成员组。' },
  'record.noPeople': { en: 'No matching people.', zh: '没有匹配的人员。' },
  'record.noRoles': { en: 'No matching roles.', zh: '没有匹配的角色。' },
  'record.searchPlaceholder': { en: 'Search people, member groups, or roles', zh: '搜索人员、成员组或角色' },
  'record.status.granted': { en: 'Permission granted', zh: '权限已授予' },
  'record.status.removed': { en: 'Permission removed', zh: '权限已移除' },
  'record.status.updated': { en: 'Permission updated', zh: '权限已更新' },
  'record.subtitle': { en: 'Manage who can access this record and at what level.', zh: '管理谁可以访问此记录以及访问级别。' },
  'record.title': { en: 'Record Permissions', zh: '记录权限' },
  'sheet.currentAccess': { en: 'Current access', zh: '当前访问权限' },
  'sheet.eligibleSection': { en: 'Eligible people, member groups, or roles', zh: '可授权人员、成员组或角色' },
  'sheet.emptyAccess': { en: 'No sheet-specific access grants yet.', zh: '暂无表专属访问授权。' },
  'sheet.error.clearSubjectOverrides': { en: 'Failed to clear subject overrides', zh: '清除对象覆盖失败' },
  'sheet.error.copyDownstreamAcl': { en: 'Failed to copy downstream member-group ACL', zh: '复制下游成员组 ACL 失败' },
  'sheet.error.loadAccess': { en: 'Failed to load sheet access', zh: '加载表访问权限失败' },
  'sheet.error.loadCandidates': { en: 'Failed to load permission candidates', zh: '加载权限候选项失败' },
  'sheet.error.updateAccess': { en: 'Failed to update sheet access', zh: '更新表访问权限失败' },
  'sheet.loadingAccess': { en: 'Loading access list...', zh: '正在加载访问列表...' },
  'sheet.noCandidates': { en: 'No matching eligible people, member groups, or roles.', zh: '没有匹配的可授权人员、成员组或角色。' },
  'sheet.searchingCandidates': { en: 'Searching eligible people, member groups, and roles...', zh: '正在搜索可授权人员、成员组和角色...' },
  'sheet.searchPlaceholder': { en: 'Search people or roles', zh: '搜索人员或角色' },
  'sheet.status.copyDownstreamNoop': { en: 'Downstream field and view ACL already matches source member group', zh: '下游字段和视图 ACL 已与源成员组一致' },
  'sheet.status.copiedDownstreamAcl': { en: 'Copied downstream field and view ACL from source member group', zh: '已从源成员组复制下游字段和视图 ACL' },
  'sheet.status.removed': { en: 'Sheet access override removed', zh: '表访问覆盖已移除' },
  'sheet.status.saved': { en: 'Sheet access override saved', zh: '表访问覆盖已保存' },
  'sheet.status.updated': { en: 'Sheet access override updated', zh: '表访问覆盖已更新' },
  'sheet.subtitle': {
    en: 'Override sheet-level access for eligible people, member groups, or roles. Admin includes sharing and sheet deletion. Write-own remains user-only.',
    zh: '为可授权人员、成员组或角色覆盖表级访问权限。管理员包含分享和删除表权限；仅写入自己仍只适用于用户。',
  },
  'sheet.tab.fields': { en: 'Field Permissions', zh: '字段权限' },
  'sheet.tab.sheet': { en: 'Sheet Access', zh: '表访问权限' },
  'sheet.tab.views': { en: 'View Permissions', zh: '视图权限' },
  'sheet.title': { en: 'Manage Access', zh: '管理访问权限' },
  'subject.cleanupOnly': { en: 'Cleanup only', zh: '仅可清理' },
  'subject.grantBlocked': { en: 'Grant blocked', zh: '授权已阻止' },
  'subject.inactiveUser': { en: 'Inactive user', zh: '已停用用户' },
  'subject.memberGroup': { en: 'Member group', zh: '成员组' },
  'subject.memberGroups': { en: 'Member groups', zh: '成员组' },
  'subject.noMemberGroups': { en: 'No matching member groups.', zh: '没有匹配的成员组。' },
  'subject.noPeople': { en: 'No matching people.', zh: '没有匹配的人员。' },
  'subject.noRoles': { en: 'No matching roles.', zh: '没有匹配的角色。' },
  'subject.people': { en: 'People', zh: '人员' },
  'subject.person': { en: 'Person', zh: '人员' },
  'subject.role': { en: 'Role', zh: '角色' },
  'subject.roles': { en: 'Roles', zh: '角色' },
  'subject.user': { en: 'User', zh: '用户' },
  'view.applyAll': { en: 'Apply to all views', zh: '应用到所有视图' },
  'view.bulkApply': { en: 'Bulk apply to all views', zh: '批量应用到所有视图' },
  'view.error.applyTemplate': { en: 'Failed to apply view permission template', zh: '应用视图权限模板失败' },
  'view.error.clear': { en: 'Failed to clear view permission', zh: '清除视图权限失败' },
  'view.error.clearOrphans': { en: 'Failed to clear orphan view overrides', zh: '清除孤立视图覆盖失败' },
  'view.error.copyTemplate': { en: 'Failed to copy view ACL template', zh: '复制视图 ACL 模板失败' },
  'view.error.update': { en: 'Failed to update view permission', zh: '更新视图权限失败' },
  'view.noSubjects': {
    en: 'No subjects with sheet access. Grant sheet access first to configure view permissions.',
    zh: '暂无拥有表访问权限的对象。请先授予表访问权限，再配置视图权限。',
  },
  'view.noViews': { en: 'No views available.', zh: '暂无可用视图。' },
  'view.state.none': { en: 'None', zh: '无' },
  'view.status.cleared': { en: 'View permission cleared', zh: '视图权限已清除' },
  'view.status.copiedTemplate': { en: 'Copied view ACL template from source member group', zh: '已从源成员组复制视图 ACL 模板' },
  'view.status.copyTemplateNoop': { en: 'View ACL template already matches source member group', zh: '视图 ACL 模板已与源成员组一致' },
  'view.status.updated': { en: 'View permission updated', zh: '视图权限已更新' },
  'view.title': { en: 'View-level permissions', zh: '视图级权限' },
  'condRule.title': { en: 'Conditional read-deny rules', zh: '条件读取拒绝规则' },
  'condRule.desc': { en: 'A record matched by any rule below is hidden from non-admin readers on every surface. Rules only take effect when row-level read permissions are enabled above.', zh: '被下列任一规则匹配的记录，将在所有界面对非管理员读者隐藏。仅当上方启用了行级读取权限时，规则才生效。' },
  'condRule.empty': { en: 'No conditional rules.', zh: '暂无条件规则。' },
  'condRule.field': { en: 'Field', zh: '字段' },
  'condRule.operator': { en: 'Condition', zh: '条件' },
  'condRule.value': { en: 'Value', zh: '值' },
  'condRule.add': { en: 'Add rule', zh: '添加规则' },
  'condRule.delete': { en: 'Remove', zh: '移除' },
  'condRule.save': { en: 'Save rules', zh: '保存规则' },
  'condRule.saved': { en: 'Rules saved', zh: '规则已保存' },
  'condRule.unknownField': { en: '(field not found — preserved)', zh: '（字段不存在——已保留）' },
  'condRule.disabledHint': { en: 'Rules are stored but only enforce when row-level read permissions are enabled.', zh: '规则已保存，但仅在启用行级读取权限后才会强制执行。' },
  'condRule.error.load': { en: 'Failed to load conditional rules', zh: '加载条件规则失败' },
  'condRule.error.save': { en: 'Failed to save conditional rules', zh: '保存条件规则失败' },
  'condRule.deny': { en: 'deny read', zh: '拒绝读取' },
  'condRule.op.eq': { en: 'equals', zh: '等于' },
  'condRule.op.neq': { en: 'not equals', zh: '不等于' },
  'condRule.op.contains': { en: 'contains', zh: '包含' },
  'condRule.op.isEmpty': { en: 'is empty', zh: '为空' },
  'condRule.op.isNotEmpty': { en: 'is not empty', zh: '不为空' },
  'condRule.op.gt': { en: 'greater than', zh: '大于' },
  'condRule.op.lt': { en: 'less than', zh: '小于' },
  'condRule.op.gte': { en: 'at least', zh: '大于等于' },
  'condRule.op.lte': { en: 'at most', zh: '小于等于' },
  'condRule.op.before': { en: 'before', zh: '早于' },
  'condRule.op.after': { en: 'after', zh: '晚于' },
  'condRule.op.hasAny': { en: 'has any of', zh: '包含任一' },
  'condRule.op.hasNone': { en: 'has none of', zh: '不包含任一' },
}

export function permissionLabel(key: MetaPermissionLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function recordAccessText(level: string, isZh: boolean): string {
  if (level === 'read') return permissionLabel('access.read', isZh)
  if (level === 'write') return permissionLabel('access.write', isZh)
  if (level === 'admin') return permissionLabel('access.admin', isZh)
  if (level === 'none') return permissionLabel('access.none', isZh)
  return level
}

export function sheetAccessText(level: string, isZh: boolean): string {
  if (level === 'read') return permissionLabel('access.read', isZh)
  if (level === 'write') return permissionLabel('access.write', isZh)
  if (level === 'write-own') return permissionLabel('access.writeOwn', isZh)
  if (level === 'admin') return permissionLabel('access.admin', isZh)
  return level
}

export function subjectText(subjectType: string, isZh: boolean, userLabel: 'user' | 'person' = 'user'): string {
  if (subjectType === 'role') return permissionLabel('subject.role', isZh)
  if (subjectType === 'member-group') return permissionLabel('subject.memberGroup', isZh)
  return permissionLabel(userLabel === 'person' ? 'subject.person' : 'subject.user', isZh)
}

export function fieldStateText(value: string, isZh: boolean): string {
  if (value === 'hidden') return permissionLabel('field.state.hidden', isZh)
  if (value === 'readonly') return permissionLabel('field.state.readonly', isZh)
  return permissionLabel('field.state.default', isZh)
}

export function viewPermissionText(value: string, isZh: boolean): string {
  if (value === 'read') return permissionLabel('access.read', isZh)
  if (value === 'write') return permissionLabel('access.write', isZh)
  if (value === 'admin') return permissionLabel('access.admin', isZh)
  return permissionLabel('view.state.none', isZh)
}

export function fieldStatusClearedOrphans(count: number, isZh: boolean): string {
  if (isZh) return `已清除 ${count} 个孤立字段覆盖`
  return `Cleared ${count} orphan field override${count === 1 ? '' : 's'}`
}

export function viewStatusClearedOrphans(count: number, isZh: boolean): string {
  if (isZh) return `已清除 ${count} 个孤立视图覆盖`
  return `Cleared ${count} orphan view override${count === 1 ? '' : 's'}`
}

export function subjectOverrideSummary(fieldCount: number, viewCount: number, isZh: boolean): string {
  const parts: string[] = []
  if (fieldCount > 0) {
    parts.push(isZh ? `${fieldCount} 个字段覆盖` : `${fieldCount} field override${fieldCount === 1 ? '' : 's'}`)
  }
  if (viewCount > 0) {
    parts.push(isZh ? `${viewCount} 个视图覆盖` : `${viewCount} view override${viewCount === 1 ? '' : 's'}`)
  }
  return parts.join(' · ')
}

export function clearedSubjectOverrides(summary: string, isZh: boolean): string {
  return isZh ? `已清除 ${summary}` : `Cleared ${summary}`
}

export function fieldStatusClearedAll(count: number, isZh: boolean): string {
  if (isZh) return `已清除 ${count} 个字段上的权限覆盖`
  return `Cleared field permission overrides on ${count} fields`
}

export function fieldStatusApplied(count: number, isZh: boolean): string {
  if (isZh) return `已将字段权限应用到 ${count} 个字段`
  return `Applied field permission to ${count} fields`
}

export function viewStatusApplied(count: number, isZh: boolean): string {
  if (isZh) return `已将视图权限应用到 ${count} 个视图`
  return `Applied view permission to ${count} views`
}

export function orphanSubjectText(subjectLabel: string, isZh: boolean): string {
  return isZh ? `孤立的 ${subjectLabel}` : `Orphan ${subjectLabel}`
}
