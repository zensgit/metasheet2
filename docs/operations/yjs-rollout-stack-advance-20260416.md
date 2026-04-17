# Yjs Rollout Stack Advance

Date: 2026-04-16

## Purpose

The Yjs rollout follow-ups are intentionally stacked:

1. `#888`
2. `#889`
3. `#890`
4. `#891`
5. `#892`

This script helps maintainers advance the stack after each parent PR merges.

## Dry Run

```bash
node scripts/ops/advance-yjs-rollout-stack.mjs
```

This prints:

- which PR is still waiting on its parent
- which PR is already based on `main`
- which PR should now be retargeted to `main`

## Apply

```bash
node scripts/ops/advance-yjs-rollout-stack.mjs --apply
```

This will run `gh pr edit <number> --base main` for any child PR whose parent has already merged.

## Notes

- The script only retargets open child PRs.
- It does not merge PRs.
- It does not rewrite local git history.
- Run it after a parent merge, then do the final rebase/verification on the child branch if needed.
