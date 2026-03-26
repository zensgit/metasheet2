# Remote Deploy Non-Git Host Fallback

Date: 2026-03-26

## Problem

After merging `#548`, mainline deploy run `23593684257` still failed.
The new diagnostics showed that the path resolution fix worked:

- resolved path: `/home/mainuser/metasheet2`
- current directory after `cd`: `/home/mainuser/metasheet2`

But the host directory is not a git repository:

- `[deploy][error] DEPLOY_PATH is not a git repo: metasheet2 (resolved: /home/mainuser/metasheet2)`

The directory already contains the deployment files needed for runtime operations:

- `docker-compose.app.yml`
- `docker/app.env`
- `docker/nginx.conf`
- `scripts/ops/*`

So the remaining blocker is not path discovery; it is the hard requirement that the deploy host must also be a git checkout.

## Design

Treat git sync as an optional host-sync optimization instead of a hard runtime prerequisite.

Rules:

1. Missing deploy directory remains a hard error.
2. If the directory exists and is a git repo, keep the existing fetch/checkout/pull behavior.
3. If the directory exists but is not a git repo, emit a warning, print `pwd` and `ls -la`, and continue with the existing deployment files.

This keeps the logs explicit while unblocking hosts that are managed as deployment bundles rather than live git checkouts.

## Scope

Updated workflows:

- `.github/workflows/docker-build.yml`
- `.github/workflows/attendance-remote-preflight-prod.yml`
- `.github/workflows/attendance-remote-storage-prod.yml`
- `.github/workflows/attendance-remote-metrics-prod.yml`
- `.github/workflows/attendance-remote-env-reconcile-prod.yml`
- `.github/workflows/attendance-remote-upload-cleanup-prod.yml`
- `.github/workflows/attendance-remote-docker-gc-prod.yml`

## Claude Code Note

Claude Code was used again after the first fix. Its smallest safe unblock recommendation was consistent with this direction: if the host already has deploy artifacts and does not need source checkout semantics, stop treating remote git operations as the only valid sync mechanism.
