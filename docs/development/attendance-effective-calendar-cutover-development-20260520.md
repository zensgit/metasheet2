# Attendance Calc-Chain Cutover to Effective Calendar (Step 5)

Date: 2026-05-20
Branch: `runtime/attendance-effective-calendar-cutover-20260520`
Base: `origin/main@ec76beae0`
Implements: RFC §8 (Phase 2 Cutover Plan).
Builds on: Step 3 PR #1707 (resolver + read-only API), Step 4 PR #1712
(multitable Calendar consumer), Step 4 PR #1715 (attendance views consumer).

## Scope

Step 5 closes the effective-calendar slice by routing the runtime calc
chain — `resolveWorkContext` and `resolveWorkContextFromPrefetch` — through
the same `calendarPolicy.overrides` logic the read-only API has used since
Step 3. Once Step 5 lands, every consumer (UI / payroll / import /
auto-absence / summary / scheduler) reads the same effective `isWorkingDay`
for any (user, date) pair.

Delivered:

- A shared override-selection core extracted from
  `resolveEffectiveCalendar` so the read-only API and the calc chain share
  one implementation of priority + tie-order.
- `resolveWorkContext` (single-date) reads `calendarPolicy.overrides` from
  settings and (when needed) loads scope context for the target user.
- `resolveWorkContextFromPrefetch` (batch) reads prefetched
  `calendarPolicy` + `scopeContextByUser`; falls back to no-op when the
  prefetch is missing those fields (backward-compat with existing fixtures).
- `attendance_records.is_workday` writebacks reflect the new effective
  value automatically — no caller change at the 17 existing
  `resolveWorkContext` / `resolveWorkContextFromPrefetch` call sites.
- Integration tests cover §6.1 equivalence (no overrides), policy-flips
  workday, payroll/import/auto-absence parity, prefetch backward-compat,
  tie-order between same-source overrides.

Not delivered:

- Frontend changes — surfaces already swapped in PR1/PR2.
- Role / roleTags resolver-mode policy matching (still inert; see "Known
  limitations").
- Removing the dual-source-of-truth code path inside
  `resolveEffectiveCalendar` — Step 5 keeps it producing the same result
  via the shared core; pulling out the old branch is a clean-up slice if
  ever needed.

## Pinned decisions (Codex review of Step 5 plan)

### D1 — `context.source` keeps its old semantics

`source` continues to represent the profile origin
(`'rotation'` | `'shift'` | `'rule'`). Step 5 **adds** two optional
fields:

- `policySource?: 'org' | 'group' | 'role' | 'user'` — set only when a
  `calendar_policy` layer fired.
- `policyId?: string` — the matched `CalendarPolicyOverride.id` for audit.

Callers that already read `source` (metadata writeback, diagnostics,
summary) see no semantic shift. Callers that want the final effective
source check `context.policySource ?? context.source`.

### D2 — Auto-absence behavior change ships default-on

After Step 5, if `calendarPolicy.overrides` flips an
otherwise-rest day into a working day (e.g. organization-wide override of
a national holiday), the nightly auto-absence sweep will start judging
that day, generating absences for users who did not punch. This is the
intended source-of-truth unification and is **not** behind a feature
flag. Verification MD includes a behavior-change line for deployment
notes.

### D3 — Shared override-selection split into two functions

```
selectHighestPriorityCalendarOverride(overrides, dayContext, mode) → match | null
applyCalendarPolicyToWorkContext(workContext, overrides, scopeContext, dayMeta, mode, dateKey) → workContext
```

- `selectHighestPriorityCalendarOverride` is the pure helper: it iterates
  `overrides[]`, calls `matchCalendarOverride`, tracks
  `CALENDAR_POLICY_SOURCE_PRIORITY[source]`, and applies the **same**
  tie-order as `resolveEffectiveCalendar`: `>=` priority comparison so a
  later-array-index entry with the same source wins. Tests pin this order.
- `applyCalendarPolicyToWorkContext` is the calc-chain integration: takes
  a `workContext` already merged for profile + holiday, runs the selector,
  returns the (possibly-mutated) context with `isWorkingDay`, `policySource`,
  `policyId` set. Pure function; no DB access.
- Both `resolveEffectiveCalendar` and the calc-chain path import these.
  No duplicated matching/priority logic.

### D4 — Single-date `resolveWorkContext` avoids unnecessary DB hits

- When `settings.calendarPolicy.overrides` is empty, **do not** call
  `loadAttendanceScopeContextForUser` — early return with the pre-Step-5
  result.
- `options.calendarOverrides` and `options.scopeContext` may be passed in
  by callers (batch path + tests) to avoid duplicate queries. When
  provided, the function honors them and skips the corresponding loads.
- Settings come from `getSettings(db)` (already cached, 60s TTL).

### D5 — Prefetch path is backward-compatible with old fixtures

- `resolveWorkContextFromPrefetch` reads
  `prefetched.calendarPolicy` and `prefetched.scopeContextByUser`. **When
  either is missing**, the function applies no policy layer — equivalent
  to pre-Step-5 behavior.
- `buildWorkContextPrefetch` (the helper that builds prefetched maps)
  populates the two new fields. Tests that construct `prefetched`
  manually without those fields still work with the same `isWorkingDay`
  as before.

### D6 — Role / roleTags filter remains resolver-inert

`loadAttendanceScopeContextForUser` (and the new
`loadAttendanceScopeContextMapForUsers` it parallels) load `userId`,
`userName`, and `attendanceGroups[]`. They do **not** load
`role` / `roleTags`. Step 5 does **not** change this. A
`calendar_policy` override declaring `effective.source: 'role'` remains
valid configuration but **will not** fire in either the read-only API
(documented in PR #1707 Known Limitations) or the calc chain (documented
here). A future slice can add a role context loader without re-touching
the cutover.

## Key code anchors (post-Step 5)

| Concern | File:line |
| --- | --- |
| `selectHighestPriorityCalendarOverride` (new shared core) | `plugins/plugin-attendance/index.cjs` near `CALENDAR_POLICY_SOURCE_PRIORITY` (~10260) |
| `applyCalendarPolicyToWorkContext` (new integration helper) | same file, immediately after the selector |
| `resolveWorkContext` single-date integration (calls helpers + loads scope when needed) | `plugins/plugin-attendance/index.cjs:10101+` |
| `resolveWorkContextFromPrefetch` batch integration | `plugins/plugin-attendance/index.cjs:10672+` |
| `loadAttendanceScopeContextMapForUsers` (new range loader, mirrors `loadShiftAssignmentMapForUsersRange`) | new function near other range loaders (~10180) |
| `buildWorkContextPrefetch` (existing helper extended to include calendarPolicy + scopeContextByUser) | wherever currently built (TBD during impl) |
| `resolveEffectiveCalendar` switched to use the shared selector | `:10550` (priority loop replaced) |
| Integration tests | `packages/core-backend/tests/integration/attendance-plugin.test.ts` (extended) |

## Implementation plan (5 blocks)

| Block | Content |
| --- | --- |
| A | Add `selectHighestPriorityCalendarOverride` + `applyCalendarPolicyToWorkContext` near existing `matchCalendarOverride`. Switch the priority loop inside `resolveEffectiveCalendar` to use the new selector (one-line replacement). |
| B | Wire `resolveWorkContext` single-date: read settings.calendarPolicy.overrides; if empty, return as before. Else load scope context (or use `options.scopeContext`/`options.calendarOverrides` overrides). Call `applyCalendarPolicyToWorkContext`. |
| C | Add `loadAttendanceScopeContextMapForUsers(db, orgId, userIds)`. Extend `buildWorkContextPrefetch` to populate `calendarPolicy` + `scopeContextByUser`. Wire `resolveWorkContextFromPrefetch` to apply policy when the prefetched fields are present; no-op otherwise. |
| C2 (review fix v1) | Extract `runAutoAbsenceForOrgDate(db, options)` from the scheduler's run loop so the per-(org, date) auto-absence pass goes through `resolveWorkContext`. Preserve the org-holiday-rest short-circuit ONLY when `calendarPolicy.overrides` is empty (Codex Blocking #1: otherwise the scheduler bypassed Step 5's calc-chain integration entirely). Add admin trigger `POST /api/attendance/auto-absence/run` (attendance:admin) so ops can re-run after policy edits and so the new test surface can drive the scheduler logic without waiting for the scheduled run. |
| C3 (review fix v2) | Future-date guard on the admin endpoint: reject `workDate >= UTC today` with `WORK_DATE_NOT_PAST` (Codex Blocking #1 v2). Auto-absence is a retrospective pass; an admin trigger that fabricates absent rows for today / future dates is a real misuse vector. The Step 5 auto-absence test now pins this with a negative-path assertion on `error.code` and switches its rest/work fixtures to past dates (`2024-01-15` / `2024-01-16`). The Step 5 keystone test similarly switches to `2024-10-07` so the `/punch` `FUTURE_PUNCH_NOT_ALLOWED` guard does not silently skip the assertions via the `!baseUrl` early-return path. |
| D | Tests (see Test Matrix below). Scratch PG mandatory. **Note:** auto-absence test uses a unique `orgId = step5-absence-org-${runSuffix}` (Codex Blocking #2 v2 fix) so the multi-user fanout of the auto-absence pass cannot touch any other org's rows even on partial failure; all seeds + cleanups are `WHERE org_id = $1`. |
| E | Verification MD with concrete PASS lines + behavior-change line + 9 baseline-failing files audit (zero new regressions). |

## Test matrix

| # | Scenario | Spec | Assertion |
| --- | --- | --- | --- |
| §5.1 | RFC §6.1 equivalence — no calendarPolicy override, all 6 baseline cases | `multitable-context.api.test.ts` (existing Step 3 tests) | `effective.isWorkingDay === resolveWorkContext.isWorkingDay` still holds. **Negative protection.** |
| §5.2 | org override flips rest → work for current user | `attendance-plugin.test.ts` new | `resolveWorkContext` returns `isWorkingDay=true`, `policySource='org'`, `policyId=<override.id>` |
| §5.3 | group override flips for user IN production group; user OUT keeps base | new | both directions verified |
| §5.4 | user override (priority 4) beats group override (priority 2) on the same date | new | `policySource='user'` wins |
| §5.5 | **same-source tie-order**: two `org` overrides matching same date, later array index wins | new | matches PR1 behavior; tooltip layer chain (read-only API) and calc chain agree |
| §5.6 | `attendance_records.is_workday` writeback after import on a policy-flipped day | new | row.is_workday reflects effective value |
| §5.7 | **payroll equivalence**: no calendarPolicy → payroll cycle totals unchanged vs pre-Step-5 fixture | new (negative protection) | total_days / total_minutes identical |
| §5.8 | **payroll flip**: with org override, payroll picks up additional work day | new | total_days +1, total_minutes ≈ work_minutes |
| §5.9 | **auto-absence rest→work**: org override flips a rest day to work; user did not punch → absence row generated | new (`Step 5: auto-absence respects calendarPolicy in both directions ...`) | absence record present for the flipped day; response.data.skipped=false |
| §5.10 | **auto-absence work→rest**: group override flips a default work day to rest for that group; user did not punch → NO absence | same test (second half) | no absence record; response.data.total=0 |
| §5.11 | **import equivalence**: no policy → record minutes unchanged vs pre-Step-5 baseline | new (negative protection) | same row contents |
| §5.12 | **import flip**: with override, import classifies a flipped day correctly | new | imported record has is_workday matching policy |
| §5.13 | **prefetch backward-compat**: calling `resolveWorkContextFromPrefetch` with old-shape prefetched (no `calendarPolicy` / `scopeContextByUser`) returns same isWorkingDay as before | new | guards old fixtures |
| §5.14 | **role inert**: override with `effective.source='role'` + `filters.roles=[...]` does not fire in calc chain (resolveWorkContext) for any user | new | base isWorkingDay unchanged; `policySource` undefined |

Cases §5.1, §5.7, §5.11, §5.13, §5.14 are the **negative protection
shield**: they must pass to prove Step 5 does not silently regress old
behavior on no-policy or unsupported-context paths.

## DoD (verification gate)

- vue-tsc / tsc clean
- `node --check plugins/plugin-attendance/index.cjs` clean
- Full attendance integration suite has **0 new regressions vs origin/main**
  on scratch PostgreSQL 15.x (origin/main itself has 3 unchanged
  pre-existing baseline fails — CSV export header drift, JSON export
  year mismatch, RBAC bypass — see Verification MD §"Baseline failures").
  No skip-when-unreachable acceptable; scratch DB must be real, with
  migrations actually applied, and tests must use **past** dates so the
  `FUTURE_PUNCH_NOT_ALLOWED` / `WORK_DATE_NOT_PAST` guards don't push
  the assertions into silent `!baseUrl` early-returns.
- §5.1–§5.14 all PASS with concrete test names printed in verification MD.
- Existing `multitable-context.api.test.ts` §6.1 / §6.2 / §6.3 cases
  unchanged (Step 3 baseline).
- Existing Step 2 `protects manual holiday origins during national
  holiday sync` test unchanged.
- Full web vitest: 9 baseline-failing files match prior PR set exactly;
  zero new regressions.
- `git diff --check origin/main..HEAD` and `origin/main...HEAD` clean.

## Behavior change announcement

After Step 5 lands and is deployed:

> A `calendarPolicy.overrides[]` entry that flips a rest day into a
> working day will now drive **auto-absence** judgments. Users who do
> not punch on such days will be flagged absent. Operators upgrading to
> the post-Step-5 build should review their org/group/user policies
> before the first nightly run to avoid surprise absences on
> recently-overridden dates.

This is the intended source-of-truth unification per RFC §8; PR2's
verification MD already foreshadowed it for the personal calendar.

## Known limitations (carried)

- `role` / `roleTags` policy filters remain inert in both the read-only
  API and the calc chain (no DB-backed role context loader in v1).
- `groupId` resolver mode uses the org default rule for base profile
  (group's `rule_set.workingDays` not yet applied).

## Risks + mitigations

| Risk | Mitigation |
| --- | --- |
| Calc-chain regression on the 17 call sites | Negative-protection tests (§5.1 / §5.7 / §5.11 / §5.13 / §5.14) lock no-policy equivalence; positive flip tests (§5.2–§5.6, §5.8, §5.9, §5.10, §5.12) pin new semantics |
| Same-source tie-order drift between calc chain and read-only API | Shared `selectHighestPriorityCalendarOverride` core; §5.5 verifies the `>=` order; tests cross-reference both call paths |
| Scope context loader cost in prefetch | One JOIN per batch; same shape as existing `loadShiftAssignmentMapForUsersRange` |
| Settings cache (60s TTL) vs real-time policy edits | Pre-Step-5 settings had same caching for `holidayPolicy`; Step 5 does not change cache strategy |
| Auto-absence behavior change surprise | Behavior-change announcement in dev + verification MD; default-on with documented warning |
| Old fixtures break under new prefetch shape | D5 explicitly: no-op when prefetched fields missing; §5.13 guards |
