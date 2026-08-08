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
> owner decision, **OD-W8-1(b)** (an earlier draft pointed this sentence at
> OD-W8-2, which is the separate soak-topology choice).
>
> Freshness: this document is written against the pinned baseline above but is
> re-verified at each rebase. Items that later changed state are corrected in
> place with their provenance rather than silently dropped — see OD-W8-3
> (SATISFIED), ledger rows L1, L2, L6, L8, L9, and §10.

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

Precedence: where this document and an owner-ratified lock disagree — by
omission, paraphrase, or otherwise — the ratified lock wins and this document
must be amended. This clause binds every section below, §4 in particular.

## 1. Verified current-state spine (what already exists at this baseline)

| Area | Current fact | Evidence |
| --- | --- | --- |
| Golden definition gates | Fingerprint-definition golden tests pin fixed input → fixed 64-hex literals (a domain-separator or canonical-JSON change goes red on a literal, not a relational, comparison); an identity golden-parity real-DB suite pins advisory-key/identity derivations; a shared golden-response util pins legacy response bytes. | `packages/core-backend/src/attendance/__tests__/w4c1-fingerprint-golden.test.ts:1-13`; `packages/core-backend/tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts`; `packages/core-backend/tests/utils/attendance-w4c2-golden-response.ts` |
| Real-DB gate corpus | 40 files match `attendance-w4c*.db.test.ts` under `packages/core-backend/tests/integration/` at this baseline, but the attendance real-DB integration step (`.github/workflows/plugin-tests.yml:1147`, an explicit whole-file run-list, not a glob) carries only **38 of the 40**. `attendance-w4c3b-request-snapshots.db.test.ts` and `attendance-w4c3b-central-approval.db.test.ts` are in neither the run-list nor `vitest.config.ts` `test.exclude`, so the no-DB step (`plugin-tests.yml:553`, no `DATABASE_URL`) collects them and their `describeIfDatabase` guards `describe.skip` — the two suites' DB-gated blocks execute **nowhere in CI** at this baseline (the exact skip-green shape W4 lock §12.9 calls a failed gate). The existing wiring guard cannot catch this: its `FILES` constant is a hardcoded allowlist, not a completeness assertion. The companion CI-wiring fix — **PR 4805** (OPEN, non-draft, head `2985e03c` as re-read 2026-08-08 after this rebase — an earlier round of this document cited head `40dfd4f3`, which the branch has since advanced past; the PR is still OPEN and unmerged; wires both files two-point and converts the guard from its hardcoded `FILES` list to a completeness assertion derived from the on-disk `attendance-*.db.test.ts` set, a superset of the `attendance-w4c*` corpus this row measures) — is a named precondition, not merged at this baseline; see ledger row L8 and §3.3. | `packages/core-backend/tests/integration/attendance-w4c*.db.test.ts` (inventory in §10 below); run-list `.github/workflows/plugin-tests.yml:1147`; CI mapping per `docs/development/attendance-w4c2-qa-handoff-20260726.md` §1.2 |
| Zero-bypass hard gate | Current-tree open-debt set asserted exactly empty with a live side-door mutation leg; exact P16 allowlist. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1074, 1386`; `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` |
| QA handoff tooling | The W4C-2 QA handoff manual (gate matrix G1-G24 mapped to suites and CI steps) plus isolated-DB scripts (reset / run-suites / residue check) exist and are values-safe (localhost-forced). | `docs/development/attendance-w4c2-qa-handoff-20260726.md` (§1.2, §2.3); `scripts/attendance/w4c2-qa/qa-db-reset.sh`, `qa-run-suites.sh`, `qa-residue-check.sql` |
| Manual preview QA matrix | Issue #4629 carries the ten-case manual feedback matrix `PQA-01..PQA-10` (multi-segment authoring, overnight attribution, timezone, legacy compatibility, shadow posture, ambiguous evidence, authorization isolation, fingerprint freeze, outbox retry, scheduled identity) against a frozen candidate SHA; all ten checkboxes are unchecked and PQA-10 is marked BLOCKED there. This is the only place "PQA" exists as a case-ID concept (the raw three-letter token also occurs as base64/binary noise in unrelated assets) — it is an issue-side case-ID prefix, **not** a repo artifact. | issue #4629 (OPEN), body read 2026-08-07 |
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
an executed run URL / local log with non-zero **per-file** test counts for
each named suite (a step-level total over a multi-file run-list proves nothing
about any single file — see W8-R4; skip-green is a failed gate, W4 lock
§12.9); CI-step rows are reproduced with the step's exact shell flags and file
arguments.

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

Named precondition (ledger L8): before any §3 row is executed, the two
currently-unwired w4c3b suites (`attendance-w4c3b-request-snapshots.db.test.ts`,
`attendance-w4c3b-central-approval.db.test.ts`) must be two-point wired
(run-list + no-DB exclude) and green — the companion CI-wiring fix, **PR 4805**
(OPEN, non-draft, head `2985e03c` as re-read 2026-08-08 after this rebase — an earlier round of this document cited head `40dfd4f3`, which the branch has since advanced past; the PR is still OPEN and unmerged), carries this. That PR
being merged is the precondition; this plan does not authorize its merge.

| Leg | Predicate |
| --- | --- |
| Real-DB corpus | Full attendance real-DB corpus green on the named head, on a **fresh** database (shared-DB residue is a known false-red source). "Full" is defined by the directory glob over `attendance-w4c*.db.test.ts`, not by the historical run-list — see the L8 precondition above. |
| Zero-bypass | Collector `unclaimed=0` on the named head, with the side-door mutation leg red-capable (run the mutation, verify red, restore from file backup — never via `git checkout -- <file>`). |
| Migrations | Fresh-migration + upgrade + replay pass (W4 lock §11); pending migrations zero against the deploy image. |
| CI wiring contract | Green with the guard converted to a **directory-glob completeness assertion** (an `attendance-w4c*.db.test.ts` file missing from run-list or exclude is red by construction — the hardcoded-allowlist form is the mechanism that let L8 stay invisible), extended to every W6/W7 suite added since; run-list + path-filter wiring is itself asserted, not assumed. The conversion is what **PR 4805** carries (it derives the corpus from the wider on-disk `attendance-*.db.test.ts` set); this leg is green only against a head where that conversion has landed. |
| Mutation ledger | Every red line of the W6/W7 locks has its named mutation leg re-run on the named head; each leg's anchor-hit is verified (mutation actually landed in executed code) before its red is counted. |

## 4. Soak entry and exit criteria

The W7 lock §4.3 defers here for the operational summary. **§4 is a
non-exhaustive operational summary, not a restatement**: the governing texts
are the ratified W4 lock §12.8 (`:3000-3031`, 15 gate bullets) and the W4C-5
amendment §3 (`:84-108`, database-backed predicates) + §4 (`:110-128`,
evidence-manifest fields) **verbatim, in full**. Where this summary and a
ratified lock differ — by omission, paraphrase, or otherwise — the ratified
lock wins and this plan must be amended (§0 precedence clause). The colon
lists below are pointers with examples, never enumerations; an item absent
from this summary binds exactly as if it were listed.

**Entry (all required, per W4 lock §12.8 + transition-safety amendment §3-§4):**

1. separate owner authorization for the staging org (W4 lock §14 item 9);
2. exact deployed image SHA recorded; pending migrations zero; service health;
3. named synthetic org only — no wildcard, no customer data, no external
   notifications (`customerData=false` in the evidence manifest);
4. every entrypoint represented (live punch, scheduled, all three import
   transports, approval/correction/outdoor/cancellation, manual, recompute
   both policies);
5. the database-backed predicate set — **all of W4C-5 §3, verbatim** —
   returns all-clear **inside the transition transaction** (no read-only
   preflight reuse). Examples, not an enumeration: 8-cell request snapshot
   report zero (`readAttendanceRequestSnapshotDefectReportV1`), zero
   unresolved `legacy_time_ingress_not_authoritative` reviews, legacy batch
   closure/preimage complete, retryable-job posture matrix clean. The §3
   predicates not named here — no nonterminal null-version legacy async job
   for entry into `shadow|eligible|authoritative`; no incomplete operation,
   operation batch, import batch, or source-bearing mismatch required by the
   pair; suspend has serialized every source writer; the resume proof — bind
   identically. CI-proof precondition (ledger L8): the real-DB suite proving
   the 8-cell report end-to-end
   (`attendance-w4c3b-request-snapshots.db.test.ts`) executes nowhere in CI
   at this baseline; it must be two-point wired and green on the W8 head
   before this item's report may be cited as CI-proven;
6. the expected-differences roster (§3.1) is finalized and carried in;
7. sweep observability counters healthy at entry (backlog draining,
   `neverAttemptedRunning` at floor);
8. P16 staging execution bodies and cleanup are inventoried explicitly;
   dynamic SQL or direct DML against W4-backed rows fails the tooling debt
   guard (W4 lock §12.8);
9. the zero-unresolved-review gate carries its **negative transition test**
   (W4 lock §12.8 — the test half, not only the zero count);
10. the evidence manifest carries the owner authorization reference **and**
    the authorized target state, and the every-entrypoint inventory **and**
    its observation dates (W4C-5 §4 — both halves of each field, plus every
    other §4 field verbatim);
11. standing gate, entry through exit: **no production deploy/flag action**
    (W4 lock §12.8) — restated here as a soak gate, not only as this
    document's header authorization text.

**Exit (all required):**

1. ≥ 7 calendar days in the target posture;
2. zero critical diffs (work-date/context/input/review classes) and zero
   unresolved reviews over the whole window;
3. reversal drill and suspend/resume drill executed: suspend preserves
   owner/pointer with zero synchronous source/result writes **and** an
   already-durable job remains retryable without a projection; a
   shadow/unknown accepted write posture blocks transition, and
   source-bearing mismatches require explicit incident remediation (W4 lock
   §12.8, both halves of each); offline replay clean; resume returns to
   authoritative; first changed punch supersedes the preserved pointer;
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
| L1 | FSER-4 **§3-§4 only** — the frontend surface wiring (one shared client/composable; group-drawer, employee-schedule, self-trace, admin-trace and report projections; browser evidence; OpenAPI): unimplemented. (§2, the member-safe `/me` projection, is **not** part of this debt — see the retraction opposite.) | issue #4709; `attendance-4709-fser4-member-projection-contract-amendment-20260804.md:136-183` | **RETRACTION — the previous cell was wrong when written, not merely stale.** It read "No `/me` route in tree; amendment §6 owner decision OPEN"; both halves are false, and were false at this document's own pinned baseline. (i) The member-safe route `GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me` exists at `plugins/plugin-attendance/index.cjs:44419`, landed by PR 4772 (MERGED 2026-08-05T15:54:09Z; commit `ce17ed321752d3adb96569f15a102c8986f303da`, verified an ancestor of the pinned baseline `4e6a35d9…`). (ii) `OD-4709-2` was ruled **(a)** by the owner on 2026-08-05 against the amendment's merged SHA `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, recorded verbatim in PR 4772's body and asserted in the route's own module comment (`index.cjs:44405-44416`). **A contradiction inside the repo is left standing here, not adjudicated**: the amendment MD on main still carries `Status: PROPOSED / runtime HOLD` and a §6 reading "`OD-4709-2` remains **OPEN**" — its own §7 step 2 has the owner ratify the exact merged SHA rather than re-stamp the file, so the MD was never updated and the PR body plus the module comment are the ratification record. Which of those the owner treats as authoritative is the owner's call. **What the row was right about survives**: §3-§4 are unimplemented. Verified at the rebase base, with the grep proved live rather than trusted for its emptiness: `grep -rn "fixed-schedule/effectiveness" apps/web` returns **0** hits — covering the admin aggregate route and the `/me` route alike — while the identical grep over `plugins` returns 3, so the pattern and the search path both work; `getSelfEffectiveness` likewise has zero `apps/web` hits; and `apps/web/src/composables` contains no FSER member, only `useAuth`, `useCalendarDays`, `useLocale`, `useMobileViewport`, `usePlatformApps`, `usePlugins`. (Fixed-schedule *authoring* UI does exist in `AttendanceView.vue`; it is not an effectiveness projection and is not what §3 wires.) PR 4772 itself declares §3-§4 out of its scope (amendment landing sequence step 3 vs. step 4). | **Unchanged and still OPEN.** Owner decision recorded: in-scope-for-issue-4556-closure, or explicitly tracked outside it (recommended: outside — it is issue 4709's line; see OD-W8-5). The §2 route having landed answers a different question and does **not** dispose of OD-W8-5. |
| L2 | Real-server integration teardown flake: 57P01 race in attendance-w4c2 `afterAll` reds the required "test" check. | issue 4791 — **CLOSED as COMPLETED 2026-08-07T15:44:55Z**; rollup issue 4796 closed on the same evidence 2026-08-07T15:45:30Z | **Fixed and landed** (an earlier draft of this cell read "issue #4791 (OPEN) / Not addressed in tree" — accurate at the pinned baseline, superseded here). PR 4799 merged 2026-08-07T15:18:34Z as `51c3d8720789476efa15f6b99b6dc5f51df4743b`, verified an ancestor of the rebase base: drain-then-drop in `packages/core-backend/tests/helpers/scratch-database.ts`, plus an unconditional `scratchDrain=` line at both real-server call sites. The closing criterion — that line reporting `CLEAN` on main's required gate, not merely a green run — was met at workflow run 31191954460 (`event=push`, head `51c3d872…`), required check `test (20.x)` success, both call sites `CLEAN`, and `FORCED` / `57P01` / `Unhandled Errors` all at zero. Full record and its residual: OD-W8-3 (SATISFIED). | **Row stays live; its requirement changed from decide to re-verify.** The predicate, stated without a verdict attached: on the W8 head this row is green **only** when the `scratchDrain=` line reports `CLEAN` at both real-server call sites in the required-gate log, with zero `FORCED`, zero `57P01`, and zero `Unhandled Errors`. A `FORCED` line **reds this row** and reopens the debt with a named suspect — its `holders=[…]` field identifies the component still holding a connection. Whether a reddened row is then an owner-accepted residual is an owner call at that time; per this section's preamble, this plan cannot pre-stamp that disposition, and OD-W8-3 became SATISFIED by an event rather than by anyone answering its (b). |
| L3 | Workflow residue: malformed `bpmn:timeCycle` in `startProcess` leaves ACTIVE process + OPEN incident residue (pre-existing, poller-flag-independent). | issue #4792 (OPEN) | Not addressed in tree | Not attendance-owned; W8 must verify it cannot pollute the soak org's residue-zero sweep (exclusion documented), else fix-first |
| L4 | Windows-side / manual preview QA: #4629 matrix PQA-01..10 all unchecked; PQA-10 marked BLOCKED there; the QA handoff targets a superseded head SHA by its own "re-fetch latest head" rule. | issue #4629; `attendance-w4c2-qa-handoff-20260726.md` | Confirmed unchecked 2026-08-07 | OD-W8-4: complete against current head, or formally retire in favor of the §3.2 `PQA-W8-*` matrix; silence is not a disposition |
| L5 | Soak itself: zero rollout transitions executed outside tests; no soak evidence exists. | W4 lock §12.8; §4 above | Confirmed absent | §4 executed in full, evidence in the verification MD |
| L6 | W6/W7 conditional debts: whatever OD-W6-*/OD-W7-* choices leave deliberately out (e.g. employee self-projection of the aggregate, OD-W6-5; per-group punch enforcement, OD-4556-9). | respective locks | OPEN by construction at the pinned baseline. **Movement disclosed 2026-08-08, and deliberately not treated as landed**: the OD-W6-0..9 resolutions — adopt the W6 lock, option (a) for each — are recorded in PR 4821 (OPEN, non-draft, head `b5cc1a22`), which states that **its own merge** is the durable anchor for them; that PR is not on main at this rebase base, so no on-main record exists and no W6-derived row in either document is flipped here. The authorization those resolutions carry is narrow by their own text: the **W6-1 backend aggregate slice only**, Draft/HOLD, stopping after a fresh exact-head gate (PR 4814, OPEN/Draft, unmerged) — no W6-2 contract wiring, no W6-3 UI, no W6-4 verification, no merge. Consistent with that, no W6 runtime exists on main: `git diff` over `packages/core-backend/src/attendance`, `packages/core-backend/src/services`, `plugins/plugin-attendance`, `packages/openapi`, and `apps/web/src/views/attendance` between the pinned baseline and the rebase base is empty. OD-W7-0..8 carry no ruling of any kind. | Listed in the ledger with their owning lock — not silently absorbed into issue 4556. W8-R7 re-derives this row against the then-current main, at which point PR 4821's disposition will be a fact rather than a pending one |
| L7 | Wave-5 explanation-surface posture-ceiling revision once W4 evidence is authoritative anywhere (named cross-lane follow-up; must not be done unilaterally by this lane). | W4 lock §10.3 (`:2386-2403`) | Not started | Ledger row naming the owning lane; not a #4556 closure blocker unless the owner rules otherwise |
| L8 | CI wiring gap: two of the 40 `attendance-w4c*.db.test.ts` suites (`attendance-w4c3b-request-snapshots.db.test.ts`, `attendance-w4c3b-central-approval.db.test.ts`) are in neither the plugin-tests real-DB run-list (`plugin-tests.yml:1147`) nor the vitest no-DB exclude — their DB-gated blocks skip-green and execute nowhere in CI. The request-snapshots suite is the real-DB proof of the 8-cell soak-entry precondition (#4775 arc, PR #4780). The wiring guard (`attendance-w4c2-ci-wiring.test.mjs`) cannot catch this: its `FILES` constant is a hardcoded allowlist, not a completeness assertion. | This document (§1 spine row; found by the #4804 adversarial gate); companion CI-wiring fix **PR 4805** (OPEN, non-draft, head `2985e03c` as re-read 2026-08-08 after this rebase — an earlier round of this document cited head `40dfd4f3`, which the branch has since advanced past; the PR is still OPEN and unmerged) | Verified at this baseline **and re-counted at the rebase base `5c3146ac…`, where the gap is unchanged**: 40 files on disk match `attendance-w4c*.db.test.ts`; the real-DB step (located by its stable `id: attendance-real-db-integration`) carries 98 whole-file args of which 38 are `attendance-w4c*`; the two files missing from the run-list are exactly the two named; no run-list entry is absent from disk; neither missing file appears in `vitest.config.ts` `test.exclude`; both gate on `describeIfDatabase` | **Fix before W8 execution**: two-point wire both files and convert the wiring guard to a directory-glob completeness assertion — a W8 head-scoped verdict cannot rest on a corpus two of whose files never ran |
| L9 | Parent §10 item 8 has **no landed implementation** at this baseline: the four-label group workflow (effective / inherited / preview-only / conflicting) is W6's scope, and `conflict_action_required` exists only in the types-only contract module, the W6 JSON fixtures, and the out-of-build OpenAPI draft — no runtime, no route, and the panel shell is imported nowhere. W6 is item 8's only planned vehicle. | Parent lock §10 (`:764-777`, item 8 `:776-777`); W6 lock (`Status: PROPOSED / runtime HOLD` on main, unchanged since PR 4771's merge commit `2967da018ceea41b91098e14d4c15a57236eb5f8`) | Verified at this baseline and re-verified at the rebase base (grep: label in types/fixtures/draft only; panel referenced nowhere; zero source drift over the attendance/W6 paths) | **The decision half of this row has moved; the implementation half has not.** OD-W6-0 is recorded as **adopt** (not declined) — see L6 for the exact provenance and its limits: recorded in PR 4821, which is OPEN and states that its own merge is the durable anchor, so nothing is on main yet. On that recorded direction the declining branch below is not the live one, but the coupling itself is unchanged: item 8 still has **no landed implementation**, W6 remains its only planned vehicle, and only the W6-1 *backend* slice is prospectively authorized (Draft/HOLD, unmerged) — the four-label workflow is W6-3 UI scope, which is explicitly still withheld. The original warning therefore stands as the counterfactual it always was: **were OD-W6-0 to end up declined, or were the W6 runtime not to land, item 8 could not be satisfied and issue 4556 could not close under §10 as ratified** — closure would then require an owner amendment to parent §10, routed through OD-W8-1(b); see §6 item 8. W8-R7 re-derives this row on the W8 head |

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
| 8. Group workflow shows effective / inherited / preview-only / conflicting | Conditional on W6 runtime (§3.2 group-workspace family). Disclosure (ledger L9, with L6's provenance): item 8 has no landed implementation at this baseline or at the rebase base, and W6 is its only planned vehicle. OD-W6-0 is **recorded as adopt** — in PR 4821, which is OPEN and whose own merge it names as the durable anchor, so no on-main record exists yet — and the authorization it carries reaches only the W6-1 backend slice (Draft/HOLD, unmerged); the four-label workflow is W6-3 UI scope and remains withheld. So this item's evidence slot stays empty and stays conditional. The counterfactual is unchanged: were OD-W6-0 to end up declined, or the W6 runtime not to land, this item could not be satisfied and issue 4556 **could not close under §10 as ratified**; closure would then require an owner amendment to parent §10 (routed through OD-W8-1(b)). Declining OD-W6-0 would therefore be a closure-blocking decision, not only a W6/W7 scoping one. |

Plus the W4 lock §15 completion definition, re-verified as a block, and the
honest-residuals section (misclassified gaps are not "ceilings"; every
residual names its responsibility split).

Final line of the checklist, verbatim in the future verification MD: "This
document records evidence. It does not close issue #4556. Closure is the
owner's separate final decision under W4 lock §14 item 10."

## 7. Non-negotiable red lines

| ID | Rule | MECHANICAL check |
| --- | --- | --- |
| W8-R1 | No automation closes issue #4556: no PR body, commit message, or doc merged by this line may carry a GitHub closing keyword targeting #4556 (or any issue) unintentionally. | Pre-merge sweep on every W8-line PR: `grep -inE '\b(close[sd]?\|closing\|fix(e[sd])?\|fixing\|resolv(e\|es\|ed)?)\b[[:space:]]*:?[[:space:]]*(#[0-9]+\|GH-[0-9]+\|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+\|https?://github\.com/[^ ]+/issues/[0-9]+)'` (pipes backslash-escaped here for table rendering only — the executable form uses plain pipe alternation, as in the fixture-proved run recorded for this PR) over body + changed docs returns only intended, reviewed hits — for this line, zero. **Coverage note, with its authority named:** the reference alternation covers the four GitHub-documented closing-reference spellings — `#N`, `GH-N`, `OWNER/REPOSITORY#N`, and the issue URL. No in-repo document enumerates the `GH-N` or cross-repo forms — swept 2026-08-08 over `docs/`, `scripts/`, `.github/`: the sole `GH-[0-9]` match is the substring of `High-1` in an unrelated lock, and a keyword + `OWNER/REPO#N` search returns zero files; the repo's own doctrine on this hazard enumerates only `#N` — so that coverage rests on GitHub's published linking syntax rather than on a repo authority, and the claim here is only that the regex was **executed** against a fixture carrying all four families — not that no fifth spelling exists. The sweep is proved live before its empty output counts, in both directions: a positive-control fixture of **48** lines — the full cross-product of the 11 keyword spellings (`close/closes/closed/closing/fix/fixes/fixed/fixing/resolve/resolves/resolved`) against all four reference families, 44 lines, plus 4 colon/extra-space/capitalisation variants, one per family — must match 48/48, and a **negative**-control block of **10** near-miss lines (`see #4556`, `tracked under #4556`, `closes the window on the legacy path`, `fix the flaky teardown described in the ledger`, `related to zensgit/metasheet2#4556`, `refs GH-4556`, `discussion at <issue URL>`, `disclosure: the resolver never reads the aggregate`, `the closing checklist is the owner's`, `resolution of GH problems is out of scope`) must match 0/10 — without the negative half, a regex that matched everything would also produce a clean "zero hits" story. Recorded execution for this PR (2026-08-08): **48/48 positives matched, 0/10 negatives matched**. Issue #4556 state re-checked OPEN after every merge — noting that this backstop covers #4556 only, while the rule above covers any issue, so the regex sweep is the load-bearing half. |
| W8-R2 | Completion-claim ceiling: W8 wording stops at "landed / gates green / evidence recorded"; no "accepted", "production-ready", "acceptance passed" absent owner/customer evidence. | Mechanical absolute-claim sweep before delivery: grep the MD set for the banned-claim list maintained in a versioned file **outside the artifact under review** (e.g. `scripts/ops/attendance-completion-claim-banned-terms.txt`, added via an owner-authorized tooling PR per W8-R6) that the W8 deliverable PR itself does not modify — a list living inside the checked MD lets its author pass the sweep by omission; run as a CI step where the tooling exists, and until then executed by the independent gate reviewer, not the author; each hit either quoted-with-evidence or removed; the sweep command + output recorded in the verification MD. |
| W8-R3 | Head-scoped verdicts only: every matrix row records the full 40-hex SHA it ran on; no row inherits green from an older head. | Verification MD table has a SHA column; the W8 head is pinned **once** (`git rev-parse` output pasted verbatim, full 40 hex); a checker asserts every evidence row's SHA is byte-**equal** to that single pinned value — not merely 40-hex-shaped, because a full-length but *stale* SHA satisfies a shape check while violating the no-inheritance half of the rule; abbreviated SHAs fail the same equality check by construction. |
| W8-R4 | Executed-run evidence only: a row is green via run URL / log with non-zero counts; skip/absent runs are red. | For each CI-mapped row, the workflow run ID + step name + **per-file** test counts are recorded (`vitest --reporter=json`, recording `numPassingTests` for the specific named file): a step-level total over the attendance real-DB step's **98-file** run-list (38 of them `attendance-w4c*`; an earlier draft of this cell said "38-file run-list", understating the dilution) cannot show — and that 98 is itself head-scoped per W8-R3, counted at the rebase base `5c3146ac`, where it was **97** at this document's pinned baseline `4e6a35d9` before PR 4799 added `scratch-database-drain.db.test.ts`, so the W8 executor re-counts it on the W8 head rather than quoting this number — whether one file contributed anything — a `describe.skip` inside one suite leaves the step's totals healthy, the exact mechanism by which the L8 gap stayed invisible. A `0 passed`, skipped, or absent per-file entry fails the row by definition; each DB-gated suite additionally carries a fail-closed guard that reds (not skips) when its DB URL is absent in a step claiming real-DB execution; run-list completeness itself is asserted by the glob-derived wiring guard (the L8 companion CI-wiring fix, **PR 4805**). |
| W8-R5 | Values-free evidence surfaces: soak/matrix evidence carries counts, closed codes, hashes, dates — never member lists, punch values, or secrets. | Exact-key review of every evidence artifact checked into docs; a leak probe (fixture with `userId`/`memberIds` keys) fails the artifact linter/review checklist. |
| W8-R6 | W8 adds zero runtime: the W8 deliverable PRs touch `docs/` (and, if the owner authorizes tooling, explicitly inventoried scripts) only. | `git diff <base> HEAD -- packages plugins apps scripts .github` empty for each W8 docs PR — the path list includes `scripts` (W7-R9's list) precisely because the rule conditions on scripts tooling; a list without `scripts` is structurally blind to the one directory the rule carves out. An owner-authorized tooling PR instead lists each `scripts/` path it adds against the owner's authorization reference and carries its own inventory + deletion-green proof. |
| W8-R7 | Ledger completeness is re-derived, not remembered: the §5 ledger is regenerated against the then-current main before execution. | The regeneration commands (issue queries + doc/grep sweeps) are recorded in the MD with their outputs, and the spot-check runs in **both** directions, because either alone is passable by a broken regenerator. **Positive**: a named item verified OPEN at regeneration time — issue 4792 (L3) and issue 4629 (L4) were both re-confirmed OPEN on 2026-08-08 — must appear in the regenerated ledger. **Negative**: a named item verified CLOSED must appear as *closed*, not vanish and not stay open — issue 4791 (L2) is that worked example, CLOSED COMPLETED 2026-08-07T15:44:55Z, and this document's own L2/OD-W8-3 rewrite is the recorded instance of the negative half firing. An earlier draft of this cell named only "#4791 if still open", which the closure has since made unrunnable; a spot-check whose only example can no longer fire is not a check. |

## 8. Decision points (owner menu)

OD-W8-1, OD-W8-2, and OD-W8-4..7 are **OPEN**. OD-W8-3 is **SATISFIED** — it
is kept in place, with its ID unchanged and its row rewritten as a record, so
that every cross-reference to an OD-W8-*n* elsewhere in this document keeps
pointing at the same question.

| ID | Question | Options (recommended first) and consequences — or, for a SATISFIED row, the record that replaced them |
| --- | --- | --- |
| OD-W8-1 | Adopt this plan as the W8 contract | **(a)** Adopt (amendable by its own process). (b) Re-scope W8 — any narrowing of parent §10 coverage is an owner-level contract change, recorded per-item, never a silent drop. |
| OD-W8-2 | Soak topology | **(a)** Two sequential soaks if W7 lands (W4-authoritative soak, then W7-cutover soak), calendar-parallel work allowed on other lanes. (b) One combined soak — shorter calendar, but a critical diff becomes ambiguous between the segment engine and the policy source; only acceptable if the owner rules the attribution ambiguity tolerable. |
| OD-W8-3 | Disposition of the teardown flake on a required check (issue 4791) | **SATISFIED — nothing left to rule on; this row records an event, it does not report a choice.** An earlier draft of this row offered the owner "(a) fix before W8 execution / (b) owner-accepted residual with a rerun protocol". That menu was already void when written down: the flake had been fixed and the issue closed. Retracted and replaced by the record, verified 2026-08-08 with the commands in §10. **What landed:** PR 4799 merged 2026-08-07T15:18:34Z as merge commit `51c3d8720789476efa15f6b99b6dc5f51df4743b`, verified an ancestor of this document's rebase base `5c3146acbc81b655e62bee9249b68eaec4e6e4c6`. **What it does:** removes the failure source instead of muting it — `ALTER DATABASE … ALLOW_CONNECTIONS false`, then poll `pg_stat_activity` until no other backend remains, then a **plain** `DROP DATABASE`, forcing only if the drain times out (`packages/core-backend/tests/helpers/scratch-database.ts`). Nothing is terminated, so there is no `pg_terminate_backend` for `pg` to surface as an ownerless `'error'` event on a pooled client — the mechanism that produced "all tests pass, exit code 1". **The criterion it had to meet, and why "CI went green" was explicitly not it:** a forced drop *is* the pre-fix behaviour, so a green run cannot distinguish "the drain worked" from "this run got lucky" — the issue therefore did not close on PR 4799's merge. The criterion was the unconditional `scratchDrain=` line that both real-server call sites now print reporting `CLEAN` **on main's own required gate**. **Met:** workflow run 31191954460 (`Plugin System Tests`, `event=push`, `headBranch=main`, `headSha` byte-equal to `51c3d872…`), required check `test (20.x)` = success — `test (20.x)` being one of the nine contexts in main's required-status-check set. Grep over that job's full log returns both call sites clean — `scratchDrain=CLEAN suite=bpmn-poller-disabled drainMs=66 residualBackends=0` and `scratchDrain=CLEAN suite=w4c2-sweep-call-through drainMs=74 residualBackends=0` — with `scratchDrain=FORCED`, `57P01`, and `Unhandled Errors` each at count 0. (The non-required `test (18.x)` leg carries a third `CLEAN`, `drainMs=277`; the required-gate claim rests on the two lines above, not on that one.) **State:** issue 4791 CLOSED as COMPLETED 2026-08-07T15:44:55Z; the rollup issue 4796 closed on the same evidence at 2026-08-07T15:45:30Z. **Residual, not erased:** those zeros are grep counts over one job log at one SHA, not a proof that the race cannot recur; the issue's own closing note keeps the reopen path, since a future `scratchDrain=FORCED` line names the component still holding a connection in `holders=[…]`. Ledger row L2 therefore stays live in §5 as a W8-head **re-verification** item (W8-R7 re-derives the ledger anyway). **No owner ruling occurred:** the outcome coincides with what option (a) aimed at, but the owner was never asked and did not choose — do not read this row as "(a) was selected". |
| OD-W8-4 | Disposition of the #4629 manual matrix | **(a)** Author `PQA-W8-*` against the W8 head and formally retire #4629's checklist by owner note on that issue. (b) Complete #4629 as-is first — exercises a superseded head; only worth it if the owner wants the historical candidate's evidence completed. |
| OD-W8-5 | FSER-4 §3-§4 relative to #4556 closure | **(a)** Track under #4709, outside the #4556 closure set; the ledger row records the owner's explicit exclusion. (b) Pull into the #4556 closure set — couples closure to an amendment whose own owner decision is still OPEN. |
| OD-W8-6 | Customer-acceptance evidence standard (parent §9.9) | **(a)** Closure checklist item 1 may complete with synthetic-staging evidence only, and the verification MD states plainly that no customer-acceptance claim is made. (b) Require a named customer evidence artifact before the checklist is handed over — delays closure input until a customer engagement exists. |
| OD-W8-7 | Acceptance-ledger form | **(a)** One MD table in `docs/development/` (per-item: acceptance text → slice PR/owner decision → evidence link), reviewed like code. (b) Issue-comment ledger on #4556 — closer to the issue but unreviewable and mutable; rejected by default. |

## 9. Landing sequence

1. Owner instructs merge of the docs-only Draft/HOLD PR carrying this
   document and the W7 draft lock (the PR stays Draft + HOLD until that
   explicit instruction; nothing here self-authorizes it) — merging records
   the plan; it authorizes nothing.
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
- L8 wiring evidence (verified at the pinned baseline by the #4804
  adversarial gate; re-verified in the first amendment round after rebase onto
  `origin/main@51c3d8720789476efa15f6b99b6dc5f51df4743b`, and again in this
  round after rebase onto
  `origin/main@323d7e1afef407f68c8ff2a6bfa940f175300f59`):
  `.github/workflows/plugin-tests.yml:553` (no-DB core-backend test step, no
  `DATABASE_URL`), `:594` (Start Postgres, after it), `:1147` (attendance
  real-DB run-list step, 38 `attendance-w4c*` entries);
  **anchor drift disclosed**: those three line numbers are the pinned-baseline
  ones and hold byte-identically at `51c3d872`, but `plugin-tests.yml` has moved
  on main twice since — at `a45e1416` and at the previous rebase target
  `323d7e1a` the same three anchors were `:606`, `:647`, and `:1201`, and at the
  **current** rebase base `origin/main@5c3146acbc81b655e62bee9249b68eaec4e6e4c6`
  they are `:608`, `:649`, and `:1206`. The run-list step is located by its
  stable `id: attendance-real-db-integration`, never by line number, so the
  drift moves citations, not findings. The **facts** are unchanged
  at `5c3146ac`, re-counted this round: 40 files on disk match
  `attendance-w4c*.db.test.ts`, the step carries 98 whole-file args of which 38
  are `attendance-w4c*`, the two files missing from the run-list are exactly
  `attendance-w4c3b-request-snapshots.db.test.ts` and
  `attendance-w4c3b-central-approval.db.test.ts`, no run-list entry is absent
  from disk, and neither missing file appears in `vitest.config.ts`
  `test.exclude`;
  `packages/core-backend/vitest.config.ts` `test.exclude` (neither L8 file
  present);
  `packages/core-backend/tests/integration/attendance-w4c3b-request-snapshots.db.test.ts:14-15`
  and `attendance-w4c3b-central-approval.db.test.ts:54-55`
  (`describeIfDatabase` skip gates);
  `scripts/ops/attendance-w4c2-ci-wiring.test.mjs:71` (`FILES` hardcoded
  allowlist)

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

GitHub state, **re-queried 2026-08-08 against the current rebase base** (an
earlier round of this block recorded the 2026-08-07 query, in which issue 4791
was still OPEN; that line is superseded, not merely re-dated):

- Issues OPEN: 4556; 4629 (PQA-01..10 all still unchecked, PQA-10 still marked
  BLOCKED — re-read this round: 10 `- [ ]`, 0 `- [x]`); 4709; 4770; 4775; 4792
  (timeCycle residue, zero comments).
- Issues CLOSED: **4791** (57P01 teardown flake) — CLOSED as COMPLETED
  2026-08-07T15:44:55Z; **4796** (its cross-PR rollup) — CLOSED
  2026-08-07T15:45:30Z on the same evidence. See ledger L2 and OD-W8-3.
- PRs MERGED: 4771 (W6 prep, merge commit
  `2967da018ceea41b91098e14d4c15a57236eb5f8`); 4772 (FSER-4 §2 `/me` route,
  2026-08-05T15:54:09Z — see L1); 4773; 4774; 4779; 4780; **4799**
  (`51c3d8720789476efa15f6b99b6dc5f51df4743b`, 2026-08-07T15:18:34Z, the
  issue-4791 fix — verified an ancestor of the rebase base).
- PRs OPEN / unmerged: 4805 (below); 4814 (W6-1 backend slice, Draft, head
  `4cc01228`); 4821 (durable W6 RATIFY record, non-draft, head `b5cc1a22`) —
  see ledger L6/L9. Naming any of these authorizes none of them.

Closure evidence for issue 4791, verified this round rather than quoted:
workflow run 31191954460 (`Plugin System Tests`, `event=push`,
`headBranch=main`, `headSha=51c3d8720789476efa15f6b99b6dc5f51df4743b`),
required check `test (20.x)` = success; full job-log grep returns
`scratchDrain=CLEAN` for both real-server call sites (`bpmn-poller-disabled`
`drainMs=66`, `w4c2-sweep-call-through` `drainMs=74`, both
`residualBackends=0`) and count 0 for each of `scratchDrain=FORCED`, `57P01`,
`Unhandled Errors`. `test (20.x)` was confirmed to be one of the nine contexts
in main's required-status-check set at query time (that set grows; it is read
from the API, never recalled).

Companion CI-wiring fix, re-read 2026-08-08 after this rebase: **PR 4805**
(`fix(ci): OBS-1 — wire the two orphan W4C-3b real-DB suites; convert
attendance wiring guard to derived completeness`), OPEN and non-draft, head
`2985e03c` (an earlier round cited `40dfd4f3`; the branch has advanced),
branch `claude/wire-orphan-w4c3b-suites-20260807`, check rollup 24
SUCCESS + 1 SKIPPED (`Strict E2E with Enhanced Gates`), touching
`.github/workflows/plugin-tests.yml`, `packages/core-backend/vitest.config.ts`,
`scripts/ops/attendance-w4c2-ci-wiring.test.mjs`, and one unrelated rebase
artifact. Named here as the L8 precondition only — naming it is not an
instruction to merge it, and its disposition is the owner's.

Commands behind this block (run 2026-08-08; recorded so W8-R7's regeneration
can be reproduced rather than trusted): `gh issue view <n> --json
number,state,stateReason,closedAt`; `gh pr view <n> --json
number,state,isDraft,mergedAt,mergeCommit,headRefOid,statusCheckRollup`;
`gh run view 31191954460 --json event,headSha,conclusion` plus `gh run view
--job <id> --log -R zensgit/metasheet2` piped through `grep -c`; `gh api
repos/zensgit/metasheet2/branches/main/protection --jq
'.required_status_checks.contexts'`; `git merge-base --is-ancestor <sha>
origin/main`; and, for the L8 re-count, a walk of the
`id: attendance-real-db-integration` step's own arg list rather than a
fixed-width slice of the workflow file.
