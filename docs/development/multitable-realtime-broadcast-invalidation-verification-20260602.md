# Multitable realtime broadcast invalidation verification

**Date:** 2026-06-02  
**Slice:** realtime `sheet:op` room gate + value-free invalidation implementation  
**Design lock:** `docs/development/multitable-realtime-broadcast-invalidation-design-20260601.md` (#2181)  
**Status:** IMPLEMENTATION VERIFICATION SNAPSHOT

---

## Contract Verified

- `join-sheet` no longer trusts `handshake.query.userId`; sheet room membership and presence use the token-derived user id.
- `join-sheet` requires a trusted socket identity plus sheet `canRead` through the injected sheet-room auth checker.
- `publishMultitableSheetRealtime` still invalidates the records cache, but publishes only metadata to `spreadsheet.cell.updated`; `recordPatches[].patch` does not reach `sheet:op`.
- Frontend sheet/presence/comment realtime clients send the existing JWT through Socket.IO `auth.token`.
- Frontend sheet realtime treats `sheet:op` as invalidation only; it does not apply value-bearing patches even if an old sender includes them.

---

## Tests Run

| Gate | Command | Result |
| --- | --- | --- |
| Backend type-check | `pnpm --filter @metasheet/core-backend exec tsc --noEmit` | PASS |
| Frontend type-check | `pnpm --filter @metasheet/web exec vue-tsc -b` | PASS |
| Frontend realtime specs | `pnpm --filter @metasheet/web exec vitest run --watch=false tests/multitable-sheet-realtime.spec.ts tests/multitable-sheet-presence.spec.ts tests/multitable-comment-realtime.spec.ts` | PASS, 4/4 |
| Realtime publish helper + record services | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-realtime-publish.test.ts tests/unit/record-write-service.test.ts tests/unit/record-service.test.ts --reporter=dot` | PASS, 60/60 |
| Socket.IO room gate + API publish regressions | `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/rooms.basic.test.ts tests/integration/multitable-sheet-realtime.api.test.ts tests/integration/multitable-attachments.api.test.ts --reporter=dot` | PASS, 20/20 |
| CI wiring | `.github/workflows/plugin-tests.yml` multitable real-DB step now includes `multitable-sheet-realtime.api.test.ts` and `rooms.basic.test.ts` | VERIFIED BY DIFF |

Notes:

- The Socket.IO room tests use a real Socket.IO server and inject a deterministic token verifier / sheet-room checker into `CollabService`; they do not rely on spoofable query identity.
- Local `rooms.basic.test.ts` server startup logged degraded DB initialization errors because the local default Postgres database is absent; the tested Socket.IO room behavior still ran and passed. CI runs this file in the existing Node 20 multitable real-DB step with `DATABASE_URL=postgresql://postgres@localhost:5432/metasheet_test`.
- A broader non-gating frontend command that also included `tests/multitable-workbench-view.spec.ts` failed one unrelated automation router assertion (`opens workflow designer with multitable context when automation is enabled`). The three touched realtime composable specs passed in the same run.

---

## Coverage Mapping

- R1/R2: `rooms.basic.test.ts` rejects unauthenticated and non-reader `join-sheet`, and asserts no `sheet:op` is received.
- R3/R8: `rooms.basic.test.ts` accepts a reader, emits trusted-token presence, and receives a value-free `sheet:op` with canary values absent.
- R5: `multitable-sheet-realtime.spec.ts` proves no-value / legacy-value `record-updated` events call `mergeRemoteRecord`, not `applyRemoteRecordPatch`.
- R6: `multitable-sheet-realtime.api.test.ts` and `multitable-attachments.api.test.ts` prove create, form update, bulk patch, and attachment update publishers emit value-free EventBus payloads.
- R7: `multitable-realtime-publish.test.ts` proves cache invalidation still runs while `recordPatches` are stripped.

---

## Non-Goals Preserved

- Comment-specific rooms still carry comment payloads and are not treated as cell value channels.
- Yjs document sync remains separate; this slice only covers Socket.IO `sheet:op` published by `publishMultitableSheetRealtime`.
- Per-recipient masked value fan-out remains a future optimization, not part of this safety floor.
