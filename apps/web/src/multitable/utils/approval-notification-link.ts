import type { MetaRecordSubscriptionNotification } from '../types'

/**
 * 催办站内通知的审批跳转。
 *
 * 服务端催办时写的站内通知不挂表、不挂记录（sheetId、recordId 都是空串），正文最后一行是审批详情的
 * 站内路径 `/approvals/<编码后的 id>`。这里只对这种形状的 `notification.sent` 行识别那一行：
 * 识别到就把它从显示文字里去掉，点击时跳到审批详情；审批详情自己做访问校验。
 * 挂了表或记录的通知（自动化规则、按钮发的）一律不识别，照旧处理。
 */
export interface ApprovalNotificationLink {
  /** 去掉路径行之后给人看的文字。 */
  text: string
  /** 审批详情的站内路径，形如 `/approvals/apv_1`。 */
  path: string
}

// 只认 `/approvals/` 加一段 encodeURIComponent 的输出：不含 `/`、`?`、`#`，所以只会落到审批详情路由。
const APPROVAL_PATH_LINE = /^\/approvals\/[A-Za-z0-9%._~!*'()-]+$/

type NotificationShape = Pick<MetaRecordSubscriptionNotification, 'eventType' | 'sheetId' | 'recordId' | 'message'>

export function parseApprovalNotificationLink(notification: NotificationShape): ApprovalNotificationLink | null {
  if (notification.eventType !== 'notification.sent') return null
  if ((notification.sheetId ?? '').trim() || (notification.recordId ?? '').trim()) return null
  const message = typeof notification.message === 'string' ? notification.message : ''
  const breakAt = message.lastIndexOf('\n')
  if (breakAt < 0) return null
  const lastLine = message.slice(breakAt + 1).trim()
  if (!APPROVAL_PATH_LINE.test(lastLine)) return null
  return { text: message.slice(0, breakAt).trim(), path: lastLine }
}
