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

## Live status (2026-07-16)

| Rung | PR | State | Gate |
|---|---|---|---|
| L3 chain-integrity | #4339 | ✅ MERGED `cc35b2599` | (landed with required CI green) |
| L4 all-writer fence | #4346 | ✅ MERGED `502b1df1c` | (landed; default-OFF) |
| **L4cov** writer-coverage | #4362 | 🟢 OPEN, CI CLEAN @`766ab576f`, **independent gate CLEAR** (P1 forward-field-delete hole found+fixed; B6/B7 mutation-proven) — **ready to merge, HELD per owner** | CLEAR |
| L5 trust-checkpoint | #4347 | 🟡 OPEN, independent re-gate CLEAR (carries to rebased head), lands after L4cov | CLEAR |
| L6-a sealed endpoints | #4368 | 🟡 OPEN; combined rung pending (folds #4380 + #4385) | pending combined gate |
| — rider: endpoint immutability | #4380 | 🟡 OPEN, gate CLEAR; folds into L6-a | CLEAR |
| — rider: batch/operation decouple + G-MULTIOP | #4385 | 🟡 OPEN, mutation-proven; folds into L6-a | pending combined |

**Guardrails currently intact:** L3+L4 on `main`; #4362 (L4cov) is a live INDEPENDENT rung (not folded into L5);
#4380/#4385 unmerged; nothing self-ratified or enabled; all recovery flags OFF.

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
it begins only after the Phase A DAG is fully on `main` and stays within default-OFF slices.
