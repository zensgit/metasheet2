# Yjs Internal Rollout Status Script Development

Date: 2026-04-16

## Context

PR `#888` already provides:

- rollout checklist
- ops runbook
- retention policy
- orphan cleanup job

The remaining operator gap was that rollout validation still depended on manual `curl | jq` inspection of `/api/admin/yjs/status`.

## Change

Added a small repo-native ops script:

- [scripts/ops/check-yjs-rollout-status.mjs](/Users/chouhua/Downloads/Github/metasheet2/scripts/ops/check-yjs-rollout-status.mjs:1)

The script:

1. fetches `GET /api/admin/yjs/status`
2. authenticates with a bearer token
3. evaluates basic rollout health thresholds
4. prints a concise summary
5. exits non-zero when rollout state is unhealthy

## Default Thresholds

- `activeDocCount > 200`
- `flushFailureCount > 10`
- `pendingWriteCount > 50`
- `activeSocketCount > 500`
- `enabled === false`
- `initialized === false`

## Docs Updated

- [docs/operations/yjs-internal-rollout-checklist-20260416.md](/Users/chouhua/Downloads/Github/metasheet2/docs/operations/yjs-internal-rollout-checklist-20260416.md:1)
- [docs/operations/yjs-ops-runbook-20260416.md](/Users/chouhua/Downloads/Github/metasheet2/docs/operations/yjs-ops-runbook-20260416.md:1)

## Scope

This is an execution aid only. It does not change Yjs runtime behavior, retention logic, cleanup semantics, or admin route payload shape.
