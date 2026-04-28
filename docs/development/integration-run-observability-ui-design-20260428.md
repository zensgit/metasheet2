# Integration Run Observability UI Design - 2026-04-28

## Status

Implemented in `codex/integration-run-observability-ui-20260428`.

This slice adds read-only operational visibility to the K3 WISE setup page after
pipeline dry-run/run submission.

## Files

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Problem

The previous K3 WISE setup page could save systems, install staging tables,
create draft pipelines, and submit dry-run/run requests. It still left the
operator dependent on raw JSON responses or backend logs to answer:

- Did the run succeed or fail?
- How many rows were read, cleaned, written, or failed?
- Are there open dead letters to inspect before retrying?

That gap matters for the K3 WISE Live PoC because the first customer run will
need quick feedback without requiring shell access.

## Design

The page now has a `运行观察` panel in the side rail.

The panel exposes two explicit refresh actions:

- `刷新物料状态`
- `刷新 BOM 状态`

Each action reads the selected pipeline ID from the setup form and fetches:

- latest 5 pipeline runs
- latest 5 open dead letters

The panel also refreshes automatically after a material/BOM dry-run or live run
submission succeeds.

## API Contract

The frontend uses existing plugin routes:

- `GET /api/integration/runs`
- `GET /api/integration/dead-letters`

The query builder sends only public read fields:

```json
{
  "tenantId": "tenant_1",
  "workspaceId": "workspace_1",
  "pipelineId": "pipe_material",
  "status": "open",
  "limit": 5
}
```

Dead-letter payloads are not requested. The backend already redacts payloads for
non-admin users and returns `payloadRedacted: true`.

## UI Data

Run rows show:

- run ID
- status
- rows read / cleaned / written / failed
- started or created timestamp
- error summary when present

Dead-letter rows show:

- error code
- status
- dead-letter ID
- retry count
- error message
- payload redaction marker

## Safety

This slice is read-only. It does not add replay, discard, or full payload
inspection to the page. Those operations remain separate because they need
stronger review, authorization, and operator intent.

## Fit With Multitable Cleansing

The multitable staging surface remains the data-cleaning work area. This UI
only gives operators the minimum run/dead-letter visibility needed to operate the
cleaning chain from the K3 WISE page while waiting for customer GATE inputs.
