# Approval Cancel-Round Phase 1 — Round-2 Verification (2026-09-18)

Branch: `feat/approval-cancel-round-phase1`, HEAD at time of writing: `296a47acb` (rebased onto
`main@89f1ecdee`). Design lock: `approval-change-request-design-lock-draft-20260915.md` (ratified).
Supplementary gate checklist: `impl-supplementary-gate-checklist-20260918.md`. Goal definition:
`goal-three-locks-full-implementation-20260918.md`.

## Scope of this document

This records the closure of the six items handed to round 2 of the lane (outlet-guard #3, CI-wiring
decision 1, plugin-mirror-constant decision 2, the 判据 II/IV / attendance-parity blocked-with-reason
decision 3, the Q-B/Q-C lock-order census construction, and this verification document's own virgin-DB
rerun). It is **not** a full lock-coverage audit — items in the supplementary checklist not named in
round 2's task (e.g. §2-G2's time anchor) are out of scope here and are left for the door-review that
precedes the Draft PR.

## 1. Item-by-item closure

| # | Item | Commit(s) | Evidence |
|---|---|---|---|
| 1 | Outlet-guard #3 (`applyNodeTimeoutEffect`) — two-part oracle (outcome literal `skipped_cancel_round` + deadline actually consumed), negative control = two-round scan hitting the same instance, env-flag read site | `af015de07`, `3482d99c0` | `approval-cancel-round-node-timeout-effect.db.test.ts`, §2 below |
| 2 | Decision 1 — CI wiring: promote the seven `approval-cancel-round-*.db.test.ts` files into the required `test (20.x)` step (`plugin-tests.yml`'s `approval-real-db-integration`), delete the standalone `approval-realdb-cancel-round.yml`, recompute the s6a `pluginTestsWorkflow` pin in the same commit, add `approval-cancel-round-ci-wiring.test.ts` | `e394c9e9c` | §3 below |
| 3 | Decision 2 — plugin-side mirror constant `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` in `plugin-attendance/index.cjs`, byte-identical to the core constant, pinned by a dedicated test, used for a defensive (behavior-adding-nothing) check | `e630b6ca7` | §4 below |
| 4 | Decision 3 — `attendance-parity.db.test.ts` and redemption 判据 II/IV are blocked-with-reason on slice 2 | (documentation-only, this file) | §5 below |
| 5 | Q-B / Q-C lock-order census, constructed with forward+reversed order and positive controls (not "could not construct") | `dc0943ae0`, `738f01d4a`, `af57d325c`, `296a47acb` | §6 below, and §2 test output |
| 6 | This verification document, including a virgin-DB rerun | this commit | §2, §7, §8 |

## 2. Fresh virgin-DB rerun (this commit)

**Honest baseline first**: every green result cited in this lane's prior commit messages (`0cbd79fbd`'s
"full attendance suite green", `6e2acba9c`'s DML-inventory 60/60, `e630b6ca7`'s "5 files, all green
(45 tests)") ran against the private DB `metasheet2_lock_c`, which had already accumulated schema state
and fixture rows from earlier rounds of this lane (and possibly other work) — it is **not** virgin. This
section is the fresh rerun the task required, against a database created and migrated from empty in
this same step:

```
createdb metasheet2_lock_c_virgin
DATABASE_URL=postgres://chouhua@localhost:5432/metasheet2_lock_c_virgin \
  pnpm --filter @metasheet/core-backend migrate
# → every migration in the repo runs from zero, ending at
#   zzzz20260918110000_add_attendance_requests_approval_workflow_key — no error, no skip.
```

**Order of execution** (recorded because it affects how "virgin" is read for each leg): the seven
`approval-cancel-round-*.db.test.ts` files and the two new unit tests ran against
`metasheet2_lock_c_virgin` **first, immediately after migration, before anything else touched the
database** — that leg is genuinely virgin end-to-end. The seven Q1c-fixture-pairing attendance files
(§7) ran **afterward, against the same already-migrated database**, which by then carried the row-level
residue the cancel-round suites had left behind (each of those suites cleans up its own rows in
`afterAll`, but the schema-completeness value of a virgin migration — the actual point of this exercise
— was already proven by the first leg; the second leg is not claimed as virgin, only as "ran clean
against a DB whose migrations were applied from empty").

**Config note** (two-point wiring, shown empirically, not just quoted from comments): invoking the seven
`.db.test.ts` files under the *default* `vitest.config.ts` collects and skips-to-zero all of them
(confirmed: a first attempt using the default config produced `Test Files 2 passed (2)` — only the two
`tests/unit/*.test.ts` files ran; all seven `tests/integration/*.db.test.ts` files were silently excluded
by `vitest.config.ts`'s exclude list, exactly the "excluded from the no-DB job" half of the two-point
contract). The required CI step invokes them with `--config vitest.integration.config.ts`, which is the
config actually used below.

### 2a. The seven `approval-cancel-round-*.db.test.ts` files + both new unit tests

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
  tests/integration/approval-cancel-round-creation.db.test.ts \
  tests/integration/approval-cancel-round-redemption.db.test.ts \
  tests/integration/approval-cancel-round-seat-guards.db.test.ts \
  tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
  tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
  tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts

  Test Files  7 passed (7)
       Tests  44 passed (44)
```

(The 44 already includes the lock-order-census file's 10 tests; a separate standalone rerun of just
that file, for readable verbose output, also shows `Test Files 1 passed (1)` / `Tests 10 passed (10)`
— it is the same suite, not additional coverage.)

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest run \
  tests/unit/approval-cancel-round-ci-wiring.test.ts \
  tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts

  Test Files  2 passed (2)
       Tests  15 passed (15)
```

**Sentinel census**: every one of the seven files carries the top-of-file
`itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL …')` guard, confirmed mechanically —
not just "the ones I happened to look at":

```
grep -l "EXPECT_DB === '1'" tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
```

**Combined new-test total for this leg**: 44 + 15 = **59** tests, 9 files, 0 failures, 0 skips (the
sentinel itself is a passing assertion in each file, already counted).

### 2b. s6a provenance pin (no drift on the current tree)

```
node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
✔ sealed-export-package-provenance.test.cjs (355.7ms)
ℹ tests 1, pass 1, fail 0
```

### 2c. Typecheck

```
npx tsc --noEmit -p .   → no output (clean)
```

## 3. Decision 1 — CI-wiring closure detail

`e394c9e9c` moved the seven files from the deleted standalone `approval-realdb-cancel-round.yml` into
`plugin-tests.yml`'s `approval-real-db-integration` step (the same step id
`REAL_DB_STEP_IDS.approval` used by `scripts/ops/ci-realdb-step-contract.mjs`), recomputed the s6a
`pluginTestsWorkflow` digest in the same commit, and added
`packages/core-backend/tests/unit/approval-cancel-round-ci-wiring.test.ts`.

**`scripts/ops/ci-realdb-step-contract.mjs` "processed per its own mechanism," as the task required**:
the supplementary checklist's premise (a hardcoded `FILES` array at `:99-102`) does **not** hold at this
head — that shape does not exist in the current file:

```
grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs
(0 matches)
```

Its exports (`REAL_DB_STEP_IDS`, a step-body parser) take the step id and a file path as **call-time**
arguments; the new guard supplies `REAL_DB_STEP_IDS.approval` and each of the seven file paths itself,
so there was no static list in that script to update. This is recorded here rather than silently
skipped, since a reviewer working from the checklist's literal line numbers will look for it and not
find it.

**What the new guard actually proves, and its limit**: `approval-cancel-round-ci-wiring.test.ts` pins,
for each of the seven files: excluded from the no-DB `vitest.config.ts` job; present exactly once as a
whole-file argument of the required step; absent from the sibling multitable real-DB step; and the
standalone workflow file confirmed deleted. Its own commit message records a mutation check (cp the
workflow file → drop one file from the run-list → both this guard and the repo-wide
`approval-ci-coverage-enumeration.test.ts` turn red → restore → `cmp` byte-identical to the pinned
sha256) — the closed-world protection this lane actually has is that repo-wide enumeration test, not a
new census of every `*-ci-wiring.test.ts` sibling (memory: `feedback_attendance_new_file_census_trio`,
supplementary checklist item 1's "45 个同族" caution). **A per-sibling census across all 45
`*-ci-wiring` guards was not performed in this lane** — that caution names a different failure mode
(a *sibling* guard's own hardcoded array missing this lane's new files) than what was checked here (this
lane's own guard being internally correct), and is left for the pre-PR door review, not claimed closed
by this document.

Confirmed unchanged since that commit: `git status` on the workflow file and the pin file is clean at
this HEAD (see `git diff --stat origin/main..HEAD` in the round-2 orientation step — no uncommitted
changes to either).

## 4. Decision 2 — plugin mirror constant closure detail

`e630b6ca7` added `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'` to
`plugins/plugin-attendance/index.cjs` (CJS boundary; same convention as the existing
`ATTENDANCE_APPROVAL_WORKFLOW_KEY` mirror at `:159`), and a defensive assertion in
`upsertAttendanceApprovalInstance` — the single chokepoint feeding both #10's `attendance_requests`
FK-pairing write and #11's `approval_instances.workflow_key` write — rejecting a payload that targets
the cancel-round key. `approval-cancel-round-plugin-mirror-constant.test.ts` pins: both constants
independently equal the literal (not merely equal to each other — guards against a
both-undefined vacuous pass); a source-text regex pins the *same identifier name* in `index.cjs`, not
just an equal value under a renamed identifier; the assertion throws for the cancel-round key and is
inert for the real attendance key and for missing/null payloads; and the "assigned exactly once" grep
claim behind the "adds no behavior" argument is itself mechanically re-checked in the test, not just
asserted in prose. Rerun in §2a above: 9/9 (this file's own test count includes the plugin-mirror suite
plus the shared assertion tests).

This second edit to `index.cjs` was made **after** `6e2acba9c` had already closed the four attendance
census pins (supplementary checklist item 14) for the *first* round of `index.cjs`/migration edits;
`e630b6ca7`'s own commit message records a fresh run of
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (60/60) for this second edit, so the
census closure is not stale for it.

## 5. Decision 3 — blocked-with-reason (attendance-parity, redemption 判据 II/IV)

**Status: blocked-with-reason. Left for slice 2. Not re-scheduled inside this lane.**

- `attendance-parity.db.test.ts` was never created in this lane. The file header of
  `approval-cancel-round-attendance-fk-migration.db.test.ts` (~lines 42-54) records this with its own
  `SUPERSEDED (2026-09-18)` marker (memory: `feedback_supersession_marker_must_evaluate_not_void.md` —
  the marker is pinned to the specific claim, not used to void the whole paragraph): the *original*
  reason ("blocked on WI-10/11, which are themselves blocked on WI-0's Q-B/Q-C closing") is no longer
  true, since §6 below shows Q-B/Q-C are now constructed and green. The *current* reason is
  OWNER-SCOPE, not technical: 判据 II (final approve exercising C-1's real attendance cancellation) and
  判据 IV (C-3's system-side close) are named as a second-slice item in this lane's own handoff — "a
  main-session ruling, not a technical blocker this file can close" (file's own words) — restated there
  as blocked-with-reason, not as a residual WI-0 dependency.
- Redemption's 判据 II and 判据 IV halves are not implemented here.
  `approval-cancel-round-redemption.db.test.ts` is explicitly scoped in its own title to "判据 III
  only" and its header (and the sibling outlet-guards/seat-guards file headers) name II/IV as
  "depend[ing] on WI-10/11/12, not on this branch."

Mechanical confirmation these are genuinely absent, not silently done elsewhere:

```
find . -iname "*attendance-parity*" -not -path "*/node_modules/*"
(no output — the file does not exist anywhere in the tree)

grep -rn "判据 II\|判据 IV" packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts
# 12 hits total, across attendance-fk-migration/redemption/outlet-guards/seat-guards. Re-read
# individually: several (redemption.db.test.ts:9,19,20,99; outlet-guards.db.test.ts:475) are
# substring artifacts of the string "判据 III" (which literally contains "判据 II" as a character
# prefix — "III" starts with "II") appearing in comments/a describe() title about 判据 III, not a
# claim about II. The remainder (attendance-fk-migration:50-51; redemption:10-11,16; outlet-guards:41;
# seat-guards:21) are genuine header/doc comments naming 判据 II and IV as a second-slice item out of
# this branch's scope. None of the 12 is a passing test assertion exercising 判据 II or IV.
```

This decision closes the item as **documented and boundaried**, not as "done" — the goal-definition
document's full-lock-coverage bar for redemption and attendance-parity remains open and is explicitly
not claimed met by this lane.

## 6. Q-B / Q-C lock-order census — construction, not an absence claim

Earlier in this lane's history, a commit (`0c7c990ab`, then partially retracted in `738f01d4a`) had
floated "Q-B may not be constructible" as a shortcut. That shortcut was withdrawn (`738f01d4a`:
"withdraw a false Q-B absence shortcut in the lock-order census") and both Q-B and Q-C were then
actually constructed (`dc0943ae0` for Q-A's own slice, `af57d325c` for Q-B/Q-C, hardened in `296a47acb`
for org-id isolation and mutation-tested scan coverage). All three legs (Q-A, Q-B, Q-C) live in the one
file `approval-cancel-round-lock-order-census.db.test.ts`, rerun on the virgin DB in §2a above (10/10):

- **Q-A**: `approval_instances` row lock vs. attendance class-`00` rollout advisory lock. Forward order
  (class-00 then instance row) does not deadlock (positive control) and correctly blocks-then-proceeds;
  the reversed order deadlocks deterministically (`40P01`).
- **Q-B**: `attendance_requests` row lock vs. attendance class-`11` operational-bulk-target advisory
  lock. Same shape: candidate order blocks-then-proceeds and has a passing positive control; the
  reversed order deadlocks deterministically (`40P01`).
- **Q-C**: record-link `row-auth` advisory lock vs. attendance class-`00` rollout advisory lock.
  `createCancelRoundInstance` is confirmed to never reference the record-link row-auth lock at all (a
  mechanical, freshly-re-read source scan — not a stale grep against an old head), so there is no order
  to violate; two positive controls prove the harness itself *can* see both locks held simultaneously
  via `pg_locks` and *can* force them into a real `40P01` deadlock when taken in opposite orders in an
  unrelated pairing — i.e., the "ABSENCE" verdict is not "the test couldn't construct a race," it is "a
  race was constructible and deliberately shown not to apply here."

## 7. Q1c fixture-pairing files — virgin-DB spot-check (in scope: files this lane modified)

The seven attendance `.db.test.ts`/`.test.ts` files this lane modified for `approval_workflow_key` /
`workflow_key` fixture pairing (Q1c, closed for non-virgin DB in `0cbd79fbd`) were also rerun against
the same migrated database, immediately after §2a (see the ordering caveat in §2 — this leg is not
claimed virgin, only "ran clean post-migration"):

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-approval-action-authorization.db.test.ts \
  tests/integration/attendance-approval-flow-dynamic-kind-s7-1.db.test.ts \
  tests/integration/attendance-decision-trace-w5-0.db.test.ts \
  tests/integration/attendance-plugin.test.ts \
  tests/integration/attendance-result-edit.test.ts \
  tests/integration/attendance-w4c3b-central-approval.db.test.ts \
  tests/integration/attendance-w4c3b-request-snapshots.db.test.ts

  Test Files  7 passed (7)
       Tests  298 passed (298)
```

This is a spot-check of the files this lane touched, not a rerun of the full ~150-file attendance
real-DB corpus named in `plugin-tests.yml`'s `attendance-real-db-integration` step — that full-corpus
run is what `0cbd79fbd` already recorded (against non-virgin `metasheet2_lock_c`) and re-running the
entire corpus is outside the six items this round was scoped to.

## 8. Environment disclosure (local vs. CI, not a new finding)

Local Postgres used for every run in this document: `PostgreSQL 15.17 (Homebrew) on
aarch64-apple-darwin25.2.0`, database `metasheet2_lock_c_virgin`, `lc_collate = en_US.UTF-8`, libc
locale provider (`psql -l`). `plugin-tests.yml`'s `approval-real-db-integration` step provisions
Postgres via `ankane/setup-postgres@v1` with `postgres-version: 14`. This is a pre-existing
version-vs-local gap that predates this lane (this document did not introduce it and does not attempt
to close it); it is noted here only so a reader of this verification does not mistake "green on
15.17/Homebrew" for "green on CI's actual PG 14 provisioner."

## 9. Grand total, this document

| Leg | Files | Tests | DB state |
|---|---|---|---|
| Cancel-round `.db.test.ts` × 7 (incl. lock-order-census standalone rerun) | 7 | 44 | virgin, first leg |
| Cancel-round unit tests × 2 | 2 | 15 | virgin, first leg |
| s6a provenance pin | 1 | 1 | n/a (no DB) |
| Attendance Q1c-pairing spot-check × 7 | 7 | 298 | post-migration, not virgin (second leg) |
| **Total** | **17 files** | **358** | 0 failures, 0 skips reported as passes |

`npx tsc --noEmit -p .` clean. `git status` clean at HEAD `296a47acb` before this commit.

## 10. Checklist status

All six round-2 items are closed: five by prior commits (traced in §1's table with commit SHAs), the
sixth (this document) by the virgin-DB rerun recorded in §2/§7 above. Decision 3 is closed as
**blocked-with-reason**, not as delivered — §5 is the authoritative record for what remains open for
slice 2 (attendance-parity, redemption 判据 II/IV) and must not be read as "done."
