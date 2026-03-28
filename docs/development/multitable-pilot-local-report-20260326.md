# Multitable Pilot Local Report

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Promote `scripts/ops/multitable-pilot-local.sh` from a thin runner wrapper into a canonical local/staging-ready artifact producer:

- keep the raw runner `report.json`
- also emit a wrapper-level `local-report.json`
- emit a human-readable `local-report.md`
- fail loudly if the runner exits without writing its expected report

This makes local pilot and staging rehearsal runs much easier to inspect than only reading raw smoke output or scrolling shell logs.

## Problem

Before this slice:

- `multitable-pilot-local.sh` only started/reused services and executed the runner
- success was only visible in shell output
- there was no canonical wrapper artifact that summarized:
  - backend/web reuse vs startup
  - runner script used
  - embed-host acceptance state
  - runner report path
- if the runner exited 0 but forgot to write `report.json`, the wrapper would still print success

That was weaker than the already-hardened readiness / release-gate / handoff layers.

## Design

### 1. Keep the raw runner report as source of truth

The wrapper still writes the runner report to:

- `${OUTPUT_ROOT}/${REPORT_NAME}`

No schema changes are imposed on the runner itself.

### 2. Add wrapper-level summary artifacts

After a successful runner execution, `multitable-pilot-local.sh` now writes:

- `${OUTPUT_ROOT}/local-report.json`
- `${OUTPUT_ROOT}/local-report.md`

These summarize:

- `runLabel`
- `runnerScript`
- `outputRoot`
- `apiBase`
- `webBase`
- `serviceModes.backend`
- `serviceModes.web`
- raw runner report location
- top-level embed-host protocol / navigation / deferred-replay status

The embed-host summaries reuse the same check groupings already used by:

- release-gate
- readiness
- handoff
- release-bound

### 3. Make missing runner artifacts fatal

If the runner exits successfully but does not write `${OUTPUT_ROOT}/${REPORT_NAME}`, the wrapper now exits non-zero.

This prevents false-green local rehearsal runs.

### 4. Keep the wrapper generic

`profile:multitable-grid:local` also reuses `multitable-pilot-local.sh`, so the wrapper report does **not** require embed-host evidence to exist.

Instead:

- if embed-host checks are present, they are summarized
- if they are absent, the embed-host summary stays `available: false`
- the wrapper still remains valid for non-smoke local runners

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n scripts/ops/multitable-pilot-local.sh
node --test scripts/ops/multitable-pilot-local.test.mjs
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

Results:

- shell syntax check passed
- `multitable-pilot-local.test.mjs` passed
- frontend `tsc --noEmit` passed
- frontend build passed

New regression coverage:

- success path writes both `local-report.json` and `local-report.md`
- embed-host acceptance is summarized in the local wrapper artifact
- missing raw runner report now fails the wrapper instead of silently printing success

## Outcome

Local and staging rehearsal runs now have a first-class wrapper artifact, not just a raw smoke report. That makes pre-deploy validation easier to inspect and aligns the local runner with the stricter artifact discipline already used in the rest of the multitable pilot chain.
