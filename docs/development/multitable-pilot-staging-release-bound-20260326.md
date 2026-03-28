# Multitable Pilot Staging Release-Bound

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Finish the staging-safe pilot chain above readiness, so bound artifacts and operator replay commands stop assuming a local-only execution mode.

## Problem

After the previous slice:

- staging had `verify:multitable-pilot:staging`
- staging had `verify:multitable-pilot:ready:staging`
- but release-bound wrappers and operator commands still defaulted to:
  - `multitable-pilot-ready-local`
  - `prepare:multitable-pilot:release-bound`
  - `verify:multitable-pilot:ready:local:release-bound`

That meant staging could produce readiness, but the next layer still pointed operators back to local-mode commands and directories.

## Design

### 1. Make release-bound wrappers mode-aware

`scripts/ops/multitable-pilot-ready-release-bound.sh` now switches on `RUN_MODE`:

- `local` -> `scripts/ops/multitable-pilot-ready-local.sh`
- `staging` -> `scripts/ops/multitable-pilot-ready-staging.sh`

`scripts/ops/multitable-pilot-handoff-release-bound.sh` now forwards:

- `PILOT_RUN_MODE=staging`

to the handoff generator, so default latest-root lookup can follow staging runs instead of local-only roots.

### 2. Make bound output roots mode-aware

`scripts/ops/multitable-pilot-release-bound.sh` now derives default roots from `RUN_MODE`:

- local:
  - `output/playwright/multitable-pilot-ready-local/...`
  - `output/playwright/multitable-pilot-handoff/...`
  - `output/playwright/multitable-pilot-release-bound/...`
- staging:
  - `output/playwright/multitable-pilot-ready-staging/...`
  - `output/playwright/multitable-pilot-handoff-staging/...`
  - `output/playwright/multitable-pilot-release-bound-staging/...`

### 3. Promote staging commands into canonical operator replay

New package scripts:

- `verify:multitable-pilot:ready:staging:release-bound`
- `prepare:multitable-pilot:handoff:staging:release-bound`
- `prepare:multitable-pilot:release-bound:staging`

The generated release-bound operator helper now emits the right replay command set for the active run mode instead of hardcoding local-only commands.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n \
  scripts/ops/multitable-pilot-ready-release-bound.sh \
  scripts/ops/multitable-pilot-handoff-release-bound.sh \
  scripts/ops/multitable-pilot-release-bound.sh
node --test \
  scripts/ops/multitable-pilot-release-bound-wrappers.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

## Outcome

Staging is no longer just a smoke/readiness side path. It now has a consistent bound-artifact execution surface with correct defaults, correct package commands, and correct operator replay guidance.
