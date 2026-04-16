# Yjs Rollout Stack Promote Development

Date: 2026-04-16

## Context

The earlier stack helper could only retarget children to `main`.

That still left one manual maintainer step after each retarget:

1. open the child PR
2. enable `auto-merge`

## Change

Enhanced:

- [scripts/ops/advance-yjs-rollout-stack.mjs](/tmp/metasheet2-yjs-rollout-stack-promote/scripts/ops/advance-yjs-rollout-stack.mjs:1)

Updated:

- [docs/operations/yjs-rollout-stack-advance-20260416.md](/tmp/metasheet2-yjs-rollout-stack-promote/docs/operations/yjs-rollout-stack-advance-20260416.md:1)

## New Behavior

The script now:

- includes the full stack through `#894`
- supports `--enable-auto-merge`
- can retarget eligible child PRs to `main`
- can immediately run `gh pr merge --auto --squash` for those same PRs

## Scope

This is maintainer workflow automation only. It does not change runtime rollout behavior.
