# Multitable Run11 Polish Follow-up Verification

Date: 2026-04-04

## Targeted checks

```bash
bash -n scripts/ops/multitable-onprem-apply-package.sh
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh

pnpm install --frozen-lockfile

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "maps standard work_date/check_in/check_out CSV headers through preview and commit" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit

pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts -t "surfaces punch-too-soon failures with status code, hint, and retry affordance" --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit

PACKAGE_TAG=run12-20260404 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Notes

- `pwsh` is not installed in the current macOS workspace, so PowerShell syntax was validated by code review plus package gate coverage rather than local parser execution.
- The backend import regression test now proves preview and commit both accept `user_id/work_date/check_in/check_out`.
- The frontend self-service regression test now proves punch failures surface code, hint, and retry affordance instead of failing silently.
