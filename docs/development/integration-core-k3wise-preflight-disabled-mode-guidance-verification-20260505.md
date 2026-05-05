# K3 WISE Preflight Disabled SQL Mode Guidance Verification - 2026-05-05

## Worktree

`/private/tmp/ms2-k3wise-disabled-mode-20260505`

Branch:

`codex/k3wise-preflight-disabled-mode-20260505`

Baseline:

`origin/main` at worktree creation.

## Verification Plan

Run the focused preflight test suite and the existing K3 WISE offline PoC chain:

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
pnpm run verify:integration-k3wise:poc
git diff --check
```

## Coverage Added

- `sqlServer.enabled=true` and `sqlServer.mode=disabled` now throws a targeted `LivePocPreflightError`.
- The assertion checks the operator-facing remediation text:
  - set `sqlServer.enabled=false`, or
  - choose `readonly`, `middle-table`, or `stored-procedure`.
- The assertion also checks machine-readable details:
  - `field === "sqlServer.mode"`
  - `sqlServerEnabled === true`
  - `acceptedModes` includes `readonly`.

## Results

All planned commands passed:

- `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
  - 17/17 passed.
  - New coverage: `buildPacket explains disabled SQL mode requires sqlServer.enabled=false`.
- `pnpm run verify:integration-k3wise:poc`
  - preflight tests: 17/17 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`
  - passed.

Runbook lookup coverage was also added:

- `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
  - §9.8 now maps the exact `sqlServer.mode=disabled requires sqlServer.enabled=false` error to the operator fix.
  - The fix says to set `sqlServer.enabled=false` when disabling the channel, or choose `readonly`, `middle-table`, or `stored-procedure` when enabling it.

## Not Covered

- Real customer SQL Server connectivity.
- Real K3 WISE connectivity.
- Any UI copy change; #1305 owns the setup UI surface.
