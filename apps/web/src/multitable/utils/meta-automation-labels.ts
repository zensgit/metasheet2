// Automation chrome string table (T3D).
//
// Scope: automation manager/editor/log/delivery UI. Rule names, field/view
// names, IDs, persisted enum values, backend/runtime errors, and redacted
// support-packet content stay raw.

import type { AutomationActionType, AutomationExecution } from '../types'

export type AutomationStatus = AutomationExecution['status'] | 'running'

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
  | 'error.loadGroupDeliveries'
  | 'error.loadPersonDeliveries'
  | 'error.unknown'
  | 'status.all'
  | 'status.success'
  | 'status.failed'
  | 'status.skipped'

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
  'error.loadGroupDeliveries',
  'error.loadPersonDeliveries',
  'error.unknown',
  'status.all',
  'status.success',
  'status.failed',
  'status.skipped',
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
  'error.loadGroupDeliveries': { en: 'Failed to load DingTalk group deliveries.', zh: '加载钉钉群投递记录失败。' },
  'error.loadPersonDeliveries': { en: 'Failed to load DingTalk person deliveries.', zh: '加载钉钉个人投递记录失败。' },
  'error.unknown': { en: 'Unknown error', zh: '未知错误' },
  'status.all': { en: 'All statuses', zh: '全部状态' },
  'status.success': { en: 'success', zh: '成功' },
  'status.failed': { en: 'failed', zh: '失败' },
  'status.skipped': { en: 'skipped', zh: '跳过' },
}

export function automationLabel(key: AutomationLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function automationStatusLabel(status: AutomationStatus | (string & {}), isZh: boolean): string {
  if (status === 'success') return automationLabel('status.success', isZh)
  if (status === 'failed') return automationLabel('status.failed', isZh)
  if (status === 'skipped') return automationLabel('status.skipped', isZh)
  if (status === 'running') return isZh ? '运行中' : 'running'
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

export function supportCopyFailed(message: string, isZh: boolean): string {
  return isZh ? `复制失败：${message}` : `Copy failed: ${message}`
}

export function supportDownloadFailed(message: string, isZh: boolean): string {
  return isZh ? `下载失败：${message}` : `Download failed: ${message}`
}
