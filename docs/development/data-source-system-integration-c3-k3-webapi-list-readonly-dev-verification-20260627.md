# K3 WebAPI read/list — C3 LIST-only — development & verification (2026-06-27)

> Status: **implemented + offline-verified; live entity-machine smoke = operator's gated next step.** This slice
> opens a bounded, read-only Material LIST path. It does NOT open BOM, resolver/composition, Save/Submit/Audit,
> production write, broad/unbounded scans, or cursor pagination. No real K3 was called here (no credentials); the
> fixtures are synthetic. The values-free live entity-machine smoke is the operator's gated step, as with every
> prior slice (e.g. #3241 detail retest).

## Authorization

#1709 owner/customer GATE (2026-06-27): `customerAdminAccepted=true`, `authorizedSlice=C3 LIST only`, read-only;
BOM / resolver / Save / Submit / Audit / production write remain locked. The owner published the values-free wire
contract (below), explicitly replacing the previously **inferred** shape (closed draft PR #3324).

## Approved wire contract (O1–O6, values-free, from #1709)

```text
O1  POST /K3API/Material/GetList
O2  body.Data.{Top,PageSize,PageIndex}; PageIndex starts at 1; PageSize<=10; Top<=10; no cursor token
O3  body.Data.{Filter,OrderBy,Fields}; v1 filter = FNumber only, internally composed; no raw caller filter
O4  response.Data.DATA rows → FNumber/FName/FModel/FUnitID
O6  success = StatusCode 200 + success Message + parseable Data.DATA; else read-only error evidence
```

## What was built (one coherent diff, fresh from origin/main)

- **Contract** (`lib/read-smoke.cjs`): new built-in preset `k3wise.material-list.v1` (PRESET-OWNED endpoint/method/
  pagination/fields; `allowedModes:['list']`; key-OPTIONAL). `normalizeReadSmokeContract` now allows a key-optional
  list intent (absent key → first page/no filter); `buildReadSmokeRequest` dispatches on the normalized
  `contract.object/mode` (the #3247 C3 acceptance lock — now demanded) and never reuses the GetDetail shape;
  `readSmokeSuccessEvidence` adds values-free `recordCount` + list `pageBounded` flag.
- **Adapter** (`lib/adapters/k3-wise-webapi-adapter.cjs`): the single-record `K3_WISE_READ_LIST_UNSUPPORTED`
  deny-guard is **preserved**; a separate `assertMaterialListReadOnlyScope` + bounded `Material/GetList` execution
  is added in front, opened ONLY when the preset-owned `objectConfig.readMode === 'list'`. Pagination is hard-capped
  at 10 (PageIndex=1, no cursor) regardless of config; the FNumber filter is internally composed exact-match,
  pattern-validated against injection; rows are projected to the allowlisted fields only.
- **Route** (`lib/http-routes.cjs`): passes the whole normalized `contract` to the builder (#3247 lock); write-gated
  (`requireAccess('write')`), backend credential context, values-free evidence — unchanged wiring, now list-aware.

## Verification (offline, 2026-06-27, clean origin/main worktree + pnpm install)

Full `plugin-integration-core` CJS suite: **55/55 files pass, 0 failures.** Focused C3 coverage:

- `read-smoke.test.cjs` — list preset/catalog, list builder (keyed → FNumber filter; no-key → first page), list
  evidence values-free (no FNumber/FName/FModel/FUnitID).
- `read-smoke-contract.test.cjs` — list intent normalizes (key-optional); fail-closed: detail mode / BOM object /
  raw pagination/filter/path in intent all rejected.
- `k3-wise-adapters.test.cjs` — bounded GetList success (rows projected, FExtra dropped); issued body =
  `{Data:{Top:10,PageSize:10,PageIndex:1,Filter:'',OrderBy:'FNumber',Fields:'FNumber,FName,FModel,FUnitID'}}`;
  key → `FNumber='…'`; **hard cap** (listMaxRows:999 → Top/PageSize still 10); **adversarial deny-guard still
  fires**: cursor / watermark / request-pagination → `K3_WISE_READ_LIST_UNSUPPORTED`, injection-shaped FNumber /
  raw `Filter` → `K3_WISE_READ_FILTER_UNSUPPORTED`; business failure → `K3_WISE_READ_BUSINESS_ERROR`; never
  Save/Submit/Audit/GetDetail; **BOM not unlocked**.
- `http-routes.test.cjs` — list intent → bounded read, evidence `{mode:'list',recordCount,pageBounded}`,
  values-free; preset-owned GetList overlay applied without mutating the stored system; request-supplied list
  pagination → 400.

## Boundaries verified

read-only; write-gated (operator-only, 403 for read users); values-free on success/failure (counts/flags only);
single bounded page (Top/PageSize≤10, PageIndex=1, no cursor); endpoint/method/pagination/fields preset-owned (no
request-supplied raw path/method/payload/config/pagination); FNumber-only internally-composed filter, injection
fail-closed; BOM / resolver / Save / Submit / Audit / production write unreachable (negative controls).

## Gated / not built (unchanged)

C4 BOM read, C5 resolver/composition, any K3 Save/Submit/Audit/production write, broad/unbounded scans, cursor
pagination — all still locked; each needs its own owner/customer GATE.

## Next step (gated, operator-run)

Values-free **live entity-machine smoke** against real K3 WebAPI `Material/GetList` (operator supplies credentials/
endpoint at deploy): confirm 200 + `Data.DATA` parses, bounded page, values-free evidence, no write/BOM/LIST-cursor.
This MD records the buildable+offline-verified state; it does not assert a live run.
