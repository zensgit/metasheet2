# Multitable Record History Verification - 2026-04-30

## Environment

- Worktree: `/tmp/ms2-record-history-20260430`
- Branch: `codex/multitable-record-history-20260430`
- Base after rebase: `origin/main@212f9953b`
- Dependency setup: `pnpm install --frozen-lockfile` in the temporary worktree, using the checked-in lockfile.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/integration/multitable-record-patch.api.test.ts \
  --reporter=dot
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-record-drawer.spec.ts \
  tests/multitable-client.spec.ts \
  --reporter=dot
pnpm exec tsx packages/openapi/tools/build.ts
node --test scripts/ops/multitable-openapi-parity.test.mjs
```

## Results

- `pnpm install --frozen-lockfile`: pass.
- `pnpm --filter @metasheet/core-backend build`: pass.
- `pnpm --filter @metasheet/web exec vue-tsc -b --noEmit`: pass.
- Backend focused tests: 55/55 pass.
- Frontend focused tests: 28/28 pass.
- OpenAPI build: pass.
- Multitable OpenAPI parity test: 1/1 pass.

## CI Follow-up - 2026-05-05

Initial PR CI failed `test (18.x)` / `test (20.x)` in `tests/integration/multitable-record-patch.api.test.ts`.

Root cause:

- The integration test's hand-written SQL stand-in still matched the old `SELECT id, version, created_by ... FOR UPDATE` shape.
- The record history implementation correctly changed the locked row select to include `data` for revision snapshots.
- The same fixture also lacked a handler for `INSERT INTO meta_record_revisions`.

Fix:

- Updated the integration fixture to return `data` from locked rows.
- Added no-op `meta_record_revisions` insert handlers where the test exercises successful PATCH writes.

Re-run result:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-record-patch.api.test.ts --reporter=verbose`: 6/6 pass.
- Full focused backend command listed above: 55/55 pass.

Observed non-failing noise:

- Backend tests print existing post-commit hook failure logs in tests that intentionally verify hook failures do not fail the write.
- Frontend Vitest prints `WebSocket server error: Port is already in use`; the focused tests still pass.

## Coverage

Backend:

- Create writes a `create` revision with actor, changed fields, patch, and snapshot.
- Single-record patch writes an `update` revision after version increment.
- Delete writes a `delete` revision with pre-delete snapshot.
- Batch/Yjs shared patch path writes one revision per updated record.
- Yjs-originated writes preserve `source = yjs-bridge`.
- Existing version conflict and own-write denial tests still pass.

Frontend:

- API client encodes sheet/record ids, sends `limit`, unwraps response data, and drops malformed history items.
- Record drawer renders `Details` and `History` tabs.
- History tab lazy-loads revisions and displays action, version, actor, source, and field labels.
- Drawer shows an unavailable state when no API client/sheet id is provided.

## Known Limits

- No cleanup job in v1. History retention is indefinite until a product retention rule exists.
- The drawer only fetches history for live records.
- Route integration tests with full DB permission fixtures remain a follow-up; focused unit/UI tests cover the new seams.
