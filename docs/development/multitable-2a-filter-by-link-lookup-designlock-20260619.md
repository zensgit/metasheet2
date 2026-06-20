# Multitable 2a — filter by link / lookup value (design-lock)

> **Status: DESIGN-LOCK ONLY.** No implementation here. Filter-by-link is permission-sensitive and
> cross-cutting (it touches the same ~10 filter eval/prune sites the nested-groups work just refactored),
> so — like the 1b record-set lock — the model is pinned before code. The decisions below were **ratified
> at review on 2026-06-20** (D1–D6); the first implementation slice is a separate opt-in that builds to them.

## 0. The problem

Today a `link` field falls through `evaluateMetaFilterCondition` to the **string** branch, where
`toComparableString(cellValue)` runs against `record.data[linkFieldId]` — which is an **array of linked
record IDs**, not the **display value** the user sees. So "filter where Project is *Acme*" actually
compares against opaque IDs and never matches what the user typed. Filter-by-link/lookup means: compare
against the linked records' **display values**, **permission-aware** (a linked record the requester cannot
see must never match and must never leak its display string).

`lookup` fields have the parallel problem: the surfaced value is a looked-up foreign field, materialized
separately; filtering must compare against that materialized value with the same permission discipline.

## 1. The architectural crux (why this needs a lock)

`evaluateMetaFilterCondition(type, cellValue, condition)` is a **pure** function — it sees only the cell's
raw value, not the linked records' display strings. Those come from `LinkedRecordSummary { id, display }`,
materialized per-record (the records-list path already loads them via `applyLookupRollup` /
`loadLinkValuesByRecord`) and permission-filtered against `loadDeniedRecordIds(foreignSheetId)`.

So filter-by-link requires **threading the permission-filtered display values to the eval** — the same
"materialize-then-filter, never read-raw-then-mask" discipline used by dashboard `loadChartRecords` and the
nested-filter redaction. That threading is the design decision; getting it wrong leaks a hidden linked
record's display string into a match result.

## 2. Resolved decisions (ratified at review 2026-06-20 — these were the G0 open questions)

The owner ratified the leaning options. They are now **locked** and define the first implementation slice.

- **D1 — compare against the linked record's `display` string** (the chip the grid shows), not the
  primary-field raw value. Matches the visible chip and the existing `LinkedRecordSummary` materialization.
- **D2 — a denied linked record is excluded from the comparison set** for **value operators** (`contains`/
  `is`): a hidden link is simply "not a match", consistent with row-deny precedent, and its display string
  is never compared or surfaced. (Presence operators are the explicit exception — see D5.)
- **D3 — reuse the nested-groups per-leaf evaluator threading.** Extend the existing per-leaf evaluator to
  receive the record's permission-filtered link summaries; link conditions are normal leaves inside the
  nested AND/OR tree — no separate link-only pass.
- **D4 — first cut = free-text `contains` / `is` / `isEmpty` over display.** No `isAnyOf`, no linked-record
  picker in the first slice (both deferred).
- **D5 — operator evaluation basis (the permission-critical pin).** `contains` / `is` evaluate over the
  **permission-filtered display set** (denied links excluded, per D2). `isEmpty` evaluates over **raw link
  presence/count** — it asks only "does this cell hold any link at all?", **without materializing or
  comparing any display string** (so it leaks nothing) and **permission-invariantly** (a restricted user
  gets the identical `isEmpty` result a full-permission user gets).
  *Why this split is mandatory:* if `isEmpty` used the filtered set, a row whose links are **all** hidden
  from the requester would read as *empty* for that requester yet *non-empty* for a full-permission user —
  producing a match a full-permission user would not see, violating §3. Presence operators therefore never
  consult the filtered set. (`isNotEmpty`, when added, follows the same raw-presence rule.)
- **D6 — multi-valued semantics (link is an array).** `contains X` ⇒ **any** visible (permission-filtered)
  display value contains substring X. `is X` ⇒ **membership**: any visible display value equals X exactly
  ("the link set includes a record displayed as X"), not "the whole set equals `[X]`". `isEmpty` ⇒ the raw
  link array has zero entries (per D5).

## 3. Locked principles (independent of the open questions)

- **Permission: filter-at-materialization (value operators).** For `contains`/`is`, denied linked records
  (`loadDeniedRecordIds(foreignSheetId)`) are excluded from the comparison set **before** the eval sees
  them — never read-raw-then-mask. Reuses the exact discipline from dashboard chart-data + nested-filter
  redaction. **Presence operators (`isEmpty`) bypass materialization entirely** (raw array count, no
  display values touched — D5), which is itself leak-free.
- **No silent wrong match (the invariant D5 protects).** A hidden link never produces a match a
  full-permission user wouldn't see, and never leaks the hidden display string — for *every* operator,
  presence operators included.
- **Compose with nested groups.** A link condition must be a normal leaf inside the nested AND/OR tree
  (D3) — not a special top-level-only case.
- **Bounded.** Reuses the existing per-record summary materialization (already paginated/bounded); no new
  unbounded scan. Cross-base links out of scope at lock time.

## 4. Gated TODO checklist
> 🔒 blocked · ⬜ ready · ✅ done

- ✅ **G0 — this design-lock** (crux + open questions + locked principles).
- ✅ **G1 — decisions ratified** at review 2026-06-20 (D1–D6).
- ⬜ **Slice — link filter eval** (first cut, ready): permission-filtered display materialization →
  per-leaf eval threading (D3) → `contains`/`is` over the filtered display set + `isEmpty` over raw
  presence (D5/D6) → real-DB permission goldens: denied-link excluded · hidden-display non-leak ·
  **all-links-hidden row ⇒ `isEmpty` permission-invariant (matches iff raw-empty), `is`/`contains` never
  match via the hidden link** · composes inside a nested group.
- 🔒 **Slice — lookup filter eval** (same discipline, over the materialized lookup value). *After link slice.*
- 🔒 **FE — link/lookup operator menu + value control** (free-text first, D4). *With/after the eval slice.*

## 5. Non-goals
- No cross-base link filtering at lock time.
- No linked-record picker UI in the first slice (free-text over display first).
- Own principles only; standard nomenclature, no external product names.
