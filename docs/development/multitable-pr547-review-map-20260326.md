# Multitable PR547 Review Map

## Goal

Provide a fast reviewer path for PR `#547` without forcing reviewers to re-derive the slice boundaries from commit history.

## Recommended Review Order

### 1. Route and contract foundation

Review these first:

- `f42aac363` route mount
- `84bd262ed` OpenAPI parity
- `a122ef49c` submit + sheet delete alignment
- `a574a8417` / `93ad8b3b2` / `20bf9471c` / `f2c1abf27` `ViewManager` runtime bridge

Key files:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/router/appRoutes.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/router/multitableRoute.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/services/ViewManager.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/openapi/src/paths/multitable.yml`

Reviewer question:

- Does frontend/runtime/OpenAPI now describe the same multitable contract?

### 2. Embed host runtime slice

Review next:

- `8114312f4` embed host protocol slice
- `f722ca90d` live smoke runtime fixes

Key files:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableEmbedHost.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-multitable-live-smoke.mjs`

Reviewer question:

- Do host navigation results, deferred replay, and dirty-state guards now behave deterministically enough for iframe embedding?

### 3. Pilot evidence and gate chain

Review these as one block:

- `19a903512`
- `dffc136b4`
- `df796ef59`
- `7441708e5`
- `e82a4f265`
- `7cbaed82a`
- `8fe936fae`
- `393112068`
- `c72d4486a`
- `28145324d`
- `55a96a6be`

Key files:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-readiness.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-gate.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-local.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-staging.sh`

Reviewer question:

- Does the pilot chain now produce canonical, replayable artifacts for local, staging, handoff, and release-bound flows?

### 4. Focused test-only contract corrections

Review last:

- `ab3328346`

Key file:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.test.mjs`

Reviewer question:

- Does the test now assert the actual emitted contract shape rather than a stale path expectation?

## Highest-Value Files

If a reviewer only has time for a narrow pass, prioritize:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableEmbedHost.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/services/ViewManager.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-multitable-live-smoke.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-gate.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-readiness.mjs`

## What Is Already Verified Locally

The branch has already accumulated focused green evidence for:

- runtime/OpenAPI parity
- `ViewManager` CRUD/form/config bridging
- embed host protocol and workbench dirty-state reporting
- local pilot live smoke
- local/staging readiness and release-bound wrappers
- canonical gate, gate artifact promotion, and operator replay helpers

## Reviewer Shortcut

If a reviewer wants the shortest defensible path:

1. Check `ViewManager.ts` bridge changes.
2. Check `MultitableEmbedHost.vue` + `MultitableWorkbench.vue`.
3. Check `multitable-pilot-release-gate.sh` + `multitable-pilot-readiness.mjs`.
4. Skim the latest PR comments for focused verification commands and artifact paths.

That path covers the highest-risk runtime and delivery surfaces without rereading every doc in the branch.
