# Multitable Comment Inbox Realtime Development 2026-04-04

## Summary

- Added [useMultitableCommentInboxRealtime.ts](/private/tmp/metasheet2-multitable-comment-inbox-realtime-20260404/apps/web/src/multitable/composables/useMultitableCommentInboxRealtime.ts) to subscribe the inbox page to `comment:mention` user-room events.
- Wired [MultitableCommentInboxView.vue](/private/tmp/metasheet2-multitable-comment-inbox-realtime-20260404/apps/web/src/views/MultitableCommentInboxView.vue) to auto-refresh inbox data when new mentions arrive, instead of requiring a manual refresh.
- Added targeted coverage in [multitable-comment-inbox-realtime.spec.ts](/private/tmp/metasheet2-multitable-comment-inbox-realtime-20260404/apps/web/tests/multitable-comment-inbox-realtime.spec.ts) and refreshed [multitable-comment-inbox-view.spec.ts](/private/tmp/metasheet2-multitable-comment-inbox-realtime-20260404/apps/web/tests/multitable-comment-inbox-view.spec.ts) for the new socket/auth plumbing.

## Notes

- Scope is intentionally frontend-only. Existing backend `comment:mention` user-room delivery remains unchanged.
- Realtime refreshes are coalesced while a prior inbox refresh is still running, so burst mentions trigger at most one queued follow-up reload.
