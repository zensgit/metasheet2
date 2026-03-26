# Remote Deploy Start DB Dependencies Verification

Date: 2026-03-26

## Trigger

Follow-up failure after merge commit `927dbec52d999c6862f48af71eee1dc72dd22fc1`:

- workflow: `Build and Push Docker Images`
- run: `23597386632`

Artifact evidence:

- `output/playwright/ga/23597386632/deploy-logs-23597386632-1/deploy.log`
- `output/playwright/ga/23597386632/deploy-logs-23597386632-1/step-summary.md`

The logs proved:

- deploy stage passed end-to-end
- migrate then failed because backend could not resolve `postgres`
- this is consistent with missing compose dependency startup before migration

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

### 3. Dependency startup markers present

Command:

```bash
rg -n "up -d postgres redis|ENOTFOUND postgres|DEPLOY START" \
  .github/workflows/docker-build.yml \
  scripts/ops/deploy-attendance-prod.sh
```

Result:

- workflow now starts `postgres redis` before backend/web pull+recreate
- manual helper uses the same ordering
- migration sequencing now matches the actual compose dependency graph

## What Was Not Verified

- No new remote rerun has been executed yet from this branch.
- This verification proves dependency startup sequencing, not that later migrate/smoke stages have already passed.

## Expected Next Step

Merge this slice, rerun `Build and Push Docker Images`, and confirm deploy moves beyond `ENOTFOUND postgres`.
