# Attendance Issue #4556 W8 Verification and Closeout Plan (DRAFT)

> Status: **PROPOSED / Draft / runtime HOLD**
>
> Date: 2026-08-07
>
> Pinned baseline: `origin/main@4e6a35d99ea64291dd0588bbf5daa74dccec385b`
>
> Scope: issue #4556, W8 only (parent lock §9.9 全链验证与收口 — the
> verification plan whose passage is a **precondition input** to the owner's
> final ruling on issue #4556).
>
> Authorization: on 2026-08-07 the owner authorized **W7/W8 design-lock DRAFT
> preparation only** (docs-only). This document authorizes **no** runtime, no
> staging, no soak, no flag change, no deployment, no production/customer data
> use — and, above all, **no closure of issue #4556**.
>
> **Closure is an owner ruling, never automatic.** The owner-ratified W4 lock
> §14 item 10 states: "Production enablement and issue closure require
> separate final decisions after verification MD is on main"
> (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:3103-3104`).
> Nothing in this plan — no green matrix, no completed soak, no empty ledger —
> closes the issue or triggers closure. W8's entire output is *evidence for*
> that ruling.
>
> Sequencing: W8 executes only after W7 completes its own gates, which in turn
> requires W6 owner sign-off and W6 runtime (see the W7 draft lock §8). Every
> W6/W7-derived row below is marked conditional; the owner may also choose to
> run a reduced W8 against a re-scoped line — that re-scoping is itself an
> owner decision (OD-W8-2).

## 0. Purpose and authority

The owner-ratified parent lock
`attendance-shift-group-advanced-capability-design-lock-20260723.md` defines
W8 in §9.9 (lines 755-762): development and verification MD; operator
migration/rollback runbook; issue acceptance ledger; **no customer-acceptance
claim without customer evidence**.

The same lock's §10 (lines 764-777) defines the eight conditions under which
issue #4556 *can* close; the W4 lock's §15 defines W4-completeness; the W4
lock's §14 item 10 reserves the closing decision itself to the owner. This
plan turns those clauses into an executable verification matrix, a soak
entry/exit contract, a reconciliation ledger of every parked debt, and a
closure checklist — each item feeding, never replacing, the §14-10 ruling.

Completion-claim discipline applies verbatim: W8 claims stop at "code landed,
gates green, evidence recorded". Enablement, acceptance, and closure wording
belongs to the owner alone.

## 1. Verified current-state spine (what already exists at this baseline)

| Area | Current fact | Evidence |
| --- | --- | --- |
| Golden definition gates | Fingerprint-definition golden tests pin fixed input → fixed 64-hex literals (a domain-separator or canonical-JSON change goes red on a literal, not a relational, comparison); an identity golden-parity real-DB suite pins advisory-key/identity derivations; a shared golden-response util pins legacy response bytes. | `packages/core-backend/src/attendance/__tests__/w4c1-fingerprint-golden.test.ts:1-13`; `packages/core-backend/tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts`; `packages/core-backend/tests/utils/attendance-w4c2-golden-response.ts` |
| Real-DB gate corpus | The attendance real-DB integration step runs the w4c0/w4c2/w4c3a/w4c3b/w4c3c/w4c4 `.db.test.ts` corpus (40 files matching `attendance-w4c*.db.test.ts` under `packages/core-backend/tests/integration/` at this baseline), incl. rollout-control, request-snapshots, record/request operation routes, calculation detail, sweep fairness/call-through. | `packages/core-backend/tests/integration/attendance-w4c*.db.test.ts` (inventory in W7 lock §10); CI mapping per `docs/development/attendance-w4c2-qa-handoff-20260726.md` §1.2 |
| Zero-bypass hard gate | Current-tree open-debt set asserted exactly empty with a live side-door mutation leg; exact P16 allowlist. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1074, 1386`; `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` |
| QA handoff tooling | The W4C-2 QA handoff manual (gate matrix G1-G24 mapped to suites and CI steps) plus isolated-DB scripts (reset / run-suites / residue check) exist and are values-safe (localhost-forced). | `docs/development/attendance-w4c2-qa-handoff-20260726.md` (§1.2, §2.3); `scripts/attendance/w4c2-qa/qa-db-reset.sh`, `qa-run-suites.sh`, `qa-residue-check.sql` |
| Manual preview QA matrix | Issue #4629 carries the ten-case manual feedback matrix `PQA-01..PQA-10` (multi-segment authoring, overnight attribution, timezone, legacy compatibility, shadow posture, ambiguous evidence, authorization isolation, fingerprint freeze, outbox retry, scheduled identity) against a frozen candidate SHA; all ten checkboxes are unchecked and PQA-10 is marked BLOCKED there. This is the only place the token "PQA" exists — it is an issue-side case-ID prefix, **not** a repo artifact. | issue #4629 (OPEN), body read 2026-08-07 |
| Soak preconditions landed | The W4C-5 transition-safety arc is on main: hardened single transition boundary with the closed 7-pair matrix and evidence-manifest discipline (PR #4773, OD-W4C-61=(a) per module header); recovery-sweep fairness + values-free observability counters (#4770 arc, PRs #4774/#4779, incl. `last_attempt_at` durable rotation and the `neverAttemptedRunning`/`oldestRunningAttemptAgeSeconds` counters); the complete 8-cell request-snapshot precondition (#4775 arc, PR #4780, with stored-payload re-hash). | `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1-21, 85-93, 802-823, 863, 1044, 1125`; `w4c2-scheduled-run-ops-worker.ts:44, 176-182`; `zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:1-28` |
| Expected-differences roster | A closed, fail-closed-probed roster of anticipated legacy-vs-W4 divergences exists with exactly one ratified entry (`correction_applied_daily_adjusted`); the remaining-slice plan requires this roster to enter soak so known divergence is not misread as regression. | `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53, 75-83, 135`; `attendance-issue-4556-w4-remaining-slice-plan-20260726.md:117-119` |
| Dual-host read matrices | Calculation-detail is dual-hosted (admin + self; self rejects `userId` input with a typed 400); decision-trace is dual-hosted the same way. | `packages/core-backend/src/routes/attendance-admin.ts:1479, 1512-1515, 1376, 1416` |
| Closeout master plan | The attendance line's master plan already models final closure as a locked owner item (B14, "issue #4556 关闭终裁 — 锁 §14-10"). | `docs/development/attendance-line-closeout-master-plan-20260726.md:107, 134` |

Expected-but-absent, verified honestly:

- No W8 verification MD, no operator migration/rollback runbook, and no
  acceptance ledger exist yet — they are W8's deliverables, not inputs.
- No "PQA" tooling exists in the repo (see spine row above); a W8 "PQA-style
  matrix" therefore means *a manual matrix authored in the #4629 style*, and
  §3.2 defines it rather than citing a nonexistent artifact.
- The seven-day soak has **not** run: the transition boundary and its
  preconditions are landed code, but no rollout transition beyond tests has
  been executed and no soak evidence exists anywhere in the tree.

## 2. Scope and explicit non-goals

### 2.1 W8 delivers

1. the **verification matrix** executed against one named head SHA (§3);
2. the **soak entry/exit contract** and its recorded evidence (§4);
3. the **reconciliation ledger** — every parked debt of this line with an
   owner-visible disposition (§5);
4. the **closure checklist** mapping parent §10 + W4 §15 to evidence slots,
   handed to the owner for the §14-10 ruling (§6);
5. the operator migration/rollback **runbook** (parent §9.9) as a reviewed
   document.

### 2.2 OUT (unchanged by this document)

- closing issue #4556 (owner-only; see header);
- production enablement, deployment, production migration execution, UAT;
- any customer-acceptance claim without customer evidence (parent §9.9);
- any runtime change — W8 is evidence collection and documents; a defect found
  by W8 is filed and fixed in its own gated PR, never "inside W8";
- re-deciding W6/W7 semantics (their locks own them);
- FSER-4 (#4709) runtime — tracked in the ledger (§5), decided by its own
  amendment.

## 3. Verification matrix (executed on one named head SHA)

Matrix discipline, before any row: the verdict is head-scoped — every run is
recorded with the full `git rev-parse` SHA it ran on; a row is green only via
an executed run URL / local log with non-zero test counts (skip-green is a
failed gate, W4 lock §12.9); CI-step rows are reproduced with the step's exact
shell flags and file arguments.

### 3.1 Golden parity, legacy vs. new

| Leg | Predicate | Anchor |
| --- | --- | --- |
| Fingerprint definition | Fixed input → fixed 64-hex literal for every fingerprint domain (source/context/request-payload; plus the W7 v2 context domain, conditional on OD-W7-2). | `w4c1-fingerprint-golden.test.ts` pattern |
| Legacy response bytes | Orgs with no W4/W7 posture serve byte-identical responses/projections (golden literals, not relational). | `tests/utils/attendance-w4c2-golden-response.ts` |
| Legacy-vs-shadow parity | Shadow diffs over the soak window are exactly {`equal`} ∪ roster entries (§4); every off-roster diff is a filed defect. | `w4c2-shadow-expected-differences.ts:135` probe |
| Frozen evidence immutability | Post-freeze policy edits do not move stored bytes (byte-exact re-read; trigger rejection `W4C0_IMMUTABLE`). | QA handoff G4 |
| Conditional (W7) | Group-vs-legacy golden parity per the W7 lock §4.2 roster. | W7 lock, conditional on OD-W7-* |

### 3.2 PQA-style host matrix (manual, #4629 style)

A new manual matrix — authored as `PQA-W8-*` cases in the #4629 format
(frozen candidate SHA, synthetic data only, feedback template, triage rules) —
covering every host pair and posture:

| Case family | Hosts covered | Anchor |
| --- | --- | --- |
| Calculation detail | admin host + self host; same-org other-user 404-parity; cross-org; self `userId` rejection | `attendance-admin.ts:1479, 1512-1515` |
| Decision trace | admin host + self host; grounded/partial/undeterminable confidence; shadow labeling never presented as the legacy decision | `attendance-admin.ts:1376, 1416`; `AttendanceDecisionTrace.ts:344-346` |
| Group workspace (conditional on W6) | aggregate panel labels/conflicts vs. seeded configuration; gate-OFF byte-identical | W6 lock §5 |
| Rollout/ops surfaces | sweep counters read values-free; transition tool plan-mode zero-DML | `w4c2-scheduled-run-ops-worker.ts:176-182`; W4C-5 amendment §5 |
| Legacy compatibility | non-postured org keeps existing shapes and writes zero W4 rows | #4629 PQA-04 pattern |

The unchecked #4629 matrix itself is a ledger item (§5), not silently
superseded: OD-W8-4 decides whether it is completed against a current head or
formally retired in favor of `PQA-W8-*`.

### 3.3 Real-DB and CI gates

| Leg | Predicate |
| --- | --- |
| Full attendance real-DB corpus green on the named head, on a **fresh** database (shared-DB residue is a known false-red source). |
| Zero-bypass collector: `unclaimed=0` on the named head, with the side-door mutation leg red-capable (run the mutation, verify red, restore from file backup — never via `git checkout -- <file>`). |
| Fresh-migration + upgrade + replay pass (W4 lock §11); pending migrations zero against the deploy image. |
| CI wiring contract green (`attendance-w4c2-ci-wiring.test.mjs` pattern extended to every W6/W7 suite added since — run-list + path-filter wiring is itself asserted, not assumed). |
| Mutation ledger: every red line of the W6/W7 locks has its named mutation leg re-run on the named head; each leg's anchor-hit is verified (mutation actually landed in executed code) before its red is counted. |

## 4. Soak entry and exit criteria

Single source for W7/W8; the W7 lock §4.3 defers here. All numbers below are
the ratified W4C-5 contract restated — this plan adds no new authority and
relaxes nothing.

**Entry (all required, per W4 lock §12.8 + transition-safety amendment §3-§4):**

1. separate owner authorization for the staging org (W4 lock §14 item 9);
2. exact deployed image SHA recorded; pending migrations zero; service health;
3. named synthetic org only — no wildcard, no customer data, no external
   notifications (`customerData=false` in the evidence manifest);
4. every entrypoint represented (live punch, scheduled, all three import
   transports, approval/correction/outdoor/cancellation, manual, recompute
   both policies);
5. the database-backed predicate set returns all-clear **inside the
   transition transaction** (no read-only preflight reuse): 8-cell request
   snapshot report zero (`readAttendanceRequestSnapshotDefectReportV1`),
   zero unresolved `legacy_time_ingress_not_authoritative` reviews, legacy
   batch closure/preimage complete, retryable-job posture matrix clean;
6. the expected-differences roster (§3.1) is finalized and carried in;
7. sweep observability counters healthy at entry (backlog draining,
   `neverAttemptedRunning` at floor).

**Exit (all required):**

1. ≥ 7 calendar days in the target posture;
2. zero critical diffs (work-date/context/input/review classes) and zero
   unresolved reviews over the whole window;
3. reversal drill and suspend/resume drill executed: suspend preserves
   owner/pointer with zero synchronous source/result writes; offline replay
   clean; resume returns to authoritative; first changed punch supersedes the
   preserved pointer;
4. valid pointers and unchanged historical hashes across the window;
5. PASS marker recorded and residue zero (`qa-residue-check.sql` style sweep);
6. off-roster diffs each dispositioned (defect filed or roster amended by its
   own reviewed change) — an undispositioned diff fails exit.

Conditional: if the owner adopts W7, the same contract runs a second time for
the W7 cutover posture (the W7 lock's OD-W7-8/soak markers); OD-W8-2 decides
whether the two soaks may overlap on the calendar.

## 5. Reconciliation ledger (parked debts — every one, with disposition slots)

Each row: what, where tracked, and what W8 requires. "Owner-accepted
residual" is a disposition **only the owner can stamp**; this plan cannot
pre-accept anything.

| # | Debt | Tracked at | Verified state at baseline | W8 requirement |
| --- | --- | --- | --- | --- |
| L1 | FSER-4 §3-§4 frontend (member-safe `/me` projection + surface wiring): amendment is PROPOSED / runtime HOLD; employee-schedule/trace/report surface wiring unimplemented. | issue #4709; `attendance-4709-fser4-member-projection-contract-amendment-20260804.md:136-183` | No `/me` route in tree; amendment §6 owner decision OPEN | Owner decision recorded: in-scope-for-#4556-closure or explicitly tracked outside #4556 (recommended: outside — it is #4709's issue; see OD-W8-5) |
| L2 | Real-server integration teardown flake: 57P01 race in attendance-w4c2 `afterAll` reds the required "test" check. | issue #4791 (OPEN) | Not addressed in tree | A fix in its own PR, or owner-accepted residual with a rerun protocol named in the verification MD — a flaky required check corrupts every W8 head-scoped verdict, so recommendation is fix-before-W8 |
| L3 | Workflow residue: malformed `bpmn:timeCycle` in `startProcess` leaves ACTIVE process + OPEN incident residue (pre-existing, poller-flag-independent). | issue #4792 (OPEN) | Not addressed in tree | Not attendance-owned; W8 must verify it cannot pollute the soak org's residue-zero sweep (exclusion documented), else fix-first |
| L4 | Windows-side / manual preview QA: #4629 matrix PQA-01..10 all unchecked; PQA-10 marked BLOCKED there; the QA handoff targets a superseded head SHA by its own "re-fetch latest head" rule. | issue #4629; `attendance-w4c2-qa-handoff-20260726.md` | Confirmed unchecked 2026-08-07 | OD-W8-4: complete against current head, or formally retire in favor of the §3.2 `PQA-W8-*` matrix; silence is not a disposition |
| L5 | Soak itself: zero rollout transitions executed outside tests; no soak evidence exists. | W4 lock §12.8; §4 above | Confirmed absent | §4 executed in full, evidence in the verification MD |
| L6 | W6/W7 conditional debts: whatever OD-W6-*/OD-W7-* choices leave deliberately out (e.g. employee self-projection of the aggregate, OD-W6-5; per-group punch enforcement, OD-4556-9). | respective locks | OPEN by construction | Listed in the ledger with their owning lock — not silently absorbed into #4556 |
| L7 | Wave-5 explanation-surface posture-ceiling revision once W4 evidence is authoritative anywhere (named cross-lane follow-up; must not be done unilaterally by this lane). | W4 lock §10.3 (`:2386-2403`) | Not started | Ledger row naming the owning lane; not a #4556 closure blocker unless the owner rules otherwise |

Any debt discovered between this baseline and W8 execution joins the ledger;
an empty-looking ledger at W8 time triggers a re-scan against the then-current
main, not a celebration (empty-read ≠ absence).

## 6. Closure checklist feeding the owner's §14-10 ruling

The checklist maps the parent lock's §10 closure definition (lines 764-777),
item by item, to evidence slots. W8 fills slots; **the owner rules**.

| §10 item | Evidence slot (filled by) |
| --- | --- |
| 1. Every acceptance item mapped to a merged slice or explicitly removed by an owner decision | Acceptance ledger (§2.1.4) with per-item PR/decision references |
| 2. Multi-segment actual minutes exclude breaks; segment anomalies exposed | W4C-1 calculator gates + §3.1 goldens |
| 3. Flex distinct from grace | W5 verification (`w5-flex-policy` suites) + §3.2 cases |
| 4. Calculation-group changes effective-dated and historically explainable | W1 membership gates + (conditional) W7 provenance legs |
| 5. All work-date entry points use the shared resolver | Resolver call-through inventory (W2 line) re-verified on the W8 head |
| 6. OpenAPI, runtime, frontend, migrations, tests agree | OpenAPI lint/build/diff + contract-equality mechanical tests |
| 7. Staging migration, rollback, synthetic accounting evidence durable | §4 soak evidence + drills |
| 8. Group workflow shows effective / inherited / preview-only / conflicting | Conditional on W6 runtime (§3.2 group-workspace family) |

Plus the W4 lock §15 completion definition, re-verified as a block, and the
honest-residuals section (misclassified gaps are not "ceilings"; every
residual names its responsibility split).

Final line of the checklist, verbatim in the future verification MD: "This
document records evidence. It does not close issue #4556. Closure is the
owner's separate final decision under W4 lock §14 item 10."

## 7. Non-negotiable red lines

| ID | Rule | MECHANICAL check |
| --- | --- | --- |
| W8-R1 | No automation closes issue #4556: no PR body, commit message, or doc merged by this line may carry a GitHub closing keyword targeting #4556 (or any issue) unintentionally. | Pre-merge sweep on every W8-line PR: `grep -inE '\b(close[sd]?|fix(e[sd])?|resolv(e[sd])?)\b[[:space:]]*:?[[:space:]]*#[0-9]+'` over body + changed docs returns only intended, reviewed hits — for this line, zero. Issue #4556 state re-checked OPEN after every merge. |
| W8-R2 | Completion-claim ceiling: W8 wording stops at "landed / gates green / evidence recorded"; no "accepted", "production-ready", "acceptance passed" absent owner/customer evidence. | Mechanical absolute-claim sweep before delivery: grep the MD set for the banned-claim list (maintained in the MD itself); each hit either quoted-with-evidence or removed; the sweep command + output pasted into the verification MD. |
| W8-R3 | Head-scoped verdicts only: every matrix row records the full 40-hex SHA it ran on; no row inherits green from an older head. | Verification MD table has a SHA column; `git rev-parse` output pasted verbatim; a checker greps for any abbreviated (<40 hex) SHA in evidence rows — zero allowed. |
| W8-R4 | Executed-run evidence only: a row is green via run URL / log with non-zero counts; skip/absent runs are red. | For each CI-mapped row, the workflow run ID + step name + test count is recorded; a `0 passed` or skipped step in evidence fails the row by definition. |
| W8-R5 | Values-free evidence surfaces: soak/matrix evidence carries counts, closed codes, hashes, dates — never member lists, punch values, or secrets. | Exact-key review of every evidence artifact checked into docs; a leak probe (fixture with `userId`/`memberIds` keys) fails the artifact linter/review checklist. |
| W8-R6 | W8 adds zero runtime: the W8 deliverable PRs touch `docs/` (and, if the owner authorizes tooling, explicitly inventoried scripts) only. | `git diff <base> HEAD -- packages plugins apps .github` empty for each W8 docs PR; any tooling PR carries its own inventory + deletion-green proof. |
| W8-R7 | Ledger completeness is re-derived, not remembered: the §5 ledger is regenerated against the then-current main before execution. | The regeneration commands (issue queries + doc/grep sweeps) are recorded in the MD with their outputs; a spot-check that a known-open item (e.g. #4791 if still open) appears in the regenerated ledger. |

## 8. Decision points (owner menu, all OPEN)

| ID | Question | Options (recommended first) and consequences |
| --- | --- | --- |
| OD-W8-1 | Adopt this plan as the W8 contract | **(a)** Adopt (amendable by its own process). (b) Re-scope W8 — any narrowing of parent §10 coverage is an owner-level contract change, recorded per-item, never a silent drop. |
| OD-W8-2 | Soak topology | **(a)** Two sequential soaks if W7 lands (W4-authoritative soak, then W7-cutover soak), calendar-parallel work allowed on other lanes. (b) One combined soak — shorter calendar, but a critical diff becomes ambiguous between the segment engine and the policy source; only acceptable if the owner rules the attribution ambiguity tolerable. |
| OD-W8-3 | Disposition of #4791 (teardown flake on a required check) | **(a)** Fix before W8 execution — a flaky required check undermines every head-scoped verdict. (b) Owner-accepted residual with a named rerun protocol — records that some W8 verdicts may rest on reruns. |
| OD-W8-4 | Disposition of the #4629 manual matrix | **(a)** Author `PQA-W8-*` against the W8 head and formally retire #4629's checklist by owner note on that issue. (b) Complete #4629 as-is first — exercises a superseded head; only worth it if the owner wants the historical candidate's evidence completed. |
| OD-W8-5 | FSER-4 §3-§4 relative to #4556 closure | **(a)** Track under #4709, outside the #4556 closure set; the ledger row records the owner's explicit exclusion. (b) Pull into the #4556 closure set — couples closure to an amendment whose own owner decision is still OPEN. |
| OD-W8-6 | Customer-acceptance evidence standard (parent §9.9) | **(a)** Closure checklist item 1 may complete with synthetic-staging evidence only, and the verification MD states plainly that no customer-acceptance claim is made. (b) Require a named customer evidence artifact before the checklist is handed over — delays closure input until a customer engagement exists. |
| OD-W8-7 | Acceptance-ledger form | **(a)** One MD table in `docs/development/` (per-item: acceptance text → slice PR/owner decision → evidence link), reviewed like code. (b) Issue-comment ledger on #4556 — closer to the issue but unreviewable and mutable; rejected by default. |

## 9. Landing sequence

1. Merge this document (with the W7 draft lock, one docs-only Draft/HOLD PR)
   — merging records the plan; it authorizes nothing.
2. Owner answers OD-W8-1..7 (any time; W8 execution cannot start before W7
   completes regardless).
3. After W7's own gates: execute §3 on a named head; run §4; regenerate and
   close out §5; assemble §6 + the runbook into the verification MD; land the
   MD via its own reviewed PR.
4. Hand the checklist to the owner.
5. **Stop.** The §14-10 ruling — production enablement and issue closure —
   is the owner's separate final decision. Nothing in this plan triggers it,
   schedules it, or presumes its outcome.

## 10. Provenance

All of the following were read at
`origin/main@4e6a35d99ea64291dd0588bbf5daa74dccec385b`. Line numbers are from
that tree. (Rows shared with the W7 draft lock are re-listed so this document
stands alone.)

Code:

- `packages/core-backend/src/attendance/__tests__/w4c1-fingerprint-golden.test.ts:1-13`
- `packages/core-backend/tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts` (existence/role)
- `packages/core-backend/tests/utils/attendance-w4c2-golden-response.ts` (existence/role)
- `packages/core-backend/tests/integration/attendance-w4c*.db.test.ts` (40-file inventory, `ls | grep -c` at baseline)
- `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1074, 1386`
- `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74`
- `scripts/attendance/w4c2-qa/qa-db-reset.sh`, `qa-run-suites.sh`, `qa-residue-check.sql` (existence/role)
- `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1-21, 85-93, 802-823, 863, 1044, 1089, 1125`
- `packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts:44, 176-182`
- `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53, 75-83, 135`
- `packages/core-backend/src/attendance/w4c3b-request-snapshots.ts:430, 997, 1096, 1239, 1368`
- `packages/core-backend/src/routes/attendance-admin.ts:1376, 1416, 1479, 1512-1515`
- `packages/core-backend/src/services/AttendanceDecisionTrace.ts:344-346, 437, 589`
- `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:8-23, 252, 505, 593, 781`
- `packages/core-backend/src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:1-28`
- `packages/core-backend/src/attendance/w5-flex-policy.ts:27-47, 143, 222`

Documents:

- parent lock `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md:755-762` (§9.9), `:764-777` (§10)
- W4 lock `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:2386-2403` (§10.3 cross-lane follow-up), `:3000-3031` (§12.8), `:3090-3104` (§14; item 9 `:3102`, item 10 `:3103-3104`), `:3106+` (§15), `:3033-3037` (§12.9)
- `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` (§3 predicates, §4 manifest, §5 tooling, §6 gates)
- `docs/development/attendance-issue-4556-w4-remaining-slice-plan-20260726.md:103-125` (§5-§6; roster-into-soak `:117-119`)
- `docs/development/attendance-w4c2-qa-handoff-20260726.md` (§0-§2; G-matrix)
- `docs/development/attendance-4709-fser4-member-projection-contract-amendment-20260804.md:136-183` (§3-§4)
- `docs/development/attendance-line-closeout-master-plan-20260726.md:107, 134` (B14)
- W6 lock `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md` (status + §5)
- W7 draft lock `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md` (companion document in this PR)

GitHub state (queried 2026-08-07): issues #4556, #4629 (PQA-01..10 unchecked;
PQA-10 marked BLOCKED), #4770, #4775, #4791 (57P01 teardown flake), #4792
(timeCycle residue) all OPEN; PRs #4773, #4774, #4779, #4780 MERGED.
