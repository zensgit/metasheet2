// A1 「提示与实际状态」(Codex review reply 20261008 §四, memo R1) — pure copy module for the leave-type and
// overtime-rule 「需要审批」 option. NO fetch, NO DOM, NO Vue reactivity.
//
// Why this module exists. The option is STORED but NOT ENFORCED (all line numbers at base 9d65b8318f):
//   - plugins/plugin-attendance/index.cjs:39449-39467 (leave type create) and :39728-39745 (overtime rule
//     create) only write the column; the update routes (:39529-39554, :39801-39823) only write it again.
//   - The only other reads are the row mappers (:10580, :10595) and the metadata SNAPSHOT copied onto the
//     request (:33328, :33340). Nothing branches on it: a repo-wide grep of plugins/ and
//     packages/core-backend/src finds no other `requiresApproval` / `requires_approval` consumer.
//   - Every request-creating insert writes status 'pending' (e.g. executeGenericRequestCreate, :33846) and
//     there is no auto-approval path in the plugin, so unticking the box cannot skip approval.
// Implementing the option would equal auto-approval, which is a different behaviour change (candidate PR
// #6005), so this slice only tells the truth about the control. The checkbox, its default (true), the
// POST/PUT body and the table cell values are untouched.
//
// Copy is one `tr(en, zh)` pair per string (the attendance label convention: see attendanceContextHelp.ts).

export type TranslateFn = (en: string, zh: string) => string

export type AttendanceApprovalOptionKind = 'leave' | 'overtime'

export interface AttendanceApprovalOptionCopy {
  /** The short tag rendered next to the checkbox label. */
  badge: string
  /** The explanation rendered under the control. */
  hint: string
  /** The table header for the Yes/No column that shows the stored value. */
  columnHeader: string
}

export function attendanceApprovalOptionCopy(
  tr: TranslateFn,
  kind: AttendanceApprovalOptionKind,
): AttendanceApprovalOptionCopy {
  return {
    badge: tr('Not in effect yet', '暂不生效'),
    hint: kind === 'leave'
      ? tr(
        'Recorded only for now: it does not change how requests are submitted or approved. Whether it is ticked or not, requests of this leave type are still submitted as pending and wait for an approver; unticking it does not skip approval.',
        '目前只记录该选项，不改变申请的提交与审批：无论是否勾选，该请假类型的申请都仍以待审批状态提交，等待审批人处理；取消勾选不会免除审批。',
      )
      : tr(
        'Recorded only for now: it does not change how requests are submitted or approved. Whether it is ticked or not, requests under this overtime rule are still submitted as pending and wait for an approver; unticking it does not skip approval.',
        '目前只记录该选项，不改变申请的提交与审批：无论是否勾选，适用该加班规则的申请都仍以待审批状态提交，等待审批人处理；取消勾选不会免除审批。',
      ),
    columnHeader: tr('Approval (not in effect)', '审批(暂不生效)'),
  }
}

/**
 * The sentence appended to the save status when the option was saved UNTICKED - the only value an admin
 * can misread as "approval is now skipped". '' when ticked: the stored value then matches what happens.
 */
export function attendanceApprovalOptionSaveNotice(
  tr: TranslateFn,
  kind: AttendanceApprovalOptionKind,
  requiresApproval: boolean,
): string {
  if (requiresApproval) return ''
  return kind === 'leave'
    ? tr(
      'Note: the "Requires approval" option is not in effect yet; requests of this leave type still need approval.',
      '提示：「需要审批」选项暂不生效，该请假类型的申请仍需审批。',
    )
    : tr(
      'Note: the "Requires approval" option is not in effect yet; requests under this overtime rule still need approval.',
      '提示：「需要审批」选项暂不生效，适用该加班规则的申请仍需审批。',
    )
}

/** `baseMessage` plus the notice, separated by a single space; `baseMessage` alone when there is no notice. */
export function withApprovalOptionSaveNotice(
  tr: TranslateFn,
  kind: AttendanceApprovalOptionKind,
  requiresApproval: boolean,
  baseMessage: string,
): string {
  const notice = attendanceApprovalOptionSaveNotice(tr, kind, requiresApproval)
  return notice ? `${baseMessage} ${notice}` : baseMessage
}
