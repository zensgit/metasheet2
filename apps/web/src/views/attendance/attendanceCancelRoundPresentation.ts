import type { CancelRoundCancellationOutcome } from '../../approvals/cancelRound'
import { formatLeaveBalanceMinutes, type WorkspaceTranslateFn } from './attendanceEmployeeWorkspacePresentation'

/**
 * 请假撤销 —— 撤销兑现后的余额结果行(撤销锁抬头「RATIFY 追记」P-3)。
 *
 * - The numbers are MINUTES (the summary read's contract); they are rendered with the employee
 *   workspace's existing `formatLeaveBalanceMinutes` (owner 「Reuse leave-balance formatter
 *   (Recommended)」), never a second duration dialect.
 * - Three outcome statuses stay three: `cancelled_reversal_unreported` — and a round with no
 *   outcome at all — says 「could not be read」 and NEVER renders as 「returned 0」.
 */
export function cancelRoundResultLines(
  outcome: CancelRoundCancellationOutcome | null,
  tr: WorkspaceTranslateFn,
): string[] {
  if (!outcome || outcome.status === 'cancelled_reversal_unreported' || !outcome.reversal) {
    return [
      tr(
        'The returned leave balance could not be read — please ask an administrator to check your balance.',
        '返还结果暂未能读取,请联系管理员核对余额',
      ),
    ]
  }
  const { reversed, lots, unrecoverableExpired, alreadyReversed } = outcome.reversal
  const returned = formatLeaveBalanceMinutes(reversed, tr)
  const lines: string[] = []
  if (outcome.status === 'cancelled_with_unrecoverable_expired') {
    const expired = formatLeaveBalanceMinutes(unrecoverableExpired, tr)
    lines.push(tr(
      `Returned ${returned} this time; another ${expired} could not be returned because that balance has expired.`,
      `本次已返还 ${returned};另有 ${expired} 因额度已过期未能返还`,
    ))
  } else {
    lines.push(tr(
      `Returned ${returned} this time (${lots} balance lot${lots === 1 ? '' : 's'}).`,
      `本次已返还 ${returned}(共 ${lots} 个批次)`,
    ))
  }
  if (alreadyReversed) {
    lines.push(tr(
      'This balance had already been returned earlier; it was not returned twice.',
      '此前已返还过,本次未重复返还',
    ))
  }
  return lines
}
