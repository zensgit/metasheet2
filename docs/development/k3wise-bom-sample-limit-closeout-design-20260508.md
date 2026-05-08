# K3 WISE BOM And Sample-Limit Closeout Design - 2026-05-08

## Context

This closeout records the two higher-risk K3 WISE PoC PRs merged after the broader ERP/PLM deploy-safety batch. The goal was to make the live PoC path stricter without expanding vendor scope or pretending customer-live access is already available.

## Merged Scope

| PR | Merge SHA | Area | Design decision |
| --- | --- | --- | --- |
| #1358 `fix(integration): harden K3 WISE BOM PoC contract` | `d8cd53227679d0639c7394137a4fbd3cbcaecc48` | BOM source, transform, target evidence | Pass source filters/options explicitly, support `FChildItems[]` path output for K3 BOM child rows, and require BOM evidence to include run id, row count, and K3 response identifiers. |
| #1369 `fix(integration): cap K3 live PoC sample limits` | `a7805767a5c50239e7a756a36e0ead0eff700db4` | Live PoC frontend and preflight | Cap material Save-only sample size at 1 to 3 rows in both frontend helper validation and preflight packet generation. |

## Contract Shape

The current BOM PoC contract is intentionally narrow:

- `pipeline.options.source.filters.productId` carries the BOM product scope.
- Legacy `pipeline.options.source.productId` is stripped before adapter reads.
- `FChildItems[].FItemNumber` and `FChildItems[].FQty` generate a K3 child table array.
- Evidence must prove Save-only behavior with `runId`, `rowsWritten`, and at least one K3 response id such as `externalId` or `billNo`.

## Known Boundary

The `FChildItems[]` transform support maps one source record to one child array entry. It does not yet implement a group-by aggregation where multiple PLM child records are combined into one BOM header save payload.

That boundary is acceptable for the current internal and customer PoC gate because the PoC is capped at 1 to 3 rows and is designed to prove safe Save-only writeback plus evidence capture. If the customer's PLM exports BOM children as multiple rows for one parent, the next implementation slice should add an explicit BOM grouping step instead of stretching the current transform path.

## Deployment Meaning

After these PRs, the internal K3 WISE PoC path is safer to exercise on a physical machine:

- Material writeback cannot accidentally sample 20 rows from the UI default.
- BOM evidence cannot pass without a real K3 response identifier.
- BOM product scope is passed through adapter filters rather than legacy ad hoc source options.
- Mock PoC now exercises a K3 BOM Save-only payload with `FChildItems`.

Customer-live execution remains gated by the customer GATE packet and test environment access. These PRs make the path ready to test; they do not replace customer-provided K3 WISE URL, account, PLM fields, SQL Server permissions, or rollback confirmation.
