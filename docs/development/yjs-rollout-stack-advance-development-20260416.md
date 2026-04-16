# Yjs Rollout Stack Advance Development

Date: 2026-04-16

## Context

The rollout work no longer consists of a single PR. It is now a stacked chain:

- `#888`
- `#889`
- `#890`
- `#891`
- `#892`

The repeated maintainer task after each merge is:

1. detect whether the parent is merged
2. retarget the child to `main`
3. continue with rebase / verification

## Change

Added:

- [scripts/ops/advance-yjs-rollout-stack.mjs](/tmp/metasheet2-yjs-rollout-stack-advance/scripts/ops/advance-yjs-rollout-stack.mjs:1)
- [docs/operations/yjs-rollout-stack-advance-20260416.md](/tmp/metasheet2-yjs-rollout-stack-advance/docs/operations/yjs-rollout-stack-advance-20260416.md:1)

## Behavior

Default mode is dry-run only.

With `--apply`, the script:

- checks the live GitHub state for `#888-#892`
- finds open child PRs whose parent is already merged
- runs `gh pr edit --base main` for those PRs

## Scope

This is maintainer automation only. It does not change runtime code, rollout docs, or pilot scripts.
