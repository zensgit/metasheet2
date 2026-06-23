# Design-lock (PROPOSED): Pending-leave overlay + team availability (#6 TA-0)

> **Status**: PROPOSED — Wave 2 / arc #6 from the execution plan (#3048), **after #5** (serial: both touch the hot `resolveEffectiveCalendar` / record-compute path). My lane (non-Codex). Owner 拍板s §3 before build. MetaSheet 口径; no competitor names.
> **Scope**: make **pending** (un-approved) leave visible in the team's scheduling/availability view — without changing the final attendance records — and add a **team-availability** read surface (**by group + date in v1; dept-level selection deferred** — see §3e). Today only **approved** leave reflects in the calendar.
> **Grounding**: `origin/main`, `plugins/plugin-attendance/index.cjs`. `resolveEffectiveCalendar(db, args)` (~14012) builds the per-user `items[]` (~14739); the leave→calendar reflection queries `request_type IN ('leave','overtime') AND status = 'approved'` (~11365), so **pending leave is invisible**. No team/group availability surface exists (grep 0). Frontend mirror: `apps/web/src/services/attendance/effectiveCalendar.ts`.

---

## 1. The decision — what #6 v1 is

`resolveEffectiveCalendar` is the single source of truth for "what is this person's day." v1 adds a **provisional overlay** on top of it — pending leave shows as a distinct, clearly-tentative item — and a **team-availability** endpoint that aggregates the (existing) effective calendar + this overlay across a group.

1. **Pending overlay (additive)**: surface `status='pending'` leave as `kind:'pending_leave'` items in `resolveEffectiveCalendar`'s output, **distinct** from approved leave and **never** written to `attendance_records` (pending is not a fact yet). The approved-leave path and final records are unchanged.
2. **Team availability (read-only)**: an endpoint that, for a **group + date range** (v1; dept deferred per §3e), returns each member's effective day (scheduled / on-approved-leave / pending-leave / unscheduled), aggregated from the resolver.

The hard line: this is **visualization + provisional overlay only** — it must not alter how any final attendance record, deduction, or report number is computed.

## 2. Contract

- **Overlay**: `resolveEffectiveCalendar` gains an opt-in arg (e.g. `includePending: boolean`, default **false** so today's callers are byte-identical) that, when set, adds `pending_leave` items from the pending leave requests. Each carries the request id + the date(s); they sort/merge **after** approved items and never displace them. The **write paths** (`recalculateFormulaFields` / record persistence) ignore `pending_leave` items — they're display-only (mirror the taint-skip discipline: a provisional item must never reach the records model).
- **Team-availability endpoint** (`GET …/team-availability?groupId=&from=&to=`): **v1 is group-only — `groupId` is required**; a dept-level selector and its permission semantics are a deferred follow-up (§3e), so v1 ships one well-scoped surface. Permission-gated (owner/sub-owner/admin for the group — reuse the existing group-scope gate); returns `{ date, userId, state: 'scheduled'|'rest'|'approved_leave'|'pending_leave'|'unscheduled' }[]` aggregated from the resolver.
- **State transitions**: a pending item **disappears** when the request is rejected/cancelled (it was never a record); it becomes a **formal** approved-leave item (the existing path) on approval. The overlay is always derived live from request status — no separate stored pending-calendar state.

## 3. Decisions for owner 拍板 (§3)

| # | Question | Recommended v1 | Why |
|---|---|---|---|
| 3a | **Does pending leave reduce counted capacity?** | **Show-only, tentative** — surfaced as `pending_leave` but NOT subtracted from "available headcount" totals (or subtracted only into a separate "tentative" bucket) | counting unconfirmed leave as capacity loss would mislead planning; show it, let the manager decide |
| 3b | **Who sees pending leave?** | group **owner / sub-owner / admin** (the existing group-scope gate); **not** peers | pending leave is sensitive; reuse the shipped scope gate, add no new capability |
| 3c | **Calendar marking** | a distinct provisional style + a 口径 tooltip ("待审批，未生效") — never the same as approved | the manual's "precise, trust-building definitions" humanization lesson; avoid "is this person off or not?" ambiguity |
| 3d | **Multi-day / partial-day pending** | follow whatever the leave request already models (don't invent new granularity) | keep the overlay a faithful projection of the request, not a second model |
| 3e | **Selector granularity (group vs dept)** *(owner review of #3056)* | **v1 group-only** — `groupId` required; a dept-level selector + its own permission semantics are a separate follow-up | the contract is `?groupId=` and the scope gate is group-shaped; a dept selector needs its own visibility model (who-sees-which-dept), so ship group-only first and design dept when demanded |

## 4. Boundaries / non-goals

- **Overlay + read-only availability only.** No change to approved-leave handling, deductions (#1/#7), or any final record/report number.
- **`includePending` default false** — zero behavior change for existing `resolveEffectiveCalendar` callers; only the new availability surface (and an opt-in calendar view) request the overlay.
- **Serial with #5/#8** — all three touch `resolveEffectiveCalendar` / record-compute; never land concurrently (plan §2/§7). #6 runs **after #5**.
- **No capacity/staffing engine** — availability is a read aggregation, not an auto-scheduler.

## 5. Slices (mirror the plan's TA-0..TA-4)

1. **TA-0 (this lock)** — overlay model, `includePending` opt-in, pending-vs-approved-vs-rejected visibility, the display-only (never-to-records) invariant, capacity 拍板.
2. **TA-1 resolver overlay** — `resolveEffectiveCalendar` adds `pending_leave` items behind `includePending`; a guard test that the write/records path ignores them (display-only).
3. **TA-2 team-availability endpoint** — **group + date** aggregation (v1 group-only; dept deferred per §3e), scope-gated; read-only.
4. **TA-3 UI calendar** — team availability view + the provisional marking + 口径 tooltip.
5. **TA-4 staging smoke** — pending visible to owner; reject → disappears; approve → becomes formal; records unchanged throughout.

## 6. Verification plan (real-DB, per plan §2)

- a pending leave appears as `pending_leave` in `resolveEffectiveCalendar(includePending:true)` but **NOT** in the default call, and **NOT** in `attendance_records` (the display-only invariant — a real-wire guard).
- reject the request → the `pending_leave` item is gone on the next resolve; approve → it becomes the existing approved-leave item; records unchanged across both.
- team-availability endpoint: a non-owner/non-admin of the group → 403; owner → sees members' states incl. pending.
- regression: default `resolveEffectiveCalendar` output byte-identical to pre-#6 (the opt-in didn't perturb it).

## 7. Governance

design-lock → **owner 拍板 §3 (capacity / visibility / marking)** → TA-1…TA-4 small PRs (subagent-reviewed, CI, real-DB integration for the resolver-overlay + records-isolation guard) → staging smoke → tracker backfill. **After #5; serial vs #8.** PROPOSED until selected. MetaSheet 口径; no competitor names.
