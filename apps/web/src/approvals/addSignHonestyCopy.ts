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
 * The wire contract is untouched and widen-only: the client keeps sending `addSignMode:'parallel'`,
 * and the SERVER still accepts `'before'` exactly as before, so no existing client breaks. Making
 * `'after'` reach the service (gate B-1) and giving it a runtime shape (B-3/B-4/B-5) are NOT in this
 * slice — see the PR body's deferral, which carries the reproduced `APPROVAL_NODE_ENTRY_EPOCH_MIXED`
 * blocker for OD-L5-4(b) at a multi-seat node.
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

/** The ONLY mode this client sends. The server's accepted set is unchanged (widen-only). */
export const CLIENT_ADD_SIGN_MODE = 'parallel' as const
