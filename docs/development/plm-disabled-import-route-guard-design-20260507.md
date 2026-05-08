# PLM Disabled Import Route Guard Design - 2026-05-07

## Context

When PLM is disabled with `PRODUCT_MODE=platform` and `ENABLE_PLM=0`, the server already blocks:

- `/api/plm-workbench/*`
- `/api/federation/plm/*`

The PLM import endpoint is mounted at `/api/federation/import/plm`, so it did not match either disabled prefix. That allowed a disabled deployment to return an import-shaped success response for a PLM operation.

## Change

- Add an explicit disabled feature handler for `/api/federation/import/plm`.
- Extend the existing PLM disable route test to cover the import endpoint.

## Scope

This is a route-gating fix only. It does not change PLM-enabled behavior or the federation import implementation.

## Impact

Deployments with PLM disabled now consistently return `404 FEATURE_DISABLED` for workbench, federation query, and import PLM APIs.
