# Time Machine — remaining-development map, order, model dispatch (design + verification)

**Date:** 2026-07-14 · **Status:** ASSESSMENT (answers "还有哪些开发量" — grounded on `origin/main`, not PR titles) · **Method:** a 4-agent survey (landed-runtime inventory ‖ open-PR triage ‖ unbuilt-gaps) + Opus synthesis, every capability checked against `origin/main` file:line or a merged PR#.

> **Headline (corrected against `main`):** the Time Machine is **much further along than the open drafts suggest** — the read/PIT/revert/reset/undelete/trash/config-history surface and the full revision-emission substrate are **landed** (behind default-off flags). What is **not** yet built is the **W0 trustworthiness correction** on top of the merged-but-defective #4269 precheck: causal `seq`, all-writer fence, trust baseline, deleted-chain enumeration, non-forgeable identity. Until that lands, the destructive-recovery flags must stay off (they are). The remaining line is **~20–32 dev person-weeks** (Option-B granular-async path; **+6–10 pw** if Option-A atomic base-wide), but the **real critical path is owner ratify + benchmark-gated cycles, not raw pw** — Phases 0–1 gate everything and are mostly already built.

---

## §1 LANDED on `main` (verified — the surface is real)
| Capability | Landed | Evidence (origin/main) |
|---|---|---|
| Revision emission across the whole write surface (all 8 A1–A8 sinks) | ✅ | #4245–#4249 merged: form CREATE/EDIT `univer-meta.ts:14544/14632`, plugin `records.ts:506/598`, automation `automation-executor.ts:2229/2535`, approval `automation-service.ts:2864`, attachment `univer-meta.ts:15880` |
| #4269 generation-aware contiguity precheck (replaces live-vs-latest §0.6; closes healed-gap + check→write race) | ✅ | merged `3356a7ed6`; `history-integrity-precheck.ts:163/258`, generation/marker logic `:197-236` |
| `meta_record_version_markers` table + lock/unlock marker write-path (HTTP + automation) | ✅ | migration `zzzz20260713150000`; markers at `univer-meta.ts:16503/16524`, `automation-executor.ts:3503/3520` |
| §0.6 `HISTORY_INCOMPLETE` fail-closed precheck (#4234), wired into all 4 routes + **C8 in-txn re-check on reset** | ✅ | #4234 merged; `univer-meta.ts:10001/10081`, in-txn re-check `:10446-10503`, **C4 `pg_advisory_xact_lock` fence** on reset |
| `reconstructRecordsAtT` (delete-aware deterministic PIT primitive) | ✅ | `record-reconstructor.ts:34` |
| GET /point-in-time read view — **LIVE-ONLY** (deleted-since-T excluded by v1 scope) | ✅ (scoped) | `univer-meta.ts:8335` seeds from `SELECT id FROM meta_records` then reconstructs |
| revert preview+execute · reset preview+execute (signed identity, size ceiling, drift guard, all-or-nothing txn) | ✅ | revert `:10161/10204`, reset `:10383/10425` |
| **#4261 `MULTITABLE_ENABLE_SHEET_REVERT`** master gate (default-off) + reset `PIT_RESET_ENABLED` (default-off) | ✅ | merged `86fa1d85c`; `univer-meta.ts:10159/10373` |
| PIT undelete/resurrect (original id, outbound links, restore-revision, inbound replay) — **triple-gated default-off** | ✅ | `univer-meta.ts:10248-10322`; `MULTITABLE_ENABLE_PIT_UNDELETE` ∧ SHEET_REVERT ∧ canDeleteRecord + typed confirm |
| trash/tombstone + retention sweeps (inbound-link tombstone capture; revision/config/tombstone sweeps, opt-in) | ✅ | `meta_records_trash`, tombstone tables `zzzz20260708090000`, `meta-revision-retention.ts:89/141/196` |
| Config history + config-tier restore (supported-revert classification, 422 unsupported) | ✅ | `univer-meta.ts:8555/8625/8825`, `config-restore.ts` |
| Revision-disposition guard (OD-6) — **`KNOWN_REVISION_GAPS` now EMPTY** after #4279 flipped field-undelete rehydration to revision-emitted | ✅ | `tests/unit/multitable-revision-disposition-guard.guard.test.ts` |

**Everything destructive is default-OFF in prod** (`SHEET_REVERT` / `PIT_RESET` / `PIT_UNDELETE`). Read-only previews are ungated (revert-preview) or gated (reset-preview). This is the correct posture until W0 trust closes.

## §2 The trust caveat — landed ≠ trustworthy (why W0-1 correction is still required)
The merged #4269 precheck is **defective** (owner's rounds 4–5, all verified in code): marker `UNIQUE(sheet_id,record_id,version)` is cross-generation + INSERT `ON CONFLICT DO NOTHING` (`record-history-service.ts:177-179`) ⇒ a restored record's new-generation marker is **silently swallowed** ⇒ healthy chain false-refused; the advisory fence is **one-sided** (create-family + reset only; every UPDATE/DELETE/plugin/automation/lock writer is **unfenced** ⇒ the write-after-recheck race is open); **C2 fail-open, C3 deleted-chain, C6 trust-floor deferred**; system-sheet identity is **description-spoofable**. **#4262 v3.2** is the correction lock. So: the machinery runs behind flags, but flipping the flags on before v3.2 lands would execute recovery over an untrustworthy chain. Containment (flags off) holds; **#4283** produces the host-side evidence leg.

## §3 Open-PR triage (titles lie; this is vs `main`)
- **Close — landed/superseded** (their runtime is on `main` under the merged PRs): **#4219 / #4216 / #4220 / #4204** (R13 lanes → #4245–#4249/#4269), **#3805** (completion master plan → overtaken). *Housekeeping, no dev.*
- **Close — stale plan docs** overtaken by this map + #4262 v3.2: **#4214**, **#4186**.
- **Reconcile then close: #4252** — fold its forward-looking C1–C8 conditions into #4262 v3.2, then close (single ratify target).
- **Active ratify targets:** **#4262 v3.2** (W0-1 correction), **#4274 rev4** (base-wide/hybrid), **#4224** (retention↔Reset + >5k async), **#4230** (comment-affordance governance — adjacent).
- **Genuinely-open impl (Draft):** **#4273** (benchmark — round-5 SQL-injection/attribution fix in flight), **#4283** (containment workflow — round-5 injection/false-PASS fix landed on branch).
- **Owner decision:** **#4205** (T-state Lane B — revive / fold into History Center / close), **#4229** (UI-P2-1c T5 — adjacent governance).

## §4 Remaining development lanes (model dispatch **by difficulty**)
Model rule: **fable** = mechanical FE/flags; **sonnet** = locked-spec impl + real-DB goldens; **opus** = hard correctness / schema / concurrency / security.

| Lane | Work | Model | Gate | ~pw | Goldens |
|---|---|---|---|---|---|
| **L1** #4283 | Finish read-only, dispatch-only containment workflow (injection-safe choice input, exact-container manifest, rendered `docker compose config`) | sonnet | none (open impl) | 1–2 (mostly built) | fail-closed refuse, expected-set, empty-guard |
| **L2** #4273 | Finish re-runnable scale benchmark (bounded run-id, advisory lock, no-DO-NOTHING, own-object cleanup, honesty) | sonnet | none (open impl) | 2–3 (mostly built) | injection-refuse, attribution, non-zero-on-cleanup-fail |
| **L3** #4262 §2/§4 | **W0-1 chain-integrity core**: one `meta_record_chain_seq` across revisions+markers; per-generation contiguity by seq; loud marker INSERT; C3 deleted/trash enumeration | opus | ratify #4262 v3.2 | core of the 3–5 bundle | generation-2-lock-survives, dup-fail-closed, deleted-gap, delete→restore→delete-passes |
| **L4** #4262 §3 | **All-writer shared sheet fence** — every meta_records writer takes `acquireAutoNumberSheetWriteLock` inside its real txn (same-txn/same-connection contract + per-family matrix) | opus | ratify #4262; after L3 seq | 1–2 within bundle | constructed unfenced-writer race, autocommit-fence-trap |
| **L5** #4262 §6/§7 | **Trust baseline + non-forgeable identity** — `meta_history_trust_checkpoints` (partial-unique active, `trusted_from_at`) + `meta_history_baselines` + retention floor; `system_kind` | opus | ratify #4262; two-phase rollout | 1–2 within bundle | baseline-redemption, supersession, retention-progress, spoof |
| **L6** #4274 rev4 | **Base-wide / hybrid restore** — `meta_restore_operations` state machine, chunked async, durable-row fence, plan→apply TOCTOU re-check | opus | HARD: #4262 landed+trusted + #4224 + benchmark | Option-B 4–7 (Option-A +6–10) | idempotency, fence-refusal, TOCTOU, crash-window |
| **L7** #4224 | **Retention↔Reset coexistence + >5000 async job** — replace the blanket `PIT_RESET_RETENTION_BLOCKED` 409 with floor-aware coexistence; the async engine (**shared with L6**) | opus | ratify #4224 + benchmark evidence | 3–5, mostly shared w/ L6 | retention-floor-refuse, async-resume |
| **L8** | **Revert-execute outer-txn atomicity** — wrap the best-effort per-record field-revert loop (`univer-meta.ts:10140+`) in one transaction | opus | revert default-OFF; Option-A only | 2–4 (subset of #4274 A) | loop-atomicity, partial-failure |
| **L9** #4205 B-FE | **T-state history experience (FE)** — History Center version canvas / single-record preview + click-through restore | fable | revive/ratify #4205 + read-contract | ~2 | render, deep-link, mask parity |
| **L10** #4205 | **Deleted-since-T reappear + guarded restore ledger** — /point-in-time `includeDeleted` enumeration + operationId-idempotent single-record resurrect UI path | opus | W0-1 C3 landed (L3) | 2–4 | deleted-reappear, no-existence-leak, idempotent-resurrect |
| **L11** | **Edge-level `meta_links` as-of-T history** — `reconstructLinksAtT` + as-of-T link-graph view + revert-path inbound rebuild | sonnet | **NEW owner-ratified slice** (overrides the standing OD-4 "link-edge history separate lock") | 2–4 | as-of-T edge set, resurrect-fidelity |
| L-ops | **O-2 operator flag ladder** — staging→prod enablement of the six recovery flags | — | owner/ops after W0 trusted | ~0 dev | staging acceptance run |

## §5 Order + parallelization
- **Phase 0 (owner, NOW — no dev dependency):** ratify **#4262 v3.2** (fold #4252's C1–C8, then close #4252); queue **#4224 / #4274** ratify **behind #4273 benchmark evidence** (their own bodies demand it); decide **#4205** fate; close the superseded drafts.
- **Phase 1 — safety gates (MUST precede any W0-1 runtime), parallel:** **L1 (#4283) ‖ L2 (#4273)**. L2's evidence unlocks #4224/#4274 ratify; L1 is the host-side containment leg #4262 §0 requires. Both mostly built.
- **Phase 2 — W0 trust close (after #4262 ratified AND both gates green):** **L3 seq-core lands FIRST** (the seq migration is the pinch point). Once seq exists, **L3-C3-tail ‖ L4 (fence) ‖ L5 (trust+identity)** run 3-wide — fence and identity are seq-independent, C3 rides seq.
- **Phase 3 — recovery scale (after W0 trusted + benchmark + #4224/#4274 ratified):** **L6 ‖ L7**, but they **must reconcile ownership of the async engine** (build it once — #4274 Option-B and #4224 async overlap). L8 only if the owner picks Option-A.
- **Phase 4 — T-state + relations:** **L9 (FE) ‖ L10 (deleted-since-T, needs L3's C3)**; **L11** only if the owner authorizes the new edge-history slice.
- **Then O-2 ops enablement** (owner/ops, ~0 dev).

**Total: ~20–32 dev pw** (Option-B). **+6–10 pw** if Option-A atomic base-wide. Safety gates ~3–5 (mostly built) · W0-1 bundle 3–5 · base-wide+retention+async 7–12 (shared surface) · revert-atomicity 2–4 · T-state 4–6 · edge 2–4 · O-2 ~0.

## §6 Owner decisions that gate the line
1. **Ratify #4262 v3.2** + resolve its §9 forks (marker-dup, fence-breadth, baseline mechanism [decided: separate table], retention severity, seq backfill).
2. **Fold #4252 C1–C8 into #4262** (or a follow-up), then close #4252.
3. **Ratify #4224** — HARD prerequisite is #4273 benchmark evidence.
4. **Ratify #4274 rev4 + the product model decision:** Option-A atomic base-wide (+6–10 pw, pulls in L8) vs Option-B granular-async (recommended by the evidence).
5. **Reconcile async-engine ownership** — #4224 async vs #4274 Option-B async (build once).
6. **Decide #4205** — revive / fold into History Center / close (resolve OD-B1..B7 if revived).
7. **Authorize or decline** a new ratified slice for as-of-T edge/link-graph history (L11) — overrides the standing OD-4 separate-lock.
8. **O-2 enablement** — authorize staging/prod flag ladder once W0 trust closes (ops action).
9. **Housekeeping closes** (no dev): #4219 / #4216 / #4220 / #4204 / #3805 / #4214 / #4186.

## §7 Verification
- **Method:** each §1 capability was checked against `origin/main` (file:line or merged PR#), not PR titles — the survey explicitly re-derived PR state vs `main` because parallel sessions landed content under different PRs. Landed set verified via `gh` merge status + `git show origin/main`.
- **Per-lane goldens** are in §4 (each real-DB, mutation-proven, two-point CI-wired; the W0-1 lanes carry constructed-race goldens per #4262 v3.2 §8). No lane is "done" without its mutation-proven golden red-capable.
- **Standing discipline encoded in the order:** design-lock ratify precedes destructive impl; the two safety gates (#4283 containment, #4273 benchmark) precede W0-1 runtime; W0 trust closes before T-state/base-wide/scale; every recovery flag stays default-off until its trust envelope is green.
- **What this MD does NOT claim:** that anything is ratified or that W0-1 runtime is built. It is the grounded map + plan; the gates in §6 are the owner's.
