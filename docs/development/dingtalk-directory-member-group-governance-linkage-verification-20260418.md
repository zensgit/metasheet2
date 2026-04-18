# DingTalk Directory Member Group Governance Linkage Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-member-group-role-sync-20260418`
- Branch: `codex/dingtalk-member-group-role-sync-20260418`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-member-group-projection.test.ts tests/unit/admin-directory-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend tests

- `tests/unit/directory-sync-member-group-projection.test.ts`
- `tests/unit/admin-directory-routes.test.ts`

Result:

- `2 files passed`
- `23 passed`

Covered in this round:

- projected member groups still derive linked local users from selected
  department subtrees;
- governance grant planning dedupes users, role IDs, and namespaces;
- admin-directory integration payload round-trip accepts the new governance
  config fields.

### Frontend tests

- `tests/directoryManagementView.spec.ts`

Result:

- `1 file passed`
- `32 passed`

Covered in this round:

- integration test/save payload now carries member-group default role IDs and
  namespace admissions;
- sync success feedback includes governed-user counts and additive role/plugin
  grant counts;
- existing directory management review/admission flows remain intact.

Observed existing non-blocking warning:

- Vitest prints `WebSocket server error: Port is already in use`

This warning was already present before this change and did not affect test
results.

### Builds

- `pnpm --filter @metasheet/core-backend build` — passed
- `pnpm --filter @metasheet/web build` — passed

Observed existing non-blocking warnings:

- Vite prints a dynamic import chunking note for `WorkflowDesigner.vue`
- Vite prints existing chunk-size warnings

Neither warning was introduced by this change.

## Deployment

No remote deployment was performed in this round.
