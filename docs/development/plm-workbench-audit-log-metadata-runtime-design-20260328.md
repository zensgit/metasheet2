# PLM Workbench Audit Log Metadata Runtime Design

## Background

`/api/plm-workbench/audit-logs` already returns top-level `metadata.resourceTypes`, and the generated SDK preserves that field. The web wrapper in `apps/web/src/services/plm/plmWorkbenchClient.ts` still dropped it and exposed only `items/page/pageSize/total`.

## Decision

Normalize and return `resourceTypes` from `listPlmCollaborativeAuditLogs(...)` so the web runtime matches backend and SDK behavior.

## Scope

- Read `payload.metadata?.resourceTypes`
- Filter values to the canonical `PlmCollaborativeAuditResourceType` union
- Return the normalized list beside `items/page/pageSize/total`

## Why

This keeps the web wrapper aligned with the already-exposed contract and avoids maintaining two different audit-log result shapes for SDK consumers versus in-repo callers.
