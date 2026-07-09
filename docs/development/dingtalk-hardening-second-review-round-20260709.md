# DingTalk Hardening — Second Adversarial Review Round and Verification

- Date: 2026-07-09
- Scope: the second independent adversarial review of the DingTalk sync/hardening line, and the hardening that followed. Companion to `dingtalk-sync-hardening-design-and-verification-20260708.md` (Rev 2, on `main`), which recorded the first round.
- Status: **all six remaining PRs re-reviewed; five hardened and mutation-proven, one clean. Everything held unarmed — merge is the owner's decision.** No PR on this line lands without an independent adversarial verdict.

---

## 1. Why a second round

The first round found a P1 in each of the four highest-blast-radius PRs (#3905/#3904/#3910/#3884) and established the standing rule: **nothing on this line lands without an independent adversarial pass.** Six PRs had not yet had one. This round reviewed all six, fixed every finding worth fixing with the same discipline — real-DB golden + mutation proof + held unarmed — and gated the one change that touched live logic.

The recurring failure the first round named held again: the defect is rarely a mis-written guard; it is a **test shape that makes the guard impossible to falsify** — a fake client that ignores the `WHERE`, an env var that short-circuits the resolver, a mock that returns the answer, a fixture that stores plaintext so every decrypt is a no-op, a query that is never run against a real database. Four of this round's six PRs carried a finding of exactly that class. Two did not — and the contrast is the useful signal.

---

## 2. The six PRs

| PR | Ticket | Verdict | Finding | Fix + proof |
|---|---|---|---|---|
| #3896 | H02 auto-admission orphans | APPROVE-with-hardening; **real P2** | The orphan guard was real but **incomplete**: it asserted *before* the `users` INSERT only for grant-feasibility, but `applyDirectoryAccountBindInTransaction` (after the INSERT) still threw when the account had no openId **and** no unionId, or when its identity was already bound to another user — the swallowed throw committed an orphan. Proven on real PG. | Per-account **SAVEPOINT** around INSERT+bind: any bind throw rolls the `users` row back and leaves the tx usable. New real-DB test (Scenario B + identity-conflict + tx-still-usable + control); mutation removing `ROLLBACK TO` reddens the orphan assertions. |
| #3900 | H06 timeout + partial-failure | APPROVE-with-hardening; **no P1** | Runtime correct (the partial-failure guard uses a `WHERE`-less `INSERT`, so observing params *is* observing the guard — 150→250 rows RED, real-PG confirmed). **P3**: the timeout-precedence test re-implemented the merge in the test body — a tautology (flipping production's spread order left 5/5 green). | Rewrote the test to assert on the real `AbortSignal` reaching `fetch`; mutation `signal:undefined` reddens it. P2 (approval-card ledger-visibility untested) left as a recipe — testing it cleanly needs the event-driven execution-record output; the only cheaper route is a brittle SQL-mock, the anti-pattern this line avoids. |
| #3897 | H08 robot strictness | **APPROVE — no P1/P2** | Genuinely falsifiable: reverting the errcode-strictness reddens 9 tests on the real parser; reverting link-budgeting reddens 1; title-truncation reddens 2 — all on real payloads, not re-implemented copies. Delivery-index DDL real-DB-verified (up/down idempotent, additive). | None needed. Two producer-unreachable NITs. |
| #3914 | OPS-03 alerts + coverage | APPROVE-with-hardening | **P2-1**: `getDirectoryManagerBindingCoverage()` was a **dead export** — computed, surfaced nowhere; §7.4 unmet. **P2-2**: both SQL queries were mock-only — corrupting the coverage CTE *and* flipping the streak `ORDER BY` left all 13 tests green. | P2-1: added a **read-only admin GET** mirroring the existing departments route (same `ensurePlatformAdmin` gate, no new auth). P2-2: real-DB test over both queries; mutations RED (coverage 0.667→0.333; streak 3→0). Two-point wired. |
| #3902 | H04 batch bind/unbind | APPROVE-with-hardening; **no P1** | Server-side correct and real-DB-proven (per-item isolation; each item its own atomic tx → no orphan; #3896's class doesn't apply). **P2-1**: `batchBind`'s isolation guard was untested — making the loop fail-fast left 49 tests green, while the *unbind* twin was tested. **P3-2** (security-adjacent): the deprovision UI toast reports a partial unbind as full success (server now returns 200). | Added the symmetric `batchBind` isolation test; mutation M1 (fail-fast) reddens exactly it. P3-2 toast tracked with the deferred UI panel; recommended correcting the PR body's "unchanged behavior" wording. |
| #3915 | OPS-02 preview + async | CHANGES-REQUESTED → resolved | **P2**: "preview and apply cannot drift" was false — apply counted candidates only in the deepest match-cascade branch, preview counted **unconditionally** → preview over-counted (real-PG: linked account → preview 1, apply 0). The required parity test was absent. | Extracted a shared `resolveDirectoryIdentityMatch` predicate; **both** apply and preview now call it. Real-DB parity test (exact counts + per-account effect); mutations A/B RED. **Because the fix refactored the live apply cascade, it got an independent equivalence gate** — verdict below. |

---

## 3. The one gate that mattered: #3915 apply-path equivalence

Five of the six fixes were additive (a new test, a new read-only route, a rewritten test, a SAVEPOINT). #3915 was not: it **refactored the live apply cascade** in `syncDirectoryIntegration` from an inline chain into the shared predicate. "Same outcomes" from a cascade rewrite is exactly where a silent live-behavior regression — a change in *who gets an account auto-created* — hides. A mutation proving apply *calls* the predicate does not prove the predicate *replicates* the old inline logic.

So this one change got a dedicated adversarial equivalence gate, and the verdict is **ACCEPT — a provably behaviour-preserving pure extraction**:
- `git diff -w` shows the auto-admission body absent (byte-identical modulo indentation); the only non-whitespace change is the inline preamble → predicate call + dispatch, plus one now-redundant brace.
- Branch-by-branch, all six cases identical, precedence preserved: **already_linked > external_identity > email > mobile > ambiguous > none**, computed from the same inputs with the same Map references passed by reference.
- The counter drift the author fixed is entirely on the **preview** side; the apply-side increments are unchanged.
- No differential input separates old from new.

This is the model-split discipline in action: Sonnet implemented; a change to live directory-sync behaviour was not accepted on the implementer's word — it was gated by an independent adversarial pass keyed on the exact risk.

---

## 4. What was proved, and what was not

Proved, per PR, with a mutation that reddens a test exercising the real thing:
- #3896 the SAVEPOINT rolls back the orphan (real PG); #3900 the timeout signal reaches `fetch`; #3897 errcode-strictness / link-budgeting / truncation (real parser + real payload); #3914 the coverage CTE and streak query (real PG); #3902 `batchBind` per-item isolation; #3915 preview/apply parity (real PG, both sides).

Not proved / deliberately deferred, stated plainly:
- **#3900 P2** — the approval-card ledger `deliveryStuckPending` surfacing is untested at the executor level. It is observability, not correctness (the send failure is still reported; the DB helper is integration-tested). A clean test needs the event-driven execution-record output; the cheaper route is a brittle SQL-mock, which this line refuses. Left as a recipe.
- **#3902 P3-2** — the deprovision UI toast optimism (partial reported as success) belongs with the deferred admin-UI panel; the account list refreshes to the true state, so only the toast is optimistic. The PR body's "unchanged behavior" claim should be corrected.
- **#3915 residual** — two brand-new same-batch users sharing an email/mobile count 1 in apply vs 2 in preview (apply mutates its match maps mid-batch). Fail-safe: preview over-counts, never under-warns an irreversible creation. Outside the four required parity scenarios.

The systemic finding from Rev 2 §9 stands and was reinforced: a real-database golden runs in **no** CI job unless wired at two points (excluded from the no-DB job so it cannot skip-green, and added as a whole file — never a `-t` filter — to a real-DB step). Every real-DB test added this round is wired at both points; each PR comment names the step and line.

---

## 5. Model split (as requested)

Difficulty-routed, and recorded so the choices are auditable:
- **Opus (adversarial-reviewer / main loop)** — every review gate; the #3915 equivalence gate; the #3896 orphan SAVEPOINT (correctness in a hot, security-adjacent file); the #3900 timeout-test rewrite.
- **Sonnet (attendance-impl)** — the scoped, well-specified fixes with a clear template: #3915 parity (shared predicate + real-DB golden), #3914 endpoint + coverage test, #3902 isolation test, and the earlier #3884 CSV two-pass fix. Each was **gated** — either by an independent adversarial pass (#3915) or by a direct safety inspection of the diff (#3914 route auth + read-only; #3902 test-only).
- Main loop as the gatekeeper throughout: no Sonnet output landed on the branch without a verification step.

---

## 6. Landing state

Every PR on this line is now **reviewed, hardened where needed, and held unarmed**. Round one: #3905/#3904/#3910/#3884 fixed (P1s), #3904 merged. Round two: the six above. #3911 (PERF-01) carries the composed resolution rebased onto current main (the batching folded inside #3904's seam, so reverting the primary-department write stays red). The design pair for the separate provider-org-transfer line (#3941 assessment + #3944 dev plan) is parked for owner review; no implementation started.

**Nothing merges without the owner's decision.** The development — implement, prove, review, gate — is complete for this line; the landing is not delegated.
