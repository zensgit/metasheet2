# Yjs Rollout Stack Promote Gate Rebase Development

Date: 2026-04-17

## Context

- PR `#894` was rewritten on top of the updated `#893` branch.
- PR `#895` still targeted the pre-rebase `codex/yjs-rollout-gate-20260416` head.

## What Changed

1. Rebasing `codex/yjs-rollout-stack-promote-20260416` onto `origin/codex/yjs-rollout-gate-20260416`
2. Letting Git auto-drop the already-upstream `#893` parent layer:
   - `9eb077342`
   - `8074d3d10`
   - `2e6efbbea`
3. Preserving only the promote-specific commits:
   - `99517fc87` `feat(collab): add yjs rollout stack promote mode`
   - `b505d1508` `docs: record yjs rollout stack promote rebase`

## Result

- `#895` now sits cleanly on top of the updated `#894` branch
- The branch is reduced to the intended promote-mode delta only
