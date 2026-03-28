# Multitable Local Runner Artifact Promotion

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Promote the new `multitable-pilot-local` wrapper artifact into the formal pilot evidence chain instead of leaving it as a standalone local-only file.

Target artifacts:

- `readiness.json`
- `readiness.md`
- `handoff.json`
- `handoff.md`
- `release-bound/report.json`
- `release-bound/report.md`

## Problem

The previous round added:

- `smoke/local-report.json`
- `smoke/local-report.md`

but those files were still effectively sidecars.

That left two gaps:

1. readiness/handoff/release-bound could not tell whether local rehearsal reused existing services or started fresh ones
2. operators had no top-level reminder that a canonical local wrapper artifact now exists in addition to the raw smoke `report.json`

## Design

### 1. Readiness now accepts the local wrapper artifact explicitly

`scripts/ops/multitable-pilot-readiness.mjs` now reads:

- `SMOKE_LOCAL_REPORT_JSON`
- `SMOKE_LOCAL_REPORT_MD`

and summarizes them into `localRunner` with:

- `required`
- `available`
- `ok`
- `report`
- `reportMd`
- `runnerReport`
- `serviceModes.backend`
- `serviceModes.web`
- `embedHostAcceptance`

If `SMOKE_LOCAL_REPORT_JSON` is explicitly provided but missing, readiness now fails. This keeps `ready-local` honest.

### 2. Ready-local passes the wrapper artifact forward

`scripts/ops/multitable-pilot-ready-local.sh` now binds:

- `SMOKE_LOCAL_REPORT_JSON=${SMOKE_ROOT}/local-report.json`
- `SMOKE_LOCAL_REPORT_MD=${SMOKE_ROOT}/local-report.md`

when invoking readiness.

This makes the local wrapper artifact part of the canonical local-ready bundle instead of an untracked side file.

### 3. Handoff promotes the local runner summary and copies the files

`scripts/ops/multitable-pilot-handoff.mjs` now:

- copies `smoke/local-report.json`
- copies `smoke/local-report.md`
- promotes `readiness.localRunner` into top-level `handoff.json`
- renders a top-level `## Local Pilot Runner` section in `handoff.md`

This keeps local execution context visible during triage and handoff review.

### 4. Release-bound surfaces the same summary compactly

`scripts/ops/multitable-pilot-release-bound.sh` now:

- copies `localRunner` from `handoff.json` into `report.json`
- renders a compact `## Local Pilot Runner` section in `report.md`
- lists the two local runner files in the `Outputs` section

This keeps the release-bound packet consistent with the richer handoff artifact while staying shell-friendly.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --test \
  scripts/ops/multitable-pilot-local.test.mjs \
  scripts/ops/multitable-pilot-readiness.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
bash -n \
  scripts/ops/multitable-pilot-local.sh \
  scripts/ops/multitable-pilot-ready-local.sh \
  scripts/ops/multitable-pilot-release-bound.sh
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

Results:

- local wrapper tests passed
- readiness/handoff/release-bound ops tests passed
- shell syntax checks passed
- frontend `tsc --noEmit` passed
- frontend build passed

## Outcome

The local wrapper artifact is now part of the same canonical evidence chain as readiness, handoff, and release-bound. That gives staging and pilot operators a cleaner first-screen answer to:

- which services were started locally
- where the wrapper artifact lives
- whether the wrapper-level embed-host acceptance already matched the raw smoke result
