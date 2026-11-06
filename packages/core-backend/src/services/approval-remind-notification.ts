/**
 * 催办 → 站内通知。
 *
 * 催办时给当前节点的处理人写一条站内通知（通知中心，`meta_record_subscription_notifications`，
 * 事件类型 `notification.sent`）。这张表本来按多维表的表 / 记录存通知，审批通知没有表也没有记录，
 * 所以 `sheet_id`、`record_id` 都写空串。通知中心按人取全部通知，不按表过滤；前端多维表客户端的规范化
 * 对 `notification.sent` 放行空 `sheet_id`（其他事件类型仍要求非空），所以这种行会在铃铛里列出。
 *
 * 跳转：通知行没有存审批 id 的列。不加列的做法是把审批详情的站内路径作为消息的最后一行写进去
 * （`/approvals/<编码后的 id>`），前端通知中心只对「表、记录都为空」的 `notification.sent` 行识别
 * 这一行，点击时跳到审批详情；审批详情自己做访问校验。
 *
 * 只放元数据：催办人、审批标题、审批编号，不带任何表单值。
 */

export const APPROVAL_REMIND_NOTIFICATION_SHEET_ID = ''
export const APPROVAL_REMIND_NOTIFICATION_RECORD_ID = ''

const TITLE_MAX_LENGTH = 120

export interface ApprovalRemindNotificationInput {
  instanceId: string
  title: string | null | undefined
  requestNo: string | null | undefined
  actorName: string | null | undefined
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

/** 审批详情的站内路径，与前端路由 `/approvals/:id` 一致。 */
export function approvalDetailPath(instanceId: string): string {
  return `/approvals/${encodeURIComponent(instanceId)}`
}

/**
 * 催办通知正文：第一行是给人看的文字，第二行是审批详情路径。
 * 例：「【催办】张三 提醒你处理审批「请假申请」（编号 AP-001）」
 */
export function buildApprovalRemindNotificationMessage(input: ApprovalRemindNotificationInput): string {
  const actor = normalizeText(input.actorName) || '有人'
  const title = truncate(normalizeText(input.title), TITLE_MAX_LENGTH) || '（无标题）'
  const requestNo = normalizeText(input.requestNo)
  const numberPart = requestNo ? `（编号 ${requestNo}）` : ''
  return `【催办】${actor} 提醒你处理审批「${title}」${numberPart}\n${approvalDetailPath(input.instanceId)}`
}
