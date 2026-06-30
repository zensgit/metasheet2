# K3 WISE WebAPI BOM read — GATE-front contract & design-lock — 2026-06-30

## Status

**GATE-front design only. No runtime implemented in this PR. No BOM call is made.**

Owner-authorized 2026-06-30 as the **GATE-front for C4 BOM read** (issue #1709) —
explicitly **not** BOM runtime. This PR is docs-only and exists to:

1. lock the customer-confirmable contract before any runtime, and
2. front-load the **one-time redacted BOM request/response shape** intake so that the
   post-GATE slice is mechanical (no blind probing).

Scope fence for this PR (all enforced by it being docs-only):

- no runtime; no preset; no route; no adapter change — the adapter BOM **read** surface
  stays fail-closed / unsupported.
- no BOM call; no resolver; no Save / Submit / Audit; no production write.
- values-free throughout (counts / flags / types / structural key-paths only).

The runtime slice is **frozen** until both (a) the operator returns the redacted shape
(O1–O8 below) and (b) the owner gives an explicit C4 BOM **runtime** opt-in. This
document does not authorize that step.

## Why now

C3 K3 WebAPI-LIST material read (no-key + keyed) is closed and entity-verified
(#3390 `e1766a629` + operator no-key & keyed reruns PASS). The next named capability on
the data-source line is **C4 BOM read**: pull a parent material's bill-of-materials
(sub-items) from K3 so BOM structure can land in the cleansing multitable as a source.

This is deliberately front-loaded as a contract because the single biggest accelerant we
learned on C3 LIST was: **get the operator's redacted live shape first.** C3 LIST spent
six instrumentation slices (#3341→#3386) blind-probing for a row container that the
operator revealed in one comment (`Data.Data`, PascalCase). BOM has *more* structural
unknowns (nesting, versions), so we do not blind-probe it — we ask once, then build once.

## Current adapter state (verified, unchanged by this PR)

`plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`

| Surface | Current | Note |
| --- | --- | --- |
| material **list read** | implemented, preset-owned (`k3wise.material-list.v1`) | shipped #3390; `Data.Data` PascalCase extractor + fixed-probe + read-smoke sanitizer, write-gated, values-free |
| material `Material/GetDetail` single read | implemented (dormant / operator write-gated) | #1868 + #3241 |
| `bom` object | **write-only** (`operations: ['upsert']`, `savePath: /K3API/BOM/Save`) | no read surface |
| **bom read** | **unsupported / fail-closed** | this contract governs it; stays unsupported until post-GATE opt-in |

Reusable substrate (no new transport needed): the preset-owned read-smoke pattern from
C3 LIST — request builder, response-side container extractor with a **fixed** path
allowlist, `responseShapeProbe` / `listShapeProbe` with a **frozen** sanitizer allowlist,
and the values-free evidence contract. BOM read is a *new preset over the same machinery*,
not new probing.

## Proposed contract (to implement post-GATE — NOT in this PR)

A new preset `k3wise.material-bom.v1`, mirroring `k3wise.material-list.v1`:

- **Preset-owned request.** The preset owns the BOM read body. No request-supplied raw
  filter. The only caller-supplied datum is the **parent material key**; its encoding is
  **contingent on O2 and must not be pre-assumed to match C3 LIST**: if the live shape
  carries the key inside a **filter-expression string** (as keyed C3 LIST does —
  `FNumber like '%<escaped>%'`), it is escaped via `k3_freeform`; if the key is a **plain
  structured JSON body field** (e.g. `{ FParentItemNumber: <value> }`), it is a bound JSON
  value — safe by serialization, with **no** expression-level escaping and **no**
  `k3_freeform` (escaping a value that is not in an expression would corrupt it). Either
  way the value is preset-owned, caller-supplies-the-value-only (never raw filter syntax),
  and is not echoed in evidence.
- **Response extractor, PascalCase-aware from the start.** Per the `Data.Data` lesson, the
  sub-item container candidate list includes case variants (`Data.Data` / `Data.DATA` /
  `Data.data` / vendor-confirmed path from O3) on day one — no blind-probe chain.
- **Fixed-probe + sanitizer allowlist.** A BOM `responseShapeProbe` surfaces only
  allowlisted container keys + `{type, arrayLength}`; never row values or arbitrary keys —
  identical discipline to read-smoke today.
- **Write-gated, values-free read-smoke.** Operator-run rerun reports counts / flags /
  types only. No row values, no material number/name, no key echo.

```text
intent: { object: "material-bom", mode: "bom", key: "<parent material key; escaped; not echoed>" }
evidence (values-free): recordPresent, recordCount, <container>.type/arrayLength,
                        bomLevelPresent(bool), childKeyPresent(bool), qtyKeyPresent(bool),
                        paging echo, errorCode/errorType, sampleKeyEchoed=false
```

## BOM-specific unknowns — Open questions (blockers for runtime)

BOM is structurally richer than a flat material list. These must be answered by the
redacted shape before any runtime:

| ID | Question | Why it blocks |
| --- | --- | --- |
| O1 | Exact BOM **read** endpoint path + HTTP method (is it a list query, a per-parent detail, or a bill-query?) | adapter cannot issue the request |
| O2 | **Request**: which field carries the parent material key (`FParentItemNumber`? `FMaterialID`? `FBOMID`?); **whether the key is a structured JSON field or embedded in a filter-expression string** (decides encoding — bound value vs `k3_freeform` escape); any required flags (org id, version, effective date) | request body + safe encoding cannot be built |
| O3 | **Response container**: where the sub-item rows array lives — path **and case** (mind `Data.Data` PascalCase); count/paging keys | extractor cannot locate rows |
| O4 | **Row shape**: per-sub-item field **keys only** (child number/id, qty, unit, BOM level, scrap, position, effective dates) | map to staging without inventing fields |
| O5 | **Nesting**: flat (parent + immediate children) vs recursive tree (children carry children) vs requires re-query per child | decides single-call vs fan-out (see Recursion boundary) |
| O6 | **Versions / multiplicity**: multiple BOM versions per parent? how selected (default / active / by-date)? | avoid ambiguous or multi-version row bleed |
| O7 | **Paging**: parameter names + total-count key + server page cap (if list) | page / know when to stop |
| O8 | **Error envelope**: codes/types for no-BOM / invalid-parent / version-ambiguous | distinct read error taxonomy, no body echo |

## Operator intake manifest (the one-time redacted shape ask)

Requested from the operator/customer **once**, values-free. Same redaction standard as the
C3 LIST shape that unblocked #3390: **structure keys + types + array-lengths only.** Strip
all values, rows, messages, material numbers/names/ids, credentials, tokens, authority
codes, connection strings, host/system/tenant ids, and raw payloads.

Please provide, from a live working K3 BOM read (or the K3 WebAPI BOM doc):

1. **Endpoint** — the BOM read path + method (O1).
2. **Request skeleton** — body keys with the **parent-key field marked**, **whether the
   parent key is a structured JSON field or part of a filter-expression string**, plus any
   required flags; value(s) redacted (O2).
3. **Response skeleton** — top-level keys + types; the **sub-item container path + case +
   type + arrayLength**; per-row field **keys + types** (no values); count/paging keys
   (O3, O4, O7).
4. **Nesting indicator** — is a child row's children inline (nested array), flat with a
   level column, or absent (must re-query)? (O5)
5. **Versioning** — is there a version/effective-date selector, and what's the default? (O6)
6. **Error envelope** — keys/codes for no-BOM / invalid-parent / version-ambiguous (O8).

A redacted response **skeleton** (keys + types, e.g. `Data.Data: array length=N`,
`Data.Data[].FChildItemNumber: string`) is ideal — it is exactly what localized the row
container for C3 LIST in one round-trip.

## Error taxonomy (front-loaded; post-GATE)

A distinct, non-write prefix so a failed BOM pull is never misreported as a Save failure:

| Condition | Code |
| --- | --- |
| BOM read endpoint not configured | `K3_WISE_BOM_READ_NOT_CONFIGURED` |
| parent key missing / invalid | `K3_WISE_BOM_READ_PARENT_KEY_INVALID` |
| transport / HTTP error | `K3_WISE_BOM_READ_FAILED` |
| sub-item container not located | `K3_WISE_BOM_READ_CONTAINER_UNLOCATED` |
| multiple BOM versions, no selector | `K3_WISE_BOM_READ_VERSION_AMBIGUOUS` |
| K3 business error in response | `K3_WISE_BOM_READ_BUSINESS_ERROR` |

`K3_WISE_BOM_READ_*` must never fall through to the Save / Submit / Audit path.

## Recursion boundary

If O5 says BOM is **recursive** (multi-level explosion), the recursive fan-out is a
**separate, separately-gated sub-slice** — the first C4 BOM read slice is **single-level**
(one parent → its immediate children, one call). We do not bundle tree explosion into the
first read; recursion has its own request-amplification and values-free-at-scale concerns
and earns its own opt-in.

## Explicit non-goals / boundary

- No runtime, no preset, no route, no adapter change in this PR. BOM read stays fail-closed.
- No BOM call; no resolver / server-side composition; no Save / Submit / Audit; no write.
- No recursion in the first read slice (separate gate).
- No values: no material number/name/id, no row values, no quantities, no messages.
- No credential / token / authority code / connection string / host / system / tenant id in
  code, logs, fixtures, or docs. Token stays `<redacted>` exactly as the write path does.

## Post-GATE implementation plan (mechanical once O1–O8 answered + runtime opt-in)

Mirrors #3390 (the C3 LIST slice that PASSed):

1. Add preset `k3wise.material-bom.v1` owning the BOM read body (parent-key param +
   confirmed flags) — no request-supplied raw filter; parent-key encoding **per O2**
   (bound structured field with no escape, vs `k3_freeform`-escaped filter expression).
2. Response extractor with the confirmed sub-item container path, **case-variant-aware**
   from the start; fold into a `dataDataPresent`-style presence flag.
3. BOM `responseShapeProbe` + frozen sanitizer allowlist (container keys + `{type,
   arrayLength}` only); wire test asserts the route preserves it and scrubs leak-bait.
4. Values-free read-smoke fixture (single-level parent → children, counts/keys only).
5. Operator-run write-gated rerun for PASS (values-free), same shape as C3 LIST.

No step requires a migration, a write-path change, or recursion.

## Acceptance matrix (post-GATE)

| ID | Assertion |
| --- | --- |
| A1 | BOM read endpoint reachable, HTTP 200, distinct `K3_WISE_BOM_READ_*` on failure |
| A2 | parent-key request accepted (escaped, not echoed) |
| A3 | sub-item container located, values-free (path + case + `{type, arrayLength}`) |
| A4 | row count present; per-row keys map to confirmed field set (no invented fields) |
| A5 | paging echo consistent (if list) |
| A6 | extractor localizes the container; presence flag true |
| A7 | evidence values-free only; `sampleKeyEchoed=false` |
| A8 | boundary: no write / resolver / Save / Submit / Audit; recursion not exercised |
| A9 | single-level only; recursive explosion absent unless separately gated |
