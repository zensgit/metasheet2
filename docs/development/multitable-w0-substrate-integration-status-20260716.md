# W0 trusted-substrate integration — live status + rules (2026-07-16)

**Purpose:** the repo-resident plan source the owner asked for (not an out-of-repo artifact). Authoritative
integration ORDER, dependencies, and take-over discipline live in the v3.7 design lock **§11**
(`multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md`). This file is the LIVE status snapshot; the lock
§11 is the durable contract.

## Integration order (authority = v3.7 lock §11, supersedes §7/§10)

- **Phase A — trusted-substrate DAG → `main`:** **L3 → L4 → L4cov → L5 → L6-a**. Each rung: rebase on then-current
  `main` → full required CI → exact-head independent gate → merge. **L6-a is a COMBINED rung** (L6-a + #4380
  endpoint-immutability + #4385 batch/operation decouple), gated once on the combined head with a fresh
  G-MULTIOP-BATCH mutation.
- **Phase B — recovery layers (only after the Phase A DAG is fully on `main`):** merge order **L5-wire → L6-b → L7 → L8**,
  with **L8 based on BOTH L6-b AND L7**. Drafting may be parallel; each MERGE is serial + exact-head gated. Flags OFF.
- **Phase C — enablement:** owner/ops-only (strict/Revert/Reset enablement, staging cutover, #4273 re-measure). Not
  autonomous. All flags stay default-OFF throughout A + B.

## Live status (2026-07-16, updated after L5 landing + L6-a combined gate)

| Rung | PR | State | Gate |
|---|---|---|---|
| L3 chain-integrity | #4339 | ✅ MERGED `cc35b2599` | independent gate CLEAR (landed) |
| L4 all-writer fence | #4346 | ✅ MERGED `502b1df1c` | landed; default-OFF |
| L4cov writer-coverage | #4362 | ✅ MERGED `f2020509a` | independent gate CLEAR (P1 forward-field-delete hole found+fixed; B6/B7 mutation-proven) |
| L5 trust-checkpoint | #4347 | ✅ MERGED `5b0ccf791` | independent re-gate CLEAR |
| **L6-a (COMBINED)** sealed endpoints + immutability + decouple | **#4412** | 🟢 OPEN Draft @`713f71f60` (base `0105994a8`), **independent opus gate CLEAR-WITH-NITS (0 P1/0 P2)** — **ready to merge, HELD for owner GO** | CLEAR-WITH-NITS |
| — component: sealed endpoint ledger | #4368 | 🟡 OPEN, superseded by #4412 (owner decides close) | folded |
| — component: endpoint immutability | #4380 | 🟡 OPEN, superseded by #4412 | folded |
| — component: batch/operation decouple + G-MULTIOP | #4385 | 🟡 OPEN, superseded by #4412 | folded |

**Phase-A DAG status:** L3 → L4 → L4cov → L5 are **all on `main`**. L6-a is the last Phase-A rung — built as the
superseding combined branch #4412, gated CLEAR-WITH-NITS, awaiting owner GO. On GO, the Phase-A trusted-substrate DAG
is fully landed (all default-OFF).

### Verification evidence — L6-a combined gate (`713f71f60`, real postgres:14)

Construction: `git rebase --onto <main 0105994a8> 779ea55a0 <#4385 tip ae5d16932>` replays **only the 5 L6-a commits**
onto current main; the L3/L4/L4cov base commits in the original stack are dropped (already landed as squashes). Source
integrity pre-verified (#4368/#4380 heads == the commits inside the #4385 stack).

| Check | Result |
|---|---|
| Construction integrity | ✅ only L6-a-owned files; no L3/L4/L4cov/L5 reintroduced; 7 non-conflict files byte-identical to original stack (1047 lines) |
| No silent revert | ✅ L4cov P1 fence intact (13/13 `fenceWriterEntry`, comment survives); L5 univer-meta wiring intact; only the 2 lock/unlock marker lines are mint-rewired; all 5 univer-meta mint sites survived auto-merge (0 missing) |
| CI run-list | ✅ both L5 trust-checkpoint spec (@444) and L6-a golden (@572) execute |
| `tsc` typecheck (core-backend) | ✅ 0 errors |
| Migrations | ✅ clean; `meta_record_history_operations` + `trg_mrho_reject_update` live |
| Golden (real DB) | ✅ 18/18 |
| Mutation A — re-couple `batch_id = operationId` (runtime) | ✅ load-bearing: `G-MULTIOP [S1]` + `W1 G-BATCH-ENDPOINT` RED; restore → green |
| Mutation B — disable `trg_mrho_reject_update` (runtime) | ✅ load-bearing: `§F2 DB-immutable` RED; re-enable → green |
| Flag default-OFF | ✅ mint INERT before any DB call (`=== 'true'`), operation_id NULL, no endpoint row |
| Independent adversarial gate (opus) | ✅ **CLEAR-WITH-NITS** — 7/7 claims upheld, 0 P1/0 P2 (report `/tmp/l6a-combined-gate-review.md`) |

**Gate P3 findings (coverage nits, NOT blocking this inert/fail-closed rung) → L6-b pre-arm conditions:**
- **P3-1** — plugin `records.ts` / form-submit / attachment-strip / lock-unlock marker mint surfaces have **no golden
  yet**. Inert + fail-closed today (NULL operation_id → untrusted, never silent trust). **L6-b MUST add plugin-path +
  marker-path goldens before `MULTITABLE_ENABLE_WRITER_FENCE` (or any mint-consuming flag) is ever armed.**
- **P3-2** — `recordRecordRevisionsBatch` decouple (site 2) is forward-wired but unexercised (its only caller,
  field-undelete rehydration, passes no ledger); only site 1 is load-bearing/tested today.

**Guardrails currently intact:** L3/L4/L4cov/L5 on `main`; L6-a = #4412 (superseding combined branch), gated, HELD for
owner GO; component PRs #4368/#4380/#4385 remain OPEN and untouched (owner decides whether to close); nothing
self-ratified or self-merged; all recovery/mint flags default-OFF.

## Take-over discipline (authority = v3.7 lock §11)

A ≥65-min branch silence triggers ONLY a read-only independent review + an alert. It does **not** transfer PR
ownership. Driving another session's PR branch needs an explicit handoff; absent that, use a **superseding branch**
that does not touch the original PR. (Correction adopted 2026-07-16 per owner: the earlier L4cov take-over edited
#4362's branch directly — going forward, superseding-branch or explicit handoff only.)

## Phase B lane assignment (by difficulty)

| Slice | Model | Rationale |
|---|---|---|
| L5-wire (checkpoint activation) | sonnet5 impl + opus gate | mechanical wiring of a ratified schema |
| **L6-b** (anchor resolver + signed identity) | **opus4.8 impl + gate** | security-critical: signed identity, token-bound anchorSeq, no-oracle refusals |
| L7 (target-generation + deleted enum) | sonnet5 impl + opus gate | correctness-critical generation logic |
| L8 (Revert outer-txn atomicity) | sonnet5 impl + opus gate (opus mutation battery) | destructive write-path atomicity + TOCTOU |
| final design+verification MD | fable5 | consolidation |

Execution-ready lane briefs (scope, files, goldens per lock §6, deps) are prepared; Phase B does NOT auto-start —
it begins only after the Phase A DAG is fully on `main` **and** the owner confirms (plan-review: do not auto-advance
Phase B).

**L6-b entry conditions carried from the L6-a gate:** L6-b MUST close gate findings **P3-1** (plugin/form-submit/
attachment/marker mint-surface goldens) and **P3-2** (`recordRecordRevisionsBatch` site-2 coverage) before any
mint-consuming flag is armed — the resolver that L6-b introduces is the first consumer of `operation_id`, so those
surfaces stop being inert exactly when L6-b lands.
