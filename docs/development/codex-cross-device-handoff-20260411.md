# Codex Cross-Device Handoff

Date: 2026-04-11

Purpose: save the current delivery / staging / ops conversation state in Git so work can continue from another computer without relying on local chat history.

## Read First

This file is an additive handoff for the current session.

Related baseline docs already on `main`:

- `docs/development/codex-conversation-handoff-20260411.md`
- `docs/development/multitable-session-20260411-handoff.md`

This file adds the latest context that was not covered there:

- current 142 staging / on-prem status
- multitable delivery and release packaging state
- DingTalk `stability / drill / summary` purpose and health
- Athena deployment feasibility on the same host
- how to resume safely from another computer

## Current Delivery State

### Multitable package

- Recommended delivery bundle:
  - `output/delivery/multitable-pilot-final-20260407`
- GitHub Release:
  - `https://github.com/zensgit/metasheet2/releases/tag/multitable-pilot-final-20260407`
- Current release posture:
  - `staging release-bound verified`
  - suitable for test / implementation / UAT handoff
  - not the same as final customer sign-off

### Remote 142 environment

- Host: `142.171.239.56`
- Main app web:
  - `http://142.171.239.56:8081`
- Multitable staging web:
  - `http://142.171.239.56:8081/multitable`
- Delivery bundle synced to remote:
  - `/home/mainuser/delivery/multitable-pilot-final-20260407`

### What was already confirmed

- remote `multitable` page returned `200`
- remote `/health` returned `ok`
- release package and checksums were uploaded to GitHub Release
- remote runtime had already been updated to the latest verified mainline package during this conversation

## Sensitive Access Policy

Do not store temporary passwords, JWTs, or private webhook values in Git.

During this conversation:

- a temporary staging admin account was created and validated
- a temporary JWT was minted and validated

Those secrets were intentionally not copied into this handoff file.

If a new machine needs access again, reissue temporary credentials instead of trying to recover them from Git history.

## DingTalk Ops Chain Status

### Purpose of `stability / drill / summary`

This chain exists to prove the on-prem monitoring and notification path is still alive, not just that the code once worked.

- `stability`
  - passive health check
  - backend health, alertmanager error count, webhook config, key runtime metrics
- `drill`
  - active synthetic alert exercise
  - verifies real `FIRING` and `RESOLVED` delivery to Slack
- `summary`
  - operator-facing rollup of latest health + drill state

### Current known posture

At the time of this handoff, the chain was considered healthy:

- launchd agents had been seen with `last exit code = 0`
- recent stability checks were healthy
- recent drill runs showed:
  - `firingObserved=true`
  - `resolvedObserved=true`

Do not infer exact temporary counts from this file; re-read the current logs when resuming.

Useful log roots:

- `~/Library/Logs/metasheet2/dingtalk-oauth/index.jsonl`
- `~/Library/Logs/metasheet2/dingtalk-oauth/runs/`
- `~/Library/Logs/metasheet2/dingtalk-oauth/summaries/`

Useful local status command:

```bash
bash ~/.codex/memories/metasheet2-onprem-schedule/scripts/ops/print-dingtalk-oauth-launchd-schedule-status.sh
```

## 142 Capacity Check

This conversation re-checked whether host `142.171.239.56` could also host Athena.

### Measured host resources

- disk:
  - `/` total `77G`
  - used about `43G`
  - available about `32G`
- memory:
  - total about `3.8Gi`
  - available about `2.4Gi`
- CPU:
  - `4` vCPU

### Existing runtime load

The host was already running:

- one metasheet main stack on `8081 / 8900`
- one metasheet staging stack on `8082 / 18900`
- observability services including Grafana / Prometheus / Alertmanager

### Athena feasibility conclusion

Athena's own installation doc states:

- minimum:
  - `2 CPU`
  - `8GB RAM`
  - `50GB` free storage
- recommended production:
  - `8 CPU`
  - `32GB RAM`
  - `500GB+` system/data storage split

Repository evidence:

- `docs/INSTALLATION.md`
- `docker-compose.yml`

Conclusion reached in this conversation:

- disk alone is not the blocker
- memory and service footprint are the blocker
- do **not** deploy Athena full-stack on host `142.171.239.56`

If Athena must be deployed later, prefer:

1. a separate host, or
2. a specifically reduced minimal profile with explicit port remapping

## Root Worktree Safety Note

The original root worktree on the source machine was not clean when this handoff was created.

Observed state included:

- `main` behind remote
- one tracked modification:
  - `packages/core-backend/src/integrations/dingtalk/client.ts`
- many unrelated untracked docs, scripts, output artifacts, and local automation files

Do not perform destructive cleanup from the root worktree.

If you resume development on another machine, prefer:

1. a clean clone, or
2. a fresh dedicated worktree

## How To Resume On Another Computer

### Option A: simplest

```bash
git clone git@github.com:zensgit/metasheet2.git
cd metasheet2
git fetch origin
git switch codex/session-handoff-20260411-194713
```

Then read:

- `docs/development/codex-conversation-handoff-20260411.md`
- `docs/development/multitable-session-20260411-handoff.md`
- `docs/development/codex-cross-device-handoff-20260411.md`

### Option B: stay on main but read the branch doc from GitHub

If this handoff branch has not been merged yet, read the file directly from GitHub and ask Codex to continue from it.

Suggested resume prompt:

> Continue from `docs/development/codex-cross-device-handoff-20260411.md`. Treat `multitable-pilot-final-20260407` as the current delivery bundle, `142.171.239.56` as the active staging/on-prem host, and assume Athena full-stack should not be deployed on that host.

## Suggested Next Actions

Depending on what you need next, the conversation had already converged on these defaults:

1. for delivery:
   - continue with UAT / implementation / preflight evidence collection
2. for DingTalk ops:
   - observe the automatic `stability / drill / summary` chain, intervene only on real failures
3. for Athena:
   - do not co-deploy to `142`
   - plan a separate host or a reduced profile first

