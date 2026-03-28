# Remote Deploy Container Name Conflict Reset Verification

Date: 2026-03-26

## Trigger

Follow-up failure after merge commit `738c6ffb2743d9c2bb22281ec9f4a9fac7892b7f`:

- workflow: `Build and Push Docker Images`
- run: `23594905975`

Artifact evidence:

- `output/playwright/ga/23594905975/deploy-logs-23594905975-1/deploy.log`
- `output/playwright/ga/23594905975/deploy-logs-23594905975-1/step-summary.md`

The logs proved:

- path resolution worked
- non-git host fallback worked
- compose command fallback worked
- image owner/tag override worked
- deploy then failed on fixed container-name reuse (`/metasheet-backend`)

## Verification Performed

### 1. Diff integrity

Command:

```bash
git diff --check
```

Result:

- pass

### 2. Shell syntax

Command:

```bash
bash -n scripts/ops/deploy-attendance-prod.sh
```

Result:

- pass

### 3. Reset markers present

Command:

```bash
rg -n "removing existing container|docker rm -f|metasheet-backend|metasheet-web" \
  .github/workflows/docker-build.yml \
  scripts/ops/deploy-attendance-prod.sh
```

Result:

- workflow now removes stale fixed-name app containers before recreate
- manual helper does the same
- reset scope is constrained to the two app containers only

## What Was Not Verified

- No new remote rerun has been executed yet from this branch.
- This verification proves the stale-container reset logic, not that later migrate/smoke stages have already passed.

## Expected Next Step

Merge this slice, rerun `Build and Push Docker Images`, and confirm deploy moves beyond the stale container conflict.
