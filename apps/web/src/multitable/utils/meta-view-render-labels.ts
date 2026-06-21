// Visual view render chrome string table (final audit Slice B).
//
// Scope: runtime chrome inside Calendar/Gallery/Timeline/Gantt/Hierarchy/
// Kanban/Dashboard/ChartRenderer. User-authored values stay raw: field names,
// record titles, view/dashboard/chart names, option values, attachment
// filenames, holiday/lunar labels, chart data labels, dates, IDs, and data-*.
//
// `common.*` means common inside this view-render module only. It is not an
// app-wide shared namespace.

export type MetaViewRenderLabelKey =
  | 'common.loading'
  | 'common.chooseField'
  | 'common.select'
  | 'common.auto'
  | 'common.none'
  | 'common.addRecord'
  | 'common.add'
  | 'common.createRecord'
  | 'common.createFirstRecord'
  | 'common.noRecordsFound'
  | 'calendar.today'
  | 'calendar.view'
  | 'calendar.month'
  | 'calendar.week'
  | 'calendar.day'
  | 'calendar.change'
  | 'calendar.newRecord'
  | 'calendar.selectDateField'
  | 'calendar.noRecordsOnDay'
  | 'calendar.holidayDataMissingHint'
  | 'gallery.title'
  | 'gallery.cover'
  | 'gallery.columns'
  | 'gallery.cardSize'
  | 'gallery.noRecordsTitle'
  | 'gallery.noRecordsHint'
  | 'gallery.prev'
  | 'gallery.next'
  | 'timeline.viewAria'
  | 'timeline.startDate'
  | 'timeline.endDate'
  | 'timeline.record'
  | 'timeline.axisZoomHint'
  | 'timeline.selectStartEnd'
  | 'timeline.autoRecordIdHint'
  | 'timeline.labelFieldHint'
  | 'gantt.viewAria'
  | 'gantt.start'
  | 'gantt.end'
  | 'gantt.title'
  | 'gantt.progress'
  | 'gantt.group'
  | 'gantt.dependencies'
  | 'gantt.addTask'
  | 'gantt.selectStartEnd'
  | 'gantt.task'
  | 'gantt.to'
  | 'gantt.allTasks'
  | 'gantt.ungrouped'
  | 'hierarchy.viewAria'
  | 'hierarchy.autoLinkField'
  | 'hierarchy.showAtRoot'
  | 'hierarchy.hide'
  | 'hierarchy.addRoot'
  | 'hierarchy.noParentConfigured'
  | 'hierarchy.parentHelp'
  | 'hierarchy.dropToRoot'
  | 'hierarchy.empty'
  | 'hierarchy.child'
  | 'kanban.selectFieldPromptPrefix'
  | 'kanban.selectFieldPromptSuffix'
  | 'kanban.noSelectFields'
  | 'kanban.groupedBy'
  | 'kanban.cardFields'
  | 'kanban.swimlane'
  | 'kanban.clear'
  | 'kanban.uncategorized'
  | 'kanban.dropOrAdd'
  | 'kanban.dropToUpdate'
  | 'kanban.noCards'
  | 'dashboard.rename'
  | 'dashboard.addPanel'
  | 'dashboard.newDashboard'
  | 'dashboard.loadingDashboard'
  | 'dashboard.empty'
  | 'dashboard.loadingChart'
  | 'dashboard.chartLoadFailed'
  | 'dashboard.retry'
  | 'dashboard.addChartPanel'
  | 'dashboard.noCharts'
  | 'dashboard.newChart'
  | 'dashboard.createChartTitle'
  | 'dashboard.chartName'
  | 'dashboard.chartType'
  | 'dashboard.groupBy'
  | 'dashboard.aggregation'
  | 'dashboard.valueField'
  | 'dashboard.createChart'
  | 'dashboard.cancel'
  | 'dashboard.noGroupableFields'
  | 'dashboard.dateGroupingLocked'
  | 'dashboard.chartVariant'
  | 'dashboard.variantStandard'
  | 'dashboard.variantDonut'
  | 'dashboard.variantArea'
  | 'dashboard.seriesBy'
  | 'dashboard.seriesByNone'
  | 'dashboard.seriesByHint'
  | 'dashboard.barMode'
  | 'dashboard.barModeStacked'
  | 'dashboard.barModeGrouped'
  | 'dashboard.barModeAdditiveOnly'
  | 'dashboard.noNumericFields'
  | 'dashboard.xField'
  | 'dashboard.yField'
  | 'dashboard.colorField'
  | 'dashboard.sizeField'
  | 'dashboard.scatterFieldHint'
  | 'dashboard.livePreview'
  | 'dashboard.previewFillRequired'
  | 'dashboard.loadingPreview'
  | 'dashboard.previewWaiting'
  | 'dashboard.previewError'
  | 'dashboard.createChartError'
  | 'dashboard.editChartTitle'
  | 'dashboard.editChart'
  | 'dashboard.saveChart'
  | 'dashboard.deleteChart'
  | 'dashboard.deleteChartConfirm'
  | 'dashboard.editChartError'
  | 'dashboard.addWidget'
  | 'dashboard.addWidgetTitle'
  | 'dashboard.widgetKind'
  | 'dashboard.widgetKindMetric'
  | 'dashboard.widgetKindText'
  | 'dashboard.widgetKindFilter'
  | 'dashboard.widgetTitle'
  | 'dashboard.untitledWidget'
  | 'dashboard.metricPrefix'
  | 'dashboard.metricSuffix'
  | 'dashboard.textContent'
  | 'dashboard.textContentPlaceholder'
  | 'dashboard.textEmpty'
  | 'dashboard.filterField'
  | 'dashboard.filterAllOption'
  | 'dashboard.filterValueLabel'
  | 'dashboard.filterValuePlaceholder'
  | 'dashboard.filterConfigNote'
  | 'dashboard.addWidgetAction'
  | 'dashboard.loadingMetric'
  | 'chart.label'
  | 'chart.value'
  | 'chart.restrictedTitle'
  | 'chart.restrictedHint'
  | 'chart.gaugeNonAdditiveNote'

export const VIEW_RENDER_LABEL_KEYS: readonly MetaViewRenderLabelKey[] = [
  'common.loading',
  'common.chooseField',
  'common.select',
  'common.auto',
  'common.none',
  'common.addRecord',
  'common.add',
  'common.createRecord',
  'common.createFirstRecord',
  'common.noRecordsFound',
  'calendar.today',
  'calendar.view',
  'calendar.month',
  'calendar.week',
  'calendar.day',
  'calendar.change',
  'calendar.newRecord',
  'calendar.selectDateField',
  'calendar.noRecordsOnDay',
  'calendar.holidayDataMissingHint',
  'gallery.title',
  'gallery.cover',
  'gallery.columns',
  'gallery.cardSize',
  'gallery.noRecordsTitle',
  'gallery.noRecordsHint',
  'gallery.prev',
  'gallery.next',
  'timeline.viewAria',
  'timeline.startDate',
  'timeline.endDate',
  'timeline.record',
  'timeline.axisZoomHint',
  'timeline.selectStartEnd',
  'timeline.autoRecordIdHint',
  'timeline.labelFieldHint',
  'gantt.viewAria',
  'gantt.start',
  'gantt.end',
  'gantt.title',
  'gantt.progress',
  'gantt.group',
  'gantt.dependencies',
  'gantt.addTask',
  'gantt.selectStartEnd',
  'gantt.task',
  'gantt.to',
  'gantt.allTasks',
  'gantt.ungrouped',
  'hierarchy.viewAria',
  'hierarchy.autoLinkField',
  'hierarchy.showAtRoot',
  'hierarchy.hide',
  'hierarchy.addRoot',
  'hierarchy.noParentConfigured',
  'hierarchy.parentHelp',
  'hierarchy.dropToRoot',
  'hierarchy.empty',
  'hierarchy.child',
  'kanban.selectFieldPromptPrefix',
  'kanban.selectFieldPromptSuffix',
  'kanban.noSelectFields',
  'kanban.groupedBy',
  'kanban.cardFields',
  'kanban.swimlane',
  'kanban.clear',
  'kanban.uncategorized',
  'kanban.dropOrAdd',
  'kanban.dropToUpdate',
  'kanban.noCards',
  'dashboard.rename',
  'dashboard.addPanel',
  'dashboard.newDashboard',
  'dashboard.loadingDashboard',
  'dashboard.empty',
  'dashboard.loadingChart',
  'dashboard.chartLoadFailed',
  'dashboard.retry',
  'dashboard.addChartPanel',
  'dashboard.noCharts',
  'dashboard.newChart',
  'dashboard.createChartTitle',
  'dashboard.chartName',
  'dashboard.chartType',
  'dashboard.groupBy',
  'dashboard.aggregation',
  'dashboard.valueField',
  'dashboard.createChart',
  'dashboard.cancel',
  'dashboard.noGroupableFields',
  'dashboard.dateGroupingLocked',
  'dashboard.chartVariant',
  'dashboard.variantStandard',
  'dashboard.variantDonut',
  'dashboard.variantArea',
  'dashboard.seriesBy',
  'dashboard.seriesByNone',
  'dashboard.seriesByHint',
  'dashboard.barMode',
  'dashboard.barModeStacked',
  'dashboard.barModeGrouped',
  'dashboard.barModeAdditiveOnly',
  'dashboard.noNumericFields',
  'dashboard.xField',
  'dashboard.yField',
  'dashboard.colorField',
  'dashboard.sizeField',
  'dashboard.scatterFieldHint',
  'dashboard.livePreview',
  'dashboard.previewFillRequired',
  'dashboard.loadingPreview',
  'dashboard.previewWaiting',
  'dashboard.previewError',
  'dashboard.createChartError',
  'dashboard.editChartTitle',
  'dashboard.editChart',
  'dashboard.saveChart',
  'dashboard.deleteChart',
  'dashboard.deleteChartConfirm',
  'dashboard.editChartError',
  'dashboard.addWidget',
  'dashboard.addWidgetTitle',
  'dashboard.widgetKind',
  'dashboard.widgetKindMetric',
  'dashboard.widgetKindText',
  'dashboard.widgetKindFilter',
  'dashboard.widgetTitle',
  'dashboard.untitledWidget',
  'dashboard.metricPrefix',
  'dashboard.metricSuffix',
  'dashboard.textContent',
  'dashboard.textContentPlaceholder',
  'dashboard.textEmpty',
  'dashboard.filterField',
  'dashboard.filterAllOption',
  'dashboard.filterValueLabel',
  'dashboard.filterValuePlaceholder',
  'dashboard.filterConfigNote',
  'dashboard.addWidgetAction',
  'dashboard.loadingMetric',
  'chart.label',
  'chart.value',
  'chart.restrictedTitle',
  'chart.restrictedHint',
  'chart.gaugeNonAdditiveNote',
]

const LABELS: Record<MetaViewRenderLabelKey, { en: string; zh: string }> = {
  'common.loading': { en: 'Loading...', zh: '正在加载...' },
  'common.chooseField': { en: '— Choose field —', zh: '— 选择字段 —' },
  'common.select': { en: 'select', zh: '选择' },
  'common.auto': { en: 'Auto', zh: '自动' },
  'common.none': { en: 'None', zh: '无' },
  'common.addRecord': { en: '+ Add record', zh: '+ 添加记录' },
  'common.add': { en: '+ Add', zh: '+ 添加' },
  'common.createRecord': { en: 'Create record', zh: '创建记录' },
  'common.createFirstRecord': { en: 'Create first record', zh: '创建第一条记录' },
  'common.noRecordsFound': { en: 'No records found', zh: '未找到记录' },
  'calendar.today': { en: 'Today', zh: '今天' },
  'calendar.view': { en: 'View', zh: '视图' },
  'calendar.month': { en: 'Month', zh: '月' },
  'calendar.week': { en: 'Week', zh: '周' },
  'calendar.day': { en: 'Day', zh: '日' },
  'calendar.change': { en: 'Change', zh: '更改' },
  'calendar.newRecord': { en: '+ New record', zh: '+ 新建记录' },
  'calendar.selectDateField': { en: 'Select a date field to use for the calendar:', zh: '选择一个日期字段用于日历：' },
  'calendar.noRecordsOnDay': { en: 'No records on this day', zh: '这一天没有记录' },
  'calendar.holidayDataMissingHint': {
    en: 'No public holiday data is synced for this range. Sync holidays in Attendance settings if holiday or makeup-workday chips are expected.',
    zh: '当前范围没有已同步的节假日数据；如应显示节假日或调休班标记，请先在考勤设置中同步节假日。',
  },
  'gallery.title': { en: 'Title', zh: '标题' },
  'gallery.cover': { en: 'Cover', zh: '封面' },
  'gallery.columns': { en: 'Columns', zh: '列数' },
  'gallery.cardSize': { en: 'Card size', zh: '卡片尺寸' },
  'gallery.noRecordsTitle': { en: 'No records to display', zh: '没有可显示的记录' },
  'gallery.noRecordsHint': { en: 'Add records to see them as cards here', zh: '添加记录后将在此显示为卡片' },
  'gallery.prev': { en: 'Prev', zh: '上一页' },
  'gallery.next': { en: 'Next', zh: '下一页' },
  'timeline.viewAria': { en: 'Timeline view', zh: '时间轴视图' },
  'timeline.startDate': { en: 'Start date', zh: '开始日期' },
  'timeline.endDate': { en: 'End date', zh: '结束日期' },
  'timeline.record': { en: 'Record', zh: '记录' },
  'timeline.axisZoomHint': { en: 'Axis spacing follows the selected zoom level.', zh: '坐标轴间距跟随所选缩放级别。' },
  'timeline.selectStartEnd': { en: 'Select start and end date fields to display the timeline.', zh: '选择开始和结束日期字段以显示时间轴。' },
  'timeline.autoRecordIdHint': { en: 'Auto falls back to record id.', zh: '自动模式会回退到记录 ID。' },
  'timeline.labelFieldHint': { en: 'Timeline labels use this field across rows and unscheduled items.', zh: '时间轴标签将在行和未排期项目中使用此字段。' },
  'gantt.viewAria': { en: 'Gantt view', zh: '甘特视图' },
  'gantt.start': { en: 'Start', zh: '开始' },
  'gantt.end': { en: 'End', zh: '结束' },
  'gantt.title': { en: 'Title', zh: '标题' },
  'gantt.progress': { en: 'Progress', zh: '进度' },
  'gantt.group': { en: 'Group', zh: '分组' },
  'gantt.dependencies': { en: 'Dependencies', zh: '依赖' },
  'gantt.addTask': { en: '+ Add task', zh: '+ 添加任务' },
  'gantt.selectStartEnd': { en: 'Select start and end date fields to display Gantt tasks.', zh: '选择开始和结束日期字段以显示甘特任务。' },
  'gantt.task': { en: 'Task', zh: '任务' },
  'gantt.to': { en: 'to', zh: '至' },
  'gantt.allTasks': { en: 'All tasks', zh: '全部任务' },
  'gantt.ungrouped': { en: 'Ungrouped', zh: '未分组' },
  'hierarchy.viewAria': { en: 'Hierarchy view', zh: '层级视图' },
  'hierarchy.autoLinkField': { en: '(auto link field)', zh: '自动关联字段' },
  'hierarchy.showAtRoot': { en: 'show at root', zh: '显示在根级' },
  'hierarchy.hide': { en: 'hide', zh: '隐藏' },
  'hierarchy.addRoot': { en: '+ Add root', zh: '+ 添加根记录' },
  'hierarchy.noParentConfigured': { en: 'No parent link field configured.', zh: '未配置父级关联字段。' },
  'hierarchy.parentHelp': { en: 'Add or choose a link field to render parent-child relationships.', zh: '添加或选择一个关联字段以渲染父子关系。' },
  'hierarchy.dropToRoot': { en: 'Drop here to move to root', zh: '拖到此处移动到根级' },
  'hierarchy.empty': { en: 'No records match this hierarchy view.', zh: '没有匹配此层级视图的记录。' },
  'hierarchy.child': { en: '+ Child', zh: '+ 子记录' },
  'kanban.selectFieldPromptPrefix': { en: 'Select a ', zh: '选择一个' },
  'kanban.selectFieldPromptSuffix': { en: '-type field to group by:', zh: '类型字段进行分组：' },
  'kanban.noSelectFields': { en: 'No select-type fields found. Add a select field first.', zh: '未找到单选字段。请先添加一个单选字段。' },
  'kanban.groupedBy': { en: 'Grouped by:', zh: '分组依据：' },
  'kanban.cardFields': { en: 'Card fields', zh: '卡片字段' },
  'kanban.swimlane': { en: 'Swimlane', zh: '泳道' },
  'kanban.clear': { en: 'Clear', zh: '清除' },
  'kanban.uncategorized': { en: 'Uncategorized', zh: '未分类' },
  'kanban.dropOrAdd': { en: 'Drop a card here or add a new record', zh: '将卡片拖到此处，或添加新记录' },
  'kanban.dropToUpdate': { en: 'Drop a card here to update its group', zh: '将卡片拖到此处以更新其分组' },
  'kanban.noCards': { en: 'No cards in this column', zh: '此列没有卡片' },
  'dashboard.rename': { en: 'Rename', zh: '重命名' },
  'dashboard.addPanel': { en: '+ Add Panel', zh: '+ 添加面板' },
  'dashboard.newDashboard': { en: '+ New Dashboard', zh: '+ 新建仪表板' },
  'dashboard.loadingDashboard': { en: 'Loading dashboard...', zh: '正在加载仪表板...' },
  'dashboard.empty': { en: 'No dashboards yet. Create your first dashboard.', zh: '暂无仪表板。创建你的第一个仪表板。' },
  'dashboard.loadingChart': { en: 'Loading chart...', zh: '正在加载图表...' },
  'dashboard.chartLoadFailed': { en: 'Chart failed to load.', zh: '图表加载失败。' },
  'dashboard.retry': { en: 'Retry', zh: '重试' },
  'dashboard.addChartPanel': { en: 'Add Chart Panel', zh: '添加图表面板' },
  'dashboard.noCharts': { en: 'No charts available. Create a chart first.', zh: '暂无可用图表。请先创建一个图表。' },
  'dashboard.newChart': { en: '+ New Chart', zh: '+ 新建图表' },
  'dashboard.createChartTitle': { en: 'Create chart', zh: '新建图表' },
  'dashboard.chartName': { en: 'Chart name', zh: '图表名称' },
  'dashboard.chartType': { en: 'Chart type', zh: '图表类型' },
  'dashboard.groupBy': { en: 'Group by', zh: '分组字段' },
  'dashboard.aggregation': { en: 'Aggregation', zh: '聚合方式' },
  'dashboard.valueField': { en: 'Value field', zh: '数值字段' },
  'dashboard.createChart': { en: 'Create chart', zh: '创建图表' },
  'dashboard.cancel': { en: 'Cancel', zh: '取消' },
  'dashboard.noGroupableFields': { en: 'No readable groupable fields available.', zh: '没有可读取的可分组字段。' },
  'dashboard.dateGroupingLocked': {
    en: 'Grouped by date; date grouping is preserved in this editor.',
    zh: '已按日期分组；此编辑器会保留现有日期分组。',
  },
  'dashboard.chartVariant': { en: 'Chart style', zh: '图表样式' },
  'dashboard.variantStandard': { en: 'Standard', zh: '标准' },
  'dashboard.variantDonut': { en: 'Donut', zh: '环形图' },
  'dashboard.variantArea': { en: 'Area', zh: '面积图' },
  'dashboard.seriesBy': { en: 'Split by (series)', zh: '系列分组' },
  'dashboard.seriesByNone': { en: 'None (single bar)', zh: '不分组（单系列）' },
  'dashboard.seriesByHint': { en: 'Splits each bar by a second field (stacked or grouped — see layout below).', zh: '按第二个字段拆分每根柱子（堆叠或并排，见下方布局）。' },
  'dashboard.barMode': { en: 'Series layout', zh: '系列布局' },
  'dashboard.barModeStacked': { en: 'Stacked', zh: '堆叠' },
  'dashboard.barModeGrouped': { en: 'Grouped (side by side)', zh: '并排分组' },
  'dashboard.barModeAdditiveOnly': { en: 'Stacked needs a sum or count aggregation; using grouped.', zh: '堆叠需要求和或计数聚合；已改用并排分组。' },
  'dashboard.noNumericFields': { en: 'No readable numeric fields available.', zh: '没有可读取的数值字段。' },
  'dashboard.xField': { en: 'X axis (numeric)', zh: 'X 轴（数值）' },
  'dashboard.yField': { en: 'Y axis (numeric)', zh: 'Y 轴（数值）' },
  'dashboard.colorField': { en: 'Color by (optional)', zh: '颜色分类（可选）' },
  'dashboard.sizeField': { en: 'Size by (optional, numeric)', zh: '气泡大小（可选，数值）' },
  'dashboard.scatterFieldHint': { en: 'Each record is one point at (X, Y); no grouping or aggregation.', zh: '每条记录是一个 (X, Y) 坐标点，不分组也不聚合。' },
  'dashboard.livePreview': { en: 'Live preview', zh: '实时预览' },
  'dashboard.previewFillRequired': { en: 'Complete the chart fields to preview.', zh: '填写完整图表字段后可预览。' },
  'dashboard.loadingPreview': { en: 'Loading preview...', zh: '正在加载预览...' },
  'dashboard.previewWaiting': { en: 'Preview will appear here.', zh: '预览将显示在这里。' },
  'dashboard.previewError': { en: 'Preview failed. Save is not blocked.', zh: '预览失败，不影响保存。' },
  'dashboard.createChartError': { en: 'Failed to create chart.', zh: '创建图表失败。' },
  'dashboard.editChartTitle': { en: 'Edit chart', zh: '编辑图表' },
  'dashboard.editChart': { en: 'Edit', zh: '编辑' },
  'dashboard.saveChart': { en: 'Save chart', zh: '保存图表' },
  'dashboard.deleteChart': { en: 'Delete', zh: '删除' },
  'dashboard.deleteChartConfirm': { en: 'Delete this chart? Panels showing it will be removed.', zh: '删除此图表？引用它的面板将被移除。' },
  'dashboard.editChartError': { en: 'Failed to save chart.', zh: '保存图表失败。' },
  'dashboard.addWidget': { en: '+ Add Widget', zh: '+ 添加组件' },
  'dashboard.addWidgetTitle': { en: 'Add widget', zh: '添加组件' },
  'dashboard.widgetKind': { en: 'Widget type', zh: '组件类型' },
  'dashboard.widgetKindMetric': { en: 'Metric card', zh: '指标卡' },
  'dashboard.widgetKindText': { en: 'Text note', zh: '文本说明' },
  'dashboard.widgetKindFilter': { en: 'Filter', zh: '筛选器' },
  'dashboard.widgetTitle': { en: 'Title', zh: '标题' },
  'dashboard.untitledWidget': { en: 'Untitled', zh: '未命名' },
  'dashboard.metricPrefix': { en: 'Prefix (optional)', zh: '前缀（可选）' },
  'dashboard.metricSuffix': { en: 'Suffix (optional)', zh: '后缀（可选）' },
  'dashboard.textContent': { en: 'Content', zh: '内容' },
  'dashboard.textContentPlaceholder': { en: 'Write a note (basic formatting allowed)…', zh: '撰写说明（支持基础格式）…' },
  'dashboard.textEmpty': { en: 'Empty text widget. Edit it to add content.', zh: '空文本组件。编辑以添加内容。' },
  'dashboard.filterField': { en: 'Field', zh: '字段' },
  'dashboard.filterAllOption': { en: 'All', zh: '全部' },
  'dashboard.filterValueLabel': { en: 'Value', zh: '值' },
  'dashboard.filterValuePlaceholder': { en: 'Type a value to filter by…', zh: '输入筛选值…' },
  'dashboard.filterConfigNote': {
    en: 'This filter applies to every data panel in the dashboard.',
    zh: '此筛选器将作用于仪表盘中的每个数据面板。',
  },
  'dashboard.addWidgetAction': { en: 'Add', zh: '添加' },
  'dashboard.loadingMetric': { en: 'Loading metric...', zh: '正在加载指标...' },
  'chart.label': { en: 'Label', zh: '标签' },
  'chart.value': { en: 'Value', zh: '值' },
  'chart.restrictedTitle': { en: 'Chart data restricted', zh: '图表数据受限' },
  'chart.restrictedHint': {
    en: 'This chart references fields you cannot read.',
    zh: '此图表引用了你无权读取的字段。',
  },
  'chart.gaugeNonAdditiveNote': {
    // r2 item 2: the gauge dials the first value against the sum of all values (share-of-total).
    // That reading only holds for an additive aggregation (count/sum); for avg/min/max the
    // sum-of-values denominator is not a meaningful whole, so warn the reader.
    en: 'Share of total is approximate for this aggregation (avg/min/max do not sum to a whole).',
    zh: '该聚合方式下的占比仅供参考（平均/最小/最大值之和不构成有意义的总量）。',
  },
}

export function viewRenderLabel(key: MetaViewRenderLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export type ViewRenderSize = 'small' | 'medium' | 'large'
export type ViewRenderZoom = 'day' | 'week' | 'month'
export type CalendarViewMode = 'month' | 'week' | 'day'

export function viewSizeLabel(size: ViewRenderSize | (string & {}), isZh: boolean): string {
  if (size === 'small') return isZh ? '小' : 'Small'
  if (size === 'large') return isZh ? '大' : 'Large'
  if (size === 'medium') return isZh ? '中' : 'Medium'
  return String(size)
}

export function viewZoomLabel(zoom: ViewRenderZoom | (string & {}), isZh: boolean): string {
  if (zoom === 'day') return isZh ? '日' : 'Day'
  if (zoom === 'month') return isZh ? '月' : 'Month'
  if (zoom === 'week') return isZh ? '周' : 'Week'
  return String(zoom)
}

export function calendarViewModeLabel(mode: CalendarViewMode | (string & {}), isZh: boolean): string {
  if (mode === 'month') return viewRenderLabel('calendar.month', isZh)
  if (mode === 'week') return viewRenderLabel('calendar.week', isZh)
  if (mode === 'day') return viewRenderLabel('calendar.day', isZh)
  return String(mode)
}

export function calendarWeekdayShort(index: 0 | 1 | 2 | 3 | 4 | 5 | 6, isZh: boolean): string {
  const en = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const zh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return (isZh ? zh : en)[index] ?? String(index)
}

export function calendarMoreEvents(count: number, isZh: boolean): string {
  return isZh ? `+${count} 条更多` : `+${count} more`
}

export function calendarEventCount(count: number, isZh: boolean): string {
  if (isZh) return `${count} 个事件`
  return `${count} event${count === 1 ? '' : 's'}`
}

export function calendarCellAriaLabel(
  dateLabel: string,
  annotations: string[],
  eventCount: number,
  isZh: boolean,
): string {
  const parts = [
    dateLabel,
    ...annotations,
    eventCount > 0 ? calendarEventCount(eventCount, isZh) : null,
  ].filter((item): item is string => Boolean(item))
  return parts.join(isZh ? '，' : ', ')
}

export function openRecordCommentsAria(recordLabel: string, isZh: boolean): string {
  return isZh ? `打开 ${recordLabel} 的评论` : `Open comments for ${recordLabel}`
}

export function openFieldCommentsAria(fieldName: string, isZh: boolean): string {
  return isZh ? `打开 ${fieldName} 的评论` : `Open comments for ${fieldName}`
}

export function openFieldCommentsForRecordAria(fieldName: string, recordLabel: string, isZh: boolean): string {
  return isZh ? `打开 ${recordLabel} 中 ${fieldName} 的评论` : `Open comments for ${fieldName} on ${recordLabel}`
}

export function cardFieldsSummary(count: number, isZh: boolean): string {
  return isZh ? `卡片字段（${count}）` : `Card fields (${count})`
}

export function unscheduledCount(count: number, isZh: boolean): string {
  return isZh ? `未排期（${count}）` : `Unscheduled (${count})`
}

export function timelineLabelSummary(
  kind: 'auto' | 'custom' | 'field',
  fieldName: string | null,
  isZh: boolean,
): string {
  if (kind === 'field' && fieldName) return isZh ? `标签：${fieldName}` : `Label: ${fieldName}`
  if (kind === 'custom') return isZh ? '标签：自定义' : 'Label: custom'
  return isZh ? '标签：自动' : 'Label: auto'
}

export function timelineAutoUsesFieldHint(fieldName: string, isZh: boolean): string {
  return isZh ? `自动模式会优先使用 ${fieldName}。` : `Auto uses ${fieldName} when available.`
}

export function ganttResizeAria(edge: 'start' | 'end', taskLabel: string, isZh: boolean): string {
  if (edge === 'start') return isZh ? `调整 ${taskLabel} 的开始时间` : `Resize start for ${taskLabel}`
  return isZh ? `调整 ${taskLabel} 的结束时间` : `Resize end for ${taskLabel}`
}

// Event-time: generated names are persisted as dashboard data and should not
// retranslate after creation.
export function dashboardDefaultName(index: number, isZh: boolean): string {
  return isZh ? `仪表板 ${index}` : `Dashboard ${index}`
}
