# Multitable Typed Query Polish — Design-Lock — 2026-06-03

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** Owner decisions locked 2026-06-03 (see §9 + §5.1). Implementation = Slice 1 only, pending its own opt-in.
> Author: Claude (Opus 4.8, 1M context) + read-only code recon on `origin/main` @ `690686e71`.
> Worktree: `docs/multitable-typed-query-polish-design-20260603` off `origin/main`.
> Supersedes the original ask ("design-lock the 6 new field types"): batch-1 field types
> (`currency/percent/rating/url/email/phone`) are **already shipped + verified** on `main`
> (`docs/development/multitable-mf2-field-types-batch1-{development,verification}-20260426.md`).
> This doc instead locks the **typed query** gaps those types exposed.

---

## 0. TL;DR (read this first — it corrects the original framing)

The naive framing was "add numeric sort + range filters from scratch." That is **not** the
real state. On `main`:

- **The operators already exist.** The record grid's filter/sort run **in-memory** in the
  `/api/multitable/view` (and `/view-aggregate`) handlers, via two type-aware helpers:
  `evaluateMetaFilterCondition` (filter) and `compareMetaSortValue` (sort). Both already do
  **correct numeric** comparison + the full range operator set (`is/isNot/greater/greaterEqual/less/lessEqual`)
  — **for `number`, `date`, and `rollup`.**
- **The real bug is a type-classification miss.** `currency`, `percent`, `rating` are routed
  through the **string** branch of those two helpers (and the frontend operator map), not the
  numeric branch. So they sort lexicographically and their range filters are never offered.
- **`url`/`email`/`phone` are already correct** — they belong in the string branch and reuse
  `is/isNot/contains/doesNotContain`. **No change needed** for them (this is the answer to
  scope item #3).

So the deliverable is a **centralized reclassification** (one shared predicate + three call
sites), not a new query engine. That is why it is low-risk.

**Per-type × per-behavior reality (current `main`):**

| Field type | Sort | Equality filter | Range filter (`> ≥ < ≤`) | Operators offered in UI |
|---|---|---|---|---|
| `number` | ✅ numeric | ✅ numeric | ✅ numeric | ✅ numeric |
| `rollup` | ✅ (→`number`) | ✅ | ✅ | n/a (computed) |
| `date` | ✅ epoch | ✅ epoch | ✅ epoch | ✅ date |
| `rating` | ✅ (integer; `numeric:true` collation OK) | ✅ (coincidental — both stringify to int) | ❌ **string branch → no-op** | ❌ **string ops (`contains`…)** |
| `currency` | ❌ **decimal/negative mis-sort** | ⚠️ string-equality (`100` ≠ `100.00`) | ❌ **no-op** | ❌ **string ops** |
| `percent` | ❌ **decimal/negative mis-sort** | ⚠️ string-equality | ❌ **no-op** | ❌ **string ops** |
| `string` | text | ✅ string | n/a | ✅ string |
| `url`/`email`/`phone` | text (fine) | ✅ string | n/a (correct) | ✅ string (correct) |

The **user-visible** symptom is the last column: for currency/percent/rating the UI offers
`contains`/`doesNotContain` and never `>`/`<`, while still rendering a numeric input box
(`inputTypeForField` already treats them as numeric). The backend "range op silently returns
`true`" path is a **latent API-level** issue (the UI never sends those ops today), not what a
user hits — but the fix closes both.

The decimal mis-sort is real ICU behavior: `String(1.5).localeCompare(String(1.25), undefined, { numeric: true })`
compares the fractional digit runs `5` vs `25` and returns `1.5 < 1.25` (wrong). Integers
(`rating`) are unaffected, which is why **rating's sort is fine and only its range filter is broken.**

---

## 1. Current-state ground truth (with citations, `main` @ `690686e71`)

### 1.1 Two distinct query execution paths — they do NOT share an engine

| Path | Endpoint | Used by | Filter | Sort | Execution |
|---|---|---|---|---|---|
| **Grid path** | `GET /api/multitable/view` (`univer-meta.ts:6283`) and `GET /sheets/:id/view-aggregate` (`:6057`) | the production grid (`useMultitableGrid.loadViewData` → `client.loadView`) | reads the view's persisted `filter_info` jsonb | reads `sort_info` jsonb | **in-memory JS** whenever any filter/sort is present (`hasInMemoryProcessing`, `:6383`); search-only requests take a SQL fast path (`:6387`) |
| **Cursor path** | `GET /api/multitable/records` (`univer-meta.ts:7511`) → `query-service.ts queryRecordsWithCursor` | external API-token reads + internal XLSX export pump | `filter.<fieldId>=<string>` query params → **SQL equality only** (`query-service.ts:333`) | `sortField`/`sortDir` → **SQL `data ->> field` text sort** (`:340,:360`) | **SQL** |

The grid never calls the cursor path for filtered/sorted data. The frontend persists
`filterInfo`/`sortInfo` to the view via `PATCH /views/:id` (`useMultitableGrid.ts:504`,
`client.ts:1028`), then reloads the view by id; the `/view` handler applies them server-side
in memory.

### 1.2 The three misclassification sites

1. **Backend filter** — `evaluateMetaFilterCondition` (`univer-meta.ts:1914`). Numeric branch
   guard at `:1927` is `effectiveType === 'number' || effectiveType === 'date'`. Currency/percent/rating
   fall to the string branch (`:1949`), where unknown ops (`greater`, …) hit the `return true`
   default (`:1958`) → **silent no-op range filter**, and equality is `leftNorm === rightNorm`
   on lowercased trimmed strings (`:1954`).
   Shared by `/view` (`:6491`) and `/view-aggregate` (`:6135`).

2. **Backend sort** — `compareMetaSortValue` (`univer-meta.ts:1460`). Numeric branch guard at
   `:1469` is `effectiveType === 'number' || effectiveType === 'date'`. Else falls through to
   `String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })`
   (`:1498`). Called from `/view` (`:6503`).

3. **Frontend operator map** — `FILTER_OPERATORS_BY_TYPE` (`useMultitableGrid.ts:90+`). Has a
   `number` entry with `greater/greaterEqual/less/lessEqual` (`:34-40`) but **no** `currency`/
   `percent`/`rating` entries. The resolver falls back to `FILTER_OPERATORS_BY_TYPE.string`
   (`MetaViewManager.vue:1019`). Note the inconsistency: `inputTypeForField` (`MetaViewManager.vue:1022`)
   **already** returns `'number'` for currency/percent/rating — numeric input box, text operators.

### 1.3 Supporting facts that constrain the design

- `toComparableNumber` (`univer-meta.ts:1542`) already parses string-stored numbers and returns
  `null` for non-numeric/empty → the numeric branch is **robust to legacy / mixed-type storage**.
  Garbage rows sort/filter as null (sink to `NULLS LAST` posture), they don't throw.
- The field-read gate (#2038(a), `allowedFieldIds`, `univer-meta.ts:6334-6356`) decides **which
  fields may be filtered/sorted at all**, *upstream* of the comparator. The reclassification is
  strictly downstream → the gate is untouched.
- `redactViewConfigFilterLiterals` / `mergeRedactedFilterInfoForUpdate` (`:2295`, `:2317`) redact
  filter literals for denied fields and key off `(fieldId, operator)` shape. Slice 1 adds **no new
  value shape** → redaction is unaffected. (Only `between`'s array value would touch this — see §3.6.)
- The in-memory helpers are **not currently exported**, so there are no direct unit tests; coverage
  today is via real-DB-gated route tests (`tests/integration/multitable-readpath-search-filter-field-mask.test.ts`,
  `…/multitable-viewconfig-filter-literal-redaction.test.ts`). The SQL path has a mock-query unit
  test (`tests/unit/multitable-query-service.test.ts`) asserting `data ->> $ = $` + text `ORDER BY`.
- XLSX export writes **raw stored values** (`serializeXlsxCell`, `xlsx-service.ts:229`); there is
  **no display/format mode** today. Import coerces via `createRecord` → `coerceBatch1Value`
  (already correct). No xlsx change is required or proposed here.

---

## 2. Scope & non-goals

**In scope**
- Reclassify `currency`/`percent`/`rating` as numeric in the in-memory filter evaluator, the
  in-memory sort comparator, and the frontend operator map.
- Confirm + document `url`/`email`/`phone` reuse of the string operator family (no code change).
- Optional `between` operator (separately gated slice; see §3.6).
- A named decision on the SQL cursor path divergence (deferred; see §3.7).

**Explicit non-goals / untouched (hard constraints)**
- ❌ The field-read gate / `allowedFieldIds` brand (#2038(a)). Reclassification is downstream of it.
- ❌ Slice-2 grouped grid.
- ❌ Central RBAC / auth / `plugin-integration-core`.
- ❌ New field types (batch-1 is shipped; this is query behavior only).
- ❌ XLSX display-formatting on export — raw round-trip stays the default (see §3.8).
- ❌ Any DB migration — `filter_info`/`sort_info`/value storage are unchanged.

---

## 3. Design-lock

### 3.1 Shared numeric-type predicate (anti-drift keystone)

Introduce a single exported predicate (backend, in `univer-meta.ts` near the helpers, or a small
`multitable/query-field-types.ts` if cleaner):

```ts
// Numeric query semantics: sortable/comparable as JS numbers via toComparableNumber.
// NOTE: `date` is intentionally NOT here — it has its own epoch branch (toEpoch).
// `rollup` is pre-normalized to `number` by callers (effectiveType), so it need not appear.
export function isNumericQueryFieldType(type: string): boolean {
  return type === 'number' || type === 'currency' || type === 'percent' || type === 'rating'
}
```

Both helpers call this so they **cannot drift**. The defect today is precisely that the two
branch guards were hand-duplicated and only listed `number`.

### 3.2 Backend filter — `evaluateMetaFilterCondition`

Change the numeric-branch guard (`:1927`) from
`effectiveType === 'number' || effectiveType === 'date'`
to `isNumericQueryFieldType(effectiveType) || effectiveType === 'date'`, preserving the existing
`toComparable = effectiveType === 'date' ? toEpoch : toComparableNumber` selection. No operator
logic changes — `greater/greaterEqual/less/lessEqual/is/isNot` already exist in that branch.

Effect: currency/percent/rating range + equality filters become numeric and correct.
`url/email/phone` are untouched (not numeric → string branch, correct).

### 3.3 Backend sort — `compareMetaSortValue`

Same guard change at `:1469`. Effect: currency/percent decimal/negative sort becomes correct;
rating already sorted fine but now routes through the same numeric path (consistent, still correct).

### 3.4 Frontend — `FILTER_OPERATORS_BY_TYPE`

Additive only: give `currency`, `percent`, `rating` the **same operator list as `number`**
(`is/isNot/greater/greaterEqual/less/lessEqual/isEmpty/isNotEmpty`). Simplest implementation is to
map them to the existing `number` array (shared reference) so they can't drift from it. This makes
the UI offer `>/≥/</≤` and aligns the operator menu with the already-numeric input box.

Leave `url/email/phone` falling back to `string` — **intended**, not a gap.

### 3.5 String-like reuse (scope item #3 — explicit answer)

`url/email/phone` are stored as trimmed strings (codec validates format on write) and already
reuse the string operator family (`is/isNot/contains/doesNotContain/isEmpty/isNotEmpty`). This is
the correct boundary: a URL/email/phone is text for query purposes. **Decision: no change.**
`startsWith`/`endsWith` are deliberately *not* added (the frontend has no such operators for any
type; introducing them would be a generic text-operator expansion, out of this slice's scope).

### 3.6 `between` operator (OPTIONAL — separate slice, declinable)

Once §3.2 lands, `between [a,b]` is pure sugar for `greaterEqual a AND lessEqual b` — which the
filter builder can **already express today** with two conditions and `and` conjunction. It adds
convenience, not capability.

It is also the **only** change that introduces an **array value shape** (`value: [min, max]`),
which forces two extra concerns:
- `normalizeFilterScalar` (`:1505`) returns `value[0]` for arrays → `between` must be handled
  **before** that scalarization, or bounds are lost.
- `redactViewConfigFilterLiterals` must redact **both** bounds for denied fields.

**Recommendation: defer / decline unless the owner wants the one-click range UX.** If taken, it
is its own PR (Slice 2) with explicit redaction + scalarization tests.

### 3.7 SQL cursor path (`/records` → `query-service.ts`) — NAMED divergence

After Slice 1, the two read paths **diverge by design**:
- Grid (`/view`): numeric sort + range filters for currency/percent/rating ✅
- External API-token reads (`/records`): still **text sort + equality-only** ❌

This is an **accepted, documented limitation**, not an oversight. Closing it (Slice 3) is heavier
because it is SQL, not JS:
- Numeric sort needs a **guarded cast**, never a bare `(data->>field)::numeric` (throws on any
  non-numeric/empty/legacy row). Use a `jsonb_typeof`-guarded `CASE` or a regex-guarded cast.
- The cursor is **keyset** (`(sortExpr, id) > (sortValue, id)`, `:349`) with the cursor's
  `sortValue` encoded as a **string** (`:380`). Numeric `ORDER BY` and the keyset comparison and
  the encoded cursor value must change **together**, or pagination silently skips/duplicates rows.
- Adding range operators changes the **wire contract**: today `filter.<id>=<string>` (equality).
  Any operator syntax must (a) keep a bare scalar meaning `equals` (backward-compat) and (b) be
  reflected in `packages/openapi/src/paths/multitable.yml` + the parity assertions in
  `scripts/ops/multitable-openapi-parity.test.mjs` or `verify:multitable-openapi:parity` blocks.
  (The `/records` GET is currently **undocumented** in the spec — Slice 3 would be the moment to
  add it, not before.)

**Recommendation: Slice 3, deferred, gated on a concrete external-API need.** Slice 1 delivers the
entire user-visible grid win without it.

### 3.8 XLSX export — raw round-trip locked as default

No change in any slice here. Export stays raw (`serializeXlsxCell`). If display-formatted export
is ever wanted, it must be an **explicit opt-in mode** (e.g. `?format=display`) that produces a
**separate** output and never overwrites the raw default. Documented as a future hook, not built.

### 3.9 Storage / property / value — unchanged

No migration. `filter_info`/`sort_info` jsonb schema unchanged. Field `property` unchanged. Cell
values unchanged. Slice 1 is a pure interpretation change.

---

## 4. Why Slice 1 is safe (the strongest selling point)

Pure reclassification introduces **no new value shapes and no new SQL**, therefore:
- **Redaction untouched** — `(fieldId, operator)`-keyed literal redaction sees the same shapes.
- **Field-read gate untouched** — fix is strictly downstream of `allowedFieldIds`.
- **Legacy/mixed-storage safe** — `toComparableNumber` already returns `null` for non-numeric;
  no `::numeric` cast, no throw path (this is JS, not SQL).
- **No contract / OpenAPI churn** — `filterInfo`/`sortInfo` jsonb is internal; the parity gate is
  not touched (it only guards the documented REST surface, which this does not change).
- **Centralized** — one predicate, three call sites; trivially revertable.

---

## 5. PR slicing recommendation

Ordering rationale: ship the entire user-visible win first with the lowest-risk change; treat
convenience and the external-API path as independent, gated opt-ins.

| Slice | Title | Scope | Files | Risk | Gate |
|---|---|---|---|---|---|
| **Slice 1** (recommended first, self-contained) | Numeric reclassification of currency/percent/rating | §3.1–3.5 | `univer-meta.ts` (predicate + 2 guards; export helpers for test), `useMultitableGrid.ts` (operator map), 1 backend test file | **Low** | none beyond review |
| **Slice 2** (**DEFERRED** — owner 2026-06-03) | `between` operator | §3.6 | `univer-meta.ts` (numeric branch + pre-scalarization), `useMultitableGrid.ts` + filter UI (2-input), redaction test | Medium (array value shape) | owner opt-in (declined this round) |
| **Slice 3** (**DEFERRED** — owner 2026-06-03) | SQL cursor-path typed operators + numeric sort | §3.7 | `query-service.ts`, `univer-meta.ts /records`, `packages/openapi/*`, parity test | High (contract + keyset coupling + guarded cast) | concrete external-API need |

Slice 1 alone closes the reported behavior. Slices 2/3 are **separate explicit opt-ins** per the
staged-opt-in lineage discipline — do not auto-start them. Owner has deferred both (§9).

### 5.1 Implementation boundary (locked 2026-06-03)

The Slice 1 implementation PR is bounded to **exactly**:
- Add one shared central predicate (`isNumericQueryFieldType` or equivalent), and use it at the
  **3 call sites**: `evaluateMetaFilterCondition`, `compareMetaSortValue`, frontend
  `FILTER_OPERATORS_BY_TYPE`. Export the two backend helpers for tests.

It must **NOT touch** (hard boundary):
- ❌ `query-service.ts` (the SQL cursor path) — divergence accepted (§3.7).
- ❌ OpenAPI spec / `verify:multitable-openapi:parity`.
- ❌ The field-read gate / `allowedFieldIds` brand (#2038(a)).
- ❌ Filter-literal redaction (`redactViewConfigFilterLiterals` / `mergeRedactedFilterInfoForUpdate`).
- ❌ XLSX export (`xlsx-service.ts`) — raw round-trip unchanged.
- ❌ `between` / any new value shape / any array-valued filter.
- ❌ DB migrations / `filter_info`/`sort_info` jsonb schema / field `property` / cell values.

---

## 6. TODO checklist (gated)

Markers: ✅ done · ⬜ todo (this slice) · 🔒 gated (separate opt-in, do not start)

### Slice 1 — Numeric reclassification
- ⬜ Add `isNumericQueryFieldType(type)` shared predicate; export it (testability).
- ⬜ `evaluateMetaFilterCondition`: numeric-branch guard uses the predicate (`+ date`).
- ⬜ `compareMetaSortValue`: numeric-branch guard uses the predicate (`+ date`).
- ⬜ Export `evaluateMetaFilterCondition` + `compareMetaSortValue` for direct unit tests.
- ⬜ Frontend `FILTER_OPERATORS_BY_TYPE`: currency/percent/rating reuse the `number` operator list.
- ⬜ Unit test matrix (per-type × per-op) on the two exported helpers.
- ⬜ One real-`/view` integration assertion (wire-vs-fixture-drift guard) — field type reaches comparator.
- ⬜ Page-boundary ordering test (numeric sort correct across pagination, not within-page only).
- ⬜ Regression: existing equality/string/number/date filter+sort still green.
- ⬜ Confirm `url/email/phone` unchanged (still string ops) — assert in matrix.

### Slice 2 — `between` (🔒 gated)
- 🔒 Numeric-branch `between` with inclusive `[min,max]`, handled before `normalizeFilterScalar`.
- 🔒 Frontend operator + 2-input UI.
- 🔒 Redaction test: both bounds redacted for denied fields.

### Slice 3 — SQL cursor path (🔒 gated, deferred)
- 🔒 Guarded `::numeric` cast (jsonb_typeof / regex), never bare cast.
- 🔒 Numeric keyset cursor: `ORDER BY` + comparison + encoded `sortValue` change together.
- 🔒 Operator wire syntax, backward-compatible (bare scalar = equals).
- 🔒 OpenAPI `multitable.yml` + parity-gate assertions for `/records`.

---

## 7. Verification matrix (to run at implementation time)

**Two bars, both required** (per the wire-vs-fixture-drift rule — a passing helper unit test can
coexist with a wire that misclassifies the field type):

**Bar A — exported-helper unit tests (fast, no DB).** For each field type × operator/behavior:

| Field type | Sort asc (decimals + negatives) | `is` | `isNot` | `greater`/`greaterEqual` | `less`/`lessEqual` | `contains` | `isEmpty`/`isNotEmpty` |
|---|---|---|---|---|---|---|---|
| `number` | numeric (regression) | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| `currency` | **`-5 < 1.25 < 1.5 < 10`** (was broken) | numeric eq (`100`≡`100.00`) | numeric | **now true range** | **now true range** | n/a | ✅ |
| `percent` | same as currency | numeric eq | numeric | **range** | **range** | n/a | ✅ |
| `rating` | integer order (already ok) | numeric eq | numeric | **now offered + works** | **range** | n/a | ✅ |
| `string` | text (regression) | ✅ | ✅ | n/a | n/a | ✅ | ✅ |
| `url`/`email`/`phone` | text (regression) | ✅ | ✅ | n/a | n/a | ✅ (unchanged) | ✅ |
| `date` | epoch (regression) | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| `boolean` | bool (regression) | ✅ | ✅ | n/a | n/a | n/a | ✅ |

Key positive assertions: `currency` sort of `[1.5, 1.25, -5, 10]` → `[-5, 1.25, 1.5, 10]` asc
(the exact case `localeCompare(numeric:true)` gets wrong today); `currency` `greater: 100` filters
out `99.99`, keeps `100.01`; `rating` `greaterEqual: 3` keeps `3,4,5` drops `2`.

**Bar B — real `/view` wire integration** (DB-gated, `describeIfDatabase`): seed a sheet with a
`currency` field, persist a `sortInfo` on it + a `greater` filter condition, `GET /api/multitable/view`,
assert returned row order is numeric and the range filter applied. This proves the field's `type`
actually reaches the comparator through the real handler (field-read gate, `parseMetaFilterInfo`,
`fieldTypeById` lookup). Also assert one `view-aggregate` filtered count matches.

**Cross-cutting checks:**
- ⬜ Page-boundary: numeric sort correct across an offset boundary (not "sorted within page only").
  Log + note any in-memory row cap as a pre-existing property shared with `number` — out of scope to fix.
- ⬜ Field-read gate untouched: a `field_permissions`-denied currency field stays non-filterable/
  non-sortable (existing `multitable-readpath-search-filter-field-mask.test.ts` posture still green).
- ⬜ Redaction untouched: `multitable-viewconfig-filter-literal-redaction.test.ts` still green
  (no new value shape in Slice 1).
- ⬜ `tsc --noEmit` + `vue-tsc -b` green; existing `multitable-query-service.test.ts` (SQL path)
  unchanged + green (Slice 1 does not touch it).

---

## 8. Rollback

Slice 1 is a guard-condition + map change across `univer-meta.ts` and `useMultitableGrid.ts`.
Revert the commit; no data, schema, or contract is affected (the only persisted artifacts —
`filter_info`/`sort_info` jsonb — were already valid before and after). A view authored with a
currency `greater` filter while Slice 1 was live degrades gracefully on rollback: the operator is
preserved in jsonb but the backend reverts to no-op (string branch), exactly the pre-Slice-1 state.

---

## 9. Decisions (locked 2026-06-03)

1. **`between` (Slice 2) — DEFERRED.** `greaterEqual + lessEqual` already expresses the same range;
   `between` introduces the only array value shape (normalize/redaction/save-compat cost) and the
   benefit is insufficient. Revisit only on explicit owner opt-in.
2. **SQL cursor path (Slice 3) — DIVERGENCE ACCEPTED + documented.** This round targets the grid's
   persisted-view filter/sort only. The `/records` cursor API is a separate external path; the
   `::numeric` cast, keyset-cursor coupling, and OpenAPI parity are **deliberately not pulled in**.
   The two read paths diverge in behavior after Slice 1 (§3.7); Slice 3 closes it when a concrete
   external-API need arises.
3. **Verification — exported helpers + unit matrix + one real `/view` wire assertion (+ a small
   `/view-aggregate` parity assertion).** Wire-only is too slow and too coarse; pure-unit can't prove
   the real view flow. So: (a) unit matrix over currency/percent/rating across the filter evaluator,
   the sort comparator, and the operator map; (b) one real `/view` assertion that persisted
   `filter_info`/`sort_info` reach the correct result; (c) since `/view-aggregate` shares
   `evaluateMetaFilterCondition` (confirmed, `univer-meta.ts:6135`), add one small aggregate parity
   assertion — **do not expand beyond this**.
