# W0 built-to-trust — development & verification (living tracker, 2026-07-15)

**Goal:** deliver the Time Machine **W0 "built-to-trust"** runtime (default-off) per the owner's month plan (2026-07-15 → 2026-08-14), and this MD. **Not in scope this month:** >5000/base-wide async (#4274/#4224), full deleted-since-T T-state UI (#4205), edge-level link history, and — always separate — production flag enablement.

> **Honest status:** this is a **living tracker**, not a completion claim. W0 is ~10.5–16 person-weeks; it is **not** finishable in one session. Nothing here enables strict mode, Revert/Reset, or any host/staging/prod flag. Each slice ships **default-off, Draft, independently gated**. "Done" is asserted only per-slice with its mutation-proven goldens + independent gate verdict.

## §0 Ratified basis (what authorizes this build)
**#4331 v3.7 §9 — the 7 recommendations** (owner-ratified as the design basis; ratification authorizes **default-off implementation slices only** — NOT strict-mode/Revert/Reset enablement, host mutation, staging cutover, or production rollout):
1. **Executable anchor:** committed history batch/event only; **no free-wall-clock destructive execution.**
2. **Manual datetime:** read-only approximate navigation until a separate exact commit-time design exists.
3. **Generation:** **target-generation A** as terminal state (not terminal-only).
4. **Fence:** preserve the existing auto-number key; rename to a canonical sheet-state fence; canonical → PIT lock order.
5. **Execute:** full target/schema/set recomputation + preview verification **under the fence**.
6. **Batch endpoint:** **sealed operation ledger** — server-minted, sheet-scoped, one transaction group; exact `anchorSeq` frozen in a signed identity.
7. **Bigint:** string/bigint end-to-end; **no production-sequence mutation in tests.**

**Canonical docs:** #4328 (merged unified v3.6 lock) + #4331 v3.7 (`codex/w0-v37-anchor-lock`). **Superseded and closed (ledger convergence, this session):** #4262 (my v3.6 lock), #4319 (my map), #4288 (older map) — all pointed at #4328/#4331.

## §1 The v3.7 trust model (what "built-to-trust" means)
- **One causal `seq` domain** across `meta_record_revisions` + `meta_record_version_markers`; a PG sequence is allocation- not commit-order, so **causality begins only once the L4 fence is on every writer and an L5 checkpoint cuts off pre-fence/backfilled history.** Legacy backfill is display-only, never trust. Exact **string/bigint** comparison end-to-end (`Number`/`parseInt`/`+`/subtraction forbidden for seq).
- **Sealed operation endpoints** (`meta_record_history_operations(sheet_id, operation_id, endpoint_seq, event_count, …)`): each trusted write mints a server-side op-id, writes events under the fence with that op-id + exact seq, and inserts the endpoint row **last** (`endpoint_seq = MAX(event seq)`, exact count). **DB-enforced** (DEFERRABLE INITIALLY DEFERRED event→endpoint FKs; refuse appending to a sealed operation; endpoint validates count+max). The endpoint row is the **exact externally-visible commit boundary** an in-txn wall-clock sample cannot provide.
- **Exact recovery anchor:** the recovery API takes an opaque `anchorBatchId` (**not** wall-clock T, **not** a client seq) → server resolves to the sealed endpoint → `anchorSeq` → checkpoint with `trusted_since_seq ≤ anchorSeq` → signed preview identity `{sheetId, anchorBatchId, anchorSeq, checkpointId, actorId, scope hashes}` → execute verifies + uses the token-bound `anchorSeq` under the fence (never recomputes `MAX(seq)` as authority). A free wall-clock value returns **exact-anchor-required** refusal.

## §2 Build lanes (dependency-ordered; model by difficulty)
**opus** = hard correctness/schema/concurrency/security · **sonnet** = locked-spec impl + real-DB goldens · **fable** = FE/contract.

| Lane | Work | Model | Depends | Status |
|---|---|---|---|---|
| **L3** chain-integrity core (rebuild) | shared bigint seq migration (both tables, exact comparison) + generation-aware precheck: **target-generation** (not terminal-only), deleted/trash chain, dup/illegal-seq fail-close; behind default-off flag | sonnet | — | **🔨 building (this session)** |
| **L4** all-writer canonical fence | every meta_records writer takes the (renamed) canonical sheet-state fence, same-txn/same-connection; execute recomputes in-fence; per-writer-family production-wiring mutation proof | opus | L3 seq | ⏸ next |
| **L6-a** sealed operation-endpoint ledger | `meta_record_history_operations` + `operation_id` on revisions/markers; the mint→events→endpoint-last write protocol; DEFERRABLE FKs + seal-enforcement | opus | L4 fence | ⏸ |
| **L6-b** exact-anchor recovery API | opaque `anchorBatchId` → endpoint → `anchorSeq` → checkpoint → signed identity → in-fence execute; wall-clock ⇒ exact-anchor-required refusal; anchor picker (FE) | opus + fable | L6-a | ⏸ |
| **L5** trust checkpoint + identity | checkpoint table (building→active, `trusted_since_seq`, `clock_timestamp()` cutover), retention trust-floor, non-forgeable `system_kind` | opus | L4 | ⏸ |
| **L7** target-generation + deleted/trash | fold the target-generation + deleted enumeration into the execute/precheck path end-to-end | opus | L3+L6 | ⏸ (L3 lands the precheck leg) |
| **L8** Revert outer-txn atomicity | Revert single outer transaction (all-or-nothing), aligned with Reset; preview→execute drift ⇒ 409 zero-write | opus | L4 | ⏸ (must-before any Revert enable) |
| **gate** independent adversarial review | reviews each slice at its exact SHA; does NOT implement; no auto-merge | opus | per-slice | active per-lane |

## §3 Verification contract (every slice)
- **Real-DB goldens, mutation-proven** — each guard has a "mutation lands → red → revert → green" loop; the mutation must first prove it landed.
- **Constructed races, not arguments** — TOCTOU / fence / anchor-boundary goldens build a real concurrent window (raw client + `pg_blocking_pids`), never a sequential story.
- **P2-C test safety** — goldens insert explicit synthetic seq values into isolated fixture rows and clean only their own objects; they **never** `setval('meta_record_chain_seq', …)` (poisons the shared bundle / exhausts the sequence).
- **Fresh-DB full migrate** — every migration proven up/down/replay on a fresh PG.
- **Flag-off parity** — with the strict flag off, behavior is byte-identical to landed #4269.
- **Independent adversarial gate** at the exact SHA before any slice is considered done; the earlier L3 (#4309) MERGE_CLEAN gate was **falsified** by owner re-review (it missed the reconstruction path + terminal-only C3) — the rebuild closes those, and gates now explicitly cover **every downstream consumer** (precheck, reconstruction, execute), not just the guard.
- **No enablement** — CI green + flags-off + host-untouched; strict/Revert/Reset/staging/prod remain separate owner/ops decisions.

## §4 Exit conditions (owner month plan)
- **Wk1 (7/15–7/21):** ledger convergence ✅ (this session); ratify #4331 ✅ (owner); L3 rebuild — fresh migrate up/down/replay, real-DB goldens executing, independent gate **0 P1/P2**.
- **Wk2 (7/22–7/28):** L4 fence + in-fence recompute; L5 checkpoint/floor/retention/`system_kind` — per-writer-family production-wiring mutation tests, constructed TOCTOU reds, atomic checkpoint cutover.
- **Wk3 (7/29–8/04):** L6 sealed endpoint + exact anchor + signed identity + FE picker; L7 target-generation + deleted/trash — no wall-clock T authority; 2^53/int8 boundary tests pass.
- **Wk4 (8/05–8/14):** L8 Revert single outer txn (all-or-nothing) + Reset alignment; full regression; #4273 ≥3× 5k benchmark on the corrected trunk; staging dark acceptance + browser acceptance; final MD → an **independent staging-enablement decision package** (flags still OFF).

## §5 Current status (this session)
- **✅ Ledger convergence** — #4262/#4319/#4288 closed → #4328 + #4331 canonical.
- **✅ #4329** (window-runner compose-validation cwd fix) merged (`75568af4a`); containment PASS (owner).
- **🔨 L3 rebuild** — building against v3.7 §9.3/§9.7 (exact bigint, target-generation, deleted-chain, dup/illegal-seq fail-close, P2-C-safe goldens). Draft PR + independent gate to follow.
- **⏸ L4/L5/L6/L7/L8** — sequenced; not started; all default-off.
- **Nothing enabled, armed, or host-touched.** This MD updates as each slice lands with its gate verdict.
