# W0 trusted-substrate integration — live status + rules (2026-07-16)

**Purpose:** the repo-resident plan source the owner asked for (not an out-of-repo artifact). Authoritative
integration ORDER, dependencies, and take-over discipline live in the v3.7 design lock **§11**
(`multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md`). This file is the LIVE status snapshot; the lock
§11 is the durable contract.

## Integration order (authority = v3.7 lock §11, supersedes §7/§10)

- **Phase A — trusted-substrate DAG → `main`:** **L3 → L4 → L4cov → L5 → L6-a**. Each rung: rebase on then-current
  `main` → full required CI → exact-head independent gate → merge. **L6-a is a COMBINED rung** (ledger +
  endpoint-immutability + batch/operation decouple in one gated PR); **as landed, the combined rung is #4409
  `2f456571e`** (which also carries the H1/H2/H3 owner hardenings — see Live status below).
- **Phase B — recovery layers (only after the Phase A DAG is fully on `main`):** merge order **L5-wire → L6-b → L7 → L8**,
  with **L8 based on BOTH L6-b AND L7**. Drafting may be parallel; each MERGE is serial + exact-head gated. Flags OFF.
- **Phase C — enablement:** owner/ops-only (strict/Revert/Reset enablement, staging cutover, #4273 re-measure). Not
  autonomous. All flags stay default-OFF throughout A + B.

## Live status (final, 2026-07-17 — Phase A COMPLETE on `main`)

| Rung | PR | State | Gate |
|---|---|---|---|
| L3 chain-integrity | #4339 | ✅ MERGED `cc35b2599` | independent gate CLEAR (landed) |
| L4 all-writer fence | #4346 | ✅ MERGED `502b1df1c` | landed; default-OFF |
| L4cov writer-coverage | #4362 | ✅ MERGED `f2020509a` | independent gate CLEAR (P1 forward-field-delete hole found+fixed; B6/B7 mutation-proven) |
| L5 trust-checkpoint | #4347 | ✅ MERGED `5b0ccf791` | independent re-gate CLEAR |
| **L6-a** sealed operation-endpoint ledger + owner hardening | **#4409** | ✅ **MERGED `2f456571e`** (2026-07-17) | required CI green + independent four-lens gate CLEAR (owner-reviewed) |
| — draft stack: ledger / immutability / decouple | #4368 / #4380 / #4385 | ❌ CLOSED, superseded by #4409 | — |
| — alternative combined branch | #4412 | ❌ CLOSED, superseded by #4409 (owner NO-GO; see below) | (historical: CLEAR-WITH-NITS on its own head `713f71f60`) |

**The Phase-A trusted-substrate DAG — `L3 → L4 → L4cov → L5 → L6-a` — is fully on `main`.** All flags default-OFF.

### L6-a as landed = #4409 (`2f456571e`), NOT the draft stack

#4409 carries everything the draft stack (#4368 + #4380 + #4385) and the alternative combined branch #4412 contained —
sealed operation-endpoint ledger + mint protocol, batch/operation runtime decouple (§10), endpoint UPDATE-immutability,
and all writer wiring — **plus three owner hardenings the superseded branches lacked** (verified on `main`, migration
`zzzz20260715210000_create_meta_record_history_operations.ts`):

- **H1 — ordinary endpoint DELETE is fail-closed:** `trg_mrho_reject_delete` (BEFORE DELETE) RAISES unless the
  transaction-local GUC `metasheet.mrho_retention` is `'on'` (`current_setting(..., true)` is missing-OK, so an ad-hoc
  DELETE always raises). Migration :220–237. (#4412 left DELETE to future retention.)
- **H2 — whole-operation atomic retention:** the only sanctioned bypass of H1 is the SQL function
  `meta_record_history_operations_prune(sheet_id, operation_id)` (migration :246–260), which deletes both event tables'
  rows AND the endpoint row for exactly one operation in one transaction under the GUC. The two torn-prune directions
  have **different protection mechanisms**: *endpoint-gone-but-events-remain* is DB-enforced — the DEFERRABLE FKs
  (`fk_mrr_operation`/`fk_mrvm_operation`, :104–122) RAISE at COMMIT when surviving events reference a vanished
  endpoint; *events-gone-but-endpoint-remains* (an orphan endpoint) is **NOT rejected by any FK** — that direction is
  protected only by the prune function's own implementation (all three DELETEs in one call) plus its golden coverage.
- **H3 — flag-ON with incomplete schema fails closed:** `mintOperation` (`operation-ledger.ts` ~:150) THROWS
  `OperationLedgerSchemaError` when the writer-fence flag is ON but `operation_id` is absent from the schema — the
  writer transaction ROLLS BACK instead of degrading to an inert ledger (which is what #4412 did).

**Owner NO-GO on #4412 (2026-07-16/17), recorded:** #4409 merged to `main` first and is strictly more complete;
rebasing + merging #4412 would have regressed H1/H2/H3 and duplicated the operation-ledger migration (#4412's `190000`
vs #4409's `210000`). #4412's green required checks bound only its old head `713f71f60` and were not merge evidence
after it went conflicting. Decision: close #4412/#4368/#4380/#4385 as superseded — the runtime Phase A was completed
by #4409; what remained was this governance-record close-out, not another L6-a merge.

**Exposure phrasing (corrected):** with #4409 on `main`, the L6-a mint/seal writer wiring **is present in production
code paths** — "zero production exposure" is not accurate. The accurate statement: every mint/seal call is a no-op
while the mint/fence flag stays default-OFF (*gated* exposure), and if the flag is turned ON against an incomplete
schema, H3 fails the writer transaction closed (rollback) rather than silently degrading.

### Historical gate record — superseded branch #4412 (audit trail only)

Before #4409's supersession was identified, #4412 (`713f71f60`, a `rebase --onto` fold of #4368+#4380+#4385 onto
then-main `0105994a8`) passed a full gate on its own head: construction-integrity + no-silent-revert verification,
tsc 0 errors, isolation golden 18/18, full 217-spec 20.x CI bundle green (217/217 files, 1995 tests), dual runtime
mutation (re-couple → G-MULTIOP red; disable UPDATE-trigger → §F2 red), and an independent opus adversarial gate
CLEAR-WITH-NITS (0 P1/0 P2). That verdict was head-scoped to `713f71f60` and is recorded here for audit only — it does
not transfer to #4409, which passed its own required CI + independent four-lens gate.

**Gate P3 findings — carried forward and RE-CHECKED against #4409 on `main` (still applicable) → L6-b pre-arm conditions:**
- **P3-1** — plugin `records.ts` / form-submit / attachment-strip / lock-unlock marker mint surfaces have **no
  production-path golden** (the #4409 golden — 21 tests — adds H1/H2/H3 coverage but still drives only
  record-service/record-write-service). Inert + fail-closed today (NULL operation_id → untrusted, never silent trust).
  **L6-b MUST add plugin-path + marker-path goldens before `MULTITABLE_ENABLE_WRITER_FENCE` (or any mint-consuming
  flag) is ever armed.**
- **P3-2** — `recordRecordRevisionsBatch` decouple (site 2) is forward-wired but unexercised (its only caller, the
  field-undelete rehydration at `univer-meta.ts` :6561, passes no ledger); only site 1 is load-bearing/tested today.

**Retention pre-condition from #4409's own gate (separate track — NOT an L6-b item; gates the FIRST production
retention caller instead):**
- **P3-R** — the prune function's trailing `set_config('metasheet.mrho_retention', 'off', true)` reset is
  **load-bearing inside the caller's transaction**: without it, the txn-local GUC stays `'on'` for the remainder of
  that transaction and H1 is bypassed for any subsequent ad-hoc endpoint DELETE in the same txn.
  **STATUS: the golden EXISTS — #4438 `3a5596bfd` G2** (`multitable-l4cov-services-fence-realdb.test.ts`): one
  explicit caller transaction — `…_prune(op0)` succeeds, `current_setting` reads back non-`'on'` inside the SAME
  txn, and an ad-hoc DELETE of another endpoint later in that transaction still RAISES. Mutation-proven
  (`CREATE OR REPLACE` of the fn WITHOUT the trailing reset ⇒ exactly G2 red; restore ⇒ green) and owner-APPROVED
  (2026-07-17 review). Note G2 (same-transaction) is the load-bearing test — its sibling G1 (same-connection,
  separate statement) stays green even without the reset. The pre-condition is satisfied once #4438 merges;
  the first production retention caller remains gated on that merge.

**Guardrails currently intact:** the full Phase-A DAG is on `main`; #4368/#4380/#4385/#4412 CLOSED as superseded;
nothing self-ratified or self-merged; all recovery/mint flags default-OFF.

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

Execution-ready lane briefs (scope, files, goldens per lock §6, deps) are prepared; Phase B does NOT auto-start.
The Phase A DAG is now fully on `main`; per the owner's supersession ruling, Phase B **begins from L5-wire only after
this corrected status record is merged and the owner confirms** — merge order stays serial **L5-wire → L6-b → L7 → L8**
(L8 based on both L6-b and L7), each on then-current `main` with full CI + an exact-head independent gate, flags OFF.

**L6-b entry conditions carried from the L6-a gate:** L6-b MUST close gate findings **P3-1** (plugin/form-submit/
attachment/marker mint-surface goldens) and **P3-2** (`recordRecordRevisionsBatch` site-2 coverage) before any
mint-consuming flag is armed — the resolver that L6-b introduces is the first consumer of `operation_id`, so those
surfaces stop being inert exactly when L6-b lands.
