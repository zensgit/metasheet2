# K3 WISE PoC Sample Limit Guard Verification - 2026-05-07

## Commands

```bash
node --check scripts/ops/integration-k3wise-live-poc-preflight.mjs
node --check scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
git diff --check
```

## Result

- Preflight + evidence node tests: 48/48 passed.
- `k3WiseSetup.spec.ts`: 20/20 passed.
- `git diff --check`: passed.

## Environment Note

The temporary worktree initially lacked linked `node_modules`, so the first web Vitest attempt failed with `Command "vitest" not found`. I ran `pnpm install --frozen-lockfile --ignore-scripts` in the temporary worktree to link dependencies, then restored install-generated `node_modules` symlink churn before staging code.

## Coverage Added

- Preflight accepts only material sample limits from 1 to 3.
- Preflight rejects numeric strings and numbers outside the 1 to 3 PoC boundary.
- Frontend helper rejects live PoC sample limits above 3.
- Existing evidence test remains aligned with the same row-count contract.

