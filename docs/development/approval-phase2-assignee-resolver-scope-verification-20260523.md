# Approval Phase 2 AssigneeResolver Scope Verification 2026-05-23

Scope: docs-only scope gate for the first Phase 2 slice
Branch: `codex/approval-assignee-resolver-scope-20260523`
Base: `origin/main@66394a167`

## Summary

This verification confirms that the scope gate is grounded in current `origin/main` code and does not implement runtime changes.

The gate intentionally narrows the YiDA benchmark Phase 2 entry point to `ApprovalAssigneeResolver` only. It does not restart add-sign, trigger bindings, result backwrite, automation `start_approval`, or Workflow Designer mapping.

## Commands Run

```bash
git fetch origin main --prune
git status --short --branch
git rev-list --left-right --count HEAD...origin/main
nl -ba packages/core-backend/src/types/approval-product.ts | sed -n '1,125p'
nl -ba packages/core-backend/src/services/ApprovalGraphExecutor.ts | sed -n '108,122p;736,782p;1004,1042p'
nl -ba packages/core-backend/src/services/ApprovalProductService.ts | sed -n '570,615p;2338,2416p;3438,3458p'
nl -ba packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts | sed -n '82,102p'
nl -ba packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts | sed -n '106,114p'
git grep -n "ApprovalAssigneeResolver\\|approval_trigger_bindings\\|start_approval\\|approval\\.approved\\|automation_execution_attempts\\|automation_jobs\\|approval_deadlines\\|approval_countersign_tasks" HEAD -- packages/core-backend/src packages/core-backend/tests apps/web/src
git grep -n "idx_approval_assignments_active_unique\\|duplicate approver\\|cross_branch_adjacency_conflict" HEAD -- packages/core-backend/src/services/ApprovalProductService.ts docs/development/approval-pr2-*
git diff --check
```

## Evidence

| Check | Result |
|---|---|
| Current approval node shape | `ApprovalNodeConfig` has `assigneeType`, `assigneeIds`, `approvalMode`, `emptyAssigneePolicy`, `autoApprovalPolicy`; no `assigneeSources` yet. |
| Current empty-assignee shape | `EmptyAssigneePolicy = 'error' | 'auto-approve'`; no skip/escalate/fallback in runtime types. |
| Current executor behavior | `ApprovalGraphExecutor` synchronously maps `assigneeIds` to assignments in initial and node-entry paths. |
| Current assignment insert | `ApprovalProductService.insertAssignments()` writes `assignment_type`, `assignee_id`, `source_step`, `node_key`, and empty JSON metadata. |
| Active unique invariant | `idx_approval_assignments_active_unique` is unique on `(instance_id, assignment_type, assignee_id)` for active rows. |
| Phase 2 absent namespaces | No runtime hits for `ApprovalAssigneeResolver`, `approval_trigger_bindings`, `start_approval`, `approval.approved`, `automation_execution_attempts`, `automation_jobs`, `approval_deadlines`, or `approval_countersign_tasks`. |
| Form user field | Frontend user picker writes a single user id string; backend validation also accepts object values for `type='user'`. |
| PR4 add-sign status | Add-sign remains a worksplit/ADR-first deferred item; no runtime countersign table or service exists. |
| Base freshness | `git rev-list --left-right --count HEAD...origin/main` returned `0 0`; this docs branch is on current `origin/main`. |

## Verification Result

PASS for docs-only scope gate:

- No runtime files were changed.
- No migrations were added.
- The gate's expected files and do-not-cross lines match current code shape.
- The required test matrix covers the main implementation hazards: backward compatibility, version freeze, PR2 auto-approval composition, PR3 admin-jump composition, hidden/pruned form data, and dynamic parallel duplicate collisions.
- The gate records the actual migration path under `packages/core-backend/src/db/migrations`, avoiding the old shorthand `src/migrations` path.
- Runtime grep confirms this is a docs-only scope gate; the resolver and Phase 2 trigger/backwrite/automation namespaces are not present yet.

## Remaining Gate

Implementation must not begin unless the decisions G1-G8 in `approval-phase2-assignee-resolver-scope-gate-20260523.md` are accepted.

If implementation discovers that a migration, UI, or async DB-backed resolver is required, stop and revise the scope gate first.
