# GitHub Stability Summary Polish Design

Date: 2026-04-06

## Goal

Improve the GitHub-side DingTalk OAuth stability recording so each run leaves:

- a clearer markdown summary for humans
- a machine-readable `summary.json` for downstream tooling
- explicit failure reasons and next actions when the check fails

This slice does not move the Slack drill into GitHub Actions. GitHub remains a passive recording surface for the remote stability check only.

## Current Gap

The existing workflow already uploads:

- `stability.json`
- `stability.log`
- `summary.md`

But `summary.md` only mirrors a few fields. It does not:

- explain why a run failed
- tell the operator what to do next
- emit a normalized machine-readable rollup artifact

## Design

### 1. Enrich the summary generator

Extend `scripts/ops/github-dingtalk-oauth-stability-summary.py` so it:

- reads the existing `stability.json`
- derives an overall `PASS` or `FAIL`
- computes `failureReasons`
- computes `nextActions`
- writes a sibling `summary.json`

The JSON output is derived, not a second probe. This keeps GitHub workflow behavior stable and low-risk.

### 2. Keep workflow shape stable

`.github/workflows/dingtalk-oauth-stability-recording-lite.yml` should continue to:

- run the remote stability check over SSH
- write GitHub step summary
- upload the same artifact directory

Because the artifact path already includes the whole output directory, the new `summary.json` is picked up automatically.

### 3. Failure classification

The summary generator should explicitly surface the main operator-facing failure classes:

- stability command failed
- backend health not ok
- webhook not configured or host drifted
- Alertmanager notify errors observed
- root filesystem at or above the configured gate
- stability JSON unreadable

### 4. Action hints

The summary generator should emit short operator actions tied to those failure classes, for example:

- re-run the remote stability command
- inspect backend health
- reapply persisted webhook config
- inspect Alertmanager / bridge logs
- run Docker GC on the host

## Non-Goals

- No GitHub-triggered Slack drill
- No changes to the on-prem probe contract
- No changes to launchd scheduling
- No changes to Alertmanager or webhook bridge behavior
