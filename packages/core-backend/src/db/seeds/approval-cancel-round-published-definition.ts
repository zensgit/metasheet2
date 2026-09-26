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
 *   - `allowRevoke: true` — absent/false would 409 `APPROVAL_REVOKE_DISABLED` before the revoke
 *     branch is ever reached, so 判据 III's revoke half would never fire. (This module previously
 *     cited `ApprovalProductService.ts:10159-10160` / revoke branch `:10191-10199` / window gate
 *     `:10169-10174` — those are the LOCK's own baseline line numbers (ratify header: "锁文正文
 *     保留基线行号"), not this tree's, and this lane's own edits to that file have since pushed the
 *     current-HEAD locations elsewhere — gate round-4 P3-1 (`impl-gate-C-slice1-round4-20260918.md`).
 *     Deliberately NOT re-pinned as a fresh line-number literal here (a fresh literal would just go
 *     stale the same way on the next edit to that file, reproducing the exact defect this note is
 *     fixing); re-derive on demand with
 *     `grep -n "APPROVAL_REVOKE_DISABLED\|APPROVAL_REVOKE_WINDOW_CLOSED"
 *     packages/core-backend/src/services/ApprovalProductService.ts`.)
 *   - `revokeBeforeNodeKeys` intentionally ABSENT from `CANCEL_ROUND_RUNTIME_POLICY` (nil ⇒
 *     fail-open / unrestricted). The window gate is `revokeBeforeNodeKeys?.length && …`, so an
 *     ABSENT key and an EMPTY array short-circuit identically — both fail-open. Gate round-4 P3-2
 *     (`impl-gate-C-slice1-round4-20260918.md`) WITHDRAWS this module's prior claim that "an empty
 *     array is a different, more restrictive value" — it is not, on the code as written. What
 *     actually pins this key's fail-open default is R4-M3's real-DB behavioural mutation (setting
 *     `revokeBeforeNodeKeys` to a NON-matching NON-empty array — genuinely more restrictive — and
 *     observing all 4 redemption-chain revoke assertions flip to 409
 *     `APPROVAL_REVOKE_WINDOW_CLOSED`), not a length comparison written here as prose.
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

/**
 * Sentinel audience id for the seeded template's `approval_templates.visibility_scope`.
 *
 * WHY THIS ROW NEEDS A SCOPE AT ALL. `visibility_scope` defaults to `'{"type":"all","ids":[]}'`
 * (`zzzz20260423162000_add_approval_template_visibility_scope.ts:7`), and
 * `applyTemplateVisibilityFilter`'s FIRST disjunct is
 * `COALESCE(visibility_scope->>'type','all') = 'all'` — which matches EVERY actor. Left on the
 * default, this system-only definition would be a live template-center row for every user holding
 * `approvals:read`: listed by `listTemplates`, fetchable by `getTemplate`, and accepted by
 * `templateVisibleAtCreateBoundary` as a template a user may launch an instance from. The module
 * doc above already says this definition is "不由用户在模板中心创建或编辑" — before this constant
 * existed, nothing in the data or the code enforced that sentence.
 *
 * WHY A SENTINEL ID AND NOT AN EMPTY `ids` ARRAY. Both hide the row identically in SQL (an
 * audience-scoped disjunct that matches nobody), but an empty array is REJECTED by the write-path
 * validator `normalizeTemplateVisibilityScope` ("visibilityScope.ids must contain at least one id
 * for scoped templates", 400 `VALIDATION_ERROR`) — and the authoring FE round-trips this field on
 * EVERY template save (`apps/web/src/approvals/templateAuthoring.ts`: `buildUpdateTemplatePayload`
 * -> `buildCreateTemplatePayload` -> `buildVisibilityScope`, seeded from
 * `template.visibilityScope` by `draftFromTemplate`). An empty array would therefore make the row
 * permanently un-editable by an authorized template manager, failing an unrelated rename with a
 * confusing visibility error. A single sentinel id passes the write validator (non-empty, 37 chars
 * <= the 128-char per-id cap) and so keeps the row editable.
 *
 * WHY NOT `type: 'ids'`. That type does not exist: `APPROVAL_TEMPLATE_VISIBILITY_TYPES` is
 * `{all, dept, role, user}`, the DB CHECK `approval_templates_visibility_scope_shape`
 * (`zzzz20260423162000:20-28`) enforces the same four, and `readTemplateVisibilityScope` coerces
 * an unknown type back to `{type:'all'}` in the DTO — so an out-of-set type would be a 23514 on
 * insert, and (if the CHECK were ever dropped) a DTO that reports "visible to all" while SQL hides
 * the row. `user` is an EXISTING shipped semantic, not a new one.
 *
 * NAMING follows this same filter's own sentinel convention for the empty-input case
 * (`__approval_template_no_dept__` / `__approval_template_no_role__`).
 *
 * RESIDUAL, stated plainly rather than hidden: `users.id` is `TEXT`
 * (`packages/core-backend/migrations/054_create_users_table.sql:5`), so the invisibility rests on
 * no real account ever holding this literal id, not on a type-level impossibility. That is the
 * same residual the two filter-side sentinels above already carry.
 *
 * NOT A PERMANENT DECISION. This value is what makes the definition invisible BEFORE the product
 * entry point is wired. The cancel round's own dedicated creation path does not read
 * `approval_templates` at all — it is keyed on `CANCEL_ROUND_PUBLISHED_DEFINITION_ID` and
 * deliberately bypasses `templateVisibleAtCreateBoundary` (that method's own doc comment states
 * this) — so nothing about the cancel round itself depends on this scope. How to make the
 * definition visible again when the entry slice lands is written up in
 * `docs/development/approval-cancel-round-phase1-design-20260918.md`
 * ("入口切片接线时如何翻回可见") and is an owner decision, not a decision taken here.
 *
 * (The dedicated creation path is named by SYMBOL nowhere in this module on purpose: the C-1
 * dormancy guard `tests/unit/approval-cancel-round-dormancy-unreachable.test.ts` pins the exact
 * set of PRODUCTION files that mention that symbol in any form, comments included, so that a new
 * mention forces a human to look. Naming it here would widen that pinned set for a doc comment.)
 */
export const CANCEL_ROUND_TEMPLATE_VISIBILITY_SENTINEL_ID = '__approval_cancel_round_system_only__'

/**
 * The literal `approval_templates.visibility_scope` value the seed migration writes. Shared with
 * the acceptance test so the assertion and the insert cannot drift into two hand-copied literals.
 */
export const CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE: { type: 'user'; ids: string[] } = {
  type: 'user',
  ids: [CANCEL_ROUND_TEMPLATE_VISIBILITY_SENTINEL_ID],
}

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
