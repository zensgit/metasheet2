/**
 * Lock-5 gate B-2 — `'before'` honesty.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §0 C-3/C-5, §0.1
 * (the `add_sign` row), gate B-2, master M8.
 *
 * ### The shipped defect this retires
 *
 * The member dialog shipped a `加签方式` radio with two arms, `并加签` (`'parallel'`) and `前加签`
 * (`'before'`). Per corpus C-3, 前加签 means "insert an approval node BEFORE the current one and
 * return to it when that node passes". **We implement no such thing.** §0.1 states it plainly:
 * `'before'` is *"audit-metadata only… The builder takes no mode argument and both modes insert
 * co-signer seats at the CURRENT node in the SAME epoch, so outside a parallel region `'before'`
 * and `'parallel'` are byte-identical runtime behavior"* — while the FE shipped a radio implying a
 * choice. That is a lying control (M8), and the lie is in the LABEL: the user is told they are
 * inserting a preceding node.
 *
 * ### Why the arm is REMOVED rather than relabelled
 *
 * B-2 requires that "the FE label no longer claims an unimplemented semantic". Relabelling cannot
 * satisfy that here, because there is no honest label for a SECOND option that does exactly what
 * the first one does: outside a parallel region the two arms are byte-identical (pinned by a
 * real-DB test in this same slice), and inside one they differ only in that `'before'` 409s. A
 * radio whose arms are indistinguishable is a fake switch — retiring the arm is the only shape
 * that leaves the surface honest. What remains is the ONE add-sign semantic we actually implement,
 * which corpus C-5 (并加签) describes and which the lock's own C-5 row marks as MATCHING shipped
 * behavior.
 *
 * ### What is deliberately NOT changed
 *
 * The wire contract is widen-only: `'parallel'` stays the default this client sends, and the SERVER
 * still accepts `'before'` exactly as before, so no existing client breaks.
 *
 * ### F4-S1 — 后加签 (`'after'`) lands, and its copy must be as honest as the retired radio was not
 *
 * OD-L5-4(b) (RATIFIED, `approval-lock5-node-operation-policy-20260817.md:311-322`, recorded
 * `:348-349`) ships after-sign as **a deferred same-node round**: the actor's seat is consumed as an
 * approval, the addees activate as a fresh round AT THE SAME NODE, and the node advances when that
 * round completes. The lock's own constraint: *"Under (b) … no copy may claim corpus 后加签 semantics
 * (当前节点自动通过并流转至新增节点): the node is not skipped."* Owner disposition (1) on the
 * ledger's four-completions row (2026-10-01) adds the refusal arm: when the actor's approval does not
 * complete the current round (undecided 会签 siblings / threshold still short), the server refuses
 * with `APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE` and nothing is written. Every string below states
 * exactly that, in both languages, so a locale switch cannot reintroduce the claim: the corpus
 * phrase appears only NEGATED (「也不是…」 / "this is not …"), and 前加签 does not appear at all.
 */

/**
 * Replaces the retired `加签方式` radio. States what add-sign actually does, in the corpus's own
 * 并加签 vocabulary (C-5): the addees join the CURRENT node, and the node's existing 会签/或签
 * aggregation governs completion — no node is inserted and nothing is skipped.
 *
 * Exported as a constant (not inlined in the template) so a spec can pin the exact string, and so
 * a future slice that lands real 前加签/后加签 semantics has one place to change. Mirrors the
 * `fieldPermissionHonestyCopy.ts` precedent.
 */
export const ADD_SIGN_MODE_HINT =
  '加签人将加入当前审批节点，由该节点原有的会签/或签规则决定何时通过；不会插入新的审批节点，也不会跳过当前节点。'

/** The DEFAULT mode this client sends; the dialog may switch it to `'after'` (F4-S1). */
export const CLIENT_ADD_SIGN_MODE = 'parallel' as const

/** The two placements the dialog offers. `'before'` is not offered: it is `'parallel'` mislabelled (B-2). */
export type ClientAddSignPlacement = 'parallel' | 'after'

/** The appended round's aggregation, asked only for 后加签 with two or more addees (OD-L5-5(a)). */
export type ClientAddSignAggregation = 'all' | 'any'

/**
 * F4-S1 — the honest copy for the 加签方式 choice, in both languages. Each string is a statement of
 * what the server DOES (OD-L5-4(b) + owner disposition (1)), never of what the corpus feature is
 * called. Bilingual by construction so the O-8 / F8-1 locale wiring only has to pick a key.
 */
export const ADD_SIGN_PLACEMENT_COPY = {
  zh: {
    fieldLabel: '加签方式',
    parallelLabel: '并加签',
    parallelHint: ADD_SIGN_MODE_HINT,
    afterLabel: '后加签',
    afterHint:
      '你的这一票按同意处理；加签人将在同一节点上开始新一轮审批，该轮通过后流程才继续。不会插入新的审批节点，也不是「当前节点自动通过并流转到新增节点」。若你的同意还不能完成本轮（多人会签还有人未表态、门槛未达），后加签不可用；可在其他审批人表态后再用，或改用并加签。',
    aggregationLabel: '加签人审批方式',
    aggregationAll: '会签（全部同意）',
    aggregationAny: '或签（任一同意）',
    aggregationHint: '两人及以上后加签时必选；只约束加签人这一轮。',
  },
  en: {
    fieldLabel: 'Add-sign placement',
    parallelLabel: 'Alongside me',
    parallelHint:
      'Added approvers join the current approval node, and that node\'s existing all-approve / any-approve rule decides when it passes. No new approval node is inserted and the current node is not skipped.',
    afterLabel: 'After me',
    afterHint:
      'Your seat is counted as an approval; the added approvers then start a new round at this SAME node, and the flow continues only when that round passes. No new approval node is inserted, and this is not "auto-pass the current node and move to an inserted one". If your approval would not complete the current round (others still to decide in an all-approve round, a threshold not yet met), after-sign is unavailable — use it once the others have decided, or add alongside instead.',
    aggregationLabel: 'How the added approvers decide',
    aggregationAll: 'All must approve',
    aggregationAny: 'Any one approves',
    aggregationHint: 'Required when adding two or more approvers after you; it governs only their round.',
  },
} as const

/**
 * The server's refusal when the actor's approval would not complete the current round (owner
 * disposition (1)). Deliberately contains no 请重试: it is not transient — the other seats of the
 * round have to decide first — and the dialog stays open so the member can switch to 并加签.
 */
export const ADD_SIGN_AFTER_ROUND_INCOMPLETE_CODE = 'APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE'
export const ADD_SIGN_AFTER_ROUND_INCOMPLETE_MESSAGE = {
  zh: '本节点还有其他审批人尚未表态，你的同意还不能完成本轮，暂不能后加签；可在其他审批人表态后再后加签，或改用并加签。',
  en: 'Other approvers at this node have not decided yet, so your approval would not complete the current round and after-sign is unavailable. You can after-sign once they have decided, or add the approver alongside you instead.',
} as const
