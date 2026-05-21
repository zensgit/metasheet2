import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_LABEL_KEYS,
  automationActionTypeLabel,
  automationConditionOperatorLabel,
  automationConditionValuePlaceholder,
  automationCronPresetLabel,
  automationLabel,
  automationStatusLabel,
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
})
