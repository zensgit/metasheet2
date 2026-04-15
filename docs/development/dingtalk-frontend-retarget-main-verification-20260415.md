## Verification

### Passed

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run --watch=false tests/LoginView.spec.ts tests/userManagementView.spec.ts --reporter=dot
```

## Scope

- This retarget sync was a clean merge from `origin/main`.
- Validation focuses on the DingTalk frontend entry points touched by this PR stack.
