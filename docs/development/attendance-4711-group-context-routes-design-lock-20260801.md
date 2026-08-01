# Attendance #4711 Group Context Routes Design Lock

Status: **PROPOSED**

- Baseline: `9ce340e0f7939f1c1d786acc7eb99bd865a6fac5`
- Scope: issue #4711 only. This document does not authorize runtime code, merge,
  deployment, feature flags, customer data, production data, or closing #4556.
- Related but separate: #4709 owns fixed-schedule effectiveness semantics. This
  lock must not invent or duplicate that read model.

## 1. Problem statement

The current group drawer hands cross-module actions to
`selectAdminSection(...)`, closes the drawer, and leaves the group and workflow
step only in memory. The admin rail writes the active section with
`history.replaceState`, so the browser does not receive a navigation entry for
the group workflow. Refresh, Back, and Forward therefore cannot restore the
same group and step.

The correction is a stable, authenticated group-scoped route. Drawers remain
quick-view surfaces; route state owns multi-step work.

## 2. Verified baseline

All references below are against the pinned baseline.

| Fact | Evidence |
| --- | --- |
| `/attendance` is the sole canonical attendance route and hosts `AttendanceExperienceView` | `apps/web/src/router/appRoutes.ts:82-87` |
| The attendance shell currently derives only `tab` and admin `section` from route query | `apps/web/src/views/attendance/AttendanceExperienceView.vue:147-160,184-220,248-301` |
| The admin rail changes the URL hash with `replaceState`, not router history | `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts:106-122` |
| Existing regression tests prove drawer actions close the drawer and switch the global section without API writes | `apps/web/tests/attendance-admin-regressions.spec.ts:5122-5187` |
| A group-by-id endpoint already exists and returns 404 when its scoped query finds no row | `plugins/plugin-attendance/index.cjs:40328-40365` |
| Its current `getOrgId` precedence is body `orgId`, query `orgId`, principal `orgId`/`workspaceId`, `x-org-id`, then `DEFAULT_ORG_ID`; body and query can override the principal | `plugins/plugin-attendance/index.cjs:6279-6287,40331-40350` |
| A stricter authenticated-principal helper already exists | `plugins/plugin-attendance/index.cjs:6289-6295` |
| Attendance focus mode currently permits exact paths only, so a nested attendance route would otherwise redirect to `/attendance` | `apps/web/src/router/guardPolicy.ts:20-25,117-120` |
| The live group editor stages are `basics | people | schedule | policies`; there is no group-owned `calendar` stage | `apps/web/src/views/AttendanceView.vue:4931-4975` |
| `editAttendanceGroup(...)` resets the active stage to `basics`, assigns the group id, and thereby enables the member/manager watcher | `apps/web/src/views/AttendanceView.vue:27116-27136,28981-28986` |
| Current cross-module controls have stable action keys or data hooks for Rule Sets, Holidays, Shifts, Assignments, and Advanced scheduling | `apps/web/src/views/AttendanceView.vue:5418-5435,5534-5565,13886-13915,13926-13960` |
| The attendance admin shell is intentionally desktop-only on mobile or touch runtimes | `apps/web/src/views/attendance/AttendanceExperienceView.vue:87-88,120-145` |
| In-app redirect validation rejects protocol-relative URLs but is not exported for this feature | `apps/web/src/utils/authRedirect.ts:1-16` |

## 3. Non-negotiable contracts

### 3.1 Canonical routes

The v1 route family is:

```text
/attendance/admin/groups/:groupId/schedule
/attendance/admin/groups/:groupId/calendar
/attendance/admin/groups/:groupId/rules
```

The final path segment is the closed public route-step union
`schedule | calendar | rules`. It is not a second spelling of the existing
group editor's four-stage union. The fixed mapping is:

| Public route step | Existing live surface | Optional `surface` query |
| --- | --- | --- |
| `schedule` | group workflow stage `schedule` | `shifts | assignments | advanced-scheduling`; absent means the group `schedule` stage |
| `calendar` | global Holidays admin surface, hosted inside the authorized group-context shell | none |
| `rules` | group workflow stage `policies` | `rule-sets`; absent means the group `policies` stage |

The route-to-host mapping uses these existing section identifiers and no
caller-supplied section id:

| Route selection | Internal target |
| --- | --- |
| `schedule` | group stage `schedule` |
| `schedule?surface=shifts` | `attendance-admin-shifts` |
| `schedule?surface=assignments` | `attendance-admin-assignments` |
| `schedule?surface=advanced-scheduling` | `attendance-admin-advanced-scheduling-workbench` |
| `calendar` | `attendance-admin-holidays` |
| `rules` | group stage `policies` |
| `rules?surface=rule-sets` | `attendance-admin-rule-sets` |

`calendar` remains a workspace-owned Holidays surface. The route preserves the
originating group as navigation context; it does not create group-owned holiday
state or a new write endpoint. `basics` and `people` remain ordinary group
editor stages and are outside this route family.

Unknown route steps and step/surface combinations do not fall back silently;
they resolve to the route-level not-found posture. The optional `surface` value
is parsed through a closed table keyed by the route step. It must not select an
arbitrary admin section.

`groupId` and step come only from route params. They are not duplicated into a
hash, local storage, or an independent component ref.

### 3.2 Authorization before scoped data

The first network operation for a group route is the group-by-id authorization
probe. Before that probe returns success, no member, manager, schedule,
calendar, rule, preview, or effectiveness request may run.

The existing mobile/touch desktop-only admin block is the sole exception: when
it applies, the shell keeps the URL and safe return target but does not start
the probe, mount group content, or issue any group/scoped request.

The probe must derive organization identity from the authenticated principal.
Query `orgId`, body `orgId`, and `x-org-id` must not select another organization.
If the authenticated principal has no organization id, the request fails closed
with the repository's authenticated-but-unscoped 403 posture before any group
SQL; it must never use `DEFAULT_ORG_ID`. Otherwise the backend query remains
`group id + authenticated org id`; inaccessible and missing groups expose the
same 404-shaped response.

The v1 audience is attendance administrators only. The browser route requires
the `attendanceAdmin` feature while remaining inside the attendance shell; the
API keeps `attendance:admin`. Group-manager admission is out of scope until a
separate authorization decision and backend contract exist.

### 3.3 Route is the context authority

On a group route:

- `AttendanceExperienceView` selects the admin host from route metadata, not
  from a competing query or hash default.
- Admin hash restore, scroll-spy hash writes, remembered-section fallback, and
  section keyboard navigation must not replace the route-owned group step.
- Refresh reconstructs the same group, step, and optional surface after the
  authorization probe.
- Back and Forward create and traverse real router history entries.
- A drawer action uses `router.push(...)`; it does not call
  `selectAdminSection(...)` as the navigation authority.

Route hydration has a fixed order:

1. Parse the route step, optional closed `surface`, and safe `returnTo` without
   loading group-scoped data.
2. Complete the authenticated-org group probe.
3. Seed the authorized group through a route-aware hydrator. It must not call
   the current bare `editAttendanceGroup(...)` path and then leave its
   `basics` reset in authority.
4. Apply the mapped group stage or admin surface from the route.
5. Only after probe success may assigning the selected group trigger member,
   manager, schedule, calendar, rules, preview, or effectiveness loads.

Refresh of `/schedule` must therefore settle on `schedule`, and refresh of
`/rules` must settle on `policies`; neither may flash or remain on `basics`.
Applying the route step before group seeding is invalid because the existing
seeder would overwrite it.

The ordinary `/attendance?tab=admin&section=...` and hash behavior remains
behavior-compatible outside this route family.

Attendance focus mode gains one bounded path predicate: exact existing allowed
paths remain unchanged, and a path is additionally reachable only when it is
exactly under `/attendance/admin/groups/`. Prefix neighbors such as
`/attendance/admin/groups-evil/...` remain rejected. Required-feature and route
permission checks continue to run before this reachability predicate; the
predicate grants no permission.

### 3.4 Return target

`returnTo` is optional query state. A pure normalizer accepts only a local path
under `/attendance`, rejects `//`, schemes, login routes, the current group
route itself, and nested `returnTo` recursion, and otherwise falls back to:

```text
/attendance?tab=admin&section=attendance-admin-groups
```

The breadcrumb contains the authorized group display name and the localized
step label. It never renders a raw `groupId` as the user-facing fallback.

### 3.5 Honest error states

The route host has a closed state union:

```text
loading | ready | unavailable | error
```

- `404` and authorization-denied responses map to `unavailable` with one
  neutral message; they do not disclose whether the group exists elsewhere.
- `503` and unexpected failures map to `error` with retry and safe return.
- No state silently redirects to an unrelated group or global section.

### 3.6 Surface reuse and change boundary

This ticket reuses the live `AttendanceView`/admin surfaces. It may extract the
minimum route context and focused section host needed to pass stable props.
It must not reconnect obsolete attendance components, duplicate scheduling
forms, or broadly refactor the 32k-line view.

The group drawer template region is a merge-sensitive handoff point shared with
#4709. Runtime slices must rebase after #4709 or avoid that region until the
drawer-entry slice.

## 4. Owner decisions

| ID | Decision | Recommended value | Status |
| --- | --- | --- | --- |
| OD-4711-1 | Route shape | Three canonical paths in section 3.1 | **OPEN** |
| OD-4711-2 | v1 audience | Attendance administrators only | **OPEN** |
| OD-4711-3 | Cross-org posture | Authenticated-org probe; missing and inaccessible both appear unavailable | **OPEN** |
| OD-4711-4 | Route/hash precedence | Route owns group workflow; hash rail is inert there | **OPEN** |
| OD-4711-5 | Safe return fallback | Attendance group list section | **OPEN** |
| OD-4711-6 | Mobile scope | Preserve the existing mobile admin block; prove URL/return posture and no overlap, but do not mount group editing or scoped loads | **OPEN** |
| OD-4711-7 | Existing-surface targeting | Closed route-step/`surface` mapping in section 3.1 | **OPEN** |

RATIFY means accepting all recommended values unless the owner records an
explicit alternative. Merging this document while it is PROPOSED is not
RATIFY and does not authorize the first runtime slice.

## 5. Serial delivery plan

Every slice starts from fresh main, is a separate PR, and requires an
independent exact-head review with zero open P1/P2 before merge consideration.

### R0: authorization and route contract

- Harden group-by-id lookup so client-controlled org values cannot select the
  group scope.
- Add the three named routes and attendance-focus prefix handling without
  granting permissions.
- Add pure parsers for step, step-scoped `surface`, and `returnTo`.
- Tests: spoofed query/body/header org, cross-org group, invalid UUID, missing
  group, authenticated principal with no org id, no `DEFAULT_ORG_ID` fallback,
  route permission ordering, safe-prefix and near-prefix paths, unsafe return
  targets, unknown step, and illegal step/surface pairs.

R0 does not render or load group-scoped schedule data.

### R1: route context host

- Add a small route-context host/composable with the closed state union.
- Probe group authorization before mounting scoped content.
- Pass authorized `group`, public `step`, closed `surface | null`, and safe
  `returnTo` through `AttendanceExperienceView` to the existing admin host.
- Add a route-aware group hydrator or an explicit route-stage parameter; the
  current bare `editAttendanceGroup(...)` reset path is not valid for deep links.
- Disable competing hash/remembered-section authority only for group routes.
- Tests: direct load, refresh, Back, Forward, retry, no scoped fetch before
  probe success, no member/manager fetch before probe success, route step
  and `surface` survive group hydration and refresh/Back/Forward, `/schedule`
  never settles on `basics`, and legacy `/attendance` compatibility.

### R2: drawer entry points and evidence

- Replace only these existing cross-module controls with the following closed
  mapping:

  | Existing control | Target |
  | --- | --- |
  | summary `open-shifts` and work-time drawer Open Shifts | `schedule?surface=shifts` |
  | summary `open-assignments` and work-time drawer Open Assignments | `schedule?surface=assignments` |
  | summary `open-advanced-scheduling` and work-time drawer Open Advanced scheduling | `schedule?surface=advanced-scheduling` |
  | fixed-shift group `schedule` stage Open Assignments | `schedule?surface=assignments` |
  | non-fixed group `schedule` stage Open Advanced scheduling | `schedule?surface=advanced-scheduling` |
  | rule-policy drawer Open Holidays and work-time drawer Open Holidays | `calendar` |
  | summary `open-rule-sets` and rule-policy drawer Open Rule Sets | `rules?surface=rule-sets` |

  Summary actions `open-work-time-drawer`, `open-rule-policy-drawer`, and
  `open-punch-method-drawer` remain quick-view drawer actions. Other global
  admin actions are outside #4711 and must not be silently remapped.
- Keep drawer quick-view behavior and no-write assertions.
- Browser matrix: drawer -> route -> return, refresh restoration, Back/Forward,
  unavailable group, cross-org spoof, desktop and mobile viewport.
- Capture desktop screenshots only after DOM assertions prove the authorized
  group name, current step, and breadcrumb are present. Mobile/touch evidence
  must instead prove the existing desktop-only recommendation, intact route and
  safe return, no overlay, and zero group/scoped requests; it does not claim a
  new mobile editing surface.

## 6. Required mutation proofs

The final gate must demonstrate that each guard is load-bearing:

1. Reintroducing body/query/header org precedence makes the cross-org probe
   test red.
2. Starting a scoped fetch before the probe resolves makes the zero-request
   assertion red.
3. Calling bare `editAttendanceGroup(...)`, or applying the route stage before
   group seeding, makes the refresh/hydration stage test red.
4. Replacing `router.push` with section selection makes the history test red.
5. Re-enabling hash sync on a group route makes the route-authority test red.
6. Accepting `//host`, a scheme, or recursive `returnTo` makes the redirect
   matrix red.
7. Broadening the attendance-focus predicate to `/attendance/admin/groups` as
   an unbounded string prefix makes the `groups-evil` negative test red.
8. Falling back to `DEFAULT_ORG_ID` when principal org is absent makes the
   no-SQL fail-closed test red.
9. Removing the mobile block or starting the probe on mobile makes the mobile
   zero-request test red.

## 7. Completion definition

#4711 is implementation-complete only when:

- R0, R1, and R2 are separately merged after their gates;
- the three canonical URLs restore group, step, and optional surface on refresh
  and history traversal;
- inaccessible/cross-org IDs are rejected before any scoped data load;
- drawer actions preserve group context without writes;
- desktop/mobile browser evidence and a verification MD are on main;
- #4709 behavior is referenced, not reimplemented;
- no deployment, flag, production/customer data, or #4556 closure is claimed.
