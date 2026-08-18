/**
 * Lock-5 §2.3 / gate A-2 (residual-harm repair) — honest member-action failure copy.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §2.3, §2.4;
 * adversarial-gate finding P2-3 on PR #4980.
 *
 * ### The shipped defect this retires
 *
 * The four deferred-verb handlers in `ApprovalDetailView.vue` (转交 / 加签 / 减签 / 退回) each caught
 * with a BARE `catch {`, discarding the server's code AND message, and rendered a fixed
 * `…失败，请重试` toast while leaving the dialog OPEN. Contrast `submitAction` (approve/reject),
 * which binds the error and renders the server text inline.
 *
 * With Lock-5's per-node policy live, that becomes routine rather than an edge case: unchecking
 * 允许转交 in the 操作权限 tab makes 转交 fail for EVERY approver at that node, EVERY time — and the
 * copy tells them to retry an operation that is permanently refused. Worse, the choke has no dedup
 * by design (each attempt IS a distinct denial), so every retry mints another `policy_denied` audit
 * row that gate D-3 then hides from the member timeline: invisible audit growth driven by copy that
 * invited the click.
 *
 * ### What this module does
 *
 * Classifies a member-action failure so the caller can (a) say something TRUE and (b) stop inviting
 * a retry that cannot succeed. It does NOT decide whether the action was allowed — the server did
 * that, and the 409 is the authority. This is presentation over an already-decided outcome.
 *
 * ### Values-free (§2.4)
 *
 * The denial copy is a fixed string. It never interpolates the node key, the actor, the target, or
 * the server's `details` — the member already knows which button they pressed, and the lock caps
 * what may cross the wire at `{ nodeKey, operation }` precisely so clients are not tempted to render
 * it. For any OTHER code the server's own message is surfaced verbatim, which is the behavior
 * `submitAction` already ships and which the lock's X-1 discipline keeps values-free at the source.
 */

/** The 409 the §2.1 dispatch choke raises for a policy-forbidden member operation. */
export const NODE_OPERATION_DISABLED_CODE = 'APPROVAL_NODE_OPERATION_DISABLED'

/**
 * Honest copy for a policy denial. Deliberately contains NO 请重试: the operation is disabled by the
 * template's configuration, so retrying cannot help and asking for it manufactures audit noise.
 */
export const NODE_OPERATION_DISABLED_MESSAGE = '该节点已关闭此操作，请联系管理员调整审批模板的操作权限。'

export interface MemberActionFailure {
  /** What to show the member. */
  message: string
  /**
   * True when the server refused because the node's operation policy forbids the verb. The caller
   * closes the dialog on this — a permanently refused action must not keep a retry affordance open.
   */
  isPolicyDenial: boolean
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Classify a failed member action.
 *
 * `fallback` is the caller's existing generic copy, used only when the error carries neither a
 * recognised code nor a message — so a non-`Error` throw never renders a blank toast.
 */
export function memberActionFailure(error: unknown, fallback: string): MemberActionFailure {
  if (errorCode(error) === NODE_OPERATION_DISABLED_CODE) {
    return { message: NODE_OPERATION_DISABLED_MESSAGE, isPolicyDenial: true }
  }
  const message = error instanceof Error && error.message ? error.message : fallback
  return { message, isPolicyDenial: false }
}
