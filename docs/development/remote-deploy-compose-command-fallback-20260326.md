# Remote Deploy Compose Command Fallback

Date: 2026-03-26

## Problem

After merging `#549`, mainline deploy run `23594097419` moved past:

- path resolution
- non-git host sync fallback
- attendance preflight

and then failed at deploy start with:

- `unknown shorthand flag: 'f' in -f`
- remote exit code `125`

That failure pattern means the host does not support `docker compose ...` subcommands, and likely only exposes legacy `docker-compose`.

## Design

Introduce a compose-command compatibility layer:

1. Prefer `docker compose` when available.
2. Fall back to `docker-compose` when the plugin form is unavailable.
3. Keep a hard error only when neither command exists.

Apply this in:

- the main remote deploy workflow, because it directly invokes compose pull/up/exec
- the attendance ops scripts that execute compose backend commands on the host

This is a narrow operational compatibility fix; it does not change container targets, compose files, migration commands, or smoke behavior.

## Scope

Updated files:

- `.github/workflows/docker-build.yml`
- `scripts/ops/deploy-attendance-prod.sh`
- `scripts/ops/attendance-check-storage.sh`
- `scripts/ops/attendance-clean-uploads.sh`

## Claude Code Note

Claude Code was used earlier in this release-unblock chain for boundary checks. This slice continues the same pattern: move the deploy blocker forward without widening product/runtime scope.
