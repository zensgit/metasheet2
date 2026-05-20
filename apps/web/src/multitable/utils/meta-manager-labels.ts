// Field/view manager chrome string table (T3C).
//
// Scope: MetaFieldManager.vue, MetaViewManager.vue, and the nested
// MetaFieldValidationPanel.vue. User-authored names, sheet names, field names,
// view names, formula docs, function signatures, API/backend errors, and
// persisted enum values stay raw.

import { fieldTypeLabel } from './meta-core-labels'

export type MetaManagerLabelKey =
  | 'action.configure' | 'action.conditionalFormatting' | 'action.rename'
  | 'action.moveUp' | 'action.moveDown' | 'action.delete'
  | 'action.confirmRename' | 'action.cancelRename'
  | 'action.cancel' | 'action.reloadLatest' | 'action.dismiss'
  | 'action.add' | 'action.addOption' | 'action.save' | 'action.remove'
  | 'action.clear' | 'action.apply'
  | 'field.title' | 'field.empty' | 'field.options' | 'field.optionValue'
  | 'field.targetSheet' | 'field.selectSheet' | 'field.limitSingleLinkedRecord'
  | 'field.personHint' | 'field.limitSinglePerson'
  | 'field.linkField' | 'field.selectLinkField'
  | 'field.foreignSheetId' | 'field.targetFieldId'
  | 'field.optionalOverride' | 'field.aggregation'
  | 'field.expression' | 'field.insertFieldToken'
  | 'field.formulaReference' | 'field.formulaSearchPlaceholder'
  | 'field.allCategories' | 'field.noMatchingFunctions'
  | 'field.maxFiles' | 'field.acceptedMimeTypes'
  | 'field.decimals' | 'field.preserve' | 'field.unit'
  | 'field.useThousandsSeparators' | 'field.currencyCode'
  | 'field.maxRating' | 'field.prefix' | 'field.digits' | 'field.startAt'
  | 'field.autoNumberHint' | 'field.saveSettings' | 'field.applyDefaults'
  | 'field.namePlaceholder' | 'field.addButton'
  | 'field.changedTypeBlocking' | 'field.changedWarning'
  | 'field.latestMetadataLoaded'
  | 'field.discardManagerConfirm'
  | 'field.error.linkNeedsTargetSheet'
  | 'field.error.lookupNeedsLinkAndTarget'
  | 'field.error.lookupNeedsValidTargetSheet'
  | 'field.error.rollupNeedsLinkAndTarget'
  | 'field.error.rollupNeedsValidTargetSheet'
  | 'field.error.currencyCode'
  | 'field.error.currencyDecimals'
  | 'field.error.numberDecimals'
  | 'field.error.numberUnit'
  | 'field.error.percentDecimals'
  | 'field.error.ratingMax'
  | 'field.error.autoNumberPrefix'
  | 'field.error.autoNumberDigits'
  | 'field.error.autoNumberStart'
  | 'view.title' | 'view.empty' | 'view.saveSettings'
  | 'view.namePlaceholder' | 'view.addButton'
  | 'view.titleField' | 'view.coverField' | 'view.cardFields'
  | 'view.columns' | 'view.cardSize' | 'view.dateField'
  | 'view.endDateField' | 'view.weekStartsOn' | 'view.startField'
  | 'view.endField' | 'view.labelField' | 'view.zoom'
  | 'view.progressField' | 'view.ganttGroupField'
  | 'view.dependencyField' | 'view.groupField'
  | 'view.parentField' | 'view.defaultExpandDepth'
  | 'view.orphanRecords' | 'view.noAdditionalConfig'
  | 'view.filterSortGroup' | 'view.sharedByViews'
  | 'view.filters' | 'view.sorts' | 'view.allConditions'
  | 'view.anyCondition' | 'view.noValue' | 'view.addFilter'
  | 'view.addSort' | 'view.sortAsc' | 'view.sortDesc'
  | 'view.changedWarning' | 'view.latestMetadataLoaded'
  | 'view.latestFieldMetadataLoaded'
  | 'view.discardManagerConfirm'
  | 'view.discardFormattingConfirm'
  | 'view.error.galleryTitleInvalid'
  | 'view.error.galleryCoverInvalid'
  | 'view.error.cardFieldsMissing'
  | 'view.error.dateInvalid'
  | 'view.error.endDateInvalid'
  | 'view.error.titleMissing'
  | 'view.error.startInvalid'
  | 'view.error.endInvalid'
  | 'view.error.labelMissing'
  | 'view.error.progressInvalid'
  | 'view.error.ganttGroupInvalid'
  | 'view.error.dependencyInvalid'
  | 'view.error.kanbanGroupInvalid'
  | 'view.error.parentInvalid'
  | 'view.error.filterMissing'
  | 'view.error.sortMissing'
  | 'view.error.groupInvalid'
  | 'validation.title' | 'validation.required'
  | 'validation.customErrorMessage' | 'validation.minLength'
  | 'validation.maxLength' | 'validation.pattern'
  | 'validation.patternCustom' | 'validation.patternEmail'
  | 'validation.patternUrl' | 'validation.patternPhone'
  | 'validation.regexPattern' | 'validation.minimum'
  | 'validation.maximum' | 'validation.restrictOptions'
  | 'validation.noOptions' | 'validation.preview'

const LABELS: Record<MetaManagerLabelKey, { en: string; zh: string }> = {
  'action.configure': { en: 'Configure', zh: '配置' },
  'action.conditionalFormatting': { en: 'Conditional formatting', zh: '条件格式' },
  'action.rename': { en: 'Rename', zh: '重命名' },
  'action.moveUp': { en: 'Move up', zh: '上移' },
  'action.moveDown': { en: 'Move down', zh: '下移' },
  'action.delete': { en: 'Delete', zh: '删除' },
  'action.confirmRename': { en: 'Confirm rename', zh: '确认重命名' },
  'action.cancelRename': { en: 'Cancel rename', zh: '取消重命名' },
  'action.cancel': { en: 'Cancel', zh: '取消' },
  'action.reloadLatest': { en: 'Reload latest', zh: '重新加载最新' },
  'action.dismiss': { en: 'Dismiss', zh: '忽略' },
  'action.add': { en: '+ Add', zh: '+ 添加' },
  'action.addOption': { en: '+ Add option', zh: '+ 添加选项' },
  'action.save': { en: 'Save', zh: '保存' },
  'action.remove': { en: 'Remove', zh: '移除' },
  'action.clear': { en: 'Clear', zh: '清除' },
  'action.apply': { en: 'Apply', zh: '应用' },

  'field.title': { en: 'Manage Fields', zh: '管理字段' },
  'field.empty': { en: 'No fields defined', zh: '暂无字段' },
  'field.options': { en: 'Options', zh: '选项' },
  'field.optionValue': { en: 'Value', zh: '选项值' },
  'field.targetSheet': { en: 'Target sheet', zh: '目标表' },
  'field.selectSheet': { en: 'Select sheet', zh: '选择表' },
  'field.limitSingleLinkedRecord': { en: 'Limit to a single linked record', zh: '限制为单条关联记录' },
  'field.personHint': {
    en: 'People fields use the system people sheet preset and stay hidden from normal sheet navigation.',
    zh: '人员字段使用系统人员表预设，并在普通表导航中保持隐藏。',
  },
  'field.limitSinglePerson': { en: 'Limit to a single person', zh: '限制为单个人员' },
  'field.linkField': { en: 'Link field', zh: '关联字段' },
  'field.selectLinkField': { en: 'Select link field', zh: '选择关联字段' },
  'field.foreignSheetId': { en: 'Foreign sheet id', zh: '外部表 ID' },
  'field.targetFieldId': { en: 'Target field id', zh: '目标字段 ID' },
  'field.optionalOverride': { en: 'Optional override', zh: '可选覆盖' },
  'field.aggregation': { en: 'Aggregation', zh: '聚合' },
  'field.expression': { en: 'Expression', zh: '表达式' },
  'field.insertFieldToken': { en: 'Insert field token', zh: '插入字段令牌' },
  'field.formulaReference': { en: 'Formula reference', zh: '公式参考' },
  'field.formulaSearchPlaceholder': { en: 'Search SUM, IF, %, ^, &...', zh: '搜索 SUM、IF、%、^、&...' },
  'field.allCategories': { en: 'All categories', zh: '全部分类' },
  'field.noMatchingFunctions': { en: 'No matching functions.', zh: '没有匹配的函数。' },
  'field.maxFiles': { en: 'Max files', zh: '最大文件数' },
  'field.acceptedMimeTypes': { en: 'Accepted mime types', zh: '允许的 MIME 类型' },
  'field.decimals': { en: 'Decimals', zh: '小数位' },
  'field.preserve': { en: 'Preserve', zh: '保留' },
  'field.unit': { en: 'Unit', zh: '单位' },
  'field.useThousandsSeparators': { en: 'Use thousands separators', zh: '使用千位分隔符' },
  'field.currencyCode': { en: 'Currency code (ISO 4217)', zh: '货币代码（ISO 4217）' },
  'field.maxRating': { en: 'Maximum rating (1-10)', zh: '最高评分（1-10）' },
  'field.prefix': { en: 'Prefix', zh: '前缀' },
  'field.digits': { en: 'Digits', zh: '位数' },
  'field.startAt': { en: 'Start at', zh: '起始值' },
  'field.autoNumberHint': {
    en: 'Existing records are backfilled once when the field is created or converted.',
    zh: '字段创建或转换时，会对已有记录一次性回填。',
  },
  'field.saveSettings': { en: 'Save field settings', zh: '保存字段设置' },
  'field.applyDefaults': { en: 'Apply defaults', zh: '应用默认值' },
  'field.namePlaceholder': { en: 'Field name', zh: '字段名称' },
  'field.addButton': { en: '+ Add', zh: '+ 添加' },
  'field.changedTypeBlocking': {
    en: 'This field changed type in the background. Reload latest before saving.',
    zh: '该字段类型已在后台变更。保存前请重新加载最新设置。',
  },
  'field.changedWarning': {
    en: 'This field changed in the background. Save keeps your draft, or reload the latest settings.',
    zh: '该字段已在后台变更。保存会保留当前草稿，或重新加载最新设置。',
  },
  'field.latestMetadataLoaded': { en: 'Latest field metadata loaded from the sheet context.', zh: '已从表上下文加载最新字段元数据。' },
  'field.discardManagerConfirm': { en: 'Discard unsaved field manager changes?', zh: '放弃未保存的字段管理更改吗？' },
  'field.error.linkNeedsTargetSheet': { en: 'Choose a target sheet for link fields', zh: '请为关联字段选择目标表' },
  'field.error.lookupNeedsLinkAndTarget': { en: 'Lookup fields need a link field and a target field id', zh: '查找字段需要关联字段和目标字段 ID' },
  'field.error.lookupNeedsValidTargetSheet': { en: 'Lookup fields need a valid target sheet', zh: '查找字段需要有效的目标表' },
  'field.error.rollupNeedsLinkAndTarget': { en: 'Rollup fields need a link field and a target field id', zh: '汇总字段需要关联字段和目标字段 ID' },
  'field.error.rollupNeedsValidTargetSheet': { en: 'Rollup fields need a valid target sheet', zh: '汇总字段需要有效的目标表' },
  'field.error.currencyCode': { en: 'Currency code must be a 3-letter ISO code (e.g. CNY, USD, EUR)', zh: '货币代码必须是 3 位 ISO 代码（如 CNY、USD、EUR）' },
  'field.error.currencyDecimals': { en: 'Currency decimals must be between 0 and 6', zh: '货币小数位必须在 0 到 6 之间' },
  'field.error.numberDecimals': { en: 'Number decimals must be blank or between 0 and 6', zh: '数字小数位必须留空或在 0 到 6 之间' },
  'field.error.numberUnit': { en: 'Number unit must be 24 characters or fewer', zh: '数字单位不能超过 24 个字符' },
  'field.error.percentDecimals': { en: 'Percent decimals must be between 0 and 6', zh: '百分比小数位必须在 0 到 6 之间' },
  'field.error.ratingMax': { en: 'Rating max must be between 1 and 10', zh: '评分上限必须在 1 到 10 之间' },
  'field.error.autoNumberPrefix': { en: 'Auto number prefix must be 32 characters or fewer', zh: '自动编号前缀不能超过 32 个字符' },
  'field.error.autoNumberDigits': { en: 'Auto number digits must be between 0 and 12', zh: '自动编号位数必须在 0 到 12 之间' },
  'field.error.autoNumberStart': { en: 'Auto number start must be at least 1', zh: '自动编号起始值至少为 1' },

  'view.title': { en: 'Manage Views', zh: '管理视图' },
  'view.empty': { en: 'No views defined', zh: '暂无视图' },
  'view.saveSettings': { en: 'Save view settings', zh: '保存视图设置' },
  'view.namePlaceholder': { en: 'View name', zh: '视图名称' },
  'view.addButton': { en: '+ Add', zh: '+ 添加' },
  'view.titleField': { en: 'Title field', zh: '标题字段' },
  'view.coverField': { en: 'Cover field', zh: '封面字段' },
  'view.cardFields': { en: 'Card fields', zh: '卡片字段' },
  'view.columns': { en: 'Columns', zh: '列数' },
  'view.cardSize': { en: 'Card size', zh: '卡片尺寸' },
  'view.dateField': { en: 'Date field', zh: '日期字段' },
  'view.endDateField': { en: 'End date field', zh: '结束日期字段' },
  'view.weekStartsOn': { en: 'Week starts on', zh: '每周起始日' },
  'view.startField': { en: 'Start field', zh: '开始字段' },
  'view.endField': { en: 'End field', zh: '结束字段' },
  'view.labelField': { en: 'Label field', zh: '标签字段' },
  'view.zoom': { en: 'Zoom', zh: '缩放' },
  'view.progressField': { en: 'Progress field', zh: '进度字段' },
  'view.ganttGroupField': { en: 'Gantt group field', zh: '甘特分组字段' },
  'view.dependencyField': { en: 'Dependency field', zh: '依赖字段' },
  'view.groupField': { en: 'Group field', zh: '分组字段' },
  'view.parentField': { en: 'Parent field', zh: '父级字段' },
  'view.defaultExpandDepth': { en: 'Default expand depth', zh: '默认展开层级' },
  'view.orphanRecords': { en: 'Orphan records', zh: '孤立记录' },
  'view.noAdditionalConfig': { en: 'No additional configuration is required for this view type.', zh: '此视图类型无需额外配置。' },
  'view.filterSortGroup': { en: 'Filter, sort, group', zh: '筛选、排序、分组' },
  'view.sharedByViews': { en: 'Shared by grid and visual views', zh: '网格和可视化视图共用' },
  'view.filters': { en: 'Filters', zh: '筛选' },
  'view.sorts': { en: 'Sorts', zh: '排序' },
  'view.allConditions': { en: 'all conditions', zh: '满足全部条件' },
  'view.anyCondition': { en: 'any condition', zh: '满足任一条件' },
  'view.noValue': { en: 'no value', zh: '无值' },
  'view.addFilter': { en: '+ Add filter', zh: '+ 添加筛选' },
  'view.addSort': { en: '+ Add sort', zh: '+ 添加排序' },
  'view.sortAsc': { en: 'A to Z', zh: 'A 到 Z' },
  'view.sortDesc': { en: 'Z to A', zh: 'Z 到 A' },
  'view.changedWarning': {
    en: 'This view changed in the background. Save keeps your draft, or reload the latest settings.',
    zh: '该视图已在后台变更。保存会保留当前草稿，或重新加载最新设置。',
  },
  'view.latestMetadataLoaded': { en: 'Latest view metadata loaded from the sheet context.', zh: '已从表上下文加载最新视图元数据。' },
  'view.latestFieldMetadataLoaded': { en: 'Latest field metadata loaded from the sheet context.', zh: '已从表上下文加载最新字段元数据。' },
  'view.discardManagerConfirm': { en: 'Discard unsaved view manager changes?', zh: '放弃未保存的视图管理更改吗？' },
  'view.discardFormattingConfirm': { en: 'Discard unsaved formatting rules?', zh: '放弃未保存的格式规则吗？' },
  'view.error.galleryTitleInvalid': { en: 'A selected title field is no longer a text-like field. Reload latest before saving.', zh: '已选择的标题字段不再是文本类字段。保存前请重新加载最新设置。' },
  'view.error.galleryCoverInvalid': { en: 'A selected cover field is no longer an attachment field. Reload latest before saving.', zh: '已选择的封面字段不再是附件字段。保存前请重新加载最新设置。' },
  'view.error.cardFieldsMissing': { en: 'One or more selected card fields disappeared in the background. Reload latest before saving.', zh: '一个或多个已选择的卡片字段已在后台消失。保存前请重新加载最新设置。' },
  'view.error.dateInvalid': { en: 'The selected date field is no longer date-like. Reload latest before saving.', zh: '已选择的日期字段不再是日期类字段。保存前请重新加载最新设置。' },
  'view.error.endDateInvalid': { en: 'The selected end date field is no longer date-like. Reload latest before saving.', zh: '已选择的结束日期字段不再是日期类字段。保存前请重新加载最新设置。' },
  'view.error.titleMissing': { en: 'The selected title field disappeared in the background. Reload latest before saving.', zh: '已选择的标题字段已在后台消失。保存前请重新加载最新设置。' },
  'view.error.startInvalid': { en: 'The selected start field is no longer a date field. Reload latest before saving.', zh: '已选择的开始字段不再是日期字段。保存前请重新加载最新设置。' },
  'view.error.endInvalid': { en: 'The selected end field is no longer a date field. Reload latest before saving.', zh: '已选择的结束字段不再是日期字段。保存前请重新加载最新设置。' },
  'view.error.labelMissing': { en: 'The selected label field disappeared in the background. Reload latest before saving.', zh: '已选择的标签字段已在后台消失。保存前请重新加载最新设置。' },
  'view.error.progressInvalid': { en: 'The selected progress field is no longer numeric. Reload latest before saving.', zh: '已选择的进度字段不再是数字类字段。保存前请重新加载最新设置。' },
  'view.error.ganttGroupInvalid': { en: 'The selected Gantt group field is no longer groupable. Reload latest before saving.', zh: '已选择的甘特分组字段不再可分组。保存前请重新加载最新设置。' },
  'view.error.dependencyInvalid': { en: 'The selected dependency field is no longer supported. Reload latest before saving.', zh: '已选择的依赖字段不再受支持。保存前请重新加载最新设置。' },
  'view.error.kanbanGroupInvalid': { en: 'The selected group field is no longer a select field. Reload latest before saving.', zh: '已选择的分组字段不再是单选字段。保存前请重新加载最新设置。' },
  'view.error.parentInvalid': { en: 'The selected parent field is no longer a link field. Reload latest before saving.', zh: '已选择的父级字段不再是关联字段。保存前请重新加载最新设置。' },
  'view.error.filterMissing': { en: 'One or more selected filter fields disappeared in the background. Reload latest before saving.', zh: '一个或多个已选择的筛选字段已在后台消失。保存前请重新加载最新设置。' },
  'view.error.sortMissing': { en: 'One or more selected sort fields disappeared in the background. Reload latest before saving.', zh: '一个或多个已选择的排序字段已在后台消失。保存前请重新加载最新设置。' },
  'view.error.groupInvalid': { en: 'The selected group field is no longer groupable. Reload latest before saving.', zh: '已选择的分组字段不再可分组。保存前请重新加载最新设置。' },

  'validation.title': { en: 'Validation Rules', zh: '校验规则' },
  'validation.required': { en: 'Required', zh: '必填' },
  'validation.customErrorMessage': { en: 'Custom error message', zh: '自定义错误消息' },
  'validation.minLength': { en: 'Min length', zh: '最小长度' },
  'validation.maxLength': { en: 'Max length', zh: '最大长度' },
  'validation.pattern': { en: 'Pattern', zh: '模式' },
  'validation.patternCustom': { en: 'Custom', zh: '自定义' },
  'validation.patternEmail': { en: 'Email', zh: '邮箱' },
  'validation.patternUrl': { en: 'URL', zh: 'URL' },
  'validation.patternPhone': { en: 'Phone', zh: '电话' },
  'validation.regexPattern': { en: 'Regex pattern', zh: '正则表达式' },
  'validation.minimum': { en: 'Minimum', zh: '最小值' },
  'validation.maximum': { en: 'Maximum', zh: '最大值' },
  'validation.restrictOptions': { en: 'Restrict to defined options', zh: '限制为已定义选项' },
  'validation.noOptions': { en: 'No options defined', zh: '未定义选项' },
  'validation.preview': { en: 'Preview', zh: '预览' },
}

export function managerLabel(key: MetaManagerLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function duplicateFieldName(name: string, isZh: boolean): string {
  return isZh ? `字段“${name}”已存在` : `A field named "${name}" already exists`
}

export function deleteFieldConfirm(name: string, isZh: boolean): string {
  return isZh ? `删除字段“${name}”？此操作无法撤销。` : `Delete field ${name}? This cannot be undone.`
}

export function deleteViewConfirm(name: string, isZh: boolean): string {
  return isZh ? `删除视图“${name}”？此操作无法撤销。` : `Delete view ${name}? This cannot be undone.`
}

export function configureField(name: string, isZh: boolean): string {
  return isZh ? `配置 ${name}` : `Configure ${name}`
}

export function configureNewField(type: string, isZh: boolean): string {
  return isZh ? `配置新的 ${fieldTypeLabel(type, isZh)} 字段` : `Configure new ${type} field`
}

export function insertFieldTokenTitle(fieldId: string, isZh: boolean): string {
  return isZh ? `插入 {${fieldId}}` : `Insert {${fieldId}}`
}

export function fieldOptionRequired(type: string, isZh: boolean): string {
  const label = type === 'multiSelect' ? (isZh ? '多选' : 'Multi-select') : (isZh ? '单选' : 'Select')
  return isZh ? `${label}字段至少需要一个选项` : `${label} fields need at least one option`
}

export function configureView(name: string, isZh: boolean): string {
  return isZh ? `配置 ${name}` : `Configure ${name}`
}

const VIEW_TYPE_LABELS: Record<string, { en: string; zh: string }> = {
  grid: { en: 'grid', zh: '网格' },
  form: { en: 'form', zh: '表单' },
  kanban: { en: 'kanban', zh: '看板' },
  gallery: { en: 'gallery', zh: '画廊' },
  calendar: { en: 'calendar', zh: '日历' },
  timeline: { en: 'timeline', zh: '时间轴' },
  gantt: { en: 'gantt', zh: '甘特' },
  hierarchy: { en: 'hierarchy', zh: '层级' },
}

export function viewTypeLabel(type: string, isZh: boolean): string {
  const entry = VIEW_TYPE_LABELS[type]
  if (!entry) return type
  return isZh ? entry.zh : entry.en
}

export function sizeLabel(size: string, isZh: boolean): string {
  if (size === 'small') return isZh ? '小' : 'small'
  if (size === 'large') return isZh ? '大' : 'large'
  return isZh ? '中' : 'medium'
}

export function weekdayLabel(day: 0 | 1, isZh: boolean): string {
  return day === 0 ? (isZh ? '星期日' : 'Sunday') : (isZh ? '星期一' : 'Monday')
}

export function zoomLabel(value: string, isZh: boolean): string {
  if (value === 'day') return isZh ? '日' : 'day'
  if (value === 'month') return isZh ? '月' : 'month'
  return isZh ? '周' : 'week'
}

export function orphanModeLabel(value: string, isZh: boolean): string {
  return value === 'hidden' ? (isZh ? '隐藏' : 'hide') : (isZh ? '显示在根级' : 'show at root')
}

export function groupNoneLabel(isZh: boolean): string {
  return isZh ? '无' : 'None'
}

export function autoLabel(isZh: boolean): string {
  return isZh ? '自动' : '(auto)'
}

export function autoLinkFieldLabel(isZh: boolean): string {
  return isZh ? '自动关联字段' : '(auto link field)'
}

export function aggregationLabel(value: string, isZh: boolean): string {
  if (!isZh) return value
  if (value === 'count') return '计数'
  if (value === 'sum') return '求和'
  if (value === 'avg') return '平均值'
  if (value === 'min') return '最小值'
  if (value === 'max') return '最大值'
  return value
}

export function filterOperatorLabel(value: string, fallback: string, isZh: boolean): string {
  if (!isZh) return fallback
  switch (value) {
    case 'is': return fallback === '=' ? '=' : '等于'
    case 'isNot': return fallback === '\u2260' ? '\u2260' : '不等于'
    case 'contains': return '包含'
    case 'doesNotContain': return '不包含'
    case 'isEmpty': return '为空'
    case 'isNotEmpty': return '不为空'
    case 'greater': return fallback === 'after' ? '晚于' : '大于'
    case 'greaterEqual': return '\u2265'
    case 'less': return fallback === 'before' ? '早于' : '小于'
    case 'lessEqual': return '\u2264'
    default: return fallback
  }
}
