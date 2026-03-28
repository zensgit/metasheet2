# Remote Deploy Path Home Resolution Verification

Date: 2026-03-26

## Trigger

Blocked release status after merged PR `#547`:

- workflow: `Build and Push Docker Images`
- run: `23592951330`
- failing job: `deploy`
- failure excerpt:
  - `Remote deploy failed: rc=1`
  - `[deploy][error] DEPLOY_PATH is not a git repo: metasheet2`

Downloaded artifact evidence:

- `output/playwright/ga/23592951330/deploy.log`
- `output/playwright/ga/23592951330/step-summary.md`

## Verification Performed

### 1. Workflow diff integrity

Command:

```bash
git diff --check
```

Result:

- pass

### 2. Target workflows all contain the new resolver/diagnostics contract

Command:

```bash
rg -n "DEPLOY_REPO_PATH|repo_path=|DEPLOY_PATH missing|not a git repo at" \
  .github/workflows/docker-build.yml \
  .github/workflows/attendance-remote-preflight-prod.yml \
  .github/workflows/attendance-remote-storage-prod.yml \
  .github/workflows/attendance-remote-metrics-prod.yml \
  .github/workflows/attendance-remote-env-reconcile-prod.yml \
  .github/workflows/attendance-remote-upload-cleanup-prod.yml \
  .github/workflows/attendance-remote-docker-gc-prod.yml
```

Result:

- all 7 workflows contain the new `DEPLOY_REPO_PATH` resolution
- all 7 workflows now log resolved repo path
- all 7 workflows emit failure diagnostics for missing/non-repo targets

### 3. Resolution semantics

Command:

```bash
bash -lc 'for p in metasheet2 ~/metasheet2 /srv/metasheet2; do
  DEPLOY_PATH="$p"
  if [[ "$DEPLOY_PATH" == /* ]]; then
    DEPLOY_REPO_PATH="$DEPLOY_PATH"
  elif [[ "$DEPLOY_PATH" == ~/* ]]; then
    DEPLOY_REPO_PATH="$HOME/${DEPLOY_PATH#~/}"
  else
    DEPLOY_REPO_PATH="$HOME/${DEPLOY_PATH}"
  fi
  printf "%s -> %s\n" "$DEPLOY_PATH" "$DEPLOY_REPO_PATH"
done'
```

Result:

- `metasheet2 -> $HOME/metasheet2`
- `~/metasheet2 -> $HOME/metasheet2`
- `/srv/metasheet2 -> /srv/metasheet2`

This matches the intended contract.

## What Was Not Verified

- No remote rerun was executed in this worktree.
- This verification proves the workflow contract change and diagnostics improvement, not that the target host has already been repaired.

## Expected Next Step

Re-run the failed workflow after merging this fix. If the host path is correct, deploy should continue past repo validation; if not, the new logs will expose the resolved path and host directory contents immediately.
