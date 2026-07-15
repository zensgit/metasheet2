# Time Machine — remaining-development map, order, model dispatch (design & verification, 2026-07-15)

**Status:** ASSESSMENT (answers "还有哪些开发量"), updated 2026-07-15 with the owner's `seq` mechanism decision + the L3-backfill trust boundary. Supersedes the now-stale #4288 (`ca0a12d11`, written 07-14 before the design review completed and W0 build started). Docs-only.

> **UPDATE — OWNER RE-REVIEW 2026-07-15 (v3.6): `seq` accepted, but #4262 NOT ratified; the L3 gate is FALSIFIED.** The premature v3.5 ratify is retracted and its containment PASS invalidated (compose-validation cwd bug, fix #4329). Two Highs the independent L3 gate missed: **(C2)** reconstruction still selects by `created_at ≤ T` (=txn-start) — needs a NEW **reconstruction-linearization lane** (`effective_at` under the L4 fence → seq boundary, not `created_at`); **(C3)** the precheck checks only the terminal generation — needs an **asOf-generation** check. Plus: seq is allocation- not commit-order (causal only under L4 fence + L5 checkpoint), and L3's `Number(seq)` comparison must become exact bigint. **+2 lanes; W0 build ≈ 5–8 pw (was ~3–5).** Details in #4262 v3.6 §0.6/§2b/§4/§10.
>
> **Headline — OWNER DECIDED 2026-07-15: the ordering primitive is `seq`.** The two-track divergence is resolved at the mechanism level:
> - **#4262 v3.5's shared persistent causal `seq` is THE (and only) subsequent design for C2/C3/C6.**
> - **#4269's epoch-ms/version/delete-last comparator is DEMOTED** to: the landed first-cut implementation; the flag-OFF compatibility & rollback path. It is **no longer a trust basis for history completeness**, and **strict mode must NOT fall back to it.** The on-main W0-1 lock doc (`…contiguity-trusted-since-…`) is superseded on ordering + C2/C3/C6 by #4262 v3.5.
> - **This is a MECHANISM decision only — NOT a formal ratify.** Formally marking #4262 RATIFIED still awaits a full **containment PASS** (§4). #4262 stays PROPOSED with the direction locked.
>
> **Trust-origin boundary the owner pinned:** L3 (#4309) landing alone is **NOT** W0 built-to-trust. Its legacy `seq` **backfill numbers the revisions and markers tables separately (row_number per table) ⇒ values can overlap ⇒ the backfilled seq is not causal evidence.** (Forward inserts share one `meta_record_chain_seq` and ARE totally ordered; only the legacy backfill overlaps, which is fine because pre-checkpoint data is fail-closed.) The real trust origin is: **L4 all-writer fence → L5 time-anchored baseline checkpoint → strict enablement.** Strict mode is not trustworthy until L4+L5 land and the checkpoint cutover runs on a PASS'd host.

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
| **L3** chain-integrity core | seq migration + markers + seq-ordered *chain-walk* contiguity, behind default-off flag | **Draft #4309; gate said MERGE_CLEAN but owner re-review FALSIFIED it (C2 reconstruction + C3 terminal-only Highs); needs re-build (exact bigint + asOf-generation); HELD** | opus review / sonnet impl |
| **L4b** (NEW) reconstruction linearization | `effective_at` under fence + reconstruct-by-`effective_at`→seq (the C2 REAL close) — reconstruction must stop trusting `created_at`=txn-start | **not started; depends on L4** | opus |
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

**Remaining ≈ 17–29 dev pw** (Option-B; +6–10 Option-A) — the v3.6 re-review added ~2 lanes (reconstruction linearization + asOf-generation) that the earlier 15–27 estimate omitted; L3 also needs re-build (bigint + asOf-generation), so it is NOT a finished slice. Safe-enable minimum = W0 correction (**L4 + L4b + L5**, ~5–8 pw incl. L3 re-build) + Revert-atomicity (L8, 2–4 pw). The real critical path remains **owner decisions + a VALID containment PASS**, not raw pw.

## §7 Owner decisions that gate the line
1. **W0-1 mechanism — DECIDED (`seq`, 2026-07-15).** Remaining owner action = **formal ratify of #4262 v3.5, which awaits containment PASS** (not before). The on-main epoch-ms lock is superseded on ordering/C2/C3/C6.
2. **Ratify #4262 v3.5** (`8828edbd0`) · **#4274 rev7** (`de03c7337`) · **#4224** (after #4273 re-measure).
3. **Containment:** merge #4316, authorize staging re-normalization, re-run to full PASS (Phase 0).
4. **#4205 T-state** — revive / fold into History Center / close.
5. **Authorize or decline** the edge-history slice (L11).
6. **O-2 enablement** ladder after W0 trusted + PASS.
7. **Housekeeping** — close #4288 (superseded by this doc as the working map); the R13 lane drafts already noted in #4288.

## §8 Verification
- Every §1/§3 claim checked against `origin/main` (merged PR# or branch) or the independent gate report (`/tmp/pr4309-review-claude-20260715.md` for L3 — verdict MERGE_CLEAN, **but owner re-review found two Highs the gate missed** (C2 reconstruction path + C3 terminal-only), a real gate limitation now recorded). The two-track divergence was found by diffing the on-main W0-1 lock (epoch-ms) against #4262 (seq) and #4307's ledger.
- **Not claimed:** that anything is ratified, that W0 runtime is trustworthy/enabled, or that containment is PASS. This is the grounded map; §7 items are yours.
- **Discipline encoded in the order:** design-lock ratify before destructive impl; the containment PASS gate (via #4316) before any resume; W0 trust (L3+L4+L5) before T-state/base-wide/scale; Revert-atomicity (L8) before any Revert enable; every recovery flag stays default-off until its trust envelope is green on a PASS'd host.
