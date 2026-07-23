# Attendance #4556 W1 Effective Group Membership - Development and Verification

Date: 2026-07-23

Status: **MERGED**

- Design authority:
  `attendance-shift-group-advanced-capability-design-lock-20260723.md`
  (`RATIFIED`, W1 scope only)
- Runtime PR: [#4563](https://github.com/zensgit/metasheet2/pull/4563)
- Merge commit: `9055932e314265794b3baa8e80cff0828ba2902c`
- Final reviewed branch head:
  `6fc5c13affe9b26946326b05138edab93801ae61`
- Final Actions run:
  [30020246440](https://github.com/zensgit/metasheet2/actions/runs/30020246440)
  (`test (18.x)`, `test (20.x)`, and coverage all successful)

## 1. Delivered scope

W1 adds the effective-dated calculation-group membership substrate required by
OD-4556-4 and OD-4556-12:

1. `attendance_calculation_group_memberships`
   - one inclusive `[effective_from, effective_to]` interval per membership;
   - open-ended intervals use `NULL`;
   - PostgreSQL exclusion constraint prevents overlapping
     `org_id + user_id + date` ranges;
   - same-org group references and active user/org lifecycle checks fail closed.
2. `attendance_calculation_group_membership_operations`
   - immutable actor, reason, correlation, before/after, and response snapshot;
   - exact correlation replay returns the stored response;
   - mismatched correlation reuse returns conflict without another write.
3. One org-scoped timeline read and one atomic transition command:
   - `GET /api/attendance-admin/calculation-group-memberships`;
   - `POST /api/attendance-admin/calculation-group-memberships/transition`.
4. OpenAPI and generated SDK expose effective dates, audit context, and the
   timeline/transition-only write surface.
5. Dedicated source, route, migration, concurrency, replay, and real-DB gates
   are wired into required CI.

## 2. Invariants proven

- Two intervals cannot overlap even when they only share an inclusive boundary.
- A transition at date `D` closes the current interval at `D-1`.
- A pre-existing future interval is preserved; the inserted interval ends at
  `futureStart-1`.
- Calculation groups from another org cannot be assigned.
- Inactive users and inactive `user_orgs` membership fail closed.
- The authenticated actor is authoritative; request-body actor spoofing is not
  accepted.
- UUID references are canonicalized before no-op and replay comparison.
- Timeline rows are locked before lifecycle rows in both the service and the
  semantic-update trigger, preventing the mixed-writer deadlock found during
  adversarial review.
- The service has no replace-all, delete, legacy dual-write, or calculation
  cutover path.

## 3. Adversarial review record

The independent review initially found five material problems:

1. user/org lifecycle TOCTOU during transition;
2. uppercase UUID replay/no-op fragmentation;
3. unreachable or missing OpenAPI `422`, `500`, and `503` responses;
4. insufficient migration and concurrency execution in required CI;
5. opposite lifecycle/timeline lock order causing a mixed-writer deadlock.

All five were reproduced and repaired. The final adversarial verdict on the
runtime implementation was **APPROVE, 0 P1 / 0 P2**.

A subsequent CI failure was also real: the new route tests used seven
`request(app)` sites and were rejected by the repository-wide
`supertest-app-mode-tripwire`. They were moved to the shared
`usePinnedServer()` transport. Product/runtime bytes were unchanged.

## 4. Verification

Final post-rebase local proof under Node `20.20.2`:

- attendance OpenAPI parity: `7/7` PASS;
- W1 source/CI contract: `5/5` PASS;
- W1 route suite: `7/7` PASS;
- W1 real PostgreSQL suite: `10/10` PASS;
- backend typecheck: PASS;
- OpenAPI rebuild: clean;
- `git diff --check`: PASS.

Real-DB coverage includes:

- migration down/up/second-up replay;
- inclusive boundary rejection;
- same-org and active-lifecycle guards;
- exact and conflicting idempotency replay;
- UUID case canonicalization;
- future interval preservation;
- concurrent direct overlapping writes;
- service transition racing deactivation;
- direct semantic update racing a service transition.

Mutation/negative proof:

- remove both lifecycle locks -> deactivation race test RED;
- remove UUID lowercase canonicalization -> replay test RED;
- change inclusive `[]` range to `[)` -> boundary/concurrency tests RED;
- remove OpenAPI `422` -> contract test RED;
- restore the old lifecycle-before-timeline lock order -> mixed-writer test
  reproduces `40P01` and RED.

Fresh GitHub checks on the final exact head:

- migration replay: PASS;
- attendance contract matrix: PASS;
- web tests: PASS;
- `test (18.x)`: PASS;
- `test (20.x)`: PASS, including the real PostgreSQL attendance integration
  list;
- coverage: PASS.

## 5. Explicit non-delivery

W1 does **not**:

- write or reuse legacy `attendance_group_members`;
- write or reuse `attendance_schedule_group_members`;
- mutate `user_orgs`;
- change any current attendance calculation or record read path;
- backfill historical group membership;
- enable a runtime flag;
- deploy or run production migrations;
- recalculate historical attendance;
- add a universal group save endpoint.

The new membership model is therefore a durable substrate, not a calculation
cutover. Issue #4556 remains open.

## 6. Next authorized slice

W2 is separately authorized after W1 merge:

- introduce one `AttendanceWorkDateResolver`;
- fold #4558 into that implementation;
- add live/import/correction/overtime/derived-writer adapters;
- preserve the RATIFIED precedence and ambiguity rules;
- add no segment support and no group-policy calculation cutover.

W3 and later slices remain outside this document's delivery claim.
