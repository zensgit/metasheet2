# DingTalk P4 Closeout PR1129 Review Development

- Date: 2026-04-26
- PR: `#1129`
- Branch: `codex/dingtalk-next-slice-20260423`
- Review worktree: `.worktrees/pr1129-clean-review-20260426`
- Original WIP worktree left untouched: `.worktrees/dingtalk-next-slice-20260423`
- Base after sync: `origin/main` at `df16ed84b`
- PR head before sync: `c17683a6d`

## Purpose

PR `#1129` contains the DingTalk P4 closeout workflow package. It had already passed its earlier CI run, but it was behind main after the multitable post-commit hook PR merged.

This follow-up records the admin-review merge preparation separately from the feature work:

- do not mutate the dirty local WIP worktree for the same branch;
- use a clean detached worktree for conflict checking and verification;
- merge the latest `origin/main` into the PR branch head;
- keep the change set scoped to DingTalk P4 closeout scripts and documentation;
- preserve a written trail for the tests that were rerun before admin merge.

## Sync Strategy

The local branch worktree for `codex/dingtalk-next-slice-20260423` contained unrelated WIP files, so the review was performed in `.worktrees/pr1129-clean-review-20260426` from `origin/pr-1129`.

`origin/main` was merged into the clean review worktree. The merge completed without conflicts:

- first parent: PR head `c17683a6d`;
- second parent: `origin/main` `df16ed84b`.

No user WIP files were edited, cleaned, stashed, or deleted.

## Review Focus

The high-risk areas checked for this large ops PR were:

- final closeout orchestration stops on failed subprocesses;
- release-readiness profiles cannot accidentally run self-test bypass profiles;
- smoke-session and packet output paths reject unsafe overlaps;
- env and artifact summaries redact token-shaped values;
- final input status and readiness scripts keep missing customer inputs visible;
- generated packet validation includes the newly exported closeout helpers;
- PR branch can accept the latest main without code conflicts.

## Review Fixes

The parallel review found five merge-blocking or quality issues. This follow-up keeps the fixes inside the DingTalk P4 ops surface:

- `validate-dingtalk-staging-evidence-packet.mjs` now redacts secret-finding previews in `publish-check.json` instead of storing the matched token fragment.
- `dingtalk-p4-final-handoff.mjs` writes `sessionRunId`, and `dingtalk-p4-smoke-status.mjs` rejects handoff summaries whose `tool`, `sessionDir`, or `sessionRunId` do not match the current finalized session.
- `export-dingtalk-staging-evidence-packet.mjs` rejects existing non-packet output directories before cleanup, so a repo root or arbitrary directory cannot lose `README.md`, `manifest.json`, or `evidence/`.
- Env readiness, final input status, and remote smoke now require distinct DingTalk group robot `access_token` values and reject an unauthorized manual target that is also authorized or allowlisted.
- Strict evidence compile now flags local manual artifact files older than the check's `performedAt` timestamp, with a five-minute clock skew allowance.

## Out Of Scope

- No live DingTalk 142/staging smoke was run.
- No real customer DingTalk tokens, webhook secrets, screenshots, or external packets were added.
- The dirty local worktree for the original branch remains a separate owner-managed workspace.
