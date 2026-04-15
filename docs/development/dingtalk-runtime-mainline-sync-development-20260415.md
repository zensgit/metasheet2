## Summary

- Synced `codex/dingtalk-identity-runtime-20260414` with `origin/main` in an isolated detached worktree.
- Resolved the only code conflicts in `admin-users` runtime access snapshot and its unit test.
- Preserved both sides of the API shape:
  - runtime status block from the DingTalk runtime probe work
  - directory link snapshot added on `main`

## Code Changes

- `packages/core-backend/src/routes/admin-users.ts`
  - kept `server: getDingTalkRuntimeStatus()` in the DingTalk access response
  - added `directory: { linked, linkedCount }` from directory link counts
  - made top-level `requireGrant`, `autoLinkEmail`, and `autoProvision` follow the runtime status helper
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
  - updated the access snapshot assertion to require both `server` and `directory`

## Notes

- A stale local runtime worktree had a large unrelated staged stack, so this sync was redone from a clean detached worktree to avoid accidental carry-over.
- No frontend or docs payload shape was expanded beyond the merged response fields above.
