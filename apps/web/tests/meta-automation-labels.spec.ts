import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_LABEL_KEYS,
  automationActionTypeLabel,
  automationLabel,
  automationStatusLabel,
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

  it('keeps support failure messages as localized chrome plus raw detail', () => {
    expect(supportCopyFailed('Network down', false)).toBe('Copy failed: Network down')
    expect(supportCopyFailed('Network down', true)).toBe('复制失败：Network down')
    expect(supportDownloadFailed('Disk full', false)).toBe('Download failed: Disk full')
    expect(supportDownloadFailed('Disk full', true)).toBe('下载失败：Disk full')
  })
})
