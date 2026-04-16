# Yjs Internal Rollout Execution Development

Date: 2026-04-16

## Context

The main rollout branch already included:

- runtime status script
- rollout checklist
- ops runbook
- retention policy

The remaining operator gap was that DB-side retention checks still depended on manual SQL.

## Change

Added:

- [scripts/ops/check-yjs-retention-health.mjs](/tmp/metasheet2-yjs-rollout-execution/scripts/ops/check-yjs-retention-health.mjs:1)
- [docs/operations/yjs-internal-rollout-execution-20260416.md](/tmp/metasheet2-yjs-rollout-execution/docs/operations/yjs-internal-rollout-execution-20260416.md:1)

Updated:

- [docs/operations/yjs-internal-rollout-checklist-20260416.md](/tmp/metasheet2-yjs-rollout-execution/docs/operations/yjs-internal-rollout-checklist-20260416.md:1)
- [docs/operations/yjs-ops-runbook-20260416.md](/tmp/metasheet2-yjs-rollout-execution/docs/operations/yjs-ops-runbook-20260416.md:1)

## Script Scope

`check-yjs-retention-health.mjs` queries PostgreSQL through `psql` and reports:

- `statesCount`
- `updatesCount`
- `orphanStatesCount`
- `orphanUpdatesCount`
- hottest records by update count

It exits non-zero when thresholds are exceeded, so it can be used in rollout or smoke automation.
