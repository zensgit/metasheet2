# Record-Restore Remainder — Development & Verification Report (2026-06-15)

Continues `multitable-record-restore-layer1-dev-verification-20260615.md` (Slice 1, PR #2654). Covers the **remaining** development from the design's §6 follow-up list, driven by a 6-scout feasibility audit that classified each item buildable-vs-gated with code evidence.

## 0. Outcome at a glance

| Item | Status | PR |
|---|---|---|
| Slice 1 — record-level update-restore | shipped earlier | #2654 |
| **Slice 2a — live-record link-field restore** | **built + verified** | **#2660** |
| **Retention sweep + `VERSION_EXPIRED`** | **built + verified** | **#2660** |
| **Slice 3 — frontend "restore to this version" (full-record MVP)** | **built; unit/component-verified, real-wire QA pending** | **#2662** |
| Slice 2b — undelete | **gated** (data gap + product decision) | — |
| Layer 2 — `MetaSnapshotService` | **gated** (separate program, design-lock + 5 owner decisions) | — |
| `plugin-intelligent-restore` deletion | **gated** (cross-cutting cleanup decision) | — |
| Revision partial-unique-index migration | **gated** (sensitive migration; optional hardening) | — |
| Per-field (column-level) frontend restore | **deferred** (MVP is full-record) | — |
| `mapFieldType` button-case | **not ours** (button-field track; restore handles it by raw type) | — |

All PRs are stacked on Slice 1 (#2654) and auto-retarget to `main` on its merge. `mapFieldType`/per-field/Layer-2 are explicitly out of the autonomous build scope; the rest is the cleanly-buildable remainder.

## 1. Built — Slice 2a (live-record link-field restore) · PR #2660

Lifts the Lock D link exclusion for **live** records. Link fields are restored as **SET** changes — the snapshot stores the link id array in `data`, and `RecordWriteService.patchRecords` already owns `meta_links` sync (`record-write-service.ts` ~810-870: full-clear when `ids=[]`, else incremental `toDelete`/`toInsert`) + the twoWay mirror fan-out (`collectMirrorInvalidation`). Restore routes the snapshot's id array through that path; a field absent at version N becomes a SET to `[]` (clear). Never the data-`unset` op (which touches only the `data` mirror and would desync the join table). Emitted only when the id set differs (no-op preserved). A snapshot referencing a now-deleted foreign record is rejected fail-closed by the spine's link-target validation (`VALIDATION_ERROR`).

Tests (in the restore matrix): T6 (clear), T6e (re-point), T6a (twoWay-configured), T6f (deleted-target fail-closed).

## 2. Built — Retention + `VERSION_EXPIRED` · PR #2660

`meta-revision-retention.ts`: prunes `meta_record_revisions`, mirroring the `ai-usage-ledger` bounded-DELETE discipline (id/ctid sub-select + LIMIT). **Disabled by default** (`MULTITABLE_META_REVISION_RETENTION_ENABLED=1`) so the restore guarantee is preserved until the owner opts in + picks a policy (the N/D values are the owner's product decision). Modes: keep-last-N (primary, floored at 10) / keep-days (floored at 30). **Invariant:** never deletes a record's latest revision (`row_number()=1` over `version DESC`).

The restore route now distinguishes a **pruned** target from a never-existed one: when the exact revision is absent AND `targetVersion < MIN(retained version)` for that record → **410 `VERSION_EXPIRED`**. This is data-driven (correct whether or not the sweep is scheduled; with retention off, `MIN` is the create version so it never fires spuriously). OpenAPI + parity updated.

Tests: config-resolver unit (disabled-default + floors); T13 (keep-last-N prune + `VERSION_EXPIRED`); T14 (disabled no-op).

## 3. Built — Slice 3 frontend (full-record MVP) · PR #2662

Drawer history timeline → per-revision "Restore" button (prior non-delete versions; gated on `canEdit`; never current). Emits `restore` to the workbench (consistent with `patch`/`delete`/`toggle-lock`); the workbench owns confirm + `apiClient.restoreRecordVersion` + grid/drawer refresh. Client method surfaces all six backend error codes on `.code`. i18n through the typed `meta-record-labels` module.

**Conscious deviations from the locked design (flagged, not omissions):** full-record MVP (per-field deferred); `plugin-intelligent-restore` NOT deleted (cross-cutting cleanup — gated).

**Verification boundary (honest):** `vue-tsc -b` 0 errors; client unit 8/8 (POST body + all 6 error codes); drawer component 4/4 (render/emit); i18n+regression 37/37. The full **browser→workbench→client→backend→DB round trip is NOT exercised in CI** — mocked component/unit tests are render/emit + contract only (deliberately, to avoid the wire-vs-fixture false-green). **Needs manual or e2e QA before merge.**

## 4. Gated — and the specific decision each needs

- **Slice 2b (undelete).** `deleteRecord` hard-deletes `meta_links` (`record-service.ts` ~736: `WHERE record_id=$1 OR foreign_record_id=$1`, both directions) and the delete revision's snapshot captures only `meta_records.data` — the link edges are **not** recoverable from the snapshot. **Decision:** accept partial undelete (data only, links lost) OR land a forward-capture change first (snapshot link edges at delete time) so undelete is deterministic. Also: record-id reuse after hard delete. Needs an owner product call before code.
- **Layer 2 (`MetaSnapshotService`).** A net-new base/sheet-level, schema-inclusive checkpoint engine. The audit surfaced five linked product decisions (notably: base restore is inherently **destructive** — it rolls back DDL + deletes post-snapshot records — which conflicts with Layer 1's "forward change, never destructive rewind" lock). Separate program, own design-lock + owner gate.
- **`plugin-intelligent-restore` deletion.** Non-functional stub, but deleting a plugin is a destructive cross-cutting side effect beyond what restore needs. Owner decides re-home vs delete.
- **Revision partial-unique index** `(sheet_id, record_id, version) WHERE action <> 'delete'`. Safe and recommended for data integrity, but a migration on a hot table — kept out to preserve a minimal migration surface; land as its own gated hardening.
- **Per-field restore.** Backend already supports it (restore a subset of fields). The MVP is full-record; per-field UI is a follow-up.
- **`mapFieldType` button-case.** The button-field track's domain; restore correctly excludes `button` by raw type regardless, so no cross-track change was made here.

## 5. Consolidated verification (local, real Postgres + web vitest)

- Backend: `tsc --noEmit` 0 errors · restore matrix **22/22** · retention config **5/5** · lock-guard 4/4 · mirror-links 12/12 · patch 6/6 · OpenAPI parity green.
- Frontend: `vue-tsc -b` 0 errors · client **8/8** · drawer **4/4** · i18n+drawer regression **37/37**.
- DB: throwaway `metasheet_restore_l1` (fresh, migrated) — droppable.

## 6. Landing

Three stacked PRs on #2654: **#2660** (backend remainder — ready), **#2662** (frontend — ready pending manual/e2e QA). Merge order: #2654 → #2660 → #2662 (each retargets to `main` as its base merges). The frontend should get a real-app QA pass (open a record drawer → History → Restore → confirm the DB + drawer update) before merge.

> Update 2026-06-16: #2654/#2660 merged to `main` (plus per-field backend + review-hardening #2672/#2677). #2662 reconciled to main (behind 0→merge-time) and given the render-check below.

## 7. Browser render-check (Path A component harness, 2026-06-16)

Closes the **render + interaction** half of the §6 QA item in a real browser (Chromium via Playwright). The **live round-trip** half stays open (below).

Harness: mounted `MetaRecordDrawer` (visible, canEdit) with a fake `apiClient.listRecordHistory` returning 3 canned revisions (v3 current / v2 / v1) — no backend. Drove the History tab + a restore click.

Verified (**0 console / pageerror**):
- History list renders all 3 revisions with action label (Updated/Created), `v{n}` badge, timestamp, actor, source, and changed-field list.
- `canRestoreTo` correct **visually**: Restore shows on v2 and v1 only — **not** on current v3 (`version === record.version`), not on delete revisions.
- Clicking Restore on v2 emits `restore { recordId:'rec1', targetVersion:2, expectedVersion:3 }` — drawer emits, parent owns the call (no direct mutation), exact payload.

Evidence: `~/Downloads/Github/_bv-evidence-20260616/bv-drawer-history.png`.

**STILL OPEN — not covered by Path A (needs real-app QA or Path B full-stack):** the live wire `workbench onRestore → apiClient.restoreRecordVersion → backend → DB revert → drawer/grid refresh + confirm dialog`. Backend side is covered by the restore integration matrix (now **30/30**) + the jsdom client test (POST body + all error codes); the end-to-end browser wire is not. **Real-app QA still recommended before merge.**
