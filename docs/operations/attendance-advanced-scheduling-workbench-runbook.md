# Attendance Advanced Scheduling Workbench — Operator Runbook

**Audience:** attendance administrators and operators who need to audit
multi-group scheduling state without modifying any scheduling fact tables.

**Status of the surface:** read-only diagnostic dashboard. It does not edit
shifts, rotations, schedule groups, scheduler scopes, or assignments. It does
not replace the effective-calendar resolver. Per K3 PoC stage-1 lock and the
advanced-scheduling write-path freeze, no write actions are exposed.

## 1. Entrypoint

### UI

`Admin Center → Attendance → Scheduling → Advanced scheduling`

The section anchor is `attendance-admin-advanced-scheduling-workbench`. The
workbench fetch fires automatically as part of the Admin Center's batch
data load (`loadAdvancedSchedulingWorkbench()` is one of the `Promise.all`
admin-data calls invoked when the admin view mounts or the admin rail
reloads). The section itself exposes a **Reload workbench / 重载工作台**
button (not "Refresh") for on-demand re-fetches; the same loader function
backs both paths.

### Backend route

```
GET /api/attendance/advanced-scheduling/workbench
    ?from=YYYY-MM-DD
    &to=YYYY-MM-DD
```

| Item | Value |
| --- | --- |
| Method | `GET` only |
| Permission | `attendance:admin` |
| Body | none |
| Response shape | `{ ok: true, data: { range, summary, scheduleGroups, schedulerScopes, diagnostics, metadata } }` |
| Read-only marker | `data.metadata.readOnly === true` |
| Source marker | `data.metadata.source === 'attendance_advanced_scheduling_workbench'` |
| Side effects | none — DB read-only, no `meta_*` writes, no fact table mutation |

Date validation:

- `from` and `to` are both optional. Empty range = "all time".
- Invalid format → HTTP 400 `VALIDATION_ERROR` (`Invalid "from" date. Use YYYY-MM-DD.` or the `"to"` variant).
- Inverted range → HTTP 400 `VALIDATION_ERROR` (`"from" must be on or before "to".`).
- Open-ended ranges are supported; missing bounds default to `0001-01-01` (start) and the project's open-end sentinel (end).

`POST`, `PUT`, `DELETE` on this URL are intentionally **not registered**.
Existing regression test
`packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts`
asserts the absence of those verbs.

## 2. Workbench sections (what each block means)

The workbench is a single read-only snapshot driven by one HTTP request. The
UI assembles five blocks; each maps to a region of the JSON response.

### 2.1 Read-only snapshot banner

The UI shows a `Read-only snapshot` chip whenever `data.metadata.readOnly === true`
(always true in production). It reminds the admin that nothing they see here
will be edited from this page.

### 2.2 Summary metrics

Top-of-page counts. JSON path: `data.summary`. Fields:

| Field | Meaning |
| --- | --- |
| `scheduleGroups` | active `attendance_schedule_groups` rows in the date range |
| `scheduleGroupMembers` | distinct (group, user) memberships effective in the range |
| `schedulerScopes` | scheduler-scope rows in the range |
| `shifts` | active shifts |
| `rotationRules` | active rotation rules |
| `shiftAssignments` | total shift-assignment rows (aggregate, **not** the truncated visible list) |
| `rotationAssignments` | total rotation-assignment rows (aggregate, **not** the truncated visible list) |
| `assignedUsers` | unique users with at least one active shift or rotation assignment |
| `diagnostics` | count of distinct diagnostic codes emitted (≤ 5) |
| `groupsWithoutMembers` | distinct schedule groups with 0 active members in range |
| `assignmentUsersWithoutScheduleGroup` | users assigned to a shift or rotation but with no schedule-group membership in range |
| `usersWithMultipleScheduleGroups` | users in ≥ 2 schedule groups in range |

The aggregate counters use exact SQL aggregates, **not** the truncated
sample. They remain accurate even when truncation is active (see §2.5).

### 2.3 Schedule-groups coverage table

JSON path: `data.scheduleGroups.items[*]`. Per-group columns:

| Column | Source |
| --- | --- |
| Group name | `name` |
| Member count | `memberCount` — exact, from `attendance_schedule_group_members` |
| Assigned-member count | `assignedUserCount` — distinct members with ≥ 1 active assignment |
| Shift assignments | `shiftAssignmentCount` — exact aggregate per group |
| Rotation assignments | `rotationAssignmentCount` — exact aggregate per group |

Per-group aggregates ride on the same SQL `GROUP BY` path as the summary,
so truncation does **not** distort the table.

### 2.4 Diagnostics list

JSON path: `data.diagnostics[]`. Zero-or-more entries; only triggered codes
appear. Each entry shape:

```json
{
  "code": "<diagnostic code>",
  "severity": "warning" | "info",
  "message": "<one-sentence human description>",
  "count": <integer>,
  "userIds": [...]            // present on user-targeted diagnostics
  "scheduleGroupIds": [...]   // present on group-targeted diagnostics
}
```

The five emittable codes are documented in §3.

### 2.5 Truncation warning / sampling vs aggregate

The workbench paginates assignment rows internally using a hardcoded
`ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT = 500` (per kind).
If the actual row count exceeds the limit, the UI shows a truncation banner
**and the aggregate counters remain accurate**.

JSON path: `data.metadata.truncation` and `data.metadata.sampling`.

```json
"truncation": {
  "assignmentLimit": 500,
  "shiftAssignments": <true | false>,
  "rotationAssignments": <true | false>,
  "truncated": <true | false>
},
"sampling": {
  "assignmentLimit": 500,
  "sampled": <true | false>,
  "shiftAssignments": {
    "visible": <int>,    // length of the sampled list shown in the UI
    "total":   <int>,    // exact aggregate count from SQL
    "truncated": <bool>
  },
  "rotationAssignments": {
    "visible": <int>,
    "total":   <int>,
    "truncated": <bool>
  }
}
```

When `truncated === true` for either kind, the per-assignment detail list is
incomplete by design. **Diagnostics, summary metrics, and per-group
aggregates do NOT silently drop the truncated rows** — those are computed
from SQL aggregates and stay accurate. The truncation only affects the raw
list display.

This is intentional: the workbench is a diagnostic dashboard, not a
spreadsheet. If the operator needs to inspect specific assignments under
truncation, they should narrow the date range (`from` / `to`) to bring the
list back under 500.

## 3. Diagnostic codes — definitions and remediation

All diagnostic messages are bilingual-safe English in the API. The UI renders
the message verbatim. Severity is `warning` unless noted as `info`.

### 3.1 `schedule_group_without_members`

**Severity:** `warning`

**API message:** `Active schedule groups have no effective members in this range.`

**Triggers when:** an active row in `attendance_schedule_groups` has zero
effective member rows in `attendance_schedule_group_members` for the range.

**Targets:** `scheduleGroupIds` field on the diagnostic entry.

**Operator action:**

1. Confirm the listed group is genuinely meant to be active (vs. legacy / hidden / staging).
2. If active and intentional: add members via `Admin Center → Attendance → Scheduling → Schedule groups → <group> → Members`.
3. If unintentional: deactivate the group, or narrow the workbench `from` / `to` if the membership exists outside the queried range.

### 3.2 `assignment_without_schedule_group`

**Severity:** `warning`

**API message:** `Active shift or rotation assignments reference users without an effective schedule-group membership in this range.`

**Triggers when:** users with active `attendance_shift_assignments` or
`attendance_rotation_assignments` rows in the range have no
`attendance_schedule_group_members` row in the same range.

**Targets:** `userIds` field on the diagnostic entry.

**Operator action:**

1. Open `Schedule groups → Members` and confirm whether the user should be in a group.
2. If yes, add the user to the correct schedule group.
3. If the user is intentionally on a standalone shift or rotation outside any schedule group, this is informational — the effective-calendar resolver will still resolve the day-level shift, so no action is strictly required, but the diagnostic is worth tracking for ownership clarity.

### 3.3 `user_multiple_schedule_groups`

**Severity:** `warning`

**API message:** `Users belong to multiple schedule groups in this range.`

**Triggers when:** the same user has membership rows in ≥ 2 distinct schedule
groups whose effective ranges overlap the queried range.

**Targets:** `userIds`.

**Operator action:**

1. Open each listed user's `Members` rows across the relevant groups.
2. If overlap is intentional (e.g., transitional move between groups), confirm the membership `effective_from` / `effective_to` ranges are correctly bounded.
3. If unintentional, close the older membership by setting an explicit `effective_to`.

Note: the effective-calendar resolver still owns the day-level precedence
between groups; this diagnostic does not imply a broken calendar — it implies
an ambiguous ownership signal.

### 3.4 `user_mixed_assignment_kinds`

**Severity:** `info`

**API message:** `Users have both shift and rotation assignment rows in this range; effective-calendar resolution still owns day-level precedence.`

**Triggers when:** the same user has at least one active row in BOTH
`attendance_shift_assignments` (shift) AND `attendance_rotation_assignments`
(rotation) overlapping the range.

**Targets:** `userIds`.

**Operator action:** typically none. This is an `info` diagnostic, surfaced
so the admin understands that the effective calendar resolves day-by-day
between the two kinds. If the mixed state is unintentional, close the
unwanted assignment via its respective admin section.

### 3.5 `scheduler_scope_unknown_schedule_group`

**Severity:** `warning`

**API message:** `Scheduler scopes reference schedule groups that are not active in this workbench snapshot.`

**Triggers when:** a row in `attendance_scheduler_scopes` has a
`scope.scheduleGroupIds[]` value referring to a schedule group that is not
active (or not present) in the queried range.

**Targets:** `scheduleGroupIds` — the offending unknown group IDs.

**Operator action:**

1. Open `Scheduler scopes` and locate the scope referencing the listed group ID.
2. Either reactivate the missing schedule group (if it was accidentally deactivated), or remove the stale group ID from the scope's `scheduleGroupIds`.

## 4. Operator triage flow

When the workbench surfaces non-zero diagnostics, follow this sequence:

1. **Confirm the date range.** Look at `data.range.from` / `data.range.to`. A range that's too wide will surface stale historical diagnostics; a range that's too narrow may miss real issues. The default empty range = "all time" which is good for global audit but noisy for day-to-day.
2. **Check the truncation warning.** If `data.metadata.truncation.truncated === true` for either kind, the per-row detail list is incomplete. Aggregates and diagnostics are still accurate, but if you need to inspect individual rows, narrow the range to bring the visible list under 500.
3. **Read the aggregate metrics.** Compare `summary.shiftAssignments` to `sampling.shiftAssignments.total` to confirm the aggregate matches what you expect for the org. A large mismatch with previous days indicates either truncation or a real data shift.
4. **Walk the diagnostics list top-to-bottom.** Each entry includes `count` and either `userIds` or `scheduleGroupIds`. Group entries by code first (the five codes from §3), then by severity (`warning` > `info`).
5. **Remediate via the matching admin section.** Each diagnostic in §3 points to a specific `Admin Center` section. Do not edit DB rows directly; use the existing admin UI. The workbench itself does not provide edit affordances.
6. **Re-run the workbench.** Click **Reload workbench / 重载工作台** in the UI or re-issue the GET to confirm the diagnostic has cleared.

If multiple diagnostics target the same user or group, address the
ownership-shaping diagnostic first (§3.1 → §3.2 → §3.5) before the
behavioral ones (§3.3 → §3.4); fixing membership often clears downstream
warnings in one pass.

## 5. Scope boundaries (what this dashboard does NOT do)

The workbench is intentionally narrow. The following are **not** in scope of
this route, this UI, or this runbook:

- **Read-only.** No row in `attendance_schedule_groups`,
  `attendance_schedule_group_members`, `attendance_scheduler_scopes`,
  `attendance_shifts`, `attendance_rotation_rules`,
  `attendance_shift_assignments`, or `attendance_rotation_assignments` is
  ever inserted, updated, or deleted through this route.
- **Not a substitute for the effective-calendar resolver.** Day-level
  precedence (shift vs. rotation vs. override vs. holiday) is still owned by
  the existing `resolveEffectiveCalendar` path. The workbench reports
  inputs, not outcomes.
- **No grid edit / copy-paste.** Schedule grids with cell-level editing are
  out of scope for the read-only workbench.
- **No Excel import.** Bulk schedule import via spreadsheet is not exposed
  here and is not authorized as a "kernel polish" item — it would be a new
  load-bearing surface.
- **No temporary shift / dispatch / swap.** Ad-hoc same-day shift overrides,
  shift dispatch, and shift swap are all separate write paths that are not
  reachable from this dashboard.
- **No bulk operations.** The dashboard does not bulk-apply a fix across
  diagnostics; each remediation goes through its respective admin section,
  one entity at a time.
- **No K3 / Data Factory / Bridge Agent integration.** This route is a
  pure local-DB diagnostic.

If a future request needs any of the above, it becomes a separate explicit
opt-in slice subject to RFC + design lock + write-path approval, **not** a
runbook update.

## 6. Safe live-check command examples

These commands are appropriate for ops verification against a running
deployment. They use `GET` only, do not write, and follow the
secret-hygiene patterns established for this project.

### Setup (no token printed)

```bash
# 1. Place an admin JWT in a local file. Chmod 0600. Do not commit.
AUTH_TOKEN_FILE="/tmp/$(whoami)-attendance-admin.jwt"
chmod 0600 "$AUTH_TOKEN_FILE"

# 2. Pick the deployment.
API_BASE="http://<host>:<port>"   # examples: http://23.254.236.11:8081 (prod)
                                  #           http://23.254.236.11:8082 (staging — uses a DIFFERENT JWT)
```

Secret-hygiene contract for the examples below:

- The token is **not printed** to stdout, **not committed** to the repo,
  and is **only read** from the local 0600 file at the moment the command
  runs.
- The token is **not used in shell history** because the shell substitutes
  `$(cat "$AUTH_TOKEN_FILE")` at invocation time without echoing the
  expansion. Operators should still scrub history (`history -c` /
  `unset HISTFILE`) after a sensitive session.
- Caveat: at invocation time the substituted token becomes part of the
  `curl` process's argv and is briefly visible in `/proc/<pid>/cmdline`
  to other processes running as the same OS user. For stricter isolation,
  operators may substitute `curl -H @<header-file>` where `<header-file>`
  is a 0600 file containing exactly `Authorization: Bearer <token>` on
  one line — `curl` reads the header from the file and the token does
  not enter argv. The runbook keeps `$(cat ...)` for readability; the
  `@<header-file>` swap is a drop-in for tighter ops environments.

### Auth round-trip

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE")" \
  "$API_BASE/api/auth/me"
# Expect: HTTP 200
```

### Empty range probe (full snapshot, no date filter)

```bash
RESP=$(curl -sS \
  -H "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE")" \
  "$API_BASE/api/attendance/advanced-scheduling/workbench")

# Pull only counts and diagnostic codes — never echo the full body.
echo "$RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
data = d.get("data", {})
s = data.get("summary", {}) or {}
meta = data.get("metadata", {}) or {}
trunc = meta.get("truncation", {}) or {}
print("readOnly:", meta.get("readOnly"))
print("source:",   meta.get("source"))
print("range:",    data.get("range"))
print("summary:",  {k: s.get(k) for k in ("scheduleGroups","scheduleGroupMembers","schedulerScopes",
                                          "shifts","rotationRules","shiftAssignments",
                                          "rotationAssignments","assignedUsers","diagnostics")})
print("truncation:", trunc)
print("diagnostic codes:", [diag.get("code") for diag in data.get("diagnostics", []) or []])
print("diagnostic counts:", [(diag.get("code"), diag.get("count"), diag.get("severity")) for diag in data.get("diagnostics", []) or []])
'
```

Expected output shape (counts will differ per org):

```
readOnly: True
source: attendance_advanced_scheduling_workbench
range: {'from': None, 'to': None}
summary: {'scheduleGroups': N, ...}
truncation: {'assignmentLimit': 500, 'shiftAssignments': False, 'rotationAssignments': False, 'truncated': False}
diagnostic codes: ['assignment_without_schedule_group', ...]
diagnostic counts: [('assignment_without_schedule_group', 3, 'warning'), ...]
```

### Bounded range probe

```bash
FROM="2026-05-01"; TO="2026-05-31"

curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE")" \
  "$API_BASE/api/attendance/advanced-scheduling/workbench?from=$FROM&to=$TO"
# Expect: HTTP 200, HTTP 400 only on malformed dates.
```

### Negative case (malformed `from`)

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE")" \
  "$API_BASE/api/attendance/advanced-scheduling/workbench?from=not-a-date"
# Expect: HTTP 400, body { ok: false, error.code: VALIDATION_ERROR }
```

### Negative case (inverted range)

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE")" \
  "$API_BASE/api/attendance/advanced-scheduling/workbench?from=2026-05-31&to=2026-05-01"
# Expect: HTTP 400, body { ok: false, error.code: VALIDATION_ERROR }
```

### Negative case (unauthenticated)

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  "$API_BASE/api/attendance/advanced-scheduling/workbench"
# Expect: HTTP 401, body { ok: false, error.code: UNAUTHORIZED }
```

All examples above:

- Use `GET` only.
- Use `AUTH_TOKEN_FILE` indirection so the token value is not printed, not committed, and only read from the local 0600 file at invocation time (per the secret-hygiene contract above; see that section for the argv caveat and the `-H @<header-file>` tighter variant).
- Print only status, summary, and diagnostic counts — never the raw response body, and never the token value.
- Are safe to run against production because no row is modified.

## 7. References

- Route registration: `plugins/plugin-attendance/index.cjs` around line 25790 (`addRoute('GET', '/api/attendance/advanced-scheduling/workbench', ...)`).
- Diagnostic emission: `plugins/plugin-attendance/index.cjs` around line 7588 onward (`buildAttendanceAdvancedSchedulingDiagnostic`).
- Assignment row limit constant: `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT = 500` at `plugins/plugin-attendance/index.cjs` line 7481.
- Backend test: `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts` — asserts diagnostic emission, response shape, and the absence of POST/PUT/DELETE.
- Frontend regression: `apps/web/tests/attendance-admin-regressions.spec.ts` — exercises the admin section's read-only render.
- Prior closeout: `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` — establishes the K3 PoC stage-1 lock + staged-opt-in discipline that this runbook respects.
- Advanced-scheduling benchmark and future-work matrix (if/when authored separately): consult the most recent advanced-scheduling closure doc for the "已具备 / 差距 / 禁区 / 可安全推进" framing. This runbook documents only "已具备 + 可安全使用" of the read-only workbench. Write-path items (grid edit / Excel import / temporary shift / dispatch / swap) remain explicitly out of scope here.
