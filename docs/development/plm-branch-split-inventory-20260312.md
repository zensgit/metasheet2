# PLM Branch Split Inventory (2026-03-12)

## Purpose

This note records the real state of the current worktree so `attendance` can continue in the other window while this window moves forward on `PLM` safely.

## Current Branch And Worktree Facts

- Current worktree: `/Users/huazhou/Downloads/Github/metasheet2`
- Current branch: `codex/attendance-pr396-pr399-delivery-md-20260310`
- Current `HEAD`: `ddcfcc9db3358d1c1808a4cc0db1697861b541bc`
- Latest checkout recorded in this worktree: `2026-03-10 10:27:05 +0800`, from `main` to `codex/attendance-pr396-pr399-delivery-md-20260310`
- There is no later checkout in this worktree after that point; recent work here accumulated as uncommitted changes on top of the attendance branch.

## Important Branch Findings

### 1. This directory is still the attendance branch worktree

The current repo path has not been switched to a newer PLM branch after `2026-03-10`.

### 2. Newer branches do exist, but they are mostly attendance-oriented

Current repo worktrees show newer attendance lines such as:

- `codex/attendance-perf-gate-stability-20260312`
- `codex/attendance-parallel-round24-docs`
- `codex/attendance-parallel-20260311`
- `fix/attendance-admin-error-localization`

### 3. Older PLM branches are historical references, not the right continuation point

Older PLM branches/worktrees still exist:

- `feat/plm-eco`
- `feat/plm-approvals-history-codex-yuantus`
- `chore/plm-ui-retention-cleanup`

But those older branches do **not** contain the newer modular PLM workbench code now present in this dirty worktree, especially:

- `apps/web/src/views/plm/`
- `apps/web/src/services/plm/`
- `packages/core-backend/src/plm/`
- `packages/core-backend/src/routes/plm-workbench.ts`

So the current PLM continuation should **not** restart from those old branches.

## Current Dirty Worktree Classification

Status snapshot at time of reading:

- total changed paths: `319`
- modified tracked files: `83`
- untracked files: `236`

Practical buckets:

- `PLM-only`: `157`
- `PLM-required-shared`: `43`
- `attendance-only`: `14`
- `workflow-optional`: `63`
- `noise/generated`: `35`

## Files That Should Move To A New PLM Branch

These are the files that represent the actual new PLM line and should be treated as the base of the new PLM worktree.

### A. PLM-only frontend modules

- `apps/web/src/components/plm/`
- `apps/web/src/views/plm/`
- `apps/web/src/services/plm/`
- `apps/web/src/services/PlmService.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditQueryState.ts`
- `apps/web/src/views/plmAuditSavedViews.ts`

### B. PLM-only frontend tests

- `apps/web/tests/plm*.spec.ts`
- `apps/web/tests/usePlm*.spec.ts`

### C. PLM-only backend modules

- `packages/core-backend/src/plm/`
- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/src/federation/plm-approval-bridge.ts`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/scripts/test-plm-connection.ts`
- `packages/core-backend/tests/fixtures/federation/`
- `packages/core-backend/tests/unit/federation.contract.test.ts`
- `packages/core-backend/tests/unit/plm-*.test.ts`

### D. PLM-only migrations

- `packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309150000_create_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts`

### E. PLM design and verification documents

- `docs/development/*plm*.md`
- `docs/verification-plm-ui-regression-*.md`

## Shared Files PLM Still Needs

These are not purely PLM-named files, but the current PLM workbench line depends on them and they should move with the PLM branch unless intentionally reworked.

### Frontend shell and routing

- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/utils/api.ts`
- `apps/web/src/plugins/viewRegistry.ts`
- `apps/web/src/views/HomeRedirect.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/ApprovalInboxView.vue`
- `apps/web/src/views/PluginManagerView.vue`
- `apps/web/src/views/PluginViewHost.vue`
- `apps/web/package.json`
- `apps/web/.eslintrc.cjs`
- `apps/web/vite.config.ts`
- `apps/web/tests/featureFlags.spec.ts`
- `apps/web/tests/useAuth.spec.ts`
- `apps/web/tests/utils/api.test.ts`

### Backend registration and auth surface

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/di/container.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/routes/comments.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/src/services/HealthAggregatorService.ts`
- `packages/core-backend/tests/unit/AuthService.test.ts`

### SDK and workspace wiring

- `packages/openapi/dist-sdk/`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`

### Environment and verification references

- `docker/app.env.example`
- `docs/verification-index.md`
- `docs/development/federation-integration-status-20260308.md`

## Files That Should Stay With The Attendance Window

These changes belong to the attendance delivery line and should not be carried into the new PLM branch unless there is a deliberate cross-product reason.

- `apps/web/src/views/AttendanceView.vue`
- `packages/openapi/src/paths/attendance.yml`
- `scripts/ops/deploy-attendance-prod.sh`
- `docs/attendance-*.md`
- `docs/deployment/attendance-*.md`

## Workflow Files: Optional, Not Mandatory

These files are real new work, but they are a separate platform/workflow line rather than strictly PLM-only.

If the new PLM branch is meant to continue the integrated `PLM + workflow/approval workbench` direction, keep them. If the goal is a narrower PLM-only branch, leave them out for now.

### Optional workflow frontend

- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/src/views/WorkflowHubView.vue`
- `apps/web/src/views/workflowDesigner*.ts`
- `apps/web/src/views/workflowHub*.ts`
- `apps/web/tests/workflowDesigner*.spec.ts`
- `apps/web/tests/workflowHub*.spec.ts`

### Optional workflow backend

- `packages/core-backend/src/routes/workflow-designer.ts`
- `packages/core-backend/src/workflow/`
- `packages/core-backend/tests/unit/workflow-*.test.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts`
- `packages/openapi/src/paths/workflow-designer.yml`
- `docs/development/workflow*.md`

### Recommendation on this bucket

For the current split, the safer default is:

- carry `ApprovalInboxView.vue` with PLM because the PLM shell already links `/approvals`
- keep `WorkflowHubView.vue`, `WorkflowDesigner.vue`, and the heavier workflow designer line as **optional**
- only move the workflow stack if this window will continue explicit `PLM + workflow workbench` integration work

## Noise And Generated Files To Ignore

These should not be treated as branch-shaping business changes.

- `plugins/*/node_modules/`
- `.playwright-cli/`
- `output/releases/`
- `packages/openapi/dist/`
- `apps/web/src/auto-imports.d.ts`
- `apps/web/src/components.d.ts`

## Recommended Branch Strategy

### Do not keep developing PLM in this current worktree

Reasons:

- the branch name and commit history are attendance-oriented
- another window is already using attendance work in parallel
- this worktree contains mixed attendance and PLM changes
- restarting later will keep making branch history harder to reconstruct

### Recommended next branch

Use a new dedicated branch and worktree, for example:

- `codex/plm-workbench-collab-20260312`

### Recommended new worktree path

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Safe Transfer Plan

Because the current PLM work is still uncommitted in this worktree, do **not** switch branches here.

Suggested approach:

1. Keep the current attendance worktree untouched.
2. Create a fresh worktree from current `HEAD`.
3. Copy only the `PLM-only` + `PLM-required-shared` files into that new worktree.
4. Add the `workflow-optional` bucket only if this PLM branch will continue workflow integration.
5. Leave `attendance-only` and `noise/generated` behind.

## Practical Carry Sets

### Minimum PLM carry set

- all `PLM-only` files
- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/utils/api.ts`
- `apps/web/src/views/ApprovalInboxView.vue`
- `apps/web/package.json`
- `apps/web/.eslintrc.cjs`
- `apps/web/vite.config.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/di/container.ts`
- `packages/openapi/dist-sdk/`
- `pnpm-workspace.yaml`

### Broader PLM + workflow carry set

Take the minimum PLM carry set plus:

- `apps/web/src/views/WorkflowHubView.vue`
- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/src/views/workflowDesigner*.ts`
- `apps/web/src/views/workflowHub*.ts`
- `packages/core-backend/src/routes/workflow-designer.ts`
- `packages/core-backend/src/workflow/`
- workflow migrations
- workflow tests
- `packages/openapi/src/paths/workflow-designer.yml`

## Final Recommendation

For the next step:

- attendance should continue in the other window/worktree
- this window should move to a new dedicated PLM branch/worktree
- that new branch should start from the **current dirty PLM state**, not from old `feat/plm-eco`
- carry the `PLM-only` and `PLM-required-shared` buckets first
- treat the `workflow-optional` bucket as a deliberate second decision, not as default carry
