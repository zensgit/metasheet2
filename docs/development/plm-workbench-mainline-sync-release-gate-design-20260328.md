# PLM Workbench Mainline Sync Release Gate Design

## Background

After the latest `PLM-workbench` fixes, the release blocker was no longer local quality gates. The remaining hard blocker was branch state:

- PR checks were green
- branch was still `behind` `origin/main`
- PR therefore remained unsuitable for final release even though the PLM slice itself was healthy

## Goal

Reduce release risk by synchronizing the branch with the latest `origin/main` before final release decisions, while preserving the current PLM work without reopening the previous large conflict set.

## Design

### Safe merge-first workflow

1. Preflight the merge in an isolated temporary clone.
2. Only if the preflight is conflict-free, perform the real merge in the active worktree.
3. Re-run local PLM verification after the merge.
4. Push the merged branch and let GitHub checks re-run on the new merge base.

### Why merge now instead of later

- Keeps release readiness honest: the branch is evaluated against the real current mainline
- Prevents a false “ready to release” signal while GitHub still reports `BEHIND`
- Avoids stacking more PLM-only commits on top of an outdated base

## Scope of confidence

This merge is a release-gate sync, not a new feature slice. The local verification focus stays on the PLM surface that this branch owns:

- web type-check
- PLM frontend regression suite

Remote CI remains the authoritative gate for the newly merged non-PLM changes carried in from `main`.
