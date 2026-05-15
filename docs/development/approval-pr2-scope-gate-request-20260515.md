# Approval PR2 Scope Gate Request 2026-05-15

## Request

Claude should review this request before Codex starts PR2 code changes.

Claude scope:

- Produce a scope gate checklist.
- Identify semantic risks.
- List required tests.
- Mark do-not-cross lines.
- Provide review focus for the eventual PR2 diff.

Claude should not propose Phase 2/3/4 product work for PR2.

## PR Scope

PR:

- `auto-approval-three-merge`

Branch:

- `flow/auto-approval-three-merge-20260515`

Worktree:

- `/Users/chouhua/Downloads/Github/metasheet2-flow-auto-approval-three-merge-20260515`

Base commit:

- `9501d990c docs(approval): track phase1 followups`

Primary references:

- `docs/development/approval-phase1-codex-claude-worksplit-todo-20260515.md`
- `docs/development/approval-phase1-followups-20260515.md`
- `docs/development/approval-pr1-version-freeze-development-20260515.md`
- `docs/development/approval-pr1-version-freeze-verification-20260515.md`
- `docs/research/yida-workflow-vs-metasheet2-comparison-20260514.md`
- `docs/research/yida-workflow-automation-benchmark-improvement-plan-20260515.md`

## Expected Files

Expected implementation files:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/services/ApprovalAutoApprovalPolicyService.ts` if a dedicated policy evaluator keeps `ApprovalProductService` small.
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts` only for minimal type/reason integration; avoid turning it into the requester/history policy engine.
- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/db/migrations/*approval*` for `auto_approval_policy` storage if schema changes are needed.
- `packages/core-backend/tests/unit/**/*approval*`
- `packages/core-backend/tests/integration/**/*approval*` only if the existing local integration baseline permits useful coverage.

Expected documentation files:

- `docs/development/approval-pr2-auto-approval-three-merge-development-20260515.md`
- `docs/development/approval-pr2-auto-approval-three-merge-verification-20260515.md`

## Current Code Baseline

Known existing implementation:

- PR1 version-freeze hardening is merged to `main`; existing instance runtime advancement must continue to use `approval_instances.published_definition_id`.
- `ApprovalGraphExecutor` currently emits auto-approval events only for graph-local empty-assignee cases with `reason: 'empty-assignee'`.
- `ApprovalProductService.insertAutoApprovalEvents()` writes those graph-local events as `approval_records.action = 'approve'` with system actor metadata.
- `ApprovalNodeConfig` supports `approvalMode` and `emptyAssigneePolicy`; there is no `AutoApprovalPolicy` type yet.
- `approval_template_versions` and `approval_published_definitions` exist. Any PR2 policy storage must preserve version-freeze semantics for already-started instances.
- `approval_assignments` has an active uniqueness index for `(instance_id, assignment_type, assignee_id)` where `is_active = TRUE`.
- Graph validation already rejects duplicate approvers across parallel branches because the active-assignment unique index cannot represent the same active user in multiple branches.

Therefore PR2 should add the three auto-approval merge rules without changing approval graph topology, without adding product UI, and without relaxing the active assignment invariant.

## Proposed Implementation Stance For Review

Codex intends to implement backend policy evaluation with these defaults unless Claude blocks them:

- Add an `AutoApprovalPolicy` type:
  - `mergeWithRequester?: boolean`
  - `mergeAdjacentApprover?: boolean`
  - `dedupeHistoricalApprover?: boolean`
  - optional `actorMode?: 'system' | 'original_approver'` only if needed.
- Store template/global policy as versioned data. Preferred storage is `approval_template_versions.auto_approval_policy JSONB` unless Claude recommends snapshotting it directly into `approval_published_definitions` for stronger freeze semantics.
- Store node-level override inside approval node config, for example `node.config.autoApprovalPolicy`.
- Resolve effective policy with precedence: node override > template/version policy > default disabled.
- Keep `ApprovalGraphExecutor` focused on graph progression. Requester/history/adjacent policy should live in `ApprovalProductService` or `ApprovalAutoApprovalPolicyService`.
- Evaluate auto-approval after candidate assignments are known and before they are persisted as active assignments where possible.
- Write an `approval_records` row for every automatic approval with enough metadata to explain the strategy hit and original assignee.
- Add a max auto-step guard so a bad graph or policy cannot infinite-loop through automatic approvals.

Claude should explicitly accept, reject, or amend this stance.

## Explicit Non-Goals

- No generic `approval_trigger_bindings`.
- No public-form submitted-to-approval product UI.
- No multitable submitted-to-approval product UI.
- No `start_approval` automation action.
- No persistent `automation_jobs` queue.
- No automation retry or rerun.
- No business calendar or SLA timeout action work.
- No admin jump implementation.
- No add-sign implementation.
- No graph runtime insertion or `runtimeInsertedNodes`.
- No new frontend configuration surface.
- No approval assignee resolver productization beyond what PR2 strictly needs for fixed user/role assignees.
- No relaxation of the current duplicate active-assignment invariant unless Claude explicitly approves a smaller, tested exception.

## Follow-ups To Absorb

From `docs/development/approval-phase1-followups-20260515.md`:

- A: extract `APPROVAL_TERMINAL_STATUSES` into `packages/core-backend/src/types/approval-product.ts` and reuse it in service/tests.
- B: add a short comment explaining why `assertTemplateVersionDeletable()` checks both `template_version_id` and `published_definition_id`.

These are the only PR1 follow-ups intended for PR2. Follow-ups C, D, and E remain independent/deferred.

## Boundary Checklist For Claude

Claude should explicitly answer yes/no for each item:

- Does PR2 stay limited to auto-approval three-merge?
- Does PR2 avoid adding new product surfaces or frontend configuration UI?
- Does PR2 avoid scheduler, automation retry, SLA, admin-jump, and add-sign work?
- Does PR2 preserve PR1 version-freeze semantics by evaluating policy from the instance-bound version/published definition path?
- Does PR2 avoid mutating runtime graph topology or adding `runtimeInsertedNodes`?
- Does PR2 keep `ApprovalGraphExecutor` graph-local and avoid moving requester/history/adjacent business policy into the graph walker?
- Does PR2 keep default behavior disabled unless a policy explicitly enables a merge rule?
- Does PR2 define and test node override > template policy > default disabled precedence?
- Does PR2 write audit records for every auto approval?
- Does PR2 include a max auto-step guard?
- Does PR2 handle parallel branches without violating `approval_assignments.active_unique`?
- Does PR2 document and verify migration rollback behavior if migrations change?

## Tests Planned

Codex should add or verify tests for:

- `mergeWithRequester`: requester is assignee on the first approval node, so the node is automatically approved.
- `mergeWithRequester`: requester appears after a condition node, so the node is automatically approved using the resolved runtime path.
- `mergeAdjacentApprover`: adjacent same user with a `cc` node in between; the `cc` node does not break adjacency.
- `mergeAdjacentApprover`: adjacent same user across parallel branches is either supported with explicit semantics or rejected/guarded without duplicate active assignments.
- `dedupeHistoricalApprover`: a user who already completed approval in the same instance appears again after return/jump-like history and is automatically approved.
- Multi-assignee `all` mode: auto approval should satisfy only the matching assignee and wait for remaining required approvers.
- Multi-assignee `any` mode: auto approval should complete the node and cancel or avoid sibling active assignments according to existing any-mode semantics.
- Global policy enabled and node override disabled: node does not auto approve.
- Global policy disabled and node override enabled: node auto approves.
- Multiple rules match the same assignee: metadata records deterministic strategy precedence.
- Every auto approval writes `approval_records` with actor, original approver, node key, strategy hit, and policy source.
- Max auto-step guard prevents an infinite automatic approval loop.
- Existing empty-assignee auto approval still works and remains distinguishable from the three PR2 merge rules.
- PR1 version-freeze regression: after a new template version is published, an old running instance evaluates auto-approval policy from its bound version/published definition path, not from the current active template.
- Follow-up A: `APPROVAL_TERMINAL_STATUSES` is reused instead of duplicating terminal status literals.
- Follow-up B: delete guard OR predicate intent is documented.

Suggested targeted commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run packages/core-backend/tests/unit/approval-product-service.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run packages/core-backend/tests/unit/approval-graph-executor.test.ts --watch=false
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

Baseline note:

- Full unit suite passed after PR1: 165 files, 2143 tests.
- Full integration suite was not green in this local environment before PR1 code changes; see `docs/development/approval-phase1-baseline-20260515.md` and PR1 verification notes.

## Review Focus Requested

Claude should focus review on:

1. Version source of truth: auto-approval policy must not drift to the current active template for running instances.
2. Policy semantics: requester, adjacent, and historical merge rules should be deterministic and auditable.
3. Approval modes: `single`, `all`, and `any` must not accidentally bypass required human approvers.
4. Parallel branches: implementation must not create duplicate active assignments or ambiguous adjacency.
5. Audit quality: automatic approvals must be distinguishable from human approvals and empty-assignee auto approvals.
6. Loop safety: max auto-step guard must fail closed with useful diagnostics.
7. Migration safety: if policy storage changes schema, `up -> down -> up` rollback behavior must be verified on a scratch DB.
8. Scope creep: no Phase 2+ product surfaces should be included.

## Expected Claude Output

Please return:

```text
Scope gate:
Semantic risks:
Required tests:
Do-not-cross lines:
Review focus:
Go / no-go for Codex implementation:
```
