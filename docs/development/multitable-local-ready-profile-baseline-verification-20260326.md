# Multitable Local Ready Profile Baseline Verification

Date: 2026-03-26

## Goal

Prove that:

1. `ready-local` uses the relaxed local profile baseline.
2. `ready-staging` remains on the stricter staging baseline.
3. The real local delivery chain now completes past the profile step and writes readiness artifacts.

## Verification

### 1. Focused ready-local wrapper test

Command:

```bash
pnpm verify:multitable-pilot:ready:local:test
```

Expected:

- the local wrapper test passes
- the generated `profile/summary.md` shows:
  - `ui.grid.open` passing at `500ms`
  - `api.grid.initial-load` passing at `75ms`
  - `api.grid.search-hit` passing at `75ms`

### 2. Staging wrapper guard still holds

Command:

```bash
pnpm verify:multitable-pilot:ready:staging:test
```

Expected:

- staging wrapper tests still pass unchanged
- `RUN_MODE=staging` remains wired into release-gate/readiness

### 3. Script syntax

Command:

```bash
bash -n scripts/ops/multitable-pilot-ready-local.sh scripts/ops/multitable-pilot-ready-staging.sh
```

Expected:

- shell syntax passes

### 4. Real local delivery chain

Command:

```bash
PILOT_DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_multitable_pilot_v3' pnpm verify:multitable-pilot:ready:local
```

Observed:

- command passed on the real local pilot database
- readiness artifacts were written to:
  - [`readiness.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-143812/readiness.json)
  - [`readiness.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-143812/readiness.md)
  - [`gates/report.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-143812/gates/report.json)
  - [`gates/report.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-143812/gates/report.md)
- the final profile summary passed with:
  - `ui.grid.open = 362.94ms <= 500ms`
  - `ui.grid.search-hit = 293.35ms <= 300ms`
  - `api.grid.initial-load = 54.56ms <= 75ms`
  - `api.grid.search-hit = 61.46ms <= 75ms`

### 5. On-prem gate, handoff, and release-bound

Commands:

```bash
pnpm build:multitable-onprem-package
pnpm verify:multitable-onprem:release-gate
READINESS_ROOT='/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-143812' pnpm prepare:multitable-pilot:handoff
ONPREM_GATE_STAMP='20260326-144108' ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound
```

Observed:

- on-prem package built successfully:
  - [`metasheet-multitable-onprem-v2.5.0-20260326-144031.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-20260326-144031.json)
- on-prem release gate passed:
  - [`report.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/releases/multitable-onprem/gates/20260326-144108/report.json)
  - [`report.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/releases/multitable-onprem/gates/20260326-144108/report.md)
- handoff passed:
  - [`handoff.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-handoff/20260326-143812/handoff.json)
  - [`handoff.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-handoff/20260326-143812/handoff.md)
- release-bound passed:
  - [`report.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-release-bound/20260326-144138/report.json)
  - [`report.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-release-bound/20260326-144138/report.md)
  - release-bound readiness:
    - [`readiness.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-144138-release-bound/readiness.json)
    - [`readiness.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-ready-local/20260326-144138-release-bound/readiness.md)

## Notes

This verification shows the local baseline split is not just unit-tested; it unblocks the real local delivery chain all the way through release-bound while keeping staging tests unchanged.
