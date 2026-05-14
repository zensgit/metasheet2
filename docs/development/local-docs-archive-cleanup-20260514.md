# Local Docs Archive Cleanup - 2026-05-14

## Purpose

This PR archives local documentation files that were left untracked in the
operator root checkout after the related development lanes had already moved
on. Several current `origin/main` documents reference these files by path, so
deleting them locally would leave historical cross-references broken.

This is a docs-only cleanup. It does not change runtime code, migrations,
scripts, OpenAPI contracts, CI workflows, or deployment configuration.

## Files Archived

| File | Reason |
| --- | --- |
| `docs/development/integration-k3wise-stage1-closeout-20260509.md` | Preserves the K3 WISE stage-1 closeout snapshot and gated handoff context. |
| `docs/development/multitable-feishu-three-lane-plan-discussion-20260507.md` | Referenced by the merged Gantt dependency tightening development note. |
| `docs/development/multitable-feishu-three-lane-claude-execution-plan-20260507.md` | Referenced by the Phase 2 multitable development note as the older plan that was superseded. |
| `docs/development/operations-docs-delivery-20260426.md` | Delivery record for the staging SOP and migration-alignment runbook. |
| `docs/development/staging-deploy-d88ad587b-20260426.md` | Forensic deploy note preserved with a correction banner. |
| `docs/development/staging-deploy-d88ad587b-postmortem-20260426.md` | Referenced by the K3 on-prem preflight design note and staging operations docs. |
| `docs/operations/staging-deploy-sop.md` | Operational SOP referenced by the migration-alignment runbook. |
| `docs/operations/staging-migration-alignment-runbook.md` | Operational recovery runbook referenced by the staging SOP and older multitable execution plan. |

## Files Deliberately Not Archived

| Path | Decision |
| --- | --- |
| `.claude/` | Local assistant configuration/state; not a repository artifact. |
| `output/delivery/multitable-onprem/` | Generated release/package evidence; keep local unless explicitly promoted to an artifact store. |
| `output/dingtalk-live-acceptance/` | Generated live acceptance evidence; keep local unless explicitly promoted to an artifact store. |
| `output/releases/` | Generated release bundles and checksums; do not commit to the docs cleanup PR. |

## Superseded Local Files Removed From Root Checkout

The following local-only files were removed before this PR because newer or
more complete versions already exist on `origin/main`:

- `docs/development/integration-core-external-system-config-preserve-*-20260426.md`
- `docs/development/integration-core-external-system-kind-immutable-*-20260426.md`
- `docs/development/integration-core-finishrun-error-guard-*-20260426.md`
- `docs/development/integration-core-replay-mark-guard-*-20260426.md`
- `docs/development/integration-core-run-mode-guard-*-20260426.md`
- stale local copies of the Phase 3 plan and TODO that predated PR #1537's activation-gate patch
- stale local copy of `k3wise-bridge-machine-codex-handoff-20260513.md` that lacked the latest mainline handoff notes

## Verification

Checks run before opening the PR:

- `git diff --cached --check` passed.
- Path scope check passed: changed files are under `docs/`.
- Secret-pattern scan passed: no bearer, JWT, API key, SEC token,
  access-token query value, client secret, DingTalk secret assignment, or
  password-assignment matches in the changed files.
- Cross-reference check passed for the previously missing docs referenced by
  current `origin/main` development notes.
