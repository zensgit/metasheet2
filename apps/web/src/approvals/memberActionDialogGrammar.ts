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
 * dialogs in `ApprovalDetailView.vue` render — 转交 / 加签 / 减签 / 退回 / 评论. Every zh-CN string
 * below is byte-identical to what already shipped; this is a de-duplication, not a rewrite (§1b of
 * the scout brief: C1 — dialog titles and confirm labels are literal test selectors in THREE
 * CI-required specs, so renaming any of them is explicitly OUT of this slice).
 *
 * O-8 / F8-1 (approval member-surface locale): the copy now exists in two locales. The zh-CN table
 * keeps the shipped strings and the shipped `MEMBER_ACTION_DIALOG_GRAMMAR` export; the English
 * table sits beside it, and `memberActionDialogGrammar(isZh)` picks one from the shell locale.
 * `dialogTestId` / `commentRows` are locale-independent and defined once
 * (`MEMBER_ACTION_DIALOG_SHAPE`), so a selector can never drift between locales.
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

/** Locale-independent parts of each verb's grammar — defined ONCE, shared by both locales. */
const MEMBER_ACTION_DIALOG_SHAPE: Readonly<Record<MemberActionVerb, Pick<MemberActionDialogGrammar, 'dialogTestId' | 'commentRows'>>> = {
  transfer: { dialogTestId: 'approval-transfer-dialog', commentRows: 2 },
  add_sign: { dialogTestId: 'approval-add-sign-dialog', commentRows: 2 },
  reduce_sign: { dialogTestId: 'approval-reduce-sign-dialog', commentRows: 2 },
  return: { dialogTestId: 'approval-return-dialog', commentRows: 2 },
  comment: { dialogTestId: 'approval-comment-dialog', commentRows: 3 },
}

type MemberActionDialogCopy = Omit<MemberActionDialogGrammar, 'dialogTestId' | 'commentRows'>

/** zh-CN copy — byte-identical to what already shipped (the C1 selectors above). */
export const MEMBER_ACTION_DIALOG_COPY_ZH: Readonly<Record<MemberActionVerb, MemberActionDialogCopy>> = {
  transfer: { dialogTitle: '转交审批', commentLabel: '转交说明', commentPlaceholder: '请输入转交说明', confirmLabel: '确认转交' },
  add_sign: { dialogTitle: '加签', commentLabel: '加签说明', commentPlaceholder: '请输入加签说明', confirmLabel: '确认加签' },
  reduce_sign: { dialogTitle: '减签', commentLabel: '减签说明', commentPlaceholder: '请输入减签说明', confirmLabel: '确认减签' },
  return: { dialogTitle: '退回审批', commentLabel: '退回说明', commentPlaceholder: '请输入退回说明', confirmLabel: '确认退回' },
  comment: { dialogTitle: '添加评论', commentLabel: '评论内容', commentPlaceholder: '请输入评论内容', confirmLabel: '提交评论' },
}

/** English copy (O-8 / F8-1): same keys, same verbs; the shell locale picks between the two. */
export const MEMBER_ACTION_DIALOG_COPY_EN: Readonly<Record<MemberActionVerb, MemberActionDialogCopy>> = {
  transfer: { dialogTitle: 'Transfer approval', commentLabel: 'Transfer note', commentPlaceholder: 'Enter a transfer note', confirmLabel: 'Confirm transfer' },
  add_sign: { dialogTitle: 'Add approvers', commentLabel: 'Add-approver note', commentPlaceholder: 'Enter a note for the added approvers', confirmLabel: 'Confirm add' },
  reduce_sign: { dialogTitle: 'Remove approvers', commentLabel: 'Remove-approver note', commentPlaceholder: 'Enter a note for the removal', confirmLabel: 'Confirm removal' },
  return: { dialogTitle: 'Return approval', commentLabel: 'Return note', commentPlaceholder: 'Enter a return note', confirmLabel: 'Confirm return' },
  comment: { dialogTitle: 'Add comment', commentLabel: 'Comment', commentPlaceholder: 'Enter a comment', confirmLabel: 'Submit comment' },
}

function buildGrammar(copy: Readonly<Record<MemberActionVerb, MemberActionDialogCopy>>): Readonly<Record<MemberActionVerb, MemberActionDialogGrammar>> {
  const verbs = Object.keys(MEMBER_ACTION_DIALOG_SHAPE) as MemberActionVerb[]
  return Object.fromEntries(
    verbs.map((verb) => [verb, { ...copy[verb], ...MEMBER_ACTION_DIALOG_SHAPE[verb] }]),
  ) as Record<MemberActionVerb, MemberActionDialogGrammar>
}

/** zh-CN grammar table — the shipped export, same shape as before (specs import it directly). */
export const MEMBER_ACTION_DIALOG_GRAMMAR: Readonly<Record<MemberActionVerb, MemberActionDialogGrammar>> = buildGrammar(MEMBER_ACTION_DIALOG_COPY_ZH)

/** English grammar table — identical testids and row counts, English copy. */
export const MEMBER_ACTION_DIALOG_GRAMMAR_EN: Readonly<Record<MemberActionVerb, MemberActionDialogGrammar>> = buildGrammar(MEMBER_ACTION_DIALOG_COPY_EN)

/** The grammar table for the current shell locale (`useLocale().isZh`). */
export function memberActionDialogGrammar(isZh: boolean): Readonly<Record<MemberActionVerb, MemberActionDialogGrammar>> {
  return isZh ? MEMBER_ACTION_DIALOG_GRAMMAR : MEMBER_ACTION_DIALOG_GRAMMAR_EN
}

/** The approve/reject dialog's new root testid — kept alongside the verb table for one import site. */
export const ACTION_DIALOG_TEST_ID = 'approval-action-dialog'
