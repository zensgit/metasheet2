import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_LABEL_KEYS,
  automationActionTypeLabel,
  automationCardActionSummary,
  automationCardLinkLabel,
  automationCardLinkSummary,
  automationCardStats,
  automationCardTriggerSummary,
  automationConditionOperatorLabel,
  automationConditionValuePlaceholder,
  automationCronPresetLabel,
  automationDingTalkAllowlistSummary,
  automationDingTalkDestinationScopeLabel,
  automationDingTalkDestinationSubtitle,
  automationDingTalkPersonAccessLabel,
  automationDingTalkPersonStatusLabel,
  automationDingTalkPersonSubjectLabel,
  automationDingTalkPresetLabel,
  automationDingTalkTemplateTokenLabel,
  automationLabel,
  automationStatusLabel,
  automationTestRunFailed,
  automationTestRunRequestFailed,
  automationTestRunSkipped,
  automationTestRunSucceeded,
  automationTriggerConditionLabel,
  automationTriggerTypeLabel,
  supportCopyFailed,
  supportDownloadFailed,
} from '../src/multitable/utils/meta-automation-labels'

describe('meta-automation-labels', () => {
  it('keeps the exported key list unique and fully readable in both locales', () => {
    expect(new Set(AUTOMATION_LABEL_KEYS).size).toBe(AUTOMATION_LABEL_KEYS.length)

    for (const key of AUTOMATION_LABEL_KEYS) {
      expect(automationLabel(key, false), key).toBeTruthy()
      expect(automationLabel(key, true), key).toBeTruthy()
    }
  })

  it('localizes automation statuses and preserves unknown status values raw', () => {
    expect(automationLabel('status.running', false)).toBe('running')
    expect(automationLabel('status.running', true)).toBe('运行中')
    expect(automationStatusLabel('success', false)).toBe('success')
    expect(automationStatusLabel('success', true)).toBe('成功')
    expect(automationStatusLabel('failed', true)).toBe('失败')
    expect(automationStatusLabel('skipped', true)).toBe('跳过')
    expect(automationStatusLabel('running', true)).toBe('运行中')
    expect(automationStatusLabel('custom_status', true)).toBe('custom_status')
  })

  it('localizes known action types and preserves unknown action types raw', () => {
    expect(automationActionTypeLabel('send_email', false)).toBe('Send email')
    expect(automationActionTypeLabel('send_email', true)).toBe('发送邮件')
    expect(automationActionTypeLabel('send_dingtalk_group_message', true)).toBe('发送钉钉群消息')
    expect(automationActionTypeLabel('notify', true)).toBe('发送通知')
    expect(automationActionTypeLabel('update_field', true)).toBe('更新字段值')
    expect(automationActionTypeLabel('future_action', true)).toBe('future_action')
  })

  it('localizes trigger types, trigger conditions, and cron presets with raw fallbacks', () => {
    expect(automationTriggerTypeLabel('record.created', false)).toBe('When record created')
    expect(automationTriggerTypeLabel('record.created', true)).toBe('当记录创建时')
    expect(automationTriggerTypeLabel('field.changed', true)).toBe('当字段变化时')
    expect(automationTriggerTypeLabel('future.trigger', true)).toBe('future.trigger')

    expect(automationTriggerConditionLabel('any', true)).toBe('任意变化')
    expect(automationTriggerConditionLabel('equals', true)).toBe('等于')
    expect(automationTriggerConditionLabel('changed_to', true)).toBe('变更为')
    expect(automationTriggerConditionLabel('future_condition', true)).toBe('future_condition')

    expect(automationCronPresetLabel('*/5 * * * *', true)).toBe('每 5 分钟')
    expect(automationCronPresetLabel('0 0 * * 1', true)).toBe('每周一')
    expect(automationCronPresetLabel('custom', true)).toBe('自定义')
    expect(automationCronPresetLabel('0 30 9 * *', true)).toBe('0 30 9 * *')
  })

  it('localizes condition operators and value placeholders with raw fallbacks', () => {
    expect(automationConditionOperatorLabel('equals', false)).toBe('Equals')
    expect(automationConditionOperatorLabel('equals', true)).toBe('等于')
    expect(automationConditionOperatorLabel('not_equals', true)).toBe('不等于')
    expect(automationConditionOperatorLabel('contains', true)).toBe('包含')
    expect(automationConditionOperatorLabel('not_contains', true)).toBe('不包含')
    expect(automationConditionOperatorLabel('greater_than', true)).toBe('大于')
    expect(automationConditionOperatorLabel('less_than', true)).toBe('小于')
    expect(automationConditionOperatorLabel('greater_or_equal', true)).toBe('大于等于')
    expect(automationConditionOperatorLabel('less_or_equal', true)).toBe('小于等于')
    expect(automationConditionOperatorLabel('is_empty', true)).toBe('为空')
    expect(automationConditionOperatorLabel('is_not_empty', true)).toBe('不为空')
    expect(automationConditionOperatorLabel('in', true)).toBe('在列表中')
    expect(automationConditionOperatorLabel('not_in', true)).toBe('不在列表中')
    expect(automationConditionOperatorLabel('future_operator', true)).toBe('future_operator')

    expect(automationConditionValuePlaceholder('text', false, false)).toBe('Value')
    expect(automationConditionValuePlaceholder('text', false, true)).toBe('值')
    expect(automationConditionValuePlaceholder('number', false, true)).toBe('数字')
    expect(automationConditionValuePlaceholder('date', false, true)).toBe('YYYY-MM-DD')
    expect(automationConditionValuePlaceholder('dateTime', false, true)).toBe('日期和时间')
    expect(automationConditionValuePlaceholder('boolean', true, true)).toBe('逗号分隔的值')
    expect(automationConditionValuePlaceholder('booleanMultiSelect', false, true)).toBe('值')
    expect(automationConditionValuePlaceholder('select', false, true)).toBe('值')
    expect(automationConditionValuePlaceholder('multiSelect', false, true)).toBe('值')
  })

  it('keeps support failure messages as localized chrome plus raw detail', () => {
    expect(supportCopyFailed('Network down', false)).toBe('Copy failed: Network down')
    expect(supportCopyFailed('Network down', true)).toBe('复制失败：Network down')
    expect(supportDownloadFailed('Disk full', false)).toBe('Download failed: Disk full')
    expect(supportDownloadFailed('Disk full', true)).toBe('下载失败：Disk full')
  })

  it('localizes manager card summaries while preserving raw field and view names', () => {
    expect(automationCardTriggerSummary('record.created', '', false)).toBe('When a record is created')
    expect(automationCardTriggerSummary('record.updated', '', true)).toBe('当记录更新时')
    expect(automationCardTriggerSummary('field.changed', '状态', false)).toBe('When "状态" changes')
    expect(automationCardTriggerSummary('field.changed', 'Status', true)).toBe('当“Status”变化时')
    expect(automationCardTriggerSummary('future.trigger', '', true)).toBe('future.trigger')

    expect(automationCardActionSummary('notify', '', true)).toBe('发送通知')
    expect(automationCardActionSummary('update_field', '状态', false)).toBe('Update "状态"')
    expect(automationCardActionSummary('update_field', 'Status', true)).toBe('更新“Status”')
    expect(automationCardActionSummary('future_action', '', true)).toBe('future_action')

    expect(automationCardLinkLabel('publicForm', '我的视图', false)).toBe('Open public form: 我的视图')
    expect(automationCardLinkLabel('internalView', 'Grid', true)).toBe('打开内部处理视图：Grid')
    expect(automationCardLinkSummary('publicForm', '我的视图', false)).toBe('Public form: 我的视图')
    expect(automationCardLinkSummary('internalView', 'Grid', true)).toBe('内部处理：Grid')

    expect(automationCardStats(1, 'ok', false)).toBe('1 ok')
    expect(automationCardStats(3, 'fail', true)).toBe('3 失败')
  })

  it('localizes manager test-run messages with raw details and empty fallbacks', () => {
    expect(automationTestRunRequestFailed('Automation service unavailable', false)).toBe('Test run request failed: Automation service unavailable')
    expect(automationTestRunRequestFailed('', false)).toBe('Test run request failed: Unknown error')
    expect(automationTestRunRequestFailed('服务异常', true)).toBe('测试运行请求失败：服务异常')
    expect(automationTestRunRequestFailed('', true)).toBe('测试运行请求失败：未知错误')

    expect(automationTestRunFailed('DingTalk robot keyword blocked', false)).toBe('Test run failed: DingTalk robot keyword blocked')
    expect(automationTestRunFailed('', false)).toBe('Test run failed: At least one action failed.')
    expect(automationTestRunFailed('钉钉机器人关键字拦截', true)).toBe('测试运行失败：钉钉机器人关键字拦截')
    expect(automationTestRunFailed('', true)).toBe('测试运行失败：至少一个动作失败。')

    expect(automationTestRunSucceeded(' (32 ms)', false)).toBe('Test run succeeded (32 ms).')
    expect(automationTestRunSucceeded('', true)).toBe('测试运行成功。')
    expect(automationTestRunSkipped(' (4 ms)', false)).toBe('Test run skipped (4 ms).')
    expect(automationTestRunSkipped('', true)).toBe('测试运行已跳过。')
  })

  it('localizes DingTalk shared chrome helpers with raw fallbacks', () => {
    expect(automationDingTalkPresetLabel('form_request', false)).toBe('Form request')
    expect(automationDingTalkPresetLabel('form_request', true)).toBe('表单填写')
    expect(automationDingTalkPresetLabel('internal_process', true)).toBe('内部处理')
    expect(automationDingTalkPresetLabel('form_and_process', false)).toBe('Form + processing')
    expect(automationDingTalkPresetLabel('future_preset', true)).toBe('future_preset')

    expect(automationDingTalkTemplateTokenLabel('recordId', true)).toBe('记录 ID')
    expect(automationDingTalkTemplateTokenLabel('recordField', false)).toBe('Record field')
    expect(automationDingTalkTemplateTokenLabel('futureToken', true)).toBe('futureToken')

    expect(automationDingTalkDestinationScopeLabel('org', true)).toBe('组织目录')
    expect(automationDingTalkDestinationScopeLabel('sheet', false)).toBe('This table')
    expect(automationDingTalkDestinationSubtitle('org', 'org_catalog', true)).toBe('组织目录：org_catalog')
    expect(automationDingTalkDestinationSubtitle('sheet', 'sheet_1', false)).toBe('sheet: sheet_1')

    expect(automationDingTalkPersonSubjectLabel('member-group', true)).toBe('成员组')
    expect(automationDingTalkPersonAccessLabel('read', false)).toBe('Access: read')
    expect(automationDingTalkPersonAccessLabel('write', true)).toBe('权限：write')
    expect(automationDingTalkPersonStatusLabel('memberGroupCheckedIndividually', false))
      .toBe('Member group members are checked individually for DingTalk delivery')
    expect(automationDingTalkPersonStatusLabel('noDeliveryLink', true))
      .toBe('无钉钉投递关联；关联前个人消息会跳过')
    expect(automationDingTalkPersonStatusLabel('deliveryReadyGrantEnabled', false))
      .toBe('DingTalk direct message ready; form authorization enabled')
    expect(automationDingTalkPersonStatusLabel('deliveryReadyGrantDisabled', true))
      .toBe('钉钉直接消息已就绪；表单授权未启用')
    expect(automationDingTalkPersonStatusLabel('notBound', false))
      .toBe('Not bound to DingTalk; person message may skip until linked')
    expect(automationDingTalkPersonStatusLabel('boundGrantEnabled', true))
      .toBe('已绑定钉钉；表单授权已启用')
    expect(automationDingTalkPersonStatusLabel('boundGrantDisabled', false))
      .toBe('DingTalk bound; form authorization not enabled')

    expect(automationDingTalkAllowlistSummary(0, 0, false)).toBe('')
    expect(automationDingTalkAllowlistSummary(1, 0, false)).toBe('1 local user')
    expect(automationDingTalkAllowlistSummary(2, 1, false)).toBe('2 local users and 1 local member group')
    expect(automationDingTalkAllowlistSummary(1, 2, true)).toBe('1 个本地用户和 2 个本地成员组')
  })
})
