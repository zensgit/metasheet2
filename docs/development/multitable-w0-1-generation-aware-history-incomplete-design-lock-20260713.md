# W0-1 (corrected) — generation-aware `HISTORY_INCOMPLETE` contiguity + C8/C4 same-txn fence — design lock

**Date:** 2026-07-13 · **Status:** PROPOSED (owner ratify target) · **Corrects:** #4250 and #4252 §3 (which assumed a global `UNIQUE(sheet_id,record_id,version)` — **withdrawn**, see §1). · **Model dispatch:** Opus (schema/txn/concurrency). · **Every claim anchored to `origin/main` code.**

> This lock incorporates the owner's 2026-07-13 P1 correction. The prior C5 recommendation `UNIQUE(sheet_id,record_id,version)` is **wrong and withdrawn**: restore/resurrect reuse the recordId and reset version to 1, so `(record_id,version)` repeats across — and even within — a record's life. Grounded by a three-lane discovery (vintage model, 36-site marker surface, C8 txn structure) verified against `origin/main`.

## §0 Owner's hard acceptance conditions (all binding)
1. **No global version-unique.** The only uniqueness the model tolerates is `(sheet_id,record_id,generation,version,action)`, and **generation is derived, not stored — so no unique index is created at all.**
2. **Contiguity judged per record incarnation/generation.**
3. **trusted-since per generation** (else delete→restore→version-reset confuses the old watermark).
4. **Markers comprehensive** — lock/unlock **and** automation-lock; people-directory sync + approval projection handled (excluded structurally); system sheets excluded.
5. **C2/C4/C8 not deferrable while calling this a headline fix** — especially **C8 (same-txn re-check) is the second live P1 of writable Revert** → in-scope.
6. **`MULTITABLE_HISTORY_CONTIGUITY_STRICT` default-off only guarantees no-launch-disruption**, it is *not* the current-risk mitigation → the **interim Revert-execute default-off gate is a separate independent PR** (#4261, in flight).

## §1 The vintage / generation model (verified)
A record incarnation (vintage) of `(sheet_id, record_id)` = the half-open span of `meta_record_revisions` from one `action='create'` to its following `action='delete'` (or to the live head for the open incarnation). Verified facts:
- **version resets to 1 on every (re)birth of a reused id:** trash restore `record-service.ts:1091` (`INSERT … version … VALUES(…,1,…)`) and PIT resurrect `univer-meta.ts:10214` (`… VALUES($1,$2,$3,1,…)`). `createRecord:680` also starts at 1. So **version 1 is the create-marker of every generation** — version alone can never disambiguate incarnations.
- **The delete revision reuses the last live version** (`record-service.ts:850`, `version = serverVersion`, not +1) and stores the pre-delete snapshot ⇒ within one generation the terminal integer appears **twice** (last update + delete). So even `(record_id,generation,version)` is not unique — only `(…,version,action)` is.
- **`source` does not delimit vintages:** trash restore uses `source='rest'` (the code comment at `:1088` saying `'restore'` is **wrong**); only PIT resurrect/reset/lossy use `'restore'`. `action='create'` is the sole reliable incarnation-open marker.
- **`delete_revision_id`** (`meta_records_trash`, `zzzz20260709100000`, nullable, no backfill) anchors a single *closed* vintage's terminal delete — its correct job (inbound-edge replay) — but is NULL for the open incarnation and capture-off/pre-migration deletes, so **it cannot key generations generally.**
- **reset-execute never resurrects** (verified negative: its 4 `INSERT INTO meta_records` are people-sync/seed/PIT-resurrect/public-form; none in reset). The generation-reset surface is exactly trash-restore + PIT-resurrect.

**Generation scheme = DERIVE from create-boundaries (canonical).** At query time:
```sql
generation = COUNT(*) FILTER (WHERE action='create')
  OVER (PARTITION BY sheet_id, record_id
        ORDER BY created_at, version, id ROWS UNBOUNDED PRECEDING)
```
(the codebase's established order — the exact resurrect-anchor tiebreak `univer-meta.ts:10254-10261`, complement of `reconstructRecordsAtT`'s DESC order.) 1-based, contiguous, vintage-exact, zero migration/backfill. This matches the doctrine ratified twice: the `delete_revision_id` migration **forbids** a stored/backfilled anchor ("delete→restore→delete silently anchors to the WRONG vintage"), and the R11 A′ resurrect anchor was switched from stored to derive-from-T. A persistent `generation` column is a fork (§10.3), forward-only + never-backfilled if ever adopted — never a substitute key.

## §2 Contiguity algorithm (per-generation)
Strict mode, for each record in scope — **live rows AND records that existed at T but are now deleted** (enumerate from the chain + trash, not live-only): compute `generation` per §1, then within the target generation assert the version sequence is **+1-dense** from its `create` (v1) through the reconstruction target, treating a `lock`/`unlock` marker (§3) as a version-consuming, content-neutral step and the terminal `delete` as the version-duplicate it is. A missing version = an uncaptured content write ⇒ `HISTORY_INCOMPLETE`. A `v3-delete` followed by a `v1-create` (new generation) is **NOT** a regression or gap (pinned by a delete→restore→delete golden). Keep the existing correct pieces (zero-revision refuse, live-after-delete refuse, user-authored-field projection so derived fields don't false-refuse).

## §3 Marker plan (make the version chain +1-dense)
Reconciled against `multitable-revision-disposition-guard.guard.test.ts` (36 sites). Two disjoint classes:

**A. NEEDS-MARKER — emit a marker revision (unconditional, ships with the migration, NOT flag-gated so a trusted window exists at flag-flip):**
- HTTP LOCK `univer-meta.ts:16426` / UNLOCK `:16441`; automation LOCK `automation-executor.ts:3492` / UNLOCK `:3503`. All bump `version+1` and emit no revision today.
- Change: in the **same txn** as the version bump, `recordRecordRevision` with `action='lock'`/`'unlock'`, `version` = the consumed integer, `snapshot=NULL`, `patch='{}'`, `changed_field_ids=[]`. Chain stays `create v1 / update v2 / lock v3 / update v4` — dense. Forward-only, **no backfill** (OD-5: historical lock/unlock left no trace; strict mode sound only from ship-forward — acceptable, flag default-off).

**B. SYSTEM-SHEET — structurally excluded (never markers):** one `isSystemSheet(sheet)` predicate = `isApprovalProjectionBaseId(base_id === 'base_apr_projection')` **OR** `isSystemPeopleSheetDescription(description === '__metasheet_system:people__')` (both existing side-effect-free helpers). Excludes people-directory sync (`:5177/:5194`, bumps version without a revision) and approval projection (`:225`, version+1 on-conflict, regenerable read-model). Excluded **before** any contiguity assertion.

**Pinned, not folded in:** `recreateFieldFromConfig` field-undelete rehydration (`univer-meta.ts:6537`) mutates data with **no version bump** ⇒ invisible to version-contiguity; it is owner-ruled OD-6 MUST-WRITE with its own rung (sole `KNOWN_REVISION_GAPS` entry `456ec0c986a1b1af`) — W0-1 keeps it PINNED there; fixing it here would conflate two rungs.

## §4 Migration plan (generation-aware, non-breaking)
One zzzz-timestamped **Kysely** migration (must sort after `zzzz20260430172000` and `zzzz20260711000000`; a numeric `NNN_*.sql` would run before the table exists and silently no-op — the documented `restored_from_version` pitfall, [[feedback_migration_zzzz_ordering]]):
- **Only required DDL — relax the action CHECK:** `DROP CONSTRAINT IF EXISTS meta_record_revisions_action_check; ADD CONSTRAINT … CHECK (action IN ('create','update','delete','lock','unlock'))`. Pure relaxation — every existing row still satisfies it, validates instantly, no rewrite. `down()` restores the 3-value CHECK (safe: no marker rows exist until emission ships, which lands after this).
- **Optional index** (recommended) covering the §2 window `(sheet_id,record_id,created_at,version,id)`.
- **No unique constraint anywhere.**
- Verify with a **fresh-DB full migrate**.

## §5 C8 same-txn re-check + C4 fence (unconditional live-P1 fix, independent of the strict flag)
Isolation is READ COMMITTED (`connection-pool.ts:158` plain BEGIN) — advisory-lock insert-fencing is valid with no SSI retry.

**RESET (`univer-meta.ts:10373`, single destructive txn `:10415` — primary destructive path), full atomic fix:**
1. FIRST statement in the txn: `await acquireAutoNumberSheetWriteLock(query, sheetId)` (`auto-number-service.ts:17`, `pg_advisory_xact_lock(hashtext('meta:auto-number:sheet:'||sheetId))`, held to commit, **outermost** before any FOR UPDATE — matches `createRecord:518` to avoid lock-order inversion). This is the C4 fence and the only possible phantom-INSERT fence.
2. Re-run `precheckSheetHistoryIntegrity(query, sheetId)` with the **txn** query; `if(!ok) throw HistoryIncompleteError`. The pre-txn call `:10046` stays as a cheap fail-fast gate; this in-txn one is authoritative and atomic with the writes (closes the check→write TOCTOU).
3. **Re-enumerate** revert-set + delete-set with the txn query under the fence (thread `computeSheetReset` to accept a QueryFn — `buildRecordPatchContext`/`reconstructRecordsAtT`/`loadAllowedFieldIds` already take one, so mechanical — or inline). **Move the `previewIdentity` verification (`:10397`) INSIDE the txn**, recomputing the scope hashes from the in-txn set → a phantom insert either appears (identity mismatch → throw → 409 re-preview, never silently deleted → C4) or was fenced.
4. Keep the per-`affectedId` FOR UPDATE + expectedVersion checks (`:10423`) as the delete-set-member TOCTOU guard.

**REVERT (`univer-meta.ts:10373`… resurrect txn `:10206`):** wrap the resurrect block's precheck in the same in-txn re-check + fence. **Honest limit (deferred, §9.3):** revert's field-reverts are per-record `patchRecords` txns (`record-write-service.ts:768`) — making the loop precheck-atomic needs an outer-txn refactor; until then field-reverts stay guarded by per-record FOR UPDATE + expectedVersion, and the **interim default-off revert gate (#4261) is the operative protection.**

## §6 C2 monotonicity guard (fail-closed, included)
`reconstructRecordsAtT` selects by `created_at` (`record-reconstructor.ts:54`), and `created_at DEFAULT now()` = txn-start ⇒ under concurrency version-order can disagree with time-order. Include a **fail-closed guard inside the contiguity walk**: if within a generation the `created_at` order and `version` order disagree, refuse `nonmonotonic_history`. (Open item is only *scope* — §10.1.)

## §7 Flag + trusted-window posture
`MULTITABLE_HISTORY_CONTIGUITY_STRICT` default-off: flag-off = **byte-for-byte** current #4234 live-vs-latest (zero behavior change; existing tests green). Flag-on = §2 strict contiguity + §6 guard. trusted-since/contiguity/generation form **one retention-bounded trust window**; strict mode reasons only inside the un-pruned window and is sound **only from marker-emission ship-forward** (legacy pre-marker locked records refuse fail-closed by design). This is **not** the #4261 revert gate.

## §8 Golden matrix (real-DB, mutation-proven, two-point CI-wired)
- **healed-gap** (per-generation): v3 with only v1+v3 ⇒ revert-preview + reset-preview to gap-T = 409 (flag-on); = 200 (flag-off). Mutation: remove contiguity ⇒ on-case reds.
- **delete→restore→delete** (generation boundary): v1..v3-delete then new v1-create ⇒ **passes** (not a false gap/regression). Mutation: naive cross-generation version-monotonic check ⇒ reds.
- **deleted-gap** (C3): now-deleted record with mid-gap ⇒ refused on the reconstruction that would resurrect it. Mutation: live-only enumeration ⇒ reds.
- **dup-version-within-generation**: last-update + delete share the terminal integer ⇒ **not** flagged (the model expects it).
- **lock/automation-lock not refused** (markers load-bearing): record whose only extra bumps are lock/unlock ⇒ passes. Mutation: remove the marker write ⇒ reds.
- **system-sheet exclusion**: a people/approval-projection sheet with version-bump-no-revision ⇒ not refused. Mutation: drop `isSystemSheet` ⇒ reds.
- **C8 TOCTOU** (reset): a real concurrent uncaptured write committed between the pre-txn check and the in-txn re-check ⇒ caught in-txn (409, zero writes).
- **C4 phantom-insert** (reset): a real concurrent INSERT of a would-be-deleted row ⇒ identity mismatch → 409, not silently deleted.
- **formula/derived not refused**; **positive control** (healthy chain → any T passes); **flag-off parity** for every case.

## §9 Deferred (with justification)
1. **Persistent `generation` column** — scheme A derives on all history with zero migration; C only for an absolute "Nth lifetime" label surviving pruning, nullable + no-backfill if ever added. Owner fork §10.3.
2. **`recreateFieldFromConfig` revision** (`:6537`) — no version bump ⇒ invisible to contiguity; owner-ruled OD-6 MUST-WRITE with its own rung; pinned in `KNOWN_REVISION_GAPS`, not conflated here.
3. **Revert field-revert loop atomicity** (`:10293`) — per-record txns; loop-atomic precheck needs an outer-txn refactor beyond minimal C8. Resurrect txn IS atomic; field-reverts guarded by per-record FOR UPDATE + expectedVersion + the #4261 gate.
4. **Strict whole-sheet survivor FOR UPDATE** — deadlock risk vs bulk-patch Map-order locking; the advisory fence + per-affectedId FOR UPDATE already cover phantom + delete-member TOCTOU. Adopt only with deterministic id-sorted locking. Fork §10.6.
5. **Interim Revert-execute default-off gate** — separate PR #4261 (owner condition 6).
6. **Backfill of historical lock/unlock markers** — unreconstructable; backfill would fabricate history (OD-5 forbids). Forward-only.

## §10 Open forks for owner (recommendations in **bold**)
1. **C2 scope** — the fail-closed monotonicity guard is in the flag-on walk. Also refuse on the flag-off content-diff path? **Recommend: contiguity-scoped (flag-on only) for launch safety.**
2. **C4 fence completeness** — add `acquireAutoNumberSheetWriteLock` to the two residual user-sheet phantom inserters (trash-restore `record-service.ts:1072`, automation create `automation-executor.ts:2538`) for a clean C4 claim, or document the residual gap (concurrent restore/automation-create phantom survives reset's re-enumeration → "reset to T" with a surviving row)? **Recommend: add the fence to both.**
3. **Persistent generation column** — need an absolute retention-surviving lifetime label? **Recommend: no — stay derive-only.**
4. **Marker emission posture** — ship lock/unlock/automation-lock markers unconditionally with the migration (**recommended**, so a trusted window exists at flip) or behind their own enable? History Center: surface lock/unlock markers or filter? **Recommend: filter (preserve current timeline UI).**
5. **Strict flip timing** — turning the flag on refuses (fail-closed) any record whose retained generation predates marker-emission ship. Confirm this trusted-window posture + intended flip window.
6. **Strict whole-sheet survivor FOR UPDATE** — adopt (deadlock-guarded, id-sorted) or rely on advisory fence + per-affectedId FOR UPDATE? **Recommend: the latter.**

## §11 Model dispatch (per owner policy)
Opus: the migration, generation/contiguity SQL, C8/C4 txn wiring, monotonicity guard, adversarial gate. Sonnet: marker emission (mechanical same-txn calls) + real-DB goldens. The impl is a **Draft** behind the default-off flag, independently adversarially reviewed with per-lane txn-boundary proof, **not merged/armed** pending owner ratify of §0 + the §10 forks.
