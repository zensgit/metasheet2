## Verification

### Passed

```bash
pnpm --filter @metasheet/web exec eslint src/views/LoginView.vue --max-warnings=0
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run --watch=false tests/LoginView.spec.ts tests/userManagementView.spec.ts --reporter=dot
```

- Result: lint passed
- Result: frontend type-check passed
- Result: `7/7` frontend tests passed
