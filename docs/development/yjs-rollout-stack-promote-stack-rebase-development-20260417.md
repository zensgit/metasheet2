# Yjs Rollout Stack Promote Stack Rebase Development

Date: 2026-04-17

## Context

- Parent PR layers up through `#894` were already upstream or freshly rebased.
- PR `#895` still replayed those parent layers while targeting `codex/yjs-rollout-gate-20260416`.

## What Changed

1. Rebasing `codex/yjs-rollout-stack-promote-20260416` onto `origin/codex/yjs-rollout-gate-20260416`
2. Dropping the already-upstream parent-layer commits from the rebase todo:
   - `a00e974ae`
   - `e5d12f1cf`
   - `1492a1d4c`
   - `c6333e822`
   - `649ca31be`
   - `163cc2a18`
   - `5c2dda0d2`
   - `9585cc0fb`
3. Keeping only the promote-mode commit:
   - `f210fb443` `feat(collab): add yjs rollout stack promote mode`

## Result

- `#895` now sits cleanly on top of the updated `#894` branch
- The branch is reduced to the intended promote-mode delta only
