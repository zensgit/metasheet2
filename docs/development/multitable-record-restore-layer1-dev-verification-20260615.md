# Layer 1 Record-Level Version Restore — Development & Verification Report (2026-06-15)

Companion to the design-lock: `docs/development/multitable-record-restore-layer1-design-20260615.md`.

- **Branch / worktree:** `worktree-claude+multitable-record-restore-l1-20260615` (isolated worktree off `origin/main` @ `c71b7dd12`).
- **Commit:** `cf25ccd89` — `feat(multitable): record-level version restore (Layer 1)`.
- **Status:** Implemented + verified locally (typecheck, unit regression, real-DB matrix, OpenAPI parity all green). **Not pushed, no PR opened** — awaiting owner go.

---

## 1. What was built

A server-side endpoint to restore a single **live** multitable record's scalar user-data fields to one of its prior revisions:

```
POST /api/multitable/sheets/:sheetId/records/:recordId/restore
body:    { targetVersion: int≥1, expectedVersion: int≥0 }
200:     { ok, data: { recordId, newVersion, noop, restoredFieldIds[], skippedFieldIds[] } }
errors:  VERSION_NOT_FOUND(404) · VERSION_CONFLICT(409) · RESTORE_UNSUPPORTED(422)
         · RESTORE_FORBIDDEN(403) · SNAPSHOT_UNAVAILABLE(422) · SCHEMA_DRIFT(422)
         · NOT_FOUND(404, hard-deleted record)
```

It reuses the canonical `RecordWriteService.patchRecords` spine end-to-end (transaction, optimistic version re-check, revision emit, Yjs invalidation, `recalculateFormulaFields`), adding only two restore-owned pieces: the layer-3 write pre-check and the `unset` primitive.

The five locked principles all hold and are test-pinned:

- **Forward-change / no-op** — a value-changing restore emits a new `action='update', source='restore'` revision and bumps version; an empty restorable diff is a no-op (no write, no revision) but still runs the concurrency check.
- **Lock A faithful set∪unset** — diff is computed against the unmasked stored after-image snapshot; never replays the stored incremental `patch`.
- **Lock B write-gated, own layer-3** — every differing field is gated by BOTH the static `FieldMutationGuard` (spine) AND restore's own `field_permissions` pre-check (the spine does **not** enforce layer-3 — confirmed at `univer-meta.ts:3181` / `multitable-ai.ts:530`). Atomic reject (`skippedFieldIds` always `[]`).
- **Lock C update-restore only** — hard-deleted record → 404; `targetVersion` resolves `action<>'delete'` (delete-only → `RESTORE_UNSUPPORTED`; update+delete at one version → uses the update).
- **Lock D scalar-only** — computed (`formula`/`lookup`/`rollup`), `link`, system-auto (`autoNumber`/`createdTime`/`modifiedTime`/`createdBy`/`modifiedBy`), and `attachment` excluded **by type**.

Plus the pre-landing boundary patch: `RecordWriteSource += 'restore'`, no-op-precedes-conflict-check ordering, and `SCHEMA_DRIFT` for snapshot fields no longer in the schema.

## 2. Files changed (commit `cf25ccd89`, +1333/−12)

| File | Change |
|---|---|
| `packages/core-backend/src/multitable/post-commit-hooks.ts` | `RecordWriteSource` += `'restore'` (non-bridge → fires Yjs invalidation). |
| `packages/core-backend/src/multitable/record-write-service.ts` | `RecordChange.op?: 'set'\|'unset'`; `validateChanges` gates unset (writability + forbids link/attachment unset); write loop applies `data=(data-keys)||patch`, **after-image drops removed keys**, `changedFieldIds` includes removals, revision `patch` marks removal with `null`. Set-only writes keep byte-identical SQL. |
| `packages/core-backend/src/routes/univer-meta.ts` | New `POST …/restore` route (+`type RecordChange` import). Resolution, concurrency pre-check, snapshot read+null guard, Lock D exclusion, schema-drift, dual write-gate, no-op, delegates to `patchRecords` with `source:'restore'`. |
| `packages/openapi/src/paths/multitable.yml` (+ regenerated `dist/*`) | Restore path: request body, 200 shape, 7 documented statuses. |
| `packages/core-backend/tests/integration/multitable-record-restore.test.ts` | New real-DB matrix (15 cases). |
| `.github/workflows/plugin-tests.yml` | Test added to the enumerated Node-20 multitable real-DB step + step name. |
| `docs/development/multitable-record-restore-layer1-design-20260615.md` | Design-lock (carried in; grounding bumped to `c71b7dd12`). |

## 3. Verification — commands and results

Environment: local Postgres (`metasheet-dev-postgres`, PG15) at `:5432`. CI's `postgres@…/metasheet_test` role/db is owned by another role here, so a **fresh DB owned by the connecting superuser** was created and migrated to remove both the permission and any stale-schema variable:

```
createdb metasheet_restore_l1
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_restore_l1 pnpm --filter @metasheet/core-backend migrate   # all migrations OK
```

**Harness baseline (proved on known-good code before writing the new test):**
```
vitest … run tests/integration/multitable-record-history-field-mask.test.ts   → 8 passed (8)
```

**Typecheck:** `npx tsc --noEmit` (packages/core-backend) → **exit 0, 0 errors**.

**Unit regression (the hot write path I edited):**
```
vitest run tests/unit/record-write-service.test.ts record-service.test.ts yjs-rest-invalidation.test.ts → 77 passed (77)
```

**Integration — new matrix + spine/history regression (single run):**
```
vitest --config vitest.integration.config.ts run \
  multitable-record-restore.test.ts            → 15 passed
  multitable-record-history-field-mask.test.ts →  8 passed
  multitable-record-patch.api.test.ts          →  6 passed
  multitable-patch-partial-success.api.test.ts →  2 passed
Tests  31 passed (31)
```
(Executed counts are non-zero — not a `describeIfDatabase` skip-green.)

**OpenAPI parity:** `pnpm run verify:multitable-openapi:parity` → build OK; `✔ multitable openapi stays aligned with runtime contracts` (1 pass, 0 fail).

### Test matrix → assertions

| Case | What it pins |
|---|---|
| T1 | Faithful set+unset; **removed key absent from the stored after-image snapshot**, not just the live row (the advisor's catch-2). |
| T2 | New revision is `action=update, source=restore`, version bumped; prior versions intact. |
| T3 | Undo = restore to the **pre-restore** version; re-restoring the current version is a no-op. |
| T4 | Layer-3 `read_only` differing field → atomic `RESTORE_FORBIDDEN`; nothing written. |
| T5 / T5b | Differing `formula` / `autoNumber` neither blocks nor is overwritten (Lock D by type). |
| T6 | Differing `link` not written; `meta_links` row left untouched. |
| T6b | Snapshot field absent from current schema → `SCHEMA_DRIFT`. |
| T7 | Delete-only version → `RESTORE_UNSUPPORTED`; update+delete → uses update; hard-deleted record → 404. |
| T8 | `null` snapshot → `SNAPSHOT_UNAVAILABLE` (no patch-replay fallback). |
| T9 | Empty diff → `noop:true`; **stale `expectedVersion` → `VERSION_CONFLICT` even for a no-op**. |
| T10 | Stale `expectedVersion` vs current → `VERSION_CONFLICT`. |
| T11 | Restore fires the Yjs invalidator for the record (`source='restore'` is not bridge-origin). |
| T12 | Non-writer rejected before any field logic. |

## 4. Scope notes / honest gaps

- **Type-change drift** is only partially covered: a snapshot field *missing* from the schema → `SCHEMA_DRIFT`; a field whose *type changed* since capture is not detectable without a stored schema snapshot (Layer 2), so it falls through to the spine's value validators (→ `VALIDATION_ERROR`), not `SCHEMA_DRIFT`. Documented, fail-closed either way.
- **Value equality** uses `JSON.stringify` comparison — exact for scalars/arrays; object-key-order is stable because both sides come from the same JSON serializer. Adequate for Slice 1's scalar scope.
- **Inherited, not independently re-tested (coverage honesty):**
  - *Row-level write scope (own-vs-all):* enforced by the shared spine — `ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'edit')` runs inside the `FOR UPDATE` loop (`record-write-service.ts:621`). Restore passes `sheetScope`/`access`, so an own-records-only actor cannot restore another user's record. This is covered by the record-patch suite; the restore matrix uses a full-perm writer and does not re-seed sheet-scope assignments to re-prove it.
  - *In-transaction anti-TOCTOU:* the restore matrix's T10 exercises the route's **pre-check** (`expectedVersion` ≠ current). The in-txn re-check (a write landing between the route read and the spine's `FOR UPDATE`) is inherited unchanged from `patchRecords` and covered by the patch suite; it is not separately simulated. T10's comment says so.
- **Not run here:** the full CI multitable real-DB list (ran the affected subset); frontend (Slice 3 — none built); cross-browser. CI will run the new test via the enumerated list on Node 20.
- **Deferred (separate gated opt-ins, unchanged from the design):** Slice 2 (undelete + link-value restore), Slice 3 (frontend / plugin re-home), retention (`VERSION_EXPIRED`), revision partial-unique index, partial-restore mode.

## 5. Landing instructions (owner action)

Nothing is pushed. To land:
1. Push the branch and open a PR against `main` (the worktree is already based on `origin/main` @ `c71b7dd12`; rebase if main advanced).
2. CI runs the new matrix automatically (enumerated in `plugin-tests.yml`).
3. The local throwaway DB `metasheet_restore_l1` can be dropped (`dropdb metasheet_restore_l1`).

Self-review checklist from the design's §5 is satisfied: no patch-replay restore; restore runs its own layer-3 gate; computed/link/system-auto excluded by type and `meta_links` untouched; `SCHEMA_DRIFT`/`SNAPSHOT_UNAVAILABLE` guards; value-change emits exactly one revision while no-op emits none (concurrency still checked); removed fields are `null` in the revision patch; `targetVersion` resolution excludes deletes; `RecordWriteSource` includes `'restore'`; one write path only; endpoint-scoped (no RBAC/auth central-file change).
