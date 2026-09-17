/**
 * Approval change-request design lock v5.9 §4 (lock:333-335) — the "专用「撤销审批」已发布定义"
 * seed chain: one `approval_templates` row + one `approval_template_versions` row + one
 * `approval_published_definitions` row (impl-taskbook-C-change-request-20260918.md WI-2/WI-14).
 *
 * This module is PURE DATA (no DB access, no side effects at import time) so the migration that
 * inserts these rows and any later test fixture helper (a SEPARATE deliverable —
 * `packages/core-backend/tests/helpers/approval-cancel-round-seed.ts`, not this file, not this
 * work unit) can import the identical constants instead of each hand-copying the JSON and
 * drifting apart from one another.
 *
 * Runtime-policy values are pinned per lock:334 (v5.2, 复核 P2-C) — every key that has a
 * production default is written EXPLICITLY here so the seed never depends on that default:
 *   - `allowRevoke: true` — absent/false would 409 `APPROVAL_REVOKE_DISABLED` at
 *     `ApprovalProductService.ts:10159-10160` before the revoke branch (`:10191-10199`) is ever
 *     reached, so 判据 III's revoke half would never fire.
 *   - `revokeBeforeNodeKeys` intentionally ABSENT from `CANCEL_ROUND_RUNTIME_POLICY` (nil ⇒
 *     fail-open / unrestricted per `:10169-10174`, NOT an empty array — an empty array is a
 *     different, more restrictive value).
 *   - the node's `nodeOperationPolicy.commentRequired` is written explicitly as `'reject_only'`
 *     (not left absent) even though the pinned value happens to equal the engine's own default
 *     (`approval-effective-node-operations.ts:99-106`) — lock:334 is explicit that the seed must
 *     not rely on that default computation reaching the same value by coincidence.
 *
 * Node/seat shape is pinned per lock:335 (v5.8, 第 10 轮 P3-2 / 第 11 轮 P11-3/P11-4): exactly
 * ONE approval node, `approvalMode: 'all'` (会签 — NOT the `normalizeApprovalMode` default
 * `'single'`, `ApprovalGraphExecutor.ts:433-434`). Seat COUNT is deliberately not pinned here
 * (N >= 1) — the lock defers "who" to whichever assignee mechanism the creation path (WI-4,
 * `ApprovalCancelRoundService.ts` — a different work item than this seed) uses to hand the
 * original document's approver identities to the resolver at creation time.
 *
 * `assigneeSources` DESIGN CHOICE (not a verbatim lock quote — flagged for the WI-4 implementer
 * to confirm/align): this seed uses the ALREADY-SHIPPED `requester_choice` mechanism (Lock-1 §K2;
 * `ApprovalAssigneeResolver.ts:360-366`; validated at `ApprovalProductService.ts:1109-1146`) with
 * the widest scope (`{ type: 'company' }` — "accepts any ACTIVE local user",
 * `ApprovalProductService.ts:6957`). It is the only shipped mechanism that lets a creation path
 * hand the resolver an externally-computed, per-instance list of local user ids (here: the
 * original document's approver identities) without inventing a new `ApprovalAssigneeSourceKind` —
 * the resolver reads the frozen list from `requesterSnapshot.requesterChoices[nodeKey]`
 * (`ApprovalAssigneeResolver.ts:360-366`), so WI-4 must key that map with
 * `CANCEL_ROUND_APPROVAL_NODE_KEY` for the seat to resolve to anything.
 */
import type { ApprovalGraph, FormSchema, RuntimeGraph } from '../../types/approval-product'

/** `approval_templates.key` — stable lookup key, distinct from `approval_instances.workflow_key`
 * (`'approval.cancel-round'`, §9-8) even though both use the same string; the two columns live in
 * unrelated tables and naming them alike is a legibility choice, not a shared constraint. */
export const CANCEL_ROUND_TEMPLATE_KEY = 'approval.cancel-round'
export const CANCEL_ROUND_TEMPLATE_NAME = '撤销审批'
export const CANCEL_ROUND_TEMPLATE_DESCRIPTION =
  '系统专用定义:已通过单据发起撤销时使用的审批流程,不由用户在模板中心创建或编辑。'

/** The single approval node's key — WI-4 must write `requesterSnapshot.requesterChoices` keyed
 * by this value for `requester_choice` to resolve any seat (see module doc above). */
export const CANCEL_ROUND_APPROVAL_NODE_KEY = 'cancel_approval'

// Fixed literal UUIDs (not `gen_random_uuid()`) so the migration, this module's importers, and
// any future test fixture all agree on the same identifiers without a lookup round-trip — same
// precedent as the fixed `roles.id` values in
// `zzzz20260826140000_add_elearning_role_templates.ts` (`ELEARNING_ROLE_TEMPLATES`). The `4`/`8`
// nibbles keep the literal a syntactically valid UUID; the all-zero-with-a-trailing-counter shape
// marks these as deliberate reserved constants, not randomly generated values.
export const CANCEL_ROUND_TEMPLATE_ID = '00000000-0000-4000-8000-000000000001'
export const CANCEL_ROUND_TEMPLATE_VERSION_ID = '00000000-0000-4000-8000-000000000002'
export const CANCEL_ROUND_PUBLISHED_DEFINITION_ID = '00000000-0000-4000-8000-000000000003'

const START_NODE_KEY = 'start'
const END_NODE_KEY = 'end'

/** Draft-shape graph (`approval_template_versions.approval_graph`) — start -> one approval node
 * -> end, matching the shape convention used across the test corpus (e.g.
 * `approval-add-sign-honesty.db.test.ts` `linearGraph`). */
export function buildCancelRoundApprovalGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: START_NODE_KEY, type: 'start', config: {} },
      {
        key: CANCEL_ROUND_APPROVAL_NODE_KEY,
        type: 'approval',
        name: '原审批人复核',
        config: {
          assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'company' } }],
          approvalMode: 'all',
          nodeOperationPolicy: { commentRequired: 'reject_only' },
        },
      },
      { key: END_NODE_KEY, type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-cancel_approval', source: START_NODE_KEY, target: CANCEL_ROUND_APPROVAL_NODE_KEY },
      { key: 'e-cancel_approval-end', source: CANCEL_ROUND_APPROVAL_NODE_KEY, target: END_NODE_KEY },
    ],
  }
}

/** Empty form: the cancel round carries no requester-authored form fields of its own — its
 * `form_snapshot` comes from `policy_snapshot`/`requester_snapshot` written by the creation path
 * (WI-4), not from a submitted form. */
export function buildCancelRoundFormSchema(): FormSchema {
  return { fields: [] }
}

/** Published-shape graph (`approval_published_definitions.runtime_graph`) — same nodes/edges as
 * the draft graph plus the frozen `RuntimePolicy`, mirroring the shape `buildRuntimeGraph`
 * produces at normal template-publish time (`ApprovalProductService.ts:4495-4505`). */
export function buildCancelRoundRuntimeGraph(): RuntimeGraph {
  const graph = buildCancelRoundApprovalGraph()
  return {
    ...graph,
    policy: {
      allowRevoke: true,
      // revokeBeforeNodeKeys intentionally omitted — see module doc.
    },
  }
}
