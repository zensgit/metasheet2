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
> Freshness: this document retains the pinned baseline above for historical
> citations, while the branch is rebased to fresh `main` and current-state
> claims are re-verified at each review round. Items that later changed state
> are corrected in place with their
> provenance rather than silently dropped — see OD-W8-3 (SATISFIED), ledger
> rows L1, L2, L6, **L8 (now landed — PR 4805 MERGED)**, L9, L10,
> **L11 (Gate C implementation landed — PR 4839 MERGED)**, L12, and §10.
> Re-verified 2026-08-11 against
> `origin/main@b4ec95146a11d2155de17654d69b0c241953a8f0`.

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
entry/exit contract, a reconciliation ledger of the parked debts found by this
PR's gates and current-state re-verification, and a
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
| Real-DB gate corpus (**landed 2026-08-10 — was the L8 gap, now fixed**) | At this document's pinned baseline, 40 files matched `attendance-w4c*.db.test.ts` but the real-DB run-list carried only 38 of them, leaving `attendance-w4c3b-request-snapshots.db.test.ts` and `attendance-w4c3b-central-approval.db.test.ts` skip-green nowhere-executed (the L8 gap, found by the #4804 gate). **PR 4805 MERGED** `4c28467c54f376ad5a68718d3dbe6ad50c76a917` (2026-08-10T06:59:23Z) closes it: both named files now appear in the real-DB run-list (`.github/workflows/plugin-tests.yml`, step `id: attendance-real-db-integration`) **and** in `vitest.config.ts` `test.exclude` (two-point wired), and the wiring guard (`scripts/ops/attendance-w4c2-ci-wiring.test.mjs`) is converted from the hardcoded `FILES` allowlist to a derived-completeness assertion per its own header comment. Re-counted at current `origin/main@b4ec9514`: 41 on disk, 41 carried, 102 total whole-file args in the run-list; PR 4839 supplied the additional two-point-wired W4C-5 tool suite after the earlier 40/101 count. **What W8 still owes**: this row now moves from ledger L8 (open debt) to a plain fact; the executor still re-verifies it on the W8 head per W8-R3/R7 rather than trusting this re-count. | `packages/core-backend/tests/integration/attendance-w4c*.db.test.ts` (inventory in §10 below); run-list `.github/workflows/plugin-tests.yml` step `id: attendance-real-db-integration`; `packages/core-backend/vitest.config.ts` `test.exclude`; `scripts/ops/attendance-w4c2-ci-wiring.test.mjs` header; CI mapping per `docs/development/attendance-w4c2-qa-handoff-20260726.md` §1.2 |
| Zero-bypass hard gate | Current-tree open-debt set asserted exactly empty with a live side-door mutation leg; exact P16 allowlist. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1074, 1386`; `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` |
| QA handoff tooling | The W4C-2 QA handoff manual (gate matrix G1-G24 mapped to suites and CI steps) plus isolated-DB scripts (reset / run-suites / residue check) exist and are values-safe (localhost-forced). | `docs/development/attendance-w4c2-qa-handoff-20260726.md` (§1.2, §2.3); `scripts/attendance/w4c2-qa/qa-db-reset.sh`, `qa-run-suites.sh`, `qa-residue-check.sql` |
| Manual preview QA matrix | Issue #4629 carries the ten-case manual feedback matrix `PQA-01..PQA-10` (multi-segment authoring, overnight attribution, timezone, legacy compatibility, shadow posture, ambiguous evidence, authorization isolation, fingerprint freeze, outbox retry, scheduled identity) against a frozen candidate SHA; all ten checkboxes are unchecked and PQA-10 is marked BLOCKED there. This is the only place "PQA" exists as a case-ID concept (the raw three-letter token also occurs as base64/binary noise in unrelated assets) — it is an issue-side case-ID prefix, **not** a repo artifact. | issue #4629 (OPEN), body read 2026-08-07 |
| Soak preconditions landed | The W4C-5 transition-safety arc is on main: hardened transition boundary and evidence-manifest discipline (PR #4773); recovery-sweep fairness and values-free counters (PRs #4774/#4779); the complete 8-cell request-snapshot precondition (PR #4780); and the operator `plan`/`apply` CLI plus preparation runbook (PR #4839, merge `60afbffe…`). The merge authorizes no execution, org selection, staging, flag, deployment, soak, or production/customer data. | `packages/core-backend/src/attendance/w4c3a-rollout-control.ts`; `scripts/ops/attendance-w4c5-rollout-transition.ts`; `docs/development/attendance-issue-4556-w4c5-operator-runbook-20260809.md`; `w4c2-scheduled-run-ops-worker.ts`; `zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts` |
| Expected-differences roster | A closed, fail-closed-probed roster of anticipated legacy-vs-W4 divergences exists with exactly one ratified entry (`correction_applied_daily_adjusted`); the remaining-slice plan requires this roster to enter soak so known divergence is not misread as regression. | `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53, 75-83, 135`; `attendance-issue-4556-w4-remaining-slice-plan-20260726.md:117-119` |
| Dual-host read matrices | Calculation-detail is dual-hosted (admin + self; self rejects `userId` input with a typed 400); decision-trace is dual-hosted the same way. | `packages/core-backend/src/routes/attendance-admin.ts:1479, 1512-1515, 1376, 1416` |
| Closeout master plan | The attendance line's master plan already models final closure as a locked owner item (B14, "issue #4556 关闭终裁 — 锁 §14-10"). | `docs/development/attendance-line-closeout-master-plan-20260726.md:107, 134` |

Expected-but-absent, verified honestly:

- No W8 verification MD or final acceptance ledger exists yet. PR 4839 has
  landed the W4C-5 transition CLI and its preparation runbook; that artifact
  is an input to W8, not a substitute for W8's final migration/rollback and
  closeout evidence.
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
3. the **reconciliation ledger** — every parked debt found by this PR's gates
   and current-state re-verification, each with an owner-visible disposition;
   W8-R7 must re-derive the set on the W8 head (§5);
4. the **closure checklist** mapping parent §10 + W4 §15 to evidence slots,
   handed to the owner for the §14-10 ruling (§6);
5. the operator migration/rollback **runbook** (parent §9.9) as a reviewed
   document;
6. the **issue acceptance ledger** (parent §9.9's third deliverable — missing
   from this list before this round; §5A) — acceptance text mapped to slice/
   PR/decision, contingent on `OD-W8-8` establishing what an "acceptance
   item" is.

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

Former precondition (ledger L8), **now MET**: the two w4c3b suites
(`attendance-w4c3b-request-snapshots.db.test.ts`,
`attendance-w4c3b-central-approval.db.test.ts`) had to be two-point wired
(run-list + no-DB exclude) before any §3 row could be executed. **PR 4805
MERGED** `4c28467c54f376ad5a68718d3dbe6ad50c76a917` (2026-08-10T06:59:23Z)
carries that wiring; re-verified against `origin/main@3767d87c` (§1 spine
row). "Green" is still not established by the merge alone — the W8 executor
still runs these two suites on the actual W8 head per W8-R3/R4 and records
their per-file counts; the precondition that blocked *starting* §3 is
discharged, the executed-evidence obligation is not.

| Leg | Predicate |
| --- | --- |
| Real-DB corpus | Full attendance real-DB corpus green on the named head, on a **fresh** database (shared-DB residue is a known false-red source). "Full" is defined by the directory glob over `attendance-w4c*.db.test.ts`, not by the historical run-list — see the L8 precondition above. |
| Zero-bypass | Collector `unclaimed=0` on the named head, with the side-door mutation leg red-capable (run the mutation, verify red, restore from file backup — never via `git checkout -- <file>`). |
| Migrations | Fresh-migration + upgrade + replay pass (W4 lock §11); pending migrations zero against the deploy image. |
| CI wiring contract | Green with the guard converted to a **derived-completeness assertion** (a suite missing from run-list or exclude is red by construction — the hardcoded-allowlist form is the mechanism that let L8 stay invisible), extended to every W6/W7 suite added since; run-list + path-filter wiring is itself asserted, not assumed. **Landed**: `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`'s own header, re-read at `origin/main@3767d87c`, records the OBS-1 conversion from the hardcoded `FILES` allowlist to a disk-walk-derived corpus; this leg is executed green on the W8 head, not merely asserted landed here. |
| Mutation ledger | Every red line of the W6/W7 locks has its named mutation leg re-run on the named head; each leg's anchor-hit is verified (mutation actually landed in executed code) before its red is counted. |

### 3.4 Parent lock §7 discharge table (NEW — W8's roll-up job per parent §9.9)

Parent lock §7 ("Required verification") is cited in this document and the
W7 draft only at their red-line/§9.9 sections; §7 itself was never
enumerated or mapped, and W8 (whose scope under parent §9.9 makes this
roll-up its job) built its own §3 matrix from scratch instead. This table is
that mapping.

**Denominator is 43 for this ledger, derived directly from parent-lock §7 —
not an owner authorization or closure ruling.** §7.1 Database = 12 bulleted
checks; §7.2 Calculation = 15 bulleted checks; §7.4 Mutation = 8 bulleted
checks; §7.5 Frontend = 7 bulleted checks — 12+15+8+7 = **42** bulleted
items, **plus** §7.3 Entry-point parity, which is **one prose clause, not a
bulleted list**, assigned one composite ID (**EP-01**) by this mapping — 42 +
1 = **43**. There is no discrepancy left to report: an earlier
round of this table stopped at 42 by treating EP-01's prose form as a reason
to give it no row at all, rather than a reason to give it exactly one
composite row. (Derivation: `git grep -n '^## 7\.\|^### 7\.\|^## 8'
origin/main -- docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
locates `## 7.` at `:538` and `## 8.` at `:619` (`### 7.1` `:540`, `7.2`
`:566`, `7.3` `:588`, `7.4` `:594`, `7.5` `:609`); `sed -n '538,618p' <file>`
then counted by hand per subsection — 12 / 15 / 1 prose clause / 8 / 7.)

**Exactly four bookkeeping verdicts are used by this draft** — not the two-verdict
D/R shape an earlier round of this table borrowed from parent §10 item 1's
own shape, and not the five-value D/PARTIAL/UNCERTAIN/EMPTY/R vocabulary a
later-but-still-earlier round used instead. These labels classify evidence;
they do not record owner authorization:

- **OPEN** — the requirement is known to be unmet, including a compound
  requirement for which one or more named legs remains unevidenced.
- **UNRESOLVED** — this round did not establish whether the requirement is
  met: mapping was incomplete, evidence was partial, or the relevant surface
  was not searched. Partial or suggestive evidence is kept in the notes so a
  later round does not re-search from zero; it is not silently converted into
  a claim that the implementation is absent.
- **SATISFIED** — requires both a `main` merge SHA (the commit that landed
  the discharging test, not merely a verification-anchor SHA such as
  `origin/main@d78b27d3`) **and** the specific test/evidence that discharges
  it. A verification-anchor SHA proves the cited test exists at that head;
  it does not by itself identify which commit landed it, so it is not
  sufficient alone for this verdict. (This is a narrower use of the word
  "SATISFIED" than `OD-W8-3`'s status elsewhere in this document — that OD
  table tracks whether an *open decision* has been resolved; this table
  tracks whether a parent-§7 *verification item* has a landed, named test.
  The two tables' SATISFIED do not certify the same thing.)
- **REMOVED** — requires an explicit owner decision **for that ID** plus a
  statement of the product impact of removing it. **Zero rows carry this
  verdict in this round** — no owner decision naming a specific ID is cited,
  so none is asserted here.

**Map mechanically first.** Every SATISFIED verdict
below is backed by (a) a **test title match**, not a full-body re-read of
every assertion in the named test — a materially weaker form of evidence
than the mutation-leg verification this document otherwise requires
elsewhere, stated as such rather than presented as equivalent — and (b) the
merge commit that added the discharging file, located by `git log
origin/main --diff-filter=A --format=%H -- <file> | tail -1` (the oldest
commit adding that path, re-verified 2026-08-10 against
`origin/main@d78b27d3`). A row whose only available evidence is a
verification-anchor SHA, a partial/half match, an uncertain match, or a
non-suite citation (e.g. a QA-handoff narrative rather than a titled test)
is **UNRESOLVED** under this bar, even where an earlier round of this table
called it discharged. A row is **OPEN** only when the unmet requirement is
established. A file-creation SHA is not automatically a
title-landing SHA — several of these six files grew substantially after
their creation commit (`attendance-shift-segments-writer-matrix.db.test.ts`
1258→1997 lines; `w4c1-segment-calculator.test.ts` 1211→1317;
`attendance-work-date-resolver-w2.db.test.ts` 531→545, all measured
creation-SHA vs. `origin/main@d78b27d3`), so every cited title below was
individually re-confirmed present **at the cited creation SHA itself**
(`git show <sha>:<file> | grep -c "<title>"`, not merely present on current
`main`) before this round assigned SATISFIED — the two unchanged files
(`attendance-shift-segments-migration.db.test.ts`,
`attendance-calculation-group-membership-w1.db.test.ts`) and
`w5-flex-segment-calculator.test.ts` show identical line counts at creation
and at `d78b27d3`, so no such drift was even possible there. One row (DB-07)
needed a wording correction from this check — see its own cell.

**§7.1 Database (DB-01..DB-12)**

| ID | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| DB-01 | fresh migration and upgrade from pre-segment schema | SATISFIED | `attendance-shift-segments-migration.db.test.ts`: "FRESH: up() on an empty schema creates table, constraints, and the org-integrity FK" (`~L122`), "UPGRADE + BACKFILL: every legacy shift becomes segment 0..." (`~L150`). Merge SHA `c5f08aecd5732d70b616561398d8456240f62486` (#4569, 2026-07-24 — file first added at this commit). |
| DB-02 | one segment backfill for every legacy shift | SATISFIED | same file, "UPGRADE + BACKFILL..." (`~L150`). Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. |
| DB-03 | replay idempotency | SATISFIED | same file, "REPLAY: a second up() is a no-op for already-covered shifts" (`~L166`). Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. |
| DB-04 | concurrent membership overlap rejection | SATISFIED | `attendance-calculation-group-membership-w1.db.test.ts`: "lets the database reject one of two concurrent direct overlapping writes" (`~L456`). Merge SHA `9055932e314265794b3baa8e80cff0828ba2902c` (#4563, 2026-07-23). |
| DB-05 | inclusive boundary transition (D-1 to D) without a gap or double winner | SATISFIED | same w1 file, "closes the prior inclusive interval at D-1, starts the next at D, and records audit context" (`~L238`). Merge SHA `9055932e314265794b3baa8e80cff0828ba2902c`. |
| DB-06 | cross-org FK and query isolation | SATISFIED | `attendance-shift-segments-migration.db.test.ts` "CROSS-ORG INTEGRITY: the composite FK rejects a segment whose org differs from the parent shift" (`~L207`); `attendance-shift-segments-writer-matrix.db.test.ts` "cross-org: a shift is invisible and unreferenceable from another org" (`~L714`). Both files first added at merge SHA `c5f08aecd5732d70b616561398d8456240f62486` (#4569). |
| DB-07 | flag-OFF 422 + zero-write evidence for fixed-schedule apply/rebuild, automatic matching, draft/active assignment, rotation rule/generated assignment, shift-swap create/final approval, schedule-dispatch create/final approval | SATISFIED | `attendance-shift-segments-writer-matrix.db.test.ts`, nine legs covering every named surface — not a uniform title (corrected this round: an earlier round's "nine `matrix: ... typed 422 with zero writes` legs" implied one shared title pattern for all nine, which overstates it): seven carry that literal title (current-`main` lines `~734, 789, 819, 913, 946, 966, 1578`) and two carry a distinct but substantively equivalent title, `matrix: shift-swap/schedule-dispatch final approval fails closed after the source/target shift became multi-segment` (current-`main` lines `~1498, 1541`; both titles independently re-confirmed present at the cited creation SHA too, at their then-lower line numbers `765` and `804` — `git show c5f08aecd5732d70b616561398d8456240f62486:<file> \| grep -c "final approval fails closed"` → 2), each asserting a 422 + typed guard code + a zero-incremental-write count in its body — same fail-closed/zero-write substance, different wording. Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. |
| DB-08 | existing-reference delete 409 + zero writes per durable blocker; rejected/cancelled/history fixtures prove non-blocking evidence intact + redacted UUID | UNRESOLVED | Partial evidence in `attendance-shift-segments-writer-matrix.db.test.ts`: "delete: typed 409 with zero writes for every durable blocker class" (`~L1642`) covers historical assignment, rotation-rule ID/name, requester-side pending swap, and pending dispatch; "delete: rejected/cancelled evidence does not block, remains stored, and reads redact the raw UUID" (`~L1722`) covers rejected swap and cancelled dispatch. Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. This does not yet discriminate a counterparty-side pending swap, a published dispatch, or retained `attendance_auto_shift_auto_write_run_items.candidate_shift_id` history; the blocker helper also snapshots only shift and segment rows, not every blocker row. The full parent requirement is therefore not established. |
| DB-09 | concurrent shift delete + reference insertion cannot cascade-delete a newly created reference | SATISFIED | same file, "concurrency: a reference insert racing a delete is serialized by the shared lock protocol" (`~L1892`). Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. |
| DB-10 | legacy-mode transition with active multi-segment refs rejected, prior mode unchanged; injected inconsistent state fails closed without legacy-envelope calc | UNRESOLVED | Second half only found: same file, "fails closed before a historical import can calculate a forced multi-segment shift with the legacy envelope" (`~L526`), "...before a punch can calculate..." (`~L575`). First half (rejecting a legacy-mode transition specifically while active multi-segment refs exist) — no matching test title found this round; not guessed. Below the SATISFIED bar (half the check is unevidenced), but not established absent. |
| DB-11 | runtime rollback leaves legacy envelope + segments unchanged; destructive schema rollback forbidden once segment data exists | UNRESOLVED | Schema-rollback-forbidden half only found: `attendance-shift-segments-migration.db.test.ts` "down(): aborts BEFORE any DDL when segment rows exist; drops only an empty table" (`~L224`). Runtime (non-schema, org-posture) rollback leaving both envelope and segments unchanged — no matching test title found this round. Below the SATISFIED bar, but not established absent. |
| DB-12 | migration `down()` aborts without DDL when rows exist and is replay-safe on an empty/fresh database | SATISFIED | same file, `~L224` — checked against the **test body**, not just its title, since DB-12 has two clauses and DB-11's own OPEN verdict came from a half-covered bullet at this exact test: line ~229 asserts the abort-before-DDL half; line ~243 (`await segmentsDown(testDb)` on a schema that already has no table, asserted not to throw, with the preceding comment "down() on a schema that never had the table is a safe no-op") is the replay-safe-on-empty/fresh-database half — both clauses present in one test, so DB-12 (a distinct parent bullet from DB-11) is fully covered even though DB-11's own bullet (envelope/segment-unchanged on a *runtime*, non-schema rollback) is not touched by this test at all. Same test as DB-11's schema-rollback-forbidden half, discharging DB-12 in full and DB-11 only in part — the two rows are not exempted from the same rule, they cover disjoint clauses of the same test. Merge SHA `c5f08aecd5732d70b616561398d8456240f62486`. |

**§7.2 Calculation (CALC-01..CALC-15)**

| ID | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| CALC-01 | `08:00-12:00` + `13:00-17:00` = 480, not 540 | UNRESOLVED | Two partial legs exist. `attendance-shift-segments-service.test.ts` uses the exact two windows and asserts `plannedMinutes: 480`, but does not execute the calculator. `w4c1-segment-calculator.test.ts`, "two-segment day with a break: exact full result body (no envelope arithmetic, W4C-R1)" (`~L185`), executes the calculator and asserts 480, but its windows are `09:00-12:00` + `13:00-18:00`, not the parent fixture. Merge SHAs `c5f08aecd5732d70b616561398d8456240f62486` and `aebac4f8bef344b3ff3443ee045439c789a569a1`. Neither leg alone proves the exact required calculator case. |
| CALC-02 | missing afternoon in/out produces a segment anomaly | UNRESOLVED | Partial evidence in `w4c1-segment-calculator.test.ts`: "rule 2 partial OUTRANKS rule 3 late_early..." (`~L412`) asserts an afternoon `missing_check_in`, while "missing_check_in / missing_check_out statuses and daily partial" (`~L446`) tests both missing-boundary shapes only on segment 0. Merge SHA `aebac4f8bef344b3ff3443ee045439c789a569a1`. No leg establishes the afternoon `missing_check_out` half, so the combined requirement remains unresolved. |
| CALC-03 | duplicate punches resolve deterministically | SATISFIED | same file, "two check-in candidates in one directional cell are duplicate_check_in" (`~L659`), "identical-instant duplicates..." (`~L675`), "two check-out candidates..." (`~L682`). Merge SHA `aebac4f8bef344b3ff3443ee045439c789a569a1`. |
| CALC-04 | a segment crossing midnight preserves the originating work date | UNRESOLVED | Partial evidence in `w4c1-segment-calculator.test.ts`, "overnight segment (endDayOffset=1) resolves across midnight" (`~L286`), asserts the D/D+1 instants and worked minutes but not `dailyProjection.workDate`. A route-level overnight leg in `attendance-plugin.test.ts` asserts work-date retention for a legacy single-envelope shift, not a canonical crossing segment. Merge SHAs `aebac4f8bef344b3ff3443ee045439c789a569a1` and `077fde47859c561a13f820fb8ccc285a2ed5c58f`. The exact canonical requirement remains unproved. |
| CALC-05 | same-day slots select by containing segment window, not first assignment row | UNRESOLVED | The previously cited calculator midpoint test (`~L635`) partitions evidence between segments inside one shift; it has no assignment rows or same-day slots. `attendance-work-date-resolver-w2.db.test.ts`, "same date multiple published shifts with overlapping windows..." (`~L219`), seeds two slots but asserts only a non-exact ambiguity, so an implementation that treats every assignment row as a match could pass. Merge SHAs `aebac4f8bef344b3ff3443ee045439c789a569a1` and `f1e390977e57dc1239e312c7423f3cda2d1f055f`. No current leg proves selection of a later containing row over an earlier non-containing row. |
| CALC-06 | no-window and multiple-window matches return the ratified unresolved/ambiguous outcome | UNRESOLVED | The previous calculator citations cover out-of-attribution evidence and duplicate punch cells, not work-date-window cardinality. The multiple-window half is supported by `attendance-work-date-resolver-w2.test.ts`, "actionable ambiguity when two current-day slots both contain the punch (no row-order)" (`~L344`), including exact candidate identities and order independence. The no-window real-DB leg in `attendance-work-date-resolver-w2.db.test.ts` (`~L521`) asserts only `kind === 'unresolved'`, not the ratified `NO_MATCHING_SHIFT` reason. Merge SHA `f1e390977e57dc1239e312c7423f3cda2d1f055f`. With one half incomplete, the row remains unresolved. |
| CALC-07 | approved overtime extends only the named window | SATISFIED | same file, "bounded approved overtime WITH a punch extends payable time, clipped to the exact approved interval" (`~L926`). Merge SHA `aebac4f8bef344b3ff3443ee045439c789a569a1`. |
| CALC-08 | next-day shift overlap → ratified precedence/ambiguity | SATISFIED | `attendance-work-date-resolver-w2.db.test.ts`: "open previous-night record wins over current-day containing shift at boundary" (`~L192`), "same date multiple published shifts with overlapping windows → ambiguous (no row-order)" (`~L219`). Merge SHA `f1e390977e57dc1239e312c7423f3cda2d1f055f` (#4567, 2026-07-24). |
| CALC-09 | flex late-arrive/late-leave and early-arrive/early-leave | SATISFIED | `w5-flex-segment-calculator.test.ts`: "resolves late-arrive / late-leave flex expectation and applies grace after" (`~L275`), "resolves early-arrive / early-leave flex expectation" (`~L355`). Merge SHA `7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab` (#4748, 2026-08-04). |
| CALC-10 | core-hours violation | UNRESOLVED | same flex file, "fail-closes corrupt frozen core policy as review_required/input_schema_invalid..." (`~L193, 212`), "runs authoring-valid core-hours flex without inventing a core reasonCode" (`~L410`) — plausible core-hours coverage, but no test title uses the word "violation"; below the SATISFIED bar and not established absent. |
| CALC-11 | DST gap/fold and two non-UTC timezones | UNRESOLVED | DST half found: `w4c1-segment-calculator.test.ts` describe block `~L752-845` — gap (`~L762`), fold-start (`~L779`), fold-end (`~L801`), shared-fold (`~L828`), invalid timezone (`~L845`). "Two non-UTC timezones" specifically — no test title distinguishes two vs. one non-UTC zone; half unevidenced. |
| CALC-12 | group switch at the effective boundary | UNRESOLVED | Not found this round in the files checked (`w4c1-segment-calculator.test.ts`, `attendance-calculation-group-membership-w1.db.test.ts`). Not guessed or established absent. |
| CALC-13 | historical record snapshot unchanged after configuration edits | UNRESOLVED | QA handoff G4 pattern, already cited at this document's §3.1 "Frozen evidence immutability" row (post-freeze policy edits do not move stored bytes; trigger rejection `W4C0_IMMUTABLE`) — a narrative process reference, not a titled suite; structurally cannot produce the merge-SHA-plus-test pair the SATISFIED bar requires. |
| CALC-14 | a backdated import/correction uses policy as-of the business work date, not the submission timestamp | UNRESOLVED | Not found this round. Not guessed or established absent. |
| CALC-15 | a legacy daily result remains `envelope_legacy` and receives no fabricated segment rows | UNRESOLVED | `attendance-shift-segments-writer-matrix.db.test.ts` "creates a legacy-envelope shift with a persisted segment 0 (dual-write)" (`~L358`) — about shift creation, not a daily calculation *result* row; plausible but not a confirmed match. Below the SATISFIED bar. |

**EP-01 — Entry-point parity (composite, §7.3)**

§7.3 is a single prose clause, not a bulleted list: "The same work-date cases
run through live punch, import, approved correction, approved overtime, and
recomputation. Replacing any caller with calendar-date fallback must make
its parity test fail." This mapping represents that single prose clause as one composite item,
**EP-01**, covering **five entrypoints** — live punch, import, approved
correction, approved overtime, recomputation — **plus** the fallback
mutation ("replacing any caller with calendar-date fallback must make its
parity test fail"). **缺一即保持 OPEN**: EP-01 is discharged only when all
five entrypoints' parity legs AND the fallback-mutation leg are each
individually evidenced; missing even one leaves the whole composite OPEN.

| ID | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| EP-01 | Composite: the same work-date cases pass through all five named entrypoints (live punch, import, approved correction, approved overtime, recomputation) with matching results, AND replacing any one caller with calendar-date fallback makes that caller's parity test fail. | OPEN | No suite was found this round asserting the full cross-entrypoint parity property as a single mechanism, nor per-entrypoint parity legs for all five callers, nor the fallback-mutation leg. §7.4's MUT-07 ("recompute with current rather than frozen policy") is a related but distinct mutation on a different property; it does not discharge EP-01's own fallback-mutation leg. Zero of the six required legs (5 entrypoints + 1 fallback mutation) confirmed this round, so the composite stays OPEN. |

**§7.4 Mutation (MUT-01..MUT-08) — all UNRESOLVED this round.**

| ID | Named mutation | Verdict | Evidence |
| --- | --- | --- | --- |
| MUT-01 | reintroduce first-to-last work-minute arithmetic | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-02 | remove one segment from the sum | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-03 | select the first overlapping group | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-04 | use grace as attribution tail | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-05 | choose the previous work date on ambiguity | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-06 | remove org scope from every new query | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-07 | recompute with current rather than frozen policy | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |
| MUT-08 | accept multi-segment flex in v1 | UNRESOLVED | No titled test found this round; the search was not sufficient to establish absence. |

None of these eight named mutation legs were found as titled tests in the
files checked this round. This is consistent with, though not proof of, Gate
A (§5 ledger L10): the segment calculator's mutation-tested surface found
above (`w4c1-segment-calculator.test.ts`) exercises the pure function, but
§7.4's mutations are phrased against an *authoritative* calculation path
that `SEGMENT_CALCULATION_IMPLEMENTED = false` keeps from ever running in
production. Whether any of the eight already exist as untitled assertions
inside a broader `it()` block is unverified — a title-level sweep cannot see
that — so these stay UNRESOLVED rather than credited from the absence of a
negative finding.

**§7.5 Frontend (FE-01..FE-07) — all UNRESOLVED this round**, exactly as this
line's own review anticipated.

| ID | Named check | Verdict | Evidence |
| --- | --- | --- | --- |
| FE-01 | editor keyboard and screen-reader flow | UNRESOLVED | Not searched this round (see note below). |
| FE-02 | segment order and overlap validation | UNRESOLVED | Not searched this round. |
| FE-03 | responsive 375, 768, and 1440 pixel views | UNRESOLVED | Not searched this round. |
| FE-04 | source/effect labels in every group policy summary | UNRESOLVED | Not searched this round. |
| FE-05 | no save request from preview-only controls | UNRESOLVED | Not searched this round. |
| FE-06 | no raw ID fallback | UNRESOLVED | Not searched this round. |
| FE-07 | route return preserves group and stage | UNRESOLVED | Not searched this round. |

No `apps/web` test file was searched for these this round (out of this
round's budget) — an absence-of-search, not a confirmed absence of tests;
recorded as UNRESOLVED-and-unsearched rather than OPEN-and-confirmed-unmet so
a later round does not read this as "checked, found nothing."

**Verdict tally over the 43** (counted directly from the tables above, not
estimated): **13 SATISFIED** (DB-01..07, DB-09, DB-12 = 9; CALC-03,
CALC-07..09 = 4); **1 OPEN** (EP-01, with none of its six component legs
confirmed); **29 UNRESOLVED** (DB-08, DB-10, DB-11 = 3; CALC-01, CALC-02,
CALC-04..06, CALC-10..15 = 11; MUT-01..08 = 8; FE-01..07 = 7); **0
REMOVED**. `13 + 1 + 29 + 0 = 43`. Zero REMOVED verdicts
proposed this round: that state requires an owner decision per ID, and none is
cited here.

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
   identically. Former CI-proof precondition (ledger L8), **now MET**: the
   real-DB suite proving the 8-cell report end-to-end
   (`attendance-w4c3b-request-snapshots.db.test.ts`) executed nowhere in CI at
   this document's pinned baseline; **PR 4805 MERGED**
   `4c28467c54f376ad5a68718d3dbe6ad50c76a917` two-point wires it (re-verified
   against `origin/main@3767d87c`, §1 spine row). Its executed-green run on
   the actual W8 head, with per-file counts, is still owed before this item's
   report may be cited as CI-proven — the wiring gap that made that
   impossible is closed, the execution obligation is not;
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

**Executability at the W8 head, per rung — refreshed after PR 4839.** As
written, this contract still cannot complete: day 1, a two-segment shift gets
422 from `assertSegmentCalculationAllowed` (§5 ledger L10, Gate A), and once
`authoritative`, the first live or scheduled punch 503s
(`W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED`, §5 ledger L12, Gate D). The former
missing-command blocker is closed: PR 4839 landed a shipped `plan`/`apply`
caller and runbook (§5 ledger L11). No command execution is evidenced or
authorized merely because that code is on `main`.

| Rung | Executable at the W8 head? | Blocked on |
| --- | --- | --- |
| Entry 1 (owner authorization for staging org) | Executable — governance action, no code dependency | — |
| Entry 2 (deployed SHA / migrations / health) | Executable — infra check | — |
| Entry 3 (named synthetic org only, no wildcard/customer data) | Executable — scoping decision | — |
| Entry 4 (every entrypoint represented) | **Blocked** — live punch and scheduled entrypoints 503 the instant posture is `authoritative`; any multi-segment shift 422s regardless of posture | Gate A (multi-segment 422) + Gate D (live/scheduled 503) |
| Entry 5 (W4C-5 §3 predicate set, all-clear inside the transition transaction) | Executable in code through PR 4839's `plan`/`apply` path; no live action is authorized or recorded | — (runtime authorization remains an external governance gate) |
| Entry 6 (expected-differences roster finalized) | Executable — doc/config work | — |
| Entry 7 (sweep observability counters healthy) | Executable — counters read regardless of posture | — |
| Entry 8 (P16 inventory) | Executable — static review | — |
| Entry 9 (negative transition test exists for the zero-unresolved-review gate) | Executable as a test-suite property and through the landed operator path; no live observation is claimed before a separately authorized run | — |
| Entry 10 (evidence manifest carries authorization ref + target state + entrypoint inventory + dates) | Executable through the landed CLI's validated manifest contract; no real manifest has been populated or accepted | — |
| Entry 11 (standing: no production deploy/flag action) | Executable — a prohibition requires no action to satisfy | — |
| Exit 1 (≥ 7 days in target posture) | **Blocked** — the authoritative target is still unusable for live/scheduled entrypoints, and multi-segment scope remains disabled | Gate A + Gate D |
| Exit 2 (zero critical diffs / zero unresolved reviews over the window) | **Blocked** — no valid window exists without exit 1 | Gate A + Gate D |
| Exit 3 (reversal + suspend/resume drills) | **Blocked** — drills eventually exercise the still-undelivered authoritative entrypoints | Gate D |
| Exit 4 (valid pointers, unchanged historical hashes across the window) | **Blocked** — no valid window exists | Gate A + Gate D |
| Exit 5 (PASS marker + residue zero) | **Blocked** — there is no valid completed run to mark PASS | Gate A + Gate D |
| Exit 6 (off-roster diffs dispositioned) | **Blocked** — no valid run produces the required diff set | Gate A + Gate D |

**Net**: of 11 entry items, 10 have no remaining product-code blocker in the
category their rows describe, and 1 is blocked — row 4, on Gate A + Gate D.
This is not an authorization and records no live evidence: entries 5, 9, and
10 still require a separately owner-authorized operator run before W8 may cite
them as live observations. Of 6 exit items, **all 6** remain blocked by the
Gate A/Gate D dependency chain. PR 4839 closed Gate C's missing-caller
implementation gap only; it did not clear either remaining product blocker or
start a soak clock.

Conditional: if the owner adopts W7, the same contract runs a second time for
the W7 cutover posture (the W7 lock's OD-W7-8/soak markers); OD-W8-2 decides
whether the two soaks may overlap on the calendar.

## 5. Reconciliation ledger (parked debts enumerated to date, with disposition slots)

This heading previously read "every one" — an absolute claim this document
cannot back mechanically (there is no enumerable universe of "every possible
parked debt" to check against) and which this exact round falsified in
practice: gates A, C, and D (L10-L12) existed and were mechanically verifiable
before this round, named nowhere in this ledger despite W7 recording Gate A's
fact directly. "Every one" is retired in favor of the honest claim this
section can actually stand behind: every debt found by the #4804 gate and
every debt this document's own re-verification surfaces is listed, and W8-R7
re-derives the set against the then-current main before execution rather than
trusting this list's completeness.

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
| L6 | W6/W7 conditional debts: whatever OD-W6-*/OD-W7-* choices leave deliberately out (e.g. employee self-projection of the aggregate, OD-W6-5; per-group punch enforcement, OD-4556-9). | respective locks | Re-verified 2026-08-11 at `origin/main@3767d87c`: PR 4821 has landed the RATIFIED OD-W6-0..9 record, prospectively authorizing W6-1 only. PR 4849 remains Draft/HOLD and unmerged at `c2ac8284ab38756133c74ce54fde50d07d5bf13a`; W6-2/3/4 and every W7 decision remain unlanded. The route literal is still confined to the design lock and out-of-build draft, and the backend contains only the types-only W6 contract, so no W6 runtime is on main. The earlier whole-attendance-subtree empty-diff proof is retired because PR 4839 legitimately changed unrelated W4C files in that subtree. | Listed with the owning lock, not silently absorbed into issue 4556. The W6 decision record is settled; W6/W7 implementation remains open, and W8-R7 re-derives it on the W8 head. |
| L7 | Wave-5 explanation-surface posture-ceiling revision once W4 evidence is authoritative anywhere (named cross-lane follow-up; must not be done unilaterally by this lane). | W4 lock §10.3 (`:2386-2403`) | Not started | Ledger row naming the owning lane; not a #4556 closure blocker unless the owner rules otherwise |
| L8 | CI wiring gap: two of the original 40 `attendance-w4c*.db.test.ts` suites (`attendance-w4c3b-request-snapshots.db.test.ts`, `attendance-w4c3b-central-approval.db.test.ts`) were in neither the plugin-tests real-DB run-list nor the vitest no-DB exclude — their DB-gated blocks skip-greened and executed nowhere in CI. The request-snapshots suite is the real-DB proof of the 8-cell soak-entry precondition (#4775 arc, PR #4780). The wiring guard (`attendance-w4c2-ci-wiring.test.mjs`) could not catch this: its `FILES` constant was a hardcoded allowlist, not a completeness assertion. | This document (§1 spine row; found by the #4804 adversarial gate); fix **PR 4805 MERGED** `4c28467c54f376ad5a68718d3dbe6ad50c76a917` (2026-08-10T06:59:23Z) | **Fixed and landed** (an earlier round of this cell read "PR 4805 OPEN, unmerged" — accurate at that round's rebase base, superseded here). Re-verified 2026-08-11 against `origin/main@3767d87c`: both named files appear in the real-DB run-list (step `id: attendance-real-db-integration`) **and** in `vitest.config.ts` `test.exclude` — two-point wired; 41 files on disk now match `attendance-w4c*.db.test.ts`, all 41 are carried; the run-list carries 102 total whole-file args after PR 4839 added its own two-point-wired W4C-5 suite; `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`'s own header records the conversion from the hardcoded `FILES` allowlist to a derived-completeness assertion (OBS-1, re-read at the current tip). | **Row stays live; its requirement changed from fix to re-verify-and-execute.** The wiring gap that blocked *starting* §3 is closed. What remains, per this section's preamble (which this plan cannot pre-stamp): the two previously-orphaned suites must actually run green on the W8 head with non-zero per-file counts (W8-R3/R4) before their evidence counts — a merged wiring fix is not the same claim as an executed green run, and W8-R7 re-derives this row's landed-state against the then-current main rather than trusting this round's re-count. |
| L9 | Parent §10 item 8 has **no landed implementation**: the four-label group workflow (effective / inherited / preview-only / conflicting) belongs to W6, while `conflict_action_required` remains confined to the types-only contract, fixtures, and out-of-build OpenAPI draft; the panel shell is still unmounted. | Parent lock §10 item 8; W6 lock RATIFIED via PR 4821 | Re-verified at `origin/main@3767d87c` by direct route/label/panel-reference searches. PR 4849 is only the unmerged W6-1 backend candidate; W6-3 UI remains unauthorized. | The decision direction is settled, but implementation is open. Without W6-3 UI, parent item 8 cannot be satisfied and issue 4556 cannot close under the ratified §10; changing that outcome requires owner amendment OD-W8-1(b). W8-R7 re-derives this row on the W8 head. |

| L10 | **Gate A — multi-segment calculation is OFF, and no org-level value can turn it on.** `plugins/plugin-attendance/lib/attendance-shift-service.cjs:60` — `const SEGMENT_CALCULATION_IMPLEMENTED = false`, short-circuited at `:495` (`if (!SEGMENT_CALCULATION_IMPLEMENTED) return false`) **before** the org env-allowlist is even read (the allowlist read is unreachable code for this purpose). Its call site, `assertSegmentCalculationAllowed` (`:1075`, invoked via `assertWorkContextSegmentCalculationAllowed`, `index.cjs:8351`), throws `HttpError(422, SHIFT_SERVICE_ERROR.MULTI_SEGMENT_CALCULATION_DISABLED)` for any shift with more than one persisted segment. The comment at `:57-59` names the discipline: an env value alone must never make reference writers accept multi-segment shifts, and W4 "must flip this only in the same reviewed change that adds the calculator." W4C-1 landed the calculator; the constant was never flipped in the same or any later change. | `attendance-shift-service.cjs:57-60, 495, 1075`; `index.cjs:8351` | Verified 2026-08-10 against `origin/main@d78b27d3`: constant is `false`, short-circuit precedes the allowlist read, `assertSegmentCalculationAllowed` throws 422 unconditionally for `segmentCount > 1`. W7 §1.1 records this fact and stops there (no ledger row, no soak-blocking consequence drawn); this document was silent on it entirely before this round. | **New, OPEN.** This is a hard blocker to §4 soak entry item 4 ("every entrypoint represented") for any multi-segment shift and to §4 exit generally, until the owner either (i) authorizes flipping the constant in the same reviewed change W4's own comment requires, or (ii) explicitly re-scopes the soak to single-segment shifts only via OD-W8-1(b). Silence is not a disposition. |
| L11 | **Gate C implementation gap — CLOSED by PR 4839; execution remains owner-gated.** The operator CLI now imports and calls `transitionAttendanceCalculationRolloutV1` through its tested `plan`/`apply` orchestration, so the former "tests only" statement is no longer true. | `scripts/ops/attendance-w4c5-rollout-transition.ts`; `docs/development/attendance-issue-4556-w4c5-operator-runbook-20260809.md`; PR #4839 merge `60afbffe07bfddc7f32ff08549e36e995662b228` | Re-verified 2026-08-11 against `origin/main@3767d87c`: the CLI and runbook are present; the merge commit is an ancestor of main; the runbook's non-authorization notice forbids staging, flag, deployment, soak, production/customer data, and issue closure. No tool execution or rollout transition is claimed. | **SATISFIED as a code-delivery debt, not as runtime evidence.** W8 may now use the shipped command after a separate owner authorization. Gate A and Gate D remain independent product blockers, and the soak clock has not started. PR 4839 also landed the manually invoked `scripts/ops/claim-sweep.mjs`; its own header explicitly says no CI automatically runs arbitrary document/body sweeps. |
| L12 | **Gate D — authoritative write execution is undelivered at exactly the two entrypoints §4 names first, deliberately and by design.** `w4c2-live-scheduled-boundary.ts:1272` (live punch), `:1878` (scheduled absence), `:2072` (scheduled run) each call `boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', 503)` when posture/write-posture is `authoritative`; module header `:69-72` states this in prose ("effective `authoritative` write execution itself is NOT delivered by this slice ... the state is unreachable in production"). This is a deliberate, **tested** fail-closed state, not a bug: `attendance-w4c2-gate-matrix-e5.db.test.ts:1079-1091` asserts 503 + the exact code + zero rows written for both the live and the scheduled path. Scope stays honest in both directions: authoritative mode **IS** delivered by four other modules without this short-circuit — `w4c3b-approved-leave-cancellation.ts`, `w4c3c-manual-edit-apply.ts`, and `w4c3c-recompute.ts` branch on `mode === 'authoritative'`; `w4c3a-legacy-plan-processor.ts` separately admits `posture.writePosture === 'authoritative'` through its posture resolver. It is precisely the two entrypoints W8 §4 entry item 4 names first (live punch, scheduled) that are not. | `w4c2-live-scheduled-boundary.ts:69-72, 1272, 1878, 2072`; `attendance-w4c2-gate-matrix-e5.db.test.ts:1079-1091`; `w4c3a-legacy-plan-processor.ts:203` | Verified 2026-08-11 against `origin/main@3767d87c`: all three fail-closed call sites and the paired test assertions were confirmed; the first three delivering modules branch on `mode === 'authoritative'`, while the legacy-plan processor's distinct `posture.writePosture === 'authoritative'` path was confirmed separately. W8 §4 (pre-this-round) named live punch and scheduled as the first two soak-entry entrypoints without disclosing this. | **New, OPEN.** This is a hard blocker to §4 exit generally (an org cannot spend 7 days "in the target posture" if the two highest-volume entrypoints 503 the instant posture reaches `authoritative`) and specifically undermines entry item 4's "every entrypoint represented." Disposition is the owner's: (i) authorize delivering the live/scheduled authoritative write path (its own gated PR, its own real-DB + mutation gate, same class as W4C-3a/b/c), or (ii) explicitly re-scope soak entry to the four already-delivering entrypoints only, via OD-W8-1(b), with live punch and scheduled named as a residual not yet in scope. |

Any debt discovered between this baseline and W8 execution joins the ledger;
an empty-looking ledger at W8 time triggers a re-scan against the then-current
main, not a celebration (empty-read ≠ absence).

### 5A. Issue acceptance ledger (parent §9.9 deliverable 3 — NEW in this round)

Parent lock §9.9 names three W8 deliverables: verification MD, operator
migration/rollback runbook, and **issue acceptance ledger**. §2.1 (as drafted
before this round) listed five deliverables and the acceptance ledger was not
among them; §5 above is a *different* artifact (parked debts — engineering
residue this line owes itself), not the acceptance ledger (acceptance text →
slice/PR → evidence, feeding parent §10 item 1). §2.1 is corrected to list
this as item 6.

**§10 item 1's denominator does not exist yet, and this document cannot
supply it — only the owner can.** Neither this document nor the W7 draft ever
defines what an "acceptance item" *is*, so "every acceptance item is mapped to
a merged slice or explicitly removed" (parent §10 item 1) has no countable
set to map. `OD-W8-7` (below) asks only the ledger's *form* (one MD table vs.
an issue comment); it never asked whether an acceptance-item set exists to put
in that form. `OD-W8-8` is new and asks that prior question.

Two real candidate sources exist in the tree today — not invented for this
row, both read from issue #4556's own body 2026-08-10:

- issue #4556's **验收标准 (Acceptance Criteria)** section: 7 numbered
  sentences authored by the issue's creator, e.g. "一个班次可配置多个时间段，
  并能正确计算各段工时和缺卡状态" (a shift may configure multiple time
  segments, with correct per-segment hours/anomaly computation). The most
  literal reading of "acceptance item" — but the sentences are prose, not
  independently PR-linkable, so "mapped to a merged slice" requires manual
  per-sentence adjudication, and there is no existing cross-reference from
  any of the 7 sentences to a slice/PR/decision.
- issue #4556's **建议实施拆分 (Suggested Implementation Breakdown)**
  checklist: 7 GitHub checkbox items (`- [ ]`), all 7 still unchecked as of
  2026-08-10 (`gh issue view 4556 --json body`, grep count). These are
  implementation-task-shaped, not acceptance-shaped — arguably not
  "acceptance items" in parent §10 item 1's sense at all — but they are
  already a checkbox-trackable denominator living on the issue, and GitHub
  itself would show "0/7" progress against them without any new artifact.

A third candidate is parent lock §10's own items 2-8 (the seven closure
conditions the checklist below already maps evidence slots to). Reading §10
items 2-8 side by side with #4556's 验收标准, they closely paraphrase each
other item-for-item (multi-segment minutes ~ AC #2; flex distinct from grace ~
AC #3; effective-dated group switch ~ AC #4; etc.) — suggesting §10 items 2-8
may already **be** the lock's own elaboration of the issue's 验收标准, which
would make item 1 self-referential rather than pointing at a fourth,
undiscovered list. That reading is offered as evidence for `OD-W8-8`, not
adopted here.

**The acceptance ledger table itself** (once `OD-W8-8` and `OD-W8-7` are both
answered): one row per acceptance item (from whichever source the owner
names), columns `acceptance text → owning slice/PR → evidence link →
disposition (merged / explicitly removed by owner decision, citing which)`.
Every cell empty until execution; this document does not pre-fill it.

## 6. Closure checklist feeding the owner's §14-10 ruling

The checklist maps the parent lock's §10 closure definition (lines 764-777),
item by item, to evidence slots. W8 fills slots; **the owner rules**.

| §10 item | Evidence slot (filled by) |
| --- | --- |
| 1. Every acceptance item mapped to a merged slice or explicitly removed by an owner decision | Issue acceptance ledger (§2.1 item 6, §5A) with per-item PR/decision references. **Corrected pointer**: an earlier draft of this cell cited "§2.1.4", which is the closure checklist (this section), not any ledger — a broken self-reference, not merely a stale one. §5A also records the deeper defect the broken pointer was masking: the acceptance ledger did not exist as a deliverable at all before this round, and "acceptance item" itself is undefined (`OD-W8-8`) — so this slot cannot be filled until both are resolved. |
| 2. Multi-segment actual minutes exclude breaks; segment anomalies exposed | W4C-1 calculator gates + §3.1 goldens |
| 3. Flex distinct from grace | W5 verification (`w5-flex-policy` suites) + §3.2 cases |
| 4. Calculation-group changes effective-dated and historically explainable | W1 membership gates + (conditional) W7 provenance legs |
| 5. All work-date entry points use the shared resolver | Resolver call-through inventory (W2 line) re-verified on the W8 head |
| 6. OpenAPI, runtime, frontend, migrations, tests agree | OpenAPI lint/build/diff + contract-equality mechanical tests |
| 7. Staging migration, rollback, synthetic accounting evidence durable | §4 soak evidence + drills |
| 8. Group workflow shows effective / inherited / preview-only / conflicting | Conditional on W6 runtime (§3.2 group-workspace family). Disclosure (ledger L9, with L6's provenance): item 8 has no landed implementation at this baseline or against current `origin/main`, and W6 is its only planned vehicle. OD-W6-0 is **RATIFIED as adopt** — PR 4821 MERGED `ecf77d2433596bbdd8b67c312a37178dbc97f715` (2026-08-08), the W6 lock header on `main` reads RATIFIED — and the authorization it carries reaches only the W6-1 backend slice (current candidate PR 4849, Draft/HOLD, unmerged, head `c2ac8284ab38756133c74ce54fde50d07d5bf13a`; PR 4814 remains open at an older head but is not the current candidate); the four-label workflow is W6-3 UI scope and remains withheld, unauthorized in any form. So this item's evidence slot stays empty and stays conditional. The counterfactual narrows rather than disappears: were the W6 runtime beyond W6-1 (W6-3 UI specifically) not to land, this item could not be satisfied and issue 4556 **could not close under §10 as ratified**; closure would then require an owner amendment to parent §10 (routed through OD-W8-1(b)). |

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
| W8-R4 | Executed-run evidence only: a row is green via run URL / log with non-zero counts; skip/absent runs are red. | For each CI-mapped row, the workflow run ID + step name + **per-file** test counts are recorded (`vitest --reporter=json`, recording `numPassingTests` for the specific named file): a step-level total over the attendance real-DB step's run-list cannot show — and that count is itself head-scoped per W8-R3, so the W8 executor re-counts it on the W8 head rather than quoting any number in this document — whether one file contributed anything — a `describe.skip` inside one suite leaves the step's totals healthy, the exact mechanism by which the L8 gap stayed invisible for as long as it did. This document's own re-counted history of that number, kept as a record of drift rather than a number to quote forward: **97** at the pinned baseline `4e6a35d9`; **98** after PR 4799 added `scratch-database-drain.db.test.ts` (counted at rebase base `5c3146ac`, 38 of them `attendance-w4c*`); **101** re-verified 2026-08-10 against `origin/main@d78b27d3` (40 of them `attendance-w4c*`, including the two former L8 orphans); **102** re-verified 2026-08-11 against `origin/main@60afbffe` (41 of them `attendance-w4c*`, after PR 4839 added its two-point-wired W4C-5 tool suite) — four different true counts across four rounds is itself the argument for re-counting on the actual W8 head rather than citing this cell. A `0 passed`, skipped, or absent per-file entry fails the row by definition; each DB-gated suite additionally carries a fail-closed guard that reds (not skips) when its DB URL is absent in a step claiming real-DB execution; run-list completeness itself is asserted by the derived-completeness wiring guard (the L8 fix, **PR 4805 MERGED**). |
| W8-R5 | Values-free evidence surfaces: soak/matrix evidence carries counts, closed codes, hashes, dates — never member lists, punch values, or secrets. | Exact-key review of every evidence artifact checked into docs; a leak probe (fixture with `userId`/`memberIds` keys) fails the artifact linter/review checklist. |
| W8-R6 | W8 adds zero runtime: the W8 deliverable PRs touch `docs/` (and, if the owner authorizes tooling, explicitly inventoried scripts) only. | `git diff <base> HEAD -- packages plugins apps scripts .github` empty for each W8 docs PR — the path list includes `scripts` (W7-R9's list) precisely because the rule conditions on scripts tooling; a list without `scripts` is structurally blind to the one directory the rule carves out. An owner-authorized tooling PR instead lists each `scripts/` path it adds against the owner's authorization reference and carries its own inventory + deletion-green proof. |
| W8-R7 | Ledger completeness is re-derived, not remembered: the §5 ledger is regenerated against the then-current main before execution. | The regeneration commands (issue queries + doc/grep sweeps) are recorded in the MD with their outputs, and the spot-check runs in **both** directions, because either alone is passable by a broken regenerator. **Positive**: a named item verified OPEN at regeneration time — issue 4792 (L3) and issue 4629 (L4) were both re-confirmed OPEN on 2026-08-08 — must appear in the regenerated ledger. **Negative**: a named item verified CLOSED must appear as *closed*, not vanish and not stay open — issue 4791 (L2) is that worked example, CLOSED COMPLETED 2026-08-07T15:44:55Z, and this document's own L2/OD-W8-3 rewrite is the recorded instance of the negative half firing. An earlier draft of this cell named only "#4791 if still open", which the closure has since made unrunnable; a spot-check whose only example can no longer fire is not a check. |

## 8. Decision points (owner menu)

OD-W8-1, OD-W8-2, OD-W8-4..7, and OD-W8-8 (new this round) are **OPEN**. OD-W8-3 is **SATISFIED** — it
is kept in place, with its ID unchanged and its row rewritten as a record, so
that every cross-reference to an OD-W8-*n* elsewhere in this document keeps
pointing at the same question.

| ID | Question | Options (recommended first) and consequences — or, for a SATISFIED row, the record that replaced them |
| --- | --- | --- |
| OD-W8-1 | Adopt this plan as the W8 contract | **(a)** Adopt (amendable by its own process). (b) Re-scope W8 — any narrowing of parent §10 coverage is an owner-level contract change, recorded per-item, never a silent drop. |
| OD-W8-2 | Soak topology | **(a)** Two sequential soaks if W7 lands (W4-authoritative soak, then W7-cutover soak), calendar-parallel work allowed on other lanes. (b) One combined soak — shorter calendar, but a critical diff becomes ambiguous between the segment engine and the policy source; only acceptable if the owner rules the attribution ambiguity tolerable. |
| OD-W8-3 | Disposition of the teardown flake on a required check (issue 4791) | **SATISFIED — nothing left to rule on; this row records an event, it does not report a choice.** An earlier draft of this row offered the owner "(a) fix before W8 execution / (b) owner-accepted residual with a rerun protocol". That menu was already void when written down: the flake had been fixed and the issue closed. Retracted and replaced by the record, verified 2026-08-08 with the commands in §10. **What landed:** PR 4799 merged 2026-08-07T15:18:34Z as merge commit `51c3d8720789476efa15f6b99b6dc5f51df4743b`, verified an ancestor of this document's rebase base `5c3146acbc81b655e62bee9249b68eaec4e6e4c6`. **What it does:** removes the failure source instead of muting it — `ALTER DATABASE … ALLOW_CONNECTIONS false`, then poll `pg_stat_activity` until no other backend remains, then a **plain** `DROP DATABASE`, forcing only if the drain times out (`packages/core-backend/tests/helpers/scratch-database.ts`). Nothing is terminated, so there is no `pg_terminate_backend` for `pg` to surface as an ownerless `'error'` event on a pooled client — the mechanism that produced "all tests pass, exit code 1". **The criterion it had to meet, and why "CI went green" was explicitly not it:** a forced drop *is* the pre-fix behaviour, so a green run cannot distinguish "the drain worked" from "this run got lucky" — the issue therefore did not close on PR 4799's merge. The criterion was the unconditional `scratchDrain=` line that both real-server call sites now print reporting `CLEAN` **on main's own required gate**. **Met:** workflow run 31191954460 (`Plugin System Tests`, `event=push`, `headBranch=main`, `headSha` byte-equal to `51c3d872…`), required check `test (20.x)` = success — `test (20.x)` being one of the nine contexts in main's required-status-check set. Grep over that job's full log returns both call sites clean — `scratchDrain=CLEAN suite=bpmn-poller-disabled drainMs=66 residualBackends=0` and `scratchDrain=CLEAN suite=w4c2-sweep-call-through drainMs=74 residualBackends=0` — with `scratchDrain=FORCED`, `57P01`, and `Unhandled Errors` each at count 0. (The non-required `test (18.x)` leg carries a third `CLEAN`, `drainMs=277`; the required-gate claim rests on the two lines above, not on that one.) **State:** issue 4791 CLOSED as COMPLETED 2026-08-07T15:44:55Z; the rollup issue 4796 closed on the same evidence at 2026-08-07T15:45:30Z. **Residual, not erased:** those zeros are grep counts over one job log at one SHA, not a proof that the race cannot recur; the issue's own closing note keeps the reopen path, since a future `scratchDrain=FORCED` line names the component still holding a connection in `holders=[…]`. Ledger row L2 therefore stays live in §5 as a W8-head **re-verification** item (W8-R7 re-derives the ledger anyway). **No owner ruling occurred:** the outcome coincides with what option (a) aimed at, but the owner was never asked and did not choose — do not read this row as "(a) was selected". |
| OD-W8-4 | Disposition of the #4629 manual matrix | **(a)** Author `PQA-W8-*` against the W8 head and formally retire #4629's checklist by owner note on that issue. (b) Complete #4629 as-is first — exercises a superseded head; only worth it if the owner wants the historical candidate's evidence completed. |
| OD-W8-5 | FSER-4 §3-§4 relative to #4556 closure | **(a)** Track under #4709, outside the #4556 closure set; the ledger row records the owner's explicit exclusion. (b) Pull into the #4556 closure set — couples closure to separately deferred and unauthorized FSER-4 §3-§4 delivery; the already-ratified `OD-4709-2=(a)` authorized and delivered §2 only and does not authorize §3-§4. |
| OD-W8-6 | Customer-acceptance evidence standard (parent §9.9) | **(a)** Closure checklist item 1 may complete with synthetic-staging evidence only, and the verification MD states plainly that no customer-acceptance claim is made. (b) Require a named customer evidence artifact before the checklist is handed over — delays closure input until a customer engagement exists. |
| OD-W8-7 | Acceptance-ledger form | **(a)** One MD table in `docs/development/` (per-item: acceptance text → slice PR/owner decision → evidence link), reviewed like code. (b) Issue-comment ledger on #4556 — closer to the issue but unreviewable and mutable; rejected by default. |
| OD-W8-8 | **New this round (§5A).** What is an "acceptance item" | The denominator parent §10 item 1 requires but never defines, and that neither the parent lock, W7, nor this document (before this round) ever supplied. No option is recommended-first here: the two real candidates carry genuinely different W8 cost and neither is this document's to pick. **(a)** Issue #4556's own **验收标准** section — 7 numbered prose sentences authored on the issue. Most literal reading of "acceptance item"; costs a manual per-sentence adjudication pass (no existing PR/decision cross-references) to populate the ledger, and the sentences may not partition cleanly against landed PRs (a PR can satisfy part of one sentence and part of another). **(b)** Issue #4556's own **建议实施拆分** checklist — 7 GitHub checkboxes, currently 0/7 checked. Already checkbox-trackable with zero new tooling, but these are implementation *tasks*, not acceptance *criteria* — adopting this reframes closure around "was the planned work done" rather than "does the result meet the stated bar," which is a different question than parent §10 item 1 asks. **(c)** Treat parent lock §10 items 2-8 (already itemized, already the closure checklist's own spine) as the acceptance-item set, on the observed near-1:1 paraphrase with #4556's 验收标准 (§5A) — costs nothing new to enumerate, since §6 already builds evidence slots against these 7 items, but risks item 1 becoming self-referential (mapping the §10 checklist to itself) rather than checking against the issue's own stated bar, and does not resolve whether #4556's 验收标准 wording independently matters. Whichever the owner picks, the acceptance ledger (§5A) is built against that denominator, not a fourth invented one. |

## 9. Landing sequence

1. Owner instructs merge of the docs-only Draft/HOLD PR carrying this
   document and the W7 draft lock (the PR stays Draft + HOLD until that
   explicit instruction; nothing here self-authorizes it) — merging records
   the plan; it authorizes nothing.
2. Owner answers OD-W8-1, OD-W8-2, and OD-W8-4..8 (OD-W8-3 is already
   SATISFIED; W8 execution cannot start before W7 completes regardless).
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
- L8 wiring evidence — **the gap this evidence chain tracked is now closed**
  (found by the #4804 adversarial gate; tracked through five rebase rounds
  while `PR 4805` was open; re-verified 2026-08-11 against
  `origin/main@b4ec95146a11d2155de17654d69b0c241953a8f0`, after `PR 4805`
  MERGED `4c28467c54f376ad5a68718d3dbe6ad50c76a917`):
  `.github/workflows/plugin-tests.yml` no-DB core-backend test step ("Run
  core-backend tests", no `DATABASE_URL`, `~L689` at the current tip — this
  anchor drifted at every prior round too: `:553` at the pinned baseline,
  `:606`/`:608` at intermediate rebase points; located by step **name**, never
  by line number, because the drift moves citations, not findings), the
  attendance real-DB run-list step (`id: attendance-real-db-integration`,
  located by step ID at the current tip); the **facts**, re-counted at
  `3767d87c`: 41 files on disk match `attendance-w4c*.db.test.ts`, the step now
  carries 102 whole-file args of which 41 are `attendance-w4c*` — **both** former L8 files
  (`attendance-w4c3b-request-snapshots.db.test.ts`,
  `attendance-w4c3b-central-approval.db.test.ts`) are present in the run-list;
  `packages/core-backend/vitest.config.ts` `test.exclude` now carries both L8
  files (two-point wiring complete);
  `packages/core-backend/tests/integration/attendance-w4c3b-request-snapshots.db.test.ts:14-15`
  and `attendance-w4c3b-central-approval.db.test.ts:54-55`
  (`describeIfDatabase` skip gates — now gating a real-DB-fed run, not a
  nowhere-executed one);
  `scripts/ops/attendance-w4c2-ci-wiring.test.mjs` header (re-read at
  `3767d87c`): the `FILES` hardcoded allowlist is gone, replaced by the OBS-1
  derived-completeness corpus walk it documents in its own comment block

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

GitHub state, **re-queried 2026-08-11 against current
`origin/main@b4ec95146a11d2155de17654d69b0c241953a8f0`** (this branch has
been caught up to this exact main tip; the older `5c3146ac…` base remains
historical provenance only — the
2026-08-08 round's line recorded PRs 4805/4821 as OPEN/unmerged; both have
since merged, so that line is superseded, not merely re-dated):

- Issues OPEN: 4556; 4629 (PQA-01..10 all still unchecked, PQA-10 still marked
  BLOCKED — re-read this round: 10 `- [ ]`, 0 `- [x]`); 4709; 4770; 4775; 4792
  (timeCycle residue, zero comments).
- Issues CLOSED: **4791** (57P01 teardown flake) — CLOSED as COMPLETED
  2026-08-07T15:44:55Z; **4796** (its cross-PR rollup) — CLOSED
  2026-08-07T15:45:30Z on the same evidence. See ledger L2 and OD-W8-3.
- PRs MERGED: 4771 (W6 prep, merge commit
  `2967da018ceea41b91098e14d4c15a57236eb5f8`); 4772 (FSER-4 §2 `/me` route,
  2026-08-05T15:54:09Z — see L1); 4773; 4774; 4779; 4780; 4799
  (`51c3d8720789476efa15f6b99b6dc5f51df4743b`, 2026-08-07T15:18:34Z, the
  issue-4791 fix); **4821** (durable W6 RATIFY record, merge commit
  `ecf77d2433596bbdd8b67c312a37178dbc97f715`, merged 2026-08-08T10:41:37Z —
  see ledger L6/L9); **4805** (L8 CI-wiring fix, merge commit
  `4c28467c54f376ad5a68718d3dbe6ad50c76a917`, merged 2026-08-10T06:59:23Z —
  see ledger L8, now landed); **4839** (W4C-5 operator transition CLI and
  runbook, merge commit `60afbffe07bfddc7f32ff08549e36e995662b228`, merged
  2026-08-11T03:46:49Z — Gate C implementation landed; execution remains
  separately owner-gated).
- PRs OPEN / unmerged: **4849** (current clean-rebuild W6-1 backend candidate,
  Draft, head `c2ac8284ab38756133c74ce54fde50d07d5bf13a` — the current PR whose
  merge would put W6-1 runtime on `main`); **4814** (older W6-1 candidate,
  still Draft/open/unmerged at head
  `4cc0122883846900a1325cdacd5eda0355d77215`, not the current delivery
  candidate). Naming either authorizes neither.

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

Former companion CI-wiring fix, **now landed**: **PR 4805**
(`fix(ci): OBS-1 — wire the two orphan W4C-3b real-DB suites; convert
attendance wiring guard to derived completeness`), MERGED
`4c28467c54f376ad5a68718d3dbe6ad50c76a917` 2026-08-10T06:59:23Z (an earlier
round tracked it OPEN at heads `40dfd4f3` then `2985e03c`; both superseded by
the merge), branch `claude/wire-orphan-w4c3b-suites-20260807`, touching
`.github/workflows/plugin-tests.yml`, `packages/core-backend/vitest.config.ts`,
`scripts/ops/attendance-w4c2-ci-wiring.test.mjs`, and one unrelated rebase
artifact. Its landing is what discharges ledger row L8 above and the §1/§3.3/
§4-item-5 corrections in this round. It authorizes no W8 runtime by itself —
it is a CI-tooling fix, not a rollout-transition or soak action.

Former Gate C companion, now landed: **PR 4839**
(`[HOLD] feat(attendance-w4c5): operator transition tooling + executable
runbook`), MERGED as `60afbffe07bfddc7f32ff08549e36e995662b228` from exact
head `f9127df5ae9a63d4b2dfcd50fcf7fd54949940b3` after 9/9 required checks and
an independent exact-head 0 P1/P2 gate. See ledger row L11. The landing closes
the missing-caller implementation gap only; its own body and runbook explicitly
withhold tool execution, staging, flags, deployment, soak, production/customer
data, and issue closure.

Commands behind this block (re-run 2026-08-11; recorded so W8-R7's
regeneration can be reproduced rather than trusted): `gh issue view <n> --json
number,state,stateReason,closedAt`; `gh pr view <n> --json
number,state,isDraft,mergedAt,mergeCommit,headRefOid,statusCheckRollup`;
`gh run view 31191954460 --json event,headSha,conclusion` plus `gh run view
--job <id> --log -R zensgit/metasheet2` piped through `grep -c`; `gh api
repos/zensgit/metasheet2/branches/main/protection --jq
'.required_status_checks.contexts'`; `git merge-base --is-ancestor <sha>
origin/main`; `git grep -ln <symbol> origin/main -- .` filtered by `grep -v`
against test-file and defining-module paths (Gate C, now expected to find the
landed CLI); and, for the L8/W8-R4
re-count, a walk of the `id: attendance-real-db-integration` step's own arg
list rather than a fixed-width slice of the workflow file.
