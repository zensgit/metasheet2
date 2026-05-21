# Deploy Host Sync Disk Preflight Development - 2026-05-21

## Context

Main push workflow `Build and Push Docker Images` for commit `02aa089185`
failed in the deploy job before remote deploy or smoke ran:

```text
tar: ... Cannot write: No space left on device
deploy_rc missing; failing deploy job.
```

The retry proved the image build/push path itself was healthy: backend and
frontend image pushes passed. The remaining failure was the deploy host file
sync step writing a small archive into `DEPLOY_PATH` on a full filesystem.

## Goal

Fail before extraction with a clear deploy-host storage diagnostic instead of
letting `tar -xzf` emit a low-context write error. This is an operations guard,
not a product runtime change.

## Scope

Changed:

- `.github/workflows/docker-build.yml`
- `docs/deployment/onprem-docker-gc-20260403.md`

Not changed:

- `plugin-integration-core`
- database migrations
- backend or frontend runtime
- K3 WISE Save / Submit / Audit behavior
- Bridge Agent BA-M1 runtime

## Implementation

`Sync deploy host files` now passes `DEPLOY_SYNC_MIN_FREE_KB` to the deploy host
resolver shell. The remote script:

1. resolves `DEPLOY_PATH` to the same `DEPLOY_REPO_PATH` as before;
2. creates the destination directory;
3. reads `df -Pk "$DEPLOY_REPO_PATH"`;
4. logs:

   ```text
   [host-sync] disk_available_kb=<n> required_kb=<n> use=<percent>
   ```

5. exits before archive extraction when available space is below the gate.

Default gate:

```text
DEPLOY_SYNC_MIN_FREE_KB=1048576
```

That is 1 GiB by default, configurable through a GitHub repository variable with
the same name.

## Operator Recovery

The existing Docker GC runbook now has a GitHub deploy-host sync section. It
directs the operator to:

1. check `df -h /`;
2. check `docker system df`;
3. run `scripts/ops/dingtalk-onprem-docker-gc.sh`;
4. recheck free space;
5. rerun the failed workflow.

## Risk Notes

- This gate only checks free space before sync. It does not guarantee Docker
  image pull/deploy will have enough space later.
- The threshold is intentionally low to avoid blocking healthy small hosts.
  Operators can raise `DEPLOY_SYNC_MIN_FREE_KB` if the deploy host repeatedly
  fills between preflight and extraction.
- If the remote `df` command fails, the step fails closed with the filesystem
  diagnostic output.

## Follow-up

The deploy host that failed `02aa089185` still needs capacity cleanup. This PR
only makes future failures easier to identify and rerun safely.
