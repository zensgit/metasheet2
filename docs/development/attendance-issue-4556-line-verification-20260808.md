# Attendance issue 4556 — Line-Level Verification Record

> **Baseline:** `origin/main@a45e1416002e6ca500eeda8d70e86c6443a10700`
> — `feat(directory): harden deprovision evidence ledger (#4646)`, 2026-08-08 11:44:26 +0800.
> Every ancestry verdict, file:line citation, and blob-derived count below is scoped to this SHA
> unless explicitly labelled otherwise.
>
> **One class of number is deliberately excluded from that scoping: check-run rollups.** A SHA does
> **not** pin a rollup — check runs are mutable and re-runnable, so counts of success/failure/skipped
> at a commit are *point-in-time observations*, not properties of the commit. Every such figure below
> carries the pass on which it was read. §2.2 and §4.4 were re-read on a **second pass (2026-08-08)**
> and returned different totals from the first; both readings are recorded rather than one silently
> replacing the other.
>
> `main` has also advanced past the pinned baseline (to `bea44e12d5af45e9131d4f12ce7f0a6d2d2ffc9a` at
> the second pass, two commits on, neither on this line). **The baseline is deliberately not
> re-pinned** — re-pinning would mean re-deriving every citation in this record. Live PR state
> (heads, behind/ahead, `mergeStateStatus`) is therefore stale by construction and labelled as such.
>
> **Date:** 2026-08-08 · **Author:** verification lane (read-only) · **Status:** RECORD — not a sign-off.

---

## 0. Purpose and honest scope

This document records **what is proven on `origin/main`, by what mechanism, and what is not.**

It is **not** a sign-off, not a RATIFY, not a merge authorization, not a staging or soak
authorization, and not a closure recommendation. **It triggers nothing.** No gate described here
auto-advances any phase. Every action that this line still needs — merging a held PR, enabling a
flag, touching staging, starting the soak, closing issue 4556 — is a separate owner decision that
this record cannot supply and does not attempt to supply.

### 0.1 Three scope caveats that shape everything below

**(a) "Landed" means merged + files present at the pinned SHA.** It does not mean "green today"
unless this document names the executed check that proves it. Section 1 labels every row with an
evidence class precisely so that "landed" is never silently read as "verified".

**(b) The authorization column is doc-header-derived *plus* a GitHub comment sweep — and the two
disagree.** This line's canonical institutional failure (§3, row A) is exactly the defect of
reading an in-repo `Status: RATIFIED` header as proof of authorization when the lane had itself
merged that header. Per this repo's recorded discipline, *authorization lives where the
authorization happened (PR comment / owner relay), not in the in-repo artifact the authorized
action produced.* Accordingly this record treats owner comments as authoritative and in-repo
headers as secondary. **That sweep changed two verdicts** — see §5.2. Where I could not find an
owner comment, I say so rather than falling back on the header.

**(c) I ran no build, no typecheck, and no test suite.** Every "green" claim in this document is
either (i) a CI log I personally re-read at the pinned SHA, cited with its job ID, or (ii) marked
as not re-derived. I did not execute any of the code under review.

### 0.2 What this record is good for

Deciding *what evidence exists* before someone asks for a phase advance — and, equally, knowing
exactly which cells are empty so nobody fills them with a plausible assumption.

---

## 1. Verification inventory per phase

**Evidence classes used below:**

| Class | Meaning |
|---|---|
| `real-DB` | Executes against a live PostgreSQL in the required `test (20.x)` lane |
| `unit` | Executes in the no-DB vitest step of `test (20.x)` |
| `adversarial gate` | An exact-head independent review with a recorded verdict |
| `mutation-proven` | A mutation was applied and the guard was observed to go red |
| `doc-only` | The artifact is a document; nothing executes |
| `NOT EXECUTED` | Present in the tree, runs nowhere |

### 1.0 Phase map (authoritative source)

The canonical phase map is parent-lock §9. Re-derived by heading scan
(`grep -nE '^### 9\.'` on the blob at the pinned SHA):

| § | Line | Phase |
|---|---|---|
| 9.1 | 645 | W0 — contract parity and capability truth |
| 9.2 | 663 | W1 — effective group membership |
| 9.3 | 675 | W2 — shared work-date resolver |
| 9.4 | 687 | W3 — segment schema and authoring |
| 9.5 | 707 | W4 — segment calculation and snapshots |
| 9.6 | 719 | W5 — flexible single-segment mode |
| 9.7 | 731 | W6 — group effective-policy workspace |
| 9.8 | 743 | W7 — group policy calculation cutover |
| 9.9 | 755 | W8 — verification and closeout |

### 1.1 Ancestry verification method

Every PR→SHA pair below passed a **two-witness** check that I re-ran this session:

1. the commit resolves and is an ancestor of the pinned HEAD
   (`git merge-base --is-ancestor`, **exit-code-aware** — rc=0 ancestor / rc=1 not-ancestor /
   unresolvable object reported distinctly, so a bad SHA cannot masquerade as "not an ancestor");
2. the commit subject on main carries the literal `(#N)` suffix.

**23 rows returned `ANCESTOR SUBJ_OK`.** Three negative controls fired correctly:

- fabricated SHA `deadbeef…` → `UNRESOLVABLE` (not `NOT_ANCESTOR`) — proves the two outcomes are distinguished;
- PR 4612's API `merge_commit_sha` `61dee2d61e…` → `UNRESOLVABLE` — it is a test-merge ref, not a commit;
- PR 4805's head `40dfd4f3fb…` → `NOT_ANCESTOR` **and** `SUBJ_MISSING` — proves both witnesses can fail.

### 1.2 Phase → proving suite → CI step (the coverage map)

Derived this session by matching run-list entries to phase prefixes. **The CI step for every
real-DB row is the same one:** `plugin-tests.yml:1201`, step id `attendance-real-db-integration`,
job `test`, no `if:` pin — executed at the pinned HEAD as job `93053687144`.

**A fourth trigger surface, added on the second pass.** This map was originally built from two
sources only: the `*.db.test.ts` run-list and the no-DB vitest step. It omitted the
`scripts/ops/*.test.mjs` **contract-matrix** corpus, driven by
`scripts/ops/attendance-run-gate-contract-case.sh` under `attendance-gate-contract-matrix.yml`. That
workflow has **no push trigger** (§2.2 is correct about that) but it carries
`schedule: - cron: '45 4 * * *'` (`:3-11`) and **does run nightly on `main`**: eight consecutive
`main` runs, all `success`, 2026-08-01 (`a45a2fe3fa81`) through 2026-08-08 (run `31240958190` @
`bea44e12d5af`), including run `31150277495` @ `fceee2909612`. Evidence class **`contract matrix`**
below means: executes in that workflow, PR-scoped **and** nightly-on-main.

| Phase | Proving suite(s) on main | In run-list? | Evidence class |
|---|---|---|---|
| **W0** | `packages/core-backend/tests/integration/attendance-plugin.test.ts` (the first entry of the `:1201` real-DB step; `git show --name-only 077fde47859c…` shows PR 4558 touched it) + the two contract suites PR 4560 added under `scripts/ops/attendance-*-contract.test.mjs` | ✅ (real-DB entry) | `real-DB` + `contract matrix` |
| W1 | `attendance-calculation-group-membership-w1.db.test.ts` | ✅ | `real-DB` |
| W2 | `attendance-work-date-resolver-w2.db.test.ts` | ✅ | `real-DB` |
| W3 | `attendance-shift-segments-migration.db.test.ts`, `attendance-shift-segments-writer-matrix.db.test.ts` (9 + 33 `it()`) | ✅ (but absent from `test.exclude` — §2.4(ii)) | `real-DB` |
| W4C-0 | 6 suites: `attendance-w4c0-{concurrency-gates-e3,db-gates-e1,durable-storage-smoke,identity-gates-e2,identity-golden-parity,operation-registry}.db.test.ts` | ✅ 6/6 | `real-DB` + `mutation-proven` |
| W4C-1 | **No real-DB suite by design** — pure modules. Unit specs: `src/attendance/__tests__/w4c1-{fingerprint-gates,fingerprint-golden,merge-policy,segment-calculator,strict-time}.test.ts` | n/a — runs in the **no-DB step** of `test (20.x)` | `unit` |
| W4C-2 | 12 suites incl. `attendance-w4c2-{sweep-fairness,sweep-call-through}.db.test.ts` | ✅ 12/12 | `real-DB` |
| W4C-3a | 15 suites incl. `attendance-w4c3a-rollout-control.db.test.ts` | ✅ 15/15 | `real-DB` |
| **W4C-3b** | **4 on tree, 2 wired:** ✅ `attendance-w4c3b-approved-leave-cancellation.db.test.ts`, ✅ `…-request-operation-routes.db.test.ts` · ❌ `…-central-approval.db.test.ts`, ❌ `…-request-snapshots.db.test.ts` | **2/4** | ⚠️ **`real-DB` for half; `NOT EXECUTED` for the other half** |
| W4C-3c | 2 suites incl. `attendance-w4c3c-record-operation-routes.db.test.ts` | ✅ 2/2 | `real-DB` |
| W4C-4 | `attendance-w4c4-calculation-detail.db.test.ts` | ✅ | `real-DB` |
| W4C-5 | **Two new unit suites**, plus legs added to `attendance-w4c3a-rollout-control.db.test.ts`. The new suites are `src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts` (added by `3601817969…`, 251 lines) and `src/attendance/__tests__/w4c3b-request-snapshot-metadata-fields.test.ts` (added by `0dc3596ddb…`, 141 lines). **Both execute** at the pinned HEAD — job `93053687144` shows 7 and 15 `✓ src/attendance/__tests__/…` lines respectively. An earlier pass of this row said "No new suite"; that is **retracted** (see §1.3 W4C-5). | ✅ (the `.db` legs) · unit suites run in the no-DB step | `real-DB` + `unit` |
| W5 | `attendance-shift-flex-policy-migration.db.test.ts` + unit `w5-flex-policy.test.ts`, `w5-flex-segment-calculator.test.ts` | ✅ | `real-DB` + `unit` |
| W6-prep | **None** — 9 fixtures, no runtime | n/a | `doc-only` / inert |
| W7, W8 | **None — zero artifacts on main** | n/a | — |

> **The single most important cell in this table is W4C-3b: 2 of its 4 dedicated real-DB suites
> execute nowhere.** Every other phase's dedicated suites are fully wired.

### 1.3 Per-phase inventory

#### W0 — contract parity · PR 4558, PR 4560

| | |
|---|---|
| **Commits** | `077fde47859c` overnight-punch work-date anchoring · `9f989396b765` OpenAPI alignment |
| **Ancestry** | Both `ANCESTOR SUBJ_OK` (re-derived this session — the collected inventory had *not* two-witnessed these) |
| **Evidence class** | `real-DB` + `contract matrix` + `doc-only` (contract). **Anchored on the second pass:** the `real-DB` label previously pointed at no named suite anywhere in this document — W0 had no row in §1.2's coverage map at all. It now does. `git show --name-only 077fde47859c…` shows PR 4558 touched `packages/core-backend/tests/integration/attendance-plugin.test.ts`, the first entry of the `:1201` real-DB step, and PR 4560 added two `scripts/ops/attendance-*-contract.test.mjs` suites |
| **W0 completion criterion — narrowed, not closed** | The lock's criterion is "OpenAPI focused contract test wired and green". The test **is** identifiable and **is** wired: `scripts/ops/attendance-openapi-parity-4556-contract.test.mjs`, invoked at `scripts/ops/attendance-run-gate-contract-case.sh:217` under the matrix `openapi` case, with a wiring guard asserting that exact invocation at `scripts/ops/attendance-strict-import-advanced-contract.test.mjs:92`. Re-derived this pass. **What remains unproven is narrower than before:** it has never been re-derived green **at an issue-4556 head** — the matrix is PR-scoped plus nightly-on-main, and no 4556 head appears in this record's run evidence |

#### W1 — effective group membership · PR 4563 (+ PR 4586, PR 4566)

| | |
|---|---|
| **Squash** | `9055932e3142` |
| **Principal modules** | `packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts` (introduced by this commit, confirmed via `--diff-filter=A`) · migration `zzzz20260723140000_create_attendance_calculation_group_memberships.ts` · `routes/attendance-admin.ts` · `packages/openapi/src/base.yml` + `src/paths/attendance.yml` |
| **CI step proving it** | `Run attendance calculation-group W1 contract` — step 40 of job `93053687144`, `success` |
| **Evidence class** | `real-DB` + `adversarial gate` |
| **Adversarial verdict** | W1 record doc §3: final APPROVE, 0 P1 / 0 P2, **after five findings were repaired** |
| **Follow-up** | PR 4586 `c81b3bc39202` timeline-integrity guard |

#### W2 — shared work-date resolver · PR 4567

| | |
|---|---|
| **Squash** | `f1e390977e57` |
| **Principal modules** | `plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs` · `…/attendance-work-date-adapters.cjs` (both introduced by this commit) |
| **Evidence class** | `real-DB` |
| **Binding closure condition** | Parent lock §10 item 5 — "all work-date entry points use the shared resolver" |

#### W3 — segment schema and authoring · PR 4569 (backend), PR 4570 (frontend), PR 4568 (contract), PR 4584 (hardening)

| | |
|---|---|
| **Squashes** | `c5f08aecd573` · `ee8e586f74a6` · `d6fa5d19b7a3` · `78b4133bac15` |
| **Principal modules** | migrations `zzzz20260724120000_create_attendance_shift_segments.ts`, `zzzz20260724130000_attendance_dispatch_target_shift_set_null.ts` · `attendance-shift-service.cjs` · `apps/web/src/views/attendance/AttendanceShiftSegmentsEditor.vue` |
| **Evidence class** | `real-DB` + `unit` (web) |
| **DELIBERATE NON-DELIVERY** | The W2/W3 record doc states authoritative segment calculation is **not** delivered by W3; multi-segment shifts remain **preview-only**. PR 4584 makes legacy multi-segment shifts **fail closed** rather than silently mis-calculate. This is a designed boundary, not a gap |

#### W4 lock + RATIFY · PR 4588, PR 4592

`a3e5765727ca` landed the W4 design lock; `d6ac495b947c` persisted the ratification.
Header at the pinned SHA reads `Status: **RATIFIED**` (line 3), ratified object
`a3e5765727ca608e8c49c7a44a025e6e4aae5d40` (line 12). **Evidence class: `doc-only`.**
This RATIFY is the one owner decision on this line whose scope I could confirm from an owner
comment as well as the header (§5.2).

#### W4C-0 — contracts and durable storage · PR 4606

| | |
|---|---|
| **Squash** | `d4dc12d8a8cd` (14,960 insertions) |
| **Source modules** | **7**, re-derived by `git ls-tree … \| grep -v __tests__ \| grep -c '/w4c0-'`: `w4c0-{authorization,fingerprints,identity,operation-contract,operation-registry,source-commands,write-boundary-types}.ts` |
| **Migration** | `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts` |
| **Standing gate shipped** | `scripts/attendance/w4c0-dml-inventory/` — **11 modules** (re-derived by `ls-tree \| wc -l`), driven by `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (**1,431 lines, 58 `test(` cases** — both re-derived) |
| **CI step proving it** | `plugin-tests.yml:585` `Run attendance W4C-0 Stage D §8.4 and W4C-4 §12.7 inventory collectors`, in job `test`, **no `if:` pin** (runs on both matrix legs) |
| **Executed result at pinned HEAD** | job `93053687144` TAP: `# tests 58 / # pass 58 / # fail 0 / # skipped 0` (log lines 4054-4059) — **I re-read this log this session** |
| **Evidence class** | `real-DB` + `mutation-proven` (≈10 positive-control bypass probes) + `adversarial gate` |
| **Frozen baseline** | `docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json`, byte-reproducibility checked against pinned commit `e0defbe26d7f2e1747e74aa908ca710422812bf7` |

**What the DML gate actually asserts** (named subtests observed green in the log):

- `ok 1 - exact-head HEAD scan: zero new/unclassified/out-of-boundary attendance DML` (log line 3764)
- `ok 42 - W4C-3c hard zero-bypass: current-tree open-debt set is exactly empty` (log line 3969)
- positive-control bypass probes: plugin-style INSERT, new route without discriminator, shared
  `approval_instances` write, operator-script delete, raw `COPY` into a canonical table,
  `COPY FROM STDIN`, `MERGE INTO`, runtime staging `CREATE TABLE`
- a self-assertion that this very file has an explicit CI execution step

> **SCOPE LIMIT — do not cite this gate as test-corpus coverage.** Its scanner excludes
> `/tests/`, `/test/`, `/__tests__/`, `/__fixtures__/` path segments and `.test.` / `.spec.`
> filename markers *by construction* (`collector.cjs` `EXCLUDED_PATH_SEGMENTS` /
> `EXCLUDED_FILENAME_MARKERS`). It gates **production DML sites**. It is structurally incapable of
> detecting the two unwired test files in §2.4, and contributes nothing to the question of whether
> attendance tests are wired or executed.

#### W4C-1 — pure segment calculator · PR 4607

| | |
|---|---|
| **Squash** | `aebac4f8bef3` |
| **Source modules** | **4** (re-derived): `w4c1-{strict-time,segment-calculator,merge-policy,fingerprints}.ts` |
| **Blast radius** | Exactly 8 files (4 src + 4 spec), 3,617 insertions, **0 deletions** — zero existing files modified, zero DB, zero routes, zero cutover |
| **Evidence class** | `unit` (pure modules, no DB) |

#### W4C-2 — live and scheduled shadow · runtime on main via PR 4670, **not** PR 4612

| | |
|---|---|
| **Squash on main** | `5ae2cea0b2a8` — subject prefix `test(attendance): W4C-2 option-A integration candidate (#4670)` |
| **Source modules** | **6** (re-derived): `w4c2-{frozen-attribution,live-scheduled-boundary,outbox-dispatcher,scheduled-run-ops-worker,scheduled-run,shadow-expected-differences}.ts` — all attributed to `5ae2cea0b2a8` by `--diff-filter=A` |
| **Migration** | `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` |
| **Host wiring** | `packages/core-backend/src/index.ts` +114, `src/types/plugin.ts` +103; 19,070 insertions across 47 files |
| **CI step** | `plugin-tests.yml:1201` step id `attendance-real-db-integration`; wiring pinned by `Attendance W4C-2 CI wiring contract` (step 28 of job `93053687144`, `success`) |
| **Evidence class** | `real-DB` + `adversarial gate`. **`mutation-proven` is withdrawn from this row.** The class is defined at §1 as "a mutation was applied and **the guard was observed to go red**". The only mutation record I can find for W4C-2 is self-reported in PR 4670's own 2026-07-29T00:24:34Z comment ("### Discriminating mutations" — three mutations: production terminal outcome `completed`→`failed`; named cancellation → raw SQL cancellation; DB source-DML sentinel `RAISE`→`RETURN NULL`; "All mutations were restored and their positive controls rerun green"). That is a lane's own PR comment with **no standing CI leg re-applying any of them** — the identical evidentiary shape this record grades as a DEFECT at §3 row F. The same shape cannot be a badge here and an open defect there. Recorded as a residual in §4.8 |

> **PROVENANCE ANOMALY — the nominal PR never merged.** PR 4612 is `CLOSED`, `merged=false`,
> title `⛔ OWNER-AUTHORIZATION-HOLD — W4C-2 live and scheduled shadow — DO NOT MERGE`. The runtime
> reached main under PR 4670, whose conventional-commit prefix is `test(attendance):` despite
> shipping 6 runtime modules, a migration and host wiring. I did not determine why that prefix was
> used; that is an observation about the subject line, not a finding about intent.
> The merge-authorization question is resolved in §3 row A and §4.6.

**W4C-2 follow-ups on main:** PR 4774 `523d254b8ad4` recovery-sweep fairness (+ migration
`zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts`); PR 4779 `2927a71fafd6` sweep
observability counters.

Fairness implementation is durable rotation, not `OFFSET` — re-derived at
`w4c2-scheduled-run.ts:1238`: `ORDER BY last_attempt_at ASC NULLS FIRST, created_at ASC`.
Both proving suites are in the run-list (`plugin-tests.yml:1249-1250`):

- `attendance-w4c2-sweep-fairness.db.test.ts:235` — `gate 1 — durable rotation over a >25 persistently-blocked backlog`
- `attendance-w4c2-sweep-fairness.db.test.ts:373` — `gate 3 — values-free tick observability`
- `attendance-w4c2-sweep-call-through.db.test.ts` — legs 1-4 at `:376`, `:418`, `:444`, `:532`

#### W4C-3a — import and rollback · PR 4688

| | |
|---|---|
| **Squash** | `9ce340e0f793` (44,814 insertions, 97 files) |
| **Source modules** | **18** (re-derived): `w4c3a-{canonical-import-kernel,import-proof,import-rollback-boundary,import-rollback,legacy-execution-plan,legacy-plan-batch-effects,legacy-plan-enqueue,legacy-plan-group-effects,legacy-plan-item-effects,legacy-plan-preconditions,legacy-plan-processor,legacy-plan-record-effects,legacy-plan-reservation-host,legacy-plan-worker-repository,legacy-plan-worker,rollout-control,sync-import-host,sync-import-kernel}.ts` |
| **Evidence class** | `real-DB` + `adversarial gate` |
| **Preceded by** | Six merged docs amendments, all ancestors: PR 4672, PR 4677, PR 4679, PR 4685, PR 4686, PR 4687 |

#### W4C-3b — approval and writer cutover · PR 4716 (+ PR 4714, PR 4715)

| | |
|---|---|
| **Squash** | `ce7ffe8ce8ee` (12,958 insertions) |
| **Source modules** | **4** (re-derived): `w4c3b-{approved-leave-cancellation,central-approval-hooks,request-operation-boundary,request-snapshots}.ts` |
| **Also modified** | `routes/approvals.ts`, `ApprovalProductService.ts`, `ApprovalBridgeService.ts`, `plugin-attendance/index.cjs` |
| **Precursor** | PR 4714 `f4444e15e7a5` → `AttendanceLegacyMembershipOverlapAudit.ts` |
| **Evidence class** | `real-DB` **for the wired portion** — ⚠️ **but see §2.4: this phase is the source of the line's only NOT EXECUTED cell.** |

> ⚠️ **W4C-3b is the one phase whose test evidence is materially incomplete.** Both of its
> dedicated real-DB suites are unwired; **20 DB-gated assertions covering W4C-3b central approval
> and request snapshots execute nowhere.** Details and exact counts in §2.4.

#### W4C-3c — zero-bypass cutover · PR 4718

| | |
|---|---|
| **Squash** | `2d2b9eeccab2` (11,300 insertions) |
| **Source modules** | **6** (re-derived, names read directly from the tree): `w4c3c-{active-current,manual-edit-apply,manual-override,ops-retirement,recompute,record-operation-boundary}.ts` |
| **Ops tooling** | `scripts/attendance/execute-ops-retirement-cleanup.cjs`, `scripts/ops/staging-attendance-tooling-teardown.mjs` |
| **CI step** | `Attendance W4C-3c tooling cleanup contracts` (step 29 of job `93053687144`, `success`) |
| **Evidence class** | `real-DB` + `mutation-proven` — **but the leg cited for the badge was the wrong one.** `ok 42` is *not* a mutation: verified verbatim in the job log at `:3969` (`ok 42 - W4C-3c hard zero-bypass: current-tree open-debt set is exactly empty`) and in source at `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033`, it is a **set-emptiness assertion** — no guard is made to go red, so it cannot satisfy the §1 definition. The badge stands on legs that were present and uncited, now named: `:1048` (`W4C-3c mutation: removing a canonicalizedBy/current closure reopens debt`), `:1257` (`W4C-3c mutation: inserting a new live DELETE or UPDATE bypass is caught`), `:1360` (`W4C-3c P20 mutation: bypassing the host port on anomaly listing fails only that surface`), `:1386` (`W4C-3c mutation: new side-door business DML is unclaimed under hard zero-bypass`), `:1414` (`W4C-3c mutation: reintroducing live second UPDATE after result edit is caught by scanner`). All five sit inside the 58/58-green TAP block (log `:4054-4059`) |

#### W4C-4 — calculation detail and shadow ledger · PR 4721

| | |
|---|---|
| **Squash** | `5edc118d5b7d` |
| **Principal module** | `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts` (834 lines, introduced here) · `AttendanceDecisionTrace.ts` +367 · `routes/attendance-admin.ts` +113 · OpenAPI `base.yml` +108 / `attendance.yml` +100 |
| **Evidence class** | `real-DB` + contract. The generated-SDK leg is visible in the log: `ok 3 - generated SDK contains every W4C-4 path and schema` (log line 3732) |

#### W4C-5 — transition safety · PR 4773, PR 4780, prep PR 4747

| | |
|---|---|
| **Source modules** | **ZERO new *src* modules — and the earlier statement of this row is retracted.** An earlier pass said a `--diff-filter=A --name-only` sweep lists both commits "with **no files beneath them**". **That does not reproduce.** `git show --diff-filter=A --name-only --format='' 3601817969` → `packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts` (251 lines per `--stat`); `git show --diff-filter=A --name-only --format='' 0dc3596ddb` → `packages/core-backend/src/attendance/__tests__/w4c3b-request-snapshot-metadata-fields.test.ts` (141 lines). Both commits are single-parent, so no merge suppression applies. The surviving claim is re-derived with the pathspec **printed**, not with an unscoped command: `git show --diff-filter=A --name-only --format='' <sha> -- 'packages/core-backend/src' ':(exclude)packages/core-backend/src/**/__tests__/**'` returns empty for both |
| **New suites (previously reported as none)** | Two, both executing at the pinned HEAD (job `93053687144`: 7 and 15 `✓ src/attendance/__tests__/…` lines). The irony is load-bearing and worth stating plainly: `w4c3a-rollout-control-inventory.test.ts` carries decoy / positive-control / negative-control legs at `:149`, `:174`, `:197`, `:218`, `:236` — it is **precisely the file that justifies this row's `mutation-proven` badge**, and the sweep that was supposed to inventory new files is what missed it |
| **What landed** | PR 4773 amends `w4c3a-rollout-control.ts` (+694), `w4c0-identity.ts`, `w4c3b-request-snapshots.ts`; PR 4780 amends `w4c3a-rollout-control.ts` (+257) and `w4c3b-request-snapshots.ts` (+73) |
| **Evidence class** | `real-DB` + `unit` + `mutation-proven` for the landed hardening — `doc-only` for the runbook. The `mutation-proven` badge is now anchored on the inventory suite's control legs named above, rather than left unanchored |
| **Proving suite / CI step** | `attendance-w4c3a-rollout-control.db.test.ts` (`plugin-tests.yml:1265`) via the real-DB step `plugin-tests.yml:1201` |
| **⚠️ Authorization** | The amendment's in-repo header still reads `PROPOSED / staging HOLD`, but **`OD-W4C-61=(a)` was RATIFIED by owner relay 2026-08-05 — the header is stale. See §5.2.** |

**The 8-cell closed set is mechanically closed** (re-derived):

- `w4c3a-rollout-control.ts:814-823` exports a frozen 8-member table
  `ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1` = `pendingMissing, pendingUnsupported,
  pendingPayloadStale, pendingReversalIncomplete, reversibleMissing, reversibleUnsupported,
  reversiblePayloadStale, reversibleReversalIncomplete`
- the test **imports that exported table** (`attendance-w4c3a-rollout-control.db.test.ts:21`) and
  **derives its expectation by iterating it** (`:383-385` `emptyDefectCounts`) — so the expectation
  cannot drift from the source enum
- **5** `expectSingleCellDefect(...)` call sites (`:1660`, `:1705`, `:1946`, `:1960`, `:2081`); the
  helper is **declared** at `:389`. An earlier pass said 6, counting the declaration as a call site —
  which is exactly the "打执行点非同名参数/声明" failure mode, and in a provenance record that
  distinction is the whole point. Exact-shape `toEqual` assertions at each of the five
- RACE legs present: **A, C, D, E, F, G, H, I, J, K, L** (re-derived by `grep -oE 'RACE [A-Z]\b'`).
  *Observation, not a finding:* there is no leg labelled `RACE B` in this file; I did not determine
  whether it was renamed, relocated, or never existed.
- the file **is** in the run-list (`plugin-tests.yml:1265`)

> **W4C-5's NAMED deliverable — the 7-day synthetic staging soak — HAS NOT RUN.** See §4.1 and §5.

#### W5 — single-segment flex · PR 4748

| | |
|---|---|
| **Squash** | `7da5d9e55b0f` |
| **Source module** | **1** (re-derived): `w5-flex-policy.ts` (246 lines) |
| **Also** | migration `zzzz20260804120000_attendance_shift_flex_policy.ts` · `apps/web/src/views/attendance/AttendanceShiftFlexPolicyEditor.vue` (249) · extensions to `w4c1-segment-calculator.ts` (+147), `w4c1-strict-time.ts` (+40), `attendanceShiftSegments.ts` (+211), `attendance-shift-service.cjs` (+324) |
| **Unit tests on main** | `src/attendance/__tests__/w5-flex-policy.test.ts`, `…/w5-flex-segment-calculator.test.ts` |
| **Evidence class** | `real-DB` + `unit` |
| **Binding closure condition** | Parent lock §10 item 3 — "flex behavior is distinct from grace" |

#### W6-PREP — preparation artifacts only · PR 4771

| | |
|---|---|
| **Squash** | `2967da018cee` (1,552 insertions, 14 files, all new) |
| **Source module** | **1** (re-derived): `w6-group-effective-policy-contract.ts` |
| **UI** | `AttendanceGroupEffectivePolicyPanel.vue` — 52 lines, **inert shell** |
| **Contract** | `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` — a `drafts/` path, **not** the generated `src/paths/` surface |
| **Fixtures** | nine under `packages/core-backend/tests/fixtures/attendance/w6/` |
| **Evidence class** | `doc-only` + inert. Lock header line 3: `Status: **PROPOSED / runtime HOLD**` |
| **Unverified** | Whether the OpenAPI build or any required contract gate reads `drafts/` — so whether the W6 draft is inert *by construction* or merely *unwired* is **unverified** |

**The exact merged SHA the owner must RATIFY** (W6 landing step 2) is `2967da018ceea41b91098e14d4c15a57236eb5f8`.
**No RATIFY of it exists** — see §5.2.

#### FSER-4 prerequisite (issue 4709 chain) · PR 4772, contract PR 4746

| | |
|---|---|
| **Squash** | `ce17ed321752` |
| **Module** | `plugins/plugin-attendance/lib/attendance-fixed-schedule-self-route-identity.cjs` (92 lines) |
| **Routes on main** | `/api/attendance/groups/:groupId/fixed-schedule/effectiveness` (`index.cjs:44373`) and the new `/…/effectiveness/me` (`index.cjs:44419`); identity helper required at `index.cjs:18` |
| **Evidence class** | `real-DB` (authorization matrix) |
| **Motivating finding** | PR 4746 §0: a frontend-only FSER-4 would create a permission / data-minimization defect, because the only effectiveness route was `attendance:admin`-guarded and returned whole-group counts |

**Underlying issue-4709 FSER chain, fully on main:** lock PR 4712 `7abd4e587294` (RATIFIED
2026-08-03, "authorizes FSER-1 only") · FSER-1 PR 4727 `ebeafc08be26` · FSER-2 PR 4730
`6b439a1ab05a` · FSER-3 PR 4735 `390841a645e0` · ratification record PR 4725
**`4086cef6262ccea8e1822afa5a34e19c7313f0f4`**.

> **Corrected P1 — and a method gap, not only a typo.** An earlier pass wrote PR 4725's SHA as
> `4086cef6262e`. `git rev-parse --verify 4086cef6262e` → `fatal: Needed a single revision`. Under
> this document's own §1.1 semantics that returns **UNRESOLVABLE** — the exact signature §7.2 assigns
> to the fabricated `deadbeef…` negative control — inside a sentence asserting the chain is "fully on
> main". The real object is `4086cef6262ccea8e1822afa5a34e19c7313f0f4` (12th character `c`, not `e`),
> found via `git log --all --grep='(#4725)' --format='%H'` and **never** by hand-expanding the
> abbreviation. The mechanism that let it through: PR 4725 was the **only** PR named in that sentence
> that is absent from §7.2's tabulated two-witness table, so no witness fired on it. §7.2 now carries
> a second table covering every SHA cited in §1.3 **prose**, not only the tabulated ones.

**Adjacent issue 4711 group-context-route chain, fully on main:** lock PR 4713 `8806e9679e3e`
(RATIFIED 2026-08-03) · PR 4726 `e0377e20e66a` · PR 4729 `c64d95225936`
(→ `AttendanceGroupContextHost.vue`, `attendanceGroupRouteHydration.ts`,
`useAttendanceGroupRouteContext.ts`) · PR 4733 `676ed2433813`.

#### W7 · W8 — ZERO artifacts on main

A tree-wide search for `4556.*w7` / `4556.*w8` returns **nothing**. The only `w7`/`w8`-named docs
under `docs/development` belong to unrelated lines (approval-automation and multitable cross-base
result-writeback), confirmed by name. W7 and W8 are defined **only** by parent-lock §9.8-§9.9.

Docs-only drafts exist on the **open, held** PR 4804 — not on main. **Its head is point-in-time and
has moved twice:** `e941eea9c1186bb49522c67148023b5f4fb9428a` → `4642f71328257a5efaf888d58b9ed9f8287cbb37`
(1st pass) → **`a1344c77c09725b757b5e9408b501e433bc3d385`** (2nd pass, `mergeable=MERGEABLE`,
`mergeStateStatus=BEHIND`). The `e941eea9…` → current transition was a **rebase**, not a
fast-forward, so any `file:line` anchor or check rollup taken at the older head does **not** transfer.
Re-read the head before citing anything inside those drafts.

### 1.4 Runtime posture — the whole W4 chain is flag-gated OFF by default

Re-derived:

- `.env.example` — `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` appears at lines **168 and 177 only, both commented out**
- `docker/app.env.example` — **0 occurrences**
- Production read sites **do** exist, so the gate is real code and not dead text:
  `w4c0-identity.ts:363` (allowlist env constant) · `plugin-attendance/index.cjs:29356` and `:49612`
  (`process.env` reads) · `attendance-shift-service.cjs:56`

**Conclusion:** the gate is live code, unset in the shipped env templates. Rollout state machine
defaults to `legacy`.

---

## 2. The CI enforcement surface

### 2.1 Required status checks on main — 9 contexts, `strict=true`

Re-derived from `gh api …/branches/main/protection/required_status_checks`:

`contracts (strict)` · `contracts (dashboard)` · `contracts (openapi)` · `pr-validate` ·
`test (20.x)` · `web-tests` · `stock-prep PowerShell 5.1 acceptance` · `attendance-web-guard` ·
`integration-guard`

`strict=true` means merging any one PR puts every other open PR BEHIND and forces all 9 to re-run.

### 2.2 Which contexts are present at the pinned HEAD — and *why* the others are absent

At `a45e1416`, on the **first pass**, the full check-run rollup read **20 success, 5 failure,
7 skipped, 2 pending**. On the **second pass (2026-08-08)** the identical command
(`gh api repos/zensgit/metasheet2/commits/a45e1416002e6ca500eeda8d70e86c6443a10700/check-runs --paginate`)
returns **21 success, 7 failure, 7 skipped, 0 pending**, with failures `perf` ×3, `verify-main`,
`strict-gates`, `smoke`, `deploy` — **one** `deploy` failure, not two.

> **This is not a correction of one reading by another; it is the demonstration that this class of
> number is not SHA-pinned.** Check runs are mutable and re-runnable, so a rollup is an observation
> with a timestamp, not a property of the commit. I cannot prove the state at the first read, and I
> make no claim that it was wrong — only that it is **not reproducible from the pin**. The same
> caveat applies to every behind/ahead count and `mergeStateStatus` in §7.5.

Of the 9 required contexts, **4 are present and `success`**; **5 have no check-run at all** (stable
across both passes).

I verified the mechanism for each absence by reading the actual `on:` block rather than inferring
it — and the mechanism is **not the same for all five**:

| Required context | Workflow | Present at HEAD? | Verified mechanism |
|---|---|---|---|
| `test (20.x)` | `plugin-tests.yml` | ✅ `success` (job `93053687144`) | `push: branches:[main,develop]` **with** a broad `paths:` filter incl. `packages/core-backend/**`, `plugins/**`, `scripts/**`, `.github/workflows/*.yml` — PR 4646 touched several, so it ran |
| `web-tests` | — | ✅ `success` | not separately traced |
| `stock-prep PowerShell 5.1 acceptance` | — | ✅ `success` | not separately traced |
| `integration-guard` | `integration-guard.yml` | ✅ `success` | not separately traced |
| `contracts (strict)` | `attendance-gate-contract-matrix.yml` | ❌ absent | **No `push` trigger exists at all.** `on:` = `workflow_dispatch`, `merge_group`, `schedule`, `pull_request:[main]` (lines 3-11). Structurally cannot run **on a main push**. **But it is not absent from `main` as an evidence source** — the `schedule: cron '45 4 * * *'` leg runs it nightly against `main`, all `success` for eight consecutive days (§1.2). "No push trigger" and "no main-branch evidence" are different statements, and only the first is true |
| `contracts (dashboard)` | same | ❌ absent | same |
| `contracts (openapi)` | same | ❌ absent | same |
| `pr-validate` | `phase5-validate.yml` | ❌ absent | **No `push` trigger.** `on:` = `merge_group`, `pull_request` (lines 3-7) |
| `attendance-web-guard` | `attendance-web-guard.yml` | ❌ absent | **Different mechanism — path-filtered out.** A `push: branches:[main]` trigger *does* exist (line 128) and carries a `paths:` filter at **`:130-187`** — the `paths:` key is at `:130`, its entries run `:131-187` ending with `'.github/workflows/attendance-web-guard.yml'`, and `jobs:` begins at `:189`. **57 entries** (`awk 'NR>=131 && NR<=187' \| grep -c "^ *- '"` → 57). An earlier pass cited the window as `:130-148`, which contains only **18** of the 57 — a criterion narrower than the rule, which is §3 row D applied to this record's own method. The **conclusion survives**: I matched **all 57** patterns against `git show --name-only --format='' a45e1416…` and got zero hits. Exactly one entry is a wildcard (`apps/web/src/views/attendance/**`; `grep -n '[*?]'` over the 57 confirms it is the only one), so the match is otherwise literal |

> **Why this distinction matters:** four of the five absences are "PR-only by design"; the fifth
> (`attendance-web-guard`) *would* have run had the commit touched attendance web paths. Reporting
> all five as "PR-only" would be a materially different — and wrong — statement.
>
> **Corollary:** required contexts are enforced on **pull requests**. Their absence on a main push
> commit is normal and is **not** evidence of a gap. Equally, a green `test (20.x)` on a main push
> does **not** mean all 9 gates were satisfied at that SHA.

### 2.3 Which suites run in which job

Job `test` of `plugin-tests.yml` (matrix `[18.x, 20.x]`; the `20.x` leg is the required context)
has **79 steps** (`gh api repos/zensgit/metasheet2/actions/jobs/93053687144 --jq '.steps | length'`
→ 79). I enumerated roughly 40 of them; the table below is that **subset**, not the job's full step
list. An earlier pass wrote "among ~40 steps", which read as a property of the job and was off by
about 2× — this record's own citations already exceeded it (§1.3 cites "step 40" for the W1 contract,
the W4C-0 collector is step 46, and the real-DB step is later still). Of the 79:

| Step | Name | Pin |
|---|---|---|
| 6 | `Run K3-line ops suites (required lane, issue 4802)` (`plugin-tests.yml:223-224`, id `k3-line-ops-suites`) | `if: matrix.node-version == '20.x'`, no `continue-on-error` |
| 28 | `Attendance W4C-2 CI wiring contract` | — |
| 29 | `Attendance W4C-3c tooling cleanup contracts` | — |
| — | `Run attendance W4C-0 … inventory collectors` (`:585`) | **deliberately no `if:` pin** — both legs |
| — | `Run attendance integration tests` (`:1201`, id `attendance-real-db-integration`) | **deliberately no `if:` pin** — both legs |

The real-DB step's structural pin is itself guarded: `attendance-w4c2-ci-wiring.test.mjs`
(`:191`, `:259`) parses the workflow with `python3` + PyYAML (fail-closed) and asserts via
`deepEqual` that the step id `attendance-real-db-integration` appears in **exactly** the job list
`['test']` and nowhere else. The step carries an explicit in-file comment declining to copy the
`if: matrix.node-version == '20.x'` pin from sibling workflows, because doing so would **narrow**
coverage to one leg.

### 2.4 Real-DB corpus count and run-list coverage — the load-bearing numbers

**I re-derived every number below this session** by extracting the three sets to files and
comparing them with `comm` in **both** directions — and, because a scan window that is too narrow
is itself a defect (this is §3 row D applied to my own method), **at three widths**:

| Width | Pattern | On tree | In run-list | In `test.exclude` | In NEITHER |
|---|---|---|---|---|---|
| 1 | `attendance-w4c*.db.test.ts` | **40** | **38** | **38** | **2** |
| 2 | `attendance-*.db.test.ts` | **73** | **71** | **69** | **2** (same two) |
| 3 | all `tests/integration/*.db.test.ts` | **145** | **138** | **131** | **7** (see below) |

Run-list entries **not** on the tree (negative control) = **0 at every width** — the run-list
carries no phantom entry.

> **What "the attendance corpus" means here, stated because all three widths share one blind spot.**
> Every width above is defined over the **`*.db.test.ts` filename marker**. A DB-gated spec does not
> have to carry that marker, and this record never previously said so — which left a reader unable to
> tell whether the window was complete for the invariant being tested (which is about *DB-gated*
> specs, not about a naming convention).
>
> **What was checked outside the marker, and what was not.** One file added by PR 4773 is invisible
> to all three widths and does contain a `DATABASE_URL` token:
> `packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts`. I
> hand-inspected it to rule out a gate — the token is a **decoy string at `:225`**, not a gating
> condition, and the file genuinely executes (7 `✓` lines in job `93053687144`). So the "20
> assertions" conclusion holds. **A systematic sweep for DB-gated specs outside the `*.db.test.ts`
> naming convention was not run**, and the completeness claim below is scoped accordingly.

**The two-point wiring rule is ratified lock text, not a convention.** An earlier pass of this record
called it "the two-point wiring **convention**" and "the invariant **the repo maintains**". Both
phrasings are **retracted**: they describe as a lane habit something that is a ratified per-slice
completion obligation. W4 lock §12.9 "CI collection is part of each slice"
(`docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`, heading
`:3033`, text `:3035-3037`, RATIFIED at exact merged SHA
`a3e5765727ca608e8c49c7a44a025e6e4aae5d40`) reads verbatim:

> Every new test proves local collection, DB exclude/run-list wiring, workflow
> positive control, and exact mutation/failing leg. Frontend additions update both
> path filters and explicit web-guard run list. **Skip-green is a failed gate.**

So the operative rule is: *every attendance `*.db.test.ts` must be BOTH excluded from the no-DB
vitest config AND named in the real-DB run-list.* A file in neither list does not fail loudly — it
**skip-greens**, which the lock's own final sentence classifies as **a failed gate**.

Two further things follow that this record previously did not state. (1) §12.9 names **four**
obligations, and only the second (DB exclude/run-list wiring) is inventoried anywhere on this line —
local collection, workflow positive control, and an exact mutation/failing leg are **unmapped by any
artifact**, including this one. (2) Because W4C-3b shipped two dedicated real-DB suites in neither
list, **W4C-3b's slice-completion gate is failed by the lock's own words** — which bears on W4 lock
§15's statement that the W4C slices "are on main in order". See §4.3.

**Widening changed two things, and the reader needs both:**

**(i) The headline holds.** At widths 1 and 2 the set of files in *neither* list is the **same two
files**. The "20 assertions execute nowhere" figure is therefore a complete count for the attendance
corpus **as defined by the `*.db.test.ts` filename marker** — not a subset of a larger `*.db.test.ts`
set. It is **not** a claim about DB-gated specs that do not carry that marker; see the scope note
above.

**(ii) But the invariant is violated in a second direction that width 1 hides.** At width 2 the two
lists are **not** the same size (71 vs 69). Two files are in the run-list but **not** in
`test.exclude`:

| File | `it()` | Gating | Consequence |
|---|---|---|---|
| `attendance-shift-segments-migration.db.test.ts` | 9 | `describeDb`, `DATABASE_URL` | **No coverage lost** — it *is* in the run-list and I confirmed it appears in the pinned-HEAD real-DB log. The omission means the no-DB unit run also collects it, where it skip-greens |
| `attendance-shift-segments-writer-matrix.db.test.ts` | 33 | `describeDb`, `ATTENDANCE_TEST_DATABASE_URL \|\| DATABASE_URL` | same |

Both are W3-phase files introduced by PR 4569. **This is a bookkeeping violation, not a coverage
hole** — but it means any statement of the form "the two lists are maintained in lockstep" is true
only at width 1, and I have therefore not made that claim.

**(iii) Width 3's five extra names are mostly NOT orphans — I checked the mechanism rather than
assuming.** Four of the five run in **dedicated workflows**:

| File | Runs in |
|---|---|
| `sealed-export-s6a-authority-row-lock.db.test.ts` | `sealed-export-s6a-authority-row-lock.yml` |
| `sealed-export-s6a-grant-repair.db.test.ts` | `…authority-row-lock.yml`, `…grant-repair.yml` |
| `sealed-export-s6a-runtime-authority.db.test.ts` | `sealed-export-s5-sqlserver.yml`, `…authority-row-lock.yml` |
| `sealed-export-signer-authority-lifecycle-migration.db.test.ts` | `sealed-export-s5-sqlserver.yml` |
| `approval-delegation-selfservice.db.test.ts` | ⚠️ **nothing** — a full-tree `git grep -F` returns only a design-lock doc mentioning it in prose; it is also absent from `test.exclude`, and is `DATABASE_URL`-gated |

> **Out-of-scope observation, recorded because the class matters:**
> `approval-delegation-selfservice.db.test.ts` appears to be a **third orphan** of the same shape.
> It belongs to the **approval** line, not issue 4556, so it is outside this record's scope and I make no
> claim about its contents. It is noted only to show the defect class is **not confined to this
> line** — and as a caution that "not in the plugin-tests run-list" does **not** by itself mean
> "executes nowhere", as the four sealed-export files prove.

**The two files that execute nowhere** (this is the line's primary evidence gap):

| File | Structure (re-derived) | DB-gated `it()` |
|---|---|---|
| `packages/core-backend/tests/integration/attendance-w4c3b-central-approval.db.test.ts` | `dbUrl` at `:54`, `describeIfDatabase` at `:55`, single `describeIfDatabase('W4C-3b R0 central approval (real DB)')` at `:95` | **16** |
| `packages/core-backend/tests/integration/attendance-w4c3b-request-snapshots.db.test.ts` | plain `describe('W4C-3b P12 request snapshot guards')` at `:54` (3 tests, these DO run) + `describeIfDatabase('W4C-3b P12 request snapshots (real PostgreSQL)')` at `:166` | **4** |
| | | **Total: 20** |

**Empirically confirmed at the pinned HEAD**, by grepping the `test (20.x)` job log
(`93053687144`) myself:

- `W4C-3b R0 central approval` → **0 occurrences**
- `W4C-3b P12 request snapshots (real PostgreSQL)` → **0 occurrences**
- `W4C-3b P12 request snapshot guards` → **3 occurrences** (the plain describe does run in the no-DB step)

A full-tree `git grep -F` for either basename returns **only** the DML-inventory collector test
reading `central-approval` as *source text* — zero workflow, zero `package.json` script, zero other
run-list reference. No workflow runs a broad `vitest.integration.config.ts` glob that would pick
them up.

**Age and origin:** both were introduced together by `ce7ffe8ce8ee` (PR 4716, 2026-08-02) and were
never wired. This is a standing gap of roughly six days, **not** a regression from PR 4779/PR 4780
— I confirmed neither of those PRs touched either file.

**Executed real-DB result at the pinned HEAD** (re-derived from the same log): the run-list step
totals **98 test files** (I counted the `tests/` entries in the step myself) and CI reported
**`Test Files 98 passed (98)` / `Tests 1300 passed (1300)`** — the parenthesised totals equal the
passed counts, so **zero skips** in that step. The 38 wired w4c files genuinely execute against a
real database.

**No-DB unit step at the pinned HEAD:** `Test Files 603 passed | 191 skipped (794)` /
`Tests 8323 passed | 1709 skipped (10032)`. (These differ by one test from the figures in the
upstream collection, which were read at an ancestor commit — I use the pinned-HEAD numbers.)

### 2.5 The completeness guards — **two guards and one wholly unguarded corpus; do not merge them**

| Guard | Corpus | On main? | Wired where |
|---|---|---|---|
| `plugins/plugin-integration-core/__tests__/test-chain-completeness.test.cjs` | plugin-integration-core suites | ✅ **YES** (verified `git cat-file -e`) — landed via PR 4801 | Called **independently** from `integration-guard.yml` (~`:399-408`) so it is not self-referential, with a `MIN_CHAINED_SUITES` floor and a refuse-to-report-green branch when the `test-chain-completeness: <N> suites` summary line is missing |
| **attendance-w4c derived-completeness guard** | attendance `*.db.test.ts` on disk | ❌ **NO** | Proposed only, in open PR 4805 |
| **— none —** | `scripts/ops/attendance*.test.mjs` — **48 files** on main (`git ls-tree -r --name-only origin/main -- scripts/ops \| grep -cE 'attendance.*\.test\.mjs$'`) | ❌ **no guard of any kind** | Nothing. PR 4805's derived guard does **not** extend to this corpus |

**The third corpus, added on the second pass.** A name-reference sweep
(`git grep -l -F <basename> origin/main -- .github/workflows package.json scripts`, excluding
self-matches) finds **22 of the 48** referenced nowhere executable — e.g.
`attendance-check-metrics.test.mjs`, `attendance-onprem-package-verify-migrations.test.mjs`,
`attendance-locale-zh-workflow-contract.test.mjs`, and six `staging-attendance-*-smoke.test.mjs`.

> **Caveat stated deliberately, because it changes the severity and must not be dropped when this row
> is quoted:** **none of the 22 are issue-4556 slice suites.** The 4556-relevant members of this
> corpus — the W4C-0 DML collector, the W4C-2 CI wiring guard, the W1 contract test, and the 4556
> OpenAPI parity test — are all wired. And no workflow uses a `scripts/ops/*` glob that could sweep
> them up (`git grep -nE 'scripts/ops/\*' -- .github/workflows` → empty). **This is a class-level gap,
> not a 4556 coverage hole.** It is recorded because the class is exactly the one that produced rows
> C and D, and because PR 4805 closes the `*.db.test.ts` class **only** — the ops-suite class would
> still admit the next orphan.

**The mechanism that let the two orphans land.** `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`
enforces run-list membership from a **handwritten `FILES` allowlist** — `const FILES = Object.freeze([`
at `:71`, **33 entries** (re-derived by counting quoted lines in the array). I confirmed by grep
that the file contains **no** `readdirSync`, `readdir`, `globSync`, or `glob(`. It can therefore
prove *"these named files are wired"* but is **structurally incapable** of detecting a new
`w4c*.db.test.ts` that was never added to its own list. This is a criterion narrower than the rule
it is meant to enforce, and it will keep missing the *next* unwired file too.

**Proposed closure — PR 4805 (open, not landed).** Head `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451`,
NOT an ancestor of main. Re-derived: **behind=4, ahead=2**;
`git merge-tree` shows `plugin-tests.yml` and `vitest.config.ts` **auto-merge cleanly** and the sole
conflict is `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`.
I confirmed the branch **does** wire both orphans (2 matching lines in `plugin-tests.yml`, 2 in
`vitest.config.ts`). It converts the guard from the 33-entry allowlist to a corpus **derived from
the tree**, with negative controls.

> ⚠️ PR 4805's green check rollup is head-scoped to `40dfd4f3fb` and predates the commits main has
> since taken. Because its new guard derives its corpus from the on-disk tree, a post-rebase tree
> with new or moved attendance suites can **red** the guard even though the pre-rebase run was
> green. **The current green is not predictive of post-rebase behaviour.**

### 2.6 The sealed-export provenance pin mechanism

`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` is a
pinned-vector file. Its consumers on main (re-derived via `git grep -l`) are **five**:

- `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` (the reader)
- `scripts/ops/multitable-onprem-package-verify.sh`
- `.github/workflows/sealed-export-s5-sqlserver.yml`
- `.github/workflows/sealed-export-s6a-authority-row-lock.yml`
- `.github/workflows/sealed-export-s6a-grant-repair.yml`

**Operational consequence for this line:** because the pin file must be re-pinned by *any* PR that
changes packaged content, it is a **serialization point**. PR 4646 (the pinned HEAD itself) touched
it, which is precisely why PR 4805 is now conflicting. This is the three-way JSON conflict that
issue 4802 predicted would occur if a third PR touched the pin concurrently.
**I read the consumer's existence, not its enforcement logic** — what the reader asserts on
mismatch is **unverified**.

---

## 3. Adversarial-gate history — institutional memory

Each row: the class, what the round found, and where it was closed. **Cite the fix, not the round.**

| # | Class | What the gate found | Where closed | Status |
|---|---|---|---|---|
| **A** | **Authorization self-certification** (the line's canonical failure) | PR 4606 and PR 4607 were merged while the PR 4595 AUTOMATION HOLD was in force. Mechanism named by the repo's own erratum: *「授权检查成了自证循环」* — the lane re-read the in-repo `RATIFIED` header **that it had itself merged** via PR 4600, and treated it as authorization | Erratum merged as PR 4613 `df610db9ab6c` (ancestor, two-witnessed). Blast radius recorded as production-inert. The erratum lists **six** conditions, and they do not all have the same evidentiary status — an earlier pass called them "all five … independently re-derived", which miscounted **and** over-claimed. **Five re-derived by me** (§1.4): env flag comment-only in `.env.example` (`:168,177`), absent from `docker/app.env.example` (0 hits), rollout defaults `legacy`, zero caller cutover in W4C-0, zero wiring in W4C-1. **One inherited, not re-derived: "zero orgs in shadow"** — that is a fact about rows in `attendance_calculation_rollout_state`, which this record's stated method **cannot** produce: §0.1(c) says I ran nothing, and §7.1 says every read was `git show origin/main:<path>`. It is carried from the PR 4613 erratum and is labelled **unverified** here | **Closed as a record.** The *class* recurs — see row B |
| **B** | Same class, second instance | PR 4670 merged 2026-07-29T00:28:25Z. The last statement on its thread, posted **4 minutes earlier** (00:24:34Z), reads verbatim: *"This is a **technical gate only**. PR 4670 remains Draft and unarmed. It does **not** authorize merging PR 4670 or PR 4612 … The lane stops here for the owner's merge decision."* The PR body says the same | **NOT CLOSED.** I read both the PR 4670 (3 comments) and PR 4669 (4 comments) threads in full. PR 4669 carries a genuine owner RATIFY (2026-07-28T22:50:25Z) but it binds `548d9f3597…` with `OD-W4C-54=(a)` and its authorized consequence is *"resume W4C-2 only to implement and independently gate option (a)"* — it does **not** authorize the merge. **Nor can the later relay cure it:** the 2026-08-05 owner relay states verbatim *"These decisions are effective from this owner relay and are **not retroactive** authorization for earlier work."* | **No merge authorization found in either thread, and the only subsequent owner relay *that I located* explicitly declines to supply one retroactively.** See §4.6 |
| **C** | **Skip-green coverage — a failed ratified gate, not merely a gap** | Two W4C-3b real-DB suites are in neither the run-list nor `test.exclude`; being `DATABASE_URL`-gated they skip silently. **20 DB-gated assertions execute nowhere — half of W4C-3b's dedicated real-DB suites.** Confirmed complete for the `*.db.test.ts`-named attendance corpus at three scan widths (§2.4). **The ratified obligation this violates, previously unnamed in this row:** W4 lock §12.9 (`:3033`, `:3035-3037`, RATIFIED at `a3e5765727ca…`) — "Every new test proves local collection, DB exclude/run-list wiring, workflow positive control, and exact mutation/failing leg. **Skip-green is a failed gate.**" | **NOT CLOSED on main.** Fix proposed in open PR 4805 (mechanical state is point-in-time — §7.5). Closing it also requires a **W4C-3b re-verdict** once the 20 assertions execute (§4.3) | **OPEN** |
| **C′** | Same invariant, opposite direction | Two W3 suites (`attendance-shift-segments-{migration,writer-matrix}.db.test.ts`, 9 + 33 `it()`) are in the run-list but **absent from `test.exclude`**. Visible only once the scan widened past `w4c*` | **NOT CLOSED**, but **no coverage is lost** — both execute in the real-DB step. Bookkeeping only | **OPEN (benign)** |
| **D** | **Criterion narrower than the rule** | `attendance-w4c2-ci-wiring.test.mjs` enforces wiring from a **handwritten 33-entry allowlist** with no directory scan — it cannot detect a file that was never added to it. This is *why* row C landed | **NOT CLOSED on main.** PR 4805 converts it to a tree-derived corpus | **OPEN** |
| **E** | **Guard that works but does not hold the invariant** | The W4C-0 DML-inventory gate is genuinely strong for production DML (58/58 green, ~10 positive-control bypass probes) but **excludes all test paths by construction**. It is real coverage for the wrong question — it cannot see rows C/D at all | By design. Recorded here as a **scope limit**, not a defect, so it is never cited as test-corpus coverage | **Standing caveat** |
| **F** | **Criterion narrower than the rule** (second instance) | issue 4770 completion gate 2 — "a mutation reverting the scan to the fixed prefix `ORDER BY created_at ASC LIMIT 25` goes red" — is self-reported in the PR 4774 PR body as **"PASS (hand-verified, not automated as a permanent CI leg)"** | **NOT CLOSED.** No standing CI leg guards that reversion. Gates 1 and 3 *are* automated (`sweep-fairness.db.test.ts:235`, `:373`) and in the run-list | **OPEN (residual)** |
| **G** | **Uncatchable error channel** (fail-open-shaped) | issue 4791: `DROP DATABASE … WITH (FORCE)` in scratch-DB teardown terminated live backends; node-postgres surfaces `pg_terminate_backend` as a Client/Pool **`error` EVENT**, not an in-flight query rejection — so a `.catch()` **structurally cannot see it** → node uncaught → vitest `Errors: N` → **all tests pass but exit code 1**, intermittently redding the required `test` check for any PR | **CLOSED** by PR 4799 `51c3d8720789`. Closure criterion was explicitly *not* "CI went green" but "the unconditional drain line must report CLEAN on a main required gate". Instrumentation is real code: `tests/helpers/scratch-database.ts:368/381/395` emits CLEAN/FORCED/FAILED; its own guard `scratch-database-drain.db.test.ts` is in the run-list (`plugin-tests.yml:1305`) | **CLOSED — and I re-verified it at the pinned HEAD**, not at the closure commit: job `93053687144` shows `scratchDrain=CLEAN suite=bpmn-poller-disabled drainMs=63 residualBackends=0` and `scratchDrain=CLEAN suite=w4c2-sweep-call-through drainMs=63 residualBackends=0`, with `scratchDrain=FORCED` **0**, `57P01` **0**, `Unhandled Error` **0** |
| **H** | **Fail-open on legacy data** | Legacy multi-segment shifts could be silently mis-calculated by the new path | **CLOSED** by PR 4584 `78b4133bac15` — "fail closed on legacy multi-segment shifts" (ancestor, two-witnessed) | **CLOSED** |
| **I** | **Provenance drift** | PR 4612 was force-push rebased 2026-07-27, so head `8dfde5a77…` was superseded by `b0c7e2823e…` — a review verdict bound to the old head would have been silently stale | **CLOSED** by post-merge provenance erratum PR 4637 `d449aa7e6d02`, added to the W4C-2 scheduled-run identity amendment | **CLOSED as a record** |
| **J** | **Design-option incompleteness** | PR 4669 round: independent review found **3 P2 + 2 P3** — option (a) omitted the run-pinning residual; option (b) conflicted with the pre-claim liveness invariant; membership cessation was reversible and would newly reject a current success; the prior owner-ruling citation was incomplete; the failed-outcome fixture could bypass the named writer | All five corrected; revised document re-reviewed with no remaining P1/P2/P3, then RATIFIED as `OD-W4C-54=(a)` | **CLOSED** |
| **K** | **Repaired-before-landing** | W1 round: five findings raised and repaired before the final verdict | Final adversarial verdict APPROVE, 0 P1 / 0 P2 (W1 record doc §3) | **CLOSED** |
| **L** | **Marker loss through squash** | `[HOLD]` / `[DRAFT/HOLD]` markers **do not reliably survive squash**. PR 4779 and PR 4783 carry `[HOLD]` in their PR titles and lose it in the main subject. PR 4772, PR 4773, PR 4774 happen to retain theirs — which makes the inconsistency easy to miss | **NOT CLOSED.** Anyone auditing hold posture from `git log` on main alone will **understate** it | **OPEN (audit hazard)** |
| **M** | *Schema that checks types not business results* | **No instance found** in the evidence collected for this line | — | **Unverified whether one exists** |
| **N** | *Substring host check* | **No instance found** in the evidence collected for this line | — | **Unverified whether one exists** |

> Rows M and N are named in the repo's general review doctrine. I am recording them as *not found
> for this line* rather than stretching an unrelated finding to fill the slot. Absence of a found
> instance is not proof none exists — I did not run a dedicated sweep for either class.

---

## 4. What is NOT proven

### 4.1 The 7-day synthetic soak has never run

W4C-5's **named deliverable** is the seven-calendar-day synthetic staging soak. On main there is
only:

- the runbook `docs/deployment/attendance-issue-4556-w4c5-synthetic-soak-runbook-20260804.md`,
  header line 4: **`Status: **DRAFT / NOT EXECUTABLE**`**
- the amendment whose header (line 4) reads `Status: **PROPOSED / staging HOLD**`

> ⚠️ **That amendment header is STALE — see §5.2.** `OD-W4C-61=(a)` **was ratified** by owner relay
> on 2026-08-05; the in-repo header was never updated. Do **not** read "PROPOSED" here as "the
> decision is still open." The correct reading is: **the decision is made, the hardening is
> authorized to proceed as Draft/HOLD, and the soak is still separately gated and unauthorized.**

**No execution record exists that I found.** Reporting "W4C-5 landed" means only that the
transition-boundary hardening code (PR 4773, PR 4780) landed. **The soak did not run.**

### 4.2 The Windows PQA matrix has no executed host evidence for the current candidate

Re-derived from issue 4629 (OPEN, 15 comments):

- **All 10 PQA checkboxes are `- [ ]` unchecked** (`grep -c` → 10 unchecked, **0 checked**)
- Exactly **two** cases have ever reached PASS with real Windows-host evidence — **PQA-07**
  (2026-07-28T00:26:28Z, owner-accepted 01:49:53Z) and **PQA-04** (01:58:12Z, independently
  reviewed 18:48:44Z) — **both against the OLD frozen candidate `66a980357078…`**
- The 2026-08-04T13:12:02Z comment froze a **v2** candidate and states verbatim that *"Previous
  PQA-04/PQA-07 evidence remains valid only for that old candidate and must not be transferred as
  PASS on v2"*, with state `PACKAGE/RUNTIME LIFECYCLE VERIFIED — PQA-01..10 NOT STARTED`
- The 2026-08-05T08:27:18Z owner relay authorized PQA-01..10 on v2. **No result comment has been
  posted since** — the comment timeline ends there

**Net position: ZERO PQA cases executed to PASS on the current candidate.** PQA-01, 02, 03, 05, 06,
08, 09, 10 have **never** reached PASS on any candidate. What is proven for v2 is package/runtime
lifecycle only, and the v2 comment itself says these *"do not satisfy the product matrix"*.

### 4.3 Suites that skip-green

**The 20 DB-gated assertions in §2.4** — `attendance-w4c3b-central-approval.db.test.ts` (16) and
the real-PostgreSQL half of `attendance-w4c3b-request-snapshots.db.test.ts` (4). These cover W4C-3b
central approval classification, the bulk-reassign authorization matrix, fail-closed
terminal/mutation guards, reassign-vs-decision serialization, and the real-DB request-snapshot legs.

**I could not determine whether they would even pass against a real database** — they have not been
executed since `ce7ffe8ce8ee` landed on 2026-08-02, and I did not run them (read-only mandate;
execution would require a live PostgreSQL). **The honest statement is not "these tests fail" and
not "these tests pass" — it is that W4C-3b's central-approval and request-snapshot real-DB
behaviour is currently unevidenced.**

**And the consequence, which an earlier pass stopped short of drawing.** This is not only missing
evidence; it is a **failed ratified gate**. W4 lock §12.9 (`:3033`, `:3035-3037`) makes DB
exclude/run-list wiring a per-slice completion obligation and ends "Skip-green is a failed gate". By
the lock's own words W4C-3b's slice-completion gate is therefore **failed**, and W4 lock §15's
statement that W4C-0 through W4C-5 "are on main in order" is not satisfied in the sense §12.9
requires. Two things follow that no artifact on this line currently carries:

1. Wiring the suites is **upstream of W4 completion**, and therefore upstream of W6, W7 and W8 — not
   a parallel hygiene item.
2. **W4C-3b needs a re-verdict once the 20 assertions actually execute.** Its completion was asserted
   on the strength of suites that had never run. Wiring them produces evidence only *after* the fact,
   and that evidence has to be read before W4C-3b is treated as complete. "The wiring PR merged" is
   not that re-verdict.

**Scope of this claim, stated precisely:** I confirmed at three scan widths (§2.4) that these are the
only two files **in the `*.db.test.ts`-named attendance corpus** that are in neither list. All three
widths are defined over that filename marker; a systematic sweep for DB-gated specs **outside** the
naming convention was not run, and one such file (PR 4773's inventory suite) was hand-checked and
ruled out rather than swept — see the scope note in §2.4. Two further attendance files are in the
run-list but not `test.exclude` — those **do** execute and lose no coverage. One further orphan of
the same shape exists on the **approval** line and is outside this record.

### 4.4 The prod posture of this line is currently RED

At the pinned HEAD, on the **second pass**, **7 check runs conclude `failure`**, spanning **five
distinct names**: `perf` (×3), `verify-main`, `strict-gates`, `smoke`, `deploy` (×1). The first pass
read 5 failures over four names and described the fifth entry as "a second `deploy` row"; on re-read
there is one `deploy` failure and three `perf` rows. Rollups are point-in-time (§2.2), so both
readings are recorded.

**`verify-main` failing on a `main` commit is the entry the earlier reading did not surface**, and it
is the kind of signal an owner reading a line-status document should see.

`attendance-strict-gates-prod` failed with
`failed=apiSmoke,playwrightProd,playwrightDesktop reasons=apiSmoke=AUTH_FAILED playwrightProd=TIMEOUT
playwrightDesktop=TIMEOUT`, preceded by `No valid attendance admin token`.

**None of these five is among the 9 required contexts** — which is why nothing is blocked by them and
why they went unnoticed. I classified the signature (auth + timeout against the deploy host —
environment/deploy-side rather than a repo unit/integration gate) but did **not** root-cause it.
Whether the token, the deployment, or the host is at fault is **unverified**.

**Ordering consequence, which an earlier pass left unstated.** This red is not informational once the
soak is in view. The runbook's preflight (`:67-86`) demands "staging status showing exact image SHAs,
pending migrations 0, healthy services" and rules that "Status failure or ambiguity stops the campaign
without any repair, restart, deployment, or flag change." On today's evidence the campaign's first
gate stops — and the same clause forbids repairing it *during* a campaign, so it must be closed
**before** any packet is authorized. The companion design document files it as a remaining-work item
with an owner and a model tier rather than as a provenance footnote.

### 4.5 Deferred defects

| Issue | State | Scope | Status |
|---|---|---|---|
| **issue 4791** 57P01 teardown race | **CLOSED/COMPLETED** 2026-08-07T15:44:55Z | Fixed by PR 4799; re-verified by me at the pinned HEAD (row G) | **Closed — not deferred** |
| **issue 4792** malformed `bpmn:timeCycle` residue | **OPEN**, created 2026-08-06, **0 comments** | `BPMNWorkflowEngine.startProcess` persists process + activity, then `scheduleRecurringTimer` feeds a raw ISO-8601 `<bpmn:timeCycle>` (e.g. `R/PT1M`) to node-cron which throws → `startProcess` 500s → leaves `bpmn_process_instances` ACTIVE + `bpmn_incidents` OPEN (timer rows 0). The cycle branch returns **before** the poller-flag check, so PR 4783's zero-write entry gate does **not** cover it | **UNFIXED AND UNOWNED.** The only PR referencing it is the docs-only HOLD PR 4804. Residue shape persists on main |

### 4.6 Claims that rest on a document rather than an executed check

- **PR 4670's merge authorization.** Both threads read in full; the last recorded statement before
  the merge **explicitly withholds** it; the merge was performed 4 minutes later by the `zensgit`
  account. **No authorization found.** Whether an out-of-band owner instruction existed is
  **unverifiable from the repository or GitHub** — note that PR 4669's own RATIFY comment describes
  itself as *"a relay of that owner decision"* stated *"directly in the Codex thread"*, so an
  out-of-band channel demonstrably exists and is not captured here.
- **Every `RATIFIED` header, taken alone.** Row A is the proof that a header is not authorization.
  §5.2 records where headers and owner comments now **disagree**.
- **W6 draft inertness.** Whether `packages/openapi/drafts/` is read by any build or contract gate
  is **unverified**.
- **The sealed-export pin's enforcement logic** (§2.6) — consumer existence verified, assertion
  behaviour not.
- **PR 4804's two design-lock documents.** Their internal consistency with the ratified W4/W4C-5
  locks is **unverified**, and their file:line provenance is stated against an older baseline than
  the pinned HEAD.
- **The `test (18.x)` matrix leg.** I inspected only `test (20.x)` logs. The 18.x leg is
  **unverified**.
- **PR 4804 check greens.** The upstream collection recorded 14/14 green at head `e941eea9c1…`;
  the branch has since moved twice — to `4642f71328257a5efaf888d58b9ed9f8287cbb37` at the 1st pass
  and to **`a1344c77c09725b757b5e9408b501e433bc3d385`** at the 2nd, by **rebase**, so the older head
  is not reachable from the current one (re-derived at the 1st pass:
  **behind=1, ahead=4**), so that rollup is **stale**.

### 4.7 Scope boundary of this record

"Landed" = merged + files present at the pinned SHA. I ran **no build, no typecheck, no test
suite**. Where I cite green, I cite a job ID I personally re-read.

### 4.8 Mutation evidence that is lane-self-reported and re-executed by nothing

Added on the second pass, because §1.3 carried `mutation-proven` badges that §4 did not disclose and
that §3 row F grades as a defect when it appears elsewhere.

- **W4C-2's mutation evidence is lane-self-reported.** The three discriminating mutations for W4C-2
  exist only in PR 4670's own 2026-07-29T00:24:34Z comment ("All mutations were restored and their
  positive controls rerun green"). **No required check re-applies any of them**, so a regression to
  any of the three would be caught by no standing gate. The `mutation-proven` badge is withdrawn from
  §1.3's W4C-2 row; that row now reads `real-DB` + `adversarial gate`.
- **W4C-3c's badge was cited on the wrong leg.** `ok 42` is a set-emptiness assertion, not a
  mutation. The badge stands, but on five legs that were present and previously uncited — collector
  `:1048`, `:1257`, `:1360`, `:1386`, `:1414` — now named in §1.3.
- **W4C-5's badge was unanchored.** No mutation was named anywhere in an earlier pass. It is now
  anchored on the decoy / positive-control / negative-control legs of
  `w4c3a-rollout-control-inventory.test.ts` (`:149`, `:174`, `:197`, `:218`, `:236`), which execute
  in the no-DB step of the required lane.
- **The general rule this record now applies to itself:** a `mutation-proven` badge requires a
  **named leg that executes in a required lane**. A mutation reported in a PR comment is a lane's
  claim about work it did, not a standing guard, and is recorded as a residual rather than a badge.

---

## 5. Soak readiness

### 5.1 The ratified W4C-5 entry and exit criteria

**Authority chain** (all quoted from blobs at the pinned SHA):

- **W4 lock §14.9** (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:3102`):
  `9. W4C-5 staging requires separate owner authorization.`
- **W4 lock §12.8** (`:3008`, `:3031`): gate list opens with `separate owner authorization for
  staging org` and closes with `no production deploy/flag action`.

**ENTRY — state machine.** Only **seven** rollout transition pairs are legal, each with a
comparison write posture: `legacy→shadow` (shadow) · `shadow→eligible` (shadow) ·
`eligible→shadow` (shadow) · `eligible→authoritative` (authoritative) · `shadow→legacy`
(legacy_projection_only) · `authoritative→suspended` (preserved authoritative) ·
`suspended→authoritative` (preserved authoritative).
**"Every other pair fails before rollout-state/event DML."** (amendment `:40-57`)

**ENTRY — database predicates** (amendment `:84-108`). Returns BLOCKED with **zero rollout DML**
unless: exact named org with `scope='synthetic_staging'`; no nonterminal null-version legacy async
job; no incomplete operation / operation batch / import batch / source-bearing mismatch; every
retryable job has the §1 comparison posture; every pre-W4 import batch has an immutable closure or
frozen preimage; eligibility/authority has zero pending-or-reversible calculation-affecting request
whose latest snapshot is missing/unsupported/payload-stale/reversal-incomplete; zero unresolved
`legacy_time_ingress_not_authoritative` review; suspend serializes every source writer and changes
no operation/source/result/pointer/job row; resume proves the prior state was authoritative and the
referenced offline replay artifact reports zero critical/unresolved diffs.
**"It does not accept a caller-supplied aggregate `ready=true` as a substitute for these queries."**

**ENTRY — out-of-database evidence** (amendment `:110-128`). A hashed external manifest containing
exact deployed backend/web image SHA; pending migrations 0 and service health; owner authorization
reference and authorized target state; exact synthetic org ID and explicit `customerData=false`;
external notifications disabled and zero external destinations; every-entrypoint inventory and
observation dates; **seven distinct calendar days for authority promotion**; zero critical diffs and
unresolved reviews; suspend/resume, reversal, pointer/hash and residue evidence references.

**ENTRY — owner packet** (runbook `:25-40`). Exact synthetic org ID; exact 40-character deployed
backend and web image SHA; authorized first target (shadow only for a new campaign); approved start
timestamp and minimum seven-day window; confirmation the data is synthetic and externally isolated;
confirmation external notifications and destinations are disabled; authorization limited to the
named org/image/campaign; explicit exclusions for production, customer data, release tags and issue
closure. **"An old campaign, old image, agent-authored approval, or broad 'continue' does not
satisfy this packet."**

**RUN — daily acceptance** (runbook `:104-123`). Seven distinct calendar days; exact image and tool
SHAs unchanged; services healthy and migrations pending 0; zero critical shadow codes; zero
unresolved review items; zero external notification/destination attempts; no unknown
entrypoint/reason/posture/schema; campaign residue accounted for.
**"A failed day is recorded, not rerun into disappearance. Repair, image change, or contract change
ends the campaign; a new separately authorized campaign is required."**

**EXIT — drills, cleanup, report ceiling** (runbook `:125-150`). Separately recorded synthetic-only
drills (reversal restores the exact frozen predecessor; suspend blocks new source/result writes and
preserves the authoritative pointer; retryable authoritative jobs stay durable without operation
rows; offline replay during suspension is read-only with zero critical/unresolved diffs; resume
returns authoritative and the first changed punch supersedes the preserved pointer; mismatched
frozen posture and source-bearing mismatch both block). Cleanup uses only canonical
reversal/retirement paths from the P16 inventory; the residue report must show zero campaign-owned
live data. The final summary **"may state only 'internal synthetic W4C-5 soak evidence PASS' when
all gates are proven. It must not state customer UAT, production acceptance, deployment approval,
release readiness, or issue closure."**

**Five independent gates before the runbook is executable at all** (runbook `:152-162`): transition
hardening passes exact-head real-PostgreSQL/race/mutation review; tool plan/apply tests prove
zero-DML fail-closed behaviour; the staging workflow/package contains the exact reviewed tools;
owner separately authorizes the exact campaign packet; a final read-only boundary audit confirms no
staging action occurred during preparation.

### 5.2 ⚠️ CORRECTION — `OD-W4C-61` and `OD-4709-2` ARE RATIFIED

**This overturns a doc-header-derived reading.** Both amendment documents on main still read
`PROPOSED / HOLD`, but the **owner relay on issue 4556 dated 2026-08-05T08:27:37Z** (the most
recent comment on that issue) states:

> - PR 4746 exact merged SHA `45d71c4209af35a63768ce7ce9f576377f6b8ce4` is **RATIFIED** with `OD-4709-2=(a)`. …
> - PR 4747 exact merged SHA `2a2a5eee4f00abceff94ed6360e8c051708e35f7` is **RATIFIED** with `OD-W4C-61=(a)`. …
> - W6 preparation is authorized only for a design lock, contract, fixtures, and a non-runtime UI shell. It must remain Draft/HOLD and stop at its own independent gate.

**I verified both bound SHAs resolve to exactly the merged docs on main:**
`45d71c4209af…` → `docs(attendance): propose FSER-4 member projection contract (#4746)`;
`2a2a5eee4f00…` → `docs(attendance): prepare W4C-5 transition safety (#4747)`. The RATIFY binds
the exact merged object, as the landing sequences require.

The same relay states verbatim what is **NOT** authorized:

> No implementation PR merge; no FSER-4 follow-on frontend slice; no W6 runtime; no executable
> W4C-5 tooling; no staging transition, soak, flag, deployment, production/customer data, external
> notification, release, customer-UAT claim, or issue-closure action.
>
> These decisions are effective from this owner relay and are **not retroactive** authorization for
> earlier work.

**Consequences:**

1. `OD-W4C-61=(a)` is decided → the **core transition-boundary hardening** may proceed as Draft/HOLD.
   The soak is still **not** authorized.
2. `OD-4709-2=(a)` is decided → the **narrow member-safe server projection** prerequisite was
   authorized to start. PR 4772 delivered it (§1.2).
3. `OD-W6-0..9` remain **OPEN** — I searched GitHub for a ratify and found **none**
   (`gh search issues "OD-W6-0 RATIFY"` → `[]`). W6 preparation only.
4. **The in-repo headers are stale.** They were never updated after the relay. Anyone reading only
   the documents will report these two decisions as OPEN — which is exactly the row-A defect
   inverted.

### 5.3 Which preconditions landed, and which remain

| Precondition | Issue state | Delivered by | Landed on main? | Formally discharged? |
|---|---|---|---|---|
| **issue 4770** sweep starvation + zero observability | **OPEN**, **0 comments** | PR 4774 `523d254b8ad4` (primary) + PR 4779 `2927a71fafd6` (follow-up) | ✅ Yes, both ancestors, two-witnessed. Gates 1 and 3 are real legs in run-list-covered files; fairness impl is durable rotation | ❌ **NO.** Gate 2 is hand-verified only (row F). Issue has zero comments and no closure statement |
| **issue 4775** W4C-5 §3 request-snapshot 8-cell closed set | **OPEN**, **0 comments** | PR 4780 `0dc3596ddb59` | ✅ Yes. 8-cell set mechanically closed and derived from the exported frozen table; RACE F-K legs present; file is in the run-list | ❌ **NO.** Issue has zero comments and no closure statement |

> **Do not read the merged PR titles as discharge.** PR 4780's title says "complete the 8-cell
> closed set" — the *code* is complete and executes; the *precondition* carries no recorded owner
> discharge. Both issues remain OPEN with **zero comments**, meaning there is no statement anywhere
> explaining what still remains.

### 5.4 Soak authorization status — explicit statement

**The W4C-5 seven-day synthetic soak is separately owner-authorized and HAS NOT BEEN AUTHORIZED.**

- W4 lock §14.9 requires separate owner authorization for staging;
- the 2026-08-05 owner relay explicitly excludes *"no staging transition, soak, flag, deployment"*;
- the runbook is `DRAFT / NOT EXECUTABLE` and its §0 records that at publication no staging org is
  named, no image SHA or observation window is approved, and no soak authorization is granted;
- both named preconditions remain OPEN and undischarged;
- `OD-W4C-61=(a)` authorizes **hardening**, not the soak — the amendment's landing step 5 says
  *"Stop. Actual staging access, flag changes, transitions, seven-day soak, and issue closure remain
  separately owner-gated."*

**No gate in this document, and no gate in any of those documents, auto-triggers the soak.**

---

## 6. Closure readiness

### 6.1 Resolving the "section 14-10" pointer

⚠️ **The pointer "parent lock §14-10" does not resolve inside the parent lock.**
I scanned its headings at the pinned SHA: `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
has sections **0 through 10 only** — `## 0.` (line 75) … `## 10.` (line 764). **There is no §14.**

The clause carrying that number lives in the **W4 lock**. Quoted verbatim:

> **`docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:3103-3104`**
> ```
> 10. Production enablement and issue closure require separate final decisions
>     after verification MD is on main.
> ```

> ⚠️ **"After verification MD is on main" — for W4C-2 through W4C-5 there is no such MD.**
> `git ls-tree -r --name-only origin/main -- docs/development | grep -i 'attendance-issue-4556.*verification'`
> returns **exactly four** files: W1 (`…-w1-effective-group-membership-development-verification-20260723.md`),
> W2–W3 (`…-w2-w3-development-verification-20260724.md`), W4 (`…-w4-development-verification-20260726.md`),
> and W5 (`…-w5-flex-single-segment-development-verification-20260804.md`). **None covers W4C-2,
> W4C-3a, W4C-3b, W4C-3c, W4C-4 or W4C-5.** The one named "W4" is dated 2026-07-26 — authored
> *before* the W4C-2 runtime merged on 2026-07-29 — so it cannot cover it.
>
> This is not only a §14.10 closure precondition. W4 lock **§15** (`:3125-3126`) makes it a **W4
> completion** item in its own right: "verification MD records exact SHAs, runs, real-DB evidence,
> mutations, rollout state, and honest residuals". Different lock, different scope — the W8 plan is
> **not** a substitute for it. The companion design document files authoring it as a remaining-work
> item blocked by nothing.

Its two immediate neighbours, same list (`:3101-3102`):

> ```
> 8. Each runtime slice follows section 12 and enables no org.
> 9. W4C-5 staging requires separate owner authorization.
> ```

And W4 lock §15 (`:3127`, `:3129-3130`):

> ```
> - owner separately decides production enablement and issue 4556 closure.
>
> Until then W3 authoring compatibility is the safe public behavior and
> multi-segment authoritative calculation remains off.
> ```

**The parent lock's actual closure clause is §10 "Issue closure definition" at `:764-779`** —
mapped below.

### 6.2 Parent lock §10 closure checklist → evidence slots

| # | Condition (parent lock `:768-777`) | Evidence slot | Status |
|---|---|---|---|
| 1 | every acceptance item is mapped to a merged slice or explicitly removed by an owner decision | issue 4556 body checkboxes | ❌ **0 checked, 7 unchecked** (re-derived). W7 and W8 have **zero** artifacts on main |
| 2 | multi-segment actual minutes exclude breaks and expose segment anomalies | W4C-1 calculator + W4C-4 detail; `real-DB` | ⚠️ Code landed; **authoritative calculation is flag-OFF** and multi-segment remains preview-only per W3 boundary + W4 §15 |
| 3 | flex behavior is distinct from grace | W5 PR 4748 — `w5-flex-policy.ts` + 2 unit specs | ✅ Code landed and executes |
| 4 | calculation-group changes are effective-dated and historically explainable | W1 PR 4563 + timeline-integrity guard PR 4586 | ✅ Code landed; adversarial APPROVE 0 P1/0 P2 |
| 5 | all work-date entry points use the shared resolver | W2 PR 4567 resolver + adapters | ⚠️ Landed. **"All entry points" is an absolute claim I did not mechanically re-derive** — I verified the modules exist, not that every call site routes through them |
| 6 | OpenAPI, runtime, frontend, migrations, and tests agree | `contracts (strict\|dashboard\|openapi)` + `attendance-web-guard`; **plus the nightly `attendance-gate-contract-matrix.yml` schedule leg** | ⚠️ **Partially observable — the earlier "not observable at the pinned HEAD" is corrected.** The four contexts are indeed PR-scoped and absent on a main push (§2.2), but the contract matrix **also runs nightly on `main`** via `schedule: cron '45 4 * * *'`: eight consecutive `main` runs, all `success`, 2026-08-01 → 2026-08-08 (run `31150277495` @ `fceee2909612`; run `31240958190` @ `bea44e12d5af`). So a standing main-branch evidence source exists. **What is genuinely absent is a contract-matrix run at an issue-4556 head**, which is a narrower and truer statement. The generated-SDK leg for W4C-4 *was* green in the DML step |
| 7 | staging migration, rollback, and synthetic accounting evidence are durable | **THE SOAK** | ❌ **EMPTY. Never executed.** This is the single largest gap (§4.1, §5) |
| 8 | the user-facing group workflow shows what is effective, inherited, preview-only, or conflicting | **W6** | ❌ **PREP ONLY.** Contract + fixtures + a 52-line inert shell. `OD-W6-0..9` OPEN, no RATIFY found |

**Two of eight conditions (7 and 8) have empty evidence slots. Neither can be filled by code that
is already on main** — 7 requires an authorized soak campaign, 8 requires W6 runtime, which
requires a RATIFY that does not exist.

### 6.3 Forward sequence

Recorded on main in `docs/development/attendance-issue-4556-w4-remaining-slice-plan-20260726.md` §6:

> `W5 单段 flex → W6 组有效策略只读聚合（备料亦需另获授权）→ W7 组策略核算切换 → W8 验证与收口`

W6's own landing sequence ends (`w6 lock:303-304`):

> ```
> 7. Stop. Staging, flags, soak, W7, and issue 4556 closure each require separate
>    owner authorization; no gate in this document auto-triggers them.
> ```

### 6.4 Closure is the owner's ruling and is never automatic

**issue 4556 is OPEN** (re-derived; 18 comments). Its body has **7 unchecked, 0 checked** boxes.

Closure requires all eight §10 conditions **plus** the separate final decision of W4 lock §14.10.
Every relevant document independently disclaims closure authority: the parent lock's RATIFY
"does not authorize … issue closure" (`:16-18`); the W4 lock (`:18-20`); the W6 lock (`:14-15`);
the FSER-4 amendment (`:11-13`); the W4C-5 amendment (`:9-10`); the runbook's report ceiling
(`:148-150`).

> **No gate described in this document closes issue 4556, and no combination of green checks
> triggers closure. Closure is an owner ruling.**

---

## 7. Provenance

### 7.1 Baseline and method

| Item | Value |
|---|---|
| Pinned baseline | `origin/main@a45e1416002e6ca500eeda8d70e86c6443a10700` |
| Subject / date | `feat(directory): harden deprovision evidence ledger (#4646)` · 2026-08-08 11:44:26 +0800 |
| Fetch | `git fetch origin --prune` then `git rev-parse origin/main` |
| Ancestry | `git merge-base --is-ancestor`, exit-code-aware (rc=0 / rc=1 / unresolvable distinguished) |
| Second witness | literal `(#N)` in `git log -1 --format='%s' <sha>` |
| Set comparison | extract → `sort -u` → `comm -23` / `comm -13` (both directions, so phantom entries are caught) |
| Blob reads | `git show origin/main:<path>` — **never** the working tree |

> **Working-tree caveat:** `git status` reports
> `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md` as `DU`
> (unmerged). **Every read above deliberately used `origin/main` blobs**, so local edits are outside
> this record.

### 7.2 Two-witness ancestry table (23 rows, all `ANCESTOR SUBJ_OK`)

| PR | Squash SHA | Phase |
|---|---|---|
| PR 4558 | `077fde47859c561a13f820fb8ccc285a2ed5c58f` | W0 |
| PR 4560 | `9f989396b765dac7ef87dfd0e689a69e5be8bec8` | W0 |
| PR 4563 | `9055932e314265794b3baa8e80cff0828ba2902c` | W1 |
| PR 4567 | `f1e390977e57dc1239e312c7423f3cda2d1f055f` | W2 |
| PR 4569 | `c5f08aecd5732d70b616561398d8456240f62486` | W3 backend |
| PR 4570 | `ee8e586f74a69ae03102a93abd39bfc659e1e7be` | W3 frontend |
| PR 4588 | `a3e5765727ca608e8c49c7a44a025e6e4aae5d40` | W4 lock |
| PR 4606 | `d4dc12d8a8cde38c8f04f1952b3ba0b8b317265f` | W4C-0 |
| PR 4607 | `aebac4f8bef344b3ff3443ee045439c789a569a1` | W4C-1 |
| PR 4613 | `df610db9ab6c403da6233a9c5dae2579941a6275` | authorization erratum |
| PR 4670 | `5ae2cea0b2a84f0d36319f79c38ae2e796b5d20a` | W4C-2 runtime |
| PR 4688 | `9ce340e0f7939f1c1d786acc7eb99bd865a6fac5` | W4C-3a |
| PR 4716 | `ce7ffe8ce8eecae11f0ea497093fdcce2046888e` | W4C-3b |
| PR 4718 | `2d2b9eeccab22d77adf7f5b9c803dcf45afb4fdd` | W4C-3c |
| PR 4721 | `5edc118d5b7d895f5131818ece7bb3eb34796607` | W4C-4 |
| PR 4746 | `45d71c4209af35a63768ce7ce9f576377f6b8ce4` | FSER-4 contract (RATIFIED) |
| PR 4747 | `2a2a5eee4f00abceff94ed6360e8c051708e35f7` | W4C-5 prep (RATIFIED) |
| PR 4748 | `7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab` | W5 |
| PR 4771 | `2967da018ceea41b91098e14d4c15a57236eb5f8` | W6 prep |
| PR 4772 | `ce17ed321752d3adb96569f15a102c8986f303da` | FSER-4 prerequisite |
| PR 4774 | `523d254b8ad4ea19bb3088aac566d39429074c3d` | sweep fairness |
| PR 4779 | `2927a71fafd68dcb4896d1909c31f02ad710131f` | sweep observability |
| PR 4780 | `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b` | 8-cell closed set |

### 7.2b Two-witness extension over §1.3 **prose** SHAs (second pass)

The 23-row table above covers the SHAs this record tabulates. It did **not** cover SHAs cited only in
§1.3's running prose — which is exactly how PR 4725's unresolvable SHA survived (§1.3 FSER chain).
The same exit-code-aware ancestry check plus the literal `(#N)` subject witness was re-run over every
such SHA. **All 17 returned `ANCESTOR SUBJ_OK`:**

| PR | SHA (as cited) | Outcome |
|---|---|---|
| PR 4586 | `c81b3bc39202` | ANCESTOR SUBJ_OK |
| PR 4568 | `d6fa5d19b7a3` | ANCESTOR SUBJ_OK |
| PR 4584 | `78b4133bac15` | ANCESTOR SUBJ_OK |
| PR 4592 | `d6ac495b947c` | ANCESTOR SUBJ_OK |
| PR 4714 | `f4444e15e7a5` | ANCESTOR SUBJ_OK |
| PR 4637 | `d449aa7e6d02` | ANCESTOR SUBJ_OK |
| PR 4799 | `51c3d8720789` | ANCESTOR SUBJ_OK |
| PR 4712 | `7abd4e587294` | ANCESTOR SUBJ_OK |
| PR 4727 | `ebeafc08be26` | ANCESTOR SUBJ_OK |
| PR 4730 | `6b439a1ab05a` | ANCESTOR SUBJ_OK |
| PR 4735 | `390841a645e0` | ANCESTOR SUBJ_OK |
| **PR 4725** | **`4086cef6262c`** (corrected from `4086cef6262e`) | ANCESTOR SUBJ_OK |
| PR 4713 | `8806e9679e3e` | ANCESTOR SUBJ_OK |
| PR 4726 | `e0377e20e66a` | ANCESTOR SUBJ_OK |
| PR 4729 | `c64d95225936` | ANCESTOR SUBJ_OK |
| PR 4733 | `676ed2433813` | ANCESTOR SUBJ_OK |
| PR 4773 | `3601817969af` | ANCESTOR SUBJ_OK |

Every SHA above was resolved with `git rev-parse --verify` before use. **No abbreviation was
hand-expanded** — the corrected PR 4725 object was found by `git log --all --grep='(#4725)'`, not by
guessing the missing characters.

**Negative controls (all fired correctly):**

| Probe | Outcome |
|---|---|
| `deadbeefdeadbeef…` (fabricated) | `UNRESOLVABLE` — not misreported as `NOT_ANCESTOR` |
| PR 4612 API `merge_commit_sha` `61dee2d61e4133cfc11a276776355e5dbc3d28a9` | `UNRESOLVABLE` — a test-merge ref |
| PR 4805 head `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451` | `NOT_ANCESTOR` **and** `SUBJ_MISSING` |

### 7.3 File:line citations (all at the pinned SHA)

**Parent lock** — `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
`:3` Status RATIFIED · `:11-13` ratification record · `:16-18` "unlocks W1 only" ·
`:88-95` §0 boundary · `:645/663/675/687/707/719/731/743/755` §9.1-9.9 ·
`:764-779` §10 closure definition · headings `## 0.`–`## 10.` (no §14)

**W4 lock** — `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
`:3` RATIFIED · `:11-12` ratified object · `:14-20` authorization · `:3000-3031` §12.8 soak gates ·
`:3090` §14 heading · `:3101-3104` items 8/9/10 · `:3106` §15 · `:3127`, `:3129-3130`

**W6 lock** — `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`
`:3` PROPOSED/runtime HOLD · `:7` pinned baseline `db74bd8667df…` · `:12-17` preparation-only ·
`:294-304` landing sequence + stop clause · `:306-309` OD-W6-0..9 OPEN

**W4C-5 amendment** — `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md`
`:4` PROPOSED/staging HOLD · `:5` OD-W4C-61 · `:6` baseline `783eb72fe038…` · `:8-10` disclaimer ·
`:40-57` seven legal pairs · `:84-108` DB predicates · `:110-128` manifest · `:130-145` tooling ·
`:147-164` ten gates · `:166-176` OD-W4C-61 · `:178-186` landing

**Soak runbook** — `docs/deployment/attendance-issue-4556-w4c5-synthetic-soak-runbook-20260804.md`
`:4` DRAFT/NOT EXECUTABLE · `:6-9` · `:11-19` stop conditions · `:25-40` owner packet ·
`:67-86` preflight · `:104-123` daily acceptance · `:125-150` drills/cleanup/ceiling · `:152-162` five gates

**FSER-4 amendment** — `docs/development/attendance-4709-fser4-member-projection-contract-amendment-20260804.md`
`:4` PROPOSED/runtime HOLD · `:6-7` baseline · `:9-13` disclaimer · `:195-210` OD-4709-2 · `:212` landing

**Code**
`packages/core-backend/src/attendance/w4c3a-rollout-control.ts:814-823` (frozen 8-cell table), `:826` type
`packages/core-backend/src/attendance/w4c2-scheduled-run.ts:1238` (durable-rotation ORDER BY)
`packages/core-backend/src/attendance/w4c0-identity.ts:363` (allowlist env constant)
`packages/core-backend/tests/helpers/scratch-database.ts:368/381/395` (CLEAN/FORCED/FAILED)
`plugins/plugin-attendance/index.cjs:18` (identity helper require), `:29356`, `:49612` (env reads), `:44373`, `:44419` (routes)
`plugins/plugin-attendance/lib/attendance-shift-service.cjs:56`
`.env.example:168,177` · `docker/app.env.example` (0 hits)

**Tests**
`attendance-w4c3b-central-approval.db.test.ts:54-55,95` (16 DB-gated `it()`)
`attendance-w4c3b-request-snapshots.db.test.ts:14-15,54,166` (3 plain + 4 DB-gated)
`attendance-w4c3a-rollout-control.db.test.ts:21,383-385` · helper **declared** at `:389` · **5**
`expectSingleCellDefect` **call sites** at `:1660,1705,1946,1960,2081`
`src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts` (added by `3601817969…`; decoy /
positive-control / negative-control legs at `:149,174,197,218,236`; `DATABASE_URL` decoy string at
`:225`)
`src/attendance/__tests__/w4c3b-request-snapshot-metadata-fields.test.ts` (added by `0dc3596ddb…`)
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033` (`ok 42`, a set-emptiness
assertion) · W4C-3c **mutation** legs at `:1048,1257,1360,1386,1414`
`scripts/ops/attendance-openapi-parity-4556-contract.test.mjs` · invoked at
`scripts/ops/attendance-run-gate-contract-case.sh:217` · invocation guarded at
`scripts/ops/attendance-strict-import-advanced-contract.test.mjs:92`
`attendance-w4c2-sweep-fairness.db.test.ts:235,373`
`attendance-w4c2-sweep-call-through.db.test.ts:376,418,444,532`
`scripts/ops/attendance-w4c2-ci-wiring.test.mjs:71` (`FILES`, 33 entries), `:191`, `:259`; no `readdirSync`/`glob`
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (1,431 lines, 58 `test(` cases)
`scripts/attendance/w4c0-dml-inventory/` (11 modules) · `collector.cjs` EXCLUDED_PATH_SEGMENTS / EXCLUDED_FILENAME_MARKERS

**Workflows**
`plugin-tests.yml:3-18` triggers · `:223-224` K3 ops step · `:585` DML collectors ·
`:1192-1207` real-DB step (id `:1201`) · `:1233-1270` w4c entries · `:1305` scratch-drain
`attendance-gate-contract-matrix.yml:3-11` (no push) · `:24` job `contracts`
`phase5-validate.yml:3-7` (no push) · `:17` job `pr-validate`
`attendance-web-guard.yml:126-129` (push trigger) · **`:130-187` paths filter (key at `:130`, 57
entries `:131-187`)** · `:189` `jobs:` · `:190` job — corrected from an earlier `:126-148`, which
covered 18 of the 57 entries
`attendance-gate-contract-matrix.yml:3-11` — the `schedule: cron '45 4 * * *'` leg, nightly on `main`
`integration-guard.yml:~399-408` chain-completeness invocation + floor

### 7.4 CI runs and job logs personally re-read

| Object | ID | Result |
|---|---|---|
| Workflow run at pinned HEAD | `31237870895` — `Plugin System Tests`, `.github/workflows/plugin-tests.yml`, `event=push`, `head=a45e1416002e…` | — |
| Job `test (20.x)` | **`93053687144`** — `success`, 2026-08-08T03:44:38Z→04:08:20Z, 22,419 log lines | the source of every CI number in this record |
| Real-DB step result | log `:22360-22361` | `Test Files 98 passed (98)` / `Tests 1300 passed (1300)` — zero skips |
| No-DB unit step | log `:16985-16986` | `603 passed \| 191 skipped (794)` / `8323 passed \| 1709 skipped (10032)` |
| DML gate TAP | log `:4054-4059` | `# tests 58 / # pass 58 / # fail 0 / # skipped 0` |
| DML named subtests | log `:3764`, `:3969`, `:3732` | `ok 1` exact-head scan · `ok 42` W4C-3c zero-bypass · `ok 3` W4C-4 SDK |
| scratchDrain | grep over the log | `CLEAN`×2 (drainMs 63/63, residualBackends 0); `FORCED` 0; `57P01` 0; `Unhandled Error` 0 |
| Orphan describe titles | grep over the log | `W4C-3b R0 central approval` **0** · `…(real PostgreSQL)` **0** · `…snapshot guards` **3** |
| Steps enumerated | `gh api …/actions/jobs/93053687144` | K3 ops = step 6 `success`; W4C-2 wiring = step 28 `success`; W4C-3c cleanup = step 29 `success` |
| Check-run rollup at HEAD — **1st pass** | `gh api …/commits/a45e1416…/check-runs --paginate` | 20 success / 5 failure / 7 skipped / 2 pending; failures = `deploy`, `perf`, `smoke`, `strict-gates` |
| Check-run rollup at HEAD — **2nd pass, same command** | same | **21 success / 7 failure / 7 skipped / 0 pending**; failures = `perf` ×3, `verify-main`, `strict-gates`, `smoke`, `deploy`. **Not SHA-pinned** (§2.2) |
| Job step count | `gh api …/actions/jobs/93053687144 --jq '.steps \| length'` | **79** (≈40 enumerated; §2.3) |
| Contract matrix on `main` | `gh run list --workflow=attendance-gate-contract-matrix.yml --event=schedule --branch=main` | 8 consecutive `main` runs, all `success`, 2026-08-01 → 2026-08-08 (incl. `31150277495` @ `fceee2909612`, `31240958190` @ `bea44e12d5af`) |

### 7.5 Issues and PRs (states re-derived this session)

| Object | State |
|---|---|
| issue 4556 | **OPEN**, 18 comments, body 0 checked / 7 unchecked |
| issue 4629 Windows QA | **OPEN**, 15 comments, PQA 0 checked / 10 unchecked; last comment 2026-08-05T08:27:18Z |
| issue 4770 | **OPEN**, **0 comments** |
| issue 4775 | **OPEN**, **0 comments** |
| issue 4791 | **CLOSED/COMPLETED** 2026-08-07T15:44:55Z, 3 comments |
| issue 4792 | **OPEN**, **0 comments** |
| issue 4802 | **CLOSED**, 3 comments |
| PR 4612 | CLOSED, `merged=false`, DO-NOT-MERGE title |
| PR 4670 | MERGED 2026-07-29T00:28:25Z, head `04482b6b2828…`, `mergedBy=zensgit`, 3 comments |
| issue 4616 | **OPEN** — "attendance: scheduled 结果是否需要 per-record 粒度事件（(b2) 之后重估）"; references issue 4556 and PR 4612. Body sets a two-way disposition (close vs. keep-and-rewrite) whose `(b2)` precondition landed 2026-07-29, so it has been executable since and is unexecuted. **Added on the second pass; absent from the first inventory** |
| issue 4641 | **OPEN**, **0 comments**, created 2026-07-28 — "temporary MetaSheetServer stop leaves scheduler process alive after PQA-07". A defect produced *by* the PQA-07 run counted as one of only two PASSes (§4.2); frozen to the retired candidate `66a980357078…` and artifact `attendance-onprem-package-30243591566-1`. **Added on the second pass** |
| PR 4745 | **OPEN, DRAFT**, base `main`, head `043851d3db7bb8d4b4514af3b1354265f9b2cdf3` — the **owner-frozen QA tooling SHA**; all 16 check runs `success`, including all nine required contexts. **Added on the second pass** |
| PR 4634 | **OPEN, DRAFT**, head `66a980357078f9d243fd4b025b080ac9aca9fa21`, base = PR 4630's branch. Only **2 of 9** required contexts have ever run on it (`pr-validate`, `attendance-web-guard`, both `SUCCESS`) |
| PR 4630 | **OPEN, DRAFT**, `mergeStateStatus=DIRTY`, base `claude/w4c2-live-scheduled-shadow-20260725` (PR 4612's abandoned branch) |
| PR 4804 | **OPEN, DRAFT.** Head at 1st pass `4642f71328257a5efaf888d58b9ed9f8287cbb37` (behind=1 ahead=4); **head at 2nd pass `a1344c77c09725b757b5e9408b501e433bc3d385`**, `mergeable=MERGEABLE`, `mergeStateStatus=BEHIND`. Its earlier pin `e941eea9c1186bb49522c67148023b5f4fb9428a` was superseded by **rebase**, so anchors taken at it do not transfer |
| PR 4805 | **OPEN**, not draft. Head at 1st pass `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451` (behind=4 ahead=2, CONFLICTING on `s6a-package-provenance-pins.json` only); **head at 2nd pass `1448615c5aaf27e70c3dd3f1b20400c8661b362d`**, `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED` |
| PR 4810 | **OPEN, DRAFT**, head `4ca537c66bb00bede251cbabdcbdc7e730ec60f9`, `mergeable=MERGEABLE`, **`mergeStateStatus=BEHIND`** — base moved under `strict=true`, which a rebase clears. This is **not** `BLOCKED` |

> **All rows in this table are point-in-time.** Heads move, and two of them moved between this
> record's two passes. Re-read before relying on any of them.

### 7.6 Owner comments read in full

| Location | Timestamp | Bearing |
|---|---|---|
| Issue **issue 4556**, most recent comment | 2026-08-05T08:27:37Z | **RATIFIES `OD-4709-2=(a)` @ `45d71c4209af…` and `OD-W4C-61=(a)` @ `2a2a5eee4f00…`**; authorizes W6 **preparation only**; enumerates what is not authorized; states decisions are **not retroactive** |
| PR **PR 4669** | 2026-07-28T22:50:25Z | Owner RATIFY of `548d9f3597…` with `OD-W4C-54=(a)`; describes itself as a **relay** of a decision made in the Codex thread; excludes merging PR 4612, W4C-3a+, flags, deploy, soak, closure |
| PR **PR 4669** | 2026-07-28T18:30:50Z | Exact-head review record; "not an owner decision, merge authorization, runtime authorization"; 3 P2 + 2 P3 found and corrected |
| PR **PR 4670** | 2026-07-29T00:24:34Z | APPROVE 0 P1 / 0 P2 at head `04482b6b2828…`; **"technical gate only … does not authorize merging PR 4670 or PR 4612"** — merge followed 4 minutes later |
| Search | `gh search issues "OD-W6-0 RATIFY"` | `[]` — **no W6 ratify exists** |

### 7.7 Corrections this record makes to prior collected material

1. **`OD-4709-2` and `OD-W4C-61` are RATIFIED, not OPEN** (§5.2) — the in-repo headers are stale;
   the owner relay is authoritative. Both bound SHAs verified to resolve to the merged docs.
2. **`test (20.x)` at the pinned HEAD is `success`**, not in-progress — so all CI numbers here come
   from the pinned HEAD itself rather than an ancestor.
3. **The five absent required contexts have two different mechanisms**, not one (§2.2) — three
   `contracts` + `pr-validate` have **no push trigger at all**; `attendance-web-guard` **has** one
   and was **path-filtered out**.
4. **`perf` also failed** at the pinned HEAD — four distinct failing check names, not three.
5. **PR 4804's head moved twice** — to `4642f71328…` (behind=1 ahead=4) at the 1st pass and to
   **`a1344c77c0…`** at the 2nd, by rebase; the previously recorded 14/14 green
   rollup at `e941eea9c1…` is stale. **PR 4805 is behind=4**, not 3.
6. **W0 (PR 4558/PR 4560) is now two-witnessed**, closing a declared gap.
7. **PR 4670's authorization gap is tightened** from "unverified" to **"no merge authorization found
   in either thread; the last statement before the merge explicitly withholds it"** (§3 row B, §4.6).
8. **Unit-step totals are 8323/10032**, re-derived at the pinned HEAD (one test more than the
   ancestor-commit figures).
9. **The corpus comparison was re-run at three scan widths**, not one (§2.4). The narrow
   `attendance-w4c*` window was insufficient on its own — widening to `attendance-*` surfaced a
   **second violation of the two-point invariant in the opposite direction** (2 files in the
   run-list but absent from `test.exclude`), which the narrow window hid. Widening to the full
   integration corpus surfaced 5 more names, of which **4 are not orphans** (they run in dedicated
   `sealed-export-*` workflows) and 1 belongs to the approval line. **The "2 files / 20 assertions"
   headline survived widening and is a complete count for the attendance corpus, not a subset.**
10. **PR 4725's SHA was UNRESOLVABLE and is corrected** to `4086cef6262ccea8e1822afa5a34e19c7313f0f4`
    (§1.3), and the two-witness sweep is extended from the 23 tabulated rows to **every SHA cited in
    §1.3 prose** — 17 further rows, all `ANCESTOR SUBJ_OK` (§7.2b).
11. **W4C-5 did add files**: two unit suites, both executing. The "no files beneath them" sweep is
    retracted and re-derived as "zero new **src** modules" with the pathspec printed (§1.2, §1.3).
12. **Three `mutation-proven` badges were mis-anchored or unearned** — W4C-2's is withdrawn,
    W4C-3c's and W4C-5's are re-anchored on named executing legs (§4.8).
13. **`attendance-web-guard.yml`'s paths filter is `:130-187` (57 entries)**, not `:130-148` (18)
    (§2.2, §7.3). The negative match was re-run against all 57.
14. **The `contracts` family has a nightly main-branch evidence source** via
    `attendance-gate-contract-matrix.yml`'s `schedule` leg — so closure condition 6 is *partially*
    observable, not unobservable (§1.2, §2.2, §6.2).
15. **Job `93053687144` has 79 steps**, not ~40 (§2.3).
16. **A third, wholly unguarded test corpus exists** (`scripts/ops/attendance*.test.mjs`, 48 files,
    22 unreferenced) — class-level, not a 4556 coverage hole (§2.5).
17. **`expectSingleCellDefect` has 5 call sites, not 6** — the sixth was the declaration (§1.3).
18. **Row A's blast-radius list is six conditions, not five, and one of them was not re-derived**
    ("zero orgs in shadow" is a DB fact this method cannot produce) (§3 row A).
19. **Check-run rollups are not SHA-pinned**, demonstrated by two different readings of the same
    command at the same SHA (§2.2, §4.4, §7.4).
20. **W0 now has a row in the coverage map**, so its `real-DB` label is anchored, and its OpenAPI
    completion criterion is narrowed to "never re-derived at a 4556 head" (§1.2, §1.3).

### 7.8 Absolute-claim self-audit

Mechanically swept this document for `all` / `every` / `never` / `zero` / `none` / `only`.
Each surviving absolute is backed by a command I ran:

| Claim | Backing |
|---|---|
| "exactly 2 files in neither list" | `comm -23` against **both** sets + reverse `comm -13` returning empty, **re-run at three scan widths** (§2.4) — the narrow window was not trusted on its own |
| "zero skips in the real-DB step" | parenthesised total `(98)` equals `98 passed`; `(1300)` equals `1300 passed` |
| "0 occurrences" of the two describe titles | `grep -c` over the pinned-HEAD job log |
| "no `readdirSync`/`glob`" in the wiring guard | `grep -nE 'readdirSync\|readdir\|globSync\|glob\('` → no matches |
| "zero W7/W8 artifacts" | `git ls-tree -r --name-only \| grep -Eic '4556.*w7\|4556.*w8'` → **0**. **Positive control using the SAME construct on the SAME listing:** `grep -Eic '4556.*w4'` → **16** (e.g. `attendance-issue-4556-w4-development-verification-20260726.md`). *An earlier draft cited a different pathspec and pattern as the control; that would not have controlled this construct and has been replaced.* |
| "no closing-keyword `#N` forms in this document" | `grep -inE '\b(close[sd]?\|fix(e[sd])?\|resolve[sd]?)\s+#[0-9]+'` → empty. **Positive control:** the same regex was fed a synthetic keyword-plus-number string via `printf` and matched it, proving the pattern is capable of firing. (The control string is deliberately not reproduced here, so that this audit row cannot itself trip the sweep or be mistaken for a live reference.) |
| "no push trigger" for `contracts` / `pr-validate` | read the literal `on:` blocks |
| "flag absent from `docker/app.env.example`" | `grep -n` → no output |
| "0 checked PQA boxes" | `grep -c '\- \[x\].*PQA'` → 0, with `grep -c '\- \[ \].*PQA'` → 10 as the positive control |
| "no W6 ratify" | `gh search issues "OD-W6-0 RATIFY"` → `[]` — **weak evidence; search is not exhaustive** |
| "all 23 rows ANCESTOR SUBJ_OK" | the printed table, with 3 negative controls proving both witnesses can fail |
| "all 17 §1.3-prose SHAs ANCESTOR SUBJ_OK" | §7.2b's printed table; every SHA `git rev-parse --verify`'d first, so an unresolvable one cannot pass silently — this sweep exists **because** PR 4725's did not resolve |
| "zero new **src** modules in W4C-5" | the pathspec is printed: `-- 'packages/core-backend/src' ':(exclude)packages/core-backend/src/**/__tests__/**'`. The **unscoped** form returns files, which is why the earlier unqualified claim was wrong |
| "**57** paths entries at `:131-187`" | `awk 'NR>=131 && NR<=187' \| grep -c "^ *- '"` → 57; the cited `:131-148` window returns 18. All 57 matched against `git show --name-only` for `a45e1416…` → zero hits; `grep -n '[*?]'` over the 57 confirms exactly one wildcard entry |
| "**five** distinct failing check names at the pinned SHA" | `check-runs --paginate` on the second pass, enumerated by name. **Point-in-time, not SHA-pinned** — the first pass returned four names |
| "**48** ops suites, **22** unreferenced" | `git ls-tree … \| grep -cE 'attendance.*\.test\.mjs$'` → 48; per-basename `git grep -l -F` excluding self-matches. Negative control: `git grep -nE 'scripts/ops/\*' -- .github/workflows` → empty, so no glob picks them up |
| "**79** steps in job `93053687144`" | `gh api …/actions/jobs/93053687144 --jq '.steps \| length'`. The ~40 figure is now explicitly a **subset I enumerated**, not a job property |
| "**5** `expectSingleCellDefect` call sites" | `grep -n` output enumerated line by line; the `:389` hit is the **declaration** and is excluded and named as such |
| "`ok 42` is **not** a mutation" | read at collector `:1033` and in the job log at `:3969` — a set-emptiness assertion. The five real mutation legs are enumerated with line numbers |
| "no `push` trigger for `contracts`" | the literal `on:` block — **and now paired with its counterpart**: the `schedule` leg *does* run on `main`, proven by 8 enumerated run IDs/SHAs. "No push trigger" ≠ "no main evidence" |

**Absolutes retracted or hedged on the second pass, listed so the retraction propagates rather than
being quietly overwritten:** "no files beneath them" (W4C-5 sweep — false as stated); "all five
conditions independently re-derived" (six conditions, one not re-derivable by this method); "the only
two files in the attendance corpus" (now scoped to the `*.db.test.ts` filename marker); "a complete
count for the attendance corpus" (same scoping); "among ~40 steps" (79); "6 call sites" (5); "not
observable at the pinned HEAD" for closure condition 6 (partially observable); "the two-point wiring
**convention** / the invariant **the repo maintains**" (it is ratified lock text — W4 lock §12.9);
PR 4804's head stated as a single value (it moved twice, once by rebase).

**Two claims this record now makes that are stronger than "unevidenced", and their basis:** that
W4C-3b's slice-completion gate is **failed** (basis: W4 lock §12.9's own final sentence, quoted at
§2.4, applied to the two suites in neither list), and that **no verification MD covers W4C-2 …
W4C-5** (basis: the `git ls-tree | grep` enumeration at §6.1, which returns four files and is printed
with its pathspec). Both are derived from cited text plus a printed command, not from inference.

**Deliberately NOT asserted as absolutes:** that every work-date entry point uses the shared
resolver (§6.2 row 5); that the two orphan suites would pass if run; that no owner authorization for
PR 4670 exists anywhere (only: none found in the threads read); that the W6 draft is inert by
construction; that the `*.db.test.ts` marker captures every DB-gated spec (§2.4); that W4C-2's
mutations are guarded by anything standing (§4.8); that §7.2b's 17 rows exhaust the SHAs in this
document — they exhaust the ones cited in §1.3 prose.

---

*End of record. This document is a verification record. It is not a sign-off, and it triggers nothing.*
