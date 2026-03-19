# Multitable Internal Pilot Runbook

Date: 2026-03-19  
Scope: Feishu-style multitable internal pilot  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable`

## Goal

Use the existing pilot smoke, grid profile, and threshold summary as the release gate for the first internal multitable pilot.

This runbook does not add new product functionality. It standardizes how to decide whether a branch is safe to hand to pilot users.

## Readiness Commands

### Local one-shot readiness

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ENSURE_PLAYWRIGHT=false pnpm verify:multitable-pilot:ready:local
```

This runs, in order:

1. `pnpm verify:multitable-pilot:local`
2. `pnpm profile:multitable-grid:local`
3. `pnpm verify:multitable-grid-profile:summary`
4. `pnpm verify:multitable-pilot:readiness`

Artifacts are written under:

```text
output/playwright/multitable-pilot-ready-local/<timestamp>/
```

Key outputs:

- `smoke/report.json`
- `profile/report.json`
- `profile/summary.md`
- `readiness.md`
- `readiness.json`

### CI readiness

GitHub Actions workflow:

```text
.github/workflows/multitable-pilot-e2e.yml
```

It runs:

1. pilot smoke
2. 2000-row grid profile
3. profile threshold summary

Uploaded artifact root:

```text
output/playwright/multitable-pilot-local
output/playwright/multitable-grid-profile-local
```

## Local Environment

Default local endpoints:

- backend: `http://127.0.0.1:7778`
- frontend: `http://127.0.0.1:8899`

When using the local dev-token flow, backend must allow trusted RBAC token claims:

```bash
RBAC_TOKEN_TRUST=true pnpm --filter @metasheet/core-backend dev
```

If you use a real admin token, `RBAC_TOKEN_TRUST=true` is not required.

## Current Acceptance Bar

Smoke must pass all of these:

- `ui.grid.import`
- `ui.person.assign`
- `ui.form.upload-comments`
- `ui.grid.search-hydration`
- `ui.conflict.retry`

Grid profile thresholds:

- `ui.grid.open <= 350ms`
- `ui.grid.search-hit <= 300ms`
- `api.grid.initial-load <= 25ms`
- `api.grid.search-hit <= 25ms`

## Pilot Entry Checklist

Use this checklist before handing the branch to a real team:

1. Run `pnpm verify:multitable-pilot:ready:local`
2. Confirm `readiness.md` says `Overall: PASS`
3. Confirm profile was run at `ROW_COUNT=2000`
4. Confirm smoke report includes attachment, person preset, comments, and conflict retry
5. Confirm no local-only flags are required for the target environment, except the documented dev-token `RBAC_TOKEN_TRUST=true` case

## Current Pilot Recommendation

The branch is suitable for a first internal pilot when the readiness gate is green.

Do not expand feature scope before pilot feedback. The highest-value next step is to collect real user behavior against the existing gate:

- import
- linked person assignment
- attachment upload
- form submit
- search
- conflict recovery

## Known Limits

- Large JS chunks still produce a build warning, but current build passes.
- Local disk pressure can cause transient artifact write failures when free disk space is very low.
- The readiness gate is designed for internal pilot, not public beta or market-complete launch.
