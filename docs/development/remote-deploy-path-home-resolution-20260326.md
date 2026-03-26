# Remote Deploy Path Home Resolution

Date: 2026-03-26

## Problem

`main` merge commit `1aa41d700e6f2c134fc739d67320a14bc4468159` triggered `Build and Push Docker Images` run `23592951330`.
The build job succeeded, but the remote deploy job failed before preflight/migrate/smoke:

- `Remote deploy failed: rc=1`
- `[deploy][error] DEPLOY_PATH is not a git repo: metasheet2`

The current workflows assume `DEPLOY_PATH=metasheet2` can be passed directly to `cd`. That is fragile because:

1. docs already describe the default as home-relative;
2. non-interactive SSH shells should not rely on the current working directory;
3. the old failure string did not expose the resolved path or host cwd, so operators had to re-run just to learn basic context.

The same path assumption existed in the mainline deploy workflow and six attendance remote maintenance workflows.

## Design

Apply one uniform remote-path contract to every SSH workflow that syncs/deploys a repo:

1. If `DEPLOY_PATH` is absolute, use it unchanged.
2. If `DEPLOY_PATH` starts with `~/`, expand it against `$HOME`.
3. Otherwise resolve it as `$HOME/$DEPLOY_PATH`.
4. Fail early if the resolved directory does not exist.
5. After `cd`, log the resolved repo path.
6. If `git rev-parse --is-inside-work-tree` fails, print the resolved path, `pwd`, and `ls -la` diagnostics before exiting.

This keeps the current secret contract backward-compatible while making the implicit "home-relative" rule explicit in code.

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

Claude Code was used to sanity-check the fix boundary. Its recommendation matched the chosen approach: resolve `DEPLOY_PATH` to an absolute path early and emit `pwd/ls` diagnostics on repo-check failure.
