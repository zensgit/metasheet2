# Deploy Host Sync Disk Preflight Verification - 2026-05-21

## Static Checks

Result on the implementation branch:

- workflow YAML parse: PASS
- targeted contract tests: 5/5 PASS
- `git diff --check`: PASS
- marker grep: PASS

### Diff Check

Command:

```bash
git diff --check origin/main...HEAD
```

Expected:

```text
exit 0
```

### Workflow Marker Check

Command:

```bash
rg -n "DEPLOY_SYNC_MIN_FREE_KB|disk_available_kb|deploy host free space is below the sync gate|onprem-docker-gc-20260403.md" .github/workflows/docker-build.yml
```

Expected:

- `DEPLOY_SYNC_MIN_FREE_KB` is defined in the `Sync deploy host files` step.
- The default threshold is `1048576` KB.
- The remote resolver prints `disk_available_kb`.
- The remote resolver exits before `tar -xzf` when free space is below the
  gate.
- The error points operators to `docs/deployment/onprem-docker-gc-20260403.md`.

### Runbook Marker Check

Command:

```bash
rg -n "GitHub deploy host sync|DEPLOY_SYNC_MIN_FREE_KB|Cannot write: No space left on device|docker system df" docs/deployment/onprem-docker-gc-20260403.md
```

Expected:

- The runbook has an explicit GitHub deploy-host sync section.
- The default threshold is documented.
- The `tar: ... Cannot write` fallback case is documented.
- The operator recovery sequence includes `df -h /`, `docker system df`, and
  manual GC.

## Behavioral Reasoning

The deploy failure that motivated this change happened before these later
stages:

- remote deploy;
- migration;
- K3 WISE token mint;
- K3 WISE postdeploy smoke.

The new check runs in the same early sync step, before archive extraction. When
the deploy host is already full, the workflow now fails at the storage gate
instead of failing indirectly through `tar -xzf`.

## Non-Goals Verified By Diff Scope

Command:

```bash
git diff --name-only origin/main...HEAD
```

Expected files only:

```text
.github/workflows/docker-build.yml
docs/deployment/onprem-docker-gc-20260403.md
docs/development/deploy-host-sync-disk-preflight-development-20260521.md
docs/development/deploy-host-sync-disk-preflight-verification-20260521.md
scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

This confirms no product runtime, schema, API, frontend, Bridge Agent BA-M1,
or K3 write-path files changed.

## Contract Test

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Expected:

- Existing K3 WISE postdeploy workflow contract tests pass.
- New deploy-host sync disk preflight test confirms the gate is present before
  archive extraction and links to the Docker GC runbook.

## Live Verification Plan After Merge

1. Rerun `Build and Push Docker Images` on the merged commit.
2. If deploy host space has been cleaned, expect the workflow to advance past
   `Sync deploy host files`.
3. If deploy host space is still below the gate, expect a clear failure:

   ```text
   [host-sync] disk_available_kb=...
   [host-sync][error] deploy host free space is below the sync gate
   ```

4. Clean deploy host space using
   `docs/deployment/onprem-docker-gc-20260403.md`, then rerun.

## Secret Hygiene

The change does not print deploy host credentials, SSH keys, tokens, database
URLs, or K3 credentials. The new log values are filesystem capacity numbers and
the resolved deploy repository path, matching the existing workflow behavior.
