/**
 * 催办成功后的提示文字。
 *
 * 服务端催办时给当前节点的用户席位写站内通知，响应里带 `notifiedUserCount`（写了几条）和
 * `skippedRoleSeatCount`（按角色指派、本轮不发通知的席位数）。老版本服务端不带这两个字段，
 * 这时退回各页面原来的提示文字。
 */
export interface RemindNotifyCounts {
  notifiedUserCount?: unknown
  skippedRoleSeatCount?: unknown
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function remindSuccessText(
  data: RemindNotifyCounts | null | undefined,
  fallback: string,
  isZh: boolean,
): string {
  const notified = readCount(data?.notifiedUserCount)
  const skippedRoleSeats = readCount(data?.skippedRoleSeatCount)
  if (notified === null) return fallback
  const head = notified > 0
    ? (isZh ? `已催办，已发站内通知给 ${notified} 人` : `Reminder sent; ${notified} ${notified === 1 ? 'person' : 'people'} notified in-app`)
    : fallback
  if (skippedRoleSeats && skippedRoleSeats > 0) {
    return isZh
      ? `${head}（按角色指派的处理人暂不发通知）`
      : `${head} (handlers assigned by role are not notified yet)`
  }
  return head
}
