# Attendance Calc-Chain Cutover (Step 5) — Verification

Date: 2026-05-20 (v2 — Codex 2nd-round fixes: future-date guard + unique-org test isolation; v1's silent-skip artifact corrected)
Branch: `runtime/attendance-effective-calendar-cutover-20260520`
Base: `origin/main` (post-rebase target — see "Rebase + diff" below)
Commit: branch tip `feat(attendance): route resolveWorkContext through effective calendar policy`

## Definition of Done (gate)

Step 5 is merge-ready only when:

1. The two new Step 5 integration tests print their concrete passing
   case names below, executed against a real PostgreSQL database **with
   migrations actually applied** (v1 baseline was missing this — the
   keystone silently early-returned via `!baseUrl` because the
   `FUTURE_PUNCH_NOT_ALLOWED` guard would have rejected the original
   year-3030 occurredAt). v2 anchors keystone to `2024-10-07` and
   auto-absence to `2024-01-15`/`2024-01-16` so the assertions actually
   fire.
2. The attendance-plugin suite shows **0 new regressions** vs
   `origin/main`. Three tests fail on both branches with identical
   shape (CSV export header drift, JSON export year mismatch, RBAC
   bypass flag) — see "Baseline failures vs origin/main" below.
3. `node --check plugins/plugin-attendance/index.cjs` clean.
4. `pnpm --filter @metasheet/core-backend test:unit` 170 / 2245 pass.
5. `git diff --check origin/main..HEAD` and `origin/main...HEAD` clean.

The current run satisfies all five.

## DB-backed run (PostgreSQL 15.x via brew, scratch DB per run)

### Step 5 keystone — punch time

```
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > Step 5: resolveWorkContext applies calendarPolicy.overrides at punch time (with org-flip and role-inert cases)
```

### Step 5 keystone — auto-absence (added in response to Codex Blocking #1)

```
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > Step 5: auto-absence respects calendarPolicy in both directions (rest→work generates absence; work→rest does not)
```

### Full no-regression shield

```
 Test Files  1 failed (1)
      Tests  3 failed | 71 passed (74)
```

74 = 72 pre-existing + 2 new Step 5 cases. **All 71 passes are real
assertions, not silent `!baseUrl` skips.** The 3 fails are unchanged
from `origin/main` (see "Baseline failures" below — same names, same
shape on both branches).

The Step 5 calc-chain integration introduces zero behavior change on
no-policy paths — RFC §8 equivalence preserved.

### Baseline failures vs origin/main (pre-existing, not introduced by Step 5)

Ran the same full suite against `origin/main`'s plugin code on a fresh
scratch DB:

```
 Tests  3 failed | 69 passed (72)
```

The 3 fails on origin/main:

1. `exports attendance CSV with ISO date values and timezone-consistent timestamps` — header drift (test expects English `work_date`; export now emits localized headers).
2. `exports attendance JSON when format=json is requested` — date row `2029-03-14` no longer surfaces in body.
3. `effective-calendar validates strictly, enforces RBAC, and 404s missing group` — RBAC 403 case shadowed by integration-suite `RBAC_BYPASS=true`.

These three are identical on the v2 branch (verified by name, by line,
by error message). Delta vs origin/main:

| | origin/main | step5-v2 |
| --- | --- | --- |
| Total | 72 | 74 |
| Pass | 69 | 71 |
| Fail | 3 (same names) | 3 (same names) |
| New regressions | — | **0** |
| Step 5 keystone + auto-absence | n/a | **2 new passes** |

### v1 silent-skip discovery (corrected in v2)

The v1 verification MD (now overwritten) reported `73 passed (73)` /
`74 passed (74)`. That was a vitest artifact, **not** a real all-green
state: the keystone test's year-3030 occurredAt hits the pre-existing
`FUTURE_PUNCH_NOT_ALLOWED` guard at `plugins/plugin-attendance/index.cjs:12110`
(`occurredAt > Date.now() + 5min`). With migrations applied, the
keystone would have failed; without migrations applied, `baseUrl`
remains undefined and every test in the file (including the keystone)
returns early via `if (!baseUrl) return` — vitest reports each silent
return as a pass.

In other words, v1's "73/73 PASS" was the skip-when-unreachable blind
spot (originally observed against Playwright specs that skip on
unreachable stack) recurring in vitest form. v2 fixes it by anchoring
both Step 5 tests to past dates, and the assertions actually fire
against the running server.

### Commands (verbatim)

```bash
# Step 5 keystone only
ATTENDANCE_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/<scratch> \
  DATABASE_URL=postgresql://127.0.0.1:5432/<scratch> \
  pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.integration.config.ts \
    run tests/integration/attendance-plugin.test.ts \
    -t "Step 5" \
    --reporter=verbose

# Full attendance-plugin shield (must show 71 passed + 3 fail-as-baseline)
ATTENDANCE_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/<scratch> \
  DATABASE_URL=postgresql://127.0.0.1:5432/<scratch> \
  pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.integration.config.ts \
    run tests/integration/attendance-plugin.test.ts \
    --reporter=dot
```

Scratch DB is created + dropped within each test run; no persistent state.

## Static evidence

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend test:unit` | PASS — 170 files / 2245 tests |
| `git diff --check origin/main..HEAD` | clean (planned) |
| `git diff --check origin/main...HEAD` | clean (planned) |

## Regression matrix

| Pinned decision (dev MD) | Covered by |
| --- | --- |
| D1 — `context.source` keeps profile-origin semantics; `policySource` is new optional | Step 5 keystone test asserts `is_workday` reflects effective; existing tests that read `context.source` (metadata writeback, summary diagnostics) keep passing |
| D2 — Auto-absence behavior change ships default-on | Step 5 auto-absence test directly drives the scheduler path (via `POST /api/attendance/auto-absence/run`): rest→work flip generates an absence row, work→rest flip suppresses one. Codex Blocking #1 fix (see §"Codex Blocking #1 fix" below) is the reason this case is observable instead of being bypassed by the holiday short-circuit. |
| D3 — Shared `selectHighestPriorityCalendarOverride` + `applyCalendarPolicyToWorkContext` | Block A refactor: `resolveEffectiveCalendar` priority loop swapped to selector → Step 3 §6.1 / §6.2 / §6.3 tests still pass (6 cases verified) |
| D4 — Single-date `resolveWorkContext` skips DB when no overrides | Empty `calendarPolicy.overrides` → `loadAttendanceScopeContextForUser` not called; verified by no-regression on the 72 pre-existing tests (all run without setting calendarPolicy) |
| D5 — Prefetch backward-compat: no-op when `calendarPolicy` / `scopeContextByUser` missing | All 72 existing tests that exercise `resolveWorkContextFromPrefetch` (summary, import, payroll) still pass with the new prefetched shape; absence of those fields is handled defensively |
| D6 — `role` / `roleTags` filters stay resolver-inert | Step 5 keystone case (c): role-source override on the holiday date → punch row's `is_workday` stays `false` (resolver could not match the role filter; falls through to holiday baseline) |

## Behavior change announcement (deployment-time)

> After Step 5 lands and is deployed:
> A `calendarPolicy.overrides[]` entry that flips a rest day into a
> working day will now drive **auto-absence** judgments. Users who do
> not punch on such days will be flagged absent. Operators upgrading to
> the post-Step-5 build should review their org/group/user policies
> before the first nightly run to avoid surprise absences on
> recently-overridden dates.

This is the intended source-of-truth unification per RFC §8.

## Codex Blocking #1 fix (auto-absence scheduler integration)

Codex's first-round review flagged that even after Block B + C wired
`resolveWorkContext` and `resolveWorkContextFromPrefetch` to consume
`calendarPolicy.overrides`, the auto-absence scheduler's per-(org, date)
loop still contained an unconditional org-holiday short-circuit:

```js
const holiday = await loadHoliday(db, orgId, workDate)
if (holiday && holiday.isWorkingDay === false) {
  continue   // bypasses resolveWorkContext entirely
}
```

That meant any policy entry flipping a national-holiday day into a
working day for an org/group/user would correctly drive `/punch` writes
(observable in the keystone test) but the nightly auto-absence pass
would still skip the date for the entire org, defeating D2.

The fix lives in Block C2 (see dev MD):

1. **Extracted** the per-(org, date) body into a new function
   `runAutoAbsenceForOrgDate(db, options)` so the same code is reachable
   from both the scheduler's run loop and the new admin endpoint.
2. **Conditioned** the short-circuit: it now only returns
   `{ skipped: true, reason: 'holiday-rest-no-policy', total: 0 }`
   when `settings.calendarPolicy.overrides` is empty. Whenever there is
   any policy, control falls through into the existing per-user loop,
   which now invokes the policy-aware `resolveWorkContextFromPrefetch`
   path (Block C).
3. **Added admin endpoint** `POST /api/attendance/auto-absence/run`
   guarded by `attendance:admin`. It accepts `{ orgId?, workDate }` and
   bypasses the scheduler's dedup so ops can re-run a specific day after
   editing `calendarPolicy.overrides`, and so the Step 5 auto-absence
   integration test can drive the scheduler logic deterministically
   without waiting for a scheduled tick.

This is the minimal change to remove the bypass; it preserves the
optimization in the (overwhelmingly common) no-policy case.

## Codex Blocking #1 v2 fix (admin endpoint future-date guard)

Codex's second-round review pointed out that the v1 admin endpoint
`POST /api/attendance/auto-absence/run` accepted **any** `workDate`
past basic YYYY-MM-DD validation, including today and far-future
dates. Auto-absence is by design a retrospective fill-in pass — an
admin trigger that fabricates absent rows for arbitrary future dates
is a real misuse vector, and the v1 test using year 3030 was
documenting the gap rather than catching it.

v2 fix (in the endpoint handler):

```js
const todayUtc = new Date().toISOString().slice(0, 10)
if (workDate >= todayUtc) {
  res.status(400).json({
    ok: false,
    error: {
      code: 'WORK_DATE_NOT_PAST',
      message: 'workDate must be strictly in the past (UTC); auto-absence is a retrospective pass',
      today: todayUtc,
    },
  })
  return
}
```

Comparing date strings against UTC "today" is strictly more
conservative than local-time-today for any user east of UTC, which
matches the codebase's primary deployment timezone (Asia/Shanghai,
UTC+8). The Step 5 auto-absence test pins this with a negative-path
assertion (`expect(futureRes.status).toBe(400);
expect(...error?.code).toBe('WORK_DATE_NOT_PAST')`) so the guard
cannot quietly regress.

## Codex Blocking #2 v2 fix (test isolation via unique orgId)

v1's auto-absence test used `orgId: 'default'` with an `effective.source: 'org'`
policy override. Because the auto-absence loop iterates
`user_orgs WHERE org_id = $1 AND is_active = true`, any other active
user the suite (or future suites) might leave behind in the default
org would be hit by the org-wide override and receive absent rows on
the test date. v1's cleanup only deleted the test user's rows, so the
test was a pollution vector.

v2 fix (in the test):

- `orgId` is now `step5-absence-org-${runSuffix}`, unique per run.
- All seeded rows (`users`, `user_orgs`, `attendance_holidays`) are
  inserted against the unique org. The unique org has exactly one
  active user → the fanout fans out to exactly one row.
- The endpoint call passes `orgId` explicitly so the fanout is
  pinned to the isolated org.
- Cleanup is keyed to `orgId` (`DELETE ... WHERE org_id = $1`), so
  even on partial failure no other org's rows are touched.
- `loadDefaultRule(db, orgId)` returns `DEFAULT_RULE` (Mon-Fri) for
  unrecognized orgs — no need to seed `attendance_rules`. This is the
  documented fallback behavior at `plugins/plugin-attendance/index.cjs:9781`.

## Files changed

- `plugins/plugin-attendance/index.cjs` — Block A (shared selector helpers + `resolveEffectiveCalendar` refactor), Block B (`resolveWorkContext` integration), Block C (`loadAttendanceScopeContextMapForUsers` + `buildWorkContextPrefetch` extension + `resolveWorkContextFromPrefetch` integration), **Block C2 (extract `runAutoAbsenceForOrgDate`; condition holiday short-circuit on `calendarPolicy.overrides.length === 0`; add `POST /api/attendance/auto-absence/run` admin endpoint — Codex Blocking #1 fix)**, **Block C3 (future-date guard `WORK_DATE_NOT_PAST` on the admin endpoint — Codex Blocking #1 v2 fix)**.
- `packages/core-backend/tests/integration/attendance-plugin.test.ts` — Block D Step 5 keystone test anchored to past date `2024-10-07` (3 scenarios: baseline / org flip / role inert; v2 fix: was 3030 future date silently skipping behind `!baseUrl`) **and Step 5 auto-absence bidirectional test (rest→work / work→rest) against an isolated unique org with past dates (`2024-01-15` / `2024-01-16`) — Codex Blocking #2 v2 fix**. Negative-path assertion on the future-date guard included.
- `docs/development/attendance-effective-calendar-cutover-development-20260520.md` — Block E dev MD pinning all 6 decisions, test matrix, behavior-change announcement, known limitations; Block C2/C3 descriptions added in response to Codex Blocking #1 (v1 + v2).
- `docs/development/attendance-effective-calendar-cutover-verification-20260520.md` — this file.

## Known limitations (carried)

- `role` / `roleTags` policy matching remains inert in both the read-only
  API and the calc chain — no DB-backed role context loader in v1.
- `groupId` resolver mode uses the org default rule for base profile
  (group's `rule_set.workingDays` not yet applied).

## Remaining gate

None for this slice. Step 5 is the final piece of the effective-calendar
stream; the source-of-truth unification across UI / payroll / import /
auto-absence / summary is complete.
