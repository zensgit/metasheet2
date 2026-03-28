# Remote Deploy Image Owner/Tag Override Verification

Date: 2026-03-26

## Trigger

Follow-up failure after merge commit `2c7b1557e09cd67a4d03e00d2e75326b58391257`:

- workflow: `Build and Push Docker Images`
- run: `23594571570`

Artifact evidence:

- `output/playwright/ga/23594571570/deploy-logs-23594571570-1/deploy.log`
- `output/playwright/ga/23594571570/deploy-logs-23594571570-1/step-summary.md`

The logs proved:

- path resolution worked
- non-git host fallback worked
- compose command fallback worked (`compose_cmd=docker-compose`)
- deploy still failed because compose pulled `ghcr.io/local/...:current`

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

### 3. Override markers present

Command:

```bash
rg -n "DEPLOY_IMAGE_OWNER|DEPLOY_IMAGE_TAG|image_owner=|image_tag=|IMAGE_OWNER=|IMAGE_TAG=" \
  .github/workflows/docker-build.yml \
  scripts/ops/deploy-attendance-prod.sh
```

Result:

- workflow now exports explicit owner/tag into the remote shell
- deploy log will now show the effective owner/tag
- compose `pull` / `up` are now pinned to the workflow-built image coordinates
- manual helper script supports the same explicit override path

## What Was Not Verified

- No new remote rerun has been executed yet from this branch.
- This verification proves the owner/tag override logic, not that the target host already has valid GHCR credentials for those images.

## Expected Next Step

Merge this slice, rerun `Build and Push Docker Images`, and confirm deploy moves past stale `local/current` image selection.
