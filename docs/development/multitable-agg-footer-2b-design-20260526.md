# Multitable Aggregation Footer #4-3b-2 — Scout + Design (2026-05-26)

**Status: docs-only scout/design. No implementation in this slice.**
Successor to #4-3b-1 (`docs/development/multitable-agg-footer-design-20260525.md` design / `-verification-20260525.md` shipped & merged #1841). benchmark v2 §9 #4 ("Grid BI polish"), sub-slice 3b-2.

This doc exists to **lock boundaries and shapes** so the three entangled follow-ups (group subtotals, SQL-side aggregation, computed-filter parity) can be split into independent, separately-gated PRs. It deliberately does **not** specify SQL mechanics — those belong to the SQL-agg PR's own design, which must earn its complexity with a benchmark.

> **K3 precedence:** every piece below is multitable-internal kernel-polish, NOT on the K3 PoC critical path. Under [[k3-poc-stage1-lock]], if K3 has any action, this whole track yields. None of it touches rbac / integration-core / contract.

---

## 0. What #4-3b-1 already shipped (the baseline this extends)

`GET /sheets/:sheetId/view-aggregate` (univer-meta.ts) → grand-total only:

```
{ ok: true, data: { total: <filtered row count>, aggregates: { [fieldId]: { fn, value } } } }
```

Locked invariants from #4-3b-1 that #4-3b-2 MUST preserve verbatim:
- **Two field sets.** Filter/search resolve over `visibleFields` (static-visible, mirrors `/view`); aggregate **output** is restricted to the D3c-allowed set (static `property.hidden` + `view.hiddenFieldIds` + subject `field_permissions.visible=false`). A hidden field's rows still count; its aggregate is **omitted**, never null/zero.
- **413 = whole-sheet scan-input cap (NOT filtered).** Shipped #1841 runs `SELECT COUNT(*) FROM meta_records WHERE sheet_id=$1` — the *raw sheet* row count, before any filter — and 413s if it exceeds `MULTITABLE_AGGREGATE_MAX_ROWS`; the 413 body's `total` is that raw count. This protects the in-memory scan (the endpoint fetches all sheet rows, then filters in memory). The **success** response's `data.total` is the *filtered* row count — a different number. Never truncate. (Full treatment in §3.3.)
- **Computed filter → 422.** lookup/rollup/formula filter conditions hard-fail `AGGREGATE_COMPUTED_FILTER_UNSUPPORTED` (this endpoint has no `applyLookupRollup` materialization).
- **Frontend renders server response only.** No local fallback aggregation.
- **fns LOCKED:** sum/avg/min/max/count/countNonEmpty/countDistinct; empty = null/undefined/''/[]; fn-not-applicable-to-type → omit.

---

## 1. Scout findings (ground truth, 2026-05-26)

| question | finding | source |
|---|---|---|
| Does `/view` return a server-side **group** shape to mirror? | **No.** Grid row-grouping is **purely client-side** — `groupFieldId` ref groups the *loaded page* in the browser. "group.count is page-only" = the client counts groups over the loaded page only. | `useMultitableGrid.ts:392` (`groupFieldId`/`groupField`); no `groups:` in the route response (dashboard `groupByFieldId` is unrelated). |
| Where does the **grid** group config live? | **`view.groupInfo.fieldId`** is the grid source of truth — `useMultitableGrid` reads it (`:499`) and `setGroupField` persists it (`:545` via `updateView({ groupInfo: { fieldId } })`). `view.config.groupFieldId` is a **Kanban/Gantt** config helper, **not** the grid contract — don't treat it as primary unless a migration is planned (none is). **Single** group field, not multi-level. | `useMultitableGrid.ts:499,545`; `utils/view-config.ts` (Kanban/Gantt) |
| What is the 413 cap actually counting? | The **raw whole-sheet row count** (`COUNT(*)` with no filter) — a scan-input cap; the endpoint pulls all sheet rows then filters in memory. The success `data.total` is the *filtered* count; the two differ. | `univer-meta.ts:5775,5778,5806,5812` |
| What does computed-filter parity actually require? | Importing `applyLookupRollup(req, query, fields, rows, relationalLinkFields, linkValuesByRecord)` — per-field lookup/rollup config parse + **link traversal with extra queries**. Heavy; couples the aggregate endpoint to the link subsystem. | `univer-meta.ts:1554` (def), called by `/view` at `:5913` after fetch, before filter |
| How does `/view` resolve a computed filter today? | Materializes lookup/rollup into `record.data` via `applyLookupRollup` **before** `evaluateMetaFilterCondition` runs. The aggregate endpoint skips this step → must refuse (422), not guess. | `univer-meta.ts:5913→5927` |

**Consequence:** there is no existing server group shape to extend — #4-3b-2a defines a **new** shape, the natural extension of the #4-3b-1 grand-total shape (one more level: per-group `aggregates`).

---

## 2. The one coupling that matters: fast-path / slow-path boundary

The three follow-ups look like three features but are really **one engine contract + two things hanging off it**. They entangle through a single predicate:

```
viewTouchesComputed(view) :=
  any of { filterInfo.conditions[].fieldId, groupFieldId }
  resolves to a field whose type ∈ { lookup, rollup, formula }
```

> **Sort is intentionally NOT in the predicate.** The aggregate endpoint never orders rows — sort affects only `/view`'s display order, never an aggregate or subtotal value, and groups are emitted in server group-key order (§3.1). So a computed *sort* field is irrelevant to subtotal correctness and must **not** trigger a 422.

- **`viewTouchesComputed === true` ⇒ SLOW PATH** — values only exist after in-memory `applyLookupRollup` materialization, so SQL `GROUP BY` is impossible; you must fetch → materialize → filter → aggregate in memory.
- **`viewTouchesComputed === false` ⇒ FAST PATH eligible** — every reference is a stored scalar; aggregation *could* be pushed to SQL.

Drawing this line is the **primary deliverable** of this doc. Once drawn, the three follow-ups decouple cleanly (§4).

### 2.1 ONE computed rule, two reference slots (not two half-rules)

The same rule covers **filter and group-by** (not sort — see the note above). Whoever implements #4-3b-2a must apply it to **both** slots or they'll ship a half-rule and earn a second review round. Until computed parity is implemented (#4-3b-2c, demand-gated), a computed reference in either slot **hard-fails**:

| slot | code |
|---|---|
| `filterInfo.conditions[].fieldId` is computed | `AGGREGATE_COMPUTED_FILTER_UNSUPPORTED` (already shipped in #4-3b-1) |
| `groupFieldId` is computed | `AGGREGATE_COMPUTED_GROUP_UNSUPPORTED` (new in #4-3b-2a) |

Both are `422`, same family. This is the safe "clear deferred error beats silent-wrong" posture established in #4-3b-1.

---

## 3. The three locks

### 3.1 Group subtotal **response shape** (LOCKED)

Extend the #4-3b-1 shape with an **optional** `groups` array; grand-total `aggregates` stays exactly as-is (back-compat — a non-grouped request returns the #4-3b-1 shape unchanged):

```jsonc
{
  "ok": true,
  "data": {
    "total": 60,                           // FILTERED row count (NOT the 413 basis — that's the raw sheet count, §3.3)
    "aggregates": { "fld_qty": { "fn": "sum", "value": 1830 } },   // grand total (unchanged from #4-3b-1)
    "groupFieldId": "fld_cat",             // echo of the resolved grid group field (from view.groupInfo.fieldId); null/absent when not grouped
    "groups": [                            // present ONLY when groupFieldId resolves to an allowed, non-computed field
      {
        "key": "A",                        // distinct value of the group field (see 3.2 — group field MUST be allowed)
        "count": 30,                       // rows in this group within the filtered set
        "aggregates": { "fld_qty": { "fn": "sum", "value": 900 } }  // SAME fns/omission rules as grand total
      },
      { "key": "B", "count": 30, "aggregates": { "fld_qty": { "fn": "sum", "value": 930 } } }
    ]
  }
}
```

Shape rules:
- `Σ groups[].count === total`. Groups **partition** the filtered set (every filtered row lands in exactly one group).
- Per-group `aggregates` use the **identical** fn set, type-applicability, and D3c omission rules as the grand total. A denied/hidden aggregate field is omitted in **every** group, just as in the grand total.
- **NULL/empty group key** is one group with **`key: null`** — this is a **response contract** (reviewer-locked 2026-05-26), not an impl detail. The frontend renders it with the existing "(empty)" group label. Tests assert the `null`-keyed group is present and its count is included in `Σ groups[].count === total`.
- `groups` ordering: by group key (stable). Server-defined; the client does not re-sort. (Value-based group ordering — e.g. "by subtotal desc" — is **out of scope**; deferred.)
- When `groupFieldId` is absent/empty → no `groups` key, response is byte-identical to #4-3b-1.

### 3.2 Group **key** permission strategy (LOCKED)

New security surface unique to grouping: the **group-by field's distinct values become the response keys**. If the group field is D3c-hidden/denied, returning group keys **leaks that field's data** — the same leak class #4-3b-1 guarded for aggregate output, but on the partition key.

**Disposition: hard-fail, do not silently degrade.**

```
groupFieldId not in the D3c-allowed set  →  422 AGGREGATE_GROUP_FIELD_DENIED
```

- **No silent fallback to grand-total-only.** A silent disposition change is exactly the "silent wrong" anti-pattern #4-3b-1's review round removed; the caller must know grouping was refused, not get a quietly-degraded response.
- Group field is computed → `422 AGGREGATE_COMPUTED_GROUP_UNSUPPORTED` (§2.1), checked independently of the denied check.
- Per-allowed-field **subtotals** follow the grand-total omission rule unchanged (denied aggregate field omitted in every group). The new gate is **only** about using a denied field *as the partition key*.
- The group field is also subject to the same `visibleFields`-vs-`allowedFields` distinction: a field that is statically visible but D3c-denied for this subject is **not** a usable group key (it's not in the allowed set) → 422.

### 3.3 413 stays the **whole-sheet scan-input cap** (LOCKED — matches shipped #1841)

- The cap is on the **raw whole-sheet row count** (`SELECT COUNT(*) FROM meta_records WHERE sheet_id=$1`, no filter) — a *scan-input* bound, because the endpoint fetches all sheet rows then filters in memory. This is the **current conservative semantics of #1841** (`univer-meta.ts:5775`), **not** "filtered rows."
- The **success** response's `data.total` is the *filtered* row count (`rows.length` after filter) — a different number from the 413 basis. The 413 error body's `total` is the raw count.
- Grouping is a partition of the already-fetched set, so it introduces **no** new unbounded scan. The 413 guard runs before fetch/group, identically to #4-3b-1. **Not** per-group, **not** group count (a per-group cap would let a 1M-row sheet through if groups are small, defeating the scan bound).
- **Deferred decision (entangled with #4-3b-2b):** whether to switch the cap from raw-sheet to *filtered* rows is a separate follow-up, and only becomes meaningful with SQL pushdown — once aggregation is pushed to Postgres there is no in-memory scan to bound, so #4-3b-2b must redefine the cap's meaning (e.g. a filtered-row or estimated-cost cap). Until then the raw-sheet scan-input cap stands. **Do not silently re-interpret it as "filtered rows."** (This is exactly why the evidence gate for SQL-agg must be precise: "a real sheet hits 413" today means *raw sheet count* > cap.)

---

## 4. PR split + gates (LOCKED)

Three **separate** PRs. They never share a PR. Order and gating:

### #4-3b-2a — Group subtotals (in-memory) — *available to opt-in now*
- Extends the existing in-memory filtered-set scan: partition the already-fetched, already-filtered rows by `groupFieldId`, aggregate each partition with the existing `aggregateField` helper.
- Implements §3.1 shape, §3.2 group-key permission gate, §2.1 computed-**filter+group** 422 (sort excluded — §2), §3.3 unchanged 413.
- **Zero engine/storage change.** Lowest risk, highest product value (Feishu/Airtable-style group footers). Inherits all #4-3b-1 security/parity guarantees per-group.
- Frontend: per-group subtotal rows in the grouped `<tbody>`; server response only (no local fallback), same as the grand-total footer.
- Real-DB tests: Σgroups.count === total; per-group sum parity; hidden aggregate field omitted in every group; **group-by denied field → 422**; **computed group field → 422**; empty-key group.

### #4-3b-2b — SQL-side aggregation (perf rewrite) — *EVIDENCE-gated*
- Non-functional rewrite: pushes the fast-path (`viewTouchesComputed === false`) aggregation into Postgres, raising the row ceiling above the in-memory 413 bound.
- **Gate: only if a real sheet hits 413.** Must ship with a benchmark/verdict (like the D2 perf gate) justifying the complexity (jsonb aggregation, NULL-key GROUP BY semantics, fast/slow dispatch). Those mechanics are **out of scope for this doc** — they belong to #4-3b-2b's own design.
- Sequenced **after** #4-3b-2a so SQL `GROUP BY` is designed once (covering grand-total + group), not twice.

### #4-3b-2c — Computed-filter/group parity — *DEMAND-gated; default = keep 422*
- Replace the §2.1 422s with real resolution by running `applyLookupRollup` materialization (slow-path) inside this endpoint.
- **Heaviest + most coupled** (imports the link/lookup traversal subsystem; forces slow-path; nearest to integration concerns). Keep the 422 until a real view needs it — a clear deferred error is a correct, shippable terminal state, not a bug.
- Most important to keep **out of** #4-3b-2b: a computed reference forces the slow path anyway, so it can never share the SQL fast-path.

**Dependency summary:** 2a is standalone. 2b depends on 2a (shared GROUP BY shape) + evidence. 2c is independent of both + demand. None blocks K3.

---

## 5. Out of scope for this doc (resist scope creep)
- jsonb `GROUP BY` mechanics, NULL-key SQL semantics, raised 413 cap → #4-3b-2b's own design.
- Value-based group ordering (sort groups by subtotal), multi-level grouping, collapsible-group server state → not planned; revisit only on demand.
- Any rbac / integration-core / contract / attendance change → forbidden under K3 lock.

## 6. Resolved decisions (reviewer, 2026-05-26)
1. **NULL/empty group key** — ✅ `key: null`, frontend renders the existing "(empty)" label. **Treated as a response contract** (§3.1), not impl-local.
2. **Group-by denied field** — ✅ hard-fail **`422 AGGREGATE_GROUP_FIELD_DENIED`** (§3.2). Silent grand-total fallback rejected: it would hide a security refusal.
3. **Error codes** — ✅ distinct codes per slot. Scope reduced to **filter + group only** (`AGGREGATE_COMPUTED_FILTER_UNSUPPORTED` / `AGGREGATE_COMPUTED_GROUP_UNSUPPORTED`). **Computed-sort dropped** from #4-3b-2a and from the `viewTouchesComputed` predicate (§2) — the aggregate endpoint never orders rows. Distinct codes that ship MUST land with matching frontend labels + tests.
