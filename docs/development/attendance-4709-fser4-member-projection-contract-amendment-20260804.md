# Attendance #4709 FSER-4 Member Projection Contract Amendment

Date: 2026-08-04
Status: **PROPOSED / runtime HOLD**
Issue: `#4709`
Baseline: `origin/main` at
`783eb72fe038083e21d896bc220c7afcaffaf88d`

This document is a contract repair discovered while starting the authorized
FSER-4 frontend slice. It authorizes no runtime, merge, flag, deployment,
staging, production/customer data use, or issue closure. FSER-4 runtime remains
blocked until the owner ratifies one option in section 6 against the exact
merged SHA of this amendment.

## 0. Finding

The RATIFIED FSER lock requires all four surfaces to use one authoritative
effectiveness source:

- group drawer: full group state and counts;
- employee schedule: the employee's own matching/non-matching applicability
  and group state, without unrelated counts;
- decision trace: desired revision, producer comparison, and reason codes;
- report: group state and counts.

The shipped read contract cannot satisfy that requirement safely:

1. The only effectiveness route is
   `GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness` and is
   guarded by `attendance:admin`.
2. Its response is the whole-group aggregate, including member counts and drift
   sets.
3. The lock explicitly forbids a future self projection from reusing that admin
   response wholesale.
4. The employee workspace is a self-service surface. Fetching the admin payload
   and hiding fields in Vue would still disclose those fields over the wire and
   would fail for ordinary employees before rendering.

Therefore a frontend-only FSER-4 implementation would either be incomplete or
would create a permission/data-minimization defect. The contradiction must be
repaired in the server read contract before the four-surface UI gate can be
honestly satisfied.

## 1. Current Evidence

Evidence on the baseline:

- `docs/development/attendance-4709-fixed-schedule-effectiveness-read-model-design-lock-20260801.md:154-201`
  defines only the admin aggregate route and explicitly constrains a future self
  projection.
- The same lock at `:262-284` requires employee and decision-trace projections
  in FSER-4.
- `plugins/plugin-attendance/index.cjs:44301-44333` exposes only the
  `attendance:admin` route.
- `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:71-156`
  derives aggregate counts, and `:158-212` always loads all group members and
  managed rows before returning the aggregate response.
- `apps/web/src/views/attendance/AttendanceEmployeeWorkspace.vue:355-409` is
  the existing employee self-service rule surface.
- `apps/web/src/views/attendance/useAttendanceDecisionTrace.ts:28-91` already
  distinguishes admin and self hosts; self request construction structurally
  omits `userId`.

The FSER-1, FSER-2, and FSER-3 merged implementations are respectively rooted
at `ebeafc08be265e458013077887d4b422ee15c09b`,
`6b439a1ab05a8b2588e42f59499f9849bd3242b1`, and
`390841a645e07221f1769760af6c933a37644729`. This amendment does not revise
their persisted desired-config or group-state predicates.

## 2. Recommended Repair

Add one member-safe read projection beside the existing admin aggregate:

`GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me`

The route is read-only and uses `attendance:read`. Its subject and organization
come only from the authenticated principal. It accepts no body, `userId`, or
`orgId`; any such body or query selector is rejected with a typed 400 before
scoped SQL. `x-user-id` and `x-org-id` never become identity sources. Existing
bearer/development-token clients that send no identity headers continue
unchanged; when a header is present it is tolerated only when byte-equal to the
authenticated principal, while a mismatch is a 403 before scoped SQL.
An authenticated principal without an organization receives a values-free 403
before membership or effectiveness SQL.

The route first proves in one org-scoped query that the authenticated subject
has `users.is_active = true` and
`COALESCE(users.activation_status, 'activated') = 'activated'`, has an active
`user_orgs` membership in the authenticated organization, and is an
`attendance_group_members` member of the named group in that same organization.
Missing group, missing or inactive organization membership, inactive or
non-activated subject, and non-membership use the same values-free 404 shape.
Only after that proof may it load the desired configuration and managed
assignment facts.

The server may compute the existing full group derivation internally, but the
self response is a distinct exact-key projection and never serializes coverage
counts, drift counts, managed sets, producer keys, or any user ID.

Recommended response:

```json
{
  "ok": true,
  "data": {
    "groupId": "uuid",
    "state": "pending_apply",
    "reasonCodes": ["TARGET_MEMBER_MISSING"],
    "desired": {
      "shiftId": "uuid",
      "startDate": "2026-08-01",
      "endDate": "2026-08-31",
      "revision": 2
    },
    "applicability": "non_matching",
    "evaluatedAt": "2026-08-04T00:00:00.000Z"
  }
}
```

`applicability` is a closed enum:

- `not_configured`: no desired config exists;
- `matching`: the authenticated subject has exactly one eligible managed row
  matching the desired producer key and assignment values;
- `non_matching`: the authenticated subject is a group member but does not meet
  the exact `matching` predicate.

The group `state` and `reasonCodes` are byte-identical projections of the same
canonical derivation used by the admin route. Applicability is derived in that
same module from the already loaded member/assignment facts. Neither the route
nor the frontend reimplements the four-state predicates. Parity tests inject one
evaluation instant into one canonical derivation; they do not compare two live
wall-clock calls and call that equality.

## 3. Surface Wiring After Repair

One strict shared client/composable owns parsing, stale-response suppression,
and fail-closed error posture for both response shapes. It may expose two load
methods but no status derivation.

| Surface | Authorized source | Allowed projection |
| --- | --- | --- |
| Group drawer | Existing admin aggregate route | State, desired config, counts, drift sets, and existing exact-key actions |
| Employee schedule | New member-safe `/me` route | State, desired config, own applicability, reason codes; no counts |
| Self decision trace | New member-safe `/me` route | Read-only desired revision, state, applicability, and reason codes |
| Admin decision trace | Existing admin aggregate route | Read-only desired revision, state, producer comparison, and reason codes |
| Report | Existing admin aggregate route | Group state and counts only; no actions or raw IDs |

The client displays an explicit unavailable/unknown posture on 401, 403, 404,
503, malformed JSON, unknown state/reason/applicability, or response-shape
mismatch. No error becomes `not_configured`, `configuration_changed`,
`pending_apply`, or `effective`.

## 4. Completion Gates

1. Two-user/same-org and two-org matrices prove the `/me` route can read only
   the token subject's membership and applicability. Inactive `users`,
   non-activated `users`, and inactive or missing `user_orgs` rows are separate
   negative legs.
2. Removing the subject predicate, authenticated-org predicate, or either
   active-membership predicate makes a named negative leg red.
3. A body/query `userId` or `orgId` is always rejected with the typed 400; a
   mismatched `x-user-id` or `x-org-id` is rejected with 403; byte-equal headers
   are tolerated but never used as identity. Every rejection precedes
   config/member/assignment SQL. Missing authenticated org is a separate 403
   leg before SQL.
4. Non-member, inactive or non-activated subject, inactive or missing org
   membership, and missing group responses are byte-identical 404s.
5. Admin and self projections over the same fixture and one injected evaluation
   instant return the same `state`, `reasonCodes`, desired revision, and
   `evaluatedAt`.
6. The self response exact-key test rejects `coverage`, `drift`, `managedSets`,
   `producerKey`, and every raw user identifier at any nesting depth.
7. Each surface imports the shared parser/composable; repository scan finds no
   second four-state derivation or reason-order table in frontend code.
8. Group, employee, trace, and report fixtures cover all four states and both
   member applicability values. Removing any mount makes the corresponding
   browser leg red.
9. Three viewports prove no overlap and readable state/error postures. Browser
   evidence uses synthetic data only.
10. OpenAPI lint/build/generated diff, web guard run-list wiring, plugin tests,
    and exact-head independent review are green.

## 5. Explicit Non-Scope

- no new writable status or assignment path;
- no group membership model change;
- no automatic apply/rebuild/clear;
- no arbitrary admin `userId` projection;
- no wildcard group read;
- no raw member list in effectiveness responses;
- no flag, deployment, staging, production/customer data, or issue closure.

## 6. Owner Decision

`OD-4709-2` remains **OPEN**.

- **(a) RECOMMENDED:** add the narrow authenticated-member projection in
  section 2, including its declared values-free desired shift/window/revision
  projection, then complete all FSER-4 surfaces and gates in sections 3-4.
- **(b):** keep the current admin-only API and narrow FSER-4 to group drawer,
  admin trace, and report. Employee schedule and self trace remain explicitly
  deferred and the original four-surface completion gate is amended before any
  runtime is claimed complete.

Option (a) is recommended because it preserves the already RATIFIED
four-surface product goal while adding only one read-only, subject-locked
projection. Option (b) is smaller but leaves the user-facing consistency gap
that motivated `#4709`.

## 7. Landing Sequence

1. Merge this document as `PROPOSED` after exact-head docs review.
2. Owner RATIFYs the exact merged SHA and selects `OD-4709-2`.
3. If `(a)`, implement the server projection and its real-DB authorization
   matrix in one Draft/HOLD prerequisite PR.
4. After that prerequisite merges under separate authorization, implement the
   shared FSER-4 frontend projections in one Draft/HOLD PR.
5. Run exact-head independent review and stop for the separately authorized
   merge decision.
