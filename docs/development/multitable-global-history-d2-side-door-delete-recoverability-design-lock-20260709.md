# Multitable Global History — D-2 side-door delete RECOVERABILITY — DESIGN LOCK (RATIFIED)

- **Status**: **RATIFIED 2026-07-12 (owner)**. All eight open decisions (§4) are resolved and the §1.11 truth table is accepted — see the per-OD rulings below and the ticked checklist in §8. HOT-CORE implementation is AUTHORIZED (strong-model lane + independent adversarial review + txn-boundary proof, per §8). **No environment flag may be enabled by the implementation** — `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` ships default-OFF **in code** (this is a code-default claim, not a production-status claim — see ERRATA item 3) and its enablement is a separate O-2 operator rung. This is the *recoverability* half of the destruction-path gap audit (`multitable-global-history-destruction-path-coverage-gap-audit-20260708.md`); the *PIT-correctness* half shipped as D-1 (#3969 `a1522034d` + #3992 `5dcea0b6f`).
- **ERRATA (2026-07-12)** — three corrections to this lock, recorded below:
  1. **§2/§3's "`:10183` latest-delete heuristic" is STALE.** It was replaced by the **R11 A′ vintage-exact anchor** (#4117, 2026-07-11 — *after* this lock was drafted). G5 is restated against the anchor as it actually is.
  2. **OD-7's CI-guard claim was FALSE as written** ("a non-txn regression turns G3 red"). G3 supplies its own transaction, so it proves atomicity *given* a transaction — it does NOT prove the real entry points provide one. OD-7 is now split into THREE layers of evidence.
  3. **"Flag ships default-OFF" is a CODE-default claim, not a production-status claim (owner correction, 2026-07-12).** `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` defaulting to OFF in source is not evidence about what any live deployment's environment currently has set. Production's actual flag state lives in the deploy host's env, external to this repo — it is not observable via code review or via this design lock, and must be checked on the deploy host itself (or through the O-2 operator rung's own verification step) before any claim about production's CURRENT behavior is made.
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
5. **Coverage parity when capture flag on (nesting explicit — review P3-1)**: on paths 3+4, tombstone capture is **nested under the D-2 flag** — it runs only when `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED='true'` AND `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED='true'`. With both on, **all four** destruction paths capture (closes 4c-2 §8 C2 honesty from 2/4 to 4/4). CAPTURE-on + SIDE_DOOR-off ⇒ **zero side-door tombstones** (byte-identity, §1.9/G6a) — do NOT copy the reference implementation's CAPTURE-only gating (record-service.ts:828-834), which is correct for the UI path but would break §1.9 here. SIDE_DOOR-on + CAPTURE-off ⇒ trash row + anchor written, zero tombstones (G6b). UI and PIT-reset paths keep their existing CAPTURE-only gating, unaffected by the D-2 flag.
6. **Restore-side zero delta**: no changes to `listDeletedRecords` / `restoreRecord` / `replayInboundLinks` / retention-floor code — trash rows are source-agnostic and D-2 rows flow through existing machinery. The retention floor (meta-revision-retention.ts:229-235) already pins any live trash row's anchored tombstone group; D-2 rows are floor-protected automatically (golden G8).
7. **No PIT/read-path delta**: D-1 already emits the revisions; D-2 changes no revision content, so `reconstructRecordsAtT` results are unchanged.
8. **Schema-missing is FAIL-CLOSED when the D-2 flag is on (owner P2 ruling — supersedes this lock's original mirror-the-UI-degradation stance)**: with `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED='true'`, a 42P01 (missing trash table) or 42703 (missing `delete_revision_id` column) on the recoverability write **refuses the delete** (automation step `failed` / plugin error propagated; record, links, revisions all intact) — an operator who opted into recoverability must never get a silently-unrecoverable delete. With the flag **off**, no trash write is attempted at all (§1.9 byte-identity), so the pre-migration deploy window is inert by construction. This is deliberately asymmetric to the never-fail-degradation peers — path 1 (UI, record-service.ts:861-889) AND path 2 (PIT-reset, univer-meta.ts:10487-10502 keeps its 42703 fallback as-built) — both of which predate the D-2 flag and must not start failing on deploy ordering; the asymmetry is part of what the owner ratifies (§1.11 truth table, G11).
9. **Flag-off byte-identity**: with the D-2 flag (OD-2, recommended) off, both paths behave byte-identically to today's D-1 status quo — revision-only, no trash, no tombstones, and each lane's **existing** ordering preserved: plugin keeps delete-then-emit (records.ts:575-599 fail-safe), automation keeps its emit-revision-then-DELETE inside `withTransaction` (automation-executor.ts:2306→2327 — review P3-2: the original "delete-then-emit" descriptor was plugin-specific and mischaracterized automation).
10. **4d red line untouched**: no value-level recovery of deleted-field column data; D-2 adds no new recovery semantics beyond record-trash parity.
11. **Dual-flag × schema truth table (owner P2 — normative; every row golden-pinned)**:

| `SIDE_DOOR` (D-2, OD-2) | `TOMBSTONE_CAPTURE` | trash schema | Behavior on paths 3+4 | Golden |
|---|---|---|---|---|
| off | off | any | byte-identical D-1 (revision-only) | G6a |
| off | **on** | any | byte-identical D-1 — **no side-door tombstones** (capture nested under SIDE_DOOR) | G6a |
| **on** | off | present | trash row + `delete_revision_id` anchor, zero tombstones; restore ⇒ `recoverable=false`, zero replay | G1/G6b |
| **on** | **on** | present | full UI-parity: trash + anchor + cap-checked inbound tombstones (4/4 coverage) | G1-G5 |
| **on** | any | **missing (42P01/42703)** | **fail-closed: delete refused**, record/links/revisions intact | G11 |

## §2 Fix surface (implementation map, per path)

### records.ts:547-606 (plugin-SDK deleteRecord) — MAIN CHANGE
In-txn data today: `data`+`version` only (SELECT :561-565, no FOR UPDATE); DELETE RETURNING version :575-580; revision emitted AFTER delete without pre-generated id (:589-599). Needs: extend the SELECT to `data, version, created_by, created_at, updated_at` (+ FOR UPDATE); one `SELECT base_id FROM meta_sheets`; pre-generated `randomUUID` passed as `id:` to `recordRecordRevision`; dual-flag-gated cap-checked `insertInboundLinkTombstones` (§1.5 nesting) BEFORE the links DELETE at :572; trash INSERT (fail-closed per §1.8/§1.11 when the D-2 flag is on) before the record DELETE; revision reordered to before-DELETE inside the txn (flag-on path only, per §1.9); the stale no-txn comment :586-588 and the 4c-2 §8 scope comment :567-571 reconciled. `deleted_by = null` (actor-less lane).

### automation-executor.ts:2262-2333 (executeDeleteRecord, inside withTransaction) — MAIN CHANGE
In-txn data today: `locked, locked_by, created_by, version, data` via FOR UPDATE (:2270-2276). Needs: add `created_at, updated_at` to that SELECT (zero extra queries); one `SELECT base_id FROM meta_sheets`; pre-generated id at :2306-2316; flag-gated cap-checked capture BEFORE the links DELETE :2299-2302; trash INSERT before the record DELETE :2327-2330; `TombstoneCaptureCapExceededError` caught by the existing catch :2350-2351 → step `failed`, record NOT deleted (assert explicitly). `deleted_by = context.actorId ?? null`. **HOT CORE** per the D-1 lock §8 — strong-model lane + independent adversarial review with txn-boundary proof are mandatory at impl time.

### Same-PR obligations
- `multitable-d1-delete-revision-parity-realdb.test.ts:202-210` asserts the exact OPPOSITE of D-2 (no-trash/no-tombstone) — it MUST be flipped/retired **in the same PR** (flag-off keeps a byte-identity variant; flag-on gets the parity assertions). Review NIT-1: the golden's NAME says "neither path" but its BODY exercises the plugin path only — the flip must add explicit per-path coverage for BOTH lanes, not just rename. Landing D-2 without flipping it leaves CI red or a silently weakened assertion.
- PIT-resurrect equivalence golden extending `multitable-undelete-inbound-resurrect-realdb.test.ts`. **ERRATA:** the anchor is NOT the old "latest delete revision" heuristic — that was replaced by the **R11 A′ vintage-exact anchor** (#4117): the FIRST delete revision with **`created_at > T`**, ordered **`created_at ASC, version ASC, id ASC`**, LIMIT 1. It applies **NO `source` filter** — which is precisely why a side-door (`plugin`/`automation`) delete revision is eligible to be the anchor. Prove it, don't assume it.
- Doc honesty sweep (§6).

## §3 Goldens (all real-DB, mutation-verified; realdb three-point wiring)

- **G1 per-path trash parity** (fail-first): automation / plugin delete ⇒ trash row with `data`=pre-delete snapshot, `original_version`, `created_by`, `original_created_at/updated_at`, `base_id`, `deleted_by` (actorId / NULL), `delete_revision_id` == the delete revision's id. Explicitly replaces the D-1 minimal-scope golden.
- **G2 anchor linkage** (capture flag on): tombstone rows with `source_revision_id` == trash.`delete_revision_id` == revision id, `reason='record_delete'`; capture flag off ⇒ trash row + anchor present, zero tombstones.
- **G3 atomicity per lane** (D1-5b technique): BEFORE-DELETE trigger forces the record DELETE to fail ⇒ NO trash row, NO delete revision, NO tombstones, seeded inbound link intact; plus injected failure at the trash INSERT ⇒ record still alive, no revision, no tombstones.
- **G4 restore round-trip per path** (both flags on): cross-sheet inbound edge → side-door delete → `listDeletedRecords` shows the row with `inboundEdgesRecoverable:true` → `restoreRecord` succeeds with `inbound.replayed>=1` and the neighbour's cell re-renders (RB2 shape extended to sources `'automation'`/`'plugin'`).
- **G5 PIT-resurrect equivalence (RESTATED — R11 A′)**: automation-deleted record with capture on, then PIT undelete (`confirm:'undelete'`, `MULTITABLE_ENABLE_PIT_UNDELETE` + inbound flag) ⇒ the **R11 A′ anchor** (`univer-meta.ts` ~:10196 — first delete revision with `created_at > T`, `ORDER BY created_at ASC, version ASC, id ASC LIMIT 1`, **no `source` filter**) resolves to the D-2 revision id and replays the captured vintage. Two properties are load-bearing and must BOTH be pinned: (i) the anchor query does not filter on `source`, so a side-door revision qualifies; (ii) D-2 **pre-generates** the revision id, so trash + tombstones have something to anchor to.
- **G6 flag matrix (per §1.11 truth table)**: (a) SIDE_DOOR off ⇒ byte-identical D-1 behavior **including CAPTURE-on ⇒ zero side-door tombstones** (the nesting golden — review P3-1); (b) SIDE_DOOR on + CAPTURE off: trash+anchor present, zero tombstones; restoring such a record ⇒ `recoverable=false`, zero replay, zero fabrication.
- **G7 cap breach fail-closed per lane**: >cap inbound edges + both flags on ⇒ automation step `status:'failed'` and the record still exists; plugin call rejects and the record still exists.
- **G8 retention-floor extension**: a D-2 trash row's anchor group survives a tombstone sweep that prunes an unreferenced same-age group (RB10 shape, side-door anchors).
- **G9 mutation proof**: remove the trash INSERT per path ⇒ G1 red; let `recordRecordRevision` self-generate the id ⇒ G2+G4 red (anchor mismatch); move capture after the links DELETE ⇒ G2 red (zero rows captured); neuter the cap assert ⇒ G7 red; un-nest capture from SIDE_DOOR ⇒ G6a red.
- **G10 own-only trash visibility** (pin the honest consequence): under a write-own sheet scope, a D-2 trash row with `created_by` NULL is absent from `listDeletedRecords` for the own-only actor and present for admin/full-write.
- **G11 schema-missing fail-closed per lane (§1.8/§1.11 — review P3-3)**: with SIDE_DOOR on, inject 42P01 (missing trash table) and separately 42703 (missing `delete_revision_id`) ⇒ the delete is REFUSED (automation step `failed` / plugin error), record + links + revision count all unchanged; with SIDE_DOOR off, the same schema holes are never touched (delete succeeds, revision-only).
- **G12 PIT read-path invariance (§1.7 — review P3-3)**: an identical delete sequence executed with the D-2 flag off vs on yields byte-identical `reconstructRecordsAtT` output at every probed T (D-2 adds recoverability, never changes history reads).

## §4 Owner decisions — ✅ ALL RESOLVED at ratification (2026-07-12)

Each bullet below records the owner's ruling first, then the original analysis that produced the recommendation.

- **OD-1 (API semantics — the core product question)** — ✅ **RESOLVED = (a) full parity** (owner 2026-07-12).
  Original analysis: should plugin-SDK deletes be trash'd at all? Today's SDK contract is intentionally permanent-delete (records.ts:567-571). Options: **(a) full parity both paths** · (b) automation-only, plugin stays revision-only · (c) parity + per-call SDK opt-out (`permanent:true`). **Recommended: (a)**, made safe by OD-2's default-off flag (the semantic change only manifests when an operator opts in) — parity keeps the line's core promise coherent ("recoverability doesn't depend on which door deleted you") and avoids a permanent 2-of-3-doors asterisk. Owner may override to (b)/(c) if SDK contract stability outweighs.
- **OD-2 (flag posture)** — ✅ **RESOLVED = new flag, DEFAULT OFF** (owner 2026-07-12). Enablement is a separate O-2 operator rung; the implementation must enable NO environment flag.
  Original analysis: **recommended: new default-off flag** `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` gating the trash write + reordering (adds one O-2 ladder rung; deploy-reversible; flag-off = byte-identical D-1 status quo). Alternative (unflagged parity, like the never-flagged UI trash) is simpler but irreversibly changes automation/plugin delete semantics at deploy and surfaces machine deletes in the recycle-bin UI with no off switch. Capture stays under `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` and replay under `MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND` regardless.
- **OD-3 (retention/volume)** — ✅ **RESOLVED = ACCEPT the growth risk, explicitly recorded; trash retention is a SEPARATE FUTURE RUNG** (owner 2026-07-12). **D-2 carries NO retention implementation.** Concretely: side-door deletes now add `meta_records_trash` rows that **no sweep removes** (trash is immortal by design — it is the floor that protects live tombstones from premature pruning), so enabling the flag grows that table monotonically. That growth is **accepted and documented**, not mitigated here; a retention rung is future scope with its own design + owner gate. *(An earlier version of this errata wrongly recorded this as "trash retention as a single column" — no such option exists and no such schema/runtime was ever proposed. Corrected.)*
  Original analysis: D-2 gives `meta_records_trash` its **first machine-rate writer** while trash still has NO sweep (sole DELETE = restore success, record-service.ts:1136), and live trash rows floor-pin their tombstone groups forever. Options: accept (status-quo-consistent) · commission a separate trash-retention rung (OUT of D-2 — red line §5) · minimal telemetry only. **Recommended: accept + acknowledge**, with trash-retention listed on the owner menu as its own future rung. D-2 must not smuggle in a trash sweep.
- **OD-4 (scope confirmation)** — ✅ **RESOLVED = paths 3+4 ONLY** (owner 2026-07-12). Paths 1 (UI record-service) and 2 (PIT-reset) are NO CHANGE; any behavior delta there is out of ratified scope.
  Original analysis: ratify that D-2 covers paths 3+4 only — path 2 (PIT-reset) is already at full parity via 4c-3 D-3 as-built, so the audit-table row is a doc update, not code (§0 table).
- **OD-5 (deleted_by attribution for automation)** — ✅ **RESOLVED = `actorId ?? null`** (owner 2026-07-12); plugin lane = `null` (actor-less).
  Original analysis: **recommended: `context.actorId ?? null`** (mirrors the D-1 revision's actorId); a rule-id attribution column would be a schema change beyond parity — out of scope.
- **OD-6 (plugin cap-breach error surface)** — ✅ **RESOLVED = typed SDK error, EXPORTED FROM THE PACKAGE ROOT** (owner 2026-07-12) so consumers can catch it by type.
  Original analysis: **recommended: export a typed SDK error** (visible contract, only reachable flag-on) rather than pre-mapping to an existing shape; either way the delete is refused.
- **OD-7 (records.ts transaction contract) — ✅ RESOLVED, and CORRECTED.** Pin "`input.query` MUST be transactional" as the module contract (prose + doc-comment), and keep flag-off ordering byte-identical (§1.9).
  **ERRATA — the original CI-guard claim was FALSE.** It said "the flag-on reordered path's atomicity is then CI-guarded by G3 (a non-txn regression turns G3 red)". It is not: **G3 supplies its own transaction**, so unwrapping the REAL wiring (`index.ts` SDK factory; `automation-service.ts` `deps.transaction`) leaves G3 green. Atomicity therefore needs **THREE INDEPENDENT LAYERS OF EVIDENCE**, and the implementation must provide ALL THREE:
  - **Layer 1 — "atomic GIVEN a transaction"**: G3a/G3b. Assert link intact + zero revisions + zero tombstones + zero trash on failure (not merely "the record still exists").
  - **Layer 2 — "the real entry points actually SUPPLY a transaction"**: a **production-wiring guard** that drives the ACTUAL `index.ts` SDK factory and the ACTUAL `automation-service.ts` deps (not a test re-implementation). Acceptance: unwrapping the txn at the real call sites must turn THIS guard RED.
  - **Layer 3 (belt-and-braces)**: the reordered path **refuses to run outside a transaction at runtime** (typed throw). This is a fail-closed defense that is **independent of the entry-point wiring** — it holds even if a caller is added or a wrapper is dropped. It is **not** un-removable (any guard can be deleted), so it must itself be **locked by a no-transaction golden**: invoke the reordered path with a non-transactional query and assert it THROWS and writes nothing. Removing the guard must turn that golden red.
  The stale `records.ts:586-588` no-txn comment must be reconciled.
- **OD-8 (cross-base machine deletes — review P3-4)** — ✅ **RESOLVED = accept target-base semantics** (owner 2026-07-12).
  Original analysis: the automation path is cross-base-capable (`effectiveSheetId = targetSheetId`, automation-executor.ts:2255-2290); D-2's trash INSERT + `base_id` lookup resolve against the **target** base, so the record surfaces in the target base's recycle bin and restore re-fires **target-base** events (possibly re-triggering that base's automations). **Recommended: accept target-base semantics** (it is where the record lives); owner may instead demand a cross-base marker or exclusion, which would be extra scope.

## §5 Honest consequences + risks (recorded, not hidden)

- **Product-semantics change**: automation/plugin deletes flip from "irreversible" to "restorable by anyone with `canDeleteRecord` on the sheet"; restore re-executes side effects (record-created event, realtime publish) which can re-trigger automations; a plugin that deleted a record for policy reasons can have it resurrected behind its back. This is the OD-1/OD-2 trade the owner is ratifying.
- **Write-own visibility asymmetry**: plugin/automation-created records carry `created_by` NULL (records.ts:527-532), so their trash rows are invisible/unrestorable to write-own actors — document (G10 pins it), don't fix, in D-2.
- **Plugin API behavior change when capture flag on**: a previously-succeeding delete can now fail on the cap (fail-closed refusal) — must be declared in the impl PR; manifests flag-on only.
- **Unbounded trash growth** until OD-3 gets its own rung (above).
- **Ordering regression hazard**: the flag-on path reverses D-1's deliberate delete-then-emit fail-safe. **If the required runtime guard (OD-7 Layer 3) were removed** and a non-transactional caller of `records.ts` `deleteRecord` then appeared (the type contract permits one), the reordered path would reintroduce the "revision says dead, row alive" half-state D-1 avoided. With the guard in place such a caller is REFUSED, not silently mis-ordered — which is why OD-7 requires all three evidence layers rather than a prose contract alone.
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

**RATIFIED 2026-07-12 (owner). All items resolved.**

- [x] **OD-1** = **(a) full parity**
- [x] **OD-2** = **new flag, DEFAULT OFF** — enablement is a separate O-2 rung; the impl enables NO env flag
- [x] **OD-3** = **accept the growth risk (explicitly recorded); trash retention is a SEPARATE FUTURE RUNG** — D-2 ships no retention implementation
- [x] **OD-4** = **scope: paths 3+4 ONLY** (paths 1/2 NO CHANGE)
- [x] **OD-5** = **`actorId ?? null`** (automation); plugin = `null`
- [x] **OD-6** = **typed SDK error, exported from the package root**
- [x] **OD-7** = **txn contract pinned — with THREE layers of evidence** (see the OD-7 errata: layer 1 = G3 proves "atomic GIVEN a txn"; layer 2 = a separate PRODUCTION-WIRING guard (G18 plugin / G15 automation) proves the real entry points supply one; layer 3 = a runtime refusal-outside-txn, `assertTransactionalQuery`, pinned by G16)
- [x] **OD-8** = **accept target-base semantics**
- [x] **§1.11** dual-flag × schema truth table accepted, **including the fail-closed schema-missing row**
- [x] **Impl lane** = HOT CORE: strong model + independent adversarial review + txn-boundary proof (mandatory)

**Landing order (owner):** this lock (#4004) lands FIRST; the implementation (#4168) lands after.
