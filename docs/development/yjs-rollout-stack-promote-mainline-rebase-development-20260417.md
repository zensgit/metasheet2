# Yjs Rollout Stack Promote Mainline Rebase Development

Date: 2026-04-17

## Context

- PR `#894` merged into `main` as `7aca08449c4dade68b23df2fa6a60fa94cc2d3e4`.
- PR `#895` auto-retargeted to `main` and became `BEHIND`.

## What Changed

1. Rebasing `codex/yjs-rollout-stack-promote-20260416` onto updated `origin/main`
2. Letting Git auto-drop the already-upstream `#894` parent layer:
   - `9fd858c86`
   - `6a0bf72b5`
   - `c448761ae`
3. Preserving only the promote-specific commits:
   - `3a8441754` `feat(collab): add yjs rollout stack promote mode`
   - `87b688c37` `docs: record yjs rollout stack promote rebase`
   - `17f2501d5` `docs: record yjs rollout stack promote gate rebase`

## Result

- `#895` is now a minimal delta over current `main`
- The branch no longer replays rollout-gate history
- Promote-mode scripting remains intact and ready for CI/review
