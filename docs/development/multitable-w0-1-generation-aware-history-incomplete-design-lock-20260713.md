# W0-1 (v2, corrected) — reliable-causal-order `HISTORY_INCOMPLETE` + whole-sheet fence — design lock

**Date:** 2026-07-13 · **Status:** PROPOSED (owner ratify target) — **v2 rewrite after the owner's adversarial review of #4262 + the impl draft.** · **Corrects:** #4250, #4252 §3, and v1 of this lock. · **Model:** Opus.

> **v1 was NOT ratified.** The owner's review found five load-bearing defects; v2 addresses each. The headline reversal: **derive-only ordering from `(created_at, version, id)` is not a reliable causal order** (created_at=now() collides same-ms, version resets to 1 per incarnation, id is a random UUID), so generation partitioning was wrong. v2 introduces a **persistent monotonic causal sequence** and reverses the "no full lock" reset stance. This is the full W0 trustworthiness build (~4–6 pw), not a headline slice.

## §0 What v1 got wrong (owner review) → v2 fix
| # | v1 defect | v2 fix |
|---|---|---|
| P1-a | generation derived from `(created_at, version, id)` is not causal; two concrete bugs — whole-lifecycle `maxVersionByRecord` compares old-gen v2 vs new-gen live v1 (false refuse); same-version update/delete ordered by random UUID, delete-first → false refuse | **§1** persistent monotonic `seq`; generation + contiguity ordered by `seq`; max-version **per generation** |
| P1-b | C8 reset re-check locks only `affectedIds`; a survivor whose recomputed state == T is outside the set and can be concurrently updated after the recheck → commit ≠ T | **§5** whole-sheet **shared writer fence** (all mutating writers take the advisory lock outermost) + id-sorted survivor `FOR UPDATE`; **§10.2 reverses v1's "no full lock"** |
| P1-c | markers handled only in the reconstructor; Global History exact/estimate/detail + before-hydration diff still read lock/unlock markers (NULL treated as prior version → wrong diff) | **§3B** one shared `isContentRevision` predicate applied to **all** lists/detail/diff/restore-by-version/PIT/retention |
| P2-a | `isSystemSheet` compares user-settable `description`; the create API accepts it → a normal sheet spoofs system identity and skips strict precheck | **§3C** non-user-settable `system_kind` (+ base-ownership); spoof golden |
| P2-b | trusted-since not built; after retention prunes a generation's create, numbering+integrity unprovable; migration `down()` can't restore the 3-value CHECK once markers exist | **§6** persistent checkpoint + retention **trust-floor**; **§4** no-auto-down rollback contract |

## §1 Reliable causal order — persistent monotonic `seq` (replaces derive-from-created_at)
The chain's causal order must not depend on `created_at`/`version`/`id`. Add a persistent monotonic sequence:
- **Migration:** `CREATE SEQUENCE meta_record_revisions_seq` + `ALTER TABLE meta_record_revisions ADD COLUMN seq BIGINT DEFAULT nextval(...)`; `NOT NULL` after backfill; index `(sheet_id, record_id, seq)`. **Backfill** legacy rows `seq := row_number() OVER (ORDER BY created_at, version, id)` — best-effort for legacy only (legacy pre-marker records are fail-closed in strict mode anyway, §7); **new rows get a truly causal seq** (insertion order, immune to clock skew / version-reset / UUID). `recordRecordRevision` keeps INSERTing normally; the DEFAULT stamps `seq`.
- **Generation** = `COUNT(*) FILTER (WHERE action='create') OVER (PARTITION BY sheet_id, record_id ORDER BY seq ROWS UNBOUNDED PRECEDING)`. 1-based, contiguous, vintage-exact, and now **causally ordered**.
- **Contiguity** is judged per `(sheet_id, record_id, generation)` **ordered by `seq`**. This fixes both v1 bugs: (a) `maxVersion` is computed **within the target generation** (never old-gen-v2 vs new-live-v1); (b) a same-`version` update-then-delete orders by `seq` (delete inserted later ⇒ higher seq ⇒ after), never by UUID. A `delete`(v3) → new `create`(v1) is a generation boundary, not a regression.
- **Owner-raised alternative (fork §10.3):** an explicit persistent `generation INT` stamped at create. `seq` subsumes it (seq also fixes the update/delete ordering, which a generation column alone does not), so v2 uses `seq` as the causal primitive and treats an explicit generation column as an optional forward-only materialization only if an absolute retention-surviving lifetime label is needed.

## §2 Contiguity algorithm (per-generation, seq-ordered)
Strict mode, for each record in scope — **live rows AND records that existed at T but are now deleted** (from the chain + trash): derive generation (§1), then within the target generation assert the `version` sequence is +1-dense from its `create` (v1) through the reconstruction target **in `seq` order**, treating `lock`/`unlock` markers as version-consuming content-neutral steps and the terminal `delete` as the version-duplicate it is. A missing version = uncaptured content write ⇒ `HISTORY_INCOMPLETE`. Keep zero-revision refuse, live-after-delete refuse, user-authored-field projection. **§6 C2 guard**: refuse `nonmonotonic_history` if within a generation `seq` order and `version` order disagree — with a reliable `seq` this now catches genuine corruption, not clock skew.

## §3 Markers, content-predicate, and non-forgeable system identity
**A. Emit markers (unconditional, forward-only, no backfill — OD-5):** the 4 sites that bump `version` without a revision — HTTP lock `univer-meta.ts:16426`/unlock`:16441`, automation lock `automation-executor.ts:3492`/unlock`:3503` — emit `recordRecordRevision({action:'lock'|'unlock', version:<consumed>, snapshot:NULL, patch:'{}', changed_field_ids:[]})` in the same txn as the bump.

**B. Shared `isContentRevision` predicate (the marker blast radius — NOT just the reconstructor).** Define ONE predicate `isContentRevision(action) = action IN ('create','update','delete')` and apply it at **every** consumer of `meta_record_revisions`:
- History Center list/exact/estimate/detail projection (`history-projection.ts:218`) — markers never appear as history events.
- before-hydration prior-revision lookup (`history-projection.ts:596`) — the "before" is the nearest prior **content** revision, never a NULL-snapshot marker (v1 bug: NULL marker mistaken for prior version → wrong diff).
- restore-by-version — a marker version is not a restorable target.
- PIT reconstruction (`record-reconstructor.ts`) — v1's snapshot=NULL compensation kept, but routed through the predicate.
- retention sweeps — count/prune by content revisions.
The predicate is the single source of truth; a golden asserts a locked record's list/detail/diff excludes markers and its before-hydration diff uses the prior content revision.

**C. Non-forgeable system identity (spoof fix).** `description`/user-settable fields must NOT determine system exclusion. Add a `system_kind TEXT NULL` column to `meta_sheets` (e.g. `'people'`, `'approval_projection'`), set **only** by internal `ensureSystemBase`/`ensureFamilySheet` provisioning; the sheet create/update API must **reject or ignore** `system_kind` from user input. `isSystemSheet(sheet) = sheet.system_kind IS NOT NULL` (the approval-projection `base_id === 'base_apr_projection'` check stays as a second signal **iff** verified users cannot create a base with that id — else drop it). **Spoof golden:** a normal sheet whose `description === '__metasheet_system:people__'` but `system_kind IS NULL` is **NOT** excluded → is subject to strict precheck. (`recreateFieldFromConfig` `:6537` stays PINNED in `KNOWN_REVISION_GAPS` on its own OD-6 rung — not folded here.)

## §4 Migration + rollback contract
One zzzz Kysely migration (sorts after `zzzz20260430172000` + `zzzz20260711000000`; NOT numeric `.sql` — [[feedback_migration_zzzz_ordering]]):
1. `CREATE SEQUENCE` + add `seq` (§1) + backfill + NOT NULL + index.
2. Add `system_kind` to `meta_sheets` (§3C), nullable, no user backfill (legacy system sheets get `system_kind` via a targeted UPDATE keyed on the **non-forgeable** provisioning identity — approval base_id + the internal people-sheet id — NOT on description).
3. Relax the `action` CHECK to add `'lock','unlock'` (pure relaxation, instant-validate).
4. **Rollback contract (owner P2-b):** `down()` is **fail-closed after first marker** — once any `action IN ('lock','unlock')` row exists, `down()` MUST refuse (restoring the 3-value CHECK would violate rows; dropping `seq` would destroy causal order). `down()` throws a clear "irreversible after marker emission — manual intervention required" error; it is **not** an auto-revert.
Verify with a **fresh-DB full migrate** and a **seeded-marker `down()`-refuses** test.

## §5 C8 same-txn re-check + whole-sheet writer fence (P1-b — v1's "no full lock" REVERSED)
Isolation is READ COMMITTED (`connection-pool.ts:158`). The advisory lock alone fences only INSERTs by writers that take it; it does **not** stop a concurrent UPDATE of a survivor outside `affectedIds`. Correct atomicity requires **serializing all sheet writes**:

**Primary (recommended) — shared sheet-writer fence:** every sheet-mutating write path (`createRecord`, `patchRecord`, bulk `patchRecords`, `deleteRecord`, form-submit, automation writes, restore/resurrect) acquires `acquireAutoNumberSheetWriteLock(query, sheetId)` (`auto-number-service.ts:17`) as its **outermost first statement**. Reset-execute, holding that lock, then blocks **all** concurrent writes (updates AND inserts) for the sheet — full atomicity, single serialization point, **no deadlock**. This is the owner's "all write paths share one sheet writer fence" and is the complete fix. Scope: ~10 write sites take the fence (mechanical; several already do).

**Belt-and-suspenders inside the reset txn (`univer-meta.ts` reset-execute ~:10415):** after the fence, `SELECT id FROM meta_records WHERE sheet_id=$1 ORDER BY id FOR UPDATE` (id-sorted, deadlock-safe) to lock every survivor, THEN re-run `precheckSheetHistoryIntegrity(query, …)` with the txn query, re-enumerate the revert+delete set with the txn query, and **move the `previewIdentity` verification inside the txn** recomputing scope hashes from the in-txn set. Keep per-`affectedId` FOR UPDATE + expectedVersion.

**Revert resurrect txn (~:10206):** same in-txn re-check + fence. **Honest deferral (§9):** revert's per-record field-revert loop (`:10293`, each its own `patchRecords` txn) is not loop-atomic without an outer-txn refactor; until then the **#4261 default-off gate is the operative protection** for writable Revert.

**Constructed golden (owner-required):** a concurrent UPDATE of a survivor-at-T committed after the pre-txn recheck must be **blocked** by the fence/FOR UPDATE until reset commits (or serialize after), so the final state == T. Build the real race (raw client holding the lock + `pg_blocking_pids`), not a sequential argument.

## §6 Trusted-since checkpoint + retention trust-floor (P2-b — actually built)
- **Checkpoint (survives record deletion):** a persistent `meta_history_trust_checkpoints` table `(sheet_id, trusted_since_seq, created_at)` — NOT a column on `meta_records`. `trusted_since_seq` = the `seq` from which the chain is proven dense (set at a controlled cutover **after** marker emission has shipped to all instances, §7). Strict mode reasons only at/after the checkpoint; below it, fail-closed.
- **Retention trust-floor:** retention sweeps MUST NOT prune any content revision needed to derive generation/contiguity for a record still within the recoverable window — never prune a generation's `create`, and never prune below `trusted_since_seq`. Retention respects the floor (couples retention to the integrity model; the O-2 ladder's "no retention floor" acceptance is re-opened for the strict window).
- Without this, "prune then reconstruct" does not hold — v1's rollback description is void until the checkpoint + floor exist.

## §7 Flag + two-phase rollout
`MULTITABLE_HISTORY_CONTIGUITY_STRICT` default-off = byte-for-byte current #4234. Flag-on = §2 strict. **Two-phase rollout:** (1) ship migration + marker emission + content-predicate + fence to **all** instances (no strict enforcement yet); (2) once all instances emit markers and honor the fence, set `trusted_since_seq` at the cutover and flip strict on. Turning strict on refuses (fail-closed) any record whose retained generation predates the checkpoint (unbridgeable pre-marker gaps) — the intended, owner-confirmable trusted-window posture. Not the #4261 revert gate.

## §8 Golden matrix (real-DB, mutation-proven, two-point CI-wired)
healed-gap (per-generation, seq-ordered); **delete→restore→delete passes** (generation boundary — the v1 `maxVersion` regression test); **same-version update-then-delete passes** (seq order not UUID — the v1 UUID regression test); deleted-gap (C3); lock/automation-lock not refused (markers load-bearing); **marker content-predicate** (History list/detail/diff + before-hydration exclude markers — mutation: drop the predicate at any consumer ⇒ reds); reconstructor marker-safety; **system-identity spoof** (normal sheet with the magic description but no `system_kind` is NOT excluded — mutation: revert to description-check ⇒ reds); **C8 TOCTOU** (constructed concurrent uncaptured write → 409 zero-write); **whole-sheet fence** (constructed concurrent survivor UPDATE after recheck → blocked → final==T; constructed phantom INSERT → 409); **migration down()-refuses-after-marker**; formula-not-refused; positive control; flag-off parity.

## §9 Deferred (with justification)
1. Revert field-revert loop atomicity (`:10293`, per-record txns) — needs an outer-txn refactor; resurrect txn IS atomic; field-reverts guarded by per-record FOR UPDATE + expectedVersion + the #4261 gate.
2. `recreateFieldFromConfig` revision (`:6537`) — no version bump ⇒ invisible to contiguity; OD-6 MUST-WRITE on its own rung; pinned in `KNOWN_REVISION_GAPS`.
3. Backfill of historical lock/unlock markers — unreconstructable; would fabricate history (OD-5). Forward-only; strict sound only from the checkpoint.
4. Explicit persistent `generation` column — `seq` subsumes it; add only if an absolute retention-surviving lifetime label is needed (fork §10.3), forward-only + no-backfill.

## §10 Open forks for owner (recommendations **bold**)
1. **C2 scope** — monotonicity guard flag-on-scoped, or also on the flag-off content-diff path? **Recommend: flag-on scoped.**
2. **Shared-fence breadth (reverses v1)** — take `acquireAutoNumberSheetWriteLock` in ALL ~10 sheet-mutating write paths (**recommended, complete/no-deadlock**) vs only reset's whole-sheet `FOR UPDATE` (localized but risks deadlock vs non-id-sorted bulk-patch and misses phantom inserts). **Recommend: shared fence in all writers.**
3. **Explicit generation column** — need an absolute retention-surviving lifetime label? **Recommend: no — `seq`-derived only.**
4. **Checkpoint granularity** — per-sheet `trusted_since_seq` (**recommended**) vs global.
5. **Retention floor severity** — hard block pruning below the floor (**recommended, fail-closed**) vs soft-warn.
6. **Strict flip timing** — confirm the two-phase cutover window + fail-closed posture for pre-checkpoint records.
7. **`system_kind` backfill key** — legacy system sheets' `system_kind` from the non-forgeable provisioning identity (approval base_id + internal people-sheet id), **never** description. Confirm the internal people-sheet id is discoverable for the backfill.

## §11 Sequence + model dispatch
**Order (owner):** ① pause impl (done) · ② fix + land #4261 (flag-manifest wiring — real risk isolation) · ③ ratify this v2 (§0 + §10 forks) · ④ then restart impl + independent Opus adversarial review with per-lane txn-boundary proof. Opus: migration/seq, contiguity SQL, fence, checkpoint, gate. Sonnet: marker emission, content-predicate wiring, goldens. Draft behind the default-off flag; **not merged/armed** until ratify.
