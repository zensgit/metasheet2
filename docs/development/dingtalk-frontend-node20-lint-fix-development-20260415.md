## Summary

- Fixed the Node 20 CI blocker on PR `#871`.
- The failure was not a runtime regression; it was a lint error caused by an unused local type alias in `apps/web/src/views/LoginView.vue`.

## Code Changes

- `apps/web/src/views/LoginView.vue`
  - removed the unused `DingTalkRuntimeUnavailableReason` type alias

## Notes

- No behavior changed.
- This is a lint-only fix to unblock the frontend PR after retargeting it to `main`.
