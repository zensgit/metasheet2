# Remote Deploy Non-Git Host Fallback Verification

Date: 2026-03-26

## Trigger

Follow-up failure after `#548`:

- workflow: `Build and Push Docker Images`
- run: `23593684257`
- merge commit under test: `848bc728f4a9133b810033ff08fb30e837d10b4f`

New diagnostic evidence from:

- `output/playwright/ga/23593684257/deploy-logs-23593684257-1/deploy.log`
- `output/playwright/ga/23593684257/deploy-logs-23593684257-1/step-summary.md`

confirmed:

- path resolution now works
- target directory exists
- the hard blocker is only the missing `.git` directory

## Verification Performed

### 1. Diff integrity

Command:

```bash
git diff --check
```

Result:

- pass

### 2. Fallback/warn behavior present in all target workflows

Command:

```bash
rg -n "continuing with existing files|git sync=enabled|DEPLOY_PATH is not a git repo" \
  .github/workflows/docker-build.yml \
  .github/workflows/attendance-remote-preflight-prod.yml \
  .github/workflows/attendance-remote-storage-prod.yml \
  .github/workflows/attendance-remote-metrics-prod.yml \
  .github/workflows/attendance-remote-env-reconcile-prod.yml \
  .github/workflows/attendance-remote-upload-cleanup-prod.yml \
  .github/workflows/attendance-remote-docker-gc-prod.yml
```

Result:

- all 7 workflows now contain the non-git-host fallback messaging

### 3. Shell syntax

Command:

```bash
git diff -- .github/workflows/docker-build.yml \
  .github/workflows/attendance-remote-preflight-prod.yml \
  .github/workflows/attendance-remote-storage-prod.yml \
  .github/workflows/attendance-remote-metrics-prod.yml \
  .github/workflows/attendance-remote-env-reconcile-prod.yml \
  .github/workflows/attendance-remote-upload-cleanup-prod.yml \
  .github/workflows/attendance-remote-docker-gc-prod.yml
```

Result:

- reviewed focused workflow diff
- no trailing whitespace / patch-shape issues

## What Was Not Verified

- No new mainline rerun was executed yet from this branch.
- This verification proves the workflow behavior change, not that the remote host has already completed a successful deploy with it.

## Expected Next Step

Merge this fallback fix, re-run `Build and Push Docker Images`, and confirm the deploy job moves past the former git-repo gate into preflight/deploy/migrate/smoke.
