# Design-lock (PROPOSED): Cross-midnight overtime windows (#8 NS-0)

> **Status**: PROPOSED — Wave 3 / arc #8 from the execution plan (#3048). My lane (non-Codex). Owner 拍板s §3 before build. MetaSheet 口径; no competitor names.
> **Scope**: lift the one remaining cross-midnight **hard-reject** — overtime-segmentation **windows** that span midnight — behind a **reverse/adversarial correctness matrix proven first** (plan NS-2). Overnight *shifts* are already supported; this is narrowly about the overtime window.
> **Grounding** (`origin/main`, `plugins/plugin-attendance/index.cjs`): overnight shifts work today — `computeMetrics` (~10246-10253) resolves `isOvernight` and moves `shiftEndAt` to the next day; integration test "computes overnight shift metrics against the next-day shift end window" passes (22:00→06:00, 470 workMinutes). The **only** cross-midnight hard-reject is `validateOvertimeSegmentationWindow` (~10143-10157): when an overtime window's `requestedInAt`/`requestedOutAt` fall on different calendar dates it returns `{ ok:false, code:'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' }` (enforced at ~10167-10176; test-locked at `attendance-overtime-segmentation.test.ts:144`). Rules carry no `is_overnight` column; only shifts do.

---

## 1. The decision — what #8 v1 is

The reject is a **deliberate v1 stability guard**, not a bug: segmenting an overtime window across a day boundary (e.g. 23:00→01:00) into workday/restday/holiday buckets is ambiguous, so v1 refused it with a stable code. #8 v1 makes cross-midnight overtime windows **computable** by giving the segmentation an explicit day-boundary rule, then lifting the reject **only after** an adversarial matrix proves the new split is correct and idempotent.

1. **Boundary-aware segmentation**: split a cross-midnight window at local midnight into per-date sub-spans, classify each sub-span (workday/restday/holiday) by **its own** date, and sum the buckets — so 23:00→01:00 contributes 1h to date D's bucket and 1h to date D+1's bucket.
2. **Reject lifted last**: the `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED` path stays until NS-2's matrix is green; the stable code remains for genuinely-invalid windows (e.g. reversed, or spanning >2 dates if we cap at one boundary).

No change to overnight **shift** handling (already correct) or to any non-overtime compute.

## 2. Contract

- **`validateOvertimeSegmentationWindow` keeps rejecting by default — the split lands BEHIND the guard.** *(owner review of #3071)* The boundary-aware compute MUST NOT change the route's default behavior, because `maybeBuildOvertimeSegmentationSnapshot` calls the validator directly — so NS-1 adds the one-midnight split **either** as a **separate helper** (e.g. `splitOvertimeSegmentationWindowAtMidnight`, which the validator does not invoke on the default path) **or** behind an explicit **`allowCrossMidnight` option defaulting `false`**. The default validator (the route path) keeps returning `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED` for one-midnight windows until **NS-3** explicitly flips it; a route-level test (NS-1/NS-2) proves one-midnight windows still reject until then. Reversed windows, and windows spanning more than one midnight, always keep the stable reject code regardless.
- **Segmentation output** is split by date: the snapshot records per-date sub-spans so each is bucketed by its own day's workday/holiday context (reusing the existing per-date classification — no new calendar model).
- **Idempotency**: re-running segmentation on the same window yields byte-identical buckets (no double-count at the boundary) — the landmine for boundary math.
- **Backward compatibility**: same-day windows are byte-identical to today (the new path only triggers when start-date ≠ end-date). The stable reject code is preserved for the still-invalid cases, so existing callers/tests that rely on it for those cases don't change.

## 3. Decisions for owner 拍板 (§3)

| # | Question | Recommended v1 | Why |
|---|---|---|---|
| 3a | **How many midnights may one window cross?** | **exactly one** (cap at a single boundary; >1 keeps the reject) | a single overtime window spanning >24h is almost always a data error; capping keeps the split provably 2-part |
| 3b | **Boundary attribution** | split at **local midnight** (rule timezone), each sub-span bucketed by its own date | matches how a person reads "I worked past midnight"; reuses per-date holiday/workday context |
| 3c | **Lift the reject in the same PR as the compute?** | **No** — ship boundary-aware compute behind the still-active reject, lift it only in the PR carrying NS-2's adversarial matrix | the plan's discipline: never unguard before the new behavior is proven (don't restate history on a half-proven split) |
| 3d | **Day-attribution of the reverse leave/OT effects** | overtime minutes land on **each sub-span's own date** (not all on the start date) | a restday-portion after midnight should count as restday, not bleed into the prior workday |

## 4. Boundaries / non-goals

- **Overtime windows only.** Overnight **shifts** already work — untouched. No new shift/rule `is_overnight` for rules.
- **One boundary cap** in v1 (3a). Multi-midnight windows stay rejected with the stable code.
- **Reject lifted only with the NS-2 matrix** (3c) — boundary-aware compute can land first behind the guard.
- **Serial with #5/#6** — shares the record-compute / overtime path; never land concurrently (plan §2/§7). #8 is the heaviest, sequenced **last**.
- No change to the stable `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED` code's meaning for genuinely-invalid windows (reversed / multi-midnight).

## 5. Slices (mirror the plan's NS-0..NS-4)

1. **NS-0 (this lock)** — boundary-aware segmentation model, the one-midnight cap, idempotency invariant, "lift the reject last" discipline.
2. **NS-1 boundary-aware compute, reject UNCHANGED** — add the per-date split as a **separate helper** (or behind an `allowCrossMidnight` option defaulting `false`); the validator's default path + `maybeBuildOvertimeSegmentationSnapshot` keep returning `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`. Tests: unit tests for the split + idempotency, **plus a route-level test asserting a one-midnight overtime window STILL rejects** (the reject is not lifted until NS-3).
3. **NS-2 reverse/adversarial matrix** — the proof: same-day unchanged; 23:00→01:00 splits 1h/1h by date; restday-after-midnight buckets correctly; reversed / multi-midnight still rejected; re-run idempotent. **Real-DB** integration over the actual segmentation snapshot.
4. **NS-3 lift the reject** — only after NS-2 is green: the route accepts the one-midnight window; the stable code remains for invalid cases. The test-lock at `attendance-overtime-segmentation.test.ts:144` is updated to assert the new accept + the preserved reject for invalid windows.
5. **NS-4 staging smoke** — a real cross-midnight overtime window segments + buckets correctly; a multi-midnight one still rejects; idempotent re-run.

## 6. Verification plan (real-DB, per plan §2 "data-affecting paths get real-DB integration")

- a 23:00→01:00 overtime window splits 1h to date D and 1h to date D+1, each bucketed by its own day's context (workday vs restday vs holiday); the snapshot round-trips through the **actual** segmentation projection.
- re-running segmentation on the same window is byte-identical (no boundary double-count).
- a reversed window and a >1-midnight window still return `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`.
- regression: same-day windows byte-identical to pre-#8; overnight **shift** metrics unchanged.

## 7. Governance

design-lock → **owner 拍板 §3 (midnight cap / attribution / lift-timing)** → NS-1 (compute behind guard) → NS-2 (adversarial matrix) → **NS-3 lift the reject** → NS-4 staging smoke → tracker backfill. Serial vs #5/#6; sequenced last (heaviest). PROPOSED until selected. MetaSheet 口径; no competitor names.
