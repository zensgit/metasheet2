# Multitable Comment Jump Development

Date: 2026-04-04
Branch: `codex/multitable-comment-jump-main-20260404`

## Scope

This slice closes the remaining front-end comment jump gap between the multitable comment inbox route and the actual multitable workbench state.

## Changes

### Route query contract

- Extended multitable route query parsing to include `fieldId`.
- Updated route typing so comment jump URLs can carry:
  - `recordId`
  - `commentId`
  - `fieldId`
  - `openComments`

### Embed host forwarding

- Updated `MultitableEmbedHost.vue` to forward `commentId`, `fieldId`, and `openComments` into `MultitableWorkbench`.
- This fixes a real gap in the previous implementation: the route parser already understood comment jump state, but the embed host did not pass the state through to the workbench.

### Inbox open behavior

- Updated `MultitableCommentInboxView.vue` so opening an inbox item now includes `fieldId` when the inbox item is field-scoped.
- The inbox route therefore preserves field comment context instead of only opening generic record comments.

### Workbench deep-link recovery

- Extended `MultitableWorkbench.vue` to accept `fieldId` as an initial prop.
- Deep-linked comment navigation now restores:
  - record selection
  - comment drawer visibility
  - highlighted comment id
  - field-scoped thread selection
- The field id is now carried into comment submission so a route-opened field thread does not lose `targetFieldId`.

## Tests updated

- `apps/web/tests/multitable-embed-route.spec.ts`
- `apps/web/tests/multitable-embed-host.spec.ts`
- `apps/web/tests/multitable-comment-inbox-view.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`

