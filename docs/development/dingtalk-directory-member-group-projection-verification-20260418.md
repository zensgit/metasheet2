# DingTalk Directory Member Group Projection Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-member-group-projection.test.ts tests/unit/directory-sync-auto-admission.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-review-items.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend tests

- `tests/unit/directory-sync-member-group-projection.test.ts`
- `tests/unit/directory-sync-auto-admission.test.ts`
- `tests/unit/admin-directory-routes.test.ts`
- `tests/unit/directory-sync-bind-account.test.ts`
- `tests/unit/directory-sync-review-items.test.ts`

Result:

- `5 files passed`
- `37 passed`

Covered in this round:

- selected department subtree -> projected member-user set;
- disabled projection mode -> no plans;
- auto-admission include/exclude behavior still intact;
- existing bind/unbind and review flows still intact.

### Frontend tests

- `tests/directoryManagementView.spec.ts`

Result:

- `1 file passed`
- `32 passed`

Covered in this round:

- integration payload now includes member-group sync fields;
- sync success messaging includes member-group projection stats;
- existing manual bind / admission / review UI still intact.

### Builds

- `pnpm --filter @metasheet/core-backend build` — passed
- `pnpm --filter @metasheet/web build` — passed

Observed existing non-blocking warnings:

- frontend Vitest prints `WebSocket server error: Port is already in use`
- Vite build still prints existing chunk-size warnings

Neither warning was introduced by this change.

## Deployment

No remote deployment was performed in this round.
