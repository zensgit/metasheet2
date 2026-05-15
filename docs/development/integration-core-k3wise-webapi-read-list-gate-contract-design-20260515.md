# K3 WISE WebAPI Material/BOM read/list - GATE-front contract design - 2026-05-15

## Status

GATE-front design only. **No runtime implemented in this PR.**

This document captures the design, the customer-confirmable contract, and the open
questions for #1526 finding #2 ("K3 WebAPI is currently exposed as a write-oriented
target"). It is intentionally docs-only because the K3 PoC Stage 1 Lock forbids
touching `plugins/plugin-integration-core` until the customer GATE PASS. The runtime
slice is deferred; this PR de-risks it by locking the contract before GATE so the
post-GATE implementation is mechanical.

## Why read/list before SQL executor

`metasheet:staging`-as-source and pipeline save are already wired and merged
(#1561 / #1563 / #1566 / #1572). The remaining delivery-chain blocker is "pull data
from an external system into the cleansing multitable". Two candidate channels:

- WebAPI read/list for known objects (Material, BOM): narrow, vendor-documented
  request/response, no deployment driver, no DB access.
- SQL Server read channel: broader, but pulls in driver deployment and an
  allowlist/security boundary (#1526 finding #4).

WebAPI read/list is the smaller, safer first cut and is the subject of this
contract.

## Current adapter state (verified, unchanged by this PR)

`plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`

| Surface | Current | Source |
| --- | --- | --- |
| `testConnection` | implemented (health path or skip-health) | `:539` |
| `listObjects` | implemented; returns configured objects with `operations` | `:569` |
| `getSchema` | implemented; returns `objectConfig.schema` fields | `:578` |
| `previewUpsert` | implemented (write preview) | `:591` |
| `upsert` | implemented (Save, opt-in Submit/Audit) | `:621` |
| `read` | **`unsupportedAdapterOperation(kind, 'read')`** | `:753` |

The adapter is built from K3 WISE document templates
(`lib/adapters/k3-wise-document-templates.cjs`):

- `material`: `operations: ['upsert']`, `savePath: /K3API/Material/Save`,
  `keyField: FNumber`, `keyParam: Number`, schema `FNumber, FName, FModel,
  FBaseUnitID`.
- `bom`: `operations: ['upsert']`, `savePath: /K3API/BOM/Save`,
  `keyField: FParentItemNumber`, `keyParam: Number`, schema `FParentItemNumber,
  FChildItemNumber, FQty, FUnitID, FEntryID`.

`requestJson(path, { method, query, headers, body })` (`:388`) and `login()`
(`:470`, returns `{ headers, query }` with the token bound to
`config.tokenQueryParam`) already exist and are reusable for read paths without
new transport code.

## Proposed contract (to implement post-GATE)

### Adapter surface

Replace `read: unsupportedAdapterOperation(...)` with a real `read` and add a
`list` alias mapping to the same code path. Signature stays inside the existing
adapter contract used by the pipeline runner and dry-run:

```text
read(input) -> { object, records: [...], page: { ... }, raw?: [...] }
list(input) -> read(input)   // list is read with no record-key filter
```

`input` shape (aligned with existing `getSchema`/`upsert` normalization):

```jsonc
{
  "object": "material",            // or "bom"
  "filter": {                       // all optional, see Open question O3
    "number": "MAT-001",           // single key lookup -> Material detail
    "modifiedSince": "2026-05-01"   // incremental, if K3 exposes it
  },
  "page": { "index": 1, "size": 50 } // see Open question O2
}
```

Object config gains read metadata (no migration; this is external-system JSON
config, same place `savePath` lives today):

```jsonc
{
  "objects": {
    "material": {
      "operations": ["read", "upsert"],   // read added; upsert untouched
      "readPath": "<TBD - customer/vendor confirmed>",
      "readMethod": "<TBD GET|POST>",
      "listPath": "<TBD - may equal readPath>",
      "responseListKey": "<TBD - e.g. Data / Result / Rows>",
      "responseRowKeyMap": { "FNumber": "FNumber", "FName": "FName" }
    }
  }
}
```

`operations` defaults remain `['upsert']` for any object that does not opt in to
`read`, so existing saved external systems do not silently gain a read surface.

### Read -> staging schema mapping

Reuse the existing `objectConfig.schema` arrays as the readable field set. The
read path projects each K3 response row to the same field names already returned
by `getSchema`, so `schema discovery returns Material/BOM readable fields` is
satisfied by the existing `getSchema` with no schema duplication:

| Object | Readable fields (from existing template schema) |
| --- | --- |
| material | `FNumber`, `FName`, `FModel`, `FBaseUnitID` |
| bom | `FParentItemNumber`, `FChildItemNumber`, `FQty`, `FUnitID`, `FEntryID` |

Field additions beyond these are an Open question (O4); we do not invent fields.

### Error taxonomy (acceptance: read failure must not look like write failure)

Distinct, non-write error code so a failed pull is never misreported as a Save
failure:

| Condition | Code | Notes |
| --- | --- | --- |
| read endpoint not configured | `K3_WISE_READ_NOT_CONFIGURED` | object lacks `readPath` |
| transport / HTTP error on read | `K3_WISE_READ_FAILED` | distinct from `K3_WISE_SAVE_FAILED` / `K3_WISE_TEST_FAILED` |
| K3 business error in read response | `K3_WISE_READ_BUSINESS_ERROR` | carries K3 message, no body echo of secrets |
| object configured but not `read` | reuse existing `ensureOperation` validation | mirrors how `upsert` is gated today |

`read` errors must never fall through to the `upsert`/Save error path. The
post-GATE test asserts the error `code` prefix is `K3_WISE_READ_*` and that the
message does not contain `Save`, `Submit`, or `Audit`.

## Pagination (Open question O2)

K3 WISE WebAPI list endpoints are customer/vendor-version specific. We do NOT
assume a page model. Customer must confirm:

- page parameter names (e.g. `PageNo`/`PageSize` vs `StartRow`/`Limit`),
- whether total count is returned and under which key,
- whether server caps page size.

Until confirmed, the mock fixture uses a neutral `{ index, size }` request and a
`{ rows, page: { index, size, total } }` response envelope; the live adapter
maps customer-confirmed names onto this neutral envelope.

## Filtering (Open question O3)

Minimum viable filters for the first cut:

- single-key detail: `filter.number` -> Material detail / BOM by parent code,
- full list: no filter -> first page only (caps at `page.size`, hard cap 3 in
  Save-only-adjacent contexts is NOT applicable here because read is non-mutating;
  the mock returns 1-3 rows by design for test determinism).

`modifiedSince` incremental filter is desirable but Open (O3) — only if K3
exposes a reliable modified timestamp.

## Explicit non-goals

- No Save / Submit / Audit behavior change. `upsert`, `previewUpsert`,
  `buildSaveBody`, autoSubmit/autoAudit coercion: untouched.
- No DB migration. Read config lives in existing external-system JSON config.
- No relationship auto-discovery. #1526 finding #3 (unknown K3 relationship
  discovery) is explicitly out of scope; unresolved relationships are a separate
  mapping-registry slice.
- No SQL Server channel work. #1526 finding #4 is a separate slice.
- No new REST route. Read flows through the existing external-system / adapter /
  pipeline-runner / dry-run path, same as the write path.
- No token / authorityCode / password / session / SQL connection string in code,
  logs, fixtures, or docs. The token stays bound to `config.tokenQueryParam` and
  is rendered `<redacted>` exactly as the write path already does (`:609`).

## Open questions for the customer (blockers for runtime)

| ID | Question | Why it blocks |
| --- | --- | --- |
| O1 | Exact read/list endpoint path + HTTP method for Material and for BOM | adapter cannot issue the request without it |
| O2 | Pagination parameter names + total-count key + server page cap | cannot page or know when to stop |
| O3 | Supported filters (by number; modified-since?) | determines incremental vs full-only |
| O4 | Full readable response field list (beyond current write schema) | avoid inventing fields; map to staging |
| O5 | Redacted real response JSON for the 4 cases (see customer manifest) | needed to build a faithful mock fixture |
| O6 | Read-time auth identical to write-time token, or different scope? | reuse `login()` only if identical |

These are captured for the customer in
`docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md`.

## Post-GATE implementation plan (mechanical once O1-O6 answered)

1. Add `read`/`list` to the adapter return object, replacing the
   `unsupportedAdapterOperation` stub at `:753`.
2. Extend `normalizeObjects` to accept `readPath`/`readMethod`/`listPath`/
   `responseListKey`/`responseRowKeyMap`, defaulting `operations` to `['upsert']`
   when read is not opted in.
3. Add a `mock-k3wise-webapi-read` fixture mirroring the customer-confirmed
   envelope (1-3 rows per object).
4. Add `__tests__/k3-wise-webapi-read.test.cjs` (wired into the
   `plugin-integration-core` test script) covering the acceptance matrix in the
   companion verification doc.
5. Re-run `pnpm -F plugin-integration-core test` and the K3 offline PoC.

No step requires a migration or a write-path change.
