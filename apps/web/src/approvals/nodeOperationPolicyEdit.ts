import type { ApprovalOperationPolicyCapability } from './approvalCapabilityRegistry'
import type { NodeCommentRequired, NodeOperationPolicy } from '../types/approval'
import { NODE_COMMENT_REQUIRED_VALUES } from '../types/approval'

/**
 * Lock-5 §1.1 L5-A / OD-L5-2(a) — the pure projection between the persisted `nodeOperationPolicy`
 * object and the `操作权限` tab's checkboxes.
 *
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §1.1, OD-L5-2(a),
 * gates A-6 and A-7.
 *
 * Three contract facts this module exists to make testable in isolation (no component mount):
 *
 *  1. **ABSENT ≡ ALLOWED (OD-L5-3(a)).** A checked box means "allowed", which is the absent state,
 *     so checking a box DELETES its key rather than writing `true`. That is what makes gate A-6's
 *     emptiness half hold — "authoring all-default switches leaves the persisted config
 *     byte-identical (no `nodeOperationPolicy` key at all)" — while "setting one switch to `false`
 *     DOES change the bytes". A template that already persists an explicit `allowTransfer: true`
 *     (writable through the publish API) is normalized to absent the first time the author toggles
 *     that control; absent and `true` are the SAME semantic, so this is a normalization, not a drop.
 *
 *  2. **One checkbox may own SEVERAL keys.** Corpus C-2 evidences ONE 允许加/减签 admin switch hiding
 *     BOTH member buttons, so `add_reduce_sign` writes `allowAddSign` AND `allowReduceSign`
 *     together. Two independent checkboxes would widen beyond the corpus (OD-L5-2(c), rejected);
 *     one key for both verbs could not express a persisted MIXED state (OD-L5-2(b), rejected).
 *
 *  3. **A persisted MIXED state renders READ-ONLY and round-trips unchanged (A-7).** A graph
 *     written by an API caller can legitimately carry `allowAddSign:true, allowReduceSign:false` —
 *     a state the single checkbox cannot represent. Rather than silently picking an arm (which
 *     would flip the other verb's enforcement without the author asking), the control reports
 *     `mixed`, renders disabled with honest copy, and `applyOperationPolicyControl` is never called
 *     for it — so the bytes survive. This is the Lock-4 OD-L4-6 projection pattern.
 *
 * Every mutation is NON-DESTRUCTIVE to sibling fields: `returnReviewMode` / `commentRequired` (and
 * any other switch) present on the persisted object survive every toggle (A-7's third clause).
 */

/** The rendered state of ONE `操作权限` checkbox. */
export type OperationPolicyControlState =
  /** Every key this control owns agrees. `allowed` is what the checkbox shows. */
  | { kind: 'editable'; allowed: boolean }
  /** The keys this control owns DISAGREE — unrepresentable by one checkbox (A-7). */
  | { kind: 'mixed' }

/** Honest copy for the `mixed` state (M8: the label must not claim the control is authoring
 *  something it is not). Exported so the spec pins the exact string rather than a paraphrase. */
export const OPERATION_POLICY_MIXED_HINT =
  '该表单对加签与减签设置了不同的开关，当前编辑器无法表达这种组合，已锁定为只读（保存不会改动它）。'

/**
 * Lock-5 §1.1 (A-4) honest scope copy. An instance pins its own frozen `published_definition_id`,
 * so changing a switch reaches ONLY instances created after the next publish — in-flight approvals
 * keep the policy they were created under. Saying so is required, not decorative: without it an
 * administrator reads the checkbox as immediate (§1.1: "the authoring copy must say so").
 */
export const OPERATION_POLICY_SCOPE_HINT =
  '操作权限在发布后生效，且只作用于此后新发起的审批；已在流转中的审批仍沿用其发起时的设置。'

function keyAllowed(policy: NodeOperationPolicy | undefined, key: keyof NodeOperationPolicy): boolean {
  // OD-L5-3(a): absent ≡ allowed. Only an explicit `false` denies — the same predicate the server
  // choke uses (`gatedPolicy?.[key] === false`), so the two doors cannot drift apart on the default.
  return policy?.[key] !== false
}

/**
 * Project the persisted policy onto ONE control's state. `mixed` only when the control owns more
 * than one key and those keys disagree.
 */
export function operationPolicyControlState(
  policy: NodeOperationPolicy | undefined,
  capability: Pick<ApprovalOperationPolicyCapability, 'policyKeys'>,
): OperationPolicyControlState {
  const values = capability.policyKeys.map((key) => keyAllowed(policy, key))
  const first = values[0] ?? true
  if (values.some((value) => value !== first)) {
    return { kind: 'mixed' }
  }
  return { kind: 'editable', allowed: first }
}

/**
 * Return a NEW policy object with this control's keys set to `allowed`, leaving every other field
 * byte-identical. Returns `undefined` when the result carries no field at all, so the caller omits
 * the `nodeOperationPolicy` key entirely (A-6's emptiness half, and the backend normalizer's own
 * omit-empty rule — the two must agree or a saved graph would differ from a republished one).
 */
export function applyOperationPolicyControl(
  policy: NodeOperationPolicy | undefined,
  capability: Pick<ApprovalOperationPolicyCapability, 'policyKeys'>,
  allowed: boolean,
): NodeOperationPolicy | undefined {
  const next: NodeOperationPolicy = { ...(policy ?? {}) }
  for (const key of capability.policyKeys) {
    if (allowed) {
      // Checked ≡ allowed ≡ ABSENT. Deleting (not writing `true`) is what keeps an untouched
      // default byte-identical to a toggled-off-and-on default.
      delete next[key]
    } else {
      next[key] = false
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

// ── Lock-5 §1.3 L5-C/L5-D — the 审批意见 select (`commentRequired`) ─────────────────────────────
//
// One three-way select, not two checkboxes (OD-L5-7(a)): today's default — a reject needs a
// comment, an approve does not — is neither "on" nor "off" of a single switch. The server reads the
// node value first and, when the node carries none, falls back to the instance snapshot, which for
// every instance created after a publish resolves to `'reject_only'`. So ABSENT ≡ 驳回时必填, and
// the same absent-is-default grammar as the checkboxes above applies: choosing the default REMOVES
// the key (gate A-6), and every sibling field survives every choice (A-7's third clause).

/** The value an ABSENT `commentRequired` resolves to for a newly created instance. */
export const COMMENT_REQUIRED_DEFAULT: NodeCommentRequired = 'reject_only'

/** Select value for a persisted value outside the three known ones (read-only, never overwritten). */
export const COMMENT_REQUIRED_UNKNOWN_SELECT_VALUE = '__unknown__'

/** Honest label for that read-only option — never the raw persisted string. */
export const COMMENT_REQUIRED_UNKNOWN_LABEL = '无法识别的设置（只读，保存不会改动它）'

/** Shown beside the select while 同意和驳回都必填 is chosen. The approval-center quick approve and
 *  batch approve send no comment, so at such a node they are refused row by row with the server's
 *  message; the detail page asks for the comment before submitting. Stated so an administrator is
 *  not surprised by those refusals. */
export const COMMENT_REQUIRED_ALWAYS_HINT =
  '选择「同意和驳回都必填」后，审批中心的快捷同意和批量同意不带意见，会被拒绝；审批人需在审批详情中填写意见后同意。'

export function isNodeCommentRequired(value: unknown): value is NodeCommentRequired {
  return (NODE_COMMENT_REQUIRED_VALUES as readonly unknown[]).includes(value)
}

/** The rendered state of the 审批意见 select. */
export type CommentRequiredControlState =
  /** `explicit` is false when the key is absent and the value shown is the default. */
  | { kind: 'editable'; value: NodeCommentRequired; explicit: boolean }
  /** A persisted value outside the enum — rendered read-only, never projected onto a known value. */
  | { kind: 'unknown' }

export function commentRequiredControlState(policy: NodeOperationPolicy | undefined): CommentRequiredControlState {
  const declared = policy?.commentRequired as unknown
  if (declared === undefined) return { kind: 'editable', value: COMMENT_REQUIRED_DEFAULT, explicit: false }
  if (isNodeCommentRequired(declared)) return { kind: 'editable', value: declared, explicit: true }
  return { kind: 'unknown' }
}

/**
 * Return the policy after the author picks `value`, leaving every other field byte-identical.
 *
 *  - An unknown persisted value is never overwritten (fail-closed): the SAME reference comes back.
 *  - Re-picking the value already shown is a no-op: the SAME reference comes back, so an explicit
 *    `'reject_only'` written through the publish API keeps its exact bytes until the author changes it.
 *  - Picking the default removes the key (absent ≡ `'reject_only'`); `undefined` when nothing is
 *    left, so the caller removes `nodeOperationPolicy` entirely.
 *  - `'never'` / `'always'` are written explicitly.
 */
export function applyCommentRequiredChoice(
  policy: NodeOperationPolicy | undefined,
  value: NodeCommentRequired,
): NodeOperationPolicy | undefined {
  const state = commentRequiredControlState(policy)
  if (state.kind !== 'editable' || state.value === value) return policy
  const next: NodeOperationPolicy = { ...(policy ?? {}) }
  if (value === COMMENT_REQUIRED_DEFAULT) {
    delete next.commentRequired
  } else {
    next.commentRequired = value
  }
  return Object.keys(next).length > 0 ? next : undefined
}
