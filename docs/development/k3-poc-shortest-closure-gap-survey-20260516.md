# K3 PoC Shortest-Closure Gap Survey 2026-05-16

Read-only survey. No code, no implementation branch, no lock-sensitive path touched. Produced to decide the next development direction after approval Phase 1 was deliberately closed at PR1-3 ([[project_approval_phase1_closed_at_pr3]]).

Method: read-only research agent over roadmap / GATE execution package / Stage-1 closeout / runbook / signoff / delivery-readiness / issue docs + open GitHub issues + `origin/main` log. Sources cited inline.

## TL;DR (the one fact that matters)

**The K3 PoC gate is blocked on a customer input, not on engineering.** The live-gate sequence step C2 returns `exit 2 / GATE_BLOCKED` *by design* until the customer returns filled GATE answers (A.1–A.6: tenant/workspace, K3 version/URL/acctId/credentials, PLM source, field mappings, optional SQL Server, rollback owner). C2→C10 are all transitively gated on that single input. **There is no repo-side engineering task that closes the gate.** The shortest closure path is a business/customer action (chase the GATE answers + schedule the on-site run), not a code slice.

## 1. Gate Criteria

Authoritative gate = the 11-step Stage C sequence in `docs/operations/integration-k3wise-live-gate-execution-package.md`:

> C0 mock chain → C0.5 package verify → C1 mock preflight → **C2 live preflight → C3 packet build → C4 testConnection → C5 dry-run → C6 Material Save-only → C7 optional BOM → C8 dead-letter replay → C9 rollback rehearsal → C10 evidence compiler `decision=PASS` → C11 delivery-readiness `CUSTOMER_TRIAL_SIGNED_OFF`**

Condensed acceptance (from `docs/development/integration-k3wise-stage1-closeout-20260509.md`) — Stage 1 fully closes when, against a **real customer K3**:
- `signoff.internalTrial = pass` (already true)
- live PoC preflight packet builds without `normalizeGate` throw against real GATE answers
- evidence compiler `decision=PASS / issues=[]`, ≥1 Material Save-only (+≥1 BOM Save-only if in scope)
- `rollback.owner` exercised on test rows
- pre-share self-check `0/0/0/0`

Caveat: `docs/development/integration-erp-platform-roadmap-20260425.md` is marked **"讨论稿，未列入交付"** — the 4-stage roadmap is aspirational; operational gate truth is the execution package + closeout, which only say "阶段一 = K3 真客户测试账套 Live PoC PASS".

## 2. Already Covered (merged / green)

- **C0 / C0.5 / C1 + internal-trial signoff green on machine 142**: on-prem preflight `decision=PASS 5/3skip/0fail`, migrations `applied=159 pending=0`, internal-trial postdeploy smoke `signoff.internalTrial=pass 10/0` (closeout "Verified deployment-side state").
- **Staging-source data path** (issue1542 chain): `metasheet:staging`-as-source + pipeline save merged (#1561/#1563/#1566/#1572); #1542 P0 (#1590 required-field create feedback) + P2 (#1595 project-ID UX) fixed; 142 retest `17 pass / 0 fail`, 5 staging objects installed, draft pipeline saved (`docs/development/data-factory-issue1542-postdeploy-signoff-development-20260515.md`).
- **Delivery-readiness compiler** wired with package-verify gate: states `INTERNAL_READY_WAITING_CUSTOMER_GATE → CUSTOMER_TRIAL_READY → CUSTOMER_TRIAL_SIGNED_OFF`.
- GATE intake template + on-site/live evidence templates + machine-readable signoff gate shipped.
- Approval Phase 1 PR1-3 + DB verification (this conversation) — kernel-polish permitted under the lock, **not a K3 gate requirement**.

## 3. Blocking Gaps

**One dominant blocker, non-engineering:** customer GATE answers (A.1–A.6) have not arrived. Per Stage-1 closeout ("Customer GATE answers have not arrived") and the execution package C2 row, `--live` preflight is `GATE_BLOCKED` by design until the customer supplies the inputs. C4–C9 additionally need a reachable + authenticated real customer K3. **No engineering substitute exists.**

No other hard repo-side blocker is documented as open. The only un-merged enabling work (branch-local `--issue1542-workbench-smoke` regression checks, 20 tests PASS) is a regression-hardening of a check, not a gate step — not gate-critical.

## 4. Shortest Closure Path (honest reading)

The shortest path is **not a development slice**:

1. **Customer returns filled `gate-intake-template.json`** (A.1–A.6). Pure business/customer action; nothing repo-side changes this state.
2. **On-site execution C2→C10** against the real customer K3 (reachable + authenticated) → produces the evidence the compiler needs.
3. **C11 delivery-readiness compiler with the live-evidence report** → `CUSTOMER_TRIAL_SIGNED_OFF` = Stage 1 closes (and the stage-1 lock lifts).

Implication: there is **no productive K3-PoC engineering task to pivot to right now**. Engineering is either done (Section 2) or waits on customer input (Section 3). The realistic non-engineering next move is to chase the customer for the GATE answers and schedule the on-site run.

The only repo-side item still listed as actionable is the **Chinese field-semantics explainer** (Stage-1 closeout "Optional pre-GATE work" + execution package Stage D gap #3) — and both docs explicitly defer it ("best deferred until there is real friction to capture"). Low value now; not recommended as busywork.

## 5. Do-Not-Cross Lines

Per [[project_k3_poc_stage1_lock]] (still in force — gate NOT passed):
- ❌ `plugins/plugin-integration-core/*` — blocked; K3 PoC path must stay stable.
- ❌ `lib/adapters/k3-wise-*.cjs` / K3 customer-PoC scripts — blocked unless the change IS the PoC path (and there is no such change needed — Section 4).
- ❌ New product fronts / platform-ization (阶段二/三/四 items) — blocked until GATE PASS.
- ✅ Permitted: kernel polish on shipped features, ops hygiene, read-only investigation. But per [[project_k3_poc_stage1_lock]] "permitted ≠ priority"; the #1 named risk is over-engineering the kernel before the PoC passes.
- Any new work direction is a separate explicit opt-in ([[feedback_staged_optin_lineage]]).
- Reminder ([[project_staging_migration_alignment]]): if a deploy is needed to support an on-site run, staging postgres trails the prod-track migration set — alignment required before any post-2026-04-09 image lands on staging.

## 6. PR4 Decision

**add-sign-mvp stays DEFERRED.** This survey *confirms* the 2026-05-15 checkpoint decision ([[project_approval_phase1_closed_at_pr3]]): not only is the stage-1 lock active, but the gate blocker is a customer input with **no engineering closure path** — so "finish Phase 1 with PR4" would be exactly the over-engineering the lock warns against, with zero gate impact. PR4 re-entry condition is unchanged: (a) a concrete K3 requirement names countersign/加签 as a gate blocker (this survey finds none — gate criteria are data-path/evidence, not approval-countersign), OR (b) customer GATE PASS lifts the lock. Plan frozen, low re-entry cost (worksplit §5 PR4 + Day-0-ADR-first).

## What this means for "next development"

There is no K3-PoC development slice to start. The honest options are:
1. **No-op on K3 engineering** — wait on the customer GATE answers (the true critical path). Track, don't code.
2. Permitted **kernel-polish / ops-hygiene** unrelated to K3 (e.g. the active attendance↔multitable report boundary work already on origin/main, [[project_attendance_multitable_report_boundary]]) — but consciously, not as K3-gate progress.
3. The deferred field-semantics explainer — explicitly low-value/deferred; only if real friction appears.

Recommendation deferred to the user: the survey's job is to surface that the K3 gate is customer-blocked, not to pick the fill-in work.

---

Survey end. Sources: `docs/operations/integration-k3wise-live-gate-execution-package.md`, `docs/development/integration-k3wise-stage1-closeout-20260509.md`, `docs/development/integration-erp-platform-roadmap-20260425.md`, `docs/development/data-factory-issue1542-postdeploy-signoff-development-20260515.md`, `docs/development/data-factory-delivery-readiness-evidence-gates-development-20260515.md`, issues #1526 / #1542 / #1590 / #1595, PR #1593.
