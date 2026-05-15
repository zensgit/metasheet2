# K3 WISE WebAPI read/list - customer sample manifest

## Purpose

Before MetaSheet can implement K3 WISE Material/BOM **read/list** (pull data from
K3 into the cleansing multitable, issue #1526 finding #2), we need the customer
to confirm the WebAPI read contract and provide redacted sample responses.

This is an **intake checklist**, not an execution runbook. The read/list runtime
is deferred until the customer GATE PASS; this document front-loads the inputs so
implementation is fast once unblocked.

Read alongside:

- `docs/development/integration-core-k3wise-webapi-read-list-gate-contract-design-20260515.md`
  (design + open questions O1-O6),
- `docs/operations/integration-k3wise-live-gate-execution-package.md`
  (the broader live GATE package; this manifest is the read-specific addendum).

## CRITICAL - do not send secrets

When filling the items below, the customer and operator **must not** include:

- API tokens, bearer tokens, session IDs,
- authority codes, passwords,
- SQL Server / database connection strings,
- any value that authenticates a request.

Redact every such value as `<redacted>` before sending. Sample JSON must be
**field-shape only**: real field names, representative but non-sensitive values.
Do not paste live responses verbatim if they embed auth material — strip it
first. Do not attach these files to a public issue; deliver them through the
agreed secure channel outside Git.

## Part A - WebAPI read contract (answers to design open questions)

| ID | Item | Customer answer |
| --- | --- | --- |
| O1-MAT | Material read/list endpoint path | `<fill>` |
| O1-MAT-M | Material read HTTP method (GET/POST) | `<fill>` |
| O1-BOM | BOM read/list endpoint path | `<fill>` |
| O1-BOM-M | BOM read HTTP method (GET/POST) | `<fill>` |
| O2-P | Pagination parameter names (page index + page size) | `<fill>` |
| O2-T | Total-count field name in response (or "not returned") | `<fill>` |
| O2-C | Server-enforced max page size (or "none") | `<fill>` |
| O3-F | Supported filters (by material number? others?) | `<fill>` |
| O3-M | Modified-since incremental filter supported? param name? | `<fill>` |
| O4-MAT | Full readable Material field list (K3 field -> meaning) | `<fill>` |
| O4-BOM | Full readable BOM field list (K3 field -> meaning) | `<fill>` |
| O6 | Is read-time auth identical to the write-time token, or a different scope? | `<fill>` |

## Part B - redacted sample JSON (4 cases, answer to O5)

Provide one redacted JSON sample per case. These build a faithful mock fixture
so the adapter can be tested without a live K3.

| Case | What to provide | File name to deliver |
| --- | --- | --- |
| B1 Material list | one page of the Material list response (1-3 rows is enough) | `sample-material-list.redacted.json` |
| B2 Material detail | single-material detail response (lookup by number) | `sample-material-detail.redacted.json` |
| B3 BOM list | one page of the BOM list response (1-3 parent/child rows) | `sample-bom-list.redacted.json` |
| B4 BOM detail | single-BOM detail response (by parent material code) | `sample-bom-detail.redacted.json` |

For each sample, keep the response envelope intact (list key, paging block,
status/code fields) so we map pagination and error detection correctly. Replace
only sensitive values with `<redacted>`; keep field **names** and structure.

### Expected shape (illustration only - not real K3 output)

```jsonc
{
  "<status/code field, e.g. ResponseStatus>": { "IsSuccess": true },
  "<list key, e.g. Data>": [
    {
      "FNumber": "MAT-001",
      "FName": "<sample name>",
      "FModel": "<sample spec>",
      "FBaseUnitID": "<sample unit>"
    }
  ],
  "<paging block, e.g. Page>": { "Index": 1, "Size": 50, "Total": 1 }
}
```

BOM rows are expected to expose at least `FParentItemNumber`,
`FChildItemNumber`, `FQty`, `FUnitID`, `FEntryID` (the fields already used by the
write template); confirm or correct in O4-BOM.

## Part C - what MetaSheet guarantees in return

- Read/list is **read-only**: no Save, no Submit, no Audit is issued during a
  read. The existing write path stays behind dry-run + explicit Save-only
  confirmation and is not changed by the read slice.
- A read failure surfaces a distinct `K3_WISE_READ_*` error and is never
  reported to the operator as a write/Save failure.
- No customer secret is written to logs, fixtures, or evidence files; the token
  stays bound to the configured query parameter and renders as `<redacted>`.
- Only Material and BOM are in scope for the first cut. Unknown relationship
  discovery and SQL Server sampling are tracked separately (#1526 findings #3
  and #4).

## Hand-back

Return Part A inline (redacted) and Part B as the four `*.redacted.json` files
through the secure channel. On receipt and customer GATE PASS, the runtime slice
proceeds per the post-GATE plan in the design and verification docs.
