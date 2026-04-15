## Verification

### Passed

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run --watch=false tests/LoginView.spec.ts tests/userManagementView.spec.ts --reporter=dot
```

- Result: `7/7` tests passed

## Environment Notes

- The isolated worktree needed local `node_modules` symlinks to the main repo for `vue-tsc` and `vitest` resolution.
- Vitest emitted a non-blocking Vite WebSocket `EPERM` warning while still completing both target test files successfully.
