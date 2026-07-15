# Time Machine — remaining-development map, order, model dispatch (design & verification, 2026-07-15)

**Status:** ASSESSMENT (answers "还有哪些开发量" against current `origin/main` + the open board). Supersedes the now-stale #4288 (`ca0a12d11`, written 07-14 before the design review completed and W0 build started). Docs-only.

> **Headline (must read first — a two-track reconciliation the owner should resolve).** There are **two W0-1 design-lock documents for the same trust problem**, and they diverge on the ordering primitive:
> - **On main (parallel-session track):** `…global-history-w0-1-history-incomplete-contiguity-trusted-since-design-lock-20260713.md` — records the **first-cut SHIPPED as #4269** (`3356a7ed6`, owner spot-check PASS), with **C2/C3/C6 explicitly DEFERRED** (owner order C2→C3→C6). Its comparator is an **epoch-ms / version / delete-last structured comparison** (per #4307's close-out ledger).
> - **My track (#4262 v3.5, your rounds 4–9 → APPROVE-for-ratification):** a **correction lock over #4269** that finds the epoch-ms order non-causal and **replaces it with a persistent monotonic `seq`**, and supplies the deferred **C2 (fail-closed monotonicity), C3 (deleted-chain enumeration), C6 (baseline-checkpoint trust anchor)** plus the all-writer fence and non-forgeable `system_kind`. **W0 build Lane L3 (#4309) implements the seq core.**
>
> These are complementary in intent (mine *is* the design for the deferred C2/C3/C6) but conflict on the mechanism: **`seq` vs `epoch-ms`.** Both were driven by you (you PASS'd #4269's first-cut *and* mandated `seq` while reviewing #4262 in round 6). **Owner reconciliation item #1:** confirm #4262 v3.5 (seq) is THE design for the deferred C2/C3/C6 and supersedes the epoch-ms comparator, so the two lock docs are unified (mine extends/replaces the parallel one for C2/C3/C6). The rest of this map assumes that resolution.

---

## §1 LANDED on `main` (verified 2026-07-15)
- **Revision-emission substrate complete** — all 8 write-site slices (#4245–#4249), field-undelete rehydration emits revisions (#4279) + batched (#4299, 769× fewer statements), disposition guard `KNOWN_REVISION_GAPS` empty.
- **W0-1 first-cut #4269 SHIPPED** (`3356a7ed6`) — generation-aware contiguity (epoch-ms comparator) replacing live-vs-latest, `meta_record_version_markers` table, `isSystemSheet`, C4 advisory fence + C8 in-txn re-check on reset. **C2/C3/C6 deferred.** Owner spot-check PASS.
- **§0.6 precheck (#4234)** wired into revert/reset preview+execute; **#4261 `MULTITABLE_ENABLE_SHEET_REVERT`** master gate + `PIT_RESET_ENABLED`, both default-off.
- **Read/PIT/recovery surface** (from #4288 §1, still current) — `reconstructRecordsAtT`, PIT view (live-only), revert/reset preview+execute, PIT undelete/resurrect (triple-gated), trash/tombstone + retention sweeps, config history + config-tier restore.
- **#4283 containment-check workflow MERGED** — the dispatch-only host-evidence tool.
- **Adjacent (separate W1/W2 program, not this line):** W1 terminology (#4295), W2 record-inspector lock (#4287/#4310/#4313 RATIFIED). Noted for context; out of Time-Machine scope.
- **Every destructive flag is CODE-default-off + repo-not-enabled.** Host state was **not** PASS at last check (see §4).

## §2 The trust caveat — landed ≠ trustworthy
The merged #4269 first-cut is the *interim*; it is **not** the trustworthy terminal state — C2 (epoch-ms cross-ms time-reversal can hide a hole; fail-open), C3 (deleted-record healed-gap), C6 (no persistent trust anchor) are open, and the all-writer fence is one-sided. The **#4262 v3.5 correction** (seq + fence + baseline checkpoint + deleted-enum + `system_kind`) closes them. Until it lands behind its default-off flag AND the checkpoint cutover runs, the recovery flags stay off.

## §3 W0 build — where the implementation actually stands
| Lane | Work | State | Model |
|---|---|---|---|
| **L3** chain-integrity core | seq migration (both tables) + drop cross-gen marker unique + loud marker + seq-ordered contiguity + C2 + C3, behind `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (default-off) | **Draft #4309; independent Opus gate = MERGE_CLEAN 0 P1/0 P2; HELD (see §4)** | opus review / sonnet impl |
| **L4** all-writer fence | every meta_records writer takes `acquireAutoNumberSheetWriteLock` inside its txn (same-txn/same-connection contract; per-family production-wiring mutation proof) | **not started** | opus |
| **L5** trust baseline + identity | `meta_history_trust_checkpoints` (building→active state machine, `trusted_from_at` = `clock_timestamp()` under fence, select-by-T, floor-selected retention) + `meta_history_baselines` + non-forgeable `system_kind` | **not started** | opus |

L3's two documented P3s (mature-DB pre-migration record / retention-swept deleted chain fail-closed under strict-ON) are **correct-by-design and flag-off** — they are exactly what L5's checkpoint redeems. One NIT (marker doc comment) pending.

## §4 The live blocker — containment FAIL-CLOSED (gates everything)
The recovery-flag containment check (`target=both`) **FAILED CLOSED** (run 29398270060): prod clean both ways, staging *current* container clean, but staging's **next-restart config unverifiable** — the Attendance Window Runner wrote its compose override under a per-run `/tmp` dir that cleanup deletes, while the container's `config_files` label still references it (an ops-persistence defect, **not** a flag leak; the containment design worked — it refused to false-PASS). **Repo fix = #4316** (override → persistent `$HOME/.metasheet2/window-runner/`, atomic write, portable mktemp + real-exec positive control; Draft, in owner review). **No Time-Machine action resumes until:** #4316 merges → staging re-normalized (ops re-stamps labels) → containment re-run → **full PASS**.

## §5 Remaining development lanes (model dispatch by difficulty)
**fable** = mechanical FE/flags · **sonnet** = locked-spec impl + real-DB goldens · **opus** = hard correctness/schema/concurrency/security.

| Lane | Work | Model | Gate | ~pw |
|---|---|---|---|---|
| L4 | all-writer fence (§3) | opus | #4262 ratify + containment PASS | 1–2 |
| L5 | baseline checkpoint + `system_kind` (§3) | opus | #4262 ratify + containment PASS | 1–2 |
| L6 | base-wide/hybrid restore (#4274 rev7): `meta_restore_operations` state machine, durable-row writer gate + restore-worker identity, chunked resume-forward, plan→apply TOCTOU | opus | W0 trusted + #4274 ratify + #4224 | Option-B 4–7 (Option-A +6–10) |
| L7 | retention↔Reset coexistence + >5000 async job (#4224) — shared async engine with L6 | opus | #4224 ratify + **#4273 re-measure post-W0** | 3–5 (shared) |
| L8 | **Revert-execute outer-txn atomicity** — MUST before enabling `SHEET_REVERT` at all (revert is per-record best-effort today) | opus | before any Revert enable | 2–4 |
| L9 | T-state history FE (#4205): version canvas / preview / click-through restore | fable | #4205 owner decision | ~2 |
| L10 | deleted-since-T PIT view + guarded single-record resurrect ledger (#4205) | opus | L3-C3 landed | 2–4 |
| L11 | edge-level `meta_links` as-of-T history | sonnet | NEW owner-ratified slice | 2–4 |
| L-ops | O-2 operator flag ladder (staging→prod enablement) | — | W0 trusted + containment PASS | ~0 dev |

## §6 Order + parallelization
- **Phase 0 (NOW — the blocker):** land **#4316**, re-normalize staging (ops), re-run containment to **PASS**. In parallel, owner: **reconcile the two W0-1 locks (§headline)** + ratify **#4262 v3.5** (`8828edbd0` content).
- **Phase 1 (after PASS + #4262 ratify):** merge **L3 #4309**; then **L4 (fence) ‖ L5 (checkpoint+identity)** — seq-independent, run 2-wide.
- **Phase 1b (before any Revert enable):** **L8** revert outer-txn atomicity; then **re-measure #4273** on the W0-corrected main (≥3× 5k execute + txn-boundary control).
- **Phase 2 (after W0 trusted + re-measure + ratify):** **L6 ‖ L7** (reconcile the shared async engine); ratify #4274 rev7 + #4224 first.
- **Phase 3:** **L9 (FE) ‖ L10 (deleted-since-T)**; **L11** only on a new owner slice.
- **Then O-2** operator enablement (owner/ops).

**Remaining ≈ 15–27 dev pw** (Option-B; +6–10 Option-A). Down from #4288's 20–32 because **L3 is built** (Draft) and the design phase is closed. Safe-enable minimum = W0 correction (L4/L5, ~2–4 pw on top of L3) + Revert-atomicity (L8, 2–4 pw). The real critical path remains **owner decisions + containment PASS**, not raw pw.

## §7 Owner decisions that gate the line
1. **Reconcile the two W0-1 locks** — confirm #4262 v3.5 (seq) is THE C2/C3/C6 design, superseding the epoch-ms comparator; unify the docs.
2. **Ratify #4262 v3.5** (`8828edbd0`) · **#4274 rev7** (`de03c7337`) · **#4224** (after #4273 re-measure).
3. **Containment:** merge #4316, authorize staging re-normalization, re-run to full PASS (Phase 0).
4. **#4205 T-state** — revive / fold into History Center / close.
5. **Authorize or decline** the edge-history slice (L11).
6. **O-2 enablement** ladder after W0 trusted + PASS.
7. **Housekeeping** — close #4288 (superseded by this doc as the working map); the R13 lane drafts already noted in #4288.

## §8 Verification
- Every §1/§3 claim checked against `origin/main` (merged PR# or branch) or the independent gate report (`/tmp/pr4309-review-claude-20260715.md` for L3 = MERGE_CLEAN). The two-track divergence was found by diffing the on-main W0-1 lock (epoch-ms) against #4262 v3.5 (seq) and #4307's ledger.
- **Not claimed:** that anything is ratified, that W0 runtime is trustworthy/enabled, or that containment is PASS. This is the grounded map; §7 items are yours.
- **Discipline encoded in the order:** design-lock ratify before destructive impl; the containment PASS gate (via #4316) before any resume; W0 trust (L3+L4+L5) before T-state/base-wide/scale; Revert-atomicity (L8) before any Revert enable; every recovery flag stays default-off until its trust envelope is green on a PASS'd host.
