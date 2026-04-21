# Verification - Yjs REST Invalidation Final Wiring Fix

- Branch: `codex/wire-yjs-text-cell-20260420`
- PR: `#960`
- Date: 2026-04-21
- Verified commits: `96d2f76ca`, `e014c8182`
- Linked development MD:
  `docs/development/yjs-rest-invalidation-final-wiring-development-20260421.md`

## Local Verification

### Focused backend tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/yjs-rest-invalidation.test.ts \
  tests/unit/record-write-service.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       34 passed (34)
```

Coverage from this run:

- Existing Yjs snapshot -> REST update -> invalidate -> next Yjs open reads the
  REST value, not the stale snapshot.
- `invalidateDocs` destroys in-memory docs without snapshotting stale content.
- `YjsRecordBridge.cancelPending` cancels pending debounce timers so stale bridge
  flushes cannot run after REST invalidation.
- REST `/patch` route passes the module-level `yjsInvalidator` into its
  request-local `RecordWriteService`.
- `RecordWriteService.patchRecords()` calls invalidation before realtime
  broadcast and before eventBus emission.
- `source = 'yjs-bridge'` skips invalidation.
- Invalidator throw does not fail the REST patch.

### Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

```text
@metasheet/core-backend@2.5.0 build
tsc
EXIT=0
```

### GitHub checks

Observed on PR #960 before adding this documentation-only commit:

```text
after-sales integration      pass
contracts (dashboard)        pass
contracts (openapi)          pass
contracts (strict)           pass
core-backend-cache           pass
coverage                     pass
e2e                          pass
migration-replay             pass
pr-validate                  pass
telemetry-plugin             pass
test (18.x)                  pass
test (20.x)                  pass
Strict E2E with Enhanced Gates skipping
```

PR metadata at that point:

```text
head: e014c81821dd5da82f58b82a27d6589bf6cd6638
mergeable: MERGEABLE
reviewDecision: REVIEW_REQUIRED
```

## Manual Staging Verification Still Required

After PR #960 is merged and deployed with `VITE_ENABLE_YJS_COLLAB=true`, run the
two-browser staging check:

1. Open the same text cell in two browsers/users.
2. Confirm a pre-existing text value opens as the DB value, not an empty string.
3. Edit non-overlapping ranges concurrently and confirm both edits survive.
4. Close the editor, update the same field through REST, then reopen through Yjs.
5. Confirm the reopened Yjs value is the REST value.
6. Check server logs for `[record-write] Yjs invalidation failed`.

Expected result: no stale Yjs value appears after the REST write, and no
invalidation failure log is emitted.

## Decision

Code-level verification is green. The remaining gate is repository review /
branch protection plus staging manual verification after merge.
