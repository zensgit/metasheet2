# Multitable Comment Inbox Activity Realtime Development

Date: 2026-04-04
Branch: `codex/multitable-comment-inbox-activity-realtime-20260404`

## Scope

Bring multitable comment inbox realtime behavior back in line with the newer inbox semantics from `#643`.

Current runtime already treats the inbox as:

- mentions, plus
- unread comments from other collaborators

But the inbox realtime composable was still listening only to `comment:mention`, so non-mention unread activity on already loaded inbox sheets required a manual refresh.

This slice closes that drift without changing backend fanout.

## Changes

### Frontend runtime

- Extended `useMultitableCommentInboxRealtime()` to accept the currently loaded inbox sheet ids.
- Added sheet-room subscription management on the inbox socket:
  - join `comment-sheet` rooms for the current inbox sheet set
  - leave rooms when the loaded inbox sheet set changes
- Realtime inbox refresh now triggers on:
  - `comment:mention`
  - `comment:created`
  - `comment:resolved`
- Added a self-author guard so sheet `comment:created` events authored by the current user do not trigger unnecessary inbox refreshes.
- Kept the existing refresh queue coalescing so bursts of activity still collapse into bounded refreshes.

### Frontend integration point

- `MultitableCommentInboxView` now passes the loaded inbox sheet ids into the realtime composable based on the current inbox items.

### Tests

- Expanded the inbox realtime test suite to cover:
  - mention-triggered refresh
  - non-mention activity refresh on subscribed sheets
  - ignoring self-authored creates
  - join/leave behavior when loaded inbox sheets change
  - burst coalescing across activity events

## Files

- `apps/web/src/multitable/composables/useMultitableCommentInboxRealtime.ts`
- `apps/web/src/views/MultitableCommentInboxView.vue`
- `apps/web/tests/multitable-comment-inbox-realtime.spec.ts`

## Notes

- This is intentionally a frontend-only slice.
- It does not introduce a new backend `comment:activity` user-room event.
- Realtime coverage now tracks the currently loaded inbox sheets, which is the smallest safe step that aligns the page behavior with the existing activity inbox semantics.
- Local `node_modules` churn from `pnpm install --ignore-scripts` is worktree setup noise and is not part of the implementation scope.
