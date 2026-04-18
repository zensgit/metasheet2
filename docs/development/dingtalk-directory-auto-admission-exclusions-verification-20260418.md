# DingTalk Directory Auto Admission Exclusions Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-auto-admission.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-review-items.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend tests

- `tests/unit/directory-sync-auto-admission.test.ts`
- `tests/unit/admin-directory-routes.test.ts`
- `tests/unit/directory-sync-bind-account.test.ts`
- `tests/unit/directory-sync-review-items.test.ts`

Result:

- `4 files passed`
- `35 passed`

Coverage of this round:

- allowlisted descendant matches;
- excluded department overrides included parent;
- missing-email in-scope candidate stays unmatched;
- existing directory admin routes and bind flows remain intact.

### Frontend tests

- `tests/directoryManagementView.spec.ts`

Result:

- `1 file passed`
- `32 passed`

Coverage of this round:

- directory integration payload still builds correctly;
- manual sync feedback now includes excluded-member counts;
- existing review/bind/manual-admission flows remain intact.

### Builds

- `pnpm --filter @metasheet/core-backend build` — passed
- `pnpm --filter @metasheet/web build` — passed

Observed existing non-blocking warnings:

- Vitest frontend run prints `WebSocket server error: Port is already in use`
- Vite build still prints existing chunk-size warnings

Neither warning was introduced by this change.

## Deployment

No remote deployment was performed in this round.
