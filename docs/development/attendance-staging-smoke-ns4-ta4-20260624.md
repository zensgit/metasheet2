# Attendance staging smoke — NS-4 (cross-midnight overtime) + TA-4 (team availability)

> **Status**: ✅ **PASS / CLOSED** (2026-06-24). Both smokes ran end-to-end on staging at deploy SHA `be16791d5`, both **PASS**, **residue=0** — see the filled stamps below. #8 (NS-4) and #6 (TA-4) are fully closed (code on `main` + staging-validated).

> **Conventions**: each smoke is end-to-end through the real staging route + DB. Use a disposable test user/group/dates so cleanup leaves **zero residue**. Record the exact `git rev-parse HEAD` deployed (must include the SHAs noted per section). Restore any global setting you toggle.

---

## NS-4 — cross-midnight overtime, end-to-end

**Deployed code must include**: NS-0 design-lock, NS-1 split, NS-2 bucketing, NS-3 lift+snapshot (`buildCrossMidnightOvertimeSegmentationSnapshot`, the `spans[0].date === workDate` anchor). Confirm `git log` on the deployed SHA shows `#3116` (NS-3).

**Preconditions**
1. Admin/approver token (`attendance:read,write,admin,approve`). A disposable test `userId`.
2. An overtime rule (`POST /api/attendance/overtime-rules`, e.g. `minMinutes:0, roundingMinutes:1`).
3. **Snapshot current settings** (`GET /api/attendance/settings`) to restore later, then enable: `PUT /api/attendance/settings { overtimeSegmentation: { enabled: true } }`.
4. Learn the work timezone: `GET /api/attendance/effective-calendar?from=D&to=D&userId=…` → `data.timezone`. Build all window times to cross **local** midnight in that tz. Use dates away from DST transitions.
5. Insert a holiday on **D+1** (`attendance_holidays`, `is_working_day=false`) so the after-midnight portion is distinguishable.

**Steps & expected**
| # | Action | Expect |
|---|---|---|
| 1 | Create overtime, window `D 23:00 → D+1 01:00` (local), 120 min | `201`. `metadata.overtimeSegmentation`: `crossesMidnight=true`, `totalMinutes=120`, `perDate=[{D}, {D+1}]`, `segments` **conserved** (Σ workday+restday+holiday `=120`), the D+1 portion (60) in the **holiday** bucket. |
| 2 | Corrupt the draft snapshot (set a bucket to 999 via DB), then **approve** | `200`. The stored `overtimeSegmentation` is **byte-identical** to step 1's (recomputed in the approval txn — replay-idempotent, no boundary double-count). |
| 3 | Create overtime spanning **>1 midnight** (`D 23:00 → D+2 01:00`) | `422`, code `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`. |
| 4 | Create overtime **off workDate** (`workDate=D`, window entirely on `D+1`) | `422`, code `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED` (§P1 anchor). |
| 5 | Create overtime **reversed** (`out ≤ in`) | `422`, code `OVERTIME_INVALID_TIME_WINDOW`. |
| 6 | Create a **same-day** overtime (regression) | `201`, `overtimeSegmentation` shape **unchanged** from pre-#8 (single `dayType`, all minutes in one bucket, **no** `crossesMidnight`/`perDate`). |
| 7 | Check the record / report / summary surface for the cross-midnight request | the surfaces expose the **aggregated** `workday/restday/holiday` bucket **totals**, conserved with step 1 (Σ = `totalMinutes`). `perDate` lives ONLY in the request's `metadata.overtimeSegmentation` — the record/report/summary do **NOT** expand by date (don't smoke against a non-existent per-date report surface). |

**Cleanup / residue**
- Delete the created overtime requests + their `attendance_events`; delete the holiday + overtime rule; **restore** the original settings; delete `attendance_records` for the test user/dates.
- **Residue check** (must be 0): `attendance_requests`, `attendance_events`, `attendance_records`, `attendance_holidays`, `attendance_overtime_rules` — every one for the test user/dates/rule (an orphaned event or leftover rule is a false-green).

**PASS stamp** — stamp: `ns4-pass-sb2u88xu` · deploy SHA: `be16791d5` · date: `2026-06-24` · result: ✅ `PASS` · residue=0: ☑ · notes: covered one-midnight accepted · per-own-date conserved buckets · D+1 holiday bucket · approve recompute byte-identical · multi-midnight reject · off-workDate reject · reversed → 422 `OVERTIME_INVALID_TIME_WINDOW` (#3128) · same-day regression · record/report/summary aggregated buckets.

---

## TA-4 — team availability (pending-leave overlay), end-to-end

**Deployed code must include**: TA-0 design-lock, TA-1 overlay, TA-2 endpoint (`/api/attendance/team-availability`, the §P2 404), TA-3 UI section. Confirm the deployed SHA shows `#3087` (TA-2) and `#3095` (TA-3).

**Preconditions**
1. Admin **or** group owner/sub-owner token for the test group. A disposable group with ≥2 members.
2. One member (`m1`) has a **pending** leave request (`status='pending'`, `request_type='leave'`) on a workday `D`; another (`m2`) has none.

**Steps & expected**
| # | Action | Expect |
|---|---|---|
| 1 | `GET /api/attendance/team-availability?groupId=&from=D&to=D` (admin/owner) | `200`. `items`: `m1.state='pending_leave'` (distinct from `approved_leave`); `m2.state ∈ {scheduled, rest, unscheduled}`. `summary[D]`: `pendingLeaveTentative=1`, `approvedLeave=0`, **`availableFormal = scheduled + pendingLeaveTentative`** (pending **counted**, not subtracted). |
| 2 | UI: open **Team availability** (Organization group) → enter group + range → Load | the `m1` cell renders the **provisional** style (dashed/amber/italic) + tooltip **"待审批，未生效"**, visibly distinct from approved leave's style. |
| 3 | Omit `groupId` | `400` (v1 is group-only, §3e). |
| 4 | Same call as a **non-admin / non-manager** (`RBAC` on) | `403` (§3b scope gate). |
| 5 | Call with a **valid-UUID but non-existent** groupId (admin) | `404` `NOT_FOUND` — **not** a misleading `200` empty (§P2). |
| 6 | UI: load group A, then a failing/second load | the stale table **clears** (no group-A residue under group-B's form). |
| 7 | Confirm display-only | the pending leave did **not** change `attendance_records` or approved-leave; no write side-effects. |

**Cleanup / residue**
- Delete the test group + members + the pending leave request.
- **Residue check** (must be 0): `attendance_group_members`, `attendance_groups`, `attendance_requests` for the test group/user.

**PASS stamp** — stamp: `ns4-ta4-mqro9by8` · deploy SHA: `be16791d5` · date: `2026-06-24` · result: ✅ `PASS` · residue=0: ☑ · notes: pending_leave distinct + provisional UI "待审批，未生效" · availableFormal counts pending · group-only / scope / non-existent guards · stale-clear · display-only.

---

## Sign-off

✅ **Closed 2026-06-24.** Both smokes ran end-to-end on staging at deploy SHA `be16791d5` (health ok; migration `zzzz20260624120000_create_meta_config_revisions` applied) — **NS-4 `ns4-pass-sb2u88xu` PASS / residue=0** and **TA-4 `ns4-ta4-mqro9by8` PASS / residue=0**. #8 cross-midnight overtime and #6 team-availability are fully validated end-to-end on staging; temporary worktrees and local branches cleaned up. NS-4 and TA-4 are **closed**.
