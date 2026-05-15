# Approval Phase 1 Codex/Claude Worksplit TODO 2026-05-15

## 1. Purpose

This document turns the confirmed YiDA workflow benchmark decisions into an executable Phase 1 plan.

Phase 1 is limited to approval kernel correctness. It must not open new product surfaces before the K3 PoC gate is passed.

Primary references:

- `docs/research/yida-workflow-vs-metasheet2-comparison-20260514.md`
- `docs/research/yida-workflow-automation-benchmark-improvement-plan-20260515.md`

## 2. Confirmed Boundaries

| Boundary | Decision | Phase 1 Rule |
|---|---|---|
| §5.1 unified business trigger approval entry | Defer. If K3 PoC requires it, use a hardcoded narrow path with no UI. | Do not add generic `approval_trigger_bindings` UI or productized public-form/multitable trigger configuration. |
| §5.10 persistent queue | Do not implement. At most add `automation_scheduled_runs` audit if needed. | Do not replace the current timer scheduler with `automation_jobs` or worker claiming. |
| Business calendar | Move first SLA calendar version to Phase 4: org calendar + holidays. Defer shifts and blackout windows. | Do not block Phase 1 on SLA calendar work. |
| Add-sign graph runtime | Use assignment-level MVP. Graph-level effective runtime is a later ADR. | Do not mutate `ApprovalGraphExecutor` graph topology or add `runtimeInsertedNodes` behavior in Phase 1. |
| Automation retry | Not in Phase 1. Must depend on idempotency before real retry. | No full execution retry unless action-level idempotency is implemented first. |

## 3. Collaboration Model

One agent owns code for each PR. The other agent owns scope gate, semantic review, and test matrix.

Phase 1 uses a stacked, serial PR model. By default, `PR(N+1)` starts from `main` only after `PR(N)` is merged. A stacked branch from `PR(N)` may be opened as a `PR(N+1)` preview while `PR(N)` is in review. After `PR(N)` merges, the stacked branch must be rebased onto `main` before its own merge. This applies to any adjacent `(PR(N), PR(N+1))` pair in Phase 1.

| Responsibility | Codex | Claude |
|---|---|---|
| Repo cleanup and branch/worktree preparation | Owner | Review checklist only |
| Code implementation | Owner by PR | No parallel edits to core files unless explicitly handed off |
| Migrations | Owner by PR | Review SQL rollback, constraints, and compatibility |
| Unit/integration tests | Owner by PR | Review missing cases and edge-case coverage |
| Semantic ADR/checklist | Consume and implement | Owner |
| Diff review | Fix findings | Owner |
| Final verification report | Owner | Review gates and residual risk |

### 3.1 Stacked PR Rule

- PR1 must merge before PR2 is cut from `main`.
- PR2 must merge before PR3 is cut from `main`.
- PR3 must merge before PR4 is cut from `main`.
- A stacked branch may be used only to reduce waiting time during a review window.
- Stacked preview branches are allowed for any adjacent pair: PR1 -> PR2, PR2 -> PR3, or PR3 -> PR4.
- A stacked branch must be rebased onto `main` after the parent PR merges.
- No two agents should independently edit the same approval runtime file in different branches and expect an automatic merge.

Expected Phase 1 wall-clock time: 15-23 working days, or roughly 3-5 weeks after review, rebase, and verification queues are included.

### 3.2 Ownership Locks

Only the current PR owner may edit these files in a given PR:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/db/migrations/*approval*`
- `packages/core-backend/tests/**/*approval*`
- `apps/web/src/views/**/*Approval*`
- `apps/web/src/components/**/*Approval*`

These locks apply during overlap windows, especially stacked PRs in review or preview. Once a PR merges, its files return to the shared pool for the next PR owner.

The primary code paths listed under each PR are automatically locked for that PR. Each Codex handoff must also list the intended function-level ownership, for example `(ApprovalProductService.ts, publishTemplate)` or `(routes/approvals.ts, POST /:id/jump)`. Another agent may review those functions but should not edit them without explicit handoff.

Claude may propose patch suggestions in review text, but Codex applies them after review.

## 4. Current Branch Preflight

Current branch observed before this plan:

- `codex/data-factory-issue1542-postdeploy-smoke-20260515`

Current dirty assets must be resolved before Phase 1 begins.

| Asset | Action | Owner | Done Criteria |
|---|---|---|---|
| 8 attendance/formula code changes | Assess completeness. If complete, ship as a separate `fix(attendance): formula engine hardening` PR. If incomplete, stash or move to a dedicated worktree. | Codex | `git status --short` has no unrelated attendance code changes before Phase 1 branch is cut. |
| `docs/development/attendance-dingtalk-formula-*-20260515.md` | Keep with attendance PR if they describe the code changes. Otherwise move into research/deferred notes. | Codex | Docs are either committed with attendance PR or removed from Phase 1 worktree. |
| `docs/research/yida-workflow-*.md` | Commit as `docs(research): yida workflow benchmark plan` before Phase 1 code work. | Codex | Research docs are on main or intentionally carried in a docs-only branch. |
| `.tmp-*.mjs` scripts | Delete if one-off crawl/probe scripts. If reusable, move under `scripts/ops/` with reviewed naming and tests. | Codex | No root `.tmp-*.mjs` files remain. |
| `.playwright-mcp/` artifacts | Add `.playwright-mcp/` to `.gitignore` in a standalone `chore: gitignore playwright-mcp artifacts` commit on `main` before the Phase 1 branch is cut. | Codex | No untracked Playwright MCP artifacts appear in Phase 1 worktree. |
| Final clean branch | Cut from latest `main`. | Codex | New branch `flow/version-freeze-hardening-20260515` starts with clean `git status --short`. |

## 5. Phase 1 PR Plan

### PR1: version-freeze-hardening

Estimate: 3-4 days.

Branch:

- `flow/version-freeze-hardening-20260515`

Code owner:

- Codex

Review owner:

- Claude

Primary code paths:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts`
- `packages/core-backend/tests/unit/**/*approval*`
- `packages/core-backend/tests/integration/**/*approval*`

Current code baseline:

- `publishTemplate()` already creates `approval_published_definitions.runtime_graph` and marks previous active definitions inactive.
- `createApproval()` already stores `template_version_id`, `published_definition_id`, and `form_snapshot`.
- `dispatchAction()` already reloads runtime graph from `approval_instances.published_definition_id`.

Implementation TODO:

- [ ] Add tests proving old instances continue on the old `published_definition_id` after a new template version is published.
- [ ] Add tests proving form validation uses the instance-start schema snapshot, not a later draft or published schema.
- [ ] Add service guard for hard-delete/archive attempts when unfinished instances reference a template version.
- [ ] Add list/detail metadata needed for version governance: published at, active/history state, instance count, unfinished instance count.
- [ ] Verify publish lifecycle is transactional under concurrent publish attempts.
- [ ] Confirm stale published definitions remain readable for running instances.
- [ ] Identify and remove any runtime path that advances an instance from the template's current `active_version_id` instead of the instance-bound `published_definition_id`.
- [ ] Add regression coverage for rollback on publish failure.
- [ ] Update API/OpenAPI docs if response shape changes.

Claude scope gate checklist:

- [ ] No generic business trigger binding work.
- [ ] No scheduler or automation retry work.
- [ ] No graph runtime insertion.
- [ ] No unrelated frontend product surface.
- [ ] Version deletion/archive behavior is explicitly tested.

PR1 acceptance:

- [ ] Existing instance advances with original runtime graph after new publish.
- [ ] Existing instance keeps original form snapshot semantics.
- [ ] Unfinished instance blocks destructive version deletion/archive.
- [ ] Tests fail before the hardening change and pass after it.
- [ ] `down()` migration is verified by running an up -> down -> up sequence on a scratch DB if PR1 adds or changes migrations.
- [ ] Verification note lists exact commands run.

Suggested verification:

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

### PR2: auto-approval-three-merge

Estimate: 4-6 days.

Branch:

- `flow/auto-approval-three-merge-20260515`

Code owner:

- Codex

Review owner:

- Claude

Primary code paths:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- New service if useful: `packages/core-backend/src/services/ApprovalAutoApprovalPolicyService.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/db/migrations/*approval*`
- Approval product tests

Design decision:

- Policy evaluation should live in `ApprovalProductService` or a dedicated `ApprovalAutoApprovalPolicyService`, because it needs requester, approval records, active assignments, and instance metadata.
- Keep `ApprovalGraphExecutor` focused on graph progression. It may continue returning auto-approval events for graph-local empty-assignee cases, but it should not become the main policy engine for requester/history/adjacent merge.

Implementation TODO:

- [ ] Add template/global `auto_approval_policy` storage.
- [ ] Add node-level policy override in approval node metadata/config.
- [ ] Implement `mergeWithRequester`.
- [ ] Implement `mergeAdjacentApprover`, ignoring cc nodes and skipped auto nodes.
- [ ] Implement `dedupeHistoricalApprover`, based on completed approval records in the same instance.
- [ ] Define precedence: node policy override > template policy > default disabled.
- [ ] Write `approval_records` for every auto approval with `actor_id = system:auto-approval`.
- [ ] Include original approver, node key, strategy hit, and policy source in metadata.
- [ ] Prevent infinite auto-advance loops with a max auto-step guard.
- [ ] Ensure parallel branches and `approval_assignments.active_unique` constraints are handled.
- [ ] Add UI display only if existing template detail already has a safe config surface; otherwise keep backend-only for Phase 1.

Claude semantic matrix:

- [ ] requester is assignee on first node.
- [ ] requester is assignee after a condition node.
- [ ] adjacent same user with cc in between.
- [ ] adjacent same user across parallel branches.
- [ ] historical user reappears after return/jump.
- [ ] multiple assignees with `all` mode.
- [ ] multiple assignees with `any` mode.
- [ ] policy disabled globally but enabled on node.
- [ ] policy enabled globally but disabled on node.

PR2 acceptance:

- [ ] Three merge rules work independently.
- [ ] Node override precedence is covered.
- [ ] Every auto approval has audit records.
- [ ] No duplicate active assignment is created for the same instance/type/user.
- [ ] No graph topology mutation is introduced.
- [ ] `down()` migration is verified by running an up -> down -> up sequence on a scratch DB.

Suggested verification:

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

### PR3: admin-jump-node

Estimate: 3-5 days.

Branch:

- `flow/admin-jump-node-20260515`

Code owner:

- Codex

Review owner:

- Claude

Primary code paths:

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/guards/*`
- Approval route/service tests

API draft:

```http
POST /api/approvals/:id/jump
```

Request:

```json
{
  "targetNodeKey": "approval_finance",
  "reason": "original approver left company",
  "version": 12
}
```

Implementation TODO:

- [ ] Add `approvals:admin` permission check.
- [ ] Add `ApprovalProductService.adminJump()`.
- [ ] Lock instance row with `FOR UPDATE`.
- [ ] Reject terminal instances.
- [ ] Enforce optimistic `version`.
- [ ] Load instance-bound `published_definition_id`, not active template definition.
- [ ] Validate `targetNodeKey` exists in the bound runtime graph.
- [ ] Validate target node is downstream of the current node in the bound runtime graph.
- [ ] First version allows forward jump only. Backward jump is out of scope and requires a separate ADR.
- [ ] Validate target node is an approval node unless explicitly allowing end-state recovery in a later ADR.
- [ ] Deactivate current active assignments.
- [ ] Resolve assignments for target node from the bound runtime graph.
- [ ] Insert new assignments.
- [ ] Clear or rebuild `metadata.parallelBranchStates` safely.
- [ ] Write `approval_records` action `jump` or existing allowed action plus metadata; update action constraint if needed.
- [ ] Record old node, target node, old assignees, new assignees, admin actor, reason.
- [ ] Always emit `approval.admin_jumped` with from node, to node, old assignees, new assignees, actor, reason, and instance id.
- [ ] If some notification channels are not wired yet, scope the first delivery to audit record plus in-app/event-bus consumers at minimum.

Claude security review checklist:

- [ ] Non-admin receives 403.
- [ ] Admin cannot jump a terminal instance.
- [ ] Stale version receives 409.
- [ ] Jump uses instance-bound runtime graph.
- [ ] Invalid target receives 400.
- [ ] Old assignee cannot act after jump.
- [ ] Audit contains enough data to explain recovery.
- [ ] No public-form route or automation route is changed.

PR3 acceptance:

- [ ] Stuck instance can be moved to a valid target approval node.
- [ ] Backward jump is rejected in the first version.
- [ ] Old active assignments are invalidated.
- [ ] New target assignments can approve and continue the original bound runtime.
- [ ] Audit timeline shows admin jump.
- [ ] Jump does not alter template version or published definition.
- [ ] `down()` migration is verified by running an up -> down -> up sequence on a scratch DB if PR3 adds or changes migrations.

Suggested verification:

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

### PR4: add-sign-mvp-assignment-level

Estimate: 5-8 days.

Branch:

- `flow/add-sign-mvp-20260515`

Code owner:

- Codex

Review owner:

- Claude

Primary code paths:

- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/db/migrations/*approval*`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- Approval route/service tests

Design decision:

- Do not add `runtimeInsertedNodes`.
- Do not mutate `nodeMap`, `outgoingEdges`, or published `runtime_graph`.
- Model add-sign as assignment-level child tasks tied to an existing approval node.

Candidate schema:

```sql
CREATE TABLE approval_countersign_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id TEXT NOT NULL,
  parent_assignment_id UUID NOT NULL REFERENCES approval_assignments(id) ON DELETE CASCADE,
  child_assignment_id UUID REFERENCES approval_assignments(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('before', 'after', 'parallel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  requested_by TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
```

Fallback only if the Day 0 ADR rejects the independent table: add countersign columns to `approval_assignments`. The default plan is the independent table because it avoids mixing `approval_assignments.is_active` with countersign lifecycle state and keeps timeline joins explicit.

Implementation TODO:

- [ ] Day 0: Claude writes add-sign ADR covering before/after/parallel × single/all/any × reject/return/revoke/transfer/jump interactions. ADR file: `docs/development/approval-add-sign-adr-20260515.md`. Codex blocks on its merge before any PR4 code change.
- [ ] Confirm FK types for `approval_instances.id` and `approval_assignments.id` before writing the migration.
- [ ] Add migration for `approval_countersign_tasks` as the default storage model.
- [ ] Add action request types for `add_sign_before`, `add_sign_after`, and `add_sign_parallel`.
- [ ] Add permission rule: current active approver or admin can add sign; requester cannot unless explicitly permitted.
- [ ] For before add-sign, suspend current assignment until child assignment completes.
- [ ] For after add-sign, create child assignment that must complete before advancing to next graph node.
- [ ] For parallel add-sign, add child assignment counted in current node completion.
- [ ] Adjust current-node completion check in `ApprovalProductService` to include countersign children.
- [ ] Preserve `ApprovalGraphExecutor` graph-only behavior.
- [ ] Write `approval_records` for add-sign creation and completion.
- [ ] Add metadata: parent assignment, countersign mode, inserted by, target user, reason.
- [ ] Ensure transfer, reject, return, revoke, and admin jump cancel or close countersign tasks consistently.
- [ ] Add UI only if existing action menu can expose it without broad task-center redesign; otherwise backend/API first.

Claude ADR/checklist:

- [ ] Define exact semantics for before/after/parallel add-sign.
- [ ] Define how add-sign interacts with `single`, `all`, and `any` approval modes.
- [ ] Define how add-sign interacts with reject, return, revoke, transfer, and admin jump.
- [ ] Define how countersign appears in timeline.
- [ ] Confirm no runtime graph insertion is required.

PR4 acceptance:

- [ ] Before add-sign blocks parent approver until child completes.
- [ ] After add-sign requires child completion before node advances.
- [ ] Parallel add-sign participates in node completion.
- [ ] Reject/return/jump closes pending countersign tasks correctly.
- [ ] Timeline clearly shows add-sign actor and target.
- [ ] No mutation of published runtime graph or `ApprovalGraphExecutor` topology.
- [ ] `down()` migration is verified by running an up -> down -> up sequence on a scratch DB.

Suggested verification:

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

## 6. Phase 4 Red-Line TODO Before Automation Retry

These items are not Phase 1 work, but they must be completed before enabling real retry in the automation running center.

| Item | Required Before Retry |
|---|---|
| `AutomationAction.id` | Stable per-action id for persisted execution steps. |
| `AutomationAction.idempotencyKeyTemplate?: string` | Required for side-effecting actions before retry is allowed. |
| `automation_action_idempotency_keys` table | Stores key, action type, execution id, result status, created at, and conflict metadata. |
| Action schema classification | Mark actions as side-effecting or naturally idempotent. |
| Backend guard | Return 409 if retry is requested for a run containing non-idempotent side-effecting actions. |
| UI guard | Retry button disabled with reason when idempotency is missing. |
| Support packet redaction | Must redact webhook URLs, DingTalk secrets, bearer tokens, and JWT-like strings. |
| Test matrix | For each action type, verify double execution with the same idempotency key returns the same result and does not duplicate external side effects. DingTalk, email, and webhook checks must use mocks. |

## 7. Handoff Protocol Between Codex And Claude

### 7.1 Before Each PR Starts

Codex sends Claude:

```text
PR scope:
Branch:
Files expected to change:
Explicit non-goals:
Boundary checklist:
Tests planned:
```

Claude returns:

```text
Scope gate:
Semantic risks:
Required tests:
Do-not-cross lines:
Review focus:
```

### 7.2 Before Review

Codex sends Claude:

```text
Diff summary:
Changed files:
Migration summary:
Tests run:
Known gaps:
```

Claude returns findings in review order:

1. Blocking correctness issues.
2. Security or permission issues.
3. Missing tests.
4. Scope creep.
5. Naming or maintainability comments.

### 7.3 Merge Gate

A PR is merge-ready only when:

- [ ] Worktree contains only files for that PR.
- [ ] Boundary checklist is green.
- [ ] Claude review has no unresolved blocking findings.
- [ ] Targeted unit/integration tests pass.
- [ ] Build/type-check status is recorded.
- [ ] Migration rollback behavior is documented.
- [ ] Verification notes are committed in `docs/development/` if the PR is non-trivial.

### 7.4 Response Expectations

These are working-window expectations for coordination, not automated CI gates.

| Step | Expected Response |
|---|---|
| Codex requests scope gate; Claude returns gate checklist | 4 hours within working window |
| Codex requests review; Claude returns findings | 8 hours within working window |
| Claude files blocking finding; Codex addresses or responds | Next working day |
| Codex reports blocker requiring user decision | Same working day |

## 8. User Decision Points

The following decisions are already confirmed:

| Decision | Confirmed Direction |
|---|---|
| PR3 admin jump direction | First version allows forward jump only. Backward jump requires a separate ADR. |
| PR4 countersign storage | Use independent `approval_countersign_tasks` table by default. Do not add countersign lifecycle state to `approval_assignments` unless the Day 0 ADR rejects the table. |

Only these items still require user confirmation during Phase 1:

| Decision | When To Ask |
|---|---|
| K3 hardcoded trigger path exception | Only if PR2+ work is blocked by a concrete K3 PoC requirement. |
| Add `jump` as a new `approval_records.action` value | During PR3 if reusing existing actions would obscure audit semantics. |
| Add-sign UX exposure | During PR4 if backend API is complete and frontend action menu exposure is low risk. |

## 9. Out Of Scope Until After Phase 1

- Generic `approval_trigger_bindings` product UI.
- Public-form submitted to approval generic configuration.
- Multitable submitted to approval generic configuration.
- Full `start_approval` automation action productization.
- Persistent `automation_jobs` queue and worker.
- Full cron parser and misfire policies.
- Workflow DAG/branch/loop/delay/wait automation orchestration.
- Business calendar beyond Phase 4 SLA first version.
- Graph-level add-sign runtime insertion.
- BPMN compatibility beyond existing approval bridge needs.
- Analytics dashboards and process mining.

## 10. Immediate TODO

- [ ] Finish or stash current attendance/formula work.
- [ ] Remove or relocate `.tmp-*.mjs` files.
- [ ] Remove or ignore `.playwright-mcp/` artifacts.
- [ ] Commit research docs separately.
- [ ] Before opening PR1, run `pnpm --filter @metasheet/core-backend test:unit` and `pnpm --filter @metasheet/core-backend test:integration` on `main`; save the pass/fail baseline to `docs/development/approval-phase1-baseline-20260515.md`.
- [ ] Cut `flow/version-freeze-hardening-20260515` from latest `main`.
- [ ] Ask Claude for PR1 scope gate using this document.
- [ ] Start PR1 implementation only after the worktree is clean.
