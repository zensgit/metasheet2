# Multitable Global History — D-2 side-door delete RECOVERABILITY — DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only PR; **no runtime code ships here and none is authorized until the owner ratifies this lock** (same design-lock-first discipline as 4c-1/4c-2/4c-3/D-1). This is the owner-gated *recoverability* half of the destruction-path gap audit (`multitable-global-history-destruction-path-coverage-gap-audit-20260708.md`); the *PIT-correctness* half shipped as D-1 (#3969 `a1522034d` + #3992 `5dcea0b6f`).
- **Provenance**: scoped 2026-07-09 by a primary-source audit lane against `origin/main` (R9 round, owner /goal「接续多维表历史记录与版本恢复线」). Every file:line below was read, not inferred.
- **One-sentence problem**: records deleted through the plugin-SDK or an automation `delete_record` step get a delete revision (D-1) but **no `meta_records_trash` row and no inbound-edge tombstones** — they are invisible to trash-restore and outside 4c-3's inbound-replay reach, while UI-deleted records are fully recoverable.

## §0 Scope finding — the surface is TWO paths, not four

Of the four `DELETE FROM meta_records` paths named by the gap audit:

| # | Path | D-2 status |
|---|---|---|
| 1 | `record-service.deleteRecord` (record-service.ts:806-898) | **NO CHANGE** — the full-parity reference implementation D-2 copies (capture :828-834 → links :837-843 → revision :845-856 → trash :861-889 → DELETE :892) |
| 2 | PIT-reset inline delete (univer-meta.ts:10450-10506) | **NO CHANGE — already at full parity as-built** via 4c-3 §7/D-3 (#3975): pre-generated `resetDeleteRevisionId` :10467, flag-gated cap-checked capture BEFORE the links DELETE :10468-10472, revision with pre-generated id :10474-10486, trash row with `delete_revision_id` anchor + 42703 degradation :10487-10502, cap→422 :10517-10518 — all inside the reset transaction. The gap-audit §1 table rows describing this path as "trash+revision but NO tombstone" are **stale**; this lock's ratification includes flipping them (§6 doc sweep). |
| 3 | plugin-SDK `deleteRecord` (records.ts:547-606) | **IN SCOPE** |
| 4 | automation `delete_record` (automation-executor.ts:2262-2333) | **IN SCOPE** |

Post-D-1 reality on paths 3+4: both emit a delete revision (source `'plugin'`/`'automation'`) with pre-delete snapshot; **neither** writes a trash row, **neither** captures inbound tombstones, **neither** pre-generates the revision id (`recordRecordRevision` self-generates, so there is nothing to anchor trash/tombstones to). `records.ts:568-569` states the boundary explicitly ("intentionally NOT wired … the row is still irrecoverable") — honest, and exactly what this lock proposes to close.

**Transaction reality (supersedes the D-1 lock's deviation-1):** both lanes now run inside real transactions in production — automation via `withTransaction` (#3992; automation-executor.ts:2262, deps supplied at automation-service.ts:840; the button route's second executor also supplies it and its `BUTTON_ACTION_POLICY` whitelist cannot dispatch `delete_record` anyway), plugin via the sole production wiring wrapping every SDK call in `poolManager.get().transaction` (index.ts:634-653).

## §1 Locked invariants (normative once ratified)

1. **Same-txn atomicity per lane**: trash INSERT + delete revision + tombstone capture + links DELETE + record DELETE all commit or all roll back. Pinned per-lane with the **D1-5b BEFORE-DELETE-trigger technique** (fail the DELETE step itself), NOT revision-INSERT injection — that variant was proven fake-green for atomicity in #3992.
2. **Anchor parity with the UI path (4c-3 §2)**: one pre-generated uuid = delete-revision id = `meta_records_trash.delete_revision_id` = `meta_link_tombstones.source_revision_id` (`reason='record_delete'`); forward-only; NULL/missing tombstones ⇒ `inboundEdgesRecoverable=false`; **no heuristic backfill, ever**.
3. **Capture-before-destruction ordering**: `insertInboundLinkTombstones` runs BEFORE the single `DELETE FROM meta_links WHERE record_id=$1 OR foreign_record_id=$1` statement that destroys both edge directions (records.ts:572 / automation-executor.ts:2299-2302).
4. **Cap fail-closed (4c-2 C3)**: capture flag on + inbound count > `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS` ⇒ the delete itself is refused (automation step `failed` / plugin error propagated) — never a half-captured destruction.
5. **Coverage parity when capture flag on**: after D-2, `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED='true'` ⇒ **all four** destruction paths capture (closes 4c-2 §8 C2 honesty from 2/4 to 4/4). Capture flag off ⇒ trash row + anchor still written, zero tombstones — byte-identical to the UI path's flag-off behavior.
6. **Restore-side zero delta**: no changes to `listDeletedRecords` / `restoreRecord` / `replayInboundLinks` / retention-floor code — trash rows are source-agnostic and D-2 rows flow through existing machinery. The retention floor (meta-revision-retention.ts:229-235) already pins any live trash row's anchored tombstone group; D-2 rows are floor-protected automatically (golden G8).
7. **No PIT/read-path delta**: D-1 already emits the revisions; D-2 changes no revision content, so `reconstructRecordsAtT` results are unchanged.
8. **Pre-migration deploy-window degradation** mirrors record-service.ts:861-889 (42P01 missing table ⇒ delete proceeds trash-less; 42703 missing `delete_revision_id` column ⇒ legacy INSERT shape with honest NULL anchor) — the delete must never fail on the recoverability write.
9. **Flag-off byte-identity**: with the D-2 flag (OD-2, recommended) off, both paths behave byte-identically to today's D-1 status quo (revision-only, delete-then-emit ordering, no trash, no tombstones).
10. **4d red line untouched**: no value-level recovery of deleted-field column data; D-2 adds no new recovery semantics beyond record-trash parity.

## §2 Fix surface (implementation map, per path)

### records.ts:547-606 (plugin-SDK deleteRecord) — MAIN CHANGE
In-txn data today: `data`+`version` only (SELECT :561-565, no FOR UPDATE); DELETE RETURNING version :575-580; revision emitted AFTER delete without pre-generated id (:589-599). Needs: extend the SELECT to `data, version, created_by, created_at, updated_at` (+ FOR UPDATE); one `SELECT base_id FROM meta_sheets`; pre-generated `randomUUID` passed as `id:` to `recordRecordRevision`; flag-gated cap-checked `insertInboundLinkTombstones` BEFORE the links DELETE at :572; trash INSERT (with the §1.8 degradation guards) before the record DELETE; revision reordered to before-DELETE inside the txn (flag-on path only, per §1.9); the stale no-txn comment :586-588 and the 4c-2 §8 scope comment :567-571 reconciled. `deleted_by = null` (actor-less lane).

### automation-executor.ts:2262-2333 (executeDeleteRecord, inside withTransaction) — MAIN CHANGE
In-txn data today: `locked, locked_by, created_by, version, data` via FOR UPDATE (:2270-2276). Needs: add `created_at, updated_at` to that SELECT (zero extra queries); one `SELECT base_id FROM meta_sheets`; pre-generated id at :2306-2316; flag-gated cap-checked capture BEFORE the links DELETE :2299-2302; trash INSERT before the record DELETE :2327-2330; `TombstoneCaptureCapExceededError` caught by the existing catch :2350-2351 → step `failed`, record NOT deleted (assert explicitly). `deleted_by = context.actorId ?? null`. **HOT CORE** per the D-1 lock §8 — strong-model lane + independent adversarial review with txn-boundary proof are mandatory at impl time.

### Same-PR obligations
- `multitable-d1-delete-revision-parity-realdb.test.ts:202-210` asserts the exact OPPOSITE of D-2 (no-trash/no-tombstone for both paths) — it MUST be flipped/retired **in the same PR** (flag-off keeps a byte-identity variant; flag-on gets the parity assertions). Landing D-2 without flipping it leaves CI red or a silently weakened assertion.
- PIT-resurrect equivalence golden extending `multitable-undelete-inbound-resurrect-realdb.test.ts` (the :10183-10196 latest-delete-revision heuristic auto-benefits once D-2 anchors exist — prove it, don't assume it).
- Doc honesty sweep (§6).

## §3 Goldens (all real-DB, mutation-verified; realdb three-point wiring)

- **G1 per-path trash parity** (fail-first): automation / plugin delete ⇒ trash row with `data`=pre-delete snapshot, `original_version`, `created_by`, `original_created_at/updated_at`, `base_id`, `deleted_by` (actorId / NULL), `delete_revision_id` == the delete revision's id. Explicitly replaces the D-1 minimal-scope golden.
- **G2 anchor linkage** (capture flag on): tombstone rows with `source_revision_id` == trash.`delete_revision_id` == revision id, `reason='record_delete'`; capture flag off ⇒ trash row + anchor present, zero tombstones.
- **G3 atomicity per lane** (D1-5b technique): BEFORE-DELETE trigger forces the record DELETE to fail ⇒ NO trash row, NO delete revision, NO tombstones, seeded inbound link intact; plus injected failure at the trash INSERT ⇒ record still alive, no revision, no tombstones.
- **G4 restore round-trip per path** (both flags on): cross-sheet inbound edge → side-door delete → `listDeletedRecords` shows the row with `inboundEdgesRecoverable:true` → `restoreRecord` succeeds with `inbound.replayed>=1` and the neighbour's cell re-renders (RB2 shape extended to sources `'automation'`/`'plugin'`).
- **G5 PIT-resurrect equivalence**: automation-deleted record with capture on, then PIT undelete (`confirm:'undelete'`, `MULTITABLE_ENABLE_PIT_UNDELETE` + inbound flag) ⇒ the :10183 heuristic anchors to the D-2 revision id and replays the captured vintage.
- **G6 flag matrix**: (a) D-2 flag off ⇒ byte-identical D-1 behavior; (b) capture-flag-off honesty: restoring a D-2-trashed-but-uncaptured record ⇒ `recoverable=false`, zero replay, zero fabrication.
- **G7 cap breach fail-closed per lane**: >cap inbound edges + capture on ⇒ automation step `status:'failed'` and the record still exists; plugin call rejects and the record still exists.
- **G8 retention-floor extension**: a D-2 trash row's anchor group survives a tombstone sweep that prunes an unreferenced same-age group (RB10 shape, side-door anchors).
- **G9 mutation proof**: remove the trash INSERT per path ⇒ G1 red; let `recordRecordRevision` self-generate the id ⇒ G2+G4 red (anchor mismatch); move capture after the links DELETE ⇒ G2 red (zero rows captured); neuter the cap assert ⇒ G7 red.
- **G10 own-only trash visibility** (pin the honest consequence): under a write-own sheet scope, a D-2 trash row with `created_by` NULL is absent from `listDeletedRecords` for the own-only actor and present for admin/full-write.

## §4 Open decisions — owner must pick at ratification

- **OD-1 (API semantics — the core product question)**: should plugin-SDK deletes be trash'd at all? Today's SDK contract is intentionally permanent-delete (records.ts:567-571). Options: **(a) full parity both paths** · (b) automation-only, plugin stays revision-only · (c) parity + per-call SDK opt-out (`permanent:true`). **Recommended: (a)**, made safe by OD-2's default-off flag (the semantic change only manifests when an operator opts in) — parity keeps the line's core promise coherent ("recoverability doesn't depend on which door deleted you") and avoids a permanent 2-of-3-doors asterisk. Owner may override to (b)/(c) if SDK contract stability outweighs.
- **OD-2 (flag posture)**: **recommended: new default-off flag** `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` gating the trash write + reordering (adds one O-2 ladder rung; deploy-reversible; flag-off = byte-identical D-1 status quo). Alternative (unflagged parity, like the never-flagged UI trash) is simpler but irreversibly changes automation/plugin delete semantics at deploy and surfaces machine deletes in the recycle-bin UI with no off switch. Capture stays under `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` and replay under `MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND` regardless.
- **OD-3 (retention/volume)**: D-2 gives `meta_records_trash` its **first machine-rate writer** while trash still has NO sweep (sole DELETE = restore success, record-service.ts:1136), and live trash rows floor-pin their tombstone groups forever. Options: accept (status-quo-consistent) · commission a separate trash-retention rung (OUT of D-2 — red line §5) · minimal telemetry only. **Recommended: accept + acknowledge**, with trash-retention listed on the owner menu as its own future rung. D-2 must not smuggle in a trash sweep.
- **OD-4 (scope confirmation)**: ratify that D-2 covers paths 3+4 only — path 2 (PIT-reset) is already at full parity via 4c-3 D-3 as-built, so the audit-table row is a doc update, not code (§0 table).
- **OD-5 (deleted_by attribution for automation)**: **recommended: `context.actorId ?? null`** (mirrors the D-1 revision's actorId); a rule-id attribution column would be a schema change beyond parity — out of scope.
- **OD-6 (plugin cap-breach error surface)**: **recommended: export a typed SDK error** (visible contract, only reachable flag-on) rather than pre-mapping to an existing shape; either way the delete is refused.
- **OD-7 (records.ts transaction contract)**: **recommended: pin "input.query MUST be transactional" as the module contract** in prose + doc-comment (production already satisfies it, index.ts:634-653) and keep flag-off ordering byte-identical (delete-then-emit fail-safe). The flag-on reordered path's atomicity is then CI-guarded by G3 (a non-txn regression turns G3 red). The stale records.ts:586-588 no-txn comment must be reconciled either way.

## §5 Honest consequences + risks (recorded, not hidden)

- **Product-semantics change**: automation/plugin deletes flip from "irreversible" to "restorable by anyone with `canDeleteRecord` on the sheet"; restore re-executes side effects (record-created event, realtime publish) which can re-trigger automations; a plugin that deleted a record for policy reasons can have it resurrected behind its back. This is the OD-1/OD-2 trade the owner is ratifying.
- **Write-own visibility asymmetry**: plugin/automation-created records carry `created_by` NULL (records.ts:527-532), so their trash rows are invisible/unrestorable to write-own actors — document (G10 pins it), don't fix, in D-2.
- **Plugin API behavior change when capture flag on**: a previously-succeeding delete can now fail on the cap (fail-closed refusal) — must be declared in the impl PR; manifests flag-on only.
- **Unbounded trash growth** until OD-3 gets its own rung (above).
- **Ordering regression hazard**: the flag-on path reverses D-1's deliberate delete-then-emit fail-safe; if a non-transactional caller of records.ts `deleteRecord` ever appears (the type contract permits it), the reordered path reintroduces the "revision says dead, row alive" half-state D-1 avoided — hence OD-7 is a ratify item, not an assumption.
- **Hot-core lane**: automation-executor.ts changes require the same strong-model + independent-adversarial-review treatment the D-1 lock §8 demanded.

## §6 Doc honesty sweep (ships with the impl PR)

`…4c2-forward-tombstone-capture-design-lock-20260707.md` (§1/§8 C2 coverage 2/4→4/4) · `…destruction-path-coverage-gap-audit-20260708.md` (§1 table rows 2-4: row 2 flipped by 4c-3 D-3 as-built — flip NOW at this lock's landing if the owner prefers, or with impl) · `…4c3-record-undelete-2b-inbound-edge-replay-design-lock-20260708.md` (§0 reachable boundary) · `…o2-operator-flag-ladder-20260709.md` (L1 + the new OD-2 rung if ratified).

## §7 Out of scope / red lines

- No trash-retention sweep (OD-3 is acknowledge-or-separate-rung).
- No 4d resurrection (deleted-field column values remain impossible — no tombstone, bytes gone).
- No resurrect-anchor exactness change (the 4c-3 wave §4 item (1) heuristic honesty stays as landed; separate owner rung).
- No change to path 1 (UI) or path 2 (PIT-reset) behavior.
- No schema changes beyond zero (D-2 needs NO new columns — `delete_revision_id` and tombstone tables already exist).

## §8 Ratification checklist

- [ ] OD-1 choice (recommended: (a) full parity)
- [ ] OD-2 flag posture (recommended: new default-off flag, +1 O-2 rung)
- [ ] OD-3 trash-growth posture (recommended: accept + menu the retention rung)
- [ ] OD-4 scope = paths 3+4 (+ stale-doc flip timing)
- [ ] OD-5 attribution (recommended: actorId ?? null)
- [ ] OD-6 SDK error contract (recommended: typed export)
- [ ] OD-7 txn contract pinning (recommended: prose contract + G3 CI guard)
- [ ] Impl lane assignment (hot-core: strong model + adversarial review mandatory)
