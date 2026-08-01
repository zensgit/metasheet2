# Attendance #4709 Fixed-Schedule Effectiveness Read Model Design Lock

Date: 2026-08-01
Status: PROPOSED; docs-only; no runtime, migration, route, API, UI, flag, or deployment authorization.
Issue: `#4709`
Baseline: `origin/main` at `9ce340e0f7939f1c1d786acc7eb99bd865a6fac5`

## 0. Purpose

Windows QA exposed a product-readability gap: an administrator can preview and
apply a group fixed schedule, but the group, employee, trace, and report
surfaces cannot answer the same stable question: is the selected fixed schedule
not configured, waiting to be applied, effective, or changed since the last
apply?

The four labels are a read model. They must not become a second writable state
machine. This lock identifies the one missing authoritative fact needed to
derive them and defines the smallest implementation sequence.

## 1. Current Grounding

| Area | Current fact | Consequence |
| --- | --- | --- |
| Fixed-schedule form | `AttendanceView.vue` keeps `shiftId`, `startDate`, and `endDate` in `attendanceGroupFixedSchedulePreviewForm`; reset selects the first shift and today's date. | The desired selection is browser-local and disappears on reload. |
| Preview/apply/rebuild/clear | The four group routes receive the same three values in each request body. | There is no durable desired configuration to read from another surface. |
| Applied facts | Apply/rebuild writes per-user `attendance_shift_assignments`; managed rows carry `producer_type`, `producer_ref_id`, `producer_key`, and `producer_run_id`. | Applied results are durable and can prove what was materialized. |
| Producer identity | `buildAttendanceGroupFixedScheduleProducerKey` includes group, shift, start date, and end date. | Existing managed rows can be compared with one desired configuration without adding another result identity. |
| Group schema | `attendance_groups` stores group identity, timezone, rule-set link, description, and the later `attendance_type` category; it has no fixed-schedule shift/window selection. | The four-state contract cannot be reconstructed from the group row today; `attendance_type` is not desired fixed-schedule configuration. |
| Earlier FS-A boundary | The 2026-05-28 V1 lock deliberately made assignments the only schedule facts and forbade a persistent group schedule type. | `#4709` is a deliberate vNext amendment, not an implementation detail that can be slipped into a read endpoint. |

Evidence anchors on the baseline:

- `plugins/plugin-attendance/index.cjs:10617-10628`
- `plugins/plugin-attendance/index.cjs:10630-10639`
- `plugins/plugin-attendance/index.cjs:10733-10750`
- `plugins/plugin-attendance/index.cjs:10936-10961`
- `plugins/plugin-attendance/index.cjs:40879-41149`
- `apps/web/src/views/AttendanceView.vue:13412-13416`
- `apps/web/src/views/AttendanceView.vue:27109-27114`
- `apps/web/src/views/AttendanceView.vue:27422-27574`
- `packages/core-backend/src/db/migrations/zzzz20260204123000_create_attendance_groups.ts:8-49`
- `packages/core-backend/src/db/migrations/zzzz20260529213000_add_attendance_group_type.ts:12-29`
- `docs/development/attendance-group-admin-ux-fixed-schedule-design-20260528.md:40-75`

## 2. Contradiction That Must Be Resolved

The following two requirements cannot both be satisfied with the current data:

1. `pending_apply` must survive reload and be visible from employee/report
   surfaces before any assignment row is written.
2. No durable desired fixed-schedule configuration may exist outside the
   assignment result rows.

Producer metadata proves applied results only. It cannot prove an unapplied
operator selection. Inferring intent from the latest producer run would make
`pending_apply` impossible and would silently convert historical results into
current desired configuration.

Therefore this design amends only the earlier "no persistent group schedule
selection" boundary. Assignment rows remain the only effective schedule facts.

## 3. Recommended Authoritative Fact

Add one desired-configuration record per attendance group. It is configuration,
not status and not an effective schedule fact.

Recommended table: `attendance_group_fixed_schedule_configs`.

| Field | Contract |
| --- | --- |
| `id` | UUID primary key. |
| `org_id` | Required tenant anchor. Every read and write includes it. |
| `group_id` | Required attendance group; unique with `org_id`. A composite `(group_id, org_id)` foreign key references `attendance_groups(id, org_id)` with `ON DELETE CASCADE`, so deleting a group cannot strand desired config or add a new delete blocker. |
| `shift_id` | Required desired shift; runtime validates the shift belongs to the same org. A foreign key to `attendance_shifts(id)` uses `ON DELETE RESTRICT`; the existing canonical shift-delete service adds this config table to its blocker set and returns its typed 409 before attempting the delete. |
| `start_date` / `end_date` | Required finite desired window; start must not exceed end. |
| `revision` | Monotonic configuration revision, incremented only when one of the three desired values changes. |
| `updated_by` / timestamps | Audit attribution only; never used to derive effectiveness. |

Hard rules:

1. Do not add `status`, `effectiveness`, `applied`, or equivalent writable
   columns.
2. Do not copy this desired configuration into `attendance_groups` JSON.
3. Do not treat the config row as an assignment consumed by effective-calendar
   or calculation.
4. Do not infer or backfill a desired config from historical assignment rows.
5. Saving desired config through the dedicated config route writes no
   assignment, event, notification, or recalculation result.
6. Apply/rebuild must consume a transactionally reloaded config row, not trust a
   client-supplied shadow copy after the config exists.

## 4. Derived Four-State Contract

The read model is computed from the desired config, current group membership,
and eligible managed assignment rows whose producer type is
`attendance_group_fixed_schedule` and whose producer reference is the group.
Eligible means `COALESCE(is_active, true)=true` and
`COALESCE(publish_status, 'published')='published'`, matching the existing
managed-row loader. Pending or reopened publication rows are reported
separately and cannot make the desired config effective.

| State | Exact predicate |
| --- | --- |
| `not_configured` | No desired config row exists. Historical managed rows, if any, are reported as drift evidence but do not become intent. |
| `configuration_changed` | A desired config exists and at least one eligible managed row for the group has a producer key different from the desired producer key. This state takes precedence over `pending_apply`. |
| `effective` | A desired config exists; the group has at least one current member; every current group member has exactly one eligible managed row matching the desired producer key and desired assignment values; no eligible managed row for that key targets a non-member; and no different-key eligible managed row exists for the group. |
| `pending_apply` | A desired config exists, no different-key eligible managed row exists, and the `effective` predicate is false. This includes a newly saved config, newly added members, missing rows, duplicate matching rows, or stale rows for removed members. |

The state machine has a required recovery path. It must not leave
`configuration_changed` as a terminal badge:

1. The read model returns each distinct superseded managed set as group-safe
   values (`shiftId`, `startDate`, `endDate`, producer key, and row count), never
   user IDs.
2. The operator explicitly clears each superseded set through the existing
   exact-key clear contract. No wildcard group clear is added.
3. Once no different-key eligible row remains, the state becomes
   `pending_apply`.
4. Applying the desired config then makes the state `effective` when its complete
   coverage predicate is satisfied.

Apply and rebuild do not silently deactivate a different producer key. That
existing ownership boundary remains intact.

The response also returns values-free reason codes so each surface explains why
the state was chosen without exposing employee lists by default:

- `NO_DESIRED_CONFIG`
- `NO_TARGET_MEMBERS`
- `DIFFERENT_MANAGED_KEY_ACTIVE`
- `TARGET_MEMBER_MISSING`
- `NON_MEMBER_TARGET_ACTIVE`
- `DUPLICATE_MATCHING_ASSIGNMENT`
- `ASSIGNMENT_VALUE_MISMATCH`
- `UNPUBLISHED_MANAGED_ROW`
- `EFFECTIVE`

Reason codes are de-duplicated and returned in the order listed above. A member
whose only desired-key row is unpublished contributes both
`TARGET_MEMBER_MISSING` and `UNPUBLISHED_MANAGED_ROW` because the row is not yet
eligible coverage.

Unknown schema or an unreadable dependency fails closed with `503 DB_NOT_READY`;
it must not be rendered as `not_configured`.

## 5. Read API

First slice adds one org-scoped, read-only service and route:

`GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness`

Response shape:

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
    "coverage": {
      "targetMembers": 12,
      "matchingMembers": 11,
      "missingMembers": 1,
      "nonMemberTargets": 0,
      "differentKeyRows": 0
    },
    "drift": {
      "unconfiguredManagedRows": 0,
      "unpublishedManagedRows": 0,
      "managedSets": []
    },
    "evaluatedAt": "2026-08-01T00:00:00.000Z"
  }
}
```

`desired` is `null` for `not_configured`. The default response contains counts,
not user IDs. The same service is the only source for group, employee, trace,
and report projections.

Authorization must happen before any scoped SQL. This v1 read route uses
`withPermission('attendance:admin')`. Organization identity comes from the
authenticated principal via `getAuthenticatedOrgId(req)`, never from
`getOrgId(req)` or `DEFAULT_ORG_ID`. A body, query, or `x-org-id` value may be
absent or equal to the authenticated organization; a mismatch returns 403
before group, config, membership, shift, or assignment SQL. An authenticated
principal with no organization also returns the repository's
authenticated-but-unscoped 403 posture before SQL. A future self projection may
expose only the token subject's own applicability and must not reuse the admin
response wholesale.

FSER-1 introduces one fixed-schedule route actor-context helper and uses it for
effectiveness-read, config-save, preview, apply, rebuild, and clear. The helper
derives both actor
and organization solely through `getAuthenticatedUserId(req)` and
`getAuthenticatedOrgId(req)`. It never calls `getUserId(req)` or `getOrgId(req)`
and never accepts `x-user-id` as an identity source. A missing authenticated
actor returns 401 and a missing authenticated org returns the repository's
authenticated-but-unscoped 403 posture, both before scoped SQL. Client org
selectors and `x-user-id` may be absent or byte-equal to the authenticated
values; a mismatch fails before the existing admin/scheduler-scope role check.
Apply/rebuild/clear pass that context as `actorAccess` to their existing action
guards and use `actorAccess.orgId` and `actorAccess.userId` for all transaction
arguments, audit attribution, and emitted events. This slice does not silently
rewrite the generic `resolveAttendanceSchedulerScopeActor(...)` contract used by
unrelated scheduler routes.

## 6. Write Contract Amendment

The first runtime write slice is intentionally narrow:

1. `PUT /api/attendance/groups/:groupId/fixed-schedule/config` validates and
   upserts the three desired values. It uses the existing fixed-schedule
   scheduler-scope `dispatch` authorization, including the existing full-admin
   override, rather than adding a second writer permission. The authorized org
   returned by that guard is the transaction org. Client org selectors obey the
   mismatch/no-principal fail-closed contract in section 5.
2. Existing preview remains write-free and may accept an unsaved candidate.
3. For backward compatibility, apply/rebuild with no config row atomically
   creates the desired config from the validated request only if materialization
   succeeds. A failed apply/rebuild rolls the config insert back with all other
   writes. The first-create path uses `INSERT ... ON CONFLICT DO NOTHING`, then
   reloads the winning row `FOR UPDATE`; an identical concurrent candidate may
   continue idempotently, while a different candidate returns the same typed 409
   instead of leaking a uniqueness error. Group, shift, date, and non-empty
   target validation runs before the config insert.
4. When a config row exists, apply/rebuild reloads it with `FOR UPDATE` inside
   the same transaction and rejects a stale client candidate with `409
   ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED`. New clients send
   `expectedConfigRevision`; a revision mismatch is stale. Legacy clients may
   omit the revision only when all three candidate values equal the locked
   config row; any value mismatch is the same typed 409.
5. Apply/rebuild preserves the existing `lockTargets(...)` per-user lock and
   overlap-read ordering. The config row is locked before those target locks;
   target locks are then acquired in their existing deterministic order, and
   overlap reads and writes stay in that same transaction. No route may hold a
   target lock and then attempt to acquire the config lock.
6. Apply/rebuild materializes assignment rows using the existing producer key.
   Desired-key reconstruction for reads and writes must call
   `buildAttendanceGroupFixedScheduleProducerKey`; raw date/string
   concatenation is not an equivalent implementation.
7. Clear only clears the exact managed key requested under the existing
   permission model; it does not delete desired config.
8. Desired config removal, if needed, is a separate explicit route and product
   decision. It is not bundled into the first slice.

This amendment does not authorize weekly matrices, rotations, automatic future
member scheduling, status mutation, calculation changes, flags, deployment, or
customer data use.

## 7. Cross-Surface Projection

All surfaces use the same returned `state` and reason codes:

| Surface | Projection |
| --- | --- |
| Group drawer | Full four-state badge, desired shift/window, coverage counts, exact old-managed-set clear actions when changed, and preview/apply action. |
| Employee schedule | The employee's matching/non-matching applicability plus the group-level state; no unrelated member counts. |
| Decision trace | Read-only desired revision, producer key comparison, and values-free reason codes. |
| Report | Group-level state and counts only; no operator action and no raw member IDs. |

`#4711` owns stable group-scoped navigation. It may host the group drawer but
must not duplicate the effectiveness query or cache a second status.

## 8. Implementation Slices

| Slice | Scope | Completion bar |
| --- | --- | --- |
| FSER-0 | This design lock and owner decision | Exact-head review confirms the contradiction and chosen desired-config shape. |
| FSER-1 | Migration + config service/routes | Fresh and upgrade migration tests; group delete cascades config; shift delete returns the canonical typed blocker; read uses `attendance:admin`; config write uses fixed-schedule `dispatch`; authenticated actor and org are authoritative; actor/org spoofing is blocked before SQL; config upsert is assignment-write-free. |
| FSER-2 | Pure derivation + read route | Full four-state real-Postgres matrix, two-org isolation, missing-schema fail-closed, deterministic reason ordering. |
| FSER-3 | Apply/rebuild config consumption | Absent-config compatibility is atomic; stale candidate 409 and zero writes; matching candidate retains current producer semantics and byte-compatible result shape. |
| FSER-4 | Group/employee/trace/report UI projections | One shared API client/composable, no duplicate status logic, three viewport browser evidence. |

Slices are serial at merge boundaries. `#4711` route-shell work may proceed in
parallel only while it uses route context and placeholders rather than inventing
effectiveness data.

## 9. Required Tests

1. Fresh DB and upgraded DB have one config row per `(org_id, group_id)`.
2. Same group ID or shift ID from another org is rejected before write.
3. Save config produces zero assignment/outbox/event rows.
4. Every four-state predicate has a positive leg and a remove-one-predicate
   mutation that turns it red.
5. Adding a group member after an effective apply yields `pending_apply`.
6. Editing the desired shift/window while old managed rows remain yields
   `configuration_changed`.
7. Clearing managed rows while retaining config yields `pending_apply`.
8. Historical managed rows without desired config yield `not_configured` plus
   drift evidence, never inferred intent.
9. Duplicate matching rows cannot be reported as effective.
10. Two-org forged group and shift IDs disclose no data and write nothing.
11. Missing config schema returns `503 DB_NOT_READY`, not `not_configured`.
12. Group, employee, trace, and report fixtures all display the same state for
    the same authoritative rows.
13. Effective old config -> save changed config -> clear every returned old
    managed set -> apply desired config transitions through
    `effective -> configuration_changed -> pending_apply -> effective`.
14. A failed first legacy apply creates neither config nor assignments; a
    successful first legacy apply creates both atomically.
15. A configured group with zero current members is `pending_apply` with
    `NO_TARGET_MEMBERS`; it is never vacuously `effective`.
16. Two concurrent first applies for the same group do not leak a uniqueness
    error: identical candidates converge idempotently and different candidates
    produce one winner plus one typed 409 with no losing assignment writes.
17. Read, config-save, preview, apply, rebuild, and clear each reject a forged
    body/query/header org and forged `x-user-id` before scoped SQL;
    no-principal-org never falls back to `DEFAULT_ORG_ID`, and no-principal-user
    never falls back to a header. Removing either authenticated-principal
    comparison makes the corresponding negative leg red.
18. Removing the `attendance:admin` read guard or the scheduler-scope `dispatch`
    config-write guard makes its permission-negative leg red while the existing
    full-admin positive leg stays green.
19. Replacing the canonical producer-key builder with raw concatenation, or
    acquiring the config lock after a target lock, makes the key-parity or
    lock-order gate red.
20. Deleting a group removes its desired config in the same database action;
    deleting a referenced shift returns the canonical typed 409 with both shift
    and config intact. Removing either referential/delete-service guard makes its
    lifecycle leg red.

## 10. Owner Decision

`OD-4709-1` remains OPEN.

- **(a) Recommended:** add the minimal desired-config record in Section 3 and
  derive all four states as specified.
- **(b):** keep assignments as the only durable fact. This can support only
  `not_configured/effective/drifted`; it cannot honestly implement persistent
  `pending_apply` and therefore requires narrowing issue `#4709`.

Ratifying `(a)` authorizes only FSER-1 after this docs-only lock lands and is
reviewed at its merged SHA. It does not authorize later slices, merge,
deployment, flags, staging, production/customer data, or closing `#4709` or
umbrella `#4556`.
