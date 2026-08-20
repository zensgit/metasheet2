/**
 * P5-C-1 — member-action dialog grammar (chrome-only unification).
 * Source: `docs/development/approval-parity-execution-ledger-20260817.md` (P5-C row),
 * `docs/development/approval-parity-master-design-lock-20260817.md` §4 UI-5, scout brief
 * "P5-C IMPLEMENTATION BRIEF" (2026-08-20).
 *
 * ### What this is
 *
 * A single source of truth for the per-verb COPY (dialog title, comment field label/placeholder/
 * row-count, confirm-button label, and the dialog-root `data-testid`) that the five member-action
 * dialogs in `ApprovalDetailView.vue` render — 转交 / 加签 / 减签 / 退回 / 评论. Every string below
 * is byte-identical to what already shipped; this is a de-duplication, not a rewrite (§1b of the
 * scout brief: C1 — dialog titles and confirm labels are literal test selectors in THREE
 * CI-required specs, so renaming any of them is explicitly OUT of this slice).
 *
 * The 通过/驳回 (approve/reject) dialog is deliberately NOT modeled here: its comment label/
 * placeholder/required-ness already derive from `effectiveCommentRequired` (Lock-5 §1.3 / gate
 * CR-3), a per-instance policy projection this module has no business re-deriving. Only its new
 * dialog-root testid is added directly in the view.
 *
 * ### Values-free (raw-id census, TIER B)
 *
 * This module lives under `src/approvals/` and is therefore in-scope for
 * `approval-member-identity-coverage-enumeration.spec.ts`'s mechanical pattern census. Every value
 * here is a static, values-free string — no id/key is ever interpolated into any of them.
 */

export type MemberActionVerb = 'transfer' | 'add_sign' | 'reduce_sign' | 'return' | 'comment'

export interface MemberActionDialogGrammar {
  /** The `<el-dialog>` `title` prop — also the `[data-el-dialog="…"]` test selector (C1, do not rename). */
  readonly dialogTitle: string
  /** The dialog's `data-testid` root marker (NEW, purely additive — no existing selector removed). */
  readonly dialogTestId: string
  /** `<el-form-item>` label for the comment textarea. */
  readonly commentLabel: string
  /** `<el-input>` placeholder for the comment textarea. */
  readonly commentPlaceholder: string
  /** `<el-input type="textarea">` `rows`. */
  readonly commentRows: number
  /** Confirm-button label (C1, do not rename). */
  readonly confirmLabel: string
}

export const MEMBER_ACTION_DIALOG_GRAMMAR: Readonly<Record<MemberActionVerb, MemberActionDialogGrammar>> = {
  transfer: {
    dialogTitle: '转交审批',
    dialogTestId: 'approval-transfer-dialog',
    commentLabel: '转交说明',
    commentPlaceholder: '请输入转交说明',
    commentRows: 2,
    confirmLabel: '确认转交',
  },
  add_sign: {
    dialogTitle: '加签',
    dialogTestId: 'approval-add-sign-dialog',
    commentLabel: '加签说明',
    commentPlaceholder: '请输入加签说明',
    commentRows: 2,
    confirmLabel: '确认加签',
  },
  reduce_sign: {
    dialogTitle: '减签',
    dialogTestId: 'approval-reduce-sign-dialog',
    commentLabel: '减签说明',
    commentPlaceholder: '请输入减签说明',
    commentRows: 2,
    confirmLabel: '确认减签',
  },
  return: {
    dialogTitle: '退回审批',
    dialogTestId: 'approval-return-dialog',
    commentLabel: '退回说明',
    commentPlaceholder: '请输入退回说明',
    commentRows: 2,
    confirmLabel: '确认退回',
  },
  comment: {
    dialogTitle: '添加评论',
    dialogTestId: 'approval-comment-dialog',
    commentLabel: '评论内容',
    commentPlaceholder: '请输入评论内容',
    commentRows: 3,
    confirmLabel: '提交评论',
  },
} as const

/** The approve/reject dialog's new root testid — kept alongside the verb table for one import site. */
export const ACTION_DIALOG_TEST_ID = 'approval-action-dialog'
