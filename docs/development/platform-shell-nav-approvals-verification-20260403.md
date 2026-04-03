# Platform Shell Nav / Approvals Follow-up Verification

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/App.spec.ts tests/platform-shell-nav.spec.ts tests/approval-inbox-auth-guard.spec.ts tests/featureFlags.plm.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- `vitest`: passed
- `vue-tsc --noEmit`: passed
- `pnpm --filter @metasheet/web build`: passed
- `git diff --check`: passed

## Verified Behavior

- Platform users with attendance enabled now see an explicit `/attendance` nav entry.
- Platform users default to `/attendance` when PLM is disabled.
- `/approvals` remains registered in the main app shell.
- PLM nav links stay hidden when the shell reports `plm=false`.
