# Multitable Feishu Phase 3 — Unlock Checklist

- Date: 2026-05-15
- Author: Claude (Opus 4.7, 1M context), interactive harness; landed via docs-only PR after operator review
- Companion to: `docs/development/multitable-phase3-staging-verification-20260515.md`
- Status: **Landed.** Read-only checklist of the explicit conditions that must be met before each currently-deferred Phase 3 lane can re-enter the active queue. Does NOT propose flipping any lane.
- Intent: durable record of unlock conditions per lane; subsequent revisions land via follow-up commits once any lane unlocks.

## 1. Charter

For each deferred Phase 3 lane, this checklist records:

1. The **macro gate** (K3 PoC stage-1 lock state, or PM/SME availability) that must lift first.
2. The **lane-local blockers** (T1-T7 from the review) that must each be closed independently.
3. The **non-engineering inputs** required (config values, env names, allowlists, RBAC tier, cost ceilings, etc.).
4. The **artifact** required to flip the TODO Status line from `deferred` back to `pending`.

The checklist is **prescriptive only**. Modifying TODO Status lines requires operator authorization (per stage-1 lock).

## 2. Macro-gate: K3 PoC stage-1 lock

The lock recorded in `project_k3_poc_stage1_lock.md` and
`docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5 remains in force on `origin/main` HEAD `b49505c10` (audit captured at `4743ba44d`; re-checked `b49505c10` for Phase 3 drift — none, the new commit is Data-Factory-only).

To lift the macro gate, one of:

| # | Lift trigger | Verification artifact |
| --- | --- | --- |
| L-M-1 | Operator announces `K3 GATE PASSED` after customer-side sign-off on the K3 WISE PoC test account | The announcement message itself, plus an update commit on `project_k3_poc_stage1_lock.md` recording "Lock lifted on <date> after K3 GATE PASS." |
| L-M-2 | Operator explicitly invokes `打破阶段一约束` in conversation, confirming awareness of the sunk-cost risk per the roadmap §5 | Same — memory edit recording the explicit override and the date. |

Either trigger is sufficient on its own. Until one fires, lanes labeled `deferred pending K3 GATE PASS` cannot move regardless of T-blocker state.

## 3. T-blocker reference (from the independent review)

The review at
`docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
enumerates seven pre-launch blockers. They are reused throughout this checklist.

| ID | Blocker | Closure artifact |
| --- | --- | --- |
| T1 | AI cost ledger / per-tenant token budget / daily-weekly cap / burst rate-limit | Implementation plan + agreed default values committed under `docs/development/`. |
| T2 | Explicit boundary statement against `packages/core-backend/src/multitable/automation-service.ts` (sibling service, not method addition) | A design MD that names the sibling service and the dispatch contract. |
| T3 | Concrete SLO numbers — max wall-clock per preview call, max wall-clock per run row, cancel + streaming semantics | Numeric values committed in a design MD. |
| T4 | D2 perf-gate runs must not run on 142 during K3 PoC live window | Either a separate K3-free staging environment is available, OR the K3 GATE has passed and 142's perf-budget is no longer reserved for PoC. |
| T5 | D3 must explicitly choose snapshot vs golden-matrix semantics for sheet / view / field / record / export permission paths | A design MD that names one of the two semantics and the assertions per path. |
| T6 | Full AI provider state enumeration (`disabled`, `rate_limited`, `quota_exhausted`, `provider_error`, `unsafe_input` in addition to `blocked`) | A design MD that lists the enum and the precedence order. |
| T7 | Lane C install rollback budget — either upgraded to its own sub-lane or downgraded to "best-effort no-rollback with explicit partial-state report" | An operator decision recorded in the TODO or a design MD. |

## 4. Per-lane unlock conditions

### 4.1 Lane A1 — AI Provider Readiness Contract

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| L-M-1 or L-M-2 (macro gate) | not lifted |
| T1 closed (cost ledger shape + caps agreed) | not closed |
| T6 closed (state enum agreed) | not closed |
| Operator ratifies AI provider allowlist (e.g. `anthropic` + `openai`, or different) | not ratified |
| Operator ratifies RBAC posture for `GET /api/multitable/ai/provider/readiness` (reuse existing platform JWT middleware; do NOT invent new capability primitive) | not ratified |
| OpenAPI decision: Option A (public + parity check) vs Option B (internal + x-internal); recommendation Option B | not ratified |
| Env-var names + provider allowlist + default cap values ratified | not ratified |
| Pre-design draft exists at `/tmp/multitable-phase3-lane-a1-implementation-design-20260515.md` (revised 2026-05-15) | **draft exists, NOT ratified** — see caveat below |

**Caveat on the A1 pre-design draft:** the draft is a Claude-authored proposal sitting in `/tmp/`. It is **not** committed to `docs/development/` and has **not** been ratified by the operator. Its existence does not close T1 or T6: per the draft itself (§3, §5.2, §8), T1 stays open until A2 ships the usage-ledger writer + cap enforcement and A3 ships consumption display, and T6 stays open until A2 derives the four reserved states (`rate_limited`, `quota_exhausted`, `provider_error`, `unsafe_input`). **A1 cannot be implemented until** (a) K3 GATE PASS or explicit `打破阶段一约束`, AND (b) the operator ratifies the seven outstanding design points enumerated in the draft's §20.

Sequencing: A1 is the **first** AI lane and has no upstream lane dependency. But the macro gate plus the operator-ratification items above must all close before A1's implementation PR can start.

### 4.2 Lane A2 — AI Field Shortcut Backend

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| L-M-1 or L-M-2 | not lifted |
| T1 closed | not closed |
| T2 closed (sibling-service boundary stated) | not closed |
| T3 closed (SLO numbers committed) | not closed |
| Lane A1 merged on `main` with `AIProviderReadinessService` callable | not merged |
| Mock-or-live decision: A2 unit tests must work without a real provider, so a mock provider client interface must be declared in advance | not declared |

Sequencing: A2 depends on A1 landing first.

### 4.3 Lane A3 — AI Field Shortcut Frontend

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| L-M-1 or L-M-2 | not lifted |
| T3 closed (cancel + streaming UX semantics) | not closed |
| T6 closed (state enum) | not closed |
| Lane A2 merged on `main` with preview / run endpoints reachable | not merged |
| Lane A1 merged on `main` | not merged |

Sequencing: A3 depends on A1 and A2 landing first.

### 4.4 Lane B1 — Formula Dry-Run Diagnostics

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| L-M-1 or L-M-2 | not lifted |
| Formula engine surface frozen for the dry-run contract (no API breaking changes mid-lane) | not declared |
| Mock formula evaluator interface declared so unit tests can run without a live formula sandbox | not declared |

Sequencing: B1 is the non-AI half of Lane B and has no AI dependency. Could technically ship before A1 if the macro gate lifts, though the operator has chosen to keep it deferred for coherence with B2 (per the TODO Status quote).

### 4.5 Lane B2 — Formula AI Assist

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| L-M-1 or L-M-2 | not lifted |
| T1 closed | not closed |
| T3 closed | not closed |
| T6 closed | not closed |
| Lane A1 merged on `main` | not merged |
| Lane B1 merged on `main` | not merged |

Sequencing: B2 depends on A1 + B1.

### 4.6 Lane C1 — Template Preview & Dry-Run

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| PM / PD ownership confirmed for the five industry templates (project management, CRM follow-up, contract management, inspection feedback, recruiting pipeline) | not confirmed |
| Domain SME availability confirmed for at least three of the five templates | not confirmed |
| T7 closed (rollback budget decision) | not closed |

Sequencing: independent of K3 lock (Status quote is `pending PM / SME assignment`, NOT `pending K3 GATE PASS`). Could activate as soon as PM / SME inputs land, even before the macro gate lifts.

### 4.7 Lane C2 — Template Install & Onboarding

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| Same PM / SME conditions as C1 | not confirmed |
| T7 closed | not closed |
| Lane C1 merged on `main` (preview / dry-run usable) | not merged |
| Rollback strategy chosen (transactional wrapper vs compensating writes vs best-effort no-rollback) | not chosen |

Sequencing: C2 depends on C1.

### 4.8 Lane D2 — Large Table Performance Gate

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| T4 closed: a K3-free staging environment is available, OR the K3 GATE has passed and 142 is no longer the K3 PoC stable host | not closed |
| Perf thresholds NOT yet committed (per the TODO line `Avoid making performance thresholds strict until baseline is measured on 142`) — must remain non-strict on first activation | acknowledged |
| Lane D0 release-gate skeleton merged on `main` | merged (PR #1541) |

Sequencing: D2 can activate independently of A/B/C as long as T4 is closed. Macro gate is implicitly closed once 142 is K3-free.

### 4.9 Lane D3 — Permission Matrix Gate

| Required to flip Status `deferred → pending` | Currently |
| --- | --- |
| T5 closed (snapshot-vs-golden-matrix semantics chosen) | not closed |
| Macro gate or K3-free staging — same as D2 | not closed |
| Lane D0 release-gate skeleton merged on `main` | merged (PR #1541) |

Sequencing: D3 can activate independently of A/B/C; same macro-gate condition as D2.

## 5. Cross-lane dependency graph

```
                    L-M-1 / L-M-2 (macro gate)
                    /        |        |       \
                   /         |        |        \
                  v          v        v         v
                 A1 ----+   B1       D2        C-PM/SME
                 |      |   |        |          |
                 v      v   v        v          v
                 A2     B2  D3       (post-test C1
                 |      ^   (parallel  thresholds  |
                 v      |    to D2 once tightening v
                 A3 ----+    T5 closed)            C2
```

Notable observations:

- **Lane C is the only deferred track NOT gated by K3 lock** — operator can unblock by securing PM / SME inputs alone. If the K3 GATE answer drags, Lane C can still be unblocked if those inputs surface.
- **Lane B1 could ship as a non-AI formula-diagnostics PR before AI lanes** if the macro gate lifts — operator chose to keep it coherent with B2.
- **Lane D2 / D3 are independent of A/B/C** and could activate as soon as their respective T-blocker and macro gate close.
- **No lane outside Lane C has zero K3-gate dependency.**

## 6. Operator decision matrix

Two checkpoint questions for the operator, neither of which requires implementation:

| Question | Answer routes to |
| --- | --- |
| Q1: Is K3 GATE PASSED, OR are you explicitly breaking the lock? | A1 / A2 / A3 / B1 / B2 / D2 / D3 become eligible (each still needs T-closure). |
| Q2: Do you have PM ownership + SME availability for at least 3 of the 5 industry templates, AND a rollback strategy choice for T7? | C1 / C2 become eligible regardless of Q1. |

If both Q1 and Q2 answer NO, the only Phase 3 work eligible to ship is `pending` items already in the active queue — and that queue's implementation is merged on `main` as of `4743ba44d` (rechecked at `b49505c10` — the new commit `#1566` is Data Factory only, no Phase 3 drift). Until either Q1 or Q2 answers YES, no further Phase 3 lane can ship.

If Q1 answers YES but Q2 answers NO, the AI / Formula / Hardening (D2/D3) lanes become eligible.

If Q2 answers YES but Q1 answers NO, only Lane C becomes eligible.

## 7. What happens after this checklist is ratified

1. Codex reviews this MD plus the companion staging-verification MD.
2. Operator records the macro-gate state (Q1 + Q2 answers) inline in conversation.
3. For each lane that becomes eligible:
   - The corresponding Status line in `multitable-feishu-phase3-ai-hardening-todo-20260514.md` is updated from `deferred ...` to `pending — active queue`.
   - The relevant T-blockers for that lane are closed via design MD commits.
   - Implementation PRs follow the established stage-1 lock discipline (clean worktree, scoped diff, redaction tests, dev + verification MDs).
4. This unlock checklist may be revised once any lane unlocks; subsequent revisions extend the dependency graph in §5.

## 8. What this checklist authored under

- No file under `apps/`, `packages/`, `plugins/`, `scripts/`, `.github/workflows/`, or any migration directory was modified to author this checklist.
- The verification that informed this checklist used a detached HEAD on `origin/main`.
- No real provider credential, SMTP secret, JWT, bearer token, or DingTalk webhook value was used.
- No TODO Status line was modified by this checklist (Status flips remain the operator's call once a lane unlocks).
- No memory entry was added or modified by this checklist.
- The PR that landed this checklist is docs-only.

## 9. References

- `docs/development/multitable-phase3-staging-verification-20260515.md` (companion)
- `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
- `docs/development/multitable-phase3-active-queue-closeout-development-20260515.md`
- `project_k3_poc_stage1_lock.md` (memory)
- `docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5
- `/tmp/multitable-phase3-lane-a1-implementation-design-20260515.md` (Claude's read-only A1 design draft — **still in `/tmp/`, not committed to `docs/development/`, awaiting K3 GATE PASS or explicit lock-break before ratification**)
