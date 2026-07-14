# W0-1 (v3) — correction lock over landed #4269: causal seq across revisions+markers, all-writer fence, deleted-chain, trust floor

**Date:** 2026-07-14 · **Status:** PROPOSED (owner ratify target) — **v3: a correction lock over the MERGED #4269 (`3356a7ed6`)**, not greenfield. · **Supersedes:** v1/v2 of this lock, #4250 (closed). · **Model:** Opus.

> **The base changed:** #4269 (parallel session) landed the generation-aware contiguity precheck + marker table on `main`; #4256 closed; #4278 converged the master-gate flag on `MULTITABLE_ENABLE_SHEET_REVERT`. The owner's review of the *landed* state found it **not yet a trustworthy W0-1 terminal state under flag-on**. v3 = the fix list for the landed code (each defect pinned to `origin/main` file:line) + the remaining unbuilt pieces, absorbing #4269's structural advantages (separate marker table) while replacing its unreliable primitives (cross-generation version uniqueness; created_at ordering).

## §0 CONTAINMENT (standing until this lock is ratified, built, and gated green)
`MULTITABLE_ENABLE_SHEET_REVERT=false` and `MULTITABLE_ENABLE_PIT_RESET=false` in **every real environment**. Code-default-off ≠ real-env-off: **ops must verify the running hosts' env** (repo-side verified clean 2026-07-14 — no `.env`/CI/docker/source sets either flag true; the deploy-host check is an ops action, a sandbox probe is not evidence). The strict precheck's own flag only controls launch disruption, not this containment.

## §1 Owner findings on the LANDED state → v3 fixes
| # | Landed defect (origin/main) | v3 fix |
|---|---|---|
| P1-1 | **Marker unique key is cross-generation:** `UNIQUE (sheet_id, record_id, version)` (`zzzz20260713150000_create_meta_record_version_markers.ts:40`) + the marker INSERT is `ON CONFLICT … DO NOTHING` (`record-history-service.ts:177-179`). A record restored/resurrected resets `version` to 1; a **new generation's lock at a previously-marked version is silently swallowed** → the contiguity walk sees a hole → **healthy chain false-refused**. Worse, the swallow is silent: the lock/unlock *succeeds* while its marker is dropped. | **§2**: drop the cross-generation unique; markers join the **shared causal `seq`** domain; dup-detection moves into the per-generation walk (fail-closed on a *within-generation* duplicate); the INSERT **must not** `DO NOTHING` — a marker-write failure fails the lock/unlock txn loudly. |
| P1-2 | **Fence only on one side:** the advisory fence (`acquireAutoNumberSheetWriteLock`) is held by reset-execute's destructive txn (+ the create-family: `record-service.ts:518`, `records.ts:587`, form-submit `univer-meta.ts:14485`, auto-number `:82`). **No UPDATE/DELETE writer takes it** — `patchRecord` (`record-service.ts:1389`), bulk patch (`record-write-service.ts:972`), `deleteRecord` (`record-service.ts:894`), plugin patch (`records.ts:508`), automation update (`automation-executor.ts:2231`), lock/unlock (`univer-meta.ts:16426/16441`) — so a write can still land **after** the in-txn re-check on a row outside the FOR-UPDATE set → commit ≠ T. | **§3**: the fence becomes the **shared sheet-writer fence** — every `meta_records`-mutating writer acquires it outermost. With all writers fenced, reset's in-txn re-check (already landed, `univer-meta.ts` reset txn) becomes actually authoritative. |
| P1-3 | **Deferred-but-load-bearing:** #4269 explicitly ships C2 **fail-open** (time-anchor monotonicity unproven), C3 deleted-chain enumeration deferred, C6 trust floor deferred. | **§4/§5/§6**: C2 fail-closed via seq; C3 deleted/trash enumeration in-scope; C6 checkpoint + retention floor in-scope. None of these may be deferred again while calling W0-1 done. |
| P1-4 | **System-sheet identity still partially description-sentinel** (user-settable at sheet create) → a normal sheet can spoof system identity and skip the strict precheck. | **§7**: server-owned `system_kind` column set only by internal provisioning; API rejects/ignores it from user input; spoof golden. |

## §2 Causal order — ONE `seq` domain across revisions AND markers
The chain walk must interleave content revisions and markers in true causal order; `created_at` (=txn-start, same-ms collisions), `version` (resets per generation), and UUID ids cannot do this — and today the marker join orders by exactly those.
- **Migration:** one PG sequence `meta_record_chain_seq`; add `seq BIGINT DEFAULT nextval('meta_record_chain_seq')` to **both** `meta_record_revisions` and `meta_record_version_markers`; NOT NULL after backfill; indexes `(sheet_id, record_id, seq)`. Backfill legacy rows best-effort by `(created_at, version, id)` — legacy pre-checkpoint records are fail-closed anyway (§6), so the backfill is ordering-for-display, not trust.
- **Generation** = count of `action='create'` revisions at-or-before, **ordered by seq**. **Contiguity** judged per `(sheet_id, record_id, generation)` in seq order; the version chain must be +1-dense within the generation, markers occupying their consumed versions; the terminal `delete`'s version-duplicate is expected; `v3-delete → v1-create` = generation boundary, never a regression.
- **Marker uniqueness** (replaces the dropped constraint): *within a generation* exactly one chain event may occupy a version; a duplicate ⇒ fail-closed `chain_corrupt`. Cross-generation repeats are legal by construction. The marker INSERT drops `ON CONFLICT DO NOTHING` — any conflict fails the enclosing lock/unlock txn loudly (no silent swallow, no divergence between the version bump and its marker).
- **C2 (fail-closed, no longer fail-open):** within a generation, `seq` order and `version` order must agree; disagreement ⇒ `nonmonotonic_history` refuse. With a true causal seq this flags genuine corruption, not clock skew.

## §3 All-writer shared sheet fence (completes the landed one-sided fence)
Every `meta_records`-mutating write path acquires `acquireAutoNumberSheetWriteLock(query, sheetId)` as its **outermost first statement**: patchRecord, bulk patch, deleteRecord, plugin patch/create/delete, automation create/update/delete/lock/unlock, form-submit (has it), trash restore, PIT resurrect, attachment-delete, lossy-retype revert, lock/unlock routes. (~10 sites; create-family already compliant.) Single serialization point per sheet ⇒ no deadlock; reset/revert destructive txns hold it ⇒ nothing can write after the in-txn re-check. Reset additionally keeps the landed in-txn re-check + per-affectedId FOR UPDATE; **revert's resurrect txn gets the same in-txn re-check**; revert's per-record field-revert loop remains deferred behind the #4261 gate (unchanged honest boundary).

## §4 Deleted/trash chain enumeration (C3 — in scope)
Strict mode enumerates live rows **AND** records that existed at T but are now deleted (from the revision chain + `meta_records_trash`): Revert resurrects them, so their generations must pass the same per-generation contiguity or the operation refuses. Golden: deleted record with a mid-generation gap ⇒ 409 on the reconstruction that would resurrect it.

## §5 Marker consumer surface (carried from v2, unchanged)
The separate marker table (adopted from #4269 — its structural advantage stands) keeps markers out of `meta_record_revisions` consumers by construction; the remaining obligations: the reconstructor and the precheck join markers via seq (§2); History Center/before-hydration/restore-by-version never see markers (already structural); retention sweeps must not orphan markers from their generation (§6 floor covers both tables).

## §6 Trust checkpoint + retention floor (C6 — in scope)
`meta_history_trust_checkpoints (sheet_id, trusted_since_seq, created_at)` — survives record deletion; set at a controlled cutover **after** the all-writer fence + loud-marker emission are deployed to all instances (two-phase rollout as v2 §7). Strict mode reasons only at/after the checkpoint; pre-checkpoint generations fail-closed. Retention floor: never prune a generation's `create`, never prune (revisions OR markers) below `trusted_since_seq` — fail-closed, hard block.

## §7 Non-forgeable system identity
`meta_sheets.system_kind TEXT NULL`, set only by internal provisioning (`ensureSystemBase`/`ensureFamilySheet`/people-sheet seeding); sheet create/update API rejects or ignores it from user input; `isSystemSheet = system_kind IS NOT NULL`; legacy backfill keyed on the non-forgeable provisioning identity (approval base_id + internal people-sheet id), never description. Spoof golden: user sheet with the magic description but NULL `system_kind` **is** strictly prechecked.

## §8 Golden matrix (delta over #4269's landed suite; real-DB, mutation-proven, two-point wired)
- **generation-2 lock survives** (the P1-1 regression test): create→delete→restore→lock at a version the first generation also marked ⇒ marker INSERT succeeds (no swallow), strict precheck **passes**. Mutation: restore `ON CONFLICT DO NOTHING` ⇒ this reds.
- **within-generation duplicate ⇒ fail-closed** `chain_corrupt`.
- **unfenced-writer race closed** (the P1-2 constructed race): concurrent `patchRecord` attempted during reset's fenced txn blocks until commit (pg_blocking_pids harness) — final state == T. Mutation: remove the fence from patchRecord ⇒ race golden reds.
- **C2 fail-closed**: seq/version disagreement within a generation ⇒ 409. **C3 deleted-gap** ⇒ 409. **checkpoint/floor**: pre-checkpoint generation ⇒ fail-closed; retention sweep refuses below floor. **spoof golden** (§7). Plus #4269's landed goldens stay green (healed-gap, delete→restore→delete passes, formula, flag-off parity).

## §9 Open forks (owner; recommendations **bold**)
1. Marker dup within generation: fail-closed `chain_corrupt` (**recommended**) vs auto-heal.
2. Fence breadth: all ~10 writers (**recommended**) vs destructive-paths-only (leaves the P1-2 race).
3. Checkpoint granularity: per-sheet (**recommended**) vs global. 4. Floor severity: hard block (**recommended**) vs warn.
5. Legacy seq backfill: display-only best-effort (**recommended**, trust comes from the checkpoint) vs none.

## §10 Sequence
① Containment verified by ops (§0) → ② ratify this v3 → ③ impl as Draft behind the strict flag (Opus: migration/seq/fence/checkpoint; Sonnet: goldens; independent Opus adversarial gate with per-lane txn proof + constructed races) → ④ two-phase rollout, checkpoint cutover, then owner decides strict flag-on. Estimates: ~3–5 pw on top of landed #4269 (it built the precheck skeleton + marker table + reset in-txn re-check; v3 corrects primitives and completes the trust envelope).
