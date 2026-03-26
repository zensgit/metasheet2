# Remote Deploy Compose Command Fallback Verification

Date: 2026-03-26

## Trigger

Follow-up failure after `#549`:

- workflow: `Build and Push Docker Images`
- run: `23594097419`
- merge commit under test: `0c70e2d8217bb85e493c5bb1a1b8cd081f51d9c3`

Artifact evidence:

- `output/playwright/ga/23594097419/deploy-logs-23594097419-1/deploy.log`
- `output/playwright/ga/23594097419/deploy-logs-23594097419-1/step-summary.md`

The logs proved:

- path resolution worked
- non-git host fallback worked
- attendance preflight passed
- deploy then failed specifically on `docker compose -f ...`

## Verification Performed

### 1. Shell syntax

Command:

```bash
bash -n \
  scripts/ops/deploy-attendance-prod.sh \
  scripts/ops/attendance-check-storage.sh \
  scripts/ops/attendance-clean-uploads.sh
```

Result:

- pass

### 2. Diff integrity

Command:

```bash
git diff --check
```

Result:

- pass

### 3. Fallback markers present

Command:

```bash
rg -n "COMPOSE_CMD|docker-compose|docker compose version|compose backend exec requested" \
  .github/workflows/docker-build.yml \
  scripts/ops/deploy-attendance-prod.sh \
  scripts/ops/attendance-check-storage.sh \
  scripts/ops/attendance-clean-uploads.sh
```

Result:

- workflow deploy path now detects `docker compose` vs `docker-compose`
- attendance helper scripts now detect the same fallback
- backend exec paths now fail clearly only when neither compose form exists

## What Was Not Verified

- No new remote rerun has been executed yet from this branch.
- This verification proves the compatibility logic and script syntax, not that the target host has already completed a full successful deploy.

## Expected Next Step

Merge this slice, rerun `Build and Push Docker Images`, and confirm deploy moves past the compose-command compatibility gate into pull/up/migrate/smoke execution.
