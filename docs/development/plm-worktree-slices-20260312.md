# PLM Worktree Slices (2026-03-12)

## Scope

This file summarizes the current change slices inside:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`
- branch: `codex/plm-workbench-collab-20260312`

The goal is to keep `PLM` work moving in this worktree while attendance continues elsewhere.

## Current Validation Status

Validated successfully in this worktree:

- `pnpm install`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-workbench-team-views.test.ts tests/unit/plm-approval-bridge.test.ts`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-route-models.test.ts tests/unit/workflow-designer-drafts.test.ts tests/unit/workflow-hub-team-views.test.ts`

Important finding:

- the PLM worktree needed a minimal workflow subset to stay self-consistent because the shell and backend already route `/workflows`, `/approvals`, and workflow designer endpoints.

## Logical Change Slices

### 1. PLM frontend slice

Primary files:

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/components/plm/`
- `apps/web/src/views/plm/`
- `apps/web/src/services/PlmService.ts`
- `apps/web/src/services/plm/`
- `apps/web/src/views/plmAuditQueryState.ts`
- `apps/web/src/views/plmAuditSavedViews.ts`
- `apps/web/tests/plm*.spec.ts`
- `apps/web/tests/usePlm*.spec.ts`

Notes:

- this is the biggest functional slice
- `PlmProductView.vue` is the dominant refactor payload
- this slice is commit-worthy on its own

### 2. PLM backend slice

Primary files:

- `packages/core-backend/src/plm/`
- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/src/federation/plm-approval-bridge.ts`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/src/db/migrations/*plm*`
- `packages/core-backend/tests/unit/plm-*.test.ts`
- `packages/core-backend/tests/unit/federation.contract.test.ts`
- `packages/core-backend/tests/fixtures/federation/`
- `packages/core-backend/scripts/test-plm-connection.ts`

Notes:

- this is the cleanest backend slice
- it owns presets, team views, collaborative audit, and bridge mapping

### 3. Workflow support slice

Primary files:

- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/src/views/WorkflowHubView.vue`
- `apps/web/src/views/workflowDesigner*.ts`
- `apps/web/src/views/workflowHub*.ts`
- `apps/web/tests/workflowDesigner*.spec.ts`
- `apps/web/tests/workflowHub*.spec.ts`
- `packages/core-backend/src/routes/workflow-designer.ts`
- `packages/core-backend/src/workflow/`
- `packages/core-backend/src/db/migrations/*workflow*`
- `packages/core-backend/tests/unit/workflow-*.test.ts`
- `packages/openapi/src/paths/workflow-designer.yml`

Notes:

- this is no longer truly optional if the PLM shell keeps workflow entrypoints enabled
- if desired, it can still be split into its own follow-up commit after the core PLM slice

### 4. Shared shell and SDK slice

Primary files:

- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/utils/api.ts`
- `apps/web/src/plugins/viewRegistry.ts`
- `apps/web/src/views/ApprovalInboxView.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/HomeRedirect.vue`
- `apps/web/src/views/PluginManagerView.vue`
- `apps/web/src/views/PluginViewHost.vue`
- `apps/web/src/views/TestFormula.vue`
- `apps/web/package.json`
- `apps/web/.eslintrc.cjs`
- `apps/web/vite.config.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/di/container.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/routes/comments.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/src/services/HealthAggregatorService.ts`
- `packages/openapi/dist-sdk/`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`

Notes:

- this slice binds the PLM workbench into the shared app shell
- keep it separate from pure PLM logic if clean reviewability matters

### 5. Documentation slice

Primary files:

- `docs/development/*plm*.md`
- `docs/development/*workflow*.md`
- `docs/verification-plm-ui-regression-*.md`
- `docs/verification-index.md`

Notes:

- large but low-risk
- best committed after code slices are stable

### 6. Noise slice

Do not treat these as product changes:

- `plugins/*/node_modules/*`

These should not be included in a real PLM commit.

## Recommended Commit Order

### Recommended order for commit-ready grouping

1. `feat(plm): extract workbench frontend modules and audit views`
2. `feat(plm): add workbench backend routes, presets, team views, and bridge helpers`
3. `feat(workflow): carry workflow hub/designer support required by plm shell`
4. `chore(shell): align app shell, auth bootstrap, sdk wiring, and package scripts`
5. `docs(plm): add split inventory, execution notes, and validation reports`

## Immediate Cleanup Recommendation

Before committing:

1. ignore the `plugins/*/node_modules/*` changes
2. review whether `pnpm-lock.yaml` changed only because of install noise or because the carried package graph genuinely changed
3. keep `docs` separate from the first functional commit if smaller review units are preferred

## Practical Next Step

The best next implementation step is:

- continue development from the `PLM frontend` and `PLM backend` slices
- do not add more platform-wide scope before the first PLM worktree commit series is stabilized
