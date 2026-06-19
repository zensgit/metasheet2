# Multitable Capability-Depth Hardening Plan (PROPOSED — gated tracks)

> Status: **PROPOSED plan.** Each track is a separate owner-gated arc: design-lock → opt-in → implement.
> Nothing here is built without an explicit per-track go.
> Motivation: the multitable surface has reached broad capability coverage; the remaining distance to a
> mature collaborative-table product is concentrated **depth**, not breadth. This plan targets that depth.
> The external-product capability comparison that motivates the targets lives in the internal research
> audit (not restated here, per the formal-docs principle). This plan states our own capability targets.

## Principle

Stop adding scattered features; close the few deep gaps that separate "has the feature" from "the feature
is as deep as users expect." Three tracks, prioritized so the fastest high-value parity wins land first and
the heavy structural changes are explicitly design-locked before any code.

## Track 1 — Formula depth  *(highest priority)*

**Why:** the formula engine has a competent operator set + nested calls + a real dependency graph, but the
*effective* function surface for record formulas is ~30 scalar functions, well below a mature spreadsheet
formula ecosystem. This is the single largest depth gap.

- **1a — Scalar function expansion *(do first; low risk, self-contained).*** Add the missing scalar
  functions: text (`TEXT`, `FIND`, `SEARCH`, `REPLACE`, `REPT`, `REGEX*`), date/time (`HOUR`, `MINUTE`,
  `DATEADD`, `EOMONTH`, `WORKDAY`, `WEEKNUM`), math (`INT`, `TRUNC`, `LOG`/`LN`, `EXP`, `SUMIF`,
  `COUNTIFS`, `AVERAGEIF`). Pure additions to the function registry + unit matrix per function + catalog
  sync (the user-facing catalog currently drifts from the engine — reconcile it as part of 1a). No
  architecture change. Verification: per-function unit goldens; catalog↔engine parity test.
- **1b — Array / range / lookup-in-formula over record data *(heavy — design-lock first).*** Today the
  multitable engine is no-DB and substitutes field refs as scalars/comma-joined strings, so `VLOOKUP`/
  `INDEX`/`MATCH`/array aggregation are not wired to record data, and multi-value fields aggregate
  lossily. Making these real requires record-data array/range semantics + a cross-record evaluation
  contract — a structural change that needs its own design-lock (data model + recompute + dependency
  fan-out + permission taint) before any code.

## Track 2 — View filtering + personal views

**Why:** view *filtering* is operator-shallow and views are globally shared. (Note: conditional
formatting already has relative-date / between / is-today — the gap is specifically the **view filter**
UI + backend semantics, not conditional formatting.)

- **2a — Filter operator depth *(do first, in parallel with 1a; backend + FE).*** Add to the view filter:
  relative-date operators (today / last-N-days / overdue / this-week-month), `between`, `is any of` /
  `is none of` (multi-select), filter-by-value on link/lookup fields, and nested AND/OR condition groups
  (the automation engine already nests; views don't). Verification: backend filter-eval goldens per
  operator + FE builder spec.
- **2b — Per-user / personal views *(heavy — design-lock first).*** All view config is currently shared
  (one filter/sort/group set for everyone) and field order is sheet-global. Personal views require a
  per-user view-state data model + a shared-vs-personal resolution contract + per-view field order. Needs
  its own design-lock before code.

## Track 3 — AI batch + confirmation flow  *(third)*

**Why:** AI shortcuts are wired but per-record only, write to string/longText only, and auto-persist with
no review gate.

- Batch / whole-column fill (run a shortcut across a filtered selection) under the existing quota +
  redaction governance; a generate → **review** → write confirmation step (no silent auto-persist);
  broaden target field types where safe (e.g. classify → select). Verification: batch quota accounting +
  confirm-gate golden + per-target-type write goldens.

## Sequencing (recommended)

1. **Parallel: 1a (scalar formulas) + 2a (view filter operators)** — fastest, self-contained, highest
   perceptible depth gain.
2. **1b + 2b** — each a separate heavy design-lock (record-data formula semantics; per-user view model),
   scheduled after 1a/2a land.
3. **Track 3 (AI batch + confirm)** — after, or in parallel if capacity allows.

## Gating

Every track and sub-track is a separate opt-in. The heavy ones (1b, 2b) get a design-lock doc + owner
ratification before implementation, exactly like the open-API token-auth lock. This plan does not
authorize building any of them — it sequences the work and names the gates.
