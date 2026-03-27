# Remote Deploy Reset DB Containers Verification

Date: 2026-03-27

## Trigger

Follow-up failure after merge commit `5d11160b9ba212dec7bfa0efb982bfcc2679e05f`:

- workflow: `Build and Push Docker Images`
- run: `23597784889`

Artifact evidence:

- `output/playwright/ga/23597784889/deploy-logs-23597784889-1/deploy.log`
- `output/playwright/ga/23597784889/deploy-logs-23597784889-1/step-summary.md`

The logs proved:

- backend/web container reset logic worked
- deploy now explicitly tried to start `postgres` and `redis`
- the new failure was the same fixed-name conflict pattern, just on `metasheet-postgres` and `metasheet-redis`

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
rg -n "metasheet-postgres|metasheet-redis|removing existing container|docker rm -f" \
  .github/workflows/docker-build.yml \
  scripts/ops/deploy-attendance-prod.sh
```

Result:

- workflow reset loop now includes postgres and redis
- manual helper reset loop now includes postgres and redis
- reset remains scoped to the four known fixed-name app containers only

## What Was Not Verified

- No new remote rerun has been executed yet from this branch.
- This verification proves the extended stale-container reset logic, not that later migrate/smoke stages have already passed.

## Expected Next Step

Merge this slice, rerun `Build and Push Docker Images`, and confirm deploy moves beyond stale `postgres` / `redis` container conflicts.
