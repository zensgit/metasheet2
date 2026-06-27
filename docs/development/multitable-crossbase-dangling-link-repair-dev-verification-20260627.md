# Cross-base deepen — slice 2: dangling-link referential integrity — dev & verification (2026-06-27)

> Status: built + verified (real-DB fail-first proven). Grounding: `origin/main` @ `74ae76635`. Second slice of the
> cross-base deepen arc (gap (c) from the benchmark refresh audit). Owner-reviewed + design-narrowed before build.

## 1. Investigation (the audit overstated the gap — investigate-first paid off)
The audit said "a deleted foreign record leaves a dangling cross-base edge." Reading the code corrected this:
- **`RecordService.deleteRecord` ALREADY cascades** — `record-service.ts` deletes `meta_links WHERE record_id = $1 OR foreign_record_id = $1` (both directions, global) **in-txn** before removing the record. So a normal record delete leaves **no** dangling edge.
- **FKs:** `meta_links.record_id REFERENCES meta_records ON DELETE CASCADE`; **`foreign_record_id` has NO FK** (deliberate — cross-base/denormalized edge table). So an inbound edge to a record deleted via a path that bypasses `deleteRecord` dangles.
- **Read does not filter:** `loadLinkValuesByRecord` reads `meta_links` directly (no `EXISTS`/join), so a dangling `foreign_record_id` surfaces as a **ghost** link id (proven RED in golden (a)).
- **The one product leak path:** `DELETE /sheets/:sheetId` does `DELETE FROM meta_sheets WHERE id = $1` with no `meta_links` pre-clean. The `meta_sheets→meta_records→meta_links.record_id` cascade drops the sheet's records' **outbound** edges, but **inbound** edges from OTHER sheets (`foreign_record_id` = these records) survive → dangle. There is **no product-level `DELETE /bases/:baseId` route** (the `DELETE FROM meta_bases` callers are test cleanup), so base-delete cascade is not written here.

## 2. The fix (exactly the owner-narrowed design)
- **(i) repair-on-read (primary, non-destructive)** — `loadLinkValuesByRecord` filters dangling edges, on **both** read paths:
  - forward (`record_id IN records → foreign_record_id`): `AND EXISTS (SELECT 1 FROM meta_records r WHERE r.id = foreign_record_id)` — the real fix (no FK on this side).
  - reverse/mirror (`foreign_record_id IN records → record_id`): `AND EXISTS (… r.id = record_id)` — symmetry/defense (record_id is FK-cascade-protected today, so a ghost source isn't expected; filtered so NO read path can ever surface a deleted id).
  Robust against ANY dangling source (sheet-delete, direct SQL, legacy), non-destructive (hides ghosts, doesn't delete edges).
- **(ii) sheet-delete cascade (companion)** — `DELETE /sheets/:sheetId` now runs, in **one transaction**: `DELETE FROM meta_links WHERE foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)` **then** `DELETE FROM meta_sheets …`. Cleans the inbound edges at the source, atomically (no half delete-edges / delete-sheet).

**Deliberately NOT done** (owner-scoped): FK on `foreign_record_id` (cross-base, deliberately weak-constrained); periodic repair sweep (heavier; repair-on-read already removes user-visible ghosts); **base-delete cascade** (no product-level base-delete route exists — would be speculative runtime).

## 3. Verification — `multitable-dangling-link-repair-realdb.test.ts` (real DB, CI-wired, fail-first mutation-proven)
Stashing the src fix turns both goldens RED:
- **(a) repair-on-read:** a manually-inserted dangling edge (`foreign_record_id` = a never-existent record) is **NOT** surfaced as a ghost link id; the real linked record still is. (RED before: the ghost id appeared in the link value — also confirms the GET overlays `loadLinkValuesByRecord`.)
- **(b) sheet-delete cascade:** A→B inbound edge count = 1 pre-delete; after `DELETE /sheets/B`, the inbound edge is physically cleaned (count 0, RED before: stays 1) and A reads no ghost.

**Local `metasheet_test`:** new 3/3. Regression: bidirectional-mirror-links + relation-agg + cross-base relation-agg + cross-base link-optin **47/47** (the reverse-query `EXISTS` edit does not regress mirror reads). `tsc` clean.

## 4. Arc context — cross-base deepen
Slices done: (b) relation-agg authorized-reader read gate (#3300); **(c) referential integrity (this)**. Remaining
candidates, each separate: **(a)** cross-base two-way/mirror sync (mirror is same-base only today); **(d)** cross-base
view filter/sort by a foreign field (`query-service` has no foreign traversal). Plus the deferred base-delete cascade
*if/when* a product-level base-delete is designed.
