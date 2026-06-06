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
  WorkflowJobStatus,
} from '../types'

// Legacy execution/step statuses (success/failed/skipped) + the converged C1
// WorkflowJobStatus set surfaced by the A2 runs API (resolved/queued/suspended/…).
export type AutomationStatus = AutomationExecution['status'] | WorkflowJobStatus

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
export type AutomationDingTalkPreset = 'form_request' | 'internal_process' | 'form_and_process'
export type AutomationDingTalkTemplateTokenKey = 'recordId' | 'sheetId' | 'actorId' | 'recordField'
export type AutomationDingTalkDestinationScope = 'private' | 'sheet' | 'org'
export type AutomationDingTalkPersonSubject = 'user' | 'member-group'
export type AutomationDingTalkPersonStatus =
  | 'memberGroupCheckedIndividually'
  | 'noDeliveryLink'
  | 'deliveryReadyGrantEnabled'
  | 'deliveryReadyGrantDisabled'
  | 'notBound'
  | 'boundGrantEnabled'
  | 'boundGrantDisabled'

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
  | 'editor.executionModeLabel'
  | 'editor.executionModeHint'
  | 'editor.executionModeRequiredHint'
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
  | 'actionConfig.waitForCallbackHint'
  | 'conditionBranch.readOnly'
  | 'conditionBranch.hint'
  | 'conditionBranch.key'
  | 'conditionBranch.label'
  | 'conditionBranch.value'
  | 'conditionBranch.userIds'
  | 'conditionBranch.message'
  | 'conditionBranch.addField'
  | 'conditionBranch.addAction'
  | 'conditionBranch.addBranch'
  | 'conditionBranch.default'
  | 'conditionBranch.addDefault'
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
  | 'dingtalk.preset'
  | 'dingtalk.addGroups'
  | 'dingtalk.addGroupOption'
  | 'dingtalk.groupsRegisteredHint'
  | 'dingtalk.noGroupsAvailable'
  | 'dingtalk.remove'
  | 'dingtalk.recordGroupFieldPaths'
  | 'dingtalk.recordGroupFieldPathHint'
  | 'dingtalk.pickGroupField'
  | 'dingtalk.pickFieldOption'
  | 'dingtalk.searchUsersOrGroups'
  | 'dingtalk.searchUsersOrGroupsPlaceholder'
  | 'dingtalk.searchingUsersOrGroups'
  | 'dingtalk.noMatchingUsersOrGroups'
  | 'dingtalk.inactiveUsersCannotBeAdded'
  | 'dingtalk.localUserIds'
  | 'dingtalk.localUserIdsPlaceholder'
  | 'dingtalk.memberGroupIds'
  | 'dingtalk.memberGroupIdsPlaceholder'
  | 'dingtalk.recordRecipientFieldPaths'
  | 'dingtalk.recordRecipientFieldPathPlaceholder'
  | 'dingtalk.pickRecipientField'
  | 'dingtalk.chooseUserFieldOption'
  | 'dingtalk.recordRecipientFieldPathHint'
  | 'dingtalk.recordMemberGroupFieldPaths'
  | 'dingtalk.recordMemberGroupFieldPathPlaceholder'
  | 'dingtalk.pickMemberGroupField'
  | 'dingtalk.chooseMemberGroupFieldOption'
  | 'dingtalk.recordMemberGroupFieldPathHint'
  | 'dingtalk.titleTemplate'
  | 'dingtalk.titleTemplatePlaceholder'
  | 'dingtalk.bodyTemplate'
  | 'dingtalk.bodyTemplatePlaceholder'
  | 'dingtalk.templateTokens'
  | 'dingtalk.publicFormView'
  | 'dingtalk.noPublicFormLinkOption'
  | 'dingtalk.internalProcessingView'
  | 'dingtalk.noInternalLinkOption'
  | 'dingtalk.noInternalLink'
  | 'dingtalk.messageSummary'
  | 'dingtalk.groups'
  | 'dingtalk.recordGroups'
  | 'dingtalk.recipients'
  | 'dingtalk.recordRecipients'
  | 'dingtalk.recordMemberGroups'
  | 'dingtalk.noGroupsSelected'
  | 'dingtalk.noRecipientsSelected'
  | 'dingtalk.noDynamicGroupField'
  | 'dingtalk.noDynamicRecipientField'
  | 'dingtalk.noDynamicMemberGroupField'
  | 'dingtalk.renderedTitle'
  | 'dingtalk.renderedBody'
  | 'dingtalk.noTitleTemplate'
  | 'dingtalk.noBodyTemplate'
  | 'dingtalk.noRenderedTitle'
  | 'dingtalk.noRenderedBody'
  | 'dingtalk.copy'
  | 'dingtalk.copied'
  | 'dingtalk.publicForm'
  | 'dingtalk.publicFormAccess'
  | 'dingtalk.allowedAudience'
  | 'dingtalk.internalProcessing'
  | 'dingtalk.noPublicFormLink'
  | 'dingtalk.allowedAudienceUnavailable'
  | 'dingtalk.viewUnavailable'
  | 'dingtalk.selectedViewNotForm'
  | 'dingtalk.publicFormNotConfigured'
  | 'dingtalk.publicFormDisabled'
  | 'dingtalk.publicFormMissingToken'
  | 'dingtalk.publicFormExpired'
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
  | 'status.resolved'
  | 'status.queued'
  | 'status.suspended'
  | 'status.rejected'
  | 'status.errored'
  | 'runs.title'
  | 'runs.subtitle'
  | 'runs.adminOnly'
  | 'runs.sheetFilter'
  | 'runs.triggerEvent'
  | 'runs.ruleSnapshot'
  | 'runs.steps'
  | 'runs.branchStep'
  | 'runs.selectedBranch'
  | 'runs.branchNoMatch'
  | 'runs.loadingDetail'
  | 'runs.resume'
  | 'runs.resumeConfirm'
  | 'runs.resumeError.notFound'
  | 'runs.resumeError.alreadyResumed'
  | 'runs.resumeError.ruleChanged'
  | 'runs.resumeError.ruleMissingOrDisabled'
  | 'runs.resumeError.recordGone'
  | 'runs.resumeError.generic'

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
  'editor.executionModeLabel',
  'editor.executionModeHint',
  'editor.executionModeRequiredHint',
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
  'actionConfig.waitForCallbackHint',
  'conditionBranch.readOnly',
  'conditionBranch.hint',
  'conditionBranch.key',
  'conditionBranch.label',
  'conditionBranch.value',
  'conditionBranch.userIds',
  'conditionBranch.message',
  'conditionBranch.addField',
  'conditionBranch.addAction',
  'conditionBranch.addBranch',
  'conditionBranch.default',
  'conditionBranch.addDefault',
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
  'dingtalk.preset',
  'dingtalk.addGroups',
  'dingtalk.addGroupOption',
  'dingtalk.groupsRegisteredHint',
  'dingtalk.noGroupsAvailable',
  'dingtalk.remove',
  'dingtalk.recordGroupFieldPaths',
  'dingtalk.recordGroupFieldPathHint',
  'dingtalk.pickGroupField',
  'dingtalk.pickFieldOption',
  'dingtalk.searchUsersOrGroups',
  'dingtalk.searchUsersOrGroupsPlaceholder',
  'dingtalk.searchingUsersOrGroups',
  'dingtalk.noMatchingUsersOrGroups',
  'dingtalk.inactiveUsersCannotBeAdded',
  'dingtalk.localUserIds',
  'dingtalk.localUserIdsPlaceholder',
  'dingtalk.memberGroupIds',
  'dingtalk.memberGroupIdsPlaceholder',
  'dingtalk.recordRecipientFieldPaths',
  'dingtalk.recordRecipientFieldPathPlaceholder',
  'dingtalk.pickRecipientField',
  'dingtalk.chooseUserFieldOption',
  'dingtalk.recordRecipientFieldPathHint',
  'dingtalk.recordMemberGroupFieldPaths',
  'dingtalk.recordMemberGroupFieldPathPlaceholder',
  'dingtalk.pickMemberGroupField',
  'dingtalk.chooseMemberGroupFieldOption',
  'dingtalk.recordMemberGroupFieldPathHint',
  'dingtalk.titleTemplate',
  'dingtalk.titleTemplatePlaceholder',
  'dingtalk.bodyTemplate',
  'dingtalk.bodyTemplatePlaceholder',
  'dingtalk.templateTokens',
  'dingtalk.publicFormView',
  'dingtalk.noPublicFormLinkOption',
  'dingtalk.internalProcessingView',
  'dingtalk.noInternalLinkOption',
  'dingtalk.noInternalLink',
  'dingtalk.messageSummary',
  'dingtalk.groups',
  'dingtalk.recordGroups',
  'dingtalk.recipients',
  'dingtalk.recordRecipients',
  'dingtalk.recordMemberGroups',
  'dingtalk.noGroupsSelected',
  'dingtalk.noRecipientsSelected',
  'dingtalk.noDynamicGroupField',
  'dingtalk.noDynamicRecipientField',
  'dingtalk.noDynamicMemberGroupField',
  'dingtalk.renderedTitle',
  'dingtalk.renderedBody',
  'dingtalk.noTitleTemplate',
  'dingtalk.noBodyTemplate',
  'dingtalk.noRenderedTitle',
  'dingtalk.noRenderedBody',
  'dingtalk.copy',
  'dingtalk.copied',
  'dingtalk.publicForm',
  'dingtalk.publicFormAccess',
  'dingtalk.allowedAudience',
  'dingtalk.internalProcessing',
  'dingtalk.noPublicFormLink',
  'dingtalk.allowedAudienceUnavailable',
  'dingtalk.viewUnavailable',
  'dingtalk.selectedViewNotForm',
  'dingtalk.publicFormNotConfigured',
  'dingtalk.publicFormDisabled',
  'dingtalk.publicFormMissingToken',
  'dingtalk.publicFormExpired',
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
  'status.resolved',
  'status.queued',
  'status.suspended',
  'status.rejected',
  'status.errored',
  'runs.title',
  'runs.subtitle',
  'runs.adminOnly',
  'runs.sheetFilter',
  'runs.triggerEvent',
  'runs.ruleSnapshot',
  'runs.steps',
  'runs.branchStep',
  'runs.selectedBranch',
  'runs.branchNoMatch',
  'runs.loadingDetail',
  'runs.resume',
  'runs.resumeConfirm',
  'runs.resumeError.notFound',
  'runs.resumeError.alreadyResumed',
  'runs.resumeError.ruleChanged',
  'runs.resumeError.ruleMissingOrDisabled',
  'runs.resumeError.recordGone',
  'runs.resumeError.generic',
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
  'editor.executionModeLabel': {
    en: 'Persist a per-action run record (advanced)',
    zh: '持久化每步运行记录（高级）',
  },
  'editor.executionModeHint': {
    en: 'When on, each action run for this rule is saved as a durable WorkflowJob record. Leave off for the default lightweight log.',
    zh: '开启后，本规则每个动作的运行都会保存为持久的 WorkflowJob 记录；关闭则使用默认的轻量日志。',
  },
  'editor.executionModeRequiredHint': {
    en: 'Required and locked on: this rule has an action that requires durable WorkflowJob records (wait for callback or condition branch).',
    zh: '已强制开启并锁定：本规则包含需要持久 WorkflowJob 记录的动作（等待回调或条件分支），无法关闭。',
  },
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
  'actionConfig.waitForCallbackHint': {
    en: 'Suspends the run until an admin resumes it from the runs view. No parameters in v1 (no external webhook/timer).',
    zh: '挂起执行，直到管理员在运行视图中手动恢复。v1 无参数（暂无外部 webhook/定时器）。',
  },
  'conditionBranch.readOnly': {
    en: 'This branch rule uses constructs not editable in this version — read-only (save is disabled to avoid flattening it).',
    zh: '该分支规则包含本版本不可编辑的结构 —— 只读（已禁用保存以避免压扁丢失）。',
  },
  'conditionBranch.hint': {
    en: 'Run different action chains by condition: exactly one matching branch (or the default) runs. Branch actions are limited to update-record / send-notification in v1.',
    zh: '按条件走不同动作链：仅命中其一分支（或默认分支）执行。v1 分支内动作限更新记录 / 发送通知。',
  },
  'conditionBranch.key': { en: 'Branch key', zh: '分支 key' },
  'conditionBranch.label': { en: 'Label (optional)', zh: '标签（可选）' },
  'conditionBranch.value': { en: 'Value', zh: '值' },
  'conditionBranch.userIds': { en: 'User IDs (comma-separated)', zh: '用户 ID（逗号分隔）' },
  'conditionBranch.message': { en: 'Message', zh: '消息' },
  'conditionBranch.addField': { en: '+ Field', zh: '+ 字段' },
  'conditionBranch.addAction': { en: '+ Action', zh: '+ 动作' },
  'conditionBranch.addBranch': { en: '+ Branch', zh: '+ 分支' },
  'conditionBranch.default': { en: 'Default branch (no condition)', zh: '默认分支（无条件）' },
  'conditionBranch.addDefault': { en: '+ Default branch', zh: '+ 默认分支' },
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
  'dingtalk.preset': { en: 'Message preset', zh: '消息预设' },
  'dingtalk.addGroups': { en: 'Add DingTalk groups', zh: '添加钉钉群' },
  'dingtalk.addGroupOption': { en: '-- add DingTalk group --', zh: '-- 添加钉钉群 --' },
  'dingtalk.groupsRegisteredHint': { en: 'DingTalk groups registered for this table or shared from the organization catalog are listed here.', zh: '此处列出为本表注册或从组织目录共享的钉钉群。' },
  'dingtalk.noGroupsAvailable': { en: 'No DingTalk groups are available for this table yet. Add one in API Tokens & Webhooks > DingTalk Groups, ask an admin to share an organization catalog group, or use a record group field path below.', zh: '此表暂无可用钉钉群。请在 API Token 与 Webhook > 钉钉群中添加，或让管理员共享组织目录群，也可使用下方记录群字段路径。' },
  'dingtalk.remove': { en: 'Remove', zh: '移除' },
  'dingtalk.recordGroupFieldPaths': { en: 'Record group field paths (optional)', zh: '记录群字段路径（可选）' },
  'dingtalk.recordGroupFieldPathHint': { en: 'Use record fields whose value is a DingTalk group destination ID, not a local user, member group, or DingTalk group name.', zh: '使用值为钉钉群目标 ID 的记录字段，不要使用本地用户、成员组或钉钉群名称。' },
  'dingtalk.pickGroupField': { en: 'Pick group field', zh: '选择群字段' },
  'dingtalk.pickFieldOption': { en: '-- pick field --', zh: '-- 选择字段 --' },
  'dingtalk.searchUsersOrGroups': { en: 'Search and add users or member groups', zh: '搜索并添加用户或成员组' },
  'dingtalk.searchUsersOrGroupsPlaceholder': { en: 'Search by user, member group, email, or subject ID', zh: '按用户、成员组、邮箱或主体 ID 搜索' },
  'dingtalk.searchingUsersOrGroups': { en: 'Searching users and member groups...', zh: '正在搜索用户和成员组...' },
  'dingtalk.noMatchingUsersOrGroups': { en: 'No matching users or member groups', zh: '没有匹配的用户或成员组' },
  'dingtalk.inactiveUsersCannotBeAdded': { en: 'Inactive users cannot be added', zh: '不能添加已停用用户' },
  'dingtalk.localUserIds': { en: 'Local user IDs', zh: '本地用户 ID' },
  'dingtalk.localUserIdsPlaceholder': { en: 'Use comma or newline separated local user IDs', zh: '使用逗号或换行分隔本地 userId' },
  'dingtalk.memberGroupIds': { en: 'Member group IDs (optional)', zh: '成员组 ID（可选）' },
  'dingtalk.memberGroupIdsPlaceholder': { en: 'Use comma or newline separated member group IDs', zh: '使用逗号或换行分隔成员组 ID' },
  'dingtalk.recordRecipientFieldPaths': { en: 'Record recipient field paths (optional)', zh: '记录收件人字段路径（可选）' },
  'dingtalk.recordRecipientFieldPathPlaceholder': { en: 'Example: record.assigneeUserIds, record.reviewerUserId', zh: '例如：record.assigneeUserIds, record.reviewerUserId' },
  'dingtalk.pickRecipientField': { en: 'Pick recipient field', zh: '选择收件人字段' },
  'dingtalk.chooseUserFieldOption': { en: '-- choose a user field --', zh: '-- 选择用户字段 --' },
  'dingtalk.recordRecipientFieldPathHint': { en: 'Record data is keyed by field ID. Use comma or newline separated record.<fieldId> paths. The picker only lists user fields.', zh: '记录数据以字段 ID 为键。请使用逗号或换行分隔的 record.<fieldId> 路径。选择器仅列出用户字段。' },
  'dingtalk.recordMemberGroupFieldPaths': { en: 'Record member group field paths (optional)', zh: '记录成员组字段路径（可选）' },
  'dingtalk.recordMemberGroupFieldPathPlaceholder': { en: 'Example: record.watcherGroupIds, record.escalationGroupId', zh: '例如：record.watcherGroupIds, record.escalationGroupId' },
  'dingtalk.pickMemberGroupField': { en: 'Pick member group field', zh: '选择成员组字段' },
  'dingtalk.chooseMemberGroupFieldOption': { en: '-- choose a member group field --', zh: '-- 选择成员组字段 --' },
  'dingtalk.recordMemberGroupFieldPathHint': { en: 'Use comma or newline separated record.<fieldId> paths whose values resolve to member group IDs. The picker only lists explicit member group fields.', zh: '使用逗号或换行分隔的 record.<fieldId> 路径，字段值应解析为成员组 ID。选择器仅列出显式成员组字段。' },
  'dingtalk.titleTemplate': { en: 'Title template', zh: '标题模板' },
  'dingtalk.titleTemplatePlaceholder': { en: 'Example: {{record.title}} needs attention', zh: '例如：{{record.title}} 待处理' },
  'dingtalk.bodyTemplate': { en: 'Body template', zh: '正文模板' },
  'dingtalk.bodyTemplatePlaceholder': { en: 'Supports {{record.xxx}}, {{recordId}}, {{sheetId}}, and {{actorId}}', zh: '支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}' },
  'dingtalk.templateTokens': { en: 'Template tokens', zh: '模板令牌' },
  'dingtalk.publicFormView': { en: 'Public form view (optional)', zh: '公开表单视图（可选）' },
  'dingtalk.noPublicFormLinkOption': { en: '-- no public form link --', zh: '-- 无公开表单链接 --' },
  'dingtalk.internalProcessingView': { en: 'Internal processing view (optional)', zh: '内部处理视图（可选）' },
  'dingtalk.noInternalLinkOption': { en: '-- no internal link --', zh: '-- 无内部链接 --' },
  'dingtalk.noInternalLink': { en: 'No internal link', zh: '无内部链接' },
  'dingtalk.messageSummary': { en: 'Message summary', zh: '消息摘要' },
  'dingtalk.groups': { en: 'Groups', zh: '群' },
  'dingtalk.recordGroups': { en: 'Record groups', zh: '记录群' },
  'dingtalk.recipients': { en: 'Recipients', zh: '收件人' },
  'dingtalk.recordRecipients': { en: 'Record recipients', zh: '记录收件人' },
  'dingtalk.recordMemberGroups': { en: 'Record member groups', zh: '记录成员组' },
  'dingtalk.noGroupsSelected': { en: 'No groups selected', zh: '未选择群' },
  'dingtalk.noRecipientsSelected': { en: 'No recipients selected', zh: '未选择收件人' },
  'dingtalk.noDynamicGroupField': { en: 'No dynamic group field', zh: '无动态群字段' },
  'dingtalk.noDynamicRecipientField': { en: 'No dynamic recipient field', zh: '无动态收件人字段' },
  'dingtalk.noDynamicMemberGroupField': { en: 'No dynamic member group field', zh: '无动态成员组字段' },
  'dingtalk.renderedTitle': { en: 'Rendered title', zh: '渲染标题' },
  'dingtalk.renderedBody': { en: 'Rendered body', zh: '渲染正文' },
  'dingtalk.noTitleTemplate': { en: 'No title template', zh: '无标题模板' },
  'dingtalk.noBodyTemplate': { en: 'No body template', zh: '无正文模板' },
  'dingtalk.noRenderedTitle': { en: 'No rendered title', zh: '无渲染标题' },
  'dingtalk.noRenderedBody': { en: 'No rendered body', zh: '无渲染正文' },
  'dingtalk.copy': { en: 'Copy', zh: '复制' },
  'dingtalk.copied': { en: 'Copied', zh: '已复制' },
  'dingtalk.publicForm': { en: 'Public form', zh: '公开表单' },
  'dingtalk.publicFormAccess': { en: 'Public form access', zh: '公开表单访问' },
  'dingtalk.allowedAudience': { en: 'Allowed audience', zh: '允许范围' },
  'dingtalk.internalProcessing': { en: 'Internal processing', zh: '内部处理' },
  'dingtalk.noPublicFormLink': { en: 'No public form link', zh: '无公开表单链接' },
  'dingtalk.allowedAudienceUnavailable': { en: 'Allowed audience unavailable', zh: '允许范围不可用' },
  'dingtalk.viewUnavailable': { en: 'View unavailable in this sheet', zh: '此表中不可用的视图' },
  'dingtalk.selectedViewNotForm': { en: 'Selected view is not a form', zh: '所选视图不是表单视图' },
  'dingtalk.publicFormNotConfigured': { en: 'Public form sharing is not configured', zh: '未配置公开表单分享' },
  'dingtalk.publicFormDisabled': { en: 'Public form sharing is disabled', zh: '公开表单分享已停用' },
  'dingtalk.publicFormMissingToken': { en: 'Public form sharing is missing a public token', zh: '公开表单分享缺少公开令牌' },
  'dingtalk.publicFormExpired': { en: 'Public form sharing has expired', zh: '公开表单分享已过期' },
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
  'status.resolved': { en: 'resolved', zh: '已完成' },
  'status.queued': { en: 'queued', zh: '排队中' },
  'status.suspended': { en: 'suspended', zh: '已挂起' },
  'status.rejected': { en: 'rejected', zh: '已拒绝' },
  'status.errored': { en: 'errored', zh: '异常' },
  'runs.title': { en: 'Automation Runs', zh: '自动化运行记录' },
  'runs.subtitle': { en: 'Cross-sheet · admin only · read-only', zh: '跨表 · 仅管理员 · 只读' },
  'runs.adminOnly': { en: 'Admin access required', zh: '需要管理员权限' },
  'runs.sheetFilter': { en: 'Sheet ID', zh: '表 ID' },
  'runs.triggerEvent': { en: 'Trigger event', zh: '触发事件' },
  'runs.ruleSnapshot': { en: 'Rule snapshot', zh: '规则快照' },
  'runs.steps': { en: 'Steps', zh: '步骤' },
  'runs.branchStep': { en: 'branch', zh: '分支' },
  'runs.selectedBranch': { en: 'Selected branch:', zh: '命中分支：' },
  'runs.branchNoMatch': { en: 'No branch matched (no default)', zh: '无分支命中（无默认分支）' },
  'runs.loadingDetail': { en: 'Loading detail…', zh: '加载详情…' },
  'runs.resume': { en: 'Resume', zh: '恢复执行' },
  'runs.resumeConfirm': {
    en: 'Resume this run? It continues the remaining actions and may cause external side effects.',
    zh: '恢复这条执行？将继续执行剩余动作，可能产生外部副作用。',
  },
  'runs.resumeError.notFound': { en: 'Resume token not found.', zh: '恢复令牌不存在。' },
  'runs.resumeError.alreadyResumed': { en: 'This run was already resumed.', zh: '该执行已被恢复。' },
  'runs.resumeError.ruleChanged': { en: 'The rule changed since it was suspended; cannot resume safely.', zh: '规则在挂起后已变更，无法安全恢复。' },
  'runs.resumeError.ruleMissingOrDisabled': { en: 'The rule is missing or disabled; cannot resume.', zh: '规则缺失或已停用，无法恢复。' },
  'runs.resumeError.recordGone': { en: 'The record no longer exists; cannot resume.', zh: '记录已不存在，无法恢复。' },
  'runs.resumeError.generic': { en: 'Resume failed.', zh: '恢复失败。' },
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
  if (status === 'resolved') return automationLabel('status.resolved', isZh)
  if (status === 'queued') return automationLabel('status.queued', isZh)
  if (status === 'suspended') return automationLabel('status.suspended', isZh)
  if (status === 'rejected') return automationLabel('status.rejected', isZh)
  if (status === 'errored') return automationLabel('status.errored', isZh)
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
    case 'wait_for_callback':
      return isZh ? '等待回调（挂起）' : 'Wait for callback (suspend)'
    case 'condition_branch':
      return isZh ? '条件分支' : 'Condition branch'
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

export function automationDingTalkPresetLabel(preset: AutomationDingTalkPreset | (string & {}), isZh: boolean): string {
  switch (preset) {
    case 'form_request':
      return isZh ? '表单填写' : 'Form request'
    case 'internal_process':
      return automationLabel('dingtalk.internalProcessing', isZh)
    case 'form_and_process':
      return isZh ? '表单 + 处理' : 'Form + processing'
    default:
      return String(preset)
  }
}

export function automationDingTalkTemplateTokenLabel(token: AutomationDingTalkTemplateTokenKey | (string & {}), isZh: boolean): string {
  switch (token) {
    case 'recordId':
      return isZh ? '记录 ID' : 'Record ID'
    case 'sheetId':
      return isZh ? '表 ID' : 'Sheet ID'
    case 'actorId':
      return isZh ? '触发人 ID' : 'Actor ID'
    case 'recordField':
      return isZh ? '记录字段' : 'Record field'
    default:
      return String(token)
  }
}

export function automationDingTalkDestinationScopeLabel(scope: AutomationDingTalkDestinationScope | (string & {}), isZh: boolean): string {
  switch (scope) {
    case 'org':
      return isZh ? '组织目录' : 'Organization catalog'
    case 'sheet':
      return isZh ? '本表' : 'This table'
    case 'private':
      return isZh ? '私有' : 'Private'
    default:
      return String(scope)
  }
}

export function automationDingTalkDestinationSubtitle(scope: AutomationDingTalkDestinationScope, id: string, isZh: boolean): string {
  if (scope === 'org') {
    if (!id) return isZh ? '组织目录' : 'organization catalog'
    return isZh ? `组织目录：${id}` : `organization catalog: ${id}`
  }
  if (scope === 'sheet') {
    if (!id) return isZh ? '本表' : 'this table'
    return isZh ? `表：${id}` : `sheet: ${id}`
  }
  return isZh ? '私有' : 'private'
}

export function automationDingTalkPersonSubjectLabel(subject: AutomationDingTalkPersonSubject | (string & {}), isZh: boolean): string {
  switch (subject) {
    case 'member-group':
      return isZh ? '成员组' : 'Member group'
    case 'user':
      return isZh ? '用户' : 'User'
    default:
      return String(subject)
  }
}

export function automationDingTalkPersonAccessLabel(accessLevel: string, isZh: boolean): string {
  return accessLevel ? `${isZh ? '权限：' : 'Access: '}${accessLevel}` : ''
}

export function automationDingTalkPersonStatusLabel(status: AutomationDingTalkPersonStatus | (string & {}), isZh: boolean): string {
  switch (status) {
    case 'memberGroupCheckedIndividually':
      return isZh ? '成员组成员会逐个检查钉钉投递条件' : 'Member group members are checked individually for DingTalk delivery'
    case 'noDeliveryLink':
      return isZh ? '无钉钉投递关联；关联前个人消息会跳过' : 'No DingTalk delivery link; person message will skip until linked'
    case 'deliveryReadyGrantEnabled':
      return isZh ? '钉钉直接消息已就绪；表单授权已启用' : 'DingTalk direct message ready; form authorization enabled'
    case 'deliveryReadyGrantDisabled':
      return isZh ? '钉钉直接消息已就绪；表单授权未启用' : 'DingTalk direct message ready; form authorization not enabled'
    case 'notBound':
      return isZh ? '未绑定钉钉；关联前个人消息可能跳过' : 'Not bound to DingTalk; person message may skip until linked'
    case 'boundGrantEnabled':
      return isZh ? '已绑定钉钉；表单授权已启用' : 'DingTalk bound; form authorization enabled'
    case 'boundGrantDisabled':
      return isZh ? '已绑定钉钉；表单授权未启用' : 'DingTalk bound; form authorization not enabled'
    default:
      return String(status)
  }
}

export function automationDingTalkAllowlistSummary(userCount: number, memberGroupCount: number, isZh: boolean): string {
  const users = Math.max(0, userCount)
  const groups = Math.max(0, memberGroupCount)
  if (users === 0 && groups === 0) return ''
  if (isZh) {
    const parts: string[] = []
    if (users > 0) parts.push(`${users} 个本地用户`)
    if (groups > 0) parts.push(`${groups} 个本地成员组`)
    return parts.join('和 ')
  }
  const parts: string[] = []
  if (users > 0) parts.push(`${users} ${users === 1 ? 'local user' : 'local users'}`)
  if (groups > 0) parts.push(`${groups} ${groups === 1 ? 'local member group' : 'local member groups'}`)
  return parts.join(' and ')
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
