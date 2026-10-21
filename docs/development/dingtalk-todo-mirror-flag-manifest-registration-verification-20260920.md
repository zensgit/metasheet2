# DINGTALK_TODO_MIRROR_* flag manifest registration — verification (2026-09-20)

## Test run

```
node --test scripts/ops/global-history-flag-manifest.test.mjs
tests 30, pass 30, fail 0
node --test scripts/ops/multitable-global-history-flag-status.test.mjs
tests 20, pass 20, fail 0
```

## Mutation checks (both performed against the working tree, then reverted — diff against origin/main
is clean of the mutations)

1. **Remove one manifest registration** (deleted the `DINGTALK_TODO_MIRROR_INTERVAL_MS` `FlagSpec`
   object from `global-history-flag-manifest.mjs`, keeping the grep extension in the test):
   → `completeness` test goes red:
   `AssertionError: source reads Global-History flags MISSING from the manifest: DINGTALK_TODO_MIRROR_INTERVAL_MS`
   Restored; suite green again (30/30).

2. **Remove the grep extension** (reverted `globalHistoryFlagsInSource()` in the test to drop the
   `dingtalkTodoMirror` term from the returned set, keeping both manifest registrations):
   → `completeness` test goes red on the phantom branch:
   `AssertionError: manifest lists flags NOT read anywhere in packages/core-backend/src (stale or typo'd key): DINGTALK_TODO_MIRROR_ENABLED, DINGTALK_TODO_MIRROR_INTERVAL_MS`
   Restored; suite green again (30/30), confirmed byte-identical to the fixed version via `diff`.

Both directions of the registration/grep pairing are load-bearing, as the task required.

## Scope check

- `git diff origin/main | grep -P '\x08'` → empty (no backslash/control-char contamination).
- `packages/openapi/src` untouched — no dist/dist-sdk regeneration needed.
- `df -h /c` → 16G available (above the 4G stop threshold).
- Files touched: `scripts/ops/global-history-flag-manifest.mjs`,
  `scripts/ops/global-history-flag-manifest.test.mjs`, `packages/core-backend/src/index.ts` (comment
  only), plus these two docs. No production behavior change: the two flags already existed and were
  already read at the cited sites; this PR only adds their operator-facing documentation/registration
  and corrects a stale comment.
- `scripts/ops/multitable-global-history-flag-status.mjs` requires no edit (reads
  `GLOBAL_HISTORY_FLAG_KEYS` generically); its own test suite (20/20) passes unmodified, confirming no
  regression from the manifest addition.
