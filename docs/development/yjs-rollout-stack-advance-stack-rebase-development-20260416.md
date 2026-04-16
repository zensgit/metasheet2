# Yjs Rollout Stack Advance Stack Rebase Development

Date: 2026-04-16

## Context

- Parent PR chain up to `#892` changed after the `#891` packet branch and `#892` signoff branch were rewritten.
- PR `#893` still replayed already-upstream parent layers while targeting `codex/yjs-rollout-signoff-20260416`.

## What Changed

1. Rebasing `codex/yjs-rollout-stack-advance-20260416` onto `origin/codex/yjs-rollout-signoff-20260416`
2. Dropping the already-upstream parent-layer commits:
   - `a00e974ae`
   - `e5d12f1cf`
   - `1492a1d4c`
   - `c6333e822`
   - `649ca31be`
   - `163cc2a18`
3. Keeping only the stack-advance script commit:
   - `a61296822` `feat(collab): add yjs rollout stack advance script`

## Result

- `#893` now sits cleanly on top of the updated `#892` branch
- The branch is reduced to the intended stack-advance delta only
