// Automation chrome string table (T3D).
//
// Scope: automation manager/editor/log/delivery UI. Rule names, field/view
// names, IDs, persisted enum values, backend/runtime errors, and redacted
// support-packet content stay raw.

import type {
  AutomationActionType,
  AutomationExecution,
  AutomationTriggerType,
  ConditionOperator,
} from '../types'

export type AutomationStatus = AutomationExecution['status'] | 'running'

// Keep in sync with MetaAutomationRuleEditor.vue ConditionValueWidget.
export type AutomationConditionValueWidget =
  | 'text'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'boolean'
  | 'booleanMultiSelect'
  | 'select'
  | 'multiSelect'

export type AutomationTriggerCondition = 'any' | 'equals' | 'changed_to'

export type AutomationCronPresetValue =
  | '*/5 * * * *'
  | '0 * * * *'
  | '0 0 * * *'
  | '0 0 * * 1'
  | 'custom'

export type AutomationCardLinkVariant = 'publicForm' | 'internalView'
export type AutomationCardStatType = 'ok' | 'fail'

export type AutomationLabelKey =
  | 'log.title'
  | 'log.total'
  | 'log.success'
  | 'log.failed'
  | 'log.avgDuration'
  | 'log.refresh'
  | 'log.errorPrefix'
  | 'log.retry'
  | 'log.loading'
  | 'log.empty'
  | 'support.copyPacket'
  | 'support.downloadJson'
  | 'support.clipboardUnavailable'
  | 'support.copied'
  | 'support.downloaded'
  | 'delivery.groupTitle'
  | 'delivery.personTitle'
  | 'delivery.loading'
  | 'delivery.emptyGroup'
  | 'delivery.emptyPerson'
  | 'delivery.inactiveUser'
  | 'delivery.dingtalkPrefix'
  | 'delivery.statusSkippedUnbound'
  | 'delivery.unboundReason'
  | 'editor.titleEdit'
  | 'editor.titleNew'
  | 'editor.name'
  | 'editor.namePlaceholder'
  | 'editor.value'
  | 'editor.save'
  | 'editor.saving'
  | 'editor.cancel'
  | 'editor.actions'
  | 'editor.actionStepHint'
  | 'editor.addField'
  | 'editor.addAction'
  | 'editor.moveUpTitle'
  | 'editor.moveDownTitle'
  | 'editor.removeActionTitle'
  | 'trigger.title'
  | 'trigger.watchField'
  | 'trigger.selectField'
  | 'trigger.condition'
  | 'trigger.preset'
  | 'trigger.cronExpression'
  | 'trigger.intervalMinutes'
  | 'condition.title'
  | 'condition.optional'
  | 'condition.and'
  | 'condition.or'
  | 'condition.group'
  | 'condition.addNestedCondition'
  | 'condition.addNestedGroup'
  | 'condition.removeGroupTitle'
  | 'condition.selectField'
  | 'condition.selectValue'
  | 'condition.addCondition'
  | 'condition.addGroup'
  | 'condition.removeConditionTitle'
  | 'actionConfig.targetSheetId'
  | 'actionConfig.sheetIdPlaceholder'
  | 'actionConfig.fieldIdPlaceholder'
  | 'actionConfig.url'
  | 'actionConfig.method'
  | 'actionConfig.userId'
  | 'actionConfig.message'
  | 'actionConfig.notificationMessagePlaceholder'
  | 'actionConfig.recipients'
  | 'actionConfig.emailRecipientsHint'
  | 'actionConfig.subjectTemplate'
  | 'actionConfig.emailSubjectPlaceholder'
  | 'actionConfig.bodyTemplate'
  | 'actionConfig.emailBodyPlaceholder'
  | 'actionConfig.lockRecord'
  | 'testRun.warning'
  | 'testRun.confirmSuffix'
  | 'testRun.unsavedHint'
  | 'testRun.button'
  | 'testRun.running'
  | 'manager.title'
  | 'manager.quickEditTitle'
  | 'manager.quickNewTitle'
  | 'manager.action'
  | 'manager.targetField'
  | 'manager.newValuePlaceholder'
  | 'manager.update'
  | 'manager.create'
  | 'manager.newAutomation'
  | 'manager.quickLegacyForm'
  | 'manager.loading'
  | 'manager.empty'
  | 'manager.enabled'
  | 'manager.disabled'
  | 'manager.allowedAudiencePrefix'
  | 'manager.statOk'
  | 'manager.statFail'
  | 'manager.edit'
  | 'manager.viewLogs'
  | 'manager.viewDeliveries'
  | 'manager.delete'
  | 'manager.cardPublicForm'
  | 'manager.cardInternalProcessing'
  | 'manager.cardOpenPublicForm'
  | 'manager.cardOpenInternalView'
  | 'manager.testRunning'
  | 'manager.testRunningDingTalkWarning'
  | 'manager.testRunAtLeastOneActionFailed'
  | 'error.loadGroupDeliveries'
  | 'error.loadPersonDeliveries'
  | 'error.loadRules'
  | 'error.createRule'
  | 'error.updateRule'
  | 'error.deleteRule'
  | 'error.saveFailed'
  | 'error.unknown'
  | 'status.all'
  | 'status.success'
  | 'status.failed'
  | 'status.skipped'
  | 'status.running'

export const AUTOMATION_LABEL_KEYS: readonly AutomationLabelKey[] = [
  'log.title',
  'log.total',
  'log.success',
  'log.failed',
  'log.avgDuration',
  'log.refresh',
  'log.errorPrefix',
  'log.retry',
  'log.loading',
  'log.empty',
  'support.copyPacket',
  'support.downloadJson',
  'support.clipboardUnavailable',
  'support.copied',
  'support.downloaded',
  'delivery.groupTitle',
  'delivery.personTitle',
  'delivery.loading',
  'delivery.emptyGroup',
  'delivery.emptyPerson',
  'delivery.inactiveUser',
  'delivery.dingtalkPrefix',
  'delivery.statusSkippedUnbound',
  'delivery.unboundReason',
  'editor.titleEdit',
  'editor.titleNew',
  'editor.name',
  'editor.namePlaceholder',
  'editor.value',
  'editor.save',
  'editor.saving',
  'editor.cancel',
  'editor.actions',
  'editor.actionStepHint',
  'editor.addField',
  'editor.addAction',
  'editor.moveUpTitle',
  'editor.moveDownTitle',
  'editor.removeActionTitle',
  'trigger.title',
  'trigger.watchField',
  'trigger.selectField',
  'trigger.condition',
  'trigger.preset',
  'trigger.cronExpression',
  'trigger.intervalMinutes',
  'condition.title',
  'condition.optional',
  'condition.and',
  'condition.or',
  'condition.group',
  'condition.addNestedCondition',
  'condition.addNestedGroup',
  'condition.removeGroupTitle',
  'condition.selectField',
  'condition.selectValue',
  'condition.addCondition',
  'condition.addGroup',
  'condition.removeConditionTitle',
  'actionConfig.targetSheetId',
  'actionConfig.sheetIdPlaceholder',
  'actionConfig.fieldIdPlaceholder',
  'actionConfig.url',
  'actionConfig.method',
  'actionConfig.userId',
  'actionConfig.message',
  'actionConfig.notificationMessagePlaceholder',
  'actionConfig.recipients',
  'actionConfig.emailRecipientsHint',
  'actionConfig.subjectTemplate',
  'actionConfig.emailSubjectPlaceholder',
  'actionConfig.bodyTemplate',
  'actionConfig.emailBodyPlaceholder',
  'actionConfig.lockRecord',
  'testRun.warning',
  'testRun.confirmSuffix',
  'testRun.unsavedHint',
  'testRun.button',
  'testRun.running',
  'manager.title',
  'manager.quickEditTitle',
  'manager.quickNewTitle',
  'manager.action',
  'manager.targetField',
  'manager.newValuePlaceholder',
  'manager.update',
  'manager.create',
  'manager.newAutomation',
  'manager.quickLegacyForm',
  'manager.loading',
  'manager.empty',
  'manager.enabled',
  'manager.disabled',
  'manager.allowedAudiencePrefix',
  'manager.statOk',
  'manager.statFail',
  'manager.edit',
  'manager.viewLogs',
  'manager.viewDeliveries',
  'manager.delete',
  'manager.cardPublicForm',
  'manager.cardInternalProcessing',
  'manager.cardOpenPublicForm',
  'manager.cardOpenInternalView',
  'manager.testRunning',
  'manager.testRunningDingTalkWarning',
  'manager.testRunAtLeastOneActionFailed',
  'error.loadGroupDeliveries',
  'error.loadPersonDeliveries',
  'error.loadRules',
  'error.createRule',
  'error.updateRule',
  'error.deleteRule',
  'error.saveFailed',
  'error.unknown',
  'status.all',
  'status.success',
  'status.failed',
  'status.skipped',
  'status.running',
]

const LABELS: Record<AutomationLabelKey, { en: string; zh: string }> = {
  'log.title': { en: 'Execution Logs', zh: '执行日志' },
  'log.total': { en: 'Total', zh: '总计' },
  'log.success': { en: 'Success', zh: '成功' },
  'log.failed': { en: 'Failed', zh: '失败' },
  'log.avgDuration': { en: 'Avg duration', zh: '平均耗时' },
  'log.refresh': { en: 'Refresh', zh: '刷新' },
  'log.errorPrefix': { en: 'Failed to load logs:', zh: '加载日志失败：' },
  'log.retry': { en: 'Retry', zh: '重试' },
  'log.loading': { en: 'Loading logs...', zh: '正在加载日志...' },
  'log.empty': { en: 'No execution logs found.', zh: '暂无执行日志。' },
  'support.copyPacket': { en: 'Copy redacted packet', zh: '复制脱敏包' },
  'support.downloadJson': { en: 'Download JSON', zh: '下载 JSON' },
  'support.clipboardUnavailable': { en: 'Clipboard unavailable', zh: '剪贴板不可用' },
  'support.copied': { en: 'Redacted packet copied.', zh: '已复制脱敏包。' },
  'support.downloaded': { en: 'Redacted JSON downloaded.', zh: '已下载脱敏 JSON。' },
  'delivery.groupTitle': { en: 'DingTalk Group Deliveries', zh: '钉钉群投递记录' },
  'delivery.personTitle': { en: 'DingTalk Person Deliveries', zh: '钉钉个人投递记录' },
  'delivery.loading': { en: 'Loading deliveries...', zh: '正在加载投递记录...' },
  'delivery.emptyGroup': { en: 'No DingTalk group deliveries found.', zh: '暂无钉钉群投递记录。' },
  'delivery.emptyPerson': { en: 'No DingTalk person deliveries found.', zh: '暂无钉钉个人投递记录。' },
  'delivery.inactiveUser': { en: 'Inactive user', zh: '已停用用户' },
  'delivery.dingtalkPrefix': { en: 'DingTalk', zh: '钉钉' },
  'delivery.statusSkippedUnbound': { en: 'Skipped / unbound', zh: '跳过 / 未绑定' },
  'delivery.unboundReason': { en: 'DingTalk account is not linked or user is inactive', zh: '钉钉账号未绑定或用户已停用' },
  'editor.titleEdit': { en: 'Edit Automation Rule', zh: '编辑自动化规则' },
  'editor.titleNew': { en: 'New Automation Rule', zh: '新建自动化规则' },
  'editor.name': { en: 'Name', zh: '名称' },
  'editor.namePlaceholder': { en: 'Automation name', zh: '自动化名称' },
  'editor.value': { en: 'Value', zh: '值' },
  'editor.save': { en: 'Save', zh: '保存' },
  'editor.saving': { en: 'Saving...', zh: '正在保存...' },
  'editor.cancel': { en: 'Cancel', zh: '取消' },
  'editor.actions': { en: 'Actions', zh: '动作' },
  'editor.actionStepHint': { en: '(1-3 steps)', zh: '（1-3 步）' },
  'editor.addField': { en: '+ Field', zh: '+ 字段' },
  'editor.addAction': { en: '+ Add action', zh: '+ 添加动作' },
  'editor.moveUpTitle': { en: 'Move up', zh: '上移' },
  'editor.moveDownTitle': { en: 'Move down', zh: '下移' },
  'editor.removeActionTitle': { en: 'Remove action', zh: '移除动作' },
  'trigger.title': { en: 'Trigger', zh: '触发器' },
  'trigger.watchField': { en: 'Watch field', zh: '监听字段' },
  'trigger.selectField': { en: '-- select field --', zh: '-- 选择字段 --' },
  'trigger.condition': { en: 'Condition', zh: '条件' },
  'trigger.preset': { en: 'Preset', zh: '预设' },
  'trigger.cronExpression': { en: 'Cron expression', zh: 'Cron 表达式' },
  'trigger.intervalMinutes': { en: 'Interval (minutes)', zh: '间隔（分钟）' },
  'condition.title': { en: 'Conditions', zh: '条件' },
  'condition.optional': { en: '(optional)', zh: '（可选）' },
  'condition.and': { en: 'AND', zh: '且' },
  'condition.or': { en: 'OR', zh: '或' },
  'condition.group': { en: 'Group', zh: '条件组' },
  'condition.addNestedCondition': { en: '+ Condition', zh: '+ 条件' },
  'condition.addNestedGroup': { en: '+ Group', zh: '+ 条件组' },
  'condition.removeGroupTitle': { en: 'Remove group', zh: '移除条件组' },
  'condition.selectField': { en: '-- field --', zh: '-- 字段 --' },
  'condition.selectValue': { en: '-- value --', zh: '-- 值 --' },
  'condition.addCondition': { en: '+ Add condition', zh: '+ 添加条件' },
  'condition.addGroup': { en: '+ Add group', zh: '+ 添加条件组' },
  'condition.removeConditionTitle': { en: 'Remove condition', zh: '移除条件' },
  'actionConfig.targetSheetId': { en: 'Target sheet ID', zh: '目标工作表 ID' },
  'actionConfig.sheetIdPlaceholder': { en: 'Sheet ID', zh: '工作表 ID' },
  'actionConfig.fieldIdPlaceholder': { en: 'Field ID', zh: '字段 ID' },
  'actionConfig.url': { en: 'URL', zh: 'URL' },
  'actionConfig.method': { en: 'Method', zh: '方法' },
  'actionConfig.userId': { en: 'User ID', zh: '用户 ID' },
  'actionConfig.message': { en: 'Message', zh: '消息' },
  'actionConfig.notificationMessagePlaceholder': { en: 'Notification message', zh: '通知内容' },
  'actionConfig.recipients': { en: 'Recipients', zh: '收件人' },
  'actionConfig.emailRecipientsHint': { en: 'Use comma or newline separated email addresses. Delivery uses the NotificationService email channel.', zh: '使用逗号或换行分隔邮箱地址。投递使用 NotificationService 邮件通道。' },
  'actionConfig.subjectTemplate': { en: 'Subject template', zh: '主题模板' },
  'actionConfig.emailSubjectPlaceholder': { en: '{{record.title}} needs attention', zh: '{{record.title}} 需要处理' },
  'actionConfig.bodyTemplate': { en: 'Body template', zh: '正文模板' },
  'actionConfig.emailBodyPlaceholder': { en: 'Record {{recordId}} changed. Status: {{record.status}}', zh: '记录 {{recordId}} 已变更。状态：{{record.status}}' },
  'actionConfig.lockRecord': { en: 'Lock record', zh: '锁定记录' },
  'testRun.warning': { en: 'Test Run executes the saved rule and can send real DingTalk messages to configured groups or users.', zh: '测试运行会执行已保存规则，并可能向已配置的钉钉群或用户发送真实消息。' },
  'testRun.confirmSuffix': { en: 'Unsaved changes are not included. Continue?', zh: '未保存的更改不会包含在内。是否继续？' },
  'testRun.unsavedHint': { en: 'Save this automation before running a test.', zh: '请先保存此自动化，再运行测试。' },
  'testRun.button': { en: 'Test Run', zh: '测试运行' },
  'testRun.running': { en: 'Running...', zh: '正在运行...' },
  'manager.title': { en: 'Automations', zh: '自动化' },
  'manager.quickEditTitle': { en: 'Edit Automation', zh: '编辑自动化' },
  'manager.quickNewTitle': { en: 'New Automation', zh: '新建自动化' },
  'manager.action': { en: 'Action', zh: '动作' },
  'manager.targetField': { en: 'Target field', zh: '目标字段' },
  'manager.newValuePlaceholder': { en: 'New value', zh: '新值' },
  'manager.update': { en: 'Update', zh: '更新' },
  'manager.create': { en: 'Create', zh: '创建' },
  'manager.newAutomation': { en: '+ New Automation', zh: '+ 新建自动化' },
  'manager.quickLegacyForm': { en: 'Quick legacy form', zh: '快速旧版表单' },
  'manager.loading': { en: 'Loading automations...', zh: '正在加载自动化...' },
  'manager.empty': { en: 'No automations yet. Create your first automation rule.', zh: '暂无自动化。创建第一条自动化规则。' },
  'manager.enabled': { en: 'Enabled', zh: '已启用' },
  'manager.disabled': { en: 'Disabled', zh: '已停用' },
  'manager.allowedAudiencePrefix': { en: 'Allowed audience:', zh: '允许范围：' },
  'manager.statOk': { en: 'ok', zh: '成功' },
  'manager.statFail': { en: 'fail', zh: '失败' },
  'manager.edit': { en: 'Edit', zh: '编辑' },
  'manager.viewLogs': { en: 'View Logs', zh: '查看日志' },
  'manager.viewDeliveries': { en: 'View Deliveries', zh: '查看投递记录' },
  'manager.delete': { en: 'Delete', zh: '删除' },
  'manager.cardPublicForm': { en: 'Public form', zh: '公开表单' },
  'manager.cardInternalProcessing': { en: 'Internal processing', zh: '内部处理' },
  'manager.cardOpenPublicForm': { en: 'Open public form', zh: '打开公开表单' },
  'manager.cardOpenInternalView': { en: 'Open internal view', zh: '打开内部处理视图' },
  'manager.testRunning': { en: 'Running test.', zh: '正在运行测试。' },
  'manager.testRunningDingTalkWarning': { en: 'Running test. DingTalk actions may send real messages.', zh: '正在运行测试。钉钉动作可能发送真实消息。' },
  'manager.testRunAtLeastOneActionFailed': { en: 'At least one action failed.', zh: '至少一个动作失败。' },
  'error.loadGroupDeliveries': { en: 'Failed to load DingTalk group deliveries.', zh: '加载钉钉群投递记录失败。' },
  'error.loadPersonDeliveries': { en: 'Failed to load DingTalk person deliveries.', zh: '加载钉钉个人投递记录失败。' },
  'error.loadRules': { en: 'Failed to load automation rules', zh: '加载自动化规则失败' },
  'error.createRule': { en: 'Failed to create automation rule', zh: '创建自动化规则失败' },
  'error.updateRule': { en: 'Failed to update automation rule', zh: '更新自动化规则失败' },
  'error.deleteRule': { en: 'Failed to delete automation rule', zh: '删除自动化规则失败' },
  'error.saveFailed': { en: 'Save failed', zh: '保存失败' },
  'error.unknown': { en: 'Unknown error', zh: '未知错误' },
  'status.all': { en: 'All statuses', zh: '全部状态' },
  'status.success': { en: 'success', zh: '成功' },
  'status.failed': { en: 'failed', zh: '失败' },
  'status.skipped': { en: 'skipped', zh: '跳过' },
  'status.running': { en: 'running', zh: '运行中' },
}

export function automationLabel(key: AutomationLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function automationStatusLabel(status: AutomationStatus | (string & {}), isZh: boolean): string {
  if (status === 'success') return automationLabel('status.success', isZh)
  if (status === 'failed') return automationLabel('status.failed', isZh)
  if (status === 'skipped') return automationLabel('status.skipped', isZh)
  if (status === 'running') return automationLabel('status.running', isZh)
  return String(status)
}

export function automationActionTypeLabel(type: AutomationActionType | (string & {}), isZh: boolean): string {
  switch (type) {
    case 'update_record':
      return isZh ? '更新记录' : 'Update record'
    case 'create_record':
      return isZh ? '创建记录' : 'Create record'
    case 'send_webhook':
      return isZh ? '发送 Webhook' : 'Send webhook'
    case 'send_notification':
    case 'notify':
      return isZh ? '发送通知' : 'Send notification'
    case 'send_email':
      return isZh ? '发送邮件' : 'Send email'
    case 'send_dingtalk_group_message':
      return isZh ? '发送钉钉群消息' : 'Send DingTalk group message'
    case 'send_dingtalk_person_message':
      return isZh ? '发送钉钉个人消息' : 'Send DingTalk person message'
    case 'lock_record':
      return isZh ? '锁定记录' : 'Lock record'
    case 'update_field':
      return isZh ? '更新字段值' : 'Update field value'
    default:
      return String(type)
  }
}

export function automationTriggerTypeLabel(type: AutomationTriggerType | (string & {}), isZh: boolean): string {
  switch (type) {
    case 'record.created':
      return isZh ? '当记录创建时' : 'When record created'
    case 'record.updated':
      return isZh ? '当记录更新时' : 'When record updated'
    case 'record.deleted':
      return isZh ? '当记录删除时' : 'When record deleted'
    case 'field.value_changed':
      return isZh ? '当字段值变化时' : 'When field value changed'
    case 'schedule.cron':
      return isZh ? '定时计划（cron）' : 'Schedule (cron)'
    case 'schedule.interval':
      return isZh ? '定时计划（间隔）' : 'Schedule (interval)'
    case 'webhook.received':
      return isZh ? '收到 Webhook 时' : 'Webhook received'
    case 'field.changed':
      return isZh ? '当字段变化时' : 'When field changed'
    default:
      return String(type)
  }
}

export function automationTriggerConditionLabel(condition: AutomationTriggerCondition | (string & {}), isZh: boolean): string {
  switch (condition) {
    case 'any':
      return isZh ? '任意变化' : 'Any change'
    case 'equals':
      return isZh ? '等于' : 'Equals'
    case 'changed_to':
      return isZh ? '变更为' : 'Changed to'
    default:
      return String(condition)
  }
}

export function automationCronPresetLabel(value: AutomationCronPresetValue | (string & {}), isZh: boolean): string {
  switch (value) {
    case '*/5 * * * *':
      return isZh ? '每 5 分钟' : 'Every 5 minutes'
    case '0 * * * *':
      return isZh ? '每小时' : 'Every hour'
    case '0 0 * * *':
      return isZh ? '每天午夜' : 'Daily at midnight'
    case '0 0 * * 1':
      return isZh ? '每周一' : 'Weekly (Monday)'
    case 'custom':
      return isZh ? '自定义' : 'Custom'
    default:
      return String(value)
  }
}

export function automationConditionOperatorLabel(operator: ConditionOperator | (string & {}), isZh: boolean): string {
  switch (operator) {
    case 'equals':
      return isZh ? '等于' : 'Equals'
    case 'not_equals':
      return isZh ? '不等于' : 'Not equals'
    case 'contains':
      return isZh ? '包含' : 'Contains'
    case 'not_contains':
      return isZh ? '不包含' : 'Not contains'
    case 'greater_than':
      return isZh ? '大于' : 'Greater than'
    case 'less_than':
      return isZh ? '小于' : 'Less than'
    case 'greater_or_equal':
      return isZh ? '大于等于' : 'Greater or equal'
    case 'less_or_equal':
      return isZh ? '小于等于' : 'Less or equal'
    case 'is_empty':
      return isZh ? '为空' : 'Is empty'
    case 'is_not_empty':
      return isZh ? '不为空' : 'Is not empty'
    case 'in':
      return isZh ? '在列表中' : 'In list'
    case 'not_in':
      return isZh ? '不在列表中' : 'Not in list'
    default:
      return String(operator)
  }
}

export function automationConditionValuePlaceholder(widget: AutomationConditionValueWidget, isArray: boolean, isZh: boolean): string {
  if (isArray) return isZh ? '逗号分隔的值' : 'Comma-separated values'
  if (widget === 'number') return isZh ? '数字' : 'Number'
  if (widget === 'date') return 'YYYY-MM-DD'
  if (widget === 'dateTime') return isZh ? '日期和时间' : 'Date and time'
  return isZh ? '值' : 'Value'
}

export function automationCardTriggerSummary(
  triggerType: AutomationTriggerType | (string & {}),
  fieldName: string,
  isZh: boolean,
): string {
  if (triggerType === 'field.changed' || triggerType === 'field.value_changed') {
    const rawField = fieldName.trim()
    if (!rawField) return isZh ? '当字段变化时' : 'When a field changes'
    return isZh ? `当“${rawField}”变化时` : `When "${rawField}" changes`
  }
  if (triggerType === 'record.created') return isZh ? '当记录创建时' : 'When a record is created'
  if (triggerType === 'record.updated') return isZh ? '当记录更新时' : 'When a record is updated'
  return automationTriggerTypeLabel(triggerType, isZh)
}

export function automationCardActionSummary(
  actionType: AutomationActionType | (string & {}),
  fieldName: string,
  isZh: boolean,
): string {
  if (actionType === 'update_field') {
    const rawField = fieldName.trim()
    if (!rawField) return automationActionTypeLabel(actionType, isZh)
    return isZh ? `更新“${rawField}”` : `Update "${rawField}"`
  }
  return automationActionTypeLabel(actionType, isZh)
}

export function automationCardLinkLabel(variant: AutomationCardLinkVariant, viewName: string, isZh: boolean): string {
  const key = variant === 'publicForm' ? 'manager.cardOpenPublicForm' : 'manager.cardOpenInternalView'
  return `${automationLabel(key, isZh)}${isZh ? '：' : ': '}${viewName}`
}

export function automationCardLinkSummary(variant: AutomationCardLinkVariant, viewName: string, isZh: boolean): string {
  const key = variant === 'publicForm' ? 'manager.cardPublicForm' : 'manager.cardInternalProcessing'
  return `${automationLabel(key, isZh)}${isZh ? '：' : ': '}${viewName}`
}

export function automationCardStats(count: number, status: AutomationCardStatType, isZh: boolean): string {
  const key = status === 'ok' ? 'manager.statOk' : 'manager.statFail'
  return `${count} ${automationLabel(key, isZh)}`
}

export function automationTestRunRequestFailed(message: string, isZh: boolean): string {
  const detail = message.trim() || automationLabel('error.unknown', isZh)
  return isZh ? `测试运行请求失败：${detail}` : `Test run request failed: ${detail}`
}

export function automationTestRunFailed(raw: string, isZh: boolean): string {
  const detail = raw.trim() || automationLabel('manager.testRunAtLeastOneActionFailed', isZh)
  return isZh ? `测试运行失败：${detail}` : `Test run failed: ${detail}`
}

export function automationTestRunSkipped(duration: string, isZh: boolean): string {
  return isZh ? `测试运行已跳过${duration}。` : `Test run skipped${duration}.`
}

export function automationTestRunSucceeded(duration: string, isZh: boolean): string {
  return isZh ? `测试运行成功${duration}。` : `Test run succeeded${duration}.`
}

export function supportCopyFailed(message: string, isZh: boolean): string {
  return isZh ? `复制失败：${message}` : `Copy failed: ${message}`
}

export function supportDownloadFailed(message: string, isZh: boolean): string {
  return isZh ? `下载失败：${message}` : `Download failed: ${message}`
}
