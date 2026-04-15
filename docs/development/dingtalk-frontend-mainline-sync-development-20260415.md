## Summary

- Synced `codex/dingtalk-identity-frontend-20260414` with the updated runtime base branch `origin/codex/dingtalk-identity-runtime-20260414`.
- The only merge conflict was in `apps/web/tests/userManagementView.spec.ts`.
- Resolved the conflict by keeping the frontend runtime-status assertions while reusing the newer shared payload builders from the runtime branch.

## Code Changes

- `apps/web/tests/userManagementView.spec.ts`
  - expanded `buildDingTalkAccessPayload()` to include:
    - `provider`
    - `autoLinkEmail`
    - `autoProvision`
    - `server`
    - `directory`
  - resolved the mocked `/dingtalk-access` and `/member-admission` responses to keep using the shared builder helpers

## Notes

- No production Vue component logic changed in this sync.
- The sync keeps the frontend tests aligned with the runtime branch response shape after the runtime branch picked up `origin/main`.
