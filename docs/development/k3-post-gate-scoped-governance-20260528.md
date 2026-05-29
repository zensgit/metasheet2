# K3 WISE Post-GATE Scoped Governance - 2026-05-28

## Status

The project-wide **K3 PoC Stage-1 lock** is retired for planning purposes.
Issue #1792 is closed as PASS for the accepted M1 scope:

- K3 WISE Material Save-only, one record.
- Save success confirmed.
- Readonly readback confirmed.
- Productized package deployed on the on-prem node.
- Post-deploy no-write regression and authenticated smoke passed.

This removes the blanket "no new work until customer GATE PASS" blocker. It does
not unlock every K3 capability.

## Replacement Rule

Use **post-GATE scoped gates** instead of the global Stage-1 lock:

| Scope | Status | Re-entry rule |
|---|---|---|
| M1 Material one-record Save-only | Passed / closed via #1792 | Safe as the proven baseline; further writes still need explicit approval. |
| Material multi-record / batch Save | Locked | Separate owner-approved gate with no automatic retry unless designed. |
| Submit | Locked | Separate owner-approved gate and fresh K3 evidence. |
| Audit | Locked | Separate owner-approved gate and fresh K3 evidence. |
| BOM Save | Locked | Separate owner-approved gate; relationship/reference evidence must be current. |
| Production signoff | Locked | Separate production readiness and customer signoff. |
| Broad `plugin-integration-core` refactors | Scoped | Allowed only when tied to a named slice, reviewed diff, and current tests. |

## What This Authorizes

- Planning docs may stop treating "K3 Stage-1 lock" as a global blocker.
- Previously deferred non-K3 lanes may re-enter discussion if their own local
  blockers are closed and the owner explicitly opts in.
- Data Factory / connector work may proceed only through the already established
  per-PR opt-in gates.

## What This Does Not Authorize

- No Submit / Audit / BOM.
- No multi-record or production batch.
- No automatic retry of K3 writes.
- No direct writes to K3 core SQL tables.
- No runtime relaxation of `autoSubmit=false`, `autoAudit=false`, Save-only, or
  redaction boundaries.

## Evidence

- #1792: Customer GATE completed and closed for M1 one-record Material Save-only.
- #1962: customer-proven Material Save template shape productized.
- On-prem package deploy: post-deploy authenticated smoke plus no-write M1
  customer-profile regression passed before #1792 closeout.
