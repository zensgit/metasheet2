# Multitable Internal Pilot Runbook

Date: 2026-03-19  
Scope: Feishu-style multitable internal pilot  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable`

## Goal

Use the existing pilot smoke, grid profile, and threshold summary as the release gate for the first internal multitable pilot.

This runbook does not add new product functionality. It standardizes how to decide whether a branch is safe to hand to pilot users.

## Readiness Commands

### Release-bound one-shot

If this pilot handoff must be pinned to one exact on-prem gate and you want readiness plus handoff in one run, use:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_STAMP=<gate-stamp> \
ENSURE_PLAYWRIGHT=false \
pnpm prepare:multitable-pilot:release-bound
```

This produces:

- release-bound readiness
- release-bound handoff
- one summary report under:

```text
output/playwright/multitable-pilot-release-bound/<timestamp>/
```

- `report.md`
- `report.json`

### Local one-shot readiness

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ENSURE_PLAYWRIGHT=false pnpm verify:multitable-pilot:ready:local
```

This runs, in order:

1. `pnpm verify:multitable-pilot:local`
2. `pnpm profile:multitable-grid:local`
3. `pnpm verify:multitable-grid-profile:summary`
4. `pnpm verify:multitable-pilot:release-gate`
5. `pnpm verify:multitable-pilot:readiness`

Artifacts are written under:

```text
output/playwright/multitable-pilot-ready-local/<timestamp>/
```

Key outputs:

- `smoke/report.json`
- `profile/report.json`
- `profile/summary.md`
- `gates/report.json`
- `readiness.md`
- `readiness.json`

If you need readiness itself to be explicitly bound to one on-prem gate report, regenerate it with:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_STAMP=<gate-stamp> \
ENSURE_PLAYWRIGHT=false \
pnpm verify:multitable-pilot:ready:local:release-bound
```

You can still pass a full report path when the gate artifact is outside the default release root:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_REPORT_JSON=/Users/huazhou/Downloads/Github/metasheet2-multitable/output/releases/multitable-onprem/gates/<gate-stamp>/report.json \
ENSURE_PLAYWRIGHT=false \
pnpm verify:multitable-pilot:ready:local:release-bound
```

### Pilot handoff bundle

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
pnpm prepare:multitable-pilot:handoff
```

If you are preparing a release-bound pilot handoff and want to bind it to one explicit on-prem gate instead of auto-discovering the latest one, run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_STAMP=<gate-stamp> \
pnpm prepare:multitable-pilot:handoff:release-bound
```

If you want to bind handoff to a specific readiness run at the same time:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
ONPREM_GATE_STAMP=<gate-stamp> \
READINESS_ROOT=/Users/huazhou/Downloads/Github/metasheet2-multitable/output/playwright/multitable-pilot-ready-local/<ready-stamp> \
pnpm prepare:multitable-pilot:handoff:release-bound
```

This copies the latest readiness run plus pilot docs into:

```text
output/playwright/multitable-pilot-handoff/<timestamp>/
```

Key outputs:

- `handoff.md`
- `handoff.json`
- `readiness.md`
- `readiness.json`
- `smoke/grid-import.png`
- `smoke/grid-import-people-manual-fix.png`
- `smoke/grid-hydrated.png`
- `smoke/form-comments.png`
- `docs/multitable-internal-pilot-runbook-20260319.md`
- `docs/multitable-pilot-quickstart-20260319.md`
- `docs/multitable-pilot-feedback-template-20260319.md`
- `release-gate/operator-commands.sh`
- `release-bound/operator-commands.sh`
- `artifacts/deploy/multitable-onprem-package-install.sh`
- `artifacts/deploy/multitable-onprem-deploy-easy.sh`
- `artifacts/deploy/multitable-onprem-package-install.env.example.sh`
- `artifacts/deploy/multitable-onprem-deploy-easy.env.example.sh`
- `artifacts/preflight/multitable-onprem-preflight.sh`
- `artifacts/preflight/multitable-onprem-preflight.env.example.sh`
- `artifacts/healthcheck/multitable-onprem-healthcheck.sh`
- `artifacts/healthcheck/multitable-onprem-healthcheck.env.example.sh`

The bundled preflight env template now defaults report outputs to:

- `/opt/metasheet/output/preflight/multitable-onprem-preflight.json`
- `/opt/metasheet/output/preflight/multitable-onprem-preflight.md`

### CI readiness

GitHub Actions workflow:

```text
.github/workflows/multitable-pilot-e2e.yml
```

It runs:

1. pilot smoke
2. 2000-row grid profile
3. profile threshold summary
4. pilot readiness summary

Uploaded artifact root:

```text
output/playwright/multitable-pilot-local
output/playwright/multitable-grid-profile-local
```

Readiness outputs in CI:

- `output/playwright/multitable-grid-profile-local/ci/readiness.md`
- `output/playwright/multitable-grid-profile-local/ci/readiness.json`

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

- `ui.route.grid-entry`
- `ui.route.form-entry`
- `ui.import.failed-retry`
- `ui.import.people-manual-fix`
- `api.import.people-manual-fix-hydration`
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

1. Prepare two direct URLs for the pilot owner:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>
/multitable/<sheetId>/<viewId>?baseId=<baseId>&mode=form&recordId=<recordId>
```

Do not ask the pilot team to assemble these URLs manually.

2. Run `pnpm verify:multitable-pilot:ready:local`
   If you need the pilot artifact bundle and explicit gate binding together, prefer `ONPREM_GATE_STAMP=<gate-stamp> pnpm prepare:multitable-pilot:release-bound`
3. Confirm `readiness.md` says `Overall: PASS`
4. If this pilot handoff is tied to a concrete on-prem package, regenerate readiness or handoff with `ONPREM_GATE_STAMP=<gate-stamp>` or `ONPREM_GATE_REPORT_JSON=<gate-report>`
5. Confirm profile was run at `ROW_COUNT=2000`
6. Confirm smoke report includes import retry, people manual-fix, attachment, person preset, comments, and conflict retry
7. Confirm no local-only flags are required for the target environment, except the documented dev-token `RBAC_TOKEN_TRUST=true` case
8. Give the pilot team the feedback template:

```text
docs/deployment/multitable-pilot-feedback-template-20260319.md
```
9. If the team uses GitHub issues for pilot tracking, open:

```text
.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml
```
10. Start the team with:
11. If the pilot is tied to an on-prem rollout, collect these preflight reports before checkpoint, expansion review, or sign-off:

```text
/opt/metasheet/output/preflight/multitable-onprem-preflight.json
/opt/metasheet/output/preflight/multitable-onprem-preflight.md
```

```text
docs/deployment/multitable-pilot-quickstart-20260319.md
```

Use the runbook for operators and gate owners, not as the first document for business users.

11. Use these pilot operation templates during the week:

```text
docs/deployment/multitable-pilot-team-checklist-20260319.md
docs/deployment/multitable-pilot-daily-triage-template-20260319.md
docs/deployment/multitable-pilot-go-no-go-template-20260319.md
docs/deployment/multitable-pilot-expansion-decision-template-20260323.md
docs/deployment/multitable-uat-signoff-template-20260323.md
```

## Current Pilot Recommendation

The branch is suitable for a first internal pilot when the readiness gate is green.

Do not expand feature scope before pilot feedback. The highest-value next step is to collect real user behavior against the existing gate:

- import
- people import manual repair
- linked person assignment
- attachment upload
- form submit
- search
- conflict recovery

## Known Limits

- Large JS chunks still produce a build warning, but current build passes.
- Local disk pressure can cause transient artifact write failures when free disk space is very low.
- The readiness gate is designed for internal pilot, not public beta or market-complete launch.
