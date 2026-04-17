# Yjs Rollout Stack Advance Mainline Rebase Development

Date: 2026-04-17

## Context

- PR `#892` merged into `main` as `5d79e388d4d412032fb742e8b51928e5beb6162f`.
- PR `#893` auto-retargeted to `main` and became `BEHIND`.

## What Changed

1. Rebasing `codex/yjs-rollout-stack-advance-20260416` onto updated `origin/main`
2. Dropping the already-upstream packet/signoff parent layer:
   - `c0b63f637`
   - `dcccc0a67`
   - `c2e7cee5d`
   - `67eac3e81`
3. Preserving only the stack-advance-specific commits:
   - `9eb077342` `feat(collab): add yjs rollout stack advance script`
   - `8074d3d10` `docs: record yjs rollout stack advance rebase`

## Result

- `#893` is now a minimal delta over current `main`
- The branch no longer replays packet/signoff history
- Stack-advance scripting remains intact and ready for CI/review
